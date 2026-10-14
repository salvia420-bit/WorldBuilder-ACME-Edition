// scene3d/film/pilot/pilot.js — the JEV System-One camera pilot loop (SPEC §2.14).
//
// WHY: during a take the film camera flies a planned trajectory; near trees,
// walls, rocks, creatures and particle clouds it needs fast tactical judgment —
// hold, drift, rise, sink, slow, back off; ignore / fade / reroute an occluder;
// nudge the framing. JEV (TypeSafe's System-One model, reached through an
// injected page bridge whose Node end holds the OpenRouter key) supplies that
// judgment at ≈3–8 decisions/s; the deterministic code policy supplies it when
// JEV is unavailable, failing, or being shadow-tested. This module is the loop
// that ties perception words, questions, answers and the residual mapper
// together, following the jev-drone / mikespins real-time design:
//   - consult only when needed (obstacle within `consult.withinM`, contact
//     soon, subject unseen ≥ `consult.unseenSec` or mostly hidden, framing off)
//     AND the bucketed scene changed (fingerprint) or the last answer is older
//     than `reuseSec` — otherwise reuse it;
//   - realtime: pipelined requests (≤ maxInFlight, ≥ minDispatchSec and
//     1/decisionHz apart), every request tagged with its scene sequence number;
//     only an answer about a NEWER scene than the applied one replaces it;
//     responses are folded in at the next tick, so tick() stays synchronous;
//   - stepped (film clock paused): tickStepped() awaits the bridge when a
//     decision is due — the result depends only on the inputs and the answers,
//     never on wall time (deterministic rehearsals / captures);
//   - a bridge error, malformed answer or timeout falls back to the code
//     policy for that tick (telemetry source 'code');
//   - shadow mode acts on the code policy and still asks JEV, logging the
//     agreement between the two.
// The code safety reflex (runtime/safety.js) runs after the pilot and always wins.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm. Time arrives as `now` (seconds, the caller's pilot clock: wall time
// in realtime takes, film time in stepped takes). The only timer is the
// optional stepped-mode bridge timeout (injectable `timers`).

import { FilmError } from "../core/errors.js";
import { fingerprintHash, sceneFingerprint } from "./fingerprint.js";
import { createResidualMapper } from "./mapper.js";
import { answersAgree, codePolicy, neutralAnswers } from "./policy_code.js";
import { PILOT_RULES, parseDecisionAnswers, questionsFor } from "./questions.js";
import { NO_SUBJECT, buildPilotState, slotRange } from "./scene_state.js";
import { WORD_BOUNDS, leadingWord, offsetWord, sizeWord } from "./sense_words.js";

/** Pilot modes: 'jev' acts on JEV, 'code' on the code policy only, 'shadow' on code while asking JEV. */
export const PILOT_MODES = Object.freeze(["jev", "code", "shadow"]);

/** Telemetry sources: which decision drove a tick. */
export const PILOT_SOURCES = Object.freeze(["jev", "code", "reuse", "none"]);

/** Size of the per-pilot decision ring returned by decisions(). */
export const PILOT_DECISION_LIMIT = 500;

/** Upper bound of the "mostly hidden" visibility band (0.4): below it the occluder question matters. */
const OCCLUDED_FRAC = WORD_BOUNDS.visibility.bands.find((b) => b.word === "mostly hidden").max;
/** Upper bound of the "soon" contact band (2 s): contact sooner than this is a decision. */
const CONTACT_SOON_SEC = WORD_BOUNDS.ttc.bands.find((b) => b.word === "soon").max;

/**
 * Recursively freezes a plain object/array tree.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** @param {*} v @param {number} d @returns {number} */
function nonNeg(v, d) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n >= 0 ? n : d;
}

/** @param {*} v @param {number} d @returns {number} */
function positive(v, d) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : d;
}

/** @param {*} s @param {number} n @returns {string} */
function clip(s, n = 160) {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Should the pilot consult (JEV or the code policy) for this scene? "Only when needed"
 * (jev-drone): an obstacle within `withinM` (nearest, any forward sector, or the level band
 * ahead), contact on the planned path sooner than 2 s ("soon"/"imminent"), the subject
 * unseen for ≥ `unseenSec` or under 40 % visible ("mostly hidden" or worse), or — when
 * `framing` is on — the subject's size is not "right" or it sits "near the edge"/"out of frame".
 * Subject checks are skipped when the state has no subject.
 * @param {object|null} sensorFrame SPEC §3.1
 * @param {object|null} state buildPilotState() result (decides whether a subject exists)
 * @param {{withinM?:number, unseenSec?:number, framing?:boolean}} [consult]
 * @returns {{needed:boolean, reasons:string[]}}
 */
export function consultNeeded(sensorFrame, state, consult = {}) {
  const sf = sensorFrame && typeof sensorFrame === "object" ? sensorFrame : {};
  const c = consult && typeof consult === "object" ? consult : {};
  const withinM = nonNeg(c.withinM, 6);
  const unseenSec = nonNeg(c.unseenSec, 1.0);
  const reasons = [];
  if (slotRange(sf.nearest) <= withinM) reasons.push("obstacle-near");
  const sectors = sf.sectors && typeof sf.sectors === "object" ? sf.sectors : {};
  for (const k of ["far_left", "left", "center", "right", "far_right"]) {
    if (slotRange(sectors[k]) <= withinM) {
      reasons.push("sector-blocked");
      break;
    }
  }
  if (sf.freeAhead && typeof sf.freeAhead === "object" && slotRange(sf.freeAhead.level) <= withinM) reasons.push("level-blocked");
  const ttc = sf.pathAhead && typeof sf.pathAhead === "object" ? Number(sf.pathAhead.ttc) : NaN;
  if (Number.isFinite(ttc) && ttc >= 0 && ttc < CONTACT_SOON_SEC) reasons.push("contact-soon");
  const hasSubject =
    sf.subject && typeof sf.subject === "object" && !(state && state.subject && state.subject.visibility === NO_SUBJECT);
  if (hasSubject) {
    const s = sf.subject;
    const unseen = Number(s.unseenSec);
    if (Number.isFinite(unseen) && unseen >= unseenSec) reasons.push("subject-unseen");
    const vis = Number(s.visibleFrac);
    if (Number.isFinite(vis) && vis < OCCLUDED_FRAC) reasons.push("subject-occluded");
    if (c.framing !== false) {
      const where = leadingWord(offsetWord(Array.isArray(s.ndc) ? s.ndc : null), "offset");
      if (sizeWord(s.sizeRatio) !== "right" || PILOT_RULES.recenterOffsets.includes(where)) reasons.push("framing");
    }
  }
  return { needed: reasons.length > 0, reasons };
}

/**
 * Cost of one bridge response in USD: `usage.costUsd` (film broker), `usage.cost` (raw API) or
 * `costUsd`; 0 when absent.
 * @param {*} res
 * @returns {number}
 */
function costOf(res) {
  const u = res && typeof res === "object" && res.usage && typeof res.usage === "object" ? res.usage : {};
  for (const v of [u.costUsd, u.cost, res?.costUsd]) {
    const n = Number(v);
    if (v != null && Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Create the pilot (SPEC §2.14).
 *
 * `bridge = {available, request({state, questions, seq}) → Promise<{answers, id?, usage?, ms?}
 * | {error}>}` or null (`available` may be a boolean, a getter or a function; it is re-read
 * every consult). No bridge / unavailable / mode 'code' → the code policy flies.
 *
 * Per tick: build the words-only state (scene_state.js), fingerprint it, decide whether a
 * consult is needed (consultNeeded). Not needed → neutral answers (the mapper relaxes back
 * onto the planned shot), source 'none'. Needed → reuse / dispatch / code as described in
 * the module header; the answers go through the mapper (commit window, confidence, staleness,
 * bounds) to the Setpoint.
 *
 * Telemetry per tick: `{seq, scene, t, source, fingerprint, answers, latencyMs, costUsd,
 * agreeWithCode, newDecision, consulted, reasons, dispatched, inFlight, status, fallback?}`
 * — `seq` = scene sequence of the decision in effect (its request seq for JEV), `scene` = this
 * tick's sequence, `fingerprint` = 8-hex hash of the scene fingerprint, `costUsd` = USD of every
 * JEV answer folded in during this tick (each answer counted exactly once — including dropped and
 * shadow answers — so the telemetry sum equals stats().costUsd), `latencyMs` = latency of the JEV
 * decision in effect (0 for code / none), `source` is 'none' when the mapper found the decision
 * in effect stale.
 *
 * @param {{bridge?:object|null, mode?:'jev'|'code'|'shadow', decisionHz?:number, maxInFlight?:number,
 *   minDispatchSec?:number, consult?:{withinM?:number, unseenSec?:number, framing?:boolean},
 *   reuseSec?:number, mapper?:object, log?:(entry:object)=>void, timeoutSec?:number,
 *   steppedTimeoutMs?:number, timers?:{setTimeout:Function, clearTimeout:Function}}} [opts]
 *   timeoutSec: realtime in-flight limit on the pilot clock (default 1.5 s);
 *   steppedTimeoutMs: stepped-mode wait limit (default 15000 ms, via `timers`).
 * @returns {{tick:(sensorFrame:object, ctx?:object, now?:number) => {setpoint:object, telemetry:object},
 *   tickStepped:(sensorFrame:object, ctx?:object, now?:number) => Promise<{setpoint:object, telemetry:object}>,
 *   stats:() => object, reset:() => void, decisions:() => object[], readonly mode:string,
 *   readonly mapper:object}}
 *   ctx = {standingOrder?, technique?, goal?, hasSubject?}
 */
export function createPilot(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const mode = PILOT_MODES.includes(o.mode) ? o.mode : "jev";
  const bridge = o.bridge && typeof o.bridge === "object" && typeof o.bridge.request === "function" ? o.bridge : null;
  const decisionHz = positive(o.decisionHz, 5);
  const maxInFlight = Math.max(1, Math.floor(positive(o.maxInFlight, 2)));
  const minDispatchSec = nonNeg(o.minDispatchSec, 0.12);
  const interval = Math.max(minDispatchSec, 1 / decisionHz);
  const oc = o.consult && typeof o.consult === "object" ? o.consult : {};
  const consult = Object.freeze({
    withinM: nonNeg(oc.withinM, 6),
    unseenSec: nonNeg(oc.unseenSec, 1.0),
    framing: oc.framing !== false,
  });
  const reuseSec = nonNeg(o.reuseSec, 2.0);
  const timeoutSec = positive(o.timeoutSec, 1.5);
  const steppedTimeoutMs = positive(o.steppedTimeoutMs, 15000);
  const timers =
    o.timers && typeof o.timers.setTimeout === "function"
      ? o.timers
      : typeof globalThis.setTimeout === "function"
        ? { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }
        : null;
  const mapper = o.mapper && typeof o.mapper.apply === "function" ? o.mapper : createResidualMapper({});
  const log = typeof o.log === "function" ? o.log : null;

  let epoch = 0;
  let sceneSeq = 0;
  /** @type {null|{seq:number, epoch:number, sceneTime:number, fingerprint:string, fp:string, answers:object,
   *  source:string, latencyMs:number, costUsd:number, agree:boolean|null, used:boolean}} */
  let applied = null;
  /** @type {Map<number, object>} */
  const inFlight = new Map();
  /** @type {Array<{req:object, ok:boolean, value:*}>} */
  let completed = [];
  let lastDispatchAt = -Infinity;
  let lastT = null;
  let chain = Promise.resolve();
  let pendingCost = 0;
  let st;
  let ring;

  function zeroStats() {
    st = {
      ticks: 0,
      consults: 0,
      dispatched: 0,
      answered: 0,
      appliedAnswers: 0,
      reused: 0,
      errors: 0,
      timeouts: 0,
      fallbacks: 0,
      droppedOlder: 0,
      droppedLate: 0,
      skipped: { busy: 0, rate: 0, duplicate: 0 },
      sources: { jev: 0, code: 0, reuse: 0, none: 0 },
      maxInFlightSeen: 0,
      costUsd: 0,
      latencies: [],
      latencyCount: 0,
      latencySum: 0,
      latencyMax: 0,
      agreement: { compared: 0, agreed: 0, perQuestion: {} },
    };
    ring = [];
  }
  zeroStats();

  /** @param {object} entry */
  function emit(entry) {
    if (!log) return;
    try {
      log({ event: "film-pilot", ...entry });
    } catch {
      /* a broken logger never breaks the flight */
    }
  }

  /** @param {object} entry */
  function remember(entry) {
    ring.push(entry);
    if (ring.length > PILOT_DECISION_LIMIT) ring.splice(0, ring.length - PILOT_DECISION_LIMIT);
  }

  function bridgeAvailable() {
    if (!bridge) return false;
    try {
      const a = bridge.available;
      if (typeof a === "function") return a.call(bridge) !== false;
      return a !== false;
    } catch {
      return false;
    }
  }

  /** Per-tick preparation: state, fingerprint, questions, consult gate, scene sequence. */
  function prepare(sensorFrame, ctx, now) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const sf = sensorFrame && typeof sensorFrame === "object" ? sensorFrame : {};
    let t = Number(now);
    if (now == null || !Number.isFinite(t)) t = lastT ?? 0;
    lastT = t;
    const cur = mapper.current();
    const hasSubject = typeof c.hasSubject === "boolean" ? c.hasSubject : !!(sf.subject && typeof sf.subject === "object");
    const state = buildPilotState(sf, {
      standingOrder: c.standingOrder,
      technique: c.technique,
      goal: c.goal,
      current: { maneuver: cur.maneuver, since: cur.since, lateral: cur.lateral, vertical: cur.vertical },
      bounds: mapper.bounds,
      hasSubject,
    });
    const fingerprint = sceneFingerprint(state);
    const questions = questionsFor({ hasSubject, framing: consult.framing });
    const need = consultNeeded(sf, state, consult);
    sceneSeq += 1;
    return { t, sf, state, fingerprint, fp: fingerprintHash(fingerprint), questions, need, seq: sceneSeq };
  }

  /** @returns {number} USD of the JEV answers folded in since the previous tick (reported once). */
  function takeCost() {
    const c = pendingCost;
    pendingCost = 0;
    return c;
  }

  /** Feed the mapper and build the tick result. */
  function finish(p, answers, info) {
    const setpoint = mapper.apply(answers, { sceneTime: info.sceneTime, now: p.t, sensorFrame: p.sf, source: info.source });
    const inert = setpoint.status === "stale" || setpoint.status === "empty";
    const source = inert ? "none" : info.source;
    if (setpoint.source !== source) setpoint.source = source;
    st.ticks += 1;
    st.sources[source] += 1;
    const telemetry = {
      seq: info.seq ?? p.seq,
      scene: p.seq,
      t: p.t,
      source,
      fingerprint: p.fp,
      answers: answers ?? null,
      latencyMs: info.latencyMs ?? 0,
      costUsd: takeCost(),
      agreeWithCode: info.agreeWithCode ?? null,
      newDecision: !!info.newDecision && !inert,
      consulted: p.need.needed,
      reasons: p.need.reasons,
      dispatched: info.dispatched ?? null,
      inFlight: inFlight.size,
      status: setpoint.status,
    };
    if (info.fallback) telemetry.fallback = info.fallback;
    if (telemetry.newDecision) {
      remember({
        seq: telemetry.seq,
        t: telemetry.t,
        source,
        fingerprint: telemetry.fingerprint,
        answers: telemetry.answers,
        latencyMs: telemetry.latencyMs,
        costUsd: telemetry.costUsd,
        agreeWithCode: telemetry.agreeWithCode,
      });
    }
    return { setpoint, telemetry };
  }

  /** Telemetry fields for acting on the applied record (marks it used). */
  function useApplied(p, dispatched) {
    const first = !applied.used;
    applied.used = true;
    return finish(p, applied.answers, {
      source: applied.source === "code" ? "code" : "jev",
      sceneTime: applied.sceneTime,
      seq: applied.seq,
      latencyMs: applied.latencyMs,
      agreeWithCode: applied.agree,
      newDecision: first,
      dispatched,
    });
  }

  /**
   * True when an answer about scene `seq` may replace the applied record: it is about a newer
   * scene, or about the same scene the applied record only holds as a code fallback.
   * @param {number} seq
   * @returns {boolean}
   */
  function isNewer(seq) {
    if (!applied || applied.epoch !== epoch) return true;
    return seq > applied.seq || (seq === applied.seq && applied.source !== "jev");
  }

  function isReusable(p) {
    return (
      !!applied &&
      applied.epoch === epoch &&
      applied.fingerprint === p.fingerprint &&
      p.t - applied.sceneTime <= reuseSec + 1e-9
    );
  }

  /** The code answers become the applied record (bridge failure fallback). */
  function codeRecord(p, code) {
    applied = {
      seq: p.seq,
      epoch,
      sceneTime: p.t,
      fingerprint: p.fingerprint,
      fp: p.fp,
      answers: code,
      source: "code",
      latencyMs: 0,
      costUsd: 0,
      agree: null,
      used: true,
    };
  }

  function makeRequest(p, code) {
    return {
      seq: p.seq,
      epoch,
      sceneTime: p.t,
      fingerprint: p.fingerprint,
      fp: p.fp,
      questions: p.questions,
      code,
      dispatchedAt: p.t,
    };
  }

  /** Start a bridge request; never throws. @returns {Promise<*>} */
  function callBridge(p) {
    try {
      return Promise.resolve(bridge.request({ state: p.state, questions: p.questions, seq: p.seq }));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Fold one bridge outcome in: validate, measure agreement, apply when about a newer scene.
   * @returns {{ok?:boolean, dropped?:boolean, error?:boolean, kind?:string, relevant?:boolean}}
   */
  function settle(req, ok, value, t) {
    if (req.epoch !== epoch) return { dropped: true };
    const relevant = isNewer(req.seq);
    const fail = (kind, message) => {
      st.errors += 1;
      emit({ kind: "error", seq: req.seq, error: kind, message: clip(message) });
      return { error: true, kind, relevant };
    };
    if (!ok) {
      const kind = value instanceof FilmError && value.code === "JEV_TIMEOUT" ? "timeout" : "bridge-error";
      if (kind === "timeout") st.timeouts += 1;
      return fail(kind, value && value.message ? value.message : String(value));
    }
    let res = value;
    if (typeof res === "string") {
      try {
        res = JSON.parse(res);
      } catch {
        return fail("bad-response", "bridge returned non-JSON text");
      }
    }
    if (!res || typeof res !== "object") return fail("bad-response", "bridge returned no object");
    if (res.error) {
      const e = res.error;
      const kind = typeof e === "object" && e && typeof e.kind === "string" ? `jev-${e.kind}` : "jev-error";
      return fail(kind, typeof e === "object" && e ? e.message : String(e));
    }
    let answers;
    try {
      answers = parseDecisionAnswers(res.answers !== undefined ? res.answers : res, req.questions);
    } catch (err) {
      return fail("bad-answer", err && err.message ? err.message : String(err));
    }
    const msRaw = Number(res.ms);
    const latencyMs = res.ms != null && Number.isFinite(msRaw) && msRaw >= 0 ? msRaw : Math.max(0, (t - req.dispatchedAt) * 1000);
    const costUsd = costOf(res);
    const agreement = answersAgree(answers, req.code);
    st.answered += 1;
    st.costUsd += costUsd;
    pendingCost += costUsd;
    st.latencyCount += 1;
    st.latencySum += latencyMs;
    st.latencyMax = Math.max(st.latencyMax, latencyMs);
    st.latencies.push(latencyMs);
    if (st.latencies.length > PILOT_DECISION_LIMIT) st.latencies.shift();
    if (agreement.compared > 0) {
      st.agreement.compared += 1;
      if (agreement.agree) st.agreement.agreed += 1;
      for (const [id, same] of Object.entries(agreement.perQuestion)) {
        const pq = st.agreement.perQuestion[id] ?? (st.agreement.perQuestion[id] = { compared: 0, agreed: 0 });
        pq.compared += 1;
        if (same) pq.agreed += 1;
      }
    }
    emit({
      kind: "answer",
      seq: req.seq,
      fingerprint: req.fp,
      latencyMs,
      costUsd,
      agreeWithCode: agreement.agree,
      perQuestion: agreement.perQuestion,
      id: typeof res.id === "string" ? res.id : null,
    });
    if (!relevant) {
      st.droppedOlder += 1;
      emit({ kind: "drop-older", seq: req.seq, applied: applied.seq });
      return { dropped: true };
    }
    applied = {
      seq: req.seq,
      epoch,
      sceneTime: req.sceneTime,
      fingerprint: req.fingerprint,
      fp: req.fp,
      answers: deepFreeze(answers),
      source: "jev",
      latencyMs,
      costUsd,
      agree: agreement.agree,
      used: false,
    };
    st.appliedAnswers += 1;
    return { ok: true };
  }

  /** Realtime: start a request when the pipeline allows it. @returns {number|null} seq */
  function maybeDispatch(p, code) {
    if (inFlight.size >= maxInFlight) {
      st.skipped.busy += 1;
      return null;
    }
    if (p.t - lastDispatchAt < interval - 1e-9) {
      st.skipped.rate += 1;
      return null;
    }
    for (const r of inFlight.values()) {
      if (r.fingerprint === p.fingerprint) {
        st.skipped.duplicate += 1;
        return null;
      }
    }
    const req = makeRequest(p, code);
    inFlight.set(req.seq, req);
    lastDispatchAt = p.t;
    st.dispatched += 1;
    st.maxInFlightSeen = Math.max(st.maxInFlightSeen, inFlight.size);
    emit({ kind: "dispatch", seq: req.seq, fingerprint: req.fp, inFlight: inFlight.size });
    callBridge(p).then(
      (value) => completed.push({ req, ok: true, value }),
      (value) => completed.push({ req, ok: false, value }),
    );
    return req.seq;
  }

  /** Realtime: expire timed-out requests and fold in completed responses. @returns {string|null} failure kind */
  function drain(t) {
    let failure = null;
    for (const req of [...inFlight.values()]) {
      if (t - req.dispatchedAt > timeoutSec) {
        inFlight.delete(req.seq);
        st.timeouts += 1;
        st.errors += 1;
        emit({ kind: "error", seq: req.seq, error: "timeout", message: `no answer within ${timeoutSec} s` });
        if (isNewer(req.seq)) failure = "timeout";
      }
    }
    if (completed.length) {
      const batch = completed;
      completed = [];
      for (const c of batch) {
        if (c.req.epoch !== epoch) continue;
        if (!inFlight.has(c.req.seq)) {
          st.droppedLate += 1;
          emit({ kind: "drop-late", seq: c.req.seq });
          continue;
        }
        inFlight.delete(c.req.seq);
        const r = settle(c.req, c.ok, c.value, t);
        if (r.error && r.relevant) failure = r.kind;
      }
    }
    return failure;
  }

  /**
   * Realtime tick (synchronous). Responses that arrived since the previous tick are folded in
   * first; a new request may be dispatched; the decision in effect drives the mapper.
   * @param {object} sensorFrame SPEC §3.1
   * @param {{standingOrder?:string, technique?:string, goal?:string, hasSubject?:boolean}} [ctx]
   * @param {number} [now] pilot clock, seconds
   * @returns {{setpoint:object, telemetry:object}}
   */
  function tick(sensorFrame, ctx, now) {
    const p = prepare(sensorFrame, ctx, now);
    const failure = mode === "code" ? null : drain(p.t);
    if (!p.need.needed) return finish(p, neutralAnswers(p.questions), { source: "none", sceneTime: p.t });
    st.consults += 1;
    const code = codePolicy(p.sf, p.state, { questions: p.questions });
    if (mode === "code" || !bridgeAvailable()) {
      return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true });
    }
    const reusable = isReusable(p);
    const dispatched = reusable ? null : maybeDispatch(p, code);
    if (failure) {
      st.fallbacks += 1;
      emit({ kind: "fallback", seq: p.seq, reason: failure });
      codeRecord(p, code);
      return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, dispatched, fallback: failure });
    }
    if (mode === "shadow") {
      const agree = applied && applied.source === "jev" && applied.fingerprint === p.fingerprint ? applied.agree : null;
      return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, dispatched, agreeWithCode: agree });
    }
    if (reusable && applied.used) {
      st.reused += 1;
      return finish(p, applied.answers, {
        source: "reuse",
        sceneTime: p.t,
        seq: applied.seq,
        latencyMs: 0,
        agreeWithCode: applied.agree,
        newDecision: false,
      });
    }
    if (applied && applied.epoch === epoch) return useApplied(p, dispatched);
    return finish(p, null, { source: "none", sceneTime: p.t, dispatched });
  }

  /** Bridge call bounded by steppedTimeoutMs (rejects with FilmError code JEV_TIMEOUT). */
  function withTimeout(promise) {
    if (!timers) return promise;
    return new Promise((resolve, reject) => {
      let done = false;
      const h = timers.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new FilmError(`JEV bridge gave no answer within ${steppedTimeoutMs} ms`, { code: "JEV_TIMEOUT" }));
      }, steppedTimeoutMs);
      promise.then(
        (v) => {
          if (done) return;
          done = true;
          timers.clearTimeout?.(h);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          timers.clearTimeout?.(h);
          reject(e);
        },
      );
    });
  }

  async function steppedImpl(sensorFrame, ctx, now) {
    const p = prepare(sensorFrame, ctx, now);
    if (!p.need.needed) return finish(p, neutralAnswers(p.questions), { source: "none", sceneTime: p.t });
    st.consults += 1;
    const code = codePolicy(p.sf, p.state, { questions: p.questions });
    if (mode === "code" || !bridgeAvailable()) return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true });
    if (isReusable(p)) {
      if (mode === "shadow") return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, agreeWithCode: applied.agree });
      if (!applied.used) return useApplied(p, null);
      st.reused += 1;
      return finish(p, applied.answers, {
        source: "reuse",
        sceneTime: p.t,
        seq: applied.seq,
        agreeWithCode: applied.agree,
        newDecision: false,
      });
    }
    if (p.t - lastDispatchAt < interval - 1e-9) {
      st.skipped.rate += 1;
      if (mode === "shadow") return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true });
      if (applied && applied.epoch === epoch) return useApplied(p, null);
      return finish(p, null, { source: "none", sceneTime: p.t });
    }
    const req = makeRequest(p, code);
    lastDispatchAt = p.t;
    st.dispatched += 1;
    st.maxInFlightSeen = Math.max(st.maxInFlightSeen, 1);
    emit({ kind: "dispatch", seq: req.seq, fingerprint: req.fp, inFlight: 1, stepped: true });
    let outcome;
    try {
      const value = await withTimeout(callBridge(p));
      outcome = settle(req, true, value, p.t);
    } catch (err) {
      outcome = settle(req, false, err, p.t);
    }
    if (req.epoch !== epoch) return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, dispatched: req.seq });
    if (outcome.error) {
      st.fallbacks += 1;
      emit({ kind: "fallback", seq: p.seq, reason: outcome.kind });
      codeRecord(p, code);
      return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, dispatched: req.seq, fallback: outcome.kind });
    }
    if (mode === "shadow") {
      return finish(p, code, {
        source: "code",
        sceneTime: p.t,
        newDecision: true,
        dispatched: req.seq,
        agreeWithCode: applied && applied.seq === req.seq ? applied.agree : null,
      });
    }
    if (applied && applied.epoch === epoch) return useApplied(p, req.seq);
    return finish(p, code, { source: "code", sceneTime: p.t, newDecision: true, dispatched: req.seq });
  }

  /**
   * Stepped tick: when a decision is due, awaits the bridge (film time is paused), so the
   * result depends only on inputs and answers. Calls are serialised.
   * @param {object} sensorFrame
   * @param {{standingOrder?:string, technique?:string, goal?:string, hasSubject?:boolean}} [ctx]
   * @param {number} [now] film time, seconds
   * @returns {Promise<{setpoint:object, telemetry:object}>}
   */
  function tickStepped(sensorFrame, ctx, now) {
    const run = () => steppedImpl(sensorFrame, ctx, now);
    const pr = chain.then(run, run);
    chain = pr.catch(() => undefined);
    return pr;
  }

  /**
   * Counters for the current take (JSON-safe).
   * @returns {object}
   */
  function stats() {
    const lat = [...st.latencies].sort((a, b) => a - b);
    const perQuestion = {};
    for (const [id, v] of Object.entries(st.agreement.perQuestion)) {
      perQuestion[id] = { compared: v.compared, agreed: v.agreed, rate: v.compared ? v.agreed / v.compared : null };
    }
    return {
      mode,
      bridge: bridge ? (bridgeAvailable() ? "available" : "unavailable") : "none",
      ticks: st.ticks,
      consults: st.consults,
      dispatched: st.dispatched,
      answered: st.answered,
      appliedAnswers: st.appliedAnswers,
      reused: st.reused,
      errors: st.errors,
      timeouts: st.timeouts,
      fallbacks: st.fallbacks,
      droppedOlder: st.droppedOlder,
      droppedLate: st.droppedLate,
      skipped: { ...st.skipped },
      sources: { ...st.sources },
      inFlight: inFlight.size,
      maxInFlightSeen: st.maxInFlightSeen,
      costUsd: st.costUsd,
      latencyMs: {
        count: st.latencyCount,
        mean: st.latencyCount ? st.latencySum / st.latencyCount : null,
        p50: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
        max: st.latencyCount ? st.latencyMax : null,
      },
      agreement: {
        compared: st.agreement.compared,
        agreed: st.agreement.agreed,
        rate: st.agreement.compared ? st.agreement.agreed / st.agreement.compared : null,
        perQuestion,
      },
      lastScene: sceneSeq,
      mapper: typeof mapper.stats === "function" ? mapper.stats() : null,
    };
  }

  /** New take: forget in-flight requests (late answers are ignored), answers, counters, mapper state. */
  function reset() {
    epoch += 1;
    inFlight.clear();
    completed = [];
    applied = null;
    lastDispatchAt = -Infinity;
    lastT = null;
    pendingCost = 0;
    zeroStats();
    if (typeof mapper.reset === "function") mapper.reset();
  }

  return {
    tick,
    tickStepped,
    stats,
    reset,
    /** @returns {object[]} the last PILOT_DECISION_LIMIT new decisions (JSON-safe copies of telemetry rows) */
    decisions: () => ring.map((e) => ({ ...e })),
    get mode() {
      return mode;
    },
    get mapper() {
      return mapper;
    },
  };
}
