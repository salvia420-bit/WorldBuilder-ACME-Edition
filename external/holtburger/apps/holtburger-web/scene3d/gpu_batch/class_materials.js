// scene3d/gpu_batch/class_materials.js — R3-3 K2: class materials
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 6).
//
// One MeshStandardMaterial per draw CLASS instead of one per surface:
//   blend {opaque, alphaTest, translucent, additive}
//   x light {lit, baked}          (baked = the caller's baked-vertex-light chain)
//   x side {front, double}
// The material keeps three's whole physical program; only the per-surface
// inputs are redirected to data:
//   - `map` -> a sampler2DArray page (`hbBatchMapArr`), layer per slot;
//   - `normalMap` -> a second page (`hbBatchNrmArr`), when the class has one;
//   - the per-surface uniforms `diffuse`, `opacity`, `roughness`,
//     `metalness`, `normalScale` and the alpha-test ref -> the slot's layer
//     state row (layer_state.js), fetched ONCE per vertex from the state
//     table and handed to the fragment stage as FLAT varyings (flat: an
//     interpolated constant is not bit-exact; a flat one is the f32 the
//     uniform would have held).
// Every replaced line computes exactly what the stock chunk computed from
// the uniform, from the same f32 value; the dummy 1x1 `map` / `normalMap`
// only switch three's USE_MAP / USE_NORMALMAP_TANGENTSPACE paths on (their
// identity uv transforms are what every surface texture carries; the dummies
// themselves are never sampled and compile out).
//
// PROGRAM KEY. customProgramCacheKey = (base chain key) + '|hbBatch1' + the
// class + the vertex-hook key + the normal-page bit, so a class program is
// never shared with a stock program or another class. Each class used by a
// consumer is registered with shader_prewarm.js (`registerBatchClassPrewarm`)
// so its FXC compile happens behind the loading screen, not mid-walk.
//
// Draws are plain or instanced, never BatchedMesh multidraw ranges (round-3
// rule 5: ANGLE turns every range into a full draw).
//
// POM MEMBERS (2026-10-31). materials.js `_installPomShaderPatch` (Phase 3.1
// parallax occlusion; `?pom`, on at ultra) is a FRAGMENT patch: it declares
// eight uniforms (the per-surface seam-height map `uPomMap` and seven
// scalars: steps, depth, the LOD band, self-shadow steps / darkness, the graze
// switch) and replaces `#include <map_fragment>` with a block that samples
// `map` at the marched uv. A POM class material (`pomUniform` given) runs the
// member's chain, that very text, and redirects ONLY what is per surface, by
// four documented substitutions (`applyPomFragmentPatch`):
//   P1  `uniform sampler2D uPomMap;` -> the height page `hbBatchPomArr` (a
//       sampler2DArray whose layer holds three's own R8 upload of the
//       member's height texture, every mip level: array_pages.js) and the
//       two flat varyings of the slot's POM extension row (vHbP0, vHbP1);
//   P2  each scalar `uniform <int|float> uPom<X>;` -> `#define uPom<X>
//       <row field>` (int( vHbP0.z ) for the steps, vHbP0.y for the depth,
//       ...): the f32 / int the uniform held, per slot (layer_state.js
//       packPomState; the row index rides texel 3 .y of the slot row);
//   P3  each `texture2D(uPomMap, <uv>)` -> `texture( hbBatchPomArr, vec3(
//       <uv>, vHbP0.x ) )`: the same coordinate, the slot's height layer;
//   P4  the POM block's diffuse sample `texture2D(map, _pomUv)` ->
//       `texture( hbBatchMapArr, vec3( _pomUv, vHbS2.y ) )`: the class map
//       redirect at the marched uv (the stock `#include <map_fragment>` pair
//       is skipped: the chain already replaced that line).
// Everything else in the POM text (march, secant step, LOD ramp, graze fade,
// fragment-stage tangent frame, self-shadow pass) is the member's own text.
// The POM normal-map line the patch tries to redirect sits inside the
// UNRESOLVED `#include <normal_fragment_maps>` at onBeforeCompile time, so
// the member samples its normal map at vNormalMapUv and so does the class
// (its normal_fragment_maps replacement still finds the include; a chain
// that had expanded it would miss that anchor and be refused). The chain's
// POM uniforms are dropped from the class shader (a class never holds a
// member's height texture); a chain whose POM text does not have exactly
// this shape is refused (`pomInfoFromShader` -> { reason }), never
// half-patched. One program per (class, POM on / off): the key gains `|pom1`.
//
// EXTRA-MAP MEMBERS (2026-10-31; realboot census, Holtburg ultra,
// `?interiorBatch=on`: 364 members carry aoMap + roughnessMap, 14 add an
// emissiveMap, 14 an emissiveMap alone). The texchan planes materials.js
// `_applyRough` attaches (an R8 cavity-AO `aoMap`, an RGBA8 linear
// `roughnessMap` with the value in .g) and the luminous ladder's `emissiveMap`
// (materials.js applyFloatLumDiffuse: the diffuse map itself, white emissive
// times the luminosity) are per surface. A class with a MAP SET (`mapSetOf`:
// one class per set, the program key gains `|xm` + a / r / e) switches
// three's own USE_AOMAP / USE_ROUGHNESSMAP / USE_EMISSIVEMAP paths on with the
// 1x1 dummy (channel 0, identity transform: what every member plane carries;
// never sampled), so the vertex stage computes vAoMapUv / vRoughnessMapUv /
// vEmissiveMapUv with three's own text, and the fragment stage runs THREE'S
// OWN CHUNKS, expanded in place of their includes (the includes are still
// unresolved at onBeforeCompile), with these substitutions only
// (`MAP_CHUNK_SUBSTITUTIONS`, each anchor exactly once or the class refuses):
//   A1  aomap_fragment: `texture2D( aoMap, vAoMapUv )` -> the AO page
//       `hbBatchAoArr` at ( vAoMapUv, the slot layer vHbP2.x );
//   A2  aomap_fragment: `aoMapIntensity` -> vHbP2.z (the slot's value);
//   R1  roughnessmap_fragment: `float roughnessFactor = roughness;` ->
//       `= vHbS1.x;` (what the map-less class already does);
//   R2  roughnessmap_fragment: `texture2D( roughnessMap, vRoughnessMapUv )`
//       -> the roughness page `hbBatchRghArr` at ( vRoughnessMapUv, vHbP2.y );
//   E1  `vec3 totalEmissiveRadiance = emissive;` (the template) ->
//       `= vHbP3.xyz;` (the member's emissive uniform, per slot);
//   E2  emissivemap_fragment: `texture2D( emissiveMap, vEmissiveMapUv )` ->
//       the MAP page `hbBatchMapArr` at ( vEmissiveMapUv, vHbP3.w ): an
//       emissive member's emissiveMap IS its map (the consumers require the
//       alias), so its emissive layer is an sRGB layer of the map's page.
// The slot's extension row (layer_state.js "EXTRA-MAP FIELDS") carries the
// layers and values: texel 2 (AO layer, roughness layer, aoMapIntensity),
// texel 3 (emissive rgb, emissive layer), fetched once per vertex into the
// flat varyings vHbP2 (AO or roughness) / vHbP3 (emissive), only the ones the
// set needs. A set-less class is the text it always was.
//
// GLSL text below: no backticks, quotes or apostrophes.

import * as THREE from "three";
import { injectVertexHeader } from "./row_texture.js";
import { POM_STATE_FIELDS } from "./layer_state.js";

export const CLASS_KEY_SUFFIX = "|hbBatch1";
export const CLASS_BLENDS = Object.freeze(["opaque", "alphaTest", "translucent", "additive"]);
export const CLASS_LIGHTS = Object.freeze(["lit", "baked"]);
export const CLASS_SIDES = Object.freeze(["front", "double"]);
/** Placeholder alpha-test value: switches USE_ALPHATEST on; the real ref is per slot. */
export const CLASS_ALPHA_TEST_PLACEHOLDER = 0.5;

export const LAYERS_MARKER = "HB_GPU_BATCH_LAYERS";
export const STATE_SAMPLER = "hbBatchStateTex";
export const SLOT_ATTR = "hbBatchSlot";

/** `${blend}.${light}.${side}` */
export function classKeyOf(cls) {
  return `${cls.blend}.${cls.light}.${cls.side}`;
}

/** Parse a class key back. */
export function parseClassKey(key) {
  const [blend, light, side] = String(key).split(".");
  return { blend, light, side };
}

/** All 16 class keys. */
export function allClassKeys() {
  const out = [];
  for (const b of CLASS_BLENDS) for (const l of CLASS_LIGHTS) for (const s of CLASS_SIDES) out.push(`${b}.${l}.${s}`);
  return out;
}

let _dummyMap = null;
let _dummyNormal = null;
/** 1x1 white sRGB map: switches USE_MAP on, never sampled. */
export function dummyMap() {
  if (!_dummyMap) {
    _dummyMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    _dummyMap.colorSpace = THREE.SRGBColorSpace;
    _dummyMap.name = "gpu-batch-dummy-map";
    _dummyMap.needsUpdate = true;
  }
  return _dummyMap;
}
/** 1x1 flat normal: switches USE_NORMALMAP_TANGENTSPACE on, never sampled. */
export function dummyNormalMap() {
  if (!_dummyNormal) {
    _dummyNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    _dummyNormal.name = "gpu-batch-dummy-normal";
    _dummyNormal.needsUpdate = true;
  }
  return _dummyNormal;
}

// ===========================================================================
// Extra-map sets (header "EXTRA-MAP MEMBERS").
// ===========================================================================

/** The class sampler of the AO page (R8 layers) and of the roughness page (RGBA8 linear layers). */
export const AO_PAGE_SAMPLER = "hbBatchAoArr";
export const ROUGH_PAGE_SAMPLER = "hbBatchRghArr";

// The eight sets, frozen constants (index = ao | rough << 1 | emissive << 2).
const _MAP_SETS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7].map((i) => Object.freeze({
  ao: (i & 1) !== 0, rough: (i & 2) !== 0, emissive: (i & 4) !== 0, any: i !== 0,
  key: i === 0 ? "" : "|xm" + ((i & 1) ? "a" : "") + ((i & 2) ? "r" : "") + ((i & 4) ? "e" : ""),
})));
/** No extra map: the class text it always was. */
export const MAP_SET_NONE = _MAP_SETS[0];

/** The (shared, frozen) map set { ao, rough, emissive, any, key }; `key` joins the program key ("" for none). */
export function mapSetOf(ao, rough, emissive) {
  return _MAP_SETS[(ao ? 1 : 0) | (rough ? 2 : 0) | (emissive ? 4 : 0)];
}

/** A member's map set (the maps it carries; a consumer's eligibility decides whether it may batch). */
export function memberMapSet(member) {
  return member ? mapSetOf(!!member.aoMap, !!member.roughnessMap, !!member.emissiveMap) : MAP_SET_NONE;
}

/** A1 / A2, R1 / R2, E2: [chunk text, class text] pairs inside three's own chunk, by chunk name. */
export const MAP_CHUNK_SUBSTITUTIONS = Object.freeze({
  aomap_fragment: Object.freeze([
    Object.freeze(["texture2D( aoMap, vAoMapUv )", "texture( " + AO_PAGE_SAMPLER + ", vec3( vAoMapUv, vHbP2.x ) )"]),
    Object.freeze(["aoMapIntensity", "vHbP2.z"]),
  ]),
  roughnessmap_fragment: Object.freeze([
    Object.freeze(["float roughnessFactor = roughness;", "float roughnessFactor = vHbS1.x;"]),
    Object.freeze(["texture2D( roughnessMap, vRoughnessMapUv )", "texture( " + ROUGH_PAGE_SAMPLER + ", vec3( vRoughnessMapUv, vHbP2.y ) )"]),
  ]),
  emissivemap_fragment: Object.freeze([
    Object.freeze(["texture2D( emissiveMap, vEmissiveMapUv )", "texture( hbBatchMapArr, vec3( vEmissiveMapUv, vHbP3.w ) )"]),
  ]),
});
/** E1: the template line the emissive class redirects. */
export const EMISSIVE_RADIANCE_LINE = "vec3 totalEmissiveRadiance = emissive;";
export const EMISSIVE_RADIANCE_BATCH = "vec3 totalEmissiveRadiance = vHbP3.xyz;";

/**
 * Three's own chunk `name` (THREE.ShaderChunk, what resolveIncludes would put
 * in place of its include) with its MAP_CHUNK_SUBSTITUTIONS applied; null
 * when an anchor is not there exactly once (the class then refuses).
 */
export function batchMapChunk(name) {
  let s = THREE.ShaderChunk[name];
  const subs = MAP_CHUNK_SUBSTITUTIONS[name];
  if (typeof s !== "string" || !subs) return null;
  for (const [from, to] of subs) {
    if (_occurrences(s, from) !== 1) return null;
    s = s.replace(from, to);
  }
  return s;
}

/**
 * The vertex header: one state-row fetch per vertex into flat varyings
 * (`withPom`: also the slot's POM extension row, texel 3 .y, into vHbP0 /
 * vHbP1; `maps`, a map set: texel 2 of that row into vHbP2 for AO /
 * roughness, texel 3 into vHbP3 for emissive; the text without them is
 * unchanged).
 */
export function layerStateVertexChunk(withPom = false, maps = null) {
  const ms = maps || MAP_SET_NONE;
  const ext2 = ms.ao || ms.rough;
  return [
    "// ---- " + LAYERS_MARKER + " (scene3d/gpu_batch/class_materials.js) ----",
    "uniform highp sampler2D " + STATE_SAMPLER + ";",
    "attribute float " + SLOT_ATTR + ";",
    "flat varying vec4 vHbS0;",
    "flat varying vec4 vHbS1;",
    "flat varying vec4 vHbS2;",
    "flat varying vec4 vHbS3;",
    ...(withPom ? ["flat varying vec4 vHbP0;", "flat varying vec4 vHbP1;"] : []),
    ...(ext2 ? ["flat varying vec4 vHbP2;"] : []),
    ...(ms.emissive ? ["flat varying vec4 vHbP3;"] : []),
    "void hbBatchSlotSetup() {",
    "  int hbS = int(" + SLOT_ATTR + " + 0.5);",
    "  vHbS0 = texelFetch(" + STATE_SAMPLER + ", ivec2(0, hbS), 0);",
    "  vHbS1 = texelFetch(" + STATE_SAMPLER + ", ivec2(1, hbS), 0);",
    "  vHbS2 = texelFetch(" + STATE_SAMPLER + ", ivec2(2, hbS), 0);",
    "  vHbS3 = texelFetch(" + STATE_SAMPLER + ", ivec2(3, hbS), 0);",
    ...(withPom || ms.any ? ["  int hbP = int(vHbS3.y + 0.5);"] : []),
    ...(withPom ? [
      "  vHbP0 = texelFetch(" + STATE_SAMPLER + ", ivec2(0, hbP), 0);",
      "  vHbP1 = texelFetch(" + STATE_SAMPLER + ", ivec2(1, hbP), 0);",
    ] : []),
    ...(ext2 ? ["  vHbP2 = texelFetch(" + STATE_SAMPLER + ", ivec2(2, hbP), 0);"] : []),
    ...(ms.emissive ? ["  vHbP3 = texelFetch(" + STATE_SAMPLER + ", ivec2(3, hbP), 0);"] : []),
    "}",
    "// ---- end " + LAYERS_MARKER + " ----",
    "",
  ].join("\n");
}

const FRAG_HEADER = [
  "// ---- " + LAYERS_MARKER + " ----",
  "uniform highp sampler2DArray hbBatchMapArr;",
  "flat varying vec4 vHbS0;",
  "flat varying vec4 vHbS1;",
  "flat varying vec4 vHbS2;",
  "flat varying vec4 vHbS3;",
  "",
].join("\n");
const FRAG_HEADER_NORMAL = "uniform highp sampler2DArray hbBatchNrmArr;\n";

/** The extra-map part of the fragment header (a map set's page samplers and flat varyings; "" for none). */
export function mapFragmentHeader(maps) {
  const ms = maps || MAP_SET_NONE;
  if (!ms.any) return "";
  const out = [];
  if (ms.ao) out.push("uniform highp sampler2DArray " + AO_PAGE_SAMPLER + ";");
  if (ms.rough) out.push("uniform highp sampler2DArray " + ROUGH_PAGE_SAMPLER + ";");
  if (ms.ao || ms.rough) out.push("flat varying vec4 vHbP2;");
  if (ms.emissive) out.push("flat varying vec4 vHbP3;");
  return out.join("\n") + "\n";
}

/** The fragment header the class patch prepends (what the proof suites strip to compare a class with its member). */
export function classFragmentHeader(withNormal, maps = null) {
  return FRAG_HEADER + (withNormal ? FRAG_HEADER_NORMAL : "") + mapFragmentHeader(maps);
}

/**
 * [stock text, replacement] pairs, applied to the fragment template
 * (`withPom`: without the map_fragment pair, which the POM chain replaced;
 * P4 of applyPomFragmentPatch redirects its sample instead; `maps`, a map
 * set: three's own roughness / emissive / AO chunks with A1-E2 in place of
 * their includes, header "EXTRA-MAP MEMBERS"). A replacement is null when
 * its chunk lost an anchor (applyClassPatch counts it missing).
 */
export function fragmentReplacements(withNormal, withPom = false, maps = null) {
  const ms = maps || MAP_SET_NONE;
  const r = [
    // diffuse + opacity uniforms -> slot texel 0 (same f32 values)
    ["vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vHbS0;"],
    ...(withPom ? [] : [["#include <map_fragment>", [
      "#ifdef USE_MAP",
      "\tvec4 sampledDiffuseColor = texture( hbBatchMapArr, vec3( vMapUv, vHbS2.y ) );",
      "\tdiffuseColor *= sampledDiffuseColor;",
      "#endif",
    ].join("\n")]]),
    ["#include <alphatest_fragment>", [
      "#ifdef USE_ALPHATEST",
      "\tif ( diffuseColor.a < vHbS2.x ) discard;",
      "#endif",
    ].join("\n")],
    ["#include <roughnessmap_fragment>", ms.rough ? batchMapChunk("roughnessmap_fragment") : "float roughnessFactor = vHbS1.x;"],
    ["#include <metalnessmap_fragment>", "float metalnessFactor = vHbS1.y;"],
  ];
  if (withNormal) {
    r.push(["#include <normal_fragment_maps>", [
      "#ifdef USE_NORMALMAP_TANGENTSPACE",
      "\tvec3 mapN = texture( hbBatchNrmArr, vec3( vNormalMapUv, vHbS3.x ) ).xyz * 2.0 - 1.0;",
      "\tmapN.xy *= vHbS1.zw;",
      "\tnormal = normalize( tbn * mapN );",
      "#endif",
    ].join("\n")]);
  }
  if (ms.emissive) {
    r.push([EMISSIVE_RADIANCE_LINE, EMISSIVE_RADIANCE_BATCH]);
    r.push(["#include <emissivemap_fragment>", batchMapChunk("emissivemap_fragment")]);
  }
  if (ms.ao) r.push(["#include <aomap_fragment>", batchMapChunk("aomap_fragment")]);
  return r;
}

/**
 * Apply the class patch to an onBeforeCompile `shader`. Returns the number of
 * fragment replacements that did NOT find their stock text (0 = complete).
 * `withPom`: the member chain is materials.js's POM patch (header note): its
 * substitutions run first, and a POM class needs the normal page (the POM
 * text calls getTangentFrame, declared only with a tangent-space normal map).
 * `maps`: the class's map set (header "EXTRA-MAP MEMBERS"; null = none).
 */
export function applyClassPatch(shader, withNormal, withPom = false, maps = null) {
  const ms = maps || MAP_SET_NONE;
  injectVertexHeader(shader, layerStateVertexChunk(withPom, ms), LAYERS_MARKER, "hbBatchSlotSetup", null);
  let fs = shader.fragmentShader;
  let missing = 0;
  if (fs.indexOf(LAYERS_MARKER) === -1) {
    if (withPom) {
      if (!withNormal) missing += 1;
      const p = { fragmentShader: fs };
      missing += applyPomFragmentPatch(p);
      fs = p.fragmentShader;
    }
    for (const [from, to] of fragmentReplacements(withNormal, withPom, ms)) {
      if (to === null || fs.indexOf(from) === -1) { missing += 1; continue; }
      fs = fs.replace(from, () => to);
    }
    fs = FRAG_HEADER + (withNormal ? FRAG_HEADER_NORMAL : "") + mapFragmentHeader(ms) + fs;
    shader.fragmentShader = fs;
  }
  return missing;
}

/**
 * Dry run of a class material's onBeforeCompile on three's stock physical
 * templates: how many stock lines the class patch could NOT find after the
 * base chain ran (0 = the class program is complete). A chain that rewrote a
 * line the patch needs would otherwise compile a program that silently
 * samples the 1x1 dummy.
 */
export function classPatchMissing({ chain = null, withNormal = false, withPom = false, maps = null } = {}) {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
    defines: {},
  };
  try {
    if (chain) chain.call(null, shader, null);
  } catch (_) {
    return Infinity;
  }
  return applyClassPatch(shader, withNormal, withPom, maps);
}

// ===========================================================================
// POM members (header "POM MEMBERS").
// ===========================================================================

/** The uniforms materials.js `_installPomShaderPatch` declares, in its order, with their GLSL types. */
export const POM_UNIFORMS = Object.freeze([
  ["uPomMap", "sampler2D"], ["uPomSteps", "int"], ["uPomDepth", "float"], ["uPomLodNear", "float"],
  ["uPomLodFar", "float"], ["uPomShadowSteps", "int"], ["uPomShadowDarkness", "float"], ["uPomGraze", "float"],
]);
/** The class sampler of the height page. */
export const POM_PAGE_SAMPLER = "hbBatchPomArr";
/** P2: where each POM scalar comes from in the class program (the POM extension row, layer_state.js). */
export const POM_SCALAR_SOURCE = Object.freeze({
  uPomSteps: "int( vHbP0.z )", uPomDepth: "vHbP0.y", uPomShadowSteps: "int( vHbP0.w )",
  uPomLodNear: "vHbP1.x", uPomLodFar: "vHbP1.y", uPomShadowDarkness: "vHbP1.z", uPomGraze: "vHbP1.w",
});
/** P1: what replaces the height-map declaration. */
export const POM_FRAG_HEADER = [
  "uniform highp sampler2DArray " + POM_PAGE_SAMPLER + ";",
  "flat varying vec4 vHbP0;",
  "flat varying vec4 vHbP1;",
].join("\n");
/** P3: one height sample of the POM text (its uv argument is a plain identifier in every call). */
export const POM_SAMPLE_RE = /texture2D\(uPomMap, ([A-Za-z_][A-Za-z0-9_]*)\)/g;
/** P4: the POM block's diffuse sample, and its class redirect. */
export const POM_MAP_SAMPLE = "texture2D(map, _pomUv)";
export const POM_MAP_SAMPLE_BATCH = "texture( hbBatchMapArr, vec3( _pomUv, vHbS2.y ) )";

function _occurrences(s, sub) {
  let n = 0;
  for (let i = s.indexOf(sub); i !== -1; i = s.indexOf(sub, i + sub.length)) n += 1;
  return n;
}

/** The P1 / P2 [declaration, replacement] pairs. */
export function pomDeclarationSubstitutions() {
  return POM_UNIFORMS.map(([n, type]) => ["uniform " + type + " " + n + ";", n === "uPomMap" ? POM_FRAG_HEADER : "#define " + n + " " + POM_SCALAR_SOURCE[n]]);
}

/**
 * P1-P4 on `shader.fragmentShader` (the member chain already ran). Returns
 * the number of anchors that did not have exactly the expected shape (0 =
 * complete): every declaration exactly once, at least one height sample and
 * every one of them redirected (no `uPomMap` left, no other `uPom` uniform
 * declared), the diffuse sample exactly once and no stock map_fragment left.
 */
export function applyPomFragmentPatch(shader) {
  let fs = shader.fragmentShader;
  let missing = 0;
  for (const [from, to] of pomDeclarationSubstitutions()) {
    if (_occurrences(fs, from) !== 1) { missing += 1; continue; }
    fs = fs.replace(from, to);
  }
  const want = _occurrences(fs, "texture2D(uPomMap,");
  let hits = 0;
  fs = fs.replace(POM_SAMPLE_RE, (_, uv) => { hits += 1; return "texture( " + POM_PAGE_SAMPLER + ", vec3( " + uv + ", vHbP0.x ) )"; });
  if (hits === 0 || hits !== want) missing += 1;
  if (/\buPomMap\b/.test(fs) || /\buniform\s+\w+\s+uPom\w*/.test(fs)) missing += 1;
  if (_occurrences(fs, POM_MAP_SAMPLE) !== 1) missing += 1;
  else fs = fs.replace(POM_MAP_SAMPLE, POM_MAP_SAMPLE_BATCH);
  if (fs.indexOf("#include <map_fragment>") !== -1) missing += 1;
  shader.fragmentShader = fs;
  return missing;
}

/** "Not a POM chain" (shared, frozen). */
export const POM_NONE = Object.freeze({ pom: false });

/**
 * What a member chain's dry run (`shader` = three's stock templates after the
 * chain) says about POM: POM_NONE (no POM uniform, no POM text), `{ pom:
 * true, texture, values }` (the height texture the chain binds and its seven
 * scalars as the compile binds them, by layer_state.js POM_STATE_FIELDS
 * name), or `{ reason }` (POM text of another shape: stays legacy).
 */
export function pomInfoFromShader(shader) {
  const u = (shader && shader.uniforms) || {};
  const fs = (shader && shader.fragmentShader) || "";
  const vs = (shader && shader.vertexShader) || "";
  let any = fs.indexOf("uPom") !== -1 || vs.indexOf("uPom") !== -1;
  for (const n of Object.keys(u)) if (n.startsWith("uPom")) { any = true; break; }
  if (!any) return POM_NONE;
  const known = new Set(POM_UNIFORMS.map(([n]) => n));
  for (const n of Object.keys(u)) if (n.startsWith("uPom") && !known.has(n)) return { reason: "pom-shape" };
  const h = u.uPomMap;
  const texture = h && typeof h === "object" ? h.value : null;
  if (!texture || texture.isTexture !== true) return { reason: "pom-map" };
  const values = {};
  for (const [n] of POM_UNIFORMS) {
    if (n === "uPomMap") continue;
    const hu = u[n];
    const v = hu && typeof hu === "object" ? hu.value : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return { reason: "pom-uniform:" + n };
    values[POM_STATE_FIELDS[n]] = v;
  }
  if (vs.indexOf("uPom") !== -1) return { reason: "pom-shape" };
  if (applyPomFragmentPatch({ fragmentShader: fs }) !== 0) return { reason: "pom-shape" };
  return { pom: true, texture, values };
}

let _pomScratch = null;
/** pomInfoFromShader of `chain` run on three's stock physical templates (a chain that throws: { reason }). */
export function pomChainInfo(chain) {
  if (typeof chain !== "function") return POM_NONE;
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
    defines: {},
  };
  if (!_pomScratch) _pomScratch = new THREE.MeshStandardMaterial();
  try { chain.call(_pomScratch, shader, null); } catch (_) { return { reason: "chain-throws" }; }
  return pomInfoFromShader(shader);
}

/** A uniform value as fingerprint text (null = not shareable: a texture, a render target, an opaque object). */
export function uniformValueKey(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === "number" || t === "boolean" || t === "string") return t[0] + String(v);
  if (v.isTexture || v.isRenderTargetTexture || v.isWebGLRenderTarget) return null;
  if (typeof v.toArray === "function") return "a" + v.toArray().join(",");
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    if (depth > 4) return null;
    const out = [];
    for (const x of v) { const k = uniformValueKey(x, depth + 1); if (k === null) return null; out.push(k); }
    return "[" + out.join(",") + "]";
  }
  return null;
}

let _pomNames = null; // Set of the POM uniform names (lazy)

/**
 * A member chain's dry run on three's stock physical templates as a
 * fingerprint (the chain IS this text: two members with equal fingerprints
 * compile the same class program and bind the same chain uniforms):
 * `{ fp, pom }` = (vertex text, fragment text, defines, uniform names +
 * numeric values; for a chain that is materials.js's POM patch the eight POM
 * uniforms by NAME only: their values are slot data) and the POM verdict
 * (POM_NONE or pomInfoFromShader's), or `{ reason }` (the chain throws, a
 * texture-valued or opaque uniform, POM text of another shape). `self` is
 * the `this` the chain runs with (a scratch material).
 */
export function chainFingerprintOf(chain, self = null) {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
    defines: {},
  };
  if (typeof chain === "function") {
    if (!self) { if (!_pomScratch) _pomScratch = new THREE.MeshStandardMaterial(); self = _pomScratch; }
    try { chain.call(self, shader, null); } catch (_) { return { reason: "chain-throws" }; }
  }
  const pom = typeof chain === "function" ? pomInfoFromShader(shader) : POM_NONE;
  if (pom.reason) return { reason: "chain-" + pom.reason };
  if (pom.pom && !_pomNames) _pomNames = new Set(POM_UNIFORMS.map(([n]) => n));
  const parts = [];
  for (const n of Object.keys(shader.uniforms || {}).sort()) {
    if (pom.pom && _pomNames.has(n)) { parts.push(n + "=slot"); continue; }
    const u = shader.uniforms[n];
    const k = uniformValueKey(u && typeof u === "object" && "value" in u ? u.value : u);
    if (k === null) return { reason: "chain-uniform:" + n };
    parts.push(n + "=" + k);
  }
  const defs = [];
  for (const n of Object.keys(shader.defines || {}).sort()) defs.push(n + "=" + String(shader.defines[n]));
  return { fp: shader.vertexShader + "\u0000" + shader.fragmentShader + "\u0000" + defs.join(";") + "\u0000" + parts.join(";"), pom };
}

/** FNV-1a 32 of a string, 8 hex digits (fingerprint ids). */
export function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The POM extension-row state of a member (layer_state.js packPomState):
 * `layer` = its height layer; the scalars from the member's live POM uniform
 * handle (materials.js stashes the compiled `shader.uniforms` as
 * `userData.pomShaderUniforms`: what its program binds now) when it has
 * one, else the dry run's `info.values` (what its compile will bind).
 */
export function pomStateOf(member, info, layer, out = {}) {
  // Per sync per POM slot (consumers' steady state): field to field, no
  // helper returning a double (a non-inlined return boxes it: an allocation
  // a sync, tests/interior_batch_steady.test.mjs A3).
  const live = member && member.userData ? member.userData.pomShaderUniforms : null;
  const v = info.values;
  out.layer = layer;
  if (live && live.uPomSteps && live.uPomDepth && live.uPomShadowSteps && live.uPomLodNear && live.uPomLodFar
    && live.uPomShadowDarkness && live.uPomGraze) {
    out.steps = live.uPomSteps.value;
    out.depth = live.uPomDepth.value;
    out.shadowSteps = live.uPomShadowSteps.value;
    out.lodNear = live.uPomLodNear.value;
    out.lodFar = live.uPomLodFar.value;
    out.shadowDarkness = live.uPomShadowDarkness.value;
    out.graze = live.uPomGraze.value;
  } else {
    out.steps = v.steps;
    out.depth = v.depth;
    out.shadowSteps = v.shadowSteps;
    out.lodNear = v.lodNear;
    out.lodFar = v.lodFar;
    out.shadowDarkness = v.shadowDarkness;
    out.graze = v.graze;
  }
  return out;
}

/**
 * The extra-map half of a member's extension row (layer_state.js
 * packExtState; header "EXTRA-MAP MEMBERS"): the layers the consumer
 * admitted (0 for a map the member does not have), and the values three
 * uploads for the member's own draw: `aoMapIntensity` (only with an aoMap:
 * 0 otherwise) and `emissive` = material.emissive * emissiveIntensity, each
 * channel in f64 as Color.multiplyScalar computes it. Runs per sync per slot
 * with an extension row: field to field into `out`, no helper returning a
 * double (the pomStateOf rule).
 */
export function extraMapStateOf(member, aoLayer, roughLayer, emissiveLayer, out = {}) {
  out.aoLayer = aoLayer;
  out.roughLayer = roughLayer;
  out.aoIntensity = member.aoMap ? member.aoMapIntensity : 0;
  const em = member.emissive;
  if (em) {
    const s = member.emissiveIntensity;
    out.emissiveR = em.r * s;
    out.emissiveG = em.g * s;
    out.emissiveB = em.b * s;
  } else {
    out.emissiveR = 0;
    out.emissiveG = 0;
    out.emissiveB = 0;
  }
  out.emissiveLayer = emissiveLayer;
  return out;
}

/**
 * Build a class material.
 *
 * @param {object} o
 * @param {{blend:string, light:string, side:string}} o.cls
 * @param {{value:any}} o.mapUniform     holder of the map page (ExternalTexture)
 * @param {{value:any}|null} [o.normalUniform] holder of the normal page; null = no normal map
 * @param {{value:any}} o.stateUniform   holder of the state RowTexture texture
 * @param {(shader:any)=>void} [o.vertexHook]  extra vertex injection (e.g. the anim pose)
 * @param {string} [o.vertexHookKey]
 * @param {(shader:any, renderer:any)=>void} [o.chain]  base onBeforeCompile chain (baked light)
 * @param {string} [o.chainKey]
 * @param {{value:any}|null} [o.pomUniform] holder of the height page; given = a POM class
 *   (the chain is materials.js's POM patch: header "POM MEMBERS")
 * @param {{value:any}|null} [o.aoUniform] holder of the AO page; given = the set samples an aoMap
 * @param {{value:any}|null} [o.roughnessUniform] holder of the roughness page; given = a roughnessMap
 * @param {boolean} [o.emissive] the set samples an emissiveMap (from the map page; header "EXTRA-MAP MEMBERS")
 * @param {object} [o.base]  material props copied from a representative member
 *   (fog, envMapIntensity, dithering, toneMapped, depthTest, singlePass)
 */
export function makeClassMaterial(o) {
  const cls = o.cls;
  if (!CLASS_BLENDS.includes(cls.blend) || !CLASS_LIGHTS.includes(cls.light) || !CLASS_SIDES.includes(cls.side)) {
    throw new Error(`makeClassMaterial: bad class ${JSON.stringify(cls)}`);
  }
  if (cls.light === "baked" && typeof o.chain !== "function") {
    throw new Error("makeClassMaterial: a baked-light class needs the baked-light chain");
  }
  const withNormal = !!o.normalUniform;
  const pomU = o.pomUniform || null;
  const aoU = o.aoUniform || null;
  const rghU = o.roughnessUniform || null;
  const ms = mapSetOf(!!aoU, !!rghU, o.emissive === true);
  const base = o.base || {};
  const m = new THREE.MeshStandardMaterial({
    map: dummyMap(),
    side: cls.side === "front" ? THREE.FrontSide : THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  if (withNormal) m.normalMap = dummyNormalMap();
  // The map set's USE_* switches (the 1x1 dummy: channel 0, identity
  // transform; never sampled, A1-E2 redirect every read).
  if (ms.ao) m.aoMap = dummyMap();
  if (ms.rough) m.roughnessMap = dummyMap();
  if (ms.emissive) m.emissiveMap = dummyMap();
  if (cls.blend === "alphaTest") m.alphaTest = CLASS_ALPHA_TEST_PLACEHOLDER;
  if (cls.blend === "translucent") {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
  } else if (cls.blend === "additive") {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.fog = false;
  }
  if (typeof base.fog === "boolean" && cls.blend !== "additive") m.fog = base.fog;
  if (typeof base.envMapIntensity === "number") m.envMapIntensity = base.envMapIntensity;
  if (typeof base.dithering === "boolean") m.dithering = base.dithering;
  if (typeof base.toneMapped === "boolean") m.toneMapped = base.toneMapped;
  if (typeof base.depthTest === "boolean") m.depthTest = base.depthTest;
  if (m.transparent && m.side === THREE.DoubleSide && typeof base.singlePass === "boolean") m.forceSinglePass = base.singlePass;
  const mapU = o.mapUniform;
  const nrmU = o.normalUniform || null;
  const stateU = o.stateUniform;
  const chain = typeof o.chain === "function" ? o.chain : null;
  const hook = typeof o.vertexHook === "function" ? o.vertexHook : null;
  m.onBeforeCompile = function hbBatchClassOnBeforeCompile(shader, renderer) {
    if (chain) chain.call(this, shader, renderer);
    shader.uniforms = shader.uniforms || {};
    if (pomU) {
      // The member's POM uniforms are per surface: the slot rows and the
      // height page carry them (P1-P3); the class holds none of them.
      for (const [n] of POM_UNIFORMS) delete shader.uniforms[n];
      shader.uniforms[POM_PAGE_SAMPLER] = pomU;
    }
    shader.uniforms.hbBatchMapArr = mapU;
    if (nrmU) shader.uniforms.hbBatchNrmArr = nrmU;
    if (aoU) shader.uniforms[AO_PAGE_SAMPLER] = aoU;
    if (rghU) shader.uniforms[ROUGH_PAGE_SAMPLER] = rghU;
    shader.uniforms[STATE_SAMPLER] = stateU;
    if (hook) hook(shader);
    applyClassPatch(shader, withNormal, !!pomU, ms);
  };
  const key = (o.chainKey || "") + CLASS_KEY_SUFFIX + "|" + classKeyOf(cls) + "|" + (o.vertexHookKey || "") + (withNormal ? "|n1" : "|n0")
    + (pomU ? "|pom1" : "") + ms.key;
  m.customProgramCacheKey = function hbBatchClassProgramKey() { return key; };
  m.name = `gpu-batch-class-${classKeyOf(cls)}`;
  m.userData = { hbBatchClass: classKeyOf(cls), hbBatchProgramKey: key };
  if (pomU) m.userData.hbBatchPom = true;
  if (ms.any) m.userData.hbBatchMaps = ms.key;
  return m;
}

/**
 * A one-instance stand-in for compiling a class material's program (the
 * object kind is part of three's program key, so this is an InstancedMesh
 * when the real draws are). The geometry carries every attribute the class
 * shader reads.
 */
export function classPrewarmProxy(material, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  g.setAttribute(SLOT_ATTR, new THREE.BufferAttribute(new Float32Array(3), 1));
  for (const a of opts.extraAttributes || []) g.setAttribute(a, new THREE.BufferAttribute(new Float32Array(3), 1));
  const mesh = opts.instanced === false ? new THREE.Mesh(g, material) : new THREE.InstancedMesh(g, material, 1);
  if (mesh.isInstancedMesh) mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.frustumCulled = false;
  mesh.name = `gpu-batch-prewarm-${material.userData?.hbBatchClass || "class"}`;
  return mesh;
}
