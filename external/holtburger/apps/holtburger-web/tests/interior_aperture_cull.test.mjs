// interior_aperture_cull.test.mjs — ?interiorApertureCull (scene3d/interior_aperture_cull.js).
//
// Perf 2026-10-17: from outdoors, an interior room is drawn only when a door or
// window it could be seen through is in view (retail PView::DrawPortal →
// ConstructView, acclient.c:462565 / :462507). The behaviour that MUST NOT drift:
//   §1 the flag reader: default ON, `off|0|false|no` off, `noside` keeps the
//      cull but drops the sidedness half.
//   §2 aperture admission = retail's gates: front-facing (portal_side), survives
//      the near plane, lands on screen; a camera crossing a doorway keeps
//      EVERYTHING (no pop when entering/leaving a building).
//   §3 the room test: behind an in-view door → drawn; off to the side → culled;
//      camera at/inside the room, or a box corner behind the camera → drawn.
//   §4 CONSERVATIVE: any room point visible through a door's polygon keeps the
//      room (randomised against a real ray/polygon test).
//   §5 cells.js runs it outdoors only, before the occlusion culler.
//   §6 end to end through tickCellVisibility3D (real AC→three worldRoot, a v3
//      aperture export): the room behind the in-view door stays, the doorless
//      one goes; doorway / `.off` seam / stale pkg keep today's set.
//
// Run: node tests/interior_aperture_cull.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  readApertureCullMode,
  interiorApertureCullActive,
  apertureViewRects,
  boxScreenRect,
  cellSeenThroughApertures,
  __setInteriorApertureCullOffForTest,
  interiorApertureCullStats,
  APERTURE_RECT_PAD,
} from "../scene3d/interior_aperture_cull.js";
import { makeNearPlane, polygonPlane } from "../scene3d/portal_clip.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

// One frame for both spaces: the camera sits at the origin looking down -Z, so
// the "AC" aperture space and the "main-scene" box space coincide (cells.js
// folds worldRoot into the aperture MVP; the maths below does not care).
function view(pos = [0, 0, 0], look = [0, 0, -1]) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  cam.position.set(...pos);
  cam.lookAt(pos[0] + look[0], pos[1] + look[1], pos[2] + look[2]);
  cam.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const camAc = { x: pos[0], y: pos[1], z: pos[2] };
  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  return { vp: Float32Array.from(vp.elements), camAc, nearPlane: makeNearPlane(camAc, { x: fwd.x, y: fwd.y, z: fwd.z }) };
}

/** A z-plane door quad [x0..x1]×[y0..y1] at z, whose room lies toward `roomZ`. */
function door(x0, x1, y0, y1, z, roomZ) {
  const pts = [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z];
  const pl = polygonPlane(pts);
  // retail portal_side: true = the room is in the NEGATIVE halfspace of the plane.
  const roomDist = pl.nx * ((x0 + x1) / 2) + pl.ny * ((y0 + y1) / 2) + pl.nz * roomZ + pl.d;
  return { pts, side: roomDist < 0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: roomZ };
}

/** v3 wire shape: [count, (nv, cx,cy,cz, side, verts…)×count]. */
function v3(...doors) {
  const out = [doors.length];
  for (const d of doors) out.push(4, d.cx, d.cy, d.cz, d.side ? 1 : 0, ...d.pts);
  return Float32Array.from(out);
}
function v1(...doors) {
  const out = [doors.length];
  for (const d of doors) out.push(4, ...d.pts);
  return Float32Array.from(out);
}

function rects(flat, v, o = {}) {
  return apertureViewRects(flat, v.vp, { nearPlane: v.nearPlane, camAc: v.camAc, withCellCenter: true, withPortalSide: true, ...o });
}

await test("§1 flag reader", () => {
  assert.equal(readApertureCullMode(""), "on");
  assert.equal(readApertureCullMode("?foo=1"), "on");
  for (const v of ["off", "0", "false", "no", "OFF"]) assert.equal(readApertureCullMode(`?interiorApertureCull=${v}`), "off", v);
  assert.equal(readApertureCullMode("?interiorApertureCull=noside"), "noside");
  assert.equal(readApertureCullMode("?interiorApertureCull=banana"), "on");
  assert.equal(interiorApertureCullActive(), true, "node has no location: default ON");
  __setInteriorApertureCullOffForTest(true);
  assert.equal(interiorApertureCullActive(), false, "live .off seam");
  __setInteriorApertureCullOffForTest(false);
});

await test("§2 a front door 20 m ahead is in view; its rect is padded and on screen", () => {
  const v = view();
  const r = rects(v3(door(-1, 1, -1, 1, -20, -25)), v);
  assert.equal(r.full, false);
  assert.equal(r.inView, 1);
  assert.equal(r.rects.length, 4);
  const [x0, y0, x1, y1] = r.rects;
  assert.ok(x0 < 0.5 && x1 > 0.5 && y0 < 0.5 && y1 > 0.5, "centred on screen");
  assert.ok(x0 >= -APERTURE_RECT_PAD - 1e-9 && x1 <= 1 + APERTURE_RECT_PAD + 1e-9);
});

await test("§2 sidedness: a far-side door (room between it and the camera) is not a way in", () => {
  const v = view();
  const far = door(-1, 1, -1, 1, -30, -25); // room spans z -30..-20, camera at 0 → inside its side
  const r = rects(v3(far), v);
  assert.equal(r.inView, 0);
  assert.equal(r.away, 1);
  const r2 = rects(v3(far), v, { sidedness: false }); // ?interiorApertureCull=noside
  assert.equal(r2.inView, 1, "noside keeps it");
  const r3 = apertureViewRects(v1(far), v.vp, { nearPlane: v.nearPlane, camAc: v.camAc }); // v1 export: no side
  assert.equal(r3.inView, 1, "a stale pkg without portal_side cannot apply the reject");
});

await test("§2 near plane / off screen", () => {
  const v = view();
  const behind = door(-1, 1, -1, 1, 20, 25);
  const aside = door(500, 502, -1, 1, -20, -25);
  const r = rects(v3(behind, aside), v);
  assert.equal(r.inView, 0);
  assert.equal(r.behind, 1);
  assert.equal(r.offscreen, 1);
});

await test("§2 crossing a doorway keeps everything (no pop entering a building)", () => {
  const v = view([0, 0, -19.2]);
  const r = rects(v3(door(-1, 1, -1, 1, -20, -25)), v);
  assert.equal(r.full, true);
});

await test("§2 a short / corrupt buffer is parsed safely", () => {
  const v = view();
  const r = rects(Float32Array.from([3, 4, 0, 0, 0, 1, 1, 2]), v);
  assert.equal(r.inView, 0);
  assert.equal(r.full, false);
  assert.equal(rects(null, v).inView, 0);
});

await test("§3 room behind the door drawn; room off to the side culled", () => {
  const v = view();
  const r = rects(v3(door(-1, 1, -1, 1, -20, -25)), v);
  const cam = v.camAc;
  assert.equal(cellSeenThroughApertures([-3, -2, -26, 3, 2, -20], v.vp, cam, r.rects), true);
  assert.equal(cellSeenThroughApertures([-20, -2, -26, -14, 2, -20], v.vp, cam, r.rects), false);
  // An upper storey above the ground-floor door: not seen through it.
  assert.equal(cellSeenThroughApertures([-3, 6, -26, 3, 10, -20], v.vp, cam, r.rects), false);
  // No aperture in view at all → every room culled.
  assert.equal(cellSeenThroughApertures([-3, -2, -26, 3, 2, -20], v.vp, cam, []), false);
});

await test("§3 camera near/inside a room, or a box corner behind the camera → drawn", () => {
  const v = view();
  const cam = v.camAc;
  assert.equal(cellSeenThroughApertures([-2, -2, -2, 2, 2, 2], v.vp, cam, []), true, "inside");
  assert.equal(cellSeenThroughApertures([1.0, -1, -3, 4, 1, -1], v.vp, cam, []), true, "within the guard");
  assert.equal(cellSeenThroughApertures([5, -1, -10, 8, 1, 10], v.vp, cam, []), true, "spans the camera plane");
  assert.equal(boxScreenRect([5, -1, -10, 8, 1, 10], v.vp, [0, 0, 0, 0]), false);
});

for (const [label, look] of [["straight", [0, 0, -1]], ["yawed+pitched", [0.45, -0.2, -1]]]) await test(`§4 conservative (${label}): a room point visible through a door keeps the room`, () => {
  // Deterministic LCG so a failure reproduces.
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const v = view([0, 0, 0], look);
  let visibleCases = 0;
  for (let n = 0; n < 2000; n++) {
    const zd = -(2 + rnd() * 80);
    const w = 0.5 + rnd() * 3, h = 0.5 + rnd() * 3;
    const dx = (rnd() - 0.5) * 40, dy = (rnd() - 0.5) * 20;
    const d = door(dx - w / 2, dx + w / 2, dy - h / 2, dy + h / 2, zd, zd - 5);
    const r = rects(v3(d), v);
    // A room somewhere behind the door plane.
    const bx = dx + (rnd() - 0.5) * 30, by = dy + (rnd() - 0.5) * 15, bz = zd - 0.5 - rnd() * 10;
    const sx = 1 + rnd() * 6, sy = 1 + rnd() * 4, sz = 1 + rnd() * 6;
    const box = [bx - sx, by - sy, bz - sz, bx + sx, by + sy, Math.min(bz + sz, zd - 0.01)];
    // Sample the box: is any point ON SCREEN and seen THROUGH the door polygon?
    let seen = false;
    const e = v.vp;
    for (let i = 0; i < 64 && !seen; i++) {
      const px = box[0] + rnd() * (box[3] - box[0]);
      const py = box[1] + rnd() * (box[4] - box[1]);
      const pz = box[2] + rnd() * (box[5] - box[2]);
      const cw = e[3] * px + e[7] * py + e[11] * pz + e[15];
      const nx = (e[0] * px + e[4] * py + e[8] * pz + e[12]) / cw;
      const ny = (e[1] * px + e[5] * py + e[9] * pz + e[13]) / cw;
      if (!(cw > 0) || Math.abs(nx) > 1 || Math.abs(ny) > 1) continue;
      const t = zd / pz; // camera at the origin: the ray hits the door plane at t
      const qx = px * t, qy = py * t;
      seen = qx >= d.pts[0] && qx <= d.pts[3] && qy >= d.pts[1] && qy <= d.pts[7];
    }
    if (!seen) continue;
    visibleCases++;
    assert.equal(cellSeenThroughApertures(box, v.vp, v.camAc, r.rects), true, `case ${n}`);
  }
  assert.ok(visibleCases > 100, `enough visible cases exercised (${visibleCases})`);
});

await test("§5 cells.js gates outdoors only, before the occlusion culler", () => {
  const src = readFileSync(new URL("../scene3d/cells.js", import.meta.url), "utf8");
  const tick = src.slice(src.indexOf("export function tickCellVisibility3D"));
  const gate = tick.indexOf("_gateInteriorsByAperture(scene3d, sessionHandle, visibleSet");
  const occ = tick.indexOf("getOcclusionCuller(scene3d, THREE)");
  assert.ok(gate > 0 && occ > gate, "gate runs before the occlusion culler");
  const guard = tick.slice(tick.lastIndexOf("if (", gate), gate);
  assert.ok(/!isIndoor && !splitArmed && !CELL_BUG_PARITY/.test(guard), "armed like the occlusion culler");
  assert.ok(/interiorApertureCullActive\(\)/.test(guard), "flag / live seam honoured");
});

// §6 end to end through tickCellVisibility3D with a fake session: the real AC→
// three worldRoot rotation, a door in AC space, rooms as boxes in the main
// scene. Room A sits behind the in-view door, room B off to the left with no
// door in view. Outdoors: A drawn (and, ?interiorShadowCull, not casting), B
// culled. The camera stepping into the doorway keeps both.
globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;
const { tickCellVisibility3D } = await import("../scene3d/cells.js");

const LB = 0xa9b40000;
const OUTDOOR = (LB | 0x0024) >>> 0;
const ROOM_A = (LB | 0x0101) >>> 0;
const ROOM_B = (LB | 0x0102) >>> 0;

function room(cellId, min, max) {
  const c = new THREE.Group();
  c.name = `envcell-${cellId.toString(16)}`;
  c.userData = { cellId, isEnvCell: true };
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  m.castShadow = true;
  c.add(m);
  c.visible = false;
  c.updateMatrixWorld(true);
  return c;
}

function e2eScene(camPos) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(...camPos);
  camera.lookAt(camPos[0], camPos[1], camPos[2] - 10); // three -Z = AC +Y
  camera.updateMatrixWorld(true);
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up (adapter.js)
  worldRoot.updateMatrixWorld(true);
  const reg = new Map();
  // three frame: x = AC x, y = AC z, z = -AC y.
  reg.set(ROOM_A, room(ROOM_A, [-3, 0, -15], [3, 4, -5]));
  reg.set(ROOM_B, room(ROOM_B, [-40, 0, -15], [-30, 4, -5]));
  return {
    camera,
    worldRoot,
    cellContainers3d: reg,
    terrainGroup: { visible: true },
    buildingsGroup: { visible: true, children: [] },
    staticsGroup: { visible: true, children: [] },
  };
}

function e2eSession() {
  // Room A's door: AC plane y = 5 (three z = -5), x ∈ [-1,1], z ∈ [0,2.5]; the
  // room lies at AC y > 5, so retail portal_side = "room in the negative
  // halfspace" of the polygon's own plane.
  const pts = [-1, 5, 0, 1, 5, 0, 1, 5, 2.5, -1, 5, 2.5];
  const pl = polygonPlane(pts);
  const side = pl.nx * 0 + pl.ny * 10 + pl.nz * 1 + pl.d < 0;
  return {
    getCurrentCellId: () => OUTDOOR,
    isCurrentCellIndoor: () => false,
    getRenderSet: () => [OUTDOOR],
    getRenderSetWithFrustum: () => Uint32Array.from([OUTDOOR, ROOM_A, ROOM_B]),
    getVisiblePortalAperturesWithSidedness: () => Float32Array.from([1, 4, 0, 10, 1.25, side ? 1 : 0, ...pts]),
    getVisiblePortalApertures: () => Float32Array.from([1, 4, ...pts]),
  };
}

await test("§6 e2e: the room behind the in-view door is drawn, the doorless one culled", () => {
  const s3 = e2eScene([0, 1.5, 10]);
  tickCellVisibility3D(s3, e2eSession());
  const a = s3.cellContainers3d.get(ROOM_A), b = s3.cellContainers3d.get(ROOM_B);
  assert.equal(a.visible, true, "room A drawn through its door");
  assert.equal(b.visible, false, "room B: no door/window in view");
  assert.equal(a.children[0].castShadow, false, "?interiorShadowCull: no interior casters outdoors");
  const st = interiorApertureCullStats();
  assert.equal(st.culled, 1);
  assert.equal(st.inView, 1);
  assert.equal(st.skipped, "");
});

await test("§6 e2e: camera in the doorway keeps every room", () => {
  const s3 = e2eScene([0, 1.5, -5.4]); // 0.4 m in front of the door plane
  tickCellVisibility3D(s3, e2eSession());
  assert.equal(s3.cellContainers3d.get(ROOM_A).visible, true);
  assert.equal(s3.cellContainers3d.get(ROOM_B).visible, true);
});

await test("§6 e2e: live .off seam restores today's set", () => {
  __setInteriorApertureCullOffForTest(true);
  try {
    const s3 = e2eScene([0, 1.5, 10]);
    tickCellVisibility3D(s3, e2eSession());
    assert.equal(s3.cellContainers3d.get(ROOM_B).visible, true);
  } finally {
    __setInteriorApertureCullOffForTest(false);
  }
});

await test("§6 e2e: a stale pkg without any aperture export steps aside", () => {
  const s3 = e2eScene([0, 1.5, 10]);
  const sh = e2eSession();
  delete sh.getVisiblePortalAperturesWithSidedness;
  delete sh.getVisiblePortalApertures;
  tickCellVisibility3D(s3, sh);
  assert.equal(s3.cellContainers3d.get(ROOM_B).visible, true);
});

console.log(`\ninterior_aperture_cull: ${passed} passed`);
