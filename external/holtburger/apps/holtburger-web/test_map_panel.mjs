// Map panel — pure-maths + roster-pin tests.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_map_panel.mjs
//
// HUD rec #139 (2026-06-16): collectRosterMarkers — the pure cross-reference
// of roster guids against the live entityMap (+ a last-seen cache) that
// produces the fellow/allegiance map pins.
// HUD overhaul 2026-10-05: retail coordinate maths (gmMapUI::Update /
// PlaceMarkerOnMap), the s_rgLocations town table, indoor/outdoor fix
// resolution, heading → bearing, waypoint vectors, the Derethian calendar,
// and the expanded map's view maths (cursor-anchored zoom, fit, clamp,
// grid step, scale bar, label placement).
// A minimal DOM shim lets the real module import (no browser needed).

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {}, prepend() {} }, body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} } },
};

const M = await import("./plugins/map-panel.js");
const {
  collectRosterMarkers, lbToCoords, worldToCoords, coordsToWorld, formatCoords,
  coordsToMapPx, mapPxToCoords, MAP_MARKER_AREA, MAP_LOCATIONS, locationAtMapPx,
  isOutdoorCell, pickCell, classifyPlace, resolvePlayerFix, describeFix, readPlayerPose,
  headingToBearingDeg, bearingToCompass, waypointVector, formatDistance,
  zoomAt, fitView, centreView, clampView, toMapPx, toLocalPx, MAP_W, MAP_H,
  gridStep, scaleBarFor, placeLabels, sanitizeWaypoint, derethDateTime, mapIsCrisp,
  blipKindOf, blipColor, readRoster, DERETH_MONTHS, calendarFromHandle,
} = M;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertNear(a, e, tol, label) {
  if (!(Math.abs(a - e) <= tol)) throw new Error(`${label}: expected ${e} ±${tol}, got ${a}`);
}

const PLAYER = (x, y) => ({ root: { position: { x, y } }, meta: { objDescFlags: 0x08 } });
const NONPLAYER = (x, y) => ({ root: { position: { x, y } }, meta: { objDescFlags: 0x00 } });

console.log("===========================================================");
console.log("HUD rec #139 — fellow/allegiance map-pin projection");
console.log("===========================================================\n");

check("live PVS member → live marker at its AC coords", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const em = new Map([[0x5001, PLAYER(100, 200)]]);
  const out = collectRosterMarkers(roster, em, new Map(), 1000, 0);
  assertEq(out.length, 1, "count");
  assertEq([out[0].x, out[0].y, out[0].source, out[0].kind], [100, 200, "live", "fellow"], "marker");
});

check("local player guid is skipped (it has its own marker)", () => {
  const roster = new Map([[0x5003, { kind: "fellow", name: "Me" }]]);
  const em = new Map([[0x5003, PLAYER(1, 2)]]);
  assertEq(collectRosterMarkers(roster, em, new Map(), 1000, 0x5003), [], "skip-local");
});

check("member never seen (not in PVS, not cached) → omitted", () => {
  const roster = new Map([[0x5002, { kind: "alleg", name: "Bob" }]]);
  assertEq(collectRosterMarkers(roster, new Map(), new Map(), 1000, 0), [], "omit-unseen");
});

check("non-PLAYER entity at a roster guid is suppressed (collision guard)", () => {
  const roster = new Map([[0x5004, { kind: "fellow", name: "Item?" }]]);
  const em = new Map([[0x5004, NONPLAYER(5, 5)]]);
  assertEq(collectRosterMarkers(roster, em, new Map(), 1000, 0), [], "odf-guard");
});

check("member who left PVS recently → cached marker, faded by age", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const cache = new Map();
  collectRosterMarkers(roster, new Map([[0x5001, PLAYER(100, 200)]]), cache, 1000, 0);
  const out = collectRosterMarkers(roster, new Map(), cache, 1000 + 60_000, 0);
  assertEq([out.length, out[0].source, out[0].ageMs, out[0].x], [1, "cached", 60_000, 100], "cached");
});

check("cached position past staleMs TTL → omitted", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const cache = new Map([[0x5001, { x: 100, y: 200, ts: 0 }]]);
  assertEq(collectRosterMarkers(roster, new Map(), cache, 6 * 60_000, 0), [], "ttl");
});

check("allegiance members carry kind=alleg + live entity refreshes cache", () => {
  const roster = new Map([[0x5005, { kind: "alleg", name: "Patron" }]]);
  const cache = new Map();
  const out = collectRosterMarkers(roster, new Map([[0x5005, PLAYER(7, 8)]]), cache, 500, 0);
  assertEq(out[0].kind, "alleg", "kind");
  assertEq(cache.get(0x5005), { x: 7, y: 8, ts: 500 }, "cache-seed");
});

check("readRoster copies guid/name and frees every wasm box", () => {
  const freed = [];
  const box = (o, tag) => ({ ...o, free() { freed.push(tag); } });
  const handle = {
    playerFellowship: () => box({ members: [box({ guid: 0x5001, name: "Alice" }, "m1")] }, "fel"),
    playerAllegiance: () => box({ monarch: box({ guid: 0x5009, name: "King" }, "mon"), patron: undefined,
      myself: box({ guid: 0x5001, name: "Alice" }, "me"), vassals: [] }, "alg"),
  };
  const r = readRoster(handle);
  assertEq([...r.entries()], [[0x5001, { kind: "fellow", name: "Alice" }], [0x5009, { kind: "alleg", name: "King" }]], "roster");
  assertEq(freed.sort(), ["alg", "fel", "m1", "me", "mon"], "freed");
});

console.log("\n===========================================================");
console.log("HUD overhaul 2026-10-05 — coordinates (gmMapUI::Update)");
console.log("===========================================================\n");

check("test character LB 0xA9B4 (82.7, 8.8) = Holtburg 42.1N, 33.6E", () => {
  const c = lbToCoords(0xA9B40019, 82.7, 8.8);
  assertEq(formatCoords(c.ew, c.ns), "42.1N, 33.6E", "fmt");
});

check("world ↔ coords round-trip; origin 101.95 per 240 m", () => {
  const c = worldToCoords(0, 0);
  assertNear(c.ew, -101.95, 1e-9, "ew0");
  const w = coordsToWorld(33.6, 42.1);
  const back = worldToCoords(w.wx, w.wy);
  assertNear(back.ew, 33.6, 1e-9, "ew");
  assertNear(back.ns, 42.1, 1e-9, "ns");
});

check("formatCoords: NS first, sign from raw value, zero has no suffix", () => {
  assertEq(formatCoords(-89.8, 46.1), "46.1N, 89.8W", "NW");
  assertEq(formatCoords(13.2, -31.3), "31.3S, 13.2E", "SE");
  assertEq(formatCoords(0, 0), "0.0, 0.0", "zero");
  assertEq(formatCoords(0.04, -0.04), "0.0S, 0.0E", "tiny");
  assertEq(formatCoords(NaN, 1), "—", "nan");
});

check("PlaceMarkerOnMap formula: lcoord 0 → x0, lcoord 2048 → x1+1; NS inverted", () => {
  const a = MAP_MARKER_AREA;
  assertNear(coordsToMapPx(-102.4, 0).x, a.x0, 1e-9, "west edge");
  assertNear(coordsToMapPx(102.4, 0).x, a.x1 + 1, 1e-9, "east edge");
  assertNear(coordsToMapPx(0, 102.3).y, a.y0, 1e-9, "north edge");
  if (!(coordsToMapPx(0, 10).y < coordsToMapPx(0, -10).y)) throw new Error("north must be up");
});

check("mapPxToCoords inverts coordsToMapPx", () => {
  for (const [ew, ns] of [[33.6, 42.1], [-89.8, 46.1], [0.7, 13.5], [95.5, -87.5]]) {
    const p = coordsToMapPx(ew, ns);
    const c = mapPxToCoords(p.x, p.y);
    assertNear(c.ew, ew, 1e-9, `ew ${ew}`);
    assertNear(c.ns, ns, 1e-9, `ns ${ns}`);
  }
});

check("Holtburg landing point lands on the bitmap's Holtburg icon (retail rect)", () => {
  const p = coordsToMapPx(33.6, 42.1);
  // s_rgLocations Holtburg = {164, 77, 9, 8}
  if (p.x < 164 - 3 || p.x > 173 + 3 || p.y < 77 - 3 || p.y > 85 + 3) throw new Error(`(${p.x}, ${p.y}) off the icon`);
});

check("MAP_LOCATIONS: 53 retail notes; every Locations.txt landing point within 6.5 px of its icon", () => {
  assertEq(MAP_LOCATIONS.length, 53, "count");
  let exact = 0;
  for (const loc of MAP_LOCATIONS) {
    if (!loc.exact) continue;
    exact += 1;
    const p = coordsToMapPx(loc.ew, loc.ns);
    const d = Math.hypot(p.x - loc.cx, p.y - loc.cy);
    if (d > 6.5) throw new Error(`${loc.name} lands ${d.toFixed(1)} px from its icon`);
  }
  if (exact < 45) throw new Error(`only ${exact} exact entries`);
});

check("locationAtMapPx hits Holtburg's rect, misses open water", () => {
  assertEq(locationAtMapPx(168, 81)?.name, "Holtburg", "holtburg");
  assertEq(locationAtMapPx(3, 3), null, "corner");
});

check("town tiers: 9×8/7×6 icons are tier 1, 5×5 outposts tier 2", () => {
  const byName = Object.fromEntries(MAP_LOCATIONS.map((l) => [l.name, l]));
  assertEq([byName.Holtburg.tier, byName["Al-Arqas"].tier, byName.Stonehold.tier], [1, 1, 2], "tiers");
});

console.log("\n===========================================================");
console.log("Player fix — indoor/outdoor (SmartBox::is_player_outside)");
console.log("===========================================================\n");

check("isOutdoorCell: low word < 0x100", () => {
  assertEq([isOutdoorCell(0xA9B40019), isOutdoorCell(0xA9B40100), isOutdoorCell(0x01D90108)], [true, false, false], "cells");
});

check("pickCell: same LB → snapshot; stale outdoor pose vs indoor snapshot → snapshot", () => {
  assertEq(pickCell(0xA9B40019, 0xA9B40105), 0xA9B40105, "same-lb");
  assertEq(pickCell(0xA9B40019, 0x01D90108), 0x01D90108, "stale-pose");
  assertEq(pickCell(0xA9B40019, 0xA9B50001), 0xA9B40019, "lb-crossing lag");
  assertEq(pickCell(0xA9B40019, 0), 0xA9B40019, "no snapshot");
  assertEq(pickCell(0, 0x01D90108), 0x01D90108, "no pose cell");
});

check("classifyPlace: outdoor / building / dungeon / login-inside", () => {
  assertEq(classifyPlace(0xA9B40019), "outside", "out");
  assertEq(classifyPlace(0xA9B40105, { lastOutdoorLb: 0xA9B4 }), "indoors", "building");
  assertEq(classifyPlace(0x01D90108, { lastOutdoorLb: 0xA9B4, seenOutside: true }), "underground", "dungeon");
  assertEq(classifyPlace(0xA9B40105, { seenOutside: true }), "indoors", "login in building");
  assertEq(classifyPlace(0x01D90108), "underground", "login in dungeon");
  assertEq(classifyPlace(0), "unknown", "none");
});

check("resolvePlayerFix: outside → live + remembered; dungeon → last outdoor, not live", () => {
  const tracker = { lastOutdoor: null };
  const out = resolvePlayerFix({ x: 82.7, y: 8.8, heading: 0 }, 0xA9B40019, { tracker });
  assertEq([out.place, out.live, describeFix(out), out.bearing], ["outside", true, "42.1N, 33.6E", 0], "outside");
  const dun = resolvePlayerFix({ x: 30, y: -40, heading: 1 }, 0x01D90108, { tracker });
  assertEq([dun.place, dun.live, dun.bearing, describeFix(dun)], ["underground", false, null, "Underground (last: 42.1N, 33.6E)"], "dungeon");
  const bld = resolvePlayerFix({ x: 100, y: 20, heading: 0 }, 0xA9B40105, { tracker });
  assertEq([bld.place, bld.live, describeFix(bld)], ["indoors", true, "42.1N, 33.7E (indoors)"], "building");
  assertEq(describeFix(resolvePlayerFix(null, 0)), "—", "unknown");
  assertEq(describeFix(resolvePlayerFix({ x: 1, y: 1 }, 0x01D90108, { tracker: { lastOutdoor: null } })), "Underground", "no history");
});

check("readPlayerPose copies the wasm box then frees it", () => {
  let freed = 0;
  const handle = { getLocalPlayerPose: () => ({ landblockId: 0xA9B40019, x: 82.7, y: 8.8, z: 94, heading: 0.5, free() { freed += 1; } }) };
  const p = readPlayerPose(handle);
  assertEq([p.cell, p.x, p.y, p.heading, freed], [0xA9B40019, 82.7, 8.8, 0.5, 1], "pose");
  assertEq(readPlayerPose({ getLocalPlayerPose: () => undefined }), null, "none");
  assertEq(readPlayerPose(null), null, "no handle");
});

check("heading → compass bearing: θ CCW about +Z, forward (−sinθ, cosθ)", () => {
  assertNear(headingToBearingDeg(0), 0, 1e-9, "north");
  assertNear(headingToBearingDeg(-Math.PI / 2), 90, 1e-9, "east");
  assertNear(headingToBearingDeg(Math.PI / 2), 270, 1e-9, "west");
  assertNear(headingToBearingDeg(Math.PI), 180, 1e-9, "south");
  assertEq(headingToBearingDeg(NaN), null, "nan");
  assertEq([bearingToCompass(0), bearingToCompass(44), bearingToCompass(91), bearingToCompass(359)], ["N", "NE", "E", "N"], "compass");
});

check("waypointVector: distance in coords/metres + bearing", () => {
  const v = waypointVector({ ew: 10, ns: 10 }, { ew: 11, ns: 10 });
  assertNear(v.coords, 1, 1e-9, "coords");
  assertNear(v.metres, 240, 1e-9, "metres");
  assertNear(v.bearing, 90, 1e-9, "bearing");
  assertEq(v.compass, "E", "compass");
  assertEq(waypointVector({ ew: 0, ns: 0 }, { ew: -1, ns: -1 }).compass, "SW", "sw");
  assertEq([formatDistance(240), formatDistance(1234), formatDistance(25000)], ["240 m", "1.2 km", "25 km"], "fmt");
});

check("sanitizeWaypoint rejects junk and clamps labels", () => {
  assertEq(sanitizeWaypoint({ ew: 1, ns: 2, label: "x".repeat(60) })?.label.length, 48, "label clamp");
  assertEq(sanitizeWaypoint({ ew: "a", ns: 2 }), null, "nan");
  assertEq(sanitizeWaypoint({ ew: 500, ns: 2 }), null, "range");
  assertEq(sanitizeWaypoint(null), null, "null");
});

console.log("\n===========================================================");
console.log("Derethian calendar (GameTime::CalcDayBegin / ACE DerethDateTime)");
console.log("===========================================================\n");

check("ACE anchors: tick 1 = Morningthaw 1, 10 P.Y., Morntide-and-Half", () => {
  const d = derethDateTime(1);
  assertEq([d.date, d.time], ["Morningthaw 1, 10 P.Y.", "Morntide-and-Half"], "day zero");
});
check("ACE hourOneTicks 210 = Midsong", () => {
  assertEq(derethDateTime(209.9).time, "Morntide-and-Half", "before");
  assertEq(derethDateTime(210).time, "Midsong", "at");
});
check("ACE dayOneTicks 4020 = Morningthaw 2, Darktide", () => {
  const d = derethDateTime(4020);
  assertEq([d.date, d.time], ["Morningthaw 2, 10 P.Y.", "Darktide"], "day one");
});
check("ACE yearZeroTicks = Snowreap 1, 10 P.Y.; yearOneTicks = Morningthaw 1, 11 P.Y.", () => {
  assertEq(derethDateTime(4020 + 7620 * 269).date, "Snowreap 1, 10 P.Y.", "snowreap");
  assertEq(derethDateTime(4020 + 7620 * 359).date, "Morningthaw 1, 11 P.Y.", "year one");
});
check("calendar rejects pre-session 0, NaN and past ACE's MaxValue", () => {
  assertEq([derethDateTime(0), derethDateTime(NaN), derethDateTime(1073741829), derethDateTime(1.79e9)], [null, null, null, null], "invalid");
});
// daytime-3 (R2 2026-10-08): GetDateTimeString (acclient.c:463286) prints the
// DAT season name verbatim; Region 0x13000000 spells the 7th "HarvestGain".
check("season names are the Region DAT's (HarvestGain, not Harvestgain)", () => {
  assertEq(DERETH_MONTHS, [
    "Morningthaw", "Solclaim", "Seedsow", "Leafdawning", "Verdantine", "Thistledown",
    "HarvestGain", "Leafcull", "Frostfell", "Snowreap", "Coldeve", "Wintersebb",
  ], "all 12");
  assertEq(derethDateTime(4020 + 7620 * 179).date, "HarvestGain 1, 10 P.Y.", "day 180");
});
check("calendarFromHandle prefers the wasm GameTime port, same shape", () => {
  const calls = [];
  const handle = {
    derethCalendarAt(t) {
      calls.push(t);
      return {
        year: 10, dayOfYear: 180, seasonIndex: 6, seasonName: "HarvestGain", dayInSeason: 1,
        timeOfDayIndex: 0, presentTimeOfDay: 0, isNight: true,
        dateString: "HarvestGain 1, 10 P.Y.", timeString: "Darktide",
      };
    },
  };
  const d = calendarFromHandle(handle, 1368000);
  assertEq(calls, [1368000], "called once with the ticks");
  assertEq(d, {
    year: 10, month: "HarvestGain", day: 1, hour: "Darktide", hourIndex: 0, timeOfDay: 0,
    date: "HarvestGain 1, 10 P.Y.", time: "Darktide",
  }, "mapped");
  // With the retail tables the port and the fallback print the same strip.
  const fb = derethDateTime(1368000);
  assertEq([d.date, d.time], [fb.date, fb.time], "same strip text");
  // A Map-shaped record (serde-wasm-bindgen) reads the same.
  const m = calendarFromHandle({ derethCalendarAt: () => new Map(Object.entries(handle.derethCalendarAt(1368000))) }, 1368000);
  assertEq(m, d, "Map shape");
});
check("calendarFromHandle falls back to the hardcoded tables", () => {
  const fb = derethDateTime(210);
  assertEq(calendarFromHandle(null, 210), fb, "no handle");
  assertEq(calendarFromHandle({}, 210), fb, "stale pkg (no export)");
  assertEq(calendarFromHandle({ derethCalendarAt: () => undefined }, 210), fb, "sky not populated");
  assertEq(calendarFromHandle({ derethCalendarAt: () => { throw new Error("x"); } }, 210), fb, "throws");
  assertEq(calendarFromHandle({ derethCalendarAt: () => ({ dateString: 5 }) }, 210), fb, "malformed");
  let called = false;
  assertEq(calendarFromHandle({ derethCalendarAt: () => { called = true; return {}; } }, 0), null, "pre-session 0");
  assertEq(called, false, "invalid ticks never reach the wasm");
});

console.log("\n===========================================================");
console.log("Expanded map — view maths");
console.log("===========================================================\n");

check("zoomAt keeps the map point under the cursor fixed", () => {
  const v0 = { scale: 2, ox: 30, oy: -40 };
  const anchor = { x: 210, y: 155 };
  const before = toMapPx(v0, anchor.x, anchor.y);
  const v1 = zoomAt(v0, anchor.x, anchor.y, 7.5);
  const after = toMapPx(v1, anchor.x, anchor.y);
  assertNear(after.x, before.x, 1e-9, "x");
  assertNear(after.y, before.y, 1e-9, "y");
  assertEq(v1.scale, 7.5, "scale");
});

check("fitView centres the whole bitmap", () => {
  const v = fitView(800, 600, 1);
  const tl = toLocalPx(v, 0, 0);
  const br = toLocalPx(v, MAP_W, MAP_H);
  assertNear(tl.y, 0, 1e-9, "top");
  assertNear(br.y, 600, 1e-9, "bottom");
  assertNear((tl.x + br.x) / 2, 400, 1e-9, "centred");
});

check("centreView puts a map point at the viewport centre", () => {
  const v = centreView(6, 640, 480, 168, 81);
  const p = toLocalPx(v, 168, 81);
  assertEq([p.x, p.y], [320, 240], "centre");
});

check("clampView never loses the map off-screen", () => {
  const v = clampView({ scale: 4, ox: 5000, oy: -9000 }, 800, 600, 48);
  if (v.ox > 800 - 48 + 1e-9) throw new Error(`ox ${v.ox}`);
  if (v.oy + MAP_H * 4 < 48 - 1e-9) throw new Error(`oy ${v.oy}`);
  const ok = { scale: 4, ox: -100, oy: -100 };
  assertEq(clampView(ok, 800, 600, 48), ok, "in-range untouched");
});

check("gridStep / scaleBarFor pick round values that stay readable", () => {
  assertEq(gridStep(1.18 * 2.5), 20, "fit zoom");
  assertEq(gridStep(1.18 * 40), 2, "40x");
  assertEq(gridStep(1.18 * 64), 1, "max zoom");
  const sb = scaleBarFor(6);
  if (!(sb.px >= 48)) throw new Error(`bar ${sb.px}px`);
  assertEq(scaleBarFor(6).label, "2 km", "6x");
  assertEq(scaleBarFor(40).label, "250 m", "40x");
});

check("placeLabels: priority wins, overlaps and off-screen boxes dropped", () => {
  const items = [
    { x: 10, y: 10, w: 50, h: 14, priority: 2 },
    { x: 30, y: 12, w: 50, h: 14, priority: 1 },   // overlaps #0, higher priority
    { x: 200, y: 10, w: 50, h: 14, priority: 2 },
    { x: 790, y: 10, w: 50, h: 14, priority: 1 },  // off the right edge
  ];
  assertEq(placeLabels(items, 800, 600).sort(), [1, 2], "kept");
});

check("mapIsCrisp: nearest from 2 to 12 device px per map px, smooth outside", () => {
  assertEq([mapIsCrisp(1.25), mapIsCrisp(1.5), mapIsCrisp(2), mapIsCrisp(10), mapIsCrisp(12), mapIsCrisp(80)], [false, false, true, true, false, false], "crisp");
});

check("blip classification mirrors gmRadarUI (ShowNever hidden, colour override)", () => {
  assertEq(blipKindOf("Creature", {}), "creature", "wo class");
  assertEq(blipKindOf(null, { objDescFlags: 0x08 }), "player", "odf player");
  assertEq(blipKindOf("Creature", { radarBehavior: 1 }), null, "show never");
  assertEq(blipKindOf(null, {}), null, "item");
  assertEq([blipColor("creature", 0), blipColor("creature", 0x04)], ["#FFAB00", "#BF63FF"], "colours");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
