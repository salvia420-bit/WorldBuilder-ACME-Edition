// tests/daygroup_weather_scan.test.mjs — sky-fog-time-1 (2026-10-13). The storm scan
// (scene3d/daygroup_weather.js `scanWeatherSkyObjects`) counted any visible SetupModel with a
// non-zero PES as rain droplets. The moon proxy (Setup 0x02000714, PES 0x330007DB, props 0x00,
// begin == end == 0 → always visible) sits in all 20 retail DayGroups, so every DayGroup read
// as a storm. Retail's weather test is `properties & 0x04` alone (GameSky::MakeObject /
// GameSky::Draw, acclient.c:308427 / :308475). The retail rule is the DEFAULT since 2026-10-17
// (owner); `?stormScan=legacy` (or off/0/false/no) keeps the legacy scan byte-identical.
//   S1  no flag / any other value selects the retail rule; legacy/off/0/false/no is legacy
//   S2  the legacy scan is unchanged: the moon alone still scans as a storm with
//       droplets, and a 0x0D Setup is still the first "streak"
//   S3  retail: the moon alone, and a Sunny-like DayGroup set, are not a storm
//   S4  retail: a streak (0x04 / 0x05) is a storm with its GfxObj as streak_gfx_id; a 0x0D rain
//       Setup is a storm with droplets and no streak id
//   S5  retail: invisible weather objects, nulls, unreadable entries and non-arrays are skipped
//   S6  retail: "weather off" (visual_options.js dropWeatherSkyObjects) and "no storm" agree
//   S7  weatherForState on the default (retail) module: a Sunny-like set is not a storm even on
//       a DayGroup whose table profile storms; a fresh `?stormScan=legacy` module still storms
//
// Run from apps/holtburger-web/:  node tests/daygroup_weather_scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };

const dw = await import("../scene3d/daygroup_weather.js");
const { dropWeatherSkyObjects } = await import("../scene3d/visual_options.js");
const { scanWeatherSkyObjects, stormScanMode, STORM_SCAN_MODE, STORM_SCAN_LEGACY, STORM_SCAN_RETAIL } = dw;

const sky = (properties, gfxObjectId, pesObjectId = 0, visible = true) =>
  ({ visible, properties, gfxObjectId, pesObjectId });

// Real retail ids (sky.rs / sky_glow.js probes): the moon proxy, the cloud band, the two
// streaks and the rain Setup. The props-0x00 GfxObjs stand in for shell / sun / moon / stars.
const MOON = sky(0x00, 0x02000714, 0x330007db);
const CLOUDS = sky(0x02, 0x010015b6);
const STREAK = sky(0x04, 0x01004c42);
const STREAK2 = sky(0x05, 0x01004c44);
const RAIN = sky(0x0d, 0x02000588, 0x33000428);
const SUNNY_LIKE = [
  sky(0x00, 0x010015ee), // sky shell
  sky(0x00, 0x010015ef), // sky shell
  sky(0x00, 0x01001f67), // sun
  sky(0x00, 0x01001f68), // moon GfxObj
  sky(0x00, 0x01001f69), // stars
  CLOUDS,
  MOON,
];
const NONE = { is_storm: false, has_droplets: false, streak_gfx_id: 0 };

test("S1: the retail rule is the default; legacy/off/0/false/no keep the legacy scan", () => {
  assert.equal(STORM_SCAN_MODE, STORM_SCAN_RETAIL, "no URL flag → retail");
  for (const s of ["", "?stormScan=retail", "stormScan=retail&clouds=on", "?stormScan=on", "?stormScan=RETAIL", "?stormScan=1", "?clouds=on"]) {
    assert.equal(stormScanMode(s), STORM_SCAN_RETAIL, s);
  }
  for (const s of ["?stormScan=legacy", "?stormScan=LEGACY", "?stormScan=off", "?stormScan=0", "?stormScan=false", "?stormScan=no"]) {
    assert.equal(stormScanMode(s), STORM_SCAN_LEGACY, s);
  }
  const saved = globalThis.window.location;
  try {
    globalThis.window.location = { search: "?stormScan=legacy" };
    assert.equal(stormScanMode(), STORM_SCAN_LEGACY, "defaults to the page URL");
    globalThis.window.location = null;
    assert.equal(stormScanMode(), STORM_SCAN_RETAIL, "no location → retail");
  } finally {
    globalThis.window.location = saved;
  }
});

test("S2: the legacy scan is unchanged", () => {
  assert.deepEqual(scanWeatherSkyObjects([MOON], STORM_SCAN_LEGACY), { is_storm: true, has_droplets: true, streak_gfx_id: 0 },
    "legacy still reads the moon proxy as rain droplets");
  assert.deepEqual(scanWeatherSkyObjects(SUNNY_LIKE, STORM_SCAN_LEGACY).is_storm, true);
  assert.deepEqual(scanWeatherSkyObjects([RAIN, STREAK], STORM_SCAN_LEGACY),
    { is_storm: true, has_droplets: true, streak_gfx_id: 0x02000588 }, "a 0x0D Setup is still the first streak");
  assert.deepEqual(scanWeatherSkyObjects([CLOUDS, sky(0x08, 0x01001234)], STORM_SCAN_LEGACY), NONE);
  for (const set of [[MOON], SUNNY_LIKE, [RAIN, STREAK], [CLOUDS, STREAK2], [sky(0x04, 0x01004c42, 0, false)]]) {
    assert.deepEqual(scanWeatherSkyObjects(set), scanWeatherSkyObjects(set, STORM_SCAN_RETAIL), "the default is the retail scan");
  }
});

test("S3: retail — the moon proxy and a Sunny-like set are not a storm", () => {
  assert.deepEqual(scanWeatherSkyObjects([MOON], STORM_SCAN_RETAIL), NONE);
  assert.deepEqual(scanWeatherSkyObjects(SUNNY_LIKE, STORM_SCAN_RETAIL), NONE);
  assert.deepEqual(scanWeatherSkyObjects([CLOUDS, sky(0x08, 0x02000999, 0x33000001)], STORM_SCAN_RETAIL), NONE,
    "a PES or the 0x08 bit without 0x04 is not weather");
});

test("S4: retail — streaks and rain Setups are storms", () => {
  assert.deepEqual(scanWeatherSkyObjects([MOON, STREAK], STORM_SCAN_RETAIL),
    { is_storm: true, has_droplets: false, streak_gfx_id: 0x01004c42 });
  assert.deepEqual(scanWeatherSkyObjects([MOON, STREAK2, STREAK], STORM_SCAN_RETAIL),
    { is_storm: true, has_droplets: false, streak_gfx_id: 0x01004c44 }, "the first streak wins");
  assert.deepEqual(scanWeatherSkyObjects([MOON, RAIN], STORM_SCAN_RETAIL),
    { is_storm: true, has_droplets: true, streak_gfx_id: 0 });
  assert.deepEqual(scanWeatherSkyObjects([RAIN, MOON, CLOUDS, STREAK], STORM_SCAN_RETAIL),
    { is_storm: true, has_droplets: true, streak_gfx_id: 0x01004c42 }, "a Setup is never the streak id");
});

test("S5: retail — invisible, null and unreadable entries are skipped", () => {
  assert.deepEqual(scanWeatherSkyObjects([sky(0x04, 0x01004c42, 0, false)], STORM_SCAN_RETAIL), NONE);
  assert.deepEqual(scanWeatherSkyObjects([sky(0x0d, 0x02000588, 0x33000428, false), MOON], STORM_SCAN_RETAIL), NONE);
  const freed = { get visible() { throw new Error("null pointer passed to rust"); } };
  assert.deepEqual(scanWeatherSkyObjects([null, freed, MOON], STORM_SCAN_RETAIL), NONE);
  assert.deepEqual(scanWeatherSkyObjects([null, freed, STREAK], STORM_SCAN_RETAIL).is_storm, true);
  assert.deepEqual(scanWeatherSkyObjects(null, STORM_SCAN_RETAIL), NONE);
  assert.deepEqual(scanWeatherSkyObjects([], STORM_SCAN_RETAIL), NONE);
});

test("S6: retail — dropping the weather objects always leaves no storm", () => {
  for (const set of [[MOON], SUNNY_LIKE, [MOON, STREAK], [MOON, RAIN], [CLOUDS, STREAK2, RAIN, MOON]]) {
    assert.equal(scanWeatherSkyObjects(dropWeatherSkyObjects(set), STORM_SCAN_RETAIL).is_storm, false);
  }
});

test("S7: weatherForState on the default (retail) module; ?stormScan=legacy still storms", async () => {
  const stormy = dw.getProfiles().findIndex((p) => p.is_storm);
  assert.ok(stormy >= 0, "some DayGroup profile storms in the table");
  const state = { dayGroupIndex: stormy };
  assert.equal(dw.STORM_SCAN_MODE, STORM_SCAN_RETAIL);
  const sunny = dw.weatherForState(state, stormy, SUNNY_LIKE);
  assert.equal(sunny.is_storm, false, "the scan replaces the table storm");
  assert.deepEqual(sunny._weather, NONE);
  assert.equal(sunny.name, dw.getProfiles()[stormy].name, "T/Td/P profile kept");
  assert.equal(dw.weatherForState({ dayGroupIndex: 0 }, 0, [...SUNNY_LIKE, RAIN]).is_storm, true);
  const streak = dw.weatherForState({ dayGroupIndex: 0 }, 0, [MOON, STREAK]);
  assert.equal(streak.is_storm, true);
  assert.equal(streak._weather.streak_gfx_id, 0x01004c42);
  assert.equal(dw.weatherForState(state, stormy, []).is_storm, true, "an empty snapshot keeps the table");

  const saved = globalThis.window.location;
  globalThis.window.location = { search: "?stormScan=legacy" };
  try {
    const legacy = await import("../scene3d/daygroup_weather.js?stormScanLegacy");
    assert.equal(legacy.STORM_SCAN_MODE, STORM_SCAN_LEGACY);
    assert.equal(legacy.weatherForState(state, stormy, SUNNY_LIKE).is_storm, true, "legacy scan");
    assert.equal(legacy.weatherForState(state, 0, [MOON]).is_storm, true, "legacy scan");
  } finally {
    globalThis.window.location = saved;
  }
});
