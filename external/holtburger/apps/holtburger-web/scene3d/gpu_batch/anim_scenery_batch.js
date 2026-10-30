// scene3d/gpu_batch/anim_scenery_batch.js — R3-3 K3: `?animSceneryBatch`
// (DEFAULT OFF; `=on` opt-in), the GPU batch kit's first consumer
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 8).
//
// TODAY (animated_scenery.js ?animSceneryInstanced + ?animSceneryGpu, both
// default on): one InstancedMesh per (setup, animation DID, part, surface
// group) — a "bucket" — drawing every live placement of that setup with the
// part's own geometry. The census counts 19 anim-inst draws a frame at
// Holtburg, 13 of them the insect cloud 0x020004B0 (13 parts, 3 surfaces).
//
// THE BATCH. Per (setup, animation DID) the buckets are re-drawn by fewer
// InstancedMeshes over MERGED geometry: the parts are concatenated and each
// vertex keeps the pose row its bucket's geometry carried (`hbAiPose`, now
// per VERTEX instead of per geometry), so the vertex shader composes exactly
// the matrix it composed before (anim_scenery_gpu.js injectAnimInstPose —
// the very same code, the same pose table, the same static placement in the
// instance attribute). Two kinds of draw:
//   - SAME: the buckets of one member material merged into one draw that
//     still uses that material's GPU variant (the same program, the same
//     uniforms, the same texture). Exact by construction.
//   - ARRAY: members with DIFFERENT surfaces whose textures live in the same
//     kit array page (same size, format, levels and sampler state) merged
//     into one draw with a kit class material: map (and normal map) from the
//     page at the slot's layer, the per-surface uniforms (diffuse, opacity,
//     roughness, metalness, normal scale, alpha-test ref) from the slot's
//     layer-state row. Texels are the driver's own mips copied GPU-side, the
//     sampler state is the texture's, the scalars are the f32 the uniforms
//     held: the same arithmetic on the same inputs (SwiftShader smoke:
//     harness/glsl_smoke/gpu_batch_smoke.mjs; the 1070 layer readback probe
//     is the M1 arm).
// The batch draws SHARE the representative bucket's instance attribute
// (every bucket of a setup holds the same placements: one slot per live
// instance, collapsed slots zeroed by the legacy bookkeeping), so register /
// collapse / restore / reclaim / park all keep working untouched — this file
// only re-points the attribute when a bucket grows and mirrors its count.
//
// WHAT STAYS LEGACY (counted by reason in `animSceneryBatchDiag()`):
//   - translucent / additive members (instance-major order inside one
//     instanced draw would change the blend order — retail's alpha list);
//   - a member with one bucket and no array partner (nothing to merge);
//   - a CPU-posed bucket anywhere in the setup (`?animSceneryGpu=off`, an
//     array / ShaderMaterial member);
//   - array draws need the member to be a plain MeshStandardMaterial whose
//     only shader chain is materials.js's default light clamp (patch-set key
//     `hb|d0|c0|p0|l1|...`, which reads no per-material state); POM (its
//     height texture is per surface: `pom` is on at mid+ for the Generic /
//     Stone / ... categories), detail, CSM, depth biases, baked light and VFX
//     keep their member program; also no luminous emissive (?lumNight mutates
//     it), no extra maps, not a shadow caster, and a map / normal map the kit
//     can hold byte-exactly (describeTexture). Such members fall back to SAME
//     draws (`unitReasons["array:..."]`);
//   - any texture / blend-class change on a member (a BC7 upgrade swapping
//     the map, a fade) tears the setup's batch down in that frame (legacy back
//     on screen, its attributes re-uploaded whole) and re-plans it the next;
//     after `BATCH_REPLAN_LIMIT` re-plans the setup stays legacy;
//   - a WebGL context loss OR restore (a new GL-context generation:
//     renderer.properties swapped; kit.js kitContextGeneration) tears
//     every batch down at once — at the canvas event, and at the next tick
//     where no event reached us — drops the kit pages (pages.reset: a new
//     `generation`) and re-plans from scratch: new pages, class programs
//     compiled on the new context, legacy buckets on screen meanwhile. The
//     teardown deletes no GL object of the lost context on the restored one
//     (merged geometries are tracked by generation: array_pages.js
//     trackContextGenerations / disposeOnLiveContext; the pages re-check
//     theirs), and still deletes what three made on the live one.
// Until a batch is fully built the legacy buckets keep drawing. The order:
// layers admitted under the kit's per-frame upload budget ("admitting"); its
// class programs linked ("warming": registered with and compiled by
// shader_prewarm.js at the first registration, and again on a restored
// context, polled without blocking); then the merged geometry ("building"),
// charged to the budget in the SAME sync that adds the batch draws to the
// scene visible, and only while the setup has a live instance — three uploads
// a geometry the first time it draws it, at its next render (nothing is
// merged or allocated before the budget admits its bytes). The charge is a
// DEFERRED spend (kit.js upload-budget contract): its ticket keeps the bytes
// booked until three's upload callbacks land them, so the rAF frame whose
// render uploads them (the NEXT one in the app: the render loop runs before
// this module's tick) admits only the rest of the cap for its own layers.
// The build, three's attribute upload and the first draw are timed into the
// kit budget's `ms` / `phaseMs` (S1). Indexed part geometry (the ?geomBundles
// default: every part shares the model's vertex stream) is compacted to the
// vertices each part's index names (`referencedVerticesOf`). Then the batch
// draws show NEXT TO the legacy buckets ("overlap": the same fragments at the
// same depth, so pixel-identical) until three has drawn each new class
// material once —
// async_link_guard.js defers a material's draw while its program links — and
// only then are the legacy buckets hidden (and their raycast muted: the
// batch's raycast facade answers with the POSED parts). There is no time cap
// that hides the legacy buckets early: a class material that is never drawn
// keeps the setup in overlap, and after BATCH_OVERLAP_GIVEUP_FRAMES frames on
// screen without that first draw the setup gives up and stays legacy. The
// batch draws show whenever the representative bucket has a live instance
// (the ?animSceneryBucketVis rule).
//
// WHAT CAN LOOK DIFFERENT: draw order among one setup's parts (one draw,
// instance-major) — only coplanar opaque ties can show it; nothing else.
// An eye-test class change all the same: rc-eye shot list in the R3-3 report.

import * as THREE from "three";
import {
  animPoseTexUniform, injectAnimInstPose, posedMatrixFromRow, animSceneryMemberOf,
} from "../anim_scenery_gpu.js";
import {
  kitBudget, kitBeginFrame, kitPages, kitStateTable, kitFlush, kitSummary, kitContextGeneration, kitLiveGeneration,
} from "./kit.js";
import {
  describeTexture, liveContextGeneration, trackContextGenerations, disposeOnLiveContext, LOST_CONTEXT_GENERATION,
} from "./array_pages.js";
import { pageKeyOf } from "./page_allocator.js";
import { UPLOAD_KIND, uploadNowMs } from "./upload_budget.js";
import {
  makeClassMaterial, classKeyOf, classPrewarmProxy, classPatchMissing, dummyMap, dummyNormalMap, SLOT_ATTR,
} from "./class_materials.js";
import { installBatchRaycast, noRaycast } from "./raycast.js";
import { registerBatchClassPrewarm, prewarmBatchClasses, programsOf, programPending } from "../shader_prewarm.js";

export const BATCH_REPLAN_LIMIT = 8;
/**
 * Frames ON SCREEN the batch and the legacy buckets may both draw while a
 * class material waits for its first draw (async_link_guard defers it while
 * its program links: 0.5-1.7 s per program on the 1070). Past this the setup
 * gives up and stays legacy (`legacyReasons["never-drawn"]`); it never hides
 * the legacy buckets before the class material has drawn.
 */
export const BATCH_OVERLAP_GIVEUP_FRAMES = 600;
/** Frames a class draw waits for a program that was never compiled (no camera) before drawing anyway. */
export const BATCH_WARM_WAIT_FRAMES = 120;
const POSE_ATTR = "hbAiPose";

const _groups = new Map(); // `${setup}:${anim}` -> group
const _order = [];         // groups, creation order
const _classMats = new Map(); // material key -> { material, refs, programKey }
const _warmByProgramKey = new Map(); // program key -> { material, tries, registered, warmedOn }
let _frameNo = 0;
let _envOverride = null;
const _stats = {
  groups: 0, active: 0, legacy: 0, replans: 0, builds: 0, teardowns: 0,
  sameDraws: 0, arrayDraws: 0, bucketsTaken: 0, contextResets: 0, legacyReasons: {}, unitReasons: {},
};

function _count(map, reason) { map[reason] = (map[reason] || 0) + 1; }

/** Test seam: `{ renderer, camera, scene }` instead of window.liveScene3d (null clears). */
export function __setAnimSceneryBatchEnvForTest(env) { _envOverride = env || null; }

function _env(g) {
  if (_envOverride) return _envOverride;
  let renderer = (g && g.renderer) || null;
  let camera = null;
  let scene = null;
  try {
    const live = typeof window !== "undefined" ? window.liveScene3d : null;
    if (live) { renderer = renderer || live.renderer || null; camera = live.camera || null; scene = live.scene || null; }
  } catch (_) { /* no window */ }
  return { renderer, camera, scene };
}

// ===========================================================================
// Eligibility (pure; exported for the node suite).
// ===========================================================================

/** Why a member cannot be merged at all (null = mergeable as a SAME draw). */
export function unitMergeReason(member, variant) {
  if (!variant || Array.isArray(variant) || !variant.isMaterial) return "no-variant";
  if (!member) return "no-member";
  if (variant.transparent === true || member.transparent === true) return "transparent";
  if (member.visible === false) return "invisible";
  return null;
}

const _NO_EXTRA_MAPS = ["lightMap", "aoMap", "bumpMap", "displacementMap", "roughnessMap", "metalnessMap", "alphaMap", "emissiveMap", "envMap"];

// The member shader chains an ARRAY draw may carry: materials.js's patch-set
// key (`_patchSetCacheKey`) with nothing but the light-clamp bit (`l1`, the
// default-on retail light falloff + clamp). That hook edits only the light
// chunks and reads no per-material state, so running ONE member's hook on the
// class material is exactly what every member's own program runs. Every other
// patch (detail `d1`, CSM `c2`, POM `p1` — its height texture is per surface —
// AO, depth biases, baked light, VFX, env detail) keeps its member program
// (SAME draws).
const ARRAY_CHAIN_KEY = /^hb\|d0\|c0\|p0\|l[01]\|a0\|b0\|f0\|s0\|k0\|v$/;
// Live uniform handles a member's hooks stash on its (shared) userData; a
// class compile must not steal them (anim_scenery_gpu.js `_LIVE_HANDLE_KEYS`).
const LIVE_HANDLE_KEYS = [
  "acBakedLightUniforms", "detailShaderUniforms", "csmShaderUniforms",
  "pomShaderUniforms", "lightClampShaderUniforms",
];

/** The member's program-key string ("" = stock: no chain, no custom key; null = unknown). */
export function memberProgramKey(member) {
  const hasChain = member.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile;
  const hasKey = member.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
  if (!hasChain && !hasKey) return "";
  if (!hasChain || !hasKey) return null;
  try { return String(member.customProgramCacheKey()); } catch (_) { return null; }
}

/**
 * The member's chain as a class-material hook: the member's onBeforeCompile,
 * with the member's live userData handles saved and restored around it.
 */
export function memberChainHook(member) {
  if (member.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) return null;
  return function hbBatchMemberChain(shader, renderer) {
    const ud = member.userData;
    const saved = [];
    if (ud) for (const k of LIVE_HANDLE_KEYS) saved.push(Object.getOwnPropertyDescriptor(ud, k));
    try {
      member.onBeforeCompile.call(this, shader, renderer);
    } finally {
      if (ud) {
        for (let i = 0; i < LIVE_HANDLE_KEYS.length; i += 1) {
          const k = LIVE_HANDLE_KEYS[i];
          try {
            if (saved[i]) Object.defineProperty(ud, k, saved[i]);
            else if (Object.prototype.hasOwnProperty.call(ud, k)) delete ud[k];
          } catch (_) { /* frozen userData: leave it */ }
        }
      }
    }
  };
}

/** Why a mergeable member cannot join an ARRAY draw (null = it can). */
export function unitArrayReason(member) {
  if (!member) return "no-member";
  if (member.type !== "MeshStandardMaterial" || !member.isMeshStandardMaterial || member.isMeshPhysicalMaterial) return "type";
  const pk = memberProgramKey(member);
  if (pk === null || (pk !== "" && !ARRAY_CHAIN_KEY.test(pk))) return "shader-chain";
  // MeshStandardMaterial's own `{ STANDARD: "" }` and nothing else (the class
  // material has exactly that).
  if (member.defines) {
    for (const k of Object.keys(member.defines)) if (k !== "STANDARD" || member.defines[k] !== "") return "defines";
  }
  for (const k of _NO_EXTRA_MAPS) if (member[k]) return "map:" + k;
  if (!member.map) return "no-map";
  const em = member.emissive;
  if (em && (em.r !== 0 || em.g !== 0 || em.b !== 0)) return "luminous";
  if (member.vertexColors || member.flatShading || member.wireframe || member.alphaHash || member.alphaToCoverage || member.premultipliedAlpha) return "feature";
  if (member.clippingPlanes && member.clippingPlanes.length > 0) return "clipping";
  if (member.polygonOffset || member.stencilWrite) return "raster-state";
  if (member.side !== THREE.DoubleSide && member.side !== THREE.FrontSide) return "side";
  if (member.normalMap && member.normalMapType !== THREE.TangentSpaceNormalMap) return "normal-map-type";
  if (!describeTexture(member.map)) return "map-format";
  if (member.normalMap && !describeTexture(member.normalMap)) return "normal-map-format";
  return null;
}

/** The draw class of an (array-eligible) member. */
export function memberClass(member) {
  return {
    blend: member.alphaTest > 0 ? "alphaTest" : "opaque",
    light: "lit",
    side: member.side === THREE.FrontSide ? "front" : "double",
  };
}

/**
 * Everything that must be EQUAL for two members to share a class program and
 * its non-slot uniforms (the slot row carries the rest), plus the pages their
 * textures land in.
 */
export function arraySignature(member) {
  const r = member.envMapRotation;
  const mapD = describeTexture(member.map);
  const nrmD = member.normalMap ? describeTexture(member.normalMap) : null;
  return [
    classKeyOf(memberClass(member)), memberProgramKey(member), member.fog, member.envMapIntensity, member.dithering, member.toneMapped,
    member.depthTest, member.depthWrite, member.depthFunc, member.colorWrite, member.forceSinglePass,
    member.shadowSide, member.precision, member.blending,
    r ? `${r.x},${r.y},${r.z},${r.order}` : "-",
    mapD ? pageKeyOf(mapD) : "-", nrmD ? pageKeyOf(nrmD) : "-",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Referenced vertices. The DEFAULT animated-scenery geometry is INDEXED and
// SHARED: with ?geomBundles (default on) each part group is
// geom_bundles.js bundleToPartGroups output, whose position / normal / uv
// attributes are views of the WHOLE model's vertex stream and whose index
// names only that group's vertices (animated_scenery.js then gives every
// bucket its own `hbAiPose` over the whole stream). Copying each bucket's
// whole stream would merge N_parts x the model (5 parts x 300 vertices =
// 1,500 merged vertices for 300 drawn) and charge the upload budget for all
// of them, so each bucket is COMPACTED to the vertices its index names: the
// same triangles over the same per-vertex values, in source vertex order.
// ---------------------------------------------------------------------------
const _refCache = new WeakMap(); // index BufferAttribute -> { version, vertexCount, used }
let _mark = null;  // scratch: one byte per source vertex (grown, reused)
let _remap = null; // scratch: source vertex -> compacted vertex (grown, reused)

/**
 * The sorted unique vertex ids `geo`'s index names (a Uint32Array, cached per
 * index attribute and version), null for a non-indexed geometry, or false
 * when the index names a vertex the attributes do not have.
 */
export function referencedVerticesOf(geo) {
  const index = geo.index;
  if (index === null || index === undefined) return null;
  const n = geo.attributes.position.count;
  const c = _refCache.get(index);
  if (c && c.version === index.version && c.vertexCount === n) return c.used;
  if (!_mark || _mark.length < n) _mark = new Uint8Array(Math.max(n, 1024));
  _mark.fill(0, 0, n);
  const src = index.array;
  const ic = index.count;
  let k = 0;
  let used = false;
  for (let i = 0; i < ic; i += 1) {
    const v = src[i];
    if (v >= n) { k = -1; break; }
    if (_mark[v] === 0) { _mark[v] = 1; k += 1; }
  }
  if (k >= 0) {
    used = new Uint32Array(k);
    let o = 0;
    for (let v = 0; v < n && o < k; v += 1) if (_mark[v] !== 0) used[o++] = v;
  }
  _refCache.set(index, { version: index.version, vertexCount: n, used });
  return used;
}

/** Why `geos` cannot be concatenated into one geometry (null = they can). */
export function geometryMergeReason(geos) {
  if (!geos.length) return "empty";
  const first = geos[0];
  if (!first || !first.attributes || !first.attributes.position) return "no-position";
  const names = Object.keys(first.attributes).sort();
  if (!names.includes(POSE_ATTR)) return "no-pose-row";
  const indexed = first.index !== null && first.index !== undefined;
  for (const g of geos) {
    if (!g || !g.attributes) return "no-attributes";
    if ((g.index !== null && g.index !== undefined) !== indexed) return "index-mix";
    if (g.groups && g.groups.length > 0) return "groups";
    if (g.morphAttributes && Object.keys(g.morphAttributes).length > 0) return "morph";
    if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return "draw-range";
    const n2 = Object.keys(g.attributes).sort();
    if (n2.length !== names.length || n2.some((n, i) => n !== names[i])) return "attribute-set";
    for (const n of names) {
      const a = g.attributes[n];
      const a0 = first.attributes[n];
      if (a.isInterleavedBufferAttribute || a0.isInterleavedBufferAttribute) return "interleaved";
      if (a.itemSize !== a0.itemSize || a.normalized !== a0.normalized || a.array.constructor !== a0.array.constructor) return "attribute-layout";
    }
    if (indexed && referencedVerticesOf(g) === false) return "index-range";
  }
  return null;
}

/**
 * The bytes `mergeGeometriesForBatch(geos, withSlot ? slots : null)` would
 * allocate (and upload): every attribute over the merged (compacted)
 * vertices, the optional per-vertex slot attribute, the index (16- or 32-bit
 * by the merged vertex count). Arithmetic over the sources (the referenced
 * vertex count of an indexed source is cached) — the upload gate asks the
 * budget with this BEFORE anything is allocated.
 */
export function mergedBytesOf(geos, withSlot) {
  const first = geos[0];
  const indexed = first.index !== null && first.index !== undefined;
  let vtx = 0;
  let idx = 0;
  for (const g of geos) {
    if (indexed) {
      vtx += referencedVerticesOf(g).length;
      idx += g.index.count;
    } else {
      vtx += g.attributes.position.count;
    }
  }
  let bytes = 0;
  for (const name of Object.keys(first.attributes)) {
    const a0 = first.attributes[name];
    bytes += vtx * a0.itemSize * a0.array.BYTES_PER_ELEMENT;
  }
  if (withSlot) bytes += vtx * Float32Array.BYTES_PER_ELEMENT;
  if (indexed) bytes += idx * (vtx > 65535 ? Uint32Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT);
  return bytes;
}

/**
 * Concatenate `geos` (geometryMergeReason === null). `slotValues[i]` (optional)
 * fills a per-vertex `hbBatchSlot` attribute. Returns `{ geometry, slices,
 * bytes }`; `slices[i]` is geometry i's range in index (or vertex) units.
 * An indexed source is compacted to the vertices its index names
 * (`referencedVerticesOf`): `slices[i].vertexMap[j]` is the source vertex of
 * merged vertex `vertexStart + j`, and the index is remapped and rebased, so
 * every triangle draws the same vertices with the same values. A non-indexed
 * source is copied whole (`vertexMap` null).
 */
export function mergeGeometriesForBatch(geos, slotValues) {
  const first = geos[0];
  const names = Object.keys(first.attributes);
  const indexed = first.index !== null && first.index !== undefined;
  let vtx = 0;
  let idx = 0;
  const slices = [];
  for (const g of geos) {
    const used = indexed ? referencedVerticesOf(g) : null;
    const n = used ? used.length : g.attributes.position.count;
    const ic = indexed ? g.index.count : n;
    slices.push({ start: indexed ? idx : vtx, count: ic, vertexStart: vtx, vertexCount: n, vertexMap: used });
    vtx += n;
    idx += ic;
  }
  const out = new THREE.BufferGeometry();
  let bytes = 0;
  for (const name of names) {
    const a0 = first.attributes[name];
    const isz = a0.itemSize;
    const arr = new a0.array.constructor(vtx * isz);
    let o = 0;
    for (let i = 0; i < geos.length; i += 1) {
      const a = geos[i].attributes[name];
      const used = slices[i].vertexMap;
      if (used) {
        const src = a.array;
        for (let j = 0; j < used.length; j += 1) {
          const so = used[j] * isz;
          for (let c = 0; c < isz; c += 1) arr[o + c] = src[so + c];
          o += isz;
        }
      } else {
        const len = a.count * isz;
        arr.set(a.array.subarray(0, len), o);
        o += len;
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, isz, a0.normalized));
    bytes += arr.byteLength;
  }
  if (slotValues) {
    const s = new Float32Array(vtx);
    for (let i = 0; i < geos.length; i += 1) s.fill(slotValues[i], slices[i].vertexStart, slices[i].vertexStart + slices[i].vertexCount);
    out.setAttribute(SLOT_ATTR, new THREE.BufferAttribute(s, 1));
    bytes += s.byteLength;
  }
  if (indexed) {
    const I = vtx > 65535 ? Uint32Array : Uint16Array;
    const ia = new I(idx);
    let o = 0;
    for (let i = 0; i < geos.length; i += 1) {
      const src = geos[i].index.array;
      const base = slices[i].vertexStart;
      const used = slices[i].vertexMap;
      const sn = geos[i].attributes.position.count;
      if (!_remap || _remap.length < sn) _remap = new Uint32Array(Math.max(sn, 1024));
      for (let j = 0; j < used.length; j += 1) _remap[used[j]] = j;
      const n = geos[i].index.count;
      for (let k = 0; k < n; k += 1) ia[o++] = _remap[src[k]] + base;
    }
    out.setIndex(new THREE.BufferAttribute(ia, 1));
    bytes += ia.byteLength;
  }
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return { geometry: out, slices, bytes };
}

/**
 * The draw plan for one setup's units (pure). `units[i]` =
 * `{ buckets, variant, member, mergeReason, arrayReason, sig }`. Returns
 * `{ draws: [{ kind: "same"|"array", units }], kept: [unit] }`: ARRAY draws
 * for >= 2 units with one signature; SAME draws for a mergeable unit with
 * >= 2 buckets that joined no array draw; everything else stays legacy.
 */
export function planDraws(units) {
  const bySig = new Map();
  for (const u of units) {
    if (u.mergeReason || u.arrayReason) continue;
    let l = bySig.get(u.sig);
    if (!l) { l = []; bySig.set(u.sig, l); }
    l.push(u);
  }
  const draws = [];
  const used = new Set();
  for (const l of bySig.values()) {
    if (l.length < 2) continue;
    draws.push({ kind: "array", units: l });
    for (const u of l) used.add(u);
  }
  const kept = [];
  for (const u of units) {
    if (used.has(u)) continue;
    if (u.mergeReason || u.buckets.length < 2) { kept.push(u); continue; }
    draws.push({ kind: "same", units: [u] });
  }
  // Deterministic order: by the first bucket's index.
  const first = (d) => Math.min(...d.units.map((u) => u.firstIndex ?? 0));
  draws.sort((a, b) => first(a) - first(b));
  return { draws, kept };
}

// ===========================================================================
// Groups.
// ===========================================================================

/** Members with this array signature keep their own programs in this setup. */
function _noArray(g, sig) {
  if (!sig) return;
  if (!g.noArraySigs) g.noArraySigs = new Set();
  g.noArraySigs.add(sig);
}

function _setLegacy(g, reason) {
  g.status = "legacy";
  g.reason = reason;
  _stats.legacy += 1;
  _count(_stats.legacyReasons, reason);
}

// The class programs this consumer can mint, registered with shader_prewarm
// (and compiled right away when a renderer + camera exist) the first time an
// instance registers with the flag on — the first landblock bake, behind the
// loading screen — so the first batch does not link mid-walk. Canonical
// members: what a statics MaterialCache surface material carries (its default
// light-clamp chain when `?lightClamp` is on), map + optional normal map,
// opaque / alpha-tested, double / front sided: 8 programs.
let _canonical = null;
function _registerCanonicalClasses(env) {
  if (_canonical) return _canonical;
  _canonical = (async () => {
    let installLightClamp = null;
    try { ({ installLightClampShaderPatch: installLightClamp } = await import("../materials.js")); } catch (_) { installLightClamp = null; }
    const keys = [];
    for (const blend of ["opaque", "alphaTest"]) {
      for (const side of ["double", "front"]) {
        for (const nrm of [false, true]) {
          const member = new THREE.MeshStandardMaterial({ map: dummyMap(), side: side === "front" ? THREE.FrontSide : THREE.DoubleSide, roughness: 0.9 });
          if (nrm) member.normalMap = dummyNormalMap();
          if (blend === "alphaTest") member.alphaTest = 0.5;
          if (typeof installLightClamp === "function") installLightClamp(member);
          const material = makeClassMaterial(_classOpts(member, { blend, light: "lit", side }, { value: null }, nrm ? { value: null } : null));
          const key = material.customProgramCacheKey();
          if (_warmByProgramKey.has(key)) continue;
          _warmByProgramKey.set(key, { material, tries: 0, registered: true, warmedOn: null });
          registerBatchClassPrewarm(key, () => [classPrewarmProxy(material, { extraAttributes: [POSE_ATTR] })]);
          keys.push(key);
        }
      }
    }
    if (env && env.renderer && env.camera) {
      try { prewarmBatchClasses(env.renderer, env.camera, env.scene || null); } catch (_) { /* first draw compiles */ }
    }
    return keys;
  })();
  return _canonical;
}
/** Test seam: the canonical registration promise (null before the first note). */
export function __animSceneryBatchCanonicalForTest() { return _canonical; }

function _classOpts(member, cls, mapUniform, normalUniform) {
  return {
    cls,
    chain: memberChainHook(member),
    chainKey: memberProgramKey(member) || "",
    mapUniform,
    normalUniform,
    stateUniform: kitStateTable().rows.uniform,
    vertexHook: (shader) => {
      shader.uniforms.hbAiPoseTex = animPoseTexUniform();
      injectAnimInstPose(shader);
    },
    vertexHookKey: "aiPose",
    base: {
      fog: member.fog, envMapIntensity: member.envMapIntensity, dithering: member.dithering,
      toneMapped: member.toneMapped, depthTest: member.depthTest,
    },
  };
}

/**
 * Registration hook (animated_scenery.js buildOneInstanced, flag on): the
 * first registered instance of a (setup, animation) names the setup's
 * buckets — every instance registers in every (non-null) bucket of its
 * setup, so its slot list IS the bucket list.
 */
export function noteAnimSceneryBatchInstance(scene3d, setupId, animId, inst, opts) {
  const key = `${setupId >>> 0}:${animId >>> 0}`;
  const have = _groups.get(key);
  if (have) return have;
  const buckets = [];
  const parts = [];
  for (const s of inst?.slots || []) {
    if (!buckets.includes(s.bucket)) { buckets.push(s.bucket); parts.push(s.partIdx); }
  }
  const g = {
    key, setupId: setupId >>> 0, animId: animId >>> 0,
    parent: scene3d?.staticsGroup || null, renderer: scene3d?.renderer || null,
    buckets, parts, rep: buckets[0] || null,
    status: "pending", reason: null, units: [], draws: [], owned: new Map(),
    retryFrame: 0, replans: 0, shown: false,
  };
  _groups.set(key, g);
  _order.push(g);
  _stats.groups += 1;
  _registerCanonicalClasses(_env(g));
  if (opts && opts.bucketVis === false) _setLegacy(g, "bucket-vis-off");
  else if (buckets.length < 2) _setLegacy(g, "single-bucket");
  else if (!g.parent) _setLegacy(g, "no-parent");
  else if (buckets.some((b) => b.gpu !== true)) _setLegacy(g, "cpu-posed");
  return g;
}

/** Frames a setup waits for a renderer (array pages) before planning without arrays. */
export const BATCH_RENDERER_WAIT_FRAMES = 300;

function _plan(g, pages) {
  if (!pages && (g.rendererWaits | 0) < BATCH_RENDERER_WAIT_FRAMES) {
    // window.liveScene3d not up yet: the legacy buckets keep drawing; plan
    // once the array pages can exist, so the plan is not SAME-only for good.
    g.rendererWaits = (g.rendererWaits | 0) + 1;
    g.retryFrame = _frameNo + 1;
    return;
  }
  const units = [];
  const byVariant = new Map();
  for (let i = 0; i < g.buckets.length; i += 1) {
    const b = g.buckets[i];
    const variant = b.mesh.material;
    let u = byVariant.get(variant);
    if (!u) {
      u = { buckets: [], parts: [], variant, member: animSceneryMemberOf(variant), firstIndex: i,
        mergeReason: null, arrayReason: null, sig: null, kind: null, slot: -1, mapRef: null, nrmRef: null };
      byVariant.set(variant, u);
      units.push(u);
    }
    u.buckets.push(b);
    u.parts.push(g.parts[i]);
  }
  for (const u of units) {
    u.mergeReason = unitMergeReason(u.member, u.variant);
    if (u.mergeReason) { _count(_stats.unitReasons, u.mergeReason); continue; }
    u.arrayReason = pages ? unitArrayReason(u.member) : "no-renderer";
    // A shadow caster's depth variant would sample the class material's dummy
    // map and placeholder alpha ref (CSM is off on every tier; a caster keeps
    // its member program).
    if (!u.arrayReason && u.buckets.some((b) => b.mesh.castShadow)) u.arrayReason = "shadow-caster";
    if (!u.arrayReason) {
      u.sig = arraySignature(u.member);
      if (g.noArraySigs && g.noArraySigs.has(u.sig)) u.arrayReason = "class-self-check";
    }
    if (u.arrayReason) _count(_stats.unitReasons, "array:" + u.arrayReason);
    if (geometryMergeReason(u.buckets.map((b) => b.mesh.geometry))) {
      u.mergeReason = "geometry";
      _count(_stats.unitReasons, "geometry");
    }
  }
  const plan = planDraws(units);
  // An array draw's merged geometry must be concatenable too.
  for (let i = plan.draws.length - 1; i >= 0; i -= 1) {
    const d = plan.draws[i];
    if (d.kind !== "array") continue;
    const geos = [];
    for (const u of d.units) for (const b of u.buckets) geos.push(b.mesh.geometry);
    if (geometryMergeReason(geos)) {
      plan.draws.splice(i, 1);
      for (const u of d.units) {
        u.arrayReason = "geometry-mix";
        if (u.buckets.length >= 2) plan.draws.push({ kind: "same", units: [u] });
      }
    }
  }
  g.units = units;
  g.build = null;
  // The pages generation this plan's layers / class materials live on: a
  // context loss or restore (pages.reset) makes everything built on it dead.
  g.pagesGen = pages ? pages.generation : -1;
  if (plan.draws.length === 0) { _setLegacy(g, "nothing-to-merge"); return; }
  g.draws = plan.draws.map((d) => ({ kind: d.kind, units: d.units, mesh: null, geometry: null, slices: null, classEntry: null }));
  for (const d of g.draws) for (const u of d.units) u.kind = d.kind;
  g.status = "admitting";
}

/** Admit array layers + state slots; returns true when everything is resident. */
function _admit(g, pages, budget) {
  const table = kitStateTable();
  for (const d of g.draws) {
    if (d.kind !== "array") continue;
    for (const u of d.units) {
      const m = u.member;
      if (!u.mapRef) {
        const r = pages.admit(m.map, budget);
        if (r && r.deferred) return false;
        if (!r) { _noArray(g, u.sig); _replan(g, "admit-failed"); return false; }
        u.mapRef = { ...r, pages };
        u.map = m.map;
        u.mapVersion = m.map.version;
      }
      if (m.normalMap && !u.nrmRef) {
        const r = pages.admit(m.normalMap, budget);
        if (r && r.deferred) return false;
        if (!r) { _noArray(g, u.sig); _replan(g, "admit-failed"); return false; }
        u.nrmRef = { ...r, pages };
      }
      if (u.slot < 0) {
        const s = table.addFromMaterial(m, u.mapRef.layer, budget, u.nrmRef ? u.nrmRef.layer : 0);
        if (s < 0) return false; // state-table growth refused this frame
        u.slot = s;
      }
      u.normalMap = m.normalMap || null;
      u.nrmVersion = m.normalMap ? m.normalMap.version : -1;
      u.version = m.version;
    }
  }
  // Units of one array draw must share ONE map page (and one normal page):
  // a page that filled up hands out a new page. Split by page.
  const out = [];
  for (const d of g.draws) {
    if (d.kind !== "array") { out.push(d); continue; }
    const byPage = new Map();
    for (const u of d.units) {
      const k = `${u.mapRef.page.id}|${u.nrmRef ? u.nrmRef.page.id : "-"}`;
      let l = byPage.get(k);
      if (!l) { l = []; byPage.set(k, l); }
      l.push(u);
    }
    for (const l of byPage.values()) {
      if (l.length >= 2) { out.push({ ...d, units: l }); continue; }
      const u = l[0];
      _releaseUnitLayers(u);
      u.kind = u.buckets.length >= 2 ? "same" : null;
      if (u.kind) out.push({ kind: "same", units: [u], mesh: null, geometry: null, slices: null, classEntry: null });
    }
  }
  g.draws = out;
  if (g.draws.length === 0) { _setLegacy(g, "nothing-to-merge"); return false; }
  return true;
}

function _classEntryFor(d) {
  const u0 = d.units[0];
  const m = u0.member;
  const cls = memberClass(m);
  const mapPage = u0.mapRef.page;
  const nrmPage = u0.nrmRef ? u0.nrmRef.page : null;
  const key = `${classKeyOf(cls)}|${mapPage.id}|${nrmPage ? nrmPage.id : "-"}|${u0.sig}`;
  let e = _classMats.get(key);
  if (!e) {
    const opts = _classOpts(m, cls, { value: mapPage.gl.texture }, nrmPage ? { value: nrmPage.gl.texture } : null);
    // Every stock line the class patch replaces must survive the chain.
    if (classPatchMissing({ chain: opts.chain, withNormal: !!nrmPage }) !== 0) return null;
    const material = makeClassMaterial(opts);
    material.depthWrite = m.depthWrite;
    material.colorWrite = m.colorWrite;
    material.depthFunc = m.depthFunc;
    const programKey = material.customProgramCacheKey();
    if (!_warmByProgramKey.has(programKey)) {
      const warmMat = makeClassMaterial(opts);
      warmMat.depthWrite = m.depthWrite;
      warmMat.colorWrite = m.colorWrite;
      warmMat.depthFunc = m.depthFunc;
      _warmByProgramKey.set(programKey, { material: warmMat, tries: 0, registered: false, warmedOn: null });
    }
    e = { key, material, refs: 0, programKey };
    _classMats.set(key, e);
  }
  e.refs += 1;
  return e;
}

function _releaseClassEntry(e) {
  if (!e) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  _classMats.delete(e.key);
  _disposeClassMaterial(e.material);
}

/**
 * Dispose a class material — unless the context is lost right now: three's
 * material dispose releases the program through the CURRENT properties /
 * program cache, which until the restore are the lost context's (a
 * deleteProgram + deleteVertexArray of dead objects). Dropped instead: the
 * restore discards that generation whole. After a restore, dispose() touches
 * only the new generation (renderer-level listener), as it should.
 */
function _disposeClassMaterial(material) {
  if (kitLiveGeneration() === LOST_CONTEXT_GENERATION) return;
  try { material.dispose(); } catch (_) { /* fail-soft */ }
}

/**
 * The renderer's GL-context generation (kit.js kitContextGeneration):
 * three's onContextRestore builds a NEW WebGLProperties (and program cache)
 * and assigns it to `renderer.properties` (async_link_guard.js "CONTEXT
 * RESTORE"), so a program warmed before a loss is warm on the old object
 * only. shader_prewarm.js keys its warmed set the same way.
 */
const _ctxOf = (renderer) => kitContextGeneration(renderer);

/** Is the class program for `e` linked (or never compiled ahead: draw anyway)? */
function _classReady(e, env) {
  if (!env.renderer) return true;
  const w = _warmByProgramKey.get(e.programKey);
  if (!w) return true;
  if (!w.registered) {
    w.registered = true;
    registerBatchClassPrewarm(e.programKey, () => [classPrewarmProxy(w.material, { extraAttributes: [POSE_ATTR] })]);
  }
  const ctx = _ctxOf(env.renderer);
  if (w.warmedOn !== ctx && env.camera) {
    // Compile every registered class not yet warm on THIS context (a no-op
    // for classes the boot warm already compiled; after a context restore,
    // every class again), with the warm target.
    w.warmedOn = ctx;
    w.tries = 0;
    try { prewarmBatchClasses(env.renderer, env.camera, env.scene || null); } catch (_) { /* first draw compiles */ }
  }
  const progs = programsOf(env.renderer, w.material);
  if (progs.length === 0) return ++w.tries > BATCH_WARM_WAIT_FRAMES;
  for (const p of progs) if (programPending(p)) return false;
  return true;
}

function _sliceMatrix(mesh) {
  return (i, slice, out) => {
    mesh.getMatrixAt(i, out);
    posedMatrixFromRow(out, slice.row, out);
    return true;
  };
}

/**
 * The class materials of the array draws (after the layers are resident, so
 * the pages are known); false = re-planned. No GL: a class program is linked
 * by the warm and polled in "warming".
 */
function _resolveClasses(g) {
  for (const d of g.draws) {
    if (d.kind !== "array" || d.classEntry) continue;
    d.classEntry = _classEntryFor(d);
    if (!d.classEntry) {
      // The chain broke a line the class patch needs: these members keep
      // their own programs (SAME draws) from the next plan on (the teardown
      // releases the class entries taken so far).
      _noArray(g, d.units[0].sig);
      _replan(g, "class-self-check");
      return false;
    }
    // The class (opaque / alpha-tested) was chosen from this alpha test.
    for (const u of d.units) u.alphaBit = u.member.alphaTest > 0;
  }
  return true;
}

/** The merge inputs of every draw + their bytes, computed once per plan. */
function _buildInputs(g) {
  if (g.build) return g.build;
  const inputs = [];
  let bytes = 0;
  for (const d of g.draws) {
    const geos = [];
    const slots = [];
    const sliceInfo = [];
    // Bucket order of the setup (part order), whichever unit a bucket is in.
    for (let i = 0; i < g.buckets.length; i += 1) {
      const b = g.buckets[i];
      const u = d.units.find((x) => x.buckets.includes(b));
      if (!u) continue;
      geos.push(b.mesh.geometry);
      slots.push(u.slot);
      sliceInfo.push({ part: g.parts[i], row: b.mesh.userData?.animGpuRow ?? 0, bucket: b });
    }
    inputs.push({ d, geos, slots, sliceInfo });
    bytes += mergedBytesOf(geos, d.kind === "array");
  }
  g.build = { inputs, bytes };
  return g.build;
}

/**
 * Geometry (budgeted) + meshes, shown in this same frame; returns true when
 * built. THE FRAME THAT PAYS IS THE FRAME THAT UPLOADS (plan R3-3 item 4):
 * three uploads a geometry the first time it draws it, so the budget is
 * asked only when the batch can be shown right away — its class programs
 * are linked ("warming" came first) and the representative bucket has a live
 * instance (otherwise the batch draws would be hidden, and would upload later
 * in a frame that never asked) — and the caller adds the meshes to the scene,
 * visible, in the same sync (`_beginOverlap`). The merged byte count is
 * arithmetic over the sources, so a refused frame allocates nothing (no
 * merged arrays, no meshes) and the legacy buckets keep drawing.
 */
function _build(g, budget) {
  if (!(g.rep.active > 0)) return false; // nothing would draw (or upload) this frame
  const { inputs, bytes } = _buildInputs(g);
  // A DEFERRED spend (kit.js contract 2): three uploads the merged geometry
  // at its next render, which in the app is the next rAF frame; the ticket
  // keeps the bytes booked until three's upload callbacks land them.
  const ticket = budget.spendDeferred(bytes, UPLOAD_KIND.GEOMETRY);
  if (!ticket) return false;
  const t0 = uploadNowMs();
  g.build = null;
  g.ticket = ticket;
  g.ticketBudget = budget;
  const renderer = _env(g).renderer;
  const rm = g.rep.mesh;
  for (let k = 0; k < inputs.length; k += 1) {
    const { d, geos, slots, sliceInfo } = inputs[k];
    const merged = mergeGeometriesForBatch(geos, d.kind === "array" ? slots : null);
    for (let i = 0; i < merged.slices.length; i += 1) Object.assign(merged.slices[i], sliceInfo[i]);
    const material = d.kind === "array" ? d.classEntry.material : d.units[0].variant;
    const mesh = new THREE.InstancedMesh(merged.geometry, material, 1);
    mesh.instanceMatrix = rm.instanceMatrix;
    mesh.count = rm.count;
    mesh.name = `anim-batch-0x${g.setupId.toString(16)}-a0x${g.animId.toString(16)}-${d.kind}${k}`;
    mesh.userData = { isAnimatedSceneryInstanced: true, animSceneryBatch: true, batchKind: d.kind };
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    installBatchRaycast(mesh, { slices: merged.slices, matrixAt: _sliceMatrix(mesh) });
    _trackBatchGeometry(merged.geometry, mesh, renderer, budget, ticket);
    d.mesh = mesh;
    d.geometry = merged.geometry;
    d.slices = merged.slices;
  }
  _stats.builds += 1;
  budget.addMs(UPLOAD_KIND.GEOMETRY, uploadNowMs() - t0, "geometryBuild");
  return true;
}

const _protoBeforeRender = THREE.Object3D.prototype.onBeforeRender;
const _protoAfterRender = THREE.Object3D.prototype.onAfterRender;

/**
 * A merged geometry's GL lifecycle (set up once, at the build; nothing per
 * frame):
 *   - GENERATION (P1): its 'dispose' listeners are tagged with the GL-context
 *     generation that uploads it, so the teardown after a loss / restore
 *     (`disposeOnLiveContext`) deletes only buffers / VAOs of the live context;
 *   - UPLOAD TICKET (P3): every attribute and the index land their bytes on
 *     the build's budget ticket from three's onUploadCallback (one-shot);
 *   - TIMINGS (S1): three's attribute uploads, from its first touch of the
 *     geometry (WebGLGeometries adds its dispose listener right before it
 *     uploads the attributes) to the last attribute's upload callback, and
 *     the mesh's first draw (onBeforeRender -> onAfterRender: index upload,
 *     VAO, uniforms, the draw call).
 */
function _trackBatchGeometry(geo, mesh, renderer, budget, ticket) {
  let touched = -1;
  trackContextGenerations(geo, () => liveContextGeneration(renderer), () => {
    if (touched < 0) touched = uploadNowMs();
  });
  const attrs = Object.values(geo.attributes);
  let left = attrs.length;
  function onAttrUpload() {
    // `this` is the attribute three just uploaded (createBuffer / updateBuffer).
    delete this.onUploadCallback;
    budget.land(ticket, this.array.byteLength);
    if (this === geo.index) return;
    left -= 1;
    if (left === 0 && touched >= 0) budget.addMs(UPLOAD_KIND.GEOMETRY, uploadNowMs() - touched, "geometryUpload");
  }
  for (const a of attrs) a.onUploadCallback = onAttrUpload;
  if (geo.index) geo.index.onUploadCallback = onAttrUpload;
  let drawT0 = -1;
  mesh.onBeforeRender = function hbBatchFirstDrawBegin() { drawT0 = uploadNowMs(); };
  mesh.onAfterRender = function hbBatchFirstDrawEnd() {
    if (drawT0 >= 0) budget.addMs(UPLOAD_KIND.GEOMETRY, uploadNowMs() - drawT0, "geometryFirstDraw");
    mesh.onBeforeRender = _protoBeforeRender;
    mesh.onAfterRender = _protoAfterRender;
  };
}

function _own(g, b) {
  const m = b.mesh;
  m.visible = false;
  m.raycast = noRaycast;
  g.owned.set(b, m);
}

/**
 * Show the batch draws NEXT TO the legacy buckets first. A class material
 * that three has never drawn is deferred for a frame or two by
 * async_link_guard.js (its first setProgram re-derives the program), and the
 * legacy buckets must not be hidden while that happens or those parts would
 * blink out. Drawing both is pixel-identical (the same fragments at the same
 * depth, depth func LessEqual, the same colour), so the overlap is invisible.
 */
function _beginOverlap(g) {
  for (const d of g.draws) {
    g.parent.add(d.mesh);
    if (d.kind === "array") _stats.arrayDraws += 1; else _stats.sameDraws += 1;
  }
  _stats.active += 1;
  g.status = "overlap";
  g.overlapFrames = 0;
  _syncDraws(g);
}

/**
 * Has three drawn every class material of `g` at least once (on the current
 * context)? three stamps `__version` in setProgram, i.e. only on a real draw:
 * async_link_guard skips the draw (and three never reaches setProgram) while
 * the program links, and a context restore starts a fresh properties map.
 * SAME draws use the legacy buckets' own variant material: nothing to wait for.
 */
function _classDrawsDone(g, env) {
  if (!env.renderer) return true;
  for (const d of g.draws) {
    if (!d.classEntry) continue;
    let mp = null;
    try { mp = env.renderer.properties.get(d.classEntry.material); } catch (_) { mp = null; }
    if (!mp || mp.__version === undefined) return false;
  }
  return true;
}

function _activate(g) {
  for (const d of g.draws) for (const u of d.units) for (const b of u.buckets) _own(g, b);
  _stats.bucketsTaken += g.owned.size;
  g.status = "active";
  _syncActive(g);
}

function _restoreLegacy(g) {
  for (const [b, m] of g.owned) {
    if (Object.prototype.hasOwnProperty.call(m, "raycast")) delete m.raycast;
    if (b.mesh !== m && Object.prototype.hasOwnProperty.call(b.mesh, "raycast")) delete b.mesh.raycast;
    // The ?animSceneryBucketVis rule, now (the next loop applies it anyway).
    b.mesh.visible = b.active > 0;
    // Hidden, this bucket's attribute uploaded nothing while its slots kept
    // changing; its pending update ranges only cover the latest frame. Send
    // the whole buffer so it shows what its array holds.
    _fullUpload(b.mesh.instanceMatrix);
  }
  _stats.bucketsTaken -= g.owned.size;
  g.owned.clear();
}

function _releaseUnitLayers(u) {
  if (u.mapRef) { u.mapRef.pages.release(u.mapRef.contentKey); u.mapRef = null; }
  if (u.nrmRef) { u.nrmRef.pages.release(u.nrmRef.contentKey); u.nrmRef = null; }
  if (u.slot >= 0) { kitStateTable().remove(u.slot); u.slot = -1; }
}

/** Upload the whole instance attribute on its next draw (see `_syncActive`). */
function _fullUpload(attr) {
  if (!attr) return;
  if (typeof attr.clearUpdateRanges === "function") attr.clearUpdateRanges();
  attr.needsUpdate = true;
}

function _teardown(g) {
  const wasActive = g.status === "active" || g.status === "overlap";
  // Torn down before three uploaded (all of) it: stop carrying its bytes.
  if (g.ticket) { g.ticketBudget.drop(g.ticket); g.ticket = null; g.ticketBudget = null; }
  for (const d of g.draws) {
    if (d.mesh) {
      if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
      d.mesh.instanceMatrix = null; // shared with the legacy bucket: never disposed here
    }
    // Only GL objects of the LIVE context are deleted: after a loss / restore
    // the buffers and VAOs three made on the lost context are dropped with
    // their generation, never deleted on the restored one (P1).
    if (d.geometry) { try { disposeOnLiveContext(d.geometry); } catch (_) { /* fail-soft */ } }
    if (d.classEntry) _releaseClassEntry(d.classEntry);
    if (wasActive) { if (d.kind === "array") _stats.arrayDraws -= 1; else _stats.sameDraws -= 1; }
  }
  for (const u of g.units) _releaseUnitLayers(u);
  _restoreLegacy(g);
  if (wasActive) _stats.active -= 1;
  g.units = [];
  g.draws = [];
  g.build = null;
  _stats.teardowns += 1;
}

/**
 * The GL context was lost, or restored (a new GL-context generation): every
 * batch is torn down in this call (legacy buckets back on screen, shared
 * attributes re-uploaded whole), the pages dropped (`pages.reset()`: a new
 * generation), and each group re-plans from scratch on the next sync (layers
 * admitted into new pages, class programs compiled on the new context by
 * `_classReady`). Not a re-plan: it does not count toward
 * BATCH_REPLAN_LIMIT. (Pages reset by another kit consumer are caught per
 * group by the generation check in syncAnimSceneryBatches.) Diag
 * `contextResets` counts the calls: the canvas events, plus one per tick
 * while the context stays lost.
 */
function _contextChanged(pages) {
  for (const h of _order) {
    if (h.status === "legacy" || h.status === "pending") continue;
    _restart(h);
  }
  if (pages) pages.reset();
  _stats.contextResets += 1;
}

function _restart(h) {
  _teardown(h);
  h.status = "pending";
  h.retryFrame = _frameNo + 1;
}

// GL-context events (flag on only; installed at the first sync with a
// renderer). three's own 'webglcontextlost' / 'webglcontextrestored'
// listeners were added in the WebGLRenderer constructor, so they run first:
// by the time this one runs a restore has already swapped
// renderer.properties. Tearing down HERE closes the window between a restore
// and the next anim-scenery tick, in which a render (the app's render loop
// may run before this module's rAF loop in a frame) would draw the batch
// with pre-loss page textures; the per-tick generation check in
// syncAnimSceneryBatches is the fallback where no event reaches us.
let _watch = null; // { renderer, el, onEvent }
function _watchContext(renderer) {
  if (_watch && _watch.renderer === renderer) return;
  _unwatchContext();
  const el = renderer && renderer.domElement;
  if (!el || typeof el.addEventListener !== "function") { _watch = { renderer, el: null, onEvent: null }; return; }
  const onEvent = () => {
    try { _contextChanged(kitPages(renderer)); } catch (_) { /* the next tick re-checks */ }
  };
  el.addEventListener("webglcontextlost", onEvent, false);
  el.addEventListener("webglcontextrestored", onEvent, false);
  _watch = { renderer, el, onEvent };
}
function _unwatchContext() {
  if (!_watch) return;
  const { el, onEvent } = _watch;
  _watch = null;
  if (!el || !onEvent) return;
  try {
    el.removeEventListener("webglcontextlost", onEvent, false);
    el.removeEventListener("webglcontextrestored", onEvent, false);
  } catch (_) { /* fail-soft */ }
}

function _replan(g, reason) {
  _teardown(g);
  g.replans += 1;
  _stats.replans += 1;
  _count(_stats.unitReasons, "replan:" + reason);
  if (g.replans > BATCH_REPLAN_LIMIT) { _setLegacy(g, "unstable"); return; }
  g.status = "pending";
  g.retryFrame = _frameNo + 1;
}

/** A member changed in a way the built batch does not follow. */
function _unitDrift(u) {
  const m = u.member;
  const v = u.variant;
  if (!m || v.transparent === true || m.transparent === true) return "blend";
  if (u.kind !== "array") return null;
  if (m.map !== u.map || (u.map && u.map.version !== u.mapVersion)) return "map";
  if ((m.normalMap || null) !== u.normalMap || (u.normalMap && u.normalMap.version !== u.nrmVersion)) return "normal-map";
  if (m.version !== u.version) return "version";
  if ((m.alphaTest > 0) !== u.alphaBit) return "alpha-class";
  if (u.buckets[0].mesh.castShadow) return "shadow-caster";
  return null;
}

/** Per frame, overlap or active: follow the members; false = torn down. */
function _syncUnits(g) {
  const table = kitStateTable();
  for (const u of g.units) {
    if (!u.kind) continue;
    const drift = _unitDrift(u);
    if (drift) { _replan(g, drift); return false; }
    if (u.kind === "array") table.writeFromMaterial(u.slot, u.member, u.mapRef.layer, u.nrmRef ? u.nrmRef.layer : 0);
  }
  return true;
}

function _syncActive(g) {
  if (!_syncUnits(g)) return;
  _syncDraws(g);
  for (const [b, m] of g.owned) {
    if (b.mesh !== m) { // the bucket grew: a new InstancedMesh took its place
      if (Object.prototype.hasOwnProperty.call(m, "raycast")) delete m.raycast;
      g.owned.set(b, b.mesh);
      b.mesh.raycast = noRaycast;
    }
    if (b.mesh.visible) b.mesh.visible = false;
  }
}

/** The batch draws follow the representative bucket (attribute, count, visibility). */
function _syncDraws(g) {
  const rep = g.rep;
  const rm = rep.mesh;
  const show = rep.active > 0;
  // Shown again after a hidden stretch (or for the first time): the shared
  // attribute was not uploaded while no draw used it, and the legacy flush
  // keeps only the LATEST frame's dirty span (clearUpdateRanges + one
  // addUpdateRange), so earlier writes would be lost. Upload it whole.
  if (show && !g.shown) _fullUpload(rm.instanceMatrix);
  g.shown = show;
  for (const d of g.draws) {
    const mesh = d.mesh;
    if (mesh.instanceMatrix !== rm.instanceMatrix) { mesh.instanceMatrix = rm.instanceMatrix; if (show) _fullUpload(rm.instanceMatrix); }
    if (mesh.count !== rm.count) mesh.count = rm.count;
    if (mesh.visible !== show) mesh.visible = show;
    if (mesh.castShadow !== rm.castShadow) mesh.castShadow = rm.castShadow;
    if (mesh.receiveShadow !== rm.receiveShadow) mesh.receiveShadow = rm.receiveShadow;
    if (mesh.layers.mask !== rm.layers.mask) mesh.layers.mask = rm.layers.mask;
  }
}

/**
 * Once per frame, after the legacy loop flushed its buckets and applied
 * their visibility (animated_scenery.js). `frameId`: the rAF timestamp (the
 * kit budget refills once per id).
 */
export function syncAnimSceneryBatches(frameId) {
  _frameNo += 1;
  kitBeginFrame(frameId === undefined ? `asb:${_frameNo}` : frameId);
  const budget = kitBudget();
  // The renderer's pages (array draws only exist with one). A lost context
  // destroys every page: tear the batches down (legacy shows) and re-plan
  // once the context is back.
  let pages = null;
  let renderer = null;
  for (let i = 0; i < _order.length && !renderer; i += 1) {
    if (_order[i].status !== "legacy") renderer = _env(_order[i]).renderer;
  }
  if (renderer) {
    _watchContext(renderer);
    pages = kitPages(renderer);
    // Lost, or lost AND restored since the last tick (a new GL-context
    // generation: `contextLost()` compares it): exactly a loss.
    if (pages && pages.contextLost()) {
      _contextChanged(pages);
      kitFlush();
      return;
    }
  }
  for (let i = 0; i < _order.length; i += 1) {
    const g = _order[i];
    if (g.status === "legacy") continue;
    // Built on pages another reset dropped: start over (as on a loss).
    if (g.status !== "pending" && pages && g.pagesGen !== pages.generation) _restart(g);
    if (g.status === "active") { _syncActive(g); continue; }
    if (g.status === "overlap") {
      if (!_syncUnits(g)) continue;
      _syncDraws(g);
      // The legacy buckets go only once three has drawn every class material
      // (no time cap: hiding them earlier would blink the parts out while the
      // draw is still deferred). Frames on screen without that draw count
      // toward giving up; hidden frames (no live instance) wait for free.
      if (_classDrawsDone(g, _env(g))) _activate(g);
      else if (g.shown && ++g.overlapFrames > BATCH_OVERLAP_GIVEUP_FRAMES) { _teardown(g); _setLegacy(g, "never-drawn"); }
      continue;
    }
    if (g.status === "pending") {
      if (_frameNo < g.retryFrame) continue;
      _plan(g, pages);
    }
    if (g.status === "admitting") {
      if (!_admit(g, pages, budget)) continue;
      if (!_resolveClasses(g)) continue;
      g.status = "warming";
    }
    if (g.status === "warming") {
      // Class programs first: the geometry is charged (and so uploaded) only
      // in the frame the batch can be shown (see `_build`).
      const env = _env(g);
      let ready = true;
      for (const d of g.draws) if (d.classEntry && !_classReady(d.classEntry, env)) ready = false;
      if (!ready) continue;
      g.status = "building";
    }
    if (g.status === "building") {
      // A member that drifted while this setup waited re-plans before
      // anything is charged (the overlap must stay pixel-identical).
      if (!_syncUnits(g)) continue;
      if (!_build(g, budget)) continue;
      _beginOverlap(g);
    }
  }
  kitFlush();
}

/** Teardown of every batch (disposeAnimatedScenery). The kit's pages stay (shared). */
export function disposeAnimSceneryBatches() {
  _unwatchContext();
  for (const g of _order) if (g.status !== "legacy" && g.status !== "pending") _teardown(g);
  _groups.clear();
  _order.length = 0;
  for (const e of _classMats.values()) _disposeClassMaterial(e.material);
  _classMats.clear();
  _stats.active = 0;
  _stats.sameDraws = 0;
  _stats.arrayDraws = 0;
  _stats.bucketsTaken = 0;
}

/** Diag (animatedSceneryDiag().batch). */
export function animSceneryBatchDiag() {
  const byStatus = {};
  let draws = 0;
  for (const g of _order) {
    byStatus[g.status] = (byStatus[g.status] || 0) + 1;
    if (g.status === "active" || g.status === "overlap") draws += g.draws.length;
  }
  return {
    ...JSON.parse(JSON.stringify(_stats)),
    byStatus, draws, classMaterials: _classMats.size, programKeys: [..._warmByProgramKey.keys()],
    // S1: layer admits / upload bytes / deferrals, pages, state rows.
    kit: kitSummary(),
  };
}

/** Test seam: the live groups (read-only by convention). */
export function __animSceneryBatchGroupsForTest() {
  return _order;
}
