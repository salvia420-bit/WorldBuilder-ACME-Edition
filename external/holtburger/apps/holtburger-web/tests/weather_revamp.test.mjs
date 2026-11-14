// tests/weather_revamp.test.mjs — Comprehensive unit test suite for Items 8, 9, 10, and 11:
//   - Item 8: Multi-layer GPU-instanced crystalline falling snow (`SnowEffect`)
//   - Item 9: Multi-layer GPU-instanced velocity-streaked rain + lazy 16x16 ground/water splashes (`RainEffect`)
//   - Item 10: Procedural 3D forked lightning + volumetric cloud-sheet flash + directional strike light + 343 m/s thunder (`LightningEffect`)
//   - Item 11: Unified cloud-associated `WeatherSystem`, biome climate awareness, `fx_fields` / `sky_dome` cleanup,
//              and HUD Bar + Graphics Settings + Options Panel (`0x04`) bidirectional online/offline toggle sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_CLOUDS = pathToFileURL(
  path.join(HERE, '..', 'vendor', 'takram-three-clouds', 'build', 'index.js')
).href;

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        if (spec === "@takram/three-clouds") return { url: ${JSON.stringify(VENDOR_CLOUDS)}, shortCircuit: true };
        return next(spec, ctx);
      }`
    )
);

// Minimal browser/DOM shims for headless Node unit tests
const storageMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => storageMap.set(String(k), String(v)),
  removeItem: (k) => storageMap.delete(String(k)),
  clear: () => storageMap.clear(),
  key: (i) => Array.from(storageMap.keys())[i] ?? null,
  get length() {
    return storageMap.size;
  },
};

function makeFakeDomEnv() {
  const winListeners = new Map();
  const byId = new Map();
  const allElements = [];

  function makeEl(tag) {
    const cls = new Set();
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      title: '',
      textContent: '',
      innerHTML: '',
      type: '',
      checked: false,
      disabled: false,
      value: '',
      htmlFor: '',
      tabIndex: -1,
      scrollTop: 0,
      isConnected: true,
      dataset: {},
      style: {
        display: '',
        left: '',
        top: '',
        right: '',
        bottom: '',
        transform: '',
        cssText: '',
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; },
      },
      children: [],
      parentNode: null,
      classList: {
        add(...cs) {
          for (const c of cs) if (c) cls.add(c);
          el.className = Array.from(cls).join(' ');
        },
        remove(...cs) {
          for (const c of cs) cls.delete(c);
          el.className = Array.from(cls).join(' ');
        },
        toggle(c, force) {
          const on = force === undefined ? !cls.has(c) : !!force;
          if (on) cls.add(c);
          else cls.delete(c);
          el.className = Array.from(cls).join(' ');
          return on;
        },
        contains(c) {
          return cls.has(c);
        },
      },
      appendChild(child) {
        if (!child) return child;
        child.parentNode = el;
        el.children.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      insertBefore(child, ref) {
        child.parentNode = el;
        const idx = el.children.indexOf(ref);
        if (idx >= 0) el.children.splice(idx, 0, child);
        else el.children.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      remove() {
        if (el.parentNode) {
          const idx = el.parentNode.children.indexOf(el);
          if (idx >= 0) el.parentNode.children.splice(idx, 1);
          el.parentNode = null;
        }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') {
          el.id = String(v);
          byId.set(el.id, el);
        }
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (arr) listeners.set(type, arr.filter((f) => f !== fn));
      },
      dispatch(type, ev = {}) {
        const payload = {
          stopPropagation() {},
          preventDefault() {},
          target: el,
          currentTarget: el,
          ...ev,
        };
        for (const fn of listeners.get(type) || []) fn(payload);
      },
      click() {
        el.dispatch('click');
      },
      getBoundingClientRect() {
        return { left: 10, top: 10, right: 50, bottom: 130, width: 40, height: 120 };
      },
      querySelector(sel) {
        const match = (node) => {
          if (sel.startsWith('#')) return node.id === sel.slice(1);
          if (sel.startsWith('.')) {
            const c = sel.slice(1);
            return node.classList.contains(c) || String(node.className || '').split(/\s+/).includes(c);
          }
          if (sel === 'input[type="checkbox"]') return node.tagName === 'INPUT' && node.type === 'checkbox';
          return node.tagName === sel.toUpperCase();
        };
        const walk = (root) => {
          for (const ch of root.children || []) {
            if (match(ch)) return ch;
            const found = walk(ch);
            if (found) return found;
          }
          return null;
        };
        return walk(el);
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (root) => {
          for (const ch of root.children || []) {
            if (sel === '[data-orient]' && ch.dataset?.orient) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      closest() {
        return null;
      },
      focus() {},
      scrollIntoView() {},
    };
    allElements.push(el);
    return el;
  }

  const head = makeEl('head');
  const body = makeEl('body');
  const documentElement = makeEl('html');

  const doc = {
    head,
    body,
    documentElement,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) || body.querySelector(`#${id}`) || head.querySelector(`#${id}`) || null,
    addEventListener() {},
    removeEventListener() {},
  };

  let rafQueue = [];
  globalThis.window = globalThis;
  globalThis.document = doc;
  globalThis.innerWidth = 1920;
  globalThis.innerHeight = 1080;
  globalThis.location = { search: '', href: 'http://127.0.0.1:8765/', reload() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.addEventListener = (t, fn) => {
    if (!winListeners.has(t)) winListeners.set(t, []);
    winListeners.get(t).push(fn);
  };
  globalThis.removeEventListener = (t, fn) => {
    const arr = winListeners.get(t);
    if (arr) winListeners.set(t, arr.filter((f) => f !== fn));
  };
  globalThis.dispatchEvent = (ev) => {
    for (const fn of winListeners.get(ev.type) || []) fn(ev);
    return true;
  };

  return {
    doc,
    allElements,
    flushRaf() {
      const pending = rafQueue;
      rafQueue = [];
      for (const fn of pending) fn(16);
    },
  };
}

makeFakeDomEnv();

const { SnowEffect, SNOW_PRESET_COUNTS, SNOW_LAYER_RADII_M } = await import('../scene3d/weather/snow_effect.js');
const { RainEffect, RAIN_PRESET_COUNTS, SPLASH_LAZY_MOVE_M } = await import('../scene3d/weather/rain_effect.js');
const {
  LightningEffect,
  DEFAULT_THUNDER_DID,
  SPEED_OF_SOUND_MPS,
  STRIKE_PULSE_OFFSETS_MS,
  evaluateStrikeEnvelope,
  buildForkedBoltSegments,
} = await import('../scene3d/weather/lightning_effect.js');
const { WeatherSystem, createWeatherSystem } = await import('../scene3d/weather/weather_system.js');
const {
  getWeatherState,
  getExtendedWeatherState,
  parseWeatherUrlMode,
  setWeatherMode,
  updateFromDayGroup,
  updateFromPosition,
  updateBiomeClimate,
  setCloudOverheadFactor,
  setLightningFlashState,
  _resetWeatherStateForTest,
} = await import('../scene3d/weather_state.js');
const { weatherForState, applyBiomeToProfile } = await import('../scene3d/daygroup_weather.js');
const { applyContinuousWeatherLook, weatherCloudinessFactor } = await import('../scene3d/cloud_storm_look.js');
const { CloudVolume } = await import('../scene3d/cloud_volume.js');
const { cloudLightningSheetRadiance } = await import('../scene3d/cloud_night.js');
const {
  isWeatherEnabled,
  setWeatherEnabled,
  toggleWeatherEnabled,
  readVisualOptions,
  _resetVisualOptionsForTest,
} = await import('../scene3d/visual_options.js');
const {
  VOLCANO_BOX_MIN_FRAC,
  fxFieldDensities,
  setFxFieldsSnowDelegated,
} = await import('../scene3d/vfx/fx_fields.js');
const { FAM_SNOWICE, FAM_WATER } = await import('../scene3d/terrain_families.js');
const { SkyDome } = await import('../scene3d/sky_dome.js');
const { mountBar } = await import('../ui/bar.js');
const { __setHudDietSearchForTest } = await import('../ui/hud_diet.js');
const { renderGraphicsTab, loadGraphicsState } = await import('../ui/graphics_settings.js');
const optionsPanel = await import('../plugins/options-panel.js');

// ---------------------------------------------------------------------------
// 1. Item 8 — Multi-Layer GPU-Instanced Crystalline Snow
// ---------------------------------------------------------------------------

test('[Item 8] SnowEffect builds 3 stratified layers in 1 draw call with zero per-frame CPU buffer uploads', () => {
  const scene = new THREE.Scene();
  const snow = new SnowEffect({ scene, preset: 'high', seed: 12345 });

  assert.equal(snow.maxInstances, SNOW_PRESET_COUNTS.high);
  assert.deepEqual(SNOW_LAYER_RADII_M, { near: 14, mid: 32, far: 65 });
  assert.equal(snow.mesh.parent, scene);
  assert.equal(snow.mesh.visible, false);

  // Verify near (0), mid (1), and far (2) layers are interleaved in one buffer
  const flakeAttr = snow.geometry.getAttribute('aFlake');
  const seedAttr = snow.geometry.getAttribute('aSeed');
  const layerCounts = [0, 0, 0];
  for (let i = 0; i < snow.maxInstances; i++) {
    layerCounts[flakeAttr.array[i * 4 + 0]]++;
  }
  assert.ok(layerCounts[0] > 1000, 'near crystalline layer populated');
  assert.ok(layerCounts[1] > 1000, 'mid feathered layer populated');
  assert.ok(layerCounts[2] > 600, 'far atmospheric layer populated');

  // Verify shader anchors for 6-fold dendrite crystal + depth bokeh + lightning + lanterns
  assert.match(snow.material.fragmentShader, /snowCrystalMask/);
  assert.match(snow.material.fragmentShader, /vBokeh/);
  assert.match(snow.material.fragmentShader, /uLightningFlash/);
  assert.match(snow.material.vertexShader, /uFxLightPos/);

  const seedVerBefore = seedAttr.version;
  const flakeVerBefore = flakeAttr.version;

  snow.tick(0.05, {
    enabled: true,
    intensity: 0.85,
    isIndoor: false,
    cameraPos: { x: 1200, y: 80, z: -3400 },
    wind: { x: 3.2, y: 0, z: -1.8 },
    gustStrength: 0.7,
    lightningFlash: 0.9,
    immediate: true,
  });

  assert.equal(snow.stats().drawCalls, 1);
  assert.equal(snow.mesh.visible, true);
  assert.equal(seedAttr.version, seedVerBefore, 'zero CPU buffer uploads on aSeed');
  assert.equal(flakeAttr.version, flakeVerBefore, 'zero CPU buffer uploads on aFlake');
  assert.equal(snow.uniforms.uLightningFlash.value, 0.9);

  // Smooth ~0.35s doorway fade on entering indoor cell (no abrupt pop!)
  snow.tick(0.05, { enabled: true, intensity: 0.85, isIndoor: true });
  assert.ok(snow.stats().indoorFade > 0.4 && snow.stats().indoorFade < 0.95, 'mid-fade at doorway');
  assert.equal(snow.mesh.visible, true);

  for (let i = 0; i < 20; i++) {
    snow.tick(0.05, { enabled: true, intensity: 0.85, isIndoor: true });
  }
  assert.equal(snow.stats().indoorFade, 0);
  assert.equal(snow.mesh.visible, false, 'fully culled once inside building');

  snow.setPreset('low');
  assert.equal(snow.maxInstances, SNOW_PRESET_COUNTS.low);
  snow.dispose();
  assert.equal(snow.mesh.parent, null);
});

// ---------------------------------------------------------------------------
// 2. Item 9 — Multi-Layer Velocity-Streaked Rain & Ground/Water Splashes
// ---------------------------------------------------------------------------

test('[Item 9] RainEffect renders streaks + splashes in 2 draw calls and lazily caches 16x16 surface grid', () => {
  const scene = new THREE.Scene();
  const rain = new RainEffect({ scene, preset: 'high', seed: 54321 });

  assert.equal(rain.maxStreaks, RAIN_PRESET_COUNTS.high.streaks);
  assert.equal(rain.maxSplashes, RAIN_PRESET_COUNTS.high.splashes);

  // Verify 3 visual streak tiers (0 close specular, 1 mid tapered, 2 storm-curtain sheets)
  const dropAttr = rain.streakGeometry.getAttribute('aDrop');
  const tierCounts = [0, 0, 0];
  for (let i = 0; i < rain.maxStreaks; i++) {
    tierCounts[dropAttr.array[i * 4 + 0]]++;
  }
  assert.ok(tierCounts[0] > 1000, 'close specular raindrops');
  assert.ok(tierCounts[1] >= 1800, 'mid fine rain streaks');
  assert.ok(tierCounts[2] > 200, 'distant valley storm-curtain sheets');
  assert.match(rain.streakMaterial.vertexShader, /cross\(viewDir, velDir\)/);

  let sampleCalls = 0;
  const sampleSurface = (wx, wz, out) => {
    sampleCalls++;
    out.valid = true;
    out.height = wx < 0 ? 12.0 : 14.5;
    out.isWater = wx < 0;
  };

  // Initial outdoor tick populates the 16x16 (256-sample) grid
  rain.tick(0.016, {
    enabled: true,
    intensity: 0.9,
    isIndoor: false,
    cameraPos: { x: 0, y: 16.2, z: 0 },
    wind: { x: 4.5, y: 0, z: 2.0 },
    gustStrength: 0.8,
    lightningFlash: 0.75,
    sampleSurface,
    immediate: true,
  });

  assert.equal(rain.stats().drawCalls, 2, 'exactly 2 draw calls (streaks + splashes)');
  assert.equal(rain.stats().splashGridUpdates, 1);
  assert.equal(sampleCalls, 256);

  // Verify water flags & heights populated in uniform arrays
  const waterCells = Array.from(rain.uniforms.uSplashWater.value).filter((w) => w > 0.5).length;
  const groundCells = Array.from(rain.uniforms.uSplashWater.value).filter((w) => w < 0.5).length;
  assert.ok(waterCells > 80 && groundCells > 80, 'grid distinguishes water ripples vs ground splash crowns');

  // Camera move <= 1.5 m must NOT resample surface grid
  rain.tick(0.016, {
    enabled: true,
    intensity: 0.9,
    isIndoor: false,
    cameraPos: { x: 0.9, y: 16.2, z: 0.8 },
    sampleSurface,
  });
  assert.equal(rain.stats().splashGridUpdates, 1, `no resample within ${SPLASH_LAZY_MOVE_M}m`);
  assert.equal(sampleCalls, 256);

  // Camera move > 1.5 m lazily refreshes surface grid
  rain.tick(0.016, {
    enabled: true,
    intensity: 0.9,
    isIndoor: false,
    cameraPos: { x: 2.4, y: 16.2, z: 0.0 },
    sampleSurface,
  });
  assert.equal(rain.stats().splashGridUpdates, 2, 'resamples after moving > 1.5m');

  // Indoor doorway hides splashes immediately
  rain.tick(0.016, {
    enabled: true,
    intensity: 0.9,
    isIndoor: true,
    cameraPos: { x: 2.4, y: 16.2, z: 0.0 },
    sampleSurface,
    immediate: true,
  });
  assert.equal(rain.stats().splashesVisible, false);
  assert.equal(rain.stats().drawCalls, 0);

  rain.dispose();
});

// ---------------------------------------------------------------------------
// 3. Item 10 — Procedural 3D Forked Lightning, Cloud Flash & 343 m/s Thunder
// ---------------------------------------------------------------------------

test('[Item 10] LightningEffect builds 3D forked bolts, multi-pulse directional/cloud flash, and 343 m/s delayed thunder', () => {
  assert.equal(DEFAULT_THUNDER_DID, 0x0a000045);
  assert.equal(SPEED_OF_SOUND_MPS, 343);
  assert.deepEqual(STRIKE_PULSE_OFFSETS_MS, [0, 70, 160]);

  // Verify 3-pulse flicker envelope peaks near 0, 70, 160 ms and decays cleanly
  const p0 = evaluateStrikeEnvelope(10, false);
  const dip1 = evaluateStrikeEnvelope(58, false);
  const p1 = evaluateStrikeEnvelope(78, false);
  const p2 = evaluateStrikeEnvelope(168, false);
  const done = evaluateStrikeEnvelope(800, false);
  assert.ok(p0.boltFlash > dip1.boltFlash, 'decays between pulse 0 and pulse 1');
  assert.ok(p1.boltFlash > dip1.boltFlash, 're-brightens on pulse 1 (70ms)');
  assert.ok(p2.boltFlash > 0.5, 'strong return stroke on pulse 2 (160ms)');
  assert.ok(p1.cloudSheetFlash > 0.5, 'volumetric cloud sheet flash active');
  assert.equal(done.boltFlash, 0);

  // Verify procedural 3D forked bolt geometry
  const built = buildForkedBoltSegments({
    start: { x: 0, y: 680, z: -800 },
    end: { x: 25, y: 10, z: -790 },
    branchCount: 5,
    seed: 99,
  });
  assert.equal(built.trunkSegmentCount, 32, '5 midpoint subdivisions = 32 jagged trunk segments');
  assert.equal(built.branchCount, 5, '5 forked secondary branches');
  assert.ok(built.segments.length > 60, 'trunk + forked branches + tertiary twigs generated');

  // Verify runtime strike + directional light aiming + acoustic speed-of-sound thunder
  const scene = new THREE.Scene();
  const played = [];
  const mockAudio = {
    play(did, pos, opts) {
      played.push({ did, pos, opts });
    },
  };
  const lightning = new LightningEffect({ scene, audioManager: mockAudio, seed: 42 });
  assert.equal(lightning.material.depthTest, true, 'bolts depth-test behind terrain hills');
  assert.equal(lightning.material.depthWrite, true, 'bolts write foreground depth ahead of >1200m post-pass clouds');
  assert.match(lightning.material.vertexShader, /logdepthbuf_vertex/);

  const strike = lightning.flashNow({
    cameraPos: { x: 100, y: 50, z: -200 },
    distanceM: 686, // exactly 2.000s at 343 m/s!
    azimuthRad: 0,  // due East (+X)
    intraCloud: false,
    cloudBaseM: 600,
  });

  assert.equal(Math.round(strike.thunderDelaySec * 1000), 2000);
  lightning.tick(0.012, {
    enabled: true,
    cameraPos: { x: 100, y: 50, z: -200 },
    isIndoor: false,
  });

  assert.equal(lightning.boltMesh.visible, true);
  assert.ok(lightning.strikeLight.intensity > 1.0, 'directional strike light active');
  assert.ok(lightning.strikeLight.position.x > 200, 'directional light aimed from East (+X) strike azimuth');
  assert.ok(lightning.cloudSheetFlash > 0.4, 'cloudSheetFlash exposed for volumetric clouds');
  assert.equal(played.length, 0, 'thunder has not arrived yet at 12 ms');

  // Advance to 1.90 s -> still silent (sound wave in flight)
  for (let i = 0; i < 10; i++) {
    lightning.tick(0.188, { enabled: true, cameraPos: { x: 100, y: 50, z: -200 }, isIndoor: false });
  }
  assert.equal(played.length, 0, 'still silent at 1.892 s');

  // Advance past 2.00 s -> thunder arrives!
  lightning.tick(0.15, { enabled: true, cameraPos: { x: 100, y: 50, z: -200 }, isIndoor: false });
  assert.equal(played.length, 1, 'thunder played after distance / 343 m/s');
  assert.equal(played[0].did, 0x0a000045);
  assert.equal(played[0].opts.refDistance, 50);
  assert.equal(played[0].opts.maxDistance, 5000);
  assert.ok(played[0].pos.x > 700, '3D panner position matches East strike location');

  // Turning weather off cancels pending thunder immediately
  lightning.flashNow({ cameraPos: { x: 0, y: 0, z: 0 }, distanceM: 500 });
  assert.equal(lightning.stats().pendingThunder, 1);
  lightning.tick(0.016, { enabled: false });
  assert.equal(lightning.stats().pendingThunder, 0);
  assert.equal(lightning.strikeLight.intensity, 0);

  lightning.dispose();
});

// ---------------------------------------------------------------------------
// 4. Item 11 — Biome Climate, URL Overrides & Bidirectional Cloud Coupling
// ---------------------------------------------------------------------------

test('[Item 11] weather_state preserves 9-key enumerable contract while supporting URL modes and biome snow/rain cooling', () => {
  _resetWeatherStateForTest();

  // Exact 9-key enumerable shape required by legacy callers & test_weather_flags
  const base = getWeatherState();
  assert.equal(Object.keys(base).length, 9);
  assert.equal(typeof base.rh_pct, 'number');
  assert.equal(typeof base.precip_mm_hr, 'number');
  assert.equal(typeof base.weather_kind, 'string');
  assert.ok(base.cloud_coupling);

  // URL mode parser covers all modes + lint-url-flags off-spellings
  assert.equal(parseWeatherUrlMode('?weather=storm'), 'storm');
  assert.equal(parseWeatherUrlMode('?weather=snow'), 'snow');
  assert.equal(parseWeatherUrlMode('?weather=blizzard'), 'blizzard');
  assert.equal(parseWeatherUrlMode('?weather=rain'), 'rain');
  assert.equal(parseWeatherUrlMode('?weather=cloudy'), 'cloudy');
  assert.equal(parseWeatherUrlMode('?weather=clear'), 'clear');
  for (const offVal of ['off', '0', 'false', 'no', 'none']) {
    assert.equal(parseWeatherUrlMode(`?weather=${offVal}`), 'off');
  }

  // Temperate storm (Holtburg grass, 18°C) -> rainstorm ('storm')
  setWeatherMode('auto');
  updateFromPosition(169 * 192, -180 * 192);
  updateBiomeClimate({ snowIceFrac: 0.0, elevationM: 45, waterFrac: 0.0 });
  const stormSkyObjects = [{ visible: true, properties: 0x04, gfxObjectId: 0x01004c42, pesObjectId: 0 }];
  updateFromDayGroup(weatherForState(null, null, stormSkyObjects));
  let ext = getExtendedWeatherState();
  assert.equal(ext.weather_kind, 'storm');
  assert.ok(ext.temperature_C > 5);
  assert.ok(ext.precip_mm_hr > 10);

  // Alpine / snowy northern biome storm (FAM_SNOWICE = 0.75, elevation = 320m) -> cools below 0°C -> snow/blizzard!
  updateBiomeClimate({ snowIceFrac: 0.75, elevationM: 320, waterFrac: 0.0 });
  ext = getExtendedWeatherState();
  assert.ok(ext.temperature_C < -4, `expected sub-zero biome temperature, got ${ext.temperature_C}`);
  assert.ok(ext.weather_kind === 'blizzard' || ext.weather_kind === 'snow');

  // Pure daygroup helper also supports biome cooling
  const cooled = applyBiomeToProfile({ name: 'heavy-rain', temperature_C: 12, dewpoint_C: 11, surface_pressure_hPa: 1004, is_storm: true }, { snowIceFrac: 0.6, elevationM: 250, latitudeDeg: 58 });
  assert.ok(cooled.temperature_C < 0);

  _resetWeatherStateForTest();
});

test('[Item 11] Bidirectional Cloud <-> Weather association modulates precipitation, storm look, and cloud lightning radiance', () => {
  _resetWeatherStateForTest();
  setWeatherMode('storm');

  // Overhead cloud factor modulates local precip_intensity (0.35 + 0.65 * factor)
  setCloudOverheadFactor(0.0, 0);
  const sparse = getExtendedWeatherState();
  setCloudOverheadFactor(1.0, 1.25);
  const dense = getExtendedWeatherState();
  assert.ok(dense.precip_intensity > sparse.precip_intensity * 2.4, 'dense overhead cloud amplifies storm intensity');
  assert.ok(dense.cloud_coupling.coverageBoost > 0.15, 'active storm boosts cloud coverage');
  assert.ok(dense.cloud_coupling.baseDropM > 150, 'active storm lowers cloud base');

  // cloud_storm_look reads live rh_pct, precip_mm_hr, and cloud_coupling
  const mockEffect = {
    coverage: 0.35,
    cloudLayers: [
      { altitude: 750, height: 650, densityScale: 0.2, shadow: true },
      { altitude: 2200, height: 900, densityScale: 0.15, shadow: true },
      { altitude: 6500, height: 1200, densityScale: 0.06, shadow: false },
      { altitude: 600, height: 3200, densityScale: 0.22, shadow: true },
    ],
  };
  const baseSnap = mockEffect.cloudLayers.map((l) => ({ ...l }));
  const factor = weatherCloudinessFactor(getWeatherState());
  assert.ok(factor > 0.85, `live rh_pct + precip_mm_hr yields high cloudiness factor (${factor})`);
  applyContinuousWeatherLook(mockEffect, 0.45, baseSnap, getWeatherState());
  assert.ok(mockEffect.coverage > 0.65, 'storm thickens live cloud coverage');
  assert.ok(mockEffect.cloudLayers[0].altitude < 750, 'storm lowers cloud base altitude');

  // CloudVolume CPU weather-map sampler + fallback + internal lightning uniform
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  const vol = new CloudVolume({ camera: cam });
  assert.equal(vol.getOverheadCloudFactor(0, 0), 1.0, 'falls back to 1.0 when weather texture absent/disabled');

  // Populate a synthetic 4x4 RGBA DataTexture (west half clear=0, east half stormy=255)
  const texData = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const idx = (y * 4 + x) * 4;
      const val = x >= 2 ? 250 : 10;
      texData[idx + 0] = val;
      texData[idx + 1] = val;
      texData[idx + 2] = val;
      texData[idx + 3] = val;
    }
  }
  const dataTex = new THREE.DataTexture(texData, 4, 4, THREE.RGBAFormat);
  vol.effect.localWeatherTexture = dataTex;
  vol.effect.localWeatherRepeat.set(1, 1);
  vol.effect.localWeatherOffset.set(0, 0);

  const clearFactor = vol.getOverheadCloudFactor(10000, 10000);   // u ~ 0.11 (west clear half)
  const denseFactor = vol.getOverheadCloudFactor(70000, 10000);   // u ~ 0.78 (east storm half)
  assert.ok(denseFactor > clearFactor + 0.5, `dense cloud cell (${denseFactor}) > clear cell (${clearFactor})`);

  // Internal electric blue-white sheet lightning radiance in cloud_night & CloudsMaterial
  const rad = cloudLightningSheetRadiance(0.9, 10);
  assert.ok(rad[2] > rad[1] && rad[1] > rad[0] && rad[2] > 0.2, 'electric blue-white calibrated cloud radiance');

  setLightningFlashState(0.85, 0.92, 400, 700, -500);
  vol.tick({ dirPitch: -20, dirHeading: 90 });
  const lgtRad = vol.effect.cloudsPass?.currentMaterial?.uniforms?.cloudLightningRadiance?.value;
  const lgtOff = vol.effect.cloudsPass?.currentMaterial?.uniforms?.cloudLightningOffset?.value;
  assert.ok(lgtRad && lgtRad.z > 0.2, 'cloudLightningRadiance uniform pulsed during lightning flash');
  assert.ok(lgtOff && lgtOff.w > 0, 'cloudLightningOffset 3D storm-cell attenuation set');

  vol.dispose();
  _resetWeatherStateForTest();
});

// ---------------------------------------------------------------------------
// 5. fx_fields Item 7 + Snow Delegation & SkyDome Weather Particle Reaping
// ---------------------------------------------------------------------------

test('[Item 11 + Item 7] fx_fields enforces VOLCANO_BOX_MIN_FRAC=0.16, delegates snow, and SkyDome reaps 0x04 weather PES chains', () => {
  assert.equal(VOLCANO_BOX_MIN_FRAC, 0.16);

  // Sparse volcano border (< 0.16) emits zero volcanic embers
  const sparseVolc = fxFieldDensities({ volcano: 0.10, ash: 0, snow: 0.8 }, 0.5, false);
  assert.equal(sparseVolc.embers, 0, 'volcano fraction 0.10 (< 0.16) produces zero embers');
  const activeVolc = fxFieldDensities({ volcano: 0.50, ash: 0, snow: 0 }, 0.5, false);
  assert.ok(activeVolc.embers > 0.2, 'volcano fraction 0.50 (>= 0.16) emits embers');

  // Snow delegation suppresses legacy 520-dot fx_fields snow
  setFxFieldsSnowDelegated(false);
  const legacySnow = fxFieldDensities({ snow: 0.8 }, 0.2, false);
  assert.ok(legacySnow.snow > 0.5);

  setFxFieldsSnowDelegated(true);
  const delegatedSnow = fxFieldDensities({ snow: 0.8 }, 0.2, false);
  assert.equal(delegatedSnow.snow, 0, 'legacy 520-dot snow suppressed when WeatherSystem owns snow');
  setFxFieldsSnowDelegated(false);

  // SkyDome immediately reaps attached weather PES chains (0x33000453 / 0x33000428) when dropped by weatherOff
  const destroyedOwners = [];
  const anchor = new THREE.Group();
  anchor.visible = true;
  const fakeDome = {
    _skyBirdsEnabled: true,
    _skyBirdChainsAttached: new Set([0x33000453, 0x33000428]),
    _skyBirdAnchor: anchor,
    scene: new THREE.Scene(),
    liveScene3dRef: { worldRoot: new THREE.Group() },
    _ownerRegistry: {
      destroyAllForOwner(key) {
        destroyedOwners.push(key);
      },
    },
  };
  // Partial drop: 0x33000428 disappears while 0x33000453 stays visible
  SkyDome.prototype.updateSkyParticleChains.call(
    fakeDome,
    [{ visible: true, pesObjectId: 0x33000453 }],
    null
  );
  assert.equal(fakeDome._skyBirdChainsAttached.size, 1);
  assert.deepEqual(destroyedOwners, [`sky:${0x33000428}`]);
  assert.equal(fakeDome._skyBirdAnchor.visible, true);

  // Now weatherOff filters out all weather skyObjects -> empty array -> SkyDome immediately reaps remaining chain & hides anchor!
  SkyDome.prototype.updateSkyParticleChains.call(fakeDome, [], null);
  assert.equal(fakeDome._skyBirdChainsAttached.size, 0);
  assert.deepEqual(destroyedOwners, [`sky:${0x33000428}`, `sky:${0x33000453}`]);
  assert.equal(fakeDome._skyBirdAnchor.visible, false);
});

// ---------------------------------------------------------------------------
// 6. Unified WeatherSystem + HUD Bar + Graphics Settings + Options Panel Sync
// ---------------------------------------------------------------------------

test('[Item 11] WeatherSystem + HUD Bar + Graphics Settings + Options Panel (0x04) sync live both offline and online', () => {
  storageMap.clear();
  _resetVisualOptionsForTest();
  _resetWeatherStateForTest();
  __setHudDietSearchForTest('');

  const dom = makeFakeDomEnv();
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  cam.position.set(100, 40, -200);

  let serverDisableWeatherBit = false;
  const setCharCalls = [];
  const mockHandle = {
    isCharacterOptionEnabled(idx) {
      return idx === 0x04 ? serverDisableWeatherBit : false;
    },
    setCharacterOption(idx, val) {
      setCharCalls.push([idx, val]);
      if (idx === 0x04) serverDisableWeatherBit = !!val;
    },
    isCurrentCellIndoor: () => false,
  };

  const wxSys = createWeatherSystem({
    scene,
    camera: cam,
    qualityPreset: 'mid',
    sessionHandleAccessor: () => mockHandle,
    sampleTerrain: (_wx, _wz, out) => {
      out.valid = true;
      out.height = 38.3;
      out.family = FAM_WATER;
    },
  });

  setWeatherMode('storm');
  wxSys.tick(0.05);
  assert.equal(wxSys.rain.streaksMesh.visible, true, 'storm rain active');
  assert.equal(wxSys.snow.mesh.visible, false);

  // Mount HUD Bar (both bar icon #hb-bar-weather and minimized #hb-weather-pill)
  const barHandle = mountBar({ client: null, root: dom.doc.body, slots: [] });
  dom.flushRaf();
  const barWeatherBtn = dom.doc.getElementById('hb-bar-weather');
  const pillWeatherBtn = dom.doc.getElementById('hb-weather-pill');
  assert.ok(barWeatherBtn, '#hb-bar-weather button mounted on HUD bar');
  assert.ok(pillWeatherBtn, '#hb-weather-pill button mounted next to minimized pill');
  assert.equal(barWeatherBtn.getAttribute('aria-pressed'), 'true');

  // Mount Graphics Settings tab -> find "Weather effects" checkbox (reload: false!)
  const gfxContainer = dom.doc.createElement('div');
  renderGraphicsTab(gfxContainer);
  const weatherLabel = dom.allElements.find((e) => e.tagName === 'LABEL' && e.textContent === 'Weather effects');
  assert.ok(weatherLabel, '"Weather effects" row rendered in Graphics Settings');
  const gfxWeatherCb = dom.allElements.find((e) => e.tagName === 'INPUT' && e.id === weatherLabel.htmlFor);
  const reloadBanner = dom.allElements.find((e) => String(e.className || '').includes('hb-graphics-reload') && e.tagName === 'DIV');
  assert.equal(gfxWeatherCb.checked, true);

  // Mount Options Panel OFFLINE (window.__sessionHandle = null) -> 0x04 checkbox MUST be enabled!
  globalThis.__sessionHandle = null;
  const optParent = dom.doc.createElement('div');
  const unmountOptOffline = optionsPanel.view.mount(optParent, { tab: 'character' });
  const optDisableWeatherLbl = dom.allElements.find((e) => e.tagName === 'LABEL' && e.textContent === 'Disable most weather effects');
  assert.ok(optDisableWeatherLbl, '0x04 label rendered in Options -> Character');
  const optDisableWeatherCb = dom.allElements.find((e) => e.tagName === 'INPUT' && e.id === optDisableWeatherLbl.htmlFor);
  assert.equal(optDisableWeatherCb.disabled, false, '0x04 weather toggle works 100% standalone when offline!');
  assert.equal(optDisableWeatherCb.checked, false);

  // 1) Click HUD Bar weather button -> turns weather OFF everywhere!
  globalThis.__sessionHandle = mockHandle;
  barWeatherBtn.click();
  assert.equal(isWeatherEnabled(mockHandle), false);
  assert.equal(readVisualOptions(mockHandle).weatherOff, true);
  assert.equal(barWeatherBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(pillWeatherBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(gfxWeatherCb.checked, false, 'Graphics Settings checkbox synced to OFF');
  assert.equal(optDisableWeatherCb.checked, true, 'Options 0x04 "Disable most weather effects" synced to checked');
  assert.deepEqual(setCharCalls.at(-1), [0x04, true], 'synced to sessionHandle.setCharacterOption(0x04, true)');

  wxSys.tick(0.2);
  for (let i = 0; i < 15; i++) wxSys.tick(0.1);
  assert.equal(wxSys.rain.streaksMesh.visible, false, 'rain turned off live');
  assert.equal(wxSys.stats().totalDrawCalls, 0, 'zero weather draw calls when disabled');

  // 2) Re-enable via Graphics Settings "Weather effects" checkbox -> reload banner stays hidden!
  gfxWeatherCb.checked = true;
  gfxWeatherCb.dispatch('change');
  assert.equal(reloadBanner.style.display, 'none', 'Weather effects toggle applies live without reload banner');
  assert.equal(isWeatherEnabled(mockHandle), true);
  assert.equal(barWeatherBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(optDisableWeatherCb.checked, false);
  assert.deepEqual(setCharCalls.at(-1), [0x04, false]);

  // 3) Switch terrain biome to snowy mountains in auto storm -> WeatherSystem transitions rain -> snow!
  setWeatherMode('auto');
  updateFromDayGroup(weatherForState(null, null, [{ visible: true, properties: 0x04, gfxObjectId: 0x01004c42, pesObjectId: 0 }]));
  wxSys._customSampleTerrain = (_wx, _wz, out) => {
    out.valid = true;
    out.height = 280;
    out.code = 17;
    out.family = FAM_SNOWICE;
  };
  cam.position.set(500, 282, -12000); // move > 6m to trigger biome scan
  wxSys.tick(0.1);
  assert.equal(wxSys.snow.mesh.visible, true, 'snow activates in snowy mountain storm');

  unmountOptOffline();
  barHandle.destroy();
  wxSys.dispose();
  _resetVisualOptionsForTest();
  _resetWeatherStateForTest();
});
