// tests/sky6_color_grade_alloc.test.mjs — 2026-10-18 systematic review SKY-6.
//
// `?grade` is default on and ColorGradeEffect.update runs every rendered frame
// (pmndrs EffectPass.render -> effect.update). It used to rebuild the day/night
// blend from scratch each time: an m3 closure, a `[1, 1, 1]`, five `[0, 1, 2]`
// literals with five `.map` results and callbacks, and the result object
// (~18 short-lived objects a frame). The blend now fills one result object the
// effect owns.
//
//   G1  the per-frame path reuses its blend object and calls no Array#map.
//   G2  the uniforms are exactly the blend at the smoothed night fraction
//       (same values as a fresh blendGrade), and live `__grade` edits still
//       land on the next frame.
//   G3  blendGrade(day, night, t) without `out` still returns a fresh result
//       (tests / diagnostics), and `out` is filled in place.
//
// Run: node tests/sky6_color_grade_alloc.test.mjs

globalThis.window = globalThis.window || {};
const G = await import("../scene3d/color_grade.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const near3 = (v, a) => near(v.x, a[0]) && near(v.y, a[1]) && near(v.z, a[2]);

let night = 0.35;
const fx = G.createColorGradeEffect({ enabled: true, nightSource: () => night });

// ---------------------------------------------------------------------------
console.log("-- G1 the per-frame path allocates no blend ---------------------------");
{
  fx.update(null, null, 1 / 60);
  const blend = fx._blend;
  let maps = 0;
  const realMap = Array.prototype.map;
  Array.prototype.map = function (...a) { maps++; return realMap.apply(this, a); };
  try {
    for (let i = 0; i < 120; i++) { night = 0.35 + 0.001 * i; fx.update(null, null, 1 / 60); }
  } finally {
    Array.prototype.map = realMap;
  }
  check("120 frames: no Array#map in update()", maps === 0, `maps=${maps}`);
  check("the effect keeps one blend object across frames", !!blend && fx._blend === blend);
}

// ---------------------------------------------------------------------------
console.log("\n-- G2 the uniforms are the blend ---------------------------------------");
{
  const u = fx.uniforms;
  const ref = G.blendGrade(fx.day, fx.night, fx._night);
  check("uWB / uTint / uLift / uGain are the blend at the smoothed night fraction",
    near3(u.get("uWB").value, ref.wb) && near3(u.get("uTint").value, ref.tint) &&
    near3(u.get("uLift").value, ref.lift) && near3(u.get("uGain").value, ref.gain));
  check("uGammaInv is 1 / gamma", near3(u.get("uGammaInv").value, ref.gamma.map((g) => 1 / g)));
  check("scalars: contrast, pivot, saturation, vibrance",
    near(u.get("uContrast").value, ref.contrast) && near(u.get("uPivot").value, ref.pivot) &&
    near(u.get("uSat").value, ref.saturation) && near(u.get("uVib").value, ref.vibrance));
  fx.day.contrast = 1.3;
  fx.update(null, null, 1 / 60);
  const ref2 = G.blendGrade(fx.day, fx.night, fx._night);
  check("a live `__grade.day` edit lands on the next frame", near(u.get("uContrast").value, ref2.contrast) &&
    !near(u.get("uContrast").value, ref.contrast));
  // A param set without `tint` (older __grade presets) blends from white.
  const { tint: _t, ...noTint } = G.GRADE_NIGHT;
  fx.night = noTint;
  fx.update(null, null, 1 / 60);
  check("a set without tint blends toward [1, 1, 1]",
    near3(u.get("uTint").value, G.blendGrade(fx.day, { ...noTint, tint: [1, 1, 1] }, fx._night).tint));
}

// ---------------------------------------------------------------------------
console.log("\n-- G3 blendGrade's two forms -------------------------------------------");
{
  const a = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 0.25);
  const b = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 0.25);
  check("without `out`: a fresh result each call", a !== b && a.wb !== b.wb);
  const out = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 1, a);
  check("with `out`: filled in place and returned", out === a && near(a.saturation, G.GRADE_NIGHT.saturation) &&
    a.tint.every((c, i) => near(c, G.GRADE_NIGHT.tint[i])));
  check("t is clamped and NaN reads as day",
    near(G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 7).contrast, G.GRADE_NIGHT.contrast) &&
    near(G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, NaN).pivot, G.GRADE_DAY.pivot));
}

fx.dispose?.();
console.log(`\nsky6 color grade alloc: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
