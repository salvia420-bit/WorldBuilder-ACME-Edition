// scene3d/weather/snow_effect.js — Item 8: Multi-Layer GPU-Instanced Crystalline Falling Snow.
//
// Replaces the basic 520-dot Gaussian fx_fields snow with a rich, 1-draw-call
// InstancedBufferGeometry + ShaderMaterial system (zero per-frame CPU buffer uploads;
// 100% vertex-shader camera-wrapped toroidal simulation in eye-relative space):
//   - Near (R=14m), Mid (R=32m), and Far (R=65m) depth layers in one instanced mesh
//   - Procedural 6-fold symmetric dendrite snowflake SDF + 3D tumble foreshortening & glint
//     for near flakes, feathered snow crystals for mid flakes, and soft lens bokeh / snow
//     mist for very close (< 1.2m) and distant far-layer flakes
//   - Coherent 3D turbulent wind drift, spatial storm gust corridors, and helical flutter
//   - Scene-coherent sun/moon ambient + warm night lantern glow + lightning flash boost
//   - Smooth 0.35s doorway fade when entering/exiting indoor EnvCells

import * as THREE from 'three';
import { TERRAIN_FX_LIGHT_UNIFORMS } from '../vfx/fx_lights.js';

export const SNOW_PRESET_COUNTS = Object.freeze({
  low: 800,
  mid: 1800,
  high: 3800,
  ultra: 4500,
});

export const SNOW_LAYER_RADII_M = Object.freeze({
  near: 14.0,
  mid: 32.0,
  far: 65.0,
});

export const SNOW_INDOOR_FADE_SEC = 0.35;

function _seededRng(seed) {
  let s = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x9e3779b9) >>> 0;
    let t = s ^ (s >>> 13);
    t = Math.imul(t, 0x85ebca6b) >>> 0;
    t ^= t >>> 16;
    return (t >>> 0) / 4294967296;
  };
}

const SNOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSeed;       // xyz = [0..1) toroidal seed, w = stratified density rank [0..1)
attribute vec4 aFlake;      // x = layer (0 near, 1 mid, 2 far), y = sizeScale, z = swayPhase, w = spinRate

uniform float uTime;
uniform float uDensity;     // [0..1] active snowfall intensity
uniform float uIndoorFade;  // [0..1] smooth 0.35s doorway occlusion factor
uniform vec3 uCamPos;       // Three.js Y-up camera world position
uniform vec3 uWind;         // XZ wind drift (m/s), Y updraft/turbulence
uniform float uGustStrength;// [0..1] storm/blizzard gustiness
uniform float uViewH;       // viewport height in pixels (sub-pixel clamp)
uniform vec4 uFxLightPos[8];
uniform vec4 uFxLightCol[8];

varying vec2 vUv;
varying float vAlpha;
varying float vLayer;
varying float vBokeh;
varying float vGlint;
varying vec3 vLanternRgb;

void main() {
  vUv = position.xy * 2.0;
  vLayer = aFlake.x;

  float activeCutoff = clamp(uDensity, 0.0, 1.0);
  if (aSeed.w >= activeCutoff || uIndoorFade <= 0.001) {
    vAlpha = 0.0;
    vBokeh = 0.0;
    vGlint = 0.0;
    vLanternRgb = vec3(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Layer dimensions: Near (R=14m, H=16m), Mid (R=32m, H=26m), Far (R=65m, H=40m)
  float radius = aFlake.x < 0.5 ? 14.0 : (aFlake.x < 1.5 ? 32.0 : 65.0);
  float heightSpan = aFlake.x < 0.5 ? 16.0 : (aFlake.x < 1.5 ? 26.0 : 40.0);
  float baseSize = aFlake.x < 0.5 ? 0.056 : (aFlake.x < 1.5 ? 0.095 : 0.185);
  float size = baseSize * aFlake.y;

  vec3 box = vec3(radius * 2.0, heightSpan, radius * 2.0);
  float phase = aFlake.z;
  float spin = aFlake.w;

  // Terminal fall speed scales with flake size & blizzard gustiness (0.85 .. 2.25 m/s)
  float fallSpeed = (0.88 + 0.72 * aFlake.y) * (1.0 + 0.32 * uGustStrength);

  // Coherent spatial wind + gust corridor wave
  float wMag = length(uWind.xz);
  vec2 wDir = wMag > 1e-4 ? (uWind.xz / wMag) : vec2(0.7071, 0.7071);
  vec2 wPerp = vec2(-wDir.y, wDir.x);

  vec3 baseAnchor = aSeed.xyz * box;
  float corridorPhase = dot(baseAnchor.xz, wDir) * 0.075 - uTime * (1.25 + 0.85 * uGustStrength);
  float crossPhase = dot(baseAnchor.xz, wPerp) * 0.11 - uTime * 0.85;
  float gustWave = 0.78 + (0.28 + 0.34 * uGustStrength) * sin(corridorPhase)
                        + 0.16 * uGustStrength * cos(crossPhase + phase);

  // Individual 3D helical flutter + cross-wind eddy swirl
  float flutterFreq = 1.35 + 0.65 * fract(phase * 0.37);
  float flutterAmp = (0.24 + 0.22 * aFlake.y) * (1.0 + 0.55 * uGustStrength);
  vec3 flutter = vec3(
    sin(uTime * flutterFreq + phase) * flutterAmp + wPerp.x * sin(crossPhase) * 0.45 * uGustStrength,
    sin(uTime * 0.92 + phase * 1.7) * 0.18 * uGustStrength,
    cos(uTime * flutterFreq * 0.86 + phase * 1.13) * flutterAmp + wPerp.y * sin(crossPhase) * 0.45 * uGustStrength
  );

  vec3 simPos = baseAnchor + vec3(
    uWind.x * uTime * gustWave,
    -fallSpeed * uTime,
    uWind.z * uTime * gustWave
  ) + flutter;

  // Camera-centred toroidal wrap in eye-relative world offsets (immune to large-coord fp32 jitter)
  vec3 boxOrigin = uCamPos - vec3(radius, heightSpan * 0.42, radius);
  vec3 relWorld = mod(simPos - boxOrigin, box) + boxOrigin - uCamPos;
  vec3 worldPos = uCamPos + relWorld;

  float distXZ = length(relWorld.xz);
  float dist3D = length(relWorld);

  // Smooth toroidal boundary fade + close-lens soft entry
  float radialFade = 1.0 - smoothstep(radius * 0.72, radius * 0.99, distXZ);
  float vertNorm = abs(relWorld.y - heightSpan * 0.08) / (heightSpan * 0.5);
  float vertFade = 1.0 - smoothstep(0.74, 1.0, vertNorm);
  float closeFade = smoothstep(0.22, 0.75, dist3D);

  // Depth-of-field bokeh factor: close lens (< 1.2m) OR distant atmospheric veil layer
  float closeBokeh = 1.0 - smoothstep(0.45, 1.25, dist3D);
  float farBokeh = aFlake.x > 1.5 ? 1.0 : (aFlake.x > 0.5 ? 0.32 : 0.0);
  vBokeh = clamp(max(closeBokeh, farBokeh), 0.0, 1.0);
  if (closeBokeh > 0.01) {
    size *= (1.0 + closeBokeh * 0.85);
  }

  // Warm night point/lantern light sampling (up to 8 nearest scene pool lights)
  vec3 lantern = vec3(0.0);
  if (aFlake.x < 1.5) {
    for (int i = 0; i < 8; i++) {
      vec4 lp = uFxLightPos[i];
      if (lp.w <= 0.0) continue;
      float d = length(worldPos - lp.xyz) / lp.w;
      if (d < 1.0) {
        float att = (1.0 - d) * (1.0 - d);
        lantern += uFxLightCol[i].rgb * (att * 0.028);
      }
    }
  }
  vLanternRgb = min(lantern, vec3(1.35));

  // Transform eye-relative offset by view rotation only (exact fp32 precision anywhere in Dereth)
  vec4 mv = vec4(mat3(viewMatrix) * relWorld, 1.0);
  if (mv.z > -0.15) {
    vAlpha = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float alpha = radialFade * vertFade * closeFade * uIndoorFade;
  // Sub-pixel clamp to prevent distant crystal sparkle aliasing
  float projRadiusPx = 0.25 * size * projectionMatrix[1][1] / max(-mv.z, 0.1) * uViewH;
  if (projRadiusPx > 1e-5 && projRadiusPx < 1.35) {
    float boost = 1.35 / projRadiusPx;
    size *= boost;
    alpha /= (boost * boost);
  }

  // 3D tumble rotation & foreshortening + crystal facet glint
  float rotAngle = uTime * spin + phase;
  float tilt = 0.46 + 0.54 * abs(cos(uTime * (spin * 0.83) + phase * 1.4));
  vGlint = (1.0 - vBokeh) * pow(max(0.0, sin(uTime * 2.8 + phase * 3.7)), 10.0);

  float ca = cos(rotAngle);
  float sa = sin(rotAngle);
  vec2 localCorner = position.xy;
  localCorner.y *= mix(tilt, 1.0, vBokeh);
  vec2 rotated = vec2(
    ca * localCorner.x - sa * localCorner.y,
    sa * localCorner.x + ca * localCorner.y
  );

  mv.xy += rotated * size;
  vAlpha = alpha * (aFlake.x > 1.5 ? 0.52 : (aFlake.x > 0.5 ? 0.78 : 0.94));
  gl_Position = vAlpha <= 0.002 ? vec4(0.0, 0.0, 2.0, 1.0) : (projectionMatrix * mv);
  #include <logdepthbuf_vertex>
}
`;

const SNOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSnowAmbient;      // sun/sky/moon scene-coherent snow luminance
uniform float uLightningFlash;  // [0..1] lightning strike boost
uniform float uExposureCal;     // pre-exposure HDR calibration scalar

varying vec2 vUv;
varying float vAlpha;
varying float vLayer;
varying float vBokeh;
varying float vGlint;
varying vec3 vLanternRgb;

// Procedural 6-fold crystalline dendrite snowflake SDF
float snowCrystalMask(vec2 uv) {
  float r = length(uv);
  if (r > 1.0) return 0.0;
  float angle = atan(uv.y, uv.x);
  // Fold into 30-degree sector (6-fold rotational + mirror symmetry)
  float sector = abs(mod(angle + 3.14159265, 1.04719755) - 0.52359878);
  vec2 p = vec2(cos(sector), sin(sector)) * r;

  // Main crystal spine along p.x + hexagonal centre plate
  float spine = 1.0 - smoothstep(0.035, 0.115, p.y);
  spine *= 1.0 - smoothstep(0.78, 0.98, r);
  float hexCore = 1.0 - smoothstep(0.18, 0.34, p.x + p.y * 0.57735);

  // Two tiers of 60-degree dendrite side-branches along each arm
  float bCoord1 = abs(p.x - 0.38 - p.y * 0.58);
  float branch1 = (1.0 - smoothstep(0.025, 0.085, bCoord1)) * step(p.y, 0.24) * step(0.20, p.x);

  float bCoord2 = abs(p.x - 0.62 - p.y * 0.58);
  float branch2 = (1.0 - smoothstep(0.022, 0.075, bCoord2)) * step(p.y, 0.18) * step(0.42, p.x);

  float softHalo = exp(-r * r * 4.2) * 0.42;
  return clamp(max(max(spine, hexCore), max(branch1, branch2) * 0.88) + softHalo, 0.0, 1.0);
}

void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 || vAlpha <= 0.002) discard;

  float r = sqrt(r2);
  // Soft bokeh disc (creamy centre + gentle optical rim falloff)
  float bokehMask = (1.0 - smoothstep(0.35, 1.0, r)) * (0.72 + 0.28 * smoothstep(0.35, 0.72, r));
  // Feathered mid-range crystal vs crisp near dendrite crystal
  float crystal = vLayer < 1.5 ? snowCrystalMask(vUv) : bokehMask;
  float feathered = mix(crystal, exp(-r2 * 3.4), clamp(vLayer * 0.42, 0.0, 0.75));
  float shapeAlpha = mix(feathered, bokehMask, vBokeh);

  float a = shapeAlpha * vAlpha;
  if (a < 0.004) discard;

  vec3 lightningTint = vec3(0.80, 0.89, 1.0) * (uLightningFlash * 1.85);
  vec3 glintRgb = vec3(0.95, 0.98, 1.0) * (vGlint * 0.45);
  vec3 litColor = (uSnowAmbient + vLanternRgb + lightningTint + glintRgb) * uExposureCal;

  gl_FragColor = vec4(litColor, clamp(a, 0.0, 0.96));
}
`;

export const SNOW_GLSL = Object.freeze({
  vertex: SNOW_VERT,
  fragment: SNOW_FRAG,
});

export class SnowEffect {
  /**
   * @param {object} [opts]
   * @param {THREE.Scene|THREE.Group} [opts.scene]
   * @param {'low'|'mid'|'high'|'ultra'} [opts.preset='high']
   * @param {number} [opts.count]
   * @param {number} [opts.seed=0x510e527f]
   */
  constructor(opts = {}) {
    this.preset = opts.preset in SNOW_PRESET_COUNTS ? opts.preset : 'high';
    this.maxInstances = Number.isFinite(opts.count) && opts.count > 0
      ? Math.floor(opts.count)
      : SNOW_PRESET_COUNTS[this.preset];
    this._seed = opts.seed ?? 0x510e527f;

    this._density = 0;
    this._targetDensity = 0;
    this._indoorFade = 1;
    this._timeSec = 0;

    this.uniforms = {
      uTime: { value: 0 },
      uDensity: { value: 0 },
      uIndoorFade: { value: 1 },
      uCamPos: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector3(1.2, 0, 0.8) },
      uGustStrength: { value: 0.2 },
      uViewH: { value: 1080 },
      uSnowAmbient: { value: new THREE.Vector3(0.84, 0.88, 0.95) },
      uLightningFlash: { value: 0 },
      uExposureCal: { value: 0.52 },
      uFxLightPos: TERRAIN_FX_LIGHT_UNIFORMS.uFxLightPos,
      uFxLightCol: TERRAIN_FX_LIGHT_UNIFORMS.uFxLightCol,
    };

    this.geometry = this._buildGeometry(this.maxInstances);
    this.material = new THREE.ShaderMaterial({
      name: 'weather-snow-crystalline',
      uniforms: this.uniforms,
      vertexShader: SNOW_VERT,
      fragmentShader: SNOW_FRAG,
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      fog: false,
    });
    this.material.userData = { __cacheOwned: true, __weatherSnow: true };

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'weather-snow';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.userData = { isWeatherSnow: true };

    if (opts.scene && typeof opts.scene.add === 'function') {
      opts.scene.add(this.mesh);
    }
  }

  _buildGeometry(count) {
    const rng = _seededRng(this._seed);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geom.setIndex([0, 1, 2, 0, 2, 3]);

    const seeds = new Float32Array(count * 4);
    const flakes = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4 + 0] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      // Stratified rank [0..1) so near, mid, and far layers scale proportionally at any intensity
      seeds[i * 4 + 3] = (i + rng()) / count;

      // Interleaved layer assignment: ~38% near (0), ~38% mid (1), ~24% far (2)
      const rLayer = (i % 25) / 25;
      const layer = rLayer < 0.38 ? 0 : (rLayer < 0.76 ? 1 : 2);
      flakes[i * 4 + 0] = layer;
      flakes[i * 4 + 1] = 0.70 + 0.75 * rng();
      flakes[i * 4 + 2] = rng() * Math.PI * 2;
      flakes[i * 4 + 3] = (rng() < 0.5 ? -1 : 1) * (0.9 + 1.8 * rng());
    }

    geom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geom.setAttribute('aFlake', new THREE.InstancedBufferAttribute(flakes, 4));
    geom.instanceCount = count;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return geom;
  }

  setPreset(preset) {
    if (!(preset in SNOW_PRESET_COUNTS) || preset === this.preset) return;
    this.preset = preset;
    this.maxInstances = SNOW_PRESET_COUNTS[preset];
    const oldGeom = this.geometry;
    this.geometry = this._buildGeometry(this.maxInstances);
    this.mesh.geometry = this.geometry;
    oldGeom?.dispose?.();
  }

  /**
   * Advance snowfall simulation uniforms (zero CPU buffer uploads).
   * @param {number} dt
   * @param {object} params
   */
  tick(dt, params = {}) {
    const stepDt = Number.isFinite(dt) && dt >= 0 ? Math.min(dt, 0.25) : 0.016;
    this._timeSec = (this._timeSec + stepDt) % 4096;
    this.uniforms.uTime.value = this._timeSec;

    const target = params.enabled === false
      ? 0
      : Math.min(1, Math.max(0, Number(params.intensity) || 0));
    this._targetDensity = target;

    if (params.immediate) {
      this._density = target;
    } else {
      const rate = target > this._density ? 1.8 : 2.6;
      const k = 1 - Math.exp(-stepDt * rate);
      this._density += (target - this._density) * k;
      if (this._density < 0.002 && target === 0) this._density = 0;
    }

    // Smooth ~0.35s doorway fade when entering/exiting indoor cells
    const indoorTarget = params.isIndoor ? 0 : 1;
    if (params.immediate) {
      this._indoorFade = indoorTarget;
    } else {
      const fadeStep = stepDt / (SNOW_INDOOR_FADE_SEC * 0.35);
      const fk = 1 - Math.exp(-Math.max(0, fadeStep));
      this._indoorFade += (indoorTarget - this._indoorFade) * fk;
      if (this._indoorFade < 0.002 && indoorTarget === 0) this._indoorFade = 0;
      if (this._indoorFade > 0.998 && indoorTarget === 1) this._indoorFade = 1;
    }

    if (params.cameraPos) {
      this.uniforms.uCamPos.value.set(
        params.cameraPos.x || 0,
        params.cameraPos.y || 0,
        params.cameraPos.z || 0
      );
    }
    if (params.wind) {
      this.uniforms.uWind.value.set(
        Number(params.wind.x) || 0,
        Number(params.wind.y) || 0,
        Number(params.wind.z) || 0
      );
    }
    if (Number.isFinite(params.gustStrength)) {
      this.uniforms.uGustStrength.value = Math.min(1, Math.max(0, params.gustStrength));
    }
    if (Number.isFinite(params.viewportHeight) && params.viewportHeight > 0) {
      this.uniforms.uViewH.value = params.viewportHeight;
    }
    if (params.ambientRgb) {
      this.uniforms.uSnowAmbient.value.set(
        params.ambientRgb[0],
        params.ambientRgb[1],
        params.ambientRgb[2]
      );
    }
    this.uniforms.uLightningFlash.value = Number.isFinite(params.lightningFlash)
      ? Math.max(0, params.lightningFlash)
      : 0;

    const exp = Number(params.exposure);
    this.uniforms.uExposureCal.value = Number.isFinite(exp) && exp > 1
      ? 0.78 / Math.min(20, exp)
      : 0.78;

    this.uniforms.uDensity.value = this._density;
    this.uniforms.uIndoorFade.value = this._indoorFade;
    this.mesh.visible = this._density > 0.002 && this._indoorFade > 0.002;
  }

  stats() {
    return {
      preset: this.preset,
      maxInstances: this.maxInstances,
      drawCalls: this.mesh.visible ? 1 : 0,
      visible: this.mesh.visible,
      density: this._density,
      indoorFade: this._indoorFade,
    };
  }

  dispose() {
    if (this.mesh?.parent) this.mesh.parent.remove(this.mesh);
    this.geometry?.dispose?.();
    this.material?.dispose?.();
  }
}
