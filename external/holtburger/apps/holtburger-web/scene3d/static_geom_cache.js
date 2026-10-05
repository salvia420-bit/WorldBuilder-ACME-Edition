// scene3d/static_geom_cache.js — ?statGeomCache: ONE geometry per static model,
// shared by every landblock that places it (perf T3, GPU half; OpenAC
// comparison 2026-10-04, `Wb/ObjectMeshManager.cs` refcount + unowned LRU).
//
// WHAT IT REPLACES. `bakeStaticsForLandblock` decodes every model an LB places
// into BufferGeometries that THAT LB owns (`lbDisposableGeometries`), even when
// the neighbouring LB already holds the identical triangles. Each bake pays the
// worker round trip, the wasm pack and copy-out, `meshToGeometryGroups`, the
// degrade-chain lookups and band clones, and — for every node that is drawn
// as itself rather than copied into a batch — a GPU upload of a buffer that
// already exists. Measured on a 14-LB SwiftShader tour (2026-10-04 census,
// docs/openac-comparison-2026-10-04/5-perf.md T3): model-tagged statics
// geometries ran 2.1-2.3x their distinct content, and the per-LB source
// geometries that batching had already copied were held for the LB's lifetime.
//
// WHY ONE GEOMETRY PER MODEL IS CORRECT. A statics geometry is a pure function
// of its model id: `fetch_model_meshes` takes only ids and routes to the
// substitution-free triangulation (memoised by model id in Rust for exactly
// that reason), `meshToGeometryGroups` has no per-LB input, and no consumer
// mutates a statics geometry in place (the atlas clones before normalising;
// ?statArrayMerge's `aLayer` is added and removed synchronously). That is the
// same argument `?statGeomDedup` makes for its content key, made one level up.
//
// OWNERSHIP — THE ONE RULE. An entry's geometries belong to THIS module and are
// tagged `userData.__cacheOwned = true`. Nothing else may dispose them:
//   - the LRU's disposables loops already skip `__cacheOwned` (evict step 5,
//     `_discardStalePoolCopy`), so cached geometries are simply never listed;
//   - the atlas disposes a consumed singleton's SOURCE geometry after copying
//     it, and the bake's two eviction-during-build guards dispose the groups
//     they built; all three check the tag (statics.js / static_atlas.js).
// An LB holds a LEASE (model id -> count) instead of the geometries. Park keeps
// the lease (the parked nodes still reference the geometry); a true evict —
// including `disposeParked`, which routes through evict — releases it via the
// `_releaseStaticGeomForLb` facade. An entry whose last lease goes is NOT freed:
// it moves to the unowned LRU, so the next LB that places the model gets it
// with no decode and no upload. It is disposed only when the unowned set is
// over its byte budget, or when the live-geometry governor is engaged (an
// unowned entry is the cheapest geometry in the scene to give back — nobody is
// drawing it), oldest release first, a bounded number per call.
//
// WHAT IS NEVER CACHED. A decode with record misses (`decodeMisses > 0`) — it
// may be partial, and the starved-retry machinery must see it again. Anything
// the caller did not insert (bundle-served groups under ?geomBundles keep their
// legacy per-LB ownership).
//
// DEFAULT-OFF, exact-match opt-in: `?statGeomCache=on` or `=on:<MB>` (unowned
// budget, 1..1024, default 64). Off = this module is never constructed and the
// bake is byte-identical.
//
// THREE-ONLY LEAF (no imports): the headless test loads it as-is.

let _mode;
let _budgetMb = 64;

/** `?statGeomCache=on[:<MB>]`. Anything else (absent, `1`, `true`) is OFF. */
export function statGeomCacheEnabled() {
  if (_mode !== undefined) return _mode;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const raw = (new URLSearchParams(globalThis.location.search).get("statGeomCache") || "").toLowerCase();
      const parts = raw.split(":");
      if (parts[0] === "on") {
        on = true;
        if (parts.length > 1) {
          const mb = Number(parts[1]);
          if (Number.isFinite(mb) && mb >= 1 && mb <= 1024) _budgetMb = mb;
        }
      }
    }
  } catch (_) { on = false; }
  _mode = on;
  return on;
}
/** Test seam. `undefined` re-reads the URL. */
export function __setStatGeomCacheForTest(on, budgetMb) {
  _mode = on;
  if (Number.isFinite(budgetMb)) _budgetMb = budgetMb;
}
export function statGeomCacheBudgetMb() { return _budgetMb; }

/** Most entries one trim call may dispose (bounded work per frame). */
const TRIM_PER_CALL = 24;

function _geomBytes(g) {
  if (!g || !g.attributes) return 0;
  let b = 0;
  for (const k in g.attributes) b += g.attributes[k]?.array?.byteLength || 0;
  if (g.index && g.index.array) b += g.index.array.byteLength;
  return b;
}

function _tag(g) {
  if (!g) return;
  g.userData = g.userData || {};
  g.userData.__cacheOwned = true;
  g.userData.__staticGeomCache = true;
}

/** Every geometry an entry owns: full groups + every degrade band level. */
function _entryGeoms(e) {
  const out = [];
  for (const grp of e.groups) if (grp && grp.geometry) out.push(grp.geometry);
  if (e.degraded) {
    for (const levels of e.degraded.values()) {
      for (const lvl of levels) if (lvl && lvl.geometry) out.push(lvl.geometry);
    }
  }
  return out;
}

export class StaticGeomCache {
  constructor({ budgetBytes = 64 * 1024 * 1024 } = {}) {
    this.budgetBytes = budgetBytes;
    /** modelId -> entry */
    this.entries = new Map();
    /** lbKey -> Map<modelId, count> */
    this.leases = new Map();
    /** modelId -> entry, refs === 0, insertion order = release order (oldest first) */
    this.unowned = new Map();
    this.unownedBytes = 0;
    this.bytes = 0;
    this.stats = {
      hits: 0, misses: 0, inserts: 0, emptyInserts: 0, degradedSets: 0,
      acquires: 0, releases: 0, lbReleases: 0,
      trimmedBudget: 0, trimmedPressure: 0, trimmedBytes: 0,
      disposeErrors: 0,
    };
  }

  /**
   * The cached decode for `modelId`, or null. A hit is not a lease; call
   * `acquire` for every model a bake keeps.
   */
  lookup(modelId) {
    const e = this.entries.get(modelId >>> 0);
    if (e) this.stats.hits += 1; else this.stats.misses += 1;
    return e || null;
  }

  /**
   * Take ownership of a COMPLETE decode. `groups` is `meshToGeometryGroups`'
   * output ({geometry, surfaceDid, doubleSided, ...}[]); an empty array records
   * a genuinely empty (physics-only) model so it is not refetched either.
   * Returns the entry (the existing one if `modelId` was already inserted — the
   * caller then owns, and must dispose, the geometries it passed).
   */
  insert(modelId, { groups = [], surfaceDids = [], didDegrade = 0 } = {}) {
    const id = modelId >>> 0;
    const prior = this.entries.get(id);
    if (prior) return prior;
    const e = {
      modelId: id,
      groups,
      surfaceDids: Array.from(surfaceDids, (d) => d >>> 0),
      didDegrade: didDegrade >>> 0,
      // null = the degrade chain has not been resolved yet; a Map (possibly
      // empty) = resolved. Distinguishes "no LOD" from "not asked".
      degraded: didDegrade >>> 0 ? null : new Map(),
      refs: 0,
      bytes: 0,
    };
    for (const g of e.groups) _tag(g && g.geometry);
    for (const g of e.groups) e.bytes += _geomBytes(g && g.geometry);
    this.entries.set(id, e);
    this.bytes += e.bytes;
    // A fresh entry has no lease yet: it starts unowned and is protected only
    // by the caller acquiring it in the same synchronous step.
    this.unowned.set(id, e);
    this.unownedBytes += e.bytes;
    if (e.groups.length === 0) this.stats.emptyInserts += 1; else this.stats.inserts += 1;
    return e;
  }

  /**
   * Attach the resolved degrade chain (`Map<surfaceKey, level[]>`, possibly
   * empty). First writer wins; returns false (caller keeps ownership of
   * `levelsBySurface`) when the entry is gone or already resolved.
   */
  setDegraded(modelId, levelsBySurface) {
    const e = this.entries.get(modelId >>> 0);
    if (!e || e.degraded !== null) return false;
    const m = levelsBySurface instanceof Map ? levelsBySurface : new Map();
    let add = 0;
    for (const levels of m.values()) {
      for (const lvl of levels) { _tag(lvl && lvl.geometry); add += _geomBytes(lvl && lvl.geometry); }
    }
    e.degraded = m;
    e.bytes += add;
    this.bytes += add;
    if (e.refs === 0) this.unownedBytes += add;
    this.stats.degradedSets += 1;
    return true;
  }

  /** `lbKey` keeps `modelId` alive until `releaseLb(lbKey)`. */
  acquire(lbKey, modelId) {
    const id = modelId >>> 0;
    const e = this.entries.get(id);
    if (!e) return false;
    const key = lbKey >>> 0;
    let lease = this.leases.get(key);
    if (!lease) { lease = new Map(); this.leases.set(key, lease); }
    lease.set(id, (lease.get(id) || 0) + 1);
    if (e.refs === 0) {
      this.unowned.delete(id);
      this.unownedBytes -= e.bytes;
    }
    e.refs += 1;
    this.stats.acquires += 1;
    return true;
  }

  /** Release every lease `lbKey` holds. Returns the number of model refs dropped. */
  releaseLb(lbKey) {
    const key = lbKey >>> 0;
    const lease = this.leases.get(key);
    if (!lease) return 0;
    this.leases.delete(key);
    let n = 0;
    for (const [id, count] of lease) {
      const e = this.entries.get(id);
      if (!e) continue;
      e.refs -= count;
      n += count;
      if (e.refs <= 0) {
        e.refs = 0;
        // Re-insert at the tail: unowned order is release order.
        this.unowned.delete(id);
        this.unowned.set(id, e);
        this.unownedBytes += e.bytes;
      }
    }
    this.stats.releases += n;
    this.stats.lbReleases += 1;
    return n;
  }

  /**
   * Undo ONE `acquire(lbKey, modelId)` — for a bake that took leases and then
   * aborted. Unlike `releaseLb` it leaves any lease an earlier bake of the same
   * LB holds untouched.
   */
  release(lbKey, modelId) {
    const key = lbKey >>> 0;
    const id = modelId >>> 0;
    const lease = this.leases.get(key);
    const have = lease ? lease.get(id) || 0 : 0;
    if (have <= 0) return false;
    if (have === 1) lease.delete(id); else lease.set(id, have - 1);
    if (lease.size === 0) this.leases.delete(key);
    const e = this.entries.get(id);
    if (e) {
      e.refs -= 1;
      if (e.refs <= 0) {
        e.refs = 0;
        this.unowned.delete(id);
        this.unowned.set(id, e);
        this.unownedBytes += e.bytes;
      }
    }
    this.stats.releases += 1;
    return true;
  }

  hasLease(lbKey) { return this.leases.has(lbKey >>> 0); }

  _disposeEntry(e) {
    for (const g of _entryGeoms(e)) {
      try {
        // The tag is what kept every other path's hands off; clear it so a
        // stray later reference is an ordinary geometry again.
        if (g.userData) { g.userData.__cacheOwned = false; g.userData.__staticGeomCache = false; }
        g.dispose();
      } catch (_) { this.stats.disposeErrors += 1; }
    }
    this.entries.delete(e.modelId);
    this.unowned.delete(e.modelId);
    this.bytes -= e.bytes;
    this.unownedBytes -= e.bytes;
    this.stats.trimmedBytes += e.bytes;
  }

  /**
   * Dispose unowned entries, oldest release first, at most TRIM_PER_CALL per
   * call. `pressure` = the live-geometry governor is engaged: shed regardless
   * of the byte budget. Otherwise shed only down to the budget. Returns the
   * number of entries disposed.
   */
  trim({ pressure = false } = {}) {
    let n = 0;
    for (const e of this.unowned.values()) {
      if (n >= TRIM_PER_CALL) break;
      if (!pressure && this.unownedBytes <= this.budgetBytes) break;
      if (e.refs !== 0) { this.unowned.delete(e.modelId); continue; } // defensive
      this._disposeEntry(e);
      n += 1;
      if (pressure) this.stats.trimmedPressure += 1; else this.stats.trimmedBudget += 1;
    }
    return n;
  }

  /** Dispose everything (session teardown). Leases are dropped with it. */
  clear() {
    for (const e of [...this.entries.values()]) {
      e.refs = 0;
      if (!this.unowned.has(e.modelId)) { this.unowned.set(e.modelId, e); this.unownedBytes += e.bytes; }
      this._disposeEntry(e);
    }
    this.leases.clear();
    this.unowned.clear();
    this.unownedBytes = 0;
    this.bytes = 0;
  }

  getStats() {
    let geoms = 0;
    for (const e of this.entries.values()) geoms += _entryGeoms(e).length;
    return {
      entries: this.entries.size,
      geometries: geoms,
      bytes: this.bytes,
      unowned: this.unowned.size,
      unownedBytes: this.unownedBytes,
      budgetBytes: this.budgetBytes,
      leasedLbs: this.leases.size,
      ...this.stats,
    };
  }
}

let _instance = null;
/** The session cache, or null when the flag is off. */
export function getStaticGeomCache() {
  if (!statGeomCacheEnabled()) return null;
  if (!_instance) _instance = new StaticGeomCache({ budgetBytes: _budgetMb * 1024 * 1024 });
  return _instance;
}
/** Test seam: drop the singleton (does not dispose). */
export function __resetStaticGeomCacheForTest() { _instance = null; }
