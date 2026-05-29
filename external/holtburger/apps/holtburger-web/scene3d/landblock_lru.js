// Landblock LRU — bounds the resident set of baked landblocks.
//
// Today (pre-LRU) the 13×13 spawn ring + every LB the player has ever
// walked into stays resident forever. Each LB owns:
//   - 1 terrain mesh (per-LB ShaderMaterial + per-LB BufferGeometry +
//     per-LB vertexTypesTex DataTexture)
//   - N building placement Groups (each Group's meshes share materials
//     via MaterialCache — those are NOT per-LB and must NOT be
//     disposed at LB eviction)
//   - N statics singleton Mesh/LOD nodes (same MaterialCache caveat)
//   - N EnvCell containers (one per cellId; LB owns all cells whose
//     cellId & 0xffff_0000 === lbKey)
//
// Cross-LB shared resources (NEVER touched here):
//   - statics InstancedMesh (one InstancedMesh per modelId batches
//     placements across the ENTIRE ring; no per-LB userData tag)
//   - MaterialCache surfaces (per-DID, shared across all LBs)
//   - terrain atlas / road texture (once-per-ring opts)
//   - building bake cache (`buildingBakeCache` Map)
//
// The LRU evicts containers + their PER-LB geometry/material/texture
// disposables. Cross-LB shares stay live. Re-entry to an evicted LB
// re-bakes via the existing lazy hooks (`loadTerrainForLandblock`
// etc.) — the bake's idempotency Sets are cleared on eviction so the
// re-entry actually re-runs the bake.

const LB_KEY_MASK = 0xffff_0000 >>> 0;

function lbKeyFromXY(lbX, lbY) {
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
}

function lbKeyOf(landblockIdOrLbKey) {
  return (landblockIdOrLbKey & LB_KEY_MASK) >>> 0;
}

// 3×3 ring around a given lb-key (the player's current LB + 8
// neighbours). Wraps at world edges — out-of-range neighbours are
// dropped, never wrap to the other side of the world.
function ringKeysAround(lbKey) {
  const cx = (lbKey >>> 24) & 0xff;
  const cy = (lbKey >>> 16) & 0xff;
  const out = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
      out.push(lbKeyFromXY(nx, ny));
    }
  }
  return out;
}

// Chebyshev distance in LB units (max of |dx|, |dy|) between two
// packed lb-keys. Used as the "always-resident" floor: 0 == same LB,
// 1 == 3×3 ring around player.
function lbChebyshev(a, b) {
  const ax = (a >>> 24) & 0xff;
  const ay = (a >>> 16) & 0xff;
  const bx = (b >>> 24) & 0xff;
  const by = (b >>> 16) & 0xff;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export class LandblockLRU {
  constructor({ scene3d, maxResident, getCurrentLbId, onEvictLandblock = null, debug = false } = {}) {
    if (!scene3d) throw new Error("LandblockLRU: scene3d required");
    this.scene3d = scene3d;
    // Phase 6 collision-leak fix (2026-05-29): optional hook fired in evict()
    // to purge the evicted LB's wasm-side SpatialScene collision (see evict()).
    this._onEvictLandblock = typeof onEvictLandblock === "function" ? onEvictLandblock : null;
    // No clamp: the 3×3 always-resident ring is enforced inside
    // tickEviction's candidate filter (Chebyshev distance ≤ 1 skipped),
    // so `?lbCap=1` still keeps the 9-LB floor cleanly.
    this.maxResident = Math.max(1, maxResident | 0);
    this.getCurrentLbId = typeof getCurrentLbId === "function"
      ? getCurrentLbId
      : () => null;
    this.debug = !!debug;

    // Map<lbKey, { lastTouchMs: number, disposables: { geometries:[],
    //   materials:[], textures:[] } }>
    this.entries = new Map();

    this._evictedTotal = 0;
    this._lastEvictedLbKey = null;
  }

  // Register an LB as resident. Idempotent — re-tracking the same lbKey
  // refreshes its disposable list (subsequent bakes that produced new
  // resources can extend the tracked refs).
  track(lbKey, options = {}) {
    const key = lbKeyOf(lbKey >>> 0);
    const now = (typeof performance !== "undefined")
      ? performance.now()
      : Date.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        lastTouchMs: now,
        disposables: { geometries: [], materials: [], textures: [] },
      };
      this.entries.set(key, entry);
    } else {
      entry.lastTouchMs = now;
    }
    if (Array.isArray(options.geometries)) {
      for (const g of options.geometries) if (g) entry.disposables.geometries.push(g);
    }
    if (Array.isArray(options.materials)) {
      for (const m of options.materials) if (m) entry.disposables.materials.push(m);
    }
    if (Array.isArray(options.textures)) {
      for (const t of options.textures) if (t) entry.disposables.textures.push(t);
    }
  }

  touch(lbKey) {
    const key = lbKeyOf(lbKey >>> 0);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastTouchMs = (typeof performance !== "undefined")
      ? performance.now()
      : Date.now();
  }

  // Per-frame eviction tick. Touches the player's LB + 3×3 ring (the
  // always-resident floor), then evicts the oldest entries beyond
  // `maxResident` until the resident count is ≤ maxResident.
  tickEviction(currentLbKeyArg) {
    const currentLbKey = currentLbKeyArg != null
      ? lbKeyOf(currentLbKeyArg >>> 0)
      : null;

    // Refresh the always-resident floor's timestamps so they're never
    // candidates for eviction even under adversarial maxResident < 9.
    if (currentLbKey != null) {
      this.touch(currentLbKey);
      for (const k of ringKeysAround(currentLbKey)) this.touch(k);
    }

    if (this.entries.size <= this.maxResident) return;

    // Collect eviction candidates: every tracked LB OUTSIDE the 3×3
    // always-resident ring (`lbChebyshev(currentLbKey, key) > 1`).
    // Sort ascending by lastTouchMs → oldest evicted first.
    const candidates = [];
    for (const [key, entry] of this.entries) {
      if (currentLbKey != null && lbChebyshev(currentLbKey, key) <= 1) continue;
      candidates.push({ key, ts: entry.lastTouchMs });
    }
    candidates.sort((a, b) => a.ts - b.ts);

    let toEvict = this.entries.size - this.maxResident;
    for (const c of candidates) {
      if (toEvict <= 0) break;
      this.evict(c.key);
      toEvict -= 1;
    }
  }

  // Remove the LB's containers from the scene + dispose the per-LB
  // resources we own. Cross-LB shares (MaterialCache surfaces, statics
  // InstancedMesh, terrain atlas / road texture) are NEVER touched.
  evict(lbKeyArg) {
    const lbKey = lbKeyOf(lbKeyArg >>> 0);
    const entry = this.entries.get(lbKey);
    if (!entry) return false;

    const s = this.scene3d;
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;

    // 1. Terrain — every child of terrainGroup whose userData.lbX/lbY
    //    matches. Wire-fill companion meshes (userData.lbX/lbY also
    //    set) are caught by the same filter.
    if (s.terrainGroup?.children) {
      const kill = [];
      for (const c of s.terrainGroup.children) {
        const ud = c.userData;
        if (!ud) continue;
        if (ud.lbX === lbX && ud.lbY === lbY) kill.push(c);
      }
      for (const c of kill) s.terrainGroup.remove(c);
    }

    // 2. Buildings — per-placement Groups with userData.landblockId
    //    (full 32-bit; mask to lb-key). Each Group's child Meshes
    //    reference cached materials/geometries — DO NOT dispose those.
    if (s.buildingsGroup?.children) {
      const kill = [];
      for (const c of s.buildingsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb == null) continue;
        if (lbKeyOf(lb >>> 0) === lbKey) kill.push(c);
      }
      for (const c of kill) s.buildingsGroup.remove(c);
      if (s.buildingMap3d instanceof Map) {
        for (const c of kill) {
          const k = c.userData?.placementKey;
          if (k) s.buildingMap3d.delete(k);
        }
      }
    }

    // 3. Statics — singletons (Mesh / LOD) carry userData.landblockId.
    //    InstancedMesh nodes have NO landblockId (they batch across all
    //    LBs in the ring) and are intentionally skipped.
    if (s.staticsGroup?.children) {
      const kill = [];
      for (const c of s.staticsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb == null) continue;
        if (lbKeyOf(lb >>> 0) === lbKey) kill.push(c);
      }
      for (const c of kill) s.staticsGroup.remove(c);
    }

    // 4. EnvCells — cellContainers3d is keyed by full cellId. Remove
    //    every container whose cellId & 0xffff_0000 === lbKey.
    if (s.cellContainers3d instanceof Map && s.cellsGroup) {
      const killIds = [];
      for (const [cellId, container] of s.cellContainers3d) {
        if (lbKeyOf(cellId >>> 0) === lbKey) {
          killIds.push(cellId);
          s.cellsGroup.remove(container);
        }
      }
      for (const id of killIds) s.cellContainers3d.delete(id);
    }

    // 5. Dispose per-LB owned resources. Skip anything tagged
    //    `__cacheOwned` (shared MaterialCache surfaces) defensively
    //    even though track() callers shouldn't be passing those in.
    for (const g of entry.disposables.geometries) {
      try { g?.dispose && g.dispose(); } catch (_) {}
    }
    for (const m of entry.disposables.materials) {
      if (!m) continue;
      if (m.userData?.__cacheOwned === true) continue;
      try { m.dispose && m.dispose(); } catch (_) {}
    }
    for (const t of entry.disposables.textures) {
      if (!t) continue;
      if (t.userData?.__cacheOwned === true) continue;
      try { t.dispose && t.dispose(); } catch (_) {}
    }

    // 6. Clear idempotency sets so a re-entry actually re-bakes.
    //    Without this, the lazy hooks would short-circuit and leave
    //    the LB visually empty until a hard reload.
    if (s.terrainBakedLbs instanceof Set) s.terrainBakedLbs.delete(lbKey);
    if (s.buildingsBakedLbs instanceof Set) s.buildingsBakedLbs.delete(lbKey);
    if (s.staticsBakedLbs instanceof Set) s.staticsBakedLbs.delete(lbKey);
    if (s.envCellLoadedLbs instanceof Set) s.envCellLoadedLbs.delete(lbKey);

    // 7. Also drop the per-LB ShaderMaterial entry off scene3d's
    //    terrainMaterials registry (the per-rAF uTime push iterates
    //    this; a stale dispose'd entry would still receive a push
    //    until the next bake replaces it).
    if (Array.isArray(s.terrainMaterials) && entry.disposables.materials.length > 0) {
      const dropped = new Set(entry.disposables.materials);
      s.terrainMaterials = s.terrainMaterials.filter((m) => !dropped.has(m));
    }

    // Phase 6 collision-leak fix (2026-05-29): the THREE.js render objects are
    // gone, but the wasm SpatialScene's per-LB collision (cell + building
    // AABBs + physics triangles + portal graph + building origins) must be
    // purged too — `insert_cell_triangle` / `insert_building_aabb` are
    // append-only, so without this a later re-entry re-bake APPENDS duplicates
    // and the indices grow unbounded on every LB re-load.
    if (this._onEvictLandblock) {
      try { this._onEvictLandblock(lbKey); } catch (_) { /* fail-soft */ }
    }

    this.entries.delete(lbKey);
    this._evictedTotal += 1;
    this._lastEvictedLbKey = lbKey;

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[lbLru/evict] id=0x${lbKey.toString(16).padStart(8, "0")} ` +
        `resident=${this.entries.size} totalEvicted=${this._evictedTotal}`
      );
    }
    // Wave 3 / A6 instrumentation (2026-05-28) — investigation-first for
    // the R2 hypothesis (Three.js internal program cache may retain
    // compiled programs of disposed materials). Records a snapshot of
    // renderer.info.{programs,memory.{geometries,textures}} keyed by
    // the just-evicted LB so operators can trend program count vs
    // eviction count over a long traversal session. Ring-buffered to
    // 200 entries; lazy-initialised on first call so the namespace
    // doesn't exist until something has been evicted.
    this._recordProgramSnapshot(lbKey);
    return true;
  }

  /**
   * Snapshot the WebGLRenderer's program cache + memory counters to
   * `window.__diag.renderer.evictionProgramSnapshots` (ring buffer cap
   * 200). Detached from `evict` to keep the hot eviction path readable;
   * any throw inside is swallowed so a diag failure can't kill an LB
   * eviction.
   */
  _recordProgramSnapshot(lbKey) {
    if (typeof window === "undefined") return;
    try {
      const renderer = this.scene3d?.renderer;
      if (!renderer || !renderer.info) return;
      const programCount = Array.isArray(renderer.info.programs)
        ? renderer.info.programs.length
        : 0;
      if (!window.__diag) window.__diag = {};
      if (!window.__diag.renderer) {
        window.__diag.renderer = {
          evictionProgramSnapshots: [],
          maxSnapshots: 200,
          peakPrograms: 0,
          lastPrograms: 0,
        };
      }
      const d = window.__diag.renderer;
      d.lastPrograms = programCount;
      if (programCount > d.peakPrograms) d.peakPrograms = programCount;
      d.evictionProgramSnapshots.push({
        ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
        lbKey: lbKey >>> 0,
        programs: programCount,
        geometries: renderer.info.memory?.geometries ?? 0,
        textures: renderer.info.memory?.textures ?? 0,
        residentLbs: this.entries.size,
        evictionsTotal: this._evictedTotal,
      });
      while (d.evictionProgramSnapshots.length > d.maxSnapshots) {
        d.evictionProgramSnapshots.shift();
      }
    } catch (_) {
      // Never let a diag throw kill an eviction.
    }
  }

  dispose() {
    const keys = [...this.entries.keys()];
    for (const k of keys) this.evict(k);
  }

  getStats() {
    return {
      resident: this.entries.size,
      evicted: this._evictedTotal,
      lastEvictedLbId: this._lastEvictedLbKey,
      maxResident: this.maxResident,
    };
  }
}

// Helper exported for callers that need the same lb-key shape used
// internally (e.g. the bake site converting (lbX, lbY) → lbKey for
// `track`).
export { lbKeyFromXY, lbKeyOf };
