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
// GLSL text below: no backticks, quotes or apostrophes.

import * as THREE from "three";
import { injectVertexHeader } from "./row_texture.js";

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

/** The vertex header: one state-row fetch per vertex into flat varyings. */
export function layerStateVertexChunk() {
  return [
    "// ---- " + LAYERS_MARKER + " (scene3d/gpu_batch/class_materials.js) ----",
    "uniform highp sampler2D " + STATE_SAMPLER + ";",
    "attribute float " + SLOT_ATTR + ";",
    "flat varying vec4 vHbS0;",
    "flat varying vec4 vHbS1;",
    "flat varying vec4 vHbS2;",
    "flat varying vec4 vHbS3;",
    "void hbBatchSlotSetup() {",
    "  int hbS = int(" + SLOT_ATTR + " + 0.5);",
    "  vHbS0 = texelFetch(" + STATE_SAMPLER + ", ivec2(0, hbS), 0);",
    "  vHbS1 = texelFetch(" + STATE_SAMPLER + ", ivec2(1, hbS), 0);",
    "  vHbS2 = texelFetch(" + STATE_SAMPLER + ", ivec2(2, hbS), 0);",
    "  vHbS3 = texelFetch(" + STATE_SAMPLER + ", ivec2(3, hbS), 0);",
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

/** [stock text, replacement] pairs, applied to the fragment template. */
export function fragmentReplacements(withNormal) {
  const r = [
    // diffuse + opacity uniforms -> slot texel 0 (same f32 values)
    ["vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vHbS0;"],
    ["#include <map_fragment>", [
      "#ifdef USE_MAP",
      "\tvec4 sampledDiffuseColor = texture( hbBatchMapArr, vec3( vMapUv, vHbS2.y ) );",
      "\tdiffuseColor *= sampledDiffuseColor;",
      "#endif",
    ].join("\n")],
    ["#include <alphatest_fragment>", [
      "#ifdef USE_ALPHATEST",
      "\tif ( diffuseColor.a < vHbS2.x ) discard;",
      "#endif",
    ].join("\n")],
    ["#include <roughnessmap_fragment>", "float roughnessFactor = vHbS1.x;"],
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
  return r;
}

/**
 * Apply the class patch to an onBeforeCompile `shader`. Returns the number of
 * fragment replacements that did NOT find their stock text (0 = complete).
 */
export function applyClassPatch(shader, withNormal) {
  injectVertexHeader(shader, layerStateVertexChunk(), LAYERS_MARKER, "hbBatchSlotSetup", null);
  let fs = shader.fragmentShader;
  let missing = 0;
  if (fs.indexOf(LAYERS_MARKER) === -1) {
    for (const [from, to] of fragmentReplacements(withNormal)) {
      if (fs.indexOf(from) === -1) { missing += 1; continue; }
      fs = fs.replace(from, to);
    }
    fs = FRAG_HEADER + (withNormal ? FRAG_HEADER_NORMAL : "") + fs;
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
export function classPatchMissing({ chain = null, withNormal = false } = {}) {
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
  return applyClassPatch(shader, withNormal);
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
  const base = o.base || {};
  const m = new THREE.MeshStandardMaterial({
    map: dummyMap(),
    side: cls.side === "front" ? THREE.FrontSide : THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  if (withNormal) m.normalMap = dummyNormalMap();
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
    shader.uniforms.hbBatchMapArr = mapU;
    if (nrmU) shader.uniforms.hbBatchNrmArr = nrmU;
    shader.uniforms[STATE_SAMPLER] = stateU;
    if (hook) hook(shader);
    applyClassPatch(shader, withNormal);
  };
  const key = (o.chainKey || "") + CLASS_KEY_SUFFIX + "|" + classKeyOf(cls) + "|" + (o.vertexHookKey || "") + (withNormal ? "|n1" : "|n0");
  m.customProgramCacheKey = function hbBatchClassProgramKey() { return key; };
  m.name = `gpu-batch-class-${classKeyOf(cls)}`;
  m.userData = { hbBatchClass: classKeyOf(cls), hbBatchProgramKey: key };
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
