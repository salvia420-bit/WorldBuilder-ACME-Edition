// scene3d/diag/cast.js — spell-cast pipeline observability (WS16)
//
// The cast animation is a JS wall-clock chain (entities.js::playCastSequence)
// gated on wasm MotionTable link resolution (setSwingMotion →
// classifyMotionCommandTyped → lookupMotionLinkForSwing). Every failure in
// that chain is a SILENT no-op from outside (foundation §1.3, S1 map): a
// stance-falsy skip, a link miss, a cold animationCache race, a busy-window
// early-return, or an echo double-play. This surface makes each of those
// measurable without changing any cast behavior.
//
// Same "no cheating" stance as motion.js / combat.js: every hook records
// state the runtime already committed (the gesture it TRIED, the link
// outcome it GOT, the token it bumped). Cost per hook fire is O(1) — a Map
// get + a ring push; a full multi-windup war cast fires ~6 hooks total.
//
// Default-ON, no URL flag (matches the other __diag surfaces — pure
// observation, never alters the cast; the flag-off arm is byte-identical by
// construction because no hook mutates cast behavior). Heavy reads (the
// movement-arbitration wasm poll) are ON-DEMAND getters, so nothing runs
// per-frame; `?renderDiag` is not required.
//
// Devtools entry points exposed on `__diag.cast`:
//   state(guid?)          — live chain state {spellId, gestureIndex, token,
//                           busyUntilMs, phase} for one guid or all
//   busyRemainMs(guid)    — remaining cast busy-window ms, domain-correct
//                           (subtracts performance.now(), NOT Date.now())
//   timelineTail(n=10)    — last N per-cast timeline records (armed→sent→
//                           windup_n→cast→casterEffect→UseDone/fizzle)
//   lastTimeline(guid?)   — most recent record with computed deltas (ms)
//   linkStats({castOnly}) — per-(stance, gesture-id) link hit/miss counts
//                           with miss-reason breakdown
//   echoStats()           — echo-vs-prediction dedup counters
//   movementSnapshot()    — on-demand read of the wasm arbitration getters
//                           (latch / forward-slot / pending-motions / reclaims)
//   summary()             — one-line rollup for operators + probes
//   assertLastCast(spec)  — PASS/DRIFT check helper for probe_cast_matrix.cjs
//   reset()               — zero all counters/rings (keeps subscription)

const MAX_TIMELINE = 64;          // bounded ring of completed/aborted casts
const MAX_WINDUP_STAMPS = 16;     // per-cast windup stamp cap (retail max ~10)
const SUB_POLL_MAX_TICKS = 60;    // ~30s @ 500ms — give up if never logged in

// performance.now() exists in browsers and Node ≥16; fall back for safety.
function _now() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) { /* fall through */ }
  return Date.now();
}

function _hex(u32) {
  return "0x" + ((u32 >>> 0).toString(16).padStart(8, "0"));
}

// Cast-class gesture bands (mirror scene3d/diag/motion.js CAST set + the
// full-32-bit cast gesture class 0x40000000). Used to filter linkStats to
// cast gestures only. Windup band low16 0x6F..0x78 (MagicPowerUp01..10),
// colored band 0x128..0x134, aim/cast-substate 0x2B..0x39, plus the
// 0x40000000-class final cast gestures (MagicBlast/Self/Transfer/etc).
function _isCastGestureCmd(cmd) {
  const c = cmd >>> 0;
  const cls = c & 0xff000000;
  if (cls === 0x40000000) return true;             // final cast gesture class
  if (cls === 0x10000000) {                          // Action-class windups
    const low = c & 0xffff;
    if (low >= 0x6f && low <= 0x78) return true;    // MagicPowerUp01..10
    if (low >= 0x128 && low <= 0x134) return true;  // colored (void) powerups
  }
  return false;
}

export function attachCast(diag) {
  const cast = {
    // ── live chain state (one entry per guid currently/last casting) ──
    // { spellId, token, busyUntilMs, gestureIndex, gestureCount, phase,
    //   startedAt } where phase ∈ requested|windup|cast|effect|done|
    //   fizzled|cancelled|suppressed.
    chains: new Map(),

    // ── bounded ring of per-cast timeline records ──
    // { guid, spellId, school, shape, level, fastCast, leadOnly,
    //   t_requested, t_sent, windups:[{i, cmd, name, t}], t_cast,
    //   t_casterEffect, t_done, t_useDone, t_fizzle, outcome,
    //   suppressedReason, cancelCause }
    timeline: [],

    // ── link-resolution counters, per (stance, gesture-id) ──
    // Map<stance_u32, Map<cmd_u32, {hit, miss, reasons:{...}}>>. Populated
    // from setSwingMotion for EVERY swing/cast; linkStats({castOnly}) filters
    // to cast gestures. WS01 owns the canonical gesture-id→name naming; this
    // surface keys on the raw u32 and humanizes lazily via
    // data/motion-command-names.json.
    links: new Map(),

    // ── echo-vs-prediction dedup counters (foundation §1.5) ──
    echo: { noted: 0, consumedHit: 0, consumedMiss: 0 },

    // ── early-return / suppression counters (S1(e), S1(b)) ──
    suppress: { noSpell: 0, tableNotLoaded: 0, noSetSwing: 0, busyWindow: 0 },

    // ── aggregate lifecycle counters ──
    counters: {
      requested: 0, chainsStarted: 0, chainsCompleted: 0,
      chainsCancelled: 0, fizzles: 0, useDones: 0, casterEffects: 0,
    },

    _motionNames: null,   // lazy humanization table (shared shape w/ combat.js)

    // ────────────────────────────────────────────────────────────────
    // Lifecycle hooks — called from entities.js::playCastSequence.
    // Every one is optional-chained at the call site, so a missing surface
    // is a no-op. None mutate cast behavior.
    // ────────────────────────────────────────────────────────────────

    /** Top of playCastSequence, BEFORE any early return. spellId may be 0. */
    onCastRequested(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.requested += 1;
      const rec = {
        guid: g,
        spellId: (meta.spellId | 0) || 0,
        school: meta.school ?? null,
        shape: meta.shape ?? null,
        level: meta.level ?? null,
        fastCast: meta.fastCast ?? null,
        leadOnly: meta.leadOnly ?? null,
        t_requested: _now(),
        t_sent: meta.t_sent ?? null,
        windups: [],
        t_cast: null,
        t_casterEffect: null,
        t_done: null,
        t_useDone: null,
        t_fizzle: null,
        outcome: "pending",
        suppressedReason: null,
        cancelCause: null,
      };
      this.chains.set(g, {
        spellId: rec.spellId, token: null, busyUntilMs: null,
        gestureIndex: -1, gestureCount: null, phase: "requested",
        startedAt: rec.t_requested, _rec: rec,
      });
    },

    /** An armed-spell click routed through picking.js (plugin-bus). Enriches
     *  the open record with school/shape/level BEFORE the chain runs. */
    onSpellCastInitiated(meta) {
      if (!meta) return;
      const g = (meta.attackerGuid >>> 0) || (meta.guid >>> 0);
      const chain = this.chains.get(g);
      const rec = chain?._rec;
      if (rec) {
        if (meta.school != null) rec.school = meta.school;
        if (meta.shape != null) rec.shape = meta.shape;
        if (meta.level != null) rec.level = meta.level;
        if (rec.t_armed == null) rec.t_armed = _now();
      }
    },

    /** Any of the fallback early-returns fired (no spellId / table not loaded
     *  / no setSwingMotion / busy-window). reason ∈ the suppress keys. */
    onCastSuppressed(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      const reason = meta.reason;
      if (reason && this.suppress[reason] !== undefined) this.suppress[reason] += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.outcome = "suppressed";
        chain._rec.suppressedReason = reason ?? "unknown";
        chain._rec.t_done = _now();
        this._commit(chain._rec);
      }
      this.chains.delete(g);
    },

    /** Chain committed to running (past all early returns): token bumped,
     *  busy window set, windup count known. */
    onChainStart(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsStarted += 1;
      let chain = this.chains.get(g);
      if (!chain) { this.onCastRequested({ guid: g, spellId: meta.spellId }); chain = this.chains.get(g); }
      chain.token = (meta.token | 0);
      chain.busyUntilMs = (meta.busyUntilMs != null) ? +meta.busyUntilMs : null;
      chain.gestureCount = (meta.windupCount | 0) + (meta.hasCast ? 1 : 0);
      chain.phase = "windup";
      if (chain._rec) {
        chain._rec.t_sent = chain._rec.t_sent ?? _now();
        chain._rec.fastCast = meta.fastCast ?? chain._rec.fastCast;
        chain._rec.leadOnly = meta.leadOnly ?? chain._rec.leadOnly;
      }
    },

    /** One windup or the cast gesture fired (setSwingMotion was called). */
    onGesture(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      const chain = this.chains.get(g);
      if (!chain) return;
      chain.gestureIndex = (meta.index | 0);
      chain.phase = meta.isCast ? "cast" : "windup";
      const rec = chain._rec;
      if (!rec) return;
      if (meta.isCast) {
        rec.t_cast = _now();
      } else if (rec.windups.length < MAX_WINDUP_STAMPS) {
        rec.windups.push({ i: (meta.index | 0), cmd: (meta.motion >>> 0), name: meta.name ?? null, t: _now() });
      }
    },

    /** CasterEffect PlayScript emitted at chain end. */
    onCasterEffect(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.casterEffects += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_casterEffect = _now();
      if (chain) chain.phase = "effect";
    },

    /** Chain reached the end normally. */
    onChainComplete(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsCompleted += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.t_done = _now();
        if (chain._rec.outcome === "pending") chain._rec.outcome = "complete";
        this._commit(chain._rec);
      }
      if (chain) chain.phase = "done";
      this.chains.delete(g);
    },

    /** cancelCastSequence bumped the token (fizzle / UseDone / anim-break). */
    onChainCancel(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsCancelled += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.outcome = "cancelled";
        chain._rec.cancelCause = meta.cause ?? "unknown";
        chain._rec.t_done = chain._rec.t_done ?? _now();
        this._commit(chain._rec);
      }
      if (chain) chain.phase = "cancelled";
      this.chains.delete(g);
    },

    /** WeenieError 0x0402 fizzle landed (index.html kind=13). */
    onFizzle(meta) {
      const g = (meta?.guid >>> 0) || 0;
      this.counters.fizzles += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_fizzle = _now();
    },

    /** UseDone landed (index.html kind=14) — server finished the action. */
    onUseDone(meta) {
      const g = (meta?.guid >>> 0) || 0;
      this.counters.useDones += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_useDone = _now();
    },

    // ── link-resolution hook (setSwingMotion) ──
    /** outcome ∈ "hit"|"miss"; reason ∈ not-wasm-link|kind-mismatch|
     *  resolved-zero|no-fetchKeyframes|null-clip|cache-throw|stance-falsy. */
    onLinkResolve(meta) {
      if (!meta) return;
      const stance = (meta.stance >>> 0);
      const cmd = (meta.cmd >>> 0);
      let row = this.links.get(stance);
      if (!row) { row = new Map(); this.links.set(stance, row); }
      let cell = row.get(cmd);
      if (!cell) { cell = { hit: 0, miss: 0, reasons: {} }; row.set(cmd, cell); }
      if (meta.outcome === "hit") {
        cell.hit += 1;
      } else {
        cell.miss += 1;
        const r = meta.reason ?? "unknown";
        cell.reasons[r] = (cell.reasons[r] ?? 0) + 1;
      }
    },

    // ── echo-dedup hooks ──
    onEchoNote(_cmd) { this.echo.noted += 1; },
    onEchoConsume(meta) {
      if (meta?.hit) this.echo.consumedHit += 1;
      else this.echo.consumedMiss += 1;
    },

    // ────────────────────────────────────────────────────────────────
    // Read-side getters
    // ────────────────────────────────────────────────────────────────

    _commit(rec) {
      this.timeline.push(rec);
      if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
    },

    state(guid) {
      if (guid != null) {
        const c = this.chains.get(guid >>> 0);
        return c ? { ...c, _rec: undefined } : null;
      }
      const out = {};
      for (const [g, c] of this.chains) out[_hex(g)] = { ...c, _rec: undefined };
      return out;
    },

    /**
     * C3-wire-send (2026-07-12): remaining busy-window time (ms) for `guid`,
     * clamped to ≥ 0.
     *
     * CLOCK DOMAIN — the footgun this fixes: `chain.busyUntilMs` is an
     * ABSOLUTE `performance.now()` timestamp (stamped in entities.js
     * `playCastSequence`: `inst._castBusyUntilMs = performance.now() + est`).
     * `performance.now()` and `Date.now()` share NO epoch, so a consumer that
     * computed `busyUntilMs - Date.now()` got a value off by the whole Unix
     * epoch (~1.7e12 ms) → after clamping it read "always ~0 remaining"
     * (SLIDECAST report Gap 4). This accessor subtracts the CORRECT clock
     * (`_now()`, which is `performance.now()` when available — the same source
     * the window was stamped with) so callers never mix domains. Read this
     * instead of doing the subtraction yourself.
     *
     * Returns 0 when: no live chain for `guid`, no busy window set, or the
     * window has already elapsed.
     */
    busyRemainMs(guid) {
      if (guid == null) return 0;
      const c = this.chains.get(guid >>> 0);
      const until = c && c.busyUntilMs != null ? +c.busyUntilMs : 0;
      if (!(until > 0)) return 0;
      return Math.max(0, until - _now());
    },

    /** Add computed inter-stamp deltas (ms) to a raw timeline record. */
    _withDeltas(rec) {
      if (!rec) return null;
      const base = rec.t_requested ?? rec.t_sent ?? 0;
      const d = (t) => (t == null ? null : Math.round((t - base) * 10) / 10);
      const windupDeltas = rec.windups.map((w) => ({ i: w.i, cmd: _hex(w.cmd), name: w.name, at: d(w.t) }));
      return {
        guid: _hex(rec.guid),
        spellId: rec.spellId,
        school: rec.school, shape: rec.shape, level: rec.level,
        fastCast: rec.fastCast, leadOnly: rec.leadOnly,
        outcome: rec.outcome,
        suppressedReason: rec.suppressedReason,
        cancelCause: rec.cancelCause,
        deltasMs: {
          armed: d(rec.t_armed),
          sent: d(rec.t_sent),
          windups: windupDeltas,
          cast: d(rec.t_cast),
          casterEffect: d(rec.t_casterEffect),
          done: d(rec.t_done),
          useDone: d(rec.t_useDone),
          fizzle: d(rec.t_fizzle),
        },
      };
    },

    timelineTail(n = 10) {
      const k = Math.max(0, Math.min(n | 0, this.timeline.length));
      return this.timeline.slice(this.timeline.length - k).map((r) => this._withDeltas(r));
    },

    lastTimeline(guid) {
      for (let i = this.timeline.length - 1; i >= 0; i--) {
        const r = this.timeline[i];
        if (guid == null || (r.guid >>> 0) === (guid >>> 0)) return this._withDeltas(r);
      }
      // Fall back to a live (not-yet-committed) chain record.
      if (guid != null) {
        const c = this.chains.get(guid >>> 0);
        if (c?._rec) return this._withDeltas(c._rec);
      }
      return null;
    },

    linkStats(opts) {
      const castOnly = !!(opts && opts.castOnly);
      const out = {};
      for (const [stance, row] of this.links) {
        const cells = {};
        for (const [cmd, cell] of row) {
          if (castOnly && !_isCastGestureCmd(cmd)) continue;
          cells[_hex(cmd)] = {
            name: this._motionNames ? (this._motionNames[_hex(cmd)] ?? null) : null,
            hit: cell.hit, miss: cell.miss,
            reasons: { ...cell.reasons },
          };
        }
        if (Object.keys(cells).length) out[_hex(stance)] = cells;
      }
      return out;
    },

    echoStats() { return { ...this.echo }; },

    /** ON-DEMAND read of the wasm movement-arbitration getters. Zero cost
     *  until called. Degrades gracefully: any getter absent (stale pkg/) →
     *  its field is null. `castArbitrationDiag` is the WS16 addition (packs
     *  the autonomy latch + interpreter forward-slot occupancy). The others
     *  already exist (foundation §1.4). */
    movementSnapshot() {
      const w = (typeof window !== "undefined") ? window : null;
      const hb = w && w.__hbWasm ? w.__hbWasm : null;
      const call = (fn) => {
        try { return (hb && typeof hb[fn] === "function") ? hb[fn]() : null; }
        catch (_) { return null; }
      };
      const arb = call("castArbitrationDiag");
      let latch = null, forwardSlot = null, heldSubstate = null, castMove = null, slideCast = null;
      if (typeof arb === "number") {
        latch = (arb & 0x1) ? 1 : 0;
        castMove = (arb & 0x2) ? 1 : 0;
        slideCast = (arb & 0x4) ? 1 : 0;
        const occ = (arb >> 4) & 0x3;
        forwardSlot = ["none", "walk", "run", "substate"][occ] ?? "none";
        if (occ === 3) heldSubstate = _hex(0x40000000 | ((arb >>> 16) & 0xffff));
      }
      return {
        // WS16 new getter (rides wasm v6, no manifest bump; needs rebuild):
        latchAutonomous: latch,          // 1 = raw keyboard drives; 0 = server-echo (a cast gesture lowered it)
        forwardSlot,                     // none|walk|run|substate — "substate" = a cast gesture holds the slot at 0 loco (SLIDECAST)
        heldSubstate,                    // the gesture cmd occupying the forward slot, if substate
        castMoveEnabled: castMove,
        slideCastEnabled: slideCast,
        // Existing getters (foundation §1.4):
        pendingMotions: call("movementPendingMotionsDiag"),   // completion-node queue depth (a cast stomp raises it)
        reclaimCause: (() => {
          const rc = call("reclaimCauseDiag");
          if (typeof rc !== "number") return null;
          return { edge: rc & 0xffff, useTime: (rc >>> 16) & 0xffff };
        })(),
      };
    },

    summary() {
      const c = this.counters;
      // Roll up link hit/miss over cast gestures only.
      let castHit = 0, castMiss = 0;
      for (const [, row] of this.links) {
        for (const [cmd, cell] of row) {
          if (!_isCastGestureCmd(cmd)) continue;
          castHit += cell.hit; castMiss += cell.miss;
        }
      }
      return {
        requested: c.requested,
        chainsStarted: c.chainsStarted,
        chainsCompleted: c.chainsCompleted,
        chainsCancelled: c.chainsCancelled,
        fizzles: c.fizzles,
        useDones: c.useDones,
        casterEffects: c.casterEffects,
        suppress: { ...this.suppress },
        castLink: { hit: castHit, miss: castMiss },
        echo: { ...this.echo },
        liveChains: this.chains.size,
        timelineDepth: this.timeline.length,
      };
    },

    /** Probe helper — assert the most-recent cast for `guid` against a spec.
     *  Returns { pass:boolean, checks:[{name, pass, detail}] }.
     *  spec = { minWindups, expectCast, maxCastMs, expectCasterEffect,
     *           forbidSuppressed, expectOutcome, maxLinkMiss }. */
    assertLastCast(guid, spec) {
      spec = spec || {};
      const tl = this.lastTimeline(guid);
      const checks = [];
      const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail ?? null });
      if (!tl) {
        add("has-timeline", false, "no cast record for guid");
        return { pass: false, checks };
      }
      if (spec.forbidSuppressed) add("not-suppressed", tl.outcome !== "suppressed", tl.suppressedReason);
      if (spec.expectOutcome) add(`outcome=${spec.expectOutcome}`, tl.outcome === spec.expectOutcome, tl.outcome);
      if (spec.minWindups != null) add(`>=${spec.minWindups}-windups`, tl.deltasMs.windups.length >= spec.minWindups, `${tl.deltasMs.windups.length}`);
      if (spec.expectCast) add("cast-gesture-played", tl.deltasMs.cast != null, `at ${tl.deltasMs.cast}ms`);
      if (spec.maxCastMs != null && tl.deltasMs.cast != null) add(`cast<=${spec.maxCastMs}ms`, tl.deltasMs.cast <= spec.maxCastMs, `${tl.deltasMs.cast}ms`);
      if (spec.expectCasterEffect) add("caster-effect-fired", tl.deltasMs.casterEffect != null, `at ${tl.deltasMs.casterEffect}ms`);
      if (spec.maxLinkMiss != null) {
        const s = this.summary().castLink;
        add(`link-miss<=${spec.maxLinkMiss}`, s.miss <= spec.maxLinkMiss, `miss=${s.miss} hit=${s.hit}`);
      }
      const pass = checks.every((c) => c.pass);
      return { pass, checks, timeline: tl };
    },

    reset() {
      this.chains.clear();
      this.timeline.length = 0;
      this.links.clear();
      this.echo.noted = this.echo.consumedHit = this.echo.consumedMiss = 0;
      for (const k of Object.keys(this.suppress)) this.suppress[k] = 0;
      for (const k of Object.keys(this.counters)) this.counters[k] = 0;
    },
  };

  // Lazily fetch the motion-command-name table (same file combat.js uses) to
  // humanize gesture ids in linkStats/timeline. Non-fatal on failure.
  try {
    if (typeof fetch === "function") {
      fetch("./data/motion-command-names.json", { cache: "force-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { cast._motionNames = j || null; })
        .catch(() => {});
    }
  } catch (_) { /* Node / no fetch — humanization stays null */ }

  diag.cast = cast;

  // Subscribe to the picking.js `spellCastInitiated` emit for school/shape
  // enrichment (mirror combat.js's poll-until-available pattern). This is
  // enrichment only — the direct playCastSequence hooks are authoritative and
  // cover the plugin/hotbar paths too.
  _activeCast = cast;
  _installInitiatedSubscription();
}

// Module-scope subscription state (survives reset(), idempotent).
let _activeCast = null;
let _initiatedInstalled = false;
let _initiatedPollTimer = null;
const _initiatedHandler = (meta) => {
  try { _activeCast?.onSpellCastInitiated?.(meta?.detail ?? meta); } catch (_) {}
};
function _installInitiatedSubscription() {
  if (_initiatedInstalled) return;
  // Browser-only: no plugin bus in Node (unit tests) — skip the poll so we
  // never leave a setInterval keeping the process alive.
  if (typeof window === "undefined") return;
  const tryHook = () => {
    try {
      const client = (typeof window !== "undefined") ? window.__pluginClient : null;
      if (!client?.events?.on) return false;
      client.events.on("spellCastInitiated", _initiatedHandler);
      _initiatedInstalled = true;
      return true;
    } catch (_) { return false; }
  };
  if (!tryHook()) {
    let ticks = 0;
    _initiatedPollTimer = setInterval(() => {
      if (tryHook()) { try { clearInterval(_initiatedPollTimer); } catch (_) {} _initiatedPollTimer = null; return; }
      ticks += 1;
      if (ticks >= SUB_POLL_MAX_TICKS) {
        try { clearInterval(_initiatedPollTimer); } catch (_) {}
        _initiatedPollTimer = null;
      }
    }, 500);
  }
}
