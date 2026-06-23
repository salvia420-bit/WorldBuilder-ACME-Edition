// VFX Phase 1 — emissive.magicGlow unit test.
//
// Locks: the component registers + lints clean (manifest + source), the GLSL
// seam lands the ambient-glow accumulate AFTER <emissivemap_fragment> (so it
// reads the resolved/palette-decoded diffuseColor), the uGlow uniform is
// declared + clamped to the (0, 2.0] luminosity floor, and the firewall holds
// (config-invariant link variant, set-scoped cache key, no per-instance program).
// No `three` dependency: we assert against a faked shader, exactly like the
// other test_vfx_*.mjs harnesses.

import fs from "node:fs";
import path from "node:path";
import { magicGlow } from "./scene3d/vfx/components/magicGlow.js"; // registers it
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal stand-in for the MeshStandardMaterial fragment shader, carrying the
// canonical chunk seams in their real order (map -> ... -> emissivemap).
function fakeShader() {
  return {
    uniforms: {},
    vertexShader: ["#include <common>", "#include <begin_vertex>"].join("\n"),
    fragmentShader: [
      "#include <common>",
      "void main() {",
      "\tvec4 diffuseColor = vec4( diffuse, opacity );",
      "\tReflectedLight reflectedLight = ReflectedLight( vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0) );",
      "\tvec3 totalEmissiveRadiance = emissive;",
      "\t#include <map_fragment>",
      "\t#include <roughnessmap_fragment>",
      "\t#include <emissivemap_fragment>",
      "\t#include <opaque_fragment>",
      "}",
    ].join("\n"),
  };
}

// ---- registration + manifest ----
check("registered as emissive.magicGlow", getComponent("emissive.magicGlow") === magicGlow);
check("validateComponent(magicGlow) clean", validateComponent(magicGlow).length === 0,
  validateComponent(magicGlow).join("; "));
check("lintManifest clean", lintManifest(magicGlow).length === 0, lintManifest(magicGlow).join("; "));
check("family/mech/channel", magicGlow.family === "emissive" && magicGlow.mech === "frag" && magicGlow.channel === "glow");
check("legacy-safe scalars: deterministic + lightCountDelta 0 + cacheKeyScope set",
  magicGlow.deterministic === true && magicGlow.lightCountDelta === 0 && magicGlow.cacheKeyScope === "set");
check("reads ⊆ ALLOWED_READS (surface only)",
  magicGlow.reads.length === 1 && magicGlow.reads[0] === "surface" && magicGlow.reads.every((r) => ALLOWED_READS.has(r)));
check("writes ⊆ ALLOWED_WRITES (materialUniform)",
  magicGlow.writes.length === 1 && magicGlow.writes[0] === "materialUniform" && magicGlow.writes.every((w) => ALLOWED_WRITES.has(w)));

// ---- firewall: config-invariant link variant (no per-instance program) ----
check("★ linkVariant() === '' for any config (set key carries only presence)",
  magicGlow.linkVariant({ glow: 0.2 }) === "" && magicGlow.linkVariant({ glow: 1.9 }) === "");

// ---- declareUniforms: clamp to (0, 2.0] ----
let s = fakeShader();
magicGlow.declareUniforms(s, { glow: 0.6 });
check("declareUniforms sets uGlow from config", s.uniforms.uGlow && s.uniforms.uGlow.value === 0.6);
s = fakeShader(); magicGlow.declareUniforms(s, { glow: 5.0 });
check("★ uGlow clamped to floor cap 2.0 (emissiveIntensity parity)", s.uniforms.uGlow.value === 2.0);
s = fakeShader(); magicGlow.declareUniforms(s, { glow: -3 });
check("uGlow floored at 0", s.uniforms.uGlow.value === 0);
s = fakeShader(); magicGlow.declareUniforms(s, {});
check("uGlow falls back to default 0.6 when config missing", s.uniforms.uGlow.value === 0.6);
s = fakeShader(); magicGlow.declareUniforms(s, { glow: NaN });
check("uGlow rejects NaN -> default", s.uniforms.uGlow.value === 0.6);

// ---- inject: GLSL seam ----
s = fakeShader();
magicGlow.inject(s);
const fs0 = s.fragmentShader;
check("inject declares `uniform float uGlow;`", fs0.includes("uniform float uGlow;"));
check("inject adds the accumulate term", fs0.includes("totalEmissiveRadiance += diffuseColor.rgb * uGlow;"));
const iEmis = fs0.indexOf("#include <emissivemap_fragment>");
const iAdd = fs0.indexOf("totalEmissiveRadiance += diffuseColor.rgb * uGlow;");
check("★ accumulate lands AFTER <emissivemap_fragment> (reads resolved diffuseColor)", iEmis >= 0 && iAdd > iEmis);
const iMap = fs0.indexOf("#include <map_fragment>");
check("★ accumulate is POST <map_fragment> (palette-decoded albedo)", iMap >= 0 && iAdd > iMap);
check("uGlow declared (after <common>) BEFORE its use", fs0.indexOf("uniform float uGlow;") < iAdd);
check("vertex shader untouched (frag-only emissive effect)", s.vertexShader === fakeShader().vertexShader);

// inject is a safe no-op when the seam is absent (e.g. a MeshBasic wire material)
const noSeam = { uniforms: {}, fragmentShader: "#include <common>\nvoid main(){}" };
magicGlow.inject(noSeam);
check("inject no-op without the emissivemap seam (no orphan uniform)",
  !noSeam.fragmentShader.includes("uniform float uGlow;") && !noSeam.fragmentShader.includes("totalEmissiveRadiance"));

// ---- Layer B: source denylist over the actual file ----
const src = fs.readFileSync(path.resolve("scene3d/vfx/components/magicGlow.js"), "utf8");
check("Layer B: magicGlow.js has no forbidden source patterns", lintSource(src).length === 0,
  lintSource(src).map((h) => `${h.lineno}:${h.label}`).join("; "));
// CODE (comment-stripped) must not touch the program-cache key or non-determinism —
// the firewall mentions live in descriptive comments, which Layer B already ignores.
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
check("CODE never touches customProgramCacheKey (firewall)", !/customProgramCacheKey/.test(code));
check("CODE never uses Math.random / argless Date.now", !/Math\.random|Date\.now\s*\(\s*\)/.test(code));

console.log(`\nVFX emissive.magicGlow component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
