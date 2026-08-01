// test_terrain_grass_shader.mjs — §3.1 GRASS shader injection (Wave 1A;
// `scene3d/terrain_grass.js::injectTerrainGrassShader`).
//
// PURE-ESM, NO THREE (plan §6 tier 1): the injector is string surgery, so this
// test needs no GL context, no `node_modules` and no stub loader.
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.1, §5.1, §5.2, §5.4, §5.6, §6):
//   S1  Every uniform/attribute/varying is declared EXACTLY ONCE — including
//       over a shader that ALREADY declares `uniform float uTime;` (uTime is
//       the shared VFX clock; a second declaration is a GLSL error, and that is
//       precisely the case a chained patch produces).
//   S2  NO-OP when the seam is absent: a non-standard material comes back
//       byte-identical (`vertexShader === before`), like `resolveFragMaterial`
//       returning null.
//   S3  RECOMPILE-SAFE: injecting twice is idempotent (three recompiles a
//       material on many state changes and re-runs onBeforeCompile).
//   S4  The program cache key is NEVER touched (§5.4 — per-instance keys are a
//       shader-link explosion). Per-blade variety rides `vVfxHash`, which is
//       derived procedurally from the instance matrix and adds no program.
//   S5  The wind is windSwayGpu's gust function: the same primary sine + 3.7x
//       flutter band off the same `uTime`, so trees and grass gust together;
//       amplitude is CUBIC in height so the blade base stays planted.
//   S6  The stomp reads `uTrailMap` at the blade's own world position, is
//       gated on `uTrailEnabled`, and bends DOWN plus splays away from the
//       stamp (the negative trail gradient).
//   S7  The distance blend uses `terrain_scatter.js`'s own `hbScatterFade` +
//       the pool's four uniforms — one fade function for every family.
//   S8  FIREWALL (§5.1/§5.2): the module source is `lintSource`-clean (no
//       Math.random, no argless Date.now, no wire/collision/physics-move, no
//       `.visible =`, no per-instance cache key) and it adds no light.
//   S9  NO BACKTICKS in the emitted GLSL (a backtick would close the JS string
//       it lands in — a house rule paid for once already).
//
// Run from apps/holtburger-web/:  node test_terrain_grass_shader.mjs

import fs from "node:fs";
import path from "node:path";
import { lintSource } from "./scene3d/vfx/lint_caps.js";
import { VFX_HASH_ASSIGN_VERTEX } from "./scene3d/vfx/per_instance.js";
import {
  GRASS_MARKER,
  GRASS_END,
  GRASS_VERTEX_SEAM,
  GRASS_FRAGMENT_SEAM,
  GRASS_ATTRIBUTES,
  injectTerrainGrassShader,
  hasTerrainGrassShader,
} from "./scene3d/terrain_grass.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const countOf = (src, re) => (src.match(re) || []).length;

// A minimal stand-in for three's MeshLambert VERTEX shader: the global-scope
// `#include <common>` (where per_instance injects the hash pars), `void main()`
// and the `#include <begin_vertex>` seam that declares `transformed`.
// ⚠ It ALREADY declares `uniform float uTime;` — the shared VFX clock — which
// is the case that catches a naive "always prepend the declaration" injector.
function fakeShader() {
  return {
    vertexShader: [
      "uniform mat4 modelViewMatrix;",
      "uniform float uTime;",
      "#include <common>",
      "void main() {",
      "  #include <begin_vertex>",
      "  #include <project_vertex>",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform float uTime;",
      "#include <common>",
      "void main() {",
      "  vec4 diffuseColor = vec4( diffuse, opacity );",
      "  #include <color_fragment>",
      "  gl_FragColor = diffuseColor;",
      "}",
    ].join("\n"),
    uniforms: {},
  };
}

// ---------------------------------------------------------------------------
console.log("\n-- S1: every declaration lands exactly once --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  check("patched (marker present in BOTH stages)", hasTerrainGrassShader(s));
  check("uniform float uTime; declared exactly once (it was pre-declared)",
    countOf(s.vertexShader, /uniform float uTime;/g) === 1,
    String(countOf(s.vertexShader, /uniform float uTime;/g)));
  check("uTrailMap sampler declared exactly once",
    countOf(s.vertexShader, /uniform sampler2D uTrailMap;/g) === 1);
  for (const u of ["uGrassWindAmp", "uGrassWindFreq", "uGrassWindFlutter", "uGrassLean",
    "uGrassStompBend", "uGrassStompSplay", "uTrailCenter", "uTrailRadius", "uTrailEnabled"]) {
    check(`${u} declared exactly once`,
      countOf(s.vertexShader, new RegExp(`uniform [a-z0-9]+ ${u};`, "g")) === 1);
  }
  for (const a of GRASS_ATTRIBUTES) {
    check(`attribute ${a.name} declared exactly once`,
      countOf(s.vertexShader, new RegExp(`attribute [a-z0-9]+ ${a.name};`, "g")) === 1);
  }
  check("varying vGrassTint declared once per stage",
    countOf(s.vertexShader, /varying vec3 vGrassTint;/g) === 1
    && countOf(s.fragmentShader, /varying vec3 vGrassTint;/g) === 1);
  check("the per-instance hash varying is present in both stages (shared infra)",
    s.vertexShader.includes("vfxHash01") && s.fragmentShader.includes("varying float vVfxHash;"));
  check("the snippet is spliced AFTER the hash assignment (vVfxHash written before read)",
    s.vertexShader.indexOf(VFX_HASH_ASSIGN_VERTEX) < s.vertexShader.indexOf(GRASS_MARKER)
    && s.vertexShader.indexOf(GRASS_MARKER) > 0);
  check("the vertex snippet is closed (BEGIN/END balanced)",
    countOf(s.vertexShader, new RegExp(GRASS_MARKER, "g")) === 1
    && countOf(s.vertexShader, new RegExp(GRASS_END, "g")) === 1);
  check("declarations sit at GLOBAL scope (before void main)",
    s.vertexShader.indexOf("uniform sampler2D uTrailMap;") < s.vertexShader.indexOf("void main() {"));
  check("only `transformed` and the tint varying are written (no gl_Position surgery)",
    /transformed = hbP;/.test(s.vertexShader) && !/gl_Position\s*=/.test(
      s.vertexShader.slice(s.vertexShader.indexOf(GRASS_MARKER), s.vertexShader.indexOf(GRASS_END))));
  check("the fragment side only multiplies diffuseColor by the per-blade tint",
    /diffuseColor\.rgb \*= vGrassTint;/.test(s.fragmentShader));
}

// ---------------------------------------------------------------------------
console.log("\n-- S2: absent seam ⇒ byte-identical no-op --");
{
  const noSeam = {
    vertexShader: "void main() { gl_Position = vec4(0.0); }",
    fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
  };
  const vBefore = noSeam.vertexShader;
  const fBefore = noSeam.fragmentShader;
  injectTerrainGrassShader(noSeam);
  check("no begin_vertex ⇒ vertexShader === before", noSeam.vertexShader === vBefore);
  check("no begin_vertex ⇒ fragmentShader === before", noSeam.fragmentShader === fBefore);
  check("not reported as patched", hasTerrainGrassShader(noSeam) === false);

  // A vertex seam without the fragment seam is also inert (both or neither —
  // a tint varying written but never read is a link-time landmine).
  const halfSeam = {
    vertexShader: "#include <common>\nvoid main() {\n  #include <begin_vertex>\n}",
    fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
  };
  const hvBefore = halfSeam.vertexShader;
  injectTerrainGrassShader(halfSeam);
  check("vertex seam but no color_fragment seam ⇒ still a no-op",
    halfSeam.vertexShader === hvBefore);

  check("a garbage shader object is tolerated",
    injectTerrainGrassShader(null) === null
    && injectTerrainGrassShader({}).vertexShader === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- S3: recompile-safe (idempotent) --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  const v1 = s.vertexShader;
  const f1 = s.fragmentShader;
  injectTerrainGrassShader(s);
  injectTerrainGrassShader(s);
  check("a second and third inject change nothing",
    s.vertexShader === v1 && s.fragmentShader === f1);
  check("still exactly one uTime declaration after three injects",
    countOf(s.vertexShader, /uniform float uTime;/g) === 1);
  check("still exactly one marker", countOf(s.vertexShader, new RegExp(GRASS_MARKER, "g")) === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- S4: the program cache key is never touched --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  check("injector sets no customProgramCacheKey on the shader",
    s.customProgramCacheKey === undefined);
  check("emitted GLSL mentions no cache key",
    !/customProgramCacheKey/.test(s.vertexShader + s.fragmentShader));
  check("per-blade variety comes from vVfxHash + instanced attributes, not a program",
    /vVfxHash/.test(s.vertexShader) && /aRot/.test(s.vertexShader));
}

// ---------------------------------------------------------------------------
console.log("\n-- S5: windSwayGpu's gust function, cubic in height --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  const snip = s.vertexShader.slice(s.vertexShader.indexOf(GRASS_MARKER), s.vertexShader.indexOf(GRASS_END));
  check("primary band: sin(t + phase)", /sin\(hbT \+ hbPhase\)/.test(snip));
  check("flutter band: the same 3.7x / 1.7 / 1.3 constants as windSwayGpu",
    /sin\(hbT \* 3\.7 \+ hbPhase \* 1\.7 \+ 1\.3\)/.test(snip));
  check("phase is driven by uTime * 2PI * uGrassWindFreq (one shared clock)",
    /hbT = uTime \* 6\.2831853 \* uGrassWindFreq/.test(snip));
  check("per-blade phase from the procedural instance hash",
    /vVfxHash \* 6\.2831853/.test(snip));
  check("amplitude is CUBIC in normalised height (base stays planted)",
    /hbH \* hbH \* hbH \* hbOsc/.test(snip));
  check("moss is stiffened by the sub-variant param", /mix\(1\.0, 0\.25, aFamilyParam\)/.test(snip));
  check("the ground normal leans the blade downhill", /aNormal\.xy \* \(hbP\.z \* uGrassLean\)/.test(snip));
}

// ---------------------------------------------------------------------------
console.log("\n-- S6: stomp reads the trail map at the blade's world position --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  const snip = s.vertexShader.slice(s.vertexShader.indexOf(GRASS_MARKER), s.vertexShader.indexOf(GRASS_END));
  check("world xy comes from the instance matrix translation",
    /instanceMatrix\[3\]\.xy/.test(snip) && /modelMatrix\[3\]\.xy/.test(snip));
  check("gated on uTrailEnabled (no map ⇒ not even a tap)",
    /if \(uTrailEnabled > 0\.5\)/.test(snip));
  check("uv is centred on uTrailCenter over a 2R extent (trail_map's own mapping)",
    /\(hbWorld - uTrailCenter\) \/ \(2\.0 \* uTrailRadius\) \+ 0\.5/.test(snip));
  check("out-of-map uvs are skipped, never clamp-smeared",
    /hbUv\.x >= 0\.0 && hbUv\.x <= 1\.0/.test(snip));
  check("bends the blade DOWN proportionally", /hbP\.z \*= \(1\.0 - uGrassStompBend \* hbStomp\)/.test(snip));
  check("splays along the NEGATIVE trail gradient (away from the stamp)",
    /hbGrad \* -1\.0/.test(snip) && /texture2D\(uTrailMap, hbUv \+ vec2\(hbStep, 0\.0\)\)/.test(snip));
  check("three taps total (value + two forward differences)",
    countOf(snip, /texture2D\(uTrailMap/g) === 3, String(countOf(snip, /texture2D\(uTrailMap/g)));
}

// ---------------------------------------------------------------------------
console.log("\n-- S7: one distance-fade function, shared with terrain_scatter --");
{
  const s = fakeShader();
  injectTerrainGrassShader(s);
  check("hbScatterFade is defined exactly once",
    countOf(s.vertexShader, /float hbScatterFade\(vec2 worldXy\)/g) === 1);
  check("the pool's four uniforms come with it, once each",
    countOf(s.vertexShader, /uniform vec3 uScatterCenter;/g) === 1
    && countOf(s.vertexShader, /uniform float uScatterRadius;/g) === 1
    && countOf(s.vertexShader, /uniform float uScatterFadeStart;/g) === 1
    && countOf(s.vertexShader, /uniform int uScatterShape;/g) === 1);
  check("the blade is scaled by the fade (zero scale at the rim)",
    /hbP \*= hbScatterFade\(hbWorld\);/.test(s.vertexShader));
}

// ---------------------------------------------------------------------------
console.log("\n-- S8/S9: firewall + house rules over the shipped source --");
{
  const srcPath = path.resolve("scene3d/terrain_grass.js");
  const src = fs.readFileSync(srcPath, "utf8");
  const hits = lintSource(src);
  check("lintSource(terrain_grass.js) clean (no Math.random / Date.now() / wire / physics / .visible=)",
    hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join("; "));
  check("no light is ever constructed (§5.2 — a light-count change relinks every material)",
    !/new\s+THREE\.[A-Za-z]*Light\b/.test(src));
  check("castShadow is never turned on", !/castShadow\s*=\s*true/.test(src));
  const s = fakeShader();
  injectTerrainGrassShader(s);
  check("no backticks in the emitted GLSL",
    !s.vertexShader.includes("`") && !s.fragmentShader.includes("`"));
  check("the module imports no three (injected namespace only)",
    !/^import .* from "three"/m.test(src));
  check("the seam constants the injector anchors on are exported",
    GRASS_VERTEX_SEAM === "#include <begin_vertex>"
    && GRASS_FRAGMENT_SEAM === "#include <color_fragment>");
}

console.log(`\nterrain grass shader: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
