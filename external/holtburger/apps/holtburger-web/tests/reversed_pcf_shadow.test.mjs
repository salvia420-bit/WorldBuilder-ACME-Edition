// tests/reversed_pcf_shadow.test.mjs
//
// 2026-10-20 (improvement hunt recent-render-diff-2) — shader_logdepth.js
// installReversedZ item 9: three r184's 2D PCF getShadow adds shadowBias with
// no reversed-depth branch (its VSM / Basic / point twins flip the sign), so
// under the default reversed-Z `?shadows=on` pushed every reference ~1.2 m
// AWAY from the sun against a GreaterEqual compare: the lit faces of thin and
// DoubleSide casters read as shadowed.
//
//   P1  the premise, on three r184's REAL ShaderChunk: one PCF getShadow, its
//       `shadowCoord.z += shadowBias;` unguarded; VSM / Basic guarded
//   P2  reversedPcfShadowChunk: the PCF body gets `-=` and the far test
//       `>= 0.0` under USE_REVERSED_DEPTH_BUFFER, the stock lines in #else
//   P3  log arm: with the define absent the patched chunk compiles to the stock
//       text BYTE FOR BYTE (stripReversedZBranches), and everything outside the
//       PCF function is the stock text
//   P4  reversed arm (define present): the PCF function takes the flipped lines
//   P5  the bug trigger, numerically on the real ?shadows=on sun shadow camera
//       (ortho 0.1..2400, bias -0.0005, reversed projection from three's
//       makeOrthographic): a DoubleSide lit face (stored = its own depth) and
//       a 0.3 m thick FrontSide box (stored = its back face) read SHADOWED with
//       the stock reversed line, LIT with the patched one — and lit on the log
//       arm (conventional), which the patch leaves alone
//   P6  installReversedZ: reversed renderer ⇒ chunk swapped, res.pcfShadowFix;
//       a second install changes nothing (no double wrap); a non-reversed
//       renderer ⇒ untouched
//   P7  drift guards: two PCF functions / no bias line / already branched ⇒
//       null, and installReversedZ leaves the chunk alone with a note
//   P8  index.js records pcfShadowFix in window.__depthMode and the boot log
//
// Run:  cd apps/holtburger-web && node tests/reversed_pcf_shadow.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

globalThis.window ??= {};
window.location ??= { search: "" };
globalThis.location ??= window.location;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THREE = await import("three");
const Z = await import("../scene3d/shader_logdepth.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}
const count = (s, n) => s.split(n).length - 1;

const STOCK = THREE.ShaderChunk.shadowmap_pars_fragment;
const HEAD = "float getShadow( sampler2DShadow shadowMap";
const END = "#elif defined( SHADOWMAP_TYPE_VSM )";
const pcfBody = (s) => { const a = s.indexOf(HEAD); return s.slice(a, s.indexOf(END, a)); };

// The text a GLSL source compiles from WITH USE_REVERSED_DEPTH_BUFFER defined:
// reversed #ifdef bodies kept, their #else bodies dropped (inverse of strip).
function keepReversedBranches(src) {
  const out = [];
  const stack = [];
  const keeping = () => stack.every((f) => !f.rev || !f.inElse);
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (/^#\s*if(?:n?def)?\b/.test(t)) {
      const rev = /^#\s*ifdef\s+USE_REVERSED_DEPTH_BUFFER\b/.test(t);
      if (!rev && keeping()) out.push(line);
      stack.push({ rev, inElse: false });
      continue;
    }
    if (/^#\s*(?:else|elif)\b/.test(t) && stack.length) {
      const top = stack[stack.length - 1];
      if (top.rev) { top.inElse = true; continue; }
      if (keeping()) out.push(line);
      continue;
    }
    if (/^#\s*endif\b/.test(t) && stack.length) {
      const top = stack.pop();
      if (!top.rev && keeping()) out.push(line);
      continue;
    }
    if (keeping()) out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------- P1
console.log("\n-- P1 premise (three r184 ShaderChunk) ------------------------------");
{
  check("P1 three r184", THREE.REVISION === "184", THREE.REVISION);
  check("P1 one 2D PCF getShadow", count(STOCK, HEAD) === 1);
  const body = pcfBody(STOCK);
  check("P1 its bias line is unguarded (the bug)", count(body, "shadowCoord.z += shadowBias;") === 1 && !body.includes("USE_REVERSED_DEPTH_BUFFER"));
  const rest = STOCK.slice(STOCK.indexOf(END));
  check("P1 VSM / Basic / point twins flip under the define", count(rest, "shadowCoord.z -= shadowBias;") === 2 && count(rest, "dp -= shadowBias;") === 1);
}

// ---------------------------------------------------------------------------- P2-P4
console.log("\n-- P2-P4 the patched chunk ------------------------------------------");
const PATCHED = Z.reversedPcfShadowChunk(STOCK);
{
  check("P2 patch applies to the real chunk", typeof PATCHED === "string" && PATCHED !== STOCK);
  const body = pcfBody(PATCHED);
  check("P2 PCF body: reversed bias + far test, stock lines in #else",
    /#ifdef USE_REVERSED_DEPTH_BUFFER\n\s*shadowCoord\.z -= shadowBias;\n\s*#else\n\s*shadowCoord\.z \+= shadowBias;\n\s*#endif/.test(body) &&
    /#ifdef USE_REVERSED_DEPTH_BUFFER\n\s*bool frustumTest = inFrustum && shadowCoord\.z >= 0\.0;\n\s*#else\n\s*bool frustumTest = inFrustum && shadowCoord\.z <= 1\.0;\n\s*#endif/.test(body));
  check("P3 log arm: strips back to the stock chunk byte for byte", Z.stripReversedZBranches(PATCHED) === Z.stripReversedZBranches(STOCK));
  const a = STOCK.indexOf(HEAD);
  const tail = STOCK.slice(STOCK.indexOf(END, a));
  check("P3 everything outside the PCF function is the stock text",
    PATCHED.startsWith(STOCK.slice(0, a)) && PATCHED.endsWith(tail));
  const rev = pcfBody(keepReversedBranches(PATCHED));
  check("P4 reversed arm: `-= shadowBias` and `>= 0.0` only",
    rev.includes("shadowCoord.z -= shadowBias;") && !rev.includes("shadowCoord.z += shadowBias;") &&
    rev.includes("shadowCoord.z >= 0.0") && !rev.includes("shadowCoord.z <= 1.0"));
  check("P4 reversed arm of the stock chunk: still `+=` (the bug)", pcfBody(keepReversedBranches(STOCK)).includes("shadowCoord.z += shadowBias;"));
}

// ---------------------------------------------------------------------------- P5
console.log("\n-- P5 bug trigger on the real ?shadows=on sun camera ----------------");
{
  // lighting.js setupSceneLighting single shadow: near 0.1, far sceneSize*4 = 2400, bias -0.0005.
  const NEAR = 0.1, FAR = 2400, BIAS = -0.0005;
  const mk = (reversed) => {
    const cam = new THREE.OrthographicCamera(-600, 600, 600, -600, NEAR, FAR);
    cam._reversedDepth = reversed;
    cam.updateProjectionMatrix();
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    return cam;
  };
  // [0,1] shadow depth of a point `d` metres in front of the light, as
  // LightShadow.updateMatrices maps it (conventional: 0.5 z + 0.5; reversed: identity Z).
  const depth01 = (cam, d) => {
    const v = new THREE.Vector3(0, 0, -d).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    return cam.reversedDepth ? v.z : v.z * 0.5 + 0.5;
  };
  // The arm's bias line, read from the chunk text that arm compiles.
  const biasOp = (text) => (/shadowCoord\.z ([-+])= shadowBias;/.exec(pcfBody(text)) || [])[1];
  const lit = (reversed, text, dFace, dStored) => {
    const cam = mk(reversed);
    const op = biasOp(text);
    const ref = depth01(cam, dFace) + (op === "-" ? -BIAS : BIAS);
    const stored = depth01(cam, dStored);
    // PCF compare: LessEqual conventional, GreaterEqual reversed (WebGLShadowMap).
    return reversed ? ref >= stored : ref <= stored;
  };
  const revStock = keepReversedBranches(STOCK);
  const revFixed = keepReversedBranches(PATCHED);
  const logFixed = Z.stripReversedZBranches(PATCHED);
  const dFace = 800;
  // DoubleSide lit face: its own depth is in the map.
  check("P5 stock reversed: a DoubleSide lit face reads SHADOWED (bug trigger)", lit(true, revStock, dFace, dFace) === false);
  check("P5 patched reversed: lit", lit(true, revFixed, dFace, dFace) === true);
  check("P5 log arm (conventional): lit, patch or not", lit(false, logFixed, dFace, dFace) === true && lit(false, STOCK, dFace, dFace) === true);
  // 0.3 m thick FrontSide box: three renders its back face (shadowSide).
  check("P5 stock reversed: a 0.3 m box's lit face reads SHADOWED", lit(true, revStock, dFace, dFace + 0.3) === false);
  check("P5 patched reversed: lit", lit(true, revFixed, dFace, dFace + 0.3) === true);
  // Where the stock reversed line starts working: thickness > |bias| * range.
  check("P5 stock reversed only lights casters thicker than ~1.2 m", lit(true, revStock, dFace, dFace + 1.25) === true && lit(true, revStock, dFace, dFace + 1.15) === false);
  // A receiver truly behind an occluder 5 m nearer the light stays shadowed.
  check("P5 patched reversed: real shadows stay shadows", lit(true, revFixed, dFace, dFace - 5) === false && lit(false, logFixed, dFace, dFace - 5) === false);
}

// ---------------------------------------------------------------------------- P6
console.log("\n-- P6 installReversedZ ------------------------------------------------");
const stubRenderer = (reversed) => ({
  state: { buffers: { depth: { getReversed: () => reversed, setFunc() {} } } },
  getContext: () => ({ getParameter: () => 0, NEVER: 0x0200 }),
  domElement: { addEventListener() {} },
});
const fakeTHREE = () => ({ ...THREE, ShaderChunk: { packing: THREE.ShaderChunk.packing, shadowmap_pars_fragment: STOCK } });
{
  const T = fakeTHREE();
  const r = Z.installReversedZ(T, stubRenderer(true));
  check("P6 reversed renderer: pcfShadowFix, chunk swapped", r.installed && r.pcfShadowFix === true && T.ShaderChunk.shadowmap_pars_fragment === PATCHED, JSON.stringify(r));
  check("P6 three's own ShaderChunk untouched (the fake was patched)", THREE.ShaderChunk.shadowmap_pars_fragment === STOCK);
  const r2 = Z.installReversedZ(T, stubRenderer(true));
  check("P6 second install: still pcfShadowFix, no double wrap", r2.pcfShadowFix === true && T.ShaderChunk.shadowmap_pars_fragment === PATCHED &&
    count(pcfBody(T.ShaderChunk.shadowmap_pars_fragment), "USE_REVERSED_DEPTH_BUFFER") === 2);
  const T3 = fakeTHREE();
  const r3 = Z.installReversedZ(T3, stubRenderer(false));
  check("P6 non-reversed renderer: nothing installed, chunk untouched", r3.installed === false && r3.pcfShadowFix === false && T3.ShaderChunk.shadowmap_pars_fragment === STOCK);
}

// ---------------------------------------------------------------------------- P7
console.log("\n-- P7 drift guards -----------------------------------------------------");
{
  const body = pcfBody(STOCK);
  const twoHeads = STOCK.replace(END, body + END);
  const noBias = STOCK.replace(body, body.replace("shadowCoord.z += shadowBias;", "shadowCoord.z += shadowBias * 1.0;"));
  const twoBias = STOCK.replace(body, body.replace("shadowCoord.z += shadowBias;", "shadowCoord.z += shadowBias;\n\t\t\tshadowCoord.z += shadowBias;"));
  const branched = STOCK.replace(body, body.replace("shadowCoord.z += shadowBias;", "#ifdef USE_REVERSED_DEPTH_BUFFER\nshadowCoord.z -= shadowBias;\n#else\nshadowCoord.z += shadowBias;\n#endif"));
  check("P7 two PCF functions ⇒ null", Z.reversedPcfShadowChunk(twoHeads) === null);
  check("P7 bias line changed ⇒ null", Z.reversedPcfShadowChunk(noBias) === null);
  check("P7 bias line twice ⇒ null", Z.reversedPcfShadowChunk(twoBias) === null);
  check("P7 already branched ⇒ null", Z.reversedPcfShadowChunk(branched) === null);
  check("P7 not a string ⇒ null", Z.reversedPcfShadowChunk(undefined) === null);
  const T = { ...THREE, ShaderChunk: { packing: THREE.ShaderChunk.packing, shadowmap_pars_fragment: noBias } };
  const r = Z.installReversedZ(T, stubRenderer(true));
  check("P7 installReversedZ on a drifted chunk: left alone, noted", r.pcfShadowFix === false && T.ShaderChunk.shadowmap_pars_fragment === noBias &&
    r.notes.some((n) => /shadowmap_pars_fragment/.test(n)), JSON.stringify(r.notes));
}

// ---------------------------------------------------------------------------- P8
console.log("\n-- P8 index.js wiring ---------------------------------------------------");
{
  const ix = readFileSync(resolve(ROOT, "scene3d/index.js"), "utf8");
  check("P8 __depthMode.fixes.pcfShadowFix", /pcfShadowFix: _rzFixes\.pcfShadowFix === true/.test(ix));
  check("P8 boot log carries pcfShadowFix", /pcfShadowFix=\$\{_rz\.pcfShadowFix\}/.test(ix));
}

console.log(`\nreversed_pcf_shadow: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
