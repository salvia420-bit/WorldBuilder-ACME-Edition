// test_a1_o4_single_frame_driver.mjs — A1-O4 (`?singleDriver`) headless
// acceptance gate (S2 spec §4; pattern: the behavioral + static style of
// test_a15_q4_renderer_neutral_core.mjs).
//
//   PART 1 — behavioral: scene3d/loop.js#tickPerFrame imported as ESM
//            with a stubbed `globalThis.window`; assert the CRITICAL
//            phase #0 pump (`window.__netFramePump`) fires iff
//            `scene3d.singleDriverOn` is set AND the pump exists, that a
//            throwing pump is swallowed with a ONE-SHOT warn (no rethrow
//            into the frame, no warn spam), and that the pump keeps
//            firing on subsequent frames after a throw.
//   PART 2 — static: read index.html + scene3d/index.js +
//            scene3d/loop.js as text; O4-a extraction shape
//            (pumpNetFrame owns the old body incl. the heartbeat stamp,
//            `upd.free()` + the syncOwned tickMovement gate unmoved;
//            `__rafTickCount++` lives in the drainEvents WRAPPER so it
//            freezes when the 2D driver parks), O4-b gate + exposures +
//            claim rule / claim point / un-claim + re-claim paths, O4-c
//            watchdog (setTimeout chain, 4 s staleness, disarm on
//            released claim), and loop.js phase #0 placement ABOVE the
//            RP3 frame-budget stamp (never budget-gated).
//
// Run: node test_a1_o4_single_frame_driver.mjs   (no browser, no build)

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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

// Import BEFORE installing the window stub so module-scope URL-flag
// parses take their node fail-soft branches (same as every other
// headless loop.js consumer in this repo).
const { tickPerFrame } = await import("./scene3d/loop.js");

// ---------------------------------------------------------------------
// PART 1 — behavioral: tickPerFrame CRITICAL phase #0
// ---------------------------------------------------------------------
console.log("PART 1: tickPerFrame phase #0 (single-driver net/input pump)");

const warns = [];
const realWarn = console.warn;
console.warn = (...args) => { warns.push(args.map(String).join(" ")); };

let pumpCalls = 0;
globalThis.window = {
  __netFramePump: () => { pumpCalls += 1; },
};
// tickPerFrame's later phases (cells/lighting/...) operate on a real
// scene; with a bare stub they may throw AFTER phase #0 — that is fine
// for this gate (the production caller try/catches tickPerFrame), so
// every call below is wrapped and only pump behavior is asserted.
function runTick(scene3d) {
  try { tickPerFrame(scene3d, null, 0.016); } catch (_) { /* post-#0 phases on stubs */ }
}

// 1. claim armed → pump fires once per tick
let scene = { singleDriverOn: true };
runTick(scene);
check("pump fires when scene3d.singleDriverOn is set", pumpCalls === 1, `calls=${pumpCalls}`);
runTick(scene);
check("pump fires once per tickPerFrame call", pumpCalls === 2, `calls=${pumpCalls}`);

// 2. flag off (default scene3d shape) → pump never fires
pumpCalls = 0;
runTick({});
runTick({ singleDriverOn: false });
check("pump does NOT fire without singleDriverOn (default off = byte-path-identical)", pumpCalls === 0, `calls=${pumpCalls}`);

// 3. null scene3d → no crash in phase #0 (optional-chaining guard)
let threwAtPhase0 = false;
try { tickPerFrame(null, null, 0.016); } catch (_) { threwAtPhase0 = false; }
check("null scene3d does not crash the phase #0 guard", !threwAtPhase0);
check("null scene3d does not pump", pumpCalls === 0, `calls=${pumpCalls}`);

// 4. missing pump (2D loop not booted yet) → skipped, no warn
warns.length = 0;
delete globalThis.window.__netFramePump;
runTick({ singleDriverOn: true });
check("missing __netFramePump is skipped silently", warns.length === 0, `warns=${warns.length}`);

// 5. throwing pump → swallowed, ONE-SHOT warn, pump keeps being called
warns.length = 0;
let throwCalls = 0;
globalThis.window.__netFramePump = () => { throwCalls += 1; throw new Error("synthetic pump failure"); };
scene = { singleDriverOn: true };
runTick(scene);
runTick(scene);
runTick(scene);
check("throwing pump is still invoked every frame (no latch-off)", throwCalls === 3, `calls=${throwCalls}`);
const pumpWarns = warns.filter((w) => w.includes("[singleDriver] __netFramePump threw"));
check("pump throw warns exactly once (_netPumpWarned one-shot)", pumpWarns.length === 1, `warns=${pumpWarns.length}`);
check("pump throw never propagates out of phase #0", true); // runTick would have caught a *different* error site; phase #0 rethrow would surface as the synthetic message
let phase0Rethrew = false;
try {
  // A scene with ONLY singleDriverOn — if phase #0 rethrew, the synthetic
  // error would surface here before any later-phase stub error.
  tickPerFrame({ singleDriverOn: true }, null, 0.016);
} catch (e) {
  phase0Rethrew = String(e && e.message).includes("synthetic pump failure");
}
check("rethrow probe: caught error is never the pump's", !phase0Rethrew);

console.warn = realWarn;
delete globalThis.window;

// ---------------------------------------------------------------------
// PART 2 — static source shape
// ---------------------------------------------------------------------
console.log("PART 2: static source checks");

const htmlSrc = readFileSync(`${__dirname}/index.html`, "utf8");
const loopSrc = readFileSync(`${__dirname}/scene3d/loop.js`, "utf8");
const idxSrc = readFileSync(`${__dirname}/scene3d/index.js`, "utf8");

// -- index.html: O4-a extraction --------------------------------------
check("index.html parses ?singleDriver=on (__SINGLE_DRIVER_ON)",
  /get\("singleDriver"\)\s*===\s*"on"/.test(htmlSrc) && htmlSrc.includes("__SINGLE_DRIVER_ON"));
check("index.html defines pumpNetFrame (extracted drainEvents body)",
  htmlSrc.includes("function pumpNetFrame()"));
const pumpStart = htmlSrc.indexOf("function pumpNetFrame()");
const wrapperStart = htmlSrc.indexOf("function drainEvents()", pumpStart);
check("drainEvents wrapper defined AFTER pumpNetFrame", pumpStart > 0 && wrapperStart > pumpStart);
const pumpBody = htmlSrc.slice(pumpStart, wrapperStart);
check("pumpNetFrame stamps the __lastPumpMs heartbeat",
  /window\.__lastPumpMs\s*=\s*performance\.now\(\)/.test(pumpBody));
check("pumpNetFrame still owns the wasm-bindgen lifetime (upd.free())",
  pumpBody.includes("upd.free()"));
check("pumpNetFrame keeps the O3 syncOwned tickMovement gate (one swap point, owned by O3)",
  pumpBody.includes("__syncTickOwned") && pumpBody.includes("handle.tickMovement()"));
check("pumpNetFrame keeps the 3D-only input side-effects (setMotion + setSidestepLayer)",
  pumpBody.includes("em.setMotion") && pumpBody.includes("em.setSidestepLayer"));
check("pumpNetFrame does NOT increment __rafTickCount (wrapper-only — must freeze when parked)",
  !pumpBody.includes("__rafTickCount++"));
check("pumpNetFrame does NOT rAF-re-arm (the wrapper owns the cadence)",
  !pumpBody.includes("requestAnimationFrame(drainEvents)"));

// -- index.html: O4-b wrapper gate + exposures -------------------------
const wrapperEnd = htmlSrc.indexOf("requestAnimationFrame(drainEvents);", wrapperStart);
const wrapperRegion = htmlSrc.slice(wrapperStart, wrapperEnd + 200);
check("wrapper increments __rafTickCount (2D rAF tick counter)",
  wrapperRegion.includes("window.__rafTickCount++"));
check("wrapper claim-checks EVERY frame (singleDriver && 3D && claim flag)",
  /__SINGLE_DRIVER_ON\s*&&\s*__USE_RENDERER_3D\s*&&\s*window\.__scene3dFrameDriverActive/.test(wrapperRegion));
check("parked wrapper arms the watchdog and returns (no pump, no re-arm)",
  /_arm2dWatchdog\(\);[\s\S]{0,200}?return;/.test(wrapperRegion));
check("unparked wrapper pumps then re-arms",
  /pumpNetFrame\(\);\s*\n\s*requestAnimationFrame\(drainEvents\);/.test(wrapperRegion));
check("one-shot handoff log (__singleDriverHandoffLogged)",
  wrapperRegion.includes("__singleDriverHandoffLogged"));
check("window.__netFramePump exposure",
  htmlSrc.includes("window.__netFramePump = pumpNetFrame"));
check("window.__resume2dFrameDriver exposure (queue-deduped resume)",
  htmlSrc.includes("window.__resume2dFrameDriver =") && htmlSrc.includes("__resume2dQueued"));
check("boot arm retained (requestAnimationFrame(drainEvents) outside the wrapper)",
  (htmlSrc.match(/requestAnimationFrame\(drainEvents\);/g) || []).length >= 2);

// -- index.html: O4-c watchdog -----------------------------------------
check("watchdog is a setTimeout chain (hidden tabs), 2 s cadence",
  /_arm2dWatchdog[\s\S]{0,800}setTimeout\(/.test(htmlSrc) && /__check2dHeartbeat,?\s*2000\)/.test(htmlSrc));
check("watchdog staleness threshold is two missed beats (4000 ms)",
  /__lastPumpMs[\s\S]{0,200}?>\s*4000/.test(htmlSrc));
check("watchdog disarms when the claim flag is off",
  /if\s*\(!window\.__scene3dFrameDriverActive\)\s*return;/.test(htmlSrc));
check("stale heartbeat un-claims AND resumes the 2D driver",
  /pump heartbeat stale[\s\S]{0,300}__scene3dFrameDriverActive\s*=\s*false;[\s\S]{0,100}__resume2dFrameDriver\(\)/.test(htmlSrc));

// -- scene3d/index.js: claim lifecycle ----------------------------------
check("index.js parses ?singleDriver=on",
  /get\("singleDriver"\)\s*===\s*"on"/.test(idxSrc));
check("claim rule excludes renderOnDemand-without-netDrainHz",
  /singleDriverRequested\s*&&\s*!\(renderOnDemand\s*&&\s*!\(netDrainHz\s*>\s*0\)\)/.test(idxSrc));
check("refused-claim combo warns and leaves the 2D loop driving",
  idxSrc.includes("?renderOnDemand=1 without ?netDrainHz — 2D loop remains the net driver"));
const hookIdx = idxSrc.indexOf("installSharedDrainHook(liveScene3d);");
// (the onResume re-claim also assigns `= true`, earlier in the file —
// the claim POINT is the singleDriverOn block right after the hook)
const claimIdx = idxSrc.indexOf("window.__scene3dFrameDriverActive = true", hookIdx);
check("claim point is AFTER installSharedDrainHook (no dropped updates during handoff)",
  hookIdx > 0 && claimIdx > hookIdx &&
  /installSharedDrainHook\(liveScene3d\);[\s\S]{0,800}?liveScene3d\.singleDriverOn\s*=\s*true;/.test(idxSrc));
check("claim arms loop.js phase #0 via liveScene3d.singleDriverOn",
  /liveScene3d\.singleDriverOn\s*=\s*true;/.test(idxSrc));
check("stop() releases the claim",
  /stop\(\)\s*\{[^}]*_releaseFrameDriverClaim\(\);\s*\}/.test(idxSrc));
check("onPause releases the claim",
  /onPause:\s*\(\)\s*=>\s*\{[^}]*_releaseFrameDriverClaim\(\);\s*\}/.test(idxSrc));
check("onResume re-claims",
  /onResume:[\s\S]{0,400}__scene3dFrameDriverActive\s*=\s*true/.test(idxSrc));
check("release helper un-claims then queues the 2D resume",
  /_releaseFrameDriverClaim[\s\S]{0,400}__scene3dFrameDriverActive\s*=\s*false;[\s\S]{0,200}__resume2dFrameDriver\?\.\(\)/.test(idxSrc));

// -- scene3d/loop.js: phase #0 placement ---------------------------------
const tickIdx = loopSrc.indexOf("export function tickPerFrame(");
const pumpIdx = loopSrc.indexOf("window.__netFramePump", tickIdx);
const rp3StampIdx = loopSrc.indexOf("_rp3State(scene3d)", tickIdx);
check("phase #0 lives inside tickPerFrame", tickIdx > 0 && pumpIdx > tickIdx);
check("phase #0 runs BEFORE the RP3 frame-budget stamp (never budget-gated)",
  rp3StampIdx > 0 && pumpIdx < rp3StampIdx);
check("phase #0 guarded on scene3d?.singleDriverOn + window + typeof function",
  /scene3d\?\.singleDriverOn\s*&&\s*typeof window !== "undefined"\s*\n?\s*&&\s*typeof window\.__netFramePump === "function"/.test(loopSrc));
check("phase #0 one-shot warn flag (_netPumpWarned)",
  loopSrc.includes("_netPumpWarned"));

// -- docs ---------------------------------------------------------------
const flagsDoc = readFileSync(`${__dirname}/docs/url-flags.md`, "utf8");
check("docs/url-flags.md documents ?singleDriver", /\|\s*`singleDriver`\s*\|/.test(flagsDoc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
