// tests/retail_light_tick.test.mjs
//
// sky-fog-time-4 — ONE landscape light clock, reset by LScape::SetDay.
// Retail: LScape::UseTime (acclient.c:307222) re-lights the landscape only
// when LScape::next_light_tick expires (Dereth: 15 s), and LScape::SetDay
// (acclient.c:306897; the Always-Daylight option at login :452816 and on every
// option change :452974) zeroes it so the very next frame re-lights. holtburger
// had two private 15 s timers (loop.js terrain Gouraud, terrain_rock.js
// pebbles) on unrelated phases, never reset when always_daylight.js pinned or
// unpinned the sky, so the ground kept the old light for up to 15 s.
//
//   L1  due() fires once per 15 s on the clock it was given.
//   L2  reset() fires only once the sky snapshot's _tickCount has advanced
//       past its value at (or just after) the reset; the 15 s deadline keeps
//       running meanwhile and does not consume a pending reset.
//   L3  createAlwaysDaylight resets the clock exactly on the applied pin edges
//       (pin, unpin), never on the per-poll re-asserts; ?lightTickReset=off
//       skips the reset and leaves the pin behaviour unchanged.
//   L4  terrain (loop.js tickTerrainSunDir) and pebbles (terrain_rock.js)
//       driven by one clock in loop.js frame order report equal epochs from
//       the same SkyState, and a SetDay reset re-lights both from the
//       POST-pin sky on the next frame.
//   L5  wiring.
//
// Run: node tests/retail_light_tick.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// Import loop.js BEFORE anything installs a window stub so its module-scope
// URL-flag reads take their node fail-soft branches.
const { tickTerrainSunDir } = await import("../scene3d/loop.js");
const {
  RETAIL_LIGHT_TICK_SEC,
  createRetailLightTick,
  retailLightTick,
  lightTickResetEnabled,
} = await import("../scene3d/retail_light_tick.js");
const { createAlwaysDaylight, ALWAYS_DAYLIGHT_OPTION, ALWAYS_DAYLIGHT_POLL_MS } =
  await import("../scene3d/always_daylight.js");
const { createPebbleField, ROCK_LIGHT_TICK_SEC } = await import("../scene3d/terrain_rock.js");
const { familyForCode } = await import("../scene3d/terrain_families.js");

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A clock on a test-controlled time. */
function testClock() {
  const c = { t: 0 };
  c.tick = createRetailLightTick({ now: () => c.t });
  return c;
}

console.log("L1 — the 15 s cadence");
check("the retail tick is Dereth's 15 s, and the pebbles use it", () => {
  assert(RETAIL_LIGHT_TICK_SEC === 15, `tick ${RETAIL_LIGHT_TICK_SEC}`);
  assert(ROCK_LIGHT_TICK_SEC === RETAIL_LIGHT_TICK_SEC, "terrain_rock re-exports the same tick");
});
check("due() fires on the first call, then once per 15 s", () => {
  const c = testClock();
  const fires = [];
  for (let i = 0; i < 60 * 60; i += 1) { // 60 s of 60 Hz frames
    c.t = i / 60;
    if (c.tick.due(i)) fires.push(c.t);
  }
  assert(fires.length === 4, `fires ${JSON.stringify(fires)}`);
  assert(fires[0] === 0, "first call fires");
  for (let k = 1; k < fires.length; k += 1) {
    const gap = fires[k] - fires[k - 1];
    assert(gap >= 15 && gap < 15 + 1 / 30, `gap ${gap}`);
  }
  assert(c.tick.epoch === 4 && c.tick.stats().fires === 4, JSON.stringify(c.tick.stats()));
});
check("sync() returns the epoch and advances it only when due", () => {
  const c = testClock();
  assert(c.tick.sync(0) === 1, "first sync advances to 1");
  c.t = 7;
  assert(c.tick.sync(1) === 1, "mid-tick: unchanged");
  c.t = 15;
  assert(c.tick.sync(2) === 2, "deadline: advanced");
});
check("a non-finite clock reads as 0 (never fires every frame)", () => {
  const tick = createRetailLightTick({ now: () => NaN });
  assert(tick.due() === true, "first fires");
  assert(tick.due() === false && tick.due() === false, "then holds");
});

console.log("L2 — reset (LScape::SetDay)");
check("reset() waits for the sky snapshot to advance, then fires once", () => {
  const c = testClock();
  c.tick.due(10); // fires at t=0
  c.t = 5;
  c.tick.reset();
  assert(c.tick.due(10) === false, "first post-reset frame only captures the stamp");
  assert(c.tick.due(10) === false, "same snapshot: still waiting");
  assert(c.tick.due(11) === true, "a newer snapshot fires");
  assert(c.tick.epoch === 2, `epoch ${c.tick.epoch}`);
  assert(c.tick.due(12) === false, "fires once, then the 15 s cadence resumes");
  c.t = 5 + 15;
  assert(c.tick.due(13) === true, "next deadline 15 s after the reset fire");
});
check("reset(stateTick) gates on the given stamp", () => {
  const c = testClock();
  c.tick.due(0);
  c.t = 3;
  c.tick.reset(20);
  assert(c.tick.due(20) === false, "same stamp");
  assert(c.tick.due(21) === true, "newer stamp");
});
check("a caller without a stamp keeps the cadence but cannot satisfy a reset", () => {
  const c = testClock();
  c.tick.due();
  c.t = 2;
  c.tick.reset();
  assert(c.tick.due() === false && c.tick.due(undefined) === false, "no stamp: no reset fire");
  c.t = 15;
  assert(c.tick.due() === true, "the deadline still fires (no wedge)");
  assert(c.tick.stats().armed === true, "the reset is still pending");
});
check("a deadline inside the reset window does not consume the reset", () => {
  const c = testClock();
  c.tick.due(1); // t=0
  c.t = 14.99;
  c.tick.reset(3); // the pump pinned the sky; _lastState is still pre-pin (3)
  c.t = 15.0;
  assert(c.tick.due(3) === true, "deadline fires on the pre-pin snapshot");
  c.t = 15.016;
  assert(c.tick.due(4) === true, "the post-pin snapshot re-lights again");
  assert(c.tick.stats().armed === false, "reset consumed");
});
check("invalidate() re-lights on the next due() regardless of stamp", () => {
  const c = testClock();
  c.tick.due(1);
  c.t = 4;
  c.tick.invalidate();
  assert(c.tick.due(1) === true, "fires");
  assert(c.tick.due(1) === false, "then holds");
});
check("?lightTickReset parse: default on; off/0/false disable", () => {
  assert(lightTickResetEnabled("") === true, "empty");
  assert(lightTickResetEnabled("?lightTickReset=on") === true, "on");
  assert(lightTickResetEnabled("?lightTickReset=off") === false, "off");
  assert(lightTickResetEnabled("?lightTickReset=0") === false, "0");
  assert(lightTickResetEnabled("?lightTickReset=false") === false, "false");
  assert(lightTickResetEnabled(undefined) === true, "no window in node");
});

console.log("L3 — always_daylight.js pin edges");
function fakeHandle({ on = false, skyReady = true } = {}) {
  const h = {
    on,
    skyReady,
    override: undefined,
    calls: [],
    isCharacterOptionEnabled(idx) {
      return idx === ALWAYS_DAYLIGHT_OPTION ? h.on : false;
    },
    setSkyTimeOverride(t) {
      h.calls.push(t);
      if (!h.skyReady) return false;
      h.override = Number.isNaN(t) ? undefined : t;
      return true;
    },
  };
  return h;
}
function spyClock() {
  return { resets: 0, reset() { this.resets += 1; }, sync() { return 0; } };
}
function pump(ctl, h, t0, n, stepMs = 16) {
  for (let i = 0; i < n; i += 1) ctl.tick(h, t0 + i * stepMs);
  return t0 + n * stepMs;
}
check("option off from login: no reset", () => {
  const spy = spyClock();
  const ctl = createAlwaysDaylight({ lightTick: spy });
  pump(ctl, fakeHandle({ on: false }), 0, 200);
  assert(spy.resets === 0, `resets ${spy.resets}`);
});
check("on → off: exactly two resets, on the pin and the unpin edges", () => {
  const spy = spyClock();
  const h = fakeHandle({ on: false });
  const ctl = createAlwaysDaylight({ lightTick: spy });
  let t = pump(ctl, h, 0, 20);
  h.on = true;
  t = pump(ctl, h, t, 20);
  assert(ctl.state().pinned && spy.resets === 1, `pin edge: ${spy.resets}`);
  t = pump(ctl, h, t, 200); // ~3 s of per-poll re-asserts
  assert(h.calls.filter((c) => c === 0.5).length > 5, "re-asserted per poll");
  assert(spy.resets === 1, `re-asserts do not reset: ${spy.resets}`);
  h.on = false;
  t = pump(ctl, h, t, 40);
  assert(!ctl.state().pinned && spy.resets === 2, `unpin edge: ${spy.resets}`);
  pump(ctl, h, t, 200);
  assert(spy.resets === 2, `off stays quiet: ${spy.resets}`);
  assert(ctl.state().lightResets === 2, JSON.stringify(ctl.state()));
});
check("pre-sky retries do not reset; the pin that lands does (the login edge)", () => {
  const spy = spyClock();
  const h = fakeHandle({ on: true, skyReady: false });
  const ctl = createAlwaysDaylight({ lightTick: spy });
  let t = pump(ctl, h, 0, 10);
  assert(spy.resets === 0 && !ctl.state().pinned, "nothing applied yet");
  h.skyReady = true;
  t = pump(ctl, h, t, 1);
  assert(ctl.state().pinned && spy.resets === 1, `landed: ${spy.resets}`);
  pump(ctl, h, t, Math.ceil(ALWAYS_DAYLIGHT_POLL_MS / 16) * 4);
  assert(spy.resets === 1, `held: ${spy.resets}`);
});
check("?lightTickReset=off: no reset, identical pin calls", () => {
  const run = (search) => {
    const spy = spyClock();
    const h = fakeHandle({ on: false });
    const ctl = createAlwaysDaylight({ lightTick: spy, search });
    let t = pump(ctl, h, 0, 10);
    h.on = true;
    t = pump(ctl, h, t, 50);
    h.on = false;
    pump(ctl, h, t, 50);
    return { resets: spy.resets, calls: h.calls.map(String).join() };
  };
  const on = run("");
  const off = run("?lightTickReset=off");
  assert(on.resets === 2 && off.resets === 0, `${on.resets} / ${off.resets}`);
  assert(on.calls === off.calls, "the sky pin is unchanged by the flag");
});
check("default: the shared landscape clock is the one reset", () => {
  const before = retailLightTick.stats().resets;
  const h = fakeHandle({ on: true });
  const ctl = createAlwaysDaylight();
  pump(ctl, h, 0, 5);
  assert(retailLightTick.stats().resets === before + 1, JSON.stringify(retailLightTick.stats()));
  assert(retailLightTick.stats().armed === true, "a SetDay reset is pending");
});

console.log("L4 — terrain + pebbles on one clock (loop.js frame order)");
function vec3() {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
}
function color() {
  return { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } };
}
function terrainMaterial() {
  return {
    userData: {},
    uniforms: {
      uSunDir: { value: vec3() },
      uAcSunVec: { value: vec3() },
      uAcSunColor: { value: color() },
      uAcAmbColor: { value: color() },
      uAcAmbLevel: { value: 0 },
    },
  };
}
function sky(dirBright) {
  return {
    dirHeading: 90, dirPitch: 45, dirBright,
    dirColorArgb: 0xffffffff, ambColorArgb: 0xffffffff, ambBright: 0.4,
  };
}
function fakeOracle() {
  return {
    sample() {
      return { code: 0, family: familyForCode(0), height: 10, hasHeight: true, normal: { x: 0, y: 0, z: 1 }, cornerCodes: null };
    },
    heightAt: () => 10,
  };
}
/** One loop.js frame: [pump] → terrainVfxTick (pebbles) → tickTerrainSunDir → sky tick. */
function makeWorld(bright0 = 0.30) {
  const c = testClock();
  const ctl = { _lastState: sky(bright0), _tickCount: 1, next: bright0 };
  const mat = terrainMaterial();
  const scene3d = { terrainMaterials: [mat], skyLightingController: ctl };
  const field = createPebbleField({
    oracle: fakeOracle(), count: 16, radiusM: 16, offRoad: false,
    lightTick: c.tick, readStateTick: () => ctl._tickCount,
  });
  function frame(dt = 0.1) {
    field.update(dt, c.t, 100, 100, 10, ctl._lastState);
    tickTerrainSunDir(scene3d, c.tick);
    ctl._lastState = sky(ctl.next); // skyLightingController.tick
    ctl._tickCount += 1;
    c.t += dt;
  }
  const terrainBright = () => {
    const v = mat.uniforms.uAcSunVec.value;
    return Math.hypot(v.x, v.y, v.z); // sunlight_vec carries dirBright as its magnitude
  };
  return { c, ctl, mat, field, frame, terrainBright };
}
check("equal epochs and the same snapshot every frame for 100 s", () => {
  const w = makeWorld();
  let mismatches = 0;
  for (let i = 0; i < 1000; i += 1) {
    w.ctl.next = 0.2 + 0.6 * (i / 1000); // a slow dawn
    w.frame(0.1);
    if (w.field.stats().lightEpoch !== w.mat.userData.__acLightEpoch) mismatches += 1;
    if (!approx(w.terrainBright(), w.field.light.sun[0], 1e-9)) mismatches += 1;
  }
  assert(mismatches === 0, `mismatched frames: ${mismatches}`);
  const e = w.c.tick.epoch;
  assert(e >= 7 && e <= 8, `~one epoch per 15 s over 100 s: ${e}`);
  assert(w.field.stats().lightTicks === e, `pebble pushes ${w.field.stats().lightTicks} vs epochs ${e}`);
  assert(w.field.stats().sharedLightClock === true, "the field reports the shared clock");
});
check("a SetDay reset re-lights both from the POST-pin sky, not the stale one", () => {
  const w = makeWorld(0.10); // night
  for (let i = 0; i < 30; i += 1) w.frame(0.1); // 3 s in: lit at night, deadline ~12 s away
  assert(approx(w.terrainBright(), 0.10, 1e-9), `night ground: ${w.terrainBright()}`);
  const epoch0 = w.c.tick.epoch;
  // always_daylight pins Midsong in the net pump (phase #0): the wasm sky is
  // noon from now on, but `_lastState` is the night snapshot until the sky tick.
  w.ctl.next = 0.95;
  w.c.tick.reset();
  w.frame(0.016);
  assert(w.c.tick.epoch === epoch0, "the reset frame does not re-light from the pre-pin snapshot");
  assert(approx(w.terrainBright(), 0.10, 1e-9), "still the old light this frame");
  w.frame(0.016);
  assert(w.c.tick.epoch === epoch0 + 1, `re-lit next frame: ${w.c.tick.epoch}`);
  assert(approx(w.terrainBright(), 0.95, 1e-9), `ground at noon: ${w.terrainBright()}`);
  assert(approx(w.field.light.sun[0], 0.95, 1e-9), `pebbles at noon: ${w.field.light.sun[0]}`);
  assert(w.field.stats().lightEpoch === w.mat.userData.__acLightEpoch, "same epoch");
});
check("without the reset the ground would hold the night for the rest of the tick", () => {
  const w = makeWorld(0.10);
  for (let i = 0; i < 30; i += 1) w.frame(0.1);
  w.ctl.next = 0.95; // pinned, no SetDay
  for (let i = 0; i < 50; i += 1) w.frame(0.1); // 5 s later
  assert(approx(w.terrainBright(), 0.10, 1e-9), "the bug the reset fixes");
});
check("a bare field (no shared clock) keeps a private timer on its tSec", () => {
  const f = createPebbleField({ oracle: fakeOracle(), count: 16, radiusM: 16, offRoad: false });
  f.update(0.016, 0, 100, 100, 10, sky(1));
  f.update(0.016, 14, 100, 100, 10, sky(0.2));
  assert(f.stats().lightTicks === 1 && f.stats().sharedLightClock === false, JSON.stringify(f.stats().lightTicks));
  f.update(0.016, 15.5, 100, 100, 10, sky(0.2));
  assert(f.stats().lightTicks === 2, "re-lit on its own 15 s");
  f.dispose();
});

console.log("L5 — wiring");
const src = (p) => readFileSync(path.join(APP, p), "utf8");
check("loop.js drives the terrain from the shared clock, before the sky tick", () => {
  const loop = src("scene3d/loop.js");
  assert(loop.includes('import { retailLightTick } from "./retail_light_tick.js";'), "import");
  assert(loop.includes("const epoch = lightTick.sync(scene3d.skyLightingController?._tickCount);"), "sync with the stamp");
  assert(!/nextLightTick/.test(loop), "no private terrain timer left");
  const iTerrain = loop.indexOf("tickTerrainSunDir(scene3d);");
  const iSky = loop.indexOf("scene3d.skyLightingController.tick(dt);");
  assert(iTerrain > 0 && iSky > iTerrain, "frame order the reset gate is built for");
  assert((loop.match(/retailLightTick\.invalidate\(\)/g) || []).length === 2, "devtools setters");
});
check("terrain_rock's provider hands the shared clock in unless ?lightTickReset=off", () => {
  const rock = src("scene3d/terrain_rock.js");
  assert(rock.includes("lightTick: _rock.sharedLightTick ? retailLightTick : null,"), "provider");
  assert(rock.includes("readStateTick: _skyStateTick,"), "stamp reader");
  assert(rock.includes("sharedLightTick: lightTickResetEnabled(opts.search),"), "flag");
});
check("always_daylight.js resets through the shared clock", () => {
  const ad = src("scene3d/always_daylight.js");
  assert(ad.includes('import { retailLightTick, lightTickResetEnabled } from "./retail_light_tick.js";'), "import");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
