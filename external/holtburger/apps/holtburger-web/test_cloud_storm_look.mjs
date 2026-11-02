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
  lookLayers, cloudLayersMatchLook, STORM_TOWER_HEIGHT_LOW, STORM_TOWER_HEIGHT_HIGH, FAIR_ALTO_DENSITY_HIGH_SCALE,
  cloudHighBandEnabled, cloudHighBandWant,
  cloudHighBandMarchEnabled, CLOUD_HIGH_BAND_MARCH, CLOUD_HIGH_BAND_SHAFTS_MUL, applyHighBandMarch, restoreHighBandMarch,
  highBandMarchDrift,
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

// --- ?flightView high band (2026-11-01): the storm towers flatten into a deck under a high aircraft ---
{
  check('high band 0: the fair look is the shipped table itself (ground players see no change)',
    lookLayers(false, 0) === FAIR_LAYERS && lookLayers(false, undefined) === FAIR_LAYERS && lookLayers(false, -1) === FAIR_LAYERS);
  const fhi = lookLayers(false, 1);
  check('high band 1, fair: the alto deck thins (density x 0.1), the cumulus tops round (r / g bias 0.7), the rest verbatim',
    FAIR_ALTO_DENSITY_HIGH_SCALE === 0.1 && Math.abs(fhi[3].densityScale - FAIR_LAYERS[3].densityScale * 0.1) < 1e-12
      && fhi[3].altitude === FAIR_LAYERS[3].altitude && fhi[3].height === FAIR_LAYERS[3].height
      && fhi[0].shapeAlteringBias === 0.7 && fhi[1].shapeAlteringBias === 0.7
      && JSON.stringify(fhi[2]) === JSON.stringify(FAIR_LAYERS[2])
      && FAIR_LAYERS[3].densityScale === 0.004 && FAIR_LAYERS[0].shapeAlteringBias === 0.35);
  check('high band 0.5, fair: linear in between (bias 0.525, alto x 0.55)',
    lookLayers(false, 0.5)[0].shapeAlteringBias === 0.525
      && Math.abs(lookLayers(false, 0.5)[3].densityScale - 0.004 * 0.55) < 1e-12);
  const fe = makeEffect();
  applyCloudLook(fe, false, 1);
  check('applyCloudLook writes the fair high-band look; the match test sees it as that look only',
    cloudLayersMatchLook(fe, false, 1) && !cloudLayersMatchLook(fe, false, 0));
  check('high band 0: the storm look is the shipped table itself (ground players see no change)',
    lookLayers(true, 0) === STORM_LAYERS && lookLayers(true, undefined) === STORM_LAYERS);
  const hi = lookLayers(true, 1);
  const tower = STORM_LAYERS.findIndex((l) => l.height === STORM_TOWER_HEIGHT_LOW);
  check('high band 1: the tower fades (height 6000 → 1900 m, density × 0.02), the deck tops round (r / g bias 0.7), the rest verbatim',
    tower >= 0 && hi[tower].height === STORM_TOWER_HEIGHT_HIGH
      && Math.abs(hi[tower].densityScale - STORM_LAYERS[tower].densityScale * 0.02) < 1e-9
      && hi[0].shapeAlteringBias === 0.7 && hi[1].shapeAlteringBias === 0.7
      && JSON.stringify(hi[2]) === JSON.stringify(STORM_LAYERS[2])
      && STORM_LAYERS[tower].height === STORM_TOWER_HEIGHT_LOW && STORM_LAYERS[0].shapeAlteringBias === 0.35);
  check('high band 0.5: linear in between, quantized to 1 %',
    lookLayers(true, 0.5)[tower].height === 3950 && lookLayers(true, 0.504)[tower].height === 3950);
  check('high band: out-of-range blends clamp', lookLayers(true, 7)[tower].height === STORM_TOWER_HEIGHT_HIGH
    && lookLayers(true, -3) === STORM_LAYERS);
  const e = makeEffect();
  applyCloudLook(e, true, 1);
  check('applyCloudLook writes the high-band tower; the match test sees it as the high-band look only',
    e.cloudLayers[tower].height === STORM_TOWER_HEIGHT_HIGH
      && cloudLayersMatchLook(e, true, 1) && !cloudLayersMatchLook(e, true, 0));
  const vol = readFileSync(new URL('./scene3d/cloud_volume.js', import.meta.url), 'utf8');
  check('cloud_volume re-applies the look on a high-band step (globalThis.__hbCloudHighBand)',
    vol.includes('__hbCloudHighBand') && /applyCloudLook\(this\.effect, storm, this\._highBandApplied/.test(vol));
}

// --- ?cloudHighBand (2026-11-01): every-pixel half-res march above the deck -------------------------
{
  check('?cloudHighBand: DEFAULT ON, off / 0 / false / no escape',
    cloudHighBandEnabled('') === true && cloudHighBandEnabled('?cloudHighBand=off') === false
      && cloudHighBandEnabled('?cloudHighBand=0') === false && cloudHighBandEnabled('?cloudHighBand=on') === true);
  check('high-band march: on above 0.65, off below 0.35 (hysteresis, no flapping on the 1 % ease)',
    cloudHighBandWant(0.7, false) === true && cloudHighBandWant(0.6, false) === false
      && cloudHighBandWant(0.4, true) === true && cloudHighBandWant(0.3, true) === false && cloudHighBandWant(undefined, true) === false);
  const vol = readFileSync(new URL('./scene3d/cloud_volume.js', import.meta.url), 'utf8');
  check('the every-pixel march keys on the ABOVE-DECK blend (1.8 km), not the storm-tower fade (900 m)',
    vol.includes('__hbCloudAboveDeck') && !/cloudHighBandWant\(hb,/.test(vol));
  check('cloud_volume switches temporalUpscale + resolutionScale only after the resolve variant is prewarmed (compileAsync)',
    /_prewarmResolveVariant\(\)/.test(vol) && /compileAsync\(mesh/.test(vol) && /eff\.temporalUpscale = false/.test(vol)
      && /eff\.resolutionScale = 0\.5/.test(vol) && /prewarm !== 'done'/.test(vol));
}

// --- ?cloudHighBandMarch (2026-11-02): the march from above without what it cannot show, uniforms only --------
{
  check('?cloudHighBandMarch: DEFAULT ON, off / 0 / false / no escape',
    cloudHighBandMarchEnabled('') === true && cloudHighBandMarchEnabled('?cloudHighBandMarch=off') === false
      && cloudHighBandMarchEnabled('?cloudHighBandMarch=no') === false && cloudHighBandMarchEnabled('?cloudHighBandMarch=on') === true);
  check('the high band: one ground-bounce sample (the undersides are out of view), the light shafts x0',
    CLOUD_HIGH_BAND_MARCH.maxIterationCountToGround === 1 && Object.keys(CLOUD_HIGH_BAND_MARCH).length === 1
      && Object.isFrozen(CLOUD_HIGH_BAND_MARCH) && CLOUD_HIGH_BAND_SHAFTS_MUL === 0);
  // takram's CloudsMaterial.onBeforeRender drops its GROUND_BOUNCE define (a relink of the clouds program, ~300 ms on
  // the 1070, seconds cold) when maxIterationCountToGround is 0: the high band must never write 0 there
  const vendor = readFileSync(new URL('./vendor/takram-three-clouds/build/index.js', import.meta.url), 'utf8');
  check('no define flip: the march keeps maxIterationCountToGround > 0 (takram keys GROUND_BOUNCE on it)',
    /maxIterationCountToGround\.value > 0/.test(vendor) && /GROUND_BOUNCE/.test(vendor)
      && Object.entries(CLOUD_HIGH_BAND_MARCH).every(([k, v]) => k !== 'maxIterationCountToGround' || v > 0));
  // takram's clouds params are accessors on the effect's `clouds` object: a class with getters / setters doubles it
  class Clouds {
    constructor() { this._u = { maxIterationCountToGround: 3, maxIterationCount: 500 }; }
    get maxIterationCountToGround() { return this._u.maxIterationCountToGround; }
    set maxIterationCountToGround(v) { this._u.maxIterationCountToGround = v; }
    get maxIterationCount() { return this._u.maxIterationCount; }
    set maxIterationCount(v) { this._u.maxIterationCount = v; }
  }
  const c = new Clouds();
  const base = applyHighBandMarch(c);
  check('apply writes the march through the accessors and returns exactly what it replaced',
    c.maxIterationCountToGround === 1 && c.maxIterationCount === 500
      && base.maxIterationCountToGround === 3 && Object.keys(base).length === 1);
  check('no drift while the march holds', highBandMarchDrift(c) === null);
  c.maxIterationCountToGround = 2; // a quality preset re-writes it while the aircraft is up
  const drift = highBandMarchDrift(c);
  check('drift reports the re-written param with its new value (the new base for the way down)',
    drift && drift.maxIterationCountToGround === 2 && Object.keys(drift).length === 1);
  restoreHighBandMarch(c, { ...base, ...drift });
  check('restore puts the (updated) base back', c.maxIterationCountToGround === 2);
  check('a march with several params: only the drifted ones are reported',
    JSON.stringify(highBandMarchDrift({ a: 1, b: 5 }, { a: 1, b: 2 })) === JSON.stringify({ b: 5 }));
  check('null-safe: no clouds object / no base', JSON.stringify(applyHighBandMarch(null)) === '{}'
    && highBandMarchDrift(null) === null && (restoreHighBandMarch(null, base), true) && (restoreHighBandMarch(c, null), true));
  const vol = readFileSync(new URL('./scene3d/cloud_volume.js', import.meta.url), 'utf8');
  check('cloud_volume writes the march at the switch into the band, restores it on the way out, re-asserts it on drift',
    /cloudHighBandMarchEnabled\(\) \? applyHighBandMarch\(eff\.clouds\)/.test(vol)
      && /restoreHighBandMarch\(eff\.clouds, this\._hbBaseMarch\)/.test(vol)
      && /highBandMarchDrift\(eff\.clouds\)/.test(vol));
  check('the shafts go off through the ONE writer of maxShadowLengthRayDistance (?cloudNight scale x shaftMul), with or without ?cloudNight',
    /'maxShadowLengthRayDistance', cn\.directFactor \* shaftMul\)/.test(vol)
      && /_scaleCloudUniform\(u, 'maxShadowLengthRayDistance', shaftMul\)/.test(vol)
      && /this\._hbShaftsOff = !!this\._hbBaseMarch/.test(vol) && /this\._hbShaftsOff = false/.test(vol)
      && !/lightShafts\s*=\s*false/.test(vol));
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
