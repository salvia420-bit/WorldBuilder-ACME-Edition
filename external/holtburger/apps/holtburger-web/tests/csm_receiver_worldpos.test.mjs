// tests/csm_receiver_worldpos.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-2 + shadows-restore-4) — the
// CSM receiver patch (materials.js _installCsmShaderPatch) and its terrain
// copy (terrain.js csmSampleCascade).
//
//   W1  shadows-restore-2, the shader text: the injected world position goes
//       batchingMatrix (#ifdef USE_BATCHING) -> instanceMatrix (#ifdef
//       USE_INSTANCING) -> modelMatrix, and the old modelMatrix-only multiply
//       is gone.
//   W2  shadows-restore-2, same chain as three: for all four define combos
//       the ACTIVE CSM lines (real r184 standard vertex shader, #includes
//       resolved, preprocessed) apply exactly the matrices three's own
//       worldpos_vertex applies, in the same order, and batchingMatrix is
//       declared before the CSM block (also under batched_runs.js's chunk
//       rewrite).
//   W3  shadows-restore-2, the bug trigger, numerically: a real
//       THREE.BatchedMesh / THREE.InstancedMesh placed away from the origin.
//       Evaluating the active CSM lines lands on the instance's true world
//       vertex; the pre-fix modelMatrix-only line (negative control) misses
//       by the instance offset, i.e. it looks the cascades up near the bucket
//       origin.
//   K   program key: a CSM receiver keys `|c2`; un-patched keys keep `|c0`.
//   L1  shadows-restore-4: materials.js has 4 textureLod(sm, ..., 0.0) taps
//       and no implicit-LOD texture(sm, ...) left.
//   L2  shadows-restore-4: terrain.js same, and every change sits inside the
//       `#ifdef HB_TERRAIN_CSM` block, which is only defined with csmState.
//   L3  pixel identity premise: three r184 gives the cascade depth texture
//       minFilter == magFilter (Linear/Linear under PCF, the type index.js
//       sets with CSM) and a non-mipmap min filter, so the implicit LOD only
//       ever chose between two identical filters; LOD 0 = same taps.
//   D   default path untouched: CSM is off in every preset; a MaterialCache
//       without csmState never installs the hook (no CSM text, `|c0`).
//
// Run: node tests/csm_receiver_worldpos.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as THREE from "three";
import { installCsmShaderPatch, MaterialCache, SURFACE_TYPE } from "../scene3d/materials.js";
import { setupCsm, csmShadowSampleTexture } from "../scene3d/csm.js";
import { patchBatchingChunks } from "../scene3d/batched_runs.js";
import { getQuality, PRESET_NAMES } from "../scene3d/quality.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// --- three r184 program text helpers (tests/baked_direct_out.test.mjs) -------
function resolveIncludes(s, chunks = {}) {
  return s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name) => {
    const c = chunks[name] ?? THREE.ShaderChunk[name];
    if (c === undefined) throw new Error(`unknown chunk ${name}`);
    return resolveIncludes(c, chunks);
  });
}
// Minimal GLSL preprocessor: #if/#ifdef/#ifndef/#elif/#else/#endif,
// object-like #define/#undef, defined(), integer logic in #if.
function preprocess(src, defines) {
  const macros = new Map(Object.entries(defines));
  const expand = (expr) => {
    let e = expr.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) => (macros.has(a || b) ? " 1 " : " 0 "));
    for (let n = 0; n < 8; n++) {
      const next = e.replace(/\b[A-Za-z_]\w*\b/g, (id) => (macros.has(id) ? ` ( ${macros.get(id) === "" ? "1" : macros.get(id)} ) ` : " 0 "));
      if (next === e) break;
      e = next;
    }
    return e;
  };
  const evalIf = (expr) => !!Function(`"use strict"; return ( ${expand(expr)} );`)();
  const out = [], stack = [];
  const isActive = () => stack.every((f) => f.active);
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^#\s*(ifdef|ifndef)\s+(\w+)/))) {
      const v = m[1] === "ifdef" ? macros.has(m[2]) : !macros.has(m[2]);
      stack.push({ active: isActive() && v, taken: v, parentActive: isActive() });
    } else if ((m = line.match(/^#\s*if\s+(.*)$/))) {
      const pa = isActive(); const v = pa && evalIf(m[1]);
      stack.push({ active: v, taken: v, parentActive: pa });
    } else if ((m = line.match(/^#\s*elif\s+(.*)$/))) {
      const f = stack[stack.length - 1];
      if (f.taken || !f.parentActive) f.active = false; else { f.active = evalIf(m[1]); f.taken = f.active; }
    } else if (/^#\s*else\b/.test(line)) {
      const f = stack[stack.length - 1]; f.active = f.parentActive && !f.taken; f.taken = true;
    } else if (/^#\s*endif\b/.test(line)) {
      stack.pop();
    } else if ((m = line.match(/^#\s*define\s+(\w+)\s*(.*)$/))) {
      if (isActive()) macros.set(m[1], m[2]);
    } else if ((m = line.match(/^#\s*undef\s+(\w+)/))) {
      if (isActive()) macros.delete(m[1]);
    } else if (/^#\s*(pragma|version|extension)\b/.test(line)) {
      // carries no code
    } else if (isActive()) out.push(raw);
  }
  return out;
}
const stripComments = (lines) =>
  lines.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    .split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
// No spot-light coords in this client (lighting.js: no spot shadows / maps).
const lightNums = (s) => s.replace(/NUM_SPOT_LIGHT_COORDS/g, "0");

/** Run `mat`'s onBeforeCompile chain on the REAL r184 standard shader text. */
function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}
function activeVert(vertexShader, defs, chunks = {}) {
  return stripComments(preprocess(lightNums(resolveIncludes(vertexShader, chunks)), defs));
}

/** Active lines from the first line matching `startRe` through the first matching `endRe`. */
function block(lines, startRe, endRe) {
  const i = lines.findIndex((l) => startRe.test(l));
  if (i < 0) return null;
  let j = i;
  while (j < lines.length && !endRe.test(lines[j])) j++;
  return j < lines.length ? lines.slice(i, j + 1) : null;
}
/** The matrices a `v = A * B * v;` chain applies, in application order. */
function matrixChain(lines, varName) {
  const seq = [];
  for (const l of lines) {
    const m = l.match(new RegExp(`^(?:vec4\\s+)?${varName}\\s*=\\s*(.+);$`));
    if (!m) continue;
    const ops = m[1].split("*").map((t) => t.trim());
    const src = ops.pop();
    if (!(src === varName || /^vec4\(\s*transformed\s*,\s*1\.0\s*\)$/.test(src))) return null;
    for (let k = ops.length - 1; k >= 0; k--) seq.push(ops[k]);
  }
  return seq;
}
/** Evaluate a matrix chain numerically on a local vertex. */
function evalChain(seq, env, v) {
  const p = v.clone();
  for (const name of seq) {
    const M = env[name];
    if (!M) throw new Error(`no matrix bound for ${name}`);
    p.applyMatrix4(M);
  }
  return p;
}

const sceneM = new THREE.Scene();
const csmState = setupCsm(sceneM, { sunDir: { x: 60, y: 80, z: 30 } });
const csmMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
installCsmShaderPatch(csmMat, csmState);
const sh = compile(csmMat);

// ---------------------------------------------------------------------------
console.log("\n-- W1 injected text --------------------------------------------");
{
  const vs = sh.vertexShader;
  const at = vs.indexOf("#include <project_vertex>");
  const inj = vs.slice(at, vs.indexOf("vCsmWorldPos = _wp.xyz;", at) + 1);
  const iB = inj.indexOf("#ifdef USE_BATCHING\n  _wp = batchingMatrix * _wp;\n#endif");
  const iI = inj.indexOf("#ifdef USE_INSTANCING\n  _wp = instanceMatrix * _wp;\n#endif");
  const iM = inj.indexOf("_wp = modelMatrix * _wp;");
  check("USE_BATCHING term present (batchingMatrix * _wp)", iB > 0, inj);
  check("USE_INSTANCING term present (instanceMatrix * _wp)", iI > 0, inj);
  check("order: batching, then instancing, then modelMatrix (worldpos_vertex order)", iB > 0 && iB < iI && iI < iM);
  check("the old modelMatrix-only multiply is gone",
    !/modelMatrix\s*\*\s*vec4\(\s*transformed/.test(vs));
  check("the block still follows <project_vertex> (mvPosition-derived view depth unchanged)",
    at >= 0 && /vCsmViewDepth = -mvPosition\.z;/.test(vs.slice(at)));
  check("one CSM block only (no double injection)",
    vs.split("vCsmWorldPos = _wp.xyz;").length === 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- W2 same chain as three's worldpos_vertex, all define combos ---");
const COMBOS = [
  ["plain Mesh", {}],
  ["InstancedMesh", { USE_INSTANCING: "" }],
  ["BatchedMesh", { USE_BATCHING: "" }],
  ["batching + instancing", { USE_BATCHING: "", USE_INSTANCING: "" }],
];
const BASE_DEFS = { STANDARD: "", USE_SHADOWMAP: "", USE_UV: "", USE_MAP: "" };
const runs = patchBatchingChunks(THREE.ShaderChunk);
check("batched_runs.js chunk rewrite applies to r184 (test precondition)", !!runs);
const RUNS_CHUNKS = runs
  ? { batching_pars_vertex: runs.pars, batching_vertex: runs.vert, color_vertex: runs.color }
  : {};
const chains = {};
for (const [label, extra] of COMBOS) {
  for (const [variant, chunks] of [["stock chunks", {}], ["batched_runs chunks", RUNS_CHUNKS]]) {
    const act = activeVert(sh.vertexShader, { ...BASE_DEFS, ...extra }, chunks);
    // Start at the CSM block's first assignment, whatever its shape, so the
    // pre-fix one-liner is parsed too (it then reports [modelMatrix] only).
    const csm = block(act, /^vec4 _wp = /, /^vCsmWorldPos = _wp\.xyz;$/);
    const ref = block(act, /^vec4 worldPosition = vec4\( transformed, 1\.0 \);$/, /^worldPosition = modelMatrix \* worldPosition;$/);
    const csmSeq = csm && matrixChain(csm, "_wp");
    const refSeq = ref && matrixChain(ref, "worldPosition");
    if (variant === "stock chunks") chains[label] = csmSeq;
    check(`${label} (${variant}): CSM chain == worldpos_vertex chain [${csmSeq?.join(" -> ")}]`,
      !!csmSeq && !!refSeq && csmSeq.length > 0 && csmSeq.join(",") === refSeq.join(","),
      `csm=${csmSeq?.join(",")} ref=${refSeq?.join(",")}`);
    if (extra.USE_BATCHING !== undefined) {
      const decl = act.findIndex((l) => /^mat4 batchingMatrix = getBatchingMatrix\(/.test(l));
      const use = act.indexOf("_wp = batchingMatrix * _wp;");
      check(`${label} (${variant}): batchingMatrix declared before the CSM block`,
        decl >= 0 && use > decl, `decl=${decl} use=${use}`);
    }
  }
}
check("plain Mesh compiles to the old single multiply (modelMatrix only)",
  chains["plain Mesh"]?.join(",") === "modelMatrix");

// ---------------------------------------------------------------------------
console.log("\n-- W3 bug trigger, numerically (real BatchedMesh / InstancedMesh) --");
{
  const v = new THREE.Vector3(1.5, 2.0, -0.75); // a local vertex
  const OLD_LINE = ["vec4 _wp = modelMatrix * vec4(transformed, 1.0);"]; // pre-fix hook (negative control)
  const oldSeq = matrixChain(OLD_LINE, "_wp");
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const inst = new THREE.Matrix4().compose(
    new THREE.Vector3(120, 4, -80),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
    new THREE.Vector3(1.25, 1.25, 1.25),
  );

  // statics bucket shape: a BatchedMesh at a landblock-ish origin, one member
  // placed by setMatrixAt (static_batch_x.js / buildings.js).
  const bm = new THREE.BatchedMesh(1, 64, 128, csmMat);
  const gid = bm.addGeometry(geo);
  const iid = bm.addInstance(gid);
  bm.setMatrixAt(iid, inst);
  bm.position.set(5000, 0, 3000);
  bm.updateMatrixWorld(true);
  const bInst = bm.getMatrixAt(iid, new THREE.Matrix4());
  const bTruth = v.clone().applyMatrix4(bInst).applyMatrix4(bm.matrixWorld); // three's own placement
  const bEnv = { batchingMatrix: bInst, modelMatrix: bm.matrixWorld };
  const safeEval = (seq, env) => { try { return evalChain(seq || [], env, v); } catch (_) { return new THREE.Vector3(NaN, NaN, NaN); } };
  const bNew = safeEval(chains["BatchedMesh"], bEnv);
  const bOld = evalChain(oldSeq, bEnv, v);
  check("BatchedMesh: active CSM chain lands on the true world vertex",
    bNew.distanceTo(bTruth) < 1e-6, `${bNew.toArray()} vs ${bTruth.toArray()}`);
  check("BatchedMesh: the pre-fix line misses by the instance offset (> 100 m, near the bucket origin)",
    bOld.distanceTo(bTruth) > 100 && bOld.distanceTo(bm.position) < 5, `miss=${bOld.distanceTo(bTruth).toFixed(1)}`);

  // ring-baker / walk-in shape: an InstancedMesh.
  const im = new THREE.InstancedMesh(geo, csmMat, 1);
  im.setMatrixAt(0, inst);
  im.position.set(-2400, 12, 7200);
  im.updateMatrixWorld(true);
  const iInst = new THREE.Matrix4();
  im.getMatrixAt(0, iInst);
  const iTruth = v.clone().applyMatrix4(iInst).applyMatrix4(im.matrixWorld);
  const iEnv = { instanceMatrix: iInst, modelMatrix: im.matrixWorld };
  const iNew = safeEval(chains["InstancedMesh"], iEnv);
  const iOld = evalChain(oldSeq, iEnv, v);
  check("InstancedMesh: active CSM chain lands on the true world vertex",
    iNew.distanceTo(iTruth) < 1e-6, `${iNew.toArray()} vs ${iTruth.toArray()}`);
  check("InstancedMesh: the pre-fix line misses by the instance offset (> 100 m)",
    iOld.distanceTo(iTruth) > 100, `miss=${iOld.distanceTo(iTruth).toFixed(1)}`);

  // Plain Mesh: unchanged answer (same as the old line).
  const mesh = new THREE.Mesh(geo, csmMat);
  mesh.position.set(300, 5, 900);
  mesh.updateMatrixWorld(true);
  const pEnv = { modelMatrix: mesh.matrixWorld };
  check("plain Mesh: new chain == old line (no change off the batched / instanced paths)",
    safeEval(chains["plain Mesh"], pEnv).distanceTo(evalChain(oldSeq, pEnv, v)) === 0);
  bm.dispose(); im.dispose(); geo.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- K program key ------------------------------------------------");
{
  const k = csmMat.customProgramCacheKey();
  check("CSM receiver key carries |c2 (new hook version)", k === "hb|d0|c2|p0|l0|a0|b0|f0|s0|k0|v", k);
  const plain = new THREE.MeshStandardMaterial();
  // any other patch installs the key function; CSM off must still read |c0.
  const cache = new MaterialCache({});
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const noCsm = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  const kNo = typeof noCsm.customProgramCacheKey === "function" ? noCsm.customProgramCacheKey() : "";
  check("MaterialCache without csmState: key keeps |c0, never |c2", /\|c0\|/.test(kNo) && !/\|c2/.test(kNo), kNo);
  check("stock material key untouched (no hb key installed)", !/^hb\|/.test(plain.customProgramCacheKey()));
}

// ---------------------------------------------------------------------------
console.log("\n-- L1 materials.js: explicit-LOD cascade taps --------------------");
{
  const fs = sh.fragmentShader;
  const fn = fs.slice(fs.indexOf("float _csmSampleCascade("), fs.indexOf("float _csmShadowFactor("));
  const lod = fn.match(/textureLod\(sm, vec3\([^;]*?, ref\), 0\.0\)/g) || [];
  check("4 textureLod(sm, vec3(uv, ref), 0.0) taps", lod.length === 4, String(lod.length));
  check("no implicit-LOD texture(sm, ...) tap left anywhere in the program", !/\btexture\(\s*sm\b/.test(fs));
  check("the four tap offsets are unchanged (+-tx.x, +-tx.y)",
    ["(-tx.x, -tx.y)", "( tx.x, -tx.y)", "(-tx.x,  tx.y)", "( tx.x,  tx.y)"].every((o) => fn.includes(`shadowCoord.xy + vec2${o}, ref), 0.0)`)));
  check("compare reference + bias untouched", fn.includes("float bias = 0.0007;") &&
    fn.includes("float ref = shadowCoord.z - bias;") && fn.includes("float ref = shadowCoord.z + bias;"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L2 terrain.js: same taps, all inside #ifdef HB_TERRAIN_CSM ----");
{
  const SRC = readFileSync(resolve(ROOT, "scene3d/terrain.js"), "utf8");
  const lines = SRC.split("\n");
  const i0 = lines.indexOf("const TERRAIN_FRAGMENT_GLSL = `");
  let i1 = i0 + 1;
  while (i1 < lines.length && lines[i1] !== "`;") i1++;
  const FRAG = lines.slice(i0 + 1, i1).join("\n");
  const b0 = FRAG.indexOf("#ifdef HB_TERRAIN_CSM");
  const b1 = FRAG.indexOf("#endif  // HB_TERRAIN_CSM");
  const csmBlock = FRAG.slice(b0, b1);
  const lod = csmBlock.match(/textureLod\(sm, vec3\([^;]*?, ref\), 0\.0\)/g) || [];
  check("terrain csmSampleCascade: 4 textureLod(..., 0.0) taps", b0 >= 0 && b1 > b0 && lod.length === 4, String(lod.length));
  check("terrain: no implicit-LOD texture(sm, ...) tap left", !/\btexture\(\s*sm\b/.test(FRAG));
  check("terrain: every textureLod(sm ...) sits inside the HB_TERRAIN_CSM block",
    (FRAG.match(/textureLod\(sm,/g) || []).length === lod.length);
  check("terrain: HB_TERRAIN_CSM is defined only when scene3d.csmState exists",
    SRC.includes('...(scene3d?.csmState ? { HB_TERRAIN_CSM: "" } : {}),') &&
    (SRC.match(/HB_TERRAIN_CSM:/g) || []).length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- L3 LOD 0 == implicit LOD on the cascade depth texture ----------");
{
  const THREE_SRC = readFileSync(resolve(ROOT, "node_modules/three/build/three.module.js"), "utf8");
  const at = THREE_SRC.indexOf("if ( this.type === PCFShadowMap ) {");
  const branch = at >= 0 ? THREE_SRC.slice(at, THREE_SRC.indexOf("shadow.camera.updateProjectionMatrix();", at)) : "";
  check("three r184 PCF shadow depth texture: minFilter = magFilter = LinearFilter",
    /depthTexture\.minFilter = LinearFilter;/.test(branch) && /depthTexture\.magFilter = LinearFilter;/.test(branch));
  check("three r184 non-PCF branch: minFilter = magFilter = NearestFilter (equal too)",
    /depthTexture\.minFilter = NearestFilter;[\s\S]*depthTexture\.magFilter = NearestFilter;/.test(branch.slice(branch.indexOf("} else {"))));
  check("LinearFilter is a non-mipmap min filter (only the base level is ever read)",
    THREE.LinearFilter !== THREE.LinearMipmapLinearFilter && THREE.LinearFilter !== THREE.LinearMipmapNearestFilter);
  const INDEX = readFileSync(resolve(ROOT, "scene3d/index.js"), "utf8");
  check("index.js runs CSM under PCFShadowMap",
    /if \(shadowsEnabled \|\| csmEnabled\) \{\s*renderer\.shadowMap\.enabled = true;\s*renderer\.shadowMap\.type = THREE\.PCFShadowMap;/.test(INDEX));
  const fakeLight = { shadow: { map: { depthTexture: "DEPTH", texture: "COLOUR" } } };
  check("receivers sample the cascade DEPTH texture", csmShadowSampleTexture(fakeLight) === "DEPTH");
}

// ---------------------------------------------------------------------------
console.log("\n-- D default path untouched ---------------------------------------");
{
  for (const tier of PRESET_NAMES) {
    const q = getQuality(`http://127.0.0.1:8765/?quality=${tier}`, "Mozilla/5.0");
    check(`preset ${tier}: CSM off by default`, q?.flags?.csm === false, String(q?.flags?.csm));
  }
  const qOn = getQuality("http://127.0.0.1:8765/?quality=ultra&csm=on", "Mozilla/5.0");
  check("?csm=on still opts in (the only path these changes reach)", qOn?.flags?.csm === true);

  const cache = new MaterialCache({});
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const m = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  check("no csmState: the CSM hook is never installed", m.userData?.csmEnabled !== true);
  const s = compile(m);
  check("no csmState: compiled program carries no CSM text at all",
    !/vCsmWorldPos|_csmSampleCascade|uCsmShadowMap|batchingMatrix \* _wp/.test(s.vertexShader + s.fragmentShader));
}

csmState.dispose?.();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
