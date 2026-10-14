// scene3d/film/runtime/jev_bridge_page.js — the page end of the JEV bridge (SPEC §3.2).
//
// WHY: JEV (TypeSafe's System-One decision model on OpenRouter) is the film
// camera's reflexes, but its API key must NEVER enter the page. The CLI keeps
// the key in Node (tools/film/lib/jev_broker.mjs) and exposes ONE function
// into the page with Playwright `page.exposeFunction`:
//     window.__filmJev(JSON.stringify({state, questions, seq})) → Promise<json>
// This module wraps that function for the pilot (pilot/pilot.js `bridge`):
//   * `available` is re-read on every access (the CLI may install, re-install
//     or remove the binding between takes; no binding → the pilot flies on its
//     code policy);
//   * `request()` NEVER throws and NEVER rejects into the pilot: every failure
//     (no binding, payload > 48 KB, a throwing / rejecting binding, non-JSON,
//     no answers, timeout) resolves to the broker's failure envelope
//     `{error:{kind, message, retryable}, seq}`, which the pilot turns into a
//     code-policy tick (telemetry source 'code');
//   * the broker answers with a JSON STRING (an already-parsed object is
//     accepted too); success = `{answers, usage:{inputTokens, outputTokens,
//     costUsd}, ms, seq, id, model}` with answers already in codePolicy shape;
//   * a page-side timeout (1.5 s realtime / 15 s stepped by default) bounds
//     every request; a late answer after the timeout is ignored.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: window, timers and
// clock are injected (defaults: globalThis). No network code here — the page
// never talks to OpenRouter (or any Anthropic API) itself.

/** Name of the binding the CLI exposes (tools/film/lib/jev_broker.mjs JEV_BINDING_NAME). */
export const JEV_BRIDGE_FUNCTION = "__filmJev";

/** Page-side request timeouts per capture mode (SPEC §3.2), milliseconds. */
export const JEV_BRIDGE_TIMEOUTS = Object.freeze({ realtime: 1500, stepped: 15000 });

/** Largest request body the broker accepts (it answers 'too-large' above it). */
export const JEV_BRIDGE_MAX_PAYLOAD_BYTES = 48 * 1024;

/** Failure kinds of the wire envelope (SPEC §3.2). */
export const JEV_BRIDGE_ERROR_KINDS = Object.freeze([
  "busy", "disabled", "budget", "timeout", "rate", "server", "network", "too-large",
  "bad-request", "bad-response", "auth", "credits", "config", "internal",
]);

/** Kinds worth retrying on a later tick. */
const RETRYABLE = new Set(["busy", "timeout", "rate", "server", "network"]);

/**
 * The broker failure envelope.
 * @param {string} kind one of JEV_BRIDGE_ERROR_KINDS
 * @param {string} message
 * @param {number|null} seq
 * @returns {{error:{kind:string, message:string, retryable:boolean}, seq:number|null}}
 */
export function bridgeError(kind, message, seq) {
  const k = JEV_BRIDGE_ERROR_KINDS.includes(kind) ? kind : "internal";
  return { error: { kind: k, message: String(message ?? ""), retryable: RETRYABLE.has(k) }, seq: seq ?? null };
}

/**
 * Normalise one broker answer (a JSON string or an object) into either the
 * success shape `{answers, usage, ms, seq, id?, model?}` or a failure envelope.
 * A success needs an `answers` object; `usage` defaults to zeros; `ms` to
 * `fallbackMs` when the broker gave none.
 * @param {*} raw
 * @param {number|null} seq the request's sequence number (used when the answer has none)
 * @param {number} [fallbackMs]
 * @returns {object}
 */
export function parseBridgeResponse(raw, seq, fallbackMs) {
  let r = raw;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch (_) {
      return bridgeError("bad-response", "the JEV broker answered with text that is not JSON", seq);
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return bridgeError("bad-response", "the JEV broker answered with no object", seq);
  if (r.error !== undefined && r.error !== null) {
    const e = r.error;
    const kind = e && typeof e === "object" && typeof e.kind === "string" ? e.kind : "internal";
    const message = e && typeof e === "object" ? e.message : e;
    const out = bridgeError(kind, message, r.seq !== undefined ? r.seq : seq);
    if (e && typeof e === "object" && typeof e.retryable === "boolean") out.error.retryable = e.retryable;
    return out;
  }
  if (!r.answers || typeof r.answers !== "object" || Array.isArray(r.answers)) {
    return bridgeError("bad-response", "the JEV broker answer has no answers object", seq);
  }
  const u = r.usage && typeof r.usage === "object" ? r.usage : {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const ms = typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0 ? r.ms : (Number.isFinite(fallbackMs) ? Math.max(0, fallbackMs) : 0);
  const out = {
    answers: r.answers,
    usage: { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), costUsd: num(u.costUsd ?? u.cost) },
    ms,
    seq: r.seq !== undefined ? r.seq : seq,
  };
  if (typeof r.id === "string") out.id = r.id;
  if (typeof r.model === "string") out.model = r.model;
  return out;
}

/** UTF-8 byte length of a string (TextEncoder when present). */
function utf8Length(s) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(s).length;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/**
 * Create the page bridge the pilot uses (SPEC §3.2).
 *
 * - `available` (getter): `typeof window.__filmJev === 'function'`, re-read every access.
 * - `request({state, questions, seq})` → `Promise<{answers, usage, ms, seq, id?, model?}
 *   | {error:{kind, message, retryable}, seq}>` — never throws, never rejects.
 * - `configure({timeoutMs?, mode?})` → the effective `{timeoutMs, mode}`; `mode`
 *   'realtime' | 'stepped' picks JEV_BRIDGE_TIMEOUTS unless timeoutMs is given.
 * - `timeoutMs` (getter), `stats()` → counters (requests, answers, errors by kind, timeouts,
 *   lateAnswers, lastMs).
 *
 * @param {{window?:object|null, timeoutMs?:number, mode?:'realtime'|'stepped',
 *   functionName?:string, maxPayloadBytes?:number, setTimeout?:Function,
 *   clearTimeout?:Function, now?:()=>number, log?:(entry:object)=>void}} [deps]
 * @returns {{readonly available:boolean, request:Function, configure:Function,
 *   readonly timeoutMs:number, stats:Function}}
 */
export function createPageBridge(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const winOf = () => (d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null));
  const name = typeof d.functionName === "string" && d.functionName ? d.functionName : JEV_BRIDGE_FUNCTION;
  const maxPayload = Number.isFinite(d.maxPayloadBytes) && d.maxPayloadBytes > 0 ? d.maxPayloadBytes : JEV_BRIDGE_MAX_PAYLOAD_BYTES;
  const setT = typeof d.setTimeout === "function" ? d.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
  const clearT = typeof d.clearTimeout === "function" ? d.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
  const nowMs = typeof d.now === "function"
    ? d.now
    : () => (typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : 0);
  const emit = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-jev-bridge", ...entry });
    } catch (_) {
      /* a logger never breaks the pilot */
    }
  };

  let mode = d.mode === "stepped" ? "stepped" : "realtime";
  let timeoutMs = Number.isFinite(d.timeoutMs) && d.timeoutMs > 0 ? d.timeoutMs : JEV_BRIDGE_TIMEOUTS[mode];
  const counters = { requests: 0, answers: 0, errors: 0, timeouts: 0, lateAnswers: 0, lastMs: null, byKind: {} };

  function fnOf() {
    const w = winOf();
    try {
      const f = w ? w[name] : undefined;
      return typeof f === "function" ? { w, f } : null;
    } catch (_) {
      return null;
    }
  }

  function noteError(env) {
    counters.errors += 1;
    const k = env.error.kind;
    counters.byKind[k] = (counters.byKind[k] || 0) + 1;
    if (k === "timeout") counters.timeouts += 1;
    return env;
  }

  function request(payload) {
    counters.requests += 1;
    const p = payload && typeof payload === "object" ? payload : {};
    const seq = Number.isFinite(p.seq) ? p.seq : null;
    return new Promise((resolve) => {
      let body;
      try {
        body = JSON.stringify({ state: p.state ?? null, questions: p.questions ?? null, seq });
      } catch (e) {
        resolve(noteError(bridgeError("bad-request", `the decision request is not JSON-serialisable: ${e && e.message ? e.message : e}`, seq)));
        return;
      }
      if (typeof body !== "string") {
        resolve(noteError(bridgeError("bad-request", "the decision request is empty", seq)));
        return;
      }
      const bytes = utf8Length(body);
      if (bytes > maxPayload) {
        resolve(noteError(bridgeError("too-large", `the decision request is ${bytes} bytes (limit ${maxPayload})`, null)));
        return;
      }
      const b = fnOf();
      if (!b) {
        resolve(noteError(bridgeError("disabled", `window.${name} is not installed (no JEV broker): the code policy flies`, seq)));
        return;
      }
      const t0 = nowMs();
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null && clearT) {
          try {
            clearT(timer);
          } catch (_) {
            /* already fired */
          }
        }
        if (value && value.error) noteError(value);
        else {
          counters.answers += 1;
          counters.lastMs = value.ms;
        }
        resolve(value);
      };
      if (setT && timeoutMs > 0) {
        timer = setT(() => {
          if (settled) return;
          emit({ level: "info", message: `JEV request ${seq} timed out after ${timeoutMs} ms` });
          finish(bridgeError("timeout", `no JEV answer within ${timeoutMs} ms`, seq));
        }, timeoutMs);
      }
      let pr;
      try {
        pr = b.f.call(b.w, body);
      } catch (e) {
        finish(bridgeError("internal", `window.${name} threw: ${e && e.message ? e.message : e}`, seq));
        return;
      }
      Promise.resolve(pr).then(
        (raw) => {
          if (settled) {
            counters.lateAnswers += 1;
            return;
          }
          finish(parseBridgeResponse(raw, seq, nowMs() - t0));
        },
        (e) => {
          if (settled) {
            counters.lateAnswers += 1;
            return;
          }
          finish(bridgeError("network", `window.${name} rejected: ${e && e.message ? e.message : e}`, seq));
        },
      );
    });
  }

  function configure(c = {}) {
    const o = c && typeof c === "object" ? c : {};
    if (o.mode === "realtime" || o.mode === "stepped") {
      mode = o.mode;
      if (!(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) timeoutMs = JEV_BRIDGE_TIMEOUTS[mode];
    }
    if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) timeoutMs = o.timeoutMs;
    return { timeoutMs, mode };
  }

  return {
    get available() {
      return fnOf() !== null;
    },
    request,
    configure,
    get timeoutMs() {
      return timeoutMs;
    },
    stats: () => ({ ...counters, byKind: { ...counters.byKind }, mode, timeoutMs, available: fnOf() !== null }),
  };
}
