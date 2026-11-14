// scene3d/weather/weather_system.js — Item 11: Unified Cloud-Associated Weather Orchestrator.
//
// Coordinates:
//   - Multi-layer GPU-instanced crystalline falling snow (`SnowEffect`, Item 8)
//   - Multi-layer GPU-instanced velocity-streaked rain + ground/water splashes (`RainEffect`, Item 9)
//   - Procedural 3D forked sky/cloud lightning + internal cloud-sheet flash + delayed thunder (`LightningEffect`, Item 10)
//   - Bidirectional volumetric cloud coupling (`cloud_volume.js` <-> `weather_state.js` <-> `cloud_storm_look.js`)
//   - Local terrain biome/elevation climate sensing (`FAM_SNOWICE`, `FAM_WATER`, elevation)
//   - HUD / Graphics Settings / Options Panel (`0x04`) weather on/off toggle (`visual_options.js`)

import * as THREE from 'three';
import { SnowEffect } from './snow_effect.js';
import { RainEffect } from './rain_effect.js';
import { LightningEffect } from './lightning_effect.js';
import {
  getWeatherState,
  getExtendedWeatherState,
  getWeatherMode,
  setWeatherMode,
  updateFromPosition,
  updateFromDayGroup,
  updateBiomeClimate,
  setCloudOverheadFactor,
  setLightningFlashState,
  setWeatherSuppressed,
  readWeatherCloudCoupling,
} from '../weather_state.js';
import { weatherForState, scanWeatherSkyObjects } from '../daygroup_weather.js';
import {
  isWeatherEnabled,
  setWeatherEnabled,
  readVisualOptions,
  dropWeatherSkyObjects,
  onWeatherEnabledChange,
} from '../visual_options.js';
import { setFxFieldsSnowDelegated } from '../vfx/fx_fields.js';
import { VFX_GLOBALS } from '../materials.js';
import { FAM_SNOWICE, FAM_WATER, familyForCode } from '../terrain_families.js';
import { createTerrainOracle } from '../terrain_oracle.js';
import { ensureOracle, terrainVfxOracle } from '../terrain_vfx.js';
import { viewerIndoorOr } from '../viewer_cell.js';
import { nightFactorFromAuthoredPitch } from '../night_ramp.js';

const BIOME_GRID_N = 5;
const BIOME_SPAN_M = 64.0;
const BIOME_LAZY_MOVE_M = 6.0;
const BIOME_MAX_AGE_SEC = 0.75;

function _normalizePreset(preset) {
  if (preset === 'low' || preset === 'mid' || preset === 'high' || preset === 'ultra') {
    return preset;
  }
  return 'high';
}

export class WeatherSystem {
  /**
   * @param {object} [opts]
   * @param {THREE.Scene} [opts.scene]
   * @param {object} [opts.scene3d]
   * @param {THREE.Camera} [opts.camera]
   * @param {Function} [opts.sessionHandleAccessor]
   * @param {'low'|'mid'|'high'|'ultra'} [opts.qualityPreset]
   * @param {object} [opts.audioManager]
   * @param {(worldX:number, worldZ:number, out:object)=>void} [opts.sampleTerrain]
   * @param {number} [opts.seed]
   */
  constructor(opts = {}) {
    this.scene3d = opts.scene3d || null;
    this.scene = opts.scene || this.scene3d?.scene || null;
    this.camera = opts.camera || this.scene3d?.camera || null;
    this.sessionHandleAccessor = typeof opts.sessionHandleAccessor === 'function'
      ? opts.sessionHandleAccessor
      : () => this.scene3d?.sessionHandle ?? null;
    this.preset = _normalizePreset(opts.qualityPreset || this.scene3d?.quality?.preset || 'high');
    this._customSampleTerrain = typeof opts.sampleTerrain === 'function' ? opts.sampleTerrain : null;

    const baseSeed = opts.seed ?? 0x517cc1b7;
    this.snow = new SnowEffect({
      scene: this.scene,
      preset: this.preset,
      seed: baseSeed ^ 0x11111111,
    });
    this.rain = new RainEffect({
      scene: this.scene,
      preset: this.preset,
      seed: baseSeed ^ 0x22222222,
    });
    this.lightning = new LightningEffect({
      scene: this.scene,
      audioManager: opts.audioManager || this.scene3d?.audioManager || null,
      seed: baseSeed ^ 0x33333333,
    });

    // Delegate ambient snow to our multi-layer crystalline SnowEffect
    setFxFieldsSnowDelegated(true);

    // Warm up shared park-surviving terrain oracle + keep a lightweight local fallback
    try { ensureOracle().catch(() => {}); } catch (_) {}
    this._fallbackOracle = createTerrainOracle({
      getTerrainMeshes: () => {
        try { return this.scene3d?.terrainGroup?.children || []; } catch (_) { return []; }
      },
    });

    this._oracleScratch = {};
    this._ccScratch = {};
    this._camScratch = new THREE.Vector3();
    this._windScratch = { x: 1.5, y: 0, z: 1.5 };
    this._ambientRgb = [0.84, 0.88, 0.95];
    this._rainRgb = [0.74, 0.82, 0.94];

    this._lastBiomeX = NaN;
    this._lastBiomeZ = NaN;
    this._biomeAgeSec = Infinity;
    this._meanGroundY = 0;
    this._biomeStats = { snowIceFrac: 0, waterFrac: 0, elevationM: 0, samples: 0 };

    this._lastDayGroupKey = null;
    this._lastStormScan = false;
    this._disposed = false;

    this._boundSampleSurface = (worldX, worldZ, out) => {
      this.sampleSurface(worldX, worldZ, out);
    };

    // React immediately when user toggles weather on HUD, Graphics Settings, or Options Panel
    this._unsubWeatherEnabled = onWeatherEnabledChange((enabled) => {
      setWeatherSuppressed(!enabled);
      if (!enabled) {
        this.lightning.tick(0, { enabled: false });
        setLightningFlashState(0, 0, 0, 800, 0);
      }
    });

    this._mountWindowHooks();
  }

  _mountWindowHooks() {
    if (typeof window === 'undefined') return;
    window.__weatherSystem = this;
    window.__weatherEffects = {
      flashNow: (o) => this.flashNow(o),
      setMode: (m) => this.setMode(m),
      getMode: () => getWeatherMode(),
      setEnabled: (on) => setWeatherEnabled(on),
      isEnabled: () => isWeatherEnabled(this.sessionHandleAccessor()),
      setPreset: (p) => this.setPreset(p),
      stats: () => this.stats(),
      getState: () => getExtendedWeatherState(),
    };
  }

  setPreset(preset) {
    const next = _normalizePreset(preset);
    if (next === this.preset) return;
    this.preset = next;
    this.snow.setPreset(next);
    this.rain.setPreset(next);
  }

  setMode(mode) {
    return setWeatherMode(mode);
  }

  /**
   * Sample terrain surface height & water/snow-ice family at Three.js `(worldX, worldZ)`.
   */
  sampleSurface(worldX, worldZ, out = {}) {
    if (this._customSampleTerrain) {
      this._customSampleTerrain(worldX, worldZ, out);
      if (out.family !== undefined && out.family >= 0) {
        out.isWater = out.family === FAM_WATER;
        out.isSnowIce = out.family === FAM_SNOWICE;
      }
      return out;
    }

    const acX = worldX;
    const acY = -worldZ;
    const oracle = terrainVfxOracle() || this._fallbackOracle;
    let foundHeight = false;
    let code = -1;
    let fam = -1;

    if (oracle && typeof oracle.sample === 'function') {
      const s = oracle.sample(acX, acY, this._oracleScratch);
      if (s) {
        if (Number.isFinite(s.code) && s.code >= 0) {
          code = s.code;
          fam = Number.isFinite(s.family) ? s.family : familyForCode(code);
        }
        if (s.hasHeight && Number.isFinite(s.height)) {
          out.height = s.height;
          foundHeight = true;
        }
      }
    }

    if (!foundHeight) {
      const handle = this.sessionHandleAccessor();
      if (handle && typeof handle.terrainHeightAt === 'function') {
        try {
          const h = handle.terrainHeightAt(acX, acY);
          if (Number.isFinite(h)) {
            out.height = h;
            foundHeight = true;
          }
        } catch (_) {}
      }
    }

    out.valid = foundHeight;
    out.code = code;
    out.family = fam;
    out.isWater = fam === FAM_WATER;
    out.isSnowIce = fam === FAM_SNOWICE;
    return out;
  }

  _updateBiomeIfNeeded(camX, camY, camZ, dt) {
    this._biomeAgeSec += dt;
    const moved = Math.hypot(camX - this._lastBiomeX, camZ - this._lastBiomeZ);
    if (moved <= BIOME_LAZY_MOVE_M && this._biomeAgeSec < BIOME_MAX_AGE_SEC) {
      return;
    }

    this._lastBiomeX = camX;
    this._lastBiomeZ = camZ;
    this._biomeAgeSec = 0;

    const step = BIOME_SPAN_M / (BIOME_GRID_N - 1);
    const ox = camX - BIOME_SPAN_M * 0.5;
    const oz = camZ - BIOME_SPAN_M * 0.5;

    let validCodes = 0;
    let snowIce = 0;
    let water = 0;
    let hSum = 0;
    let hCount = 0;
    const pt = { height: camY - 1.7, valid: false, code: -1, family: -1, isWater: false, isSnowIce: false };

    for (let j = 0; j < BIOME_GRID_N; j++) {
      const wz = oz + j * step;
      for (let i = 0; i < BIOME_GRID_N; i++) {
        const wx = ox + i * step;
        pt.valid = false;
        pt.code = -1;
        pt.family = -1;
        pt.isWater = false;
        pt.isSnowIce = false;
        this.sampleSurface(wx, wz, pt);
        if (pt.code >= 0 || pt.isSnowIce || pt.isWater) {
          validCodes++;
          if (pt.isSnowIce) snowIce++;
          if (pt.isWater) water++;
        }
        if (pt.valid && Number.isFinite(pt.height)) {
          hSum += pt.height;
          hCount++;
        }
      }
    }

    const elevationM = hCount > 0 ? hSum / hCount : Math.max(0, camY - 1.7);
    this._meanGroundY = elevationM;

    if (validCodes > 0 || hCount > 0) {
      const snowIceFrac = validCodes > 0 ? snowIce / validCodes : 0;
      const waterFrac = validCodes > 0 ? water / validCodes : 0;
      this._biomeStats.snowIceFrac = snowIceFrac;
      this._biomeStats.waterFrac = waterFrac;
      this._biomeStats.elevationM = elevationM;
      this._biomeStats.samples += 1;
      updateBiomeClimate(this._biomeStats);
    }
  }

  _syncStandaloneSkyState(s3d, handle, weatherOff = false) {
    // When CloudOverlay is active, CloudVolume.tick already feeds DayGroup + SkyObject
    // scans into weather_state.js. When volumetric clouds are disabled (e.g. low/mid
    // presets or ?clouds=off), sync DayGroup + SkyObject weather directly here!
    if (s3d?.cloudOverlay?.volume) return;
    if (!handle || typeof handle.getSkyState !== 'function') return;
    let skyState = null;
    try {
      skyState = handle.getSkyState();
    } catch (_) {
      return;
    }
    if (!skyState) return;
    let rawObjects = skyState.skyObjects;
    if (!Array.isArray(rawObjects) && typeof handle.getSkyObjectStates === 'function') {
      try { rawObjects = handle.getSkyObjectStates(); } catch (_) {}
    }
    const skyObjects = weatherOff ? dropWeatherSkyObjects(rawObjects) : rawObjects;
    const scan = scanWeatherSkyObjects(skyObjects);
    const dgIdx = Number.isFinite(skyState.dayGroupIndex) ? skyState.dayGroupIndex : null;
    const dgKey = `${dgIdx ?? ''}:${skyState.dayGroupName ?? ''}`;
    const isStorm = weatherOff ? false : !!scan.is_storm;
    if (dgKey !== this._lastDayGroupKey || isStorm !== this._lastStormScan) {
      this._lastDayGroupKey = dgKey;
      this._lastStormScan = isStorm;
      const profile = weatherForState(skyState, dgIdx, skyObjects);
      updateFromDayGroup(weatherOff ? { ...profile, is_storm: false } : profile);
    }
  }

  _resolveLightingAndExposure(s3d) {
    let exposure = 1.0;
    const expVal = s3d?.renderer?.toneMappingExposure;
    if (Number.isFinite(expVal) && expVal > 0) exposure = expVal;

    const skyState = s3d?.skyLightingController?._lastState;
    let night = 0;
    if (skyState && Number.isFinite(skyState.sunPitchDeg)) {
      night = nightFactorFromAuthoredPitch(skyState.sunPitchDeg);
    } else if (Number.isFinite(s3d?.skyDome?._lastSunPitchDeg)) {
      night = nightFactorFromAuthoredPitch(s3d.skyDome._lastSunPitchDeg);
    }

    const dayLum = 1.0 - 0.72 * night;
    this._ambientRgb[0] = 0.86 * dayLum + 0.10 * night;
    this._ambientRgb[1] = 0.90 * dayLum + 0.14 * night;
    this._ambientRgb[2] = 0.97 * dayLum + 0.24 * night;

    this._rainRgb[0] = 0.72 * dayLum + 0.12 * night;
    this._rainRgb[1] = 0.80 * dayLum + 0.17 * night;
    this._rainRgb[2] = 0.92 * dayLum + 0.28 * night;

    return exposure;
  }

  /**
   * Trigger an immediate lightning bolt + cloud sheet flash + delayed thunder.
   */
  flashNow(opts = {}) {
    const s3d = this.scene3d;
    const handle = this.sessionHandleAccessor();
    if (!isWeatherEnabled(handle)) return null;

    const activeCam = s3d?.cameraSwitcher?.activeCamera ?? this.camera;
    let camPos = opts.cameraPos || null;
    if (!camPos && activeCam) {
      if (typeof activeCam.getWorldPosition === 'function') {
        camPos = activeCam.getWorldPosition(this._camScratch);
      } else if (activeCam.position) {
        camPos = activeCam.position;
      }
    }

    const cc = readWeatherCloudCoupling(this._ccScratch);
    const ws = getWeatherState();
    const res = this.lightning.flashNow({
      cameraPos: camPos || { x: 0, y: 0, z: 0 },
      denseCloudAzimuth: cc.denseCloudAzimuth ?? cc.dense_cloud_azimuth,
      cloudBaseM: Math.max(380, (ws.lcl_m || 620) - (cc.base_drop_m || 0)),
      groundY: this._meanGroundY,
      ...opts,
    });
    setLightningFlashState(
      this.lightning.sceneFlash,
      this.lightning.cloudSheetFlash,
      this.lightning.strikeWorldPos.x,
      this.lightning.strikeWorldPos.y,
      this.lightning.strikeWorldPos.z
    );
    return res;
  }

  /**
   * Per-frame weather tick. Safe to call every frame; zero per-frame allocations.
   * @param {number} dt seconds
   * @param {object} [scene3dOverride]
   * @param {object} [sessionHandleOverride]
   */
  tick(dt, scene3dOverride, sessionHandleOverride) {
    if (this._disposed) return;

    const s3d = scene3dOverride || this.scene3d;
    if (s3d && !this.scene3d) this.scene3d = s3d;

    const handle = sessionHandleOverride !== undefined
      ? sessionHandleOverride
      : (s3d?.sessionHandle ?? this.sessionHandleAccessor());

    // Sync quality preset dynamically if Graphics Settings changed it live
    const livePreset = s3d?.quality?.preset;
    if (livePreset && livePreset !== this.preset) {
      this.setPreset(livePreset);
    }

    const activeCam = s3d?.cameraSwitcher?.activeCamera ?? s3d?.camera ?? this.camera;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (activeCam) {
      if (typeof activeCam.getWorldPosition === 'function') {
        const p = activeCam.getWorldPosition(this._camScratch);
        cx = p.x; cy = p.y; cz = p.z;
      } else if (activeCam.position) {
        cx = activeCam.position.x || 0;
        cy = activeCam.position.y || 0;
        cz = activeCam.position.z || 0;
      }
    }

    const stepDt = Number.isFinite(dt) && dt >= 0 ? Math.min(dt, 0.25) : 0.016;

    // 1. Check HUD / Options weather enable state
    const nowMs = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const visOpts = readVisualOptions(handle, nowMs);
    const enabledByUser = isWeatherEnabled(handle) && !visOpts.weatherOff;
    setWeatherSuppressed(!enabledByUser);

    // 2. Sense local terrain biome (snow/ice, water, elevation) + standalone sky state
    this._updateBiomeIfNeeded(cx, cy, cz, stepDt);
    this._syncStandaloneSkyState(s3d, handle, !enabledByUser);

    // 3. Bidirectional cloud density coupling (`cloud_volume.js` -> `weather_state.js`)
    const cloudVol = s3d?.cloudOverlay?.volume;
    if (cloudVol && typeof cloudVol.getOverheadCloudFactor === 'function') {
      const factor = cloudVol.getOverheadCloudFactor(cx, cz);
      const az = typeof cloudVol.sampleDenseCloudAzimuth === 'function'
        ? cloudVol.sampleDenseCloudAzimuth(cx, cz)
        : 0;
      setCloudOverheadFactor(factor, az);
    } else {
      // Volumetric clouds disabled (e.g. low/mid presets) -> default overhead cloud factor 1.0
      setCloudOverheadFactor(1.0, 0);
    }

    // 4. Update latitude/longitude & recompute cloud-coupled precipitation state
    updateFromPosition(cx, cz);
    const cc = readWeatherCloudCoupling(this._ccScratch);
    const ws = getWeatherState();

    // 5. Resolve indoor occlusion, wind vector, and scene lighting
    let isIndoor = false;
    try {
      const fallbackIndoor = !!(
        s3d?.skyDome?._lastIsIndoor ||
        handle?.isCurrentCellIndoor?.()
      );
      isIndoor = !!viewerIndoorOr(fallbackIndoor);
    } catch (_) {
      isIndoor = false;
    }

    const kind = enabledByUser ? cc.weather_kind : 'off';
    const intensity = enabledByUser ? cc.precip_intensity : 0;
    const isStormKind = kind === 'storm';
    const isBlizzardKind = kind === 'blizzard';
    const isSnowKind = kind === 'snow' || isBlizzardKind;
    const isRainKind = kind === 'rain' || isStormKind;

    // Physical 3D wind vector from shared VFX_GLOBALS.uWindDir (ground-plane x,z)
    const wd = VFX_GLOBALS?.uWindDir?.value;
    const wxRaw = Number(wd?.x) || 0.7071;
    const wzRaw = Number(wd?.y) || 0.7071;
    const windSpeedScale = isStormKind || isBlizzardKind
      ? 4.6 + 4.2 * intensity
      : (isRainKind || isSnowKind ? 2.2 + 2.4 * intensity : 1.4);
    this._windScratch.x = wxRaw * windSpeedScale;
    this._windScratch.y = 0;
    this._windScratch.z = wzRaw * windSpeedScale;

    const gustStrength = isStormKind || isBlizzardKind
      ? Math.min(1, 0.55 + 0.45 * intensity)
      : Math.min(1, 0.18 + 0.38 * intensity);

    const exposure = this._resolveLightingAndExposure(s3d);
    const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 1080;

    // 6. Tick Lightning FIRST so this frame's flash illuminates clouds, rain, and snow!
    const audioMgr = s3d?.audioManager ?? this.lightning.audioManager;
    this.lightning.tick(stepDt, {
      enabled: enabledByUser && kind !== 'off',
      cameraPos: { x: cx, y: cy, z: cz },
      isIndoor,
      exposure,
      audioManager: audioMgr,
      stormActive: isStormKind,
      stormIntensity: isStormKind ? intensity : 0,
      overheadCloudFactor: cc.overhead_cloud_factor,
      denseCloudAzimuth: cc.dense_cloud_azimuth,
      cloudBaseM: Math.max(360, (ws.lcl_m || 620) - (cc.base_drop_m || 0)),
      groundY: this._meanGroundY,
    });

    setLightningFlashState(
      this.lightning.sceneFlash,
      this.lightning.cloudSheetFlash,
      this.lightning.strikeWorldPos.x,
      this.lightning.strikeWorldPos.y,
      this.lightning.strikeWorldPos.z
    );

    // 7. Tick Multi-Layer Crystalline Snow
    this.snow.tick(stepDt, {
      enabled: enabledByUser && isSnowKind,
      intensity: isSnowKind ? intensity : 0,
      isIndoor,
      cameraPos: { x: cx, y: cy, z: cz },
      wind: this._windScratch,
      gustStrength,
      viewportHeight,
      ambientRgb: this._ambientRgb,
      lightningFlash: this.lightning.sceneFlash,
      exposure,
    });

    // 8. Tick Multi-Layer Rain Streaks & Ground/Water Splashes
    this.rain.tick(stepDt, {
      enabled: enabledByUser && isRainKind,
      intensity: isRainKind ? intensity : 0,
      isIndoor,
      cameraPos: { x: cx, y: cy, z: cz },
      wind: this._windScratch,
      gustStrength,
      rainRgb: this._rainRgb,
      lightningFlash: this.lightning.sceneFlash,
      exposure,
      sampleSurface: this._boundSampleSurface,
    });
  }

  stats() {
    const snowStats = this.snow.stats();
    const rainStats = this.rain.stats();
    const lightningStats = this.lightning.stats();
    return {
      enabled: isWeatherEnabled(this.sessionHandleAccessor()),
      mode: getWeatherMode(),
      preset: this.preset,
      weather: getExtendedWeatherState(),
      biome: { ...this._biomeStats },
      totalDrawCalls: snowStats.drawCalls + rainStats.drawCalls + lightningStats.drawCalls,
      snow: snowStats,
      rain: rainStats,
      lightning: lightningStats,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubWeatherEnabled?.();
    this._unsubWeatherEnabled = null;
    setFxFieldsSnowDelegated(false);
    setLightningFlashState(0, 0, 0, 800, 0);
    this.snow?.dispose();
    this.rain?.dispose();
    this.lightning?.dispose();
    if (typeof window !== 'undefined') {
      if (window.__weatherSystem === this) window.__weatherSystem = null;
    }
  }
}

/**
 * Factory helper for `scene3d/index.js`.
 * @param {object} opts
 * @returns {WeatherSystem}
 */
export function createWeatherSystem(opts = {}) {
  return new WeatherSystem(opts);
}
