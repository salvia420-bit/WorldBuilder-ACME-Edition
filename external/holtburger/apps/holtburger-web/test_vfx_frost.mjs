// VFX Phase 1 — weathering.frost component unit test.
//
// Locks: the frost component registers with a legacy-safe manifest, its source
// passes the lint, it injects POST `<map_fragment>` (post palette decode), binds
// the shared globals BY REFERENCE (one per-frame tick drives every material), keeps
// the program key per-SET (linkVariant stable across config -> no shader-link
// explosion), carries the rain/frost mutual-exclusion gate, and is an exact no-op
// at uFrost==0 (off == identical). THREE-free (operates on a plain shader object).

import fs from "node:fs";
import path from "node:path";
import { frost } from "./scene3d/vfx/components/frost.js"; // registers it
import { getComponent, validateComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal MeshStandard-ish fragment shader with the two seams the inject targets.
function fakeShader() {
  return {
    uniforms: {},
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader:
      "uniform vec3 diffuse;\nvoid main() {\nvec4 diffuseColor = vec4(diffuse, 1.0);\n" +
      "#include <map_fragment>\n#include <roughnessmap_fragment>\n}",
  };
}

// ---- registration + identity ----
check("registered as weathering.frost", getComponent("weathering.frost") === frost);
check("family/mech = weathering/frag; channel shared with wetness (precip)",
  frost.family === "weathering" && frost.mech === "frag" && frost.channel === "precip");
check("validateComponent(frost) clean", validateComponent(frost).length === 0,
  validateComponent(frost).join("; "));

// ---- manifest (legacy-safety) ----
check("lintManifest(frost) clean", lintManifest(frost).length === 0, lintManifest(frost).join("; "));
check("reads ⊆ ALLOWED_READS (clock,weather,geometry)", frost.reads.every((r) => ALLOWED_READS.has(r)));
check("writes ⊆ ALLOWED_WRITES (materialUniform only)",
  frost.writes.length === 1 && frost.writes[0] === "materialUniform" && ALLOWED_WRITES.has(frost.writes[0]));
check("legacy-safe scalars: deterministic + lightCountDelta 0 + cacheKeyScope set",
  frost.deterministic === true && frost.lightCountDelta === 0 && frost.cacheKeyScope === "set");

// ---- firewall: linkVariant stable across config -> O(set) programs, never per-DID ----
check("★ linkVariant() == '' for any config (no per-instance/per-config program)",
  frost.linkVariant({ lighten: 0.6 }) === "" && frost.linkVariant({ lighten: 0.95, sparkle: 1 }) === "");
const src = fs.readFileSync(path.resolve("scene3d/vfx/components/frost.js"), "utf8");
check("★ source never references customProgramCacheKey (firewall: key is per-SET)",
  !src.includes("customProgramCacheKey"));

// ---- Layer B: source lint clean ----
check("lintSource(frost.js) clean (no forbidden patterns)", lintSource(src).length === 0,
  lintSource(src).map((h) => `${h.lineno}:${h.label}`).join("; "));

// ---- inject: seam, ordering, uniform decls ----
const s = fakeShader();
frost.inject(s);
const f = s.fragmentShader;
const iMap = f.indexOf("#include <map_fragment>");
const iFrost = f.indexOf("_frost = clamp(uFrost");
check("★ frost block injected AFTER #include <map_fragment> (post palette decode)",
  iMap >= 0 && iFrost > iMap);
check("frost block lands BEFORE #include <roughnessmap_fragment> (diffuse, not spec)",
  iFrost < f.indexOf("#include <roughnessmap_fragment>"));
check("uniforms declared before void main()",
  f.indexOf("uniform float uFrostLighten;") < f.indexOf("void main()") &&
  f.includes("uniform float uFrost;") && f.includes("uniform float uTime;") && f.includes("uniform float uWetness;"));
check("★ carries the rain/frost mutual-exclusion gate (1.0 - clamp(uWetness ...))",
  f.includes("(1.0 - clamp(uWetness"));
check("★ off==identical: effect scaled by _frost (uFrost==0 -> no-op on diffuseColor)",
  f.includes("diffuseColor.rgb = mix(_base, _f, _frost)") && f.includes("if (_frost > 0.0001)"));
check("sparkle guarded by USE_UV (safe on UV-less materials)",
  /#ifdef\s+USE_UV[\s\S]*vMapUv[\s\S]*#endif/.test(f));
check("vertex shader untouched (frost is a fragment-only weathering patch)",
  s.vertexShader === "void main() {\n#include <begin_vertex>\n}");

// inject idempotent within one compile (guard prevents a duplicate block).
const before = f;
frost.inject(s);
check("inject() idempotent (no duplicate block on re-run)",
  s.fragmentShader === before && (s.fragmentShader.match(/_frost = clamp\(uFrost/g) || []).length === 1);

// ---- declareUniforms: BY-REFERENCE globals + config-as-uniform ----
const globals = { uTime: { value: 0 }, uFrost: { value: 0 }, uWetness: { value: 0 } };
const s2 = fakeShader();
frost.declareUniforms(s2, {}, globals);
check("★ shared globals bound BY REFERENCE (uFrost/uTime/uWetness === the global object)",
  s2.uniforms.uFrost === globals.uFrost && s2.uniforms.uTime === globals.uTime && s2.uniforms.uWetness === globals.uWetness);
globals.uFrost.value = 0.7; // the per-frame tick mutates the shared {value}
check("★ a tick on the global drives the bound uniform (shared {value})",
  s2.uniforms.uFrost.value === 0.7);
check("config defaults applied as uniforms",
  s2.uniforms.uFrostLighten.value === frost.defaults.lighten && s2.uniforms.uFrostSparkleScale.value === frost.defaults.sparkleScale);
const s3 = fakeShader();
frost.declareUniforms(s3, { lighten: 0.9, sparkle: 0.4 }, globals);
check("config overrides flow through uniforms (NOT the cache key)",
  s3.uniforms.uFrostLighten.value === 0.9 && s3.uniforms.uFrostSparkle.value === 0.4);

console.log(`\nVFX weathering.frost component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
