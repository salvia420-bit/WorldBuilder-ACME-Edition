// scene3d/weenie_contact_shadows.js — 1-draw instanced ground contact shadows
// for the local player and nearby dynamic weenies (NPCs, monsters, lifestones,
// portals, chests, signs/pedestals).
//
// World coordinates under `scene3d.worldRoot` (`worldRoot.rotation.x = -PI/2`)
// are AC Z-up `(east = X, north = Y, height = Z)`. A unit XY plane (`2m x 2m`)
// has local normal `+Z` (straight up in AC space) and spans `[-1, +1]^2`, so
// scaling an instance by `(radius, radius, 1)` and orienting `+Z` to the ground
// normal stamps a soft radial Gaussian AO contact disc cleanly on flat dungeon
// stone floors and sloped outdoor terrain alike.
//
// Performance contract:
//   - Single `THREE.InstancedMesh` (`maxCount = 256`, `frustumCulled = false`)
//   - 0 texture binds (analytic radial Gaussian + smooth rim falloff in shader)
//   - `depthWrite: false`, `polygonOffset` + `+0.03m` normal lift
//   - Fail-soft in headless/mock test environments where `THREE` or `scene3d`
//     is partially stubbed.

import * as THREE from "three";

export const WEENIE_CONTACT_SHADOW_MAX = 256;
export const WEENIE_CONTACT_SHADOW_RANGE_M = 55.0;
const FADE_START_M = 42.0;
const AIRBORNE_ATTEN_START_M = 0.25;
const AIRBORNE_ATTEN_SPAN_M = 2.75; // full fade by 3.0 m airborne
const NORMAL_LIFT_M = 0.03;
const SLOPE_SAMPLE_STEP_M = 0.35;

const ITEM_TYPE_CONTAINER = 0x00000002;
const ITEM_TYPE_CREATURE = 0x00000010;
const ITEM_TYPE_LIFE_STONE = 0x00000200;
const ITEM_TYPE_PORTAL = 0x00002000;
const ITEM_TYPE_WRITABLE = 0x00020000;

const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/**
 * `?contactShadows=off|0|false|no` (or `?weenieContactShadows=off`) disables
 * instanced weenie ground contact shadows. DEFAULT ON.
 * @param {string} [search]
 * @returns {boolean}
 */
export function weenieContactShadowsEnabled(search) {
  try {
    const s = typeof search === "string"
      ? search
      : (typeof globalThis !== "undefined" && globalThis.location ? globalThis.location.search || "" : "");
    if (!s) return true;
    const params = new URLSearchParams(s);
    const v1 = params.get("contactShadows");
    if (v1 !== null && OFF_VALUES.has(String(v1).trim().toLowerCase())) return false;
    const v2 = params.get("weenieContactShadows");
    if (v2 !== null && OFF_VALUES.has(String(v2).trim().toLowerCase())) return false;
    return true;
  } catch (_) {
    return true;
  }
}

const VERTEX_SHADER = /* glsl */ `
attribute float aShadowAlpha;
varying vec2 vDiscCoord;
varying float vShadowAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDiscCoord = uv * 2.0 - 1.0;
  vShadowAlpha = aShadowAlpha;
  vec4 mvPosition = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec2 vDiscCoord;
varying float vShadowAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  float r2 = dot(vDiscCoord, vDiscCoord);
  if (r2 >= 1.0 || vShadowAlpha <= 0.002) discard;
  #include <logdepthbuf_fragment>
  float gauss = exp(-3.35 * r2);
  float rim = 1.0 - smoothstep(0.42, 1.0, r2);
  float ao = gauss * rim * vShadowAlpha;
  if (ao <= 0.002) discard;
  gl_FragColor = vec4(0.012, 0.014, 0.024, clamp(ao, 0.0, 0.68));
}
`;

function _smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function _canConstructThreeInstanced() {
  return Boolean(
    THREE &&
    typeof THREE.InstancedMesh === "function" &&
    typeof THREE.PlaneGeometry === "function" &&
    typeof THREE.ShaderMaterial === "function" &&
    typeof THREE.InstancedBufferAttribute === "function" &&
    typeof THREE.Matrix4 === "function" &&
    typeof THREE.Quaternion === "function" &&
    typeof THREE.Vector3 === "function"
  );
}

function _terrainZAt(sh, wx, wy) {
  if (!sh || typeof sh.terrainHeightAt !== "function") return null;
  try {
    const gz = sh.terrainHeightAt(wx, wy);
    return typeof gz === "number" && Number.isFinite(gz) ? gz : null;
  } catch (_) {
    return null;
  }
}

export class WeenieContactShadows {
  /**
   * @param {object} scene3d
   * @param {object} [opts]
   * @param {number} [opts.maxCount=256]
   * @param {object} [opts.parent]
   */
  constructor(scene3d, opts = {}) {
    this.scene3d = scene3d || null;
    this.maxCount = Math.max(1, (opts.maxCount ?? WEENIE_CONTACT_SHADOW_MAX) | 0);
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.alphaAttr = null;
    this.activeCount = 0;
    this._disposed = false;
    this._explicitParent = opts.parent ?? null;
    this._candidates = [];
    this._pool = [];
    this._mat4 = null;
    this._pos = null;
    this._quat = null;
    this._scale = null;
    this._up = null;
    this._norm = null;

    if (!weenieContactShadowsEnabled() || !_canConstructThreeInstanced()) {
      return;
    }

    try {
      const geo = new THREE.PlaneGeometry(2, 2);
      const alphaArray = new Float32Array(this.maxCount);
      const alphaAttr = new THREE.InstancedBufferAttribute(alphaArray, 1);
      if (typeof alphaAttr.setUsage === "function" && THREE.DynamicDrawUsage !== undefined) {
        alphaAttr.setUsage(THREE.DynamicDrawUsage);
      }
      geo.setAttribute("aShadowAlpha", alphaAttr);

      const mat = new THREE.ShaderMaterial({
        name: "WeenieContactShadowMaterial",
        uniforms: {},
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
        toneMapped: false,
      });

      const mesh = new THREE.InstancedMesh(geo, mat, this.maxCount);
      mesh.name = "weenieContactShadows";
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 1;
      mesh.count = 0;
      mesh.raycast = () => {};
      if (mesh.layers && typeof mesh.layers.set === "function") {
        mesh.layers.set(0);
      } else if (mesh.layers && typeof mesh.layers.enable === "function") {
        mesh.layers.enable(0);
      }
      if (mesh.instanceMatrix && typeof mesh.instanceMatrix.setUsage === "function" && THREE.DynamicDrawUsage !== undefined) {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      }

      this.geometry = geo;
      this.material = mat;
      this.alphaAttr = alphaAttr;
      this.mesh = mesh;
      this._mat4 = new THREE.Matrix4();
      this._pos = new THREE.Vector3();
      this._quat = new THREE.Quaternion();
      this._scale = new THREE.Vector3(1, 1, 1);
      this._up = new THREE.Vector3(0, 0, 1);
      this._norm = new THREE.Vector3(0, 0, 1);

      this._tryAttachParent();
    } catch (_) {
      this.mesh = null;
      this.geometry = null;
      this.material = null;
      this.alphaAttr = null;
    }
  }

  _tryAttachParent() {
    if (!this.mesh || this.mesh.parent) return true;
    const liveRoot = typeof globalThis !== "undefined" ? globalThis.window?.liveScene3d?.worldRoot : null;
    const builderRoot = this.scene3d?.quality
      ? (this.scene3d?.entitiesGroup?.parent ?? this.scene3d?.entitiesGroup ?? null)
      : null;
    const parent = this._explicitParent ?? this.scene3d?.worldRoot ?? liveRoot ?? builderRoot ?? null;
    if (parent && typeof parent.add === "function") {
      try {
        parent.add(this.mesh);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  _borrowCandidate(idx) {
    let c = this._pool[idx];
    if (!c) {
      c = { inst: null, d2: 0, priority: 0 };
      this._pool[idx] = c;
    }
    return c;
  }

  _footprintFor(inst, sepRadii) {
    const meta = inst.meta || {};
    const itemType = (meta.itemType ?? 0) >>> 0;
    const objScale = Math.max(0.25, Math.min(4.0, +(meta.objScale ?? 1.0) || 1.0));
    const setupId = (inst.setupId ?? meta.modelId ?? meta.setupId ?? 0) >>> 0;
    const sepR = sepRadii && typeof sepRadii.get === "function" ? sepRadii.get(setupId) : undefined;

    if (itemType & ITEM_TYPE_PORTAL) {
      return { radius: 0.85 * objScale, baseAlpha: 0.34 };
    }
    if (itemType & ITEM_TYPE_LIFE_STONE) {
      return { radius: 0.95 * objScale, baseAlpha: 0.58 };
    }
    if (itemType & ITEM_TYPE_CONTAINER) {
      return { radius: Math.max(0.5, Math.min(1.4, (sepR || 0.62) * 1.15)) * objScale, baseAlpha: 0.54 };
    }
    if ((itemType & ITEM_TYPE_CREATURE) || ((meta.mtableId ?? 0) >>> 0) !== 0 || inst._unifiedLoco) {
      const r = typeof sepR === "number" && sepR > 0.05
        ? Math.max(0.42, Math.min(2.35, sepR * 1.22))
        : 0.62;
      return { radius: r * objScale, baseAlpha: 0.56 };
    }
    if (itemType & ITEM_TYPE_WRITABLE) {
      return { radius: 0.48 * objScale, baseAlpha: 0.44 };
    }
    const r = typeof sepR === "number" && sepR > 0.05
      ? Math.max(0.35, Math.min(1.8, sepR * 1.15))
      : 0.52;
    return { radius: r * objScale, baseAlpha: 0.48 };
  }

  /**
   * Stamp up to `maxCount` contact shadow discs for the current frame.
   * @param {object} em EntityManager
   * @param {object} [opts]
   * @returns {number} stamped instance count
   */
  update(em, opts) {
    if (this._disposed || !this.mesh || !em || !em.entityMap) return 0;
    if (!weenieContactShadowsEnabled()) {
      if (this.mesh.count !== 0) {
        this.mesh.count = 0;
        this.mesh.visible = false;
      }
      this.activeCount = 0;
      return 0;
    }
    if (!this._tryAttachParent()) return 0;

    const s3d = this.scene3d || em.scene3d || (typeof globalThis !== "undefined" ? globalThis.window?.liveScene3d : null);
    const cam = opts?.camera ?? s3d?.cameraSwitcher?.activeCamera ?? s3d?.camera ?? null;
    const camPos = cam?.position ?? null;

    let localGuid = null;
    try {
      if (typeof em._localPlayerGuid === "function") {
        localGuid = em._localPlayerGuid();
      } else if (typeof globalThis !== "undefined" && typeof globalThis.window?.getLocalPlayerGuid === "function") {
        const g = globalThis.window.getLocalPlayerGuid();
        if (g != null) localGuid = g >>> 0;
      }
    } catch (_) {}

    const selectedGuid = ((em._selectedGuid ?? (typeof globalThis !== "undefined" ? globalThis.window?.__selectedGuid : 0)) || 0) >>> 0;
    const hoveredGuid = ((em._hoveredGuid ?? (typeof globalThis !== "undefined" ? globalThis.window?.__hoveredGuid : 0)) || 0) >>> 0;
    const sh = opts?.sessionHandle ?? (typeof globalThis !== "undefined" ? globalThis.window?.__sessionHandle : null);

    const maxRange = opts?.rangeM ?? WEENIE_CONTACT_SHADOW_RANGE_M;
    const maxRangeSq = maxRange * maxRange;
    const candidates = this._candidates;
    candidates.length = 0;

    for (const inst of em.entityMap.values()) {
      if (!inst || inst._disposed || !inst.root || inst.root.visible === false) continue;
      if (inst._isProjectile || inst._ballistic || inst._attachedParentGuid != null || inst._leftWorld || inst._hiddenForHandoff) continue;
      if ((inst._physicsTranslucency ?? 0) >= 0.85) continue;
      const p = inst.root.position;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      const hasRenderable = (Array.isArray(inst.parts) && inst.parts.length > 0) ||
        (Array.isArray(inst.root.children) && inst.root.children.length > 0);
      if (!hasRenderable) continue;

      const guid = inst.guid >>> 0;
      const isLocal = localGuid !== null && guid === localGuid;
      let d2 = 0;
      if (camPos) {
        // worldRoot rotation.x = -PI/2 maps AC (p.x, p.y, p.z) -> Three (p.x, p.z, -p.y)
        const dx = camPos.x - p.x;
        const dy = camPos.y - p.z;
        const dz = camPos.z + p.y;
        d2 = dx * dx + dy * dy + dz * dz;
        if (!isLocal && d2 > maxRangeSq) continue;
      }

      const c = this._borrowCandidate(candidates.length);
      c.inst = inst;
      c.d2 = d2;
      c.priority = isLocal ? 2 : (guid !== 0 && (guid === selectedGuid || guid === hoveredGuid) ? 1 : 0);
      candidates.push(c);
    }

    if (candidates.length === 0) {
      this.mesh.count = 0;
      this.mesh.visible = false;
      this.activeCount = 0;
      return 0;
    }

    if (candidates.length > this.maxCount) {
      candidates.sort((a, b) => (b.priority - a.priority) || (a.d2 - b.d2));
    }

    const limit = Math.min(candidates.length, this.maxCount);
    const sepRadii = em._separationRadii ?? null;
    const alphaArr = this.alphaAttr.array;
    let outIdx = 0;

    for (let i = 0; i < limit; i++) {
      const c = candidates[i];
      const inst = c.inst;
      c.inst = null;
      const p = inst.root.position;
      const meta = inst.meta || {};
      const cellIdx = ((inst._currentCellId ?? meta.landblockId ?? 0) >>> 0) & 0xffff;
      const isIndoor = (cellIdx & 0x7fff) >= 0x0100;
      const airborne = Boolean(inst._isAirborne || inst._jumpPoseTween);

      let terrainZ = null;
      let cachedSlopeValid = false;
      if (!isIndoor) {
        if (
          typeof inst._csSampleX === "number" &&
          Math.abs(p.x - inst._csSampleX) < 0.08 &&
          Math.abs(p.y - inst._csSampleY) < 0.08 &&
          inst._csTerrainZ !== undefined
        ) {
          terrainZ = inst._csTerrainZ;
          cachedSlopeValid = typeof inst._csNz === "number";
        } else {
          terrainZ = _terrainZAt(sh, p.x, p.y);
          inst._csSampleX = p.x;
          inst._csSampleY = p.y;
          inst._csTerrainZ = terrainZ;
          inst._csNz = undefined;
        }
      }

      // Track last grounded Z so jumping/falling indoors or outdoors keeps the
      // shadow anchored to the floor/terrain rather than floating mid-air.
      if (!airborne) {
        if (terrainZ !== null && Math.abs(p.z - terrainZ) <= 0.32) {
          inst._contactGroundZ = terrainZ;
        } else if (
          inst._contactGroundZ === undefined ||
          Math.abs(p.z - inst._contactGroundZ) > 3.2 ||
          Math.abs((inst._prevContactZ ?? p.z) - p.z) < 0.004
        ) {
          inst._contactGroundZ = p.z;
        }
      }
      inst._prevContactZ = p.z;

      let footZ = p.z;
      let onTerrainSurface = false;
      if (
        terrainZ !== null &&
        p.z >= terrainZ - 0.20 &&
        p.z - terrainZ <= 3.2 &&
        (airborne || Math.abs((inst._contactGroundZ ?? p.z) - terrainZ) <= 0.35)
      ) {
        footZ = terrainZ;
        onTerrainSurface = true;
      } else if (typeof inst._contactGroundZ === "number" && p.z >= inst._contactGroundZ - 0.05) {
        footZ = inst._contactGroundZ;
      }

      const explicitAir = typeof meta.heightAboveGround === "number" && Number.isFinite(meta.heightAboveGround)
        ? Math.max(0, meta.heightAboveGround)
        : null;
      const heightAboveGround = explicitAir !== null ? explicitAir : Math.max(0, p.z - footZ);

      const { radius: baseRadius, baseAlpha } = this._footprintFor(inst, sepRadii);
      let airAlpha = 1.0;
      let airScale = 1.0;
      if (heightAboveGround > AIRBORNE_ATTEN_START_M) {
        const s = _smoothstep(AIRBORNE_ATTEN_START_M, AIRBORNE_ATTEN_START_M + AIRBORNE_ATTEN_SPAN_M, heightAboveGround);
        airAlpha = (1.0 - s) * (1.0 - s);
        airScale = 1.0 - 0.45 * s;
      }
      if (airAlpha <= 0.01) continue;

      let distFade = 1.0;
      if (c.priority < 2 && c.d2 > FADE_START_M * FADE_START_M) {
        distFade = 1.0 - _smoothstep(FADE_START_M, maxRange, Math.sqrt(c.d2));
      }
      const fadeMul = 1.0 - Math.max(0, Math.min(1, +(inst._physicsTranslucency ?? 0)));
      const finalAlpha = baseAlpha * airAlpha * distFade * fadeMul;
      if (finalAlpha <= 0.01) continue;

      let nx = 0;
      let ny = 0;
      let nz = 1;
      if (onTerrainSurface && sh) {
        if (cachedSlopeValid) {
          nx = inst._csNx;
          ny = inst._csNy;
          nz = inst._csNz;
        } else {
          const zxPos = _terrainZAt(sh, p.x + SLOPE_SAMPLE_STEP_M, p.y);
          const zxNeg = _terrainZAt(sh, p.x - SLOPE_SAMPLE_STEP_M, p.y);
          const zyPos = _terrainZAt(sh, p.x, p.y + SLOPE_SAMPLE_STEP_M);
          const zyNeg = _terrainZAt(sh, p.x, p.y - SLOPE_SAMPLE_STEP_M);
          if (zxPos !== null && zxNeg !== null && zyPos !== null && zyNeg !== null) {
            const dzdx = (zxPos - zxNeg) / (2 * SLOPE_SAMPLE_STEP_M);
            const dzdy = (zyPos - zyNeg) / (2 * SLOPE_SAMPLE_STEP_M);
            const invLen = 1 / Math.hypot(dzdx, dzdy, 1);
            nx = -dzdx * invLen;
            ny = -dzdy * invLen;
            nz = invLen;
          }
          inst._csNx = nx;
          inst._csNy = ny;
          inst._csNz = nz;
        }
      }

      this._norm.set(nx, ny, nz);
      this._quat.setFromUnitVectors(this._up, this._norm);
      this._pos.set(
        p.x + nx * NORMAL_LIFT_M,
        p.y + ny * NORMAL_LIFT_M,
        footZ + nz * NORMAL_LIFT_M,
      );
      const r = Math.max(0.18, baseRadius * airScale);
      this._scale.set(r, r, 1);
      this._mat4.compose(this._pos, this._quat, this._scale);
      this.mesh.setMatrixAt(outIdx, this._mat4);
      alphaArr[outIdx] = finalAlpha;
      outIdx++;
    }

    for (let i = limit; i < candidates.length; i++) {
      candidates[i].inst = null;
    }
    candidates.length = 0;

    this.mesh.count = outIdx;
    this.mesh.visible = outIdx > 0;
    this.activeCount = outIdx;
    if (outIdx > 0) {
      if (this.mesh.instanceMatrix) this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }
    return outIdx;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.activeCount = 0;
    if (this.mesh) {
      try {
        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
      } catch (_) {}
      try { this.mesh.dispose(); } catch (_) {}
      this.mesh = null;
    }
    if (this.geometry) {
      try { this.geometry.dispose(); } catch (_) {}
      this.geometry = null;
    }
    if (this.material) {
      try { this.material.dispose(); } catch (_) {}
      this.material = null;
    }
    this.alphaAttr = null;
    this._candidates.length = 0;
  }
}

export default WeenieContactShadows;
