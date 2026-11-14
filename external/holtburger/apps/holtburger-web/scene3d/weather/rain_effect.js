// scene3d/weather/rain_effect.js — Item 9: Multi-Layer GPU-Instanced Rain & Splash System.
//
// 2 GPU-instanced draw calls total (zero per-frame CPU particle buffer uploads):
//   1. Falling Rain Streaks & Distant Storm Curtains (`streaksMesh`):
//      - Tier 0 (close crisp specular velocity-stretched raindrops, 13–18 m/s, R=22m)
//      - Tier 1 (mid-range fine motion-tapered rain streaks, bright leading bead, R=36m)
//      - Tier 2 (distant valley storm-curtain mist sheets, R=35..80m)
//      Dynamically tilted in 3D along wind vector via camera-facing cross(viewDir, velDir),
//      lit by sky/sun/moon luminance + strong lightning flash specular boost.
//   2. Ground & Water Splash Ripples / Crown Splashes (`splashesMesh`, ~600 quads):
//      - Samples a lazy-cached 16×16 ground/water height + water-flag uniform grid around
//        camera XZ (updated only when camera moves > 1.5 m, < 0.02 ms CPU), spawning
//        expanding concentric capillary ripple rings on water/wet surfaces and tiny upward
//        splash crowns on solid ground (!isIndoor).

import * as THREE from 'three';

export const RAIN_PRESET_COUNTS = Object.freeze({
  low: Object.freeze({ streaks: 1000, splashes: 140 }),
  mid: Object.freeze({ streaks: 2500, splashes: 320 }),
  high: Object.freeze({ streaks: 4800, splashes: 600 }),
  ultra: Object.freeze({ streaks: 5400, splashes: 640 }),
});

export const SPLASH_GRID_N = 16;
export const SPLASH_GRID_SPAN_M = 36.0;
export const SPLASH_LAZY_MOVE_M = 1.5;

function _seededRng(seed) {
  let s = (seed >>> 0) || 0x243f6a88;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x9e3779b9) >>> 0;
    let t = s ^ (s >>> 13);
    t = Math.imul(t, 0x85ebca6b) >>> 0;
    t ^= t >>> 16;
    return (t >>> 0) / 4294967296;
  };
}

const RAIN_STREAK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSeed;   // xyz = [0..1) seed, w = stratified density rank [0..1)
attribute vec4 aDrop;   // x = tier (0 close, 1 mid, 2 storm-curtain), y = speedScale, z = phase, w = widthScale

uniform float uTime;
uniform float uDensity;
uniform float uIndoorFade;
uniform vec3 uCamPos;
uniform vec3 uWind;         // XZ wind velocity (m/s)
uniform float uGustStrength;
uniform float uShutterSec;  // velocity-streak shutter integration (~0.042s)

varying vec2 vUv;
varying float vAlpha;
varying float vTier;
varying float vFresnel;

void main() {
  vUv = position.xy; // [-0.5 .. 0.5]
  vTier = aDrop.x;

  if (aSeed.w >= uDensity || uIndoorFade <= 0.001) {
    vAlpha = 0.0;
    vFresnel = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float tier = aDrop.x;
  float phase = aDrop.z;
  vec3 relWorld;
  vec3 vel;
  float widthM;
  float lengthM;
  float baseAlpha;

  // Spatial gust wave along wind direction
  float wMag = length(uWind.xz);
  vec2 wDir = wMag > 1e-4 ? (uWind.xz / wMag) : vec2(0.7071, 0.7071);
  float gustWave = 0.82 + (0.25 + 0.35 * uGustStrength) * sin(uTime * 2.1 + phase);
  vec2 gustWind = uWind.xz * gustWave;

  if (tier < 1.5) {
    // Tier 0 (close R=22m, H=28m) & Tier 1 (mid R=36m, H=32m): camera-wrapped toroidal volume
    float radius = tier < 0.5 ? 22.0 : 36.0;
    float heightSpan = tier < 0.5 ? 28.0 : 32.0;
    vec3 box = vec3(radius * 2.0, heightSpan, radius * 2.0);
    float fallSpeed = (tier < 0.5 ? 14.5 : 12.8) + 3.8 * aDrop.y;

    vel = vec3(gustWind.x, -fallSpeed, gustWind.y);
    vec3 simPos = aSeed.xyz * box + vel * uTime;
    vec3 origin = uCamPos - vec3(radius, heightSpan * 0.45, radius);
    relWorld = mod(simPos - origin, box) + origin - uCamPos;

    float distXZ = length(relWorld.xz);
    float radialFade = 1.0 - smoothstep(radius * 0.74, radius * 0.99, distXZ);
    float vertNorm = abs(relWorld.y - heightSpan * 0.05) / (heightSpan * 0.5);
    float vertFade = 1.0 - smoothstep(0.76, 1.0, vertNorm);
    float nearFade = smoothstep(0.55, 1.65, length(relWorld));

    widthM = (tier < 0.5 ? 0.015 : 0.022) * aDrop.w;
    lengthM = clamp(length(vel) * uShutterSec * (tier < 0.5 ? 1.15 : 1.0), 0.48, 1.45);
    baseAlpha = (tier < 0.5 ? 0.72 : 0.54) * radialFade * vertFade * nearFade;
    float minWidthM = length(relWorld) * 0.0021;
    if (widthM > 1e-5 && widthM < minWidthM) {
      baseAlpha *= clamp(widthM / minWidthM, 0.42, 1.0);
      widthM = minWidthM;
    }
  } else {
    // Tier 2: Distant storm-curtain mist sheets in annular ring R = 35..80 m
    float angle = aSeed.x * 6.2831853 + uTime * 0.012;
    float rRing = mix(35.0, 80.0, aSeed.y);
    float hSpan = 44.0;
    float fallSpeed = 9.5 + 3.0 * aDrop.y;
    vel = vec3(gustWind.x * 0.9, -fallSpeed, gustWind.y * 0.9);

    float yWrapped = mod(aSeed.z * hSpan - fallSpeed * uTime, hSpan) - hSpan * 0.38;
    relWorld = vec3(cos(angle) * rRing, yWrapped, sin(angle) * rRing);

    float vertFade = 1.0 - smoothstep(0.65, 1.0, abs(yWrapped) / (hSpan * 0.5));
    float ringFade = smoothstep(33.0, 42.0, rRing) * (1.0 - smoothstep(68.0, 80.0, rRing));
    widthM = 3.2 + 2.4 * aDrop.w;
    lengthM = 15.0 + 8.0 * aDrop.y;
    baseAlpha = 0.075 * vertFade * ringFade * clamp((uDensity - 0.25) / 0.75, 0.0, 1.0);
  }

  // Camera-facing velocity-aligned 3D ribbon basis: right = normalize(cross(viewDir, velDir))
  float dist = length(relWorld);
  vec3 viewDir = dist > 1e-4 ? (relWorld / dist) : vec3(0.0, 0.0, -1.0);
  vec3 velDir = normalize(vel);
  vec3 side = cross(viewDir, velDir);
  float sideLen = length(side);
  side = sideLen > 1e-4 ? (side / sideLen) : vec3(1.0, 0.0, 0.0);

  // Position vertex on the wind-tilted velocity ribbon (vUv.y = -0.5 is leading bottom tip)
  vec3 cornerRel = relWorld + side * (position.x * widthM) - velDir * (position.y * lengthM);
  vec4 mv = vec4(mat3(viewMatrix) * cornerRel, 1.0);

  vFresnel = clamp(1.0 - abs(dot(viewDir, velDir)), 0.15, 1.0);
  vAlpha = baseAlpha * uIndoorFade;
  gl_Position = (vAlpha <= 0.001 || mv.z > -0.15) ? vec4(0.0, 0.0, 2.0, 1.0) : (projectionMatrix * mv);
  #include <logdepthbuf_vertex>
}
`;

const RAIN_STREAK_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uRainColor;        // sky/sun/moon coherent rain tint
uniform float uLightningFlash;  // [0..1] lightning specular surge
uniform float uExposureCal;

varying vec2 vUv;
varying float vAlpha;
varying float vTier;
varying float vFresnel;

void main() {
  #include <logdepthbuf_fragment>
  if (vAlpha <= 0.001) discard;

  float u = vUv.x * 2.0;        // [-1 .. +1] across width
  float v = vUv.y + 0.5;        // [0 = leading bottom bead .. 1 = trailing top tail]

  float a;
  float specBoost = 1.0;
  if (vTier > 1.5) {
    // Soft wide valley downpour curtain sheet
    float horiz = exp(-u * u * 2.6);
    float vert = sin(clamp(v, 0.0, 1.0) * 3.14159265);
    a = horiz * vert * vAlpha;
  } else {
    // Crisp cylindrical droplet profile + bright leading refractive bead + tapered motion tail
    float cyl = exp(-u * u * 5.2);
    float tail = pow(1.0 - clamp(v, 0.0, 1.0), 1.35) * smoothstep(0.0, 0.08, v);
    float bead = exp(-pow((v - 0.10) * 9.5, 2.0)) * 0.55;
    a = cyl * (tail + bead) * vAlpha * (0.75 + 0.45 * vFresnel);
    specBoost = 1.0 + bead * 0.65;
  }

  if (a < 0.003) discard;

  // Rain streaks catch lightning flashes brilliantly!
  vec3 lightningSpec = vec3(0.82, 0.90, 1.0) * (uLightningFlash * (vTier > 1.5 ? 1.35 : 2.65));
  vec3 rgb = (uRainColor * specBoost + lightningSpec) * uExposureCal;
  gl_FragColor = vec4(rgb, clamp(a, 0.0, 0.92));
}
`;

const RAIN_SPLASH_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSplash; // x,y = [0..1) XZ seed, z = phase [0..1), w = stratified rank [0..1)

uniform float uTime;
uniform float uDensity;
uniform float uIndoorFade;
uniform vec3 uCamPos;
uniform float uSplashHgt[${SPLASH_GRID_N * SPLASH_GRID_N}];
uniform float uSplashWater[${SPLASH_GRID_N * SPLASH_GRID_N}];
uniform vec3 uGridOriginStep; // x = originX, y = originZ, z = cellStepM

varying vec2 vUv;
varying float vAge;
varying float vWater;
varying float vAlpha;

void sampleSplashSurface(vec2 worldXZ, out float hgt, out float waterFlag) {
  vec2 g = clamp((worldXZ - uGridOriginStep.xy) / uGridOriginStep.z, vec2(0.0), vec2(${SPLASH_GRID_N - 1}.0 - 1e-3));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  int i00 = i.y * ${SPLASH_GRID_N} + i.x;
  float h00 = uSplashHgt[i00];
  float h10 = uSplashHgt[i00 + 1];
  float h01 = uSplashHgt[i00 + ${SPLASH_GRID_N}];
  float h11 = uSplashHgt[i00 + ${SPLASH_GRID_N} + 1];
  hgt = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);

  float w00 = uSplashWater[i00];
  float w10 = uSplashWater[i00 + 1];
  float w01 = uSplashWater[i00 + ${SPLASH_GRID_N}];
  float w11 = uSplashWater[i00 + ${SPLASH_GRID_N} + 1];
  waterFlag = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
}

void main() {
  vUv = position.xy * 2.0; // [-1 .. +1]
  if (aSplash.w >= uDensity || uIndoorFade <= 0.01) {
    vAlpha = 0.0; vAge = 1.0; vWater = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float span = ${SPLASH_GRID_SPAN_M.toFixed(1)};
  float period = 0.44 + 0.22 * fract(aSplash.z * 7.13);
  float cycle = floor(uTime / period + aSplash.z);
  float age = fract(uTime / period + aSplash.z);
  vAge = age;

  // Jitter XZ per lifecycle so splashes land at fresh spots each cycle
  vec2 jitter = fract(vec2(aSplash.x + cycle * 0.371, aSplash.y + cycle * 0.619));
  vec2 originXZ = uCamPos.xz - vec2(span * 0.5);
  vec2 worldXZ = mod(jitter * span - originXZ, vec2(span)) + originXZ;

  float surfY;
  float waterW;
  sampleSplashSurface(worldXZ, surfY, waterW);
  vWater = waterW;

  vec3 centerRel = vec3(worldXZ.x - uCamPos.x, (surfY + 0.03) - uCamPos.y, worldXZ.y - uCamPos.z);
  float distXZ = length(centerRel.xz);
  float edgeFade = (1.0 - smoothstep(span * 0.36, span * 0.49, distXZ)) * smoothstep(0.8, 2.2, distXZ);

  vec3 cornerRel;
  if (waterW > 0.45) {
    // Horizontal expanding concentric water ripple quad
    float rippleR = mix(0.08, 0.54, age);
    cornerRel = centerRel + vec3(position.x * rippleR * 2.0, 0.0, position.y * rippleR * 2.0);
    vAlpha = (1.0 - age) * (1.0 - age) * edgeFade * uIndoorFade * 0.92;
  } else {
    // Upward micro-crown ground splash billboard
    float crownW = mix(0.06, 0.22, sqrt(age));
    float crownH = sin(age * 3.14159265) * 0.18;
    vec3 viewDir = normalize(vec3(centerRel.x, 0.0, centerRel.z) + vec3(1e-4, 0.0, 0.0));
    vec3 right = vec3(-viewDir.z, 0.0, viewDir.x);
    cornerRel = centerRel
      + right * (position.x * crownW * 2.0)
      + vec3(0.0, (position.y + 0.5) * (0.05 + crownH), 0.0);
    vAlpha = (1.0 - age) * edgeFade * uIndoorFade * 0.78;
  }

  vec4 mv = vec4(mat3(viewMatrix) * cornerRel, 1.0);
  gl_Position = (vAlpha <= 0.002 || mv.z > -0.15) ? vec4(0.0, 0.0, 2.0, 1.0) : (projectionMatrix * mv);
  #include <logdepthbuf_vertex>
}
`;

const RAIN_SPLASH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uRainColor;
uniform float uLightningFlash;
uniform float uExposureCal;

varying vec2 vUv;
varying float vAge;
varying float vWater;
varying float vAlpha;

void main() {
  #include <logdepthbuf_fragment>
  if (vAlpha <= 0.002) discard;

  float a = 0.0;
  if (vWater > 0.45) {
    float r = length(vUv);
    if (r > 1.0) discard;
    // Two concentric expanding capillary rings
    float ring1 = exp(-pow((r - 0.82) * 9.5, 2.0));
    float ring2 = exp(-pow((r - 0.46) * 8.0, 2.0)) * 0.55;
    a = (ring1 + ring2) * vAlpha;
  } else {
    // Upward crown droplets fan
    float x = vUv.x;
    float y = vUv.y * 0.5 + 0.5; // [0..1] bottom to top
    float fan = exp(-pow(abs(x) - (0.25 + 0.45 * y), 2.0) * 14.0);
    float spokes = 0.55 + 0.45 * cos(x * 15.0);
    float rim = (1.0 - smoothstep(0.75, 1.0, y)) * smoothstep(0.0, 0.2, y);
    a = fan * spokes * rim * vAlpha;
  }

  if (a < 0.003) discard;
  vec3 flash = vec3(0.82, 0.90, 1.0) * (uLightningFlash * 1.8);
  gl_FragColor = vec4((uRainColor * 1.12 + flash) * uExposureCal, clamp(a, 0.0, 0.85));
}
`;

export const RAIN_GLSL = Object.freeze({
  streakVertex: RAIN_STREAK_VERT,
  streakFragment: RAIN_STREAK_FRAG,
  splashVertex: RAIN_SPLASH_VERT,
  splashFragment: RAIN_SPLASH_FRAG,
});

export class RainEffect {
  /**
   * @param {object} [opts]
   * @param {THREE.Scene|THREE.Group} [opts.scene]
   * @param {'low'|'mid'|'high'|'ultra'} [opts.preset='high']
   * @param {number} [opts.streakCount]
   * @param {number} [opts.splashCount]
   */
  constructor(opts = {}) {
    this.preset = opts.preset in RAIN_PRESET_COUNTS ? opts.preset : 'high';
    const counts = RAIN_PRESET_COUNTS[this.preset];
    this.maxStreaks = Number.isFinite(opts.streakCount) && opts.streakCount > 0
      ? Math.floor(opts.streakCount)
      : counts.streaks;
    this.maxSplashes = Number.isFinite(opts.splashCount) && opts.splashCount >= 0
      ? Math.floor(opts.splashCount)
      : counts.splashes;

    this._density = 0;
    this._indoorFade = 1;
    this._timeSec = 0;
    this._lastSplashCamX = NaN;
    this._lastSplashCamZ = NaN;
    this._splashGridUpdates = 0;

    this._splashHgt = new Float32Array(SPLASH_GRID_N * SPLASH_GRID_N);
    this._splashWater = new Float32Array(SPLASH_GRID_N * SPLASH_GRID_N);

    const sharedCamPos = { value: new THREE.Vector3() };
    const sharedRainColor = { value: new THREE.Vector3(0.76, 0.84, 0.96) };
    const sharedLightning = { value: 0 };
    const sharedExpCal = { value: 0.90 };
    const sharedTime = { value: 0 };
    const sharedDensity = { value: 0 };
    const sharedIndoor = { value: 1 };

    this.uniforms = {
      uTime: sharedTime,
      uDensity: sharedDensity,
      uIndoorFade: sharedIndoor,
      uCamPos: sharedCamPos,
      uWind: { value: new THREE.Vector3(2.2, 0, 1.4) },
      uGustStrength: { value: 0.35 },
      uShutterSec: { value: 0.042 },
      uRainColor: sharedRainColor,
      uLightningFlash: sharedLightning,
      uExposureCal: sharedExpCal,
      uSplashHgt: { value: this._splashHgt },
      uSplashWater: { value: this._splashWater },
      uGridOriginStep: { value: new THREE.Vector3(0, 0, SPLASH_GRID_SPAN_M / (SPLASH_GRID_N - 1)) },
    };

    this.streakGeometry = this._buildStreakGeometry(this.maxStreaks);
    this.streakMaterial = new THREE.ShaderMaterial({
      name: 'weather-rain-streaks',
      uniforms: this.uniforms,
      vertexShader: RAIN_STREAK_VERT,
      fragmentShader: RAIN_STREAK_FRAG,
      transparent: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      fog: false,
    });
    this.streakMaterial.userData = { __cacheOwned: true, __weatherRain: true };

    this.streaksMesh = new THREE.Mesh(this.streakGeometry, this.streakMaterial);
    this.streaksMesh.name = 'weather-rain-streaks';
    this.streaksMesh.frustumCulled = false;
    this.streaksMesh.matrixAutoUpdate = false;
    this.streaksMesh.renderOrder = 2;
    this.streaksMesh.visible = false;
    this.streaksMesh.userData = { isWeatherRainStreaks: true };

    this.splashGeometry = this._buildSplashGeometry(Math.max(1, this.maxSplashes));
    this.splashMaterial = new THREE.ShaderMaterial({
      name: 'weather-rain-splashes',
      uniforms: this.uniforms,
      vertexShader: RAIN_SPLASH_VERT,
      fragmentShader: RAIN_SPLASH_FRAG,
      transparent: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      fog: false,
    });
    this.splashMaterial.userData = { __cacheOwned: true, __weatherRainSplashes: true };

    this.splashesMesh = new THREE.Mesh(this.splashGeometry, this.splashMaterial);
    this.splashesMesh.name = 'weather-rain-splashes';
    this.splashesMesh.frustumCulled = false;
    this.splashesMesh.matrixAutoUpdate = false;
    this.splashesMesh.renderOrder = 2;
    this.splashesMesh.visible = false;
    this.splashesMesh.userData = { isWeatherRainSplashes: true };

    this.group = new THREE.Group();
    this.group.name = 'weather-rain-group';
    this.group.add(this.streaksMesh, this.splashesMesh);

    if (opts.scene && typeof opts.scene.add === 'function') {
      opts.scene.add(this.group);
    }
  }

  _buildStreakGeometry(count) {
    const rng = _seededRng(0x7f4a7c15);
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
    const drops = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4 + 0] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      seeds[i * 4 + 3] = (i + rng()) / count;

      // Interleaved 3 visual tiers: 45% close crisp (0), 40% mid fine (1), 15% storm curtains (2)
      const rTier = (i % 20) / 20;
      const tier = rTier < 0.45 ? 0 : (rTier < 0.85 ? 1 : 2);
      drops[i * 4 + 0] = tier;
      drops[i * 4 + 1] = rng();
      drops[i * 4 + 2] = rng() * Math.PI * 2;
      drops[i * 4 + 3] = 0.75 + 0.55 * rng();
    }

    geom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geom.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
    geom.instanceCount = count;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return geom;
  }

  _buildSplashGeometry(count) {
    const rng = _seededRng(0x319bc411);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geom.setIndex([0, 1, 2, 0, 2, 3]);

    const splashAttr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      splashAttr[i * 4 + 0] = rng();
      splashAttr[i * 4 + 1] = rng();
      splashAttr[i * 4 + 2] = rng();
      splashAttr[i * 4 + 3] = (i + rng()) / count;
    }
    geom.setAttribute('aSplash', new THREE.InstancedBufferAttribute(splashAttr, 4));
    geom.instanceCount = count;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return geom;
  }

  setPreset(preset) {
    if (!(preset in RAIN_PRESET_COUNTS) || preset === this.preset) return;
    this.preset = preset;
    const counts = RAIN_PRESET_COUNTS[preset];
    this.maxStreaks = counts.streaks;
    this.maxSplashes = counts.splashes;

    const oldS = this.streakGeometry;
    this.streakGeometry = this._buildStreakGeometry(this.maxStreaks);
    this.streaksMesh.geometry = this.streakGeometry;
    oldS?.dispose?.();

    const oldP = this.splashGeometry;
    this.splashGeometry = this._buildSplashGeometry(Math.max(1, this.maxSplashes));
    this.splashesMesh.geometry = this.splashGeometry;
    oldP?.dispose?.();
  }

  /**
   * Lazily refresh the 16×16 ground/water height grid only when camera XZ moves > 1.5 m.
   * @param {number} camX
   * @param {number} camY
   * @param {number} camZ
   * @param {(worldX:number, worldZ:number, out:object)=>void} [sampleSurface]
   */
  updateSplashGridIfNeeded(camX, camY, camZ, sampleSurface, force = false) {
    const moved = Math.hypot(camX - this._lastSplashCamX, camZ - this._lastSplashCamZ);
    if (!force && moved <= SPLASH_LAZY_MOVE_M) return false;

    this._lastSplashCamX = camX;
    this._lastSplashCamZ = camZ;
    this._splashGridUpdates += 1;

    const step = SPLASH_GRID_SPAN_M / (SPLASH_GRID_N - 1);
    const ox = camX - SPLASH_GRID_SPAN_M * 0.5;
    const oz = camZ - SPLASH_GRID_SPAN_M * 0.5;
    this.uniforms.uGridOriginStep.value.set(ox, oz, step);

    const fallbackY = camY - 1.7;
    const scratch = { height: fallbackY, isWater: false, valid: false };
    for (let j = 0; j < SPLASH_GRID_N; j++) {
      const wz = oz + j * step;
      for (let i = 0; i < SPLASH_GRID_N; i++) {
        const wx = ox + i * step;
        const idx = j * SPLASH_GRID_N + i;
        if (typeof sampleSurface === 'function') {
          scratch.valid = false;
          scratch.isWater = false;
          scratch.height = fallbackY;
          sampleSurface(wx, wz, scratch);
          this._splashHgt[idx] = Number.isFinite(scratch.height) ? scratch.height : fallbackY;
          this._splashWater[idx] = scratch.isWater ? 1.0 : 0.0;
        } else {
          this._splashHgt[idx] = fallbackY;
          this._splashWater[idx] = 0.0;
        }
      }
    }
    return true;
  }

  tick(dt, params = {}) {
    const stepDt = Number.isFinite(dt) && dt >= 0 ? Math.min(dt, 0.25) : 0.016;
    this._timeSec = (this._timeSec + stepDt) % 4096;
    this.uniforms.uTime.value = this._timeSec;

    const target = params.enabled === false
      ? 0
      : Math.min(1, Math.max(0, Number(params.intensity) || 0));

    if (params.immediate) {
      this._density = target;
    } else {
      const rate = target > this._density ? 2.2 : 2.8;
      const k = 1 - Math.exp(-stepDt * rate);
      this._density += (target - this._density) * k;
      if (this._density < 0.002 && target === 0) this._density = 0;
    }

    const indoorTarget = params.isIndoor ? 0 : 1;
    if (params.immediate) {
      this._indoorFade = indoorTarget;
    } else {
      const fk = 1 - Math.exp(-stepDt / 0.12);
      this._indoorFade += (indoorTarget - this._indoorFade) * fk;
      if (this._indoorFade < 0.002 && indoorTarget === 0) this._indoorFade = 0;
      if (this._indoorFade > 0.998 && indoorTarget === 1) this._indoorFade = 1;
    }

    const cx = params.cameraPos?.x || 0;
    const cy = params.cameraPos?.y || 0;
    const cz = params.cameraPos?.z || 0;
    this.uniforms.uCamPos.value.set(cx, cy, cz);

    if (this._density > 0.002 && !params.isIndoor) {
      this.updateSplashGridIfNeeded(cx, cy, cz, params.sampleSurface);
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
    if (params.rainRgb) {
      this.uniforms.uRainColor.value.set(params.rainRgb[0], params.rainRgb[1], params.rainRgb[2]);
    }
    this.uniforms.uLightningFlash.value = Number.isFinite(params.lightningFlash)
      ? Math.max(0, params.lightningFlash)
      : 0;

    const exp = Number(params.exposure);
    this.uniforms.uExposureCal.value = Number.isFinite(exp) && exp > 1
      ? 0.86 / Math.min(20, exp)
      : 0.86;

    this.uniforms.uDensity.value = this._density;
    this.uniforms.uIndoorFade.value = this._indoorFade;

    const active = this._density > 0.002 && this._indoorFade > 0.002;
    this.streaksMesh.visible = active;
    this.splashesMesh.visible = active && !params.isIndoor && this.maxSplashes > 0;
  }

  stats() {
    const drawCalls = (this.streaksMesh.visible ? 1 : 0) + (this.splashesMesh.visible ? 1 : 0);
    return {
      preset: this.preset,
      maxStreaks: this.maxStreaks,
      maxSplashes: this.maxSplashes,
      drawCalls,
      streaksVisible: this.streaksMesh.visible,
      splashesVisible: this.splashesMesh.visible,
      density: this._density,
      indoorFade: this._indoorFade,
      splashGridUpdates: this._splashGridUpdates,
    };
  }

  dispose() {
    if (this.group?.parent) this.group.parent.remove(this.group);
    this.streakGeometry?.dispose?.();
    this.streakMaterial?.dispose?.();
    this.splashGeometry?.dispose?.();
    this.splashMaterial?.dispose?.();
  }
}
