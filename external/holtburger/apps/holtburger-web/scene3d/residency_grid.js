// scene3d/residency_grid.js — ST7 (`?slotGrid`, SPEC §1.4 / pass 6): the
// tile-granular slot grid as RESIDENCY AUTHORITY, DEFAULT OFF.
//
// Pass-6 shape (D-06.1..D-06.10), landed at T20 with the draw pools still OFF
// — so the grid drives TODAY'S producers through the SPEC §1.4 adapter table
// (statics/buildings/cells/terrain keep their current feed APIs; the
// `tickPvsLoadExpansion` ring population becomes event-driven; parks ride the
// existing `landblock_lru.park()` machinery; the legacy LRU itself runs
// ASSERT-ONLY — victims computed, diffed, never acted on; `gridLruDivergence`
// must stay 0 over the battery).
//
//   * Geometry (D-06.1/S1): tile t(x)=floor(x/2); ring-min anchor
//     A(lb) = (floor((lb_x−R)/2), floor((lb_y−R)/2)) with R = 5; W_T = 6
//     (36 slots = 144 LBs allocated covering the 121-LB 11×11 ring — 19%
//     stated alignment slack). Shift-in-place: the anchor moves ±1 per 2 LBs;
//     a shift admits/vacates ≤6-tile rows/columns, interior pointer-copied.
//     Teleport = anchor max-axis delta ≥ W_T (whole-grid invalidate).
//   * Slot states (D-06.3/S2): EMPTY → FETCHING → STAGED → LIVE ⇄ PARKED →
//     EMPTY, + QUARANTINED (controller bookkeeping authoritative, never
//     erased here). Park is 2 s hysteresis-gated (EdgeParkScheduler, adopted
//     from fixed_grid.js at tile scale); PARKED→LIVE is a pointer re-adopt;
//     PARKED→EMPTY only via the pressure pass / teleport ageout / teardown,
//     amortized ≤1 tile per tick.
//   * Integrity detectors carried from the proven FixedSlotGrid VERBATIM in
//     mechanism (fixed_grid.js:271-288/394-474): positional shift cross-check
//     vs set-intersection (`shiftMismatches`), slot-table↔record lockstep +
//     positional slot check + illegal state transitions (`slotDesyncs`), and
//     the pin ledger audit (`pinLeaks` — pins held by tiles that are neither
//     LIVE/PARKED/STAGED). All three MUST stay 0 (CENSUS-CI gates).
//   * Pressure (D-06.6/S4): the legacy geometry-count governor
//     (MAX_LIVE_GEOM), its floor-zeroing (`floorMs = overGeomAtEntry ? 0 :`,
//     landblock_lru.js:1374) and the ~203 count-cap DO NOT EXIST on the ON
//     arm — the grid's class-local byte loop replaces them: park pool
//     ≤40 tiles AND ≤128 MiB [A], 30 s UseTime floor, dispose farthest-first
//     oldest-tie ≤1 tile/tick, all-young+over-budget ⇒ run over and COUNT
//     (`parkDeferredCount/Bytes`), floors NEVER zeroed. The 4-rung ladder
//     (R1 demote → R2 park-release+budget-halve → R3 Rust-budget-halve →
//     R4 emergency floor-lower 30 s → 5 s, NEVER 0) triggers at
//     0.9×M1 / context loss / 0.94×M3, sampled 1 Hz, ≥5 s per rung, release
//     in reverse at 0.85 low-water. `r4Engagements > 0` on a default run is
//     a FAIL by definition.
//   * NEVER sheds at any rung: the player's current tile + 3×3 LB, pinned
//     packs (session commons + slot pins + LIVE/PARKED-region PVW), the
//     sealed return core (R1–R3), quarantine records.
//
// Pure, injected-deps, node-testable (the fixed_grid.js discipline): no
// `three`, no `window` in the core classes; scene3d/index.js injects the live
// controller/LRU/feed/wasm deps. `harness/test_residency_grid.mjs` pins the
// battery.
//
// OFF arm (`?slotGrid` absent): nothing here is constructed beyond the flag
// read — every residency path is byte-identical legacy (I7 kill path).
// Requires `?packSource` (D-12.4): the wiring disarms loudly without it.

import { EdgeParkScheduler } from "./fixed_grid.js";

// ---------------------------------------------------------------------------
// flag reader (house grammar: EXACT-MATCH opt-in, DEFAULT OFF; audited by
// scripts/audit-flag-defaults.mjs — keep comparisons same-line on .get())
// ---------------------------------------------------------------------------

/**
 * `?slotGrid` — DEV opt-in, **DEFAULT OFF** (SPEC §0.1 lifecycle; the
 * orchestrator flips after GATE-GRID). Only `on`/`1`/`true`/`yes` read ON.
 * Absent, empty, `off`, `0`, garbage => OFF. Not memoised.
 */
export function slotGridEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("slotGrid");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// constants (pass 6 S1/S3/S4 — [A] budgets re-classed by the first soak)
// ---------------------------------------------------------------------------

/** Ring radius in LBs (residency.js RESIDENCY_RADIUS_LB — unchanged). */
export const R_LB = 5;
/** Tiles per axis: minimal tile cover of the 11×11 ring (cover proof D-06.1). */
export const W_T = R_LB + 1; // 6
/** Slot count. */
export const SLOT_COUNT = W_T * W_T; // 36

/** Park hysteresis (D-06.3; the fixed_grid EdgeParkScheduler default). */
export const PARK_HYSTERESIS_MS = 2000;
/** Park pool bounds (S3 [A]). */
export const PARK_POOL_MAX_TILES = 40;
export const PARK_POOL_MAX_BYTES = 128 * 1024 * 1024;
/** UseTime floor (S4.2) and the R4 emergency minimum (S4.4 — NEVER 0). */
export const PARK_FLOOR_MS = 30_000;
export const PARK_FLOOR_EMERGENCY_MS = 5_000;
/** True-release amortization: ≤1 tile per tick under this budget (D-06.3). */
export const RELEASE_BUDGET_MS = 6;
/** Teleport drain first-burst budget (D-06.10, the R-12 lesson). */
export const TELEPORT_FIRST_BURST_MS = 250;
/** Ladder thresholds (S4.3 [A]): 0.9 × M1 (1.6 GB) and 0.94 × M3 (512 MiB). */
export const LADDER_HEAP_TRIGGER_BYTES = Math.round(0.9 * 1.6 * 1024 * 1024 * 1024);
export const LADDER_WASM_TRIGGER_BYTES = Math.round(0.94 * 512 * 1024 * 1024);
export const LADDER_RELEASE_FRAC = 0.85;
export const LADDER_RUNG_DWELL_MS = 5_000;
export const LADDER_SAMPLE_MS = 1_000;
/** Sealed return core: tiles within Chebyshev 1 of the entry tile (≤9). */
export const SEALED_CORE_RADIUS_T = 1;

/** Slot states (D-06.3/S2). */
export const SLOT_STATE = Object.freeze({
  EMPTY: "EMPTY",
  FETCHING: "FETCHING",
  STAGED: "STAGED",
  LIVE: "LIVE",
  PARKED: "PARKED",
  QUARANTINED: "QUARANTINED",
});

/** Legal transition table (S2). from -> Set(to). */
const LEGAL = {
  // STAGED directly on the no-pack-lane arm; QUARANTINED directly when the
  // admit-time controller consult finds the tile already quarantined (the
  // controller's bookkeeping is authoritative — S7/H-03.3).
  EMPTY: new Set(["FETCHING", "STAGED", "QUARANTINED"]),
  FETCHING: new Set(["STAGED", "QUARANTINED", "EMPTY"]),
  STAGED: new Set(["LIVE", "EMPTY"]),
  LIVE: new Set(["PARKED", "EMPTY"]), // EMPTY only via teardown/teleport drain fallthrough
  PARKED: new Set(["LIVE", "EMPTY"]),
  QUARANTINED: new Set(["FETCHING", "EMPTY"]),
};

// ---------------------------------------------------------------------------
// tile helpers
// ---------------------------------------------------------------------------

/** Pack a tile coordinate pair (0..127 each) into one key. -1 = absent. */
export function tileKeyOf(tx, ty) {
  return ((tx & 0xff) << 8) | (ty & 0xff);
}
export function tileXOf(key) { return (key >> 8) & 0xff; }
export function tileYOf(key) { return key & 0xff; }

function tileInMap(t) {
  return t >= 0 && t <= 127;
}

/** Chebyshev distance between two tile keys, in tiles. */
export function tileChebyshev(a, b) {
  return Math.max(
    Math.abs(tileXOf(a) - tileXOf(b)),
    Math.abs(tileYOf(a) - tileYOf(b)),
  );
}

/** The player's own tile for an LB coordinate. */
export function tileOfLb(lbx, lby) {
  return tileKeyOf(lbx >> 1, lby >> 1);
}

/** Ring-min anchor (S1): A(lb) = (floor((lb−R)/2), floor((lb−R)/2)). */
export function anchorOf(lbx, lby) {
  return { ax: Math.floor((lbx - R_LB) / 2), ay: Math.floor((lby - R_LB) / 2) };
}

/** The 4 LB keys of a tile (packed 0xXXYY0000), world-edge-clamped. */
export function tileLbKeys(tileKey) {
  const tx = tileXOf(tileKey);
  const ty = tileYOf(tileKey);
  const out = [];
  for (const [lx, ly] of [[tx * 2, ty * 2], [tx * 2, ty * 2 + 1], [tx * 2 + 1, ty * 2], [tx * 2 + 1, ty * 2 + 1]]) {
    if (lx > 0xff || ly > 0xff) continue;
    out.push((((lx & 0xff) << 24) | ((ly & 0xff) << 16)) >>> 0);
  }
  return out;
}

function defaultNow() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) { /* fall through */ }
  return Date.now();
}

// ---------------------------------------------------------------------------
// SlotGrid — the WHAT of residency (policy core; no fetch/park side effects)
// ---------------------------------------------------------------------------

export class SlotGrid {
  /**
   * @param {object} deps
   * @param {()=>number} [deps.now]
   * @param {(msg:string, detail?:any)=>void} [deps.warn]
   * @param {(ev:{tile:number, from:string, to:string})=>void} [deps.onSlotState]
   * @param {(ev:{anchor:object, tiles:number[]})=>void} [deps.onSeed]
   * @param {(ev:{anchor:object, admitted:number[], vacated:number[], heading:{dx:number,dy:number}})=>void} [deps.onShift]
   * @param {(ev:{fromAnchor:object, toAnchor:object, vacated:number[]})=>void} [deps.onTeleport]
   */
  constructor({ now, warn, onSlotState, onSeed, onShift, onTeleport } = {}) {
    this.now = typeof now === "function" ? now : defaultNow;
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) {} };
    this._onSlotState = onSlotState || null;
    this._onSeed = onSeed || null;
    this._onShift = onShift || null;
    this._onTeleport = onTeleport || null;

    this.anchor = null; // {ax, ay} once seeded
    this.playerTile = -1;
    /** Sealed freeze (D-06.10): while true the wiring stops calling
     *  update(), window tiles may legally hold PARKED content, and the
     *  audit's tier check relaxes accordingly. */
    this.frozen = false;
    /** slots[r*W_T + c] = tileKey or -1 (off-map). */
    this.slots = new Array(SLOT_COUNT).fill(-1);
    /** Window membership cache, kept in LOCKSTEP with slots (audited). */
    this._window = new Set();
    /**
     * Slot records — every tile the grid currently manages: window tiles
     * (EMPTY/FETCHING/STAGED/LIVE) plus out-of-window LIVE-in-hysteresis /
     * PARKED / QUARANTINED tiles. Map<tileKey, {state, sinceMs, parkedAtMs,
     * sealedPinned}>.
     */
    this.records = new Map();

    this._stats = {
      seeds: 0, shifts: 0, teleports: 0, noMoves: 0, updates: 0,
      admitted: 0, vacated: 0,
      transitions: {}, // "FROM>TO" -> count
      // Integrity — MUST stay 0 (CENSUS-CI):
      shiftMismatches: 0, slotDesyncs: 0,
    };
    this._lastShiftCheck = null;
  }

  get windowTiles() { return this._window; }

  record(tile) { return this.records.get(tile) || null; }

  stateOf(tile) {
    const r = this.records.get(tile);
    return r ? r.state : SLOT_STATE.EMPTY;
  }

  /**
   * State transition executor (S2). Validates legality; an illegal request
   * bumps `slotDesyncs` (a state-machine desync IS a slot desync), warns,
   * and is REFUSED — the caller's world view was stale.
   * @returns {boolean} applied
   */
  setState(tile, to) {
    const rec = this.records.get(tile);
    const from = rec ? rec.state : SLOT_STATE.EMPTY;
    if (from === to) return true; // idempotent
    if (!LEGAL[from] || !LEGAL[from].has(to)) {
      this._stats.slotDesyncs += 1;
      this.warn(`[slotGrid] ILLEGAL transition ${from}>${to} for tile 0x${tile.toString(16)}`);
      return false;
    }
    if (to === SLOT_STATE.EMPTY) {
      this.records.delete(tile);
    } else if (rec) {
      rec.state = to;
      rec.sinceMs = this.now();
      if (to === SLOT_STATE.PARKED) rec.parkedAtMs = rec.sinceMs;
    } else {
      this.records.set(tile, {
        state: to, sinceMs: this.now(),
        parkedAtMs: to === SLOT_STATE.PARKED ? this.now() : 0,
        sealedPinned: false,
      });
    }
    const k = `${from}>${to}`;
    this._stats.transitions[k] = (this._stats.transitions[k] || 0) + 1;
    if (this._onSlotState) {
      try { this._onSlotState({ tile, from, to }); } catch (_) { /* events are best-effort */ }
    }
    return true;
  }

  // Fill the slot table for anchor (ax, ay), recording positional carry-over
  // when shifting — the fixed_grid.js `_placeBlock` mechanism at tile scale.
  _placeWindow(ax, ay, shift) {
    const prev = this.slots;
    const prevWindow = this._window;
    const next = new Array(SLOT_COUNT).fill(-1);
    let copied = 0;
    for (let r = 0; r < W_T; r += 1) {
      for (let c = 0; c < W_T; c += 1) {
        const tx = ax + c;
        const ty = ay + r;
        const key = (tileInMap(tx) && tileInMap(ty)) ? tileKeyOf(tx, ty) : -1;
        next[r * W_T + c] = key;
        if (shift && key !== -1) {
          const sr = r + shift.day;
          const sc = c + shift.dax;
          if (sr >= 0 && sr < W_T && sc >= 0 && sc < W_T && prev[sr * W_T + sc] === key) {
            copied += 1;
          }
        }
      }
    }
    this.slots = next;
    const window = new Set();
    for (const k of next) if (k !== -1) window.add(k);
    this._window = window;
    // SHIFT CROSS-CHECK (fixed_grid.js:271-288 verbatim mechanism): the
    // positional carry-over count must equal the pure set intersection — an
    // off-by-one in the shift offsets shows up here and nowhere else.
    if (shift) {
      let expectedCopied = 0;
      for (const k of window) if (prevWindow.has(k)) expectedCopied += 1;
      this._lastShiftCheck = { dax: shift.dax, day: shift.day, copied, expectedCopied };
      if (copied !== expectedCopied) this._stats.shiftMismatches += 1;
    } else {
      this._lastShiftCheck = null;
    }
  }

  /**
   * Feed the player's LB. Returns {seed|shift|teleport|moved, admitted,
   * vacated}: `admitted` = window tiles that just entered, `vacated` =
   * tiles that just left (their records stay — hysteresis/park own them).
   */
  update(lbx, lby) {
    this._stats.updates += 1;
    const cx = lbx & 0xff;
    const cy = lby & 0xff;
    const a = anchorOf(cx, cy);
    this.playerTile = tileOfLb(cx, cy);

    if (this.anchor === null) {
      this._stats.seeds += 1;
      const oldWindow = this._window; // nonempty on a RE-seed (sealed exit)
      this._placeWindow(a.ax, a.ay, null);
      this.anchor = a;
      const tiles = [...this._window];
      // A re-seed's departed tiles are VACATED (the sealed-exit / restart
      // path) — without this, out-of-window records would zombie as LIVE
      // forever and their pins would leak.
      const vacated = [];
      for (const k of oldWindow) if (!this._window.has(k)) vacated.push(k);
      this._stats.admitted += tiles.length;
      this._stats.vacated += vacated.length;
      if (this._onSeed) { try { this._onSeed({ anchor: { ...a }, tiles }); } catch (_) {} }
      return { moved: true, seed: true, shift: false, teleport: false, admitted: tiles, vacated };
    }

    const dax = a.ax - this.anchor.ax;
    const day = a.ay - this.anchor.ay;
    if (dax === 0 && day === 0) {
      this._stats.noMoves += 1;
      return { moved: false, seed: false, shift: false, teleport: false, admitted: [], vacated: [] };
    }

    const teleport = Math.abs(dax) >= W_T || Math.abs(day) >= W_T;
    const oldWindow = this._window;
    this._placeWindow(a.ax, a.ay, teleport ? null : { dax, day });
    const fromAnchor = this.anchor;
    this.anchor = a;
    const admitted = [];
    for (const k of this._window) if (!oldWindow.has(k)) admitted.push(k);
    const vacated = [];
    for (const k of oldWindow) if (!this._window.has(k)) vacated.push(k);
    this._stats.admitted += admitted.length;
    this._stats.vacated += vacated.length;

    if (teleport) {
      this._stats.teleports += 1;
      if (this._onTeleport) {
        try { this._onTeleport({ fromAnchor: { ...fromAnchor }, toAnchor: { ...a }, vacated }); } catch (_) {}
      }
      return { moved: true, seed: false, shift: false, teleport: true, admitted, vacated };
    }

    this._stats.shifts += 1;
    if (this._onShift) {
      try {
        this._onShift({ anchor: { ...a }, admitted, vacated, heading: { dx: Math.sign(dax), dy: Math.sign(day) } });
      } catch (_) {}
    }
    return { moved: true, seed: false, shift: true, teleport: false, admitted, vacated };
  }

  /**
   * Integrity audit (run on steady ticks / by the battery). Re-derives the
   * window from the anchor formula and checks (a) every slot holds the key
   * its own offset implies, (b) the `_window` cache matches the slot table,
   * (c) record states are tier-legal: a window tile may not be
   * PARKED/QUARANTINED-free — i.e. non-window records must be LIVE
   * (hysteresis), PARKED or QUARANTINED; window records must not be PARKED.
   * Any failure bumps `slotDesyncs`.
   */
  audit() {
    if (!this.anchor) return { ok: true };
    const misplaced = [];
    for (let r = 0; r < W_T; r += 1) {
      for (let c = 0; c < W_T; c += 1) {
        const tx = this.anchor.ax + c;
        const ty = this.anchor.ay + r;
        const want = (tileInMap(tx) && tileInMap(ty)) ? tileKeyOf(tx, ty) : -1;
        if (this.slots[r * W_T + c] !== want) misplaced.push({ r, c, got: this.slots[r * W_T + c], want });
      }
    }
    let lockstep = true;
    const derived = new Set();
    for (const k of this.slots) if (k !== -1) derived.add(k);
    if (derived.size !== this._window.size) lockstep = false;
    else { for (const k of derived) if (!this._window.has(k)) { lockstep = false; break; } }
    const tierIllegal = [];
    for (const [tile, rec] of this.records) {
      const inWindow = this._window.has(tile);
      if (inWindow && rec.state === SLOT_STATE.PARKED && !this.frozen) tierIllegal.push({ tile, state: rec.state, inWindow });
      if (!inWindow && (rec.state === SLOT_STATE.FETCHING || rec.state === SLOT_STATE.STAGED)) {
        // A vacated FETCHING/STAGED slot must have been driven to EMPTY by
        // the adapter (S2 "dequeued — never fetch-then-drop").
        tierIllegal.push({ tile, state: rec.state, inWindow });
      }
    }
    const ok = misplaced.length === 0 && lockstep && tierIllegal.length === 0;
    if (!ok) {
      this._stats.slotDesyncs += 1;
      this.warn("[slotGrid] audit divergence", { misplaced, lockstep, tierIllegal });
    }
    return { ok, misplaced, lockstep, tierIllegal };
  }

  counts() {
    const c = { live: 0, parked: 0, fetching: 0, staged: 0, quarantined: 0 };
    for (const rec of this.records.values()) {
      if (rec.state === SLOT_STATE.LIVE) c.live += 1;
      else if (rec.state === SLOT_STATE.PARKED) c.parked += 1;
      else if (rec.state === SLOT_STATE.FETCHING) c.fetching += 1;
      else if (rec.state === SLOT_STATE.STAGED) c.staged += 1;
      else if (rec.state === SLOT_STATE.QUARANTINED) c.quarantined += 1;
    }
    return c;
  }

  getStats() {
    return {
      W: W_T,
      anchor: this.anchor ? { ...this.anchor } : null,
      playerTile: this.playerTile,
      window: this._window.size,
      lastShiftCheck: this._lastShiftCheck ? { ...this._lastShiftCheck } : null,
      ...this._stats,
      transitions: { ...this._stats.transitions },
    };
  }
}

// ---------------------------------------------------------------------------
// PressureLadder — the 4-rung degradation ladder (D-06.6/S4)
// ---------------------------------------------------------------------------

export class PressureLadder {
  /**
   * @param {object} deps
   * @param {()=>number} [deps.now]
   * @param {()=>{heapBytes:number, wasmBytes:number, contextLoss:boolean}} deps.sample
   * @param {(rung:number, engaged:boolean)=>void} [deps.onRung]  R1..R4 hooks
   *   (engage true / release false). R1 = texture demote (a SEAM at T20 — the
   *   demote-to-preview primitive lands at ST5; engagements are counted
   *   either way), R2 = park release + budget halve, R3 = Rust budget halve,
   *   R4 = floor lowering + lookahead/laneT suspend + frame_work EMERGENCY.
   * @param {(ev:{rung:number, engaged:boolean})=>void} [deps.onLadder]
   * @param {number} [deps.heapTrigger]  bytes (default 0.9×M1)
   * @param {number} [deps.wasmTrigger]  bytes (default 0.94×M3)
   */
  constructor({ now, sample, onRung, onLadder, heapTrigger, wasmTrigger } = {}) {
    this.now = typeof now === "function" ? now : defaultNow;
    this.sample = typeof sample === "function" ? sample : () => ({ heapBytes: 0, wasmBytes: 0, contextLoss: false });
    this.onRung = typeof onRung === "function" ? onRung : () => {};
    this.onLadder = typeof onLadder === "function" ? onLadder : null;
    this.heapTrigger = heapTrigger ?? LADDER_HEAP_TRIGGER_BYTES;
    this.wasmTrigger = wasmTrigger ?? LADDER_WASM_TRIGGER_BYTES;
    this.rung = 0; // 0 = disengaged; 1..4 = R1..R4 engaged
    this._lastSampleMs = -Infinity;
    this._lastChangeMs = -Infinity;
    this._stats = {
      samples: 0, engagements: 0, releases: 0,
      r1Engagements: 0, r2Engagements: 0, r3Engagements: 0, r4Engagements: 0,
      floorLowerings: 0,
    };
  }

  _fire(rung, engaged) {
    try { this.onRung(rung, engaged); } catch (_) {}
    if (engaged) {
      this._stats[`r${rung}Engagements`] += 1;
      if (rung === 4) this._stats.floorLowerings += 1;
    }
    if (this.onLadder) { try { this.onLadder({ rung, engaged }); } catch (_) {} }
  }

  /** 1 Hz sampler (S4.3). Call every tick; internally rate-limited. */
  tick(nowMs = null) {
    const t = nowMs != null ? nowMs : this.now();
    if (t - this._lastSampleMs < LADDER_SAMPLE_MS) return this.rung;
    this._lastSampleMs = t;
    this._stats.samples += 1;
    let s;
    try { s = this.sample(); } catch (_) { s = { heapBytes: 0, wasmBytes: 0, contextLoss: false }; }
    const heap = s.heapBytes || 0;
    const wasm = s.wasmBytes || 0;
    const triggered = s.contextLoss === true
      || heap >= this.heapTrigger
      || wasm >= this.wasmTrigger;
    const releasable = heap < this.heapTrigger * LADDER_RELEASE_FRAC
      && wasm < this.wasmTrigger * LADDER_RELEASE_FRAC
      && s.contextLoss !== true;
    if (triggered) {
      if (this.rung === 0) {
        this.rung = 1;
        this._lastChangeMs = t;
        this._stats.engagements += 1;
        this._fire(1, true);
      } else if (this.rung < 4 && t - this._lastChangeMs >= LADDER_RUNG_DWELL_MS) {
        // The current rung had its ≥5 s to move the metric — escalate.
        this.rung += 1;
        this._lastChangeMs = t;
        this._fire(this.rung, true);
      }
    } else if (this.rung > 0 && releasable && t - this._lastChangeMs >= LADDER_RUNG_DWELL_MS) {
      // Release in REVERSE order at the 0.85 low-water (S4.3).
      this._fire(this.rung, false);
      this.rung -= 1;
      this._lastChangeMs = t;
      if (this.rung === 0) this._stats.releases += 1;
    }
    return this.rung;
  }

  getStats() {
    return { rung: this.rung, ...this._stats };
  }
}

// ---------------------------------------------------------------------------
// GridResidencyAdapter — the grid→legacy-producer adapter (SPEC §1.4 table)
// ---------------------------------------------------------------------------

/**
 * Drives TODAY'S producers from grid slot events (pools OFF):
 *
 *   grid event            legacy action (deps injected by scene3d/index.js)
 *   ------------------    ---------------------------------------------------
 *   admit (seed/shift)    pack fetch (controller lane R/U) → `pack_pin`;
 *                         per-LB build kickoff via feeds.fireLb (the
 *                         tickPvsLoadExpansion population, now event-driven)
 *   vacate                2 s hysteresis (EdgeParkScheduler at tile scale)
 *                         → lru.parkLb per LB (existing park machinery)
 *   PARKED→EMPTY          pressure pass: existing LRU dispose path via
 *                         lru.disposeLb, ≤1 tile/tick, floors honored,
 *                         `pack_unpin` + per-LB wasm world-cache clears
 *   QUARANTINED           tile's LBs never fed (controller bookkeeping is
 *                         authoritative; legacy-lane misses stay silent)
 *   teleport              grid drain replaces the LRU teleport purge:
 *                         vacated LIVE tiles park amortized (250 ms first
 *                         burst, 6 ms steady), then age out via the pool
 */
export class GridResidencyAdapter {
  /**
   * @param {object} deps
   * @param {SlotGrid} deps.grid
   * @param {object} deps.feeds  { fireLb(lbx, lby) } — the three legacy
   *   per-LB hooks (terrain/statics/buildings), idempotent by construction.
   * @param {object} deps.lru  { parkLb(lbKey):boolean, disposeLb(lbKey):boolean,
   *   unparkLb(lbKey):boolean, isParkedLb(lbKey):boolean, lbBytes(lbKey):number,
   *   touchLb?(lbKey) } — touchLb keeps the legacy LRU's recency truth: the
   *   pre-grid sweep re-touched every ring LB once per crossing, so the
   *   assert-only victim computation must keep seeing window LBs as fresh
   *   (without it, window content ages into the legacy victim set and reads
   *   as spurious gridLruDivergence).
   * @param {object|null} deps.packs  null = legacy-lane fetch (no pack dist);
   *   else { fetchTile(tile):Promise, tileHashes(tile):string[],
   *   isQuarantined(tile):boolean, pin(hash), unpin(hash) }
   * @param {(lbKey:number)=>void} [deps.evictLbCaches]  per-LB wasm
   *   world-cache clear (scenery/spawns rows) at true release.
   * @param {(tile:number)=>boolean} [deps.bakedPredicate]  STAGED→LIVE
   *   promotion check (terrain baked for the tile's in-map LBs).
   * @param {()=>number} [deps.now]
   * @param {(msg:string, detail?:any)=>void} [deps.warn]
   */
  constructor({ grid, feeds, lru, packs = null, evictLbCaches, bakedPredicate, now, warn } = {}) {
    this.grid = grid;
    this.feeds = feeds;
    this.lru = lru;
    this.packs = packs;
    this.evictLbCaches = typeof evictLbCaches === "function" ? evictLbCaches : null;
    this.bakedPredicate = typeof bakedPredicate === "function" ? bakedPredicate : null;
    this.now = typeof now === "function" ? now : defaultNow;
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) {} };

    // Park hysteresis at TILE scale — the proven EdgeParkScheduler adopted
    // verbatim (fixed_grid.js:504-606); `park` here parks the TILE.
    this.parkSched = new EdgeParkScheduler({
      park: (tile) => this._parkTile(tile),
      hysteresisMs: PARK_HYSTERESIS_MS,
      now: this.now,
    });

    /** Pin ledger: tileKey -> string[] of pack hashes pinned for the slot.
     *  Audited by `auditPins` — a pin for a tile that is not
     *  LIVE/PARKED/STAGED/FETCHING is a `pinLeak` (MUST stay 0). */
    this.pins = new Map();

    // Pressure state (S4). Floors are ladder-adjustable, NEVER below
    // PARK_FLOOR_EMERGENCY_MS, NEVER 0.
    this.parkFloorMs = PARK_FLOOR_MS;
    this.parkBudgetScale = 1; // R2 halves for the emergency's duration
    this.sealedCore = null; // Set<tileKey> pinned return core while sealed
    this._sealedEntryTile = -1;
    this._teleportDrain = null; // [tileKey...] pending amortized parks
    this._teleportFirstBurst = false;

    this._stats = {
      feedsFired: 0, feedLbs: 0, packFetches: 0, packPins: 0, packUnpins: 0,
      parksIssued: 0, parkLbsIssued: 0, releases: 0, releaseLbs: 0,
      reAdopts: 0, quarantineHolds: 0,
      parkDeferredCount: 0, parkDeferredBytes: 0,
      teleportDrains: 0, teleportDrainedTiles: 0,
      sealedFreezes: 0, sealedCorePinned: 0,
      pinLeaks: 0, // audited; MUST stay 0
      lastError: null,
    };
  }

  // ── admit / vacate (grid event handlers; wire these to the SlotGrid) ─────

  /** Handle a grid update result (seed/shift/teleport). */
  onUpdate(res) {
    if (!res || !res.moved) {
      // Steady tick: drain the park scheduler (walk-then-stand still parks).
      this.parkSched.drain();
      return;
    }
    if (res.teleport || res.seed) {
      // Pending hysteresis parks are dropped (D-06.10 — the fixed_grid
      // constraint #3 discipline); the amortized drain owns the vacated set
      // (a RE-seed's departed tiles take the same path as a teleport's).
      this.parkSched.reset();
      if (res.vacated.length > 0) this._beginTeleportDrain(res.vacated);
    } else {
      // Shift: a re-entering tile cancels its pending park (anti zig-zag).
      this.parkSched.onResident(res.admitted);
      for (const tile of res.vacated) this._vacate(tile);
    }
    for (const tile of res.admitted) this._admit(tile);
    if (!res.teleport && !res.seed) this.parkSched.drain();
    // Per-crossing window touch (legacy parity — see the touchLb dep doc):
    // one Map write per window LB, the recency signal the retired
    // per-crossing sweep used to provide.
    if (typeof this.lru.touchLb === "function") {
      for (const tile of this.grid.windowTiles) {
        for (const lbKey of tileLbKeys(tile)) {
          try { this.lru.touchLb(lbKey); } catch (_) {}
        }
      }
    }
  }

  _admit(tile) {
    const g = this.grid;
    const st = g.stateOf(tile);
    if (st === SLOT_STATE.PARKED) {
      // PARKED → LIVE: pointer re-adopt — zero fetch, zero decode. The
      // loaders' unpark fast-path does the re-attach when feeds re-fire.
      g.setState(tile, SLOT_STATE.LIVE);
      for (const lbKey of tileLbKeys(tile)) {
        try { if (this.lru.isParkedLb(lbKey)) this.lru.unparkLb(lbKey); } catch (_) {}
      }
      this._stats.reAdopts += 1;
      this._fireFeeds(tile); // idempotent; re-arms baked-set fast paths
      return;
    }
    if (st === SLOT_STATE.LIVE || st === SLOT_STATE.STAGED || st === SLOT_STATE.FETCHING) {
      return; // already managed (zig-zag re-entry inside hysteresis)
    }
    if (this.packs) {
      if (this.packs.isQuarantined(tile)) {
        // Controller quarantine is authoritative: never fed, never
        // rendered-as-empty. Timed re-eligibility is the controller's; the
        // next admit retries naturally.
        g.setState(tile, SLOT_STATE.QUARANTINED);
        this._stats.quarantineHolds += 1;
        return;
      }
      g.setState(tile, SLOT_STATE.FETCHING); // EMPTY→ or QUARANTINED→ (timed re-eligibility)
      this._stats.packFetches += 1;
      this.packs.fetchTile(tile).then(
        () => this._onTileStaged(tile),
        (e) => this._onTileFetchFailed(tile, e),
      );
    } else {
      // Legacy-lane arm (no pack dist): records fetch per-record inside the
      // guarded bakes — the slot stages immediately.
      g.setState(tile, SLOT_STATE.STAGED);
      this._fireFeeds(tile);
    }
  }

  _onTileStaged(tile) {
    const g = this.grid;
    if (g.stateOf(tile) !== SLOT_STATE.FETCHING) return; // vacated meanwhile
    if (!g.windowTiles.has(tile)) {
      // Vacated before receipt: dequeue semantics — never fetch-then-drop
      // into the scene. Bytes ride the PackStore floor for a fast return.
      g.setState(tile, SLOT_STATE.EMPTY);
      return;
    }
    g.setState(tile, SLOT_STATE.STAGED);
    this._pinTile(tile);
    this._fireFeeds(tile);
  }

  _onTileFetchFailed(tile, _e) {
    const g = this.grid;
    if (g.stateOf(tile) !== SLOT_STATE.FETCHING) return;
    if (this.packs && this.packs.isQuarantined(tile)) {
      g.setState(tile, SLOT_STATE.QUARANTINED);
    } else {
      // Transient (dropped/dequeued): back to EMPTY; a later admit retries.
      g.setState(tile, SLOT_STATE.EMPTY);
    }
  }

  _fireFeeds(tile) {
    this._stats.feedsFired += 1;
    for (const lbKey of tileLbKeys(tile)) {
      const lbx = (lbKey >>> 24) & 0xff;
      const lby = (lbKey >>> 16) & 0xff;
      try {
        this.feeds.fireLb(lbx, lby);
        this._stats.feedLbs += 1;
      } catch (e) {
        if (!this._stats.lastError) this._stats.lastError = String(e && e.message ? e.message : e);
      }
    }
  }

  _vacate(tile) {
    const g = this.grid;
    const st = g.stateOf(tile);
    if (st === SLOT_STATE.FETCHING) {
      // Vacated before fetch: EMPTY (the controller's ring backpressure
      // dequeues its own lane-R entry on the next notePlayerLandblock).
      g.setState(tile, SLOT_STATE.EMPTY);
      return;
    }
    if (st === SLOT_STATE.STAGED) {
      // Unbaked vacated slot goes straight to EMPTY (S2); unpin — the pack
      // bytes ride the PackStore floor.
      this._unpinTile(tile);
      g.setState(tile, SLOT_STATE.EMPTY);
      return;
    }
    if (st === SLOT_STATE.LIVE) {
      // 2 s hysteresis then park (the scheduler drives _parkTile).
      this.parkSched.onVacated([tile]);
    }
    // PARKED / QUARANTINED / EMPTY: nothing to do.
  }

  _parkTile(tile) {
    const g = this.grid;
    if (g.stateOf(tile) !== SLOT_STATE.LIVE) return false;
    if (g.windowTiles.has(tile)) return false; // re-admitted since (safety)
    let any = false;
    for (const lbKey of tileLbKeys(tile)) {
      try { if (this.lru.parkLb(lbKey)) any = true; } catch (_) {}
    }
    g.setState(tile, SLOT_STATE.PARKED);
    this._stats.parksIssued += 1;
    if (any) this._stats.parkLbsIssued += 1;
    return true;
  }

  // ── STAGED→LIVE promotion (bake completion poll — pass 8 owns the real
  //    event at ST9; at T20 the baked-set predicate is the completion signal)
  tickPromotions() {
    if (!this.bakedPredicate) return;
    const g = this.grid;
    for (const tile of g.windowTiles) {
      if (g.stateOf(tile) !== SLOT_STATE.STAGED) continue;
      let baked = false;
      try { baked = this.bakedPredicate(tile) === true; } catch (_) {}
      if (baked) g.setState(tile, SLOT_STATE.LIVE);
    }
  }

  // ── pack pins (D-06.5.1) ─────────────────────────────────────────────────

  _pinTile(tile) {
    if (!this.packs || this.pins.has(tile)) return;
    let hashes = [];
    try { hashes = this.packs.tileHashes(tile) || []; } catch (_) {}
    if (hashes.length === 0) return;
    for (const h of hashes) {
      try { this.packs.pin(h); this._stats.packPins += 1; } catch (_) {}
    }
    this.pins.set(tile, hashes);
  }

  _unpinTile(tile) {
    const hashes = this.pins.get(tile);
    if (!hashes) return;
    for (const h of hashes) {
      try { this.packs.unpin(h); this._stats.packUnpins += 1; } catch (_) {}
    }
    this.pins.delete(tile);
  }

  /** Pin-ledger audit: a pin held by a tile that is not FETCHING/STAGED/
   *  LIVE/PARKED is a leak. Diffable counter; MUST stay 0. */
  auditPins() {
    let leaks = 0;
    for (const tile of this.pins.keys()) {
      const st = this.grid.stateOf(tile);
      if (st === SLOT_STATE.EMPTY || st === SLOT_STATE.QUARANTINED) leaks += 1;
    }
    if (leaks > 0) {
      this._stats.pinLeaks += leaks;
      this.warn(`[slotGrid] pin ledger leak: ${leaks} pinned non-resident tiles`);
    }
    return leaks;
  }

  // ── teleport drain (D-06.10) ─────────────────────────────────────────────

  _beginTeleportDrain(vacated) {
    const list = [];
    for (const tile of vacated) {
      const st = this.grid.stateOf(tile);
      if (st === SLOT_STATE.LIVE) list.push(tile);
      else if (st === SLOT_STATE.FETCHING) this.grid.setState(tile, SLOT_STATE.EMPTY);
      else if (st === SLOT_STATE.STAGED) {
        this._unpinTile(tile);
        this.grid.setState(tile, SLOT_STATE.EMPTY);
      }
    }
    if (list.length > 0) {
      this._teleportDrain = list;
      this._teleportFirstBurst = true;
      this._stats.teleportDrains += 1;
    }
  }

  /** Amortized teleport park drain: first tick ~250 ms, then 6 ms (R-12). */
  tickTeleportDrain() {
    const list = this._teleportDrain;
    if (!list || list.length === 0) { this._teleportDrain = null; return; }
    const budget = this._teleportFirstBurst ? TELEPORT_FIRST_BURST_MS : RELEASE_BUDGET_MS;
    this._teleportFirstBurst = false;
    const t0 = this.now();
    while (list.length > 0) {
      const tile = list.pop();
      if (this.grid.stateOf(tile) === SLOT_STATE.LIVE && !this.grid.windowTiles.has(tile)) {
        this._parkTile(tile);
        this._stats.teleportDrainedTiles += 1;
      }
      if (this.now() - t0 > budget) break;
    }
    if (list.length === 0) this._teleportDrain = null;
  }

  // ── sealed interiors (D-06.10): freeze + pinned return core ─────────────

  sealedEnter(entryLbKey) {
    const entryTile = tileOfLb((entryLbKey >>> 24) & 0xff, (entryLbKey >>> 16) & 0xff);
    if (this.sealedCore && this._sealedEntryTile === entryTile) return;
    this._sealedEntryTile = entryTile;
    this.sealedCore = new Set();
    this.grid.frozen = true;
    this._stats.sealedFreezes += 1;
    this.parkSched.reset();
    // All outdoor window slots go PARKED via the (amortized) drain path;
    // the ≤9 tiles within Chebyshev 1 of the entry tile are the pinned
    // return core — exempt from pressure rungs R1–R3 for the dwell.
    const toPark = [];
    for (const tile of this.grid.windowTiles) {
      const st = this.grid.stateOf(tile);
      if (tileChebyshev(tile, entryTile) <= SEALED_CORE_RADIUS_T) {
        this.sealedCore.add(tile);
        this._stats.sealedCorePinned += 1;
      }
      if (st === SLOT_STATE.LIVE) toPark.push(tile);
      else if (st === SLOT_STATE.FETCHING) this.grid.setState(tile, SLOT_STATE.EMPTY);
      else if (st === SLOT_STATE.STAGED) { this._unpinTile(tile); this.grid.setState(tile, SLOT_STATE.EMPTY); }
    }
    // Amortized direct-park drain (same bounds as the teleport drain — the
    // S6 "sealed lattice collapses into freeze + pinned core" line). Window
    // membership does not gate the sealed park: the grid is FROZEN (the
    // wiring stops calling update() while sealed), so the tiles stay in the
    // window while their content parks.
    this._sealedDrainList = toPark;
    this._sealedFirstBurst = true;
  }

  tickSealedDrain() {
    const list = this._sealedDrainList;
    if (!list || list.length === 0) return;
    const budget = this._sealedFirstBurst ? TELEPORT_FIRST_BURST_MS : RELEASE_BUDGET_MS;
    this._sealedFirstBurst = false;
    const t0 = this.now();
    while (list.length > 0) {
      const tile = list.pop();
      if (this.grid.stateOf(tile) === SLOT_STATE.LIVE) {
        // Direct park (grid frozen — window membership check bypassed).
        let any = false;
        for (const lbKey of tileLbKeys(tile)) {
          try { if (this.lru.parkLb(lbKey)) any = true; } catch (_) {}
        }
        this.grid.setState(tile, SLOT_STATE.PARKED);
        this._stats.parksIssued += 1;
        if (any) this._stats.parkLbsIssued += 1;
      }
      if (this.now() - t0 > budget) break;
    }
  }

  sealedExit() {
    // Pins release; re-seed is the wiring's job (grid.anchor = null →
    // next update seeds at the exit position; core tiles re-adopt via the
    // PARKED→LIVE pointer path when re-admitted).
    this.sealedCore = null;
    this._sealedEntryTile = -1;
    this._sealedDrainList = null;
    this.grid.frozen = false;
  }

  get sealed() { return this.sealedCore !== null; }

  // ── pressure pass (S4.1 park-pool loop; PARKED→EMPTY true release) ──────

  /** Park-pool occupancy: [tiles, bytes] over PARKED records. */
  _parkPool() {
    const pool = [];
    let bytes = 0;
    for (const [tile, rec] of this.grid.records) {
      if (rec.state !== SLOT_STATE.PARKED) continue;
      let b = 0;
      for (const lbKey of tileLbKeys(tile)) {
        try { b += this.lru.lbBytes(lbKey) || 0; } catch (_) {}
      }
      pool.push({ tile, parkedAtMs: rec.parkedAtMs, bytes: b });
      bytes += b;
    }
    return { pool, bytes };
  }

  /**
   * The class-local park-pool budget loop (S4.1): ≤40 tiles AND
   * ≤128 MiB × parkBudgetScale, floor honored (30 s; ladder R4 lowers to
   * 5 s, never 0), farthest-from-player-first oldest-tie, ≤1 tile released
   * per tick. All-young + over-budget ⇒ run over and count. The sealed
   * return core and the player's 3×3 are never victims (R1–R3).
   * @param {boolean} [emergency]  R4: core pins may be shed (loudly)
   */
  tickPressure(emergency = false) {
    const { pool, bytes } = this._parkPool();
    const maxTiles = Math.max(1, Math.floor(PARK_POOL_MAX_TILES * this.parkBudgetScale));
    const maxBytes = Math.floor(PARK_POOL_MAX_BYTES * this.parkBudgetScale);
    if (pool.length <= maxTiles && bytes <= maxBytes) return;
    const nowMs = this.now();
    // Floor: NEVER zero (the deleted landblock_lru.js:1373-1374 pathology).
    const floorMs = Math.max(PARK_FLOOR_EMERGENCY_MS, this.parkFloorMs);
    const playerTile = this.grid.playerTile;
    const candidates = [];
    let deferred = 0;
    let deferredBytes = 0;
    for (const p of pool) {
      // NEVER-shed list (S4.5): player's own tile + neighbors (the 3×3-LB
      // floor is inside the player tile + Chebyshev-1 tiles), sealed core.
      if (playerTile !== -1 && tileChebyshev(p.tile, playerTile) <= 1) continue;
      if (!emergency && this.sealedCore && this.sealedCore.has(p.tile)) continue;
      if (nowMs - p.parkedAtMs < floorMs) {
        deferred += 1;
        deferredBytes += p.bytes;
        continue;
      }
      candidates.push(p);
    }
    if (candidates.length === 0) {
      // Run over and record — floors hold (D-06.5).
      this._stats.parkDeferredCount += deferred;
      this._stats.parkDeferredBytes += deferredBytes;
      return;
    }
    // Farthest-from-player first, oldest breaking ties.
    candidates.sort((a, b) => {
      if (playerTile !== -1) {
        const d = tileChebyshev(b.tile, playerTile) - tileChebyshev(a.tile, playerTile);
        if (d !== 0) return d;
      }
      return a.parkedAtMs - b.parkedAtMs;
    });
    // ≤1 tile true-release per tick (D-06.3 amortization).
    this._releaseTile(candidates[0].tile);
  }

  /** PARKED→EMPTY: existing LRU dispose path + unpin + per-LB cache clears. */
  _releaseTile(tile) {
    for (const lbKey of tileLbKeys(tile)) {
      try { this.lru.disposeLb(lbKey); } catch (_) {}
      if (this.evictLbCaches) { try { this.evictLbCaches(lbKey); } catch (_) {} }
      this._stats.releaseLbs += 1;
    }
    this._unpinTile(tile);
    this.grid.setState(tile, SLOT_STATE.EMPTY);
    this._stats.releases += 1;
  }

  /** Session teardown: release everything (amortization waived). */
  dispose() {
    for (const [tile, rec] of [...this.grid.records]) {
      if (rec.state === SLOT_STATE.PARKED) this._releaseTile(tile);
      else if (rec.state === SLOT_STATE.STAGED || rec.state === SLOT_STATE.LIVE) {
        this._unpinTile(tile);
      }
    }
    this.parkSched.reset();
  }

  getStats() {
    const { pool, bytes } = this._parkPool();
    return {
      parkPoolTiles: pool.length,
      parkPoolBytes: bytes,
      parkFloorMs: Math.max(PARK_FLOOR_EMERGENCY_MS, this.parkFloorMs),
      parkBudgetScale: this.parkBudgetScale,
      pinnedTiles: this.pins.size,
      sealed: this.sealed,
      sealedCoreTiles: this.sealedCore ? this.sealedCore.size : 0,
      park: this.parkSched.getStats(),
      ...this._stats,
    };
  }
}
