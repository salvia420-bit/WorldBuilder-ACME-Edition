// tools/rust_parity/gen_math.mjs — three.js r184 math reference for
// crates/holtburger-scene/src/math.rs (pinned by tests/math_parity.rs).
//
// Run: node tools/rust_parity/gen_math.mjs   (writes tests/fixtures/math.json)

import * as THREE from "three";
import { f64arr, inputRng, writeFixture } from "./fixture_util.mjs";

const r = inputRng(20261026);
const rnd = (s = 10) => (r() * 2 - 1) * s;
const randQuat = () => new THREE.Quaternion(rnd(1), rnd(1), rnd(1), rnd(1)).normalize();
const N = 400;
const cases = [];
for (let i = 0; i < N; i++) {
  const p = new THREE.Vector3(rnd(500), rnd(500), rnd(50));
  const q = randQuat();
  const s = i % 3 === 0 ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3(r() * 3 + 0.1, r() * 3 + 0.1, r() * 3 + 0.1);
  const q2 = randQuat();
  const v = new THREE.Vector3(rnd(20), rnd(20), rnd(20));
  const axis = new THREE.Vector3(rnd(1), rnd(1), rnd(1)).normalize();
  const angle = rnd(7);
  const eul = [rnd(4), rnd(4), rnd(4)];

  const m = new THREE.Matrix4().compose(p, q, s);
  const m2 = new THREE.Matrix4().compose(v, q2, new THREE.Vector3(1, 1, 1));
  const mm = new THREE.Matrix4().multiplyMatrices(m, m2);
  const inv = m.clone().invert();
  const dp = new THREE.Vector3(), dq = new THREE.Quaternion(), ds = new THREE.Vector3();
  m.decompose(dp, dq, ds);
  const qq = q.clone().multiply(q2);
  const qn = new THREE.Quaternion(rnd(3), rnd(3), rnd(3), rnd(3));
  const qnIn = [qn.x, qn.y, qn.z, qn.w];
  qn.normalize();
  const vq = v.clone().applyQuaternion(q);
  const vm = v.clone().applyMatrix4(m);
  const qa = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const qe = new THREE.Quaternion().setFromEuler(new THREE.Euler(eul[0], eul[1], eul[2], "YXZ"));
  const qx = new THREE.Quaternion().setFromEuler(new THREE.Euler(eul[0], eul[1], eul[2], "XYZ"));
  const vn = v.clone().normalize();

  cases.push({
    p: f64arr([p.x, p.y, p.z]), q: f64arr([q.x, q.y, q.z, q.w]), s: f64arr([s.x, s.y, s.z]),
    q2: f64arr([q2.x, q2.y, q2.z, q2.w]), v: f64arr([v.x, v.y, v.z]),
    axis: f64arr([axis.x, axis.y, axis.z]), angle: f64arr([angle])[0], eul: f64arr(eul),
    qnIn: f64arr(qnIn),
    compose: f64arr(m.elements), compose2: f64arr(m2.elements), mul: f64arr(mm.elements), invert: f64arr(inv.elements),
    det: f64arr([m.determinant()])[0],
    decompose: f64arr([dp.x, dp.y, dp.z, dq.x, dq.y, dq.z, dq.w, ds.x, ds.y, ds.z]),
    qmul: f64arr([qq.x, qq.y, qq.z, qq.w]), qnorm: f64arr([qn.x, qn.y, qn.z, qn.w]),
    applyQuat: f64arr([vq.x, vq.y, vq.z]), applyMat4: f64arr([vm.x, vm.y, vm.z]),
    axisAngle: f64arr([qa.x, qa.y, qa.z, qa.w]), eulerYXZ: f64arr([qe.x, qe.y, qe.z, qe.w]),
    eulerXYZ: f64arr([qx.x, qx.y, qx.z, qx.w]), vnorm: f64arr([vn.x, vn.y, vn.z]),
    maxScale: f64arr([m.getMaxScaleOnAxis()])[0],
  });
}
const path = writeFixture("math", { three: THREE.REVISION, cases });
console.log(`wrote ${cases.length} cases → ${path}`);
