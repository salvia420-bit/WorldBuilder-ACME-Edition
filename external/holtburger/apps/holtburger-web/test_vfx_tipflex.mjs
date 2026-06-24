// VFX Phase 2 — deformation.tipFlex component unit test (MECH-B vertex).
//
// The FIRST GPU vertex-displacement component: the atlan-spear shaft sways/whips,
// axially weighted 0 at the grip -> 1 at the distal tip, injected at three.js
// `#include <begin_vertex>` modifying the `transformed` vec3. Ships default-OFF
// behind ?tipFlex (composed under the ?visual master gate); byte-identical when
// off. Mirrors test_vfx_glint.mjs (the frag-seam sibling) but for the VERTEX seam.
//
// Locks (against the SHIPPED scene3d/vfx/components/tipFlex.js): tipFlex registers
// + validates against the contract; its manifest is legacy-safe (lintManifest
// clean, reads/writes ⊆ the capability vocab); its SOURCE is clean (lintSource —
// no Math.random/Date.now/wire/collision); mech "B"; deterministic;
// lightCountDelta 0; one program per SET (linkVariant ""=> config-invariant GLSL);
// declareUniforms binds uTime BY REFERENCE (shared clock) + declares the tip
// uniforms (amplitude in RADIANS + the geometry shaft frame); inject() splices
// GLSL after the begin_vertex seam (in fact after the per-instance-hash assign so
// vVfxHash is readable) and modifies ONLY the vertex shader's `transformed`
// (never the fragment displacement / no light-count change); GUARANTEES the
// per-instance hash varying via per_instance.ensureVfxHashVarying; off=no-op
// (inert on a non-standard material => byte-identical); recompile-safe.
//
// CONTRACT the tipFlex.js builder satisfies (verified against the artifact):
//   id "deformation.tipFlex"; family "deformation"; mech "B"; channel "transform";
//   linkVariant()===""; cacheKeyScope "set"; deterministic true; lightCountDelta 0;
//   reads ⊆ ALLOWED_READS (geometry/clock/instanceHash); writes ⊆ ALLOWED_WRITES
//   (materialUniform, partTransform); defaults.ampDeg:number(=1.5);
//   GLSL marker "VFX_TIPFLEX_BEGIN"; seam "#include <begin_vertex>";
//   declareUniforms binds shader.uniforms.uTime by reference + declares uTipAmpRad
//   (ampDeg->radians) + the shaft frame uShaftAxis/uGripBase/uShaftLen;
//   inject declares those uniforms in the vertex stage + reads vVfxHash for phase.

import fs from "node:fs";
import path from "node:path";
import { tipFlex } from "./scene3d/vfx/components/tipFlex.js"; // registers it
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal stand-in for the three MeshStandard VERTEX shader: the global-scope
// `#include <common>` (where per_instance injects the hash pars) + void main()
// with `#include <begin_vertex>` (which declares `vec3 transformed = vec3(position)`
// that tipFlex displaces) + the project_vertex consumer downstream.
function fakeVert() {
  return [
    "uniform mat4 modelViewMatrix;",
    "#include <common>",
    "void main() {",
    "  #include <begin_vertex>",
    "  #include <project_vertex>",
    "  gl_Position = projectionMatrix * mvPosition;",
    "}",
  ].join("\n");
}

// ---- registration + contract ----
check("tipFlex registered as deformation.tipFlex", getComponent("deformation.tipFlex") === tipFlex);
check("validateComponent(tipFlex) clean", validateComponent(tipFlex).length === 0,
  validateComponent(tipFlex).join("; "));
check("manifest: deformation / MECH-B / channel transform",
  tipFlex.family === "deformation" && tipFlex.mech === "B" && tipFlex.channel === "transform",
  `${tipFlex.family}/${tipFlex.mech}/${tipFlex.channel}`);
check("manifest: cacheKeyScope=set + deterministic + lightCountDelta 0 (no relink)",
  tipFlex.cacheKeyScope === "set" && tipFlex.deterministic === true && tipFlex.lightCountDelta === 0);
check("manifest: linkVariant() config-independent ('' => one program per SET)",
  tipFlex.linkVariant({ ampDeg: 9 }) === "" && tipFlex.linkVariant() === "");
check("defaults expose ampDeg (number)", typeof tipFlex.defaults.ampDeg === "number");

// ---- legacy-safety: manifest (Layer A) + source (Layer B) ----
check("lintManifest(tipFlex) clean", lintManifest(tipFlex).length === 0, lintManifest(tipFlex).join("; "));
check("reads ⊆ ALLOWED_READS (static/derived + clock only)",
  tipFlex.reads.length > 0 && tipFlex.reads.every((r) => ALLOWED_READS.has(r)), tipFlex.reads.join());
check("writes ⊆ ALLOWED_WRITES + includes materialUniform (cloned-material shader, nothing replicated)",
  tipFlex.writes.length > 0 && tipFlex.writes.every((w) => ALLOWED_WRITES.has(w)) && tipFlex.writes.includes("materialUniform"),
  tipFlex.writes.join());
const tipSrc = fs.readFileSync(path.resolve("scene3d/vfx/components/tipFlex.js"), "utf8");
const srcHits = lintSource(tipSrc);
check("lintSource(tipFlex.js) clean (no forbidden patterns: wire/collision/move/random/Date.now)",
  srcHits.length === 0, srcHits.map((h) => `${h.lineno}:${h.label}`).join(", "));

// ---- declareUniforms: shared clock by REFERENCE + the tip/frame uniforms ----
{
  const sharedTime = { value: 7 };
  const globals = { uTime: sharedTime };
  const shader = { uniforms: {} };
  tipFlex.declareUniforms(shader, { ampDeg: 3.0 }, globals);
  check("declareUniforms binds uTime BY REFERENCE (the shared clock)",
    shader.uniforms.uTime === sharedTime);
  check("declareUniforms declares the amplitude uniform uTipAmpRad (number)",
    shader.uniforms.uTipAmpRad && typeof shader.uniforms.uTipAmpRad.value === "number");
  check("declareUniforms declares the geometry shaft frame (uShaftAxis vec3 + uGripBase + uShaftLen)",
    shader.uniforms.uShaftAxis && typeof shader.uniforms.uShaftAxis.value === "object" &&
    typeof shader.uniforms.uShaftAxis.value.x === "number" &&
    typeof shader.uniforms.uGripBase?.value === "number" &&
    typeof shader.uniforms.uShaftLen?.value === "number");
  // a later oscillator tick of uTime is visible through the bound reference
  sharedTime.value = 42;
  check("a later oscillator tick of uTime is seen through the bound reference",
    shader.uniforms.uTime.value === 42);
  // ampDeg is DEGREES; the uniform is RADIANS. Lock the deg->rad conversion.
  const s180 = { uniforms: {} }; tipFlex.declareUniforms(s180, { ampDeg: 180 }, globals);
  check("uTipAmpRad converts ampDeg degrees -> radians (180deg => PI)",
    Math.abs(s180.uniforms.uTipAmpRad.value - Math.PI) < 1e-9, String(s180.uniforms.uTipAmpRad.value));
  // config rides the uniform (firewall: NOT the program key) — distinct ampDeg => distinct value
  const sLo = { uniforms: {} }; tipFlex.declareUniforms(sLo, { ampDeg: 1.5 }, globals);
  const sHi = { uniforms: {} }; tipFlex.declareUniforms(sHi, { ampDeg: 6.0 }, globals);
  check("config ampDeg rides the uTipAmpRad uniform (firewall: not the program key)",
    sLo.uniforms.uTipAmpRad.value !== sHi.uniforms.uTipAmpRad.value);
  // omitting config falls back to defaults
  const sDef = { uniforms: {} }; tipFlex.declareUniforms(sDef, undefined, globals);
  const sDefAmp = { uniforms: {} }; tipFlex.declareUniforms(sDefAmp, { ampDeg: tipFlex.defaults.ampDeg }, globals);
  check("declareUniforms with no config uses defaults",
    sDef.uniforms.uTipAmpRad.value === sDefAmp.uniforms.uTipAmpRad.value);
}

// ---- inject: GLSL shape, seam placement, vertex-only, idempotency ----
{
  const shader = { vertexShader: fakeVert(), fragmentShader: "void main(){ gl_FragColor = vec4(1.0); }" };
  const beforeFrag = shader.fragmentShader;
  tipFlex.inject(shader);
  const out = shader.vertexShader;
  check("inject splices the patch AFTER the #include <begin_vertex> seam",
    out.indexOf("VFX_TIPFLEX_BEGIN") > out.indexOf("#include <begin_vertex>"));
  check("inject modifies the `transformed` vertex position (the displacement)",
    /transformed\s*\+=/.test(out.slice(out.indexOf("VFX_TIPFLEX_BEGIN"))));
  check("uniforms declared in the vertex GLSL (uTime + uTipAmpRad + the shaft frame)",
    out.includes("uniform float uTime;") && out.includes("uniform float uTipAmpRad;") &&
    out.includes("uniform vec3 uShaftAxis;") && out.includes("uniform float uGripBase;") &&
    out.includes("uniform float uShaftLen;"));
  check("inject edits ONLY the vertex shader (fragment displacement untouched)",
    shader.fragmentShader === beforeFrag);
  check("no backtick leaked into the GLSL (template-literal safety)", !out.includes("`"));
  // recompile-safe: a second inject must NOT double-patch
  const onceLen = out.length;
  tipFlex.inject(shader);
  check("inject is recompile-safe (no double-patch)", shader.vertexShader.length === onceLen);
  check("exactly one VFX_TIPFLEX_BEGIN marker", shader.vertexShader.split("VFX_TIPFLEX_BEGIN").length === 2);
}

// ---- inject: GUARANTEES the per-instance hash varying (ensureVfxHashVarying) ----
// tipFlex reads vVfxHash for per-object sway phase, so it injects the slice-03
// per-instance-hash varying + its derivation itself (no caller dependency). After
// inject the vertex stage references vVfxHash AND its procedural derivation.
{
  const shader = { vertexShader: fakeVert(), fragmentShader: "#include <common>\nvoid main(){ gl_FragColor = vec4(1.0); }" };
  tipFlex.inject(shader);
  check("inject guarantees the per-instance hash varying vVfxHash in the vertex stage",
    shader.vertexShader.includes("vVfxHash"));
  check("inject brings the procedural hash derivation (vfxHash01) with it",
    shader.vertexShader.includes("vfxHash01"));
}

// ---- inject: off=no-op — inert on a non-standard material (no seam) ----
{
  const basic = "void main() {\n  gl_Position = vec4(1.0);\n}"; // no begin_vertex seam
  const shader = { vertexShader: basic, fragmentShader: "" };
  tipFlex.inject(shader);
  check("no begin_vertex seam => inject is a no-op (byte-identical, off=no-op)",
    shader.vertexShader === basic);
}

// ---- uniform-decl collision safety (uTime shared across a SET) ----
{
  // simulate a prior component in the same SET already declaring uTime
  const pre = "uniform float uTime;\n" + fakeVert();
  const shader = { vertexShader: pre, fragmentShader: "void main(){}" };
  tipFlex.inject(shader);
  check("uTime declared exactly once even if a prior component declared it",
    (shader.vertexShader.match(/uniform float uTime;/g) || []).length === 1);
}

console.log(`\nVFX deformation.tipFlex component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
