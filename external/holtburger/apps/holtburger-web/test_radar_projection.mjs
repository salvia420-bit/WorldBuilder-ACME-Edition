// test_radar_projection.mjs — retail gmRadarUI maths behind plugins/radar.js.
//
// HUD overhaul 2026-10-05. The radar used to be NORTH-UP, which made the disk
// sprite's view-cone wedge (always pointing up) lie whenever the player wasn't
// facing north — the owner's "busted and inverted" radar. Retail is
// HEADING-UP: gmRadarUI::DrawObjects projects every object through
// SmartBox::convert_to_player_space, and gmRadarUI::UpdateCompassTokens orbits
// the N/E/S/W tokens by the player's heading. This pins:
//   - the pose-yaw → compass-heading sign (a flip here re-inverts the radar),
//   - the DrawObjects projection (forward = up, right = right, range cut-off),
//   - UpdateCompassTokens placement (matches the DAT rects at heading 0),
//   - InqPlayerCoords / gid_to_lcoord coordinates + the "%.1f%s,%.1f%s" format,
//   - GetRadarRadius, InqShowableOnRadar, GetBlipShape, DrawBlip pixels, and
//     the 6-px m_iidObjectUnderMouse pick.
//
// Run: node test_radar_projection.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  compassHeadingFromPoseYaw,
  toPlayerSpace,
  projectToRadar,
  compassTokenPosition,
  tokenMagnitude,
  RADAR_TOKEN_RECTS,
  RADAR_GEOMETRY,
  isOutdoorCell,
  radarRangeForCell,
  outdoorCellId,
  mapCoordsForCell,
  formatRadarCoords,
  radarCoordsText,
  isShowableOnRadar,
  blipShapeFor,
  BLIP_SHAPE,
  blipPixels,
  SELECTED_PIXELS,
  CENTRE_PIXELS,
  blipIntensity,
  pickBlipUnderMouse,
  scaleHexColor,
  RADAR_RANGE_OUTDOOR,
  RADAR_RANGE_INDOOR,
} from "./plugins/radar.js";
import { resolveRadarLook } from "./scene3d/selection_brackets.js";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}\n    ${err.message}`);
  }
};

const DEG = Math.PI / 180;
const NORTH = 0;
const EAST = 90 * DEG;
const SOUTH = 180 * DEG;
const WEST = 270 * DEG;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const { cx, cy } = RADAR_GEOMETRY;

console.log("[heading] pose yaw (CCW about +Z) → compass heading (CW from north)");
test("yaw 0 → facing north", () => assert.ok(near(compassHeadingFromPoseYaw(0), 0)));
test("yaw −π/2 → facing east (AC forward (−sinθ, cosθ) = (+1, 0))", () => {
  assert.ok(near(compassHeadingFromPoseYaw(-Math.PI / 2), EAST));
});
test("yaw +π/2 → facing west", () => assert.ok(near(compassHeadingFromPoseYaw(Math.PI / 2), WEST)));
test("yaw ±π → facing south", () => {
  assert.ok(near(compassHeadingFromPoseYaw(Math.PI), SOUTH));
  assert.ok(near(compassHeadingFromPoseYaw(-Math.PI), SOUTH));
});
test("non-finite yaw → north", () => assert.equal(compassHeadingFromPoseYaw(NaN), 0));
test("heading agrees with the AC forward vector for arbitrary yaw", () => {
  for (const yaw of [0.3, -1.2, 2.9, -2.4]) {
    const h = compassHeadingFromPoseYaw(yaw);
    // AC forward for raw yaw θ (ACE Position.InFrontOf) …
    const fx = -Math.sin(yaw);
    const fy = Math.cos(yaw);
    // … must be straight ahead (player-space +y) after the radar transform.
    const v = toPlayerSpace(fx, fy, h);
    assert.ok(near(v.x, 0, 1e-12) && near(v.y, 1, 1e-12), `yaw ${yaw}: ${JSON.stringify(v)}`);
  }
});

console.log("[projection] gmRadarUI::DrawObjects is heading-up");
test("facing north: entity due north is straight up", () => {
  const p = projectToRadar(0, 30, NORTH);
  assert.deepEqual([p.x, p.y], [cx, cy - 20]); // 30 m · 50 px / 75 m = 20 px
});
test("facing north: entity due east is to the right", () => {
  const p = projectToRadar(30, 0, NORTH);
  assert.deepEqual([p.x, p.y], [cx + 20, cy]);
});
test("facing east: entity due north is on the LEFT", () => {
  const p = projectToRadar(0, 30, EAST);
  assert.equal(p.x, cx - 20);
  assert.ok(Math.abs(p.y - cy) <= 1, `y ${p.y}`);
});
test("facing east: entity due east is straight up", () => {
  const p = projectToRadar(30, 0, EAST);
  assert.ok(Math.abs(p.x - cx) <= 1, `x ${p.x}`);
  assert.equal(p.y, cy - 20);
});
test("facing south: entity due north is straight down (behind)", () => {
  const p = projectToRadar(0, 30, SOUTH);
  assert.ok(Math.abs(p.x - cx) <= 1);
  assert.ok(p.y > cy + 19);
});
test("facing west: entity due north is on the RIGHT", () => {
  const p = projectToRadar(0, 30, WEST);
  assert.ok(p.x > cx + 19 && Math.abs(p.y - cy) <= 1, JSON.stringify(p));
});
test("range cut-off is (range − 1)² on the horizontal distance", () => {
  assert.ok(projectToRadar(0, 73.9, NORTH));
  assert.equal(projectToRadar(0, 74, NORTH), null);
  assert.equal(projectToRadar(60, 60, NORTH), null);
});
test("indoor range 25 m scales the same disk", () => {
  const p = projectToRadar(0, 12, NORTH, RADAR_RANGE_INDOOR);
  assert.deepEqual([p.x, p.y], [cx, cy - 24]); // 12 · 50 / 25
  assert.equal(projectToRadar(0, 24, NORTH, RADAR_RANGE_INDOOR), null);
});
test("pixel coordinates are truncated like retail's (unsigned __int64) cast", () => {
  const p = projectToRadar(1.4, -1.4, NORTH); // 0.933 px right, 0.933 px down
  assert.deepEqual([p.x, p.y], [cx, cy]);
});

console.log("[tokens] gmRadarUI::UpdateCompassTokens");
test("heading 0 reproduces the DAT token rects exactly", () => {
  for (const dir of ["n", "e", "s", "w"]) {
    const r = RADAR_TOKEN_RECTS[dir];
    assert.deepEqual(compassTokenPosition(dir, NORTH), { left: r.x, top: r.y }, dir);
  }
});
test("token magnitudes come from the layout (PostInit)", () => {
  assert.ok(near(tokenMagnitude("n"), 54.5));
  assert.ok(near(tokenMagnitude("s"), 54.5));
  assert.ok(near(tokenMagnitude("e"), Math.hypot(55, 0.5)));
});
test("facing east: N token on the LEFT, E token at the TOP", () => {
  const n = compassTokenPosition("n", EAST);
  const e = compassTokenPosition("e", EAST);
  assert.ok(n.left <= 1 && Math.abs(n.top - 55) <= 1, `N ${JSON.stringify(n)}`);
  assert.ok(Math.abs(e.left - 55) <= 1 && e.top <= 1, `E ${JSON.stringify(e)}`);
});
test("facing south: N token at the BOTTOM", () => {
  const n = compassTokenPosition("n", SOUTH);
  assert.ok(Math.abs(n.left - 55) <= 1 && n.top >= 109, JSON.stringify(n));
});
test("token N sits where a blip due north would project, at any heading", () => {
  for (const h of [0.4, 1.9, 3.3, 5.1]) {
    const t = compassTokenPosition("n", h);
    const tc = { x: t.left + 5, y: t.top + 4.5 };
    const v = toPlayerSpace(0, 1, h); // unit vector due north in player space
    const dir = { x: v.x, y: -v.y };   // screen y grows downward
    const len = Math.hypot(tc.x - cx, tc.y - cy);
    const ux = (tc.x - cx) / len;
    const uy = (tc.y - cy) / len;
    assert.ok(ux * dir.x + uy * dir.y > 0.99, `h ${h}`);
  }
});

console.log("[coords] CPlayerSystem::InqPlayerCoords + gmRadarUI::UpdateCoordinates");
test("Holtburg pose (LB 0xA9B4, local 82.7, 8.8) → cell 0xA9B40019", () => {
  assert.equal(outdoorCellId(0xa9b40021, 82.7, 8.8), 0xa9b40019);
});
test("Holtburg → \"42.1N,33.6E\" (NS first, no space — retail %.1f%s,%.1f%s)", () => {
  assert.equal(radarCoordsText(0xa9b40019), "42.1N,33.6E");
});
test("coords are the cell centre: same text anywhere inside one 24 m cell", () => {
  assert.equal(radarCoordsText(outdoorCellId(0xa9b40000, 72.01, 0.2)), "42.1N,33.6E");
  assert.equal(radarCoordsText(outdoorCellId(0xa9b40000, 95.9, 23.9)), "42.1N,33.6E");
  assert.equal(radarCoordsText(outdoorCellId(0xa9b40000, 96.1, 23.9)), "42.1N,33.7E");
});
test("cell-centre coords agree with the continuous map formula", () => {
  // EW = (lbX·192 + x)/240 − 101.95 evaluated at the cell centre.
  const c = mapCoordsForCell(outdoorCellId(0xa9b40000, 82.7, 8.8));
  assert.ok(near(c.ew, (169 * 192 + 3 * 24 + 12) / 240 - 101.95, 1e-9));
  assert.ok(near(c.ns, (180 * 192 + 0 * 24 + 12) / 240 - 101.95, 1e-9));
});
test("south/west hemisphere uses S and W", () => {
  assert.equal(radarCoordsText(0x00000001), "101.9S,101.9W");
});
test("exactly zero gets no suffix (retail empty string)", () => {
  assert.equal(formatRadarCoords(0, 0), "0.0,0.0");
  // lcoord 1019 → (1019 − 1024)·0.1 + 0.5 = 0 — LB 0x7F cell (3,3).
  assert.equal(radarCoordsText(outdoorCellId(0x7f7f0000, 80, 80)), "0.0,0.0");
});
test("indoor / dungeon cells hide the coordinates", () => {
  assert.equal(mapCoordsForCell(0xa9b40105), null);
  assert.equal(radarCoordsText(0xa9b40105), "");
  assert.equal(radarCoordsText(0x01d90100), "");
  assert.equal(radarCoordsText(0xa9b40000), ""); // cell 0 is not a valid cell
});
test("outdoor cell index clamps at the landblock edge", () => {
  assert.equal(outdoorCellId(0x12340000, 192, 192) & 0xffff, 0x40);
  assert.equal(outdoorCellId(0x12340000, -0.1, 0) & 0xffff, 0x01);
});

console.log("[range] CPlayerSystem::GetRadarRadius");
test("outdoors 75 m, indoors 25 m", () => {
  assert.equal(isOutdoorCell(0xa9b40019), true);
  assert.equal(radarRangeForCell(0xa9b40019), RADAR_RANGE_OUTDOOR);
  assert.equal(RADAR_RANGE_OUTDOOR, 75);
  assert.equal(isOutdoorCell(0xa9b40105), false);
  assert.equal(radarRangeForCell(0xa9b40105), RADAR_RANGE_INDOOR);
  assert.equal(RADAR_RANGE_INDOOR, 25);
});

console.log("[filter/shape] InqShowableOnRadar + GetBlipShape");
test("only RadarBehavior 2/3/4 are listed (membership, not motion)", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, undefined].map(isShowableOnRadar),
    [false, false, true, true, true, false, false]);
});
const ODF_PLAYER = 0x08, ODF_PK = 0x20, ODF_UI_HIDDEN = 0x80, ODF_PKLITE = 0x02000000;
test("everyone defaults to the + cross", () => {
  assert.equal(blipShapeFor({ objDescFlags: 0x10, guid: 5 }, { objDescFlags: ODF_PLAYER }, null), BLIP_SHAPE.CROSS);
  assert.equal(blipShapeFor({ objDescFlags: 0x10, guid: 5 }, null, null), BLIP_SHAPE.CROSS);
});
test("fellowship leader ▲, fellow ▼ (checked first)", () => {
  const fs = { leaderGuid: 7, members: new Set([7, 8]) };
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER, guid: 7 }, {}, fs), BLIP_SHAPE.TRIANGLE);
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER, guid: 8 }, {}, fs), BLIP_SHAPE.INVERTED_TRIANGLE);
});
test("allegiance member (same monarch) □", () => {
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER, guid: 9, monarch: 0x50000001 },
    { objDescFlags: ODF_PLAYER, monarch: 0x50000001 }, null), BLIP_SHAPE.HOLLOW);
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER, guid: 9, monarch: 0 },
    { objDescFlags: ODF_PLAYER, monarch: 0 }, null), BLIP_SHAPE.CROSS, "no monarch ≠ member");
});
test("mutual PK or mutual PK-lite ×", () => {
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER | ODF_PK, guid: 9 },
    { objDescFlags: ODF_PLAYER | ODF_PK }, null), BLIP_SHAPE.X);
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER | ODF_PKLITE, guid: 9 },
    { objDescFlags: ODF_PLAYER | ODF_PKLITE }, null), BLIP_SHAPE.X);
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER | ODF_PK, guid: 9 },
    { objDescFlags: ODF_PLAYER }, null), BLIP_SHAPE.CROSS);
});
test("UI-hidden objects get no blip", () => {
  assert.equal(blipShapeFor({ objDescFlags: ODF_UI_HIDDEN, guid: 9 }, {}, null), BLIP_SHAPE.NONE);
});
// radar-3 (2026-10-08 round 2): the shape reads the LIVE flags (OnStatUpdated
// 0x86 → SetPlayerKillerStatus); the spawn meta kept the pre-altar CROSS.
test("a player who turned PK after spawn: live flags give the mutual-PK ×", () => {
  const sh = { objectDescFlags: () => ODF_PLAYER | ODF_PK, objectIntProperty: () => undefined };
  const look = resolveRadarLook(sh, 9, { objDescFlags: ODF_PLAYER });
  const me = { objDescFlags: ODF_PLAYER | ODF_PK };
  assert.equal(blipShapeFor({ objDescFlags: look.odf, guid: 9 }, me, null), BLIP_SHAPE.X);
  assert.equal(blipShapeFor({ objDescFlags: ODF_PLAYER, guid: 9 }, me, null), BLIP_SHAPE.CROSS, "stale meta");
});

console.log("[pixels] DrawBlip / DrawSelected / DrawChildren");
const pts = (flat) => {
  const s = new Set();
  for (let i = 0; i < flat.length; i += 2) s.add(`${flat[i]},${flat[i + 1]}`);
  return s;
};
test("cross = centre + 4 edges; hollow = 3×3 ring; triangle points up", () => {
  assert.deepEqual(pts(blipPixels(BLIP_SHAPE.CROSS)), new Set(["0,0", "0,-1", "0,1", "-1,0", "1,0"]));
  const hollow = pts(blipPixels(BLIP_SHAPE.HOLLOW));
  assert.equal(hollow.size, 8);
  assert.ok(!hollow.has("0,0"));
  assert.deepEqual(pts(blipPixels(BLIP_SHAPE.TRIANGLE)), new Set(["0,0", "-1,1", "0,1", "1,1"]));
  assert.deepEqual(pts(blipPixels(BLIP_SHAPE.INVERTED_TRIANGLE)), new Set(["0,0", "-1,-1", "0,-1", "1,-1"]));
  assert.equal(pts(blipPixels(BLIP_SHAPE.X_BOX)).size, 12);
  assert.deepEqual(blipPixels(BLIP_SHAPE.NONE), []);
});
test("selected bracket = four 5-px bars at distance 3", () => {
  const s = pts(SELECTED_PIXELS);
  assert.equal(s.size, 20);
  for (const p of ["-2,3", "2,3", "3,-2", "3,2", "-2,-3", "-3,2"]) assert.ok(s.has(p), p);
});
test("player marker = 5×5 bright-green plus", () => {
  assert.deepEqual(pts(CENTRE_PIXELS),
    new Set(["0,0", "0,-1", "0,1", "-1,0", "1,0", "-2,0", "2,0", "0,-2", "0,2"]));
});
test("height difference ≥ 5 m dims the blip colour to 65 %", () => {
  assert.equal(blipIntensity(4.9), 1.0);
  assert.equal(blipIntensity(-5), 0.65);
  assert.equal(scaleHexColor("#ffab00", 0.65), "rgb(166,111,0)");
});

console.log("[pick] m_iidObjectUnderMouse (closest within 6 px)");
test("closest blip within 6 px wins; beyond 6 px nothing", () => {
  const blips = [{ x: 10, y: 10 }, { x: 14, y: 10 }, { x: 40, y: 40 }];
  assert.equal(pickBlipUnderMouse(blips, 13, 10), 1);
  assert.equal(pickBlipUnderMouse(blips, 11, 10), 0);
  assert.equal(pickBlipUnderMouse(blips, 46, 40), 2); // exactly 6 px
  assert.equal(pickBlipUnderMouse(blips, 47, 40), -1);
  assert.equal(pickBlipUnderMouse([], 0, 0), -1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
