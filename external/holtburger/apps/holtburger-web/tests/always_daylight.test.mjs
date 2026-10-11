// tests/always_daylight.test.mjs
//
// "Always daylight outdoors" (CharacterOption 0x05, CharacterOptions2
// PersistentAtDay). The Options checkbox reached the server but nothing in the
// renderer read it. Retail: PersistentAtDay -> LScape::SetDay (acclient.c:306897)
// at login (:452815) and on every option change (:452973); set_landscape_lighting
// (:307016) then lights from CRegionDesc::GetLighting(0.5, ...), Midsong.
// scene3d/always_daylight.js pins the wasm sky evaluator to 0.5 while the option
// is on, through setSkyTimeOverride (NaN clears).
//
//   D1  option off from login -> the sky clock is never touched.
//   D2  option on -> pin 0.5, retried on every pump until the SkyDesc lands
//       (the wasm returns false), then re-asserted once per poll (an
//       EnteredWorld repopulate replaces the evaluator and drops the pin).
//   D3  option turned off -> one NaN clear, then nothing; on again -> re-pins.
//   D4  missing / throwing exports read as "off" and never throw.
//   D5  wiring: index.html drives it from pumpNetFrame only when no ?skytime
//       pin/accel owns the clock; the Options page still offers 0x05.
//
// Run: node tests/always_daylight.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const {
  ALWAYS_DAYLIGHT_OPTION,
  ALWAYS_DAYLIGHT_TIME_OF_DAY,
  ALWAYS_DAYLIGHT_POLL_MS,
  readAlwaysDaylight,
  createAlwaysDaylight,
} = await import("../scene3d/always_daylight.js");

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

/** A fake SessionHandle: option bits + a sky evaluator that may not exist yet. */
function fakeHandle({ on = false, skyReady = true } = {}) {
  const h = {
    on,
    skyReady,
    override: undefined, // what the evaluator holds (undefined = never set)
    calls: [],
    optionReads: [],
    isCharacterOptionEnabled(idx) {
      h.optionReads.push(idx);
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

/** Drive `n` pumps of `stepMs` from `t0`. */
function pump(ctl, h, t0, n, stepMs = 16) {
  for (let i = 0; i < n; i += 1) ctl.tick(h, t0 + i * stepMs);
  return t0 + n * stepMs;
}

console.log("D0 — constants");
check("option index, Midsong, poll cadence", () => {
  assert(ALWAYS_DAYLIGHT_OPTION === 0x05, "CharacterOption::AlwaysDaylightOutdoors = 0x05");
  assert(ALWAYS_DAYLIGHT_TIME_OF_DAY === 0.5, "retail GetLighting(0.5) = Midsong");
  assert(ALWAYS_DAYLIGHT_POLL_MS > 0 && ALWAYS_DAYLIGHT_POLL_MS <= 1000, "polls at least once a second");
});

console.log("D1 — option off from login");
check("never touches the sky clock", () => {
  const h = fakeHandle({ on: false });
  const ctl = createAlwaysDaylight();
  pump(ctl, h, 0, 200);
  assert(h.calls.length === 0, `setSkyTimeOverride called ${h.calls.length}x`);
  assert(h.optionReads.length >= 2, "the option is still polled");
  const s = ctl.state();
  assert(s.on === false && s.pinned === false, JSON.stringify(s));
});

console.log("D2 — option on");
check("pins Midsong on the first pump", () => {
  const h = fakeHandle({ on: true });
  const ctl = createAlwaysDaylight();
  ctl.tick(h, 1000);
  assert(h.calls.length === 1 && h.calls[0] === 0.5, JSON.stringify(h.calls));
  assert(h.override === 0.5, "evaluator pinned");
  assert(ctl.state().pinned === true, "pinned");
});
check("retries every pump until the SkyDesc lands, then once per poll", () => {
  const h = fakeHandle({ on: true, skyReady: false });
  const ctl = createAlwaysDaylight();
  let t = pump(ctl, h, 0, 5); // 5 pumps inside one poll window, sky not ready
  assert(h.calls.length === 5, `retried each pump: ${h.calls.length}`);
  assert(ctl.state().pinned === false, "not pinned yet");
  h.skyReady = true;
  t = pump(ctl, h, t, 1);
  assert(h.override === 0.5 && ctl.state().pinned, "pinned once the sky exists");
  const before = h.calls.length;
  // 2 s of 16 ms pumps → one re-assert per 250 ms poll, not one per pump.
  pump(ctl, h, t, 125);
  const extra = h.calls.length - before;
  assert(extra >= 7 && extra <= 9, `re-asserts per poll only: ${extra}`);
  assert(h.calls.every((c) => c === 0.5), "only ever pins 0.5 while on");
});
check("an EnteredWorld repopulate (pin dropped) is re-pinned within a poll", () => {
  const h = fakeHandle({ on: true });
  const ctl = createAlwaysDaylight();
  let t = pump(ctl, h, 0, 3);
  h.override = undefined; // populateSkyDescFromRegion: a fresh evaluator
  t = pump(ctl, h, t, Math.ceil(ALWAYS_DAYLIGHT_POLL_MS / 16) + 1);
  assert(h.override === 0.5, "pin restored");
});

console.log("D3 — toggling");
check("off clears once with NaN, then leaves the clock alone", () => {
  const h = fakeHandle({ on: true });
  const ctl = createAlwaysDaylight();
  let t = pump(ctl, h, 0, 3);
  h.on = false;
  t = pump(ctl, h, t, 40); // > one poll
  const nans = h.calls.filter((c) => Number.isNaN(c)).length;
  assert(nans === 1, `exactly one clear: ${nans}`);
  assert(h.override === undefined, "back on the wall clock");
  const n = h.calls.length;
  pump(ctl, h, t, 100);
  assert(h.calls.length === n, "no further calls while off");
  assert(ctl.state().pinned === false, "unpinned");
});
check("on again re-pins", () => {
  const h = fakeHandle({ on: false });
  const ctl = createAlwaysDaylight();
  let t = pump(ctl, h, 0, 20);
  h.on = true;
  pump(ctl, h, t, 20);
  assert(h.override === 0.5 && ctl.state().pinned, "pinned after the toggle");
});

console.log("D4 — missing / throwing exports");
check("readAlwaysDaylight: no handle / stale pkg / throw → false", () => {
  assert(readAlwaysDaylight(undefined) === false, "undefined");
  assert(readAlwaysDaylight({}) === false, "no export");
  assert(readAlwaysDaylight({ isCharacterOptionEnabled() { throw new Error("freed"); } }) === false, "throws");
});
check("tick never throws on a throwing setSkyTimeOverride", () => {
  const ctl = createAlwaysDaylight();
  const h = {
    isCharacterOptionEnabled: () => true,
    setSkyTimeOverride() { throw new Error("freed"); },
  };
  pump(ctl, h, 0, 30);
  assert(ctl.state().pinned === false, "not pinned");
});

console.log("D5 — wiring");
check("index.html imports the driver and ticks it only without a ?skytime owner", () => {
  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  assert(/import\s*\{\s*createAlwaysDaylight\s*\}\s*from\s*"\.\/scene3d\/always_daylight\.js"/.test(html), "import");
  assert(/const __alwaysDaylight = createAlwaysDaylight\(\);/.test(html), "per-login driver");
  assert(
    /\} else if \(__skyTimePin === null\) \{[\s\S]{0,300}__alwaysDaylight\.tick\(handle, window\.__lastPumpMs\);/.test(html),
    "ticked in the no-pin branch of pumpNetFrame",
  );
  assert(/if \(__skyTimeAccel\) \{/.test(html), "accel branch still first");
});
check("the Options page still offers the 0x05 checkbox", () => {
  const src = readFileSync(path.join(APP, "plugins", "options-panel.js"), "utf8");
  assert(/\{ idx: 0x05, label: "Always daylight outdoors" \}/.test(src), "options row");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
