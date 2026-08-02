// test_cloud_storm_look.mjs — the storm/fair cloud-look module that replaced
// the WMO weather→cloud-layer machinery (2026-08-01).
//
// Drives the REAL scene3d/cloud_storm_look.js against an effect-shaped test
// double, and string-audits cloud_volume.js / cloud_overlay.js so the old
// WMO config (or a second inline layer writer) can't silently return.
//
// Run: node test_cloud_storm_look.mjs

import { readFileSync } from 'node:fs';
import {
  applyCloudLook,
  FAIR_LAYERS, STORM_LAYERS,
  FAIR_COVERAGE, STORM_COVERAGE,
  FAIR_HAZE_DENSITY, STORM_HAZE_DENSITY,
} from './scene3d/cloud_storm_look.js';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}`); }
}

function makeEffect() {
  return {
    cloudLayers: [{}, {}, {}, {}],
    coverage: 0.3,
    haze: false,
    clouds: { hazeDensityScale: 0 },
  };
}

const LAYER_KEYS = [
  'channel', 'altitude', 'height', 'densityScale', 'shapeAmount',
  'shapeDetailAmount', 'weatherExponent', 'shapeAlteringBias',
  'coverageFilterWidth', 'shadow',
];

// --- fair look ---------------------------------------------------------
{
  const e = makeEffect();
  check('applyCloudLook(fair) returns true', applyCloudLook(e, false) === true);
  check('fair coverage is 0.5 (the tuned overlay default)', e.coverage === FAIR_COVERAGE && FAIR_COVERAGE === 0.5);
  check('haze is forced on', e.haze === true);
  check('fair haze density is takram\'s subtle default', e.clouds.hazeDensityScale === FAIR_HAZE_DENSITY);
  // R/G/B must be takram CloudLayers.DEFAULT verbatim (vendor CloudLayers.ts).
  const [r, g, b, a] = e.cloudLayers;
  check('R = takram default cumulus (750/650, d0.2, shadow)',
    r.channel === 'r' && r.altitude === 750 && r.height === 650 &&
    r.densityScale === 0.2 && r.shadow === true);
  check('G = takram default cumulus (1000/1200, d0.2, shadow)',
    g.channel === 'g' && g.altitude === 1000 && g.height === 1200 &&
    g.densityScale === 0.2 && g.shadow === true);
  check('B = takram default cirrus (7500/500, d0.003)',
    b.channel === 'b' && b.altitude === 7500 && b.height === 500 &&
    b.densityScale === 0.003 && b.shadow === false);
  check('A = the alto deck the overlay used to set inline (3500/600, d0.004)',
    a.channel === 'a' && a.altitude === 3500 && a.height === 600 &&
    a.densityScale === 0.004 && a.shapeAmount === 0.5);
  check('channels pack to rgba (localWeatherChannels contract)',
    r.channel + g.channel + b.channel + a.channel === 'rgba');
}

// --- storm look --------------------------------------------------------
{
  const e = makeEffect();
  applyCloudLook(e, true);
  const [r, g, b, a] = e.cloudLayers;
  check('storm coverage is 0.55 (map-driven overcast, anti-flood 2026-08-02)', e.coverage === STORM_COVERAGE && STORM_COVERAGE === 0.55);
  check('Cb has the dense-base density profile (const 1, linear -0.55)',
    STORM_LAYERS[3].densityProfile &&
    STORM_LAYERS[3].densityProfile.constantTerm === 1.0 &&
    STORM_LAYERS[3].densityProfile.linearTerm === -0.55);
  {
    // profile round-trip: storm writes the inverted profile onto a
    // DensityProfile-shaped object; fair RESETS it to takram default.
    const t = makeEffect();
    t.cloudLayers = t.cloudLayers.map(() => ({ densityProfile: { expTerm: 9, exponent: 9, linearTerm: 9, constantTerm: 9 } }));
    applyCloudLook(t, true);
    const stormConst = t.cloudLayers[3].densityProfile.constantTerm;
    applyCloudLook(t, false);
    const fp = t.cloudLayers[3].densityProfile;
    check('storm→fair resets the Cb densityProfile to takram default',
      stormConst === 1.0 && fp.linearTerm === 0.75 && fp.constantTerm === 0.25);
  }
  check('storm cumulus deck drops to 600/850 m', r.altitude === 600 && g.altitude === 850);
  check('A becomes a Cb tower: base 600 m, ≥3 km tall', a.altitude === 600 && a.height >= 3000);
  check('Cb top stays inside the raymarch-sane band (<12 km)', a.altitude + a.height < 12000);
  check('Cb density sits AT the 0.05 soft-alpha ceiling (probe 2026-05-16)', a.densityScale === 0.05);
  check('Cb casts terrain shadow (the WMO config never set this)', a.shadow === true);
  check('storm haze is the humid-air endpoint (3e-4)', e.clouds.hazeDensityScale === STORM_HAZE_DENSITY);
  check('cirrus untouched by the storm swap', b.altitude === 7500 && b.densityScale === 0.003);
}

// --- determinism / hygiene --------------------------------------------
{
  // Storm → fair must fully restore: no key survives from the other look.
  const e = makeEffect();
  applyCloudLook(e, true);
  applyCloudLook(e, false);
  const f = makeEffect();
  applyCloudLook(f, false);
  check('fair-after-storm is byte-identical to fresh fair (full restore)',
    JSON.stringify(e.cloudLayers) === JSON.stringify(f.cloudLayers) &&
    e.coverage === f.coverage && e.clouds.hazeDensityScale === f.clouds.hazeDensityScale);

  for (const [name, src] of [['FAIR', FAIR_LAYERS], ['STORM', STORM_LAYERS]]) {
    check(`${name}_LAYERS: every layer defines every CloudLayer key`,
      src.length === 4 && src.every(l => LAYER_KEYS.every(k => k in l)));
    // The 0.05 soft-alpha ceiling is for THICK layers (the probe's finding
    // was about km-scale optical depth); takram's own default cumulus runs
    // 0.2 over ~1 km and is the shipped good look. Guard the product.
    check(`${name}_LAYERS: optical depth (density × height) ≤ the Cb's 440`,
      src.every(l => l.densityScale * l.height <= 0.05 * 8800));
    check(`${name}_LAYERS: numeric fields all finite`,
      src.every(l => LAYER_KEYS.every(k =>
        typeof l[k] === 'string' || typeof l[k] === 'boolean' || Number.isFinite(l[k]))));
  }

  check('missing/short cloudLayers fails soft (returns false)',
    applyCloudLook({}, true) === false && applyCloudLook(null, true) === false);
}

// --- source audit: no WMO resurrection, one layer writer ---------------
{
  const vol = readFileSync(new URL('./scene3d/cloud_volume.js', import.meta.url), 'utf8');
  const ovl = readFileSync(new URL('./scene3d/cloud_overlay.js', import.meta.url), 'utf8');
  check('cloud_volume no longer reads the WMO state (getWeatherState/etage/lcl)',
    !/getWeatherState|etage_m|lcl_m|getWeatherRevision/.test(vol));
  check('cloud_volume switches the look via applyCloudLook on the storm flag',
    vol.includes('applyCloudLook') && vol.includes('readWeatherFlags'));
  check('cloud_volume keeps the ?cloudWeather=off freeze escape',
    vol.includes("get('cloudWeather')"));
  check('cloud_volume loosens temporal variance clipping (anti-cycling, 2026-08-01)',
    vol.includes('varianceGamma') && vol.includes("get('cloudVarGamma')"));
  check('cloud_overlay delegates its baseline to cloud_storm_look (no inline layer writer)',
    ovl.includes('applyCloudLook(this.volume.effect, false)') &&
    !/A\.altitude\s*=\s*3500/.test(ovl));
}

console.log(`\ncloud storm look: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
