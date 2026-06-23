// VFX Phase 1 — weathering.tarnish unit test.
//
// Locks: the component registers + passes the legacy-safety manifest AND source
// lint; the GLSL tints diffuse POST #include <map_fragment> (post-palette decode)
// and bumps roughnessFactor at #include <roughnessmap_fragment>; per-instance
// amount rides the vVfxHash varying (firewall: never a per-instance program key);
// the shine-restore knob (uTarnishAge -> 0) is a plain uniform; inject is
// idempotent and composes after a prior same-seam (detail) patch.

import fs from "node:fs";
import path from "node:path";
import { tarnish, _glsl } from "./scene3d/vfx/components/tarnish.js"; // registers it
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
function count(hay, needle) { return hay.split(needle).length - 1; }

// A minimal MeshStandard-shaped fragment shader with the seams we patch.
function fakeShader() {
  return {
    uniforms: {},
    defines: {},
    vertexShader: "void main() {\n  gl_Position = vec4(0.0);\n}",
    fragmentShader: [
      "void main() {",
      "  vec4 diffuseColor = vec4( diffuse, opacity );",
      "  #include <map_fragment>",
      "  #include <color_fragment>",
      "  #include <roughnessmap_fragment>",
      "  #include <metalnessmap_fragment>",
      "  #include <emissivemap_fragment>",
      "}",
    ].join("\n"),
  };
}

// ---- Registration + manifest ----
check("registered as weathering.tarnish", getComponent("weathering.tarnish") === tarnish);
check("validateComponent(tarnish) clean", validateComponent(tarnish).length === 0, validateComponent(tarnish).join("; "));
check("lintManifest(tarnish) clean", lintManifest(tarnish).length === 0, lintManifest(tarnish).join("; "));
check("family/mech/channel = weathering/frag/tarnish",
  tarnish.family === "weathering" && tarnish.mech === "frag" && tarnish.channel === "tarnish");
check("legacy-safe scalars: lightCountDelta 0 + deterministic + cacheKeyScope set",
  tarnish.lightCountDelta === 0 && tarnish.deterministic === true && tarnish.cacheKeyScope === "set");
check("reads ⊆ ALLOWED_READS (setup, instanceHash; no clock/weather/server state)",
  tarnish.reads.length > 0 && tarnish.reads.every((r) => ALLOWED_READS.has(r)) &&
  tarnish.reads.includes("setup") && tarnish.reads.includes("instanceHash"));
check("writes ⊆ ALLOWED_WRITES (materialUniform only)",
  tarnish.writes.length === 1 && tarnish.writes[0] === "materialUniform" && ALLOWED_WRITES.has("materialUniform"));
check("defaults mirror visual_archetype_rules rigid-glint (amount hash01, roughTarget 1, topWeight .6)",
  tarnish.defaults.amount === "hash01" && tarnish.defaults.roughTarget === 1.0 && tarnish.defaults.topWeight === 0.6);

// ---- Firewall: linkVariant is per-SET, never per-instance ----
check("linkVariant() = '' for the default uniform-only look (shares one program)",
  tarnish.linkVariant({}) === "" && tarnish.linkVariant() === "");
check("linkVariant() = 'blotch' for the textured variant (stable per-SET bit, not per-instance)",
  tarnish.linkVariant({ blotchMap: "x" }) === "blotch");

// ---- declareUniforms ----
{
  const s = fakeShader();
  tarnish.declareUniforms(s, {});
  check("declareUniforms binds the tint as a plain vec3 array (THREE-free)",
    Array.isArray(s.uniforms.uTarnishTint.value) && s.uniforms.uTarnishTint.value.length === 3);
  check("amount 'hash01' -> uTarnishAmount sentinel -1 (use per-instance hash)",
    s.uniforms.uTarnishAmount.value === -1.0);
  check("default age 1.0 (fully aged) bound", s.uniforms.uTarnishAge.value === 1.0);
  check("roughTarget default 1.0 bound", s.uniforms.uTarnishRoughTarget.value === 1.0);
}
{
  const s = fakeShader();
  tarnish.declareUniforms(s, { amount: 0.42, age: 0.0 });
  check("constant amount config -> uTarnishAmount = clamp(amount) (not the hash sentinel)",
    Math.abs(s.uniforms.uTarnishAmount.value - 0.42) < 1e-9);
  check("★ shine-restore: age 0 -> uTarnishAge 0 (lerp uTarnish->0 polishes; pure uniform)",
    s.uniforms.uTarnishAge.value === 0.0);
}

// ---- inject GLSL: seams + ordering ----
{
  const s = fakeShader();
  tarnish.declareUniforms(s, {});
  tarnish.inject(s);
  const fs2 = s.fragmentShader;
  check("inject declares the uniform block (uniform vec3 uTarnishTint;)",
    fs2.includes("uniform vec3 uTarnishTint;"));
  check("inject declares the function-scoped accumulator float _vfxTarnishT",
    fs2.includes("float _vfxTarnishT = 0.0;"));
  check("diffuse tint present (diffuseColor.rgb = mix(.. uTarnishTint ..))",
    fs2.includes("diffuseColor.rgb = mix(diffuseColor.rgb, uTarnishTint, _vfxTarnishT);"));
  check("roughness bump present (roughnessFactor = mix(.. uTarnishRoughTarget ..))",
    fs2.includes("roughnessFactor = mix(roughnessFactor, uTarnishRoughTarget, _vfxTarnishT);"));
  // POST-palette: the tint must land AFTER #include <map_fragment>, not before.
  const iMap = fs2.indexOf("#include <map_fragment>");
  const iTint = fs2.indexOf("diffuseColor.rgb = mix(diffuseColor.rgb, uTarnishTint");
  check("★ POST-palette decode: diffuse tint is AFTER #include <map_fragment>",
    iMap >= 0 && iTint > iMap);
  // Roughness write must land after #include <roughnessmap_fragment> (where roughnessFactor exists).
  const iRm = fs2.indexOf("#include <roughnessmap_fragment>");
  const iRough = fs2.indexOf("roughnessFactor = mix(roughnessFactor, uTarnishRoughTarget");
  check("roughness bump is AFTER #include <roughnessmap_fragment> (roughnessFactor in scope)",
    iRm >= 0 && iRough > iRm);
  // Accumulator declared before it is read at the roughness seam.
  check("accumulator declared before the roughness read",
    fs2.indexOf("float _vfxTarnishT = 0.0;") < iRough);
  // Per-instance hash path present (the #ifdef + vVfxHash reference).
  check("per-instance variation via vVfxHash under #ifdef VFX_INSTANCE_HASH",
    fs2.includes("#ifdef VFX_INSTANCE_HASH") && fs2.includes("float _tInst = vVfxHash;"));
  check("uniform-only fallback present (uTarnishHashFallback) when the hash infra is absent",
    fs2.includes("float _tInst = uTarnishHashFallback;"));
}

// ---- Idempotency ----
{
  const s = fakeShader();
  tarnish.inject(s);
  tarnish.inject(s);
  check("inject is idempotent (uniform block declared exactly once)",
    count(s.fragmentShader, "uniform vec3 uTarnishTint;") === 1);
  check("inject is idempotent (diffuse tint emitted exactly once)",
    count(s.fragmentShader, "uTarnishTint, _vfxTarnishT") === 1);
}

// ---- Composition with a prior same-seam patch (legacy detail) ----
{
  const s = fakeShader();
  // Simulate the Phase 0.2 detail patch having already appended after map_fragment.
  s.fragmentShader = s.fragmentShader.replace(
    "#include <map_fragment>",
    "#include <map_fragment>\n  { /* detail modulate */ diffuseColor.rgb *= 1.0; }",
  );
  tarnish.inject(s);
  const fs2 = s.fragmentShader;
  const iMap = fs2.indexOf("#include <map_fragment>");
  const iTint = fs2.indexOf("uTarnishTint, _vfxTarnishT");
  check("composes after a prior detail patch: tint still lands after <map_fragment>",
    iMap >= 0 && iTint > iMap);
}

// ---- Firewall: the component never touches a per-instance program key ----
{
  const src = fs.readFileSync(path.resolve("scene3d/vfx/components/tarnish.js"), "utf8");
  // Comment-stripped, so the doc-comment mentioning the word can't false-positive
  // (mirrors lint_caps _blankComments). The firewall concern is an ASSIGNMENT —
  // the component must never SET customProgramCacheKey (only materials.js does, per-SET).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  check("source never ASSIGNS customProgramCacheKey (firewall: per-SET only, set by materials.js)",
    !/customProgramCacheKey\s*=/.test(code));
  check("component object exposes no customProgramCacheKey override",
    tarnish.customProgramCacheKey === undefined);
  check("★ Layer B source lint clean (no Math.random / wire / collision / .visible)",
    lintSource(src).length === 0, JSON.stringify(lintSource(src)));
}

console.log(`\nVFX tarnish component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
