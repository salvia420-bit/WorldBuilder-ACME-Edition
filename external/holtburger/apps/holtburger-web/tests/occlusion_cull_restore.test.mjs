// tests/occlusion_cull_restore.test.mjs — ?occlusionCull across a WebGL context
// loss + restore (review 2026-10-18, RENDER-3).
//
// A restore keeps the same WebGL2RenderingContext object but every WebGLQuery
// from before the loss is dead. Chrome does not throw on one: getQueryParameter
// answers null (so QUERY_RESULT_AVAILABLE never reads true) and begin/endQuery
// only raise a GL error. A proxy pending at loss time then stayed pending for
// good, and want() kept returning its frozen verdict: a rig or interior cell
// hidden at loss time stayed hidden in plain view. The mock below models that
// (dead queries answer null, never throw) and the restore fires the canvas
// listener the culler registers.
//
// Run:  cd apps/holtburger-web && node tests/occlusion_cull_restore.test.mjs

import * as THREE from "three";
import { OcclusionCuller, HIDE_AFTER } from "../scene3d/occlusion_cull.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// WebGL2 query surface with a context generation: results land one frame after
// issue; a query from an older generation is dead (Chrome semantics).
function fakeGl() {
  return {
    ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    gen: 0, active: null, created: 0,
    nextResult: () => 0,
    createQuery() { this.created++; return { gen: this.gen, result: 0, pendingFrames: 0 }; },
    deleteQuery() {},
    beginQuery(_t, q) { if (q.gen !== this.gen) return; /* INVALID_OPERATION */ this.active = q; },
    endQuery() { const q = this.active; if (!q) return; /* INVALID_OPERATION */ this.active = null; q.result = this.nextResult(); q.pendingFrames = 1; },
    getQueryParameter(q, p) {
      if (q.gen !== this.gen) return null; // object from a lost context
      if (p === this.QUERY_RESULT_AVAILABLE) return q.pendingFrames <= 0;
      if (p === this.QUERY_RESULT) return q.result;
      return null;
    },
  };
}

function setup() {
  const gl = fakeGl();
  const listeners = [];
  const canvas = {
    addEventListener(t, f) { if (t === "webglcontextrestored") listeners.push(f); },
    removeEventListener(t, f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  const renderer = { getContext: () => gl, domElement: canvas };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const occ = new OcclusionCuller(THREE, renderer, scene);
  // "Render": run the hooks of every drawn proxy, as WebGLRenderer.renderObject would.
  const render = () => {
    for (const m of occ.group.children) {
      if (!m.visible || !occ.group.visible) continue;
      m.onBeforeRender(renderer, scene, camera);
      m.onAfterRender(renderer, scene, camera);
    }
    for (const p of occ.proxies.values()) if (p.query) p.query.pendingFrames -= 1;
  };
  const restore = () => { gl.gen += 1; for (const f of [...listeners]) f({}); };
  return { gl, occ, camera, render, restore, listeners };
}

console.log("PART 1 — a proxy hidden at loss time is re-queried after the restore");
{
  const { gl, occ, camera, render, restore } = setup();
  const box = [10, -1, -1, 12, 1, 1];
  const frame = () => { occ.beginFrame(camera, true); const v = occ.want("rig", ...box); render(); return v; };
  let v = true;
  for (let f = 0; f < HIDE_AFTER + 4; f++) v = frame();
  check("occluded before the loss", v === false);
  check("a query is in flight at loss time", occ.proxies.get("rig").queryPending === true);
  restore();
  gl.nextResult = () => 1; // the occluder is gone: the box is in view now
  const after = [];
  for (let f = 0; f < 4; f++) after.push(frame());
  check("visible right after the restore (no frozen hidden verdict)", after[0] === true, after.join(","));
  check("re-queried on the new context and the result keeps it visible", after.every((x) => x === true) && gl.created === 2,
    `created=${gl.created} ${after.join(",")}`);
  check("the restore is counted", occ.stats.restores === 1);
}

console.log("PART 2 — culling still works after the restore");
{
  const { gl, occ, camera, render, restore } = setup();
  const box = [10, -1, -1, 12, 1, 1];
  const frame = () => { occ.beginFrame(camera, true); const v = occ.want("cell", ...box); render(); return v; };
  gl.nextResult = () => 1;
  for (let f = 0; f < 4; f++) frame();
  restore();
  gl.nextResult = () => 0; // now behind a wall
  let v = true;
  for (let f = 0; f < HIDE_AFTER + 4; f++) v = frame();
  check("a proxy occluded on the restored context hides again", v === false);
}

console.log("PART 3 — dispose drops the restore listener");
{
  const { occ, listeners } = setup();
  check("one listener while alive", listeners.length === 1);
  occ.dispose();
  check("none after dispose", listeners.length === 0);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
