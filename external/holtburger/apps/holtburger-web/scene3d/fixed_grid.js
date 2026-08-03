// scene3d/fixed_grid.js — `?fixedGrid` player-centered slot-grid residency
// DRIVER (docs/PLAN-fixed-slot-grid-residency-2026-07-11.md §2, landing §5.3/§5.4).
//   S15b: TERRAIN slot grid (shift-in-place; the FixedSlotGrid below).
//   S15c: the vacated edge → real whole-LB park (buildings/statics/scenery/cells
//         ride park()'s existing per-layer detach) via the hysteresis-gated
//         EdgeParkScheduler at the bottom of this file, + a post-crossing diag
//         grace on the derived-view assert.
//
// Pure, injected-deps core (the scene3d/terrain_ring.js + scene3d/world_stream.js
// pattern): no `three`, no `window`, no wasm import — so it unit-tests without a
// browser (test_fixed_grid.mjs). The scene3d wiring — the `loadTerrainRing`
// facade in scene3d/index.js, the single terrain call-site both position-update
// ring drivers (scene3d/world_stream.js + the legacy index.html A15-Q4-SYNC
// block) share — injects the live deps.
//
// Retail model (plan §1, L1): `LScape::update_block` (acclient.c:307916) keeps a
// FIXED player-centered `land_blocks[W²]` pointer grid; on an LB crossing the
// grid SHIFTS IN PLACE — interior pointers are copied, only the leading/trailing
// EDGE row is released/fetched. No dump, no re-bake-on-return. This is that grid
// for the TERRAIN layer (S15b): the slot owns the terrain residency RECORD (what
// the grid says should be resident); the existing guarded bake path
// (`loadTerrainRing` → runTerrainRingBatch → `loadTerrainForLandblock` +
// `_guardedStreamBake`) still decides HOW to bake. The grid does NOT build a
// parallel bake path (plan §3, non-goal).
//
// What S15b changes on the ON path (vs the flag-OFF facade, which re-runs the
// whole ring on EVERY position packet — sub-LB moves included):
//   - Steady state (player within one LB): ZERO terrain work — the grid is
//     already up to date; the LRU's 3×3 always-resident floor holds the block.
//   - LB crossing with grid overlap (a walk / short hop): SHIFT — interior
//     untouched (no fetch, no release, no LRU churn); the incoming edge is one
//     batched `fetchEdge` (→ runTerrainRingBatch on the new centre, whose
//     already-baked pre-filter naturally narrows the wasm fetch to the leading
//     edge); the vacated edge goes to `releaseEdge` (the existing release/park
//     path — see the index.js wiring for the S15b scoping of the release side).
//   - Teleport (no grid overlap): WHOLE-GRID INVALIDATE == today's behavior
//     EXACTLY — `fetchEdge(newBlock)` (→ the same runTerrainRingBatch the OFF
//     path calls), and NO proactive release (today's teleport does not release;
//     the LRU reclaims the old block). This bounds regression risk for the
//     teleport-dominated battery (plan §2, gate §4.2).
//
// The grid is the terrain residency authority on the ON path; `terrainBakedLbs`
// etc. stay authoritative for the rest of the code. Under `?diag=1` the grid
// periodically asserts its resident set against the derived view
// (`terrainBakedLbs` ∩ block) and warns loudly with the diff on divergence
// (plan §2 "kept in sync, asserted equal").

// Grid radius comes from the ring the drivers actually drive today: the two
// position-update ring drivers call `loadTerrainRing(cx,cy)`, whose
// runTerrainRingBatch bakes the hardcoded 3×3 (dy/dx ∈ [-1,1]) — radius 1. So
// W = 2·radius+1 = 3 for S15b's terrain layer. (Plan §2 frames W in terms of
// `pvsRingRadius`; the radius-5 PVS expansion ring is driven separately by
// cells.js `tickPvsLoadExpansion`, which is out of S15b's terrain-near-ring
// scope — the "ring drivers" the brief points at are the loadTerrainRing pair.)
export const FIXED_GRID_TERRAIN_RADIUS = 1;

// LB x/y bytes span 0x00..0xff; off-map neighbours are dropped (clamp, never
// wrap to the far side of the world) — identical to the runTerrainRingBatch /
// world_stream / legacy-index.html ring clamp.
function inMap(v) {
  return v >= 0 && v <= 0xff;
}

// Monotonic-ish clock for the diag grace window / park hysteresis. performance
// is preferred; Date.now is the node/older-env fallback. Injected in tests.
function defaultNow() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) { /* fall through */ }
  return Date.now();
}

/**
 * The clamped W×W block of lb-keys centred on (cx, cy). Off-map cells are
 * simply absent (the block shrinks near a world edge) — matching the ring
 * clamp everywhere else.
 * @returns {Set<number>}
 */
export function computeBlockKeys(cx, cy, radius, lbKeyFromXY) {
  const out = new Set();
  const cxi = cx & 0xff;
  const cyi = cy & 0xff;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = cxi + dx;
      const ny = cyi + dy;
      if (!inMap(nx) || !inMap(ny)) continue;
      out.add(lbKeyFromXY(nx, ny) >>> 0);
    }
  }
  return out;
}

// a − b (elements of a not in b).
function setDiff(a, b) {
  const out = new Set();
  for (const k of a) if (!b.has(k)) out.add(k);
  return out;
}

/**
 * Derived-view assertion (plan §2). Compares what the grid claims resident to
 * what the bake path has actually produced, restricted to the current block.
 * Pure so it is unit-testable in isolation.
 *
 * @param {object} p
 * @param {Set<number>} p.resident   grid's resident record
 * @param {Set<number>} p.baked      the derived view (e.g. terrainBakedLbs)
 * @param {Set<number>|null} p.inFlight lb-keys whose terrain bake is in flight
 * @param {Set<number>} p.block      the current clamped W×W block
 * @returns {{unbacked:number[], untracked:number[], offBlock:number[]}}
 *   unbacked  — grid claims resident (on-block) but the bake path has neither
 *               baked it nor has it in flight (a grid that over-claims: it
 *               would then skip re-fetching a void LB → the divergence that
 *               makes the grid's fetch-skipping unsafe).
 *   untracked — baked & on-block but the grid does NOT claim it resident (grid
 *               under-claims / lost track of a block LB).
 *   offBlock  — grid claims resident for a key outside its own block (a grid
 *               bookkeeping bug — the shift left a stale slot).
 */
export function diffResidency({ resident, baked, inFlight, block }) {
  const unbacked = [];
  const offBlock = [];
  for (const k of resident) {
    if (!block.has(k)) {
      offBlock.push(k);
      continue;
    }
    if (!baked.has(k) && !(inFlight && inFlight.has(k))) unbacked.push(k);
  }
  const untracked = [];
  for (const k of block) {
    if (baked.has(k) && !resident.has(k)) untracked.push(k);
  }
  return { unbacked, untracked, offBlock };
}

export class FixedSlotGrid {
  /**
   * @param {object} deps
   * @param {number} deps.radius  grid radius (W = 2·radius+1). ≥1.
   * @param {(lbX:number, lbY:number)=>number} deps.lbKeyFromXY
   * @param {(edgeKeys:Set<number>, cx:number, cy:number)=>any} deps.fetchEdge
   *   Dispatch a residency FETCH for the incoming edge (or the whole block on a
   *   teleport/seed). Called at most ONCE per crossing (one batched call). The
   *   wiring maps this to runTerrainRingBatch on the new centre.
   * @param {(edgeKeys:Set<number>)=>any} deps.releaseEdge
   *   Route the vacated edge to the existing release/park path. NOT called on a
   *   teleport (today's behavior: the LRU reclaims the old block). S15c wires
   *   this to the EdgeParkScheduler's `onVacated` so the vacated set schedules a
   *   hysteresis-gated whole-LB park (see the index.js grid construction).
   * @param {()=>number} [deps.now]  monotonic clock (ms) — ONLY used for the
   *   `?diag=1` post-crossing grace window (§ assertResidency). Defaults to
   *   performance.now()/Date.now(); tests inject a controllable clock.
   * @param {()=>object} [deps.parkStatsProvider]  optional accessor merged into
   *   getStats() under a `park` key so the ONE `window.__fixedGrid.getStats()`
   *   the wave-2D probe reads carries the S15c EdgeParkScheduler counters too
   *   (the grid stays pure — it just calls the injected function).
   * @param {(msg:string, detail?:any)=>void} [deps.warn]
   */
  constructor({ radius, lbKeyFromXY, fetchEdge, releaseEdge, now, parkStatsProvider, warn } = {}) {
    this.radius = Math.max(1, radius | 0);
    this.width = 2 * this.radius + 1;
    this.lbKeyFromXY = lbKeyFromXY;
    this.fetchEdge = typeof fetchEdge === "function" ? fetchEdge : () => {};
    this.releaseEdge = typeof releaseEdge === "function" ? releaseEdge : () => {};
    this.now = typeof now === "function" ? now : defaultNow;
    this._parkStatsProvider = typeof parkStatsProvider === "function" ? parkStatsProvider : null;
    this.warn = typeof warn === "function"
      ? warn
      : (m, d) => { try { console.warn(m, d); } catch (_) {} };

    // Timestamp (via `now()`) of the last MOVED crossing (seed/teleport/shift).
    // The `?diag=1` derived-view assert uses it to grace the async bake window:
    // an `unbacked` block LB seen within FIXED_GRID_DIAG_GRACE_MS of a crossing
    // is the in-flight bake catching up, not a true divergence (docs/1123.md §3
    // known noise — 13 transient warns). null until the first crossing.
    this._lastCrossingAtMs = null;

    this.center = null; // { cx, cy } once seeded
    // slots[row * W + col] = lb-key or -1 (off-map). Slot (r,c) represents the
    // LB at (centerCx + (c-radius), centerCy + (r-radius)). Maintained by an
    // in-place pointer SHIFT on each crossing (interior slots copied, only the
    // edge slots rewritten) — the retail land_blocks[] discipline.
    this.slots = new Array(this.width * this.width).fill(-1);
    // The authoritative resident record: the set of on-map lb-keys the grid
    // says should be resident (the non-(-1) slots). Kept in lockstep with slots.
    this._resident = new Set();

    this._stats = {
      updates: 0, crossings: 0, shifts: 0, teleports: 0, seeds: 0, noMoves: 0,
      fetchCalls: 0, releaseCalls: 0, assertRuns: 0, assertWarns: 0,
      // S15c grace telemetry: unbacked block LBs suppressed inside the
      // post-crossing bake-window grace (transient, NOT a divergence), and how
      // many assert runs did any grace suppression. A wave-2D diag battery can
      // gate on "0 non-transient warns" = assertWarns stays flat while these
      // absorb the boot/teleport bake ramp.
      transientUnbackedSuppressed: 0, graceSuppressedRuns: 0,
      // F8 (2026-08-03): the two detectors below are the only ones in this
      // class that can contradict the block formula — see _placeBlock's shift
      // cross-check and assertResidency's slot-table derivation. Both MUST
      // stay 0; a non-zero value is a real bookkeeping bug, not bake noise.
      shiftMismatches: 0, slotDesyncs: 0,
      lastDx: 0, lastDy: 0,
    };
    // { dx, dy, copied, expectedCopied } for the last shift crossing, or null.
    this._lastShiftCheck = null;
  }

  /** The grid's resident record (the lb-keys it claims should be resident). */
  get residentKeys() {
    return this._resident;
  }

  getStats() {
    const base = {
      radius: this.radius,
      width: this.width,
      center: this.center ? { ...this.center } : null,
      resident: this._resident.size,
      lastCrossingAtMs: this._lastCrossingAtMs,
      lastShiftCheck: this._lastShiftCheck ? { ...this._lastShiftCheck } : null,
      ...this._stats,
    };
    // Merge the S15c park scheduler counters (parksIssued, parkSkippedInEntriesMiss,
    // pending, …) so the probe reads ONE object. Null when park wiring is off
    // (?fixedGridPark=off) or absent (unit/capture paths).
    if (this._parkStatsProvider) {
      try { base.park = this._parkStatsProvider(); } catch (_) { base.park = null; }
    }
    return base;
  }

  // Recompute slots + resident from the block geometry, recording which slots
  // were carried over from the previous grid (interior, untouched) vs newly
  // filled (edge). We derive the slot values from the freshly-clamped block so
  // world-edge growth/shrink is always correct; the `shift` bookkeeping is what
  // proves the interior was a pointer-copy, not a rebuild.
  _placeBlock(cx, cy, shift) {
    const W = this.width;
    const R = this.radius;
    const prev = this.slots;
    const next = new Array(W * W).fill(-1);
    let copied = 0;
    for (let r = 0; r < W; r += 1) {
      for (let c = 0; c < W; c += 1) {
        const nx = (cx & 0xff) + (c - R);
        const ny = (cy & 0xff) + (r - R);
        const key = (inMap(nx) && inMap(ny)) ? (this.lbKeyFromXY(nx, ny) >>> 0) : -1;
        next[r * W + c] = key;
        // Interior carry-over check: the same absolute LB occupied slot
        // (r+dy, c+dx) of the previous grid. If that source slot held the same
        // key, it is an untouched interior pointer copy.
        if (shift && key !== -1) {
          const sr = r + shift.dy;
          const sc = c + shift.dx;
          if (sr >= 0 && sr < W && sc >= 0 && sc < W && prev[sr * W + sc] === key) {
            copied += 1;
          }
        }
      }
    }
    const prevResident = this._resident;
    this.slots = next;
    const resident = new Set();
    for (const k of next) if (k !== -1) resident.add(k);
    this._resident = resident;

    // SHIFT CROSS-CHECK (2026-08-03 review F8). `copied` above is POSITIONAL:
    // it walks the shift offsets into the previous slot array. Compute the same
    // quantity a completely different way — pure set intersection, no offsets —
    // so the two can disagree. They must not: every key present in both blocks
    // is, under a correct shift, reachable at the shifted slot index. An
    // off-by-one in `sr`/`sc` shows up here and NOWHERE else, because every
    // other value in this class is re-derived from the block formula and so
    // cannot contradict it.
    if (shift) {
      let expectedCopied = 0;
      for (const k of resident) if (prevResident.has(k)) expectedCopied += 1;
      this._lastShiftCheck = { dx: shift.dx, dy: shift.dy, copied, expectedCopied };
      if (copied !== expectedCopied) this._stats.shiftMismatches += 1;
    } else {
      this._lastShiftCheck = null;
    }
    return { copied };
  }

  /**
   * Feed the grid the player's current centre LB (cx, cy). Computes the shift,
   * routes the edge fetch/release, and returns a description of what happened.
   * @returns {{moved:boolean, teleport:boolean, seed:boolean,
   *            incoming:Set<number>, vacated:Set<number>}}
   */
  update(cx, cy) {
    this._stats.updates += 1;
    const cxi = cx & 0xff;
    const cyi = cy & 0xff;
    const newBlock = computeBlockKeys(cxi, cyi, this.radius, this.lbKeyFromXY);

    // First observation (boot / post-connect first packet): seed the grid and
    // fetch the whole block — this IS today's behavior (the driver's first
    // loadTerrainRing bakes the ring). No release (nothing to vacate).
    if (this.center === null) {
      this._stats.seeds += 1;
      this._placeBlock(cxi, cyi, null);
      this.center = { cx: cxi, cy: cyi };
      this._lastCrossingAtMs = this.now();
      this._stats.fetchCalls += 1;
      this.fetchEdge(newBlock, cxi, cyi);
      return { moved: true, teleport: false, seed: true, incoming: new Set(newBlock), vacated: new Set() };
    }

    const dx = cxi - this.center.cx;
    const dy = cyi - this.center.cy;
    this._stats.lastDx = dx;
    this._stats.lastDy = dy;

    // No LB crossing — steady state (sub-LB movement, standing still). ZERO
    // terrain work: the grid is already current and the LRU floor holds the
    // block resident. (This is the idle/walk churn the flag-OFF facade paid
    // every packet.)
    if (dx === 0 && dy === 0) {
      this._stats.noMoves += 1;
      return { moved: false, teleport: false, seed: false, incoming: new Set(), vacated: new Set() };
    }

    this._stats.crossings += 1;
    this._lastCrossingAtMs = this.now(); // grace anchor (teleport + shift alike)
    const oldBlock = this._resident;
    const incoming = setDiff(newBlock, oldBlock);
    const vacated = setDiff(oldBlock, newBlock);

    // Two W×W blocks centred |dx|/|dy| apart share a column/row iff |dx|<W and
    // |dy|<W; otherwise there is NO overlap → teleport. (Plan says "delta > W";
    // the exact no-overlap boundary is |dx|≥W or |dy|≥W — for W=3 that is a
    // ≥3-LB jump, which a walk never produces.)
    const teleport = Math.abs(dx) >= this.width || Math.abs(dy) >= this.width;

    // Pointer-shift (overlap) or whole rebuild (teleport — no interior to
    // carry). Either way the resulting slots/resident == the clamped new block.
    this._placeBlock(cxi, cyi, teleport ? null : { dx, dy });
    this.center = { cx: cxi, cy: cyi };

    if (teleport) {
      this._stats.teleports += 1;
      // Whole-grid invalidate == today's behavior EXACTLY: fetch the new block
      // (→ the same runTerrainRingBatch the OFF path calls), and NO proactive
      // release — the LRU reclaims the old block just as it does today.
      this._stats.fetchCalls += 1;
      this.fetchEdge(newBlock, cxi, cyi);
      return { moved: true, teleport: true, seed: false, incoming, vacated };
    }

    // Shift: one batched incoming-edge fetch + the vacated-edge release. The
    // interior (newBlock ∩ oldBlock) appears in neither diff → untouched.
    this._stats.shifts += 1;
    if (incoming.size > 0) {
      this._stats.fetchCalls += 1;
      this.fetchEdge(incoming, cxi, cyi);
    }
    if (vacated.size > 0) {
      this._stats.releaseCalls += 1;
      this.releaseEdge(vacated);
    }
    return { moved: true, teleport: false, seed: false, incoming, vacated };
  }

  /**
   * Derived-view assertion (plan §2 "asserted equal"). Compare the grid's
   * resident record to the real bake state; warn loudly with the diff on any
   * divergence. Intended to run on STEADY (no-move) ticks — the async bake
   * window after a crossing has passed, so a still-`unbacked` block LB is a
   * true divergence, not an in-flight transient.
   *
   * S15c post-crossing grace (docs/1123.md §3 known noise): right after a
   * seed/teleport/shift the incoming edge is dispatched but its bake has not
   * landed yet, so it reads `unbacked` for a few hundred ms. Under `graceMs>0`
   * an `unbacked` LB seen within `graceMs` of the last crossing is reclassified
   * as `transientUnbacked` — counted, NOT warned — so a full-battery diag run
   * can gate on "0 non-transient warns". Anything that PERSISTS past the grace
   * (still-unbacked, or any untracked/offBlock which are real bookkeeping bugs,
   * not bake-window transients) stays loud. graceMs defaults to 0 (no grace) so
   * direct/unit callers keep the pre-S15c behavior byte-identically.
   *
   * @param {object} p
   * @param {Set<number>} p.baked        the derived view (terrainBakedLbs)
   * @param {Set<number>|null} [p.inFlight] terrain bakes still in flight
   * @param {number} [p.graceMs=0]  post-crossing grace window (ms); 0 = off
   * @param {number|null} [p.nowMs=null]  clock override (tests); else this.now()
   * @returns {{unbacked:number[], untracked:number[], offBlock:number[], transientUnbacked:number[]}}
   */
  assertResidency({ baked, inFlight = null, graceMs = 0, nowMs = null }) {
    this._stats.assertRuns += 1;
    const block = this.center
      ? computeBlockKeys(this.center.cx, this.center.cy, this.radius, this.lbKeyFromXY)
      : new Set();
    // F8 (2026-08-03): derive the resident set from the SLOT TABLE, not from
    // the `_resident` cache. Both used to be re-derivations of the same block
    // formula that `block` above re-derives a third time, so `untracked` and
    // `offBlock` were provably always empty — this assert could only ever fire
    // on `unbacked`, and a corrupted slot arrangement would sail straight
    // through the check that exists to catch it. `slots` is the state the grid
    // actually indexes with, so validating IT against the geometry (and against
    // the `_resident` cache, below) is a claim that can be false.
    const resident = new Set();
    for (const k of this.slots) if (k !== -1) resident.add(k);
    // Lockstep check: `_resident` is documented as "kept in lockstep with
    // slots". Any future path that mutates one without the other lands here.
    let slotDesync = false;
    if (resident.size !== this._resident.size) slotDesync = true;
    else { for (const k of resident) if (!this._resident.has(k)) { slotDesync = true; break; } }
    // Positional check: slot (r,c) must hold the key its own offset implies.
    // Catches a stale/mis-centred slot table, which a set comparison cannot see.
    const misplaced = [];
    if (this.center) {
      const W = this.width, R = this.radius;
      for (let r = 0; r < W; r += 1) {
        for (let c = 0; c < W; c += 1) {
          const nx = (this.center.cx & 0xff) + (c - R);
          const ny = (this.center.cy & 0xff) + (r - R);
          const want = (inMap(nx) && inMap(ny)) ? (this.lbKeyFromXY(nx, ny) >>> 0) : -1;
          if (this.slots[r * W + c] !== want) misplaced.push({ r, c, got: this.slots[r * W + c], want });
        }
      }
    }
    if (slotDesync || misplaced.length) this._stats.slotDesyncs += 1;
    const raw = diffResidency({ resident, baked, inFlight, block });

    // Grace classification: only `unbacked` is a bake-window transient (an edge
    // whose bake is still catching up). untracked/offBlock are real divergences
    // and are NEVER graced.
    let unbacked = raw.unbacked;
    let transientUnbacked = [];
    const t = (nowMs != null) ? nowMs : this.now();
    const withinGrace = graceMs > 0
      && this._lastCrossingAtMs != null
      && (t - this._lastCrossingAtMs) < graceMs;
    if (withinGrace && unbacked.length) {
      transientUnbacked = unbacked;
      unbacked = [];
      this._stats.transientUnbackedSuppressed += transientUnbacked.length;
      this._stats.graceSuppressedRuns += 1;
    }

    const shiftCheck = this._lastShiftCheck;
    const shiftMismatch = !!(shiftCheck && shiftCheck.copied !== shiftCheck.expectedCopied);
    const diff = {
      unbacked, untracked: raw.untracked, offBlock: raw.offBlock, transientUnbacked,
      // F8 detectors — never graced: these are arithmetic/bookkeeping bugs,
      // not bake-window transients.
      misplacedSlots: misplaced, slotDesync, shiftMismatch,
    };
    if (unbacked.length || diff.untracked.length || diff.offBlock.length
        || misplaced.length || slotDesync || shiftMismatch) {
      this._stats.assertWarns += 1;
      const hex = (arr) => arr.map((k) => `0x${(k >>> 0).toString(16).padStart(8, "0")}`);
      this.warn(
        "[fixedGrid] derived-view divergence: grid resident set ≠ terrainBakedLbs∩block",
        {
          center: this.center ? { ...this.center } : null,
          unbacked: hex(unbacked),                 // persistent past grace — grid claims resident, bake path lacks it
          untracked: hex(diff.untracked),          // baked in-block, grid lost track of it
          offBlock: hex(diff.offBlock),            // grid resident outside its own block
          transientUnbacked: hex(transientUnbacked), // in-grace bake-window LBs (context only, not part of the warn trigger)
          misplacedSlots: misplaced,               // slot (r,c) holds the wrong LB for its own offset
          slotDesync,                              // `_resident` cache no longer matches `slots`
          shiftMismatch: shiftMismatch ? shiftCheck : false, // positional carry-over ≠ set intersection
        },
      );
    }
    return diff;
  }
}

/**
 * S15c — hysteresis-gated whole-LB park scheduler for the fixed-grid VACATED
 * edge (docs/PLAN-fixed-slot-grid-residency-2026-07-11.md §5.4).
 *
 * The plan's release-≠-free tie-in: on an LB crossing the grid's trailing edge
 * is vacated. S15b left `releaseEdge` a no-op (terrain-only scope); S15c routes
 * that exact vacated set to `landblockLru.park(key)` so a whole LB's residency
 * (terrain + buildings + statics + scenery + cells — every layer park() detaches)
 * goes WARM, kept re-adoptable behind the S15a 30 s UseTime floor instead of
 * LRU-reclaimed and re-decoded on return. Pure/injected-deps (no `three`, no
 * `window`, no lru import) so it unit-tests headless.
 *
 * The churn hazard (the session-11 sealedKeepRing park↔unpark storm class): at
 * terrain radius 1 the vacated row sits only ~2 LBs behind the player, so a
 * zig-zag walk that re-crosses a boundary would park-then-immediately-unpark the
 * same row every packet — even though the S15a UseTime floor makes the unpark a
 * cheap pointer re-adopt, park() itself does per-crossing DETACH work. So park
 * is HYSTERESIS-GATED: a vacated key is only parked once it has stayed
 * continuously vacated for `hysteresisMs`. The instant it re-enters the block
 * (the grid's incoming edge → `onResident`) its pending park is cancelled — a
 * zig-zag never issues a park. Committed walk-away parks after the window.
 *
 * Teleport (constraint #3 / plan §2): the grid does NOT fire releaseEdge on a
 * teleport, and the wiring calls `reset()` on teleport/seed so any pre-teleport
 * pending keys are dropped — the whole-grid-invalidate path stays owned by the
 * LRU's evict-on-teleport reclaim, never routed through park.
 */
export class EdgeParkScheduler {
  /**
   * @param {object} deps
   * @param {(lbKey:number)=>boolean} deps.park  whole-LB park; returns true when
   *   parked, false when the key wasn't in the LRU's `entries` (already parked /
   *   evicted) — the false case is counted as parkSkippedInEntriesMiss, not an error.
   * @param {number} [deps.hysteresisMs=2000]  continuous-vacated dwell before a
   *   park is issued. ~one LB crossing's worth; a quick zig-zag re-crosses well
   *   inside it and cancels. 0 = park on the next drain (no hysteresis).
   * @param {()=>number} [deps.now]  monotonic clock (ms); tests inject.
   * @param {(msg:string, detail?:any)=>void} [deps.warn]
   */
  constructor({ park, hysteresisMs = 2000, now, warn } = {}) {
    this.park = typeof park === "function" ? park : () => false;
    this.hysteresisMs = Math.max(0, hysteresisMs | 0);
    this.now = typeof now === "function" ? now : defaultNow;
    this.warn = typeof warn === "function"
      ? warn
      : (m, d) => { try { console.warn(m, d); } catch (_) {} };
    // lb-key → vacatedAtMs (the timestamp it FIRST went vacated; re-observing a
    // still-vacated key does NOT refresh it — dwell is measured from first exit).
    this._pending = new Map();
    this._stats = {
      parksIssued: 0,            // park() returned true
      parkSkippedInEntriesMiss: 0, // park() returned false (not in entries)
      reAdoptCancels: 0,         // pending park cancelled by a re-entering edge (zig-zag saved)
      vacatedObserved: 0,        // distinct keys that entered the pending queue
      drains: 0,
      resets: 0,                 // teleport/seed clears
      maxPending: 0,
    };
  }

  /** The trailing edge went vacated — schedule each key for a hysteresis-gated park. */
  onVacated(keys) {
    if (!keys) return;
    const t = this.now();
    for (const k of keys) {
      const key = k >>> 0;
      if (!this._pending.has(key)) {
        this._pending.set(key, t);
        this._stats.vacatedObserved += 1;
      }
    }
    if (this._pending.size > this._stats.maxPending) this._stats.maxPending = this._pending.size;
  }

  /**
   * A key re-entered the block (the incoming edge) — cancel its pending park.
   * This is the anti-storm guard: a vacated key can only return via the incoming
   * edge, so cancelling on incoming means a zig-zag never parks/unparks.
   */
  onResident(keys) {
    if (!keys) return;
    for (const k of keys) {
      if (this._pending.delete(k >>> 0)) this._stats.reAdoptCancels += 1;
    }
  }

  /**
   * Issue parks for every pending key whose continuous-vacated dwell has reached
   * `hysteresisMs`. Called every position packet (INCLUDING no-move ticks) so a
   * player who walks then stands still still parks the trailing edge once it ages
   * out. Cheap: a bounded map scan.
   * @returns {{parked:number[], skipped:number[]}}
   */
  drain(nowMs = null) {
    this._stats.drains += 1;
    const parked = [];
    const skipped = [];
    if (this._pending.size === 0) return { parked, skipped };
    const t = (nowMs != null) ? nowMs : this.now();
    // Deleting the current key during Map iteration is spec-safe (the iterator
    // continues over the remaining entries).
    for (const [key, at] of this._pending) {
      if (t - at < this.hysteresisMs) continue; // not aged out yet
      let ok = false;
      try { ok = this.park(key) === true; } catch (_) { ok = false; }
      if (ok) { this._stats.parksIssued += 1; parked.push(key); }
      else { this._stats.parkSkippedInEntriesMiss += 1; skipped.push(key); }
      this._pending.delete(key);
    }
    return { parked, skipped };
  }

  /**
   * Drop all pending parks (teleport/seed). Keeps the whole-grid-invalidate path
   * owned by the LRU's evict-on-teleport reclaim (constraint #3): a key vacated
   * during a walk that is then interrupted by a teleport is NOT parked.
   */
  reset() {
    this._stats.resets += 1;
    this._pending.clear();
  }

  getStats() {
    return {
      pending: this._pending.size,
      hysteresisMs: this.hysteresisMs,
      ...this._stats,
    };
  }
}
