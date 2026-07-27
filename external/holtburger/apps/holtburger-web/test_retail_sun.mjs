// test_retail_sun.mjs — RND-11/12 diurnal-curve regression for ?retailSun.
//
// Self-contained: the DayGroup keyframes below are the VERBATIM Dereth Region
// DAT payload (portal 0x13000000, skyInfo.dayGroups[0] "Sunny", 11 SkyTimeOfDay
// entries), and `getLighting` is a direct port of acclient.c:301424
// (DayGroup::GetTimeOfDay) + acclient.c:301485 (SkyDesc::GetLighting). It
// drives the patched `retailSunLighting` from scene3d/atmosphere_lights.js over
// 48 evenly spaced game times.
//
// Loads the module by stripping its three / @takram imports (same technique as
// test_sky_lighting.mjs) so no GPU / bundler is needed.
//
//   node test_retail_sun.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- Region 0x13000000 skyInfo.dayGroups[0].skyTime[] --------------------
const SKY_TIME = [
  { begin: 0, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xFFDCDCDC, ambBright: 0.4, ambColor: 0xFFC864FF },
  { begin: 0.02, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xFFDCDCDC, ambBright: 0.45, ambColor: 0xFFC864FF },
  { begin: 0.16, dirBright: 0.4, dirHeading: 90, dirPitch: 0.9, dirColor: 0xFFDCDCDC, ambBright: 0.45, ambColor: 0xFFC8B4FF },
  { begin: 0.21, dirBright: 0.5, dirHeading: 90, dirPitch: 10, dirColor: 0xFFFAD797, ambBright: 0.4, ambColor: 0xFFBEBEFF },
  { begin: 0.27, dirBright: 0.7, dirHeading: 90, dirPitch: 20, dirColor: 0xFFFAD797, ambBright: 0.35, ambColor: 0xFFE6E6FF },
  { begin: 0.61, dirBright: 0.8, dirHeading: 90, dirPitch: 90, dirColor: 0xFFFAD797, ambBright: 0.35, ambColor: 0xFFE6E6FF },
  { begin: 0.611, dirBright: 0.8, dirHeading: 270, dirPitch: 90, dirColor: 0xFFFAD797, ambBright: 0.35, ambColor: 0xFFE6E6FF },
  { begin: 0.84, dirBright: 0.75, dirHeading: 270, dirPitch: 20, dirColor: 0xFFFAD797, ambBright: 0.35, ambColor: 0xFFC8C8FF },
  { begin: 0.9, dirBright: 0.5, dirHeading: 270, dirPitch: 10, dirColor: 0xFFFFFF96, ambBright: 0.4, ambColor: 0xFFC8B4FF },
  { begin: 0.96, dirBright: 0.35, dirHeading: 270, dirPitch: 0.9, dirColor: 0xFFDCDCDC, ambBright: 0.4, ambColor: 0xFFC864FF },
  { begin: 0.999, dirBright: 0.25, dirHeading: 270, dirPitch: 0.9, dirColor: 0xFFDCDCDC, ambBright: 0.4, ambColor: 0xFFC864FF },
];

const DEG2RAD = 0.0174532925199433;      // acclient.c:301550
const LSCAPE_LIGHT_MINIMUM = 0.2;        // acclient.c:40344
const WORLD_LIGHT_SCALE = 0.4;           // index.js WORLD_LIGHT_SCALE_DEFAULT

/** acclient.c:301424 — bracketing keyframes + ratio, with the wrap branch. */
function getTimeOfDay(t) {
  const n = SKY_TIME.length;
  let i = 0;
  for (let k = 1; k < n && SKY_TIME[k].begin <= t; k += 1) i += 1;
  const before = SKY_TIME[i];
  if (i === n - 1) {
    return [before, SKY_TIME[0], (t - before.begin) / (1.0 - before.begin)];
  }
  const after = SKY_TIME[i + 1];
  return [before, after, (t - before.begin) / (after.begin - before.begin)];
}

const lerp = (a, b, r) => (b - a) * r + a;

/** acclient casts the lerped double to an integer type -> truncation. */
function lerpArgb(a, b, r) {
  let out = 0xff000000;
  for (const sh of [16, 8, 0]) {
    const ca = (a >>> sh) & 0xff;
    const cb = (b >>> sh) & 0xff;
    out |= (Math.trunc(lerp(ca, cb, r)) & 0xff) << sh;
  }
  return out >>> 0;
}

/** acclient.c:301485 — the SkyState fields RND-11/12 consumes. */
function getLighting(t) {
  const [b, a, r] = getTimeOfDay(t);
  const dirBright = lerp(b.dirBright, a.dirBright, r);
  const headingDeg = lerp(b.dirHeading, a.dirHeading, r);
  const pitchDeg = lerp(b.dirPitch, a.dirPitch, r);
  const cp = Math.cos(pitchDeg * DEG2RAD);
  return {
    ambBright: lerp(b.ambBright, a.ambBright, r),
    ambColorArgb: lerpArgb(b.ambColor, a.ambColor, r),
    dirBright,
    dirHeading: headingDeg,
    dirPitch: pitchDeg,
    dirColorArgb: lerpArgb(b.dirColor, a.dirColor, r),
    // Brightness is carried as the sun vector's MAGNITUDE (acclient.c:301554).
    sunVec: [
      Math.sin(headingDeg * DEG2RAD) * dirBright * cp,
      Math.cos(headingDeg * DEG2RAD) * dirBright * cp,
      dirBright * Math.sin(pitchDeg * DEG2RAD),
    ],
  };
}

function loadHelpers() {
  const file = path.join(HERE, "scene3d/atmosphere_lights.js");
  let src = fs.readFileSync(file, "utf8");
  src = src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
  src = src.replace(/^export\s+/gm, "");
  src += "\nreturn { retailSunLighting, RETAIL_SUN_ON };\n";
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

let fails = 0;
let checks = 0;
const ok = (cond, msg) => { checks += 1; if (!cond) { fails += 1; console.error("FAIL:", msg); } };
const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol,
  `${msg}: got ${got}, want ${want} (tol ${tol})`);

const H = loadHelpers();

// ?retailSun defaults ON — the reader is `!== "off"`, so an ABSENT param is ON.
ok(H.RETAIL_SUN_ON === true, "RETAIL_SUN_ON must default true");

let minSun = Infinity;
let maxSun = -Infinity;
let minFlatL = Infinity;
let maxFlatL = -Infinity;

for (let i = 0; i < 48; i += 1) {
  const t = i / 48;
  const s = getLighting(t);
  const r = H.retailSunLighting({
    dirBright: s.dirBright,
    dirColorArgb: s.dirColorArgb,
    ambBright: s.ambBright,
    worldLightScale: WORLD_LIGHT_SCALE,
    indoorMute: false,
  });

  near(r.sunIntensity, s.dirBright * WORLD_LIGHT_SCALE, 1e-6, `i=${i} sunIntensity`);
  near(r.ambientLevel, Math.max(LSCAPE_LIGHT_MINIMUM, s.ambBright), 1e-6, `i=${i} ambientLevel`);

  const dc = s.dirColorArgb;
  const ch = [(dc >>> 16) & 0xff, (dc >>> 8) & 0xff, dc & 0xff].map((v) => v / 255);
  const peak = Math.max(...ch);
  near(r.sunTint.r, ch[0] / peak, 1e-6, `i=${i} sunTint.r`);
  near(r.sunTint.g, ch[1] / peak, 1e-6, `i=${i} sunTint.g`);
  near(r.sunTint.b, ch[2] / peak, 1e-6, `i=${i} sunTint.b`);
  ok(peak <= 1.0 + 1e-9 && r.sunTint.r <= 1.0 + 1e-9, `i=${i} tint must not exceed 1`);

  minSun = Math.min(minSun, r.sunIntensity);
  maxSun = Math.max(maxSun, r.sunIntensity);
  const flatL = Math.max(0, s.sunVec[2]); // N = (0,0,1) flat terrain
  minFlatL = Math.min(minFlatL, flatL);
  maxFlatL = Math.max(maxFlatL, flatL);
}

// The sun must actually move across the day. Pre-patch it was a constant.
ok(maxSun / minSun > 3.0, `sun intensity must swing >3x across the day (got ${(maxSun / minSun).toFixed(2)}x)`);

// Dereth's DAT never drops dirBright below 0.20 in ANY of the 20 day groups —
// night darkness comes from dirPitch collapsing to 0.9 deg, not from dirBright.
// Guard the mechanism that actually carries it.
ok(maxFlatL / minFlatL > 50, `flat-terrain N.sunVec must swing >50x (got ${(maxFlatL / minFlatL).toFixed(1)}x)`);

// LSCAPE_LIGHT_MINIMUM floors AMBIENT ONLY (acclient.c:307261).
const dark = H.retailSunLighting({ dirBright: 0, dirColorArgb: 0xff808080, ambBright: 0, worldLightScale: 1 });
ok(dark.sunIntensity === 0, "dirBright=0 must give sunIntensity 0 (no ambient floor on the sun)");
near(dark.ambientLevel, LSCAPE_LIGHT_MINIMUM, 1e-9, "ambientLevel floor");

// Indoors the sun is cut (Render::minimize_envcell_lighting, acclient.c:379655).
ok(H.retailSunLighting({ dirBright: 0.8, dirColorArgb: 0xffffffff, ambBright: 0.4, indoorMute: true })
  .sunIntensity === 0, "indoorMute must zero the sun");

// Fail-soft on a malformed SkyState.
const bad = H.retailSunLighting({ dirBright: NaN, dirColorArgb: 0, ambBright: undefined });
ok(Number.isFinite(bad.sunIntensity) && Number.isFinite(bad.probeIntensity), "no NaN on bad state");
ok(bad.sunTint.r === 1 && bad.sunTint.g === 1 && bad.sunTint.b === 1, "black dirColor -> neutral tint");

console.log(`sun intensity  : ${minSun.toFixed(4)} .. ${maxSun.toFixed(4)} (${(maxSun / minSun).toFixed(2)}x)`);
console.log(`flat N.sunVec  : ${minFlatL.toFixed(5)} .. ${maxFlatL.toFixed(5)} (${(maxFlatL / minFlatL).toFixed(1)}x)`);
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
