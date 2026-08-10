// scene3d/pool_registry.js — persistent (world-sector × material-class) draw
// pools (ST9 / T22; SPEC §1.5, pass-07 D-07.1/D-07.4/D-07.5/D-07.7/S1/S2/S5).
//
// WHAT THIS IS
// ------------
// A pool is ONE `THREE.BatchedMesh` holding every resident placement of one
// material CLASS (`pool_class_key.js`) within one world-SECTOR (2×2 tiles =
// 4×4 LBs = 768 m, world-absolute lattice — so a pass-6 anchor shift never
// re-homes an instance). Pools are created on first member, persist across
// all residency churn, and are reaped when empty.
//
// This module is the ONLY writer of pool membership (pass-07 S1), and every
// mutation it performs is triggered by a residency/PVS/LOD EVENT — never by
// the camera and never by "the frame ticked". `census().events
// .mutationsThisFrame` exists to make violations of that law visible; a
// settled parked frame must read 0 (S2's anti-churn invariant, a CI gate).
//
// THE THREE EARLY-OUT (D-07.4) — why the properties below are load-bearing
// ------------------------------------------------------------------------
// r184's `BatchedMesh.onBeforeRender` opens with
//   `if (!this._visibilityChanged && !this.perObjectFrustumCulled &&
//        !this.sortObjects) return;`
// so an OPAQUE pool that sets `perObjectFrustumCulled = false` +
// `sortObjects = false` performs ZERO per-instance work on every frame in
// which its membership/visibility did not change — for EVERY camera, CSM
// shadow cascades included. That is the structural removal of the measured
// 5.72 ms multidraw-rebuild term (80% per-instance over ~13k instances), and
// unlike `?statBatchMemo` it is camera-independent, so the ultra/4-camera
// thrash case is covered by construction. Node-level culling is kept
// (`frustumCulled = true`, sector-bounded geometry).
//
// v1 PASS STRUCTURE (D-07.3, SPEC §1.5): pools are OPAQUE-only for the
// early-out. Additive and translucent pools keep TODAY'S sorted-bucket
// semantics exactly (`sortObjects = true`, `perObjectFrustumCulled = true`)
// at sector partition — blend behaviour is bit-identical by construction and
// no eye-test is owed for v1 pass structure. `?poolAdditiveNoSort` is
// RESERVED behind an eye-gate and is not built here (the ClipMap eye-test
// failure is the cautionary tale: widening pass membership by predicate is
// invisible to every harness metric).
//
// LOAD-BEARING DEPENDENCY (F-11.18 / R-11): `three_batchedmesh_colortexture_fix
// .js` must be applied BEFORE any pool is constructed — without it, r184 reads
// `object.colorTexture` (BatchedMesh has `_colorsTexture`) and re-derives the
// program for every BatchedMesh every frame (−3.35 ms renderCPU when fixed).
// At pool scale that is per-pool-per-frame. `poolFor()` verifies the fix on
// the prototype and refuses silence: the first miss is a loud console.error
// and `census().fix.applied` reads false for the rest of the session.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT OWN
// ------------------------------------------
//   * class MATERIALS — injected via `materialFactory(classKey, member)`, so
//     the MaterialCache class tier is a separate seam (and the registry is
//     node-testable with no three material machinery);
//   * GEOMETRY decode — injected via a `geometrySource` with
//     `get(contentKey)`; HBG1 bundles (T13) are the production source;
//   * WHEN work runs — the FrameWorkScheduler owns that (P4/W3/W4); this
//     module exposes chunkable jobs and never schedules itself;
//   * terrain and animated scenery — charter I5-kept on their landed shapes;
//   * entities — charter-excluded (27 draws at 12.7 µs is not the cost).

import {
  classKeyOf, passClassOf, poolNodeName, isPooledDomain,
} from "./pool_class_key.js";

// ---------------------------------------------------------------------------
// flag + prerequisite chain (F-11.3)
// ---------------------------------------------------------------------------

/**
 * `?drawPools` — DEV opt-in, **DEFAULT OFF** (SPEC §0.1 lifecycle). Only
 * `on`/`1`/`true`/`yes` read ON; absent, empty, `off`, `0`, garbage ⇒ OFF.
 * Not memoised (the singleton below memoises once, as the house pattern does).
 */
export function drawPoolsEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("drawPools");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

/** The F-11.3 prerequisite set, in SPEC §3 T22's order. */
export const DRAW_POOLS_PREREQS = Object.freeze([
  "slotGrid", "packSource", "geomBundles", "texCompressedOnly",
]);

/**
 * F-11.3 chain check. `?drawPools` requires `?slotGrid` + `?packSource` +
 * `?geomBundles` + `?texCompressedOnly` (pools consume grid events, pack
 * records, baked geometry and the compressed texture tier — there is no
 * adapter for any of them and none is built). `?frameWork` is additionally
 * required for scheduler stages B/C and is reported separately: stage-A
 * pools (feed on the caller's own cadence) are legal without it.
 *
 * Returns `{armed, reasons, frameWork}`; NEVER throws. A refusal is LOUD —
 * the kill path is "the flag did nothing", not "the flag half-worked".
 *
 * @param {string} [search] query string (defaults to window.location.search)
 * @param {(name:string, search?:string)=>boolean} [readerFor] injectable
 *   per-flag reader (tests); defaults to the exact-match house grammar.
 */
export function checkDrawPoolsPrereqs(search, readerFor) {
  const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
  const read = readerFor || ((name) => {
    try {
      const v = new URLSearchParams(s).get(name);
      if (v == null) return false;
      const t = String(v).toLowerCase();
      return t === "on" || t === "1" || t === "true" || t === "yes";
    } catch (_) {
      return false;
    }
  });
  const reasons = [];
  if (!drawPoolsEnabled(s)) reasons.push("?drawPools is not on");
  for (const flag of DRAW_POOLS_PREREQS) {
    if (!read(flag, s)) reasons.push(`?drawPools requires ?${flag}=on (SPEC F-11.3)`);
  }
  return { armed: reasons.length === 0, reasons, frameWork: read("frameWork", s) };
}

// ---------------------------------------------------------------------------
// sizing ([A] — pass-07 S5.1's anchors, re-classed by the first soak)
// ---------------------------------------------------------------------------

/** Initial pool capacities (static_batch_x's proven `_INIT` shape). */
export const POOL_INIT_INSTANCES = 256;
export const POOL_INIT_VERTS = 16_384;
/** Dead-extent fraction that makes `optimize()` worth its compaction. */
export const POOL_OPTIMIZE_FRAC = 0.30;
/** Bytes per vertex of the pass-4 indexed layout (pos f32×3, normal snorm8×3
 *  +pad, uv f32×2) — the M6 `allocatedBytes` denominator. */
export const POOL_VERTEX_BYTES = 24;
/** Bytes per u16 index. */
export const POOL_INDEX_BYTES = 2;

// ---------------------------------------------------------------------------
// membership record (pass-07 S1 — the ONLY retained per-tile scene bookkeeping)
// ---------------------------------------------------------------------------

function makeMembership(pool) {
  return {
    pool,
    instanceIds: [],       // u32[] — this tile's instances in this pool
    gidRefs: new Map(),    // gid -> count (refcount-by-tile, S1)
    layerRefs: new Set(),  // rsIds this tile needs resident in the class array
    cellRanges: null,      // Map<cellId, number[]> for envcell PVS ranges
    bands: null,           // Map<instanceId, {gids:[near,far], band:0|1}>
    live: false,
  };
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

export class PoolRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.THREE            the three namespace (injected — this
   *   module must stay importable in node harnesses that stub it)
   * @param {(classKey:string, member:object)=>object} deps.materialFactory
   *   ONE material per class (D-07.2); called at most once per class.
   * @param {object} [deps.group]          scene group pools attach to
   * @param {(m:string, d?:any)=>void} [deps.warn]
   * @param {()=>number} [deps.now]
   * @param {number} [deps.initInstances]
   * @param {number} [deps.initVerts]
   */
  constructor({ THREE, materialFactory, group = null, warn, now, initInstances, initVerts } = {}) {
    if (!THREE || typeof THREE.BatchedMesh !== "function") {
      throw new Error("pool_registry: THREE with BatchedMesh required");
    }
    if (typeof materialFactory !== "function") {
      throw new Error("pool_registry: materialFactory required (one material per class)");
    }
    this.THREE = THREE;
    this.materialFactory = materialFactory;
    this.group = group;
    this.now = typeof now === "function" ? now : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };
    this.initInstances = initInstances || POOL_INIT_INSTANCES;
    this.initVerts = initVerts || POOL_INIT_VERTS;

    /** poolKey ("<sectorKey>|<classKey>") -> pool state */
    this.pools = new Map();
    /** classKey -> {material, passClass, pools:Set<poolKey>, created:number} */
    this.classes = new Map();
    /** tileKey -> Map<poolKey, membership> */
    this.tiles = new Map();

    // D-07.9: the class set is CLOSED at boot. `sealClassSet()` is called once
    // the boot ring settles (the prewarm's own precondition); every class
    // minted after that is a class-key BUG by definition and is counted.
    this._sealed = false;
    this._fixApplied = null; // tri-state: null = not yet probed
    this._fixWarned = false;

    this._stats = {
      feeds: 0, parks: 0, adopts: 0, releases: 0,
      bandSwaps: 0, cellFlips: 0,
      mutationsThisFrame: 0, mutationsTotal: 0,
      dedupHits: 0, geometryAdds: 0, instanceAdds: 0, instanceDeletes: 0,
      poolsCreated: 0, poolsReaped: 0,
      classesCreated: 0, classesCreatedPostBoot: 0,
      optimizeRuns: 0, growthDoublings: 0,
      unresolvedGeometry: 0, unpooledMembers: 0,
      lastError: null,
    };
  }

  // ── frame edge ──────────────────────────────────────────────────────────

  /** Call once per frame BEFORE any pool work. Resets the per-frame mutation
   *  counter that the S2 anti-churn invariant is measured on. */
  beginFrame() {
    this._stats.mutationsThisFrame = 0;
  }

  _mutate(n = 1) {
    this._stats.mutationsThisFrame += n;
    this._stats.mutationsTotal += n;
  }

  /** D-07.9 — seal the class set (boot ring settled / prewarm complete). */
  sealClassSet() {
    this._sealed = true;
  }

  get sealed() {
    return this._sealed;
  }

  // ── pools ───────────────────────────────────────────────────────────────

  static poolKeyOf(sectorKey, classKey) {
    return `${sectorKey}|${classKey}`;
  }

  _verifyColorTextureFix() {
    if (this._fixApplied !== null) return this._fixApplied;
    let ok = false;
    try {
      ok = Object.prototype.hasOwnProperty.call(this.THREE.BatchedMesh.prototype, "colorTexture")
        || "colorTexture" in this.THREE.BatchedMesh.prototype;
    } catch (_) {
      ok = false;
    }
    this._fixApplied = ok;
    if (!ok && !this._fixWarned) {
      this._fixWarned = true;
      // LOUD: at pool scale this is a per-pool-per-frame program re-derive
      // (upstream three #34054). R-11 keeps it on the doc-propagation register.
      try {
        console.error(
          "[drawPools] three_batchedmesh_colortexture_fix is NOT applied — "
          + "BatchedMesh.prototype.colorTexture is absent, so r184 re-derives the "
          + "program for EVERY pool EVERY frame (three #34054). Apply the fix "
          + "before constructing pools (scene3d/index.js applies it at boot).",
        );
      } catch (_) { /* fail-soft */ }
    }
    return ok;
  }

  _classOf(classKey, member) {
    let c = this.classes.get(classKey);
    if (c) return c;
    const material = this.materialFactory(classKey, member);
    if (!material) throw new Error(`pool_registry: materialFactory returned nothing for ${classKey}`);
    c = {
      classKey,
      material,
      passClass: member && member.passClass ? member.passClass : "opaque",
      pools: new Set(),
    };
    this.classes.set(classKey, c);
    this._stats.classesCreated += 1;
    if (this._sealed) {
      // D-07.9 / S5.3: a class minted after the boot ring settles is a bug —
      // it means the key depends on something that streams. Counted, never
      // hidden; the CI gate is `classesCreatedPostBoot === 0`.
      this._stats.classesCreatedPostBoot += 1;
      this.warn(`[drawPools] class minted POST-BOOT (D-07.9 violation): ${classKey}`);
    }
    return c;
  }

  /**
   * Get-or-create the pool for (sector, class). Create-on-first-member;
   * persists across residency churn; reaped when empty.
   */
  poolFor(sectorKey, classKey, member) {
    const key = PoolRegistry.poolKeyOf(sectorKey, classKey);
    let p = this.pools.get(key);
    if (p) return p;
    this._verifyColorTextureFix();
    const cls = this._classOf(classKey, member);
    const THREE = this.THREE;
    const bm = new THREE.BatchedMesh(
      this.initInstances, this.initVerts, this.initVerts * 2, cls.material,
    );
    bm.name = poolNodeName(sectorKey, classKey);
    // Node-level culling KEPT (sector-bounded geometry, D-07.4 step 1).
    bm.frustumCulled = true;
    bm.matrixAutoUpdate = false;
    if (cls.passClass === "opaque") {
      // D-07.4 step 2 — three's own early-out on every settled frame, every
      // camera, CSM included.
      bm.perObjectFrustumCulled = false;
      bm.sortObjects = false;
    } else {
      // D-07.3 — additive/translucent keep TODAY'S sorted-bucket semantics
      // exactly. `?poolAdditiveNoSort` is reserved behind an eye-gate.
      bm.perObjectFrustumCulled = true;
      bm.sortObjects = true;
    }
    bm.userData = {
      __drawPool: true,
      sectorKey,
      classKey,
      passClass: cls.passClass,
    };
    p = {
      key, sectorKey, classKey, passClass: cls.passClass, mesh: bm,
      /** contentKey|layer -> gid (exact bake identities; the statGeomDedup
       *  FNV fingerprint existed to guard partial decodes, a failure class
       *  --verify-closure deletes — D-07.7). */
      geomByContent: new Map(),
      /** gid -> {refs, contentKey, verts, indices} */
      gids: new Map(),
      instances: 0,
      deadInstances: 0,
      maxInstances: this.initInstances,
      maxVerts: this.initVerts,
      maxIndices: this.initVerts * 2,
      usedVerts: 0,
      usedIndices: 0,
      /** vertices freed by deleteGeometry since the last optimize() — the
       *  DEAD EXTENT the >30% compaction threshold is measured on. */
      freedVerts: 0,
    };
    this.pools.set(key, p);
    cls.pools.add(key);
    this._stats.poolsCreated += 1;
    if (this.group && typeof this.group.add === "function") this.group.add(bm);
    return p;
  }

  _reapIfEmpty(p) {
    if (p.instances > 0 || p.gids.size > 0) return false;
    this.pools.delete(p.key);
    const cls = this.classes.get(p.classKey);
    if (cls) cls.pools.delete(p.key);
    if (this.group && typeof this.group.remove === "function") this.group.remove(p.mesh);
    try { p.mesh.dispose?.(); } catch (_) { /* fail-soft */ }
    this._stats.poolsReaped += 1;
    return true;
  }

  // ── capacity (growth doublings are exclusive P4 items; see upload_stage) ──

  _ensureGeometryRoom(p, geometry) {
    const posAttr = geometry.getAttribute ? geometry.getAttribute("position") : null;
    const verts = posAttr ? posAttr.count : 0;
    const idx = geometry.getIndex && geometry.getIndex() ? geometry.getIndex().count : verts;
    let grew = false;
    let maxV = p.maxVerts;
    let maxI = p.maxIndices;
    while (p.usedVerts + verts > maxV) { maxV *= 2; grew = true; }
    while (p.usedIndices + idx > maxI) { maxI *= 2; grew = true; }
    if (grew) {
      p.mesh.setGeometrySize(maxV, maxI);
      p.maxVerts = maxV;
      p.maxIndices = maxI;
      this._stats.growthDoublings += 1;
    }
    return { verts, indices: idx };
  }

  _ensureInstanceRoom(p) {
    if (p.instances < p.maxInstances) return;
    const next = p.maxInstances * 2;
    p.mesh.setInstanceCount(next);
    p.maxInstances = next;
    this._stats.growthDoublings += 1;
  }

  _ensureGeometry(p, member, geometrySource) {
    const layer = member.layer == null ? 0 : member.layer | 0;
    // Layer identity stays per-vertex `aLayer` in v1 (D-07.7), so a geometry
    // used under two layers is two pool geometries — proven, shader-risk-free.
    const ck = `${member.contentKey}|${layer}`;
    const hit = p.geomByContent.get(ck);
    if (hit !== undefined) {
      const g = p.gids.get(hit);
      g.refs += 1;
      this._stats.dedupHits += 1;
      return hit;
    }
    const geometry = geometrySource && typeof geometrySource.get === "function"
      ? geometrySource.get(member.contentKey, layer, member)
      : null;
    if (!geometry) {
      this._stats.unresolvedGeometry += 1;
      return -1;
    }
    const room = this._ensureGeometryRoom(p, geometry);
    const gid = p.mesh.addGeometry(geometry);
    p.geomByContent.set(ck, gid);
    p.gids.set(gid, { refs: 1, contentKey: ck, verts: room.verts, indices: room.indices });
    p.usedVerts += room.verts;
    p.usedIndices += room.indices;
    this._stats.geometryAdds += 1;
    return gid;
  }

  _releaseGeometry(p, gid) {
    const g = p.gids.get(gid);
    if (!g) return;
    g.refs -= 1;
    if (g.refs > 0) return;
    p.gids.delete(gid);
    p.geomByContent.delete(g.contentKey);
    p.usedVerts -= g.verts;
    p.usedIndices -= g.indices;
    p.freedVerts += g.verts;
    try { p.mesh.deleteGeometry(gid); } catch (e) { this._stats.lastError = String(e && e.message || e); }
  }

  // ── STAGED → LIVE (the feed; pass-07 S2 row 2) ───────────────────────────

  /**
   * Begin feeding a TilePlan. Returns a chunkable job so the P4 scheduler
   * (W3) owns the cadence — this module never schedules itself.
   *
   * ORDERING INVARIANT (pass-08 S2.4, shared with the stage-C upload path):
   * geometry appends → texture stages → matrices/instances → membership
   * record → **LIVE flip last**. Instances are added INVISIBLE and flipped
   * visible only in `commit()`, so P3 can never draw a half-fed tile.
   *
   * @param {object} tilePlan  pass-07 S1 TilePlan
   * @param {{get:(contentKey:any, layer:number, member:object)=>object}} geometrySource
   * @param {{onLayer?:(rsId:number, member:object)=>void}} [hooks]
   */
  beginFeed(tilePlan, geometrySource, hooks = {}) {
    const tileKey = tilePlan.tile;
    const members = tilePlan.members || [];
    const self = this;
    let i = 0;
    let committed = false;
    const touched = new Map(); // poolKey -> membership

    const job = {
      tileKey,
      total: members.length,
      get index() { return i; },
      get done() { return i >= members.length; },
      get committed() { return committed; },

      /** Feed up to `maxMembers` members (or until `deadline()` returns true).
       *  @returns {number} members fed this step. */
      step(maxMembers = Infinity, deadline = null) {
        let fed = 0;
        while (i < members.length) {
          if (fed >= maxMembers) break;
          if (fed > 0 && typeof deadline === "function" && deadline()) break;
          const m = members[i++];
          try {
            self._feedMember(tileKey, m, geometrySource, touched, hooks);
          } catch (e) {
            self._stats.lastError = String(e && e.message || e);
          }
          fed += 1;
        }
        return fed;
      },

      /** LIVE flip — last, atomic, one visibility batch per touched pool. */
      commit() {
        if (committed) return 0;
        committed = true;
        let flipped = 0;
        for (const mem of touched.values()) {
          for (const id of mem.instanceIds) {
            mem.pool.mesh.setVisibleAt(id, true);
            flipped += 1;
          }
          mem.live = true;
        }
        if (touched.size > 0) {
          let byTile = self.tiles.get(tileKey);
          if (!byTile) { byTile = new Map(); self.tiles.set(tileKey, byTile); }
          for (const [pk, mem] of touched) {
            const prev = byTile.get(pk);
            if (prev) {
              // Re-feed of a tile already resident in this pool (idempotent
              // producers do this): merge instead of orphaning the old ids.
              for (const id of mem.instanceIds) prev.instanceIds.push(id);
              for (const [g, n] of mem.gidRefs) prev.gidRefs.set(g, (prev.gidRefs.get(g) || 0) + n);
              for (const r of mem.layerRefs) prev.layerRefs.add(r);
              if (mem.cellRanges) {
                if (!prev.cellRanges) prev.cellRanges = new Map();
                for (const [c, ids] of mem.cellRanges) {
                  const cur = prev.cellRanges.get(c) || [];
                  prev.cellRanges.set(c, cur.concat(ids));
                }
              }
              if (mem.bands) {
                if (!prev.bands) prev.bands = new Map();
                for (const [id, b] of mem.bands) prev.bands.set(id, b);
              }
              prev.live = true;
            } else {
              byTile.set(pk, mem);
            }
          }
          self._stats.feeds += 1;
          self._mutate(touched.size);
        }
        return flipped;
      },

      /** STAGED-but-vacated: nothing entered any pool that must persist. */
      abandon() {
        if (committed) return;
        committed = true;
        for (const mem of touched.values()) {
          for (const id of mem.instanceIds) {
            try { mem.pool.mesh.deleteInstance(id); } catch (_) { /* fail-soft */ }
            self._stats.instanceDeletes += 1;
          }
          for (const [gid, n] of mem.gidRefs) {
            for (let k = 0; k < n; k++) self._releaseGeometry(mem.pool, gid);
          }
          mem.pool.instances -= mem.instanceIds.length;
          self._reapIfEmpty(mem.pool);
        }
        touched.clear();
      },
    };
    return job;
  }

  /** One-shot convenience (tests + non-budgeted callers). */
  feedTile(tilePlan, geometrySource, hooks) {
    const job = this.beginFeed(tilePlan, geometrySource, hooks);
    job.step();
    job.commit();
    return job;
  }

  _feedMember(tileKey, m, geometrySource, touched, hooks) {
    if (!isPooledDomain(m.domain || "st")) {
      this._stats.unpooledMembers += 1;
      return;
    }
    const p = this.poolFor(m.sectorKey, m.classKey, m);
    let mem = touched.get(p.key);
    if (!mem) { mem = makeMembership(p); touched.set(p.key, mem); }

    // LOD (D-07.8): both band gids are pool-resident members of the SAME
    // class (same surface ⇒ same class by construction). The active gid is
    // chosen at feed by band and re-chosen by the throttled band tick.
    const band = m.band | 0;
    let gid = -1;
    let bandGids = null;
    if (Array.isArray(m.bandGids) && m.bandGids.length === 2) {
      const near = this._ensureGeometry(p, { ...m, contentKey: m.bandGids[0] }, geometrySource);
      const far = this._ensureGeometry(p, { ...m, contentKey: m.bandGids[1] }, geometrySource);
      bandGids = [near, far];
      gid = band === 1 ? far : near;
      if (near >= 0) mem.gidRefs.set(near, (mem.gidRefs.get(near) || 0) + 1);
      if (far >= 0) mem.gidRefs.set(far, (mem.gidRefs.get(far) || 0) + 1);
    } else {
      gid = this._ensureGeometry(p, m, geometrySource);
      if (gid >= 0) mem.gidRefs.set(gid, (mem.gidRefs.get(gid) || 0) + 1);
    }
    if (gid < 0) return; // unresolved geometry — counted, never a silent draw

    this._ensureInstanceRoom(p);
    const id = p.mesh.addInstance(gid);
    // The flip is LAST (commit): an instance is born invisible.
    p.mesh.setVisibleAt(id, false);
    if (m.matrix) p.mesh.setMatrixAt(id, this._matrixOf(m.matrix));
    p.instances += 1;
    this._stats.instanceAdds += 1;
    mem.instanceIds.push(id);
    if (m.rsId) {
      mem.layerRefs.add(m.rsId >>> 0);
      if (hooks && typeof hooks.onLayer === "function") hooks.onLayer(m.rsId >>> 0, m);
    }
    if (m.cellId != null) {
      if (!mem.cellRanges) mem.cellRanges = new Map();
      const arr = mem.cellRanges.get(m.cellId) || [];
      arr.push(id);
      mem.cellRanges.set(m.cellId, arr);
    }
    if (bandGids) {
      if (!mem.bands) mem.bands = new Map();
      mem.bands.set(id, { gids: bandGids, band, pos: m.pos || null });
    }
  }

  _matrixOf(matrix) {
    if (matrix && matrix.isMatrix4) return matrix;
    const m4 = this._scratchM4 || (this._scratchM4 = new this.THREE.Matrix4());
    m4.fromArray(matrix);
    return m4;
  }

  // ── LIVE ⇄ PARKED (S2 rows 3/4 — GPU-free by construction) ───────────────

  /** LIVE → PARKED: `setVisibleAt(false)` batch. No GPU or heap release. */
  parkTile(tileKey) {
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      if (!mem.live) continue;
      for (const id of mem.instanceIds) { mem.pool.mesh.setVisibleAt(id, false); n += 1; }
      mem.live = false;
    }
    if (n > 0) { this._stats.parks += 1; this._mutate(byTile.size); }
    return n;
  }

  /** PARKED → LIVE: pointer re-adopt — zero fetch, zero decode, zero upload. */
  adoptTile(tileKey) {
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      if (mem.live) continue;
      for (const id of mem.instanceIds) {
        // A cell outside the current PVS set stays hidden across a re-adopt.
        if (mem.hiddenCells && mem.hiddenCells.has(id)) continue;
        mem.pool.mesh.setVisibleAt(id, true);
        n += 1;
      }
      mem.live = true;
    }
    if (n > 0) { this._stats.adopts += 1; this._mutate(byTile.size); }
    return n;
  }

  isTileResident(tileKey) {
    return this.tiles.has(tileKey);
  }

  // ── PARKED → EMPTY (S2 row 5 — amortized, ≤1 tile/tick under the budget) ─

  /**
   * True release. `deleteInstance` per id, gid deref → `deleteGeometry` at
   * zero, layer refs released, pool marked dirty, lazy `optimize()` at >30%
   * dead extent, empty pool reaped.
   * @returns {number} instances deleted.
   */
  releaseTile(tileKey) {
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let n = 0;
    for (const mem of byTile.values()) {
      const p = mem.pool;
      for (const id of mem.instanceIds) {
        try { p.mesh.deleteInstance(id); } catch (e) { this._stats.lastError = String(e && e.message || e); }
        n += 1;
        this._stats.instanceDeletes += 1;
      }
      p.instances -= mem.instanceIds.length;
      p.deadInstances += mem.instanceIds.length;
      for (const [gid, refs] of mem.gidRefs) {
        for (let k = 0; k < refs; k++) this._releaseGeometry(p, gid);
      }
      this._maybeOptimize(p);
      this._reapIfEmpty(p);
    }
    this.tiles.delete(tileKey);
    if (n > 0) { this._stats.releases += 1; this._mutate(byTile.size); }
    return n;
  }

  _maybeOptimize(p) {
    if (!this.pools.has(p.key)) return false;
    const extent = p.usedVerts + p.freedVerts;
    if (extent <= 0) return false;
    if (p.freedVerts / extent < POOL_OPTIMIZE_FRAC) return false;
    try {
      p.mesh.optimize();
      p.freedVerts = 0;
      p.deadInstances = 0;
      this._stats.optimizeRuns += 1;
      return true;
    } catch (e) {
      this._stats.lastError = String(e && e.message || e);
      return false;
    }
  }

  /** Explicit compaction pass (a W4 item) — returns pools compacted. */
  tickOptimize(maxPools = 1) {
    let done = 0;
    for (const p of this.pools.values()) {
      if (done >= maxPools) break;
      if (this._maybeOptimize(p)) done += 1;
    }
    return done;
  }

  // ── per-cell PVS ranges (D-07.8) ─────────────────────────────────────────

  /**
   * Interior renderSet delta → `setVisibleAt` batches over the entering and
   * leaving cells' instance ranges. Replaces the per-container visibility
   * walk (cells.js's ~1,100 containers at Town Network).
   * @param {number} tileKey
   * @param {Set<number>} renderSet  cellIds that should be visible
   */
  cellSetChanged(tileKey, renderSet) {
    const byTile = this.tiles.get(tileKey);
    if (!byTile) return 0;
    let flips = 0;
    for (const mem of byTile.values()) {
      if (!mem.cellRanges) continue;
      if (!mem.hiddenCells) mem.hiddenCells = new Set();
      for (const [cellId, ids] of mem.cellRanges) {
        const want = renderSet.has(cellId);
        for (const id of ids) {
          const hidden = mem.hiddenCells.has(id);
          if (want && hidden) {
            mem.hiddenCells.delete(id);
            if (mem.live) mem.pool.mesh.setVisibleAt(id, true);
            flips += 1;
          } else if (!want && !hidden) {
            mem.hiddenCells.add(id);
            mem.pool.mesh.setVisibleAt(id, false);
            flips += 1;
          }
        }
      }
    }
    if (flips > 0) { this._stats.cellFlips += 1; this._mutate(1); }
    return flips;
  }

  // ── LOD band tick (D-07.8 — 2 Hz + moved-≥8 m gate, owned by the caller) ─

  /**
   * Re-choose each banded member's active gid by distance band, with ±10%
   * hysteresis on the edge. Walks the membership records (JS arrays), NOT
   * scene nodes. Parked cost 0; moving cost O(band crossings).
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} bandRadius  metres (the ~100 m band, [A])
   * @returns {number} band swaps performed.
   */
  bandTick(playerPos, bandRadius = 100) {
    if (!playerPos) return 0;
    const near = bandRadius * 0.9;
    const far = bandRadius * 1.1;
    let swaps = 0;
    for (const byTile of this.tiles.values()) {
      for (const mem of byTile.values()) {
        if (!mem.bands) continue;
        for (const [id, b] of mem.bands) {
          if (!b.pos) continue;
          const dx = b.pos.x - playerPos.x;
          const dy = (b.pos.y || 0) - (playerPos.y || 0);
          const dz = (b.pos.z || 0) - (playerPos.z || 0);
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const want = b.band === 0 ? (d > far ? 1 : 0) : (d < near ? 0 : 1);
          if (want === b.band) continue;
          const gid = b.gids[want];
          if (gid == null || gid < 0) continue;
          try {
            mem.pool.mesh.setGeometryIdAt(id, gid);
            b.band = want;
            swaps += 1;
          } catch (e) {
            this._stats.lastError = String(e && e.message || e);
          }
        }
      }
    }
    if (swaps > 0) { this._stats.bandSwaps += swaps; this._mutate(1); }
    return swaps;
  }

  // ── census (__diag.pools — the registry schema is the contract) ──────────

  /** M6: allocated (buffer capacity) vs used EXTENT — never `position.count`
   *  (the §5c allocated-vs-used lesson). */
  geometryBytes() {
    let allocated = 0;
    let used = 0;
    for (const p of this.pools.values()) {
      allocated += p.maxVerts * POOL_VERTEX_BYTES + p.maxIndices * POOL_INDEX_BYTES;
      used += p.usedVerts * POOL_VERTEX_BYTES + p.usedIndices * POOL_INDEX_BYTES;
    }
    return { allocated, used };
  }

  census() {
    const byClass = {};
    const byPass = { opaque: 0, additive: 0, translucent: 0 };
    for (const p of this.pools.values()) {
      byClass[p.classKey] = (byClass[p.classKey] || 0) + 1;
      byPass[p.passClass] = (byPass[p.passClass] || 0) + 1;
    }
    const g = this.geometryBytes();
    const s = this._stats;
    return {
      pools: { count: this.pools.size, byClass, byPass },
      classes: { count: this.classes.size, createdPostBoot: s.classesCreatedPostBoot, sealed: this._sealed },
      nodes: { scene: this.pools.size, worldStatic: this.pools.size, entity: 0 },
      geometry: {
        allocatedBytes: g.allocated,
        usedBytes: g.used,
        dedupHits: s.dedupHits,
        adds: s.geometryAdds,
      },
      tiles: { resident: this.tiles.size },
      events: {
        feeds: s.feeds, parks: s.parks, adopts: s.adopts, releases: s.releases,
        bandSwaps: s.bandSwaps, cellFlips: s.cellFlips,
        mutationsThisFrame: s.mutationsThisFrame,
        mutationsTotal: s.mutationsTotal,
      },
      draws: { submitted: this.pools.size, switchRate: null, programSwitches: null },
      fix: { applied: this._fixApplied === true },
      errors: { unresolvedGeometry: s.unresolvedGeometry, unpooledMembers: s.unpooledMembers, lastError: s.lastError },
    };
  }

  /** Teardown (context loss / arm switch). */
  dispose() {
    for (const p of [...this.pools.values()]) {
      if (this.group && typeof this.group.remove === "function") this.group.remove(p.mesh);
      try { p.mesh.dispose?.(); } catch (_) { /* fail-soft */ }
    }
    this.pools.clear();
    this.classes.clear();
    this.tiles.clear();
  }
}

// ---------------------------------------------------------------------------
// helpers shared with the producers
// ---------------------------------------------------------------------------

/**
 * Resolve a member's class + pass from its raw axis record (the producer's
 * one call into the key). Kept here so no producer ever hand-builds a key.
 */
export function resolveMemberClass(axisRecord) {
  return { classKey: classKeyOf(axisRecord), passClass: passClassOf(axisRecord) };
}

// ---------------------------------------------------------------------------
// singleton (browser wiring; inert unless the flag chain is armed)
// ---------------------------------------------------------------------------

let _registry = null;
let _armed = null; // null = not yet resolved

/**
 * Arm the pool registry. Returns the registry when the F-11.3 chain is
 * satisfied, else `null` after logging every unmet reason (kill path: the
 * flag did nothing and said so).
 */
export function initDrawPools(deps = {}) {
  const chk = checkDrawPoolsPrereqs(deps.search);
  if (!chk.armed) {
    _armed = false;
    if (drawPoolsEnabled(deps.search)) {
      try {
        console.error(
          "[drawPools] flag ON but DISARMED (legacy producer stack stays in charge):\n  - "
          + chk.reasons.filter((r) => r !== "?drawPools is not on").join("\n  - "),
        );
      } catch (_) { /* fail-soft */ }
    }
    return null;
  }
  if (!chk.frameWork) {
    // Stage A is legal without ?frameWork; stages B/C are not (SPEC §3 T22).
    try {
      console.warn("[drawPools] armed WITHOUT ?frameWork — scheduler stages B/C are inert (feeds run on the caller's cadence).");
    } catch (_) { /* fail-soft */ }
  }
  _registry = new PoolRegistry(deps);
  _armed = true;
  // Publish the census on the RESERVED registry name `__diag.pools` (the
  // declared successor of `__atlasStats`). Merged onto whatever `__diag`
  // already holds — never assigned wholesale, so ordering against index.js's
  // own `__diag` construction cannot clobber either side. The registry entry
  // stays `reserved` until the producer swap makes this live on a real run
  // (T22 report: "remainder").
  if (typeof window !== "undefined") {
    try {
      window.__diag = window.__diag || {};
      window.__diag.pools = () => (_registry ? _registry.census() : { enabled: false });
    } catch (_) { /* fail-soft */ }
  }
  return _registry;
}

export function drawPoolsActive() {
  return _armed === true && _registry !== null;
}

export function getPoolRegistry() {
  return _registry;
}

/** Test hook — drop the singleton between arms. */
export function _resetDrawPoolsForTest() {
  if (_registry) { try { _registry.dispose(); } catch (_) { /* fail-soft */ } }
  _registry = null;
  _armed = null;
}
