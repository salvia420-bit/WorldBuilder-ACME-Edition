// operator_stop.js — durable operator stop latches + the ONE stop/resume/state
// authority over a running bot (OperatorControl).
//
// ── 1. AI-director latch (task #11, 2026-07-19) ─────────────────────────────
// Bug it fixes: the ?bot=1 auto-boot block (index.html) rebuilds a fresh bot
// from URL params on every session takeover/reconnect. Because the stream-rig
// URL carries botModel/botInterval, the fresh bot auto-started a NEW AI
// director even when the operator had deliberately stopped the previous one
// via window.rynthAI.stop(). A soak once closed with the director stopped; a
// 04:24 auto-reconnect booted a fresh director that ran ~11h and burned
// OpenRouter credits against a stuck character.
//
// Fix: rynthAI.stop() writes a persistent latch; rynthAI.start() clears it;
// the auto-boot cfg assembly forces cfg.ai = false whenever the latch is set,
// so an operator stop survives reloads AND reconnect reboots. localStorage
// (not sessionStorage) is used deliberately so the latch also survives a full
// browser restart. The latch is ADDITIVE: ?botAi=off still forces the director
// off on its own; the latch is an extra AND-style suppressor. When the latch
// is absent (operator never touched rynthAI) behavior is unchanged.
//
// ── 2. Bot-wide latch + OperatorControl (2026-10-12) ────────────────────────
// The 2026-07-23 review's open P1 ("no single mechanism is authoritative over
// who owns the character right now"): `!bot pause` held the kernel but left a
// goto/route walking and the director's latch alone; rynthAI.stop() stopped
// only the director; nothing survived a reconnect except the AI latch. The
// RynthSuite HUD's RUNNING/STOPPED button needs ONE call that stops
// everything, ONE that undoes it, and ONE truthful state read.
// OperatorControl is that authority — getOperatorControl(bot) hands out the
// single instance attached as `bot.control`:
//   stop()   kernel operator hold (start() refused for EVERY caller, the AI
//            `resume` action included) + director stopped + router/goto
//            cancelled + unwedge recovery cancelled + pursuit/stick stopped;
//            persisted by default under THIS character's key
//            (botStopKey(guid) — other bot tabs on the origin are not
//            stopped) so a reconnect reboot boots the bot HELD
//            (applyOperatorStopToCfg(cfg, storage, guid) sets cfg.startHeld).
//   resume() undoes exactly that: clears the latch, releases the hold and
//            restarts the kernel and the director only if THEY were running
//            before the stop. "Running" includes a kernel a mover (goto,
//            route, approach, unwedge) had paused for its walk —
//            bot.kernelEnabled + bot.movementClaimed(); an AI-paused kernel
//            or an AI-latched director stays off.
//   state()  one plain snapshot for a UI to poll (cheap; no wasm walks).
// The AI latch (section 1) stays independent: a bot stop never sets it and a
// bot resume never clears it — setAi() is the HUD's AI toggle over it.
//
// Pure + storage-injectable so it is unit-testable under plain `node` (which
// has no localStorage): every entry point accepts an optional storage object
// and defaults to globalThis.localStorage in the browser. No imports.

export const OPERATOR_STOP_KEY = "rynthAiOperatorStop";
export const BOT_STOP_KEY = "rynthBotOperatorStop";

function resolveStore(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function setFlag(storage, key) {
  const s = resolveStore(storage);
  try { s?.setItem(key, "1"); } catch { /* blocked storage */ }
}
function clearFlag(storage, key) {
  const s = resolveStore(storage);
  try { s?.removeItem(key); } catch { /* blocked storage */ }
}
function readFlag(storage, key) {
  const s = resolveStore(storage);
  try { return s?.getItem(key) === "1"; } catch { return false; }
}

// Operator pressed stop: persist the latch. Blocked/absent storage is a no-op.
export function latchOperatorStop(storage) {
  setFlag(storage, OPERATOR_STOP_KEY);
}

// Operator pressed start: release the latch so auto-boot may run the director.
export function clearOperatorStop(storage) {
  clearFlag(storage, OPERATOR_STOP_KEY);
}

export function isOperatorStopLatched(storage) {
  return readFlag(storage, OPERATOR_STOP_KEY);
}

// Bot-wide latch (OperatorControl.stop({persist}) writes it, resume() clears it).
//
// PER CHARACTER (2026-10-12 review #4): localStorage is shared by every tab on
// the origin, so ONE key meant a STOP in one bot tab silently stopped every
// other bot tab (their directors refused check-ins, their HUDs read STOPPED).
// The latch is therefore keyed by a SCOPE — the character's player guid —
// `rynthBotOperatorStop:<guid u32 decimal>`. A missing/0 scope maps to the
// bare key in these helpers only for LEGACY compatibility: OperatorControl
// never writes it (a STOP before the guid is readable is held in memory and
// persisted under the scoped key once it resolves) and never reads it (an
// unresolved scope reads nothing); boot.js honours a bare key that already
// exists, and resume() clears it (review-2 #5). The AI latch above stays
// origin-wide on purpose.

/** The storage key for a scope (player guid); a missing/0 scope = the bare key. */
export function botStopKey(scope) {
  const sc = Number(scope) >>> 0;
  return sc ? `${BOT_STOP_KEY}:${sc}` : BOT_STOP_KEY;
}
export function latchBotStop(storage, scope) {
  setFlag(storage, botStopKey(scope));
}
export function clearBotStop(storage, scope) {
  clearFlag(storage, botStopKey(scope));
}
export function isBotStopLatched(storage, scope) {
  return readFlag(storage, botStopKey(scope));
}

/** The latch scope of a createGrindBot() bot: its character's player guid,
 *  read from the host snapshot, else straight off the session handle (the
 *  snapshot is empty until the host's first tick). null when unknown. */
export function botScopeOf(bot) {
  const h = safe(() => bot?.host ?? null);
  let id = safe(() => (typeof h?.GetPlayerId === "function" ? Number(h.GetPlayerId()) >>> 0 : 0), 0);
  if (!id) {
    id = safe(() => {
      const s = h?.unsafeHandle ?? h?.s ?? null;
      return typeof s?.playerGuid === "function" ? Number(s.playerGuid()) >>> 0 : 0;
    }, 0);
  }
  return id || null;
}

/** Is this bot operator-stopped right now? bot.control's answer when attached
 *  (in-memory stop, kernel hold, a persist-pending stop, its character's
 *  latch); else the kernel hold or THIS character's latch. Never the bare
 *  origin-wide key — an unresolved scope reads nothing (review-2 #5). The
 *  director's check-in gate and the plan executor read this. */
export function isBotOperatorStopped(bot, storage) {
  const ctl = safe(() => bot?.control ?? null);
  if (ctl && typeof ctl.isStopped === "function") return safe(() => ctl.isStopped() === true, false);
  if (safe(() => bot?.kernel?.operatorHeld === true, false)) return true;
  const sc = botScopeOf(bot);
  return sc ? isBotStopLatched(storage, sc) : false;
}

/** Both latches at once, for a boot log line: { ai, bot }. Never throws. */
export function describeOperatorStop(storage, scope) {
  return { ai: isOperatorStopLatched(storage), bot: isBotStopLatched(storage, scope) };
}

// Auto-boot decision: when the AI latch is set, force the AI director off on
// the assembled bot config, regardless of botModel/botInterval params. When
// the BOT-wide latch is set, also mark cfg.startHeld = true (bot.js boots the
// kernel under an operator hold and defers the director's autoStart until
// OperatorControl.resume()). Mutates cfg in place and returns true iff it
// suppressed the director (the existing caller's log line) — the startHeld
// side effect does not change the return value; describeOperatorStop() is
// the precise read for logging. A missing/invalid cfg or absent latches are a
// no-op returning false — the default (never-stopped) path is untouched.
// `scope` = the booting character's player guid (botStopKey): only THAT
// character's stop boots it held.
export function applyOperatorStopToCfg(cfg, storage, scope) {
  if (!cfg || typeof cfg !== "object") return false;
  if (isBotStopLatched(storage, scope)) cfg.startHeld = true;
  if (!isOperatorStopLatched(storage)) return false;
  cfg.ai = false;
  return true;
}

// ── OperatorControl ─────────────────────────────────────────────────────────

// Loops the HUD may toggle. Each resolves on the bot surface first (bot.js
// puts every loop on the bot object) and on the kernel second (the shape a
// bare kernel-only harness builds). `enabled` is a plain property: combat /
// loot / unwedge already gate on it; buff / vitals need kernel.js to honor it
// (see the module report — until then their toggle reads back but does not
// stop the loop).
const SUBSYSTEM_LOOKUP = {
  combat: (b) => b?.combat ?? b?.kernel?.combat ?? null,
  loot: (b) => b?.loot ?? b?.kernel?.loot ?? null,
  buff: (b) => b?.buff ?? b?.kernel?.buff ?? null,
  vitals: (b) => b?.vitals ?? b?.kernel?.vitals ?? null,
  unwedge: (b) => b?.unwedge ?? b?.kernel?.unwedge ?? null,
};
export const OPERATOR_SUBSYSTEMS = Object.freeze(Object.keys(SUBSYSTEM_LOOKUP));

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

export class OperatorControl {
  /**
   * @param bot the createGrindBot() object (kernel, ai.director, router,
   *            globalRouter, unwedge, host, combat/loot/buff/vitals)
   * @param opts { storage?: Storage-like (tests), log?: (line) => void,
   *              scope?: the bot-stop latch scope (default: the bot's
   *              character guid, botScopeOf) }
   */
  constructor(bot, { storage = null, log = null, scope = null } = {}) {
    this.bot = bot;
    this._storage = storage;
    this._log = typeof log === "function" ? log : null;
    this._scopeFixed = Number(scope) >>> 0 || null; // explicit scope (tests / callers that know it)
    this._scopeSeen = null; // first non-zero guid resolved off the bot (stable for a bot's life)
    this._latchKeyWritten = null; // the exact key our last persisted stop() wrote (resume clears it)
    // A persisted stop() issued before the character's guid was readable:
    // held in memory and written under the SCOPED key once the scope resolves
    // (_flushPendingLatch) — never under the bare origin-wide key, which every
    // other bot tab would read as its own stop (review-2 #5).
    this._persistPending = false;
    this._stopped = false; // a stop() issued through THIS control is in effect
    this._stoppedAt = null;
    this._reason = null;
    // Pre-stop memory, captured on the FIRST stop() only. null = unknown
    // (the bot was already held when the control first saw it — a boot-held
    // reboot or an external hold); resume() then falls back to "a live hold
    // means it was running" for the kernel and bot.ai.deferredAutoStart for
    // the director.
    this._kernelWasRunning = null;
    this._directorWasEnabled = null;
    this._listeners = new Set();
  }

  _kernel() { return safe(() => this.bot?.kernel ?? null); }
  _director() { return safe(() => this.bot?.ai?.director ?? null); }

  /** This bot's latch scope: the explicit opts.scope, else its character's
   *  guid (cached once seen — a bot instance never changes character), else
   *  null = the bare origin-wide key. */
  _scope() {
    if (this._scopeFixed) return this._scopeFixed;
    if (this._scopeSeen) return this._scopeSeen;
    const sc = botScopeOf(this.bot);
    if (sc) this._scopeSeen = sc;
    return sc;
  }

  /** THIS character's persisted bot latch. Unknown scope -> false: the
   *  control never reads (or writes) the bare origin-wide key — a legacy one
   *  is honoured only by the boot (boot.js) and cleared by resume(). */
  _latchedScoped() {
    const sc = this._scope();
    return sc ? isBotStopLatched(this._storage, sc) : false;
  }

  /** Write a pending persisted stop once the scope (guid) is known. Cheap
   *  no-op otherwise; state(), isStopped() and the host tick call it. */
  _flushPendingLatch() {
    if (!this._persistPending || !this._stopped) return;
    const sc = this._scope();
    if (!sc) return;
    latchBotStop(this._storage, sc);
    this._latchKeyWritten = botStopKey(sc);
    this._persistPending = false;
    this._logLine("operator STOP persisted (character resolved)");
  }

  /** True while the bot is operator-stopped by ANY route: a stop() through
   *  this control, a live kernel operator hold, or THIS character's persisted
   *  bot latch. */
  isStopped() {
    this._flushPendingLatch();
    if (this._stopped) return true;
    if (safe(() => this._kernel()?.operatorHeld === true, false)) return true;
    return this._latchedScoped();
  }

  /** Was the grind kernel meant to be running when stop() was pressed? It is
   *  stopped (not running) for the whole of any mover's walk — goto, egress,
   *  route follow, travel, an AI approach, an unwedge recovery — each of
   *  which restarts it when the walk ends. Under the operator hold that
   *  restart is refused, so the "was running" answer must come from the
   *  mover's claim, or resume() would leave the bot standing (review #1).
   *  bot.kernelEnabled is false for a kernel-off (explorer/pure-travel) bot. */
  _kernelMeantToRun(k) {
    if (safe(() => k?.running === true, false)) return true;
    // A kernel the DIRECTOR paused on purpose (the AI `pause` action →
    // kernel.pauseFor("ai")) stays off across STOP/RESUME even while a mover
    // walks — that goto/route captured wasRunning=false and would leave it
    // off too (review-2 #4).
    if (safe(() => k?.pausedBy === "ai", false)) return false;
    const b = this.bot;
    if (safe(() => b?.kernelEnabled === true, false) !== true) return false;
    return safe(() => typeof b?.movementClaimed === "function" && b.movementClaimed() === true, false);
  }

  /** One plain snapshot for a UI to poll (2-4 Hz is fine — no wasm walks
   *  beyond the cheap kernel/director status getters). Never throws. */
  state() {
    this._flushPendingLatch();
    const b = this.bot;
    const k = this._kernel();
    const d = this._director();
    const scope = this._scope();
    const latched = { bot: this._latchedScoped(), ai: isOperatorStopLatched(this._storage) };
    const held = safe(() => k?.operatorHeld === true, false);
    const stopped = this._stopped || held || latched.bot;
    const ks = safe(() => k?.status ?? null);
    const ds = safe(() => d?.status ?? null);
    const subsystems = {};
    for (const name of OPERATOR_SUBSYSTEMS) {
      const loop = safe(() => SUBSYSTEM_LOOKUP[name](b));
      subsystems[name] = loop ? safe(() => loop.enabled !== false, true) : null;
    }
    return {
      stopped,
      running: !stopped,
      reason: stopped
        ? this._reason ?? (held ? "kernel operator hold" : latched.bot ? "persisted bot-stop latch" : null)
        : null,
      since: stopped ? this._stoppedAt : null,
      latched,
      scope, // the character guid the bot-stop latch is keyed by (null = not resolved yet)
      persistPending: this._persistPending, // a STOP waiting for the scope to be written
      kernel: k
        ? {
            running: safe(() => k.running === true, false),
            held,
            action: safe(() => ks?.action ?? k.action ?? null),
            kills: safe(() => ks?.kills ?? null),
            looted: safe(() => ks?.looted ?? null),
            // combat_loop status passthrough (kernel.status.combat, when the
            // kernel publishes it): { state, enabled, locked, mode, … }.
            combat: safe(() => ks?.combat ?? null),
            // The SAME kernel.status read's buff / vitals blocks, so a UI
            // never recomputes them (vitals.status copies wasm stats) —
            // undefined when the kernel does not publish them (review-2 #8).
            buffs: ks && Object.prototype.hasOwnProperty.call(ks, "buffs") ? ks.buffs : undefined,
            vitals: ks && Object.prototype.hasOwnProperty.call(ks, "vitals") ? ks.vitals : undefined,
            pausedBy: safe(() => ks?.pausedBy ?? k.pausedBy ?? null),
          }
        : null,
      ai: d
        ? {
            enabled: safe(() => d.enabled === true, false),
            busy: safe(() => (typeof d.isBusy === "function" ? d.isBusy() === true : ds?.running === true), false),
            disposed: safe(() => d.disposed === true, false),
            nextCheckAt: safe(() => ds?.nextCheckAt ?? null),
            lastCheckAt: safe(() => ds?.lastCheckAt ?? null),
            lastSummary: safe(() => ds?.lastSummary ?? null),
            calls: safe(() => ds?.calls ?? null),
            errors: safe(() => ds?.consecutiveErrors ?? null),
            deferredAutoStart: safe(() => b?.ai?.deferredAutoStart === true, false),
          }
        : null,
      subsystems,
      movement: {
        router: safe(() => b?.router?.status?.state ?? null),
        goto: safe(() => b?.globalRouter?.busy === true, false),
        mission: safe(() => (b?.mission ? b.mission.label ?? b.mission.kind ?? "mission" : null)),
        unwedge: safe(() => b?.unwedge?.state ?? null),
      },
    };
  }

  /**
   * Stop EVERYTHING the bot drives and hand the character back to the
   * player. Idempotent (a repeat stop() refreshes the reason and re-halts
   * movement but keeps the FIRST stop's pre-stop memory). opts.persist
   * (default true) writes the bot-wide latch so a reconnect/reload reboot
   * comes back held. -> state()
   */
  stop({ persist = true, reason = "operator" } = {}) {
    const k = this._kernel();
    const d = this._director();
    if (!this._stopped) {
      // A live hold we did not set means the true pre-stop state is unknown
      // (null) — resume() then infers it (see the constructor note).
      const held = safe(() => k?.operatorHeld === true, false);
      const unknown = held ? null : false;
      const kernelRan = this._kernelMeantToRun(k);
      const directorRan =
        safe(() => d?.enabled === true, false) || safe(() => this.bot?.ai?.deferredAutoStart === true, false);
      this._kernelWasRunning = k ? (kernelRan ? true : unknown) : null;
      this._directorWasEnabled = d ? (directorRan ? true : unknown) : null;
    }
    this._stopped = true;
    this._stoppedAt = this._stoppedAt ?? Date.now();
    this._reason = String(reason ?? "operator");
    try { k?.holdForOperator?.(); } catch { /* a broken kernel must not block the stop */ }
    try { d?.stop?.(); } catch { /* ditto */ }
    this._haltMovement(this._reason);
    let persistNote = "";
    if (persist) {
      const scope = this._scope();
      if (scope) {
        latchBotStop(this._storage, scope);
        this._latchKeyWritten = botStopKey(scope);
        this._persistPending = false;
        persistNote = " — persisted";
      } else {
        // Guid not readable yet (seconds after login): stop now, persist under
        // THIS character's key once it resolves — never the bare key.
        this._persistPending = true;
        persistNote = " — persist pending (character not resolved yet)";
      }
    }
    this._logLine(`operator STOP (${this._reason})${persistNote}`);
    this._notify();
    return this.state();
  }

  /**
   * Undo stop(): clear the bot latch, release the kernel hold and restart
   * the kernel / director only if each was running before the stop. The AI
   * latch is respected (an AI-latched director stays off). -> state()
   */
  resume() {
    const b = this.bot;
    const k = this._kernel();
    const d = this._director();
    const sc = this._scope();
    if (sc) clearBotStop(this._storage, sc);
    // Whatever key our own stop() wrote (a scope that changed under us).
    if (this._latchKeyWritten && this._latchKeyWritten !== botStopKey(sc)) {
      try { resolveStore(this._storage)?.removeItem(this._latchKeyWritten); } catch { /* blocked storage */ }
    }
    this._latchKeyWritten = null;
    this._persistPending = false;
    // Compat: a LEGACY origin-wide latch (written by a pre-scope control) is
    // what boot.js honoured to boot this bot held — resume clears it.
    clearBotStop(this._storage);
    const held = safe(() => k?.operatorHeld === true, false);
    try { k?.releaseOperatorHold?.(); } catch { /* ignore */ }
    const wantKernel = this._kernelWasRunning ?? held;
    if (k && wantKernel) {
      try { k.start(); } catch { /* start() refusing/throwing leaves it stopped */ }
    }
    let wantAi = this._directorWasEnabled;
    if (wantAi == null) wantAi = safe(() => b?.ai?.deferredAutoStart === true, false);
    if (d && wantAi && !isOperatorStopLatched(this._storage)) {
      try { d.start(); } catch { /* ignore */ }
    }
    try { if (b?.ai) b.ai.deferredAutoStart = false; } catch { /* frozen */ }
    this._stopped = false;
    this._stoppedAt = null;
    this._reason = null;
    this._kernelWasRunning = null;
    this._directorWasEnabled = null;
    this._logLine("operator RESUME");
    this._notify();
    return this.state();
  }

  /** RUNNING <-> STOPPED (the HUD's macro button). -> state() */
  toggle(opts = {}) {
    return this.isStopped() ? this.resume() : this.stop(opts);
  }

  /**
   * The HUD's AI toggle — same durable semantics as rynthAI.start/stop:
   * on clears the AI latch and starts the director (deferred to resume()
   * while the bot is stopped — a director must never drive a held bot);
   * off latches it and stops the director. -> { ok, deferred?, error?, state }
   */
  setAi(on) {
    const d = this._director();
    if (on) {
      clearOperatorStop(this._storage);
      if (!d) {
        this._notify();
        return { ok: false, error: "no AI director on this bot (no API key / ai config at boot)", state: this.state() };
      }
      if (this.isStopped()) {
        this._directorWasEnabled = true;
        this._notify();
        return { ok: true, deferred: true, state: this.state() };
      }
      try { d.start(); } catch (e) { return { ok: false, error: String(e?.message ?? e), state: this.state() }; }
    } else {
      latchOperatorStop(this._storage);
      if (this.isStopped()) this._directorWasEnabled = false;
      try { d?.stop?.(); } catch { /* ignore */ }
    }
    this._notify();
    return { ok: true, state: this.state() };
  }

  /** Toggle one loop's `enabled` flag (OPERATOR_SUBSYSTEMS). Turning combat
   *  off is hunt_stop: no new targets, a locked fight winds down over its
   *  scan grace. -> { ok, error?, state } */
  setEnabled(name, on) {
    const pick = Object.prototype.hasOwnProperty.call(SUBSYSTEM_LOOKUP, name) ? SUBSYSTEM_LOOKUP[name] : null;
    if (!pick) {
      return { ok: false, error: `unknown subsystem ${JSON.stringify(name)} (known: ${OPERATOR_SUBSYSTEMS.join(", ")})`, state: this.state() };
    }
    const loop = safe(() => pick(this.bot));
    if (!loop) return { ok: false, error: `no ${name} loop on this bot`, state: this.state() };
    try { loop.enabled = !!on; } catch (e) { return { ok: false, error: String(e?.message ?? e), state: this.state() }; }
    this._notify();
    return { ok: true, state: this.state() };
  }

  /** Cancel any travel in flight (router walk / goto / route / unwedge
   *  retreat) WITHOUT stopping the loops — the HUD's "stop moving". */
  cancelTravel() {
    this._haltMovement("operator cancel");
    this._notify();
    return this.state();
  }

  /** Subscribe to this control's own transitions (stop/resume/setAi/
   *  setEnabled/cancelTravel). -> unsubscribe(). Poll state() for the rest. */
  onChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  _haltMovement(reason) {
    const b = this.bot;
    try { b?.router?.cancel?.(); } catch { /* router.cancel() also aborts an in-flight goto */ }
    try {
      const u = b?.unwedge;
      if (u) {
        if (typeof u.cancel === "function") u.cancel(`operator: ${reason}`);
        else if (typeof u.active === "function" && u.active() && typeof u._finish === "function") {
          u._finish(false, `operator: ${reason}`);
        }
      }
    } catch { /* ignore */ }
    try { b?.host?.StopStick?.(); } catch { /* ignore */ }
    try { b?.host?.StopCompletely?.(); } catch { /* ignore */ }
  }

  _notify() {
    if (!this._listeners.size) return;
    let st;
    try { st = this.state(); } catch { return; }
    for (const fn of [...this._listeners]) {
      try { fn(st, this); } catch { /* a broken listener must not break the control */ }
    }
  }

  _logLine(line) {
    try { (this._log ?? ((m) => console.log(`[rynth] ${m}`)))(line); } catch { /* no console */ }
  }
}

/**
 * The ONE control for `bot` — returns bot.control when already attached
 * (duck-typed, so a second module instance still finds it), else creates one
 * and attaches it. On creation it enforces a persisted bot-wide stop on a bot
 * that booted running anyway (a bot.js without startHeld support). -> null for
 * a non-object bot.
 */
export function getOperatorControl(bot, opts = {}) {
  if (!bot || typeof bot !== "object") return null;
  const cur = safe(() => bot.control ?? null);
  if (cur && typeof cur.state === "function" && typeof cur.stop === "function" && typeof cur.resume === "function") {
    return cur;
  }
  const ctl = new OperatorControl(bot, opts);
  try { bot.control = ctl; } catch { /* frozen bot: still hand the control back */ }
  try {
    // Only THIS character's latch (an unresolved scope reads nothing — the
    // boot itself honours a legacy bare key via cfg.startHeld).
    const held = bot?.kernel?.operatorHeld === true;
    if (!held && ctl._latchedScoped()) {
      ctl.stop({ persist: true, reason: "persisted bot-stop latch (boot)" });
    }
  } catch { /* enforcement is best-effort */ }
  // Flush a persist-pending STOP as soon as the guid resolves, even when no
  // UI is polling state(): one boolean test per host tick.
  try {
    if (typeof bot.host?.onTick === "function") {
      bot.host.onTick(() => { if (ctl._persistPending) ctl._flushPendingLatch(); });
    }
  } catch { /* no tick — state()/isStopped() still flush */ }
  return ctl;
}

export default getOperatorControl;
