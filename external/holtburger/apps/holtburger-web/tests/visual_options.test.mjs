// tests/visual_options.test.mjs — "Disable most weather effects" (CharacterOption 0x04) and
// "Disable distance fog" (0x30), 2026-10-11. Both checkboxes only reached the server: nothing in
// the renderer read either bit (owner-bugs handoff, "Still open").
//   V1  the option bits come from the session (0x04 / 0x30), re-read at most every 250 ms, and an
//       unreadable session reads off
//   V2  weather off drops exactly the SkyObjects retail never creates (properties 0x04: the
//       streaks 0x04 / 0x05 and the rain/snow SetupModels 0x0D); cloud bands stay
//   V3  with them dropped the storm scan finds no storm, and an EMPTY snapshot would fall back to
//       the per-DayGroup table's storm — which is why loop.js forces is_storm off as well
//   V4  fog off pushes a linear fog's band out of reach; a FogExp2 is left alone
//   V5  loop.js reads both options where the weather and the fog are applied
//   V6  `?weatherOption=off` / `?distanceFogOption=off` make the checkboxes inert again
//
// Run from apps/holtburger-web/:  node tests/visual_options.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };

const vo = await import("../scene3d/visual_options.js");
const { weatherForState, getProfiles } = await import("../scene3d/daygroup_weather.js");

function session(bits) {
  const calls = [];
  return {
    calls,
    isCharacterOptionEnabled(idx) { calls.push(idx); return !!bits[idx]; },
  };
}

test("V1: the bits come from the session, polled at most every VISUAL_OPTIONS_POLL_MS", () => {
  vo._resetVisualOptionsForTest();
  const h = session({ 0x04: true, 0x30: false });
  let s = vo.readVisualOptions(h, 1000);
  assert.equal(s.weatherOff, true);
  assert.equal(s.fogOff, false);
  assert.deepEqual(h.calls.sort(), [0x04, 0x30]);
  vo.readVisualOptions(h, 1000 + vo.VISUAL_OPTIONS_POLL_MS - 1);
  assert.equal(h.calls.length, 2, "no re-read inside the poll window");
  const h2 = session({ 0x30: true });
  s = vo.readVisualOptions(h2, 1000 + vo.VISUAL_OPTIONS_POLL_MS);
  assert.equal(s.weatherOff, false);
  assert.equal(s.fogOff, true);
  assert.equal(vo.readCharacterOption({ isCharacterOptionEnabled() { throw new Error("freed"); } }, 0x30), false);
  assert.equal(vo.readCharacterOption(null, 0x30), false);
  globalThis.window.__sessionHandle = session({ 0x04: true });
  assert.equal(vo.readVisualOptions(null, 9e9).weatherOff, true, "defaults to window.__sessionHandle");
  delete globalThis.window.__sessionHandle;
  vo._resetVisualOptionsForTest();
});

const sky = (properties, gfxObjectId, pesObjectId = 0) => ({ visible: true, properties, gfxObjectId, pesObjectId });
const CLOUDS = sky(0x02, 0x010015b6);
const STREAK = sky(0x04, 0x01004c42);
const STREAK2 = sky(0x05, 0x01004c44);
const RAIN = sky(0x0d, 0x02000588, 0x33000428);

test("V2: weather off drops the 0x04 SkyObjects and keeps the cloud bands", () => {
  const kept = vo.dropWeatherSkyObjects([CLOUDS, STREAK, STREAK2, RAIN, sky(0, 0x01001234)]);
  assert.deepEqual(kept, [CLOUDS, sky(0, 0x01001234)]);
  assert.equal(vo.dropWeatherSkyObjects(null), null);
  const bad = { get properties() { throw new Error("freed"); } };
  assert.deepEqual(vo.dropWeatherSkyObjects([bad]), [bad], "an unreadable entry is left to the scan's guard");
});

test("V3: no storm once the weather objects are gone; an empty snapshot falls back to the table", () => {
  const state = { dayGroupIndex: 0 };
  assert.equal(weatherForState(state, 0, [CLOUDS, STREAK]).is_storm, true, "the streak is a storm");
  assert.equal(weatherForState(state, 0, vo.dropWeatherSkyObjects([CLOUDS, STREAK])).is_storm, false);
  const stormy = getProfiles().findIndex((p) => p.is_storm);
  assert.ok(stormy >= 0, "some DayGroup profile storms in the table");
  assert.equal(weatherForState(state, stormy, vo.dropWeatherSkyObjects([STREAK, RAIN])).is_storm, true,
    "an empty snapshot keeps the table storm, so loop.js must force it off");
});

test("V4: fog off pushes a linear fog's band out of reach; FogExp2 is untouched", () => {
  const fog = { isFog: true, near: 150, far: 1000 };
  assert.equal(vo.disableFogBand(fog), true);
  assert.equal(fog.near, vo.FOG_DISABLED_NEAR_M);
  assert.equal(fog.far, vo.FOG_DISABLED_FAR_M);
  assert.ok(fog.far > fog.near && fog.near >= 1e6);
  const exp2 = { isFogExp2: true, density: 0.002 };
  assert.equal(vo.disableFogBand(exp2), false);
  assert.equal(exp2.density, 0.002);
  assert.equal(vo.disableFogBand(null), false);
});

test("V5: loop.js applies both options where the weather and the fog are applied", () => {
  const loop = readFileSync(new URL("../scene3d/loop.js", import.meta.url), "utf8");
  assert.ok(loop.includes('import { readVisualOptions, dropWeatherSkyObjects, disableFogBand } from "./visual_options.js";'));
  const wx = loop.slice(loop.indexOf("function tickWeatherState("), loop.indexOf("function tickWeatherState(") + 4000);
  const drop = wx.indexOf("if (weatherOff) skyObjects = dropWeatherSkyObjects(skyObjects);");
  assert.ok(drop > 0 && drop < wx.indexOf("weatherForState(state, state.dayGroupIndex, skyObjects)"),
    "dropped before the storm scan");
  assert.ok(wx.indexOf("if (weatherOff && profile?.is_storm) profile = { ...profile, is_storm: false };") <
    wx.indexOf("wxUpdateFromDayGroup(profile);"), "storm forced off before the weather state");
  assert.ok(wx.indexOf("dropWeatherSkyObjects") < wx.indexOf("updateWeatherSkyObjects(skyObjects, indoor)"),
    "the sky-dome hosts see the filtered snapshot");
  const fog = loop.slice(loop.indexOf("function tickDistanceFogColor("), loop.indexOf("function tickDistanceFogColor(") + 3000);
  const off = fog.indexOf("if (readVisualOptions(null, performance.now()).fogOff) {");
  assert.ok(off > 0 && off < fog.indexOf("window.__environFogOverride"), "fog off wins over the environ override");
  assert.ok(fog.includes("disableFogBand(scene.fog);"));
});

test("V6: ?weatherOption=off / ?distanceFogOption=off make the checkboxes inert", async () => {
  globalThis.window.location = { search: "?weatherOption=off&distanceFogOption=off" };
  try {
    const inert = await import("../scene3d/visual_options.js?inert");
    const s = inert.readVisualOptions(session({ 0x04: true, 0x30: true }), 1);
    assert.equal(s.weatherOff, false);
    assert.equal(s.fogOff, false);
  } finally {
    globalThis.window.location = { search: "" };
  }
});
