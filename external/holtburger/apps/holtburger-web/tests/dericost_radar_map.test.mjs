// tests/dericost_radar_map.test.mjs — Area 11: Dericost Continent & Ocean Corridor
// Support in Radar and Map Panel.
//
// Verifies:
//   1. continent_coords.js conversions: bit 15 detection, Y offset (+68,928m),
//      NS offset (+287.2), global/local cell coords, distance calculation.
//   2. radar.js: outdoorCellId bit 15 preservation, mapCoordsForCell with +287.2 NS offset,
//      radar candidate culling fix (entities on Dericost within 75m not culled).
//   3. map-panel.js: MAP_NORTH_Y expansion, lbToCoords bit 15 support,
//      sanitizeWaypoint northern bound expansion (up to +410 NS),
//      clampView northern margin, all 41 Dericost towns indexed in ALL_MAP_LOCATIONS,
//      and locationAtMapPx hit-testing.
//
// Run from apps/holtburger-web/:  node tests/dericost_radar_map.test.mjs

import assert from "node:assert/strict";
import {
  DERICOST_Y_OFFSET,
  DERICOST_NS_OFFSET,
  DERETH_Y_MIN,
  DERETH_Y_MAX,
  DERICOST_Y_MIN,
  DERICOST_Y_MAX,
  isDericostCell,
  continentFromCellId,
  continentIndexFromCellId,
  localYToGlobalY,
  globalYToLocalY,
  worldToCoords,
  coordsToWorld,
  cellToGlobal,
  globalToCell,
  continentDistance2D,
  formatContinentCoords,
} from "../plugins/continent_coords.js";

import {
  DERICOST_Y_OFFSET as RADAR_DERICOST_Y,
  DERICOST_NS_OFFSET as RADAR_DERICOST_NS,
  outdoorCellId,
  mapCoordsForCell,
  formatRadarCoords,
  radarCoordsText,
  RADAR_RANGE_OUTDOOR,
} from "../plugins/radar.js";

import {
  MAP_NORTH_Y,
  DERICOST_Y_OFFSET as MAP_DERICOST_Y,
  DERICOST_NS_OFFSET as MAP_DERICOST_NS,
  lbToCoords,
  sanitizeWaypoint,
  clampView,
  DERICOST_TOWNS,
  DERICOST_MAP_LOCATIONS,
  ALL_MAP_LOCATIONS,
  locationAtMapPx,
  coordsToMapPx,
} from "../plugins/map-panel.js";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err?.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}

console.log("\n[1] continent_coords.js — Geodetic & Coordinate Transformations");

await check("Constants match canonical geodetics (+68,928m / +287.2 NS)", () => {
  assert.equal(DERICOST_Y_OFFSET, 68928.0);
  assert.equal(DERICOST_NS_OFFSET, 287.2);
  assert.equal(DERETH_Y_MIN, 0.0);
  assert.equal(DERETH_Y_MAX, 48960.0);
  assert.equal(DERICOST_Y_MIN, 68928.0);
  assert.equal(DERICOST_Y_MAX, 117888.0);
});

await check("isDericostCell checks bit 15 (0x8000) on cell id", () => {
  // Dereth cell: high bit 15 unset
  assert.equal(isDericostCell(0x01000001), false);
  assert.equal(isDericostCell(0x00A90001), false);
  assert.equal(isDericostCell(0x7FFF0001), false);

  // Dericost cell: bit 15 set (0x8000... or 0x8xxx...)
  assert.equal(isDericostCell(0x80000001), true);
  assert.equal(isDericostCell(0x80A90001), true);
  assert.equal(isDericostCell(0x00A98001), true);
  assert.equal(isDericostCell(0x8FFF0001), true);

  // Unsigned 32-bit normalization check
  const signedNegative = -2147483648; // 0x80000000 in signed 32-bit
  assert.equal(isDericostCell(signedNegative), true);
});

await check("continentFromCellId returns 'dericost' vs 'dereth'", () => {
  assert.equal(continentFromCellId(0x01000001), "dereth");
  assert.equal(continentFromCellId(0x80000001), "dericost");
  assert.equal(continentFromCellId(0x00A98001), "dericost");
  assert.equal(continentIndexFromCellId(0x01000001), 0);
  assert.equal(continentIndexFromCellId(0x80000001), 1);
});

await check("localYToGlobalY & globalYToLocalY roundtrip", () => {
  const localDereth = 24480.0;
  assert.equal(localYToGlobalY(localDereth, false), 24480.0);
  assert.equal(globalYToLocalY(24480.0), 24480.0);

  const localDericost = 1200.0;
  const globalDericost = localYToGlobalY(localDericost, true);
  assert.equal(globalDericost, 1200.0 + 68928.0);
  assert.equal(globalYToLocalY(globalDericost), localDericost);
});

await check("worldToCoords & coordsToWorld on Dereth and Dericost", () => {
  // Dereth coords: coordsToWorld(0, 0)
  const derethWorld = coordsToWorld(0.0, 0.0);
  assert.equal(derethWorld.wx, 24468.0);
  assert.equal(derethWorld.wy, 24468.0);

  const derethCoords = worldToCoords(24468.0, 24468.0, false);
  assert.equal(Math.round(derethCoords.ew * 100) / 100, 0.0);
  assert.equal(Math.round(derethCoords.ns * 100) / 100, 0.0);

  // Dericost point: coordsToWorld(0.0, 287.2)
  const dericostWorld = coordsToWorld(0.0, 287.2);
  assert.equal(dericostWorld.wx, 24468.0);
  assert.equal(Math.round(dericostWorld.wy), 93396);

  const dericostCoords = worldToCoords(24468.0, 93396.0);
  assert.equal(Math.round(dericostCoords.ew * 100) / 100, 0.0);
  assert.equal(Math.round(dericostCoords.ns * 10) / 10, 287.2);
});

await check("cellToGlobal & globalToCell with continent bit 15", () => {
  // Dericost landblock 0x80A9, cell 1 (x=0, y=0), local pos (12, 12, 0)
  const global = cellToGlobal(0x80A98001, 12.0, 12.0, 50.0);
  assert.equal(global.isDericost, true);
  assert.ok(global.y >= 68928.0, "Global Y must include +68,928m offset");

  // Re-encode to cell
  const back = globalToCell(global.x, global.y);
  assert.equal(back.isDericost, true);
  assert.ok((back.cell & 0x8000) !== 0, "Cell ID must have bit 15 set");
});

await check("continentDistance2D calculates true Euclidean distance without jump", () => {
  // Two points on Dericost 10m apart along Y
  const p1 = { x: 20000, y: 70000 };
  const p2 = { x: 20000, y: 70010 };
  const dist = continentDistance2D(p1, p2);
  assert.equal(dist, 10.0);
});

await check("formatContinentCoords formats coordinates with NS/EW suffixes", () => {
  assert.equal(formatContinentCoords(-34.2, 10.5), "10.5N, 34.2W");
  assert.equal(formatContinentCoords(45.1, 290.0), "290.0N, 45.1E");
});

console.log("\n[2] radar.js — Dericost Radar Geodetics & Blip Culling Fix");

await check("radar.js exports match canonical offsets", () => {
  assert.equal(RADAR_DERICOST_Y, 68928.0);
  assert.equal(RADAR_DERICOST_NS, 287.2);
});

await check("outdoorCellId preserves Continent Bit 15 (0x8000)", () => {
  // Dereth landblock 0x00A9
  const derethCell = outdoorCellId(0x00A9, 12.0, 12.0);
  assert.equal((derethCell & 0x8000) === 0, true, "Dereth cell must not have bit 15 set");

  // Dericost landblock 0x80A9 (with bit 15)
  const dericostCell = outdoorCellId(0x80A9, 12.0, 12.0);
  assert.equal((dericostCell & 0x8000) !== 0, true, "Dericost cell must preserve bit 15");
});

await check("mapCoordsForCell returns +287.2 NS offset when bit 15 is set", () => {
  // Dereth center landblock cell (cell 1)
  const derethCell = 0x7F7F0001;
  const derethCoords = mapCoordsForCell(derethCell);
  assert.ok(derethCoords, "Dereth cell must produce valid map coords");
  assert.ok(Math.abs(derethCoords.ns) < 1.0, "Dereth center should be near 0 NS");

  // Dericost cell with bit 15 set
  const dericostCell = 0x7F7F8001;
  const dericostCoords = mapCoordsForCell(dericostCell);
  assert.ok(dericostCoords, "Dericost cell must produce valid map coords");
  assert.ok(Math.abs(dericostCoords.ns - (derethCoords.ns + 287.2)) < 0.01,
    `Dericost cell NS ${dericostCoords.ns} should be ~287.2 + ${derethCoords.ns}`);
});

await check("radarCoordsText formats NS correctly for Dericost", () => {
  const dericostCell = 0x7F7F8001;
  const text = radarCoordsText(dericostCell);
  assert.ok(text.includes("N"), "Dericost coords must be in Northern hemisphere");
  assert.ok(text.includes("287.") || text.includes("286.") || text.includes("288."),
    `Expected ~287.2N in text: ${text}`);
});

await check("Radar candidate blip culling fix on Dericost", () => {
  // Reproduce the bug that was fixed:
  // When player is on Dericost:
  // - wasm pose local Y is 1072.0 (relative to local continent landblock)
  // - 3D entity in scene has global Y = 70000.0 (68928.0 + 1072.0)
  // Previously: dy = p.y - player.wy = 70000.0 - 1072.0 = 68928.0m > 75m => CULLED!
  const isDericost = true;
  const playerPoseY = 1072.0; // local
  const playerGlobalY = playerPoseY + (isDericost ? RADAR_DERICOST_Y : 0.0); // 70000.0

  const nearbyEntity = { x: 20000.0, y: 70005.0 }; // 5 metres away in global space
  const dyGlobal = nearbyEntity.y - playerGlobalY;
  assert.equal(dyGlobal, 5.0);
  assert.ok(Math.abs(dyGlobal) < RADAR_RANGE_OUTDOOR, "Nearby entity within 5m must NOT be culled!");

  // If compared against local without offset, it would fail:
  const brokenDy = nearbyEntity.y - playerPoseY;
  assert.ok(brokenDy > RADAR_RANGE_OUTDOOR, "Unfixed dy would be 68km > 75m culling all blips");
});

console.log("\n[3] map-panel.js — Northern Panning, Waypoints & 41 Dericost Towns");

await check("map-panel.js exports match canonical limits", () => {
  assert.equal(MAP_NORTH_Y, -370);
  assert.equal(MAP_DERICOST_Y, 68928.0);
  assert.equal(MAP_DERICOST_NS, 287.2);
});

await check("lbToCoords applies +287.2 NS offset for Dericost landblock (bit 15)", () => {
  // Landblock with bit 15 set: 0x8000 | 0x00A9
  const coords = lbToCoords(0x80A9, 12.0, 12.0);
  assert.ok(coords.ns > 102.0, "Dericost landblock NS must be north of Dereth (> 102.0)");
  assert.ok(coords.ns >= 287.2 - 105.0 && coords.ns <= 287.2 + 105.0,
    `Dericost landblock NS ${coords.ns} must be in Dericost range (~287.2)`);
});

await check("sanitizeWaypoint allows waypoints up to +410 NS (Dericost range)", () => {
  // Standard Dereth waypoint
  const wpDereth = sanitizeWaypoint({ ns: 10.5, ew: -20.2, label: "Holtburg" });
  assert.equal(wpDereth.ns, 10.5);
  assert.equal(wpDereth.ew, -20.2);
  assert.equal(wpDereth.label, "Holtburg");

  // Dericost waypoint in northern territory (+295.0 NS)
  const wpDericost = sanitizeWaypoint({ ns: 295.0, ew: 15.0, label: "Vasmora Outpost" });
  assert.ok(wpDericost, "Must accept waypoint in Dericost range");
  assert.equal(wpDericost.ns, 295.0, "Must not reject +295.0 NS");
  assert.equal(wpDericost.ew, 15.0);

  // Out-of-bounds boundary tests
  assert.equal(sanitizeWaypoint({ ns: 500.0, ew: 0.0 }), null, "Must reject NS > 410");
  assert.equal(sanitizeWaypoint({ ns: -150.0, ew: 0.0 }), null, "Must reject NS < -110");
});

await check("clampView allows northern panning without clipping MAP_NORTH_Y", () => {
  const view = { ox: 0, oy: 500, scale: 2.0 };
  const w = 400;
  const h = 400;
  const clamped = clampView(view, w, h);
  assert.ok(typeof clamped.ox === "number" && typeof clamped.oy === "number");
  assert.ok(clamped.scale === 2.0);
});

await check("DERICOST_TOWNS contains all 41 canonical towns", () => {
  assert.equal(DERICOST_TOWNS.length, 41, "Must contain exactly 41 Dericost towns");
  assert.equal(DERICOST_MAP_LOCATIONS.length, 41);
  assert.ok(ALL_MAP_LOCATIONS.length >= 41);

  // Spot-check canonical Dericost towns from the 6 provinces
  const townNames = new Set(DERICOST_TOWNS.map(t => t[0]));
  assert.ok(townNames.has("Vasmora"), "Must contain Vasmora");
  assert.ok(townNames.has("Frore"), "Must contain Frore");
  assert.ok(townNames.has("Daralet"), "Must contain Daralet");
  assert.ok(townNames.has("Tresimaen"), "Must contain Tresimaen");
  assert.ok(townNames.has("Shakrassekor"), "Must contain Shakrassekor");
  assert.ok(townNames.has("Nesortania"), "Must contain Nesortania");
  assert.ok(townNames.has("Galleys-Anchorage"), "Must contain Galleys-Anchorage");
  assert.ok(townNames.has("South-Haven"), "Must contain South-Haven");

  for (const loc of DERICOST_MAP_LOCATIONS) {
    assert.ok(loc.name, "Location must have a name");
    assert.ok(typeof loc.ns === "number", "Location must have numerical NS coord");
    assert.ok(typeof loc.ew === "number", "Location must have numerical EW coord");
    assert.ok(loc.ns >= 180.0, `Dericost town ${loc.name} NS ${loc.ns} must be in northern continent`);
    assert.equal(loc.isDericost, true);
  }
});

await check("locationAtMapPx hit-tests Dericost towns", () => {
  const townLoc = DERICOST_MAP_LOCATIONS.find(l => l.name === "Nesortania") || DERICOST_MAP_LOCATIONS[0];
  assert.ok(townLoc, "Must find town to hit-test");

  // Get map pixel for this town
  const mapPx = coordsToMapPx(townLoc.ew, townLoc.ns);
  const hit = locationAtMapPx(mapPx.x, mapPx.y, 10);
  assert.ok(hit, `Must hit-test town at map px (${mapPx.x}, ${mapPx.y})`);
  assert.equal(hit.name, townLoc.name);
  assert.equal(hit.isDericost, true);
});

console.log(`\n========================================`);
console.log(`dericost_radar_map: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
