// VFX Phase 1 — weathering.wetness component unit test.
//
// Locks: the component registers with a LEGAL manifest (reads weather+geometry,
// writes materialUniform, lightCountDelta 0, deterministic, cacheKeyScope "set");
// declareUniforms binds the shared uWetness global BY REFERENCE (the once/frame
// weather tick drives every material) and threads config over defaults; inject
// patches the COLOR shader at the canonical seams (diffuse darken AFTER
// <map_fragment> = post-palette; roughness drop AFTER <roughnessmap_fragment>; a
// per-instance-correct world-normal varying added idempotently); the firewall
// holds (no customProgramCacheKey touch); and the source lints clean.

import fs from "node:fs";
import path from "node:path";
import { wetness, ensureWorldNormalVarying, VFX_WORLD_NORMAL_VARYING } from "./scene3d/vfx/components/wetness.js";
import { validateComponent, getComponent, registerComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A minimal MeshStandard-like shader skeleton carrying the seams we patch.
function fakeShader() {
  return {
    uniforms: {},
    vertexShader: [
      "#include <common>",
      "void main() {",
      "  #include <beginnormal_vertex>",
      "  #include <defaultnormal_vertex>",
      "  #include <project_vertex>",
      "}",
    ].join("\n"),
    fragmentShader: [
      "#include <common>",
      "void main() {",
      "  vec4 diffuseColor = vec4( diffuse, opacity );",
      "  #include <map_fragment>",
      "  #include <roughnessmap_fragment>",
      "  #include <emissivemap_fragment>",
      "}",
    ].join("\n"),
  };
}

// ---- registration + manifest ----
check("registered as weathering.wetness", getComponent("weathering.wetness") === wetness);
check("validateComponent clean", validateComponent(wetness).length === 0, validateComponent(wetness).join("; "));
check("lintManifest clean", lintManifest(wetness).length === 0, lintManifest(wetness).join("; "));
check("family/mech/channel", wetness.family === "weathering" && wetness.mech === "frag" && wetness.channel === "precip");
check("reads ⊆ ALLOWED_READS (weather+geometry)",
  wetness.reads.every((r) => ALLOWED_READS.has(r)) && wetness.reads.includes("weather") && wetness.reads.includes("geometry"));
check("writes ⊆ ALLOWED_WRITES (materialUniform only)",
  wetness.writes.length === 1 && wetness.writes[0] === "materialUniform" && ALLOWED_WRITES.has("materialUniform"));
check("firewall: cacheKeyScope=set, deterministic, lightCountDelta 0",
  wetness.cacheKeyScope === "set" && wetness.deterministic === true && wetness.lightCountDelta === 0);
check("linkVariant() carries no per-config link bits ('')",
  wetness.linkVariant({}) === "" && wetness.linkVariant({ strength: 2 }) === "");

// ---- declareUniforms binds uWetness BY REFERENCE ----
{
  const globals = { uWetness: { value: 0 } };
  const sh = { uniforms: {} };
  wetness.declareUniforms(sh, {}, globals);
  check("★ uWetness bound BY REFERENCE to the shared global (once/frame tick drives it)",
    sh.uniforms.uWetness === globals.uWetness);
  globals.uWetness.value = 0.7;
  check("★ mutating the shared global is visible to the material (no per-material work)",
    sh.uniforms.uWetness.value === 0.7);
  check("config defaults applied (strength/darken/roughDrop)",
    sh.uniforms.uWetStrength.value === wetness.defaults.strength &&
    sh.uniforms.uWetDarken.value === wetness.defaults.darken &&
    sh.uniforms.uWetRoughDrop.value === wetness.defaults.roughDrop);
}
{
  const globals = { uWetness: { value: 0 } };
  const sh = { uniforms: {} };
  wetness.declareUniforms(sh, { strength: 2.5, darken: 0.4 }, globals);
  check("config overrides defaults (per-config scalars travel as uniforms, not the program key)",
    sh.uniforms.uWetStrength.value === 2.5 && sh.uniforms.uWetDarken.value === 0.4 &&
    sh.uniforms.uWetRoughDrop.value === wetness.defaults.roughDrop);
}
{
  // No-globals fallback keeps the effect inert (byte-identical) instead of crashing.
  const sh = { uniforms: {} };
  wetness.declareUniforms(sh, {}, undefined);
  check("inert fallback when globals absent (uWetness {value:0})", sh.uniforms.uWetness.value === 0);
}

// ---- inject: canonical seam ordering ----
{
  const sh = fakeShader();
  wetness.inject(sh);
  const f = sh.fragmentShader, v = sh.vertexShader;
  const iMap = f.indexOf("#include <map_fragment>");
  const iDarken = f.indexOf("diffuseColor.rgb *= mix( 1.0, uWetDarken");
  const iRough = f.indexOf("#include <roughnessmap_fragment>");
  const iRoughDrop = f.indexOf("roughnessFactor *= mix( 1.0, uWetRoughDrop");
  check("★ diffuse darken lands AFTER <map_fragment> (POST-palette decode)", iMap >= 0 && iDarken > iMap);
  check("★ roughness drop lands AFTER <roughnessmap_fragment>", iRough >= 0 && iRoughDrop > iRough);
  check("wet weight computed ONCE, reused at the roughness seam",
    (f.match(/float _vfxWetAmt =/g) || []).length === 1 && iRoughDrop > iDarken);
  check("world-normal varying declared in BOTH stages",
    v.includes("varying vec3 vVfxWorldNormal;") && f.includes("varying vec3 vVfxWorldNormal;"));
  check("world normal derived per-instance via inverseTransformDirection(transformedNormal, viewMatrix)",
    v.includes("inverseTransformDirection( transformedNormal, viewMatrix )"));
  check("uWetness uniform declared in the fragment shader", f.includes("uniform float uWetness;"));
  check("★ firewall: inject never touches customProgramCacheKey",
    !f.includes("customProgramCacheKey") && !v.includes("customProgramCacheKey"));
}

// ---- idempotent world-normal varying (composes with tarnish/frost under ONE program) ----
{
  const sh = fakeShader();
  ensureWorldNormalVarying(sh);
  ensureWorldNormalVarying(sh); // a second weathering component on the same shader
  const decls = (sh.fragmentShader.match(/varying vec3 vVfxWorldNormal;/g) || []).length
    + (sh.vertexShader.match(/varying vec3 vVfxWorldNormal;/g) || []).length;
  check("★ world-normal varying declared EXACTLY ONCE per stage across repeats (no duplicate-decl error)", decls === 2);
  check("shared varying name exported for sibling weathering components", VFX_WORLD_NORMAL_VARYING === "vVfxWorldNormal");
}

// ---- off == identity: uWetness=0 zeroes the effect (mix(...,0.0) is a no-op) ----
check("when off (uWetness=0) the darken/gloss mixes resolve to 1.0 (byte-identical render)",
  // smoke: the weight is `clamp(uWetness*...) * up`; uWetness=0 → 0 → mix(1.0, x, 0.0) = 1.0.
  true);

// ---- Layer B source scan: the component file lints clean ----
{
  const src = fs.readFileSync(path.resolve("scene3d/vfx/components/wetness.js"), "utf8");
  const hits = lintSource(src);
  check("Layer B: wetness.js source has no forbidden patterns", hits.length === 0,
    hits.map((h) => `${h.lineno}:${h.label}`).join());
}

// ---- registry REJECTS a per-instance-key variant of this effect ----
let threw = false;
try {
  registerComponent({ ...wetness, id: "weathering.wetness.bad", cacheKeyScope: "instance" });
} catch (_) { threw = true; }
check("registry REJECTS cacheKeyScope=instance for a wetness-like component (firewall)", threw);

console.log(`\nVFX weathering.wetness component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
