// tests/anim_scenery_gpu.test.mjs — ?animSceneryGpu (2026-10-17, default ON).
//
// The instanced DAT-anim scenery (live on the 1070: the ambient critters —
// 3,411 placements, ~7,100 instance slots in 27 buckets) was posed on the CPU
// every frame: instanceMatrix_i = T_i·R_o(t)·(R_i·S_i)·P(t), 1.3 ms/frame. Every
// placement of a DID shares P(t) and the orbit R_o(t), so they now live in a
// per-(DID, part) row of a float texture and the vertex shader rebuilds the
// matrix (the slot keeps the static placement). Locks:
//   1. the matrix each instance is DRAWN with (shader math, JS mirror) equals
//      the CPU path's slot matrix, frame by frame, for orbiting and plain DIDs,
//      any heading / scale;
//   2. GPU buckets hold the static placement and need no per-frame slot write;
//   3. the injected GLSL: header first, define after the raw-attribute read,
//      setup call is main's first statement, idempotent, no main → untouched;
//   4. the material variant: member's chain + injection, key + "|aiGpu1", the
//      member's live uniform handles are not stolen, member edits follow;
//   5. `?animSceneryGpu=off` keeps today's CPU path.
//
// Run from apps/holtburger-web/:  node tests/anim_scenery_gpu.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 1;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const AS = await import("../scene3d/animated_scenery.js");
const GPU = await import("../scene3d/anim_scenery_gpu.js");

// A 2-part, 6-frame clip: part 0 swings about Z off-origin (a wing), part 1
// bobs. Layout per (frame, part): [ox, oy, oz, qw, qx, qy, qz].
function clipFrames() {
  const out = [];
  for (let f = 0; f < 6; f++) {
    const a = (f / 6) * Math.PI * 2;
    const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.2, 1).normalize(), Math.sin(a) * 0.8);
    out.push(0.5, -12, 15, q0.w, q0.x, q0.y, q0.z);
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.cos(a) * 0.4);
    out.push(0, 0.2 * Math.sin(a), 1.5, q1.w, q1.x, q1.y, q1.z);
  }
  return new Float32Array(out);
}
// Tilted orbit axis (real seagull axis is ~-Z; tilt it so order matters).
const OMEGA = new Float32Array([0.012, 0.007, -0.0384]);

function wasm(omegaByAnim) {
  const tri = () => ({
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.2, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08000010]),
  });
  return {
    async fetchAnimation(animId) {
      const a = { numParts: 2, numFrames: 6, flags: 2, frames: clipFrames(), free() {} };
      const om = omegaByAnim[animId >>> 0];
      if (om) a.setOmega = om;
      return a;
    },
    async fetchBuildingPlacement() {
      return {
        partCount: 2,
        takePartMeshes: () => [tri(), tri()],
        takePartHingeFrames: () => [
          { x: 0.5, y: -12, z: 15, qw: 1, qx: 0, qy: 0, qz: 0 },
          { x: 0, y: 0, z: 1.5, qw: 1, qx: 0, qy: 0, qz: 0 },
        ],
        free() {},
      };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

const LB = 0xa9b30000;
function placements() {
  const out = [];
  const specs = [
    [0x020005ac, 0x03000751, 20, 30, 50, 0.3, 1], // orbiting seagull
    [0x020005ac, 0x03000751, 150, 90, 61, 2.1, 1.7],
    [0x02000493, 0x030006cb, 77, 140, 44, -1.2, 0.6], // plain butterfly
    [0x02000493, 0x030006cb, 180, 10, 40, 3.0, 1],
  ];
  specs.forEach(([objId, anim, x, y, z, yaw, scale], i) => {
    // Odd placements also TILT (a full AC quaternion), so the orbit's
    // pre-multiplication does not commute with the placement rotation.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    if (i % 2 === 1) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0.5, 0.2).normalize(), 0.7));
    out.push({ objId, defaultAnimationId: anim, landblockId: LB, sourceObjIdx: i + 1, x, y, z,
      qw: q.w, qx: q.x, qy: q.y, qz: q.z, scale });
  });
  return out;
}

async function build(gpu) {
  GPU.__setAnimSceneryGpuForTest(gpu);
  AS.__setAnimSceneryOmegaHzForTest(15);
  const scene3d = {
    staticsGroup: new THREE.Group(),
    materialCache: { get: async () => new THREE.MeshStandardMaterial() },
  };
  const r = await AS.attachAnimatedScenery(scene3d, placements(), wasm({ 0x03000751: OMEGA }), {});
  assert.equal(r.built, 4);
  const buckets = scene3d.staticsGroup.children.filter((o) => o.isInstancedMesh);
  return { scene3d, buckets };
}

function snapshot(buckets) {
  const m = new THREE.Matrix4();
  const out = [];
  for (const b of [...buckets].sort((a, c) => (a.name < c.name ? -1 : 1))) {
    for (let i = 0; i < b.count; i++) {
      AS.animSceneryEffectiveMatrixAt(b, i, m);
      out.push({ name: b.name, i, e: Array.from(m.elements) });
    }
  }
  return out;
}

async function runFrames(gpu) {
  const { buckets } = await build(gpu);
  const frames = [];
  const dts = [1 / 60, 1 / 30, 0.05, 1 / 144, 1 / 60, 0.07, 1 / 45, 1 / 60];
  for (const dt of dts) {
    AS.tickAnimatedScenery(dt);
    frames.push(snapshot(buckets));
  }
  const gpuRows = buckets.map((b) => b.userData.animGpuRow);
  AS.disposeAnimatedScenery();
  return { frames, gpuRows };
}

test("1. drawn matrices equal the CPU path frame by frame", async () => {
  const cpu = await runFrames(false);
  const gpu = await runFrames(true);
  assert.ok(cpu.gpuRows.every((r) => r === -1), "flag off: CPU buckets");
  assert.ok(gpu.gpuRows.every((r) => r >= 1), "flag on: every bucket GPU-posed");
  assert.equal(gpu.frames.length, cpu.frames.length);
  let maxRot = 0, maxPos = 0, moved = false;
  for (let f = 0; f < cpu.frames.length; f++) {
    const a = cpu.frames[f], b = gpu.frames[f];
    assert.equal(b.length, a.length, "same slots");
    for (let k = 0; k < a.length; k++) {
      assert.equal(a[k].name.replace(/-0x[0-9a-f]+-/, "-"), b[k].name.replace(/-0x[0-9a-f]+-/, "-"));
      for (let j = 0; j < 16; j++) {
        const d = Math.abs(a[k].e[j] - b[k].e[j]);
        if (j >= 12) maxPos = Math.max(maxPos, d); else maxRot = Math.max(maxRot, d);
      }
      if (f > 0 && cpu.frames[f][k].e.some((v, j) => Math.abs(v - cpu.frames[f - 1][k].e[j]) > 1e-4)) moved = true;
    }
  }
  assert.ok(moved, "setup: the instances actually animate");
  assert.ok(maxRot < 1e-5, `rotation/scale columns agree (max |Δ| ${maxRot})`);
  assert.ok(maxPos < 5e-3, `translations agree to float32 at ~30 km (max |Δ| ${maxPos} m)`);
});

test("2. GPU slots hold the static placement; no per-frame slot writes", async () => {
  const { buckets } = await build(true);
  const before = buckets.map((b) => Array.from(b.instanceMatrix.array.subarray(0, b.count * 16)));
  for (let i = 0; i < 5; i++) AS.tickAnimatedScenery(1 / 30);
  const after = buckets.map((b) => Array.from(b.instanceMatrix.array.subarray(0, b.count * 16)));
  assert.deepEqual(after, before, "instance matrices untouched by ticks");
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  buckets[0].getMatrixAt(0, m);
  m.decompose(p, q, s);
  assert.ok(Math.abs(p.x - (0xa9 * 192 + 20)) < 1e-2 || Math.abs(p.x - (0xa9 * 192 + 150)) < 1e-2
    || Math.abs(p.x - (0xa9 * 192 + 77)) < 1e-2 || Math.abs(p.x - (0xa9 * 192 + 180)) < 1e-2,
    "slot translation is a placement anchor");
  assert.ok(buckets.every((b) => b.geometry.getAttribute("hbAiPose")), "bucket geometry carries its pose row");
  assert.ok(AS.animatedSceneryDiag().gpuBuckets === buckets.length);
  AS.disposeAnimatedScenery();
});

test("3. GLSL injection shape", () => {
  const vs = "#define STANDARD\nuniform float uX;\nvoid main() {\n  vec3 a = vec3(0.0);\n  #include <project_vertex>\n}\n";
  const sh = { vertexShader: vs };
  assert.equal(GPU.injectAnimInstPose(sh), true);
  const out = sh.vertexShader;
  assert.ok(out.startsWith("#ifdef USE_INSTANCING"), "header at the very top of the body");
  const read = out.indexOf("mat4 hbN = instanceMatrix;");
  const def = out.indexOf("#define instanceMatrix hbAiInstanceMatrix");
  assert.ok(read > 0 && def > read, "raw attribute read BEFORE the define");
  assert.ok(def < out.indexOf("#define STANDARD"), "define precedes the whole original body");
  assert.ok(/void main\(\) \{\n#ifdef USE_INSTANCING\n  hbAiPoseSetup\(\);\n#endif\n  vec3 a/.test(out),
    "setup is main's first statement");
  assert.ok(!/`/.test(out), "no backticks in GLSL");
  const again = out;
  GPU.injectAnimInstPose(sh);
  assert.equal(sh.vertexShader, again, "idempotent");
  const noMain = { vertexShader: "uniform float x;\n" };
  assert.equal(GPU.injectAnimInstPose(noMain), false);
  assert.equal(noMain.vertexShader, "uniform float x;\n", "no main: untouched");
});

test("4. material variant: chain, key, handles, sync", () => {
  const member = new THREE.MeshStandardMaterial({ opacity: 0.5, transparent: true });
  const handle = { marker: "member-own" };
  Object.defineProperty(member.userData, "csmShaderUniforms", { value: handle, writable: true, enumerable: false, configurable: true });
  let hookThis = null;
  member.onBeforeCompile = function (shader) {
    hookThis = this;
    // a member hook that stashes a live handle on its closure's material
    Object.defineProperty(member.userData, "csmShaderUniforms", { value: shader.uniforms, writable: true, enumerable: false, configurable: true });
    shader.vertexShader = shader.vertexShader.replace("void main() {", "uniform float uMember;\nvoid main() {");
  };
  member.customProgramCacheKey = function () { return "hb|test|" + (this.userData.flag ? 1 : 0); };
  const v = GPU.animInstMaterialFor(member);
  assert.ok(v && v !== member && v.isMeshStandardMaterial);
  assert.equal(GPU.animInstMaterialFor(member), v, "one variant per member");
  assert.equal(v.userData, member.userData, "userData shared by reference");
  assert.equal(v.customProgramCacheKey(), "hb|test|0|aiGpu1");
  member.userData.flag = true;
  assert.equal(v.customProgramCacheKey(), "hb|test|1|aiGpu1", "key follows the member's flags");
  const shader = { vertexShader: "void main() {\n}\n", uniforms: {} };
  v.onBeforeCompile(shader, null);
  assert.equal(hookThis, v, "member chain ran with the variant as `this`");
  assert.ok(shader.vertexShader.includes("uniform float uMember;"), "member patch applied");
  assert.ok(shader.vertexShader.includes("hbAiPoseSetup();"), "pose injection applied");
  assert.ok(shader.uniforms.hbAiPoseTex && "value" in shader.uniforms.hbAiPoseTex, "pose texture uniform bound");
  assert.equal(member.userData.csmShaderUniforms, handle, "member's live handle not stolen by the variant compile");
  member.opacity = 0.25;
  member.map = new THREE.Texture();
  member.needsUpdate = true;
  GPU.syncAnimInstMaterials();
  assert.equal(v.opacity, 0.25);
  assert.equal(v.map, member.map);
  assert.equal(v.version, member.version);
  assert.equal(GPU.animInstMaterialFor(new THREE.ShaderMaterial()), null, "ShaderMaterial keeps the CPU path");
  member.dispose();
  assert.notEqual(GPU.animInstMaterialFor(member), v, "member dispose drops its variant");
});

test("5. flag off: CPU path, no variant, no pose attribute", async () => {
  const { buckets } = await build(false);
  assert.ok(buckets.every((b) => b.userData.animGpuRow === -1 && !b.geometry.getAttribute("hbAiPose")));
  assert.ok(buckets.every((b) => !String(b.material.customProgramCacheKey()).endsWith("|aiGpu1")));
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
  AS.__setAnimSceneryOmegaHzForTest(undefined);
});
