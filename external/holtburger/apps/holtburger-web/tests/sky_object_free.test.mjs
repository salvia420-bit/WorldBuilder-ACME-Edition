// tests/sky_object_free.test.mjs — sky-fog-time-5 (2026-10-13). The weather tick
// (loop.js `tickWeatherState`) pulled `getSkyObjectStates()` every sky tick and never
// freed the ~7 wasm SkyObjectState wrappers it returned; they waited for the
// FinalizationRegistry after a GC.
//   F1  a mock handle's array is freed entry by entry: free() count === array length
//   F2  plain entries, nulls and non-arrays are skipped; a throwing (already freed) free
//       never escapes
//   F3  the weather-off filter shares wrappers, so freeing the ORIGINAL array frees each
//       wrapper exactly once
//   F4  nothing in the tick keeps a wrapper: the storm scan's result is plain data that
//       stays readable after the wrappers are freed (freed wrappers throw, as wasm's do)
//   F5  `?skyObjFree=off` / `0` / `false` disable it; default on
//   F6  loop.js calls getSkyObjectStates once and frees that array in a `finally` after
//       both sky-dome hosts ran; getSkyState / getSkyObjectStates are untouched
//
// Run from apps/holtburger-web/:  node tests/sky_object_free.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };

const { freeSkyObjectStates, skyObjectFreeEnabled, SKY_OBJECT_FREE_ENABLED } =
  await import("../scene3d/sky_object_free.js");
const { dropWeatherSkyObjects } = await import("../scene3d/visual_options.js");
const { weatherForState } = await import("../scene3d/daygroup_weather.js");

/**
 * A stand-in for a wasm-bindgen SkyObjectState: getters read the "heap" and throw once
 * the wrapper is freed (wasm-bindgen throws "null pointer passed to rust"), and a second
 * free throws too.
 */
function wrapper(fields, log) {
  let ptr = 1;
  const read = (k) => {
    if (ptr === 0) throw new Error("null pointer passed to rust");
    return fields[k];
  };
  return {
    get visible() { return read("visible"); },
    get properties() { return read("properties"); },
    get gfxObjectId() { return read("gfxObjectId"); },
    get pesObjectId() { return read("pesObjectId"); },
    get texOffsetX() { return read("texOffsetX"); },
    get texOffsetY() { return read("texOffsetY"); },
    get freed() { return ptr === 0; },
    free() {
      if (ptr === 0) throw new Error("null pointer passed to rust");
      ptr = 0;
      log.push(fields.gfxObjectId);
    },
  };
}

const SUNNY = [
  { visible: true, properties: 0x00, gfxObjectId: 0x010015ee, pesObjectId: 0 },   // sky shell
  { visible: true, properties: 0x00, gfxObjectId: 0x01001f67, pesObjectId: 0 },   // sun
  { visible: true, properties: 0x02, gfxObjectId: 0x010015b6, pesObjectId: 0 },   // cloud band
  { visible: true, properties: 0x04, gfxObjectId: 0x01004c42, pesObjectId: 0 },   // streak
  { visible: true, properties: 0x0d, gfxObjectId: 0x02000588, pesObjectId: 0x33000428 }, // rain
];

function mockHandle(rows) {
  const log = [];
  let calls = 0;
  return {
    log,
    get calls() { return calls; },
    getSkyObjectStates() {
      calls += 1;
      return rows.map((r) => wrapper({ texOffsetX: 0, texOffsetY: 0, ...r }, log));
    },
  };
}

test("F1: every wrapper a mock handle returns is freed once", () => {
  const h = mockHandle(SUNNY);
  const arr = h.getSkyObjectStates();
  assert.equal(freeSkyObjectStates(arr), arr.length);
  assert.equal(h.log.length, arr.length, "free() count equals the array length");
  assert.ok(arr.every((o) => o.freed));
  assert.deepEqual(h.log, SUNNY.map((r) => r.gfxObjectId));
});

test("F2: plain entries, nulls and non-arrays are skipped; a throwing free never escapes", () => {
  assert.equal(freeSkyObjectStates(null), 0);
  assert.equal(freeSkyObjectStates(undefined), 0);
  assert.equal(freeSkyObjectStates({ length: 3 }), 0);
  assert.equal(freeSkyObjectStates([]), 0);
  const log = [];
  const w = wrapper({ gfxObjectId: 1 }, log);
  w.free(); // already freed: a second free throws in wasm-bindgen
  const plain = { visible: true, properties: 0 };
  assert.doesNotThrow(() => freeSkyObjectStates([null, plain, w, undefined]));
  assert.equal(freeSkyObjectStates([null, plain, w]), 0);
  const fresh = wrapper({ gfxObjectId: 2 }, log);
  assert.equal(freeSkyObjectStates([plain, fresh, null]), 1);
  assert.deepEqual(log, [1, 2]);
});

test("F3: the weather-off filter shares wrappers; freeing the original frees each once", () => {
  const h = mockHandle(SUNNY);
  const fetched = h.getSkyObjectStates();
  const filtered = dropWeatherSkyObjects(fetched);
  assert.ok(filtered.length < fetched.length, "the filter drops the 0x04 objects");
  assert.ok(filtered.every((o) => fetched.includes(o)), "same wrapper objects, not copies");
  assert.equal(freeSkyObjectStates(fetched), fetched.length);
  assert.equal(h.log.length, fetched.length, "no wrapper freed twice");
  assert.equal(new Set(h.log).size, h.log.length);
  assert.equal(freeSkyObjectStates(filtered), 0, "a second pass over the copy frees nothing");
});

test("F4: the storm scan keeps no wrapper — its result survives the free", () => {
  const h = mockHandle(SUNNY);
  const fetched = h.getSkyObjectStates();
  const profile = weatherForState({ dayGroupIndex: 0 }, 0, fetched);
  const before = JSON.stringify(profile);
  freeSkyObjectStates(fetched);
  assert.equal(JSON.stringify(profile), before, "profile and _weather are plain data");
  assert.equal(profile.is_storm, true);
  assert.equal(profile._weather.streak_gfx_id, 0x01004c42);
  assert.throws(() => fetched[0].visible, /null pointer/, "a freed wrapper cannot be read");
});

test("F5: ?skyObjFree=off / 0 / false disable it; default on", () => {
  assert.equal(SKY_OBJECT_FREE_ENABLED, true, "no URL flag → on");
  assert.equal(skyObjectFreeEnabled(""), true);
  assert.equal(skyObjectFreeEnabled("?skyObjFree=on"), true);
  assert.equal(skyObjectFreeEnabled("?skyObjFree=1"), true);
  for (const v of ["off", "0", "false"]) {
    assert.equal(skyObjectFreeEnabled(`?skyObjFree=${v}`), false, v);
  }
  assert.equal(skyObjectFreeEnabled("?other=off"), true);
});

test("F6: loop.js pulls the array once and frees it in a finally after both hosts", () => {
  const loop = readFileSync(new URL("../scene3d/loop.js", import.meta.url), "utf8");
  assert.ok(loop.includes('import { freeSkyObjectStates, SKY_OBJECT_FREE_ENABLED } from "./sky_object_free.js";'));
  const start = loop.indexOf("function tickWeatherState(");
  assert.ok(start > 0);
  const end = loop.indexOf("\n}\n", start);
  const fn = loop.slice(start, end);
  assert.equal(fn.split("getSkyObjectStates()").length - 1, 1, "one evaluation per tick");
  const fetchAt = fn.indexOf("skyObjects = handle.getSkyObjectStates();");
  const capture = fn.indexOf("const fetched = skyObjects;");
  const drop = fn.indexOf("if (weatherOff) skyObjects = dropWeatherSkyObjects(skyObjects);");
  const birds = fn.indexOf("updateSkyParticleChains(skyObjects, scene3d.wasmExports)");
  const billboard = fn.indexOf("updateWeatherSkyObjects(skyObjects, indoor)");
  const fin = fn.indexOf("} finally {");
  const free = fn.indexOf("if (SKY_OBJECT_FREE_ENABLED) freeSkyObjectStates(fetched);");
  assert.ok(fetchAt > 0 && fetchAt < capture, "the original array is captured after the fetch");
  assert.ok(capture < drop, "…and before the weather-off filter replaces it");
  assert.ok(billboard > 0 && birds > billboard && fin > birds, "the finally follows both hosts");
  assert.ok(free > fin, "the free sits in the finally");
  assert.equal(fn.split("freeSkyObjectStates(").length - 1, 1, "freed exactly once");
});

test("F6b: the rynth-visible exports keep their names and shapes", () => {
  const lib = readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8");
  assert.ok(lib.includes("#[wasm_bindgen(js_name = getSkyState)]\n    pub fn get_sky_state(&self) -> Option<SkyState> {"));
  assert.ok(lib.includes("#[wasm_bindgen(js_name = getSkyObjectStates)]\n    pub fn get_sky_object_states(&self) -> Vec<SkyObjectState> {"));
  const webhost = readFileSync(new URL("../rynth/webhost.js", import.meta.url), "utf8");
  assert.ok(webhost.includes('GetSkyObjectStates: ["getSkyObjectStates"]'));
});
