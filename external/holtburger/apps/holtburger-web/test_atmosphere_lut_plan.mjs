// test_atmosphere_lut_plan.mjs — scene3d/atmosphere_lut_plan.js (`?atmosphereLut`).
//
// What must hold: explicit `load`/`bake` (and their synonyms) win over the
// bandwidth tier; absent/`auto` bakes on a LOW session and downloads on a
// HIGH one with the ATMOSPHERE_LOAD_TIMEOUT_MS race armed; garbage reads auto.
//
// Run: cd apps/holtburger-web && node test_atmosphere_lut_plan.mjs
import {
  ATMOSPHERE_LOAD_TIMEOUT_MS,
  atmosphereLutMode,
  atmosphereLutPlan,
} from "./scene3d/atmosphere_lut_plan.js";
import { _resetBandwidthTierForTest } from "./scene3d/bandwidth_tier.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

console.log("\nmode grammar");
for (const v of ["load", "exr", "download", "LOAD"]) check(`'${v}' ⇒ load`, atmosphereLutMode(`?atmosphereLut=${v}`) === "load");
for (const v of ["bake", "gpu", "generate"]) check(`'${v}' ⇒ bake`, atmosphereLutMode(`?atmosphereLut=${v}`) === "bake");
check("absent ⇒ auto", atmosphereLutMode("") === "auto");
check("garbage ⇒ auto", atmosphereLutMode("?atmosphereLut=banana") === "auto");

console.log("\nplan");
check("explicit load beats a low tier", JSON.stringify(atmosphereLutPlan({ mode: "load", low: true })) ===
  JSON.stringify({ preferLoad: true, timeoutMs: 0, reason: "url:load" }));
check("explicit bake beats a high tier", atmosphereLutPlan({ mode: "bake", low: false }).preferLoad === false);
check("auto + low ⇒ bake, no download", JSON.stringify(atmosphereLutPlan({ mode: "auto", low: true })) ===
  JSON.stringify({ preferLoad: false, timeoutMs: 0, reason: "bandwidth:low" }));
const hi = atmosphereLutPlan({ mode: "auto", low: false });
check("auto + high ⇒ download with the race armed",
  hi.preferLoad === true && hi.timeoutMs === ATMOSPHERE_LOAD_TIMEOUT_MS && hi.reason === "bandwidth:high");
check("race window is generous for a fast link (>= 10 s)", ATMOSPHERE_LOAD_TIMEOUT_MS >= 10000);
_resetBandwidthTierForTest({ tier: "low" });
check("reads the live tier when not injected (low ⇒ bake)", atmosphereLutPlan({ mode: "auto" }).preferLoad === false);
_resetBandwidthTierForTest({ tier: "high" });
check("reads the live tier when not injected (high ⇒ load)", atmosphereLutPlan({ mode: "auto" }).preferLoad === true);
_resetBandwidthTierForTest();

console.log("\nlow-session bake waits for in-world (never during the login handshake)");
{
  const { waitForInWorld } = await import("./scene3d/atmosphere_runtime.js");
  globalThis.window = { __bootState: "connecting", __bootStateHistory: [{ state: "connecting" }] };
  let done = false;
  const p = waitForInWorld(5000).then((v) => { done = v; });
  await new Promise((r) => setTimeout(r, 400));
  check("still waiting while connecting", done === false);
  window.__bootState = "in-world";
  await p;
  check("resolves true once in-world", done === true);
  window.__bootState = "ready"; // in-world already moved on to ready
  window.__bootStateHistory = [{ state: "connecting" }, { state: "in-world" }, { state: "ready" }];
  check("sticky: ready-after-in-world also counts", (await waitForInWorld(1000)) === true);
  window.__bootState = "error";
  window.__bootStateHistory = [{ state: "error" }];
  const t0 = Date.now();
  const v = await waitForInWorld(600);
  check("bounded: gives up after maxMs (then the bake runs anyway)", v === false && Date.now() - t0 >= 550);
  delete globalThis.window;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
