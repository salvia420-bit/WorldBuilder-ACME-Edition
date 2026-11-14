// scene3d/weather/lightning_effect.js — Item 10: Procedural 3D Forked Lightning,
// Volumetric Cloud-Sheet Illumination, Directional Strike Light & Delayed Thunder.
//
// Regains and substantially upgrades Asheron's Call storm lightning (historical
// thunder Wave DID `0x0A000045`, `343 m/s` speed-of-sound acoustic delay, 3-pulse
// `[0, 70, 160] ms` return-stroke flicker):
//   - Procedural 3D midpoint-displaced main trunk + 3–6 forked secondary branches
//     descending from cloud base (`cloudBaseM`) at `distance = 250..1800 m` (plus
//     horizontal spider/sheet bolts inside storm clouds).
//   - Pre-allocated single-draw-call camera-facing 3D ribbon BufferGeometry with
//     searing white-hot plasma core + soft electric blue-violet corona halo,
//     log-depth aware (`depthTest: true, depthWrite: true` with alpha discard)
//     so bolts occlude naturally behind nearer hills/trees/buildings while writing
//     foreground depth ahead of post-pass volumetric clouds (> 1200 m).
//   - Exposes `cloudSheetFlash` [0..1] + `strikeWorldPos` to `weather_state.js` ->
//     `cloud_storm_look.js` / `cloud_volume.js` / `cloud_night.js` so volumetric
//     storm clouds glow internally from the strike's 3D cell.
//   - Drives a 3D azimuth-aimed `THREE.DirectionalLight(0xdceaff)` + sky-scatter
//     `THREE.HemisphereLight` with multi-pulse return-stroke flicker, plus
//     deterministic `distance / 343 m/s` delayed thunder audio (`0x0A000045`).

import * as THREE from 'three';

export const DEFAULT_THUNDER_DID = 0x0a000045;
export const SPEED_OF_SOUND_MPS = 343.0;
export const STRIKE_PULSE_OFFSETS_MS = Object.freeze([0, 70, 160]);
export const BOLT_MIN_DIST_M = 250.0;
export const BOLT_MAX_DIST_M = 1800.0;
const MAX_BOLT_SEGMENTS = 192;

function _seededRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x9e3779b9) >>> 0;
    let t = s ^ (s >>> 13);
    t = Math.imul(t, 0x85ebca6b) >>> 0;
    t ^= t >>> 16;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Evaluate realistic 3-pulse return-stroke lightning envelope at `elapsedMs`.
 * Pulses peak near `[0, 70, 160] ms` with fast rise (~8 ms) and exponential tail.
 * Returns `{ boltFlash, sceneFlash, cloudSheetFlash, leaderProgress }`.
 */
export function evaluateStrikeEnvelope(elapsedMs, isIntraCloud = false) {
  if (!(elapsedMs >= 0) || elapsedMs > 720) {
    return { boltFlash: 0, sceneFlash: 0, cloudSheetFlash: 0, leaderProgress: 1 };
  }

  const pulseWeights = isIntraCloud ? [0.72, 0.95, 0.58] : [1.0, 0.68, 0.86];
  const pulseDecaysMs = isIntraCloud ? [62, 78, 95] : [42, 38, 64];

  let bolt = 0;
  let cloud = 0;
  for (let i = 0; i < STRIKE_PULSE_OFFSETS_MS.length; i++) {
    const dt = elapsedMs - STRIKE_PULSE_OFFSETS_MS[i];
    if (dt < 0) continue;
    const rise = Math.min(1, dt / 7.5);
    const fast = rise * Math.exp(-dt / pulseDecaysMs[i]) * pulseWeights[i];
    const slowCloud = rise * Math.exp(-dt / (pulseDecaysMs[i] * 1.85)) * pulseWeights[i];
    bolt = Math.max(bolt, fast);
    cloud = Math.max(cloud, slowCloud);
  }

  const leaderProgress = Math.min(1, Math.max(0.08, elapsedMs / 32.0));
  const boltFlash = isIntraCloud ? bolt * 0.55 : bolt;
  const sceneFlash = isIntraCloud ? bolt * 0.52 : bolt;
  const cloudSheetFlash = Math.min(1, cloud * (isIntraCloud ? 1.0 : 0.92));
  return { boltFlash, sceneFlash, cloudSheetFlash, leaderProgress };
}

function _subdivideChain3D(p0, p1, subdivisions, jitterM, rng, progress0, progress1, width0, width1, intensity, branchId, outSegments) {
  let pts = [
    { x: p0.x, y: p0.y, z: p0.z },
    { x: p1.x, y: p1.y, z: p1.z },
  ];
  let disp = jitterM;
  for (let level = 0; level < subdivisions; level++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mx = (a.x + b.x) * 0.5 + (rng() - 0.5) * 2.0 * disp;
      const my = (a.y + b.y) * 0.5 + (rng() - 0.5) * 0.45 * disp;
      const mz = (a.z + b.z) * 0.5 + (rng() - 0.5) * 2.0 * disp;
      next.push({ x: mx, y: my, z: mz }, b);
    }
    pts = next;
    disp *= 0.54;
  }

  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    if (outSegments.length >= MAX_BOLT_SEGMENTS) break;
    const t0 = i / n;
    const t1 = (i + 1) / n;
    outSegments.push({
      ax: pts[i].x,
      ay: pts[i].y,
      az: pts[i].z,
      bx: pts[i + 1].x,
      by: pts[i + 1].y,
      bz: pts[i + 1].z,
      p0: progress0 + (progress1 - progress0) * t0,
      p1: progress0 + (progress1 - progress0) * t1,
      w0: width0 + (width1 - width0) * t0,
      w1: width0 + (width1 - width0) * t1,
      intensity,
      branchId,
    });
  }
  return pts;
}

/**
 * Generate procedural 3D forked lightning segments (jagged main trunk + 3–6 forked
 * secondary branches + optional tertiary twigs).
 */
export function buildForkedBoltSegments(opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : _seededRng(opts.seed ?? 0x517cc1b7);
  const start = opts.start || { x: 0, y: 650, z: -600 };
  const end = opts.end || { x: 20, y: 0, z: -580 };
  const isIntraCloud = !!opts.intraCloud;
  const branchCount = Math.max(3, Math.min(6, opts.branchCount ?? (3 + Math.floor(rng() * 4))));

  const segments = [];
  const spanM = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  const trunkJitter = Math.max(18, spanM * (isIntraCloud ? 0.16 : 0.12));
  const trunkWidth0 = isIntraCloud ? 16.0 : 22.0;
  const trunkWidth1 = isIntraCloud ? 9.0 : 14.0;

  // 5 subdivisions -> 32 jagged trunk segments
  const trunkPts = _subdivideChain3D(
    start,
    end,
    5,
    trunkJitter,
    rng,
    0.0,
    1.0,
    trunkWidth0,
    trunkWidth1,
    1.0,
    0,
    segments
  );

  // Spawn 3–6 forked secondary branches along upper/mid trunk
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;

  for (let b = 0; b < branchCount; b++) {
    if (segments.length >= MAX_BOLT_SEGMENTS - 8) break;
    // Stratified split fraction [0.14 .. 0.78] so forks spread naturally down the bolt
    const frac = 0.14 + ((b + 0.18 + 0.64 * rng()) / branchCount) * 0.64;
    const idx = Math.min(trunkPts.length - 2, Math.max(1, Math.floor(frac * (trunkPts.length - 1))));
    const origin = trunkPts[idx];

    const sideSign = (b % 2 === 0 ? 1 : -1) * (rng() < 0.18 ? -1 : 1);
    const yawAngle = sideSign * (0.38 + 0.46 * rng()); // ~22°..48°
    const branchLenFrac = 0.24 + 0.24 * rng();
    const cosA = Math.cos(yawAngle);
    const sinA = Math.sin(yawAngle);

    // Rotate horizontal offset + splay outward from trunk axis
    const horizSpan = Math.max(85, spanM * branchLenFrac * 0.68);
    const baseAngle = Math.atan2(dz, dx) + yawAngle;
    const bx = origin.x + Math.cos(baseAngle) * horizSpan * (0.65 + 0.6 * rng());
    const bz = origin.z + Math.sin(baseAngle) * horizSpan * (0.65 + 0.6 * rng());
    const by = isIntraCloud
      ? origin.y + (rng() - 0.55) * horizSpan * 0.45
      : origin.y + dy * branchLenFrac * (0.72 + 0.35 * rng());

    const bEnd = { x: bx + (cosA - sinA) * 4.0, y: by, z: bz };
    const bPts = _subdivideChain3D(
      origin,
      bEnd,
      3,
      trunkJitter * 0.42,
      rng,
      frac,
      Math.min(1.0, frac + branchLenFrac * 0.85),
      trunkWidth0 * 0.52,
      trunkWidth1 * 0.22,
      0.58 + 0.24 * rng(),
      b + 1,
      segments
    );

    // Occasional fine tertiary twig off major branches
    if (b < 2 && bPts.length >= 5 && segments.length < MAX_BOLT_SEGMENTS - 5) {
      const mid = bPts[Math.floor(bPts.length * 0.5)];
      const twigAngle = baseAngle + sideSign * (0.35 + 0.35 * rng());
      const twigLen = horizSpan * 0.42;
      const tEnd = {
        x: mid.x + Math.cos(twigAngle) * twigLen,
        y: mid.y + (isIntraCloud ? (rng() - 0.5) * 30 : dy * branchLenFrac * 0.32),
        z: mid.z + Math.sin(twigAngle) * twigLen,
      };
      _subdivideChain3D(
        mid,
        tEnd,
        2,
        trunkJitter * 0.22,
        rng,
        Math.min(0.95, frac + branchLenFrac * 0.4),
        Math.min(1.0, frac + branchLenFrac),
        trunkWidth0 * 0.28,
        trunkWidth1 * 0.12,
        0.42,
        b + 1,
        segments
      );
    }
  }

  return {
    segments,
    branchCount,
    trunkSegmentCount: trunkPts.length - 1,
  };
}

const BOLT_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aSegA;      // world start of segment
attribute vec3 aSegB;      // world end of segment
attribute vec4 aRibbon;    // x = side [-1,+1], y = endSelect [0,1], z = halfWidthM, w = leaderProgressPos [0..1]
attribute float aIntensity;

uniform vec3 uCamPos;

varying vec2 vRibbonUv;
varying float vIntensity;
varying float vProgressPos;

void main() {
  vRibbonUv = vec2(aRibbon.x, aRibbon.y);
  vIntensity = aIntensity;
  vProgressPos = aRibbon.w;

  if (aIntensity <= 0.001 || aRibbon.z <= 0.001) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec3 relA = aSegA - uCamPos;
  vec3 relB = aSegB - uCamPos;
  vec3 viewA = mat3(viewMatrix) * relA;
  vec3 viewB = mat3(viewMatrix) * relB;

  vec3 viewPos = mix(viewA, viewB, aRibbon.y);
  vec3 segDir = viewB - viewA;
  float segLen = length(segDir);
  segDir = segLen > 1e-4 ? (segDir / segLen) : vec3(0.0, -1.0, 0.0);

  vec3 viewDir = normalize(viewPos);
  vec3 side = cross(viewDir, segDir);
  float sideLen = length(side);
  side = sideLen > 1e-4 ? (side / sideLen) : vec3(1.0, 0.0, 0.0);

  // Sub-pixel / screen-space minimum ribbon half-width so distant forked bolts stay razor-sharp and bold
  float halfW = max(aRibbon.z * 0.52, length(viewPos) * 0.0038);
  vec3 capExtend = segDir * ((aRibbon.y - 0.5) * halfW * 0.14);
  vec3 mvPos = viewPos + side * (aRibbon.x * halfW) + capExtend;

  gl_Position = projectionMatrix * vec4(mvPos, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const BOLT_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform float uBoltFlash;
uniform float uLeaderProgress;
uniform float uExposureCal;

varying vec2 vRibbonUv;
varying float vIntensity;
varying float vProgressPos;

void main() {
  #include <logdepthbuf_fragment>

  // Stepped-leader downward propagation gate + smooth emergence out of storm cloud base
  float leaderMask = 1.0 - smoothstep(uLeaderProgress - 0.06, uLeaderProgress + 0.04, vProgressPos);
  float cloudEmerge = smoothstep(0.0, 0.09, vProgressPos);
  float d = abs(vRibbonUv.x);

  // Razor-sharp white-hot plasma channel + electric blue-violet corona
  float core = exp(-d * d * 42.0);
  float innerGlow = exp(-d * d * 12.0);

  vec3 coreRgb = vec3(1.0, 0.99, 1.0);
  vec3 innerRgb = vec3(0.68, 0.84, 1.0);

  float vis = uBoltFlash * leaderMask * cloudEmerge;
  float mask = (core + innerGlow * 0.55) * vis;
  // Discard outside the bright plasma channel so depthWrite never leaves a dark rim against illuminated clouds
  if (mask < 0.24) discard;

  float energy = vIntensity * vis * uExposureCal;
  vec3 col = (coreRgb * (core * 7.8) + innerRgb * (innerGlow * 3.4)) * energy;
  gl_FragColor = vec4(col, clamp(mask * 1.35, 0.0, 1.0));
}
`;

export class LightningEffect {
  /**
   * @param {object} [opts]
   * @param {THREE.Scene} [opts.scene]
   * @param {object} [opts.audioManager]
   * @param {number} [opts.thunderDid]
   * @param {number} [opts.seed]
   */
  constructor(opts = {}) {
    this.scene = opts.scene || null;
    this.audioManager = opts.audioManager || null;
    this.thunderDid = (opts.thunderDid ?? DEFAULT_THUNDER_DID) >>> 0;
    this._rng = _seededRng(opts.seed ?? 0x9e3779b9);

    this.group = new THREE.Group();
    this.group.name = 'weather-lightning-group';

    // Pre-allocated ribbon geometry (4 vertices, 6 indices per segment)
    this.geometry = this._createBoltGeometry();
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uBoltFlash: { value: 0 },
      uLeaderProgress: { value: 1 },
      uExposureCal: { value: 0.85 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'weather-lightning-bolt',
      uniforms: this.uniforms,
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.material.userData = { __cacheOwned: true, __weatherLightning: true };

    this.boltMesh = new THREE.Mesh(this.geometry, this.material);
    this.boltMesh.name = 'weather-lightning-bolt-mesh';
    this.boltMesh.frustumCulled = false;
    this.boltMesh.matrixAutoUpdate = false;
    // Render before transparent rain/snow particles, depth-tested against terrain!
    this.boltMesh.renderOrder = 1;
    this.boltMesh.visible = false;
    this.boltMesh.userData = { isWeatherLightning: true };
    this.group.add(this.boltMesh);

    // Directional strike light aimed from actual 3D bolt azimuth + hemisphere sky scatter
    this.strikeLight = new THREE.DirectionalLight(0xdceaff, 0);
    this.strikeLight.name = 'weather-lightning-dir-light';
    this.strikeLight.castShadow = false;
    this.strikeLightTarget = new THREE.Object3D();
    this.strikeLightTarget.name = 'weather-lightning-dir-target';
    this.strikeLight.target = this.strikeLightTarget;
    this.group.add(this.strikeLight);
    this.group.add(this.strikeLightTarget);

    this.hemiFlashLight = new THREE.HemisphereLight(0xc8dcff, 0x28344c, 0);
    this.hemiFlashLight.name = 'weather-lightning-hemi-light';
    this.group.add(this.hemiFlashLight);

    if (this.scene && typeof this.scene.add === 'function') {
      this.scene.add(this.group);
    }

    // Active strike & acoustic thunder queue state
    this._activeStrike = null;
    this._pendingThunder = [];
    this._cooldownSec = 3.5 + this._rng() * 5.0;
    this.sceneFlash = 0;
    this.cloudSheetFlash = 0;
    this.strikeWorldPos = { x: 0, y: 750, z: 0 };
    this._strikeCount = 0;
    this._thunderCount = 0;
    this._lastBranchCount = 0;
    this._lastSegmentCount = 0;
  }

  _createBoltGeometry() {
    const vCount = MAX_BOLT_SEGMENTS * 4;
    const geom = new THREE.BufferGeometry();
    // Keep a dummy `position` attribute so Three.js WebGLProgram binding is always satisfied
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    geom.setAttribute('aSegA', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    geom.setAttribute('aSegB', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    geom.setAttribute('aRibbon', new THREE.BufferAttribute(new Float32Array(vCount * 4), 4));
    geom.setAttribute('aIntensity', new THREE.BufferAttribute(new Float32Array(vCount), 1));

    const indices = new Uint16Array(MAX_BOLT_SEGMENTS * 6);
    for (let s = 0; s < MAX_BOLT_SEGMENTS; s++) {
      const vi = s * 4;
      const ii = s * 6;
      indices[ii + 0] = vi + 0;
      indices[ii + 1] = vi + 1;
      indices[ii + 2] = vi + 2;
      indices[ii + 3] = vi + 0;
      indices[ii + 4] = vi + 2;
      indices[ii + 5] = vi + 3;
    }
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.setDrawRange(0, 0);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return geom;
  }

  _uploadBoltSegments(segments) {
    const segA = this.geometry.getAttribute('aSegA');
    const segB = this.geometry.getAttribute('aSegB');
    const ribbon = this.geometry.getAttribute('aRibbon');
    const inten = this.geometry.getAttribute('aIntensity');

    const aArr = segA.array;
    const bArr = segB.array;
    const rArr = ribbon.array;
    const iArr = inten.array;

    const count = Math.min(segments.length, MAX_BOLT_SEGMENTS);
    const corners = [
      [-1, 0],
      [1, 0],
      [1, 1],
      [-1, 1],
    ];

    for (let s = 0; s < count; s++) {
      const seg = segments[s];
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        const side = corners[c][0];
        const endSel = corners[c][1];
        aArr[v * 3 + 0] = seg.ax;
        aArr[v * 3 + 1] = seg.ay;
        aArr[v * 3 + 2] = seg.az;
        bArr[v * 3 + 0] = seg.bx;
        bArr[v * 3 + 1] = seg.by;
        bArr[v * 3 + 2] = seg.bz;
        rArr[v * 4 + 0] = side;
        rArr[v * 4 + 1] = endSel;
        rArr[v * 4 + 2] = endSel === 0 ? seg.w0 : seg.w1;
        rArr[v * 4 + 3] = endSel === 0 ? seg.p0 : seg.p1;
        iArr[v] = seg.intensity;
      }
    }

    segA.needsUpdate = true;
    segB.needsUpdate = true;
    ribbon.needsUpdate = true;
    inten.needsUpdate = true;
    this.geometry.setDrawRange(0, count * 6);
  }

  /**
   * Trigger a lightning strike immediately (used by storm scheduler and devtools `flashNow`).
   * @param {object} [opts]
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [opts.cameraPos]
   * @param {number} [opts.distanceM]
   * @param {number} [opts.azimuthRad]
   * @param {number} [opts.cloudBaseM]
   * @param {boolean} [opts.intraCloud]
   * @param {number} [opts.groundY]
   */
  flashNow(opts = {}) {
    const camX = Number(opts.cameraPos?.x) || this.uniforms.uCamPos.value.x || 0;
    const camY = Number(opts.cameraPos?.y) || this.uniforms.uCamPos.value.y || 0;
    const camZ = Number(opts.cameraPos?.z) || this.uniforms.uCamPos.value.z || 0;

    const rawDist = Number(opts.distanceM);
    const distanceM = Number.isFinite(rawDist)
      ? Math.min(BOLT_MAX_DIST_M, Math.max(BOLT_MIN_DIST_M, rawDist))
      : BOLT_MIN_DIST_M + Math.pow(this._rng(), 0.78) * (BOLT_MAX_DIST_M - BOLT_MIN_DIST_M);

    const azimuthRad = Number.isFinite(opts.azimuthRad)
      ? opts.azimuthRad
      : (Number.isFinite(opts.denseCloudAzimuth)
        ? opts.denseCloudAzimuth + (this._rng() - 0.5) * 1.4
        : this._rng() * Math.PI * 2);

    const intraCloud = typeof opts.intraCloud === 'boolean'
      ? opts.intraCloud
      : this._rng() < 0.28;

    const cloudBaseAboveCam = Number.isFinite(opts.cloudBaseM)
      ? Math.max(260, opts.cloudBaseM)
      : 540 + this._rng() * 240;

    const sx = camX + Math.cos(azimuthRad) * distanceM;
    const sz = camZ + Math.sin(azimuthRad) * distanceM;
    const sy = camY + cloudBaseAboveCam;

    let endPt;
    if (intraCloud) {
      const spanAngle = azimuthRad + (this._rng() < 0.5 ? 1 : -1) * (1.1 + 0.6 * this._rng());
      const spanM = 280 + 360 * this._rng();
      endPt = {
        x: sx + Math.cos(spanAngle) * spanM,
        y: sy + (this._rng() - 0.45) * 90,
        z: sz + Math.sin(spanAngle) * spanM,
      };
    } else {
      const groundY = Number.isFinite(opts.groundY) ? opts.groundY : camY - 25;
      endPt = {
        x: sx + (this._rng() - 0.5) * 95,
        y: groundY,
        z: sz + (this._rng() - 0.5) * 95,
      };
    }

    const built = buildForkedBoltSegments({
      start: { x: sx, y: sy, z: sz },
      end: endPt,
      intraCloud,
      branchCount: opts.branchCount,
      rng: this._rng,
    });

    this._uploadBoltSegments(built.segments);
    this._lastBranchCount = built.branchCount;
    this._lastSegmentCount = built.segments.length;
    this._strikeCount += 1;

    this.strikeWorldPos = { x: sx, y: sy, z: sz };
    this._activeStrike = {
      elapsedMs: 0,
      distanceM,
      azimuthRad,
      intraCloud,
      sx,
      sy,
      sz,
      branchCount: built.branchCount,
      segmentCount: built.segments.length,
    };

    // Aim directional strike light from actual 3D lightning bolt bearing toward camera
    this.strikeLight.position.set(
      camX + Math.cos(azimuthRad) * 180,
      camY + Math.max(95, cloudBaseAboveCam * 0.25),
      camZ + Math.sin(azimuthRad) * 180
    );
    this.strikeLightTarget.position.set(camX, camY, camZ);
    this.strikeLightTarget.updateMatrixWorld?.();

    // Queue acoustic thunder delayed by speed of sound (343 m/s)
    const thunderDelaySec = distanceM / SPEED_OF_SOUND_MPS;
    this._pendingThunder.push({
      remainingSec: thunderDelaySec,
      distanceM,
      x: sx,
      y: Math.max(camY + 40, sy * 0.35),
      z: sz,
      intraCloud,
    });

    // Apply initial t=0 onset envelope so immediate callers observe flash state right away
    this._applyActiveEnvelope(0, false, 1.0);
    return {
      distanceM,
      azimuthRad,
      intraCloud,
      thunderDelaySec,
      branchCount: built.branchCount,
      segmentCount: built.segments.length,
      strikeWorldPos: { ...this.strikeWorldPos },
    };
  }

  _applyActiveEnvelope(elapsedMs, isIndoor, exposure) {
    if (!this._activeStrike) {
      this.sceneFlash = 0;
      this.cloudSheetFlash = 0;
      this.boltMesh.visible = false;
      this.strikeLight.intensity = 0;
      this.hemiFlashLight.intensity = 0;
      return;
    }

    const env = evaluateStrikeEnvelope(elapsedMs, this._activeStrike.intraCloud);
    const distAtten = Math.max(0.32, 1.0 - (this._activeStrike.distanceM - BOLT_MIN_DIST_M) / 2400.0);
    const outdoorMask = isIndoor ? 0.0 : 1.0;

    this.sceneFlash = env.sceneFlash * distAtten * outdoorMask;
    this.cloudSheetFlash = env.cloudSheetFlash * (0.55 + 0.45 * distAtten) * outdoorMask;

    const exp = Number(exposure);
    this.uniforms.uExposureCal.value = Number.isFinite(exp) && exp > 1
      ? 0.95 / Math.min(18, exp)
      : 0.95;
    this.uniforms.uBoltFlash.value = env.boltFlash * outdoorMask;
    this.uniforms.uLeaderProgress.value = env.leaderProgress;

    this.boltMesh.visible = env.boltFlash * outdoorMask > 0.01;
    this.strikeLight.intensity = this.sceneFlash * 2.85;
    this.hemiFlashLight.intensity = this.sceneFlash * 0.95;
  }

  _clearAll() {
    this._activeStrike = null;
    this._pendingThunder.length = 0;
    this.sceneFlash = 0;
    this.cloudSheetFlash = 0;
    this.boltMesh.visible = false;
    this.strikeLight.intensity = 0;
    this.hemiFlashLight.intensity = 0;
  }

  _fireThunder(item, audioMgr, isIndoor) {
    this._thunderCount += 1;
    if (!audioMgr || typeof audioMgr.play !== 'function') return;
    const distNorm = Math.min(1, Math.max(0, (item.distanceM - BOLT_MIN_DIST_M) / 1800.0));
    const baseGain = (1.0 - 0.72 * distNorm) * (item.intraCloud ? 0.68 : 1.0);
    const gain = Math.max(0.12, Math.min(1.0, baseGain * (isIndoor ? 0.35 : 1.0)));
    try {
      audioMgr.play(
        this.thunderDid,
        { x: item.x, y: item.y, z: item.z },
        {
          gain,
          refDistance: 50,
          maxDistance: 5000,
          rolloffFactor: 0.4,
        }
      );
    } catch (_) {
      // Safe no-op when WebAudio is locked, muted, or wave asset absent
    }
  }

  /**
   * Advance storm strike scheduler, active bolt flicker, directional flash, and thunder queue.
   * @param {number} dt seconds
   * @param {object} [params]
   */
  tick(dt, params = {}) {
    if (params.enabled === false) {
      this._clearAll();
      return;
    }

    const stepDt = Number.isFinite(dt) && dt >= 0 ? Math.min(dt, 0.5) : 0.016;
    const cx = Number(params.cameraPos?.x) || 0;
    const cy = Number(params.cameraPos?.y) || 0;
    const cz = Number(params.cameraPos?.z) || 0;
    this.uniforms.uCamPos.value.set(cx, cy, cz);

    const isIndoor = !!params.isIndoor;
    const audioMgr = params.audioManager ?? this.audioManager;

    // 1. Advance active strike envelope
    if (this._activeStrike) {
      this._activeStrike.elapsedMs += stepDt * 1000.0;
      if (this._activeStrike.elapsedMs > 720) {
        this._activeStrike = null;
        this._applyActiveEnvelope(999, isIndoor, params.exposure);
      } else {
        // Keep directional strike light anchored relative to moving camera
        const az = this._activeStrike.azimuthRad;
        this.strikeLight.position.set(
          cx + Math.cos(az) * 180,
          cy + 145,
          cz + Math.sin(az) * 180
        );
        this.strikeLightTarget.position.set(cx, cy, cz);
        this.strikeLightTarget.updateMatrixWorld?.();
        this._applyActiveEnvelope(this._activeStrike.elapsedMs, isIndoor, params.exposure);
      }
    }

    // 2. Drain acoustic speed-of-sound thunder queue (343 m/s)
    if (this._pendingThunder.length > 0) {
      for (let i = this._pendingThunder.length - 1; i >= 0; i--) {
        const item = this._pendingThunder[i];
        item.remainingSec -= stepDt;
        if (item.remainingSec <= 0) {
          this._pendingThunder.splice(i, 1);
          this._fireThunder(item, audioMgr, isIndoor);
        }
      }
    }

    // 3. Autonomous storm strike scheduler (coupled to storm intensity & overhead cloud density)
    const stormIntensity = Number(params.stormIntensity) || 0;
    const cloudFactor = Number.isFinite(params.overheadCloudFactor)
      ? Math.min(1, Math.max(0, params.overheadCloudFactor))
      : 1.0;

    if (params.stormActive && stormIntensity > 0.15 && cloudFactor > 0.18) {
      this._cooldownSec -= stepDt;
      if (this._cooldownSec <= 0 && !this._activeStrike) {
        this.flashNow({
          cameraPos: { x: cx, y: cy, z: cz },
          denseCloudAzimuth: params.denseCloudAzimuth,
          cloudBaseM: params.cloudBaseM,
          groundY: params.groundY,
        });
        // Higher storm + denser overhead cloud -> shorter mean interval (~4.5..12s)
        const rateScale = Math.max(0.35, stormIntensity * (0.4 + 0.6 * cloudFactor));
        const minWait = 3.8 / rateScale;
        const maxWait = 10.5 / rateScale;
        this._cooldownSec = minWait + this._rng() * (maxWait - minWait);
      }
    }
  }

  stats() {
    return {
      active: !!this._activeStrike,
      boltVisible: this.boltMesh.visible,
      drawCalls: this.boltMesh.visible ? 1 : 0,
      sceneFlash: this.sceneFlash,
      cloudSheetFlash: this.cloudSheetFlash,
      strikeWorldPos: { ...this.strikeWorldPos },
      pendingThunder: this._pendingThunder.length,
      strikeCount: this._strikeCount,
      thunderCount: this._thunderCount,
      lastBranchCount: this._lastBranchCount,
      lastSegmentCount: this._lastSegmentCount,
      thunderDid: this.thunderDid,
    };
  }

  dispose() {
    this._clearAll();
    if (this.group?.parent) this.group.parent.remove(this.group);
    this.geometry?.dispose?.();
    this.material?.dispose?.();
  }
}
