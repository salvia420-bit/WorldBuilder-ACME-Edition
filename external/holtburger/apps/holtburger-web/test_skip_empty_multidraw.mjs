// 2026-10-07 — ?skipEmptyMultiDraw (scene3d/skip_empty_multidraw.js).
//
// Run:
//   cd apps/holtburger-web/
//   node test_skip_empty_multidraw.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  installSkipEmptyMultiDraw, uninstallSkipEmptyMultiDraw,
  getSkipEmptyMultiDrawStats, __setSkipEmptyMultiDrawOffForTest,
} from "./scene3d/skip_empty_multidraw.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// --- the premise, anchored in three's source ----------------------------------
// An empty multidraw must already be a GL no-op in three, or skipping it would
// change the frame. Both BatchedMesh branches of renderBufferDirect loop/draw
// over `_multiDrawCount`, and renderMultiDraw returns on 0 before touching GL.
{
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("three").replace(/[^/\\]+$/, "") + "three.module.js", "utf8");
  const rmd = src.indexOf("function renderMultiDraw( starts, counts, drawCount ) {");
  check("premise: renderMultiDraw returns on drawCount === 0 before any GL call",
    rmd > 0 && /^\s*if \( drawCount === 0 \) return;/.test(src.slice(rmd + 56, rmd + 120)));
  const br = src.indexOf("if ( object.isBatchedMesh ) {", src.indexOf("this.renderBufferDirect = function"));
  const body = src.slice(br, br + 900);
  check("premise: the no-multi_draw fallback loops `drawCount = object._multiDrawCount` times",
    body.includes("const drawCount = object._multiDrawCount;") && body.includes("for ( let i = 0; i < drawCount; i ++ )"));
  check("premise: the multi_draw path passes `object._multiDrawCount`",
    body.includes("renderer.renderMultiDraw( object._multiDrawStarts, object._multiDrawCounts, object._multiDrawCount );"));
}

// --- the wrapper ----------------------------------------------------------------
const seen = [];
const renderer = {
  renderBufferDirect(camera, scene, geometry, material, object, group) { seen.push(object.name); },
};
check("installs", installSkipEmptyMultiDraw(renderer, { force: true }) === true);
check("idempotent", installSkipEmptyMultiDraw(renderer, { force: true }) === true);

const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
const bm = new THREE.BatchedMesh(4, 3, 0, new THREE.MeshBasicMaterial());
bm.name = "batch";
const gid = bm.addGeometry(geo);
bm.addInstance(gid);
bm.updateMatrixWorld(true);
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
const away = cam.clone(); away.position.set(0, 0, -50); away.lookAt(0, 0, -100); away.updateMatrixWorld(true);
away.matrixWorldInverse.copy(away.matrixWorld).invert();
const plain = new THREE.Mesh(geo, new THREE.MeshBasicMaterial()); plain.name = "plain";
const draw = (o, c) => {
  if (o.isBatchedMesh) o.onBeforeRender(null, null, c, o.geometry, o.material, null);
  renderer.renderBufferDirect(c, null, o.geometry, o.material, o, null);
};

seen.length = 0;
draw(bm, cam);
check("a batch with drawn instances reaches three", seen.join() === "batch" && bm._multiDrawCount === 1);
seen.length = 0;
const s0 = getSkipEmptyMultiDrawStats().skipped;
draw(bm, away);
check("a batch whose rebuild culled everything is skipped", seen.length === 0 && bm._multiDrawCount === 0
  && getSkipEmptyMultiDrawStats().skipped === s0 + 1);
seen.length = 0;
draw(plain, away);
check("non-batched objects always reach three", seen.join() === "plain");
__setSkipEmptyMultiDrawOffForTest(true);
seen.length = 0;
draw(bm, away);
check("seam off: the empty batch reaches three again", seen.join() === "batch");
__setSkipEmptyMultiDrawOffForTest(false);
seen.length = 0;
draw(bm, cam);
check("back on: a batch that regains instances draws", seen.join() === "batch" && bm._multiDrawCount === 1);

const inner = renderer.__hbSkipEmptyMultiDraw;
uninstallSkipEmptyMultiDraw(renderer);
check("uninstall restores the wrapped method", renderer.renderBufferDirect === inner);
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
