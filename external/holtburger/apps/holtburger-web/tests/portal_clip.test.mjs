// portal_clip.test.mjs — the retail portal-aperture gates.
//
// NEW 2026-08-04 (terrain-over-interiors fix). `scene3d/portal_clip.js` is the
// port of the four gates `D3DPolyRender::DrawPortalPolyInternal`
// (acclient.c:453882) runs before it touches depth, plus the two arm/cull
// predicates the fix adds. It is dependency-free precisely so these rules can
// be locked here rather than only on a GPU.
//
// The behaviour that MUST NOT drift:
//   §1 near-plane CLIP, not drop — the 2026-07-06 R9-290 blackout was a
//      near-plane-straddling aperture rasterizing over the viewport. The old
//      `nearPlaneCullApertures` dropped the whole doorway; retail's
//      `polyClipFinish` (acclient.c:453941) clips it. A regression back to
//      "drop" silently loses every doorway you walk up to.
//   §2 the screen-area clamp — the structural guarantee that a degenerate poly
//      can never blank the frame. If this is widened, the blackout is back.
//   §3 `isCameraBelowTerrain` fails CLOSED — an unbaked landblock must NOT arm
//      the indoor depth split, or the world pass loses terrain depth over an
//      unknown surface.
//   §4 `terrainRayBlocked` fails OPEN — an unbaked landblock must NOT suppress
//      a doorway the player can plainly see.
//
// Run: node tests/portal_clip.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  clipPolygonAgainstPlane,
  makeNearPlane,
  isLandCellBoundaryPoly,
  projectScreenRect,
  terrainRayBlocked,
  isCameraBelowTerrain,
  clipAperturesForPunch,
  makeLosCache,
  nodeInLandblock,
  polygonPlane,
  apertureStraddlesViewer,
  apertureFacesAway,
  SIDEDNESS_MIN_INWARD_M,
  PUNCH_NEAR_MARGIN_M,
} from "../scene3d/portal_clip.js";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// A camera at the AC origin looking down +X, and the matching perspective MVP.
// AC is Z-up; we only need a matrix that maps "in front of the camera" to a
// positive w, so build a plain look-down-+X perspective by hand (column-major,
// THREE.Matrix4.elements order).
const NEAR = 0.1;
const FAR = 1000;
function mvpLookingAlongX() {
  // view: x_ac → -z_view (forward), y_ac → -x_view, z_ac → +y_view
  // proj: standard symmetric perspective, fov 90°, aspect 1.
  const f = 1.0; // 1/tan(45°)
  const A = (FAR + NEAR) / (NEAR - FAR);
  const B = (2 * FAR * NEAR) / (NEAR - FAR);
  // Composed column-major elements: e[col*4 + row].
  const e = new Float32Array(16);
  // view-space x = -y_ac ; y = z_ac ; z = -x_ac
  // clip.x = f * vx = -f*y_ac
  e[0] = 0;    e[4] = -f;  e[8] = 0;   e[12] = 0;   // row 0 (clip.x)
  e[1] = 0;    e[5] = 0;   e[9] = f;   e[13] = 0;   // row 1 (clip.y)
  e[2] = -A;   e[6] = 0;   e[10] = 0;  e[14] = B;   // row 2 (clip.z)
  e[3] = -(-1); e[7] = 0;  e[11] = 0;  e[15] = 0;   // row 3 (clip.w = -vz = x_ac)
  return e;
}
const MVP = mvpLookingAlongX();

console.log("§1 near-plane clip (retail polyClipFinish, acclient.c:453941)");

t("makeNearPlane puts the plane `margin` in front of the camera", () => {
  const p = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.equal(p.nx, 1);
  assert.ok(Math.abs(p.d + PUNCH_NEAR_MARGIN_M) < 1e-6);
});

t("makeNearPlane rejects a degenerate forward vector", () => {
  assert.equal(makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), null);
});

t("a straddling quad is CLIPPED, not dropped (the 2026-07-06 fix)", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  // Quad spanning x = -1 (behind the camera) to x = +5 (in front).
  const quad = [
    -1, -1, 0,
    5, -1, 0,
    5, 1, 0,
    -1, 1, 0,
  ];
  const out = clipPolygonAgainstPlane(quad, plane);
  assert.ok(out.length >= 12, "clip must keep the in-front part");
  for (let i = 0; i < out.length; i += 3) {
    assert.ok(
      out[i] >= PUNCH_NEAR_MARGIN_M - 1e-4,
      `every surviving vertex is in front of the near plane (got x=${out[i]})`,
    );
  }
});

t("a fully-behind quad clips to nothing", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const quad = [-5, -1, 0, -1, -1, 0, -1, 1, 0, -5, 1, 0];
  assert.deepEqual(clipPolygonAgainstPlane(quad, plane), []);
});

t("a fully-in-front quad is passed through intact", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const quad = [3, -1, 0, 5, -1, 0, 5, 1, 0, 3, 1, 0];
  const out = clipPolygonAgainstPlane(quad, plane);
  assert.equal(out.length, 12);
});

console.log("§1b LandCell-boundary reject (retail :453919-453932)");

t("a quad flat on a 24 m LandCell wall plane is rejected", () => {
  // All x == 24 (a cell wall) — retail's cell-local ±12.
  assert.equal(isLandCellBoundaryPoly([24, 0, 0, 24, 5, 0, 24, 5, 5]), true);
});

t("a real doorway quad off the wall planes is kept", () => {
  assert.equal(isLandCellBoundaryPoly([30.5, 12, 1, 30.5, 14, 1, 30.5, 14, 3]), false);
});

console.log("§2 screen-area clamp — the anti-blackout guarantee");

t("projectScreenRect refuses a vertex with w <= 0", () => {
  // x_ac = -5 → w = -5 → must not become a rect.
  assert.equal(projectScreenRect([-5, 0, 0, -5, 1, 0, -5, 1, 1], MVP), null);
});

t("a small distant doorway yields a small rect", () => {
  const r = projectScreenRect([20, -1, -1, 20, 1, -1, 20, 1, 1, 20, -1, 1], MVP);
  assert.ok(r, "should project");
  assert.ok(r.x1 - r.x0 < 0.2, `width ${r.x1 - r.x0} should be small`);
  assert.ok(r.y1 - r.y0 < 0.2, `height ${r.y1 - r.y0} should be small`);
});

t("an oversize aperture is DROPPED by clipAperturesForPunch", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  // A 400 m quad 20 m ahead: covers the whole screen, but is far enough from
  // the viewer that the §6 straddle gate does not claim it first (that gate
  // runs earlier, so keeping this case isolated is what proves the clamp
  // itself still works).
  const flat = [
    1,
    4,
    20, -200, -200,
    20, 200, -200,
    20, 200, 200,
    20, -200, 200,
  ];
  const res = clipAperturesForPunch(flat, MVP, {
    nearPlane: plane,
    camAc: { x: 0, y: 0, z: 0 },
  });
  assert.equal(res.kept, 0, "an aperture that covers the viewport must not punch");
  assert.equal(res.dropped.oversize, 1);
  assert.equal(res.rect, null);
});

t("a legitimate doorway survives and produces a bounded scissor rect", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const flat = [
    1,
    4,
    20, -1, -1,
    20, 1, -1,
    20, 1, 1,
    20, -1, 1,
  ];
  const res = clipAperturesForPunch(flat, MVP, {
    nearPlane: plane,
    camAc: { x: 0, y: 0, z: 0 },
  });
  assert.equal(res.kept, 1);
  assert.ok(res.rect, "a kept aperture must produce a rect");
  assert.ok(res.rect.x0 >= 0 && res.rect.x1 <= 1, "rect is clamped to [0,1]");
  assert.ok(res.rect.x1 - res.rect.x0 < 0.5, "rect bounds the punch to the doorway");
  // Wire shape is preserved: [count, nv, x,y,z ...]
  assert.equal(res.flat[0], 1);
  assert.equal(res.flat[1], 4);
});

t("an empty / malformed feed is a clean no-punch", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  for (const bad of [null, [], [0], [3]]) {
    const res = clipAperturesForPunch(bad, MVP, { nearPlane: plane });
    assert.equal(res.kept, 0);
    assert.equal(res.rect, null);
  }
  // No near plane (degenerate camera) → no punch, never a throw.
  assert.equal(clipAperturesForPunch([1, 3, 1, 0, 0, 2, 0, 0, 2, 1, 0], MVP, {}).kept, 0);
});

console.log("§3 isCameraBelowTerrain — the indoor-split arm, fails CLOSED");

t("camera under the surface arms", () => {
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 5), true);
});

t("camera on the surface does NOT arm (the 2026-05-29 anti-regression)", () => {
  // Standing on a Holtburg building plot: the plot is an EnvCell so
  // isCurrentCellIndoor() is true, but the camera is at/above ground.
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 10), false);
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 10.4), false);
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 12), false);
});

t("the 0.5 m margin is respected", () => {
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 9.6), false, "9.6 is within margin");
  assert.equal(isCameraBelowTerrain(() => 10, 0, 0, 9.4), true, "9.4 is below margin");
});

t("unknown / throwing / missing height fails CLOSED", () => {
  assert.equal(isCameraBelowTerrain(() => null, 0, 0, -100), false);
  assert.equal(isCameraBelowTerrain(() => undefined, 0, 0, -100), false);
  assert.equal(isCameraBelowTerrain(() => NaN, 0, 0, -100), false);
  assert.equal(isCameraBelowTerrain(() => { throw new Error("x"); }, 0, 0, -100), false);
  assert.equal(isCameraBelowTerrain(null, 0, 0, -100), false);
  assert.equal(isCameraBelowTerrain(() => 10, NaN, 0, 0), false);
});

console.log("§4 terrainRayBlocked — the LOS cull, fails OPEN");

t("a hill between camera and aperture blocks", () => {
  // Ray from (0,0,10) to (100,0,10); a ridge at x≈50 rises to 40.
  const h = (x) => (x > 40 && x < 60 ? 40 : 0);
  assert.equal(terrainRayBlocked(h, 0, 0, 10, 100, 0, 10), true);
});

t("flat ground below the ray does not block", () => {
  assert.equal(terrainRayBlocked(() => 0, 0, 0, 10, 100, 0, 10), false);
});

t("unknown samples fail OPEN (an unbaked LB must not hide a doorway)", () => {
  assert.equal(terrainRayBlocked(() => null, 0, 0, -50, 100, 0, -50), false);
  assert.equal(terrainRayBlocked(() => { throw new Error("x"); }, 0, 0, 0, 1, 0, 0), false);
  assert.equal(terrainRayBlocked(null, 0, 0, 0, 1, 0, 0), false);
});

t("endpoints are excluded — a below-grade aperture is not self-blocking", () => {
  // Camera inside a pit (z=-5) looking at an aperture also at z=-5, with the
  // surface at 0 everywhere. The ENDPOINTS are under the surface but the span
  // between them is too — this is the sunken-Yaraq geometry, and it MUST be
  // reported blocked only because the terrain genuinely covers the span.
  assert.equal(terrainRayBlocked(() => 0, 0, 0, -5, 20, 0, -5), true);
  // Whereas an open courtyard (surface dips with the pit) does not block.
  assert.equal(terrainRayBlocked(() => -8, 0, 0, -5, 20, 0, -5), false);
});

t("the terrain cull is wired into clipAperturesForPunch", () => {
  const plane = makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const flat = [1, 4, 20, -1, -1, 20, 1, -1, 20, 1, 1, 20, -1, 1];
  const opts = { nearPlane: plane, camAc: { x: 0, y: 0, z: 0 } };
  assert.equal(clipAperturesForPunch(flat, MVP, opts).kept, 1, "no sampler → kept");
  const res = clipAperturesForPunch(flat, MVP, {
    ...opts,
    sampleHeight: (x) => (x > 5 && x < 15 ? 50 : 0), // a hill in the way
  });
  assert.equal(res.kept, 0);
  assert.equal(res.dropped.terrain, 1);
});

console.log("§5 nodeInLandblock — indoorDepthSplit re-layer narrowing, fails CLOSED");

const LB = 0xa9b40000;

t("a tagged node in the landblock matches (full cell id is masked)", () => {
  assert.equal(nodeInLandblock({ userData: { landblockId: 0xa9b4011a } }, LB), true);
  assert.equal(nodeInLandblock({ userData: { landblockId: LB } }, LB), true);
  // The caller may pass a full cell id as lbKey too.
  assert.equal(nodeInLandblock({ userData: { landblockId: LB } }, 0xa9b4011a), true);
});

t("a tagged node in a DIFFERENT landblock does not match", () => {
  assert.equal(nodeInLandblock({ userData: { landblockId: 0xa9b50000 } }, LB), false);
  assert.equal(nodeInLandblock({ userData: { landblockId: 0x7d640000 } }, LB), false);
});

t("a merged instanced static matches via coversLbKeys", () => {
  assert.equal(
    nodeInLandblock({ userData: { coversLbKeys: [0xa9b30000, LB, 0xa9b50000] } }, LB),
    true,
  );
  assert.equal(
    nodeInLandblock({ userData: { coversLbKeys: [0xa9b30000, 0xa9b50000] } }, LB),
    false,
  );
});

t("an UNTAGGED node fails CLOSED — it stays on layer 0, keeping terrain occlusion", () => {
  assert.equal(nodeInLandblock({ userData: {} }, LB), false);
  assert.equal(nodeInLandblock({}, LB), false);
  assert.equal(nodeInLandblock(null, LB), false);
  assert.equal(nodeInLandblock(undefined, LB), false);
  assert.equal(nodeInLandblock({ userData: { coversLbKeys: "nope" } }, LB), false);
});

console.log("§6 apertureStraddlesViewer — DEFECT 2, the doorway-transition leak");

// A doorway quad in the plane x = 20, spanning y ∈ [-1,1], z ∈ [-1,1].
const DOOR = [20, -1, -1, 20, 1, -1, 20, 1, 1, 20, -1, 1];

t("polygonPlane returns a unit normal through the centroid", () => {
  const pl = polygonPlane(DOOR);
  assert.ok(pl, "should produce a plane");
  assert.ok(Math.abs(Math.abs(pl.nx) - 1) < 1e-5, "normal is +/-X");
  assert.ok(Math.abs(pl.cx - 20) < 1e-5, "centroid on the door plane");
  // Centroid satisfies the plane equation.
  assert.ok(Math.abs(pl.nx * pl.cx + pl.ny * pl.cy + pl.nz * pl.cz + pl.d) < 1e-5);
});

t("polygonPlane rejects a degenerate (collinear) polygon", () => {
  assert.equal(polygonPlane([0, 0, 0, 1, 0, 0, 2, 0, 0]), null);
  assert.equal(polygonPlane([0, 0, 0, 1, 0, 0]), null);
});

t("a viewer STANDING IN the doorway straddles → aperture dropped", () => {
  assert.equal(apertureStraddlesViewer(DOOR, { x: 20, y: 0, z: 0 }), true);
  assert.equal(apertureStraddlesViewer(DOOR, { x: 19.5, y: 0, z: 0 }), true);
  assert.equal(apertureStraddlesViewer(DOOR, { x: 20.5, y: 0, z: 0 }), true);
});

t("a viewer well OUTSIDE does not straddle → aperture kept (the working case)", () => {
  assert.equal(apertureStraddlesViewer(DOOR, { x: 0, y: 0, z: 0 }), false);
  assert.equal(apertureStraddlesViewer(DOOR, { x: 10, y: 0, z: 0 }), false);
});

t("a viewer well INSIDE does not straddle → aperture kept (the working case)", () => {
  assert.equal(apertureStraddlesViewer(DOOR, { x: 30, y: 0, z: 0 }), false);
});

t("near the INFINITE plane but far off to the side does NOT drop the doorway", () => {
  // 40 m down the street, level with the door plane. Dropping this would blind
  // the punch to every door on that wall.
  assert.equal(apertureStraddlesViewer(DOOR, { x: 20, y: 40, z: 0 }), false);
  assert.equal(apertureStraddlesViewer(DOOR, { x: 20, y: 0, z: 40 }), false);
});

t("degenerate inputs never throw and never drop", () => {
  assert.equal(apertureStraddlesViewer(null, { x: 0, y: 0, z: 0 }), false);
  assert.equal(apertureStraddlesViewer(DOOR, null), false);
  assert.equal(apertureStraddlesViewer([0, 0, 0, 1, 0, 0, 2, 0, 0], { x: 0, y: 0, z: 0 }), false);
});

t("the straddle cull is wired into clipAperturesForPunch", () => {
  const flat = [1, 4, 20, -1, -1, 20, 1, -1, 20, 1, 1, 20, -1, 1];
  // Viewer far outside, looking at the door: kept.
  const far = clipAperturesForPunch(flat, MVP, {
    nearPlane: makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    camAc: { x: 0, y: 0, z: 0 },
  });
  assert.equal(far.kept, 1);
  assert.equal(far.dropped.straddle, 0);
  // Viewer standing in the doorway: dropped, and counted as a straddle.
  const inDoor = clipAperturesForPunch(flat, MVP, {
    nearPlane: makeNearPlane({ x: 19.9, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    camAc: { x: 19.9, y: 0, z: 0 },
  });
  assert.equal(inDoor.kept, 0);
  assert.equal(inDoor.dropped.straddle, 1);
});

console.log("§7 apertureFacesAway — round-5 ConstructView sidedness reject");

// Room centred at x=25; its near door at x=20 and far door at x=30.
const NEAR_DOOR = [20, -1, -1, 20, 1, -1, 20, 1, 1, 20, -1, 1];
const FAR_DOOR  = [30, -1, -1, 30, 1, -1, 30, 1, 1, 30, -1, 1];
const ROOM_C    = { x: 25, y: 0, z: 0 };
const VIEWER    = { x: 0, y: 0, z: 0 }; // outside, on the near-door side

t("the NEAR door faces the viewer → kept", () => {
  assert.equal(apertureFacesAway(NEAR_DOOR, ROOM_C, VIEWER), false);
});

t("the FAR door faces away → DROPPED (no punch through the near wall)", () => {
  assert.equal(apertureFacesAway(FAR_DOOR, ROOM_C, VIEWER), true);
});

t("orientation is winding-independent — reversed winding gives the same answer", () => {
  const rev = [];
  for (let i = (FAR_DOOR.length / 3) - 1; i >= 0; i--) {
    rev.push(FAR_DOOR[i * 3], FAR_DOOR[i * 3 + 1], FAR_DOOR[i * 3 + 2]);
  }
  assert.equal(apertureFacesAway(rev, ROOM_C, VIEWER), true);
  const revNear = [];
  for (let i = (NEAR_DOOR.length / 3) - 1; i >= 0; i--) {
    revNear.push(NEAR_DOOR[i * 3], NEAR_DOOR[i * 3 + 1], NEAR_DOOR[i * 3 + 2]);
  }
  assert.equal(apertureFacesAway(revNear, ROOM_C, VIEWER), false);
});

t("a viewer on the far side sees the FAR door and not the near one", () => {
  const behind = { x: 50, y: 0, z: 0 };
  assert.equal(apertureFacesAway(FAR_DOOR, ROOM_C, behind), false);
  assert.equal(apertureFacesAway(NEAR_DOOR, ROOM_C, behind), true);
});

t("degenerate inputs never throw and never drop", () => {
  assert.equal(apertureFacesAway(null, ROOM_C, VIEWER), false);
  assert.equal(apertureFacesAway(NEAR_DOOR, null, VIEWER), false);
  assert.equal(apertureFacesAway(NEAR_DOOR, ROOM_C, null), false);
  assert.equal(apertureFacesAway([0,0,0, 1,0,0, 2,0,0], ROOM_C, VIEWER), false);
});

t("clipAperturesForPunch drops the far door when fed cell centres", () => {
  // withCellCenter wire shape: [count, (nv, cx,cy,cz, x,y,z...) x count]
  const flat = [2,
    4, 25, 0, 0,  20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1,
    4, 25, 0, 0,  30,-1,-1, 30,1,-1, 30,1,1, 30,-1,1,
  ];
  const res = clipAperturesForPunch(flat, MVP, {
    nearPlane: makeNearPlane(VIEWER, { x: 1, y: 0, z: 0 }),
    camAc: VIEWER,
    withCellCenter: true,
  });
  assert.equal(res.dropped.backface, 1, "the far door must be rejected");
  assert.equal(res.kept, 1, "the near door must survive");
});

t("without cell centres the sidedness gate is skipped (stale-pkg fallback)", () => {
  const flat = [2,
    4, 20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1,
    4, 30,-1,-1, 30,1,-1, 30,1,1, 30,-1,1,
  ];
  const res = clipAperturesForPunch(flat, MVP, {
    nearPlane: makeNearPlane(VIEWER, { x: 1, y: 0, z: 0 }),
    camAc: VIEWER,
  });
  assert.equal(res.dropped.backface, 0);
  assert.equal(res.kept, 2, "round-4 behaviour preserved when the export is absent");
});

console.log("§8 sidedness TRUTH TABLE + the round-5 outdoor regression guard");

// Room centred at x=25. Near door x=20, far door x=30. Viewer outside at x=0.
// The four rows that matter, stated explicitly so the convention cannot drift:
//
// The rule, stated once so the convention cannot drift: DROP iff the viewer is
// on the INWARD side (the room's side) of the aperture. "Outward" is defined as
// away from the owning room's centre — never from vertex winding.
//
//   viewer      | door        | viewer is on   | expect
//   ------------|-------------|----------------|--------
//   OUTSIDE x=0 | near (x=20) | OUTWARD side   | KEEP   <- the case the punch exists for
//   OUTSIDE x=0 | far  (x=30) | INWARD side    | DROP   <- far-side door through the wall
//   OUTSIDE x=40| far  (x=30) | OUTWARD side   | KEEP
//   OUTSIDE x=40| near (x=20) | INWARD side    | DROP
//   INSIDE  x=25| either      | INWARD side    | DROP   (moot: the punch never runs indoors)
t("truth table: outward side keeps, inward side drops", () => {
  const near = [20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1];
  const far  = [30,-1,-1, 30,1,-1, 30,1,1, 30,-1,1];
  const room = { x: 25, y: 0, z: 0 };
  const outsideNear = { x: 0, y: 0, z: 0 };
  const outsideFar  = { x: 40, y: 0, z: 0 };
  const inside      = { x: 25, y: 0, z: 0.5 };
  assert.equal(apertureFacesAway(near, room, outsideNear), false, "OUTSIDE+near must KEEP");
  assert.equal(apertureFacesAway(far,  room, outsideNear), true,  "OUTSIDE+far must DROP");
  assert.equal(apertureFacesAway(far,  room, outsideFar),  false, "far-side viewer keeps far door");
  assert.equal(apertureFacesAway(near, room, outsideFar),  true,  "far-side viewer drops near door");
  // From inside the room the viewer is inward of EVERY door, so both drop.
  // The punch only runs when `!isIndoor`, so this row is documentation, not a
  // behaviour anyone renders.
  assert.equal(apertureFacesAway(near, room, inside), true);
  assert.equal(apertureFacesAway(far,  room, inside), true);
});

t("REGRESSION GUARD: a near-coplanar cell centre FAILS OPEN, never drops", () => {
  // A doorway in a LONG WALL: the room's AABB centre lands essentially ON the
  // wall plane, so `inward` is ~0 and its sign is noise. Round 5 let that flip
  // the outward normal and cull the doorway the player was looking at — the
  // reported outdoor-punch regression. It must now keep, from BOTH sides.
  const door = [20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1];
  const eps = SIDEDNESS_MIN_INWARD_M * 0.5;
  for (const cx of [20 + eps, 20 - eps, 20]) {
    const room = { x: cx, y: 0, z: 0 };
    assert.equal(apertureFacesAway(door, room, { x: 0, y: 0, z: 0 }), false);
    assert.equal(apertureFacesAway(door, room, { x: 40, y: 0, z: 0 }), false);
  }
});

t("a cell centre comfortably off the plane is still trusted", () => {
  const door = [20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1];
  const room = { x: 20 + SIDEDNESS_MIN_INWARD_M * 4, y: 0, z: 0 };
  assert.equal(apertureFacesAway(door, room, { x: 0, y: 0, z: 0 }), false, "outward keeps");
  assert.equal(apertureFacesAway(door, room, { x: 40, y: 0, z: 0 }), true, "inward drops");
});

t("the LOS cache returns the same verdicts as the uncached path", () => {
  const flat = [1, 4, 20,-1,-1, 20,1,-1, 20,1,1, 20,-1,1];
  const base = {
    nearPlane: makeNearPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    camAc: { x: 0, y: 0, z: 0 },
    sampleHeight: () => 0, // flat ground well below the ray → never blocks
  };
  const uncached = clipAperturesForPunch(flat, MVP, base);
  const cache = makeLosCache();
  let cached = null;
  for (let i = 0; i < 5; i++) {
    cached = clipAperturesForPunch(flat, MVP, { ...base, losCache: cache });
  }
  assert.equal(uncached.kept, 1);
  assert.equal(cached.kept, uncached.kept, "cache must not change the verdict");
  assert.equal(cached.dropped.terrain, 0);
});

console.log(`\nportal_clip.test.mjs — ${passed} assertions groups passed`);
