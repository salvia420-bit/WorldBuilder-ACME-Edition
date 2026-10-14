// tools/film/lib/jev_broker.mjs — Node end of the page ⇄ JEV bridge (window.__filmJev).
//
// WHY: the in-page pilot (scene3d/film/pilot/pilot.js through
// runtime/jev_bridge_page.js; SPEC §2.14, §3.2) asks JEV bounded maneuver questions
// several times a second. The OpenRouter key must never enter the page, so the film
// CLI uses Playwright page.exposeFunction to expose window.__filmJev(json) →
// Promise<json>, and this broker is that function. It validates the page's request,
// enforces a concurrency cap and an on/off switch, calls the Node JEV client, and
// answers with a JSON string. It NEVER throws into the page. Film mode is default OFF
// (`?filmMode=on`). Without the binding the pilot flies on its code policy.
//
// WHAT: createJevBroker({client, page, mode, maxInFlight, log, …}) →
//   {install, handler, stats, setMode, mode, setDecideOptions, telemetry, telemetryMark, dumpTelemetry}
//   handler(json) resolves to a JSON string:
//     ok    {answers, usage:{inputTokens, outputTokens, costUsd}, ms, seq, id, model}
//     error {error:{kind, message, retryable}, seq}
//   Error kinds are the JevError kinds plus:
//     'busy'     — maxInFlight reached. The pilot pipelines and drops stale answers,
//                  so refusing now beats a queue that answers an old scene.
//     'disabled' — mode 'off'
//     'internal' — a bug; the message never contains the key or the state
// Telemetry: one entry per request (seq, outcome, kind, question ids, normalized
// answers, ms, cost, bytes, in-flight count — never the state) in a ring of the
// last 500. dumpTelemetry(path) writes it as JSONL. One broker serves a whole
// `film shoot`, so a per-shot file takes `const m = broker.telemetryMark()` when
// the shot starts and `dumpTelemetry(path, {since: m})` writes only the entries
// recorded after that mark (the shot's rehearsal and attempts, no earlier shot).
//
// Usage (film CLI):
//   const broker = createJevBroker({client: jev, page, maxInFlight: 4, log});
//   await broker.install();                        // window.__filmJev now exists
//   broker.setDecideOptions({timeoutMs: 1200, maxRetries: 0});   // realtime takes
//   const mark = broker.telemetryMark();
//   …take…
//   broker.dumpTelemetry(`${takeDir}/jev.jsonl`, {since: mark});   // this take's entries only

import fs from "node:fs";
import path from "node:path";

import { JevError, validateQuestions } from "./jev.mjs";

/** Name of the page binding (SPEC §3.2). */
export const JEV_BINDING_NAME = "__filmJev";
/** Largest accepted page payload: 48 KB of UTF-8 JSON. */
export const BROKER_MAX_PAYLOAD_BYTES = 48 * 1024;
/** Telemetry ring size. */
export const BROKER_TELEMETRY_LIMIT = 500;
/** Broker modes: 'jev' forwards to the client; 'off' answers {error:{kind:'disabled'}}. */
export const BROKER_MODES = Object.freeze(["jev", "off"]);

const DECIDE_OPTION_KEYS = ["timeoutMs", "maxRetries", "model", "trace"];

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function clip(s, n = 200) {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// The page tags each request with a scene sequence number. Echo numbers and short
// strings; anything else becomes null.
function cleanSeq(seq) {
  if (typeof seq === "number" && Number.isFinite(seq)) return seq;
  if (typeof seq === "string" && seq.length <= 64) return seq;
  return null;
}

function pickDecideOptions(o) {
  if (o == null) return {};
  if (!isPlainObject(o)) throw new JevError("config", "decideOptions must be an object");
  const out = {};
  for (const k of DECIDE_OPTION_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Creates the Node-side broker behind window.__filmJev.
 *
 * Order of checks in handler(json):
 *   1. mode 'off' → 'disabled', for every input (`seq` is echoed when readable)
 *   2. size: more than maxPayloadBytes of UTF-8 → 'too-large' (never parsed)
 *   3. parse: a JSON string, or an already-structured object; malformed → 'bad-request'
 *   4. payload: needs `state` and questions that pass validateQuestions → 'bad-request'
 *   5. capacity: maxInFlight requests already waiting on the client → 'busy'
 *   6. client.decide({state, questions, sessionId?, ...decideOptions})
 * Steps 1–5 run synchronously, before the handler's first await.
 *
 * @param {object} opts
 * @param {{decide: Function, stats?: Function}} opts.client a createJevClient() client
 * @param {{exposeFunction: Function}} [opts.page] Playwright Page (needed only by install())
 * @param {'jev'|'off'} [opts.mode='jev']
 * @param {number} [opts.maxInFlight=4]
 * @param {(entry: object) => void} [opts.log] gets {event:'jev-broker', …} for errors and mode changes
 * @param {number} [opts.maxPayloadBytes=49152]
 * @param {number} [opts.telemetryLimit=500]
 * @param {() => number} [opts.now=Date.now]
 * @param {string} [opts.bindingName='__filmJev']
 * @param {string} [opts.sessionId] session_id for every decision (e.g. per take)
 * @param {{timeoutMs?: number, maxRetries?: number, model?: string, trace?: object}} [opts.decideOptions]
 * @returns {{install: () => Promise<{ok: true, already: boolean}>, handler: (json: unknown) => Promise<string>,
 *   stats: () => object, setMode: (m: string) => string, readonly mode: string,
 *   setDecideOptions: (o: object) => void, telemetry: (o?: {since?: number|null}) => object[],
 *   telemetryMark: () => number, dumpTelemetry: (file: string, o?: {since?: number|null}) => {path: string, count: number}}}
 */
export function createJevBroker(opts = {}) {
  const {
    client,
    page = null,
    mode: initialMode = "jev",
    maxInFlight = 4,
    log,
    maxPayloadBytes = BROKER_MAX_PAYLOAD_BYTES,
    telemetryLimit = BROKER_TELEMETRY_LIMIT,
    now = () => Date.now(),
    bindingName = JEV_BINDING_NAME,
    sessionId,
    decideOptions,
  } = opts ?? {};

  if (!client || typeof client.decide !== "function") throw new JevError("config", "createJevBroker needs a JEV client with decide()");
  if (!BROKER_MODES.includes(initialMode)) throw new JevError("config", `mode must be one of ${BROKER_MODES.join(", ")}`);
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new JevError("config", "maxInFlight must be an integer ≥ 1");
  if (!(typeof maxPayloadBytes === "number" && maxPayloadBytes > 0)) throw new JevError("config", "maxPayloadBytes must be a positive number");
  if (!Number.isInteger(telemetryLimit) || telemetryLimit < 1) throw new JevError("config", "telemetryLimit must be an integer ≥ 1");
  if (log != null && typeof log !== "function") throw new JevError("config", "log must be a function");
  if (typeof bindingName !== "string" || !bindingName) throw new JevError("config", "bindingName must be a non-empty string");

  let mode = initialMode;
  let decideOpts = pickDecideOptions(decideOptions);
  let inFlight = 0;
  let installed = false;
  let installing = null;
  let lastSeq = null;
  const ring = [];
  // Entries ever recorded = dropped (fell off the ring) + ring.length; a mark is that total at some moment.
  let dropped = 0;
  const counters = { requests: 0, ok: 0, errors: 0 };
  const byKind = {};

  const emit = (entry) => {
    if (!log) return;
    try {
      log(entry);
    } catch {
      // logging never breaks the bridge
    }
  };

  function record(entry) {
    ring.push(entry);
    if (ring.length > telemetryLimit) {
      const n = ring.length - telemetryLimit;
      ring.splice(0, n);
      dropped += n;
    }
  }

  // The ring entries recorded after `since` (a telemetryMark() value); null/undefined → the whole ring.
  function entriesSince(since) {
    if (since === null || since === undefined) return ring.slice();
    if (!Number.isInteger(since) || since < 0) throw new JevError("config", "telemetry since must be a telemetryMark() value (integer ≥ 0)");
    return ring.slice(Math.max(0, since - dropped));
  }

  /**
   * The function exposed as window.__filmJev. It always resolves to a JSON string and never throws.
   * @param {unknown} json the page's JSON string {state, questions, seq} (an object is accepted too)
   * @returns {Promise<string>}
   */
  async function handler(json) {
    const tStart = now();
    let seq = null;
    let bytes = 0;
    let qids = [];
    counters.requests++;

    const fail = (kind, message, retryable = false) => {
      counters.errors++;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      const msg = clip(message, 300);
      try {
        record({ seq, t: tStart, mode, outcome: "error", kind, message: clip(msg, 160), questions: qids, bytes, inFlight, ms: Math.max(0, now() - tStart) });
        if (kind !== "busy" && kind !== "disabled") emit({ event: "jev-broker", outcome: "error", seq, kind, message: msg });
      } catch {
        // telemetry is best-effort
      }
      return JSON.stringify({ error: { kind, message: msg, retryable: Boolean(retryable) }, seq });
    };

    try {
      // Measure and parse first (an oversize payload is never parsed), so even a
      // refusal can echo the page's seq.
      let payload;
      let parseError = null;
      if (typeof json === "string") {
        bytes = Buffer.byteLength(json, "utf8");
        if (bytes <= maxPayloadBytes) {
          try {
            payload = JSON.parse(json);
          } catch {
            parseError = "payload is not valid JSON";
          }
        }
      } else if (json !== null && typeof json === "object") {
        let text;
        try {
          text = JSON.stringify(json);
        } catch {
          text = undefined;
        }
        if (typeof text !== "string") parseError = "payload is not JSON-serialisable";
        else {
          bytes = Buffer.byteLength(text, "utf8");
          // Re-parse a copy, so getters/proxies cannot change between validation and dispatch.
          if (bytes <= maxPayloadBytes) payload = JSON.parse(text);
        }
      } else {
        parseError = "payload must be a JSON string {state, questions, seq}";
      }
      if (isPlainObject(payload)) {
        seq = cleanSeq(payload.seq);
        if (seq != null) lastSeq = seq;
        if (isPlainObject(payload.questions)) qids = Object.keys(payload.questions).slice(0, 32);
      }

      if (mode === "off") return fail("disabled", "the film JEV broker is off");
      if (bytes > maxPayloadBytes) return fail("too-large", `payload is ${bytes} bytes; the limit is ${maxPayloadBytes}`);
      if (parseError) return fail("bad-request", parseError);
      if (!isPlainObject(payload)) return fail("bad-request", "payload must be a JSON object {state, questions, seq}");

      if (payload.state === undefined || payload.state === null) return fail("bad-request", "payload.state is missing");
      const v = validateQuestions(payload.questions);
      if (!v.ok) return fail("bad-request", `invalid questions: ${v.issues.slice(0, 5).join("; ")}`);

      if (inFlight >= maxInFlight) return fail("busy", `${inFlight} JEV requests already in flight (max ${maxInFlight})`, true);

      const dispatchedInFlight = ++inFlight;
      let r;
      try {
        r = await client.decide({
          state: payload.state,
          questions: payload.questions,
          ...(sessionId != null ? { sessionId } : {}),
          ...decideOpts,
        });
      } finally {
        inFlight--;
      }
      if (!r || !isPlainObject(r.answers)) return fail("internal", "the JEV client returned no answers");
      const usage = isPlainObject(r.usage) ? r.usage : null;
      const ms = typeof r.ms === "number" ? r.ms : Math.max(0, now() - tStart);
      const out = { answers: r.answers, usage, ms, seq, id: r.id ?? null, model: r.model ?? null };
      const text = JSON.stringify(out);
      counters.ok++;
      record({
        seq,
        t: tStart,
        mode,
        outcome: "ok",
        id: out.id,
        model: out.model,
        questions: qids,
        answers: r.answers,
        ms,
        brokerMs: Math.max(0, now() - tStart),
        costUsd: typeof usage?.costUsd === "number" ? usage.costUsd : null,
        bytes,
        inFlight: dispatchedInFlight,
      });
      return text;
    } catch (e) {
      if (e instanceof JevError) return fail(e.kind, e.message, e.retryable);
      return fail("internal", `broker failure: ${e?.message ?? String(e)}`);
    }
  }

  /**
   * Exposes the handler as window[bindingName] via page.exposeFunction. The call is
   * idempotent: repeat calls (concurrent ones included) expose once. Playwright's
   * "has been already registered" error counts as success with already: true;
   * note that the binding registered earlier, not this broker's handler, then
   * keeps serving the page.
   * @returns {Promise<{ok: true, already: boolean}>}
   */
  function install() {
    if (installed) return Promise.resolve({ ok: true, already: true });
    if (installing) return installing;
    if (!page || typeof page.exposeFunction !== "function") {
      return Promise.reject(new JevError("config", "install() needs a Playwright page with exposeFunction()"));
    }
    installing = (async () => {
      try {
        await page.exposeFunction(bindingName, handler);
        installed = true;
        return { ok: true, already: false };
      } catch (e) {
        if (/already registered/i.test(String(e?.message ?? e))) {
          installed = true;
          emit({ event: "jev-broker", outcome: "install", note: `${bindingName} was already registered` });
          return { ok: true, already: true };
        }
        throw e;
      } finally {
        installing = null;
      }
    })();
    return installing;
  }

  /**
   * Switches between 'jev' (forward to JEV) and 'off' (answer 'disabled').
   * @param {'jev'|'off'} next
   * @returns {string} the previous mode
   */
  function setMode(next) {
    if (!BROKER_MODES.includes(next)) throw new JevError("config", `mode must be one of ${BROKER_MODES.join(", ")} (got ${String(next)})`);
    const prev = mode;
    mode = next;
    if (prev !== next) emit({ event: "jev-broker", outcome: "mode", from: prev, to: next });
    return prev;
  }

  /**
   * Replaces the per-call decide() overrides, e.g. {timeoutMs: 1200, maxRetries: 0} for
   * realtime takes (the page gives up after 1.5 s) and {timeoutMs: 4000, maxRetries: 2}
   * for stepped takes (the page waits up to 15 s).
   * @param {{timeoutMs?: number, maxRetries?: number, model?: string, trace?: object}|null} o
   */
  function setDecideOptions(o) {
    decideOpts = pickDecideOptions(o);
  }

  /** Counters, plus the client's stats when the client provides them. */
  function stats() {
    let clientStats = null;
    try {
      clientStats = typeof client.stats === "function" ? client.stats() : null;
    } catch {
      clientStats = null;
    }
    return {
      mode,
      installed,
      inFlight,
      maxInFlight,
      requests: counters.requests,
      ok: counters.ok,
      errors: counters.errors,
      byKind: { ...byKind },
      telemetry: ring.length,
      lastSeq,
      client: clientStats,
    };
  }

  /**
   * Copy of the telemetry ring, oldest first; with `{since: mark}` only the entries recorded after that
   * telemetryMark() (entries that already fell off the ring are gone).
   * @param {{since?: number|null}} [o]
   * @returns {object[]}
   */
  function telemetry(o = {}) {
    return entriesSince(o?.since);
  }

  /**
   * How many telemetry entries this broker has recorded so far (including those that fell off the ring). Take it
   * when a shot starts and pass it as `since` to telemetry()/dumpTelemetry() for that shot's entries only.
   * @returns {number}
   */
  function telemetryMark() {
    return dropped + ring.length;
  }

  /**
   * Writes the telemetry ring as JSONL (one entry per line, oldest first); with `{since: mark}` only the entries
   * recorded after that telemetryMark(). Creates parent directories as needed and overwrites the file.
   * @param {string} file
   * @param {{since?: number|null}} [o]
   * @returns {{path: string, count: number}}
   */
  function dumpTelemetry(file, o = {}) {
    if (typeof file !== "string" || !file) throw new JevError("config", "dumpTelemetry needs a file path");
    const list = entriesSince(o?.since);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = list.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(file, list.length ? `${body}\n` : "");
    return { path: file, count: list.length };
  }

  return {
    install,
    handler,
    stats,
    setMode,
    get mode() {
      return mode;
    },
    setDecideOptions,
    telemetry,
    telemetryMark,
    dumpTelemetry,
  };
}
