// test_sky_lighting.mjs — `scene3d/sky_lighting.js` (post-K.6 contract).
//
// REWRITTEN 2026-10-05. The original Sky-C suite pinned the parametric
// lighting path (THREE.Fog / DirectionalLight / AmbientLight writes,
// `SKY_LIGHTING_CONSTANTS`, `sunPositionFromHeadingPitch`). The Sky-K.6
// cleanup DELETED that path on purpose — the atmosphere stack now owns
// sun/sky/fog — and gutted the module to a per-frame SkyState CACHE. That
// suite crashed on load (`SKY_LIGHTING_CONSTANTS is not defined`) and sat in
// QUARANTINE as "unclassified". This version asserts what the module does
// TODAY, which the atmosphere/cloud consumers depend on:
//
//   1. tick() with no session / no getSkyState / a throwing or null getter
//      leaves `_lastState` untouched and counts a null tick.
//   2. tick() snapshots every SkyStateSnapshot field into a plain object
//      (u32 fields coerced unsigned, floats coerced numeric) and frees the
//      wasm handle exactly once.
//   3. A getter that throws mid-snapshot yields null (no partial state) and
//      STILL frees the handle; the previous good `_lastState` survives.
//   4. decodeArgb splits 0xAARRGGBB into [a, r, g, b] bytes.
//
// Pure ESM import (the module has no imports of its own). Run:
//   cd apps/holtburger-web/ && node test_sky_lighting.mjs

import { SkyLightingController, __internals } from "./scene3d/sky_lighting.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

function mockState(over = {}) {
  let frees = 0;
  const s = {
    dirColorArgb: 0xfffad797,
    dirBright: 1.25,
    dirHeading: 90,
    dirPitch: 67.35,
    ambColorArgb: 0xffc864ff,
    ambBright: 0.4,
    fogColorArgb: 0xff9cb3d9,
    fogColorArgbLerp: 0xff171723,
    fogMin: 120,
    fogMax: 900,
    worldFog: 2,
    timeOfDayNormalized: 0.5,
    dayGroupIndex: 3,
    free() { frees += 1; },
    ...over,
  };
  return { s, frees: () => frees };
}

console.log("sky_lighting.js — SkyState cache (post-K.6)");

// 1. null paths
{
  const c0 = new SkyLightingController();
  c0.tick(0.016);
  check("no accessor → null tick, no state", c0._lastState === null && c0._nullStateTickCount === 1);
  const c1 = new SkyLightingController({ sessionHandleAccessor: () => ({}) });
  c1.tick(0.016);
  check("session without getSkyState → null tick", c1._lastState === null && c1._nullStateTickCount === 1);
  const c2 = new SkyLightingController({ sessionHandleAccessor: () => ({ getSkyState() { throw new Error("pre-world"); } }) });
  c2.tick(0.016);
  check("throwing getSkyState → null tick (never propagates)", c2._lastState === null && c2._nullStateTickCount === 1);
  const c3 = new SkyLightingController({ sessionHandleAccessor: () => ({ getSkyState: () => null }) });
  c3.tick(0.016);
  check("null SkyState → null tick", c3._lastState === null && c3._nullStateTickCount === 1);
}

// 2. snapshot + free
{
  const m = mockState({ dirColorArgb: -394345 /* 0xFFF9FA97 as i32 */ });
  const c = new SkyLightingController({ sessionHandleAccessor: () => ({ getSkyState: () => m.s }) });
  c.tick(0.016);
  const st = c._lastState;
  check("good tick stores a snapshot", !!st && c._tickCount === 1 && c._nullStateTickCount === 0);
  check("u32 colour coerced unsigned", st && st.dirColorArgb === (-394345 >>> 0), String(st?.dirColorArgb));
  const keys = ["dirColorArgb", "dirBright", "dirHeading", "dirPitch", "ambColorArgb", "ambBright",
    "fogColorArgb", "fogColorArgbLerp", "fogMin", "fogMax", "worldFog", "timeOfDayNormalized", "dayGroupIndex"];
  check("snapshot carries exactly the SkyStateSnapshot fields",
    !!st && Object.keys(st).sort().join() === keys.slice().sort().join(), Object.keys(st || {}).join());
  check("snapshot is a plain object (no wasm handle retained)", !!st && !("free" in st));
  check("floats copied", st && st.fogMin === 120 && st.fogMax === 900 && st.timeOfDayNormalized === 0.5);
  check("wasm handle freed exactly once", m.frees() === 1, String(m.frees()));
}

// 3. throw mid-snapshot
{
  const good = mockState();
  let n = 0;
  const bad = mockState();
  Object.defineProperty(bad.s, "fogMin", { get() { throw new Error("freed"); } });
  const c = new SkyLightingController({ sessionHandleAccessor: () => ({ getSkyState: () => (n++ === 0 ? good.s : bad.s) }) });
  c.tick(0.016);
  const first = c._lastState;
  c.tick(0.016);
  check("getter throw mid-snapshot → null tick, previous state kept", c._lastState === first && c._nullStateTickCount === 1);
  check("handle still freed on the throwing path", bad.frees() === 1);
  check("snapshotSkyState(null) → null", __internals.snapshotSkyState(null) === null);
}

// 4. decodeArgb
{
  const [a, r, g, b] = __internals.decodeArgb(0xfffad797);
  check("decodeArgb(0xFFFAD797) → [255, 250, 215, 151]", a === 255 && r === 250 && g === 215 && b === 151, `${a},${r},${g},${b}`);
}

console.log(`\nsky_lighting: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
