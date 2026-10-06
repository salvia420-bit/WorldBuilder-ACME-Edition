// 2026-10-06 — ?skipHiddenMatrix (scene3d/skip_hidden_matrix.js).
//
// Run:
//   cd apps/holtburger-web/
//   node test_skip_hidden_matrix.mjs

import * as THREE from "three";
import { installSkipHiddenMatrix, uninstallSkipHiddenMatrix } from "./scene3d/skip_hidden_matrix.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
check("installs", installSkipHiddenMatrix(THREE, { force: true }) === true);

const scene = new THREE.Scene();
const group = new THREE.Group(); scene.add(group);
const rig = new THREE.Group(); group.add(rig);
const part = new THREE.Group(); part.position.set(0, 1, 0); rig.add(part);
const mesh = new THREE.Mesh(); mesh.position.set(0, 0, 2); part.add(mesh);
scene.updateMatrixWorld();
const wp = () => new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).toArray().join(",");
check("visible subtree updates", wp() === "0,1,2", wp());

let calls = 0;
const proto = THREE.Object3D.prototype, inner = proto.__hbSkipHidden;
rig.visible = false;
rig.position.set(10, 0, 0);
part.rotation.set(0, Math.PI / 2, 0);
const spy = mesh.updateMatrixWorld; mesh.updateMatrixWorld = function (f) { calls++; return spy.call(this, f); };
scene.updateMatrixWorld();
check("hidden subtree is not walked", calls === 0, `calls=${calls}`);
check("hidden subtree keeps its old matrix (not drawn)", wp() === "0,1,2", wp());

rig.visible = true;
scene.updateMatrixWorld();
const v = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
check("re-shown subtree is exact on the first walk (moved + re-posed while hidden)",
  Math.abs(v.x - 12) < 1e-9 && Math.abs(v.y - 1) < 1e-9 && Math.abs(v.z) < 1e-9, v.toArray().map((x) => x.toFixed(3)).join(","));

rig.visible = false;
rig.position.set(20, 0, 0);
rig.updateMatrixWorld(true);
check("a direct updateMatrixWorld(true) on a hidden node (not a scene walk) still updates it",
  Math.abs(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).x - 22) < 1e-9);

const p = new THREE.Vector3(); rig.position.set(30, 0, 0); mesh.getWorldPosition(p);
check("getWorldPosition on a hidden node is fresh (updateWorldMatrix path)", Math.abs(p.x - 32) < 1e-9, p.x.toFixed(3));

group.visible = false; rig.visible = true; group.position.set(0, 0, 100);
scene.updateMatrixWorld();
group.visible = true; scene.updateMatrixWorld();
check("a hidden ANCESTOR re-shown recomputes its descendants",
  Math.abs(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).z - 100) < 1e-9);

uninstallSkipHiddenMatrix(THREE);
check("uninstall restores three", THREE.Object3D.prototype.updateMatrixWorld === inner);
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
