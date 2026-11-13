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
  nraSourceResEnabled,
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
  makeBc7Texture,
  writeBc7ArrayLayer,
  bc7LevelBytes,
  texCompressedOnlyActive,
  materialRsId,
  bc7AlphaFloor,
  clipAlphaCutOf,
  bc7ClipAlphaGuardEnabled,
  bc7Source,
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
import { applyBakedVertexLightPatch, VERTEX_BAKE, heightTexForMaterial, installCsmShaderPatch, VFX_GLOBALS, installVfxComponentPatch } from "./materials.js";
import { windSwayGpu } from "./vfx/components/windSwayGpu.js";
import { ensureVfxHashVarying } from "./vfx/per_instance.js";
import { registerLuminousMaterial } from "./luminous_night.js";

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

/**
 * POOL-PAGE-UPLOAD (2026-10-25): queue ONE layer of a class page for the GPU. three sends a texture
 * only when its version moves, and with `layerUpdates` non-empty it sends just those layers
 * (texSubImage3D / compressedTexSubImage3D). The writes below marked the layer but never moved the
 * version, so after a page's first upload every later admit and every refeed rewrite stayed on the
 * CPU (measured on the 1070: diffuse layers written-but-unsent for a whole session). The atlas's
 * `touchedDiff`/`touchedNra` flush (static_atlas.js) is the same rule, batched per feed; several
 * marks before a draw cost one upload here too.
 */
function _queueLayerUpload(arr, layer) {
  if (!arr) return;
  if (typeof arr.addLayerUpdate === "function") arr.addLayerUpdate(layer);
  arr.needsUpdate = true;
}

/** Disable hardware mipmap auto-generation on DataArrayTexture NRA pages:
 *  Three.js r184 DataArrayTexture partial layer uploads (addLayerUpdate) with
 *  generateMipmaps=true either re-mip the entire array or emit GL_INVALID_VALUE (1281). */
function _noMipNra(arr) {
  if (!arr) return arr;
  arr.generateMipmaps = false;
  arr.minFilter = THREE.LinearFilter;
  return arr;
}

const _VFX_HASH_PRELUDE = { id: "infra.vfxHash", inject: (s) => ensureVfxHashVarying(s) };

function _texHasCutout(tex, mat) {
  if (!bc7ClipAlphaGuardEnabled() || !tex || !mat) return false;
  const cut = clipAlphaCutOf(mat);
  if (!(cut > 0)) return false;
  if (tex.isCompressedTexture && Array.isArray(tex.mipmaps) && tex.mipmaps[0]?.data) {
    const floor = bc7AlphaFloor({ width: tex.mipmaps[0].width, height: tex.mipmaps[0].height, levels: tex.mipmaps }, cut);
    return floor >= 0 && floor < cut;
  }
  const d = tex.image && tex.image.data;
  if (d && typeof d.length === "number") {
    for (let i = 3; i < d.length; i += 4) if (d[i] < cut) return true;
  }
  return false;
}

function _bc7LostCutout(tex, mat) {
  if (!bc7ClipAlphaGuardEnabled() || !tex || !mat || !tex.isCompressedTexture) return false;
  const cut = clipAlphaCutOf(mat);
  if (!(cut > 0)) return false;
  if (!Array.isArray(tex.mipmaps) || !tex.mipmaps[0]?.data) return false;
  const floor = bc7AlphaFloor({ width: tex.mipmaps[0].width, height: tex.mipmaps[0].height, levels: tex.mipmaps }, cut);
  return floor >= cut;
}

/**
 * POOL-NRA-SOURCE-RES (2026-10-26) — the nra page is sized at its SOURCES' resolution, the rule the
 * atlas has had since memory-1 (static_atlas.js header, `?nraSourceRes`, owner-approved). The page
 * used to be the class's diffuse dims, and under the chain the diffuse is the x4 BC7 full tier while
 * every plane `packNraLayer` reads is smaller: the worker normal is half that tier, the seam height
 * and the texchan roughness/AO are DAT size. `_liftChannel` filled each layer with 2x2 / 4x4
 * nearest-neighbour copies of every real texel — 4x the bytes to pack on the main thread, to send
 * (`texSubImage3D`, up to 16 MiB per 2048² layer) and to re-mip (three's `generateMipmap` runs over
 * the WHOLE array on every upload), and blocky relief up close where the singleton filters the real
 * texels. No shader change: every nra sample is `textureGrad` in normalized UV, so the array's own
 * size picks its own mip (the same reason the atlas could shrink its layers).
 *
 * A class page has ONE material, so it cannot split by nra size the way the atlas buckets do
 * (`|n<w>x<h>`). Instead the page holds the per-axis MAX of its members' asks and grows when a
 * larger member arrives (`_fitNra`), repacking every live layer from its retained material. It never
 * shrinks and never stores a plane below its own size; a member with smaller planes is lifted up,
 * as every member was before. Capacity and growth keep the page-dims arithmetic, so no class holds
 * more bytes than it did. `?nraSourceRes=off` asks for the page itself: the old sizing exactly.
 */
function _texDims(tex) {
  const img = tex && tex.image;
  const w = img ? img.width | 0 : 0;
  const h = img ? img.height | 0 : 0;
  return w > 0 && h > 0 ? [w, h] : null;
}
// The packer's own fallback for a normal / height plane the material does not carry: the wasm decode
// memo, asked the way `_texChannel` (static_atlas.js) asks it.
function _memoDims(plane, did) {
  if (!did) return null;
  const p = planeFor({ map: null, normalMap: null, roughnessMap: null, aoMap: null }, plane, did);
  return p && p.width > 0 && p.height > 0 ? [p.width | 0, p.height | 0] : null;
}
/** The nra size a member's planes ask for, clamped to the page; null when it carries none (a flat
 *  layer is exact at any size). Exported for the regression suite. */
export function _nraAskFor(mat, w, h) {
  if (!nraSourceResEnabled()) return { w, h };
  if (!mat) return null;
  const did = mat.userData?.surfaceDid >>> 0;
  let nw = 0;
  let nh = 0;
  for (const d of [
    _texDims(mat.normalMap) || _memoDims(PLANE.NORMAL, did),
    _texDims(heightTexForMaterial(mat)) || _memoDims(PLANE.HEIGHT, did),
    _texDims(mat.roughnessMap),
    _texDims(mat.aoMap),
  ]) {
    if (!d) continue;
    if (d[0] > nw) nw = d[0];
    if (d[1] > nh) nh = d[1];
  }
  if (!nw || !nh) return null;
  return { w: Math.min(w, nw), h: Math.min(h, nh) };
}

export class ClassMaterialRegistry {
  /**
   * @param {object} deps
   * @param {(m:string,d?:any)=>void} [deps.warn]
   * @param {object} [deps.csmState]
   * @param {object} [deps.stager]
   * @param {boolean} [deps.preSizeBc7Nra]
   */
  constructor({ warn, csmState, stager = null, preSizeBc7Nra = false } = {}) {
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };
    this.csmState = csmState ?? null;
    this.stager = stager || null;
    this.preSizeBc7Nra = preSizeBc7Nra === true;
    this._nraPending = [];
    /** classKey -> class page record */
    this.classes = new Map();
    this.stats = {
      classes: 0,
      layerAllocs: 0, layerHits: 0, layerRecycles: 0, layerGrows: 0, layerGrowFails: 0,
      bc7Layers: 0, rgbaLayers: 0, nraLayers: 0, nraRepacks: 0, nraPendingDropped: 0, nraResizes: 0, nraResizeFails: 0,
      refeedDimMismatch: 0, refeedFormatMismatch: 0, refeedAlphaVetoed: 0,
      refused: { noTexture: 0, needsResample: 0, offPage: 0, bc7Pending: 0, deformed: 0, layerFull: 0, layerWriteFail: 0, noPixels: 0 },
      allocatedBytes: 0,
    };
  }

  _stageDiff(arr, rsId, bytes) {
    if (!this.stager || !arr || typeof this.stager.enqueueTexture !== "function") return;
    this.stager.enqueueTexture({ texture: arr, rsId: rsId >>> 0, cls: "U-TEX", bytes: bytes | 0 });
  }

  _stageNra(arr, bytes) {
    if (!this.stager || !arr || typeof this.stager.enqueueTexture !== "function") return;
    this.stager.enqueueTexture({ texture: arr, rsId: 0, cls: "U-NRA", bytes: bytes | 0 });
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
    // MECH-B vertex-deformed variants (e.g. `deformation.windSwayGpu`) are
    // refused so swaying trees route through cross-LB `static_batch_x` /
    // `InstancedMesh` without opening duplicate 2048² BC7 array pages.
    const setKey = material.userData && material.userData.__vfxSetKey;
    if (typeof setKey === "string" && setKey.length > 0) {
      return this._refuse(REFUSE.DEFORMED);
    }
    // A surface whose BC7 verdict is still in flight cannot be committed: the
    // page's format and dims are fixed by texStorage3D at allocation.
    if (bc7AtlasShouldDefer(material)) return this._refuse(REFUSE.BC7_PENDING);
    // THE PAGE-RESAMPLE AUTHORITY. `rec.texOffPage` is stamped by the producer
    // when TEXREF declares dims that differ from the ones currently on the
    // GPU: such a member's dims WILL move when its full tier lands, so a page
    // layer taken now pins it to the wrong page for the session.
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
      const rsHit = materialRsId(material) >>> 0;
      if (rsHit && this.stager && typeof this.stager.isStaged === "function" && !this.stager.isStaged(rsHit)) {
        if (!hit.rsId || this.stager.isStaged(hit.rsId)) {
          if (typeof this.stager.markStaged === "function") this.stager.markStaged(rsHit);
        } else if (typeof this.stager.enqueueRepoint === "function") {
          this.stager.enqueueRepoint(hit.rsId, () => {
            if (typeof this.stager.markStaged === "function") this.stager.markStaged(rsHit);
          });
        }
      }
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
    const rsId = materialRsId(material);
    if (!this._writeLayer(c, layer, tex, material, rsId)) {
      c.freeLayers.push(layer);
      return this._refuse(REFUSE.LAYER_WRITE);
    }
    const entry = {
      layer,
      refs: 1,
      rsId,
      mat: material,
      hadCutout: _texHasCutout(tex, material),
    };
    c.layerOf.set(uuid, entry);
    this.stats.layerAllocs += 1;
    // X5 — the nra layer is packed from THIS member's material (first member of
    // a deduped surface only, exactly like the diffuse pixels).
    if (c.arrays.nra) {
      try {
        this._fitNra(c, material);
        packNraLayer(c.arrays.nra, layer, material, c.nw, c.nh, null);
        _queueLayerUpload(c.arrays.nra, layer);
        this._stageNra(c.arrays.nra, c.nw * c.nh * 4);
        this.stats.nraLayers += 1;
        // Phase-5 texchan roughness/AO and worker ST5 normal+height attach
        // asynchronously; queue a re-pack keyed by entry/rsId so BC7 map UUID
        // upgrades never orphan pending NRA relief!
        if (!material.normalMap || !material.roughnessMap || (!heightTexForMaterial(material) && !material.aoMap)) {
          this._nraPending.push({
            c,
            layer,
            mat: material,
            rsId,
            entry,
            hadNormalAtAdmit: !!(material.normalMap || heightTexForMaterial(material)),
            tries: 0,
          });
        }
      } catch (_) { /* fail-soft: the flat texel shades like albedo-only v1 */ }
    }
    return { ok: true, layer };
  }

  /**
   * Release one reference to a member's layer.
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
          // Even when diffuse stays at PVW page dims, the ST5 upgrade may have
          // attached worker normal+height maps onto `mat` — repack NRA so
          // buildings/statics still gain relief!
          if (c.arrays.nra && (mat.normalMap || heightTexForMaterial(mat))) {
            try {
              this._fitNra(c, mat);
              packNraLayer(c.arrays.nra, e.layer, mat, c.nw, c.nh, null);
              _queueLayerUpload(c.arrays.nra, e.layer);
              this._stageNra(c.arrays.nra, c.nw * c.nh * 4);
              this.stats.nraRepacks += 1;
            } catch (_) { /* fail-soft */ }
          }
          continue;
        }
        if ((isBc7AtlasTexture(tex) === true) !== c.bc7) {
          this.stats.refeedFormatMismatch += 1;
          continue;
        }
        // Guard BC7 full-tier (`tex-xu7`) promotion for cutout/transparent classes:
        // if the admitted PVW layer had cutout alpha (`floor < cut`) and the
        // upgraded texture lost it (`floor >= cut`), keep PVW and try `hbc7Fallback(rs)`.
        if (e.hadCutout && _bc7LostCutout(tex, mat)) {
          this.stats.refeedAlphaVetoed += 1;
          this._tryHbc7Rescue(rs, mat, c);
          continue;
        }
        if (!this._writeLayer(c, e.layer, tex, mat, rs)) continue;
        if (_texHasCutout(tex, mat)) e.hadCutout = true;
        if (c.arrays.nra) {
          try {
            this._fitNra(c, mat);
            packNraLayer(c.arrays.nra, e.layer, mat, c.nw, c.nh, null);
            _queueLayerUpload(c.arrays.nra, e.layer);
            this._stageNra(c.arrays.nra, c.nw * c.nh * 4);
            this.stats.nraRepacks += 1;
          } catch (_) { /* fail-soft: the layer keeps its admit-time texels */ }
        }
        c.layerOf.delete(uuid);
        c.layerOf.set(tex.uuid, e);
        n += 1;
      }
    }
    return n;
  }

  _tryHbc7Rescue(rs, mat, c) {
    try {
      const src = bc7Source();
      if (!src || typeof src.hbc7Fallback !== "function" || mat.userData?.__poolHbc7RescueTried) return;
      mat.userData = mat.userData || {};
      mat.userData.__poolHbc7RescueTried = true;
      Promise.resolve(src.hbc7Fallback(rs)).then((twin) => {
        if (!twin || twin.texDropped || !Array.isArray(twin.levels)) return;
        const cut = clipAlphaCutOf(mat);
        const floor = bc7AlphaFloor(twin, cut);
        if (cut > 0 && floor >= 0 && floor >= cut) return;
        const chain = c && c.arrays.diff && c.arrays.diff.mipmaps.length > 1;
        const rescued = makeBc7Texture(twin, chain ? { mipChain: true, anisotropy: getAdapterMaxAnisotropy() } : {});
        if (!rescued) return;
        rescued.wrapS = mat.map?.wrapS ?? THREE.RepeatWrapping;
        rescued.wrapT = mat.map?.wrapT ?? THREE.RepeatWrapping;
        mat.map = rescued;
        this.refeedRsId(rs);
      }).catch(() => {});
    } catch (_) { /* fail-soft */ }
  }

  _resolvePendingEntry(p) {
    if (!p || !p.c || !p.c.layerOf) return null;
    const byUuid = p.mat?.map?.uuid ? p.c.layerOf.get(p.mat.map.uuid) : null;
    if (byUuid && byUuid.layer === p.layer) return byUuid;
    if (p.entry && p.entry.refs > 0 && p.entry.layer === p.layer) {
      for (const v of p.c.layerOf.values()) if (v === p.entry) return p.entry;
    }
    if (p.rsId > 0) {
      for (const v of p.c.layerOf.values()) {
        if (v.rsId === p.rsId && v.layer === p.layer) return v;
      }
    }
    return null;
  }

  drainNraPending() {
    if (!this._nraPending || this._nraPending.length === 0) return 0;
    const _NRA_PENDING_TRIES = 600;
    const touched = new Set();
    let repacked = 0;
    for (let i = this._nraPending.length - 1; i >= 0; i -= 1) {
      const p = this._nraPending[i];
      const cur = this._resolvePendingEntry(p);
      if (!cur) {
        this._nraPending.splice(i, 1);
        continue;
      }
      const mat = cur.mat || p.mat;
      const texchanReady = !!(mat?.roughnessMap && (heightTexForMaterial(mat) || mat?.aoMap));
      const normalArrived = !p.hadNormalAtAdmit && !!(mat?.normalMap || heightTexForMaterial(mat));
      const expired = ++p.tries > _NRA_PENDING_TRIES;
      if (!texchanReady && !normalArrived && !expired) continue;
      const any = !!(mat?.normalMap || mat?.roughnessMap || mat?.aoMap || heightTexForMaterial(mat));
      if (any && p.c.arrays.nra) {
        try {
          this._fitNra(p.c, mat);
          packNraLayer(p.c.arrays.nra, p.layer, mat, p.c.nw, p.c.nh, null);
          _queueLayerUpload(p.c.arrays.nra, p.layer);
          this._stageNra(p.c.arrays.nra, p.c.nw * p.c.nh * 4);
          this.stats.nraRepacks += 1;
          repacked += 1;
          touched.add(p.c.arrays.nra);
        } catch (_) { /* fail-soft */ }
        if (normalArrived && !texchanReady && !expired) {
          p.hadNormalAtAdmit = true;
          continue;
        }
      } else {
        this.stats.nraPendingDropped = (this.stats.nraPendingDropped || 0) + 1;
      }
      this._nraPending.splice(i, 1);
    }
    for (const t of touched) t.needsUpdate = true;
    return repacked;
  }

  census() {
    const byClass = {};
    let allocated = 0;
    let used = 0;
    for (const [k, c] of this.classes) {
      const per = _perLayerBytesFor(c.w, c.h, c.bc7, c.nw, c.nh);
      allocated += per * c.allocLayers;
      used += per * (c.nextLayer - c.freeLayers.length);
      byClass[k] = {
        w: c.w, h: c.h, nw: c.arrays.nra ? c.nw : 0, nh: c.arrays.nra ? c.nh : 0,
        bc7: c.bc7, layers: c.layerOf.size, alloc: c.allocLayers, capacity: c.capacity,
      };
    }
    return {
      classes: this.classes.size,
      pageBytes: { allocated, used },
      nraPending: this._nraPending.length,
      layers: {
        allocs: this.stats.layerAllocs, hits: this.stats.layerHits,
        recycles: this.stats.layerRecycles, grows: this.stats.layerGrows,
        growFails: this.stats.layerGrowFails, nra: this.stats.nraLayers,
        nraRepacks: this.stats.nraRepacks, nraPendingDropped: this.stats.nraPendingDropped,
        nraResizes: this.stats.nraResizes, nraResizeFails: this.stats.nraResizeFails,
        refeedDimMismatch: this.stats.refeedDimMismatch,
        refeedFormatMismatch: this.stats.refeedFormatMismatch,
        refeedAlphaVetoed: this.stats.refeedAlphaVetoed,
      },
      refused: { ...this.stats.refused },
      byClass,
    };
  }

  dispose() {
    this._nraPending.length = 0;
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
    // POOL-NRA-SOURCE-RES: pre-size BC7 class NRA to the worker's half-res
    // target (capped at 512) when `preSizeBc7Nra` is armed so ST5 NRA arrivals
    // never trigger mid-stream `_resizeNra` reallocations.
    const ask = statNraEnabled() ? _nraAskFor(material, w, h) : null;
    const preSize = this.preSizeBc7Nra && bc7 && texCompressedOnlyActive() && statNraEnabled() && nraSourceResEnabled();
    const defNw = preSize ? Math.min(512, Math.min(w, Math.max(64, w >> 1))) : 1;
    const defNh = preSize ? Math.min(512, Math.min(h, Math.max(64, h >> 1))) : 1;
    const nw = ask ? Math.max(defNw, ask.w) : defNw;
    const nh = ask ? Math.max(defNh, ask.h) : defNh;
    let diff = null;
    let nra = null;
    try {
      diff = bc7
        ? makeBc7ArrayTexture(w, h, alloc,
            texCompressedOnlyActive() ? { mipChain: true, anisotropy: getAdapterMaxAnisotropy() } : {})
        : buildDiffuseArray([], w, h, alloc);
      nra = statNraEnabled() ? _noMipNra(buildNraArray(nw, nh, alloc)) : null;
    } catch (e) {
      try { diff && diff.dispose && diff.dispose(); } catch (_) { /* fail-soft */ }
      this.warn(`[drawPools] class page allocation refused for ${classKey}`, e);
      return null;
    }
    const arrays = { diff, nra };
    const csm = this.csmState !== undefined ? this.csmState : (material?.userData?.csmState ?? globalThis.window?.liveScene3d?.csmState ?? globalThis.__hbCsmState ?? null);
    const material2 = makeArrayMaterial(diff, stateKey, nra, arrays, csm);
    if (csm && !material2.userData?.csmEnabled) {
      const atlasKey = material2.customProgramCacheKey;
      installCsmShaderPatch(material2, csm);
      material2.customProgramCacheKey = typeof atlasKey === "function"
        ? () => `${atlasKey()}|c2`
        : material2.customProgramCacheKey;
    }
    // The class material carries its own identity so the census, the prewarm
    // and devtools all join on the same string.
    material2.name = `pool-class-${classKey}`;
    material2.userData = { ...(material2.userData || {}), __poolClassMat: true, classKey };

    // Preserve `sfLuminosity` / night-lit window & canopy emissive on pooled classes!
    const lum = +(material?.userData?.__surfaceLuminosity ?? (material?.emissiveMap ? material.emissiveIntensity : 0)) || 0;
    if (lum > 0) {
      material2.emissive = new THREE.Color(0xffffff);
      material2.emissiveIntensity = Math.min(2.0, lum);
      material2.userData.__surfaceLuminosity = lum;
      const prevCompile = material2.onBeforeCompile;
      material2.onBeforeCompile = function (shader, renderer) {
        if (typeof prevCompile === "function") prevCompile.call(this, shader, renderer);
        if (shader.fragmentShader && !shader.fragmentShader.includes("/* hb_pool_lum */")) {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n\t/* hb_pool_lum */ totalEmissiveRadiance *= diffuseColor.rgb;",
          );
        }
      };
      const prevKey = material2.customProgramCacheKey;
      const boundPrev = typeof prevKey === "function" ? prevKey.bind(material2) : null;
      material2.customProgramCacheKey = boundPrev ? () => `${boundPrev()}|m1` : () => `${classKey}|m1`;
      registerLuminousMaterial(material2, lum);
    }

    // ENVCELL-POOL-SWAP — THE INTERIOR BAKE. Installed LAST so customProgramCacheKey
    // composes over every preceding patch.
    if (material && material.userData && material.userData.__acBakedLight === true) {
      const atlasKey = material2.customProgramCacheKey;
      applyBakedVertexLightPatch(material2, { suppressDirect: VERTEX_BAKE.suppressDirect });
      const composed = typeof atlasKey === "function" ? atlasKey.bind(material2) : null;
      material2.customProgramCacheKey = composed
        ? () =>
            `${composed()}|k1${VERTEX_BAKE.suppressDirect ? "s" : ""}` +
            `${material2.userData && material2.userData.__acBakedDirectOut ? "d" : ""}`
        : material2.customProgramCacheKey;
      material2.userData.__poolClassBaked = true;
    }
    // D-07.6: shadow flags become POOL-uniform, and the class key already
    // carries them, so the material's own shadow-side settings are class-wide.
    c = {
      classKey, w, h, nw, nh, bc7, stateKey, arrays, material: material2,
      layerOf: new Map(), freeLayers: [], nextLayer: 0,
      allocLayers: alloc, capacity,
    };
    this.classes.set(classKey, c);
    this.stats.classes += 1;
    return c;
  }

  _writeLayer(c, layer, tex, material, rsId = 0) {
    const w = c.w;
    const h = c.h;
    if (c.bc7) {
      const chain = c.arrays.diff.mipmaps.length > 1;
      const ok = writeBc7ArrayLayer(c.arrays.diff, layer, {
        width: w,
        height: h,
        levels: chain ? tex.mipmaps : [{ data: tex.mipmaps?.[0]?.data, width: w, height: h }],
      });
      if (ok) {
        this.stats.bc7Layers += 1;
        _queueLayerUpload(c.arrays.diff, layer);
        this._stageDiff(c.arrays.diff, rsId, bc7LevelBytes(w, h));
      }
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
    _queueLayerUpload(c.arrays.diff, layer);
    this._stageDiff(c.arrays.diff, rsId, stride);
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
        newNra = _noMipNra(buildNraArray(c.nw, c.nh, target));
        newNra.image.data.set(c.arrays.nra.image.data.subarray(0, c.allocLayers * c.nw * c.nh * 4), 0);
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
    this._stageDiff(newDiff, 0, _perLayerBytesFor(w, h, c.bc7, 0, 0) * c.nextLayer);
    if (newNra) this._stageNra(newNra, c.nw * c.nh * 4 * c.nextLayer);
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

  /** POOL-NRA-SOURCE-RES: grow the class's nra page to cover `mat`'s ask (see `_nraAskFor`).
   *  Returns true when the page was re-allocated. */
  _fitNra(c, mat) {
    const ask = _nraAskFor(mat, c.w, c.h);
    if (!ask || (ask.w <= c.nw && ask.h <= c.nh)) return false;
    return this._resizeNra(c, Math.max(c.nw, ask.w), Math.max(c.nh, ask.h));
  }

  /** Re-allocate the nra page at (nw, nh) and repack every live layer from its retained material
   *  (the same source `refeedRsId` reads). A refused allocation leaves the page EXACTLY as it was;
   *  the caller then packs at the old size, lifted as before. */
  _resizeNra(c, nw, nh) {
    let next = null;
    try {
      next = _noMipNra(buildNraArray(nw, nh, c.allocLayers));
    } catch (_) {
      this.stats.nraResizeFails += 1;
      return false;
    }
    for (const e of c.layerOf.values()) {
      try { packNraLayer(next, e.layer, e.mat, nw, nh, null); } catch (_) { /* fail-soft: the flat texel */ }
      if (typeof next.addLayerUpdate === "function") next.addLayerUpdate(e.layer);
    }
    const old = c.arrays.nra;
    c.arrays.nra = next;
    c.nw = nw;
    c.nh = nh;
    next.needsUpdate = true;
    this._stageNra(next, nw * nh * 4 * c.layerOf.size);
    const u = c.material && c.material.userData && c.material.userData._statArrayUniforms;
    if (u && u.uNraArray) u.uNraArray.value = next;
    try { old && old.dispose && old.dispose(); } catch (_) { /* fail-soft */ }
    this.stats.nraResizes += 1;
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

/** Convenience helper for draining pending async NRA repacks. */
export function drainPoolNraPending(registry) {
  return registry?.drainNraPending?.() ?? 0;
}
