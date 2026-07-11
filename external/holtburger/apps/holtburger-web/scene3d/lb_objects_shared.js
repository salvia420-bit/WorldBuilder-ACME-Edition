// scene3d/lb_objects_shared.js — A7-F1 (2026-07-11 s13) shared per-cellId
// LandblockInfo placement cache (docs/1120-appendix.md §1 A7).
//
// The BUG: buildings.js (cold bake) and statics.js (cold bake) EACH issue a
// full `fetch_landblock_objects(new Uint32Array([lbKey|0xfffe]), urgent)` for
// the SAME cellId per cold LB, on the player-blocking urgent lane, with
// separate dedup namespaces — the wasm redoes LandblockInfo::unpack +
// SetupModel::unpack setup-resolution TWICE. Each consumer then keeps only its
// half (buildings: isBuilding; statics: !isBuilding) and frees the wasm
// records.
//
// The FIX: route BOTH consumers through fetchLandblockObjectsShared(). The
// first caller's fetch is shared; its wasm records are drained ONCE into a
// plain-JS snapshot (the superset of fields both consumers read) and freed.
// The cache holds ONLY plain JS data — never wasm handles — so there is no
// lifetime hazard: both consumers read fields off the snapshot and build their
// own filtered records downstream (buildings.js's push, statics.js's
// drainPlacements), neither mutating the shared snapshot.
//
// Boundedness (required): an entry is evicted once BOTH consumers have read it
// (2-read drop — the steady state), with a hard FIFO cap as a safety net for
// the case where only one consumer ever reads a given LB (e.g. an all-2D or
// all-buildings-disabled path). clearForLb()/clear() are exported for the
// eviction flow to call (see index.html __onLandblockEvicted wiring note).
//
// Urgent-lane note: if the two callers disagree on `urgent`, FIRST-CALLER WINS
// — the shared fetch is created with the first caller's lane and the second
// reuses it. Acceptable per the appendix (both fire in the same cold-LB
// crossing; the urgent bypass only matters for the current 3×3, where both are
// urgent anyway).

// Hard cap on distinct in-cache cellIds. The 2-read drop keeps the live set at
// ~1-2 during a cold-LB crossing; this only bounds the pathological "one
// consumer only" path so the map can't grow unbounded across a long session.
export const LB_OBJECTS_SHARED_MAX_ENTRIES = 32;

// key(cellId>>>0) -> { promise: Promise<snapshot[]>, snapshot: snapshot[]|null, reads: number }
const CACHE = new Map();

// Read count at which an entry self-evicts: buildings + statics = 2.
const READS_TO_DROP = 2;

/**
 * Snapshot a wasm ObjectPlacement into a plain-JS record carrying the SUPERSET
 * of fields both consumers read (buildings.js's push + statics.js's
 * drainPlacements). Downstream filtering (isBuilding vs !isBuilding) and any
 * per-consumer reshaping (statics adds scale/objId/source) stay unchanged.
 */
export function snapshotLbPlacement(p) {
  return {
    landblockId: p.landblockId,
    modelId: p.modelId,
    x: p.x,
    y: p.y,
    z: p.z,
    rotationZ: p.rotationZ,
    qw: p.qw,
    qx: p.qx,
    qy: p.qy,
    qz: p.qz,
    isBuilding: !!p.isBuilding,
    defaultScriptId:
      typeof p.defaultScriptId === "number" ? p.defaultScriptId >>> 0 : 0,
    defaultAnimationId:
      typeof p.defaultAnimationId === "number" ? p.defaultAnimationId >>> 0 : 0,
  };
}

/**
 * Fetch (or reuse) the drained LandblockInfo placement snapshot for a cellId.
 * Returns a Promise resolving to a plain-JS array; the SAME array reference is
 * returned to both consumers (they must not mutate it — they don't).
 *
 * @param {object} wasmExports  must expose fetch_landblock_objects
 * @param {number} cellId       XXYYFFFE LandblockInfo cell id
 * @param {boolean} urgent      urgent-lane hint (first caller wins)
 * @returns {Promise<Array<object>>}
 */
export function fetchLandblockObjectsShared(wasmExports, cellId, urgent) {
  const key = cellId >>> 0;
  let entry = CACHE.get(key);
  if (!entry) {
    entry = { promise: null, snapshot: null, reads: 0 };
    entry.promise = Promise.resolve(
      wasmExports.fetch_landblock_objects(new Uint32Array([key]), urgent)
    ).then((placements) => {
      const snap = [];
      for (const p of placements || []) {
        snap.push(snapshotLbPlacement(p));
        // Drain the wasm handle once, here — neither consumer sees a live
        // wasm record anymore (their p.free() guards become harmless no-ops
        // on the plain snapshot records).
        if (p && typeof p.free === "function") {
          try { p.free(); } catch (_) { /* already-freed */ }
        }
      }
      entry.snapshot = snap;
      return snap;
    }).catch((err) => {
      // A rejected fetch must NOT stick: reads only count on success, so a
      // cached rejection would poison this LB for both consumers and defeat
      // the statics/buildings starved-retry (streamFix pairing). Drop the
      // entry so the next attempt re-fetches; both current awaiters still
      // see the rejection (matching the pre-A7 per-caller failure).
      if (CACHE.get(key) === entry) CACHE.delete(key);
      throw err;
    });
    CACHE.set(key, entry);
    // Hard FIFO cap (safety net only; the 2-read drop is the normal path).
    // Evict the oldest OTHER entry so we never exceed the cap.
    if (CACHE.size > LB_OBJECTS_SHARED_MAX_ENTRIES) {
      for (const oldest of CACHE.keys()) {
        if (oldest !== key) { CACHE.delete(oldest); break; }
      }
    }
  }
  // Await the shared in-flight (or already-resolved) promise, THEN count this
  // read. Two reads (buildings + statics) drop the entry so it can't linger.
  const p = entry.promise;
  return p.then((snap) => {
    entry.reads += 1;
    if (entry.reads >= READS_TO_DROP && CACHE.get(key) === entry) {
      CACHE.delete(key);
    }
    return snap;
  });
}

/**
 * Drop the cached entry for a landblock (accepts a full landblockId, an lbKey,
 * or the XXYYFFFE cellId — the low 16 bits are masked to 0xFFFE). Safe to call
 * for an LB that was never cached. Exported for the eviction flow.
 */
export function clearForLb(landblockIdOrKey) {
  const cellId = (((landblockIdOrKey >>> 16) << 16) | 0xfffe) >>> 0;
  CACHE.delete(cellId);
}

/** Drop the whole cache (e.g. on init_resource_source / hard reset). */
export function clear() {
  CACHE.clear();
}

/** Test/diag hook — current number of cached cellIds. */
export function _cacheSize() {
  return CACHE.size;
}
