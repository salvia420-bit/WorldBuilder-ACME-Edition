// scene3d/fixed_grid.js — S15b (2026-07-11) `?fixedGrid` player-centered
// TERRAIN slot-grid residency DRIVER
// (docs/PLAN-fixed-slot-grid-residency-2026-07-11.md §2, landing order §5.3).
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
   *   teleport (today's behavior: the LRU reclaims the old block).
   * @param {(msg:string, detail?:any)=>void} [deps.warn]
   */
  constructor({ radius, lbKeyFromXY, fetchEdge, releaseEdge, warn } = {}) {
    this.radius = Math.max(1, radius | 0);
    this.width = 2 * this.radius + 1;
    this.lbKeyFromXY = lbKeyFromXY;
    this.fetchEdge = typeof fetchEdge === "function" ? fetchEdge : () => {};
    this.releaseEdge = typeof releaseEdge === "function" ? releaseEdge : () => {};
    this.warn = typeof warn === "function"
      ? warn
      : (m, d) => { try { console.warn(m, d); } catch (_) {} };

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
      lastDx: 0, lastDy: 0,
    };
  }

  /** The grid's resident record (the lb-keys it claims should be resident). */
  get residentKeys() {
    return this._resident;
  }

  getStats() {
    return {
      radius: this.radius,
      width: this.width,
      center: this.center ? { ...this.center } : null,
      resident: this._resident.size,
      ...this._stats,
    };
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
    this.slots = next;
    const resident = new Set();
    for (const k of next) if (k !== -1) resident.add(k);
    this._resident = resident;
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
   * @param {object} p
   * @param {Set<number>} p.baked        the derived view (terrainBakedLbs)
   * @param {Set<number>|null} [p.inFlight] terrain bakes still in flight
   * @returns {{unbacked:number[], untracked:number[], offBlock:number[]}}
   */
  assertResidency({ baked, inFlight = null }) {
    this._stats.assertRuns += 1;
    const block = this.center
      ? computeBlockKeys(this.center.cx, this.center.cy, this.radius, this.lbKeyFromXY)
      : new Set();
    const diff = diffResidency({ resident: this._resident, baked, inFlight, block });
    if (diff.unbacked.length || diff.untracked.length || diff.offBlock.length) {
      this._stats.assertWarns += 1;
      const hex = (arr) => arr.map((k) => `0x${(k >>> 0).toString(16).padStart(8, "0")}`);
      this.warn(
        "[fixedGrid] derived-view divergence: grid resident set ≠ terrainBakedLbs∩block",
        {
          center: this.center ? { ...this.center } : null,
          unbacked: hex(diff.unbacked),   // grid claims resident, bake path doesn't have it
          untracked: hex(diff.untracked), // baked in-block, grid lost track of it
          offBlock: hex(diff.offBlock),   // grid resident outside its own block
        },
      );
    }
    return diff;
  }
}
