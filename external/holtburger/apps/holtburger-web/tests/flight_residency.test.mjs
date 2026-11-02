// 2026-11-01 — the flight-residency API in scene3d/residency.js (flight experience Phases 1 / 5): the flag grammar
// of ?flightResidency (default ON) and ?flightLight (default ON), the flight hint's staleness, the forward bias (an
// opt-in A/B arm) and the light band that skips the on-foot-only streaming (building interiors, collision AABBs)
// while an aircraft is airborne.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/flight_residency.test.mjs

import {
  flightResidencyEnabled, setFlightHint, clearFlightHint, getFlightHint, FLIGHT_HINT_STALE_MS,
  flightBiasLb, flightBiasEnabled, flightLightEnabled, flightLightFor, flightLightActive, FLIGHT_LIGHT_AGL,
} from "../scene3d/residency.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- FR1 flags ----------------------------------------------------------");
check("?flightResidency: DEFAULT ON, off / 0 / false / no escape",
  flightResidencyEnabled("") === true && flightResidencyEnabled("?flightResidency=on") === true
  && flightResidencyEnabled("?flightResidency=off") === false && flightResidencyEnabled("?flightResidency=0") === false);
check("?flightLight: DEFAULT ON, off / 0 / false / no escape",
  flightLightEnabled("") === true && flightLightEnabled("?flightLight=off") === false && flightLightEnabled("?flightLight=no") === false);
check("?flightBias: opt-in (measured net negative, arm C)", flightBiasEnabled("") === false && flightBiasEnabled("?flightBias=on") === true);

console.log("-- FR2 the flight hint ------------------------------------------------");
{
  clearFlightHint();
  check("no hint → null", getFlightHint(1000) === null);
  setFlightHint({ x: 100, y: 200, z: 150, vx: 80, vy: 60, agl: 90 });
  const h = getFlightHint();
  check("a fresh hint carries the pose, speed and AGL", h && h.speed === 100 && h.agl === 90 && h.x === 100);
  check("stale after FLIGHT_HINT_STALE_MS (a landed / exited aircraft stops refreshing it)",
    getFlightHint(h.t + FLIGHT_HINT_STALE_MS + 1) === null && getFlightHint(h.t + FLIGHT_HINT_STALE_MS - 1) !== null);
  clearFlightHint();
  check("cleared at landing / exit / bail", getFlightHint() === null);
}

console.log("-- FR3 forward bias (the A/B arm) --------------------------------------");
{
  const b = flightBiasLb({ speed: 111, vx: 111, vy: 0 });
  check("bias = the lead vector in landblocks, clamped", b.dx >= 1 && b.dx <= 2 && b.dy === 0, JSON.stringify(b));
  check("no bias when slow / no hint", JSON.stringify(flightBiasLb(null)) === JSON.stringify({ dx: 0, dy: 0 }));
}

console.log("-- FR4 the light band (no interiors / wall AABBs while airborne) --------");
{
  check("airborne above FLIGHT_LIGHT_AGL → light", flightLightFor({ agl: FLIGHT_LIGHT_AGL + 1 }) === true);
  check("taxiing / low / unknown AGL → not light", flightLightFor({ agl: 10 }) === false && flightLightFor({ agl: null }) === false
    && flightLightFor(null) === false);
  setFlightHint({ x: 1, y: 1, vx: 50, vy: 0, agl: 120 });
  check("live: an airborne hint → active", flightLightActive() === true);
  clearFlightHint();
  check("live: no hint (on foot, landed, bailed) → inactive", flightLightActive() === false);
  check("the app/ bridge is installed (landblock_stream.js reads it)", typeof globalThis.__hbFlightLightActive === "function"
    && globalThis.__hbFlightLightActive() === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
