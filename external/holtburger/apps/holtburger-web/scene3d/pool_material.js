// scene3d/pool_material.js — the CLASS MATERIAL tier (ST9 / T22-PRODUCER;
// SPEC §1.5 "ONE material object per class", pass-07 D-07.2).
//
// WHAT THIS IS
// ------------
// `PoolRegistry` takes `materialFactory(classKey, member)` as an injected
// dependency and deliberately owns no material machinery (pool_registry.js
// header, "what this module deliberately does not own"). This module is that
// dependency for the live producers: it turns a CLASS KEY into
//
//   * ONE `THREE.Material` — `makeArrayMaterial`'s `sampler2DArray` variant,
//     the SAME object the cross-LB atlas has shipped since RND-33, so a pooled
//     surface shades exactly as an atlased surface does today;
//   * ONE array PAGE per class — a `CompressedArrayTexture` (BC7) or
//     `DataArrayTexture` (RGBA8) allocated at the class's PAGE DIMS, which is
//     what makes "any two members of a class share any layer of the class's one
//     texStorage3D allocation" a theorem (pool_class_key.js header);
//   * a per-member LAYER index, refcounted by source-texture uuid.
//
// D-07.2's load-bearing sentence, restated: the tier IS the (format, w, h)
// triple `texStorage3D` fixes. That is why the page tier is in the class key
// and why this module refuses any member whose native dims are not the page.
//
// THE D2 GATE (T22 report Deviation D2 — the reason members get REFUSED)
// ---------------------------------------------------------------------
// The T00 re-key's correctness half is "a member whose native dims ≠ its page
// dims is stored RESAMPLED (upscaled) to page dims at bake/transcode time".
// That resample is a bake/transcode-pipeline change and is NOT landed (a
// concurrent task owns it). Until it lands the page tier is sound as a CENSUS
// key but not as an ALLOCATION key for off-page members, so:
//
//   `admit()` REFUSES every member for which `needsResample(rec)` is true,
//   counts it as `needsResample`, and the producer routes it to the LEGACY
//   path — rendered, never dropped, never silent.
//
// When the resample lands, the refusal becomes unreachable by construction
// (every TEXREF'd payload arrives at page dims) and the counter reads 0. That
// counter is therefore the migration's own progress meter.
//
// REUSE, NOT RE-IMPLEMENTATION
// ---------------------------
// Every array primitive here is imported from `static_atlas.js` /
// `bc7_textures.js` — the same allocation, colour space, wrap mode, filtering,
// mip policy, growth arithmetic and layer-write invariant the atlas has been
// measured on. A class page and an atlas bucket are the same kind of object by
// construction; what differs is the KEY that owns it (classKey, not
// `<w>x<h>|<stateKey>`) and the page-dims refusal above. `static_atlas.js` is
// NOT modified — the atlas remains the OFF arm, byte for byte.

import * as THREE from "three";
import {
  makeArrayMaterial,
  buildDiffuseArray,
  buildNraArray,
  packNraLayer,
  statNraEnabled,
  isBc7AtlasTexture,
  bc7AtlasShouldDefer,
  _stateKeyOf,
  _perLayerBytesFor,
  _layerCapacityFor,
  _atlasStartLayersFor,
  _atlasGrowTargetFor,
} from "./static_atlas.js";
import {
  makeBc7ArrayTexture,
  writeBc7ArrayLayer,
  bc7LevelBytes,
  texCompressedOnlyActive,
  materialRsId,
} from "./bc7_textures.js";
import { getAdapterMaxAnisotropy } from "./adapter.js";
import { PLANE, planeFor, canSupplyPlanes } from "./surface_planes.js";
import { pageDimsOf, needsResample } from "./pool_class_key.js";
// ENVCELL-POOL-SWAP: the interior BAKE. `?vertexBake`'s retail arm drops an
// EnvCell's static lamps from the live light pool on the strength of the
// per-vertex `acBakedLight` term (lighting.js RND-04 handshake), so a class
// material that does not carry the patch renders that dungeon on ambient
// alone. Dungeon lighting is not negotiable: the class material takes the
// patch, or the member does not pool.
import { applyBakedVertexLightPatch, VERTEX_BAKE } from "./materials.js";

/** Why a member was refused. Every value is COUNTED and routes the member to
 *  the legacy producer path — there is no silent drop. */
export const REFUSE = Object.freeze({
  NO_TEXTURE: "noTexture",
  NEEDS_RESAMPLE: "needsResample",
  BC7_PENDING: "bc7Pending",
  DEFORMED: "deformed",
  OFF_PAGE: "offPage",
  LAYER_FULL: "layerFull",
  LAYER_WRITE: "layerWriteFail",
  NO_PIXELS: "noPixels",
});

export class ClassMaterialRegistry {
  /**
   * @param {object} deps
   * @param {(m:string,d?:any)=>void} [deps.warn]
   */
  constructor({ warn } = {}) {
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };
    /** classKey -> class page record */
    this.classes = new Map();
    this.stats = {
      classes: 0,
      layerAllocs: 0, layerHits: 0, layerRecycles: 0, layerGrows: 0, layerGrowFails: 0,
      bc7Layers: 0, rgbaLayers: 0, nraLayers: 0,
      refeedDimMismatch: 0, refeedFormatMismatch: 0,
      refused: { noTexture: 0, needsResample: 0, offPage: 0, bc7Pending: 0, deformed: 0, layerFull: 0, layerWriteFail: 0, noPixels: 0 },
      allocatedBytes: 0,
    };
  }

  /** The `PoolRegistry.materialFactory` dependency. The class page is always
   *  created by `admit()` before any member reaches the registry, so this is a
   *  lookup; a miss is a producer bug and is LOUD. */
  materialFactory(classKey) {
    const c = this.classes.get(classKey);
    if (!c) throw new Error(`pool_material: no class page for ${classKey} (admit() must run first)`);
    return c.material;
  }

  /**
   * Try to admit ONE member (a resolved node/material) into its class page.
   *
   * @param {string} classKey
   * @param {object} material  the member's resolved THREE material
   * @param {object} rec       the member's axis record (`axisRecordOf` shape)
   * @returns {{ok:true, layer:number} | {ok:false, reason:string}}
   */
  admit(classKey, material, rec) {
    const tex = material && material.map;
    if (!tex || !tex.image) return this._refuse(REFUSE.NO_TEXTURE);
    // A MECH-B vertex-deformed variant must never be consumed: the class
    // material replaces the member's variant and would silently strip the
    // deformation (the 2026-07-02 "trunk sways, foliage frozen" split).
    const setKey = material.userData && material.userData.__vfxSetKey;
    if (typeof setKey === "string" && setKey.includes("deformation.")) return this._refuse(REFUSE.DEFORMED);
    // A surface whose BC7 verdict is still in flight cannot be committed: the
    // page's format and dims are fixed by texStorage3D at allocation.
    if (bc7AtlasShouldDefer(material)) return this._refuse(REFUSE.BC7_PENDING);
    // THE PAGE-RESAMPLE AUTHORITY. `rec.texOffPage` is stamped by the producer
    // when TEXREF declares dims that differ from the ones currently on the
    // GPU: such a member's dims WILL move when its full tier lands, so a page
    // layer taken now pins it to the wrong page for the session. The
    // `FULL_PAGE_DIMS` tier bit is the authority here — the dims byte alone
    // cannot be (a 1096² member rounds to a convincing 2048²).
    if (rec && rec.texOffPage === true) return this._refuse(REFUSE.OFF_PAGE);
    // THE D2 GATE. `rec` carries the page-tier facts the class key was built
    // from; a member off its page has no legal layer until the bake/transcode
    // resample lands.
    if (needsResample(rec)) return this._refuse(REFUSE.NEEDS_RESAMPLE);
    const page = pageDimsOf(rec);
    if (!page) return this._refuse(REFUSE.NO_TEXTURE);

    const bc7 = isBc7AtlasTexture(tex) === true;
    const img = tex.image;
    const canPixels = (img && img.data) || bc7
      || canSupplyPlanes(material, material.userData?.surfaceDid);
    if (!canPixels) return this._refuse(REFUSE.NO_PIXELS);

    const c = this._classOf(classKey, page.width, page.height, bc7, material);
    if (!c) return this._refuse(REFUSE.NO_PIXELS);

    const uuid = tex.uuid;
    const hit = c.layerOf.get(uuid);
    if (hit) {
      hit.refs += 1;
      this.stats.layerHits += 1;
      return { ok: true, layer: hit.layer };
    }

    let layer;
    if (c.freeLayers.length > 0) { layer = c.freeLayers.pop(); this.stats.layerRecycles += 1; }
    else if (c.nextLayer < c.allocLayers) layer = c.nextLayer++;
    else if (c.nextLayer < c.capacity && this._grow(c, c.nextLayer + 1)) layer = c.nextLayer++;
    else return this._refuse(REFUSE.LAYER_FULL);

    // LAYER-WRITE INVARIANT (static_atlas.js:1586): a layer index is RECYCLED,
    // so a skipped or failed write leaves the previous tenant's texels resident
    // and the member renders someone else's texture. Every path below either
    // rewrites the layer in full or releases it.
    if (!this._writeLayer(c, layer, tex, material)) {
      c.freeLayers.push(layer);
      return this._refuse(REFUSE.LAYER_WRITE);
    }
    c.layerOf.set(uuid, {
      layer,
      refs: 1,
      // RSID-MARKER: the ONE reader. Was an inline `__bc7RsId ?? __pvwRsId`,
      // which reads 0 for a member admitted after a NEGATIVE verdict (the X6
      // path stamps `__bc7RsId` only on success) — and a layer filed under
      // rsId 0 is a layer `refeedRsId` can never find again.
      rsId: materialRsId(material),
      // The MATERIAL is retained so `refeedRsId` can re-read its (upgraded)
      // `map` — `atlasRefeed(rsId)` carries no resolver, and re-deriving the
      // surface from the DID here would duplicate the MaterialCache.
      mat: material,
    });
    this.stats.layerAllocs += 1;
    // X5 — the nra layer is packed from THIS member's material (first member of
    // a deduped surface only, exactly like the diffuse pixels).
    if (c.arrays.nra) {
      try {
        packNraLayer(c.arrays.nra, layer, material, c.w, c.h, null);
        this.stats.nraLayers += 1;
      } catch (_) { /* fail-soft: the flat texel shades like albedo-only v1 */ }
    }
    return { ok: true, layer };
  }

  /**
   * Release one reference to a member's layer.
   *
   * NOT WIRED IN v1, deliberately (recorded as a deviation): the registry's
   * membership record refcounts by rsId, not by source-texture uuid, so a tile
   * release cannot name the layers it held without a second ledger. A layer
   * handed back while another tile's instances still sample it renders someone
   * else's texture — the exact failure the layer-write invariant exists to
   * prevent — so v1 keeps class-page layers SESSION-RESIDENT: bounded by the
   * unique-surface population (a few hundred), ceilinged by
   * `_layerCapacityFor`, and the ceiling's `layerFull` refusal is the counted
   * fail-soft. The uuid ledger lands with the tile-scoped release.
   */
  release(classKey, texUuid) {
    const c = this.classes.get(classKey);
    if (!c) return false;
    const e = c.layerOf.get(texUuid);
    if (!e) return false;
    e.refs -= 1;
    if (e.refs > 0) return false;
    c.layerOf.delete(texUuid);
    c.freeLayers.push(e.layer);
    return true;
  }

  /** Every class page holding a layer for `rsId` (the F-11.17 refeed seam). */
  classesForRsId(rsId) {
    const rs = rsId >>> 0;
    const out = [];
    for (const [k, c] of this.classes) {
      for (const e of c.layerOf.values()) if (e.rsId === rs) { out.push(k); break; }
    }
    return out;
  }

  /**
   * Re-write the layer a surface already owns from its (now upgraded) texture.
   * This is the pool half of `atlasRefeed(rsId)` — the full tier lands, the
   * material's `map` re-points, and the class page must follow or the pooled
   * copy stays at preview resolution for the session (F-11.17).
   *
   * The retained MATERIAL is the source: `atlasRefeed` carries no resolver, and
   * a member whose upgraded texture has DIFFERENT dims than its page belongs to
   * a different class entirely — that member was never committed here (it was
   * held out at admit time), so a dims mismatch is counted and skipped, never
   * written into the wrong page.
   * @returns {number} layers rewritten
   */
  refeedRsId(rsId) {
    const rs = rsId >>> 0;
    let n = 0;
    for (const c of this.classes.values()) {
      for (const [uuid, e] of [...c.layerOf]) {
        if (e.rsId !== rs) continue;
        const mat = e.mat;
        const tex = mat && mat.map;
        if (!tex || !tex.image) continue;
        if (tex.uuid === uuid) continue; // unchanged map — nothing to re-home
        if ((tex.image.width | 0) !== c.w || (tex.image.height | 0) !== c.h) {
          this.stats.refeedDimMismatch += 1;
          continue;
        }
        // RSID-MARKER: the page's FORMAT is fixed by texStorage3D too, and a
        // swap can change it — a member admitted while its BC7 record was
        // already cached takes an RGBA8 layer and then upgrades its `map` to
        // a CompressedTexture. Writing that into an RGBA8 page finds no
        // `image.data`, and the layer-write invariant would ZERO the layer:
        // the member goes BLACK. Refuse, count, leave the layer alone (it
        // holds correct — if now stale — pixels).
        if ((isBc7AtlasTexture(tex) === true) !== c.bc7) {
          this.stats.refeedFormatMismatch += 1;
          continue;
        }
        if (!this._writeLayer(c, e.layer, tex, mat)) continue;
        c.layerOf.delete(uuid);
        c.layerOf.set(tex.uuid, e);
        n += 1;
      }
    }
    return n;
  }

  census() {
    const byClass = {};
    let allocated = 0;
    let used = 0;
    for (const [k, c] of this.classes) {
      const per = _perLayerBytesFor(c.w, c.h, c.bc7);
      allocated += per * c.allocLayers;
      used += per * (c.nextLayer - c.freeLayers.length);
      byClass[k] = { w: c.w, h: c.h, bc7: c.bc7, layers: c.layerOf.size, alloc: c.allocLayers, capacity: c.capacity };
    }
    return {
      classes: this.classes.size,
      pageBytes: { allocated, used },
      layers: {
        allocs: this.stats.layerAllocs, hits: this.stats.layerHits,
        recycles: this.stats.layerRecycles, grows: this.stats.layerGrows,
        growFails: this.stats.layerGrowFails, nra: this.stats.nraLayers,
        refeedDimMismatch: this.stats.refeedDimMismatch,
        refeedFormatMismatch: this.stats.refeedFormatMismatch,
      },
      refused: { ...this.stats.refused },
      byClass,
    };
  }

  dispose() {
    for (const c of this.classes.values()) {
      try { c.arrays.diff?.dispose?.(); } catch (_) { /* fail-soft */ }
      try { c.arrays.nra?.dispose?.(); } catch (_) { /* fail-soft */ }
      try { c.material?.dispose?.(); } catch (_) { /* fail-soft */ }
    }
    this.classes.clear();
  }

  // ── internals ───────────────────────────────────────────────────────────

  _refuse(reason) {
    this.stats.refused[reason] = (this.stats.refused[reason] || 0) + 1;
    return { ok: false, reason };
  }

  _classOf(classKey, w, h, bc7, material) {
    let c = this.classes.get(classKey);
    if (c) return c;
    const capacity = _layerCapacityFor(w, h, bc7);
    const alloc = _atlasStartLayersFor(w, h, bc7, capacity);
    const stateKey = _stateKeyOf(material);
    let diff = null;
    let nra = null;
    try {
      diff = bc7
        ? makeBc7ArrayTexture(w, h, alloc,
            texCompressedOnlyActive() ? { mipChain: true, anisotropy: getAdapterMaxAnisotropy() } : {})
        : buildDiffuseArray([], w, h, alloc);
      nra = statNraEnabled() ? buildNraArray(w, h, alloc) : null;
    } catch (e) {
      try { diff && diff.dispose && diff.dispose(); } catch (_) { /* fail-soft */ }
      this.warn(`[drawPools] class page allocation refused for ${classKey}`, e);
      return null;
    }
    const arrays = { diff, nra };
    const material2 = makeArrayMaterial(diff, stateKey, nra, arrays);
    // The class material carries its own identity so the census, the prewarm
    // and devtools all join on the same string.
    material2.name = `pool-class-${classKey}`;
    material2.userData = { ...(material2.userData || {}), __poolClassMat: true, classKey };
    // ENVCELL-POOL-SWAP — THE INTERIOR BAKE. `__acBakedLight` is already a
    // class-key axis (`pool_class_key.js:262`, the `k` bit of the patch token),
    // so a baked surface and an unbaked one are DIFFERENT classes by
    // construction and this decision is class-uniform. What was missing is the
    // patch itself: the class material is `makeArrayMaterial`'s, which knows
    // nothing about `acBakedLight`, so a pooled dungeon would have rendered
    // with its static lamps ALREADY dropped from the live pool (the RND-04
    // handshake in lighting.js fires on the ATTRIBUTE, not on who draws it) and
    // no baked term to replace them — interiors on ambient alone, which is the
    // exact regression `_patchSetCacheKey`'s `k` bit was added to fix.
    //
    // The patch is installed LAST (after the userData spread, which would
    // otherwise drop the non-enumerable `acBakedLightUniforms` handle) and the
    // cache key is COMPOSED, never replaced: `_chainBeforeCompile` installs
    // `_patchSetCacheKey`, which knows nothing about the array material's own
    // axes (wrap bucket, nra presence) — collapsing those onto one program is
    // precisely the failure mode the atlas's per-bucket key exists to prevent.
    if (material && material.userData && material.userData.__acBakedLight === true) {
      const atlasKey = material2.customProgramCacheKey;
      applyBakedVertexLightPatch(material2, { suppressDirect: VERTEX_BAKE.suppressDirect });
      const composed = typeof atlasKey === "function" ? atlasKey.bind(material2) : null;
      material2.customProgramCacheKey = composed
        ? () => `${composed()}|k1${VERTEX_BAKE.suppressDirect ? "s" : ""}`
        : material2.customProgramCacheKey;
      material2.userData.__poolClassBaked = true;
    }
    // D-07.6: shadow flags become POOL-uniform, and the class key already
    // carries them, so the material's own shadow-side settings are class-wide.
    c = {
      classKey, w, h, bc7, stateKey, arrays, material: material2,
      layerOf: new Map(), freeLayers: [], nextLayer: 0,
      allocLayers: alloc, capacity,
    };
    this.classes.set(classKey, c);
    this.stats.classes += 1;
    return c;
  }

  _writeLayer(c, layer, tex, material) {
    const w = c.w;
    const h = c.h;
    if (c.bc7) {
      const chain = c.arrays.diff.mipmaps.length > 1;
      const ok = writeBc7ArrayLayer(c.arrays.diff, layer, {
        width: w,
        height: h,
        levels: chain ? tex.mipmaps : [{ data: tex.mipmaps?.[0]?.data, width: w, height: h }],
      });
      if (ok) this.stats.bc7Layers += 1;
      return ok === true;
    }
    const stride = w * h * 4;
    let src = tex.image && tex.image.data;
    if (!src) {
      const p = planeFor(material, PLANE.ALBEDO, material?.userData?.surfaceDid >>> 0);
      if (p) src = p.data;
    }
    if (src && src.length === stride) {
      c.arrays.diff.image.data.set(src, layer * stride);
    } else {
      // Wrong-stride source: ZERO the layer rather than inherit the previous
      // tenant's pixels (the layer-write invariant).
      c.arrays.diff.image.data.fill(0, layer * stride, (layer + 1) * stride);
    }
    if (typeof c.arrays.diff.addLayerUpdate === "function") c.arrays.diff.addLayerUpdate(layer);
    this.stats.rgbaLayers += 1;
    return true;
  }

  /** Grow the class page's arrays (×1.5 under ST5, ×2 otherwise — the atlas's
   *  own `_atlasGrowTargetFor`), copying the live prefix. A refused growth
   *  leaves the page EXACTLY as it was and the member routes legacy. */
  _grow(c, needed) {
    const target = _atlasGrowTargetFor(c.allocLayers, needed, c.capacity);
    if (target <= c.allocLayers) return false;
    const w = c.w;
    const h = c.h;
    const rgbaStride = w * h * 4;
    let newDiff = null;
    let newNra = null;
    try {
      if (c.bc7) {
        const chain = c.arrays.diff.mipmaps.length > 1;
        newDiff = makeBc7ArrayTexture(w, h, target,
          chain ? { mipChain: true, anisotropy: c.arrays.diff.anisotropy } : {});
        for (let li = 0; li < c.arrays.diff.mipmaps.length; li += 1) {
          const src = c.arrays.diff.mipmaps[li];
          const st = bc7LevelBytes(src.width, src.height);
          newDiff.mipmaps[li].data.set(src.data.subarray(0, c.allocLayers * st), 0);
        }
      } else {
        newDiff = buildDiffuseArray([], w, h, target);
        newDiff.image.data.set(c.arrays.diff.image.data.subarray(0, c.allocLayers * rgbaStride), 0);
      }
      if (c.arrays.nra) {
        newNra = buildNraArray(w, h, target);
        newNra.image.data.set(c.arrays.nra.image.data.subarray(0, c.allocLayers * rgbaStride), 0);
      }
    } catch (_) {
      try { newDiff && newDiff.dispose && newDiff.dispose(); } catch (__) { /* fail-soft */ }
      try { newNra && newNra.dispose && newNra.dispose(); } catch (__) { /* fail-soft */ }
      this.stats.layerGrowFails += 1;
      return false;
    }
    for (let i = 0; i < c.nextLayer; i += 1) {
      if (typeof newDiff.addLayerUpdate === "function") newDiff.addLayerUpdate(i);
      if (newNra && typeof newNra.addLayerUpdate === "function") newNra.addLayerUpdate(i);
    }
    const oldDiff = c.arrays.diff;
    const oldNra = c.arrays.nra;
    c.arrays.diff = newDiff;
    c.arrays.nra = newNra;
    c.allocLayers = target;
    newDiff.needsUpdate = true;
    if (newNra) newNra.needsUpdate = true;
    // Re-point the live uniform objects (three keeps
    // materialProperties.uniforms === parameters.uniforms), then dispose.
    const u = c.material && c.material.userData && c.material.userData._statArrayUniforms;
    if (u) {
      if (u.uDiffuseArray) u.uDiffuseArray.value = newDiff;
      if (u.uNraArray) u.uNraArray.value = newNra;
    }
    try { oldDiff && oldDiff.dispose && oldDiff.dispose(); } catch (_) { /* fail-soft */ }
    try { oldNra && oldNra.dispose && oldNra.dispose(); } catch (_) { /* fail-soft */ }
    this.stats.layerGrows += 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// geometry normalization (the per-member `aLayer` stamp)
// ---------------------------------------------------------------------------

/**
 * Normalize a member geometry to exactly {position, normal, uv, aLayer} with an
 * index, so every geometry in a pool has the SAME attribute set (BatchedMesh
 * fixes the layout at the first `addGeometry`).
 *
 * Unlike the atlas's `normalizeForMerge` this KEEPS the index (pass-4's whole
 * point: R = 1.13 verts/tri, and BatchedMesh reserves index space per pool) and
 * synthesises a sequential one when the source is non-indexed, so an indexed
 * HBG1 bundle and a legacy de-indexed decode can share a pool.
 *
 * IT ALSO COMPACTS (ENVCELL-POOL-SWAP). The T13 `cellToGeometryGroups` /
 * `bundleToGeometryGroups` shape is N per-surface groups whose position/normal/
 * uv attributes are the SAME whole-entry vertex-stream views, each with its own
 * compact index (`geom_bundles.js:290-370`). Cloning those attributes per group
 * would put the WHOLE cell's vertex stream into the pool once per surface — a
 * cell with 8 surfaces costs 8× its vertices, and BatchedMesh reserves that
 * capacity per geometry. That is the same "shared streams are not slabs" trap
 * `cell_fusion.js` exists for (the E1-DIRTY fracture), here paying in memory
 * instead of pixels. So an indexed source is REMAPPED to exactly the vertices
 * its own index references, in first-use order, and the index is rewritten.
 *
 * `acBakedLight` rides along when the source carries it (the interior bake —
 * the class key's `k` bit makes that class-uniform, and the caller guarantees
 * every member of a baked class carries the attribute; BatchedMesh fixes the
 * attribute set at the first `addGeometry`).
 *
 * @returns {THREE.BufferGeometry|null} a NEW geometry owned by the caller
 */
export function normalizeForPool(geom, layer) {
  if (!geom || !geom.attributes) return null;
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  const uv = geom.attributes.uv;
  if (!pos || !nor || !uv) return null;
  const baked = geom.getAttribute ? geom.getAttribute("acBakedLight") : null;
  const g = new THREE.BufferGeometry();

  if (geom.index) {
    const src = geom.index.array;
    const idxCount = geom.index.count;
    const srcVerts = pos.count;
    const remap = new Int32Array(srcVerts).fill(-1);
    // Two passes: number the referenced vertices in first-use order, then copy.
    let kept = 0;
    for (let i = 0; i < idxCount; i += 1) {
      const v = src[i];
      if (remap[v] < 0) { remap[v] = kept; kept += 1; }
    }
    const outIdx = kept > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
    for (let i = 0; i < idxCount; i += 1) outIdx[i] = remap[src[i]];
    const oPos = new Float32Array(kept * 3);
    const oNor = new Float32Array(kept * 3);
    const oUv = new Float32Array(kept * 2);
    const oBaked = baked ? new Uint8Array(kept * 3) : null;
    for (let v = 0; v < srcVerts; v += 1) {
      const d = remap[v];
      if (d < 0) continue;
      oPos[d * 3] = pos.getX(v); oPos[d * 3 + 1] = pos.getY(v); oPos[d * 3 + 2] = pos.getZ(v);
      oNor[d * 3] = nor.getX(v); oNor[d * 3 + 1] = nor.getY(v); oNor[d * 3 + 2] = nor.getZ(v);
      oUv[d * 2] = uv.getX(v); oUv[d * 2 + 1] = uv.getY(v);
      if (oBaked) {
        // The bake is stored NORMALISED u8 (adapter.js RND-04), so read the
        // RAW bytes — `getX` would hand back the 0..1 decode.
        const a = baked.array;
        oBaked[d * 3] = a[v * 3];
        oBaked[d * 3 + 1] = a[v * 3 + 1];
        oBaked[d * 3 + 2] = a[v * 3 + 2];
      }
    }
    g.setAttribute("position", new THREE.BufferAttribute(oPos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(oNor, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(oUv, 2));
    g.setAttribute("aLayer", new THREE.BufferAttribute(new Float32Array(kept).fill(layer), 1));
    if (oBaked) g.setAttribute("acBakedLight", new THREE.BufferAttribute(oBaked, 3, true));
    g.setIndex(new THREE.BufferAttribute(outIdx, 1));
    return g;
  }

  g.setAttribute("position", pos.clone());
  g.setAttribute("normal", nor.clone());
  g.setAttribute("uv", uv.clone());
  const cnt = pos.count;
  g.setAttribute("aLayer", new THREE.BufferAttribute(new Float32Array(cnt).fill(layer), 1));
  if (baked) g.setAttribute("acBakedLight", baked.clone());
  const arr = cnt > 65535 ? new Uint32Array(cnt) : new Uint16Array(cnt);
  for (let i = 0; i < cnt; i += 1) arr[i] = i;
  g.setIndex(new THREE.BufferAttribute(arr, 1));
  return g;
}
