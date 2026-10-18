// tests/sky2_ssao_sky_sentinel.test.mjs — 2026-10-18 systematic review SKY-2.
//
// The SAO shader writes a sky sentinel distance into the G channel of its
// RG16F AO target (the blur's depth weights read it). It was 1.0e6; half
// floats top out at 65504, and a GPU that rounds an out-of-range value to
// +Inf (IEEE round-to-nearest; Vulkan / Metal leave it implementation-
// defined) then computes Inf - Inf in the blur, so the whole sky's AO is NaN
// and the late NaN scrub blacks the sky out at high / ultra.
//
// The GPU conversion cannot run in Node. This builds the REAL SsaoPass and
// checks what its material actually writes against the target it writes to:
// every sentinel the AO shader stores survives IEEE half conversion, stays
// far beyond any real view distance, and keeps the blur weights finite.
//
// Run: node tests/sky2_ssao_sky_sentinel.test.mjs

globalThis.window = globalThis.window || {};
const THREE = await import("three");
const A = await import("../scene3d/ssao.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const HALF_MAX = 65504;
// IEEE 754 binary16, round-to-nearest-even: anything from 65520 up is +Inf.
const toHalf = (x) => (Math.abs(x) >= 65520 ? Math.sign(x) * Infinity : x);
// The blur's depth weight between a tap q and the centre c (BLUR_FRAG).
const blurWeight = (q, c) => Math.exp(-Math.abs(q - c) * 12 / Math.max(c, 1));

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
const pass = new A.SsaoPass(camera);
pass.setSize(1920, 1080);

console.log("-- the AO target ------------------------------------------------------");
check("the AO target is two-channel half float (RG16F)",
  pass.rtA.texture.type === THREE.HalfFloatType && pass.rtA.texture.format === THREE.RGFormat &&
  pass.rtB.texture.type === THREE.HalfFloatType);

console.log("\n-- the sky sentinel the AO shader writes ------------------------------");
const frag = pass.saoMat.fragmentShader;
const sentinels = [...frag.matchAll(/gl_FragColor\s*=\s*vec4\(\s*1\.0\s*,\s*([-+0-9.eE]+)\s*,\s*0\.0\s*,\s*1\.0\s*\)/g)]
  .map((m) => Number(m[1]));
check("both depth conventions (log, ?reversedZ) write a sky sentinel", sentinels.length === 2, String(sentinels));
check("every sentinel fits half float (<= 65504)", sentinels.every((s) => Number.isFinite(s) && s <= HALF_MAX), String(sentinels));
check("... so IEEE conversion keeps it finite", sentinels.every((s) => Number.isFinite(toHalf(s))));
check("every sentinel lies far beyond the camera's far plane (the blur still separates sky from geometry)",
  sentinels.every((s) => s > camera.far * 4), String(sentinels));

console.log("\n-- blur weights with the stored values --------------------------------");
for (const s of sentinels) {
  const sky = toHalf(s);
  const geo = 120; // a wall 120 m out, beside the sky
  check(`sentinel ${s}: sky beside sky blurs normally (weight 1)`, blurWeight(sky, sky) === 1);
  check(`sentinel ${s}: geometry beside sky never mixes (finite, ~0 both ways)`,
    Number.isFinite(blurWeight(geo, sky)) && blurWeight(geo, sky) < 1e-4 &&
    Number.isFinite(blurWeight(sky, geo)) && blurWeight(sky, geo) < 1e-4);
}
// What the old 1.0e6 did on such a GPU: NaN for the whole sky.
check("(the old 1.0e6 sentinel overflows to +Inf and the sky weight is NaN)",
  Number.isNaN(blurWeight(toHalf(1.0e6), toHalf(1.0e6))));

pass.dispose();
console.log(`\nsky2 ssao sky sentinel: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
