// 2026-10-06 — `?cellStaticMerge` (scene3d/cell_static_merge.js): one draw per (EnvCell, material)
// for a cell's static props, with an empty anchor Group left in each prop's place.
//
// Run:
//   cd apps/holtburger-web/
//   node test_cell_static_merge.mjs

import * as THREE from "three";
import { mergeCellStatics, cellStaticMergeEnabled } from "./scene3d/cell_static_merge.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const matA = new THREE.MeshStandardMaterial({ name: "A" });
const matB = new THREE.MeshStandardMaterial({ name: "B" });
const matC = new THREE.MeshStandardMaterial({ name: "C" });

// non-indexed 2-triangle quad, single material
function quad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  return g;
}
// indexed box with two material groups (faces 0-1 -> mat 0, faces 2-5 -> mat 1)
function twoMatBox() {
  const g = new THREE.BoxGeometry(1, 2, 3);
  g.clearGroups();
  g.addGroup(0, 12, 0);
  g.addGroup(12, 24, 1);
  return g;
}
const prop = (name, geom, mat, pos, rotY, scale, extra = {}) => {
  const m = new THREE.Mesh(geom, mat);
  m.name = name;
  m.position.set(...pos);
  m.rotation.set(0, rotY, 0);
  m.scale.set(...scale);
  m.userData = { cellId: 0xa9b40147, modelId: extra.modelId ?? 0x02000001, isCellStatic: true };
  if (extra.visible === false) m.visible = false;
  return m;
};

function buildCell() {
  const c = new THREE.Group();
  c.name = "envcell-a9b40147";
  c.userData = { cellId: 0xa9b40147, isEnvCell: true };
  const meshGroup = new THREE.Group(); meshGroup.name = "mesh-a9b40147"; c.add(meshGroup);
  const sharedQuad = quad();
  c.add(prop("cellstatic-a9b40147-01000aaa", sharedQuad, matA, [1, 2, 3], 0.5, [1, 1, 1], { modelId: 0x01000aaa }));
  c.add(prop("cellstatic-a9b40147-01000aab", sharedQuad, matA, [-4, 0, 1], -1.2, [2, 2, 2], { modelId: 0x01000aab }));
  c.add(prop("cellstatic-a9b40147-02000bbb", twoMatBox(), [matB, matA], [0, 5, 0], 2.0, [1, 3, 0.5], { modelId: 0x02000bbb }));
  c.add(prop("cellstatic-a9b40147-01000ccc", quad(), matC, [9, 9, 9], 0, [1, 1, 1], { modelId: 0x01000ccc, visible: false }));
  c.updateMatrixWorld(true);
  return c;
}

const drawsOf = (c) => {
  let n = 0;
  c.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    n += Array.isArray(o.material) ? o.geometry.groups.length : 1;
  });
  return n;
};
// world-space triangles per material name, as sorted rounded strings
function trianglesByMaterial(c) {
  const out = {};
  c.updateMatrixWorld(true);
  c.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal, idx = g.index;
    const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
    const ranges = Array.isArray(o.material) ? g.groups.map((gr) => [o.material[gr.materialIndex], gr.start, gr.count]) : [[o.material, 0, idx ? idx.count : pos.count]];
    for (const [mat, start, count] of ranges) {
      const list = (out[mat.name] ||= []);
      for (let t = 0; t < count; t += 3) {
        const pts = [];
        for (let k = 0; k < 3; k++) {
          const v = idx ? idx.array[start + t + k] : start + t + k;
          const p = new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(o.matrixWorld);
          const n = new THREE.Vector3().fromBufferAttribute(nor, v).applyMatrix3(nm).normalize();
          pts.push([p.x, p.y, p.z, n.x, n.y, n.z].map((x) => x.toFixed(3)).join(","));
        }
        list.push(pts.join(" "));
      }
    }
  });
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

console.log("merge");
{
  const c = buildCell();
  let disposed = 0;
  for (const ch of c.children) if (ch.geometry) ch.geometry.addEventListener("dispose", () => { disposed++; });
  const beforeDraws = drawsOf(c);
  const beforeTris = trianglesByMaterial(c);
  const beforeStatics = c.children.filter((x) => x.userData?.isCellStatic).map((x) => [x.name, x.userData.modelId, x.position.toArray().join(","), x.quaternion.toArray().map((q) => q.toFixed(5)).join(",")]);
  const r = mergeCellStatics(THREE, c, { shadow: true, canCastShadow: (m) => m.name !== "B" });
  const afterDraws = drawsOf(c);
  const afterTris = trianglesByMaterial(c);
  check("3 visible props merged, the hidden one skipped", r.props === 3 && r.skipped === 1, JSON.stringify({ props: r.props, skipped: r.skipped }));
  check("one merged mesh per material (A, B)", r.meshes === 2 && r.geometries.length === 2);
  check("draws 4 -> 2 (the hidden prop never drew)", beforeDraws === 4 && afterDraws === 2, `${beforeDraws} -> ${afterDraws}`);
  check("identical world-space triangles + normals per material", JSON.stringify(afterTris) === JSON.stringify(beforeTris),
    Object.keys(beforeTris).map((k) => `${k}: ${beforeTris[k].length} -> ${(afterTris[k] || []).length}`).join(", "));
  const anchors = c.children.filter((x) => x.userData?.isCellStatic);
  check("light anchors: same isCellStatic children, names, modelIds, transforms",
    JSON.stringify(anchors.map((x) => [x.name, x.userData.modelId, x.position.toArray().join(","), x.quaternion.toArray().map((q) => q.toFixed(5)).join(",")])) === JSON.stringify(beforeStatics));
  check("anchors are empty Groups (no draws), the hidden prop is still its Mesh", anchors.filter((x) => x.isGroup && !x.isMesh).length === 3 && anchors.filter((x) => x.isMesh).length === 1);
  const merged = c.children.filter((x) => x.userData?.isCellStaticMerged);
  check("cast shadow follows the material predicate, receive on", merged.every((m) => m.receiveShadow) && merged.find((m) => m.material === matB).castShadow === false && merged.find((m) => m.material === matA).castShadow === true);
  check("merged geometry has bounds", merged.every((m) => m.geometry.boundingSphere && m.geometry.boundingSphere.radius > 0));
  check("source geometries (shared per DID across cells) are never disposed", disposed === 0);
  const again = mergeCellStatics(THREE, c, {});
  check("merging again is a no-op", again.props === 0 && again.meshes === 0 && drawsOf(c) === 2);
}

console.log("\nunsupported props are left alone");
{
  const c = new THREE.Group(); c.userData = { cellId: 1 };
  const g = quad(); g.setAttribute("weird", new THREE.BufferAttribute(new Float32Array(6), 1));
  c.add(prop("cellstatic-x-1", g, matA, [0, 0, 0], 0, [1, 1, 1]));
  const inst = new THREE.InstancedMesh(quad(), matA, 2); inst.userData = { isCellStatic: true }; c.add(inst);
  const r = mergeCellStatics(THREE, c, {});
  check("unknown attribute / InstancedMesh -> skipped, nothing merged", r.props === 0 && r.skipped === 2 && r.meshes === 0 && c.children.length === 2);
}

console.log("\nflag");
{
  globalThis.window = { location: { search: "" } };
  check("default OFF", cellStaticMergeEnabled() === false);
  window.location.search = "?cellStaticMerge=on";
  check("?cellStaticMerge=on", cellStaticMergeEnabled() === true);
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
