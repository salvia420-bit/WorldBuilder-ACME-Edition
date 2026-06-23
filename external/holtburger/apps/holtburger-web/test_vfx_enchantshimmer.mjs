// VFX Phase 1 — emissive.enchantShimmer unit test.
//
// Locks: the component registers + conforms to the legacy-safety manifest, its
// source passes the Layer-B denylist, the firewall holds (cacheKeyScope "set",
// linkVariant ""), and the GLSL injects the emissive-pulse multiply at the
// CANONICAL emissive seam (after #include <emissivemap_fragment>) reading the
// shared uTime + the per-instance vVfxHash varying — with the uniform-decl guard
// (no duplicate `uniform float uTime;` when chained with a sibling emissive
// component) and the standalone fallback (no vVfxHash → const 0.0).

import { enchantShimmer } from "./scene3d/vfx/components/enchantShimmer.js";
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";
import fs from "node:fs";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal stand-in for a three.js MeshStandard fragment shader (only the two
// include seams enchantShimmer touches), plus a uniforms bag.
function fakeColorShader() {
  return {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main(){ gl_Position = vec4(0.0); }",
    fragmentShader:
      "#include <common>\n" +
      "void main(){\n" +
      "  vec3 totalEmissiveRadiance = emissive;\n" +
      "  #include <emissivemap_fragment>\n" +
      "  gl_FragColor = vec4(totalEmissiveRadiance, 1.0);\n" +
      "}",
  };
}
// A depth/shadow-style shader: NO emissive seam (the multiply must not appear).
function fakeDepthShader() {
  return { uniforms: {}, vertexShader: "#include <common>", fragmentShader: "#include <common>\nvoid main(){ gl_FragColor = vec4(1.0); }" };
}

// ---- registration + manifest (Layer A) ----
check("registered as emissive.enchantShimmer", getComponent("emissive.enchantShimmer") === enchantShimmer);
check("validateComponent clean", validateComponent(enchantShimmer).length === 0, validateComponent(enchantShimmer).join("; "));
check("lintManifest clean", lintManifest(enchantShimmer).length === 0, lintManifest(enchantShimmer).join("; "));
check("family/mech/channel = emissive/frag/emissive",
  enchantShimmer.family === "emissive" && enchantShimmer.mech === "frag" && enchantShimmer.channel === "emissive");
check("reads = clock + instanceHash (⊆ ALLOWED_READS)",
  enchantShimmer.reads.length === 2 &&
  enchantShimmer.reads.includes("clock") && enchantShimmer.reads.includes("instanceHash") &&
  enchantShimmer.reads.every((r) => ALLOWED_READS.has(r)));
check("writes = materialUniform (⊆ ALLOWED_WRITES)",
  enchantShimmer.writes.length === 1 && enchantShimmer.writes[0] === "materialUniform" &&
  enchantShimmer.writes.every((w) => ALLOWED_WRITES.has(w)));
check("★ firewall: cacheKeyScope 'set' + linkVariant() '' (config flows via uniforms, not the program key)",
  enchantShimmer.cacheKeyScope === "set" && enchantShimmer.linkVariant() === "" &&
  enchantShimmer.linkVariant({ amp: 0.9, freq: 9 }) === "");
check("legacy-safe scalars: deterministic + lightCountDelta 0", enchantShimmer.deterministic === true && enchantShimmer.lightCountDelta === 0);

// ---- Layer B: this component's source passes the denylist ----
const src = fs.readFileSync("./scene3d/vfx/components/enchantShimmer.js", "utf8");
const hits = lintSource(src);
check("Layer B: source has no forbidden patterns", hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join());

// ---- declareUniforms: shared uTime by reference + clamped config ----
const VFX_GLOBALS = { uTime: { value: 0 } };
const sh = fakeColorShader();
enchantShimmer.declareUniforms(sh, { amp: 0.4, freq: 1.8 }, VFX_GLOBALS);
check("★ uTime bound BY REFERENCE to VFX_GLOBALS (one tick drives all)", sh.uniforms.uTime === VFX_GLOBALS.uTime);
VFX_GLOBALS.uTime.value = 12.5; // simulate the oscillator tick
check("★ oscillator tick reaches the material with zero per-frame work here", sh.uniforms.uTime.value === 12.5);
check("config amp/freq set on uniforms", sh.uniforms.uEnchantAmp.value === 0.4 && sh.uniforms.uEnchantFreq.value === 1.8);
const clamp = fakeColorShader();
enchantShimmer.declareUniforms(clamp, { amp: 5.0 }, VFX_GLOBALS); // out-of-range
check("amp clamped to <0.95 → factor (1+amp*sin) stays positive", clamp.uniforms.uEnchantAmp.value <= 0.95 && clamp.uniforms.uEnchantAmp.value >= 0);
check("classifier alias: strength→amp, speed→freq",
  (() => { const s = fakeColorShader(); enchantShimmer.declareUniforms(s, { strength: 0.2, speed: 3.3 }, VFX_GLOBALS); return s.uniforms.uEnchantAmp.value === 0.2 && s.uniforms.uEnchantFreq.value === 3.3; })());

// ---- inject: GLSL at the canonical emissive seam ----
enchantShimmer.inject(sh);
const fs2 = sh.fragmentShader;
check("★ multiply injected AFTER #include <emissivemap_fragment> (canonical emissive seam)",
  /#include <emissivemap_fragment>\s*[\s\S]*totalEmissiveRadiance \*= \(1\.0 \+ uEnchantAmp \* sin\(uTime \* uEnchantFreq \+ vVfxHash \* 6\.2831853\)\);/.test(fs2));
check("uniforms declared in fragment shader", fs2.includes("uniform float uTime;") && fs2.includes("uniform float uEnchantAmp;") && fs2.includes("uniform float uEnchantFreq;"));

// ---- inject guard: idempotent + no duplicate uTime when chained ----
const sh2 = fakeColorShader();
// Pretend a sibling emissive component already declared uTime + the varying.
sh2.fragmentShader = sh2.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uTime;\nvarying float vVfxHash;");
enchantShimmer.declareUniforms(sh2, {}, VFX_GLOBALS);
enchantShimmer.inject(sh2);
check("★ guard: no DUPLICATE `uniform float uTime;` when a sibling already declared it",
  (sh2.fragmentShader.match(/uniform float uTime;/g) || []).length === 1);
check("uses the shared vVfxHash varying when present (no fallback const)",
  !sh2.fragmentShader.includes("float vVfxHash = 0.0;") && /sin\(uTime \* uEnchantFreq \+ vVfxHash/.test(sh2.fragmentShader));

// ---- standalone fallback: no vVfxHash → const 0.0 so it still compiles ----
const sh3 = fakeColorShader();
enchantShimmer.declareUniforms(sh3, {}, VFX_GLOBALS);
enchantShimmer.inject(sh3);
check("standalone fallback: declares `float vVfxHash = 0.0;` when the varying is absent", sh3.fragmentShader.includes("float vVfxHash = 0.0;"));

// ---- depth/shadow shader: no emissive seam → no multiply (color-pass only) ----
const dep = fakeDepthShader();
enchantShimmer.declareUniforms(dep, {}, VFX_GLOBALS);
enchantShimmer.inject(dep);
check("★ depth/shadow shader (no emissive seam) gets NO multiply", !dep.fragmentShader.includes("totalEmissiveRadiance *="));

// ---- numeric sanity: the factor never goes negative across a full cycle ----
let minF = Infinity, maxF = -Infinity;
const amp = sh.uniforms.uEnchantAmp.value, freq = sh.uniforms.uEnchantFreq.value;
for (let i = 0; i < 256; i++) {
  const t = (i / 256) * 100, phase = (i % 7) / 7 * 6.2831853;
  const f = 1.0 + amp * Math.sin(t * freq + phase);
  minF = Math.min(minF, f); maxF = Math.max(maxF, f);
}
check("factor (1+amp*sin) stays strictly positive over a full sweep", minF > 0, `min=${minF.toFixed(3)} max=${maxF.toFixed(3)}`);

console.log(`\nVFX emissive.enchantShimmer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
