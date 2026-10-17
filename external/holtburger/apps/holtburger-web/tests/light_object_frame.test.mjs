// ?lightObjectFrame (scene3d/lighting.js, DEFAULT ON, `=off` escape) — a
// Setup's LightInfo lives in the OBJECT frame (retail CPartArray::SetFrame →
// LIGHTLIST::set_frame, acclient.c:325029; Frame::combine(object, offset),
// :380601), not on the part whose index equals the LightInfo key.
//
// The defect it fixes: every portal's light was parented under part 0, which
// the Setup poses 1.415 m up and the portal MotionTable spins 360° every 4 s —
// so the purple light sat 3.7 m up and orbited a 2.3 m circle through the
// ground, freezing at a random phase beyond the 120 m animation gate.
//
//   A  an entity's lights hang off the rig ROOT at the LightInfo offset; a
//      spinning / posed part 0 no longer moves them
//   B  every light of a multi-light Setup is attached (the key is no filter)
//   C  a scaled root: the light keeps the unscaled offset, and a SECOND entity
//      of the same Setup (template-built light) is placed right too
//   D  `opts.entities` lights just the given rigs (the spawn hook) and is
//      idempotent with the full rescan; a no-light Setup is not asked twice
//   E  `?lightObjectFrame=off` restores the per-part parenting
//   F  the flag reader
import * as THREE from "three";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const L = await import("../scene3d/lighting.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass += 1;
  else { fail += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

const PURPLE = 0x020001b3, TWO = 0x02000999, DARK = 0x02000998;
// The purple portal's one light: key 0, offset (0.03, −1.29, 2.32), rgb(200,0,200) I100 f6.
const LIGHTS = new Map([
  [PURPLE, [{ partIndex: 0, x: 0.03, y: -1.29, z: 2.32 }]],
  [TWO, [{ partIndex: 0, x: 0, y: 0, z: 1 }, { partIndex: 3, x: 1, y: 0, z: 2 }]],
  [DARK, []],
]);
function makeWasm() {
  const w = {
    calls: new Map(),
    async fetchSetupModelLights(sid) {
      w.calls.set(sid, (w.calls.get(sid) || 0) + 1);
      const ls = LIGHTS.get(sid >>> 0) || [];
      return {
        partCount: ls.length,
        takeLights: () => ls.map((l) => ({
          ...l, colorR: 200 / 255, colorG: 0, colorB: 200 / 255, intensity: 100, falloff: 6,
          coneAngle: 0, qw: 1, qx: 0, qy: 0, qz: 0, free() {},
        })),
        free() {},
      };
    },
  };
  return w;
}
function rig(guid, setupId, scale = 1) {
  const root = new THREE.Group();
  root.scale.setScalar(scale);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Group();
    p.position.set(0, 0, i === 0 ? 1.415 : 0.5 * i); // part 0 posed like the portal quad
    root.add(p);
    parts.push(p);
  }
  return { guid, root, parts, meta: { modelId: setupId } };
}
function scene3dWith(insts) {
  const map = new Map(insts.map((i) => [i.guid, i]));
  return { activeLights: [], entityManager: { entityMap: map } };
}
const lightsOf = (obj) => obj.children.filter((c) => c.isLight);

// ── A ─────────────────────────────────────────────────────────────────────
L.__setLightObjectFrameForTest(true);
{
  const portal = rig(1, PURPLE);
  const s3d = scene3dWith([portal]);
  await L.attachSetupModelLights(s3d, makeWasm());
  const onRoot = lightsOf(portal.root);
  check("A: the portal light hangs off the rig root", onRoot.length === 1 && lightsOf(portal.parts[0]).length === 0);
  const lp = onRoot[0]?.position;
  check("A: at the LightInfo offset in the object frame (2.32 m up, not 3.7)",
    lp && near(lp.x, 0.03) && near(lp.y, -1.29) && near(lp.z, 2.32));
  // the portal MotionTable spins part 0 about its Y axis — the light must not move
  const before = new THREE.Vector3();
  portal.root.updateMatrixWorld(true);
  onRoot[0].getWorldPosition(before);
  portal.parts[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 0.75);
  portal.root.updateMatrixWorld(true);
  const after = new THREE.Vector3();
  onRoot[0].getWorldPosition(after);
  check("A: spinning part 0 leaves the light where it is (it never dips under the ground)", before.distanceTo(after) < 1e-9 && after.z > 0);
  check("A: the light joined activeLights", s3d.activeLights.length === 1 && s3d.activeLights[0] === onRoot[0]);
}

// ── B ─────────────────────────────────────────────────────────────────────
{
  const two = rig(2, TWO);
  const s3d = scene3dWith([two]);
  await L.attachSetupModelLights(s3d, makeWasm());
  const on = lightsOf(two.root);
  check("B: both lights of a two-light Setup attach to the root (key 3 is not a filter)", on.length === 2,
    `${on.length}`);
  check("B: each at its own offset", on.some((l) => near(l.position.z, 1)) && on.some((l) => near(l.position.x, 1) && near(l.position.z, 2)));
}

// ── C ─────────────────────────────────────────────────────────────────────
{
  const big = rig(3, PURPLE, 2);
  const big2 = rig(4, PURPLE, 2);
  const plain = rig(5, PURPLE, 1);
  const s3d = scene3dWith([big, big2, plain]);
  await L.attachSetupModelLights(s3d, makeWasm());
  const w = (inst) => { inst.root.updateMatrixWorld(true); const v = new THREE.Vector3(); lightsOf(inst.root)[0].getWorldPosition(v); return v; };
  const a = w(big), b = w(big2), c = w(plain);
  check("C: a 2x-scaled portal keeps the unscaled offset (retail frames carry no scale)",
    near(a.x, 0.03) && near(a.y, -1.29) && near(a.z, 2.32), a.toArray().join(","));
  check("C: the second scaled rig (a template-built light) lands the same", near(b.z, 2.32) && near(b.y, -1.29), b.toArray().join(","));
  check("C: an unscaled rig of the same Setup is untouched", near(c.z, 2.32));
}

// ── D ─────────────────────────────────────────────────────────────────────
{
  const p1 = rig(6, PURPLE), p2 = rig(7, PURPLE), dark1 = rig(8, DARK), dark2 = rig(9, DARK);
  const s3d = scene3dWith([p1, p2, dark1, dark2]);
  // a statics group the entities-only pass must not walk
  const statics = new THREE.Group();
  const lamp = new THREE.Mesh(new THREE.BufferGeometry());
  lamp.userData = { modelId: PURPLE };
  statics.add(lamp);
  s3d.staticsGroup = statics;
  const wasm = makeWasm();
  await L.attachSetupModelLights(s3d, wasm, { entities: [p1] });
  check("D: opts.entities lights just that rig", lightsOf(p1.root).length === 1 && lightsOf(p2.root).length === 0);
  check("D: ...and walks no statics", lamp.children.length === 0 && !lamp.userData.__setupLightScanned);
  await L.attachSetupModelLights(s3d, wasm);
  check("D: the full rescan is idempotent with it (p1 keeps one light, p2 gets its own)",
    lightsOf(p1.root).length === 1 && lightsOf(p2.root).length === 1);
  await L.attachSetupModelLights(s3d, wasm, { entities: [dark1] });
  const n = wasm.calls.get(DARK) || 0;
  await L.attachSetupModelLights(s3d, wasm, { entities: [dark2] });
  check("D: a Setup known to have no lights is not fetched again by the spawn hook", (wasm.calls.get(DARK) || 0) === n,
    `${n} → ${wasm.calls.get(DARK)}`);
}

// ── E ─────────────────────────────────────────────────────────────────────
L.__setLightObjectFrameForTest(false);
{
  const portal = rig(10, PURPLE);
  const s3d = scene3dWith([portal]);
  await L.attachSetupModelLights(s3d, makeWasm());
  check("E: =off — the old per-part parenting (under part 0)", lightsOf(portal.parts[0]).length === 1 && lightsOf(portal.root).length === 0);
}

// ── F ─────────────────────────────────────────────────────────────────────
check("F: absent → on", L.lightObjectFrameEnabled("") === true);
for (const v of ["off", "0", "false", "no"]) check(`F: ${v} → off`, L.lightObjectFrameEnabled(`?lightObjectFrame=${v}`) === false);
L.__setLightObjectFrameForTest(undefined);

console.log(`light_object_frame: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
