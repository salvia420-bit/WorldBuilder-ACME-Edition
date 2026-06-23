// VFX Phase 1 — emissive.glint component unit test.
//
// Locks: glint registers + validates against the contract, its manifest is
// legacy-safe (lintManifest clean, reads/writes ⊆ the capability vocab), its
// SOURCE is clean (lintSource — no forbidden patterns), declareUniforms binds
// uTime BY REFERENCE (the shared clock, NOT a per-component clone), the GLSL
// folds into totalEmissiveRadiance at the emissivemap_fragment seam, the per-
// instance phase rides vVfxHash (with a 0.0 fallback), uniforms are declared
// once (collision-safe), and the patch is recompile-safe + edits ONLY the
// fragment shader (never the vertex / depth pass) and never the program key.

import fs from "node:fs";
import path from "node:path";
import { glint } from "./scene3d/vfx/components/glint.js"; // registers it
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal stand-in for the three MeshStandard fragment shader: the void main
// boundary + the seams glint relies on, with totalEmissiveRadiance + the live
// locals (metalnessFactor / normal / vViewPosition) the snippet reads.
function fakeFrag({ withHash = false } = {}) {
  return [
    "uniform vec3 diffuse;",
    withHash ? "varying float vVfxHash;" : "",
    "void main() {",
    "  vec3 totalEmissiveRadiance = emissive;",
    "  #include <metalnessmap_fragment>",
    "  #include <normal_fragment_begin>",
    "  #include <emissivemap_fragment>",
    "  #include <lights_fragment_begin>",
    "  gl_FragColor = vec4(1.0);",
    "}",
  ].filter(Boolean).join("\n");
}

// ---- registration + contract ----
check("glint registered as emissive.glint", getComponent("emissive.glint") === glint);
check("validateComponent(glint) clean", validateComponent(glint).length === 0,
  validateComponent(glint).join("; "));
check("manifest: emissive / frag / channel glint",
  glint.family === "emissive" && glint.mech === "frag" && glint.channel === "glint");
check("manifest: cacheKeyScope=set + deterministic + lightCountDelta 0",
  glint.cacheKeyScope === "set" && glint.deterministic === true && glint.lightCountDelta === 0);
check("manifest: linkVariant() is config-independent ('' => one program per SET)",
  glint.linkVariant({ strength: 0.9 }) === "" && glint.linkVariant() === "");
check("defaults expose {strength, metalBias}",
  typeof glint.defaults.strength === "number" && typeof glint.defaults.metalBias === "number");

// ---- legacy-safety: manifest (Layer A) + source (Layer B) ----
check("lintManifest(glint) clean", lintManifest(glint).length === 0, lintManifest(glint).join("; "));
check("reads ⊆ ALLOWED_READS", glint.reads.length > 0 && glint.reads.every((r) => ALLOWED_READS.has(r)));
check("writes ⊆ ALLOWED_WRITES (materialUniform)",
  glint.writes.length > 0 && glint.writes.every((w) => ALLOWED_WRITES.has(w)) && glint.writes.includes("materialUniform"));
const glintSrc = fs.readFileSync(path.resolve("scene3d/vfx/components/glint.js"), "utf8");
const srcHits = lintSource(glintSrc);
check("lintSource(glint.js) clean (no forbidden patterns)", srcHits.length === 0,
  srcHits.map((h) => `${h.lineno}:${h.label}`).join(", "));

// ---- declareUniforms: shared clock bound BY REFERENCE ----
{
  const sharedTime = { value: 7 };
  const globals = { uTime: sharedTime, uWindDir: { value: { x: 1, y: 0 } } };
  const shader = { uniforms: {} };
  glint.declareUniforms(shader, { strength: 0.6, metalBias: 0.5 }, globals);
  check("declareUniforms binds uTime BY REFERENCE (the shared clock)",
    shader.uniforms.uTime === sharedTime);
  check("config strength/metalBias ride uniforms (firewall: not the program key)",
    shader.uniforms.uGlintStrength.value === 0.6 && shader.uniforms.uGlintMetalBias.value === 0.5);
  // ticking the shared clock is visible without a per-component clone
  sharedTime.value = 42;
  check("a later oscillator tick of uTime is seen through the bound reference",
    shader.uniforms.uTime.value === 42);
  // omitting config falls back to defaults
  const s2 = { uniforms: {} };
  glint.declareUniforms(s2, undefined, globals);
  check("declareUniforms with no config uses defaults",
    s2.uniforms.uGlintStrength.value === glint.defaults.strength &&
    s2.uniforms.uGlintMetalBias.value === glint.defaults.metalBias);
}

// ---- inject: GLSL shape, seam placement, hash source, idempotency ----
{
  const shader = { fragmentShader: fakeFrag({ withHash: true }), vertexShader: "void main(){}" };
  const beforeVert = shader.vertexShader;
  glint.inject(shader);
  const out = shader.fragmentShader;
  check("inject folds into totalEmissiveRadiance", out.includes("totalEmissiveRadiance += vec3("));
  check("snippet lands AFTER the emissivemap_fragment seam",
    out.indexOf("VFX_GLINT_BEGIN") > out.indexOf("#include <emissivemap_fragment>"));
  check("snippet lands BEFORE the lights accumulation",
    out.indexOf("VFX_GLINT_BEGIN") < out.indexOf("#include <lights_fragment_begin>"));
  check("metal gate present (gated by metalnessFactor + uGlintMetalBias)",
    out.includes("mix(metalnessFactor, 1.0, uGlintMetalBias)"));
  check("per-instance phase rides vVfxHash when the varying is present",
    /_ph\s*=\s*uTime \* 0\.6 \+ \(vVfxHash\)/.test(out));
  check("uniforms declared in GLSL (uTime / uGlintStrength / uGlintMetalBias)",
    out.includes("uniform float uTime;") && out.includes("uniform float uGlintStrength;") &&
    out.includes("uniform float uGlintMetalBias;"));
  check("inject edits ONLY the fragment shader (vertex untouched)",
    shader.vertexShader === beforeVert);
  check("no backtick leaked into the GLSL (template-literal safety)", !out.includes("`"));
  // recompile-safe: a second inject must NOT double-patch
  const onceLen = out.length;
  glint.inject(shader);
  check("inject is recompile-safe (no double-patch)", shader.fragmentShader.length === onceLen);
  check("exactly one VFX_GLINT_BEGIN marker", out.split("VFX_GLINT_BEGIN").length === 2);
}

// ---- inject: graceful fallback when per-instance-age infra is absent ----
{
  const shader = { fragmentShader: fakeFrag({ withHash: false }) };
  glint.inject(shader);
  check("without vVfxHash, phase falls back to a constant 0.0 (still compiles)",
    /_ph\s*=\s*uTime \* 0\.6 \+ \(0\.0\)/.test(shader.fragmentShader) &&
    !shader.fragmentShader.includes("vVfxHash"));
}

// ---- inject: inert on a non-standard material (no seam => byte-identical) ----
{
  const basic = "void main() {\n  gl_FragColor = vec4(1.0);\n}";
  const shader = { fragmentShader: basic };
  glint.inject(shader);
  check("no emissivemap seam => inject is a no-op (byte-identical)", shader.fragmentShader === basic);
}

// ---- uniform-decl collision safety (uTime shared across a SET) ----
{
  // simulate a prior component in the same SET already declaring uTime
  const pre = "uniform float uTime;\n" + fakeFrag({ withHash: true });
  const shader = { fragmentShader: pre };
  glint.inject(shader);
  check("uTime declared exactly once even if a prior component declared it",
    (shader.fragmentShader.match(/uniform float uTime;/g) || []).length === 1);
}

console.log(`\nVFX emissive.glint component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
