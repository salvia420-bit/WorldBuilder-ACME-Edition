// tests/far_bake_compile_async.test.mjs — `?farBakeCompileAsync` (2026-10-09).
//
// The far-terrain bake program is its own variant of the 151-uniform terrain
// shader. On the 1070 (fresh profile, ANGLE/D3D11) its synchronous first-use
// link froze the main thread for 4,963 ms. `bakeProgramReady` now compiles it
// with the patch's render target bound and polls three's non-blocking
// `program.isReady()`; bakes wait until it reports ready.
//
//   A1  first call: compile() with the patch RT bound and a real LB geometry on the rig mesh
//       (three keys the program on `vertexNormals`), previous target restored, not ready
//   A2  still linking → not ready, no second compile
//   A3  linked → ready (latched; the program is not polled again)
//   A4  `?farBakeCompileAsync=off` → ready at once, no compile (legacy first-use link)
//   A5  compile() throws → ready (fail-soft: the bake links as before)
//
// Run: node tests/far_bake_compile_async.test.mjs

import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.window = globalThis;

const flags = await import("../scene3d/far_terrain_flags.js");
const { _bakeProgramReadyForTest: ready } = await import("../scene3d/far_terrain.js");

function fakeRenderer({ throws = false } = {}) {
  const r = {
    target: "canvas",
    compiled: [],
    linked: false,
    polls: 0,
    program: null,
    getRenderTarget() { return this.target; },
    setRenderTarget(t) { this.target = t; },
    compile(scene, cam) {
      if (throws) throw new Error("boom");
      this.compiled.push({ scene, cam, target: this.target, geom: this.rigMesh?.geometry });
      this.program = { isReady: () => { r.polls++; return r.linked; } };
    },
    properties: { get: () => ({ currentProgram: r.program }) },
  };
  return r;
}
const rig = () => ({ scene: "bakeScene", cam: "bakeCam", mat: {}, mesh: { geometry: "empty" } });

let failures = 0;
function t(name, fn) {
  try { fn(); console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const r = fakeRenderer();
const g = rig();
t("A1 first call compiles with the patch RT bound and a real LB geometry, restores the target, not ready", () => {
  r.rigMesh = g.mesh;
  assert.equal(ready(r, g, "patchRT", "lbGeom"), false);
  assert.deepEqual(r.compiled, [{ scene: "bakeScene", cam: "bakeCam", target: "patchRT", geom: "lbGeom" }]);
  assert.equal(r.target, "canvas");
});
t("A2 still linking → not ready, no second compile", () => {
  assert.equal(ready(r, g, "patchRT"), false);
  assert.equal(r.compiled.length, 1);
  assert.equal(r.polls, 1);
});
t("A3 linked → ready, latched", () => {
  r.linked = true;
  assert.equal(ready(r, g, "patchRT"), true);
  const polls = r.polls;
  assert.equal(ready(r, g, "patchRT"), true);
  assert.equal(r.polls, polls);
});
t("A4 ?farBakeCompileAsync=off → ready at once, no compile", () => {
  globalThis.location = { search: "?farBakeCompileAsync=off" };
  flags._resetFarTerrainFlagsForTest();
  const r2 = fakeRenderer();
  assert.equal(ready(r2, rig(), "patchRT"), true);
  assert.equal(r2.compiled.length, 0);
  globalThis.location = { search: "" };
  flags._resetFarTerrainFlagsForTest();
});
t("A5 compile() throws → ready (fail-soft)", () => {
  const r3 = fakeRenderer({ throws: true });
  assert.equal(ready(r3, rig(), "patchRT"), true);
  assert.equal(r3.target, "canvas");
});

console.log(`\n${failures ? `${failures} failed` : "5 passed, 0 failed"}`);
process.exit(failures ? 1 : 0);
