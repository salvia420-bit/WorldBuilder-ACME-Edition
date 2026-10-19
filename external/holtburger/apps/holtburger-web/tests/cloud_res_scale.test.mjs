// 2026-10-19 — ?cloudResScale (scene3d/cloud_res_scale.js): the volumetric
// clouds' render resolution, takram's documented `resolutionScale`.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/cloud_res_scale.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCloudResScale, applyCloudResScale, CLOUD_RES_SCALE_MIN } from "../scene3d/cloud_res_scale.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- R1 parser -----------------------------------------------------------");
check("absent -> null (takram's default stays)", parseCloudResScale("") === null && parseCloudResScale("?x=1") === null);
check("0.5 -> 0.5", parseCloudResScale("?cloudResScale=0.5") === 0.5);
check("clamped to [0.25, 1]", parseCloudResScale("?cloudResScale=0.1") === CLOUD_RES_SCALE_MIN && parseCloudResScale("?cloudResScale=3") === 1);
check("junk / zero / negative -> null", ["abc", "0", "-1", ""].every((v) => parseCloudResScale(`?cloudResScale=${v}`) === null));

console.log("-- R2 apply ------------------------------------------------------------");
{
  // takram's setter: `resolutionScale` forwards to Resolution, which resizes on change.
  let sets = 0;
  const effect = { _s: 1, get resolutionScale() { return this._s; }, set resolutionScale(v) { sets++; this._s = v; } };
  check("applies and returns the scale", applyCloudResScale(effect, 0.5) === 0.5 && effect.resolutionScale === 0.5 && sets === 1);
  check("an unchanged scale does not re-set (no needless resize)", applyCloudResScale(effect, 0.5) === 0.5 && sets === 1);
  check("clamps", applyCloudResScale(effect, 0.01) === CLOUD_RES_SCALE_MIN);
  check("no such property -> null", applyCloudResScale({}, 0.5) === null && applyCloudResScale(null, 0.5) === null);
  check("junk -> null", applyCloudResScale(effect, "x") === null);
}

console.log("-- R3 wiring -----------------------------------------------------------");
{
  const idx = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
  const q = idx.indexOf("effect.qualityPreset = qualityParam;");
  const r = idx.indexOf("const cloudResScale = parseCloudResScale(window.location.search);");
  check("applied after ?cloudQuality (a preset assigns resolutionScale 1 back)", q > 0 && r > q);
  check("__setCloudQuality re-applies the URL scale after a preset",
    /effect\.qualityPreset = p;\s*\/\/[^\n]*\n\s*if \(cloudResScale !== null\) applyCloudResScale\(effect, cloudResScale\);/.test(idx));
  check("live setter __setCloudResScale", /window\.__setCloudResScale = \(n\) => applyCloudResScale\(effect, n\);/.test(idx));
  const vendor = readFileSync(path.join(APP, "vendor", "takram-three-clouds", "build", "index.js"), "utf8");
  check("premise: takram's quality presets carry resolutionScale (so a preset resets it)", /var values = \{\s*resolutionScale: 1,/.test(vendor));
  check("premise: takram resizes on a resolution change",
    vendor.includes('this.resolution.addEventListener("change", this.onResolutionChange);') && vendor.includes("set resolutionScale(value) {"));
}

console.log(`\ncloud res scale: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
