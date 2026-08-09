// scene3d/frame_work.js — the FrameWorkScheduler (ST8 stage A; SPEC §1.6/§3
// T21, pass-08 D-08.2/D-08.3/S1/S2).
//
// WHAT THIS IS
// ------------
// ONE post-render budgeted stream slot (P4) for the frame's streaming work.
// Today the between-frames work runs in uncoordinated setTimeout(0)/rAF tasks,
// each with its own private 6 ms budget — the six read-verified families
// (statics.js STATICS_BUILD_BUDGET_MS ×2, cells.js ENVCELL_BUILD_BUDGET_MS,
// buildings.js BUILDINGS_RING_BUILD_BUDGET_MS, landblock_lru.js
// SEALED_STEADY/PARK_DISPOSE inside tickEviction, the xu7 FIFO drain) are
// ADDITIVE: each can spend 6 ms around one frame with no shared accounting,
// and index.js additionally ran `lru.tickEviction` inline, un-budgeted.
//
// STAGE A (this file, `?frameWork` DEFAULT-OFF): the legacy families register
// as W6 clients WITH THEIR CODE UNCHANGED — each drain asks this scheduler for
// permission-with-budget instead of free-running its private 6 ms, so the
// GLOBAL cap holds. Flag OFF: every family runs exactly its current path
// (the adapters fall through to today's setTimeout(0)/rAF scheduling —
// byte-identical; that is the kill path). Stages B (P4 relocation of
// eviction/feeds via W3/W4) and C (upload staging via W2 `initTexture`) are
// T22 scope and ride `?drawPools`' timeline; the W1..W5 machinery, byte caps,
// and the `uploads` surface exist here so T22 lands onto a tested core.
//
// SCHEDULER RULES (pass-08 S2, normative):
//   - one instance, main thread; `enqueue()` from event handlers/`onmessage`
//     only; `run()` from P4 only (plus the stale-guard service below).
//   - dequeue order W1 URGENT > W2 UPLOAD > W3 FEED > W4 RELEASE > W5 LADDER
//     > W6 LEGACY; FIFO within class; budget checked BETWEEN items.
//   - always-run-one: the first item of the highest non-empty class runs
//     regardless of budget (the xu7-drain rule — a 32 ms item must not park
//     the queue forever under a 6 ms cap).
//   - staleness ceiling: a class whose oldest item has waited >= 3 frames
//     force-runs one item regardless of budget (RP3's shape, loop.js:2202).
//   - modes: NORMAL 6 ms [A, ?workBudget=N] · BOOT 50 ms [A] (pre-in-world;
//     exits when `window.__bootState === "in-world"` — the stage-A milestone;
//     `preview-complete` takes over as the exit when ST2+ lands it) ·
//     TELEPORT 250 ms ONE-SHOT (first run after an LB discontinuity — pass-06
//     D-06.10's R-12 lesson as a scheduler mode) · EMERGENCY (ladder R4,
//     entered ONLY via setEmergency() — the T20 pressure ladder is the sole
//     intended caller: W4/W5 allowance ×2, W2 uploads PAUSED) · CROSSING
//     (pass-08 Q4's named lever, `?workCrossing=on`, default OFF: budget
//     12 ms while any W1/W3/W6 queue is nonempty and the frame is under 80%
//     of target period — the pre-declared answer if BENCH-CROSS-SETTLE
//     regresses vs the additive-budget legacy arm; pull it before killing).
//   - shrink rule (S1): effectiveBudget = max(2, budget − max(0,
//     elapsed(P0..P3) − targetPeriod)) — a heavy frame halves the slot rather
//     than stacking on it [A, ?workShrink=off escape]. NORMAL/CROSSING only:
//     shrinking a BOOT/TELEPORT burst would defeat its purpose.
//
// CLOCK DISCIPLINE (D-08.1, mandatory): live monotonic `performance.now()`
// only — NEVER `scene3d.frameTime.tsSec`, which freezes under
// `?renderOnDemand=1` / the net-drain driver (the RP3 starvation defect).
//
// W6 CLIENT SHAPES (the thin adapters):
//   frameWorkW6Run(name, fn)   — coalesced SYNC drain request (xu7 `_drain`,
//     `lru.tickEviction`): latest fn per name wins; the scheduler calls it in
//     the slot and measures its real elapsed against the budget. Returns
//     false when the flag is OFF (caller keeps its legacy scheduling).
//   frameWorkW6Yield(name, spentMs) — chunk-loop yield (statics/cells/
//     buildings time-sliced builds): flag OFF returns EXACTLY today's
//     `new Promise(r => setTimeout(r, 0))`; flag ON parks the continuation
//     until the slot grants a resume. `spentMs` reports the chunk that JUST
//     ran, feeding the per-name cost estimate the grant is charged at.
//     TIMING NOTE: a granted continuation executes in the microtask drain
//     after `run()` returns; index.js stamps `__framePhase.p4` after a
//     one-microtask hop so that execution lands INSIDE the measured slot.
//
// STARVATION SAFETY (the guard): when the flag is ON but no frame driver is
// running P4 (init3D before the loop starts, hidden tab, `?renderOnDemand=1`
// idle), pending work would otherwise park forever. A module-level guard
// timer (32 ms poll, 250 ms staleness — the xu7 hidden-tab constant) services
// the queues with the mode budget and chains at setTimeout(0) while stale
// work remains, which is exactly today's setTimeout(0) chunk cadence — boot
// throughput before the loop starts is preserved by construction.
//
// DIAG SURFACES (registered in harness/lib/diag_schema.mjs, moved
// reserved→current by T21):
//   window.__frameWork   — installed at module scope (availability "boot"),
//     plain object updated in place: per-class {ran, deferredFrames,
//     forcedRuns, maxItemMs, queueDepth, itemsThisFrame}, mode, enabled,
//     budgetMs (last effective), guardServices, uploads (stage-C shape,
//     zeros at stage A). `mode` is a LEVEL: TELEPORT/BOOT-labeled long
//     frames are design-accepted (F6 excludes them).
//   window.__framePhase  — `?framePhase=on` only (its own diag flag so the
//     census can run on the LEGACY arm too — re-classing the [A] phase
//     budgets of pass-08 S1 requires measuring today's frame): last-frame
//     p0..p4 + cumulative p0Ms..p4Ms + frames, stamped by index.js via
//     framePhaseBegin/Cut/Commit. Phase taxonomy at stage A: p0 SIM (dt
//     clamp + syncTickHop), p1 RESIDENCY-class work (the LRU/reaper block),
//     p2 WORLD TICKS (tickPerFrame + moons/audio/ambient), p3 RENDER,
//     p4 STREAM SLOT. With `?frameWork` OFF, p4 ≈ 0 and the legacy families'
//     between-frames work is INVISIBLE to the vector — that asymmetry is
//     part of what the census demonstrates.
//
// Tests: harness/test_frame_work.mjs (node, mocked clock — no rAF).

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

const _defaultNow = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function _search(search) {
  if (search !== undefined) return search;
  try {
    return typeof window !== "undefined" && window.location ? window.location.search : "";
  } catch (_) {
    return "";
  }
}

/** All documented off-spellings (mirrors bc7_textures.js `flagIsOff` without
 *  importing it — this module must stay import-free so every scene3d family
 *  can depend on it without cycles). */
function _isOff(v) {
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

/**
 * `?frameWork` — ST8 stage flag, DEV opt-in, **DEFAULT OFF** (flag lifecycle
 * SPEC §0.1; the default flip is a GATE-PHASE + BENCH-CROSS-SETTLE migration
 * event, never done here). EXACT-MATCH opt-in like `?texWorkers`: only
 * `on`/`1`/`true`/`yes` read ON; absent/`off`/`0`/garbage ⇒ OFF. Not
 * memoized (ESM suites re-stub `globalThis.window` per case).
 */
export function frameWorkEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("frameWork");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

/**
 * `?framePhase` — the phase-attribution instrument (GATE-PHASE census),
 * DEFAULT OFF (7 paired `performance.now()` reads/frame when on; the bare
 * default frame stays untouched). EXACT-MATCH opt-in, independent of
 * `?frameWork` so the census can measure the legacy arm.
 */
export function framePhaseEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("framePhase");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

/** `?workBudget=N` — NORMAL-mode global slot budget, ms. Default 6 [A] (the
 *  house figure, now GLOBAL instead of per-family). Clamped [1, 100]. */
export function workBudgetMs(search) {
  try {
    const raw = new URLSearchParams(_search(search)).get("workBudget");
    if (raw === null) return 6;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return 6;
    return Math.min(100, Math.max(1, n));
  } catch (_) {
    return 6;
  }
}

/** `?workShrink` — heavy-frame shrink rule (S1). DEFAULT ON; `=off`/`0`/
 *  `false`/`no` escapes. */
export function workShrinkEnabled(search) {
  try {
    return !_isOff(new URLSearchParams(_search(search)).get("workShrink"));
  } catch (_) {
    return true;
  }
}

/** `?workCrossing` — the CROSSING elevated mode (pass-08 Q4's named lever).
 *  DEFAULT OFF; EXACT-MATCH opt-in. Pull before killing on a
 *  BENCH-CROSS-SETTLE regression. */
export function workCrossingEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("workCrossing");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// the scheduler core (node-testable; no window/rAF dependency)
// ---------------------------------------------------------------------------

export const WORK_CLASSES = Object.freeze(["W1", "W2", "W3", "W4", "W5", "W6"]);
export const MODES = Object.freeze(["NORMAL", "BOOT", "TELEPORT", "EMERGENCY", "CROSSING"]);

// Teleport predicate [A]: an LB-key discontinuity of Chebyshev >= 6 landblocks
// in one frame is not a walk crossing (walking moves 1 LB at a time; pass-06's
// grid uses "anchor delta >= 6" for the same event class).
const TELEPORT_CHEBYSHEV = 6;
// Per-resume cost estimate clamp for W6 yield grants (real cost is reported at
// the NEXT yield; until then the grant is charged at the family's last chunk
// ms, defaulting to the house 6).
const EST_MIN_MS = 0.5;
const EST_MAX_MS = 50;
const EST_DEFAULT_MS = 6;

function _lbChebyshev(a, b) {
  const ax = (a >>> 24) & 0xff; const ay = (a >>> 16) & 0xff;
  const bx = (b >>> 24) & 0xff; const by = (b >>> 16) & 0xff;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export class FrameWorkScheduler {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]  injectable clock (tests)
   * @param {number} [opts.budgetMs]        NORMAL budget (default 6 [A])
   * @param {number} [opts.bootBudgetMs]    BOOT budget (default 50 [A])
   * @param {number} [opts.teleportBudgetMs] TELEPORT one-shot (default 250 [A])
   * @param {number} [opts.crossingBudgetMs] CROSSING budget (default 12 [A])
   * @param {number} [opts.minBudgetMs]     shrink floor (default 2 [A])
   * @param {number} [opts.maxDeferFrames]  staleness ceiling (default 3)
   * @param {boolean} [opts.shrink]         shrink rule armed (default true)
   * @param {boolean} [opts.crossing]       CROSSING lever armed (default false)
   * @param {() => boolean} [opts.isInWorld] BOOT-mode exit predicate
   * @param {() => void} [opts.onPending]   called when work is enqueued
   */
  constructor(opts = {}) {
    this._now = opts.now || _defaultNow;
    this.cfg = {
      budgetMs: opts.budgetMs ?? 6,
      bootBudgetMs: opts.bootBudgetMs ?? 50,
      teleportBudgetMs: opts.teleportBudgetMs ?? 250,
      crossingBudgetMs: opts.crossingBudgetMs ?? 12,
      minBudgetMs: opts.minBudgetMs ?? 2,
      maxDeferFrames: opts.maxDeferFrames ?? 3,
      shrink: opts.shrink ?? true,
      crossing: opts.crossing ?? false,
    };
    this._isInWorld = opts.isInWorld
      || (() => {
        try {
          return typeof window !== "undefined" && window.__bootState === "in-world";
        } catch (_) {
          return false;
        }
      });
    this._onPending = opts.onPending || null;
    this._frameIdx = 0;
    this._inWorldSeen = false;
    this._teleportArmed = false;
    this._emergency = false;
    this._lastLbKey = null;
    /** @type {Record<string, Array<any>>} */
    this._queues = {};
    this._rows = {};
    for (const c of WORK_CLASSES) {
      this._queues[c] = [];
      this._rows[c] = {
        ran: 0, deferredFrames: 0, forcedRuns: 0,
        maxItemMs: 0, queueDepth: 0, itemsThisFrame: 0,
      };
    }
    this._w6RunPending = new Map(); // name -> item (coalescing)
    this._w6LastChunkMs = new Map(); // name -> reported chunk ms
    this.mode = "BOOT";
    this.lastBudgetMs = 0;
    this.teleports = 0;
    // Stage-C shape (upload staging lands with T22); published now so the
    // registry schema is stable from day one.
    this.uploads = { stagedBytesByClass: {}, initTextureCalls: 0, exclusive: [] };
    // serve-pass scratch
    this._t0 = 0;
    this._estCharge = 0;
  }

  /** Generic item enqueue (S2.1) — W1..W5 producers (T22) and tests. Items
   *  are closures with a declared kind (+ bytes for W2/W3, tileKey for
   *  cancellation). */
  enqueue(classId, item) {
    if (!WORK_CLASSES.includes(classId)) throw new Error(`frame_work: unknown class ${classId}`);
    const it = {
      type: "item",
      kind: item?.kind ?? "anon",
      fn: item?.fn ?? (typeof item === "function" ? item : null),
      bytes: item?.bytes ?? 0,
      tileKey: item?.tileKey,
      frameEnqueued: this._frameIdx,
    };
    if (typeof it.fn !== "function") throw new Error("frame_work: item.fn required");
    this._queues[classId].push(it);
    if (this._onPending) this._onPending();
    return it;
  }

  /** S2.6 — slot vacation purges queued items for that tile. Pending W6
   *  resumes are never purged (a parked continuation must eventually run —
   *  its own cancellation guards handle eviction, e.g. statics.js F3). */
  purgeByTile(tileKey) {
    let purged = 0;
    for (const c of WORK_CLASSES) {
      const q = this._queues[c];
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].type === "item" && q[i].tileKey !== undefined && q[i].tileKey === tileKey) {
          q.splice(i, 1);
          purged += 1;
        }
      }
    }
    return purged;
  }

  /** W6 coalesced sync drain (latest fn per name wins). */
  w6Run(name, fn) {
    const existing = this._w6RunPending.get(name);
    if (existing) {
      existing.fn = fn;
      return;
    }
    const item = { type: "run", name, fn, frameEnqueued: this._frameIdx };
    this._w6RunPending.set(name, item);
    this._queues.W6.push(item);
    if (this._onPending) this._onPending();
  }

  /** W6 chunk-loop yield: returns a promise resolved when the slot grants a
   *  resume. `spentMs` prices the chunk that JUST ran. */
  w6Yield(name, spentMs) {
    if (Number.isFinite(spentMs) && spentMs >= 0) {
      this._w6LastChunkMs.set(name, spentMs);
      const row = this._rows.W6;
      if (spentMs > row.maxItemMs) row.maxItemMs = spentMs;
    }
    return new Promise((resolve) => {
      this._queues.W6.push({ type: "resume", name, resolve, frameEnqueued: this._frameIdx });
      if (this._onPending) this._onPending();
    });
  }

  /** Teleport detector (stage A: no grid events yet — an LB-key jump IS the
   *  discontinuity signal; T20's grid onTeleport takes over at ST7). */
  noteLbKey(lbKey) {
    if (!Number.isFinite(lbKey) || lbKey === 0) return;
    const k = lbKey >>> 0;
    if (this._lastLbKey !== null && _lbChebyshev(this._lastLbKey, k) >= TELEPORT_CHEBYSHEV) {
      this._teleportArmed = true;
      this.teleports += 1;
    }
    this._lastLbKey = k;
  }

  /** Ladder R4 seam (T20 is the intended caller; no stage-A producer). */
  setEmergency(on) {
    this._emergency = !!on;
  }

  notifyInWorld() {
    this._inWorldSeen = true;
  }

  hasPending() {
    for (const c of WORK_CLASSES) if (this._queues[c].length > 0) return true;
    return false;
  }

  _spentMs() {
    return (this._now() - this._t0) + this._estCharge;
  }

  _resolveMode(frameStartMs, targetPeriodMs, t0) {
    if (!this._inWorldSeen) {
      if (this._isInWorld()) this._inWorldSeen = true;
      else return "BOOT";
    }
    if (this._emergency) return "EMERGENCY";
    if (this._teleportArmed) return "TELEPORT"; // one-shot; consumed by run()
    if (
      this.cfg.crossing
      && (this._queues.W1.length > 0 || this._queues.W3.length > 0 || this._queues.W6.length > 0)
      && Number.isFinite(frameStartMs) && targetPeriodMs > 0
      && (t0 - frameStartMs) < 0.8 * targetPeriodMs
    ) return "CROSSING";
    return "NORMAL";
  }

  _modeBudget(mode) {
    switch (mode) {
      case "BOOT": return this.cfg.bootBudgetMs;
      case "TELEPORT": return this.cfg.teleportBudgetMs;
      case "CROSSING": return this.cfg.crossingBudgetMs;
      default: return this.cfg.budgetMs; // NORMAL + EMERGENCY (reweights, not a bigger pie)
    }
  }

  _serveOne(cls, item, forced) {
    const row = this._rows[cls];
    if (item.type === "resume") {
      // Continuation runs in the microtask drain after run() returns; charge
      // the grant at the family's last reported chunk cost.
      const est = Math.min(
        EST_MAX_MS,
        Math.max(EST_MIN_MS, this._w6LastChunkMs.get(item.name) ?? EST_DEFAULT_MS),
      );
      this._estCharge += est;
      try {
        item.resolve();
      } catch (_) { /* fail-soft */ }
    } else {
      if (item.type === "run") this._w6RunPending.delete(item.name);
      const t = this._now();
      try {
        item.fn();
      } catch (e) {
        // A throwing drain must not kill the slot (mirror index.js's
        // one-shot-warn discipline without holding scene refs here).
        if (!this._itemWarned) {
          this._itemWarned = true;
          // eslint-disable-next-line no-console
          console.warn(`[frameWork] ${cls} item threw:`, e);
        }
      }
      const dt = this._now() - t;
      if (dt > row.maxItemMs) row.maxItemMs = dt;
    }
    row.ran += 1;
    row.itemsThisFrame += 1;
    if (forced) row.forcedRuns += 1;
  }

  /**
   * THE P4 SLOT. `frameStartMs` (this frame's tick start, the pacer's
   * `lastFrameTs`) + `targetPeriodMs` feed the shrink rule and the CROSSING
   * predicate; both optional (the guard service passes neither).
   */
  run(opts = {}) {
    const t0 = this._now();
    this._t0 = t0;
    this._estCharge = 0;
    this._frameIdx += 1;
    const frameStartMs = opts.frameStartMs;
    const targetPeriodMs = opts.targetPeriodMs ?? 0;
    const mode = this._resolveMode(frameStartMs, targetPeriodMs, t0);
    if (mode === "TELEPORT") this._teleportArmed = false; // one-shot consumed
    let budget = this._modeBudget(mode);
    if (
      this.cfg.shrink && (mode === "NORMAL" || mode === "CROSSING")
      && Number.isFinite(frameStartMs) && targetPeriodMs > 0
    ) {
      budget = Math.max(this.cfg.minBudgetMs, budget - Math.max(0, (t0 - frameStartMs) - targetPeriodMs));
    }
    this.mode = mode;
    this.lastBudgetMs = budget;

    for (const c of WORK_CLASSES) this._rows[c].itemsThisFrame = 0;
    let ranAny = false;
    // main pass — priority order, budget checked BETWEEN items, first item of
    // the highest non-empty class unconditional (always-run-one).
    for (const cls of WORK_CLASSES) {
      if (mode === "EMERGENCY" && cls === "W2") continue; // uploads paused (R4)
      const q = this._queues[cls];
      const limit = (mode === "EMERGENCY" && (cls === "W4" || cls === "W5"))
        ? budget * 2 // R4 reweight: drains/demotes get double allowance
        : budget;
      while (q.length > 0) {
        if (ranAny && this._spentMs() >= limit) break;
        this._serveOne(cls, q.shift(), false);
        ranAny = true;
      }
    }
    // staleness ceiling — a class that got NOTHING this frame but whose
    // oldest item has waited >= maxDeferFrames force-runs one item. The
    // EMERGENCY W2 pause outranks the ceiling (a paused upload lane must
    // stay paused; R4 windows are short by construction).
    for (const cls of WORK_CLASSES) {
      if (mode === "EMERGENCY" && cls === "W2") continue;
      const q = this._queues[cls];
      if (q.length === 0 || this._rows[cls].itemsThisFrame > 0) continue;
      if (this._frameIdx - q[0].frameEnqueued >= this.cfg.maxDeferFrames) {
        this._serveOne(cls, q.shift(), true);
      }
    }
    // starvation counters — engaged classes that got zero service this frame.
    for (const cls of WORK_CLASSES) {
      if (this._queues[cls].length > 0 && this._rows[cls].itemsThisFrame === 0) {
        this._rows[cls].deferredFrames += 1;
      }
    }
    for (const cls of WORK_CLASSES) this._rows[cls].queueDepth = this._queues[cls].length;
  }

  /** __frameWork row snapshot (the singleton publishes into the window
   *  object; tests read this directly). */
  statsInto(target) {
    const t = target || {};
    t.classes = t.classes || {};
    for (const c of WORK_CLASSES) {
      const row = this._rows[c];
      const out = t.classes[c] || (t.classes[c] = {});
      out.ran = row.ran;
      out.deferredFrames = row.deferredFrames;
      out.forcedRuns = row.forcedRuns;
      out.maxItemMs = row.maxItemMs;
      out.queueDepth = this._queues[c].length;
      out.itemsThisFrame = row.itemsThisFrame;
    }
    t.mode = this.mode;
    t.budgetMs = this.lastBudgetMs;
    t.teleports = this.teleports;
    t.uploads = this.uploads;
    return t;
  }
}

// ---------------------------------------------------------------------------
// the singleton + guard timer (browser wiring; everything below is inert
// unless `?frameWork=on`)
// ---------------------------------------------------------------------------

const _FW_ON = frameWorkEnabled();

// The stale-guard cadence: poll at ~2 frames; "no P4 ran for 250 ms" is the
// staleness predicate (the xu7 hidden-tab constant). While stale with pending
// work, chain at setTimeout(0) — today's chunk cadence.
const GUARD_POLL_MS = 32;
const GUARD_STALE_MS = 250;

let _guardTimer = null;
let _lastP4Ms = -Infinity;
let _guardServices = 0;

function _armGuard() {
  if (!_FW_ON || _guardTimer !== null) return;
  if (!_scheduler.hasPending()) return;
  try {
    _guardTimer = setTimeout(_guardFire, GUARD_POLL_MS);
  } catch (_) {
    _guardTimer = null;
  }
}

function _guardFire() {
  _guardTimer = null;
  if (!_scheduler.hasPending()) return;
  const now = _defaultNow();
  if (now - _lastP4Ms > GUARD_STALE_MS) {
    _guardServices += 1;
    try {
      _scheduler.run({});
    } catch (_) { /* fail-soft */ }
    _publish();
    // Still stale, still pending → chain fast (the legacy setTimeout(0)
    // cadence; the browser's own hidden-tab clamping applies as it does to
    // the legacy chain).
    if (_scheduler.hasPending()) {
      try {
        _guardTimer = setTimeout(_guardFire, 0);
      } catch (_) {
        _guardTimer = null;
      }
    }
  } else {
    _armGuard();
  }
}

const _scheduler = new FrameWorkScheduler({
  budgetMs: workBudgetMs(),
  shrink: workShrinkEnabled(),
  crossing: workCrossingEnabled(),
  onPending: _armGuard,
});

export function getFrameWorkScheduler() {
  return _scheduler;
}

// __frameWork — installed at module scope (availability "boot") so a
// flag-OFF run reads {enabled:false, zeros} instead of probing a hole
// (the __texWorkerStats convention).
const _fwSurface = { enabled: _FW_ON, guardServices: 0 };
_scheduler.statsInto(_fwSurface);
if (typeof window !== "undefined") {
  try {
    window.__frameWork = _fwSurface;
  } catch (_) { /* fail-soft */ }
}

function _publish() {
  _scheduler.statsInto(_fwSurface);
  _fwSurface.enabled = _FW_ON;
  _fwSurface.guardServices = _guardServices;
}

/**
 * The P4 entry (index.js, post-render; also the ?netDrainHz alternate driver
 * per pass-08 S1). No-op when the flag is OFF.
 */
export function frameWorkP4(opts) {
  if (!_FW_ON) return;
  _lastP4Ms = _defaultNow();
  _scheduler.run(opts || {});
  _publish();
  _armGuard();
}

/** W6 sync-drain adapter. Returns true when the scheduler owns the callback
 *  (flag ON); false = caller keeps its legacy scheduling (flag OFF). */
export function frameWorkW6Run(name, fn) {
  if (!_FW_ON) return false;
  _scheduler.w6Run(name, fn);
  return true;
}

/** W6 chunk-yield adapter. Flag OFF: EXACTLY today's macrotask yield. */
export function frameWorkW6Yield(name, spentMs) {
  if (!_FW_ON) return new Promise((r) => setTimeout(r, 0));
  return _scheduler.w6Yield(name, spentMs);
}

/** Teleport-detection feed (index.js LRU block — the one site that already
 *  holds the fresh currentLbKey). No-op when OFF. */
export function frameWorkNoteLbKey(lbKey) {
  if (!_FW_ON) return;
  _scheduler.noteLbKey(lbKey);
}

// ---------------------------------------------------------------------------
// __framePhase — the phase-attribution census instrument (?framePhase=on)
// ---------------------------------------------------------------------------

let _fpOn = framePhaseEnabled();

/** Test hook (harness only): flip the memoized instrument gate. */
export function _setFramePhaseEnabledForTest(on) {
  _fpOn = !!on;
  if (_fpOn) _installFramePhase();
}

const _fpAcc = [0, 0, 0, 0, 0];
let _fpLast = 0;
const _fpSurface = {
  p0: 0, p1: 0, p2: 0, p3: 0, p4: 0,
  p0Ms: 0, p1Ms: 0, p2Ms: 0, p3Ms: 0, p4Ms: 0,
  frames: 0,
};

function _installFramePhase() {
  if (typeof window !== "undefined") {
    try {
      window.__framePhase = _fpSurface;
    } catch (_) { /* fail-soft */ }
  }
}
if (_fpOn) _installFramePhase();

/** Frame start (index.js tick top; `ts` is the rAF timestamp — same clock as
 *  performance.now()). */
export function framePhaseBegin(ts) {
  if (!_fpOn) return;
  _fpLast = typeof ts === "number" ? ts : _defaultNow();
  _fpAcc[0] = 0; _fpAcc[1] = 0; _fpAcc[2] = 0; _fpAcc[3] = 0; _fpAcc[4] = 0;
}

/** Close the segment since the previous mark into phase `slot` (0..4). A
 *  phase may be cut more than once per frame (p2 spans the ambient roller on
 *  the far side of the LRU block); segments accumulate. */
export function framePhaseCut(slot) {
  if (!_fpOn) return;
  const n = _defaultNow();
  _fpAcc[slot] += n - _fpLast;
  _fpLast = n;
}

/** Publish the frame: last-frame levels + cumulative counters (the stall
 *  probe differences the cumulative side like any counter). */
export function framePhaseCommit() {
  if (!_fpOn) return;
  _fpSurface.p0 = _fpAcc[0];
  _fpSurface.p1 = _fpAcc[1];
  _fpSurface.p2 = _fpAcc[2];
  _fpSurface.p3 = _fpAcc[3];
  _fpSurface.p4 = _fpAcc[4];
  _fpSurface.p0Ms += _fpAcc[0];
  _fpSurface.p1Ms += _fpAcc[1];
  _fpSurface.p2Ms += _fpAcc[2];
  _fpSurface.p3Ms += _fpAcc[3];
  _fpSurface.p4Ms += _fpAcc[4];
  _fpSurface.frames += 1;
}
