// VFX Phase 1 — light.flameFlicker (BLOOM + LIGHT-BUDGET slice) unit test.
//
// Locks: the component registers + lints clean under the (newly-declared)
// "lightIntensity" write cap; the flame waveform is deterministic + bounded +
// strictly > 0 (never a relink-adjacent dark frame); warm point lights are
// classified as flame while white/cool/spot lights are not; and the
// tickFlameFlicker post-pass modulates ONLY pool slot intensity, never a count
// or .visible, and is a hard no-op when the flag is off (byte-identical render).

import {
  flameFlicker,
  FLAME_DEFAULTS,
  flameFlickerMul,
  isFlameLight,
  flameSourcePhase,
  flameFlickerEnabled,
  flameFlickerConfig,
  tickFlameFlicker,
  _resetFlameFlickerFlagsForTest,
} from "./scene3d/vfx/components/flameFlicker.js"; // registers the component
import { validateComponent, getComponent } from "./scene3d/vfx/registry.js";
import { lintManifest, lintSource, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";
import { _resetVfxCatalog } from "./scene3d/vfx_catalog.js";
import fs from "node:fs";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- Registration + manifest (Layer A) -------------------------------------
check("registered as light.flameFlicker", getComponent("light.flameFlicker") === flameFlicker);
check("validateComponent clean", validateComponent(flameFlicker).length === 0,
  validateComponent(flameFlicker).join("; "));
check("lintManifest clean", lintManifest(flameFlicker).length === 0,
  lintManifest(flameFlicker).join("; "));
check("mech=light, family is a valid bucket (emissive)",
  flameFlicker.mech === "light" && flameFlicker.family === "emissive");
check("★ lightCountDelta 0 + deterministic + cacheKeyScope none (no-relink rule)",
  flameFlicker.lightCountDelta === 0 && flameFlicker.deterministic === true &&
  flameFlicker.cacheKeyScope === "none");
check("writes ONLY lightIntensity (the new light-mech write cap)",
  flameFlicker.writes.length === 1 && flameFlicker.writes[0] === "lightIntensity" &&
  ALLOWED_WRITES.has("lightIntensity"));
check("reads are static/derived only (clock + instanceHash)",
  flameFlicker.reads.length > 0 &&
  flameFlicker.reads.every((r) => ["clock", "instanceHash"].includes(r)));
check("no shader hooks (mech=light → no inject/declareUniforms/buildClip)",
  !flameFlicker.inject && !flameFlicker.declareUniforms && !flameFlicker.buildClip);
check("not assigned to the shared tick(dt,t) contract (driven by tickFlameFlicker(scene3d))",
  flameFlicker.tick === undefined);

// ---- Source self-scan (Layer B) — no forbidden patterns --------------------
const src = fs.readFileSync(new URL("./scene3d/vfx/components/flameFlicker.js", import.meta.url), "utf8");
const hits = lintSource(src);
check("★ source lints clean (no .visible= / Math.random / Date.now / wire / collision)",
  hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join(", "));

// ---- Waveform: deterministic + bounded + strictly > 0 ----------------------
let det = true, bounded = true, positive = true, floorEngages = false;
const hiCfg = { ...FLAME_DEFAULTS, amp: 0.6 }; // high amp → exercise the floor
for (let k = 0; k < 4000; k++) {
  const ph = (k % 37) / 37;
  const t = k * 0.013;
  const a = flameFlickerMul(ph, t);
  const b = flameFlickerMul(ph, t);
  if (a !== b) det = false;                              // pure / repeatable
  if (a < FLAME_DEFAULTS.floor - 1e-9 || a > 1 + FLAME_DEFAULTS.amp * 1.281) bounded = false;
  if (a <= 0) positive = false;
  const hi = flameFlickerMul(ph, t, hiCfg);
  if (hi <= 0) positive = false;
  if (Math.abs(hi - hiCfg.floor) < 1e-9) floorEngages = true; // floor clamp fires somewhere
}
check("★ waveform deterministic (same phase,t → same value; no Math.random)", det);
check("★ waveform bounded to [floor, 1+amp*1.28] (never a relink-adjacent pop)", bounded);
check("★ waveform strictly > 0 always (never a dark frame)", positive);
check("floor clamp engages under a high amp (never crosses 0)", floorEngages);

// waveform actually animates (varies in t) and varies per-light (phase)
const v0 = flameFlickerMul(0.2, 1.0), v1 = flameFlickerMul(0.2, 1.7);
const p0 = flameFlickerMul(0.2, 1.0), p1 = flameFlickerMul(0.8, 1.0);
check("waveform varies over time", Math.abs(v0 - v1) > 1e-4);
check("waveform varies per-light phase (co-located torches desync)", Math.abs(p0 - p1) > 1e-4);

// ---- Flame classification ---------------------------------------------------
const warmPoint = { isPointLight: true, color: { r: 1.0, g: 0.32, b: 0.05 } };   // torch
const candle = { isPointLight: true, color: { r: 1.0, g: 0.85, b: 0.6 } };       // warm candle
const whitePoint = { isPointLight: true, color: { r: 1.0, g: 1.0, b: 1.0 } };    // white
const coolPoint = { isPointLight: true, color: { r: 0.1, g: 0.25, b: 1.0 } };    // magic blue
const warmSpot = { isSpotLight: true, color: { r: 1.0, g: 0.3, b: 0.05 } };      // spot (excluded)
check("warm point light → flame", isFlameLight(warmPoint));
check("warm candle → flame", isFlameLight(candle));
check("white point light → NOT flame (no portal/white flicker)", !isFlameLight(whitePoint));
check("cool/magic-blue point light → NOT flame", !isFlameLight(coolPoint));
check("spot light → NOT flame (points only; spots ~absent in data)", !isFlameLight(warmSpot));

// ---- Phase cache: lazy, stable, deterministic ------------------------------
const L = { isPointLight: true, color: { r: 1, g: 0.3, b: 0.05 }, userData: { setupLightOrigin: { x: 3.1, y: 0, z: -2.4 } } };
const ph1 = flameSourcePhase(L);
const ph2 = flameSourcePhase(L);
check("flame phase cached on userData (computed once)", L.userData.__vfxFlamePhase === ph1);
check("flame phase stable across calls (no per-frame jump)", ph1 === ph2 && ph1 >= 0 && ph1 < 1);
const Lcool = { isPointLight: true, color: { r: 0.1, g: 0.2, b: 1.0 }, userData: {} };
check("non-flame light caches sentinel -1", flameSourcePhase(Lcool) === -1 && Lcool.userData.__vfxFlamePhase === -1);

// ---- tickFlameFlicker post-pass: pool-slot intensity only, no count change --
function mkScene(poolEnabled, withFlameSrc) {
  const point = [
    { name: "lp0", visible: true, intensity: 100 },
    { name: "lp1", visible: true, intensity: 60 },
  ];
  const selPoint = withFlameSrc
    ? [
        { isPointLight: true, color: { r: 1, g: 0.3, b: 0.05 }, userData: { setupLightOrigin: { x: 1, y: 2, z: 3 } } },
        { isPointLight: true, color: { r: 1, g: 1, b: 1 }, userData: { setupLightOrigin: { x: 5, y: 6, z: 7 } } }, // white → no flicker
      ]
    : [];
  return {
    frameTime: { tsSec: 2.5 },
    lighting: { lightPool: { enabled: poolEnabled, point, spot: [], selPoint, selSpot: [] } },
  };
}

// (a) flag OFF → byte-identical (no intensity change, no visible change)
_resetVfxCatalog();
_resetFlameFlickerFlagsForTest();
check("flag OFF by default (no ?visual/?flameFlicker)", flameFlickerEnabled() === false);
const sOff = mkScene(true, true);
const beforeOff = sOff.lighting.lightPool.point.map((p) => p.intensity);
tickFlameFlicker(sOff);
check("★ OFF → pool intensities byte-identical (no-op)",
  sOff.lighting.lightPool.point.every((p, i) => p.intensity === beforeOff[i]));

// (b) Force-enable (simulate ?visual&?flameFlicker) by stubbing the flag reader's
//     URL source. We can't set window here, so drive the post-pass via the
//     pure path: enable through a temporary global URLSearchParams shim.
globalThis.window = { location: { search: "?visual=on&flameFlicker=on" } };
_resetVfxCatalog();
_resetFlameFlickerFlagsForTest();
check("flag ON with ?visual=on&flameFlicker=on", flameFlickerEnabled() === true);
check("flag requires ?visual too (?flameFlicker alone = off)", (() => {
  globalThis.window = { location: { search: "?flameFlicker=on" } };
  _resetVfxCatalog(); _resetFlameFlickerFlagsForTest();
  const r = flameFlickerEnabled();
  globalThis.window = { location: { search: "?visual=on&flameFlicker=on" } };
  _resetVfxCatalog(); _resetFlameFlickerFlagsForTest();
  return r === false;
})());

const sOn = mkScene(true, true);
const pool = sOn.lighting.lightPool;
const visBefore = pool.point.map((p) => p.visible);
const countBefore = pool.point.length;
// clock comes from scene3d.frameTime.tsSec (set to 2.5 in mkScene)
tickFlameFlicker(sOn);
check("★ ON → flame slot intensity modulated (slot 0, warm source)",
  pool.point[0].intensity !== 100 && pool.point[0].intensity > 0);
check("★ ON → white-source slot UNCHANGED (only flame sources flicker)",
  pool.point[1].intensity === 60);
check("★ slot intensity stays in band (floor*base .. (1+amp*1.28)*base)",
  pool.point[0].intensity >= FLAME_DEFAULTS.floor * 100 - 1e-6 &&
  pool.point[0].intensity <= (1 + FLAME_DEFAULTS.amp * 1.281) * 100);
check("★ NO count change + NO visibility change (the no-relink rule)",
  pool.point.length === countBefore && pool.point.every((p, i) => p.visible === visBefore[i]));

// (c) ?lightPool=off → no slots → no-op even when enabled
const sLegacy = mkScene(false, true);
const legacyBefore = sLegacy.lighting.lightPool.point.map((p) => p.intensity);
tickFlameFlicker(sLegacy);
check("★ ?lightPool=off → no-op (legacy .visible-cap path, no slots to drive)",
  sLegacy.lighting.lightPool.point.every((p, i) => p.intensity === legacyBefore[i]));

// (d) config: ?flameFlickerAmp override
globalThis.window = { location: { search: "?visual=on&flameFlicker=on&flameFlickerAmp=0.4" } };
_resetVfxCatalog();
_resetFlameFlickerFlagsForTest();
check("?flameFlickerAmp overrides amp", flameFlickerConfig().amp === 0.4);

delete globalThis.window;
_resetVfxCatalog();
_resetFlameFlickerFlagsForTest();

console.log(`\nVFX flameFlicker component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
