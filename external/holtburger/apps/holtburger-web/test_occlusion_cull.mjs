// 2026-10-06 — ?occlusionCull (scene3d/occlusion_cull.js): GPU occlusion
// queries for outdoor-visible interior cells and entity rigs.
//
// Run:
//   cd apps/holtburger-web/
//   node test_occlusion_cull.mjs

import * as THREE from "three";
import {
  OcclusionCuller,
  stepProxyState,
  HIDE_AFTER,
  HIDE_AFTER_MAX,
  FLIP_WINDOW_FRAMES,
  NEAR_GUARD_M,
} from "./scene3d/occlusion_cull.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// Fake WebGL2 query surface: results become available one frame after issue
// (WebGL never resolves inside the issuing frame); `nextResult` decides them.
function fakeGl() {
  const gl = {
    ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    active: null,
    created: 0,
    deleted: 0,
    nextResult: () => 1,
    createQuery() { this.created++; return { avail: false, result: 0 }; },
    deleteQuery() { this.deleted++; },
    beginQuery(_t, q) { if (this.active) throw new Error("nested query"); this.active = q; q.avail = false; },
    endQuery() { const q = this.active; this.active = null; q.result = this.nextResult(q); q.pendingFrames = 1; },
    getQueryParameter(q, p) {
      if (p === this.QUERY_RESULT_AVAILABLE) return q.pendingFrames <= 0;
      if (p === this.QUERY_RESULT) return q.result;
      return 0;
    },
    tick() { /* called between frames */ },
  };
  return gl;
}

function setup() {
  const gl = fakeGl();
  const renderer = { getContext: () => gl };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const occ = new OcclusionCuller(THREE, renderer, scene);
  // "Render": every visible proxy mesh in the culler group gets its hooks run,
  // exactly as WebGLRenderer.renderObject would for the world pass.
  const render = () => {
    for (const m of occ.group.children) {
      if (!m.visible || !occ.group.visible) continue;
      m.onBeforeRender(renderer, scene, camera);
      m.onAfterRender(renderer, scene, camera);
    }
    for (const p of occ.proxies.values()) if (p.query) p.query.pendingFrames = (p.query.pendingFrames ?? 0) - 1;
  };
  return { gl, renderer, scene, camera, occ, render };
}

console.log("PART 1 — state machine");
{
  const st = { visible: true, occludedRun: 0 };
  for (let i = 1; i < HIDE_AFTER; i++) stepProxyState(st, false);
  check(`stays visible for ${HIDE_AFTER - 1} occluded results`, st.visible === true);
  stepProxyState(st, false);
  check(`hidden after ${HIDE_AFTER} consecutive occluded results`, st.visible === false);
  stepProxyState(st, true);
  check("one visible result shows it again", st.visible === true && st.occludedRun === 0);
  stepProxyState(st, false); stepProxyState(st, true); stepProxyState(st, false);
  check("an interrupted run does not hide", st.visible === true);
}
{
  // Flip damping: a proxy that keeps re-revealing (grazing an edge while the
  // camera moves) waits longer before hiding again; a quiet one starts over.
  const st = { visible: true, occludedRun: 0, hideAfter: HIDE_AFTER, lastReveal: -Infinity };
  const hideRun = (f) => { let n = 0; while (st.visible && n < 100) { stepProxyState(st, false, f); n++; } return n; };
  check(`first hide still takes ${HIDE_AFTER} results`, hideRun(10) === HIDE_AFTER);
  stepProxyState(st, true, 20); // first reveal: long after "the last" ⇒ no damping
  check("a first reveal keeps the base delay", st.hideAfter === HIDE_AFTER);
  hideRun(22);
  stepProxyState(st, true, 30); // re-revealed 10 frames later ⇒ doubled
  check("a quick re-reveal doubles the hide delay", st.hideAfter === HIDE_AFTER * 2 && hideRun(31) === HIDE_AFTER * 2);
  for (let f = 40; f < 400; f += 10) { stepProxyState(st, true, f); hideRun(f + 1); }
  check(`a flapping proxy is capped at ${HIDE_AFTER_MAX}`, st.hideAfter === HIDE_AFTER_MAX);
  stepProxyState(st, true, 400 + FLIP_WINDOW_FRAMES + 1);
  check("a reveal after a quiet spell starts over at the base delay", st.hideAfter === HIDE_AFTER);
}

console.log("PART 2 — query lifecycle");
{
  const { gl, occ, camera, render } = setup();
  gl.nextResult = () => 0; // always occluded
  const box = [10, -1, -1, 12, 1, 1];
  let vis = [];
  for (let f = 0; f < 8; f++) {
    occ.beginFrame(camera, true);
    vis.push(occ.want(7, ...box));
    render();
  }
  check("starts visible (unknown = draw)", vis[0] === true);
  check("hidden once enough occluded results resolve", vis[vis.length - 1] === false, vis.join(","));
  check("one query object reused", gl.created === 1, `created=${gl.created}`);
  gl.nextResult = () => 1;
  occ.beginFrame(camera, true); occ.want(7, ...box); render();
  occ.beginFrame(camera, true);
  check("a passing query shows it on the next frame", occ.want(7, ...box) === true);
}

console.log("PART 3 — guards");
{
  const { gl, occ, camera, render } = setup();
  gl.nextResult = () => 0;
  // Camera (0,0,100) inside a box that spans it.
  const around = [-5, -5, 95, 5, 5, 105];
  let v = true;
  for (let f = 0; f < 8; f++) { occ.beginFrame(camera, true); v = occ.want("cam", ...around) && v; render(); }
  check("camera inside the box ⇒ always visible", v === true);
  const near = [-5, -5, 100 + NEAR_GUARD_M * 0.5, 5, 5, 110];
  occ.beginFrame(camera, true);
  check("camera within NEAR_GUARD_M ⇒ visible", occ.want("near", ...near) === true);
  check("guarded proxies issue no query", gl.created === 0, `created=${gl.created}`);

  // Disarmed: everything visible, nothing drawn.
  occ.beginFrame(camera, false);
  check("disarmed ⇒ want() is true", occ.want("x", 10, 10, 10, 11, 11, 11) === true);
  check("disarmed ⇒ proxy group not drawn", occ.group.visible === false);
}

console.log("PART 4 — re-arm invalidates verdicts; retirement");
{
  const { gl, occ, camera, render } = setup();
  gl.nextResult = () => 0;
  const box = [10, -1, -1, 12, 1, 1];
  for (let f = 0; f < 8; f++) { occ.beginFrame(camera, true); occ.want(1, ...box); render(); }
  check("hidden while armed", occ.want(1, ...box) === false);
  occ.beginFrame(camera, false);
  occ.beginFrame(camera, true);
  check("re-arming starts every proxy visible again", occ.want(1, ...box) === true);
  for (let f = 0; f < 40; f++) { occ.beginFrame(camera, true); render(); }
  check("a proxy not wanted for 30+ frames is retired", !occ.proxies.has(1) && gl.deleted >= 1);
  check("its mesh left the proxy group", occ.group.children.length === 0);
}

console.log("PART 5 — proxy box placement");
{
  const { occ, camera } = setup();
  occ.beginFrame(camera, true);
  occ.want("b", 2, 4, 6, 4, 8, 12);
  const m = occ.proxies.get("b").mesh;
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m.matrixWorld.decompose(pos, q, sc);
  check("centred on the AABB", pos.equals(new THREE.Vector3(3, 6, 9)), pos.toArray().join(","));
  check("scaled to the AABB", sc.equals(new THREE.Vector3(2, 4, 6)), sc.toArray().join(","));
  check("never a raycast target", (() => { const hits = []; m.raycast(new THREE.Raycaster(), hits); return hits.length === 0; })());
  check("never a shadow caster", m.castShadow === false);
  check("proxy material writes no colour or depth", occ.material.colorWrite === false && occ.material.depthWrite === false);
  check("drawn after every opaque (transparent list)", occ.material.transparent === true && occ.material.forceSinglePass === true);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
