// projectile_align_path.test.mjs — OpenAC comparison 2026-10-04, combat M-2b.
//
// An ALIGN_PATH missile faces its velocity every frame (retail
// `Frame::set_vector_heading` in `UpdatePhysicsInternal`), so an arrow on a
// gravity arc noses over. Drives the REAL `_alignToVelocity` body, lifted out
// of scene3d/entities.js by brace matching (the full module needs three.js +
// wasm): the rotated AC-forward axis (+Y) must equal the velocity direction.
//
// Run: node tests/projectile_align_path.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
function methodSource(name) {
  const start = SRC.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `method ${name} not found`);
  const i = SRC.indexOf("{", SRC.indexOf(")", start));
  let depth = 0;
  for (let j = i; j < SRC.length; j += 1) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start + 1, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const Harness = new Function(`return class { ${methodSource("_alignToVelocity")} };`)();

// Minimal quaternion holder with three's (x, y, z, w) set().
function rig() {
  const q = { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } };
  return { root: { quaternion: q } };
}
function rotate({ x, y, z, w }, [vx, vy, vz]) {
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w - iw * x - iy * z + iz * y, iy * w - iw * y - iz * x + ix * z, iz * w - iw * z - ix * y + iy * x];
}

test("forward (+Y) follows the velocity, including the climb angle", () => {
  const h = new Harness();
  for (const v of [[3, 4, -2], [0, 10, 5], [-7, 1, 0], [0, -5, -5]]) {
    const inst = rig();
    h._alignToVelocity(inst, { vx: v[0], vy: v[1], vz: v[2] });
    const f = rotate(inst.root.quaternion, [0, 1, 0]);
    const n = Math.hypot(...v);
    for (let k = 0; k < 3; k += 1) assert.ok(Math.abs(f[k] - v[k] / n) < 1e-6, `${v} → ${f}`);
    const q = inst.root.quaternion;
    assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9, "unit quaternion");
  }
});

test("a zero velocity leaves the orientation alone", () => {
  const h = new Harness();
  const inst = rig();
  inst.root.quaternion.set(0.1, 0.2, 0.3, 0.927);
  h._alignToVelocity(inst, { vx: 0, vy: 0, vz: 0 });
  assert.equal(inst.root.quaternion.x, 0.1);
});
