#!/usr/bin/env node
// Unit test (pure node, NO browser, NO sidecar): the W1.2 "loud fallback".
// GlobalRouter.goto() must surface the sidecar's route-quality fields into
// its RESULT object AND onto this.lastPlan, on every resolution path, so the
// AI decision layer (W3 journal + mission line) learns that a fallback is a
// blind straight-line through unbaked terrain WITHOUT re-deriving it.
// Stubs global.fetch + a mock host/router; global_router.js is self-contained
// (only fetch/setTimeout/console), so no DOM or wasm is needed.

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails += 1;
};

// A mock RynthRouter: follow() latches DONE after one tick so goto() resolves
// deterministically without a real host heartbeat.
function mockRouter(finalState = "DONE") {
  const r = {
    _followed: null,
    status: { state: "IDLE", leg: 0, legs: 0, walked: 0 },
    follow(legs) {
      this._followed = legs;
      // becomes DONE on the next status read
      this.status = { state: finalState, leg: legs.length, legs: legs.length, walked: legs.length };
    },
    cancel() { this.status = { ...this.status, state: "IDLE" }; },
  };
  return r;
}

const mockHost = (pose) => ({ TryGetPlayerPose: () => pose });

// Canned /route responses keyed by call count, so a replan can hand back a
// different coverage than the first plan.
function stubFetch(responses) {
  let i = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return { ok: true, json: async () => ({ ok: true, tiles: 1, portals: 0 }) };
    }
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, json: async () => body };
  };
}

(async () => {
  const { GlobalRouter } = await import("./rynth/global_router.js");

  // ── Case 1: a STRAIGHT-LINE plan (the Arwic-wall class) walked to DONE ──
  {
    stubFetch([{ ok: true, coverage: "straight", estUnits: 1234, portalsUsed: 4,
      legs: [{ lb: 0xa9a80011 >>> 0, x: 84, y: 12, z: 50, portal: false, label: "" }] }]);
    const g = new GlobalRouter(mockHost({ objCellId: 0xa9a80011 >>> 0, x: 84, y: 12, z: 50 }), { log: () => {} });
    const res = await g.goto(mockRouter("DONE"), { ns: 33.3, ew: 56.6 }, { pollMs: 5 });
    check("case1 goto ok", res.ok === true, `state=${res.state}`);
    check("case1 result.coverage surfaced", res.coverage === "straight", `coverage=${res.coverage}`);
    check("case1 result.estUnits surfaced", res.estUnits === 1234, `estUnits=${res.estUnits}`);
    check("case1 result.portalsUsed surfaced", res.portalsUsed === 4, `portalsUsed=${res.portalsUsed}`);
    check("case1 lastPlan.coverage set", g.lastPlan && g.lastPlan.coverage === "straight");
    check("case1 lastPlan.legCount set", g.lastPlan && g.lastPlan.legCount === 1);
    check("case1 lastPlan.plannedAt is a timestamp", g.lastPlan && Number.isFinite(g.lastPlan.plannedAt));
  }

  // ── Case 2: a DETOUR plan (baked region) — coverage must reflect it ──
  {
    stubFetch([{ ok: true, coverage: "detour", estUnits: 500, portalsUsed: 0,
      legs: [{ lb: 0xa1a40011 >>> 0, x: 10, y: 10, z: 20, portal: false, label: "" }] }]);
    const g = new GlobalRouter(mockHost({ objCellId: 0xa1a40011 >>> 0, x: 10, y: 10, z: 20 }), { log: () => {} });
    const res = await g.goto(mockRouter("DONE"), { ns: 1, ew: 1 }, { pollMs: 5 });
    check("case2 result.coverage=detour", res.coverage === "detour", `coverage=${res.coverage}`);
    check("case2 lastPlan.coverage=detour", g.lastPlan && g.lastPlan.coverage === "detour");
  }

  // ── Case 3: keys ALWAYS present even before a successful plan (no pose) ──
  {
    stubFetch([{ ok: false, error: "n/a" }]);
    const g = new GlobalRouter(mockHost(null), { log: () => {} });
    const res = await g.goto(mockRouter("DONE"), { ns: 1, ew: 1 }, { poseTimeoutMs: 20, pollMs: 5 });
    check("case3 ok:false on no pose", res.ok === false);
    check("case3 coverage key present (null)", "coverage" in res && res.coverage === null, `coverage=${res.coverage}`);
    check("case3 estUnits key present (null)", "estUnits" in res && res.estUnits === null);
    check("case3 portalsUsed key present (null)", "portalsUsed" in res && res.portalsUsed === null);
  }

  // ── Case 4: FAILED walk still carries the walked plan's coverage ──
  {
    stubFetch([{ ok: true, coverage: "mixed", estUnits: 900, portalsUsed: 2,
      legs: [{ lb: 0xa5a60011 >>> 0, x: 5, y: 5, z: 5, portal: false, label: "" }] }]);
    const g = new GlobalRouter(mockHost({ objCellId: 0xa5a60011 >>> 0, x: 5, y: 5, z: 5 }), { log: () => {} });
    const res = await g.goto(mockRouter("FAILED"), { ns: 1, ew: 1 }, { retries: 0, pollMs: 5 });
    check("case4 ok:false on FAILED", res.ok === false, `state=${res.state}`);
    check("case4 coverage=mixed carried on failure", res.coverage === "mixed", `coverage=${res.coverage}`);
  }

  console.log(`GLOBALROUTE-COVERAGE: ${fails === 0 ? "PASS" : `FAIL (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(`ERR ${e.stack || e.message}`); process.exit(1); });
