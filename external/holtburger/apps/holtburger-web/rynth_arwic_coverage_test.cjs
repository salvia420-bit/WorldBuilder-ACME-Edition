#!/usr/bin/env node
// requires: live rynthnav sidecar (POST /route at RYNTHNAV_URL, default :8767) — this is a
// live-infra regression, not a plain-node unit test; rynth_test_all_node.cjs skip-lists it.
// FROZEN REGRESSION (soak-14 Arwic-wall): the exact /route request whose
// blind straight-line fallback walked the bot into Arwic's wall. Before the
// W1 full-corridor bake it returns coverage:"straight" (57 legs, 4 portals);
// AFTER the corridor is baked it must return "detour" (or "mixed" with the
// on-foot walk segments detour-covered). This test asserts NOT "straight".
//
// Endpoint is configurable so it can point at a STAGING sidecar during the
// bake (RYNTHNAV_URL=http://127.0.0.1:8768) and at the live one (:8767)
// after the atomic swap. Default: the live sidecar.
//   RYNTHNAV_URL=http://127.0.0.1:8768 node rynth_arwic_coverage_test.cjs

const EP = process.env.RYNTHNAV_URL || "http://127.0.0.1:8767";

// The frozen request (Holtburg A9A8 start -> Arwic ns33.3/ew56.6).
const REQ = { from: { lb: 2846408729, x: 84, y: 12, z: 50 }, to: { ns: 33.3, ew: 56.6 } };

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails += 1;
};

(async () => {
  console.log(`endpoint: ${EP}`);
  let res;
  try {
    const r = await fetch(`${EP}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQ),
    });
    res = await r.json();
  } catch (e) {
    console.log(`FAIL: sidecar not reachable at ${EP} (${e.message}) — see apps/rynthnav-sidecar/README`);
    process.exit(1);
  }

  const legs = Array.isArray(res.legs) ? res.legs : [];
  const walkLegs = legs.filter((l) => !l.portal);
  console.log(
    `route: ok=${res.ok} coverage=${res.coverage} legs=${legs.length} ` +
      `(walk=${walkLegs.length}) portalsUsed=${res.portalsUsed} estUnits=${res.estUnits}`
  );

  check("route ok:true", res.ok === true, res.ok !== true ? `error=${res.error}` : "");
  // THE regression assertion: the blind fallback is gone.
  check(
    'coverage is "detour" or "mixed" (NOT the blind "straight" fallback)',
    res.coverage === "detour" || res.coverage === "mixed",
    `coverage=${res.coverage}`
  );
  // A "mixed" result is only acceptable if the DOMINANT on-foot corridor is
  // detour-covered — i.e. it isn't "mixed" merely because 55 of 57 legs are
  // still straight. Heuristic: with the corridor baked, the walk should have
  // real detour geometry, so legs should exceed the raw straight-seam count.
  if (res.coverage === "mixed") {
    check(
      "mixed route has a substantive baked corridor (>=10 walk legs)",
      walkLegs.length >= 10,
      `walkLegs=${walkLegs.length}`
    );
  }

  const pass = fails === 0;
  console.log(`ARWIC-COVERAGE: ${pass ? "PASS" : `FAIL (${fails})`}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(`ERR ${e.message}`); process.exit(1); });
