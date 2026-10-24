// tests/in_place_exact.test.mjs — ?inPlaceExact (2026-10-24): poseRigAt plays a
// clip in place by undoing EXACTLY the root frame the wasm bake folded into its
// parts (EntityAnimationData.rootFrames), instead of subtracting the mean of all
// parts (which also removed the authored body bob and floated the planted foot).
// Also pins the ?inPlaceLinks locomotion-link classifier.
//
// Run from apps/holtburger-web/:  node tests/in_place_exact.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { poseRigAt, _setInPlaceExactForTest } = await import("../scene3d/motion/motion_sequence.js");

// Minimal THREE-like part group.
const group = () => ({
  position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
});

// Hamilton product + rotation, w-first — the same as holtburger_common::Quaternion.
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qrot = (q, v) => {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
};
const yaw = (rad) => [Math.cos(rad / 2), 0, 0, Math.sin(rad / 2)];

// Raw per-part frames (an authored pose with a vertical bob) and a root motion
// that strides forward (and, in the second test, turns) — folded the way
// lib.rs fold_root_motion_into_parts does: p' = R·p + T, q' = R·q.
function makeClip({ turn }) {
  const numFrames = 8, partCount = 3;
  const raw = [], partFrames = new Float32Array(numFrames * partCount * 7), rootFrames = new Float32Array(numFrames * 7);
  for (let f = 0; f < numFrames; f += 1) {
    const bob = 0.1 * Math.sin((f / numFrames) * 2 * Math.PI);
    const T = [0.01 * f, 0.1333 * (f + 1), 0.0];
    const R = turn ? yaw(0.2 * (f + 1)) : [1, 0, 0, 0];
    rootFrames.set([T[0], T[1], T[2], R[0], R[1], R[2], R[3]], f * 7);
    for (let p = 0; p < partCount; p += 1) {
      const pos = [0.1 * p, 0.05 * p, 0.9 - 0.4 * p + bob];
      const q = yaw(0.1 * p + 0.01 * f);
      raw.push({ pos, q });
      const fp = qrot(R, pos), fq = qmul(R, q);
      partFrames.set([fp[0] + T[0], fp[1] + T[1], fp[2] + T[2], fq[0], fq[1], fq[2], fq[3]], (f * partCount + p) * 7);
    }
  }
  return { desc: { partFrames, partCount, numFrames, posFrames: new Float32Array(numFrames * 3), rootFrames }, raw, partCount, numFrames };
}

function checkRecovers(turn) {
  _setInPlaceExactForTest(true);
  const { desc, raw, partCount, numFrames } = makeClip({ turn });
  const parts = Array.from({ length: partCount }, group);
  for (let f = 0; f < numFrames; f += 1) {
    poseRigAt(f, desc, parts, true);
    for (let p = 0; p < partCount; p += 1) {
      const want = raw[f * partCount + p], g = parts[p];
      for (const [k, i] of [["x", 0], ["y", 1], ["z", 2]]) {
        assert.ok(Math.abs(g.position[k] - want.pos[i]) < 1e-5, `f${f} p${p} pos.${k} ${g.position[k]} vs ${want.pos[i]}`);
      }
      // q and -q are the same rotation.
      const dot = g.quaternion.w * want.q[0] + g.quaternion.x * want.q[1] + g.quaternion.y * want.q[2] + g.quaternion.z * want.q[3];
      assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-5, `f${f} p${p} quat dot ${dot}`);
    }
  }
}

test("in place undoes a pure translation root frame exactly (the authored bob survives)", () => {
  checkRecovers(false);
});

test("in place undoes a turning root frame (R⁻¹·(p − T), R⁻¹·q)", () => {
  checkRecovers(true);
});

test("raw posing (inPlace=false) still draws the folded frames", () => {
  _setInPlaceExactForTest(true);
  const { desc, partCount } = makeClip({ turn: false });
  const parts = Array.from({ length: partCount }, group);
  poseRigAt(3, desc, parts, false);
  const base = (3 * partCount + 1) * 7;
  assert.ok(Math.abs(parts[1].position.y - desc.partFrames[base + 1]) < 1e-6);
});

test("without rootFrames (older wasm) or with ?inPlaceExact=off the mean-drift fallback runs", () => {
  const { desc, partCount } = makeClip({ turn: false });
  const noRoot = { ...desc, rootFrames: null };
  const a = Array.from({ length: partCount }, group);
  _setInPlaceExactForTest(true);
  poseRigAt(4, noRoot, a, true);
  const b = Array.from({ length: partCount }, group);
  _setInPlaceExactForTest(false);
  poseRigAt(4, desc, b, true);
  for (let p = 0; p < partCount; p += 1) {
    assert.ok(Math.abs(a[p].position.y - b[p].position.y) < 1e-6, "both arms take the same legacy path");
  }
  _setInPlaceExactForTest(true);
});

test("isLocomotionLink: start/stop/gait/turn/fall links yes, actions no", async () => {
  globalThis.window ??= {};
  globalThis.window.location ??= { search: "" };
  const { isLocomotionLink } = await import("../scene3d/entities.js");
  assert.equal(isLocomotionLink(0x41000003, 0x44000007), true, "Ready -> Run");
  assert.equal(isLocomotionLink(0x44000007, 0x41000003), true, "Run -> Ready");
  assert.equal(isLocomotionLink(0x45000005, 0x44000007), true, "Walk -> Run");
  assert.equal(isLocomotionLink(0x44000007, 0x40000015), true, "Run -> Falling");
  assert.equal(isLocomotionLink(0, 0x41000003), true, "spawn -> Ready");
  assert.equal(isLocomotionLink(0x41000003, 0x1000005b), false, "Ready -> SlashHigh");
  assert.equal(isLocomotionLink(0x41000003, 0x40000011), false, "Ready -> Dead");
});
