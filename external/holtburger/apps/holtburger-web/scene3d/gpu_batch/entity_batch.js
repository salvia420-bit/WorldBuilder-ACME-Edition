// scene3d/gpu_batch/entity_batch.js — R3-4 stage A: `?entityBatch` (DEFAULT
// OFF; `=on` opt-in), entity part-surfaces drawn as batched kit draws
// (docs/2026-10-29-round3-gpu-driven.md §R3-4; lane design
// r3-batching/r3-4/design.md). The kit's second consumer; the first one,
// anim_scenery_batch.js, is the worked example this file copies (status
// machine, upload-budget contract, class-program warm protocol, overlap,
// GL-context generations).
//
// TODAY one THREE.Mesh per (part, surface) — a "leaf" under the part Group of
// an entity rig — and one draw each: 285 draws a frame at Holtburg (the
// 1070 census, 2026-10-30), a clothed human is 24.
//
// THE BATCH (one per qualifying entity):
//   - ONE InstancedMesh (count 1) under `inst.root`, one geometry GROUP per
//     run: a run is a contiguous range of leaves with the same (side, blend
//     class, shader chain, array signature, map page, normal page). Each
//     group is one draw with a kit class material (class_materials.js): the
//     map from a kit array page at the slot's layer, the per-surface
//     uniforms from the slot's layer-state row.
//   - The merged geometry (position / normal / uv / index of every batched
//     leaf, part-local, in run order) is SHARED per (setup, part swaps, leaf
//     run keys) across entities; each entity owns a light BufferGeometry that
//     references the shared attributes and adds two per-vertex Float32
//     attributes: `hbBatchSlot` (the kit state row of the leaf's material)
//     and `hbEntPart` (the leaf's PART ROW, 0 = collapsed).
//   - PART ROWS: one mat4 row per (entity, part) in a RowTexture owned here,
//     composed in JS from the posed part Group (position, quaternion, scale:
//     three's own updateMatrix arithmetic) at the frame's FIRST batch draw
//     (`onBeforeRender`, after every pose writer of the frame), uploaded with
//     one texSubImage2D for all entities. `#define instanceMatrix` (the kit's
//     instanceRedirectChunk) routes every three chunk and every chain patch
//     through the part row, so the vertex stage computes root x part x vertex
//     exactly as the legacy draw's modelView x vertex did, with the part x
//     root composition in f32 on the GPU (the plan's HOW change).
//   - PALETTE COMPOSITES are VALUE-KEYED layers: `pal:<did>:<h1h2>:<w>x<h>`
//     (two independent 32-bit hashes of the bytes three would upload, plus a
//     full-byte compare whenever a key is already live), admitted with
//     ArrayPages.admitPixels (a scratch configured exactly like
//     adapter.js surfacePixelsToTexture; the driver's mips, copied GPU-side).
//     Equal bytes under different subpalette lists share one layer; unequal
//     bytes never do. Plain cache textures use ArrayPages.admit (identity),
//     so they share layers with `?animSceneryBatch`.
//
// LEAVES STAY IN THE GRAPH ("Design A0"). A batched leaf keeps its parent,
// its material, its visibility and its matrices; only its `layers` mask moves
// to bit 31 ("parked"), which no camera and no raycaster enables, so three
// skips it in projectObject and in Raycaster.intersectObject. Everything else
// that walks the rig (Box3, traverse, children walks, dismember, limbs,
// ragdoll, carnage, selection brackets, the occlusion box, partDegrade, tex
// upgrades) sees today's rig. The batch mesh has an EMPTY object-level
// bounding box (Box3.expandByObject unions nothing for it) and a raycast
// facade that raycasts the parked leaves themselves (hits name the leaf, its
// parent is the part Group: picking.js's walk-up is unchanged).
//
// WHAT STAYS LEGACY (counted by reason in `__entityBatch.stats()`):
//   - whole entities: wireframe, shadows / CSM, weaponFx, `?visual` / itemFx
//     VFX plans, mapless (spawn race; polled until healed), live fade owners
//     (camera fade, object translucency, a material ramp tween whose value
//     moves, texture velocity, ethereal ghost under `?etherealGhost=on`;
//     polled), dismember / dislocate / ReplaceObject (for life), fewer than
//     two batchable leaves;
//   - single leaves (in the graph, unparked, drawn and sorted as today):
//     translucent / additive (retail's alpha list), luminous, any member a
//     kit class cannot reproduce (anim_scenery_batch.js unitArrayReason:
//     detail, CSM, baked light, VFX chains, extra maps other than the
//     texchan AO / roughness planes and the emissive alias, ...; POM and
//     those maps: `entityArrayReason`), animated surfaces, a non-identity
//     leaf transform, a geometry layout that does not merge, a layer mask
//     unlike the rest, a held item's root.
//
// MUTATIONS. TransparentPart (7) / Transparent (20) ramps are classified by
// VALUE before the clone getter runs (`routeRamp`): show (0 -> 0) clears and
// hide (1 -> 1, or a snap to 1) collapses the leaves of those surfaces (no
// clone; today's 0 -> 0 AFK ramp clones every surface of the entity); a real
// fade, a Luminous / Diffuse ramp, camera fade, object translucency,
// ethereal, texture velocity and selection flash DEMOTE the entity to its
// legacy leaves (unparked, pixel-identical) for their duration; a demoted
// entity keeps its batch resources and is re-promoted (polled) once every
// leaf material qualifies again. Equips (hot-swap) re-plan; dismember /
// ReplaceObject keep the entity legacy for life; any material swap the tick
// mirror sees on a batched leaf demotes it in that tick. A batch-only hide
// or show never outlives the batch: every exit (demote, re-plan, context
// reset, ReplaceObject) first writes it back as today's body would have left
// it (the clone at the ramp's value, and its tween while it would still run:
// a show's 0 -> 0 tween overwrites a camera fade / object translucency that
// starts inside it, as today; after a hot-swap only the running tween).
// Demotes count toward the re-plan limit (one forgiven per 1800 active
// frames).
//
// THE ORDER (anim_scenery_batch's): "admitting" (layers, state rows and part
// rows under the kit's per-frame upload budget; legacy on screen) ->
// "warming" (class programs registered with shader_prewarm.js and polled) ->
// "building" (the geometry charged with a DEFERRED spend in the sync that
// makes it visible; tickets landed by three's upload callbacks) -> "overlap"
// (the batch draws next to the legacy leaves until three has drawn every
// class material once; the same fragments) -> "active" (leaves parked).
//
// THE REAL BOOT (2026-10-31, laptop SwiftShader, Holtburg, 60 rigs). Fixes:
//   - LAYER KEYS are value keys over (bytes, page key): equal composites
//     share one layer across surface DIDs too (the page key carries the
//     sampler state, so equal bytes with another wrap never share). A
//     composite whose legacy texture three already holds is copied from that
//     texture's OWN levels (ArrayPages.admitAs: no scratch upload); else the
//     admitPixels scratch, as before. A layer costs exactly the legacy
//     texture's bytes (same format, same full mip chain).
//   - PAGE EXHAUSTION never refuses a rig: the kit pages reclaim idle-only
//     pages and fit a smaller page at the stated cap (kit.js
//     `?gpuBatchVramMB`, 128 MiB); a member still refused stays a legacy leaf
//     (the rest of the rig batches) and is re-tried every
//     ENTITY_BATCH_PAGEFULL_RETRY_FRAMES once the cap could take it; a rig
//     left with fewer than two leaves WAITS (`pageFull`, polled) instead of
//     going legacy for life. None of it counts toward the churn limit, and a
//     refused admit books no budget bytes.
//   - LAYERS ONLY FOR DRAWN LEAVES: a rig is admitted only while its root is
//     visible (a culled rig waits, `hidden`), and a rig hidden for
//     ENTITY_BATCH_HIDDEN_HOLD_FRAMES frees its batch (layers idle,
//     reclaimable) until it is seen again. Translucent / legacy leaves never
//     had layers.
//   - CONTEXT LOSS: one reset per transition (the loss, then the restore),
//     not one per tick while lost; a reset clears every page-derived
//     exclusion; each record re-plans at the first sync on the restored
//     generation (a per-record generation guard backs the canvas events), so
//     a rig is batched again within the admission frames its layers need.
//     `stats().context` (lost / restored / lostNow / frames since the reset)
//     and `stats().footprint` (cap, reserved, live, idle bytes) say which.
//
// POM PARTS (2026-10-31; realboot keys, Holtburg ultra: 52 part materials
// carry `hb|d0|c0|p1|l1|a0|b0|f0|s0|k0|v`, the MaterialCache base with
// materials.js's POM patch chained before its light clamp). A member whose
// program key differs from the kit's array pattern ONLY by `p1`
// (ENTITY_POM_CHAIN_KEY) is judged by its chain DRY RUN (class_materials.js
// chainFingerprintOf), not its key: a real POM chain of the shape the kit
// redirects batches with a POM class (class_materials.js "POM MEMBERS": the
// height map from a kit R8 page layer, the seven scalars from the slot's POM
// extension row, layer_state.js), a p1 flag without POM text batches as the
// chain it runs; everything else unitArrayReason checks is checked as for
// any member (`entityArrayReason`). Such a member's class program key and run
// key carry its chain fingerprint (`|pomc<id>`), so two chains behind one
// program key never share a program; a POM run splits by height page as by
// map page. A POM member needs its normal map (getTangentFrame); its height
// texture's re-upload re-plans like a map swap; a demoted rig whose members
// changed re-plans instead of adopting when a POM member is involved.
//
// AO / ROUGHNESS / EMISSIVE PARTS (2026-10-31; laptop real boot, Holtburg,
// `?entityBatch=on`: leafRoutes {map:aoMap 48, map:emissiveMap 2},
// extraMaps {aoMap+roughnessMap 47, aoMap+roughnessMap+emissiveMap 1,
// emissiveMap 2}). The model is interior_batch.js "AO / ROUGHNESS /
// EMISSIVE MEMBERS", on this consumer's rows. The texchan planes materials.js
// `_applyRough` attaches to a cache material (aoMap: R8 cavity AO at
// `aoMapIntensity`; roughnessMap: RGBA8 linear, the value in .g) and an
// emissiveMap that IS the member's map are accepted (`entityArrayReason`:
// unitArrayReason judges the member with those three maps hidden, so every
// other rule still applies; an AO / roughness plane a page cannot hold
// refuses `ao-map-format` / `roughness-map-format`). Everything else stays
// as it was: a luminous leaf (a non-black emissive: the luminous ladder's
// white emissive with its emissiveMap alias, a Luminous hook) stays legacy
// (`luminous`), an emissiveMap that is not the map stays `map:emissiveMap`,
// and lightMap / bumpMap / displacementMap / metalnessMap / alphaMap /
// envMap still route `map:<name>`. So an emissive member here has a black
// emissive (its emissive radiance is zero, as three's is). A member batches
// with a class of its MAP SET (class_materials.js "EXTRA-MAP MEMBERS": one
// class and program per set, `|xm<a|r|e>` on the program key, three's own
// aomap / roughnessmap / emissivemap chunks with the page samples
// substituted, A1-E2): the AO plane is a kit R8 page layer, the roughness
// plane an RGBA8 page layer (three's own uploads copied level by level), the
// emissive layer the map's own layer; the member's EXTENSION ROW (the POM
// row, now layer_state.js packExtState: POM half and map half, either zero)
// carries the layers, aoMapIntensity and the emissive uniform, rewritten
// every sync from the member. Run keys gain the set key and the AO /
// roughness page keys; runs and classes split by AO / roughness page as by
// map page and are keyed by the ROW's set (the planes the row admitted), so
// a run never mixes sets. Drift (`_memberDrift`): a plane that leaves, is
// swapped or re-uploads re-plans (`drift:map`, the map path and its limit);
// an emissive alias change is a `drift:luminous` demote (as before: the
// poll re-plans on the new run key); a plane that ARRIVES (texchan's async
// arm mutates the cache material in place) hands the rig back to legacy in
// that sync (`drift:ao-map-arrived` / `drift:roughness-map-arrived`) and
// re-plans it into the new set ENTITY_BATCH_MAP_SETTLE_FRAMES later (a burst
// is one re-plan), outside ENTITY_BATCH_REPLAN_LIMIT (arrivals happen once
// per member; ENTITY_BATCH_MAP_ARRIVAL_LIMIT bounds them per rig). A map
// member's layers + extension row are its own: a demoted rig re-plans
// instead of adopting when one is involved. The layers go through the same
// kit pages (budget, byte cap, demand-sized pages, page-full: the member
// stays a legacy leaf and is re-tried). Diag: `stats().mapMembers` (live
// rows by plane / set), `stats().mapLeaves` (batched leaves by extra-map set,
// counted per plan like `leafRoutes`; `extraMaps` counts the refused ones
// only), `stats().layers.{ao, roughness, emissive}`, `stats().mapArrivals`,
// `verify().mapMismatches` (the map half of every extension row, the planes
// each row samples, each run's class set).
//
// FLAG OFF: entities.js creates no EntityBatch and calls nothing here; this
// module allocates nothing at import (every structure is made in the
// constructor) and installs no listener or global.
//
// GLSL: this file writes none of its own (the kit's chunks only).

import * as THREE from "three";
import { rustFlag } from "../rust/scene_core.js";
import {
  kitBudget, kitBeginFrame, kitPages, kitStateTable, kitFlush, kitSummary, kitContextGeneration, kitLiveGeneration,
} from "./kit.js";
import {
  describeTexture, liveContextGeneration, trackContextGenerations, disposeOnLiveContext, LOST_CONTEXT_GENERATION,
  contentKeyOf, R8_PLANES,
} from "./array_pages.js";
import { pageKeyOf } from "./page_allocator.js";
import { UPLOAD_KIND, uploadNowMs } from "./upload_budget.js";
import { RowTexture, instanceRedirectChunk, injectVertexHeader, ROW_REDIRECT_MARKER } from "./row_texture.js";
import {
  makeClassMaterial, classKeyOf, classPrewarmProxy, classPatchMissing, dummyMap, SLOT_ATTR,
  chainFingerprintOf, pomStateOf, fnv1aHex, memberMapSet, MAP_SET_NONE, extraMapStateOf,
} from "./class_materials.js";
import {
  fillStateFromMaterial, blendClassOf, layerStateFromMaterial, packLayerState, packExtState, LAYER_STATE_FLOATS,
} from "./layer_state.js";
import {
  unitArrayReason, memberClass, memberProgramKey, memberChainHook, arraySignature,
  mergeGeometriesForBatch, mergedBytesOf, referencedVerticesOf,
} from "./anim_scenery_batch.js";
import { registerBatchClassPrewarm, prewarmBatchClasses, programsOf, programPending } from "../shader_prewarm.js";

// ===========================================================================
// Flag.
// ===========================================================================

let _flag = null;
/** `?entityBatch` (DEFAULT OFF): read once through rustFlag. */
export function entityBatchEnabled() {
  if (_flag === null) _flag = rustFlag("entityBatch", false);
  return _flag;
}
/** Test seam: true / false forces, undefined re-reads the URL. */
export function __setEntityBatchForTest(v) { _flag = v === undefined ? null : !!v; }

// ===========================================================================
// Constants.
// ===========================================================================

/**
 * The program keys a POM member may carry (header "POM PARTS"): the kit's
 * array pattern (anim_scenery_batch.js ARRAY_CHAIN_KEY) with `p1`.
 */
export const ENTITY_POM_CHAIN_KEY = /^hb\|d0\|c0\|p1\|l[01]\|a0\|b0\|f0\|s0\|k0\|v$/;
/** The layer a batched leaf is parked on: no camera and no raycaster enables it. */
export const ENTITY_PARK_LAYER = 31;
/** `Layers.set(31)`'s mask, as three r184 stores it (`(1 << layer | 0) >>> 0`: unsigned). */
export const ENTITY_PARK_MASK = ((1 << ENTITY_PARK_LAYER) | 0) >>> 0;
export const ENTITY_PART_ATTR = "hbEntPart";
export const ENTITY_PART_SAMPLER = "hbEntPartTex";
export const ENTITY_VERTEX_HOOK_KEY = "entPart1";
/** Demotes + re-plans an entity may take before it stays legacy (`unstable`). */
export const ENTITY_BATCH_REPLAN_LIMIT = 8;
/** One re-plan / demote is forgiven per this many frames spent active (the limit caps the churn RATE). */
export const ENTITY_BATCH_CHURN_FORGIVE_FRAMES = 1800;
/** Frames on screen in overlap without every class material drawn -> legacy `neverDrawn`. */
export const ENTITY_BATCH_OVERLAP_GIVEUP_FRAMES = 600;
/** Frames a class program that was never compiled (no camera) is waited for. */
export const ENTITY_BATCH_WARM_WAIT_FRAMES = 120;
/** Frames an entity waits for a renderer before it gives up (`noRenderer`). */
export const ENTITY_BATCH_RENDERER_WAIT_FRAMES = 300;
/** Re-qualify / re-promote poll period per entity (frames). */
export const ENTITY_BATCH_POLL_FRAMES = 15;
/** A demoted entity holds its batch resources this long, then frees them (still polled). */
export const ENTITY_BATCH_DEMOTE_HOLD_FRAMES = 1800;
/** Part-row texture: rows ever allowed (MAX_TEXTURE_SIZE on every WebGL2 target). */
export const ENTITY_PART_ROWS_MAX = 16384;
/** Idle merged-geometry entries kept (CPU arrays only): count and bytes. */
export const ENTITY_ENTRY_IDLE_MAX = 64;
export const ENTITY_ENTRY_IDLE_BYTES = 32 * 1024 * 1024;
/** The rig-cull radius entities.js uses (ENTITY_CULL_RADIUS): the batch sphere is never smaller. */
export const ENTITY_BATCH_MIN_RADIUS = 6;
/** An active rig with page-refused (legacy) leaves re-checks the cap this often (frames). */
export const ENTITY_BATCH_PAGEFULL_RETRY_FRAMES = 600;
/** A batched rig whose root stays hidden (culled) this long frees its batch (frames). */
export const ENTITY_BATCH_HIDDEN_HOLD_FRAMES = 1800;
/**
 * A texchan AO / roughness plane ARRIVING on a batched member (header "AO /
 * ROUGHNESS / EMISSIVE PARTS") hands the rig back to legacy at once and
 * re-plans it this many frames later (texchan's async arm lands one fetch at
 * a time: a burst is one re-plan). Arrivals happen once per member, so they
 * count toward ENTITY_BATCH_MAP_ARRIVAL_LIMIT per rig, not the churn limit.
 */
export const ENTITY_BATCH_MAP_SETTLE_FRAMES = 30;
export const ENTITY_BATCH_MAP_ARRIVAL_LIMIT = 64;
/** Reasons that keep an entity legacy for life when they demote it. */
// (Predicates, not Sets: the module allocates nothing at import.)
function _permanentDemote(reason) {
  switch (reason) {
    case "dismember": case "dislocate": case "corpseCarry": case "replaceObject":
    case "structure:dismember": case "structure:replaced": return true;
    default: return false;
  }
}
const _activeLike = (s) => s === "overlap" || s === "active";
const _buildingLike = (s) => s === "admitting" || s === "warming" || s === "building";

// ===========================================================================
// Pure helpers (exported for the node suites).
// ===========================================================================

/**
 * A TransparentPart (7) / Transparent (20) ramp by VALUE (the hook value is
 * TRANSLUCENCY: 0 = opaque, 1 = invisible). "show": it ends, and stays, at 0
 * (`start <= 0 && end <= 0`, or a snap `time <= 0` to `end <= 0`); "hide":
 * it ends, and stays, at 1 (`start >= 1 && end >= 1`, or a snap to
 * `end >= 1`); anything else is a "fade". With `?fadeAlphaParity` off only a
 * hide is exact (a show's legacy restore guesses `transparent`), so every
 * other ramp is a "fade".
 */
export function classifyTransparentRamp(start, end, time, parity = true) {
  const s = +start, e = +end, t = +time;
  const snap = !(t > 0);
  if ((s >= 1 && e >= 1) || (snap && e >= 1)) return "hide";
  if (!parity) return "fade";
  if ((s <= 0 && e <= 0) || (snap && e <= 0)) return "show";
  return "fade";
}

/**
 * Two independent 32-bit hashes of the first `n` bytes (FNV-1a over little-
 * endian 32-bit words, and a Murmur3-style mix with another seed), as
 * unsigned ints. Reads bytes, so any byteOffset is fine.
 */
export function hashRgbaBytes(bytes, n) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9747b28c | 0;
  const words = n >>> 2;
  let o = 0;
  for (let i = 0; i < words; i += 1, o += 4) {
    const w = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    h1 = Math.imul(h1 ^ w, 0x01000193);
    let k = Math.imul(w, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h2 ^= k;
    h2 = (h2 << 13) | (h2 >>> 19);
    h2 = (Math.imul(h2, 5) + 0xe6546b64) | 0;
  }
  for (; o < n; o += 1) {
    h1 = Math.imul(h1 ^ bytes[o], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[o], 0x5bd1e995);
  }
  h2 ^= n;
  h2 ^= h2 >>> 16; h2 = Math.imul(h2, 0x85ebca6b);
  h2 ^= h2 >>> 13; h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  return [h1 >>> 0, h2 >>> 0];
}

const _hex8 = (v) => (v >>> 0).toString(16).padStart(8, "0");

/** FNV-1a 32 of a string, as 8 hex digits. */
function _strHash8(s) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return _hex8(h);
}

/**
 * The value key of a palette composite (before any collision suffix): the
 * bytes' two hashes, the size and a hash of the PAGE KEY the layer lands in
 * (format, levels, colour space, wrap, filters, anisotropy). No surface DID
 * (2026-10-31): equal bytes under equal sampling are one layer whichever
 * surface they came from; the registry still compares the full page key and
 * every byte before it joins.
 */
export function paletteKeyOf(h1, h2, width, height, pageKey) {
  return `pal:${_hex8(h1)}${_hex8(h2)}:${width | 0}x${height | 0}:${_strHash8(String(pageKey))}`;
}

function _bytesEqual(a, b, n) {
  if (a === b) return true;
  if (!a || !b || a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Why `ArrayPages.admitPixels(tex.image.data, ...)` would NOT reproduce the
 * texture three uploads for `tex` (null = it would: the scratch it builds has
 * the same page key, the same unpack flags and the same mip rule, so its
 * levels are the driver's mips of the same bytes). The caller then admits
 * the texture itself (identity key).
 */
export function admitPixelsMismatch(tex) {
  if (!tex || !tex.isDataTexture || tex.isCompressedTexture) return "not-data-texture";
  const d = describeTexture(tex);
  if (!d || d.format !== "rgba8") return "describe";
  if (tex.format !== THREE.RGBAFormat || tex.type !== THREE.UnsignedByteType) return "format";
  // The scratch is a DataTexture too (flipY false, premultiplyAlpha false,
  // unpackAlignment 1); with 4-byte texels every alignment <= 4 unpacks the
  // same rows.
  if (tex.flipY !== false || tex.premultiplyAlpha !== false || !(tex.unpackAlignment >= 1 && tex.unpackAlignment <= 4)) return "unpack";
  if (tex.generateMipmaps !== true || tex.minFilter !== THREE.LinearMipmapLinearFilter || tex.magFilter !== THREE.LinearFilter) return "mips";
  const img = tex.image;
  const data = img && img.data;
  if (!data || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return "data";
  if (data.length < d.width * d.height * 4) return "data-short";
  // The scratch admitPixels builds (array_pages.js): sRGB-or-given colour
  // space, flipY false, Linear / LinearMipmapLinear, generateMipmaps, the
  // given anisotropy and wraps. Its descriptor must name the same page.
  const s = scratchDescriptor(d.width, d.height, admitPixelsOpts(tex));
  if (!s || pageKeyOf(s) !== pageKeyOf(d)) return "page-key";
  return null;
}

/** The `opts` handed to admitPixels for `tex`. */
export function admitPixelsOpts(tex) {
  return { colorSpace: tex.colorSpace, anisotropy: tex.anisotropy, wrapS: tex.wrapS, wrapT: tex.wrapT };
}

/** describeTexture of the scratch ArrayPages.admitPixels configures (no pixels). */
export function scratchDescriptor(width, height, opts) {
  const t = new THREE.DataTexture(null, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = opts?.colorSpace ?? THREE.SRGBColorSpace;
  t.flipY = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = opts?.anisotropy ?? 1;
  t.wrapS = opts?.wrapS ?? THREE.RepeatWrapping;
  t.wrapT = opts?.wrapT ?? THREE.RepeatWrapping;
  return describeTexture(t);
}

/**
 * The value-key registry of palette composites. `keyFor(tex, did)` hashes
 * the bytes three would upload (memoised per texture object and version) and
 * returns the content key; a key that is already live is joined only when
 * the page key and the bytes are equal in full (else `#<n>` is appended and
 * counted). `did` only feeds the diag (`crossSurfaceJoins`: a join between
 * two surfaces, a layer the pre-2026-10-31 did-keyed scheme duplicated).
 */
export class PaletteKeys {
  constructor(hash = hashRgbaBytes) {
    this._hash = hash;
    this._byKey = new Map(); // key -> { tex, version, bytes, n, pageKey, did }
    this._memo = new WeakMap(); // tex -> { version, key }
    this.stats = { hashed: 0, joins: 0, crossSurfaceJoins: 0, hashCollisions: 0, compares: 0 };
  }

  keyFor(tex, did) {
    const m = this._memo.get(tex);
    if (m && m.version === tex.version) return m.key;
    const img = tex.image;
    const w = img.width | 0, h = img.height | 0;
    const n = w * h * 4;
    const bytes = img.data;
    const [h1, h2] = this._hash(bytes, n);
    this.stats.hashed += 1;
    const pageKey = pageKeyOf(scratchDescriptor(w, h, admitPixelsOpts(tex)));
    const d = did >>> 0;
    const base = paletteKeyOf(h1, h2, w, h, pageKey);
    let key = base;
    for (let k = 1; ; k += 1) {
      const e = this._byKey.get(key);
      if (!e) { this._byKey.set(key, { tex, version: tex.version, bytes, n, pageKey, did: d }); break; }
      if (e.tex === tex && e.version === tex.version) break;
      // The stored source must still hold the bytes it was keyed by, in the same page.
      const trusted = e.tex.version === e.version && e.n === n && e.pageKey === pageKey;
      this.stats.compares += 1;
      if (trusted && _bytesEqual(e.bytes, bytes, n)) {
        this.stats.joins += 1;
        if (e.did !== d) this.stats.crossSurfaceJoins += 1;
        break;
      }
      this.stats.hashCollisions += 1;
      key = `${base}#${k}`;
    }
    this._memo.set(tex, { version: tex.version, key });
    return key;
  }

  /** Forget keys whose layer is no longer resident (`isResident(key)`). */
  sweep(isResident) {
    for (const k of [...this._byKey.keys()]) if (!isResident(k)) this._byKey.delete(k);
  }

  get size() { return this._byKey.size; }

  clear() { this._byKey.clear(); this._memo = new WeakMap(); }
}

/**
 * Why the geometry `g` cannot join a merge whose first member is `first`
 * (null = it can): anim_scenery_batch.js geometryMergeReason's rules without
 * the pose-row requirement.
 */
export function leafGeometryReason(g, first) {
  if (!g || !g.attributes || !g.attributes.position) return "no-position";
  if (g.groups && g.groups.length > 0) return "groups";
  if (g.morphAttributes && Object.keys(g.morphAttributes).length > 0) return "morph";
  if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return "draw-range";
  if (g.isInstancedBufferGeometry) return "instanced";
  const indexed = g.index !== null && g.index !== undefined;
  for (const n of Object.keys(g.attributes)) {
    const a = g.attributes[n];
    if (a.isInterleavedBufferAttribute) return "interleaved";
    if (a.isInstancedBufferAttribute) return "instanced";
    if (n === SLOT_ATTR || n === ENTITY_PART_ATTR) return "reserved-attribute";
  }
  if (indexed && referencedVerticesOf(g) === false) return "index-range";
  if (!first || first === g) return null;
  if ((first.index !== null && first.index !== undefined) !== indexed) return "index-mix";
  const names = Object.keys(first.attributes).sort();
  const n2 = Object.keys(g.attributes).sort();
  if (n2.length !== names.length || n2.some((n, i) => n !== names[i])) return "attribute-set";
  for (const n of names) {
    const a = g.attributes[n], a0 = first.attributes[n];
    if (a.itemSize !== a0.itemSize || a.normalized !== a0.normalized || a.array.constructor !== a0.array.constructor) return "attribute-layout";
  }
  return null;
}

function _isIdentityTransform(o) {
  const p = o.position, q = o.quaternion, s = o.scale;
  return p.x === 0 && p.y === 0 && p.z === 0 && q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1
    && s.x === 1 && s.y === 1 && s.z === 1 && (o.pivot === null || o.pivot === undefined);
}

// POM verdicts (header "POM PARTS"), cached per member version + chain +
// key function. Lazy: nothing at import.
let _pomVerdicts = null; // WeakMap member -> { version, obc, cpk, res }
let _arrayViews = null;  // WeakMap member -> its array view (p0 key, the accepted maps hidden)
let _pomScratchMat = null;

/**
 * The chain verdict of a member whose key matches ENTITY_POM_CHAIN_KEY:
 * `{ id, pom }` (`id` = its chain fingerprint, 8 hex digits; `pom` = the
 * POM info `{ pom: true, texture, values }` or null for a p1 flag without
 * POM text), or `{ reason }`. Null for any other member.
 */
export function entityPomVerdict(member) {
  if (!member) return null;
  const pk = memberProgramKey(member);
  if (pk === null || !ENTITY_POM_CHAIN_KEY.test(pk)) return null;
  if (!_pomVerdicts) _pomVerdicts = new WeakMap();
  const c = _pomVerdicts.get(member);
  if (c && c.version === member.version && c.obc === member.onBeforeCompile && c.cpk === member.customProgramCacheKey) return c.res;
  if (!_pomScratchMat) _pomScratchMat = new THREE.MeshStandardMaterial();
  const r = chainFingerprintOf(memberChainHook(member), _pomScratchMat);
  const res = r.reason ? { reason: r.reason } : { id: fnv1aHex(r.fp), pom: r.pom && r.pom.pom === true ? r.pom : null };
  _pomVerdicts.set(member, { version: member.version, obc: member.onBeforeCompile, cpk: member.customProgramCacheKey, res });
  return res;
}

/**
 * `member` as unitArrayReason would see it with `|p0|` in its key and without
 * the maps this consumer reproduces itself (aoMap, roughnessMap, emissiveMap:
 * header "AO / ROUGHNESS / EMISSIVE PARTS"); every other read falls through.
 * The key function is the member's own status (a member with no key of its
 * own keeps three's: unitArrayReason tells "no chain" by identity).
 */
function _arrayView(member) {
  if (!_arrayViews) _arrayViews = new WeakMap();
  let v = _arrayViews.get(member);
  if (!v) {
    v = Object.create(member);
    const p0Key = function hbEntityP0Key() { return String(member.customProgramCacheKey()).replace("|p1|", "|p0|"); };
    Object.defineProperty(v, "customProgramCacheKey", {
      get() { return member.customProgramCacheKey === _PROTO_KEY ? _PROTO_KEY : p0Key; },
      configurable: true, enumerable: false,
    });
    for (const k of ["aoMap", "roughnessMap", "emissiveMap"]) {
      Object.defineProperty(v, k, { value: null, configurable: true, writable: false, enumerable: false });
    }
    _arrayViews.set(member, v);
  }
  return v;
}

/**
 * unitArrayReason with POM parts (header "POM PARTS") and the texchan AO /
 * roughness planes + the emissive alias (header "AO / ROUGHNESS / EMISSIVE
 * PARTS"): a member refused only for a `p1` key is judged by its chain dry
 * run, a member refused for an aoMap / roughnessMap / emissiveMap with those
 * maps hidden, and either one by every other rule of unitArrayReason (the
 * array view: another extra map, a luminous emissive, ... still refuse). A
 * real POM chain also needs the normal map and an R8-page height map; an
 * emissiveMap must be the map itself; the AO / roughness planes must fit a
 * kit page (R8 or RGBA8 / RGBA8).
 */
export function entityArrayReason(member) {
  const r = unitArrayReason(member);
  if (r === null) return null;
  let v = null;
  if (r === "shader-chain") {
    v = entityPomVerdict(member);
    if (!v) return r;
    if (v.reason) return v.reason;
  } else if (r !== "map:aoMap" && r !== "map:roughnessMap" && r !== "map:emissiveMap") return r;
  // E2: an emissive class samples the emissive layer from the MAP page.
  if (member.emissiveMap && member.emissiveMap !== member.map) return "map:emissiveMap";
  const r2 = unitArrayReason(_arrayView(member));
  if (r2) return r2;
  if (v && v.pom) {
    if (!member.normalMap) return "pom-no-normal";
    if (!describeTexture(v.pom.texture, R8_PLANES)) return "pom-map-format";
  }
  if (member.aoMap && !describeTexture(member.aoMap, R8_PLANES)) return "ao-map-format";
  if (member.roughnessMap && !describeTexture(member.roughnessMap)) return "roughness-map-format";
  return null;
}

/**
 * The run key of a batchable member: anim_scenery_batch.js arraySignature,
 * plus (POM parts) the chain fingerprint and the height page key, plus (map
 * parts) the map-set key and the AO / roughness page keys.
 */
export function entityRunKeyOf(member) {
  let k = arraySignature(member);
  const v = entityPomVerdict(member);
  if (v && !v.reason) {
    const hd = v.pom ? describeTexture(v.pom.texture, R8_PLANES) : null;
    k += "|pomc" + v.id + (hd ? "|h:" + pageKeyOf(hd) : "");
  }
  const ms = memberMapSet(member);
  if (ms.any) {
    const ad = ms.ao ? describeTexture(member.aoMap, R8_PLANES) : null;
    const rd = ms.rough ? describeTexture(member.roughnessMap) : null;
    k += ms.key + (ms.ao ? "|a:" + (ad ? pageKeyOf(ad) : "-") : "") + (ms.rough ? "|r:" + (rd ? pageKeyOf(rd) : "-") : "");
  }
  return k;
}

let _extraMapNames = null; // lazy (nothing at import)
function _extraMapSet(m) {
  if (!_extraMapNames) _extraMapNames = ["lightMap", "aoMap", "bumpMap", "displacementMap", "roughnessMap", "metalnessMap", "alphaMap", "emissiveMap", "envMap"];
  let out = "";
  for (const k of _extraMapNames) if (m[k]) out += (out ? "+" : "") + k;
  return out || "-";
}

/** The POM info of a batchable member (null = none). */
function _pomOf(member) {
  const v = entityPomVerdict(member);
  return v && !v.reason && v.pom ? v.pom : null;
}

// Map parts (header "AO / ROUGHNESS / EMISSIVE PARTS"): row helpers.

/** Does `row` no longer hold the planes / set `m` carries now (a shared row is then admitted afresh)? */
function _rowMapsStale(row, m) {
  const ao = row.aoTex || null, rgh = row.rghTex || null;
  if ((m.aoMap || null) !== ao || (ao && ao.version !== row.aoVersion)) return true;
  if ((m.roughnessMap || null) !== rgh || (rgh && rgh.version !== row.rghVersion)) return true;
  return memberMapSet(m) !== (row.maps || MAP_SET_NONE);
}

/** The run / class key part of a row's map set and AO / roughness pages ("" without maps). */
function _rowMapPagesKey(row) {
  const ms = row.maps || MAP_SET_NONE;
  if (!ms.any) return "";
  return `${ms.key}|a${row.aoPage ? row.aoPage.id : "-"}|r${row.rghPage ? row.rghPage.id : "-"}`;
}

/**
 * The map half of a row's extension row (class_materials.js extraMapStateOf
 * into `out`, the row's own object in the sync: no allocation). E2: the
 * emissive layer is the map layer.
 */
function _rowMapState(row, mat, out) {
  return extraMapStateOf(mat, row.aoLayer, row.rghLayer, row.maps.emissive ? row.layer : 0, out);
}

const _PROTO_BEFORE = THREE.Object3D.prototype.onBeforeRender;
const _PROTO_KEY = THREE.Material.prototype.customProgramCacheKey;
const _PROTO_AFTER = THREE.Object3D.prototype.onAfterRender;
const _PROTO_RAYCAST = THREE.Mesh.prototype.raycast;

/**
 * Why a leaf (a per-surface Mesh under a part Group) stays legacy (null =
 * batchable). `ctx.animated(did)` = the MaterialCache animates that surface.
 * `scratch` = a reusable state object.
 */
export function leafRouteReason(leaf, ctx, scratch) {
  if (!leaf || leaf.isMesh !== true || leaf.isInstancedMesh || leaf.isSkinnedMesh || leaf.isBatchedMesh) return "notMesh";
  const mat = leaf.material;
  if (!mat || Array.isArray(mat)) return "multiMaterial";
  if (mat.visible === false) return "materialHidden";
  const cls = blendClassOf(fillStateFromMaterial(scratch || layerStateFromMaterial(null), mat));
  if (cls === "translucent" || cls === "additive") return cls;
  const r = entityArrayReason(mat);
  if (r) return r;
  const did = leaf.userData?.surfaceDid >>> 0;
  if (ctx && typeof ctx.animated === "function" && ctx.animated(did)) return "animatedSurface";
  if (!_isIdentityTransform(leaf)) return "leafTransform";
  if (leaf.matrixAutoUpdate === false && !_isIdentityMatrix(leaf.matrix)) return "leafTransform";
  if (leaf.castShadow || leaf.receiveShadow) return "shadow";
  if (leaf.renderOrder !== 0) return "renderOrder";
  if (leaf.onBeforeRender !== _PROTO_BEFORE || leaf.onAfterRender !== _PROTO_AFTER) return "renderHook";
  if (leaf.raycast !== _PROTO_RAYCAST) return "raycastHook";
  if (leaf.children && leaf.children.length > 0) return "leafChildren";
  if (leaf.morphTargetInfluences && leaf.morphTargetInfluences.length > 0) return "morph";
  return null;
}
function _isIdentityMatrix(m) {
  const e = m.elements;
  for (let i = 0; i < 16; i += 1) if (e[i] !== ((i % 5) === 0 ? 1 : 0)) return false;
  return true;
}

/** Is `obj` a held item's root parented under a wielder's part (entities.js `_isAttachedChildNode`)? */
export function isAttachedChildNode(obj) {
  return obj?.userData?.__attachedChildOf != null;
}

/** The leaves of a part Group: per-surface Meshes, attached item roots skipped. */
export function partLeaves(part, out) {
  const o = out || [];
  if (!part || !part.children) return o;
  for (const c of part.children) {
    if (!c || isAttachedChildNode(c)) continue;
    if (c.isMesh === true && c.userData && c.userData.surfaceDid !== undefined) o.push(c);
  }
  return o;
}

/**
 * The 16 f64 values three's updateMatrix gives `o` (compose + pivot), into
 * `out` (a Matrix4). `matrixAutoUpdate === false`: `o.matrix` as is.
 */
export function composePartMatrix(o, out) {
  if (o.matrixAutoUpdate === false) return out.copy(o.matrix);
  out.compose(o.position, o.quaternion, o.scale);
  const pivot = o.pivot;
  if (pivot !== null && pivot !== undefined) {
    const px = pivot.x, py = pivot.y, pz = pivot.z;
    const te = out.elements;
    te[12] += px - te[0] * px - te[4] * py - te[8] * pz;
    te[13] += py - te[1] * px - te[5] * py - te[9] * pz;
    te[14] += pz - te[2] * px - te[6] * py - te[10] * pz;
  }
  return out;
}

/** Hex of a Uint32Array (key material). */
function _hexList(a) {
  if (!a || a.length === 0) return "-";
  let s = "";
  for (let i = 0; i < a.length; i += 1) s += (i ? "," : "") + (a[i] >>> 0).toString(16);
  return s;
}

/** The shared-entry key of an entity's batched leaves (see the header). */
export function entryKeyOf(setupId, modelChanges, textureChanges, leaves, runKeys) {
  let s = `${(setupId >>> 0).toString(16)}|${_hexList(modelChanges)}|${_hexList(textureChanges)}|`;
  for (let i = 0; i < leaves.length; i += 1) {
    const l = leaves[i];
    s += `${l.part}.${l.group}.${(l.did >>> 0).toString(16)}.${l.leaf.geometry.attributes.position.count};`;
  }
  s += "|";
  // Run keys are long: intern them per plan (first-appearance index).
  const seen = new Map();
  for (const k of runKeys) {
    let id = seen.get(k);
    if (id === undefined) { id = seen.size; seen.set(k, id); s += `#${id}=${k};`; } else s += `#${id};`;
  }
  return s;
}

/**
 * Do `geos` (in order) reproduce the entry's shared arrays exactly? (Float32
 * / index compare of every attribute over every slice; the AnimationCache
 * hands two entities identical content in different BufferGeometry objects.)
 */
export function entryMatches(entry, geos) {
  if (!entry || !entry.slices || entry.slices.length !== geos.length) return false;
  for (let i = 0; i < geos.length; i += 1) {
    const g = geos[i];
    if (entry.sources && entry.sources[i] === g) continue;
    const sl = entry.slices[i];
    const used = (g.index !== null && g.index !== undefined) ? referencedVerticesOf(g) : null;
    const n = used ? used.length : g.attributes.position.count;
    if (n !== sl.vertexCount) return false;
    for (const name of entry.attrNames) {
      const a = g.attributes[name];
      const ea = entry.attrs[name];
      if (!a || !ea || a.itemSize !== ea.itemSize) return false;
      const isz = a.itemSize;
      const src = a.array, dst = ea.array;
      let o = sl.vertexStart * isz;
      if (used) {
        for (let j = 0; j < used.length; j += 1) {
          const so = used[j] * isz;
          for (let c = 0; c < isz; c += 1) if (src[so + c] !== dst[o + c]) return false;
          o += isz;
        }
      } else {
        for (let j = 0; j < n * isz; j += 1) if (src[j] !== dst[o + j]) return false;
      }
    }
    if (used) {
      const idx = g.index.array, eidx = entry.index.array;
      const remap = new Map();
      for (let j = 0; j < used.length; j += 1) remap.set(used[j], j);
      for (let k = 0; k < g.index.count; k += 1) {
        if (eidx[sl.start + k] !== remap.get(idx[k]) + sl.vertexStart) return false;
      }
    }
  }
  return true;
}

// ===========================================================================
// The consumer.
// ===========================================================================

function _count(map, reason, n = 1) { map[reason] = (map[reason] || 0) + n; }

/** entities.js `_spawnMaterialRampTween`'s supersede rule for the opacity family (7 / 20) on `dids`. */
function _dropOpacityTweens(inst, dids) {
  const tw = inst._materialHookTweens;
  if (!tw || tw.length === 0) return;
  const keep = tw.filter((t) => !((t.hookType === 7 || t.hookType === 20) && dids.includes(t.surfaceDid >>> 0)));
  if (keep.length !== tw.length) inst._materialHookTweens = keep;
}

// The class-program warm set: program key -> { material, tries, registered,
// warmedOn }. Shared by every EntityBatch of the page, because shader_prewarm's
// registry is page-wide (the first registration of a key owns its proxy
// material). Made at the first use (flag on only), like the canonical
// registration promise.
let _warmShared = null;
let _canonicalShared = null;
function _warmRegistry() {
  if (!_warmShared) _warmShared = new Map();
  return _warmShared;
}

/** The shared onBeforeRender of every batch mesh: the frame's part rows, once. */
function hbEntityBatchBeforeRender() {
  const b = this.userData && this.userData.hbRecord;
  if (!b) return;
  const eb = b.owner;
  eb._lateRows();
  if (b.drawT0 === -2) b.drawT0 = uploadNowMs();
}
function hbEntityBatchAfterRender() {
  const b = this.userData && this.userData.hbRecord;
  if (!b) return;
  if (b.drawT0 >= 0) {
    b.owner._budgetMs(uploadNowMs() - b.drawT0, "geometryFirstDraw");
    b.drawT0 = -1;
    this.onAfterRender = _PROTO_AFTER;
  }
}

/** The raycast facade: the PARKED leaves, raycast as themselves. */
function hbEntityBatchRaycast(raycaster, intersects) {
  const b = this.userData && this.userData.hbRecord;
  if (!b || !b.leaves) return;
  const want = raycaster.layers.mask;
  for (const leaf of b.leaves) {
    const ud = leaf.userData;
    if (!ud || ud.hbParked !== true) continue;
    if ((want & ud.hbHomeMask) === 0) continue;
    leaf.raycast(raycaster, intersects);
  }
}

export class EntityBatch {
  /**
   * @param {object} em  the EntityManager (scene3d, materialCache, entityMap,
   *   _getOrCloneEntityMaterial, _applyMaterialRamp, _selFlashMats)
   * @param {object} [opts]  { env: () => ({renderer, camera, scene, frameId}), diagGlobal: true }
   */
  constructor(em, opts = {}) {
    this.em = em;
    this._envFn = typeof opts.env === "function" ? opts.env : null;
    this._etherealGhost = opts.etherealGhost === true;
    this._records = new Set();
    this._entries = new Map(); // key -> [entry]
    this._idle = new Map();    // entry -> true (LRU order)
    this._idleBytes = 0;
    this._classMats = new Map(); // class key -> { key, material, refs, programKey }
    this._warm = _warmRegistry(); // program key -> { material, tries, registered, warmedOn } (page-wide)
    this._rows = new Map();      // member material -> row entry
    this._palKeys = new PaletteKeys(opts.hash);
    this._partRows = null;
    this._identityIM = null;
    this._frameNo = 0;
    this._syncSerial = 0;
    this._lateSerial = -1;
    this._watch = null;
    this._pagesGen = -1;
    this._lastPages = null;
    this._scratchState = layerStateFromMaterial(null);
    this._m = new THREE.Matrix4();
    this._leafScratch = [];
    this._stats = {
      noted: 0, plans: 0, builds: 0, teardowns: 0, replans: 0, rebuilds: 0, demotes: 0, promotes: 0,
      reparked: 0, contextResets: 0, sweeps: 0,
      fallbacks: {}, leafRoutes: {}, hooks: {}, demoteReasons: {}, replanReasons: {},
      extraMaps: {}, // leaves refused for an extra map, by their whole extra-map set (census)
      mapLeaves: {}, // batched leaves carrying AO / roughness / emissive maps, by the same set names (per plan)
      mapArrivals: 0, // texchan planes that arrived on a batched member (header "AO / ROUGHNESS / EMISSIVE PARTS")
      entries: { hits: 0, misses: 0, collisions: 0 },
      // value / identity: admits that returned a layer (fresh or not); fresh*:
      // the ones that uploaded (fromLegacy = copied from the resident legacy
      // texture, scratch = through the admitPixels scratch); refusedMembers:
      // members the cap refused (each stays a legacy leaf).
      layers: {
        value: 0, identity: 0, identityAdmits: 0, deferred: 0, refused: 0,
        freshValue: 0, freshIdentity: 0, fromLegacy: 0, scratch: 0, freshBytes: 0, refusedMembers: 0,
        pom: 0, // POM parts admitted (a height layer + an extension row each)
        ao: 0, roughness: 0, emissive: 0, // map parts admitted with an AO / roughness layer, an emissive set
      },
      rows: { lateFrames: 0, lateWrites: 0, lateSkips: 0, lateZeros: 0, partRows: 0 },
      // Waits that are not fallbacks (the rig is polled, nothing allocated).
      waits: { hidden: 0, pageFull: 0, hiddenReleases: 0, pageFullRetries: 0 },
    };
    // GL-context transitions (see sync / _contextEvent).
    this._ctx = { lost: 0, restored: 0, lossOpen: false, lastResetFrame: -1, lastResetGen: -1, replansSinceReset: 0 };
    // Config that keeps every entity legacy (nothing is allocated for it).
    const s3 = em && em.scene3d;
    this.inert = null;
    if (opts.wireframe === true || s3?.wireframeMode === true) this.inert = "wireframe";
    else if (s3?.shadowsEnabled || s3?.csmEnabled) this.inert = "shadowCaster";
    if (opts.diagGlobal !== false && typeof window !== "undefined") {
      try {
        window.__entityBatch = {
          stats: () => this.stats(),
          verify: () => this.verify(),
          records: () => [...this._records],
        };
      } catch (_) { /* no window */ }
    }
  }

  // -------------------------------------------------------------------------
  // Environment.
  // -------------------------------------------------------------------------

  _env() {
    if (this._envFn) return this._envFn() || {};
    let renderer = null, camera = null, scene = null, frameId;
    try {
      const live = typeof window !== "undefined" ? window.liveScene3d : null;
      if (live) {
        renderer = live.renderer || null;
        camera = live.camera || null;
        scene = live.scene || null;
        frameId = live.frameTime ? live.frameTime.tsMs : undefined;
      }
    } catch (_) { /* no window */ }
    return { renderer, camera, scene, frameId };
  }

  _budgetMs(ms, phase) {
    try { kitBudget().addMs(UPLOAD_KIND.GEOMETRY, ms, phase); } catch (_) { /* diag */ }
  }

  // -------------------------------------------------------------------------
  // Entry points from entities.js (each one guarded there by `this._entityBatch`).
  // -------------------------------------------------------------------------

  /** H3: a spawn committed (`inst` is in the scene and in entityMap). */
  noteSpawn(inst, info = {}) {
    this._stats.noted += 1;
    if (!inst || inst._hbBatch) return;
    if (this.inert) { _count(this._stats.fallbacks, this.inert); return; }
    const b = {
      owner: this, inst, status: "pending", reason: null, retryFrame: this._frameNo + 1,
      replans: 0, everActive: false, rendererWaits: 0, demoteFrame: 0,
      setupId: (info.setupId ?? inst._setupId ?? 0) >>> 0,
      modelChanges: info.modelChanges || null, textureChanges: info.textureChanges || null,
      leaves: null, plan: null, drawT0: -1,
    };
    inst._hbBatch = b;
    Object.defineProperty(inst, "demoteBatch", {
      configurable: true, enumerable: false, writable: true,
      value: (reason) => this.demote(inst, reason || "external"),
    });
    this._records.add(b);
    this._registerCanonicalClasses();
  }

  /** H9 / ReplaceObject / tests: tear the batch down (legacy back on screen); permanent or re-planned. */
  teardown(inst, reason, opts = {}) {
    const b = inst && inst._hbBatch;
    if (!b || b.status === "released") return;
    // A legacy rig stays legacy (a re-dress does not revive weaponFx / unstable / ...).
    if (b.status === "legacy") { if (opts.permanent && b.reason !== reason) b.reason = reason; return; }
    if (b.status !== "pending") this._teardown(b);
    if (opts.permanent) this._setLegacy(b, reason);
    else { b.status = "pending"; b.reason = reason; b.retryFrame = this._frameNo + 1; }
  }

  /** H9: the rig was rebuilt (hot-swap): plan again from scratch next frame. */
  noteRebuilt(inst, reason) {
    const b = inst && inst._hbBatch;
    if (!b || b.status === "legacy") return;
    // The swap fetched the rig from `inst.meta` (it is set to the new
    // appearance before the next plan): key the re-plan on it.
    b.keyFromMeta = true;
    if (b.status !== "pending") this._teardown(b, "tweens");
    this._stats.rebuilds += 1;
    _count(this._stats.replanReasons, "rebuilt:" + reason);
    b.status = "pending";
    b.reason = reason;
    b.retryFrame = this._frameNo + 1;
  }

  /** H14: the entity is being disposed. */
  release(inst) {
    const b = inst && inst._hbBatch;
    if (!b) return;
    if (b.status !== "legacy" && b.status !== "pending") this._teardown(b, "drop");
    this._records.delete(b);
    delete inst._hbBatch;
    delete inst.demoteBatch;
    b.status = "released";
  }

  /**
   * H6: `_getOrCloneEntityMaterial(inst, did)` is about to clone / re-point
   * every leaf of `did`. A batched did demotes the entity FIRST, so the
   * re-point writes unparked leaves and the next draw is the legacy one.
   */
  noteClone(inst, did, reason) {
    const b = inst && inst._hbBatch;
    if (!b || !_activeLike(b.status)) return;
    const d = did >>> 0;
    if (!b.plan.batchedDids.has(d)) return;
    this.demote(inst, reason || "clone:other");
  }

  /**
   * H7: a ramp hook on `inst`. Returns null (run today's body for every
   * surface) or an array of the dids today's body must still run for (the
   * batch took the rest). Only an ACTIVE batch (leaves parked) routes.
   */
  routeRamp(inst, hookType, partIndex, hook, parity = true) {
    const b = inst && inst._hbBatch;
    if (!b || b.status !== "active") return null;
    const dids = this.em._collectEntitySurfaceDids(inst, partIndex);
    if (!dids || dids.length === 0) return null;
    const B = [];
    const L = [];
    for (const d of dids) {
      if (b.plan.batchedDids.has(d >>> 0) && !b.plan.legacyDids.has(d >>> 0)) B.push(d >>> 0);
      else L.push(d);
    }
    if (B.length === 0) { _count(this._stats.hooks, "legacyDids"); return null; }
    if (hookType === 7 || hookType === 20) {
      const cls = classifyTransparentRamp(hook.rampStart, hook.rampEnd, hook.rampTime, parity);
      if (cls === "fade") { this.demote(inst, "fade:transparentRamp"); return null; }
      // Today's body drops every older opacity-family tween of these surfaces
      // (the newer hook supersedes): the batch takes the hook, so it does too.
      _dropOpacityTweens(inst, B);
      // did -> the tween today's body would have spawned, for a hide AND for
      // a show: every exit from the batch writes it back (`_materializeHidden`:
      // the clone at its value, and the tween while it would still run). A
      // show is not a no-op today: its 0 -> 0 tween writes opacity 1 over a
      // camera fade / object translucency that starts inside it, and its last
      // tick leaves that write behind. `hiddenDids` (hides) collapses leaves;
      // `shownDids` (shows) only waits for an exit. Each did is in one of them.
      const rec = {
        hookType, startMs: performance.now(), durationMs: Math.max(0, (+hook.rampTime) * 1000),
        rampStart: +hook.rampStart, rampEnd: +hook.rampEnd,
      };
      const put = cls === "hide" ? "hiddenDids" : "shownDids";
      const off = cls === "hide" ? "shownDids" : "hiddenDids";
      if (!b[put]) b[put] = new Map();
      for (const d of B) b[put].set(d, rec);
      if (b[off]) {
        for (const d of B) b[off].delete(d);
        if (b[off].size === 0) b[off] = null;
      }
      _count(this._stats.hooks, `${hookType}:${cls}`);
      this._mirrorCollapse(b);
      return L;
    }
    this.demote(inst, (hookType === 8 || hookType === 9) ? "ramp:luminous" : "ramp:diffuse");
    return null;
  }

  /**
   * Demote to the legacy leaves (pixel-identical), keeping the batch
   * resources for a re-promote; `dismember` / `dislocate` / `corpseCarry` /
   * `replaceObject` keep the entity legacy for life.
   */
  demote(inst, reason) {
    const b = inst && inst._hbBatch;
    if (!b || b.status === "legacy" || b.status === "released") return;
    this._stats.demotes += 1;
    _count(this._stats.demoteReasons, reason);
    if (_permanentDemote(reason)) {
      if (b.status !== "pending") this._teardown(b);
      this._setLegacy(b, reason);
      return;
    }
    if (_activeLike(b.status)) {
      b.status = "demoted";
      b.reason = reason;
      b.demoteFrame = this._frameNo;
      b.retryFrame = this._frameNo + ENTITY_BATCH_POLL_FRAMES;
      this._unparkAll(b);
      if (b.mesh) b.mesh.visible = false;
      this._materializeHidden(b);
      this._churn(b);
      return;
    }
    if (_buildingLike(b.status)) {
      // Not on screen yet: drop what was gathered; plan again after the poll.
      this._teardown(b);
      b.status = "pending";
      b.reason = reason;
      b.retryFrame = this._frameNo + ENTITY_BATCH_POLL_FRAMES;
      this._churn(b);
      return;
    }
    b.reason = reason;
    b.retryFrame = Math.max(b.retryFrame, this._frameNo + ENTITY_BATCH_POLL_FRAMES);
  }

  /** H15. */
  dispose() {
    this._unwatchContext();
    for (const b of [...this._records]) this.release(b.inst);
    this._records.clear();
    for (const e of this._classMats.values()) this._disposeClassMaterial(e.material);
    this._classMats.clear();
    for (const list of this._entries.values()) for (const e of list) e.attrs = null;
    this._entries.clear();
    this._idle.clear();
    this._rows.clear();
    if (this._partRows) { try { this._partRows.dispose(); } catch (_) { /* fail-soft */ } this._partRows = null; }
    this._palKeys.clear();
    this._lastPages = null;
    try { if (typeof window !== "undefined" && window.__entityBatch) delete window.__entityBatch; } catch (_) { /* no window */ }
  }

  // -------------------------------------------------------------------------
  // Per frame.
  // -------------------------------------------------------------------------

  /** H4 / H5: the end of EntityManager.tick (and its dt <= 0 exit). */
  sync() {
    this._frameNo += 1;
    this._syncSerial += 1;
    const env = this._env();
    kitBeginFrame(env.frameId === undefined || env.frameId === null ? `eb:${this._frameNo}` : env.frameId);
    if (this._records.size === 0) return;
    const budget = kitBudget();
    const renderer = env.renderer || null;
    let pages = null;
    if (renderer) {
      this._watchContext(renderer);
      pages = kitPages(renderer);
      this._lastPages = pages;
      if (pages && pages.contextLost()) {
        this._contextEvent(pages, renderer);
        kitFlush();
        return;
      }
      // Live: a loss we reset for is over even when another consumer's
      // canvas listener reset the pages first.
      if (this._ctx.lossOpen) { this._ctx.lossOpen = false; this._ctx.restored += 1; }
      if (pages && this._pagesGen !== -1 && this._pagesGen !== pages.generation) this._restartAll();
      if (pages) this._pagesGen = pages.generation;
    }
    this._syncMembers();
    for (const b of this._records) {
      // Per-record generation guard: whatever reset the pages (a canvas
      // event, a tick, another consumer), nothing built on an older
      // generation survives this sync.
      if (pages && b.plan && b.plan.pagesGen !== pages.generation && b.status !== "pending" && b.status !== "legacy" && b.status !== "released") {
        this._restartRecord(b);
      }
      switch (b.status) {
        case "active": this._syncActive(b, pages); break;
        case "overlap": this._syncOverlap(b, env); break;
        case "demoted": this._pollDemoted(b); break;
        case "legacy": case "released": break;
        default: this._advance(b, env, pages, budget); break;
      }
    }
    if ((this._frameNo % 600) === 0 && pages) this._sweep(pages);
    kitFlush();
  }

  /**
   * The pages report a dead generation (`contextLost()`): a loss, or a
   * restore not yet reset for. ONE reset per transition: at the loss (the
   * legacy leaves come back, the pages are dropped without GL calls) and at
   * the restore (a new generation on the live context); the ticks in between
   * only wait.
   */
  _contextEvent(pages, renderer) {
    const lostNow = liveContextGeneration(renderer || pages.renderer) === LOST_CONTEXT_GENERATION;
    if (lostNow) {
      if (this._ctx.lossOpen) return;
      this._ctx.lossOpen = true;
      this._ctx.lost += 1;
    } else {
      if (!this._ctx.lossOpen) this._ctx.lost += 1; // lost AND restored between two checks
      this._ctx.lossOpen = false;
      this._ctx.restored += 1;
    }
    this._contextChanged(pages);
  }

  _advance(b, env, pages, budget) {
    if (b.status === "pending") {
      if (this._frameNo < b.retryFrame) return;
      // Layers only for leaves that draw: a culled rig waits (nothing allocated).
      if (b.inst && b.inst.root && b.inst.root.visible === false && b.inst.root.parent) {
        if (b.reason !== "hidden") this._stats.waits.hidden += 1;
        b.reason = "hidden";
        b.retryFrame = this._frameNo + ENTITY_BATCH_POLL_FRAMES;
        return;
      }
      // A page-full wait re-tries every member (the cap may have room now).
      if (b.pageFullWait) { b.pageFullWait = false; b.noBatchMats = null; this._stats.waits.pageFullRetries += 1; }
      this._plan(b, env, pages);
    }
    if (b.status === "admitting" && b.inst.root && b.inst.root.visible === false) return; // paused while culled
    if (b.status === "admitting") {
      if (!this._admit(b, pages, budget)) return;
      if (!this._resolveClasses(b)) return;
      b.status = "warming";
    }
    if (b.status === "warming") {
      let ready = true;
      for (const r of b.plan.runs) if (!this._classReady(r.classEntry, env)) ready = false;
      if (!ready) return;
      b.status = "building";
    }
    if (b.status === "building") {
      if (!this._mirrorMembersStill(b)) return;
      if (!this._build(b, budget, env)) return;
      this._beginOverlap(b);
    }
  }

  // -------------------------------------------------------------------------
  // Qualification + plan.
  // -------------------------------------------------------------------------

  /** Entity-level reason the entity stays legacy now ({ reason, poll }) or null. */
  _entityBlocker(inst) {
    if (!inst.root || !Array.isArray(inst.parts) || inst.parts.length === 0) return { reason: "noParts", poll: false };
    if (inst._disposed) return { reason: "disposed", poll: false };
    if (inst._wfx) return { reason: "weaponFx", poll: false };
    if ((inst._dismemberStash && inst._dismemberStash.size > 0) || (inst._dismemberHidden && inst._dismemberHidden.size > 0)) return { reason: "structural:dismember", poll: false };
    if (inst._dislocations && inst._dislocations.size > 0) return { reason: "structural:dislocate", poll: false };
    if (inst._camFadeOpacity < 1) return { reason: "fadeOwner:camera", poll: true };
    if (inst._objectTranslucency > 0) return { reason: "fadeOwner:objectTranslucency", poll: true };
    // A ramp tween holds the rig only while its value MOVES: a constant one
    // (the AFK 0 -> 0 show, a 1 -> 1 hide) writes the same value every tick,
    // which the leaf's material already shows (the plan routes it as it is).
    const tws = inst._materialHookTweens;
    if (tws && tws.length > 0) {
      for (const t of tws) if (t.rampStart !== t.rampEnd) return { reason: "fadeOwner:ramp", poll: true };
    }
    // `_ethereal` is state only unless `?etherealGhost=on` (entities.js ETHEREAL_GHOST).
    if (this._etherealGhost && inst._ethereal === true) return { reason: "fadeOwner:ethereal", poll: true };
    if (inst._entityMaterials && inst._entityMaterials.size > 0) {
      for (const m of inst._entityMaterials.values()) if (m && m.userData && m.userData.__hookTexVel) return { reason: "texVel", poll: true };
    }
    const sel = this.em && this.em._selFlashMats;
    if (sel && sel.size > 0 && inst._entityMaterials) {
      for (const m of inst._entityMaterials.values()) if (sel.has(m)) return { reason: "selectionFlash", poll: true };
    }
    if (!inst.root.parent) return { reason: "detached", poll: true };
    return null;
  }

  _animatedDid(did) {
    const mc = this.em && this.em.materialCache;
    const a = mc && mc._animatedMaterials;
    return !!(a && typeof a.has === "function" && a.has(did));
  }

  /** The candidate leaves in (part, children) order + per-leaf route. */
  _collect(inst) {
    const out = [];
    const ctx = { animated: (d) => this._animatedDid(d) };
    for (let p = 0; p < inst.parts.length; p += 1) {
      this._leafScratch.length = 0;
      const kids = partLeaves(inst.parts[p], this._leafScratch);
      for (let g = 0; g < kids.length; g += 1) {
        const leaf = kids[g];
        const ud = leaf.userData;
        const did = ud.surfaceDid >>> 0;
        let reason = null;
        if (ud.replaced) reason = "structural:replaced";
        else reason = leafRouteReason(leaf, ctx, this._scratchState);
        out.push({ leaf, part: p, group: g, did, reason });
      }
    }
    this._leafScratch.length = 0;
    return out;
  }

  /** Re-check later: fade owners every POLL frames, slow causes (mapless, detached, clones) backing off to 32x. */
  _wait(b, reason, slow) {
    b.reason = reason;
    b.polls = (b.polls | 0) + 1;
    const k = slow ? Math.min(5, b.polls - 1) : 0;
    b.retryFrame = this._frameNo + (ENTITY_BATCH_POLL_FRAMES << k);
  }

  _plan(b, env, pages) {
    const inst = b.inst;
    this._stats.plans += 1;
    const blk = this._entityBlocker(inst);
    if (blk) {
      if (!blk.poll || blk.reason.startsWith("structural")) { this._setLegacy(b, blk.reason); return; }
      this._wait(b, blk.reason, blk.reason === "detached");
      return;
    }
    if (!pages) {
      if ((b.rendererWaits += 1) > ENTITY_BATCH_RENDERER_WAIT_FRAMES) { this._setLegacy(b, "noRenderer"); return; }
      b.reason = "noRenderer";
      b.retryFrame = this._frameNo + 1;
      return;
    }
    const cands = this._collect(inst);
    // Entity-level: a VFX plan variant, a mapless (spawn-race) leaf, a ReplaceObject leaf.
    let mapless = false;
    for (const c of cands) {
      const m = c.leaf.material;
      if (c.reason === "structural:replaced") { this._setLegacy(b, "structural:replaced"); return; }
      if (m && !Array.isArray(m) && m.userData && m.userData.__vfxSetKey) { this._setLegacy(b, "vfxPlan"); return; }
      if (m && !Array.isArray(m) && !m.map && m.isMeshStandardMaterial && c.reason !== "translucent" && c.reason !== "additive") mapless = true;
    }
    if (mapless) {
      if (b.reason !== "mapless") _count(this._stats.fallbacks, "mapless");
      this._wait(b, "mapless", true);
      return;
    }
    // The batch mask: the home mask of the first batchable leaf.
    let mask = null;
    let firstGeo = null;
    const batch = [];
    const legacy = [];
    for (const c of cands) {
      if (!c.reason) {
        if (mask === null) mask = c.leaf.layers.mask;
        if (c.leaf.layers.mask !== mask) c.reason = "layerMix";
      }
      if (!c.reason) {
        const gr = leafGeometryReason(c.leaf.geometry, firstGeo);
        if (gr) c.reason = "attrSet";
        else if (!firstGeo) firstGeo = c.leaf.geometry;
      }
      if (!c.reason && b.noBatchMats && b.noBatchMats.has(c.leaf.material)) c.reason = "pageFull";
      if (!c.reason && b.selfCheckSigs && b.selfCheckSigs.has(entityRunKeyOf(c.leaf.material))) c.reason = "class-self-check";
      if (c.reason) {
        legacy.push(c);
        _count(this._stats.leafRoutes, c.reason);
        // Census (2026-10-31): the whole extra-map set of a leaf refused for a map.
        if (c.reason.startsWith("map:") && c.leaf.material && !Array.isArray(c.leaf.material)) _count(this._stats.extraMaps, _extraMapSet(c.leaf.material));
      } else {
        batch.push(c);
        // The same census for the map parts that batch (header "AO / ROUGHNESS / EMISSIVE PARTS").
        if (memberMapSet(c.leaf.material).any) _count(this._stats.mapLeaves, _extraMapSet(c.leaf.material));
      }
    }
    if (batch.length < 2) {
      // Leaves the cap refused (pages full) are not a verdict on the rig: it
      // waits and re-tries them all (`_advance`), holding no layer meanwhile.
      if (legacy.some((c) => c.reason === "pageFull")) {
        if (b.reason !== "pageFull") this._stats.waits.pageFull += 1;
        b.pageFullWait = true;
        this._wait(b, "pageFull", true);
        return;
      }
      // A rig whose only blockers are per-entity clones (a fade that ended
      // somewhere other than the authored state) waits; anything else is final.
      const ownClone = legacy.some((c) => inst._entityMaterials && inst._entityMaterials.get(c.did) === c.leaf.material && c.leaf.material?.userData?.__disposable === true);
      if (ownClone) { this._wait(b, "nothingToBatch:clone", true); return; }
      this._setLegacy(b, "nothingToBatch");
      return;
    }
    // Run order: run key by first appearance, then (part, group).
    const keyOrder = new Map();
    for (const c of batch) {
      c.runKey = entityRunKeyOf(c.leaf.material);
      if (!keyOrder.has(c.runKey)) keyOrder.set(c.runKey, keyOrder.size);
    }
    batch.sort((x, y) => (keyOrder.get(x.runKey) - keyOrder.get(y.runKey)) || (x.part - y.part) || (x.group - y.group));
    const runKeys = batch.map((c) => c.runKey);
    // The appearance the leaves were BUILT from: the spawn's own (post-LOD:
    // its local modelChanges carry the LOD part swap; `inst.meta` does not)
    // until a hot-swap, which fetches from `inst.meta` (set to the new
    // appearance before this plan). The bit-verify keeps any key correct;
    // this keeps the collision count honest.
    const setupId = ((inst._setupId ?? b.setupId) >>> 0);
    const fromMeta = b.keyFromMeta === true || !b.modelChanges;
    const mcKey = fromMeta ? (inst.meta?.modelChanges ?? b.modelChanges) : b.modelChanges;
    const tcKey = (b.keyFromMeta === true || !b.textureChanges) ? (inst.meta?.textureChanges ?? b.textureChanges) : b.textureChanges;
    const key = entryKeyOf(setupId, mcKey, tcKey, batch, runKeys);
    const batchedDids = new Set(batch.map((c) => c.did));
    const legacyDids = new Set(legacy.map((c) => c.did));
    const partCount = inst.parts.length;
    const partHas = new Uint8Array(partCount);
    for (const c of batch) partHas[c.part] = 1;
    // Structure snapshot (the tick guard): every candidate leaf per part, in order.
    const partKids = [];
    for (let p = 0; p < partCount; p += 1) partKids.push([]);
    for (const c of cands) partKids[c.part].push(c.leaf);
    const partChildCount = new Int32Array(partCount);
    for (let p = 0; p < partCount; p += 1) partChildCount[p] = inst.parts[p] ? inst.parts[p].children.length : 0;
    b.plan = {
      key, mask, cands, batch, legacy, runKeys, batchedDids, legacyDids, partHas, partKids, partChildCount,
      members: batch.map((c) => c.leaf.material),
      maps: batch.map((c) => c.leaf.material.map),
      mapVersions: batch.map((c) => c.leaf.material.map.version),
      geometries: batch.map((c) => c.leaf.geometry),
      memberRefs: new Map(), // member -> row entry (one layer ref per entity per member)
      partRow: new Int32Array(partCount),
      runs: null,
      pagesGen: pages.generation,
    };
    b.leaves = batch.map((c) => c.leaf);
    if (b.reason === "contextReset") this._ctx.replansSinceReset += 1;
    b.reason = null;
    b.polls = 0;
    b.status = "admitting";
  }

  // -------------------------------------------------------------------------
  // Admitting: layers, state rows, part rows.
  // -------------------------------------------------------------------------

  _partRowTex() {
    if (!this._partRows) {
      const self = this;
      this._partRows = new RowTexture({
        texelsPerRow: 4, rows: 256, name: "gpu-batch-entity-parts",
        onTexture: (t) => trackContextGenerations(t, () => liveContextGeneration(self._env().renderer)),
        disposeTexture: disposeOnLiveContext,
      });
    }
    return this._partRows;
  }

  /** Is `member` one of the rig's own (per-entity / paletted) materials for `did`? */
  _perEntity(b, member, did) {
    const em = b.inst && b.inst._entityMaterials;
    return !!(em && em.get(did) === member);
  }

  /**
   * The layer `member.map` would take: `{ desc, key }` (page descriptor and
   * content key, as `_admitMap` would admit it), or null when it has none.
   */
  _layerQuery(b, member, did) {
    const tex = member && member.map;
    if (!tex) return null;
    if (this._perEntity(b, member, did) && !admitPixelsMismatch(tex)) {
      const w = tex.image.width | 0, h = tex.image.height | 0;
      return { desc: scratchDescriptor(w, h, admitPixelsOpts(tex)), key: this._palKeys.keyFor(tex, did) };
    }
    const desc = describeTexture(tex);
    return desc ? { desc, key: contentKeyOf(tex) } : null;
  }

  /**
   * The member's layer: value-keyed for a per-entity (paletted) material, else
   * identity. A value-keyed composite whose legacy 2D texture three already
   * holds is copied from that texture's own levels (`admitAs`: the texels the
   * legacy draw samples, no scratch upload); otherwise the admitPixels
   * scratch (uploaded, copied, disposed: no lasting 2D copy).
   */
  _admitMap(b, member, did, pages, budget) {
    const tex = member.map;
    const L = this._stats.layers;
    const perEntity = this._perEntity(b, member, did);
    if (perEntity) {
      const why = admitPixelsMismatch(tex);
      if (!why) {
        const ck = this._palKeys.keyFor(tex, did);
        const fresh = pages.alloc.needsUpload(ck);
        const w = tex.image.width | 0, h = tex.image.height | 0;
        const fromLegacy = fresh && typeof pages.admitAs === "function" && typeof pages.isResident === "function" && pages.isResident(tex);
        const r = fromLegacy ? pages.admitAs(tex, ck, budget) : pages.admitPixels(tex.image.data, w, h, admitPixelsOpts(tex), ck, budget);
        if (r && !r.deferred) {
          L.value += 1;
          if (fresh) { L.freshValue += 1; L.freshBytes += r.page.layerBytes; if (fromLegacy) L.fromLegacy += 1; else L.scratch += 1; }
        }
        return r;
      }
    }
    const fresh = pages.alloc.needsUpload(contentKeyOf(tex));
    const r = pages.admit(tex, budget);
    if (r && !r.deferred) {
      L.identity += 1;
      if (fresh) { L.freshIdentity += 1; L.freshBytes += r.page.layerBytes; }
      // A recolored composite three would not upload like the scratch: by identity.
      if (perEntity) L.identityAdmits += 1;
    }
    return r;
  }

  _admit(b, pages, budget) {
    const plan = b.plan;
    const table = kitStateTable();
    // Distinct members, in run order. A member the cap refuses is skipped
    // (its leaves stay legacy); the plan is redone without it at the end.
    for (let i = 0; i < plan.members.length; i += 1) {
      const m = plan.members[i];
      if (plan.memberRefs.has(m)) continue;
      if (b.noBatchMats && b.noBatchMats.has(m)) continue;
      let row = this._rows.get(m);
      if (row && (row.map !== m.map || row.mapVersion !== m.map.version || row.pagesGen !== plan.pagesGen
        || (row.pom && row.pom.texture.version !== row.pomVersion) || _rowMapsStale(row, m))) row = null; // stale (drift is handled per tick)
      if (!row) {
        const did = plan.batch[i].did;
        const r = this._admitMap(b, m, did, pages, budget);
        if (r && r.deferred) { this._stats.layers.deferred += 1; return false; }
        if (!r) { this._admitRefused(b, m); continue; }
        // The member's further layers, each through the same kit pages: the
        // normal map; (POM parts) the height plane; (map parts) the AO plane
        // (R8) and the roughness plane (header "AO / ROUGHNESS / EMISSIVE
        // PARTS"). A deferral drops what was taken and retries next frame; a
        // refusal drops it and leaves the member a legacy leaf.
        const held = [r.contentKey];
        let fail = 0; // 1 = deferred, 2 = refused
        const more = (tex, opts) => {
          if (fail) return null;
          const x = pages.admit(tex, budget, opts);
          if (x && x.deferred) { fail = 1; return null; }
          if (!x) { fail = 2; return null; }
          held.push(x.contentKey);
          return x;
        };
        const nrm = m.normalMap ? more(m.normalMap, null) : null;
        const pom = _pomOf(m);
        const hgt = pom ? more(pom.texture, R8_PLANES) : null;
        const maps = memberMapSet(m);
        const ao = maps.ao ? more(m.aoMap, R8_PLANES) : null;
        const rgh = maps.rough ? more(m.roughnessMap, null) : null;
        const drop = () => { for (const k of held) pages.release(k); };
        if (fail === 1) { drop(); this._stats.layers.deferred += 1; return false; }
        if (fail === 2) { drop(); this._admitRefused(b, m); continue; }
        // The extension row (POM state and / or the extra-map state; layer_state.js packExtState).
        let extRow = 0;
        const pomState = pom ? {} : null;
        const mapState = maps.any ? {} : null;
        if (pom || maps.any) {
          extRow = table.addExt(pom ? pomStateOf(m, pom, hgt.layer, pomState) : null,
            maps.any ? extraMapStateOf(m, ao ? ao.layer : 0, rgh ? rgh.layer : 0, maps.emissive ? r.layer : 0, mapState) : null, budget);
          if (extRow < 0) { drop(); return false; }
          if (pom) this._stats.layers.pom += 1;
        }
        const slot = table.addFromMaterial(m, r.layer, budget, nrm ? nrm.layer : 0, extRow);
        if (slot < 0) {
          drop();
          if (extRow > 0) table.remove(extRow);
          return false;
        }
        if (ao) this._stats.layers.ao += 1;
        if (rgh) this._stats.layers.roughness += 1;
        if (maps.emissive) this._stats.layers.emissive += 1;
        row = {
          member: m, slot, refs: 0, page: r.page, layer: r.layer, contentKey: r.contentKey,
          nrmPage: nrm ? nrm.page : null, nrmLayer: nrm ? nrm.layer : 0, nrmKey: nrm ? nrm.contentKey : null,
          map: m.map, mapVersion: m.map.version, normalMap: m.normalMap || null,
          nrmVersion: m.normalMap ? m.normalMap.version : -1, pagesGen: plan.pagesGen, pages,
          pom, pomPage: hgt ? hgt.page : null, pomLayer: hgt ? hgt.layer : 0, pomKey: hgt ? hgt.contentKey : null,
          pomState, pomVersion: pom ? pom.texture.version : -1,
          // The extension row (0 = none) and, for POM parts, its POM-era name.
          extRow,
          get pomRow() { return this.pom ? this.extRow : 0; },
          // Map parts: the set the row was admitted for, its planes and layers, the map half of the extension row.
          maps, mapState,
          aoTex: ao ? m.aoMap : null, aoVersion: ao ? m.aoMap.version : -1, aoPage: ao ? ao.page : null, aoLayer: ao ? ao.layer : 0, aoKey: ao ? ao.contentKey : null,
          rghTex: rgh ? m.roughnessMap : null, rghVersion: rgh ? m.roughnessMap.version : -1, rghPage: rgh ? rgh.page : null,
          rghLayer: rgh ? rgh.layer : 0, rghKey: rgh ? rgh.contentKey : null,
          snap: this._snapshotMember(m), users: new Set(),
        };
        this._rows.set(m, row);
      } else {
        // One layer reference per (entity, content key). (A layer of the row
        // no longer resident: the row is admitted afresh, planes included.)
        const gone = (k) => !!k && !pages.alloc.lookup(k);
        if (gone(row.contentKey) || gone(row.aoKey) || gone(row.rghKey)) { this._rows.delete(m); i -= 1; continue; }
        pages.alloc.acquire(row.page.desc, row.contentKey);
        if (row.nrmKey) pages.alloc.acquire(row.nrmPage.desc, row.nrmKey);
        if (row.pomKey) pages.alloc.acquire(row.pomPage.desc, row.pomKey);
        if (row.aoKey) pages.alloc.acquire(row.aoPage.desc, row.aoKey);
        if (row.rghKey) pages.alloc.acquire(row.rghPage.desc, row.rghKey);
      }
      row.refs += 1;
      row.users.add(b);
      plan.memberRefs.set(m, row);
    }
    // Members the cap refused: plan again without them, IN PLACE (their
    // leaves legacy, the rest batched; the layers already held are kept, so
    // nothing goes idle for another rig to evict). Not churn: every pass
    // drops at least one member.
    if (b.noBatchMats && plan.members.some((m) => b.noBatchMats.has(m))) {
      if (!this._replanInPlace(b, pages)) return false;
      return this._admit(b, pages, budget);
    }
    // Part rows.
    const rows = this._partRowTex();
    for (let p = 0; p < plan.partHas.length; p += 1) {
      if (!plan.partHas[p] || plan.partRow[p] > 0) continue;
      if (rows.rowsUsed >= ENTITY_PART_ROWS_MAX && !(rows._free && rows._free.length > 0)) { this._teardown(b); this._setLegacy(b, "rowsFull"); return false; }
      const r = rows.alloc(budget);
      if (r < 0) return false;
      plan.partRow[p] = r;
      this._stats.rows.partRows += 1;
    }
    // Runs: consecutive leaves with one run key and one (map page, normal
    // page, height page; the row's map set and its AO / roughness pages).
    const runs = [];
    for (let i = 0; i < plan.batch.length; i += 1) {
      const row = plan.memberRefs.get(plan.members[i]);
      const pk = `${row.page.id}|${row.nrmPage ? row.nrmPage.id : "-"}${row.pomPage ? "|h" + row.pomPage.id : ""}${_rowMapPagesKey(row)}`;
      const last = runs[runs.length - 1];
      if (last && last.runKey === plan.runKeys[i] && last.pk === pk) { last.count += 1; continue; }
      runs.push({ runKey: plan.runKeys[i], pk, first: i, count: 1, row, classEntry: null });
    }
    plan.runs = runs;
    return true;
  }

  /**
   * Re-plan `b` (status admitting, no part row yet) without its page-refused
   * members, carrying the layer + state rows it already holds over to the new
   * plan (released only for members the new plan dropped). True when the new
   * plan is admitting; false when it waits (fewer than two leaves left: every
   * held row released) or went legacy.
   */
  _replanInPlace(b, pages) {
    const held = b.plan.memberRefs;
    this._stats.replans += 1;
    _count(this._stats.replanReasons, "pageFull");
    b.plan = null;
    b.leaves = null;
    b.status = "pending";
    this._plan(b, null, pages);
    const keep = b.status === "admitting" ? new Set(b.plan.members) : null;
    for (const [m, row] of held) {
      if (keep && keep.has(m)) b.plan.memberRefs.set(m, row);
      else this._releaseRow(b, m, row);
    }
    return b.status === "admitting";
  }

  /** Drop `b`'s reference on one member row (layer refs, and the state row at its last user). */
  _releaseRow(b, m, row) {
    row.users.delete(b);
    row.refs -= 1;
    try { row.pages.release(row.contentKey); } catch (_) { /* fail-soft */ }
    if (row.nrmKey) { try { row.pages.release(row.nrmKey); } catch (_) { /* fail-soft */ } }
    if (row.pomKey) { try { row.pages.release(row.pomKey); } catch (_) { /* fail-soft */ } }
    if (row.aoKey) { try { row.pages.release(row.aoKey); } catch (_) { /* fail-soft */ } }
    if (row.rghKey) { try { row.pages.release(row.rghKey); } catch (_) { /* fail-soft */ } }
    if (row.refs <= 0) {
      if (this._rows.get(m) === row) this._rows.delete(m);
      try { kitStateTable().remove(row.slot); } catch (_) { /* fail-soft */ }
      if (row.extRow > 0) { try { kitStateTable().remove(row.extRow); } catch (_) { /* fail-soft */ } }
    }
  }

  /** The cap refused `member`'s layer: it stays a legacy leaf (re-tried later), the rig goes on. */
  _admitRefused(b, member) {
    this._stats.layers.refused += 1;
    this._stats.layers.refusedMembers += 1;
    if (!b.noBatchMats) b.noBatchMats = new Set();
    b.noBatchMats.add(member);
    b.pageFullFrame = this._frameNo;
  }

  /**
   * Every page-refused member of an active rig could get its layer now? (The
   * cap freed room: a release, a reclaim.) Then the rig re-plans with them.
   */
  _refusedWouldFit(b, pages) {
    if (!pages || !b.noBatchMats || !b.plan) return false;
    for (const m of b.noBatchMats) {
      const c = b.plan.cands.find((x) => x.leaf.material === m);
      if (!c) continue; // no longer on the rig: the next re-plan drops it
      const q = this._layerQuery(b, m, c.did);
      if (!q || !pages.alloc.wouldAcquire(q.desc, q.key)) return false;
      if (m.normalMap) {
        const nd = describeTexture(m.normalMap);
        if (!nd || !pages.alloc.wouldAcquire(nd, contentKeyOf(m.normalMap))) return false;
      }
      const pom = _pomOf(m);
      if (pom) {
        const hd = describeTexture(pom.texture, R8_PLANES);
        if (!hd || !pages.alloc.wouldAcquire(hd, contentKeyOf(pom.texture))) return false;
      }
      // Map parts: the AO (R8) and roughness planes.
      if (m.aoMap) {
        const ad = describeTexture(m.aoMap, R8_PLANES);
        if (!ad || !pages.alloc.wouldAcquire(ad, contentKeyOf(m.aoMap))) return false;
      }
      if (m.roughnessMap) {
        const rd = describeTexture(m.roughnessMap);
        if (!rd || !pages.alloc.wouldAcquire(rd, contentKeyOf(m.roughnessMap))) return false;
      }
    }
    return true;
  }

  /** The member fields the batch copies or depends on (drift fingerprint). */
  _snapshotMember(m) {
    const em = m.emissive;
    return {
      version: m.version, side: m.side, alphaTest: m.alphaTest > 0, transparent: m.transparent === true,
      blending: m.blending, visible: m.visible !== false, obc: m.onBeforeCompile, cpk: m.customProgramCacheKey,
      fog: m.fog, depthTest: m.depthTest, depthWrite: m.depthWrite, depthFunc: m.depthFunc, colorWrite: m.colorWrite,
      lum: !!(em && (em.r !== 0 || em.g !== 0 || em.b !== 0)), emissiveMap: m.emissiveMap || null,
    };
  }

  /** How `m` drifted from its snapshot: null, "visible" (collapse), or a re-plan / demote reason. */
  _memberDrift(row) {
    const m = row.member;
    const s = row.snap;
    if (m.map !== row.map || (m.map && m.map.version !== row.mapVersion)) return "drift:map";
    if ((m.normalMap || null) !== row.normalMap || (row.normalMap && row.normalMap.version !== row.nrmVersion)) return "drift:map";
    if (row.pom) {
      // The height plane the chain binds re-uploaded, or a live handle pointing elsewhere.
      if (row.pom.texture.version !== row.pomVersion) return "drift:map";
      const live = m.userData ? m.userData.pomShaderUniforms : null;
      if (live && live.uPomMap && live.uPomMap.value !== row.pom.texture) return "drift:map";
    }
    // Map parts (header "AO / ROUGHNESS / EMISSIVE PARTS"): a texchan plane
    // that ARRIVED (told before the version compare: `_applyRough` bumps the
    // version too); one that left, was swapped or re-uploaded is a map swap.
    const ao = row.aoTex || null, rgh = row.rghTex || null;
    if ((m.aoMap || null) !== ao) return ao === null ? "drift:ao-map-arrived" : "drift:map";
    if (ao && ao.version !== row.aoVersion) return "drift:map";
    if ((m.roughnessMap || null) !== rgh) return rgh === null ? "drift:roughness-map-arrived" : "drift:map";
    if (rgh && rgh.version !== row.rghVersion) return "drift:map";
    if ((m.transparent === true) !== s.transparent || m.blending !== s.blending) return "drift:blend";
    if ((m.alphaTest > 0) !== s.alphaTest) return "drift:blend";
    if (m.side !== s.side) return "drift:side";
    const em = m.emissive;
    if (!!(em && (em.r !== 0 || em.g !== 0 || em.b !== 0)) !== s.lum || (m.emissiveMap || null) !== s.emissiveMap) return "drift:luminous";
    if (m.onBeforeCompile !== s.obc || m.customProgramCacheKey !== s.cpk) return "drift:chain";
    if (m.fog !== s.fog || m.depthTest !== s.depthTest || m.depthWrite !== s.depthWrite || m.depthFunc !== s.depthFunc || m.colorWrite !== s.colorWrite) return "drift:raster";
    if (m.version !== s.version) {
      // A program-relevant change bumps the version: the run key must still hold.
      if (entityArrayReason(m)) return "drift:chain";
      const pom = _pomOf(m); // a fresh dry run after a version bump: compare what it binds
      if ((pom ? pom.texture : null) !== (row.pom ? row.pom.texture : null)) return "drift:chain";
      s.version = m.version;
    }
    return null;
  }

  /** Per frame: each distinct member once — drift, then its state row. */
  _syncMembers() {
    if (this._rows.size === 0) return;
    const table = kitStateTable();
    // (A drift's teardown deletes rows while this loop runs: a Map iterator
    // skips entries deleted ahead of it, so no copy is needed.)
    for (const row of this._rows.values()) {
      const drift = this._memberDrift(row);
      if (drift) {
        for (const b of [...row.users]) {
          if (drift === "drift:blend" || drift === "drift:luminous") {
            // A demoted user waits for its poll (which re-qualifies every leaf).
            if (b.status !== "demoted") this.demote(b.inst, drift);
          } else if (drift === "drift:ao-map-arrived" || drift === "drift:roughness-map-arrived") this._mapArrival(b, drift);
          else this._replan(b, drift);
        }
        continue;
      }
      const ext = row.extRow > 0 ? row.extRow : 0;
      table.writeFromMaterial(row.slot, row.member, row.layer, row.nrmLayer, ext);
      if (ext > 0) {
        table.writeExt(ext, row.pom ? pomStateOf(row.member, row.pom, row.pomLayer, row.pomState) : null,
          row.maps.any ? _rowMapState(row, row.member, row.mapState) : null);
      }
    }
  }

  _releaseMemberRows(b) {
    const plan = b.plan;
    if (!plan) return;
    for (const [m, row] of plan.memberRefs) this._releaseRow(b, m, row);
    plan.memberRefs.clear();
  }

  // -------------------------------------------------------------------------
  // Warming: class materials and their programs.
  // -------------------------------------------------------------------------

  /**
   * `maps` (map parts, header "AO / ROUGHNESS / EMISSIVE PARTS"): null, or
   * { aoUniform, roughnessUniform, emissive } (the AO / roughness page
   * holders; emissive samples the map page).
   */
  _classOpts(member, cls, mapUniform, normalUniform, pomUniform = null, maps = null) {
    const rows = this._partRowTex();
    // POM parts: the chain fingerprint keys the program (header "POM PARTS").
    const pv = entityPomVerdict(member);
    const hookKey = pv && !pv.reason ? ENTITY_VERTEX_HOOK_KEY + "|pomc" + pv.id : ENTITY_VERTEX_HOOK_KEY;
    return {
      cls,
      chain: memberChainHook(member),
      chainKey: memberProgramKey(member) || "",
      mapUniform,
      normalUniform,
      pomUniform,
      aoUniform: maps && maps.aoUniform ? maps.aoUniform : null,
      roughnessUniform: maps && maps.roughnessUniform ? maps.roughnessUniform : null,
      emissive: !!(maps && maps.emissive),
      stateUniform: kitStateTable().rows.uniform,
      vertexHook: (shader) => {
        shader.uniforms[ENTITY_PART_SAMPLER] = rows.uniform;
        injectVertexHeader(shader,
          instanceRedirectChunk({ sampler: ENTITY_PART_SAMPLER, rowAttr: ENTITY_PART_ATTR, matrixTexel: 0, compose: false }),
          ROW_REDIRECT_MARKER, "hbBatchRowSetup");
      },
      vertexHookKey: hookKey,
      base: {
        fog: member.fog, envMapIntensity: member.envMapIntensity, dithering: member.dithering,
        toneMapped: member.toneMapped, depthTest: member.depthTest,
      },
    };
  }

  _makeClass(member, cls, opts) {
    const material = makeClassMaterial(opts);
    material.depthWrite = member.depthWrite;
    material.colorWrite = member.colorWrite;
    material.depthFunc = member.depthFunc;
    material.name = `gpu-batch-entity-class-${classKeyOf(cls)}`;
    return material;
  }

  _classEntryFor(run) {
    const m = run.row.member;
    const cls = memberClass(m);
    const mapPage = run.row.page;
    const nrmPage = run.row.nrmPage;
    const pomPage = run.row.pomPage || null;
    // Map parts: the ROW's set and its AO / roughness pages (a run never mixes them: `_admit`).
    const ms = run.row.maps || MAP_SET_NONE;
    const aoPage = run.row.aoPage || null;
    const rghPage = run.row.rghPage || null;
    const key = `${classKeyOf(cls)}|${mapPage.id}|${nrmPage ? nrmPage.id : "-"}${pomPage ? "|h" + pomPage.id : ""}${_rowMapPagesKey(run.row)}|${run.runKey}`;
    let e = this._classMats.get(key);
    if (!e) {
      const opts = this._classOpts(m, cls, { value: mapPage.gl.texture }, nrmPage ? { value: nrmPage.gl.texture } : null,
        pomPage ? { value: pomPage.gl.texture } : null,
        ms.any ? { aoUniform: aoPage ? { value: aoPage.gl.texture } : null, roughnessUniform: rghPage ? { value: rghPage.gl.texture } : null, emissive: ms.emissive } : null);
      if (classPatchMissing({ chain: opts.chain, withNormal: !!nrmPage, withPom: !!pomPage, maps: ms }) !== 0) return null;
      const material = this._makeClass(m, cls, opts);
      const programKey = material.customProgramCacheKey();
      if (!this._warm.has(programKey)) {
        this._warm.set(programKey, { material: this._makeClass(m, cls, opts), tries: 0, registered: false, warmedOn: null });
      }
      e = { key, material, refs: 0, programKey };
      this._classMats.set(key, e);
    }
    e.refs += 1;
    return e;
  }

  _releaseClassEntry(e) {
    if (!e) return;
    e.refs -= 1;
    if (e.refs > 0) return;
    this._classMats.delete(e.key);
    this._disposeClassMaterial(e.material);
  }

  /** Dispose, unless the context is lost right now (anim_scenery_batch's rule). */
  _disposeClassMaterial(material) {
    if (kitLiveGeneration() === LOST_CONTEXT_GENERATION) return;
    try { material.dispose(); } catch (_) { /* fail-soft */ }
  }

  _resolveClasses(b) {
    for (const run of b.plan.runs) {
      if (run.classEntry) continue;
      run.classEntry = this._classEntryFor(run);
      if (!run.classEntry) {
        if (!b.selfCheckSigs) b.selfCheckSigs = new Set();
        b.selfCheckSigs.add(run.runKey);
        _count(this._stats.leafRoutes, "class-self-check");
        this._replan(b, "class-self-check");
        return false;
      }
    }
    return true;
  }

  /** The canonical classes (registered at the first spawn: the login loading screen). */
  _registerCanonicalClasses() {
    if (_canonicalShared) return _canonicalShared;
    _canonicalShared = (async () => {
      let installLightClamp = null;
      try { ({ installLightClampShaderPatch: installLightClamp } = await import("../materials.js")); } catch (_) { installLightClamp = null; }
      const keys = [];
      for (const clamp of [false, true]) {
        for (const blend of ["opaque", "alphaTest"]) {
          const member = new THREE.MeshStandardMaterial({ map: dummyMap(), side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
          if (blend === "alphaTest") member.alphaTest = 100 / 255;
          if (clamp) {
            if (typeof installLightClamp !== "function") continue;
            installLightClamp(member);
          }
          const material = makeClassMaterial(this._classOpts(member, { blend, light: "lit", side: "double" }, { value: null }, null));
          const key = material.customProgramCacheKey();
          if (this._warm.has(key)) continue;
          this._warm.set(key, { material, tries: 0, registered: true, warmedOn: null });
          registerBatchClassPrewarm(key, () => [classPrewarmProxy(material, { extraAttributes: [ENTITY_PART_ATTR] })]);
          keys.push(key);
        }
      }
      const env = this._env();
      if (env.renderer && env.camera) {
        try { prewarmBatchClasses(env.renderer, env.camera, env.scene || null); } catch (_) { /* first draw compiles */ }
      }
      return keys;
    })();
    return _canonicalShared;
  }

  _classReady(e, env) {
    if (!env.renderer) return true;
    const w = this._warm.get(e.programKey);
    if (!w) return true;
    if (!w.registered) {
      w.registered = true;
      registerBatchClassPrewarm(e.programKey, () => [classPrewarmProxy(w.material, { extraAttributes: [ENTITY_PART_ATTR] })]);
    }
    const ctx = kitContextGeneration(env.renderer);
    if (w.warmedOn !== ctx && env.camera) {
      w.warmedOn = ctx;
      w.tries = 0;
      try { prewarmBatchClasses(env.renderer, env.camera, env.scene || null); } catch (_) { /* first draw compiles */ }
    }
    const progs = programsOf(env.renderer, w.material);
    if (progs.length === 0) return ++w.tries > ENTITY_BATCH_WARM_WAIT_FRAMES;
    for (const p of progs) if (programPending(p)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Building: the shared entry, the per-entity geometry, the mesh.
  // -------------------------------------------------------------------------

  _entryFor(plan) {
    const list = this._entries.get(plan.key);
    if (list) {
      for (const e of list) {
        if (entryMatches(e, plan.geometries)) { this._stats.entries.hits += 1; return { entry: e, fresh: false }; }
      }
      this._stats.entries.collisions += 1;
    } else {
      this._stats.entries.misses += 1;
    }
    return { entry: null, fresh: true };
  }

  _buildEntry(plan) {
    const t0 = uploadNowMs();
    const merged = mergeGeometriesForBatch(plan.geometries, null);
    const g = merged.geometry;
    const attrs = {};
    for (const n of Object.keys(g.attributes)) attrs[n] = g.attributes[n];
    const entry = {
      key: plan.key, attrs, attrNames: Object.keys(attrs), index: g.index || null, slices: merged.slices,
      sources: plan.geometries.slice(), vertexCount: g.attributes.position.count,
      sharedBytes: merged.bytes, users: 0, glLive: false, ticket: null, ticketBudget: null, restRadius: 0,
    };
    let list = this._entries.get(plan.key);
    if (!list) { list = []; this._entries.set(plan.key, list); }
    list.push(entry);
    this._budgetMs(uploadNowMs() - t0, "geometryBuild");
    return entry;
  }

  _restRadius(b, entry) {
    const inst = b.inst;
    const ro = inst._restOrigins;
    let r = 0;
    for (let i = 0; i < b.plan.batch.length; i += 1) {
      const c = b.plan.batch[i];
      const geo = c.leaf.geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const bs = geo.boundingSphere;
      let o = 0;
      if (ro && ro.length >= (c.part + 1) * 3) o = Math.hypot(ro[c.part * 3], ro[c.part * 3 + 1], ro[c.part * 3 + 2]);
      const v = o + bs.center.length() + bs.radius;
      if (v > r) r = v;
    }
    return r;
  }

  _identityInstanceMatrix() {
    if (!this._identityIM) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(16), 16);
      new THREE.Matrix4().toArray(a.array, 0);
      this._identityIM = a;
    }
    return this._identityIM;
  }

  /** Charge + build; true when the mesh exists (the caller shows it in this same sync). */
  _build(b, budget, env) {
    const inst = b.inst;
    const plan = b.plan;
    if (!inst.root || !inst.root.parent || inst.root.visible === false) return false; // would not draw (or upload) this frame
    let { entry } = this._entryFor(plan);
    let V = 0;
    if (entry) V = entry.vertexCount;
    else {
      const first = plan.geometries[0];
      const indexed = first.index !== null && first.index !== undefined;
      for (const g of plan.geometries) V += indexed ? referencedVerticesOf(g).length : g.attributes.position.count;
    }
    const ownBytes = 2 * Float32Array.BYTES_PER_ELEMENT * V;
    // The shared attributes upload once per GL context, at the first draw of
    // ANY user: their bytes are charged once, on a ticket the ENTRY owns
    // (landed by whichever user's draw uploads them; dropped only when the
    // entry loses its last user before that).
    const sharedBytes = entry ? ((entry.glLive || entry.ticket) ? 0 : entry.sharedBytes) : mergedBytesOf(plan.geometries, false);
    if (!budget.canSpend(ownBytes + sharedBytes, UPLOAD_KIND.GEOMETRY)) { budget.stats.refused += 1; return false; }
    const sharedTicket = sharedBytes > 0 ? budget.spendDeferred(sharedBytes, UPLOAD_KIND.GEOMETRY) : null;
    if (sharedBytes > 0 && !sharedTicket) return false;
    const ticket = budget.spendDeferred(ownBytes, UPLOAD_KIND.GEOMETRY);
    if (!ticket) { if (sharedTicket) budget.drop(sharedTicket); return false; }
    const t0 = uploadNowMs();
    if (!entry) entry = this._buildEntry(plan);
    if (this._idle.has(entry)) { this._idle.delete(entry); this._idleBytes -= entry.sharedBytes; }
    entry.users += 1;
    b.entry = entry;
    b.ticket = ticket;
    b.ticketBudget = budget;
    // Per-entity geometry: the shared attributes by reference + two own ones.
    const geo = new THREE.BufferGeometry();
    for (const n of entry.attrNames) geo.setAttribute(n, entry.attrs[n]);
    if (entry.index) geo.setIndex(entry.index);
    const slot = new Float32Array(V);
    const part = new Float32Array(V);
    b.slices = entry.slices;
    b.collapsed = new Uint8Array(plan.batch.length);
    b.attrZero = new Uint8Array(plan.batch.length);
    b.partAllCollapsed = new Uint8Array(plan.partHas.length);
    for (let i = 0; i < plan.batch.length; i += 1) {
      const sl = entry.slices[i];
      const row = plan.memberRefs.get(plan.members[i]);
      slot.fill(row.slot, sl.vertexStart, sl.vertexStart + sl.vertexCount);
      part.fill(plan.partRow[plan.batch[i].part], sl.vertexStart, sl.vertexStart + sl.vertexCount);
    }
    b.attrSlot = new THREE.BufferAttribute(slot, 1);
    b.attrPart = new THREE.BufferAttribute(part, 1);
    geo.setAttribute(SLOT_ATTR, b.attrSlot);
    geo.setAttribute(ENTITY_PART_ATTR, b.attrPart);
    const materials = [];
    const matIndex = new Map();
    for (const run of plan.runs) {
      let mi = matIndex.get(run.classEntry);
      if (mi === undefined) { mi = materials.length; materials.push(run.classEntry.material); matIndex.set(run.classEntry, mi); }
      const s0 = entry.slices[run.first];
      let count = 0;
      for (let k = 0; k < run.count; k += 1) count += entry.slices[run.first + k].count;
      geo.addGroup(s0.start, count, mi);
    }
    if (!entry.restRadius) entry.restRadius = this._restRadius(b, entry);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(ENTITY_BATCH_MIN_RADIUS, 1.5 * entry.restRadius));
    geo.boundingBox = new THREE.Box3();
    const mesh = new THREE.InstancedMesh(geo, materials, 1);
    mesh.instanceMatrix = this._identityInstanceMatrix();
    mesh.name = `entity-batch-${(inst.guid >>> 0).toString(16)}`;
    // The record is NON-enumerable (as interior_batch.js / materials.js keep
    // such links): Object3D.copy / clone / toJSON JSON.stringify `userData`,
    // and the record is cyclic (b.mesh, b.inst).
    mesh.userData = { hbBatchMesh: true };
    Object.defineProperty(mesh.userData, "hbRecord", { value: b, writable: true, configurable: true, enumerable: false });
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.mask = plan.mask;
    // Object-level bounds: an EMPTY box (Box3.expandByObject unions nothing,
    // so every rig box is exactly the leaves'), a root-local sphere for the
    // frustum test (>= the rig cull's 6 m, >= 1.5x the rest-pose extent).
    mesh.boundingBox = new THREE.Box3();
    mesh.boundingSphere = geo.boundingSphere.clone();
    mesh.raycast = hbEntityBatchRaycast;
    mesh.onBeforeRender = hbEntityBatchBeforeRender;
    mesh.onAfterRender = hbEntityBatchAfterRender;
    mesh.visible = false;
    b.drawT0 = -2;
    if (sharedTicket) this._armEntry(entry, budget, sharedTicket);
    this._trackGeometry(b, geo, budget, ticket, env.renderer);
    b.geometry = geo;
    b.mesh = mesh;
    this._stats.builds += 1;
    this._budgetMs(uploadNowMs() - t0, undefined);
    return true;
  }

  /**
   * The per-entity geometry's GL lifecycle: generation-tagged dispose
   * listeners (no GL deletes of a lost context) and the entity's upload
   * ticket, landed by three's onUploadCallback of its two own attributes.
   */
  _trackGeometry(b, geo, budget, ticket, renderer) {
    let touched = -1;
    const owner = this;
    trackContextGenerations(geo, () => liveContextGeneration(renderer || owner._env().renderer), () => {
      if (touched < 0) touched = uploadNowMs();
    });
    let left = 2;
    const onUpload = function hbEntityBatchUpload() {
      delete this.onUploadCallback;
      budget.land(ticket, this.array.byteLength);
      left -= 1;
      if (left === 0) {
        if (b.ticket === ticket) { b.ticket = null; b.ticketBudget = null; }
        if (touched >= 0) owner._budgetMs(uploadNowMs() - touched, "geometryUpload");
      }
    };
    b.attrSlot.onUploadCallback = onUpload;
    b.attrPart.onUploadCallback = onUpload;
  }

  /** The entry's shared attributes + index land the entry's ticket (one upload per GL context). */
  _armEntry(entry, budget, ticket) {
    const list = entry.attrNames.map((n) => entry.attrs[n]);
    if (entry.index) list.push(entry.index);
    entry.ticket = ticket;
    entry.ticketBudget = budget;
    let left = list.length;
    const onUpload = function hbEntityBatchSharedUpload() {
      delete this.onUploadCallback;
      budget.land(ticket, this.array.byteLength);
      left -= 1;
      if (left === 0 && entry.ticket === ticket) { entry.ticket = null; entry.ticketBudget = null; entry.glLive = true; }
    };
    for (const a of list) a.onUploadCallback = onUpload;
  }

  /** The entry's charged upload will not happen (no user left to draw it, or a new context). */
  _disarmEntry(entry) {
    if (entry.ticket) { try { entry.ticketBudget.drop(entry.ticket); } catch (_) { /* fail-soft */ } }
    entry.ticket = null;
    entry.ticketBudget = null;
    if (entry.attrs) for (const n of entry.attrNames) { const a = entry.attrs[n]; if (Object.prototype.hasOwnProperty.call(a, "onUploadCallback")) delete a.onUploadCallback; }
    if (entry.index && Object.prototype.hasOwnProperty.call(entry.index, "onUploadCallback")) delete entry.index.onUploadCallback;
  }

  _beginOverlap(b) {
    b.inst.root.add(b.mesh);
    b.mesh.visible = true;
    b.status = "overlap";
    b.overlapFrames = 0;
    this._mirror(b);
  }

  _classDrawsDone(b, env) {
    if (!env.renderer) return true;
    for (const run of b.plan.runs) {
      let mp = null;
      try { mp = env.renderer.properties.get(run.classEntry.material); } catch (_) { mp = null; }
      if (!mp || mp.__version === undefined) return false;
    }
    return true;
  }

  _syncOverlap(b, env) {
    if (!this._mirror(b)) return;
    if (this._classDrawsDone(b, env)) { this._activate(b); return; }
    if (b.inst.root.visible !== false && ++b.overlapFrames > ENTITY_BATCH_OVERLAP_GIVEUP_FRAMES) {
      this._teardown(b);
      this._setLegacy(b, "neverDrawn");
    }
  }

  _activate(b) {
    this._parkAll(b);
    b.status = "active";
    b.everActive = true;
    b.activeSince = this._frameNo;
    this._stats.promotes += 1;
  }

  _syncActive(b, pages) {
    if (!this._mirror(b)) return;
    if (b.replans > 0 && this._frameNo - b.activeSince >= ENTITY_BATCH_CHURN_FORGIVE_FRAMES) {
      b.replans -= 1;
      b.activeSince = this._frameNo;
    }
    // Hidden (culled) for long: free the batch (layers idle, reclaimable at
    // the cap); the rig plans again once it is seen.
    const root = b.inst.root;
    if (root.visible === false) {
      if (b.hiddenSince === undefined || b.hiddenSince < 0) b.hiddenSince = this._frameNo;
      else if (this._frameNo - b.hiddenSince >= ENTITY_BATCH_HIDDEN_HOLD_FRAMES) {
        this._stats.waits.hiddenReleases += 1;
        this._release2Pending(b, "hidden");
        return;
      }
    } else b.hiddenSince = -1;
    // Leaves the cap refused: re-try once it could take them all.
    if (b.noBatchMats && this._frameNo - (b.pageFullFrame | 0) >= ENTITY_BATCH_PAGEFULL_RETRY_FRAMES) {
      b.pageFullFrame = this._frameNo;
      if (this._refusedWouldFit(b, pages)) {
        this._stats.waits.pageFullRetries += 1;
        b.noBatchMats = null;
        this._softReplan(b, "pageFull:retry");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Park / unpark.
  // -------------------------------------------------------------------------

  _parkAll(b) {
    for (const leaf of b.leaves) {
      const ud = leaf.userData;
      if (ud.hbParked === true) continue;
      ud.hbHomeMask = leaf.layers.mask;
      ud.hbParked = true;
      leaf.layers.set(ENTITY_PARK_LAYER);
    }
  }

  _unparkAll(b) {
    if (!b.leaves) return;
    for (const leaf of b.leaves) {
      const ud = leaf.userData;
      if (!ud || ud.hbParked !== true) continue;
      leaf.layers.mask = ud.hbHomeMask;
      delete ud.hbHomeMask;
      delete ud.hbParked;
    }
  }

  // -------------------------------------------------------------------------
  // The tick mirror (overlap / active).
  // -------------------------------------------------------------------------

  /** The rig still has the planned leaves (attached items ignored)? Else a reason. */
  _structureDrift(b) {
    const inst = b.inst;
    const plan = b.plan;
    if ((inst._dismemberStash && inst._dismemberStash.size > 0) || (inst._dismemberHidden && inst._dismemberHidden.size > 0)) return "structure:dismember";
    if (inst._dislocations && inst._dislocations.size > 0) return "dislocate";
    if (inst._wfx) return "structure:weaponFx";
    for (let p = 0; p < plan.partKids.length; p += 1) {
      const part = inst.parts[p];
      const kids = plan.partKids[p];
      if (!part) { if (kids.length) return "structure"; continue; }
      if (part.children.length === plan.partChildCount[p]) {
        let ok = true;
        for (const k of kids) if (k.parent !== part) { ok = false; break; }
        if (ok) continue;
      }
      const now = partLeaves(part);
      if (now.some((l) => l.userData && l.userData.replaced)) return "structure:replaced";
      if (now.length !== kids.length) return "structure";
      for (let i = 0; i < now.length; i += 1) if (now[i] !== kids[i]) return "structure";
      plan.partChildCount[p] = part.children.length; // an item mounted / unmounted: same leaves
    }
    return null;
  }

  /** Per tick: structure, leaf mirror, collapse. False = no longer batched this frame. */
  _mirror(b) {
    const plan = b.plan;
    const sd = this._structureDrift(b);
    if (sd) {
      if (sd === "structure:dismember" || sd === "structure:replaced" || sd === "dislocate") { this.demote(b.inst, sd); return false; }
      this._replan(b, sd);
      return false;
    }
    const leaves = b.leaves;
    let maskChanged = false;
    for (let i = 0; i < leaves.length; i += 1) {
      const leaf = leaves[i];
      if (leaf.material !== plan.members[i]) { this.demote(b.inst, "clone:other"); return false; }
      if (leaf.geometry !== plan.geometries[i]) { this._replan(b, "geometry"); return false; }
      const ud = leaf.userData;
      if (ud.hbParked === true && leaf.layers.mask !== ENTITY_PARK_MASK) {
        // Something stamped a parked leaf (a layer walk H11 / H12 did not cover).
        ud.hbHomeMask = leaf.layers.mask;
        leaf.layers.set(ENTITY_PARK_LAYER);
        this._stats.reparked += 1;
      }
      const home = ud.hbParked === true ? ud.hbHomeMask : leaf.layers.mask;
      if (home !== plan.mask) maskChanged = true;
    }
    if (maskChanged) {
      // All leaves moved together (a stamp): follow; a split is a re-plan.
      const m0 = leaves[0].userData.hbParked === true ? leaves[0].userData.hbHomeMask : leaves[0].layers.mask;
      for (const leaf of leaves) {
        const h = leaf.userData.hbParked === true ? leaf.userData.hbHomeMask : leaf.layers.mask;
        if (h !== m0) { this._replan(b, "layerMix"); return false; }
      }
      plan.mask = m0;
    }
    if (b.mesh && b.mesh.layers.mask !== plan.mask) b.mesh.layers.mask = plan.mask;
    this._mirrorCollapse(b);
    return true;
  }

  /** Collapse state per leaf -> the `hbEntPart` attribute and the part-level zero rows. */
  _mirrorCollapse(b) {
    if (!b.attrPart) return;
    const plan = b.plan;
    const leaves = b.leaves;
    const hd = b.hiddenDids;
    const n = leaves.length;
    const pac = b.partAllCollapsed;
    pac.fill(1);
    for (let i = 0; i < n; i += 1) {
      const leaf = leaves[i];
      const c = (leaf.visible === false || plan.members[i].visible === false || (hd !== null && hd !== undefined && hd.has(plan.batch[i].did))) ? 1 : 0;
      b.collapsed[i] = c;
      if (!c) pac[plan.batch[i].part] = 0;
    }
    const arr = b.attrPart.array;
    let dirty = false;
    for (let i = 0; i < n; i += 1) {
      const p = plan.batch[i].part;
      const want = (b.collapsed[i] === 1 && pac[p] === 0) ? 1 : 0;
      if (want === b.attrZero[i]) continue;
      b.attrZero[i] = want;
      const sl = b.slices[i];
      arr.fill(want ? 0 : plan.partRow[p], sl.vertexStart, sl.vertexStart + sl.vertexCount);
      b.attrPart.addUpdateRange(sl.vertexStart, sl.vertexCount);
      dirty = true;
    }
    if (dirty) b.attrPart.needsUpdate = true;
  }

  /** A building entity's members must still be on its leaves before it is charged. */
  _mirrorMembersStill(b) {
    const plan = b.plan;
    for (let i = 0; i < b.leaves.length; i += 1) {
      if (b.leaves[i].material !== plan.members[i] || b.leaves[i].geometry !== plan.geometries[i]) { this._replan(b, "drift:building"); return false; }
    }
    if (this._entityBlocker(b.inst)) { this._replan(b, "blocker:building"); return false; }
    return true;
  }

  // -------------------------------------------------------------------------
  // The late hook: part rows at the frame's first batch draw.
  // -------------------------------------------------------------------------

  _lateRows() {
    if (this._lateSerial === this._syncSerial) return;
    this._lateSerial = this._syncSerial;
    const rows = this._partRows;
    if (!rows) return;
    this._stats.rows.lateFrames += 1;
    const m = this._m;
    const e = m.elements;
    const data = rows.data;
    for (const b of this._records) {
      if (b.status !== "active" && b.status !== "overlap") continue;
      const inst = b.inst;
      if (inst.root.visible === false) continue;
      const plan = b.plan;
      if (!b.lastPose) { b.lastPose = new Float64Array(plan.partHas.length * 10); b.lastPose.fill(NaN); }
      const lp = b.lastPose;
      for (let p = 0; p < plan.partHas.length; p += 1) {
        const row = plan.partRow[p];
        if (row <= 0) continue;
        const part = inst.parts[p];
        const o = p * 10;
        if (!part || part.visible === false || b.partAllCollapsed[p] === 1) {
          if (lp[o] === lp[o]) { rows.zeroRow(row); lp[o] = NaN; this._stats.rows.lateZeros += 1; }
          continue;
        }
        const ps = part.position, q = part.quaternion, s = part.scale;
        if (part.matrixAutoUpdate !== false && part.pivot == null
          && lp[o] === ps.x && lp[o + 1] === ps.y && lp[o + 2] === ps.z
          && lp[o + 3] === q.x && lp[o + 4] === q.y && lp[o + 5] === q.z && lp[o + 6] === q.w
          && lp[o + 7] === s.x && lp[o + 8] === s.y && lp[o + 9] === s.z) { this._stats.rows.lateSkips += 1; continue; }
        composePartMatrix(part, m);
        const d = row * 16;
        for (let k = 0; k < 16; k += 1) data[d + k] = e[k];
        rows.markDirty();
        if (part.matrixAutoUpdate !== false && part.pivot == null) {
          lp[o] = ps.x; lp[o + 1] = ps.y; lp[o + 2] = ps.z;
          lp[o + 3] = q.x; lp[o + 4] = q.y; lp[o + 5] = q.z; lp[o + 6] = q.w;
          lp[o + 7] = s.x; lp[o + 8] = s.y; lp[o + 9] = s.z;
        } else lp[o] = NaN;
        this._stats.rows.lateWrites += 1;
      }
    }
    rows.flush();
  }

  // -------------------------------------------------------------------------
  // Demote / re-promote.
  // -------------------------------------------------------------------------

  /**
   * The batch-only hides AND shows (`hiddenDids`, `shownDids`), written back
   * as the state today's body would have left (every caller has unparked the
   * leaves and left the active states, so the clone getter below does not
   * re-enter `noteClone`):
   *   - "full" (a demote, a re-plan, a context reset, ReplaceObject): the
   *     per-entity clone at the ramp's value now (today's ramp path:
   *     `_getOrCloneEntityMaterial` + `_applyMaterialRamp`), and the tween
   *     itself back in `_materialHookTweens` while it would still run (a
   *     show's 0 -> 0 tween then overwrites a fade that starts inside it, as
   *     today; a finished show leaves today's opaque clone);
   *   - "tweens" (an equip hot-swap, called after the swap built the new
   *     leaves): only the still-running tweens — today the swap replaces
   *     `_entityMaterials` with fresh materials (a finished ramp is gone), and
   *     a running tween goes on writing whatever the new map holds;
   *   - "drop" (release: the entity is going away).
   */
  _materializeHidden(b, mode = "full") {
    const hd = b.hiddenDids;
    const sd = b.shownDids;
    b.hiddenDids = null;
    b.shownDids = null;
    if (!this.em || mode === "drop") return;
    if (hd && hd.size > 0) this._materializeRamps(b, hd, mode);
    if (sd && sd.size > 0) this._materializeRamps(b, sd, mode);
  }

  /** `_materializeHidden` for one did -> tween-record map. */
  _materializeRamps(b, hd, mode) {
    const inst = b.inst;
    const now = performance.now();
    for (const [did, rec] of hd) {
      const elapsed = now - rec.startMs;
      const running = rec.durationMs > 0 && elapsed < rec.durationMs;
      if (mode === "full") {
        const v = running ? rec.rampStart + (rec.rampEnd - rec.rampStart) * (elapsed / rec.durationMs) : rec.rampEnd;
        try {
          const mat = this.em._getOrCloneEntityMaterial(inst, did);
          if (mat) this.em._applyMaterialRamp(rec.hookType, mat, v);
        } catch (_) { /* fail-soft: the legacy rig keeps its state */ }
      }
      if (running) {
        _dropOpacityTweens(inst, [did]);
        if (!inst._materialHookTweens) inst._materialHookTweens = [];
        inst._materialHookTweens.push({
          hookType: rec.hookType, surfaceDid: did, startMs: rec.startMs, durationMs: rec.durationMs,
          rampStart: rec.rampStart, rampEnd: rec.rampEnd,
        });
      }
    }
  }

  _pollDemoted(b) {
    if (this._frameNo < b.retryFrame) return;
    b.retryFrame = this._frameNo + ENTITY_BATCH_POLL_FRAMES;
    const inst = b.inst;
    const blk = this._entityBlocker(inst);
    if (blk && !blk.poll) { this._teardown(b); this._setLegacy(b, blk.reason); return; }
    const hold = this._frameNo - b.demoteFrame > ENTITY_BATCH_DEMOTE_HOLD_FRAMES;
    if (blk) { if (hold) this._release2Pending(b, "hold"); return; }
    const sd = this._structureDrift(b);
    if (sd) {
      if (sd === "structure:dismember" || sd === "structure:replaced" || sd === "dislocate") { this._teardown(b); this._setLegacy(b, sd); return; }
      this._replan(b, sd);
      return;
    }
    const plan = b.plan;
    const ctx = { animated: (d) => this._animatedDid(d) };
    const changed = [];
    for (let i = 0; i < b.leaves.length; i += 1) {
      const leaf = b.leaves[i];
      const m = leaf.material;
      if (leaf.geometry !== plan.geometries[i]) { this._replan(b, "geometry"); return; }
      // Every leaf qualifies again — its original member too (a shared
      // material can itself have changed while the rig was demoted).
      if (leafRouteReason(leaf, ctx, this._scratchState)) { if (hold) this._release2Pending(b, "hold"); return; } // still faded / lit: wait
      if (m.map !== plan.maps[i] || m.map.version !== plan.mapVersions[i] || entityRunKeyOf(m) !== plan.runKeys[i]) { this._replan(b, "promote:changed"); return; }
      // A POM / map member's layers + extension row are its own: re-plan, never adopt.
      if (m !== plan.members[i] && (_pomOf(m) || _pomOf(plan.members[i]) || memberMapSet(m).any || memberMapSet(plan.members[i]).any)) {
        this._replan(b, "promote:changed");
        return;
      }
      if (m !== plan.members[i]) changed.push(i);
    }
    if (changed.length > 0 && !this._adoptMembers(b, changed)) return;
    // Back: re-park and show (straight to active when it has drawn before).
    b.hiddenDids = null;
    b.shownDids = null;
    if (b.mesh) b.mesh.visible = true;
    this._mirror(b);
    if (b.status !== "demoted") return; // the mirror re-planned
    if (b.everActive) { this._parkAll(b); b.status = "active"; b.activeSince = this._frameNo; this._stats.promotes += 1; } else { b.status = "overlap"; b.overlapFrames = 0; }
    b.reason = null;
  }

  /** Re-promote with new (authored-again) members: their state rows, then `hbBatchSlot`. */
  _adoptMembers(b, changed) {
    const plan = b.plan;
    const table = kitStateTable();
    const budget = kitBudget();
    for (const i of changed) {
      const m = b.leaves[i].material;
      const oldRow = plan.memberRefs.get(plan.members[i]);
      let row = plan.memberRefs.get(m) || this._rows.get(m);
      if (!row) {
        const slot = table.addFromMaterial(m, oldRow.layer, budget, oldRow.nrmLayer);
        if (slot < 0) return false;
        row = {
          member: m, slot, refs: 0, page: oldRow.page, layer: oldRow.layer, contentKey: oldRow.contentKey,
          nrmPage: oldRow.nrmPage, nrmLayer: oldRow.nrmLayer, nrmKey: oldRow.nrmKey,
          map: m.map, mapVersion: m.map.version, normalMap: m.normalMap || null,
          nrmVersion: m.normalMap ? m.normalMap.version : -1, pagesGen: plan.pagesGen, pages: oldRow.pages,
          // (Never a POM / map member: `_pollDemoted` re-plans those.)
          pom: null, extRow: 0, pomRow: 0, maps: MAP_SET_NONE, mapState: null,
          aoTex: null, aoVersion: -1, aoPage: null, aoLayer: 0, aoKey: null,
          rghTex: null, rghVersion: -1, rghPage: null, rghLayer: 0, rghKey: null,
          snap: this._snapshotMember(m), users: new Set(),
        };
        this._rows.set(m, row);
      }
      if (!plan.memberRefs.has(m)) {
        row.pages.alloc.acquire(row.page.desc, row.contentKey);
        if (row.nrmKey) row.pages.alloc.acquire(row.nrmPage.desc, row.nrmKey);
        row.refs += 1;
        row.users.add(b);
        plan.memberRefs.set(m, row);
      }
      plan.members[i] = m;
      const sl = b.slices[i];
      b.attrSlot.array.fill(row.slot, sl.vertexStart, sl.vertexStart + sl.vertexCount);
      b.attrSlot.addUpdateRange(sl.vertexStart, sl.vertexCount);
      b.attrSlot.needsUpdate = true;
    }
    // Drop rows no leaf uses any more.
    const used = new Set(plan.members);
    for (const [m, row] of [...plan.memberRefs]) {
      if (used.has(m)) continue;
      plan.memberRefs.delete(m);
      row.users.delete(b);
      row.refs -= 1;
      try { row.pages.release(row.contentKey); } catch (_) { /* fail-soft */ }
      if (row.nrmKey) { try { row.pages.release(row.nrmKey); } catch (_) { /* fail-soft */ } }
      if (row.pomKey) { try { row.pages.release(row.pomKey); } catch (_) { /* fail-soft */ } }
      if (row.aoKey) { try { row.pages.release(row.aoKey); } catch (_) { /* fail-soft */ } }
      if (row.rghKey) { try { row.pages.release(row.rghKey); } catch (_) { /* fail-soft */ } }
      if (row.refs <= 0) { if (this._rows.get(m) === row) this._rows.delete(m); table.remove(row.slot); if (row.extRow > 0) table.remove(row.extRow); }
    }
    for (const run of plan.runs) run.row = plan.memberRefs.get(plan.members[run.first]);
    return true;
  }

  /** A long demote (or a long cull) frees the batch resources (still polled; a later plan rebuilds). */
  _release2Pending(b, reason) {
    this._teardown(b);
    b.status = "pending";
    b.reason = reason;
    b.hiddenSince = -1;
    b.retryFrame = this._frameNo + ENTITY_BATCH_POLL_FRAMES;
  }

  // -------------------------------------------------------------------------
  // Teardown / legacy / re-plan.
  // -------------------------------------------------------------------------

  /**
   * Design §9.2: demotes count toward ENTITY_BATCH_REPLAN_LIMIT with the
   * re-plans (`b.replans`); past it the rig is `legacy:unstable`. (The tick
   * of an active rig forgives one per ENTITY_BATCH_CHURN_FORGIVE_FRAMES.)
   */
  _churn(b) {
    b.replans += 1;
    if (b.replans <= ENTITY_BATCH_REPLAN_LIMIT) return;
    if (b.status !== "pending") this._teardown(b);
    this._setLegacy(b, "unstable");
  }

  _setLegacy(b, reason) {
    b.status = "legacy";
    b.reason = reason;
    _count(this._stats.fallbacks, reason);
    if (b.inst) delete b.inst.demoteBatch;
  }

  _replan(b, reason) {
    if (b.status !== "pending" && b.status !== "legacy") this._teardown(b);
    b.replans += 1;
    this._stats.replans += 1;
    _count(this._stats.replanReasons, reason);
    if (b.replans > ENTITY_BATCH_REPLAN_LIMIT) { this._setLegacy(b, "unstable"); return; }
    b.status = "pending";
    b.reason = reason;
    b.retryFrame = this._frameNo + 1;
  }

  /**
   * A re-plan the RIG did not cause (the cap refused a member, or has room
   * again): next frame, NOT counted toward ENTITY_BATCH_REPLAN_LIMIT. Bounded
   * by its callers: one per newly refused member, one per retry period.
   */
  _softReplan(b, reason) {
    if (b.status !== "pending" && b.status !== "legacy") this._teardown(b);
    this._stats.replans += 1;
    _count(this._stats.replanReasons, reason);
    b.status = "pending";
    b.reason = reason;
    b.retryFrame = this._frameNo + 1;
  }

  /**
   * A texchan AO / roughness plane ARRIVED on a member of `b` (header "AO /
   * ROUGHNESS / EMISSIVE PARTS"; texchan's async arm attached it to the cache
   * material in place): the legacy leaves draw it from this frame (teardown:
   * unparked, batch mesh gone) and the rig re-plans into the new set
   * ENTITY_BATCH_MAP_SETTLE_FRAMES later, so a burst of arrivals is one
   * re-plan. Not churn (arrivals happen once per member), bounded per rig
   * by ENTITY_BATCH_MAP_ARRIVAL_LIMIT.
   */
  _mapArrival(b, reason) {
    if (b.status === "legacy" || b.status === "released") return;
    b.mapArrivals = (b.mapArrivals | 0) + 1;
    this._stats.mapArrivals += 1;
    if (b.mapArrivals > ENTITY_BATCH_MAP_ARRIVAL_LIMIT) {
      if (b.status !== "pending") this._teardown(b);
      this._setLegacy(b, "unstable");
      return;
    }
    this._softReplan(b, reason);
    b.retryFrame = this._frameNo + ENTITY_BATCH_MAP_SETTLE_FRAMES;
  }

  /**
   * Free the batch (legacy leaves back on screen). `hidden` = what becomes of
   * a batch-only hide or show (`_materializeHidden`): "full" by default (the
   * legacy rig is left as today's body would have left it), "tweens" after a
   * hot-swap, "drop" at release.
   */
  _teardown(b, hidden = "full") {
    if (b.ticket) { try { b.ticketBudget.drop(b.ticket); } catch (_) { /* fail-soft */ } b.ticket = null; b.ticketBudget = null; }
    this._unparkAll(b);
    if (b.hiddenDids || b.shownDids) {
      // Off the active states first: the clone getter's `noteClone` must not
      // demote (and re-enter) a rig that is being torn down.
      const st = b.status;
      b.status = "teardown";
      this._materializeHidden(b, hidden);
      b.status = st;
    }
    if (b.mesh) {
      if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
      b.mesh.userData.hbRecord = null;
      b.mesh.raycast = _PROTO_RAYCAST;
      b.mesh.onBeforeRender = _PROTO_BEFORE;
      b.mesh.onAfterRender = _PROTO_AFTER;
      // NEVER mesh.dispose(): the identity instanceMatrix is shared.
      b.mesh = null;
    }
    if (b.geometry) { this._disposeEntityGeometry(b, b.geometry); b.geometry = null; }
    const plan = b.plan;
    if (plan) {
      if (plan.runs) for (const run of plan.runs) { if (run.classEntry) this._releaseClassEntry(run.classEntry); run.classEntry = null; }
      this._releaseMemberRows(b);
      if (this._partRows) {
        for (let p = 0; p < plan.partRow.length; p += 1) {
          if (plan.partRow[p] > 0) { this._partRows.free(plan.partRow[p]); plan.partRow[p] = 0; this._stats.rows.partRows -= 1; }
        }
      }
    }
    b.plan = null;
    b.leaves = null;
    b.attrSlot = null;
    b.attrPart = null;
    b.slices = null;
    b.lastPose = null;
    b.hiddenDids = null;
    b.shownDids = null;
    b.drawT0 = -1;
    this._stats.teardowns += 1;
  }

  /**
   * three's onGeometryDispose removes the GL buffer of EVERY attribute (and
   * the index) of the disposed geometry. A user that is not the entry's last
   * strips the shared attributes first, so only its own two attributes and
   * its VAOs go; the last user disposes with them attached (their buffers are
   * freed) and the entry drops to CPU-only (idle LRU).
   */
  _disposeEntityGeometry(b, geo) {
    const entry = b.entry;
    b.entry = null;
    for (const a of [b.attrSlot, b.attrPart]) if (a && Object.prototype.hasOwnProperty.call(a, "onUploadCallback")) delete a.onUploadCallback;
    if (!entry) { try { disposeOnLiveContext(geo); } catch (_) { /* fail-soft */ } return; }
    entry.users -= 1;
    if (entry.users > 0) {
      for (const n of entry.attrNames) geo.deleteAttribute(n);
      geo.setIndex(null);
      try { disposeOnLiveContext(geo); } catch (_) { /* fail-soft */ }
      return;
    }
    try { disposeOnLiveContext(geo); } catch (_) { /* fail-soft */ }
    // Torn down before any user drew it: nothing will upload the charge.
    this._disarmEntry(entry);
    entry.glLive = false;
    this._idle.set(entry, true);
    this._idleBytes += entry.sharedBytes;
    while (this._idle.size > ENTITY_ENTRY_IDLE_MAX || this._idleBytes > ENTITY_ENTRY_IDLE_BYTES) {
      const old = this._idle.keys().next().value;
      this._idle.delete(old);
      this._idleBytes -= old.sharedBytes;
      const list = this._entries.get(old.key);
      if (list) {
        const k = list.indexOf(old);
        if (k >= 0) list.splice(k, 1);
        if (list.length === 0) this._entries.delete(old.key);
      }
      old.attrs = null;
      old.sources = null;
    }
  }

  // -------------------------------------------------------------------------
  // GL context.
  // -------------------------------------------------------------------------

  /**
   * One record onto a new pages generation: torn down (legacy leaves back),
   * pending, re-planned at the NEXT sync. Page-derived state goes with the
   * pages: refused members are re-tried (the new pages are empty), the
   * page-full wait and the poll back-off end. Not churn.
   */
  _restartRecord(b) {
    if (b.status === "released" || b.status === "legacy") return;
    if (b.status !== "pending") this._teardown(b);
    b.status = "pending";
    b.reason = "contextReset";
    b.retryFrame = this._frameNo + 1;
    b.noBatchMats = null;
    b.pageFullWait = false;
    b.pageFullFrame = 0;
    b.polls = 0;
    b.rendererWaits = 0;
    b.hiddenSince = -1;
    b.resetFrame = this._frameNo;
  }

  _restartAll() {
    this._ctx.replansSinceReset = 0;
    for (const b of this._records) this._restartRecord(b);
    // Every entry re-uploads on the new context; layer keys start over.
    for (const list of this._entries.values()) for (const e of list) { this._disarmEntry(e); e.glLive = false; }
    this._rows.clear();
    this._palKeys.clear();
  }

  _contextChanged(pages) {
    this._restartAll();
    for (const e of this._classMats.values()) this._disposeClassMaterial(e.material);
    this._classMats.clear();
    if (pages) { pages.reset(); this._pagesGen = pages.generation; }
    this._stats.contextResets += 1;
    this._ctx.lastResetFrame = this._frameNo;
    this._ctx.lastResetGen = pages ? pages.generation : -1;
  }

  _watchContext(renderer) {
    if (this._watch && this._watch.renderer === renderer) return;
    this._unwatchContext();
    const el = renderer && renderer.domElement;
    if (!el || typeof el.addEventListener !== "function") { this._watch = { renderer, el: null, onEvent: null }; return; }
    const onEvent = () => {
      try {
        const pages = kitPages(renderer);
        if (pages && pages.contextLost()) this._contextEvent(pages, renderer);
        else if (pages && this._pagesGen !== pages.generation) { this._restartAll(); this._pagesGen = pages.generation; }
      } catch (_) { /* the next tick re-checks */ }
    };
    el.addEventListener("webglcontextlost", onEvent, false);
    el.addEventListener("webglcontextrestored", onEvent, false);
    this._watch = { renderer, el, onEvent };
  }

  _unwatchContext() {
    if (!this._watch) return;
    const { el, onEvent } = this._watch;
    this._watch = null;
    if (!el || !onEvent) return;
    try {
      el.removeEventListener("webglcontextlost", onEvent, false);
      el.removeEventListener("webglcontextrestored", onEvent, false);
    } catch (_) { /* fail-soft */ }
  }

  _sweep(pages) {
    this._stats.sweeps += 1;
    this._palKeys.sweep((k) => pages.alloc.lookup(k) !== null);
  }

  // -------------------------------------------------------------------------
  // Diag.
  // -------------------------------------------------------------------------

  stats() {
    const live = {};
    const byStatus = {};
    let parked = 0, leaves = 0, draws = 0;
    for (const b of this._records) {
      byStatus[b.status] = (byStatus[b.status] || 0) + 1;
      if ((b.status === "active" || b.status === "overlap") && b.plan && b.plan.runs) draws += b.plan.runs.length;
      if (b.reason) live[b.reason] = (live[b.reason] || 0) + 1;
      if (b.leaves) {
        leaves += b.leaves.length;
        for (const l of b.leaves) if (l.userData && l.userData.hbParked === true) parked += 1;
      }
    }
    let liveEntries = 0, sharedBytes = 0;
    for (const list of this._entries.values()) for (const e of list) { if (e.users > 0) { liveEntries += 1; sharedBytes += e.sharedBytes; } }
    const s = JSON.parse(JSON.stringify(this._stats));
    return {
      ...s,
      inert: this.inert,
      entities: this._records.size, byStatus, live, draws,
      leaves: { batched: leaves, parked },
      entries: { ...s.entries, live: liveEntries, idle: this._idle.size, idleBytes: this._idleBytes, sharedBytes },
      layers: { ...s.layers, valueKeys: this._palKeys.size, ...this._palKeys.stats },
      rows: { ...s.rows, capacity: this._partRows ? this._partRows.capacity : 0, ...(this._partRows ? this._partRows.stats : {}) },
      stateRows: this._rows.size,
      mapMembers: this._mapMemberCounts(),
      classMaterials: this._classMats.size,
      programKeys: [...this._warm.keys()],
      context: this._contextStats(),
      footprint: this._footprint(),
      kit: kitSummary(),
    };
  }

  /** Live map-part rows (header "AO / ROUGHNESS / EMISSIVE PARTS"): by plane and by map-set key. */
  _mapMemberCounts() {
    const out = { members: 0, ao: 0, roughness: 0, emissive: 0, sets: {} };
    for (const row of this._rows.values()) {
      const ms = row.maps || MAP_SET_NONE;
      if (!ms.any) continue;
      out.members += 1;
      if (row.aoKey) out.ao += 1;
      if (row.rghKey) out.roughness += 1;
      if (ms.emissive) out.emissive += 1;
      out.sets[ms.key] = (out.sets[ms.key] || 0) + 1;
    }
    return out;
  }

  /** GL-context transitions as this consumer saw them (one reset per transition). */
  _contextStats() {
    const c = this._ctx;
    let pendingReset = 0;
    for (const b of this._records) if (b.status === "pending" && b.reason === "contextReset") pendingReset += 1;
    const pages = this._pagesRef();
    let lostNow = null;
    try { lostNow = pages ? liveContextGeneration(pages.renderer) === LOST_CONTEXT_GENERATION : null; } catch (_) { lostNow = null; }
    return {
      lost: c.lost, restored: c.restored, resets: this._stats.contextResets, lossOpen: c.lossOpen, lostNow,
      generation: pages ? pages.generation : null, lastResetFrame: c.lastResetFrame,
      framesSinceReset: c.lastResetFrame >= 0 ? this._frameNo - c.lastResetFrame : null,
      replansSinceReset: c.replansSinceReset, pendingReset,
    };
  }

  /** The kit pages this consumer last synced against (diag: no allocation). */
  _pagesRef() {
    return this._lastPages || null;
  }

  /**
   * Layer footprint against the stated cap: reserved page bytes (what the cap
   * counts), live / idle content (all kit consumers), and the layers THIS
   * consumer holds (distinct contents, bytes) by page key.
   */
  _footprint() {
    const pages = this._pagesRef();
    if (!pages) return null;
    const A = pages.alloc;
    const mine = new Map(); // content key -> layer bytes
    const byKey = {};
    for (const row of this._rows.values()) {
      for (const [k, p] of [[row.contentKey, row.page], [row.nrmKey, row.nrmPage], [row.pomKey, row.pomPage], [row.aoKey, row.aoPage], [row.rghKey, row.rghPage]]) {
        if (!k || !p || mine.has(k)) continue;
        mine.set(k, p.layerBytes);
        const e = byKey[p.key] || (byKey[p.key] = { layers: 0, bytes: 0 });
        e.layers += 1; e.bytes += p.layerBytes;
      }
    }
    let ownBytes = 0;
    for (const v of mine.values()) ownBytes += v;
    const sum = A.summary();
    let reclaimable = 0;
    try { reclaimable = typeof A.reclaimableBytes === "function" ? A.reclaimableBytes() : 0; } catch (_) { reclaimable = 0; }
    return {
      capBytes: A.maxBytes, reservedBytes: A.bytes, liveBytes: sum.liveBytes, idleBytes: sum.idleBytes,
      freeLayerBytes: A.bytes - (sum.liveBytes || 0) - (sum.idleBytes || 0), reclaimableBytes: reclaimable,
      pages: sum.pages, ownLayers: mine.size, ownBytes, byPageKey: byKey,
    };
  }

  /**
   * Every active entity's part rows equal f32(compose(part)), its state rows
   * equal packLayerState(member) at the row's layer, its extension rows
   * equal packExtState(member) (`pomMismatches`: the POM half, texels 0-1;
   * `mapMismatches`: the map half, texels 2-3, plus a row whose planes / set
   * are not the member's own now and a run whose class samples another set),
   * its leaves are parked and its `hbBatchSlot` / `hbEntPart` hold the plan's
   * rows. Counts.
   */
  verify() {
    const out = { entities: 0, rowMismatches: 0, stateMismatches: 0, pomMismatches: 0, mapMismatches: 0, parkMismatches: 0, attrMismatches: 0, details: [] };
    const m = new THREE.Matrix4();
    const f = Math.fround;
    const table = kitStateTable();
    const pack = new Float32Array(LAYER_STATE_FLOATS);
    const st = layerStateFromMaterial(null);
    for (const b of this._records) {
      if (b.status !== "active") continue;
      out.entities += 1;
      const plan = b.plan;
      for (let p = 0; p < plan.partRow.length; p += 1) {
        const row = plan.partRow[p];
        if (row <= 0) continue;
        const part = b.inst.parts[p];
        if (!part || part.visible === false || b.partAllCollapsed[p] === 1 || b.inst.root.visible === false) continue;
        if (b.lastPose === null || b.lastPose === undefined) continue; // not drawn yet
        composePartMatrix(part, m);
        const d = this._partRows.data;
        for (let k = 0; k < 16; k += 1) {
          if (d[row * 16 + k] !== f(m.elements[k])) { out.rowMismatches += 1; out.details.push(`row ${b.inst.guid}:${p}[${k}]`); break; }
        }
      }
      for (const [mat, row] of plan.memberRefs) {
        const ext = row.extRow > 0 ? row.extRow : 0;
        packLayerState(fillStateFromMaterial(st, mat), row.layer, pack, 0, row.nrmLayer, ext);
        const d = table.rows.data;
        for (let k = 0; k < LAYER_STATE_FLOATS; k += 1) {
          if (d[row.slot * LAYER_STATE_FLOATS + k] !== pack[k]) { out.stateMismatches += 1; out.details.push(`state ${mat.name}[${k}]`); break; }
        }
        const ms = row.maps || MAP_SET_NONE;
        if (ext > 0) {
          packExtState(row.pom ? pomStateOf(mat, row.pom, row.pomLayer, {}) : null, ms.any ? _rowMapState(row, mat, {}) : null, pack, 0);
          for (let k = 0; k < 8; k += 1) {
            if (d[ext * LAYER_STATE_FLOATS + k] !== pack[k]) { out.pomMismatches += 1; out.details.push(`pom ${mat.name}[${k}]`); break; }
          }
          for (let k = 8; k < LAYER_STATE_FLOATS; k += 1) {
            if (d[ext * LAYER_STATE_FLOATS + k] !== pack[k]) { out.mapMismatches += 1; out.details.push(`maps ${mat.name}[${k}]`); break; }
          }
        }
        // The planes the row samples are the member's own now (an arrival / swap re-plans: never a stale layer).
        if (memberMapSet(mat) !== ms || (mat.aoMap || null) !== (row.aoTex || null) || (mat.roughnessMap || null) !== (row.rghTex || null)
          || (ms.any && ext <= 0) || (ms.ao && !row.aoKey) || (ms.rough && !row.rghKey) || (ms.emissive && mat.emissiveMap !== mat.map)) {
          out.mapMismatches += 1;
          out.details.push(`planes ${mat.name}`);
        }
      }
      // Each run's class samples exactly its rows' set.
      for (const run of plan.runs) {
        const want = run.classEntry && run.classEntry.material.userData ? (run.classEntry.material.userData.hbBatchMaps || "") : null;
        for (let k = 0; k < run.count; k += 1) {
          const row = plan.memberRefs.get(plan.members[run.first + k]);
          if (!row || (row.maps || MAP_SET_NONE).key !== want) { out.mapMismatches += 1; out.details.push(`class set run ${run.first}`); break; }
        }
      }
      for (let i = 0; i < b.leaves.length; i += 1) {
        const leaf = b.leaves[i];
        if (leaf.userData.hbParked !== true || leaf.layers.mask !== ENTITY_PARK_MASK) out.parkMismatches += 1;
        const sl = b.slices[i];
        const want = plan.memberRefs.get(plan.members[i]).slot;
        if (b.attrSlot.array[sl.vertexStart] !== want) out.attrMismatches += 1;
        const wantPart = b.attrZero[i] ? 0 : plan.partRow[plan.batch[i].part];
        if (b.attrPart.array[sl.vertexStart] !== wantPart) out.attrMismatches += 1;
      }
    }
    if (out.details.length > 20) out.details.length = 20;
    return out;
  }
}
