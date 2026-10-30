// tools/rust_parity/gen_rig.mjs — the REAL `poseRigAt`
// (scene3d/motion/motion_sequence.js, flag-off JS body) followed by three r184
// `Object3D.updateMatrix` on every posed part, recorded for
// crates/holtburger-scene/src/rig.rs (pinned by tests/rig_parity.rs).
//
// Run: node tools/rust_parity/gen_rig.mjs   (writes tests/fixtures/rig.json)
//
// Inputs are rig-shaped: the bake's fold (part = R·local + T, quat = R ⊗ q,
// stored as f32 like EntityAnimationData.partFrames), root rows with stride,
// turn, full tumble, identity and near-threshold (|v| ≈ 1e-7) rotations, every
// posFrames shape poseRigAt meets (cumulative, all-zero, absent, null, empty →
// NaN, short → NaN past its end), a rootFrames of the wrong length (→ mean
// drift), signed zeros, and part arrays shorter than, equal to and longer than
// partCount with null holes. All three branches run: raw, in place by mean
// drift (`?inPlaceExact=off`), in place exact.
//
// `buildRigDescriptors` / `buildPoseCalls` / `clampFrame` / `poseMode` are
// shared with tests/rust_rig_parity.test.mjs (same cases through the bridge).

import * as THREE from "three";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { f64arr, f32arr, inputRng, writeFixture } from "./fixture_util.mjs";
import { poseRigAt, _setInPlaceExactForTest, _setRustRigForTest } from "../../scene3d/motion/motion_sequence.js";

export const OUT_STRIDE = 16;

const SPECS = [
  { name: "single-part-1f", pc: 1, nf: 1, root: "identity", pos: "cumulative" },
  { name: "door-2p-hinge", pc: 2, nf: 5, root: "none", pos: "absent" },
  { name: "creature-7p-turn", pc: 7, nf: 16, root: "turn", pos: "cumulative" },
  { name: "human-17p-run", pc: 17, nf: 33, root: "stride", pos: "cumulative" },
  { name: "human-17p-identity-root", pc: 17, nf: 12, root: "identity", pos: "zero" },
  { name: "human-34p-threshold", pc: 34, nf: 12, root: "threshold", pos: "cumulative" },
  { name: "creature-25p-wrong-root-len", pc: 25, nf: 8, root: "wrongLength", pos: "empty" },
  { name: "creature-9p-short-pos", pc: 9, nf: 10, root: "turn", pos: "short" },
  { name: "drone-gesture-17p", pc: 17, nf: 20, root: "none", pos: "null" },
  { name: "big-34p-tumble", pc: 34, nf: 33, root: "tumble", pos: "cumulative" },
  { name: "signed-zero-3p", pc: 3, nf: 4, root: "identity", pos: "absent", signedZero: true },
];

// Inverse-root vector parts straddling poseInPlaceExact's |x| < 1e-7 test
// (stored f32: f32(1e-7) = 1.0000000116860974e-7 is NOT below the f64 1e-7).
const THRESHOLD_ROWS = [
  [0, 0, 0], [9e-8, 0, 0], [1e-7, 0, 0], [0, -9.9e-8, 5e-8], [0, 0, 1.2e-7],
  [-1e-7, 0, 0], [5e-8, -5e-8, 9.99e-8], [0, 2e-7, 0], [0, 0, -0],
];

function randUnitQuat(rnd) {
  const q = new THREE.Quaternion(rnd(1), rnd(1), rnd(1), rnd(1));
  if (q.lengthSq() < 1e-6) q.set(0, 0, 0, 1);
  return q.normalize();
}

/**
 * Rig-shaped sequence descriptors (the animation.js buildSequenceDescriptor
 * shape poseRigAt reads). Deterministic for a seed.
 * @returns {Array<{name: string, desc: object, posKind: string, rootKind: string}>}
 */
export function buildRigDescriptors(seed = 20261026) {
  const r = inputRng(seed);
  const rnd = (s = 1) => (r() * 2 - 1) * s;
  const out = [];
  for (const spec of SPECS) {
    const { pc, nf } = spec;
    // Skeleton: per part a rest offset (a body ~1.8 m tall) and orientation.
    const base = [];
    for (let p = 0; p < pc; p += 1) {
      const q = randUnitQuat(rnd);
      if (p % 3 === 1) q.set(-q.x, -q.y, -q.z, -q.w); // w < 0 rows too
      base.push({ x: rnd(0.4), y: rnd(0.4), z: 0.1 + r() * 1.7, q });
    }
    // Root frames: cumulative translation T_f and rotation R_f (w-first rows).
    const roots = [];
    let tx = 0, ty = 0, tz = 0, yaw = 0;
    for (let f = 0; f < nf; f += 1) {
      let R = new THREE.Quaternion();
      if (spec.root === "stride") {
        ty += 0.03 + r() * 0.2; tx += rnd(0.01);
        R.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd(0.05));
      } else if (spec.root === "turn") {
        ty += 0.05; yaw += 0.1 + rnd(0.02);
        R.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
      } else if (spec.root === "tumble") {
        tx += rnd(0.3); ty += rnd(0.3); tz += rnd(0.1);
        R = randUnitQuat(rnd);
      } else if (spec.root === "threshold") {
        ty += 0.04;
        const v = THRESHOLD_ROWS[f % THRESHOLD_ROWS.length];
        // Root quaternion with vector part -v (the poser negates it).
        R.set(-v[0], -v[1], -v[2], Math.sqrt(1 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2])));
      } else if (spec.root === "identity") {
        ty += 0.02 * f;
      }
      roots.push({ t: new THREE.Vector3(tx, ty, tz), R });
    }
    const partFrames = new Float32Array(nf * pc * 7);
    for (let f = 0; f < nf; f += 1) {
      const { t, R } = roots[f];
      for (let p = 0; p < pc; p += 1) {
        const b = base[p];
        const wob = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(rnd(1), rnd(1), rnd(1)).normalize(), rnd(0.3));
        const ql = b.q.clone().multiply(wob);
        const pl = new THREE.Vector3(b.x + rnd(0.04), b.y + rnd(0.04), b.z + rnd(0.04));
        let pw = pl;
        let qw = ql;
        if (spec.root !== "none") {
          pw = pl.clone().applyQuaternion(R).add(t);
          qw = R.clone().multiply(ql);
        }
        const o = (f * pc + p) * 7;
        partFrames[o] = pw.x; partFrames[o + 1] = pw.y; partFrames[o + 2] = pw.z;
        partFrames[o + 3] = qw.w; partFrames[o + 4] = qw.x; partFrames[o + 5] = qw.y; partFrames[o + 6] = qw.z;
      }
    }
    if (spec.signedZero) {
      for (let f = 0; f < nf; f += 1) {
        const o = f * pc * 7;
        partFrames[o] = -0; partFrames[o + 1] = 0; partFrames[o + 2] = -0;
        partFrames[o + 4] = -0; partFrames[o + 5] = -0; partFrames[o + 6] = 0;
        partFrames[o + 3] = 1;
      }
    }
    let rootFrames = null;
    if (spec.root !== "none") {
      const rows = spec.root === "wrongLength" ? nf - 1 : nf;
      rootFrames = new Float32Array(rows * 7);
      for (let f = 0; f < rows; f += 1) {
        const { t, R } = roots[f];
        rootFrames.set([t.x, t.y, t.z, R.w, R.x, R.y, R.z], f * 7);
      }
      if (spec.root === "identity") {
        for (let f = 0; f < rows; f += 1) rootFrames.set([1, 0, 0, 0], f * 7 + 3);
      }
    }
    let posFrames;
    let sx = 0, sy = 0;
    const cumulative = (len) => {
      const a = new Float32Array(len);
      for (let i = 0; i < len; i += 3) {
        sx += rnd(0.02); sy += 0.05 + r() * 0.1;
        a[i] = sx;
        if (i + 1 < len) a[i + 1] = sy;
        if (i + 2 < len) a[i + 2] = rnd(0.01);
      }
      return a;
    };
    switch (spec.pos) {
      case "cumulative": posFrames = cumulative(nf * 3); break;
      case "zero": posFrames = new Float32Array(nf * 3); break;
      case "null": posFrames = null; break;
      case "empty": posFrames = new Float32Array(0); break;
      case "short": posFrames = cumulative(nf * 3 - 4); break;
      default: posFrames = undefined; // "absent": no property at all
    }
    const desc = { partCount: pc, numFrames: nf, framerate: 30, partFrames, rootFrames, duration: nf / 30 };
    if (spec.pos !== "absent") desc.posFrames = posFrames;
    out.push({ name: spec.name, desc, posKind: spec.pos, rootKind: spec.root });
  }
  return out;
}

/** poseRigAt's frame: `globalFrame | 0`, clamped to [0, numFrames). */
export function clampFrame(globalFrame, numFrames) {
  let f = globalFrame | 0;
  if (f < 0) f = 0;
  if (numFrames && f >= numFrames) f = numFrames - 1;
  return f;
}

/** The kernel mode the bridge picks (node: RENDER_ROOT_MOTION is off). */
export function poseMode(inPlace, exact) {
  return inPlace ? (exact ? 2 : 1) : 0;
}

/**
 * Pose calls over `descs`: frames at both ends, inside and out of range
 * (incl. fractional and int32-wrapping), every branch, part arrays shorter /
 * equal / longer than partCount, with null holes.
 * @returns {Array<{desc: number, globalFrame: number, inPlace: boolean, exact: boolean, nParts: number, holes: number[]}>}
 */
export function buildPoseCalls(descs, seed = 7) {
  const r = inputRng(seed);
  const calls = [];
  const MODES = [[false, true], [true, true], [true, false]];
  descs.forEach(({ desc }, di) => {
    const nf = desc.numFrames;
    const pc = desc.partCount;
    const frames = [0, nf - 1, Math.floor(r() * nf), nf + 3, -2, 2.9, 2 ** 31 + 5];
    let k = 0;
    for (const g of frames) {
      for (const [inPlace, exact] of MODES) {
        // Cycle the part-array layouts; keep the fixture under ~1.5 MB.
        if ((k + di) % 2 === 1 && g !== 0 && g !== nf - 1) { k += 1; continue; }
        const layout = (k + di) % 4;
        let nParts = pc;
        const holes = [];
        if (layout === 1) nParts = Math.max(1, pc - 2);
        else if (layout === 2) nParts = pc + 3;
        else if (layout === 3 && pc > 2) { holes.push(1); if (pc > 5) holes.push(pc - 2); }
        calls.push({ desc: di, globalFrame: g, inPlace, exact, nParts, holes });
        k += 1;
      }
    }
  });
  return calls;
}

/** Fresh rig parts (THREE.Group under a root), `null` at the holes. */
export function makeParts(nParts, holes, root = null) {
  const parts = [];
  for (let i = 0; i < nParts; i += 1) {
    if (holes.includes(i)) { parts.push(null); continue; }
    const g = new THREE.Group();
    g.name = `part_${i}`;
    if (root) root.add(g);
    parts.push(g);
  }
  return parts;
}

/** The 16 kernel outputs of a posed part, read off the three.js object. */
export function partOutputs(g) {
  const e = g.matrix.elements;
  const q = g.quaternion;
  return [g.position.x, g.position.y, g.position.z, q.x, q.y, q.z, q.w,
    e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}

function main() {
  _setRustRigForTest(false); // the JS reference body, whatever the flag says
  const descs = buildRigDescriptors();
  const calls = buildPoseCalls(descs);
  const poses = [];
  for (const call of calls) {
    const { desc } = descs[call.desc];
    _setInPlaceExactForTest(call.exact);
    const parts = makeParts(call.nParts, call.holes);
    poseRigAt(call.globalFrame, desc, parts, call.inPlace);
    const n = Math.min(desc.partCount, parts.length);
    const rec = [];
    for (let p = 0; p < n; p += 1) {
      const g = parts[p];
      if (!g) continue;
      g.updateMatrix();
      const e = g.matrix.elements;
      // compose's fixed entries — the kernel output leaves them out.
      if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1 ||
          !Object.is(e[12], g.position.x) || !Object.is(e[13], g.position.y) || !Object.is(e[14], g.position.z)) {
        throw new Error(`compose layout assumption broken at ${descs[call.desc].name} part ${p}`);
      }
      rec.push([p, f64arr(partOutputs(g))]);
    }
    poses.push({
      desc: call.desc,
      frame: clampFrame(call.globalFrame, desc.numFrames),
      mode: poseMode(call.inPlace, call.exact),
      n,
      globalFrame: call.globalFrame,
      inPlace: call.inPlace,
      exact: call.exact,
      parts: rec,
    });
  }
  _setInPlaceExactForTest(true);
  const fx = {
    three: THREE.REVISION,
    outStride: OUT_STRIDE,
    descs: descs.map(({ name, desc, posKind, rootKind }) => ({
      name, posKind, rootKind,
      partCount: desc.partCount,
      numFrames: desc.numFrames,
      partFrames: f32arr(desc.partFrames),
      posFrames: desc.posFrames ? f32arr(desc.posFrames) : null,
      rootFrames: desc.rootFrames ? f32arr(desc.rootFrames) : null,
    })),
    poses,
  };
  const path = writeFixture("rig", fx);
  const nParts = poses.reduce((a, p) => a + p.parts.length, 0);
  console.log(`wrote ${descs.length} descriptors, ${poses.length} poses, ${nParts} posed parts → ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
