// 2026-10-19 — the scene-walk census (scene3d/skip_hidden_matrix.js
// startWalkCensus / stopWalkCensus, live `__skipHiddenMatrix.census(frames)`):
// how many nodes the per-render matrix walk visits, composes, multiplies, and
// how many multiplies are ONLY the root cascade (`forcedOnly` — the most a
// container freeze could save). Counting must not change a single matrix.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/matrix_walk_census.test.mjs

import * as THREE from "three";
import { installSkipHiddenMatrix, uninstallSkipHiddenMatrix, startWalkCensus, stopWalkCensus } from "../scene3d/skip_hidden_matrix.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

check("census refuses before the patch is installed", startWalkCensus() === false && stopWalkCensus() === null);
check("installs", installSkipHiddenMatrix(THREE, { force: true }) === true);

function build() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const group = new THREE.Group(); group.position.set(3, 0, 0); worldRoot.add(group);
  const auto = new THREE.Mesh(); auto.position.set(1, 2, 3); group.add(auto);
  const frozen = new THREE.Mesh(); frozen.position.set(0, 5, 0); frozen.updateMatrix(); group.add(frozen);
  frozen.updateWorldMatrix(true, false);
  frozen.matrixAutoUpdate = false; frozen.matrixWorldAutoUpdate = false;
  const manual = new THREE.Mesh(); manual.matrixAutoUpdate = false; manual.matrix.makeTranslation(0, 0, 7); group.add(manual);
  const hidden = new THREE.Group(); hidden.visible = false; group.add(hidden);
  const hiddenChild = new THREE.Mesh(); hidden.add(hiddenChild);
  return { scene, auto, frozen, manual, hiddenChild };
}

const a = build();
a.scene.updateMatrixWorld();
const b = build();
check("census starts", startWalkCensus() === true);
check("a second start is refused while counting", startWalkCensus() === false);
b.scene.updateMatrixWorld();
const t = stopWalkCensus();
check("one walk, rooted at the Scene", t.walks === 1, JSON.stringify(t));
check("visited: scene, worldRoot, group, 3 meshes, the hidden group (not its child)", t.visited === 7, JSON.stringify(t));
check("hidden subtree counted once and not entered", t.hidden === 1);
check("composed: the 4 matrixAutoUpdate nodes", t.composed === 4, JSON.stringify(t));
check("multiplied: the 4 composed + the manual one forced by the cascade", t.multiplied === 5, JSON.stringify(t));
check("forcedOnly: the manual mesh — recomputed purely because an ancestor forced it", t.forcedOnly === 1, JSON.stringify(t));
check("frozen: the fully frozen mesh", t.frozen === 1);
const same = (x, y) => x.matrixWorld.elements.every((v, i) => v === y.matrixWorld.elements[i]);
check("counting changes no world matrix (auto / frozen / manual)", same(a.auto, b.auto) && same(a.frozen, b.frozen) && same(a.manual, b.manual));
{
  // worldRoot R_x(-90deg) x group (3,0,0) x manual (0,0,7)  =>  world (3, 7, 0).
  const e = b.manual.matrixWorld.elements;
  check("the manual mesh still gets its world from the cascade (what a root freeze would lose)",
    Math.abs(e[12] - 3) < 1e-9 && Math.abs(e[13] - 7) < 1e-9 && Math.abs(e[14]) < 1e-9, `(${e[12]}, ${e[13]}, ${e[14]})`);
}
check("stop restores the walk (a later walk is not counted)", (() => { b.scene.updateMatrixWorld(); return stopWalkCensus() === null; })());

uninstallSkipHiddenMatrix(THREE);
check("uninstall drops the census hooks", startWalkCensus() === false);

console.log(`\nmatrix walk census: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
