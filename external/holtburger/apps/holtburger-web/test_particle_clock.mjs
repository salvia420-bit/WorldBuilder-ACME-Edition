// test_particle_clock.mjs — A11-S3 (`?particleClock=off|loop|sim`) headless
// acceptance gate (S12 spec §4; pattern: the behavioral + static style of
// test_a1_o4_single_frame_driver.mjs / test_a15_q4_renderer_neutral_core.mjs).
//
//   PART 1 — flag parse matrix (real time_rng.js ESM; window stubbed
//            per-case via __resetParticleClockMode).
//   PART 2 — extraction equivalence: entities.js#tickParticlesAndScripts
//            extracted by text + compiled standalone, driven with a fake
//            EntityManager-shaped `this`; retail order particles → scripts
//            (acclient.c:322887-322892); plus static checks that tick(dt)
//            reaches it exactly once behind the "off" gate and the moved
//            blocks no longer inline in tick(dt).
//   PART 3 — sim-clock advance law (the §3.4 arithmetic, synthetic
//            (dt, wallNow) sequences): monotonic, never ahead of wall
//            time, frozen under dt=0 (DT_RECOVERY analog); plus loop.js
//            static checks (phase placement after the local-pose phase,
//            before DEFERRABLE #20; same-timestamp re-entry guard;
//            world-managers-then-statics order, acclient.c:311371-311386).
//   PART 4 — clock-hook integration: a REAL ScriptManager driven through
//            `setCurrentTime(() => simNow)` — hooks fire at queue-chained
//            times under the external clock (proves script_manager.js
//            needs zero changes for =sim).
//   PART 5 — statics.js behavioral (tickStaticParticles) + static checks
//            (rAF arm gated to "off"; index.js =sim hook install;
//            docs/url-flags.md row).
//
// Run: node test_particle_clock.mjs   (no browser, no build)

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// Import BEFORE installing any window stub so module-scope URL-flag parses
// take their node fail-soft branches (same as every other headless ESM
// consumer in this repo). statics.js / loop.js resolve "three" via the
// local node_modules like the other gates.
const timeRng = await import("./scene3d/particles/time_rng.js");
const { particleClockMode, __resetParticleClockMode, setCurrentTime } = timeRng;
const { ScriptManager } = await import("./scene3d/script_manager.js");
const { tickStaticParticles } = await import("./scene3d/statics.js");

// ---------------------------------------------------------------------
// PART 1 — flag parse matrix
// ---------------------------------------------------------------------
console.log("PART 1: particleClockMode() parse matrix");

check("no window → off", particleClockMode() === "off", particleClockMode());

function parseWith(search) {
  __resetParticleClockMode();
  globalThis.window = { location: { search } };
  const m = particleClockMode();
  delete globalThis.window;
  return m;
}
check("?particleClock=loop → loop", parseWith("?particleClock=loop") === "loop");
check("?particleClock=sim → sim", parseWith("?particleClock=sim") === "sim");
check("?particleClock=wall (garbage) → off", parseWith("?particleClock=wall") === "off");
check("param absent → off", parseWith("?renderer=3d") === "off");
check("empty search → off", parseWith("") === "off");

// cache: first parse wins until reset
__resetParticleClockMode();
globalThis.window = { location: { search: "?particleClock=loop" } };
particleClockMode();
globalThis.window.location.search = "?particleClock=sim";
check("parse is cached once (no live re-read)", particleClockMode() === "loop");
delete globalThis.window;
__resetParticleClockMode();
check("__resetParticleClockMode restores re-parse", particleClockMode() === "off");
__resetParticleClockMode();

// ---------------------------------------------------------------------
// PART 2 — tickParticlesAndScripts extraction equivalence
// ---------------------------------------------------------------------
console.log("PART 2: entities.js tickParticlesAndScripts extraction");

const entitiesSrc = readFileSync(joinPath(__dirname, "scene3d", "entities.js"), "utf8");

// Extract the method body by brace matching (entities.js is not directly
// node-importable — it imports "three" at module scope plus heavy siblings;
// the method itself only touches `this` + console).
function extractMethod(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return null;
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
const methodSrc = extractMethod(entitiesSrc, "tickParticlesAndScripts() {");
check("method tickParticlesAndScripts() exists in entities.js", methodSrc !== null);

// eslint-disable-next-line no-new-func
const tickPAS = new Function("return function " + methodSrc)();

const order = [];
const fake = {
  _worldParticleManager: { tick: () => order.push("particles") },
  _scriptManagersForGuid: new Map([
    ["g1", { active: true, update: () => order.push("scripts") }],
  ]),
};
tickPAS.call(fake);
check(
  "retail order: particles BEFORE scripts (acclient.c:322887-322892)",
  order.join(",") === "particles,scripts",
  order.join(",")
);

// inactive manager not updated
order.length = 0;
fake._scriptManagersForGuid.get("g1").active = false;
tickPAS.call(fake);
check("inactive ScriptManager is skipped", order.join(",") === "particles", order.join(","));

// null managers → no throw
let threw = false;
try {
  tickPAS.call({ _worldParticleManager: null, _scriptManagersForGuid: new Map() });
} catch (_) { threw = true; }
check("null/empty managers are a no-op (no throw)", !threw);

// throwing particle tick → one-shot warn, scripts still run
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.map(String).join(" "));
order.length = 0;
const throwingFake = {
  _worldParticleManager: { tick: () => { throw new Error("synthetic"); } },
  _scriptManagersForGuid: new Map([
    ["g1", { active: true, update: () => order.push("scripts") }],
  ]),
};
tickPAS.call(throwingFake);
tickPAS.call(throwingFake);
console.warn = realWarn;
check("throwing particle tick is swallowed, scripts still run", order.length === 2, `scripts=${order.length}`);
check(
  "particle-tick throw warns exactly once (_particleTickWarned one-shot)",
  warns.filter((w) => w.includes("[entities/H2]")).length === 1,
  `warns=${warns.length}`
);

// static: tick(dt) reaches the phase exactly once behind the "off" gate
const offGate = 'if (particleClockMode() === "off") this.tickParticlesAndScripts();';
check("tick(dt) tail = off-gated tickParticlesAndScripts() call", entitiesSrc.includes(offGate));
check(
  "exactly ONE call site of tickParticlesAndScripts() in entities.js",
  entitiesSrc.split("this.tickParticlesAndScripts()").length === 2
);
check(
  "moved block not duplicated (ONE _worldParticleManager.tick() in entities.js)",
  entitiesSrc.split("this._worldParticleManager.tick()").length === 2
);

// ---------------------------------------------------------------------
// PART 3 — sim-clock advance law + loop.js phase statics
// ---------------------------------------------------------------------
console.log("PART 3: sim-clock advance law + loop.js phase");

// The §3.4 arithmetic: simNow' = min((simNow ?? wallNow) + dt, wallNow)
function advance(simNowS, dt, wallNowS) {
  return Math.min((simNowS ?? wallNowS) + dt, wallNowS);
}
// seed: first advance from null seeds at wall
let sim = null;
sim = Math.min((sim ?? 100) + 0.016, 100);
check("seed from wall now (never ahead at seed)", sim <= 100 && sim > 99.9, String(sim));

// monotonic under normal cadence, never > wall
sim = 100;
let wall = 100;
let monotonic = true;
let bounded = true;
for (let i = 0; i < 200; i++) {
  wall += 0.016;
  const next = advance(sim, 0.016, wall);
  if (next < sim) monotonic = false;
  if (next > wall) bounded = false;
  sim = next;
}
check("monotonic over 200 normal frames", monotonic);
check("never ahead of wall time", bounded);

// dt=0 freeze (DT_RECOVERY analog): sim frozen while wall advances
const frozenAt = sim;
for (let i = 0; i < 10; i++) {
  wall += 0.016;
  sim = advance(sim, 0, wall);
}
check("dt=0 recovery frames freeze the sim clock", sim === frozenAt, `sim=${sim} frozen=${frozenAt}`);

// clamped dt after a hitch: sim falls behind wall by the clamp, never jumps
wall += 5.0; // 5 s hitch
sim = advance(sim, 0.1, wall); // loop hands the 0.1-clamped dt
check("clamped post-hitch dt advances by the clamp (no wall jump)",
  Math.abs(sim - (frozenAt + 0.1)) < 1e-9, `sim=${sim}`);

// double-driver overcount absorbed by the wall bound
sim = wall - 0.001;
sim = advance(sim, 0.1, wall);
check("wall bound absorbs double-driver overcount", sim === wall, `sim=${sim} wall=${wall}`);

const loopJs = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");
check("loop.js imports particleClockMode from ./particles/time_rng.js",
  /import \{ particleClockMode \} from "\.\/particles\/time_rng\.js"/.test(loopJs));
check("loop.js imports tickStaticParticles from ./statics.js",
  loopJs.includes("tickStaticParticles,"));
const phaseIdx = loopJs.indexOf("A11-S3 (CRITICAL — never RP3-gated)");
const poseIdx = loopJs.indexOf("applyLocalPlayerPoseFromIntegrator(scene3d, sessionHandle);");
const deferIdx = loopJs.indexOf("DEFERRABLE #20");
check("manager phase sits AFTER local-pose application", phaseIdx > poseIdx && poseIdx > 0);
check("manager phase sits BEFORE DEFERRABLE #20 (never RP3-gated)",
  phaseIdx > 0 && deferIdx > phaseIdx);
check("same-timestamp re-entry guard present (_a11s3LastTickMs)",
  loopJs.includes("scene3d._a11s3LastTickMs !== _pcNowMs"));
check("sim advance uses clamped dt bounded by wall (Math.min)",
  loopJs.includes("scene3d._particleSimNowS = Math.min("));
const phaseSlice = loopJs.slice(phaseIdx, deferIdx);
check("phase order: world managers then statics (CPhysics::UseTime order)",
  phaseSlice.indexOf("tickParticlesAndScripts()") > 0 &&
  phaseSlice.indexOf("tickParticlesAndScripts()") < phaseSlice.indexOf("tickStaticParticles(scene3d)"));
check("diag counters present (managerTicks/frames)",
  loopJs.includes("_a11s3Diag") && loopJs.includes("managerTicks") && loopJs.includes("frames"));

// ---------------------------------------------------------------------
// PART 4 — ScriptManager under an external sim clock
// ---------------------------------------------------------------------
console.log("PART 4: ScriptManager on setCurrentTime(() => simNow)");

let simNow = 100;
setCurrentTime(() => simNow);
const fired = [];
const sm = new ScriptManager({
  owner: "a11s3-test",
  executeHook: (entry, ctx) => fired.push(`${ctx.scriptDid}:${entry.startTime}@${simNow}`),
});
// Script A: hooks at +1 and +2 → starts at simNow=100, derived length 2.
sm.addScript(0xa, [{ startTime: 1 }, { startTime: 2 }]);
// Script B: hook at +0.5 → chains back-to-back at 100+2=102, fires 102.5
// (retail AddScriptInternal acclient.c:329093-329096).
sm.addScript(0xb, [{ startTime: 0.5 }]);

simNow = 100.9;
check("no hook before its chained time", sm.update() === 0);
simNow = 101.0;
check("A hook 1 fires at start+1 on the sim clock", sm.update() === 1, fired.join(" "));
simNow = 102.0;
check("A hook 2 fires at start+2", sm.update() === 1, fired.join(" "));
simNow = 102.4;
check("B not yet due (chained at A.start+length)", sm.update() === 0);
simNow = 102.5;
check("B fires at chained 102.5", sm.update() === 1, fired.join(" "));
check("queue drained (manager inactive)", !sm.active);
check("frozen sim clock fires nothing on repeat updates",
  sm.update() === 0 && sm.update() === 0);
setCurrentTime(null);

// ---------------------------------------------------------------------
// PART 5 — statics.js behavioral + remaining statics
// ---------------------------------------------------------------------
console.log("PART 5: tickStaticParticles + statics");

let staticTicks = 0;
tickStaticParticles({ _staticParticleManager: { tick: () => { staticTicks += 1; } } });
check("tickStaticParticles ticks the manager", staticTicks === 1);
tickStaticParticles(null);
tickStaticParticles({});
check("null scene3d / missing manager are no-ops", staticTicks === 1);
let stThrew = false;
try {
  tickStaticParticles({ _staticParticleManager: { tick: () => { throw new Error("x"); } } });
} catch (_) { stThrew = true; }
check("throwing static manager tick is swallowed", !stThrew);

const staticsSrc = readFileSync(joinPath(__dirname, "scene3d", "statics.js"), "utf8");
check("statics rAF arm gated to particleClockMode() === \"off\"",
  /if \(typeof window !== "undefined" && _staticScriptsEnabled\(\) && particleClockMode\(\) === "off"\)/.test(staticsSrc));
check("statics.js imports particleClockMode",
  staticsSrc.includes('import { particleClockMode } from "./particles/time_rng.js"'));

const indexSrc = readFileSync(joinPath(__dirname, "scene3d", "index.js"), "utf8");
check("index.js installs the =sim clock hook (setCurrentTime over _particleSimNowS)",
  indexSrc.includes('if (particleClockMode() === "sim")') &&
  indexSrc.includes("setCurrentTime(() => liveScene3d._particleSimNowS)"));

const flagsDoc = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
check("docs/url-flags.md documents ?particleClock", flagsDoc.includes("particleClock"));

// ---------------------------------------------------------------------
console.log(`\nA11-S3 particle clock: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
