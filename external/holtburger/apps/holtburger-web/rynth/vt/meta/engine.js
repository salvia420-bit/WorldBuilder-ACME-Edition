// rynth/vt/meta/engine.js — MetaEngine, the VTank meta runtime (PLAN §2.9,
// §3.12; U5 §2 with the §9 RynthAi bugs fixed).
//
// A meta is a flat list of rules { id, state, enabled, cond, act }. The macro
// is in one state at a time; each rule of the current state fires at most
// once per state ENTRY (GUIDE:232-234). A pass (U5 §2.2, fixed):
//   1. the events latched since the last pass are taken (each event is
//      visible to exactly one pass, U5 §2.5);
//   2. the not-yet-fired, enabled rules of the current state are walked in
//      file order: condition → (fire + action) → next rule, so a DoExpr's
//      setvar is visible to the next rule's Expr in the same pass;
//   3. the pass ends at the first state entry (SetState / CallState / Return
//      / an expression's setmetastate / a meta load), even a same-state one.
// An action that throws records lastError and stays fired — no re-fire storm
// (B14). Passes run every 293 ms or at once on "decide now" (a state entry,
// an edge event, a kernel action change) (GUIDE:237).
//
// tick(now, { running }) is called once per host heartbeat by the VT
// pre-tick (INT-2), BEFORE the kernel tick:
//   * session vars are flushed (throttled by the VarStore) ALWAYS;
//   * the delayexec queue is pumped ONLY while running — an operator hold
//     makes queued entries wait and run after RESUME (V-7, critic S1);
//   * running true→false (an operator hold) lets go of every host effect a
//     meta function engaged (expr.functions.release(): setmotion keys, I-3);
//     so do a portalIn event (V-12) and destroy();
//   * running false→true is the macro-start edge: enterState(cur,
//     "macroStart") re-arms every rule and resets Seconds-in-State but NOT
//     Seconds-in-State (P) (GUIDE:252/268, fixes B7);
//   * a pass runs only while running && EnableMeta && a meta is loaded;
//   * the watchdog counts down only while that gate is open, outside portal
//     space and with a known pose (V-12).
//
// enterState(name, why) is the ONLY state writer (fixes B4/B11): it clears
// every fired flag, resets enteredAt (and enteredAtP unless why is
// "macroStart"), clears the watchdog and requests an immediate pass.
//
// Persistent state lives ONLY in the injected `state` object (session.metaState,
// JSON-able) so a bot rebind on the same page continues it (D6):
//   { metaName, state, stack, fired: {ruleId: true}, enteredAt, enteredAtP,
//     watchdog, lastFired, lastError, debug, running }
// The loaded Meta itself lives in session.meta (INT-2); a new engine bound to
// an existing state restores it with replaceMeta(meta, { keepState: true }).
//
// No imports outside this directory (C2); EXPR helpers (truthy/toStr/isErr,
// getRegex, the runtime) are injected. No timers (C4); never throws from
// tick() or the public commands (C9).

import { evalCondition, describeCondition, CONDITIONS } from "./conditions.js";
import { runAction, describeAction, ACTIONS } from "./actions.js";

export const PASS_INTERVAL_MS = 293;
export const STACK_CAP = 64;
export const MAX_PENDING_EVENTS = 512;
export const DEFAULT_STATE = "Default";
export const EVENT_TYPES = Object.freeze(["chat", "death", "portalIn", "portalOut", "vendorOpen", "vendorClose"]);
export const ENTER_REASONS = Object.freeze(["set", "call", "return", "manual", "load", "watchdog", "macroStart", "command", "expr"]);

// A tick gap (bot rebind, a stalled Worker) never counts down more than this
// against the watchdog in one step.
const WATCHDOG_MAX_STEP_MS = 1000;
const CHAT_SYSTEM = 0; // app/chat_log.js CHAT_CATEGORY.SYSTEM

// ── helpers ────────────────────────────────────────────────────────────────

function text(x) {
  if (x === null || x === undefined) return "";
  return typeof x === "string" ? x : String(x);
}

function errText(e) {
  return e && e.message ? e.message : text(e);
}

function finite(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function lower(s) {
  return text(s).trim().toLowerCase();
}

function clone(o) {
  try {
    if (typeof structuredClone === "function") return structuredClone(o);
  } catch {
    /* fall through to JSON */
  }
  return JSON.parse(JSON.stringify(o));
}

/**
 * C3 logger: `[vt:meta]` prefix on the console default; identical messages
 * are rate-limited to one per 10 s. A broken sink never throws.
 */
export function makeMetaLog(log, now = Date.now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt:meta] ${m}`);
  const seen = new Map();
  return (msg) => {
    const m = text(msg);
    let t = 0;
    try {
      t = Number(now()) || 0;
    } catch {
      t = 0;
    }
    const last = seen.get(m);
    if (last !== undefined && t >= last && t - last < 10_000) return; // a clock that went back never mutes a line
    if (seen.size > 256) seen.clear();
    seen.set(m, t);
    try {
      base(m);
    } catch {
      /* ignore */
    }
  };
}

// Minimal stand-ins used ONLY when INT-2 forgets to inject EXPR's helpers
// (one warning). The plan's truthiness table (Q9) is mirrored.
const FALLBACK_VALUES = Object.freeze({
  isErr: (v) => !!v && typeof v === "object" && v.t === "err",
  truthy: (v) => {
    if (v === null || v === undefined || v === false || v === 0) return false;
    if (typeof v === "number") return !Number.isNaN(v);
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      return !(s === "" || s === "0" || s === "false");
    }
    if (typeof v === "object") {
      if (v.t === "err") return false;
      if (v.t === "list") return Array.isArray(v.items) && v.items.length > 0;
    }
    return true;
  },
  toStr: (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "1" : "0";
    if (typeof v === "object") return v.t === "wobj" ? text(v.name) : v.t === "err" ? `ERR: ${text(v.msg)}` : `[${text(v.t)}]`;
    return text(v);
  },
});

/**
 * Copy + normalise a Meta (§3.2): rules get stable unique ids ("r<n>" for a
 * missing or duplicate id), a state (default "Default"), enabled (default
 * true), cond/act objects (Never / None when malformed). Never mutates the
 * input. → { ok, meta?, warnings, error? }
 */
export function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") return { ok: false, warnings: [], error: "not a meta object" };
  let src;
  try {
    src = clone(meta);
  } catch (e) {
    return { ok: false, warnings: [], error: `meta is not JSON-able: ${errText(e)}` };
  }
  if (!Array.isArray(src.rules)) return { ok: false, warnings: [], error: "meta has no rules array" };
  const warnings = [];
  const rules = [];
  const used = new Set();
  const needId = [];
  src.rules.forEach((r, i) => {
    if (!r || typeof r !== "object") {
      warnings.push(`rule #${i + 1} is not an object (dropped)`);
      return;
    }
    let id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
    if (id === "__proto__") {
      // The fired map is a plain JSON object: this key would hit the
      // prototype setter, the flag would never stick and the rule would
      // re-fire on every pass.
      warnings.push(`rule #${i + 1}: id "__proto__" is reserved (renumbered)`);
      id = null;
    }
    if (id && used.has(id)) {
      warnings.push(`rule #${i + 1}: duplicate id "${id}" (renumbered)`);
      id = null;
    }
    if (id) used.add(id);
    const st = typeof r.state === "string" && r.state.trim() ? r.state.trim() : DEFAULT_STATE;
    let cond = r.cond;
    if (!cond || typeof cond !== "object" || typeof cond.t !== "string") {
      warnings.push(`rule #${i + 1}: missing condition (Never)`);
      cond = { t: "Never" };
    } else if (!Object.prototype.hasOwnProperty.call(CONDITIONS, cond.t)) {
      warnings.push(`rule #${i + 1}: unsupported condition "${cond.unknownKeyword || cond.t}" (Never)`);
    }
    let act = r.act;
    if (!act || typeof act !== "object" || typeof act.t !== "string") {
      warnings.push(`rule #${i + 1}: missing action (None)`);
      act = { t: "None" };
    } else if (!Object.prototype.hasOwnProperty.call(ACTIONS, act.t)) {
      warnings.push(`rule #${i + 1}: unsupported action "${act.unknownKeyword || act.t}" (None)`);
    }
    const out = { ...r, id, state: st, enabled: r.enabled !== false, cond, act };
    if (!id) needId.push(out);
    rules.push(out);
  });
  let n = 1;
  for (const r of needId) {
    while (used.has(`r${n}`)) n++;
    r.id = `r${n}`;
    used.add(r.id);
  }
  const navs = src.navs && typeof src.navs === "object" && !Array.isArray(src.navs) ? src.navs : {};
  const out = {
    ...src,
    v: 1,
    name: typeof src.name === "string" ? src.name : "",
    source: src.source && typeof src.source === "object" ? src.source : { kind: "json" },
    rules,
    navs,
    warnings: Array.isArray(src.warnings) ? src.warnings.map(text) : [],
  };
  return { ok: true, meta: out, warnings };
}

function initState(st, now) {
  if (typeof st.state !== "string" || !st.state.trim()) st.state = DEFAULT_STATE;
  if (!Array.isArray(st.stack)) st.stack = [];
  if (Array.isArray(st.fired)) {
    const f = {};
    for (const id of st.fired) f[text(id)] = true;
    st.fired = f;
  } else if (!st.fired || typeof st.fired !== "object") st.fired = {};
  if (!finite(st.enteredAt)) st.enteredAt = now;
  if (!finite(st.enteredAtP)) st.enteredAtP = st.enteredAt;
  if (st.watchdog === undefined || (st.watchdog !== null && typeof st.watchdog !== "object")) st.watchdog = null;
  if (st.lastFired === undefined) st.lastFired = null;
  if (st.lastError === undefined) st.lastError = null;
  st.debug = st.debug === true;
  if (st.metaName === undefined) st.metaName = null;
  if (typeof st.running !== "boolean") st.running = false; // fresh session: macro "off" until the first running tick
  return st;
}

function dist3(a, b) {
  const dx = Number(a.wx) - Number(b.wx);
  const dy = Number(a.wy) - Number(b.wy);
  const dz = (Number(a.z) || 0) - (Number(b.z) || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── MetaEngine ─────────────────────────────────────────────────────────────

export class MetaEngine {
  constructor({ ctx = null, expr = null, getRegex = null, values = null, setVar = null, state = null, now = null, log = null } = {}) {
    this.ctx = ctx && typeof ctx === "object" ? ctx : {};
    this.expr = expr && typeof expr === "object" ? expr : null;
    const ctxNow = typeof this.ctx.now === "function" ? () => this.ctx.now() : null;
    this.now = typeof now === "function" ? now : ctxNow || Date.now;
    const ctxLog = typeof this.ctx.log === "function" ? (m) => this.ctx.log(m) : null;
    this.log = makeMetaLog(typeof log === "function" ? log : ctxLog, () => this._clock());

    const okValues = values && typeof values.truthy === "function" && typeof values.toStr === "function" && typeof values.isErr === "function";
    if (!okValues) this.log("values helpers {truthy, toStr, isErr} not injected; using a minimal fallback");
    this.values = okValues ? values : FALLBACK_VALUES;

    if (typeof getRegex === "function") {
      this._getRegex = getRegex;
    } else {
      this.log("getRegex not injected; patterns are used as plain JS regexes");
      this._getRegex = (p, f) => new RegExp(p, f);
    }

    if (typeof setVar === "function") this._setVarFn = setVar;
    else if (this.expr && typeof this.expr.setVar === "function") this._setVarFn = (n, v) => this.expr.setVar(n, v);
    else if (this.expr && this.expr.vars && typeof this.expr.vars.set === "function") this._setVarFn = (n, v) => this.expr.vars.set("session", n, v);
    else this._setVarFn = null;

    this.st = initState(state && typeof state === "object" ? state : {}, this._clock());

    this._meta = null;
    this._buckets = new Map(); // lower(state) → rules (file order)
    this._stateNames = new Map(); // lower(state) → first-seen spelling
    this._ruleById = new Map();
    this._pending = [];
    this._decideNow = true;
    this._lastPass = -Infinity;
    this._tickNow = null; // the heartbeat's nowMs while tick() runs (see _clock)
    this._entrySeq = 0;
    this._lastAction = null;
    this._vendor = null;
    this._stopPass = false;
    this._curRuleId = null;
    this._destroyed = false;
    this._echoed = new Set();
    this._warned = new Set();
    this._metaListeners = new Set();
  }

  // Inside tick() every timestamp (enteredAt, the watchdog's lastAt, error
  // times) is the heartbeat's nowMs, the same clock the pass measures
  // Seconds-in-State and the watchdog with; outside a tick (manual / command
  // entries) it is the injected clock.
  _clock() {
    if (typeof this._tickNow === "number") return this._tickNow;
    try {
      const t = Number(this.now());
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  }

  // ── meta lifecycle ───────────────────────────────────────────────────────

  /**
   * Replace rules/navs, clear the call stack, watchdog and views, and START
   * IN Default (fixes B4: RynthAi boots in Rules[0].State). → { ok, warnings }
   */
  load(meta, { name = null, source = null } = {}) {
    try {
      const norm = normalizeMeta(meta);
      if (!norm.ok) return { ok: false, warnings: norm.warnings, error: norm.error };
      if (source && typeof source === "object") norm.meta.source = { ...norm.meta.source, ...source };
      else if (typeof source === "string" && source) norm.meta.source = { ...norm.meta.source, loadedFrom: source };
      this._install(norm.meta);
      const st = this.st;
      st.metaName = name !== null && name !== undefined && text(name).trim() ? text(name).trim() : norm.meta.name || null;
      st.stack = [];
      st.watchdog = null;
      st.lastFired = null;
      st.lastError = null;
      this._pending = [];
      this._echoed.clear();
      this._destroyViews();
      this.enterState(DEFAULT_STATE, "load");
      this._emitMeta();
      return { ok: true, warnings: norm.warnings };
    } catch (e) {
      this.log(`load failed: ${errText(e)}`);
      return { ok: false, warnings: [], error: errText(e) };
    }
  }

  /**
   * Panel edits / rebind restore (critic C3): swap rules and navs WITHOUT
   * entering Default. Keeps state, stack, watchdog, views, enteredAt/P; fired
   * flags are kept for rule ids that still exist and dropped for removed ids;
   * a rule moved to another state is un-fired. keepState:false ⇒ load().
   */
  replaceMeta(meta, { keepState = true } = {}) {
    try {
      if (!keepState) return this.load(meta, { name: this.st.metaName });
      const norm = normalizeMeta(meta);
      if (!norm.ok) return { ok: false, warnings: norm.warnings, error: norm.error };
      const before = this._ruleById;
      this._install(norm.meta);
      const fired = {};
      for (const id of Object.keys(this.st.fired || {})) {
        const now = this._ruleById.get(id);
        if (!now) continue; // removed rule
        const was = before.get(id);
        if (was && lower(was.state) !== lower(now.state)) continue; // moved to another state
        fired[id] = true;
      }
      this.st.fired = fired;
      if (!this.st.metaName) this.st.metaName = norm.meta.name || null;
      this._decideNow = true;
      this._emitMeta();
      return { ok: true, warnings: norm.warnings };
    } catch (e) {
      this.log(`replaceMeta failed: ${errText(e)}`);
      return { ok: false, warnings: [], error: errText(e) };
    }
  }

  unload() {
    try {
      this._install(null);
      this.st.metaName = null;
      this.st.stack = [];
      this.st.watchdog = null;
      this._pending = [];
      this._destroyViews();
      this.enterState(DEFAULT_STATE, "load");
      this._emitMeta();
    } catch (e) {
      this.log(`unload failed: ${errText(e)}`);
    }
  }

  meta() {
    return this._meta;
  }

  /** Additive: fn(meta|null) after load / replaceMeta / unload (INT-2 keeps session.meta in sync). */
  onMetaChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._metaListeners.add(fn);
    return () => this._metaListeners.delete(fn);
  }

  _emitMeta() {
    for (const fn of [...this._metaListeners]) {
      try {
        fn(this._meta);
      } catch (e) {
        this.log(`onMetaChange listener failed: ${errText(e)}`);
      }
    }
  }

  _install(meta) {
    this._meta = meta;
    this._buckets = new Map();
    this._stateNames = new Map();
    this._ruleById = new Map();
    if (!meta) return;
    for (const r of meta.rules) {
      const k = lower(r.state);
      if (!this._buckets.has(k)) {
        this._buckets.set(k, []);
        this._stateNames.set(k, r.state);
      }
      this._buckets.get(k).push(r);
      this._ruleById.set(r.id, r);
    }
  }

  // ── enable / debug ───────────────────────────────────────────────────────

  get enabled() {
    try {
      const s = this.ctx.settings;
      return !!(s && typeof s.getValue === "function" && s.getValue("EnableMeta"));
    } catch {
      return false;
    }
  }

  set enabled(v) {
    try {
      const s = this.ctx.settings;
      if (s && typeof s.set === "function") s.set("EnableMeta", !!v, { source: "meta" });
      if (v) this._decideNow = true;
    } catch (e) {
      this.log(`EnableMeta write failed: ${errText(e)}`);
    }
  }

  setDebug(on) {
    this.st.debug = !!on;
  }

  // ── state ────────────────────────────────────────────────────────────────

  get state() {
    return this.st.state;
  }

  get stackDepth() {
    return this.st.stack.length;
  }

  /**
   * THE ONLY state writer. Every entry — including a same-state one — clears
   * all fired flags, resets the Seconds-in-State timer (and the (P) timer
   * unless why === "macroStart"), clears the watchdog and asks for a pass.
   * → true, or false for an empty name (nothing changes).
   */
  enterState(name, why = "set") {
    try {
      const n = text(name).trim();
      if (!n) {
        this.log(`enterState(${why}): empty state name ignored`);
        return false;
      }
      const canonical = this._stateNames.get(n.toLowerCase()) || n;
      const now = this._clock();
      const st = this.st;
      const from = st.state;
      st.state = canonical;
      st.fired = {};
      st.enteredAt = now;
      if (why !== "macroStart") st.enteredAtP = now;
      st.watchdog = null;
      this._entrySeq++;
      this._decideNow = true;
      if (st.debug && why !== "macroStart") this._print(`[Meta] state ${from} → ${canonical} (${why})`);
      return true;
    } catch (e) {
      this.log(`enterState failed: ${errText(e)}`);
      return false;
    }
  }

  _callState(to, ret) {
    const target = text(to).trim();
    if (!target) {
      this._echoError("CallState: empty target state", this._curRuleId);
      return false;
    }
    const back = text(ret).trim() || this.st.state; // explicit return state (B2/B8), RynthAi data ⇒ current
    this.st.stack.push(back);
    if (this.st.stack.length > STACK_CAP) {
      this.st.stack.splice(0, this.st.stack.length - STACK_CAP);
      this._warnOnce("stackcap", `[Meta] call stack exceeded ${STACK_CAP} entries; the oldest return state was dropped`);
    }
    return this.enterState(target, "call");
  }

  _returnFromCall() {
    if (this.st.stack.length === 0) {
      // GUIDE:283: "If the call stack is empty, an error is raised and meta is disabled."
      const reason = "Return From Call with an empty call stack";
      this._recordError(reason, this._curRuleId);
      this._print(`[Meta] ${reason} - meta disabled`);
      this._disableMeta(reason);
      this._stopPass = true;
      return false;
    }
    const back = this.st.stack.pop();
    return this.enterState(back, "return");
  }

  _disableMeta(reason) {
    try {
      const s = this.ctx.settings;
      if (s && typeof s.disableMeta === "function") s.disableMeta(reason);
      else if (s && typeof s.set === "function") s.set("EnableMeta", false, { source: "meta" });
    } catch (e) {
      this.log(`disableMeta failed: ${errText(e)}`);
    }
  }

  // ── watchdog ─────────────────────────────────────────────────────────────

  _setWatchdog({ state, dist, secs }) {
    const target = text(state).trim();
    if (!target) return false;
    const now = this._clock();
    // A second SetWatchdog REPLACES the first (RynthAi ignores it; U5 §2.8).
    this.st.watchdog = {
      state: target,
      dist: Number(dist),
      secs: Number(secs),
      anchor: this._worldPos(),
      remainingMs: Number(secs) * 1000,
      lastAt: now,
    };
    return true;
  }

  _worldPos() {
    try {
      const p = this.ctx.player;
      const w = p && typeof p.world === "function" ? p.world() : null;
      if (!w || !finite(Number(w.wx)) || !finite(Number(w.wy))) return null;
      return { wx: Number(w.wx), wy: Number(w.wy), z: Number(w.z) || 0 };
    } catch {
      return null;
    }
  }

  _portalActive() {
    try {
      const p = this.ctx.portal;
      return !!(p && typeof p.active === "function" && p.active());
    } catch {
      return false;
    }
  }

  // Advances the watchdog clock. Counts down only when `active` (running,
  // enabled, loaded, not in portal space) and the pose is known; moving
  // ≥ dist (world frame, metres) re-anchors and restarts the countdown.
  // → true when it fired (SetState to its state).
  _watchdogStep(now, active) {
    const wd = this.st.watchdog;
    if (!wd) return false;
    let dt = finite(wd.lastAt) ? now - wd.lastAt : 0;
    if (!(dt > 0)) dt = 0;
    if (dt > WATCHDOG_MAX_STEP_MS) dt = WATCHDOG_MAX_STEP_MS;
    wd.lastAt = now;
    if (!active) return false;
    const pos = this._worldPos();
    if (!pos) return false;
    const full = (finite(wd.secs) ? wd.secs : 0) * 1000;
    if (!wd.anchor) {
      wd.anchor = pos;
      wd.remainingMs = full;
      return false;
    }
    if (dist3(pos, wd.anchor) >= (finite(wd.dist) ? wd.dist : 0)) {
      wd.anchor = pos;
      wd.remainingMs = full;
      return false;
    }
    wd.remainingMs = (finite(wd.remainingMs) ? wd.remainingMs : full) - dt;
    if (wd.remainingMs > 0) return false;
    const target = wd.state;
    this._print(`[Meta] Watchdog triggered → ${target}`);
    this.enterState(target, "watchdog");
    return true;
  }

  // ── inputs ───────────────────────────────────────────────────────────────

  /**
   * Latch an edge event for the next pass (exactly one pass sees it) and ask
   * for a pass now. { type: "chat", text, chatType } | { type: "death" } |
   * { type: "portalIn" } | { type: "portalOut" } | { type: "vendorOpen",
   * guid, name } | { type: "vendorClose", guid }.
   */
  pushEvent(evt) {
    try {
      if (this._destroyed || !evt || typeof evt !== "object") return;
      const type = evt.type;
      if (!EVENT_TYPES.includes(type)) {
        this.log(`pushEvent: ignoring unknown event type ${text(type)}`);
        return;
      }
      let e;
      switch (type) {
        case "chat":
          e = { type, text: text(evt.text), chatType: Number(evt.chatType) >>> 0 };
          if (evt.cat !== undefined && evt.cat !== null) e.cat = Number(evt.cat) >>> 0;
          break;
        case "death":
          if (evt.self === false) return; // only our own death (INT-2 forwards self deaths)
          e = { type };
          break;
        case "vendorOpen":
          e = { type, guid: Number(evt.guid) >>> 0, name: text(evt.name) };
          this._vendor = { guid: e.guid, name: e.name };
          break;
        case "vendorClose":
          e = { type, guid: Number(evt.guid) >>> 0 };
          this._vendor = null;
          break;
        case "portalIn":
          this._releaseHostEffects("portal"); // V-12: no movement key held into portal space
          e = { type };
          break;
        default:
          e = { type };
      }
      this._pending.push(e);
      if (this._pending.length > MAX_PENDING_EVENTS) {
        this._pending.splice(0, this._pending.length - MAX_PENDING_EVENTS);
        this.log(`event buffer over ${MAX_PENDING_EVENTS}; oldest events dropped`);
      }
      this._decideNow = true;
    } catch (e) {
      this.log(`pushEvent failed: ${errText(e)}`);
    }
  }

  /** The macro "deciding what to do next" (GUIDE:237): a kernel action change asks for a pass. */
  noteKernelAction(action) {
    const a = action === undefined ? null : action;
    if (a !== this._lastAction) {
      this._lastAction = a;
      this._decideNow = true;
    }
  }

  // ── the heartbeat ────────────────────────────────────────────────────────

  tick(nowMs, { running = true } = {}) {
    if (this._destroyed) return;
    const outerTickNow = this._tickNow;
    try {
      const now = finite(nowMs) ? nowMs : this._clock();
      this._tickNow = now;
      const run = running !== false;
      const st = this.st;
      this._flushVars(false); // ALWAYS (throttled inside the VarStore)
      if (run) this._pumpDelayed(now); // V-7: held ⇒ queued delayexec entries wait

      const wasRunning = st.running === true;
      st.running = run;
      if (!run) {
        if (wasRunning) {
          this._flushVars(true); // persist pending vars on stop
          this._releaseHostEffects("hold"); // I-3: STOP lets go of setmotion keys
        }
        this._closedGate(now);
        return;
      }
      if (!wasRunning) this.enterState(st.state, "macroStart"); // Run Macro off→on edge
      if (!this._meta || !this.enabled) {
        this._closedGate(now);
        return;
      }
      this._watchdogStep(now, !this._portalActive());
      const since = now - this._lastPass;
      // A clock that stepped back (since < 0) must not stall passes until it catches up.
      if (!this._decideNow && since >= 0 && since < PASS_INTERVAL_MS) return;
      this._pass(now);
    } catch (e) {
      this.log(`tick failed: ${errText(e)}`);
    } finally {
      this._tickNow = outerTickNow;
    }
  }

  // Gate closed (held, disabled or nothing loaded): the watchdog clock is
  // paused and latched events are dropped (no pass can see them).
  _closedGate(now) {
    this._watchdogStep(now, false);
    if (this._pending.length) this._pending = [];
  }

  // Let go of what host functions engaged (setmotion keys; FunctionRegistry
  // release hooks): on the running→held edge, portalIn and destroy.
  _releaseHostEffects(reason) {
    try {
      const f = this.expr && this.expr.functions;
      if (f && typeof f.release === "function") f.release(reason);
    } catch (e) {
      this.log(`release (${reason}) failed: ${errText(e)}`);
    }
  }

  _flushVars(force) {
    try {
      const vars = this.expr && this.expr.vars;
      if (vars && typeof vars.flush === "function") vars.flush(force ? { force: true } : undefined);
    } catch (e) {
      this.log(`var flush failed: ${errText(e)}`);
    }
  }

  _pumpDelayed(now) {
    try {
      if (this.expr && typeof this.expr.pump === "function") this.expr.pump(now);
    } catch (e) {
      this.log(`delayexec pump failed: ${errText(e)}`);
    }
  }

  _pass(now) {
    this._lastPass = now;
    this._decideNow = false;
    this._stopPass = false;
    const evts = this._pending;
    this._pending = [];
    const meta = this._meta;
    const st = this.st;
    const bucket = this._buckets.get(lower(st.state)) || [];
    const seq0 = this._entrySeq;
    const rc = this._makeRc(now, evts);
    try {
      for (const rule of bucket) {
        if (this._destroyed || this._meta !== meta || this._entrySeq !== seq0 || this._stopPass) break;
        if (rule.enabled === false || st.fired[rule.id] === true) continue;
        this._curRuleId = rule.id;
        rc.rule = rule;
        let hit = false;
        try {
          hit = evalCondition(rule.cond, rc, 0) === true;
        } catch (e) {
          this._recordError(`condition ${describeCondition(rule.cond)}: ${errText(e)}`, rule.id);
          hit = false;
        }
        // An expression in the condition may itself have entered a state.
        if (this._entrySeq !== seq0 || this._meta !== meta || this._destroyed) break;
        if (!hit) continue;
        st.fired[rule.id] = true;
        const cond = describeCondition(rule.cond);
        const act = describeAction(rule.act);
        st.lastFired = { ruleId: rule.id, state: rule.state, cond, act, at: now };
        if (st.debug) this._print(`[Meta] ${rule.state} | ${cond} → ${act}`);
        try {
          runAction(rule.act, rc, 0);
        } catch (e) {
          // B14 fix: the rule STAYS fired; nothing is re-armed.
          this._recordError(`action ${act}: ${errText(e)}`, rule.id);
        }
        if (this._entrySeq !== seq0 || this._stopPass) break;
        if (!this.enabled) break; // SetOpt EnableMeta false / disabled by a command
      }
    } finally {
      this._curRuleId = null;
      rc.rule = null;
    }
  }

  _makeRc(now, evts) {
    const eng = this;
    const rc = {
      ctx: this.ctx,
      events: evts,
      values: this.values,
      meta: this._meta,
      now,
      rule: null,
      secondsInState: () => (now - eng.st.enteredAt) / 1000,
      secondsInStateP: () => (now - eng.st.enteredAtP) / 1000,
      vendorOpen: () => eng._vendor !== null,
      evaluate: (src) => eng._evaluate(src),
      regex: (p, f) => eng._regex(p, f),
      setVar: (n, v) => eng._setVar(n, v),
      exprError: (msg) => eng._echoError(msg, rc.rule ? rc.rule.id : null),
      echoError: (msg) => eng._echoError(msg, rc.rule ? rc.rule.id : null),
      recordError: (msg) => eng._recordError(msg, rc.rule ? rc.rule.id : null),
      warnOnce: (key, msg) => eng._warnOnce(key, msg),
      print: (t, c) => eng._print(t, c),
      enterState: (n, why) => eng.enterState(n, why),
      callState: (to, ret) => eng._callState(to, ret),
      returnFromCall: () => eng._returnFromCall(),
      setWatchdog: (spec) => eng._setWatchdog(spec || {}),
      clearWatchdog: () => {
        eng.st.watchdog = null;
      },
      chatRun: (line) => eng._chatRun(line),
    };
    return rc;
  }

  _evaluate(src) {
    if (!this.expr || typeof this.expr.evaluate !== "function") return { t: "err", msg: "no expression runtime" };
    try {
      const v = this.expr.evaluate(text(src));
      return v === undefined ? null : v;
    } catch (e) {
      return { t: "err", msg: errText(e) }; // the real runtime never throws; fakes might
    }
  }

  _regex(pattern, flags) {
    try {
      return this._getRegex(text(pattern), text(flags), { log: this.log }) || null;
    } catch (e) {
      this._warnOnce(`regex:${pattern}`, `[Meta] bad regex /${text(pattern)}/: ${errText(e)}`);
      return null;
    }
  }

  _setVar(name, value) {
    try {
      if (this._setVarFn) this._setVarFn(text(name), value);
    } catch (e) {
      this.log(`setVar ${text(name)} failed: ${errText(e)}`);
    }
  }

  _chatRun(line) {
    const chat = this.ctx.chat;
    if (!chat || typeof chat.run !== "function") {
      this._warnOnce("nochat", "[Meta] Chat Command: no command runner is available");
      return;
    }
    chat.run(text(line));
  }

  // ── errors / output ──────────────────────────────────────────────────────

  _print(t, category = CHAT_SYSTEM) {
    try {
      if (typeof this.ctx.print === "function") this.ctx.print(text(t), finite(category) ? category : CHAT_SYSTEM);
      else this.log(text(t));
    } catch (e) {
      this.log(`print failed: ${errText(e)}`);
    }
  }

  _recordError(msg, ruleId = null) {
    this.st.lastError = { msg: text(msg), at: this._clock(), ruleId: ruleId ?? null };
    this.log(`${ruleId ? `rule ${ruleId}: ` : ""}${text(msg)}`);
    if (this.st.debug) this._print(`[Meta] error${ruleId ? ` in rule ${ruleId}` : ""}: ${text(msg)}`);
  }

  // lastError + one chat line per (rule, message) until the next meta load.
  _echoError(msg, ruleId = null) {
    this.st.lastError = { msg: text(msg), at: this._clock(), ruleId: ruleId ?? null };
    const key = `${ruleId ?? ""}\u0000${text(msg)}`;
    if (this._echoed.has(key)) return;
    if (this._echoed.size > 1024) this._echoed.clear();
    this._echoed.add(key);
    const r = ruleId ? this._ruleById.get(ruleId) : null;
    this._print(`[Meta] error${ruleId ? ` in rule ${ruleId}${r ? ` (${r.state})` : ""}` : ""}: ${text(msg)}`);
  }

  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    if (this._warned.size > 1024) this._warned.clear();
    this._warned.add(key);
    this._print(msg);
  }

  _destroyViews() {
    try {
      const v = this.ctx.views;
      if (v && typeof v.destroyAll === "function") v.destroyAll();
    } catch (e) {
      this.log(`destroying views failed: ${errText(e)}`);
    }
  }

  // ── observability ────────────────────────────────────────────────────────

  /** MetaSnapshot (§3.12) + additive `name`, `loaded`, `stack`. Never throws. */
  snapshot() {
    try {
      const st = this.st;
      const now = this._clock();
      const meta = this._meta;
      const states = [];
      const seen = new Set();
      const add = (s) => {
        const k = lower(s);
        if (!k || seen.has(k)) return;
        seen.add(k);
        states.push(text(s).trim());
      };
      add(DEFAULT_STATE);
      if (meta) for (const r of meta.rules) add(r.state);
      add(st.state);
      const fired = meta ? meta.rules.filter((r) => st.fired[r.id] === true).map((r) => r.id) : [];
      const wd = st.watchdog;
      return {
        enabled: this.enabled,
        running: st.running === true,
        name: st.metaName,
        loaded: !!meta,
        state: st.state,
        secondsInState: Math.max(0, (now - st.enteredAt) / 1000),
        secondsInStateP: Math.max(0, (now - st.enteredAtP) / 1000),
        stackDepth: st.stack.length,
        stack: [...st.stack],
        ruleCount: meta ? meta.rules.length : 0,
        stateCount: meta ? this._buckets.size : 0,
        states,
        fired,
        watchdog: wd ? { state: wd.state, dist: wd.dist, secsRemaining: Math.max(0, (finite(wd.remainingMs) ? wd.remainingMs : 0) / 1000) } : null,
        lastFired: st.lastFired ? { ...st.lastFired } : null,
        lastError: st.lastError ? { ...st.lastError } : null,
        debug: st.debug === true,
      };
    } catch (e) {
      this.log(`snapshot failed: ${errText(e)}`);
      return {
        enabled: false,
        running: false,
        name: null,
        loaded: false,
        state: DEFAULT_STATE,
        secondsInState: 0,
        secondsInStateP: 0,
        stackDepth: 0,
        stack: [],
        ruleCount: 0,
        stateCount: 0,
        states: [DEFAULT_STATE],
        fired: [],
        watchdog: null,
        lastFired: null,
        lastError: null,
        debug: false,
      };
    }
  }

  /** Detach: views destroyed, vars force-flushed, pending events dropped. The state object survives (D6). Idempotent. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseHostEffects("detach");
    this._destroyViews();
    this._flushVars(true);
    this._pending = [];
    this._metaListeners.clear();
  }
}
