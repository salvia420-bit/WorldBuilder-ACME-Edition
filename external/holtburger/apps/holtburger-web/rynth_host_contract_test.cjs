#!/usr/bin/env node
// rynth_host_contract_test.cjs — anti-drift guard for the ExplorePressure
// escape-ladder ↔ RynthWebHost seam (Phase-2 WP-7; FM-5 "mock-drift gap",
// C5-7).
//
// WHY THIS EXISTS. Every ExplorePressureController escape rung
// (rynth/bot.js _escalatePortal / _frontierHopIndoor / _legacyIndoorSweep
// and the surrounding tick) drives the world exclusively through host
// methods: NearbyGuids, TryGetObjectDescFlags, TryGetObjectPosition,
// UseObject, TryGetObjectName, MoveToPosition, TryGetPlayerPose, plus the
// wasm session handle `host.s`. The unit tests for that ladder
// (rynth_explore_pressure_test.cjs) run against a HAND-WRITTEN mock host, so
// if rynth/webhost.js's real surface ever drifts — a method renamed, a
// required parameter added, TryGetPlayerPose dropped — the mocked tests keep
// passing while the training-academy wedge fix silently breaks in-world.
// This test closes that gap by asserting the contract against the REAL
// RynthWebHost export: each method the ladder calls exists as a function,
// with a declared arity the ladder's call sites satisfy, and `host.s` is a
// live instance field. Pure read-only of bot.js/webhost.js — no runtime
// behaviour, no network, no wasm, no ticks.
//
// Run: node rynth_host_contract_test.cjs   (exits 1 on any FAIL)

"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// The contract, derived by READING both source files (citations verified,
// not trusted): declared = RynthWebHost method's Function.length (params
// before the first default); call = max args the escape ladder passes at any
// call site. The live invariant is call >= declared — the ladder must supply
// every REQUIRED parameter — while declared is pinned so a webhost signature
// change (add/remove a required param) trips the guard.
//   NearbyGuids()                         webhost.js:335   bot.js:1209
//   TryGetObjectDescFlags(guid)           webhost.js:427   bot.js:1214
//   TryGetObjectPosition(guid)            webhost.js:358   bot.js:1216
//   UseObject(guid)                       webhost.js:645   bot.js:1258
//   TryGetObjectName(guid)                webhost.js:349   bot.js:1190,1219
//   MoveToPosition(cell,x,y,z,run=true)   webhost.js:664   bot.js:1252,1319,1357
//   TryGetPlayerPose()                    webhost.js:326   bot.js:220,814
const CONTRACT = [
  { method: "NearbyGuids",           declared: 0, call: 0 },
  { method: "TryGetObjectDescFlags", declared: 1, call: 1 },
  { method: "TryGetObjectPosition",  declared: 1, call: 1 },
  { method: "UseObject",             declared: 1, call: 1 },
  { method: "TryGetObjectName",      declared: 1, call: 1 },
  { method: "MoveToPosition",        declared: 4, call: 5 },
  { method: "TryGetPlayerPose",      declared: 0, call: 0 },
];
const CONTRACT_METHODS = new Set(CONTRACT.map((c) => c.method));

async function main() {
  // rynth/webhost.js is ESM (`export class`) with a .js extension and no
  // parent "type":"module", so Node classifies it as CommonJS and a bare
  // import throws. Copy the repo bytes to a temp .mjs and import THOSE — the
  // exact same load trick rynth_combatparity_test.cjs uses. webhost.js has no
  // top-level imports, so it loads standalone.
  const whSrc = fs.readFileSync(path.join(__dirname, "rynth", "webhost.js"), "utf8");
  const whTmp = path.join(os.tmpdir(), `webhost_contract_${process.pid}.mjs`);
  fs.writeFileSync(whTmp, whSrc);
  let RynthWebHost;
  try {
    ({ RynthWebHost } = await import("file://" + whTmp));
  } finally {
    fs.unlinkSync(whTmp);
  }

  check("RynthWebHost class exported", typeof RynthWebHost === "function",
    `got ${typeof RynthWebHost}`);
  if (typeof RynthWebHost !== "function") { done(); return; }

  // Build the real host over a mock session ({} — capability probing resolves
  // nothing, but the RynthCoreHost methods are plain class members and exist
  // regardless; noEventTap avoids the window event-tap in Node).
  const session = { __stub: true };
  let host;
  try {
    host = new RynthWebHost(session, { noEventTap: true });
  } catch (e) {
    check("RynthWebHost constructs over a mock session", false, String(e));
    done();
    return;
  }
  check("RynthWebHost constructs over a mock session", !!host);

  // 1. host.s — the wasm session handle the ladder feeds to
  //    indoor_router.buildGraphFromWasm (bot.js:1009) and probeFromSession
  //    (bot.js:223). Must be a live instance field, not undefined.
  check("host.s is the session handle instance field",
    "s" in host && host.s === session,
    `"s" in host=${"s" in host}, host.s===session=${host.s === session}`);

  // 2. Every contract method: exists as a function, declared arity is pinned,
  //    and the ladder's call arity supplies every required parameter.
  for (const { method, declared, call } of CONTRACT) {
    const fn = host[method];
    const isFn = typeof fn === "function";
    check(`host.${method} exists as a function`, isFn, `typeof=${typeof fn}`);
    if (!isFn) continue;
    check(`host.${method} declared arity is ${declared}`, fn.length === declared,
      `Function.length=${fn.length}, expected ${declared}`);
    check(`escape ladder supplies host.${method}'s required params (call ${call} >= declared ${fn.length})`,
      call >= fn.length,
      `call arity ${call} < declared ${fn.length} — ladder would pass undefined for a required param`);
  }

  // 3. Reverse anti-drift: scan the _escalatePortal rung (the portal-escape
  //    core, bot.js) and assert every PascalCase host member it references via
  //    `h.` / `this.host.` is IN the contract. If a new host call sneaks into
  //    the rung, this fails and forces the contract (and webhost) to be
  //    re-verified rather than silently uncovered. PascalCase is the
  //    RynthCoreHost member convention (internal helpers are camelCase /
  //    _underscore), so this cleanly targets host methods without matching
  //    Math.*/best.*/this._* noise.
  const botSrc = fs.readFileSync(path.join(__dirname, "rynth", "bot.js"), "utf8");
  const start = botSrc.indexOf("_escalatePortal(pose");
  // Region ends where the next controller method begins (upsert helper).
  const end = botSrc.indexOf("_rememberPortal(", start);
  check("located _escalatePortal rung in bot.js", start >= 0 && end > start,
    `start=${start}, end=${end}`);
  if (start >= 0 && end > start) {
    const region = botSrc.slice(start, end);
    const referenced = new Set();
    const re = /(?:\bh|this\.host)\??\.\s*([A-Z][\w$]*)/g;
    let m;
    while ((m = re.exec(region)) !== null) referenced.add(m[1]);
    check("_escalatePortal references at least one contract host method",
      referenced.size > 0, `referenced={${[...referenced].join(", ")}}`);
    const uncovered = [...referenced].filter((x) => !CONTRACT_METHODS.has(x));
    check("every host method _escalatePortal calls is in the contract",
      uncovered.length === 0,
      `uncovered host calls not in CONTRACT: {${uncovered.join(", ")}} — update CONTRACT + verify webhost.js`);
  }

  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
