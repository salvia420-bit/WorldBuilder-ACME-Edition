var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};

// src/DensityProfile.ts
var DensityProfile = class _DensityProfile {
  constructor(expTerm = 0, exponent = 0, linearTerm = 0, constantTerm = 0) {
    this.expTerm = expTerm;
    this.exponent = exponent;
    this.linearTerm = linearTerm;
    this.constantTerm = constantTerm;
  }
  set(expTerm = 0, exponent = 0, linearTerm = 0, constantTerm = 0) {
    this.expTerm = expTerm;
    this.exponent = exponent;
    this.linearTerm = linearTerm;
    this.constantTerm = constantTerm;
    return this;
  }
  clone() {
    return new _DensityProfile(
      this.expTerm,
      this.exponent,
      this.linearTerm,
      this.constantTerm
    );
  }
  copy(other) {
    this.expTerm = other.expTerm;
    this.exponent = other.exponent;
    this.linearTerm = other.linearTerm;
    this.constantTerm = other.constantTerm;
    return this;
  }
};

// src/CloudLayer.ts
var paramKeys = [
  "channel",
  "altitude",
  "height",
  "densityScale",
  "shapeAmount",
  "shapeDetailAmount",
  "weatherExponent",
  "shapeAlteringBias",
  "coverageFilterWidth",
  "shadow",
  "densityProfile"
];
function applyOptions(target, params) {
  if (params == null) {
    return;
  }
  for (const key of paramKeys) {
    const value = params[key];
    if (value == null) {
      continue;
    }
    if (target[key] instanceof DensityProfile) {
      target[key].copy(value);
    } else {
      ;
      target[key] = value;
    }
  }
}
var CloudLayer = class _CloudLayer {
  constructor(options) {
    this.channel = "r";
    this.altitude = 0;
    this.height = 0;
    this.densityScale = 0.2;
    this.shapeAmount = 1;
    this.shapeDetailAmount = 1;
    this.weatherExponent = 1;
    this.shapeAlteringBias = 0.35;
    this.coverageFilterWidth = 0.6;
    this.densityProfile = new DensityProfile(0, 0, 0.75, 0.25);
    this.shadow = false;
    this.set(options);
  }
  static {
    this.DEFAULT = /* @__PURE__ */ new _CloudLayer();
  }
  set(options) {
    applyOptions(this, options);
    return this;
  }
  clone() {
    return new _CloudLayer(this);
  }
  copy(other) {
    this.channel = other.channel;
    this.altitude = other.altitude;
    this.height = other.height;
    this.densityScale = other.densityScale;
    this.shapeAmount = other.shapeAmount;
    this.shapeDetailAmount = other.shapeDetailAmount;
    this.weatherExponent = other.weatherExponent;
    this.shapeAlteringBias = other.shapeAlteringBias;
    this.coverageFilterWidth = other.coverageFilterWidth;
    this.densityProfile.copy(other.densityProfile);
    this.shadow = other.shadow;
    return this;
  }
};

// src/CloudLayers.ts
var entriesScratch = /* @__PURE__ */ Array.from(
  { length: 8 },
  () => ({ value: 0, flag: 0 })
);
var intervalsScratch = /* @__PURE__ */ Array.from(
  { length: 3 },
  () => ({ min: 0, max: 0 })
);
function compareEntries(a, b) {
  return a.value !== b.value ? a.value - b.value : a.flag - b.flag;
}
var CloudLayers = class _CloudLayers extends Array {
  static {
    this.DEFAULT = /* @__PURE__ */ new _CloudLayers([
      {
        channel: "r",
        altitude: 750,
        height: 650,
        densityScale: 0.2,
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.6,
        shadow: true
      },
      {
        channel: "g",
        altitude: 1e3,
        height: 1200,
        densityScale: 0.2,
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.6,
        shadow: true
      },
      {
        channel: "b",
        altitude: 7500,
        height: 500,
        densityScale: 3e-3,
        shapeAmount: 0.4,
        shapeDetailAmount: 0,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.5
      },
      { channel: "a" }
    ]);
  }
  constructor(options) {
    super(
      new CloudLayer(options?.[0]),
      new CloudLayer(options?.[1]),
      new CloudLayer(options?.[2]),
      new CloudLayer(options?.[3])
    );
  }
  set(options) {
    this[0].set(options?.[0]);
    this[1].set(options?.[1]);
    this[2].set(options?.[2]);
    this[3].set(options?.[3]);
    return this;
  }
  reset() {
    this[0].copy(CloudLayer.DEFAULT);
    this[1].copy(CloudLayer.DEFAULT);
    this[2].copy(CloudLayer.DEFAULT);
    this[3].copy(CloudLayer.DEFAULT);
    return this;
  }
  clone() {
    return new _CloudLayers(this);
  }
  copy(other) {
    this[0].copy(other[0]);
    this[1].copy(other[1]);
    this[2].copy(other[2]);
    this[3].copy(other[3]);
    return this;
  }
  get localWeatherChannels() {
    return this[0].channel + this[1].channel + this[2].channel + this[3].channel;
  }
  packValues(key, result) {
    return result.set(this[0][key], this[1][key], this[2][key], this[3][key]);
  }
  packSums(a, b, result) {
    return result.set(
      this[0][a] + this[0][b],
      this[1][a] + this[1][b],
      this[2][a] + this[2][b],
      this[3][a] + this[3][b]
    );
  }
  packDensityProfiles(key, result) {
    return result.set(
      this[0].densityProfile[key],
      this[1].densityProfile[key],
      this[2].densityProfile[key],
      this[3].densityProfile[key]
    );
  }
  // Redundant, but need to avoid creating garbage here as this runs every frame.
  packIntervalHeights(minIntervals, maxIntervals) {
    for (let i = 0; i < 4; ++i) {
      const layer = this[i];
      let entry = entriesScratch[i];
      entry.value = layer.altitude;
      entry.flag = 0;
      entry = entriesScratch[i + 4];
      entry.value = layer.altitude + layer.height;
      entry.flag = 1;
    }
    entriesScratch.sort(compareEntries);
    let intervalIndex = 0;
    let balance = 0;
    for (let entryIndex = 0; entryIndex < entriesScratch.length; ++entryIndex) {
      const { value, flag } = entriesScratch[entryIndex];
      if (balance === 0 && entryIndex > 0) {
        const interval2 = intervalsScratch[intervalIndex++];
        interval2.min = entriesScratch[entryIndex - 1].value;
        interval2.max = value;
      }
      balance += flag === 0 ? 1 : -1;
    }
    for (; intervalIndex < 3; ++intervalIndex) {
      const interval2 = intervalsScratch[intervalIndex];
      interval2.min = 0;
      interval2.max = 0;
    }
    let interval = intervalsScratch[0];
    minIntervals.x = interval.min;
    maxIntervals.x = interval.max;
    interval = intervalsScratch[1];
    minIntervals.y = interval.min;
    maxIntervals.y = interval.max;
    interval = intervalsScratch[2];
    minIntervals.z = interval.min;
    maxIntervals.z = interval.max;
  }
};

// src/CloudsEffect.ts
import { Effect, EffectAttribute, Resolution } from "postprocessing";
import {
  Camera as Camera2,
  Data3DTexture,
  EventDispatcher,
  Matrix3,
  Matrix4 as Matrix44,
  Texture,
  Uniform as Uniform6,
  Vector2 as Vector28,
  Vector3 as Vector35
} from "three";
import {
  AtmosphereParameters as AtmosphereParameters2,
  getAltitudeCorrectionOffset
} from "@takram/three-atmosphere";
import {
  define as define4,
  definePropertyShorthand,
  defineUniformShorthand,
  lerp as lerp2
} from "@takram/three-geospatial";

// src/CascadedShadowMaps.ts
import {
  Box3,
  Matrix4,
  Object3D,
  Vector2,
  Vector3 as Vector32
} from "three";

// tiny-invariant-stub:tiny-invariant
function invariant(condition, _message) {
  if (!condition) {
    throw new Error("Invariant failed");
  }
}

// src/helpers/FrustumCorners.ts
import { Vector3 } from "three";
var FrustumCorners = class _FrustumCorners {
  constructor(camera, far) {
    this.near = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this.far = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    if (camera != null && far != null) {
      this.setFromCamera(camera, far);
    }
  }
  clone() {
    return new _FrustumCorners().copy(this);
  }
  copy(other) {
    for (let i = 0; i < 4; ++i) {
      this.near[i].copy(other.near[i]);
      this.far[i].copy(other.far[i]);
    }
    return this;
  }
  setFromCamera(camera, far) {
    const isOrthographic = camera.isOrthographicCamera === true;
    const inverseProjectionMatrix = camera.projectionMatrixInverse;
    this.near[0].set(1, 1, -1);
    this.near[1].set(1, -1, -1);
    this.near[2].set(-1, -1, -1);
    this.near[3].set(-1, 1, -1);
    for (let i = 0; i < 4; ++i) {
      this.near[i].applyMatrix4(inverseProjectionMatrix);
    }
    this.far[0].set(1, 1, 1);
    this.far[1].set(1, -1, 1);
    this.far[2].set(-1, -1, 1);
    this.far[3].set(-1, 1, 1);
    for (let i = 0; i < 4; ++i) {
      const corner = this.far[i];
      corner.applyMatrix4(inverseProjectionMatrix);
      const absZ = Math.abs(corner.z);
      if (isOrthographic) {
        corner.z *= Math.min(far / absZ, 1);
      } else {
        corner.multiplyScalar(Math.min(far / absZ, 1));
      }
    }
    return this;
  }
  split(clipDepths, result = []) {
    for (let index = 0; index < clipDepths.length; ++index) {
      const frustum = result[index] ??= new _FrustumCorners();
      if (index === 0) {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i].copy(this.near[i]);
        }
      } else {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i].lerpVectors(
            this.near[i],
            this.far[i],
            clipDepths[index - 1]
          );
        }
      }
      if (index === clipDepths.length - 1) {
        for (let i = 0; i < 4; ++i) {
          frustum.far[i].copy(this.far[i]);
        }
      } else {
        for (let i = 0; i < 4; ++i) {
          frustum.far[i].lerpVectors(
            this.near[i],
            this.far[i],
            clipDepths[index]
          );
        }
      }
    }
    result.length = clipDepths.length;
    return result;
  }
  applyMatrix4(matrix) {
    for (let i = 0; i < 4; ++i) {
      this.near[i].applyMatrix4(matrix);
      this.far[i].applyMatrix4(matrix);
    }
    return this;
  }
};

// src/helpers/splitFrustum.ts
import { lerp } from "@takram/three-geospatial";
var modes = {
  uniform: (count, near, far, _, result = []) => {
    for (let i = 0; i < count; ++i) {
      result[i] = (near + (far - near) * (i + 1) / count) / far;
    }
    result.length = count;
    return result;
  },
  logarithmic: (count, near, far, _, result = []) => {
    for (let i = 0; i < count; ++i) {
      result[i] = near * (far / near) ** ((i + 1) / count) / far;
    }
    result.length = count;
    return result;
  },
  practical: (count, near, far, lambda = 0.5, result = []) => {
    for (let i = 0; i < count; ++i) {
      const uniform = (near + (far - near) * (i + 1) / count) / far;
      const logarithmic = near * (far / near) ** ((i + 1) / count) / far;
      result[i] = lerp(uniform, logarithmic, lambda);
    }
    result.length = count;
    return result;
  }
};
function splitFrustum(mode, count, near, far, lambda, result = []) {
  return modes[mode](count, near, far, lambda, result);
}

// src/CascadedShadowMaps.ts
var vectorScratch1 = /* @__PURE__ */ new Vector32();
var vectorScratch2 = /* @__PURE__ */ new Vector32();
var matrixScratch1 = /* @__PURE__ */ new Matrix4();
var matrixScratch2 = /* @__PURE__ */ new Matrix4();
var frustumScratch = /* @__PURE__ */ new FrustumCorners();
var boxScratch = /* @__PURE__ */ new Box3();
var cascadedShadowMapsDefaults = {
  maxFar: null,
  farScale: 1,
  splitMode: "practical",
  splitLambda: 0.5,
  margin: 0,
  fade: true
};
var CascadedShadowMaps = class {
  constructor(options) {
    this.cascades = [];
    this.mapSize = new Vector2();
    this.cameraFrustum = new FrustumCorners();
    this.frusta = [];
    this.splits = [];
    this._far = 0;
    const {
      cascadeCount,
      mapSize,
      maxFar,
      farScale,
      splitMode,
      splitLambda,
      margin,
      fade
    } = {
      ...cascadedShadowMapsDefaults,
      ...options
    };
    this.cascadeCount = cascadeCount;
    this.mapSize.copy(mapSize);
    this.maxFar = maxFar;
    this.farScale = farScale;
    this.splitMode = splitMode;
    this.splitLambda = splitLambda;
    this.margin = margin;
    this.fade = fade;
  }
  get cascadeCount() {
    return this.cascades.length;
  }
  set cascadeCount(value) {
    if (value !== this.cascadeCount) {
      for (let i = 0; i < value; ++i) {
        this.cascades[i] ??= {
          interval: new Vector2(),
          matrix: new Matrix4(),
          inverseMatrix: new Matrix4(),
          projectionMatrix: new Matrix4(),
          inverseProjectionMatrix: new Matrix4(),
          viewMatrix: new Matrix4(),
          inverseViewMatrix: new Matrix4()
        };
      }
      this.cascades.length = value;
    }
  }
  get far() {
    return this._far;
  }
  updateIntervals(camera) {
    const cascadeCount = this.cascadeCount;
    const splits = this.splits;
    const far = this.far;
    splitFrustum(
      this.splitMode,
      cascadeCount,
      camera.near,
      far,
      this.splitLambda,
      splits
    );
    this.cameraFrustum.setFromCamera(camera, far);
    this.cameraFrustum.split(splits, this.frusta);
    const cascades = this.cascades;
    for (let i = 0; i < cascadeCount; ++i) {
      cascades[i].interval.set(splits[i - 1] ?? 0, splits[i] ?? 0);
    }
  }
  getFrustumRadius(camera, frustum) {
    const nearCorners = frustum.near;
    const farCorners = frustum.far;
    let diagonalLength = Math.max(
      farCorners[0].distanceTo(farCorners[2]),
      farCorners[0].distanceTo(nearCorners[2])
    );
    if (this.fade) {
      const near = camera.near;
      const far = this.far;
      const distance = farCorners[0].z / (far - near);
      diagonalLength += 0.25 * distance ** 2 * (far - near);
    }
    return diagonalLength * 0.5;
  }
  updateMatrices(camera, sunDirection, distance = 1) {
    const lightOrientationMatrix = matrixScratch1.lookAt(
      vectorScratch1.setScalar(0),
      vectorScratch2.copy(sunDirection).multiplyScalar(-1),
      Object3D.DEFAULT_UP
    );
    const cameraToLightMatrix = matrixScratch2.multiplyMatrices(
      matrixScratch2.copy(lightOrientationMatrix).invert(),
      camera.matrixWorld
    );
    const frusta = this.frusta;
    const cascades = this.cascades;
    invariant(frusta.length === cascades.length);
    const margin = this.margin;
    const mapSize = this.mapSize;
    for (let i = 0; i < frusta.length; ++i) {
      const frustum = frusta[i];
      const cascade = cascades[i];
      const radius = this.getFrustumRadius(camera, frusta[i]);
      const left = -radius;
      const right = radius;
      const top = radius;
      const bottom = -radius;
      cascade.projectionMatrix.makeOrthographic(
        left,
        right,
        top,
        bottom,
        -this.margin,
        // near
        radius * 2 + this.margin
        // far
      );
      const { near, far } = frustumScratch.copy(frustum).applyMatrix4(cameraToLightMatrix);
      const bbox = boxScratch.makeEmpty();
      for (let j = 0; j < 4; j++) {
        bbox.expandByPoint(near[j]);
        bbox.expandByPoint(far[j]);
      }
      const center = bbox.getCenter(vectorScratch1);
      center.z = bbox.max.z + margin;
      const texelWidth = (right - left) / mapSize.width;
      const texelHeight = (top - bottom) / mapSize.height;
      center.x = Math.round(center.x / texelWidth) * texelWidth;
      center.y = Math.round(center.y / texelHeight) * texelHeight;
      center.applyMatrix4(lightOrientationMatrix);
      const position = vectorScratch2.copy(sunDirection).multiplyScalar(distance).add(center);
      cascade.inverseViewMatrix.lookAt(center, position, Object3D.DEFAULT_UP).setPosition(position);
    }
  }
  update(camera, sunDirection, distance) {
    this._far = this.maxFar != null ? Math.min(this.maxFar, camera.far * this.farScale) : camera.far * this.farScale;
    this.updateIntervals(camera);
    this.updateMatrices(camera, sunDirection, distance);
    const cascades = this.cascades;
    const cascadeCount = this.cascadeCount;
    for (let i = 0; i < cascadeCount; ++i) {
      const {
        matrix,
        inverseMatrix,
        projectionMatrix,
        inverseProjectionMatrix,
        viewMatrix,
        inverseViewMatrix
      } = cascades[i];
      inverseProjectionMatrix.copy(projectionMatrix).invert();
      viewMatrix.copy(inverseViewMatrix).invert();
      matrix.copy(projectionMatrix).multiply(viewMatrix);
      inverseMatrix.copy(inverseViewMatrix).multiply(inverseProjectionMatrix);
    }
  }
};

// src/CloudsPass.ts
import { ShaderPass } from "postprocessing";
import {
  HalfFloatType,
  LinearFilter,
  RedFormat,
  WebGLRenderTarget
} from "three";

// src/CloudsMaterial.ts
import {
  GLSL3,
  Matrix4 as Matrix42,
  Uniform,
  Vector2 as Vector24,
  Vector3 as Vector33,
  Vector4
} from "three";
import {
  AtmosphereMaterialBase,
  AtmosphereParameters
} from "@takram/three-atmosphere";
import {
  common,
  definitions
} from "@takram/three-atmosphere/shaders/bruneton";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/brunetonStubs.glsl
var brunetonStubs_default = "// brunetonStubs.glsl \u2014 Clouds-B Bruneton runtime decouple.\n//\n// Drop-in replacement for the takram-three-atmosphere bruneton/runtime\n// shader chunk. Keeps the same 3 short-form function signatures that\n// clouds.frag + clouds.vert call (per the original runtime's #define\n// rewrites at lines 459-461), but drives them from our synthetic\n// uSunColor / uAmbientColor / uHorizonColor / uFogDensity / uSunIntensity\n// uniforms instead of Bruneton's precomputed atmospheric scattering\n// tables.\n//\n// The Bruneton `common.glsl` and `definitions.glsl` chunks remain in\n// place (still imported from takram-three-atmosphere) for their type\n// aliases (IrradianceSpectrum / RadianceSpectrum / Position / etc.) +\n// the AtmosphereParameters struct. The atmosphere-uniforms-and-textures\n// declared in clouds.vert (line 6-14) stay declared so the shader\n// compiles; they're left unbound by the TS side and our stub functions\n// don't read them.\n//\n// Wired into CloudsMaterial.ts's resolveIncludes() call as the\n// `atmosphere.bruneton.runtime` slot. See [[project_holtburger_clouds_a_done_2026-05-15]]\n// + docs/skybox-volumetric-clouds-handoff-2026-05-15.md for the bigger\n// volumetric-clouds plan.\n\nuniform vec3 uSunColor;       // DayGroup.dirColor (ARGB \u2192 RGB)\nuniform vec3 uAmbientColor;   // DayGroup.ambColor (ARGB \u2192 RGB)\nuniform vec3 uHorizonColor;   // DayGroup.fogColor (ARGB \u2192 RGB)\nuniform float uFogDensity;    // derived from DayGroup.fogMin/fogMax\nuniform float uSunIntensity;  // default 1.0\n\n// Scale constants for the stub radiance values. Bruneton's true output\n// is in physical W/m\xB2/sr (hundreds-to-thousands range); takram's cloud\n// raymarch then multiplies by phase/scattering coefficients that bring\n// it into displayable range. Empirically: 50x scale produces NaN/black\n// (likely overflows internally), 1x produces near-black (too dim). A\n// gentle ~3x scale gives reasonable mid-day cloud lighting without\n// breaking the math.\nconst float SUN_RADIANCE_SCALE = 3.0;\nconst float SKY_RADIANCE_SCALE = 1.5;\n\n\n// ---- Short-form lighting functions ----------------------------------\n// These are the names clouds.frag + clouds.vert call directly. The\n// upstream Bruneton runtime block had `#define`s that rewrote these to\n// `*Illuminance` variants \u2014 we don't redefine those macros, so the\n// preprocessor leaves the names alone and they bind to our stubs.\n\n// 4-arg form (sky_irradiance is out-param). Used by clouds.frag:426\n// inside the per-fragment cloud lighting evaluator.\nIrradianceSpectrum GetSunAndSkyIrradiance(\n    const Position p, const Direction normal, const Direction sun_direction,\n    out IrradianceSpectrum sky_irradiance) {\n  float sunCos = clamp(dot(normalize(normal), normalize(sun_direction)), 0.0, 1.0);\n  sky_irradiance = uAmbientColor * SKY_RADIANCE_SCALE;\n  return uSunColor * sunCos * uSunIntensity * SUN_RADIANCE_SCALE;\n}\n\n// 3-arg scalar form (no surface normal). Used by clouds.vert:47-64 as\n// vGroundIrradiance + vCloudsIrradiance varyings (min/maxSun pair),\n// and by clouds.frag:440 inside the per-fragment cloud lighting eval.\n//\n// Convention: takram's Bruneton precomputes a scalar irradiance that\n// assumes the sun comes from `sun_direction` and hits a point at `p`\n// in ECEF coordinates. We approximate: use the y-component (upward)\n// of the *position* as a \"how high above the horizon\" proxy, and the\n// y-component of sun_direction as \"how high is the sun above the\n// horizon\". Both feed a smooth ramp.\nIrradianceSpectrum GetSunAndSkyScalarIrradiance(\n    const Position p, const Direction sun_direction,\n    out IrradianceSpectrum sky_irradiance) {\n  // Sun elevation drives intensity (low sun = warm grazing, dusk-like).\n  // Bruneton's full model accounts for atmospheric absorption; here we\n  // just lerp via a smooth elevation curve.\n  float sunUp = clamp(normalize(sun_direction).y, 0.0, 1.0);\n  float dayMix = smoothstep(0.0, 0.3, sunUp);\n  sky_irradiance = uAmbientColor * SKY_RADIANCE_SCALE;\n  return uSunColor * uSunIntensity * (0.2 + 0.8 * dayMix) * SUN_RADIANCE_SCALE;\n}\n\n// 5-arg sky-radiance-to-point form. Used by clouds.frag:708 for the\n// atmospheric-perspective compositing pass that fades distant cloud\n// fragments into the horizon haze.\nRadianceSpectrum GetSkyRadianceToPoint(\n    const Position camera, const Position point, const Length shadow_length,\n    const Direction sun_direction, out DimensionlessSpectrum transmittance) {\n  float dist = length(camera - point);\n  float fogAmount = 1.0 - exp(-uFogDensity * dist);\n  transmittance = vec3(1.0 - fogAmount);\n  return uHorizonColor * fogAmount;\n}\n";

// src/CloudsMaterial.ts
import {
  define,
  defineExpression,
  defineFloat,
  defineInt,
  Geodetic,
  reinterpretType,
  resolveIncludes,
  unrollLoops
} from "@takram/three-geospatial";
import {
  cascadedShadowMaps,
  depth,
  generators,
  interleavedGradientNoise,
  math,
  raySphereIntersection,
  turbo,
  vogelDisk
} from "@takram/three-geospatial/shaders";

// src/bayer.ts
import { Vector2 as Vector22 } from "three";
var bayerIndices = [
  0,
  8,
  2,
  10,
  12,
  4,
  14,
  6,
  3,
  11,
  1,
  9,
  15,
  7,
  13,
  5
];
var bayerOffsets = /* @__PURE__ */ bayerIndices.reduce((result, _, index) => {
  const offset = new Vector22();
  for (let i = 0; i < 16; ++i) {
    if (bayerIndices[i] === index) {
      offset.set((i % 4 + 0.5) / 4, (Math.floor(i / 4) + 0.5) / 4);
      break;
    }
  }
  return [...result, offset];
}, []);

// src/qualityPresets.ts
import { Vector2 as Vector23 } from "three";
var values = {
  resolutionScale: 1,
  lightShafts: true,
  shapeDetail: true,
  turbulence: true,
  haze: true,
  clouds: {
    multiScatteringOctaves: 8,
    accurateSunSkyLight: true,
    accuratePhaseFunction: false,
    // Primary raymarch
    maxIterationCount: 500,
    minStepSize: 50,
    maxStepSize: 1e3,
    maxRayDistance: 2e5,
    perspectiveStepScale: 1.01,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 0.01,
    // Secondary raymarch
    maxIterationCountToGround: 3,
    maxIterationCountToSun: 2,
    minSecondaryStepSize: 100,
    secondaryStepScale: 2,
    // Shadow length
    maxShadowLengthIterationCount: 500,
    minShadowLengthStepSize: 50,
    maxShadowLengthRayDistance: 2e5
  },
  shadow: {
    cascadeCount: 3,
    mapSize: /* @__PURE__ */ new Vector23(512, 512),
    // Primary raymarch
    maxIterationCount: 50,
    minStepSize: 100,
    maxStepSize: 1e3,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-4
  }
};
var defaults = values;
var qualityPresets = {
  // TODO: We cloud decrease multi-scattering octaves for lower quality presets,
  // but it leads to a loss of higher frequency scattering, making it darker
  // overall, which suggests the need for a fudge factor to scale the radiance.
  low: {
    ...defaults,
    lightShafts: false,
    // Expensive
    shapeDetail: false,
    // Expensive
    turbulence: false,
    // Expensive
    clouds: {
      ...defaults.clouds,
      accurateSunSkyLight: false,
      // Greatly reduces texel reads.
      maxIterationCount: 200,
      minStepSize: 100,
      maxRayDistance: 1e5,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      minTransmittance: 0.1,
      // Makes the primary march terminate earlier.
      maxIterationCountToGround: 0,
      // Expensive
      maxIterationCountToSun: 1
      // Only 1 march makes big difference
    },
    shadow: {
      ...defaults.shadow,
      maxIterationCount: 25,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      minTransmittance: 0.01,
      // Makes the primary march terminate earlier.
      cascadeCount: 2,
      // Obvious
      mapSize: /* @__PURE__ */ new Vector23(256, 256)
      // Obvious
    }
  },
  medium: {
    ...defaults,
    lightShafts: false,
    // Expensive
    turbulence: false,
    // Expensive
    clouds: {
      ...defaults.clouds,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      accurateSunSkyLight: false,
      maxIterationCountToSun: 2,
      maxIterationCountToGround: 1
    },
    shadow: {
      ...defaults.shadow,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      mapSize: /* @__PURE__ */ new Vector23(256, 256)
    }
  },
  high: defaults,
  // Consider high quality preset as default.
  ultra: {
    ...defaults,
    clouds: {
      ...defaults.clouds,
      minStepSize: 10
    },
    shadow: {
      ...defaults.shadow,
      mapSize: /* @__PURE__ */ new Vector23(1024, 1024)
    }
  }
};

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/clouds.frag
var clouds_default = `precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;

#include <common>
#include <packing>

#include "core/depth"
#include "core/math"
#include "core/turbo"
#include "core/generators"
#include "core/raySphereIntersection"
#include "core/cascadedShadowMaps"
#include "core/interleavedGradientNoise"
#include "core/vogelDisk"

#include "atmosphere/bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "atmosphere/bruneton/common"
#include "atmosphere/bruneton/runtime"

#include "types"
#include "parameters"
#include "clouds"

#if !defined(RECIPROCAL_PI4)
#define RECIPROCAL_PI4 0.07957747154594767
#endif // !defined(RECIPROCAL_PI4)

uniform sampler2D depthBuffer;
uniform mat4 viewMatrix;
uniform mat4 reprojectionMatrix;
uniform mat4 viewReprojectionMatrix;
uniform float cameraNear;
uniform float cameraFar;
uniform float cameraHeight;
uniform vec2 temporalJitter;
uniform vec2 targetUvScale;
uniform float mipLevelScale;

// Scattering
const vec2 scatterAnisotropy = vec2(SCATTER_ANISOTROPY_1, SCATTER_ANISOTROPY_2);
const float scatterAnisotropyMix = SCATTER_ANISOTROPY_MIX;
uniform float skyLightScale;
uniform float groundBounceScale;
uniform float powderScale;
uniform float powderExponent;

// Primary raymarch
uniform int maxIterationCount;
uniform float minStepSize;
uniform float maxStepSize;
uniform float maxRayDistance;
uniform float perspectiveStepScale;

// Secondary raymarch
uniform int maxIterationCountToSun;
uniform int maxIterationCountToGround;
uniform float minSecondaryStepSize;
uniform float secondaryStepScale;

// Beer shadow map
uniform sampler2DArray shadowBuffer;
uniform vec2 shadowTexelSize;
uniform vec2 shadowIntervals[SHADOW_CASCADE_COUNT];
uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT];
uniform float shadowFar;
uniform float maxShadowFilterRadius;

// Shadow length
#ifdef SHADOW_LENGTH
uniform int maxShadowLengthIterationCount;
uniform float minShadowLengthStepSize;
uniform float maxShadowLengthRayDistance;
#endif // SHADOW_LENGTH

in vec2 vUv;
in vec3 vCameraPosition;
in vec3 vCameraDirection; // Direction to the center of screen
in vec3 vRayDirection; // Direction to the texel
in vec3 vViewPosition;
in GroundIrradiance vGroundIrradiance;
in CloudsIrradiance vCloudsIrradiance;

layout(location = 0) out vec4 outputColor;
layout(location = 1) out vec3 outputDepthVelocity;
#ifdef SHADOW_LENGTH
layout(location = 2) out float outputShadowLength;
#endif // SHADOW_LENGTH

float getViewZ(const float depth) {
  #ifdef PERSPECTIVE_CAMERA
  return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  #else // PERSPECTIVE_CAMERA
  return orthographicDepthToViewZ(depth, cameraNear, cameraFar);
  #endif // PERSPECTIVE_CAMERA
}

vec3 ecefToWorld(const vec3 positionECEF) {
  return (ecefToWorldMatrix * vec4(positionECEF - altitudeCorrection, 1.0)).xyz;
}

vec2 getShadowUv(const vec3 worldPosition, const int cascadeIndex) {
  vec4 clip = shadowMatrices[cascadeIndex] * vec4(worldPosition, 1.0);
  clip /= clip.w;
  return clip.xy * 0.5 + 0.5;
}

float getDistanceToShadowTop(const vec3 rayPosition) {
  // Distance to the top of the shadows along the sun direction, which matches
  // the ray origin of BSM.
  return raySphereSecondIntersection(
    rayPosition,
    sunDirection,
    vec3(0.0),
    bottomRadius + shadowTopHeight
  );
}

#ifdef DEBUG_SHOW_CASCADES

const vec3 cascadeColors[4] = vec3[4](
  vec3(1.0, 0.0, 0.0),
  vec3(0.0, 1.0, 0.0),
  vec3(0.0, 0.0, 1.0),
  vec3(1.0, 1.0, 0.0)
);

vec3 getCascadeColor(const vec3 rayPosition) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar
  );
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec3(1.0);
  }
  return cascadeColors[cascadeIndex];
}

vec3 getFadedCascadeColor(const vec3 rayPosition, const float jitter) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? cascadeColors[cascadeIndex]
    : vec3(1.0);
}

#endif // DEBUG_SHOW_CASCADES

float readShadowOpticalDepth(
  const vec2 uv,
  const float distanceToTop,
  const float distanceOffset,
  const int cascadeIndex
) {
  // r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
  // Also see the discussion here: https://x.com/shotamatsuda/status/1885322308908442106
  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));
  float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);
  return min(shadow.b + shadow.a, shadow.g * distanceToFront);
}

float sampleShadowOpticalDepthPCF(
  const vec3 worldPosition,
  const float distanceToTop,
  const float distanceOffset,
  const float radius,
  const int cascadeIndex
) {
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  if (radius < 0.1) {
    return readShadowOpticalDepth(uv, distanceToTop, distanceOffset, cascadeIndex);
  }
  float sum = 0.0;
  vec2 offset;
  #pragma unroll_loop_start
  for (int i = 0; i < 16; ++i) {
    #if UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
    offset = vogelDisk(
      UNROLLED_LOOP_INDEX,
      SHADOW_SAMPLE_COUNT,
      interleavedGradientNoise(gl_FragCoord.xy + temporalJitter * resolution) * PI2
    );
    sum += readShadowOpticalDepth(
      uv + offset * radius * shadowTexelSize,
      distanceToTop,
      distanceOffset,
      cascadeIndex
    );
    #endif // UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
  }
  #pragma unroll_loop_end
  return sum / float(SHADOW_SAMPLE_COUNT);
}

float sampleShadowOpticalDepth(
  const vec3 rayPosition,
  const float distanceOffset,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(rayPosition);
  if (distanceToTop <= 0.0) {
    return 0.0;
  }
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(
      worldPosition,
      distanceToTop,
      distanceOffset,
      radius,
      cascadeIndex
    )
    : 0.0;
}

#ifdef DEBUG_SHOW_SHADOW_MAP
vec4 getCascadedShadowMaps(vec2 uv) {
  vec4 coord = vec4(vUv, vUv - 0.5) * 2.0;
  vec4 shadow = vec4(0.0);
  if (uv.y > 0.5) {
    if (uv.x < 0.5) {
      shadow = texture(shadowBuffer, vec3(coord.xw, 0.0));
    } else {
      #if SHADOW_CASCADE_COUNT > 1
      shadow = texture(shadowBuffer, vec3(coord.zw, 1.0));
      #endif // SHADOW_CASCADE_COUNT > 1
    }
  } else {
    if (uv.x < 0.5) {
      #if SHADOW_CASCADE_COUNT > 2
      shadow = texture(shadowBuffer, vec3(coord.xy, 2.0));
      #endif // SHADOW_CASCADE_COUNT > 2
    } else {
      #if SHADOW_CASCADE_COUNT > 3
      shadow = texture(shadowBuffer, vec3(coord.zy, 3.0));
      #endif // SHADOW_CASCADE_COUNT > 3
    }
  }

  #if !defined(DEBUG_SHOW_SHADOW_MAP_TYPE)
  #define DEBUG_SHOW_SHADOW_MAP_TYPE 0
  #endif // !defined(DEBUG_SHOW_SHADOW_MAP_TYPE

  const float frontDepthScale = 1e-5;
  const float meanExtinctionScale = 10.0;
  const float maxOpticalDepthScale = 0.01;
  vec3 color;
  #if DEBUG_SHOW_SHADOW_MAP_TYPE == 1
  color = vec3(shadow.r * frontDepthScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 2
  color = vec3(shadow.g * meanExtinctionScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 3
  color = vec3((shadow.b + shadow.a) * maxOpticalDepthScale);
  #else // DEBUG_SHOW_SHADOW_MAP_TYPE
  color =
    (shadow.rgb + vec3(0.0, 0.0, shadow.a)) *
    vec3(frontDepthScale, meanExtinctionScale, maxOpticalDepthScale);
  #endif // DEBUG_SHOW_SHADOW_MAP_TYPE
  return vec4(color, 1.0);
}
#endif // DEBUG_SHOW_SHADOW_MAP

vec2 henyeyGreenstein(const vec2 g, const float cosTheta) {
  vec2 g2 = g * g;
  // prettier-ignore
  return RECIPROCAL_PI4 *
    ((1.0 - g2) / max(vec2(1e-7), pow(1.0 + g2 - 2.0 * g * cosTheta, vec2(1.5))));
}

#ifdef ACCURATE_PHASE_FUNCTION

float draine(float u, float g, float a) {
  float g2 = g * g;
  // prettier-ignore
  return (1.0 - g2) *
    (1.0 + a * u * u) /
    (4.0 * (1.0 + a * (1.0 + 2.0 * g2) / 3.0) * PI * pow(1.0 + g2 - 2.0 * g * u, 1.5));
}

// Numerically-fitted large particles (d=10) phase function It won't be
// plausible without a more precise multiple scattering.
// Reference: https://research.nvidia.com/labs/rtr/approximate-mie/
float phaseFunction(const float cosTheta, const float attenuation) {
  const float gHG = 0.988176691700256; // exp(-0.0990567/(d-1.67154))
  const float gD = 0.5556712547839497; // exp(-2.20679/(d+3.91029) - 0.428934)
  const float alpha = 21.995520856274638; // exp(3.62489 - 8.29288/(d+5.52825))
  const float weight = 0.4819554318404214; // exp(-0.599085/(d-0.641583)-0.665888)
  return mix(
    henyeyGreenstein(vec2(gHG) * attenuation, cosTheta).x,
    draine(cosTheta, gD * attenuation, alpha),
    weight
  );
}

#else // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta, const float attenuation) {
  const vec2 g = scatterAnisotropy;
  const vec2 weights = vec2(1.0 - scatterAnisotropyMix, scatterAnisotropyMix);
  // A similar approximation is described in the Frostbite's paper, where phase
  // angle is attenuated instead of anisotropy.
  return dot(henyeyGreenstein(g * attenuation, cosTheta), weights);
}

#endif // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta) {
  return phaseFunction(cosTheta, 1.0);
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int maxIterationCount,
  const float mipLevel,
  const float jitter,
  out float rayDistance
) {
  int iterationCount = int(
    max(0.0, remap(mipLevel, 0.0, 1.0, float(maxIterationCount + 1), 1.0) - jitter)
  );
  if (iterationCount == 0) {
    // Fudge factor to approximate the mean optical depth.
    // TODO: Remove it.
    return 0.5;
  }
  float stepSize = minSecondaryStepSize / float(iterationCount);
  float nextDistance = stepSize * jitter;
  float opticalDepth = 0.0;
  for (int i = 0; i < iterationCount; ++i) {
    rayDistance = nextDistance;
    vec3 position = rayDistance * rayDirection + rayOrigin;
    vec2 uv = getGlobeUv(position);
    float height = length(position) - bottomRadius;
    WeatherSample weather = sampleWeather(uv, height, mipLevel);
    MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter);
    opticalDepth += media.extinction * stepSize;
    nextDistance += stepSize;
    stepSize *= secondaryStepScale;
  }
  return opticalDepth;
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int maxIterationCount,
  const float mipLevel,
  const float jitter
) {
  float rayDistance;
  return marchOpticalDepth(
    rayOrigin,
    rayDirection,
    maxIterationCount,
    mipLevel,
    jitter,
    rayDistance
  );
}

float approximateMultipleScattering(const float opticalDepth, const float cosTheta) {
  // Multiple scattering approximation
  // See: https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf
  // a: attenuation, b: contribution, c: phase attenuation
  vec3 coeffs = vec3(1.0); // [a, b, c]
  const vec3 attenuation = vec3(0.5, 0.5, 0.5); // Should satisfy a <= b
  float scattering = 0.0;
  float beerLambert;
  #pragma unroll_loop_start
  for (int i = 0; i < 12; ++i) {
    #if UNROLLED_LOOP_INDEX < MULTI_SCATTERING_OCTAVES
    beerLambert = exp(-opticalDepth * coeffs.y);
    scattering += coeffs.x * beerLambert * phaseFunction(cosTheta, coeffs.z);
    coeffs *= attenuation;
    #endif // UNROLLED_LOOP_INDEX < MULTI_SCATTERING_OCTAVES
  }
  #pragma unroll_loop_end
  return scattering;
}

// TODO: Construct spherical harmonics of degree 2 using 2 sample points
// positioned near the horizon occlusion points on the sun direction plane.
vec3 getGroundSunSkyIrradiance(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  out vec3 skyIrradiance
) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyIrradiance(
    (position - surfaceNormal * height) * METER_TO_LENGTH_UNIT,
    surfaceNormal,
    sunDirection,
    skyIrradiance
  );
  #else // ACCURATE_SUN_SKY_LIGHT
  skyIrradiance = vGroundIrradiance.sky;
  return vGroundIrradiance.sun;
  #endif // ACCURATE_SUN_SKY_LIGHT
}

vec3 getCloudsSunSkyIrradiance(const vec3 position, const float height, out vec3 skyIrradiance) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyScalarIrradiance(position * METER_TO_LENGTH_UNIT, sunDirection, skyIrradiance);
  #else // ACCURATE_SUN_SKY_LIGHT
  float alpha = remapClamped(height, minHeight, maxHeight);
  skyIrradiance = mix(vCloudsIrradiance.minSky, vCloudsIrradiance.maxSky, alpha);
  return mix(vCloudsIrradiance.minSun, vCloudsIrradiance.maxSun, alpha);
  #endif // ACCURATE_SUN_SKY_LIGHT
}

#ifdef GROUND_BOUNCE
vec3 approximateRadianceFromGround(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  const float mipLevel,
  const float jitter
) {
  float opticalDepthToGround = marchOpticalDepth(
    position,
    -surfaceNormal,
    maxIterationCountToGround,
    mipLevel,
    jitter
  );
  vec3 skyIrradiance;
  vec3 sunIrradiance = getGroundSunSkyIrradiance(position, surfaceNormal, height, skyIrradiance);
  const float groundAlbedo = 0.3;
  vec3 groundIrradiance = skyIrradiance + (1.0 - coverage) * sunIrradiance;
  vec3 bouncedRadiance = groundAlbedo * RECIPROCAL_PI * groundIrradiance;
  return bouncedRadiance * exp(-opticalDepthToGround);
}
#endif // GROUND_BOUNCE

vec4 marchClouds(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float cosTheta,
  const float jitter,
  const float rayStartTexelsPerPixel,
  out float frontDepth,
  out ivec3 sampleCount
) {
  vec3 radianceIntegral = vec3(0.0);
  float transmittanceIntegral = 1.0;
  float weightedDistanceSum = 0.0;
  float transmittanceSum = 0.0;

  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;
  // I don't understand why spatial aliasing remains unless doubling the jitter.
  float rayDistance = stepSize * jitter * 2.0;

  for (int i = 0; i < maxIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }

    vec3 position = rayDistance * rayDirection + rayOrigin;
    float height = length(position) - bottomRadius;
    float mipLevel = log2(max(1.0, rayStartTexelsPerPixel + rayDistance * 1e-5));

    #if !defined(DEBUG_MARCH_INTERVALS)
    if (insideLayerIntervals(height)) {
      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;
    }
    #endif // !defined(DEBUG_MARCH_INTERVALS)

    // Sample rough weather.
    vec2 uv = getGlobeUv(position);
    WeatherSample weather = sampleWeather(uv, height, mipLevel);

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    ++sampleCount.x;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    if (!any(greaterThan(weather.density, vec4(minDensity)))) {
      // Step longer in empty space.
      // TODO: This produces banding artifacts.
      // Possible improvement: Binary search refinement
      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;
    }

    // Sample detailed participating media.
    MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter, sampleCount);

    if (media.extinction > minExtinction) {
      vec3 skyIrradiance;
      vec3 sunIrradiance = getCloudsSunSkyIrradiance(position, height, skyIrradiance);
      vec3 surfaceNormal = normalize(position);

      // March optical depth to the sun for finer details, which BSM lacks.
      float sunRayDistance = 0.0;
      float opticalDepth = marchOpticalDepth(
        position,
        sunDirection,
        maxIterationCountToSun,
        mipLevel,
        jitter,
        sunRayDistance
      );

      if (height < shadowTopHeight) {
        // Obtain the optical depth from BSM at the ray position.
        opticalDepth += sampleShadowOpticalDepth(
          position,
          // Take account of only positions further than the marched ray
          // distance.
          sunRayDistance,
          // Apply PCF only when the sun is close to the horizon.
          maxShadowFilterRadius * remapClamped(dot(sunDirection, surfaceNormal), 0.1, 0.0),
          jitter
        );
      }

      vec3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);

      #ifdef GROUND_BOUNCE
      // Fudge factor for the irradiance from ground.
      if (height < shadowTopHeight && mipLevel < 0.5) {
        vec3 groundRadiance = approximateRadianceFromGround(
          position,
          surfaceNormal,
          height,
          mipLevel,
          jitter
        );
        radiance += groundRadiance * RECIPROCAL_PI4 * groundBounceScale;
      }
      #endif // GROUND_BOUNCE

      // Crude approximation of sky gradient. Better than none in the shadows.
      float skyGradient = dot(weather.heightFraction * 0.5 + 0.5, media.weight);
      radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;

      // Finally multiply by scattering.
      radiance *= media.scattering;

      #ifdef POWDER
      radiance *= 1.0 - powderScale * exp(-media.extinction * powderExponent);
      #endif // POWDER

      #ifdef DEBUG_SHOW_CASCADES
      if (height < shadowTopHeight) {
        radiance = 1e-3 * getFadedCascadeColor(position, jitter);
      }
      #endif // DEBUG_SHOW_CASCADES

      // Energy-conserving analytical integration of scattered light
      // See 5.6.3 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      float transmittance = exp(-media.extinction * stepSize);
      float clampedExtinction = max(media.extinction, 1e-7);
      vec3 scatteringIntegral = (radiance - radiance * transmittance) / clampedExtinction;
      radianceIntegral += transmittanceIntegral * scatteringIntegral;
      transmittanceIntegral *= transmittance;

      // Aerial perspective affecting clouds
      // See 5.9.1 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      weightedDistanceSum += rayDistance * transmittanceIntegral;
      transmittanceSum += transmittanceIntegral;
    }

    if (transmittanceIntegral <= minTransmittance) {
      break; // Early termination
    }

    // Take a shorter step because we've already hit the clouds.
    stepSize *= perspectiveStepScale;
    rayDistance += stepSize;
  }

  // The final product of 5.9.1 and we'll evaluate this in aerial perspective.
  frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;

  return vec4(radianceIntegral, remapClamped(transmittanceIntegral, 1.0, minTransmittance));
}

#ifdef SHADOW_LENGTH

float marchShadowLength(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float jitter
) {
  float shadowLength = 0.0;
  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  float stepSize = minShadowLengthStepSize;
  float rayDistance = stepSize * jitter;
  const float attenuationFactor = 1.0 - 5e-4;
  float attenuation = 1.0;

  // TODO: This march is closed, and sample resolution can be much lower.
  // Refining the termination by binary search will make it much more efficient.
  for (int i = 0; i < maxShadowLengthIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }
    vec3 position = rayDistance * rayDirection + rayOrigin;
    float opticalDepth = sampleShadowOpticalDepth(position, 0.0, 0.0, jitter);
    shadowLength += (1.0 - exp(-opticalDepth)) * stepSize * attenuation;
    stepSize *= perspectiveStepScale;
    rayDistance += stepSize;
  }
  return shadowLength;
}

#endif // SHADOW_LENGTH

#ifdef HAZE

vec4 approximateHaze(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const float maxRayDistance,
  const float cosTheta,
  const float shadowLength
) {
  float modulation = remapClamped(coverage, 0.2, 0.4);
  if (cameraHeight * modulation < 0.0) {
    return vec4(0.0);
  }
  float density = modulation * hazeDensityScale * exp(-cameraHeight * hazeExponent);
  if (density < 1e-7) {
    return vec4(0.0); // Prevent artifact in views from space
  }

  // Blend two normals by the difference in angle so that normal near the
  // ground becomes that of the origin, and in the sky that of the horizon.
  vec3 normalAtOrigin = normalize(rayOrigin);
  vec3 normalAtHorizon = (rayOrigin - dot(rayOrigin, rayDirection) * rayDirection) / bottomRadius;
  float alpha = remapClamped(dot(normalAtOrigin, normalAtHorizon), 0.9, 1.0);
  vec3 normal = mix(normalAtOrigin, normalAtHorizon, alpha);

  // Analytical optical depth where density exponentially decreases with height.
  // Based on: https://iquilezles.org/articles/fog/
  float angle = max(dot(normal, rayDirection), 1e-5);
  float exponent = angle * hazeExponent;
  float linearTerm = density / hazeExponent / angle;

  // Derive the optical depths separately for with and without shadow length.
  float expTerm = 1.0 - exp(-maxRayDistance * exponent);
  float shadowExpTerm = 1.0 - exp(-min(maxRayDistance, shadowLength) * exponent);
  float opticalDepth = expTerm * linearTerm;
  float shadowOpticalDepth = max((expTerm - shadowExpTerm) * linearTerm, 0.0);
  float transmittance = saturate(1.0 - exp(-opticalDepth));
  float shadowTransmittance = saturate(1.0 - exp(-shadowOpticalDepth));

  vec3 skyIrradiance = vGroundIrradiance.sky;
  vec3 sunIrradiance = vGroundIrradiance.sun;
  vec3 inscatter = sunIrradiance * phaseFunction(cosTheta) * shadowTransmittance;
  inscatter += skyIrradiance * RECIPROCAL_PI4 * skyLightScale * transmittance;
  inscatter *= hazeScatteringCoefficient / (hazeAbsorptionCoefficient + hazeScatteringCoefficient);
  return vec4(inscatter, transmittance);
}

#endif // HAZE

void applyAerialPerspective(
  const vec3 cameraPosition,
  const vec3 frontPosition,
  const float shadowLength,
  inout vec4 color
) {
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(
    cameraPosition * METER_TO_LENGTH_UNIT,
    frontPosition * METER_TO_LENGTH_UNIT,
    shadowLength * METER_TO_LENGTH_UNIT,
    sunDirection,
    transmittance
  );
  color.rgb = color.rgb * transmittance + inscatter * color.a;
}

bool rayIntersectsGround(const vec3 cameraPosition, const vec3 rayDirection) {
  float r = length(cameraPosition);
  float mu = dot(cameraPosition, rayDirection) / r;
  return mu < 0.0 && r * r * (mu * mu - 1.0) + bottomRadius * bottomRadius >= 0.0;
}

struct IntersectionResult {
  bool ground;
  vec4 first;
  vec4 second;
};

IntersectionResult getIntersections(const vec3 cameraPosition, const vec3 rayDirection) {
  IntersectionResult intersections;
  intersections.ground = rayIntersectsGround(cameraPosition, rayDirection);
  raySphereIntersections(
    cameraPosition,
    rayDirection,
    bottomRadius + vec4(0.0, minHeight, maxHeight, shadowTopHeight),
    intersections.first,
    intersections.second
  );
  return intersections;
}

vec2 getRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < minHeight) {
    // View below the clouds
    if (intersections.ground) {
      nearFar = vec2(-1.0); // No clouds to the ground
    } else {
      nearFar = vec2(intersections.second.y, intersections.second.z);
      nearFar.y = min(nearFar.y, maxRayDistance);
    }
  } else if (cameraHeight < maxHeight) {
    // View inside the total cloud layer
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.y);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
  } else {
    // View above the clouds
    nearFar = vec2(intersections.first.z, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the min height.
      nearFar.y = intersections.first.y;
    }
  }
  return nearFar;
}

#ifdef SHADOW_LENGTH
vec2 getShadowRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < shadowTopHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.w);
    }
  } else {
    nearFar = vec2(intersections.first.w, intersections.second.w);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  nearFar.y = min(nearFar.y, maxShadowLengthRayDistance);
  return nearFar;
}
#endif // SHADOW_LENGTH

#ifdef HAZE
vec2 getHazeRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < maxHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
  } else {
    nearFar = vec2(cameraNear, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  return nearFar;
}
#endif // HAZE

float getRayDistanceToScene(const vec3 rayDirection, out float viewZ) {
  float depth = readDepthValue(depthBuffer, vUv * targetUvScale + temporalJitter);
  if (depth < 1.0 - 1e-7) {
    depth = reverseLogDepth(depth, cameraNear, cameraFar);
    viewZ = getViewZ(depth);
    return -viewZ / dot(rayDirection, vCameraDirection);
  }
  viewZ = 0.0;
  return 0.0;
}

void main() {
  #ifdef DEBUG_SHOW_SHADOW_MAP
  outputColor = getCascadedShadowMaps(vUv);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_SHADOW_MAP

  vec3 cameraPosition = vCameraPosition + altitudeCorrection;
  vec3 rayDirection = normalize(vRayDirection);
  float cosTheta = dot(sunDirection, rayDirection);

  IntersectionResult intersections = getIntersections(cameraPosition, rayDirection);
  vec2 rayNearFar = getRayNearFar(intersections);
  #ifdef SHADOW_LENGTH
  vec2 shadowRayNearFar = getShadowRayNearFar(intersections);
  #endif // SHADOW_LENGTH
  #ifdef HAZE
  vec2 hazeRayNearFar = getHazeRayNearFar(intersections);
  #endif // HAZE

  float sceneViewZ;
  float rayDistanceToScene = getRayDistanceToScene(rayDirection, sceneViewZ);
  if (rayDistanceToScene > 0.0) {
    rayNearFar.y = min(rayNearFar.y, rayDistanceToScene);
    #ifdef SHADOW_LENGTH
    shadowRayNearFar.y = min(shadowRayNearFar.y, rayDistanceToScene);
    #endif // SHADOW_LENGTH
    #ifdef HAZE
    hazeRayNearFar.y = min(hazeRayNearFar.y, rayDistanceToScene);
    #endif // HAZE
  }

  bool intersectsGround = any(lessThan(rayNearFar, vec2(0.0)));
  bool intersectsScene = rayNearFar.y < rayNearFar.x;

  float stbn = getSTBN();

  vec4 color = vec4(0.0);
  float frontDepth = rayNearFar.y;
  vec3 depthVelocity = vec3(0.0);
  float shadowLength = 0.0;
  bool hitClouds = false;

  if (!intersectsGround && !intersectsScene) {
    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;

    vec2 globeUv = getGlobeUv(rayOrigin);
    #ifdef DEBUG_SHOW_UV
    outputColor = vec4(vec3(checker(globeUv, localWeatherRepeat + localWeatherOffset)), 1.0);
    outputDepthVelocity = vec3(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_UV

    float mipLevel = getMipLevel(globeUv * localWeatherRepeat) * mipLevelScale;
    mipLevel = mix(0.0, mipLevel, min(1.0, 0.2 * cameraHeight / maxHeight));

    float marchedFrontDepth;
    ivec3 sampleCount = ivec3(0);
    color = marchClouds(
      rayOrigin,
      rayDirection,
      rayNearFar,
      cosTheta,
      stbn,
      pow(2.0, mipLevel),
      marchedFrontDepth,
      sampleCount
    );

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    outputColor = vec4(vec3(sampleCount) / vec3(500.0, 5.0, 5.0), 1.0);
    outputDepthVelocity = vec3(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    // Front depth will be -1.0 when no samples are accumulated.
    hitClouds = marchedFrontDepth >= 0.0;
    if (hitClouds) {
      frontDepth = rayNearFar.x + marchedFrontDepth;

      #ifdef SHADOW_LENGTH
      // Clamp the shadow length ray at the clouds.
      shadowRayNearFar.y = mix(
        shadowRayNearFar.y,
        min(frontDepth, shadowRayNearFar.y),
        color.a // Interpolate by the alpha for smoother edges.
      );

      // Shadow length must be computed before applying aerial perspective.
      if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {
        shadowLength = marchShadowLength(
          shadowRayNearFar.x * rayDirection + cameraPosition,
          rayDirection,
          shadowRayNearFar,
          stbn
        );
      }
      #endif // SHADOW_LENGTH

      #ifdef HAZE
      // Clamp the haze ray at the clouds.
      hazeRayNearFar.y = mix(
        hazeRayNearFar.y,
        min(frontDepth, hazeRayNearFar.y),
        color.a // Interpolate by the alpha for smoother edges.
      );
      #endif // HAZE

      // Apply aerial perspective.
      vec3 frontPosition = cameraPosition + frontDepth * rayDirection;
      applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);

      // Velocity for temporal resolution.
      vec3 frontPositionWorld = ecefToWorld(frontPosition);
      vec4 prevClip = reprojectionMatrix * vec4(frontPositionWorld, 1.0);
      prevClip /= prevClip.w;
      vec2 prevUv = prevClip.xy * 0.5 + 0.5;
      vec2 velocity = vUv - prevUv;
      depthVelocity = vec3(frontDepth, velocity);
    }
  }

  if (!hitClouds) {
    #ifdef SHADOW_LENGTH
    if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {
      shadowLength = marchShadowLength(
        shadowRayNearFar.x * rayDirection + cameraPosition,
        rayDirection,
        shadowRayNearFar,
        stbn
      );
    }
    #endif // SHADOW_LENGTH

    // Velocity for temporal resolution. Here reproject in the view space for
    // greatly reducing the precision errors.
    frontDepth = sceneViewZ < 0.0 ? -sceneViewZ : cameraFar;
    vec3 frontView = vViewPosition * frontDepth;
    vec4 prevClip = viewReprojectionMatrix * vec4(frontView, 1.0);
    prevClip /= prevClip.w;
    vec2 prevUv = prevClip.xy * 0.5 + 0.5;
    vec2 velocity = vUv - prevUv;
    depthVelocity = vec3(frontDepth, velocity);
  }

  #ifdef DEBUG_SHOW_FRONT_DEPTH
  outputColor = vec4(turbo(frontDepth / maxRayDistance), 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_FRONT_DEPTH

  #ifdef HAZE
  vec4 haze = approximateHaze(
    cameraNear * rayDirection + cameraPosition,
    rayDirection,
    hazeRayNearFar.y - hazeRayNearFar.x,
    cosTheta,
    shadowLength
  );
  color.rgb = mix(color.rgb, haze.rgb, haze.a);
  color.a = color.a * (1.0 - haze.a) + haze.a;
  #endif // HAZE

  outputColor = color;
  outputDepthVelocity = depthVelocity;
  #ifdef SHADOW_LENGTH
  outputShadowLength = shadowLength * METER_TO_LENGTH_UNIT;
  #endif // SHADOW_LENGTH
}
`;

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/clouds.glsl
var clouds_default2 = "float getSTBN() {\n  ivec3 size = textureSize(stbnTexture, 0);\n  vec3 scale = 1.0 / vec3(size);\n  return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;\n}\n\n// Straightforward spherical mapping\nvec2 getSphericalUv(const vec3 position) {\n  vec2 st = normalize(position.yx);\n  float phi = atan(st.x, st.y);\n  float theta = asin(normalize(position).z);\n  return vec2(phi * RECIPROCAL_PI2 + 0.5, theta * RECIPROCAL_PI + 0.5);\n}\n\nvec2 getCubeSphereUv(const vec3 position) {\n  // Cube-sphere relaxation by: http://mathproofs.blogspot.com/2005/07/mapping-cube-to-sphere.html\n  // TODO: Tile and fix seams.\n  // Possible improvements:\n  // https://iquilezles.org/articles/texturerepetition/\n  // https://gamedev.stackexchange.com/questions/184388/fragment-shader-map-dot-texture-repeatedly-over-the-sphere\n  // https://github.com/mmikk/hextile-demo\n\n  vec3 n = normalize(position);\n  vec3 f = abs(n);\n  vec3 c = n / max(f.x, max(f.y, f.z));\n  vec2 m;\n  if (all(greaterThan(f.yy, f.xz))) {\n    m = c.y > 0.0 ? vec2(-n.x, n.z) : n.xz;\n  } else if (all(greaterThan(f.xx, f.yz))) {\n    m = c.x > 0.0 ? n.yz : vec2(-n.y, n.z);\n  } else {\n    m = c.z > 0.0 ? n.xy : vec2(n.x, -n.y);\n  }\n\n  vec2 m2 = m * m;\n  float q = dot(m2.xy, vec2(-2.0, 2.0)) - 3.0;\n  float q2 = q * q;\n  vec2 uv;\n  uv.x = sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(-24.0 * m2.x + q2)) * (m.x > 0.0 ? 1.0 : -1.0);\n  uv.y = sqrt(6.0 / (3.0 - uv.x * uv.x)) * m.y;\n  return uv * 0.5 + 0.5;\n}\n\nvec2 getGlobeUv(const vec3 position) {\n  return getCubeSphereUv(position);\n}\n\nfloat getMipLevel(const vec2 uv) {\n  const float mipLevelScale = 0.1;\n  vec2 coord = uv * resolution;\n  vec2 ddx = dFdx(coord);\n  vec2 ddy = dFdy(coord);\n  float deltaMaxSqr = max(dot(ddx, ddx), dot(ddy, ddy)) * mipLevelScale;\n  return max(0.0, 0.5 * log2(max(1.0, deltaMaxSqr)));\n}\n\nbool insideLayerIntervals(const float height) {\n  bvec3 gt = greaterThan(vec3(height), minIntervalHeights);\n  bvec3 lt = lessThan(vec3(height), maxIntervalHeights);\n  return any(bvec3(gt.x && lt.x, gt.y && lt.y, gt.z && lt.z));\n}\n\nstruct WeatherSample {\n  vec4 heightFraction; // Normalized height of each layer\n  vec4 density;\n};\n\nvec4 shapeAlteringFunction(const vec4 heightFraction, const vec4 bias) {\n  // Apply a semi-circle transform to round the clouds towards the top.\n  vec4 biased = pow(heightFraction, bias);\n  vec4 x = clamp(biased * 2.0 - 1.0, -1.0, 1.0);\n  return 1.0 - x * x;\n}\n\nWeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel) {\n  WeatherSample weather;\n  weather.heightFraction = remapClamped(vec4(height), minLayerHeights, maxLayerHeights);\n\n  vec4 localWeather = pow(\n    textureLod(\n      localWeatherTexture,\n      uv * localWeatherRepeat + localWeatherOffset,\n      mipLevel\n    ).LOCAL_WEATHER_CHANNELS,\n    weatherExponents\n  );\n  #ifdef SHADOW\n  localWeather *= shadowLayerMask;\n  #endif // SHADOW\n\n  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);\n\n  // Modulation to control weather by coverage parameter.\n  // Reference: https://github.com/Prograda/Skybolt/blob/master/Assets/Core/Shaders/Clouds.h#L63\n  vec4 factor = 1.0 - coverage * heightScale;\n  weather.density = remapClamped(\n    mix(localWeather, vec4(1.0), coverageFilterWidths),\n    factor,\n    factor + coverageFilterWidths\n  );\n\n  return weather;\n}\n\nvec4 getLayerDensity(const vec4 heightFraction) {\n  // prettier-ignore\n  return densityProfile.expTerms * exp(densityProfile.exponents * heightFraction) +\n    densityProfile.linearTerms * heightFraction +\n    densityProfile.constantTerms;\n}\n\nstruct MediaSample {\n  float density;\n  vec4 weight;\n  float scattering;\n  float extinction;\n};\n\nMediaSample sampleMedia(\n  const WeatherSample weather,\n  const vec3 position,\n  const vec2 uv,\n  const float mipLevel,\n  const float jitter,\n  out ivec3 sampleCount\n) {\n  vec4 density = weather.density;\n\n  // TODO: Define in physical length.\n  vec3 surfaceNormal = normalize(position);\n  float localWeatherSpeed = length(localWeatherOffset);\n  vec3 evolution = -surfaceNormal * localWeatherSpeed * 2e4;\n\n  vec3 turbulence = vec3(0.0);\n  #ifdef TURBULENCE\n  vec2 turbulenceUv = uv * localWeatherRepeat * turbulenceRepeat;\n  turbulence =\n    turbulenceDisplacement *\n    (texture(turbulenceTexture, turbulenceUv).rgb * 2.0 - 1.0) *\n    dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));\n  #endif // TURBULENCE\n\n  vec3 shapePosition = (position + evolution + turbulence) * shapeRepeat + shapeOffset;\n  float shape = texture(shapeTexture, shapePosition).r;\n  density = remapClamped(density, vec4(1.0 - shape) * shapeAmounts, vec4(1.0));\n\n  #ifdef DEBUG_SHOW_SAMPLE_COUNT\n  ++sampleCount.y;\n  #endif // DEBUG_SHOW_SAMPLE_COUNT\n\n  #ifdef SHAPE_DETAIL\n  if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {\n    vec3 detailPosition = (position + turbulence) * shapeDetailRepeat + shapeDetailOffset;\n    float detail = texture(shapeDetailTexture, detailPosition).r;\n    // Fluffy at the top and whippy at the bottom.\n    vec4 modifier = mix(\n      vec4(pow(detail, 6.0)),\n      vec4(1.0 - detail),\n      remapClamped(weather.heightFraction, vec4(0.2), vec4(0.4))\n    );\n    modifier = mix(vec4(0.0), modifier, shapeDetailAmounts);\n    density = remapClamped(density * 2.0, vec4(modifier * 0.5), vec4(1.0));\n\n    #ifdef DEBUG_SHOW_SAMPLE_COUNT\n    ++sampleCount.z;\n    #endif // DEBUG_SHOW_SAMPLE_COUNT\n  }\n  #endif // SHAPE_DETAIL\n\n  // Apply the density profiles.\n  density = saturate(density * densityScales * getLayerDensity(weather.heightFraction));\n\n  MediaSample media;\n  float densitySum = density.x + density.y + density.z + density.w;\n  media.weight = density / densitySum;\n  media.scattering = densitySum * scatteringCoefficient;\n  media.extinction = densitySum * absorptionCoefficient + media.scattering;\n  return media;\n}\n\nMediaSample sampleMedia(\n  const WeatherSample weather,\n  const vec3 position,\n  const vec2 uv,\n  const float mipLevel,\n  const float jitter\n) {\n  ivec3 sampleCount;\n  return sampleMedia(weather, position, uv, mipLevel, jitter, sampleCount);\n}\n";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/clouds.vert
var clouds_default3 = 'precision highp float;\nprecision highp sampler3D;\n\n#include "atmosphere/bruneton/definitions"\n\nuniform AtmosphereParameters ATMOSPHERE;\nuniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;\nuniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;\n\nuniform sampler2D transmittance_texture;\nuniform sampler3D scattering_texture;\nuniform sampler2D irradiance_texture;\nuniform sampler3D single_mie_scattering_texture;\nuniform sampler3D higher_order_scattering_texture;\n\n#include "atmosphere/bruneton/common"\n#include "atmosphere/bruneton/runtime"\n\n#include "types"\n\nuniform mat4 inverseProjectionMatrix;\nuniform mat4 inverseViewMatrix;\nuniform vec3 cameraPosition;\nuniform mat4 worldToECEFMatrix;\nuniform vec3 altitudeCorrection;\n\n// Atmosphere\nuniform float bottomRadius;\nuniform vec3 sunDirection;\n\n// Cloud layers\nuniform float minHeight;\nuniform float maxHeight;\n\nlayout(location = 0) in vec3 position;\n\nout vec2 vUv;\nout vec3 vCameraPosition;\nout vec3 vCameraDirection; // Direction to the center of screen\nout vec3 vRayDirection; // Direction to the texel\nout vec3 vViewPosition;\n\nout GroundIrradiance vGroundIrradiance;\nout CloudsIrradiance vCloudsIrradiance;\n\nvoid sampleSunSkyIrradiance(const vec3 positionECEF) {\n  vGroundIrradiance.sun = GetSunAndSkyScalarIrradiance(\n    positionECEF * METER_TO_LENGTH_UNIT,\n    sunDirection,\n    vGroundIrradiance.sky\n  );\n\n  vec3 surfaceNormal = normalize(positionECEF);\n  vec2 radii = (bottomRadius + vec2(minHeight, maxHeight)) * METER_TO_LENGTH_UNIT;\n  vCloudsIrradiance.minSun = GetSunAndSkyScalarIrradiance(\n    surfaceNormal * radii.x,\n    sunDirection,\n    vCloudsIrradiance.minSky\n  );\n  vCloudsIrradiance.maxSun = GetSunAndSkyScalarIrradiance(\n    surfaceNormal * radii.y,\n    sunDirection,\n    vCloudsIrradiance.maxSky\n  );\n}\n\nvoid main() {\n  vUv = position.xy * 0.5 + 0.5;\n\n  vec3 viewPosition = (inverseProjectionMatrix * vec4(position, 1.0)).xyz;\n  vec3 worldDirection = (inverseViewMatrix * vec4(viewPosition.xyz, 0.0)).xyz;\n  vec3 cameraDirection = normalize((inverseViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);\n  vCameraPosition = (worldToECEFMatrix * vec4(cameraPosition, 1.0)).xyz;\n  vCameraDirection = (worldToECEFMatrix * vec4(cameraDirection, 0.0)).xyz;\n  vRayDirection = (worldToECEFMatrix * vec4(worldDirection, 0.0)).xyz;\n  vViewPosition = viewPosition;\n\n  sampleSunSkyIrradiance(vCameraPosition + altitudeCorrection);\n\n  gl_Position = vec4(position.xy, 1.0, 1.0);\n}\n';

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/parameters.glsl
var parameters_default = "uniform vec2 resolution;\nuniform int frame;\nuniform sampler3D stbnTexture;\n\n// Atmosphere\nuniform float bottomRadius;\nuniform mat4 worldToECEFMatrix;\nuniform mat4 ecefToWorldMatrix;\nuniform vec3 altitudeCorrection;\nuniform vec3 sunDirection;\n\n// Participating medium\nuniform float scatteringCoefficient;\nuniform float absorptionCoefficient;\n\n// Primary raymarch\nuniform float minDensity;\nuniform float minExtinction;\nuniform float minTransmittance;\n\n// Shape and weather\nuniform sampler2D localWeatherTexture;\nuniform vec2 localWeatherRepeat;\nuniform vec2 localWeatherOffset;\nuniform float coverage;\nuniform sampler3D shapeTexture;\nuniform vec3 shapeRepeat;\nuniform vec3 shapeOffset;\n\n#ifdef SHAPE_DETAIL\nuniform sampler3D shapeDetailTexture;\nuniform vec3 shapeDetailRepeat;\nuniform vec3 shapeDetailOffset;\n#endif // SHAPE_DETAIL\n\n#ifdef TURBULENCE\nuniform sampler2D turbulenceTexture;\nuniform vec2 turbulenceRepeat;\nuniform float turbulenceDisplacement;\n#endif // TURBULENCE\n\n// Haze\n#ifdef HAZE\nuniform float hazeDensityScale;\nuniform float hazeExponent;\nuniform float hazeScatteringCoefficient;\nuniform float hazeAbsorptionCoefficient;\n#endif // HAZE\n\n// Cloud layers\nuniform vec4 minLayerHeights;\nuniform vec4 maxLayerHeights;\nuniform vec3 minIntervalHeights;\nuniform vec3 maxIntervalHeights;\nuniform vec4 densityScales;\nuniform vec4 shapeAmounts;\nuniform vec4 shapeDetailAmounts;\nuniform vec4 weatherExponents;\nuniform vec4 shapeAlteringBiases;\nuniform vec4 coverageFilterWidths;\nuniform float minHeight;\nuniform float maxHeight;\nuniform float shadowTopHeight;\nuniform float shadowBottomHeight;\nuniform vec4 shadowLayerMask;\nuniform CloudDensityProfile densityProfile;\n";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/types.glsl
var types_default = "struct GroundIrradiance {\n  vec3 sun;\n  vec3 sky;\n};\n\nstruct CloudsIrradiance {\n  vec3 minSun;\n  vec3 minSky;\n  vec3 maxSun;\n  vec3 maxSky;\n};\n\nstruct CloudDensityProfile {\n  vec4 expTerms;\n  vec4 exponents;\n  vec4 linearTerms;\n  vec4 constantTerms;\n};\n";

// src/CloudsMaterial.ts
var vectorScratch = /* @__PURE__ */ new Vector33();
var geodeticScratch = /* @__PURE__ */ new Geodetic();
var CloudsMaterial = class extends AtmosphereMaterialBase {
  constructor({
    parameterUniforms,
    layerUniforms,
    atmosphereUniforms
  }, atmosphere = AtmosphereParameters.DEFAULT) {
    super(
      {
        name: "CloudsMaterial",
        glslVersion: GLSL3,
        vertexShader: resolveIncludes(clouds_default3, {
          atmosphere: {
            bruneton: {
              common,
              definitions,
              runtime: brunetonStubs_default
            }
          },
          types: types_default
        }),
        fragmentShader: unrollLoops(
          resolveIncludes(clouds_default, {
            core: {
              depth,
              math,
              turbo,
              generators,
              raySphereIntersection,
              cascadedShadowMaps,
              interleavedGradientNoise,
              vogelDisk
            },
            atmosphere: {
              bruneton: {
                common,
                definitions,
                runtime: brunetonStubs_default
              }
            },
            types: types_default,
            parameters: parameters_default,
            clouds: clouds_default2
          })
        ),
        // prettier-ignore
        uniforms: {
          ...parameterUniforms,
          ...layerUniforms,
          ...atmosphereUniforms,
          depthBuffer: new Uniform(null),
          viewMatrix: new Uniform(new Matrix42()),
          inverseProjectionMatrix: new Uniform(new Matrix42()),
          inverseViewMatrix: new Uniform(new Matrix42()),
          reprojectionMatrix: new Uniform(new Matrix42()),
          viewReprojectionMatrix: new Uniform(new Matrix42()),
          resolution: new Uniform(new Vector24()),
          cameraNear: new Uniform(0),
          cameraFar: new Uniform(0),
          cameraHeight: new Uniform(0),
          frame: new Uniform(0),
          temporalJitter: new Uniform(new Vector24()),
          targetUvScale: new Uniform(new Vector24()),
          mipLevelScale: new Uniform(1),
          stbnTexture: new Uniform(null),
          // DayGroup lighting (Clouds-B). Replaces the precomputed-
          // Bruneton irradiance path. Drives brunetonStubs.glsl's
          // GetSun*Irradiance / GetSkyRadianceToPoint stubs. Wired
          // from skyLightingController._lastState in Clouds-C.
          uSunColor: new Uniform(new Vector33(1, 0.95, 0.85)),
          uAmbientColor: new Uniform(new Vector33(0.55, 0.62, 0.78)),
          uHorizonColor: new Uniform(new Vector33(0.85, 0.87, 0.94)),
          uFogDensity: new Uniform(2e-3),
          uSunIntensity: new Uniform(1),
          // Scattering
          skyLightScale: new Uniform(1),
          groundBounceScale: new Uniform(1),
          powderScale: new Uniform(0.8),
          powderExponent: new Uniform(150),
          // Primary raymarch
          maxIterationCount: new Uniform(defaults.clouds.maxIterationCount),
          minStepSize: new Uniform(defaults.clouds.minStepSize),
          maxStepSize: new Uniform(defaults.clouds.maxStepSize),
          maxRayDistance: new Uniform(defaults.clouds.maxRayDistance),
          perspectiveStepScale: new Uniform(defaults.clouds.perspectiveStepScale),
          minDensity: new Uniform(defaults.clouds.minDensity),
          minExtinction: new Uniform(defaults.clouds.minExtinction),
          minTransmittance: new Uniform(defaults.clouds.minTransmittance),
          // Secondary raymarch
          maxIterationCountToSun: new Uniform(defaults.clouds.maxIterationCountToSun),
          maxIterationCountToGround: new Uniform(defaults.clouds.maxIterationCountToGround),
          minSecondaryStepSize: new Uniform(defaults.clouds.minSecondaryStepSize),
          secondaryStepScale: new Uniform(defaults.clouds.secondaryStepScale),
          // Beer shadow map
          shadowBuffer: new Uniform(null),
          shadowTexelSize: new Uniform(new Vector24()),
          shadowIntervals: new Uniform(
            Array.from({ length: 4 }, () => new Vector24())
            // Populate the max number of elements
          ),
          shadowMatrices: new Uniform(
            Array.from({ length: 4 }, () => new Matrix42())
            // Populate the max number of elements
          ),
          shadowFar: new Uniform(0),
          maxShadowFilterRadius: new Uniform(6),
          shadowLayerMask: new Uniform(new Vector4().setScalar(1)),
          // Disable mask
          // Shadow length
          maxShadowLengthIterationCount: new Uniform(defaults.clouds.maxShadowLengthIterationCount),
          minShadowLengthStepSize: new Uniform(defaults.clouds.minShadowLengthStepSize),
          maxShadowLengthRayDistance: new Uniform(defaults.clouds.maxShadowLengthRayDistance),
          // Haze
          hazeDensityScale: new Uniform(3e-5),
          hazeExponent: new Uniform(1e-3),
          hazeScatteringCoefficient: new Uniform(0.9),
          hazeAbsorptionCoefficient: new Uniform(0.5)
        }
      },
      atmosphere
    );
    this.temporalUpscale = true;
    this.depthPacking = 0;
    this.localWeatherChannels = "rgba";
    this.shapeDetail = defaults.shapeDetail;
    this.turbulence = defaults.turbulence;
    this.shadowLength = defaults.lightShafts;
    this.haze = defaults.haze;
    this.multiScatteringOctaves = defaults.clouds.multiScatteringOctaves;
    this.accurateSunSkyLight = defaults.clouds.accurateSunSkyLight;
    this.accuratePhaseFunction = defaults.clouds.accuratePhaseFunction;
    this.shadowCascadeCount = defaults.shadow.cascadeCount;
    this.shadowSampleCount = 8;
    this.scatterAnisotropy1 = 0.7;
    this.scatterAnisotropy2 = -0.2;
    this.scatterAnisotropyMix = 0.5;
  }
  onBeforeRender(renderer, scene, camera, geometry, object, group) {
    const prevLogarithmicDepthBuffer = this.defines.USE_LOGARITHMIC_DEPTH_BUFFER != null;
    const nextLogarithmicDepthBuffer = renderer.capabilities.logarithmicDepthBuffer;
    if (nextLogarithmicDepthBuffer !== prevLogarithmicDepthBuffer) {
      if (nextLogarithmicDepthBuffer) {
        this.defines.USE_LOGARITHMIC_DEPTH_BUFFER = "1";
      } else {
        delete this.defines.USE_LOGARITHMIC_DEPTH_BUFFER;
      }
    }
    const prevPowder = this.defines.POWDER != null;
    const nextPowder = this.uniforms.powderScale.value > 0;
    if (nextPowder !== prevPowder) {
      if (nextPowder) {
        this.defines.POWDER = "1";
      } else {
        delete this.defines.POWDER;
      }
      this.needsUpdate = true;
    }
    const prevGroundIrradiance = this.defines.GROUND_BOUNCE != null;
    const nextGroundIrradiance = this.uniforms.groundBounceScale.value > 0 && this.uniforms.maxIterationCountToGround.value > 0;
    if (nextGroundIrradiance !== prevGroundIrradiance) {
      if (nextPowder) {
        this.defines.GROUND_BOUNCE = "1";
      } else {
        delete this.defines.GROUND_BOUNCE;
      }
      this.needsUpdate = true;
    }
  }
  copyCameraSettings(camera) {
    if (camera.isPerspectiveCamera === true) {
      if (this.defines.PERSPECTIVE_CAMERA !== "1") {
        this.defines.PERSPECTIVE_CAMERA = "1";
        this.needsUpdate = true;
      }
    } else {
      if (this.defines.PERSPECTIVE_CAMERA != null) {
        delete this.defines.PERSPECTIVE_CAMERA;
        this.needsUpdate = true;
      }
    }
    const uniforms = this.uniforms;
    uniforms.viewMatrix.value.copy(camera.matrixWorldInverse);
    uniforms.inverseViewMatrix.value.copy(camera.matrixWorld);
    const previousProjectionMatrix = this.previousProjectionMatrix ?? camera.projectionMatrix;
    const previousViewMatrix = this.previousViewMatrix ?? camera.matrixWorldInverse;
    const inverseProjectionMatrix = uniforms.inverseProjectionMatrix.value;
    const inverseViewMatrix = uniforms.inverseViewMatrix.value;
    const reprojectionMatrix = uniforms.reprojectionMatrix.value;
    const viewReprojectionMatrix = uniforms.viewReprojectionMatrix.value;
    if (this.temporalUpscale) {
      const frame = uniforms.frame.value % 16;
      const resolution = uniforms.resolution.value;
      const offset = bayerOffsets[frame];
      const dx = (offset.x - 0.5) / resolution.x * 4;
      const dy = (offset.y - 0.5) / resolution.y * 4;
      uniforms.temporalJitter.value.set(dx, dy);
      uniforms.mipLevelScale.value = 0.25;
      inverseProjectionMatrix.copy(camera.projectionMatrix);
      inverseProjectionMatrix.elements[8] += dx * 2;
      inverseProjectionMatrix.elements[9] += dy * 2;
      inverseProjectionMatrix.invert();
      reprojectionMatrix.copy(previousProjectionMatrix);
      reprojectionMatrix.elements[8] += dx * 2;
      reprojectionMatrix.elements[9] += dy * 2;
      reprojectionMatrix.multiply(previousViewMatrix);
      viewReprojectionMatrix.copy(reprojectionMatrix).multiply(inverseViewMatrix);
    } else {
      uniforms.temporalJitter.value.setScalar(0);
      uniforms.mipLevelScale.value = 1;
      inverseProjectionMatrix.copy(camera.projectionMatrixInverse);
      reprojectionMatrix.copy(previousProjectionMatrix).multiply(previousViewMatrix);
      viewReprojectionMatrix.copy(reprojectionMatrix).multiply(inverseViewMatrix);
    }
    reinterpretType(camera);
    uniforms.cameraNear.value = camera.near;
    uniforms.cameraFar.value = camera.far;
    const cameraPosition = camera.getWorldPosition(
      uniforms.cameraPosition.value
    );
    const cameraPositionECEF = vectorScratch.copy(cameraPosition).applyMatrix4(uniforms.worldToECEFMatrix.value);
    try {
      uniforms.cameraHeight.value = geodeticScratch.setFromECEF(cameraPositionECEF).height;
    } catch (error) {
    }
  }
  // copyCameraSettings can be called multiple times within a frame. Only
  // reliable way is to explicitly store the matrices.
  copyReprojectionMatrix(camera) {
    this.previousProjectionMatrix ??= new Matrix42();
    this.previousViewMatrix ??= new Matrix42();
    this.previousProjectionMatrix.copy(camera.projectionMatrix);
    this.previousViewMatrix.copy(camera.matrixWorldInverse);
  }
  setSize(width, height, targetWidth, targetHeight) {
    this.uniforms.resolution.value.set(width, height);
    if (targetWidth != null && targetHeight != null) {
      this.uniforms.targetUvScale.value.set(
        width / targetWidth,
        height / targetHeight
      );
    } else {
      this.uniforms.targetUvScale.value.setScalar(1);
    }
    this.previousProjectionMatrix = void 0;
    this.previousViewMatrix = void 0;
  }
  setShadowSize(width, height) {
    this.uniforms.shadowTexelSize.value.set(1 / width, 1 / height);
  }
  get depthBuffer() {
    return this.uniforms.depthBuffer.value;
  }
  set depthBuffer(value) {
    this.uniforms.depthBuffer.value = value;
  }
};
__decorateClass([
  defineInt("DEPTH_PACKING")
], CloudsMaterial.prototype, "depthPacking", 2);
__decorateClass([
  defineExpression("LOCAL_WEATHER_CHANNELS", {
    validate: (value) => /^[rgba]{4}$/.test(value)
  })
], CloudsMaterial.prototype, "localWeatherChannels", 2);
__decorateClass([
  define("SHAPE_DETAIL")
], CloudsMaterial.prototype, "shapeDetail", 2);
__decorateClass([
  define("TURBULENCE")
], CloudsMaterial.prototype, "turbulence", 2);
__decorateClass([
  define("SHADOW_LENGTH")
], CloudsMaterial.prototype, "shadowLength", 2);
__decorateClass([
  define("HAZE")
], CloudsMaterial.prototype, "haze", 2);
__decorateClass([
  defineInt("MULTI_SCATTERING_OCTAVES", { min: 1, max: 12 })
], CloudsMaterial.prototype, "multiScatteringOctaves", 2);
__decorateClass([
  define("ACCURATE_SUN_SKY_LIGHT")
], CloudsMaterial.prototype, "accurateSunSkyLight", 2);
__decorateClass([
  define("ACCURATE_PHASE_FUNCTION")
], CloudsMaterial.prototype, "accuratePhaseFunction", 2);
__decorateClass([
  defineInt("SHADOW_CASCADE_COUNT", { min: 1, max: 4 })
], CloudsMaterial.prototype, "shadowCascadeCount", 2);
__decorateClass([
  defineInt("SHADOW_SAMPLE_COUNT", { min: 1, max: 16 })
], CloudsMaterial.prototype, "shadowSampleCount", 2);
__decorateClass([
  defineFloat("SCATTER_ANISOTROPY_1")
], CloudsMaterial.prototype, "scatterAnisotropy1", 2);
__decorateClass([
  defineFloat("SCATTER_ANISOTROPY_2")
], CloudsMaterial.prototype, "scatterAnisotropy2", 2);
__decorateClass([
  defineFloat("SCATTER_ANISOTROPY_MIX")
], CloudsMaterial.prototype, "scatterAnisotropyMix", 2);

// src/CloudsResolveMaterial.ts
import {
  GLSL3 as GLSL32,
  RawShaderMaterial,
  Uniform as Uniform2,
  Vector2 as Vector25
} from "three";
import { define as define2, resolveIncludes as resolveIncludes2, unrollLoops as unrollLoops2 } from "@takram/three-geospatial";
import { turbo as turbo2 } from "@takram/three-geospatial/shaders";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/catmullRomSampling.glsl
var catmullRomSampling_default = `// Taken from https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1
// TODO: Use 5-taps version: https://www.shadertoy.com/view/MtVGWz
// Or even 4 taps (requires preprocessing in the input buffer):
// https://www.shadertoy.com/view/4tyGDD

/**
 * MIT License
 *
 * Copyright (c) 2019 MJP
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

vec4 textureCatmullRom(sampler2D tex, vec2 uv) {
  vec2 texSize = vec2(textureSize(tex, 0));

  // We're going to sample a a 4x4 grid of texels surrounding the target UV
  // coordinate. We'll do this by rounding down the sample location to get the
  // exact center of our "starting" texel. The starting texel will be at
  // location [1, 1] in the grid, where [0, 0] is the top left corner.
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;

  // Compute the fractional offset from our starting texel to our original
  // sample location, which we'll feed into the Catmull-Rom spline function to
  // get our filter weights.
  vec2 f = samplePos - texPos1;

  // Compute the Catmull-Rom weights using the fractional offset that we
  // calculated earlier. These equations are pre-expanded based on our knowledge
  // of where the texels will be located, which lets us avoid having to evaluate
  // a piece-wise function.
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  // Work out weighting factors and sampling offsets that will let us use
  // bilinear filtering to simultaneously evaluate the middle 2 samples from the
  // 4x4 grid.
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / (w1 + w2);

  // Compute the final UV coordinates we'll use for sampling the texture
  vec2 texPos0 = texPos1 - 1.0;
  vec2 texPos3 = texPos1 + 2.0;
  vec2 texPos12 = texPos1 + offset12;

  texPos0 /= texSize;
  texPos3 /= texSize;
  texPos12 /= texSize;

  vec4 result = vec4(0.0);
  result += texture(tex, vec2(texPos0.x, texPos0.y)) * w0.x * w0.y;
  result += texture(tex, vec2(texPos12.x, texPos0.y)) * w12.x * w0.y;
  result += texture(tex, vec2(texPos3.x, texPos0.y)) * w3.x * w0.y;

  result += texture(tex, vec2(texPos0.x, texPos12.y)) * w0.x * w12.y;
  result += texture(tex, vec2(texPos12.x, texPos12.y)) * w12.x * w12.y;
  result += texture(tex, vec2(texPos3.x, texPos12.y)) * w3.x * w12.y;

  result += texture(tex, vec2(texPos0.x, texPos3.y)) * w0.x * w3.y;
  result += texture(tex, vec2(texPos12.x, texPos3.y)) * w12.x * w3.y;
  result += texture(tex, vec2(texPos3.x, texPos3.y)) * w3.x * w3.y;

  return result;
}

vec4 textureCatmullRom(sampler2DArray tex, vec3 uv) {
  vec2 texSize = vec2(textureSize(tex, 0));
  vec2 samplePos = uv.xy * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / (w1 + w2);
  vec2 texPos0 = texPos1 - 1.0;
  vec2 texPos3 = texPos1 + 2.0;
  vec2 texPos12 = texPos1 + offset12;
  texPos0 /= texSize;
  texPos3 /= texSize;
  texPos12 /= texSize;
  vec4 result = vec4(0.0);
  result += texture(tex, vec3(texPos0.x, texPos0.y, uv.z)) * w0.x * w0.y;
  result += texture(tex, vec3(texPos12.x, texPos0.y, uv.z)) * w12.x * w0.y;
  result += texture(tex, vec3(texPos3.x, texPos0.y, uv.z)) * w3.x * w0.y;
  result += texture(tex, vec3(texPos0.x, texPos12.y, uv.z)) * w0.x * w12.y;
  result += texture(tex, vec3(texPos12.x, texPos12.y, uv.z)) * w12.x * w12.y;
  result += texture(tex, vec3(texPos3.x, texPos12.y, uv.z)) * w3.x * w12.y;
  result += texture(tex, vec3(texPos0.x, texPos3.y, uv.z)) * w0.x * w3.y;
  result += texture(tex, vec3(texPos12.x, texPos3.y, uv.z)) * w12.x * w3.y;
  result += texture(tex, vec3(texPos3.x, texPos3.y, uv.z)) * w3.x * w3.y;
  return result;
}
`;

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/cloudsResolve.frag
var cloudsResolve_default = `precision highp float;
precision highp sampler2DArray;

#include "core/turbo"
#include "catmullRomSampling"
#include "varianceClipping"

uniform sampler2D colorBuffer;
uniform sampler2D depthVelocityBuffer;
uniform sampler2D colorHistoryBuffer;

#ifdef SHADOW_LENGTH
uniform sampler2D shadowLengthBuffer;
uniform sampler2D shadowLengthHistoryBuffer;
#endif // SHADOW_LENGTH

uniform vec2 texelSize;
uniform int frame;
uniform float varianceGamma;
uniform float temporalAlpha;
uniform vec2 jitterOffset;

in vec2 vUv;

layout(location = 0) out vec4 outputColor;
#ifdef SHADOW_LENGTH
layout(location = 1) out float outputShadowLength;
#endif // SHADOW_LENGTH

const ivec2 neighborOffsets[9] = ivec2[9](
  ivec2(-1, -1),
  ivec2(-1, 0),
  ivec2(-1, 1),
  ivec2(0, -1),
  ivec2(0, 0),
  ivec2(0, 1),
  ivec2(1, -1),
  ivec2(1, 0),
  ivec2(1, 1)
);

const ivec4[4] bayerIndices = ivec4[4](
  ivec4(0, 12, 3, 15),
  ivec4(8, 4, 11, 7),
  ivec4(2, 14, 1, 13),
  ivec4(10, 6, 9, 5)
);

vec4 getClosestFragment(const ivec2 coord) {
  vec4 result = vec4(1e7, 0.0, 0.0, 0.0);
  vec4 neighbor;
  #pragma unroll_loop_start
  for (int i = 0; i < 9; ++i) {
    neighbor = texelFetchOffset(depthVelocityBuffer, coord, 0, neighborOffsets[i]);
    if (neighbor.r < result.r) {
      result = neighbor;
    }
  }
  #pragma unroll_loop_end
  return result;
}

void temporalUpscale(
  const ivec2 coord,
  const ivec2 lowResCoord,
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  vec4 currentColor = texelFetch(colorBuffer, lowResCoord, 0);
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, lowResCoord, 0).rgb, 1.0);
  #endif // SHADOW_LENGTH

  if (currentFrame) {
    // Use the texel just rendered without any accumulation.
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return;
  }

  vec4 depthVelocity = getClosestFragment(lowResCoord);
  vec2 velocity = depthVelocity.gb;
  vec2 prevUv = vUv - velocity;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }

  // Variance clipping with a large variance gamma seems to work fine for
  // upsampling. This increases ghosting, of course, but it's hard to notice on
  // clouds.
  // vec4 historyColor = textureCatmullRom(colorHistoryBuffer, prevUv);
  vec4 historyColor = texture(colorHistoryBuffer, prevUv);
  vec4 clippedColor = varianceClipping(colorBuffer, vUv, currentColor, historyColor, varianceGamma);
  outputColor = clippedColor;

  #ifdef SHADOW_LENGTH
  // Sampling the shadow length history using scene depth doesn't make much
  // sense, but it's too hard to derive it properly. At least this approach
  // resolves the edges of scene objects.
  // vec4 historyShadowLength = vec4(textureCatmullRom(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 clippedShadowLength = varianceClipping(
    shadowLengthBuffer,
    vUv,
    currentShadowLength,
    historyShadowLength,
    varianceGamma
  );
  outputShadowLength = clippedShadowLength.r;
  #endif // SHADOW_LENGTH
}

void temporalAntialiasing(const ivec2 coord, out vec4 outputColor, out float outputShadowLength) {
  vec4 currentColor = texelFetch(colorBuffer, coord, 0);
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, coord, 0).rgb, 1.0);
  #endif // SHADOW_LENGTH

  vec4 depthVelocity = getClosestFragment(coord);
  vec2 velocity = depthVelocity.gb;

  vec2 prevUv = vUv - velocity;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }

  vec4 historyColor = texture(colorHistoryBuffer, prevUv);
  vec4 clippedColor = varianceClipping(colorBuffer, coord, currentColor, historyColor);
  outputColor = mix(clippedColor, currentColor, temporalAlpha);

  #ifdef SHADOW_LENGTH
  vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 clippedShadowLength = varianceClipping(
    shadowLengthBuffer,
    coord,
    currentShadowLength,
    historyShadowLength
  );
  outputShadowLength = mix(clippedShadowLength.r, currentShadowLength.r, temporalAlpha);
  #endif // SHADOW_LENGTH
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);

  #if !defined(SHADOW_LENGTH)
  float outputShadowLength;
  #endif // !defined(SHADOW_LENGTH)

  #ifdef TEMPORAL_UPSCALE
  ivec2 lowResCoord = coord / 4;
  int bayerValue = bayerIndices[coord.x % 4][coord.y % 4];
  bool currentFrame = bayerValue == frame % 16;
  temporalUpscale(coord, lowResCoord, currentFrame, outputColor, outputShadowLength);
  #else // TEMPORAL_UPSCALE
  temporalAntialiasing(coord, outputColor, outputShadowLength);
  #endif // TEMPORAL_UPSCALE

  #if defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)
  outputColor = vec4(turbo(outputShadowLength * 0.05), 1.0);
  #endif // defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)

  #ifdef DEBUG_SHOW_VELOCITY
  outputColor.rgb = outputColor.rgb + vec3(abs(texture(depthVelocityBuffer, vUv).gb) * 10.0, 0.0);
  #endif // DEBUG_SHOW_VELOCITY
}
`;

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/cloudsResolve.vert
var cloudsResolve_default2 = "precision highp float;\n\nlayout(location = 0) in vec3 position;\n\nout vec2 vUv;\n\nvoid main() {\n  vUv = position.xy * 0.5 + 0.5;\n  gl_Position = vec4(position.xy, 1.0, 1.0);\n}\n";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/varianceClipping.glsl
var varianceClipping_default = "#ifdef VARIANCE_9_SAMPLES\n#define VARIANCE_OFFSET_COUNT 8\nconst ivec2 varianceOffsets[8] = ivec2[8](\n  ivec2(-1, -1),\n  ivec2(-1, 1),\n  ivec2(1, -1),\n  ivec2(1, 1),\n  ivec2(1, 0),\n  ivec2(0, -1),\n  ivec2(0, 1),\n  ivec2(-1, 0)\n);\n#else // VARIANCE_9_SAMPLES\n#define VARIANCE_OFFSET_COUNT 4\nconst ivec2 varianceOffsets[4] = ivec2[4](ivec2(1, 0), ivec2(0, -1), ivec2(0, 1), ivec2(-1, 0));\n#endif // VARIANCE_9_SAMPLES\n\n// Reference: https://github.com/playdeadgames/temporal\nvec4 clipAABB(const vec4 current, const vec4 history, const vec4 minColor, const vec4 maxColor) {\n  vec3 pClip = 0.5 * (maxColor.rgb + minColor.rgb);\n  vec3 eClip = 0.5 * (maxColor.rgb - minColor.rgb) + 1e-7;\n  vec4 vClip = history - vec4(pClip, current.a);\n  vec3 vUnit = vClip.xyz / eClip;\n  vec3 aUnit = abs(vUnit);\n  float maUnit = max(aUnit.x, max(aUnit.y, aUnit.z));\n  if (maUnit > 1.0) {\n    return vec4(pClip, current.a) + vClip / maUnit;\n  }\n  return history;\n}\n\n#ifdef VARIANCE_SAMPLER_ARRAY\n#define VARIANCE_SAMPLER sampler2DArray\n#define VARIANCE_SAMPLER_COORD ivec3\n#else // VARIANCE_SAMPLER_ARRAY\n#define VARIANCE_SAMPLER sampler2D\n#define VARIANCE_SAMPLER_COORD ivec2\n#endif // VARIANCE_SAMPLER_ARRAY\n\n// Variance clipping\n// Reference: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf\nvec4 varianceClipping(\n  const VARIANCE_SAMPLER inputBuffer,\n  const VARIANCE_SAMPLER_COORD coord,\n  const vec4 current,\n  const vec4 history,\n  const float gamma\n) {\n  vec4 moment1 = current;\n  vec4 moment2 = current * current;\n  vec4 neighbor;\n  #pragma unroll_loop_start\n  for (int i = 0; i < 8; ++i) {\n    #if UNROLLED_LOOP_INDEX < VARIANCE_OFFSET_COUNT\n    neighbor = texelFetchOffset(inputBuffer, coord, 0, varianceOffsets[i]);\n    moment1 += neighbor;\n    moment2 += neighbor * neighbor;\n    #endif // UNROLLED_LOOP_INDEX < VARIANCE_OFFSET_COUNT\n  }\n  #pragma unroll_loop_end\n\n  const float N = float(VARIANCE_OFFSET_COUNT + 1);\n  vec4 mean = moment1 / N;\n  vec4 varianceGamma = sqrt(max(moment2 / N - mean * mean, 0.0)) * gamma;\n  vec4 minColor = mean - varianceGamma;\n  vec4 maxColor = mean + varianceGamma;\n  return clipAABB(clamp(mean, minColor, maxColor), history, minColor, maxColor);\n}\n\nvec4 varianceClipping(\n  const VARIANCE_SAMPLER inputBuffer,\n  const VARIANCE_SAMPLER_COORD coord,\n  const vec4 current,\n  const vec4 history\n) {\n  return varianceClipping(inputBuffer, coord, current, history, 1.0);\n}\n\nvec4 varianceClipping(\n  const sampler2D inputBuffer,\n  const vec2 coord,\n  const vec4 current,\n  const vec4 history,\n  const float gamma\n) {\n  vec4 moment1 = current;\n  vec4 moment2 = current * current;\n  vec4 neighbor;\n  #pragma unroll_loop_start\n  for (int i = 0; i < 8; ++i) {\n    #if UNROLLED_LOOP_INDEX < VARIANCE_OFFSET_COUNT\n    neighbor = textureOffset(inputBuffer, coord, varianceOffsets[i]);\n    moment1 += neighbor;\n    moment2 += neighbor * neighbor;\n    #endif // UNROLLED_LOOP_INDEX < VARIANCE_OFFSET_COUNT\n  }\n  #pragma unroll_loop_end\n\n  const float N = float(VARIANCE_OFFSET_COUNT + 1);\n  vec4 mean = moment1 / N;\n  vec4 varianceGamma = sqrt(max(moment2 / N - mean * mean, 0.0)) * gamma;\n  vec4 minColor = mean - varianceGamma;\n  vec4 maxColor = mean + varianceGamma;\n  return clipAABB(clamp(mean, minColor, maxColor), history, minColor, maxColor);\n}\n\nvec4 varianceClipping(\n  const sampler2D inputBuffer,\n  const vec2 coord,\n  const vec4 current,\n  const vec4 history\n) {\n  return varianceClipping(inputBuffer, coord, current, history, 1.0);\n}\n";

// src/CloudsResolveMaterial.ts
var CloudsResolveMaterial = class extends RawShaderMaterial {
  constructor({
    colorBuffer = null,
    depthVelocityBuffer = null,
    shadowLengthBuffer = null,
    colorHistoryBuffer = null,
    shadowLengthHistoryBuffer = null
  } = {}) {
    super({
      name: "CloudsResolveMaterial",
      glslVersion: GLSL32,
      vertexShader: cloudsResolve_default2,
      fragmentShader: unrollLoops2(
        resolveIncludes2(cloudsResolve_default, {
          core: { turbo: turbo2 },
          catmullRomSampling: catmullRomSampling_default,
          varianceClipping: varianceClipping_default
        })
      ),
      uniforms: {
        colorBuffer: new Uniform2(colorBuffer),
        depthVelocityBuffer: new Uniform2(depthVelocityBuffer),
        shadowLengthBuffer: new Uniform2(shadowLengthBuffer),
        colorHistoryBuffer: new Uniform2(colorHistoryBuffer),
        shadowLengthHistoryBuffer: new Uniform2(shadowLengthHistoryBuffer),
        texelSize: new Uniform2(new Vector25()),
        frame: new Uniform2(0),
        jitterOffset: new Uniform2(new Vector25()),
        varianceGamma: new Uniform2(2),
        temporalAlpha: new Uniform2(0.1)
      }
    });
    this.temporalUpscale = true;
    this.shadowLength = true;
  }
  setSize(width, height) {
    this.uniforms.texelSize.value.set(1 / width, 1 / height);
  }
  onBeforeRender(renderer, scene, camera, geometry, object, group) {
    const uniforms = this.uniforms;
    const frame = uniforms.frame.value % 16;
    const offset = bayerOffsets[frame];
    const dx = (offset.x - 0.5) * 4;
    const dy = (offset.y - 0.5) * 4;
    this.uniforms.jitterOffset.value.set(dx, dy);
  }
};
__decorateClass([
  define2("TEMPORAL_UPSCALE")
], CloudsResolveMaterial.prototype, "temporalUpscale", 2);
__decorateClass([
  define2("SHADOW_LENGTH")
], CloudsResolveMaterial.prototype, "shadowLength", 2);

// src/PassBase.ts
import { Pass } from "postprocessing";
import { Camera } from "three";
var PassBase = class extends Pass {
  constructor(name, options) {
    super(name);
    this._mainCamera = new Camera();
    const { shadow } = options;
    this.shadow = shadow;
  }
  get mainCamera() {
    return this._mainCamera;
  }
  set mainCamera(value) {
    this._mainCamera = value;
  }
};

// src/CloudsPass.ts
function createRenderTarget(name, { depthVelocity, shadowLength }) {
  const renderTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    type: HalfFloatType
  });
  renderTarget.texture.minFilter = LinearFilter;
  renderTarget.texture.magFilter = LinearFilter;
  renderTarget.texture.name = name;
  let depthVelocityBuffer;
  if (depthVelocity) {
    depthVelocityBuffer = renderTarget.texture.clone();
    depthVelocityBuffer.isRenderTargetTexture = true;
    renderTarget.depthVelocity = depthVelocityBuffer;
    renderTarget.textures.push(depthVelocityBuffer);
  }
  let shadowLengthBuffer;
  if (shadowLength) {
    shadowLengthBuffer = renderTarget.texture.clone();
    shadowLengthBuffer.isRenderTargetTexture = true;
    shadowLengthBuffer.format = RedFormat;
    renderTarget.shadowLength = shadowLengthBuffer;
    renderTarget.textures.push(shadowLengthBuffer);
  }
  return Object.assign(renderTarget, {
    depthVelocity: depthVelocityBuffer ?? null,
    shadowLength: shadowLengthBuffer ?? null
  });
}
var CloudsPass = class extends PassBase {
  constructor({
    parameterUniforms,
    layerUniforms,
    atmosphereUniforms,
    ...options
  }, atmosphere) {
    super("CloudsPass", options);
    this.atmosphere = atmosphere;
    this.width = 0;
    this.height = 0;
    this.currentMaterial = new CloudsMaterial(
      {
        parameterUniforms,
        layerUniforms,
        atmosphereUniforms
      },
      atmosphere
    );
    this.currentPass = new ShaderPass(this.currentMaterial);
    this.resolveMaterial = new CloudsResolveMaterial();
    this.resolvePass = new ShaderPass(this.resolveMaterial);
    this.initRenderTargets({
      depthVelocity: true,
      shadowLength: defaults.lightShafts
    });
  }
  copyCameraSettings(camera) {
    this.currentMaterial.copyCameraSettings(camera);
  }
  initialize(renderer, alpha, frameBufferType) {
    this.currentPass.initialize(renderer, alpha, frameBufferType);
    this.resolvePass.initialize(renderer, alpha, frameBufferType);
  }
  initRenderTargets(options) {
    this.currentRenderTarget?.dispose();
    this.resolveRenderTarget?.dispose();
    this.historyRenderTarget?.dispose();
    const current = createRenderTarget("Clouds", options);
    const resolve = createRenderTarget("Clouds.A", {
      ...options,
      depthVelocity: false
    });
    const history = createRenderTarget("Clouds.B", {
      ...options,
      depthVelocity: false
    });
    this.currentRenderTarget = current;
    this.resolveRenderTarget = resolve;
    this.historyRenderTarget = history;
    const resolveUniforms = this.resolveMaterial.uniforms;
    resolveUniforms.colorBuffer.value = current.texture;
    resolveUniforms.depthVelocityBuffer.value = current.depthVelocity;
    resolveUniforms.shadowLengthBuffer.value = current.shadowLength;
    resolveUniforms.colorHistoryBuffer.value = history.texture;
    resolveUniforms.shadowLengthHistoryBuffer.value = history.shadowLength;
  }
  copyShadow() {
    const shadow = this.shadow;
    const currentUniforms = this.currentMaterial.uniforms;
    for (let i = 0; i < shadow.cascadeCount; ++i) {
      const cascade = shadow.cascades[i];
      currentUniforms.shadowIntervals.value[i].copy(cascade.interval);
      currentUniforms.shadowMatrices.value[i].copy(cascade.matrix);
    }
    currentUniforms.shadowFar.value = shadow.far;
  }
  copyReprojection() {
    this.currentMaterial.copyReprojectionMatrix(this.mainCamera);
  }
  swapBuffers() {
    const nextResolve = this.historyRenderTarget;
    const nextHistory = this.resolveRenderTarget;
    this.resolveRenderTarget = nextResolve;
    this.historyRenderTarget = nextHistory;
    const resolveUniforms = this.resolveMaterial.uniforms;
    resolveUniforms.colorHistoryBuffer.value = nextHistory.texture;
    resolveUniforms.shadowLengthHistoryBuffer.value = nextHistory.shadowLength;
  }
  update(renderer, frame, deltaTime) {
    this.currentMaterial.uniforms.frame.value = frame;
    this.resolveMaterial.uniforms.frame.value = frame;
    this.copyCameraSettings(this.mainCamera);
    this.copyShadow();
    this.currentPass.render(renderer, null, this.currentRenderTarget);
    this.resolvePass.render(renderer, null, this.resolveRenderTarget);
    this.copyReprojection();
    this.swapBuffers();
  }
  setSize(width, height) {
    this.width = width;
    this.height = height;
    if (this.temporalUpscale) {
      const lowResWidth = Math.ceil(width / 4);
      const lowResHeight = Math.ceil(height / 4);
      this.currentRenderTarget.setSize(lowResWidth, lowResHeight);
      this.currentMaterial.setSize(
        lowResWidth * 4,
        lowResHeight * 4,
        width,
        height
      );
    } else {
      this.currentRenderTarget.setSize(width, height);
      this.currentMaterial.setSize(width, height);
    }
    this.resolveRenderTarget.setSize(width, height);
    this.resolveMaterial.setSize(width, height);
    this.historyRenderTarget.setSize(width, height);
  }
  setShadowSize(width, height, depth2) {
    this.currentMaterial.shadowCascadeCount = depth2;
    this.currentMaterial.setShadowSize(width, height);
  }
  setDepthTexture(depthTexture, depthPacking) {
    this.currentMaterial.depthBuffer = depthTexture;
    this.currentMaterial.depthPacking = depthPacking ?? 0;
  }
  get outputBuffer() {
    return this.historyRenderTarget.texture;
  }
  get shadowBuffer() {
    return this.currentMaterial.uniforms.shadowBuffer.value;
  }
  set shadowBuffer(value) {
    this.currentMaterial.uniforms.shadowBuffer.value = value;
  }
  get shadowLengthBuffer() {
    return this.historyRenderTarget.shadowLength;
  }
  get temporalUpscale() {
    return this.currentMaterial.temporalUpscale;
  }
  set temporalUpscale(value) {
    if (value !== this.temporalUpscale) {
      this.currentMaterial.temporalUpscale = value;
      this.resolveMaterial.temporalUpscale = value;
      this.setSize(this.width, this.height);
    }
  }
  get lightShafts() {
    return this.currentMaterial.shadowLength;
  }
  set lightShafts(value) {
    if (value !== this.lightShafts) {
      this.currentMaterial.shadowLength = value;
      this.resolveMaterial.shadowLength = value;
      this.initRenderTargets({
        depthVelocity: true,
        shadowLength: value
      });
      this.setSize(this.width, this.height);
    }
  }
};

// src/ShadowPass.ts
import {
  HalfFloatType as HalfFloatType2,
  LinearFilter as LinearFilter2,
  WebGLArrayRenderTarget
} from "three";

// src/ShaderArrayPass.ts
import { ShaderPass as ShaderPass2 } from "postprocessing";

// src/helpers/setArrayRenderTargetLayers.ts
function setArrayRenderTargetLayers(renderer, outputBuffer) {
  const property = renderer.properties.get(outputBuffer.texture);
  const glTexture = property.__webglTexture;
  const gl = renderer.getContext();
  invariant(gl instanceof WebGL2RenderingContext);
  renderer.setRenderTarget(outputBuffer);
  const drawBuffers = [];
  if (glTexture != null) {
    for (let layer = 0; layer < outputBuffer.depth; ++layer) {
      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + layer,
        glTexture,
        0,
        layer
      );
      drawBuffers.push(gl.COLOR_ATTACHMENT0 + layer);
    }
  }
  gl.drawBuffers(drawBuffers);
}

// src/ShaderArrayPass.ts
var ShaderArrayPass = class extends ShaderPass2 {
  render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    const uniforms = this.fullscreenMaterial.uniforms;
    if (inputBuffer !== null && uniforms?.[this.input] != null) {
      uniforms[this.input].value = inputBuffer.texture;
    }
    setArrayRenderTargetLayers(renderer, outputBuffer);
    renderer.render(this.scene, this.camera);
  }
};

// src/ShadowMaterial.ts
import {
  GLSL3 as GLSL33,
  Matrix4 as Matrix43,
  RawShaderMaterial as RawShaderMaterial2,
  Uniform as Uniform3,
  Vector2 as Vector26
} from "three";
import {
  define as define3,
  defineExpression as defineExpression2,
  defineInt as defineInt2,
  resolveIncludes as resolveIncludes3,
  unrollLoops as unrollLoops3
} from "@takram/three-geospatial";
import { math as math2, raySphereIntersection as raySphereIntersection2 } from "@takram/three-geospatial/shaders";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/shadow.frag
var shadow_default = 'precision highp float;\nprecision highp sampler3D;\n\n#include <common>\n\n#include "core/math"\n#include "core/raySphereIntersection"\n#include "types"\n#include "parameters"\n#include "structuredSampling"\n#include "clouds"\n\nuniform mat4 inverseShadowMatrices[CASCADE_COUNT];\nuniform mat4 reprojectionMatrices[CASCADE_COUNT];\n\n// Primary raymarch\nuniform int maxIterationCount;\nuniform float minStepSize;\nuniform float maxStepSize;\nuniform float opticalDepthTailScale;\n\nin vec2 vUv;\n\nlayout(location = 0) out vec4 outputColor[CASCADE_COUNT];\n\n// Redundant notation for prettier.\n#if CASCADE_COUNT == 1\nlayout(location = 1) out vec3 outputDepthVelocity[CASCADE_COUNT];\n#elif CASCADE_COUNT == 2\nlayout(location = 2) out vec3 outputDepthVelocity[CASCADE_COUNT];\n#elif CASCADE_COUNT == 3\nlayout(location = 3) out vec3 outputDepthVelocity[CASCADE_COUNT];\n#elif CASCADE_COUNT == 4\nlayout(location = 4) out vec3 outputDepthVelocity[CASCADE_COUNT];\n#endif // CASCADE_COUNT\n\nvec4 marchClouds(\n  const vec3 rayOrigin,\n  const vec3 rayDirection,\n  const float maxRayDistance,\n  const float jitter,\n  const float mipLevel\n) {\n  // Setup structured volume sampling (SVS).\n  // While SVS introduces spatial aliasing, it is indeed temporally stable,\n  // which is important for lower-resolution shadow maps where a flickering\n  // single pixel can be highly noticeable.\n  vec3 normal = getStructureNormal(rayDirection, jitter);\n  float rayDistance;\n  float stepSize;\n  intersectStructuredPlanes(\n    normal,\n    rayOrigin,\n    rayDirection,\n    clamp(maxRayDistance / float(maxIterationCount), minStepSize, maxStepSize),\n    rayDistance,\n    stepSize\n  );\n\n  #ifdef TEMPORAL_JITTER\n  rayDistance -= stepSize * jitter;\n  #endif // TEMPORAL_JITTER\n\n  float extinctionSum = 0.0;\n  float maxOpticalDepth = 0.0;\n  float maxOpticalDepthTail = 0.0;\n  float transmittanceIntegral = 1.0;\n  float weightedDistanceSum = 0.0;\n  float transmittanceSum = 0.0;\n\n  int sampleCount = 0;\n  for (int i = 0; i < maxIterationCount; ++i) {\n    if (rayDistance > maxRayDistance) {\n      break; // Termination\n    }\n\n    vec3 position = rayDistance * rayDirection + rayOrigin;\n    float height = length(position) - bottomRadius;\n\n    #if !defined(DEBUG_MARCH_INTERVALS)\n    if (insideLayerIntervals(height)) {\n      rayDistance += stepSize;\n      continue;\n    }\n    #endif // !defined(DEBUG_MARCH_INTERVALS)\n\n    // Sample rough weather.\n    vec2 uv = getGlobeUv(position);\n    WeatherSample weather = sampleWeather(uv, height, mipLevel);\n\n    if (any(greaterThan(weather.density, vec4(minDensity)))) {\n      // Sample detailed participating media.\n      // Note this assumes an homogeneous medium.\n      MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter);\n      if (media.extinction > minExtinction) {\n        extinctionSum += media.extinction;\n        maxOpticalDepth += media.extinction * stepSize;\n        transmittanceIntegral *= exp(-media.extinction * stepSize);\n        weightedDistanceSum += rayDistance * transmittanceIntegral;\n        transmittanceSum += transmittanceIntegral;\n        ++sampleCount;\n      }\n    }\n\n    if (transmittanceIntegral <= minTransmittance) {\n      // A large amount of optical depth accumulates in the tail, beyond the\n      // point of minimum transmittance. The expected optical depth seems to\n      // decrease exponentially with the number of samples taken before reaching\n      // the minimum transmittance.\n      // See the discussion here: https://x.com/shotamatsuda/status/1886259549931520437\n      maxOpticalDepthTail = min(\n        opticalDepthTailScale * stepSize * exp(float(1 - sampleCount)),\n        stepSize * 0.5 // Excessive optical depth only introduces aliasing.\n      );\n      break; // Early termination\n    }\n    rayDistance += stepSize;\n  }\n\n  if (sampleCount == 0) {\n    return vec4(maxRayDistance, 0.0, 0.0, 0.0);\n  }\n  float frontDepth = min(weightedDistanceSum / transmittanceSum, maxRayDistance);\n  float meanExtinction = extinctionSum / float(sampleCount);\n  return vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail);\n}\n\nvoid getRayNearFar(\n  const vec3 sunPosition,\n  const vec3 rayDirection,\n  out float rayNear,\n  out float rayFar\n) {\n  vec4 firstIntersections = raySphereFirstIntersection(\n    sunPosition,\n    rayDirection,\n    vec3(0.0),\n    bottomRadius + vec4(shadowTopHeight, shadowBottomHeight, 0.0, 0.0)\n  );\n  rayNear = max(0.0, firstIntersections.x);\n  rayFar = firstIntersections.y;\n  if (rayFar < 0.0) {\n    rayFar = 1e6;\n  }\n}\n\nvoid cascade(\n  const int cascadeIndex,\n  const float mipLevel,\n  out vec4 outputColor,\n  out vec3 outputDepthVelocity\n) {\n  vec2 clip = vUv * 2.0 - 1.0;\n  vec4 point = inverseShadowMatrices[cascadeIndex] * vec4(clip.xy, -1.0, 1.0);\n  point /= point.w;\n  vec3 sunPosition = (worldToECEFMatrix * vec4(point.xyz, 1.0)).xyz + altitudeCorrection;\n\n  vec3 rayDirection = normalize(-sunDirection);\n  float rayNear;\n  float rayFar;\n  getRayNearFar(sunPosition, rayDirection, rayNear, rayFar);\n\n  vec3 rayOrigin = rayNear * rayDirection + sunPosition;\n  float stbn = getSTBN();\n  vec4 color = marchClouds(rayOrigin, rayDirection, rayFar - rayNear, stbn, mipLevel);\n  outputColor = color;\n\n  // Velocity for temporal resolution.\n  #ifdef TEMPORAL_PASS\n  vec3 frontPosition = color.x * rayDirection + rayOrigin;\n  vec3 frontPositionWorld = (ecefToWorldMatrix * vec4(frontPosition - altitudeCorrection, 1.0)).xyz;\n  vec4 prevClip = reprojectionMatrices[cascadeIndex] * vec4(frontPositionWorld, 1.0);\n  prevClip /= prevClip.w;\n  vec2 prevUv = prevClip.xy * 0.5 + 0.5;\n  vec2 velocity = (vUv - prevUv) * resolution;\n  outputDepthVelocity = vec3(color.x, velocity);\n  #else // TEMPORAL_PASS\n  outputDepthVelocity = vec3(0.0);\n  #endif // TEMPORAL_PASS\n}\n\n// TODO: Calculate from the main camera frustum perhaps?\nconst float mipLevels[4] = float[4](0.0, 0.5, 1.0, 2.0);\n\nvoid main() {\n  #pragma unroll_loop_start\n  for (int i = 0; i < 4; ++i) {\n    #if UNROLLED_LOOP_INDEX < CASCADE_COUNT\n    cascade(UNROLLED_LOOP_INDEX, mipLevels[i], outputColor[i], outputDepthVelocity[i]);\n    #endif // UNROLLED_LOOP_INDEX < CASCADE_COUNT\n  }\n  #pragma unroll_loop_end\n}\n';

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/shadow.vert
var shadow_default2 = "precision highp float;\n\nlayout(location = 0) in vec3 position;\n\nout vec2 vUv;\n\nvoid main() {\n  vUv = position.xy * 0.5 + 0.5;\n  gl_Position = vec4(position.xy, 1.0, 1.0);\n}\n";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/structuredSampling.glsl
var structuredSampling_default = "// Implements Structured Volume Sampling in fragment shader:\n// https://github.com/huwb/volsample\n// Implementation reference:\n// https://www.shadertoy.com/view/ttVfDc\n\nvoid getIcosahedralVertices(const vec3 direction, out vec3 v1, out vec3 v2, out vec3 v3) {\n  // Normalization scalers to fit dodecahedron to unit sphere.\n  const float a = 0.85065080835204; // phi / sqrt(2 + phi)\n  const float b = 0.5257311121191336; // 1 / sqrt(2 + phi)\n\n  // Derive the vertices of icosahedron where triangle intersects the direction.\n  // See: https://www.ppsloan.org/publications/AmbientDice.pdf\n  const float kT = 0.6180339887498948; // 1 / phi\n  const float kT2 = 0.38196601125010515; // 1 / phi^2\n  vec3 absD = abs(direction);\n  float selector1 = dot(absD, vec3(1.0, kT2, -kT));\n  float selector2 = dot(absD, vec3(-kT, 1.0, kT2));\n  float selector3 = dot(absD, vec3(kT2, -kT, 1.0));\n  v1 = selector1 > 0.0 ? vec3(a, b, 0.0) : vec3(-b, 0.0, a);\n  v2 = selector2 > 0.0 ? vec3(0.0, a, b) : vec3(a, -b, 0.0);\n  v3 = selector3 > 0.0 ? vec3(b, 0.0, a) : vec3(0.0, a, -b);\n  vec3 octantSign = sign(direction);\n  v1 *= octantSign;\n  v2 *= octantSign;\n  v3 *= octantSign;\n}\n\nvoid swapIfBigger(inout vec4 a, inout vec4 b) {\n  if (a.w > b.w) {\n    vec4 t = a;\n    a = b;\n    b = t;\n  }\n}\n\nvoid sortVertices(inout vec3 a, inout vec3 b, inout vec3 c) {\n  const vec3 base = vec3(0.5, 0.5, 1.0);\n  vec4 aw = vec4(a, dot(a, base));\n  vec4 bw = vec4(b, dot(b, base));\n  vec4 cw = vec4(c, dot(c, base));\n  swapIfBigger(aw, bw);\n  swapIfBigger(bw, cw);\n  swapIfBigger(aw, bw);\n  a = aw.xyz;\n  b = bw.xyz;\n  c = cw.xyz;\n}\n\nvec3 getPentagonalWeights(const vec3 direction, const vec3 v1, const vec3 v2, const vec3 v3) {\n  float d1 = dot(v1, direction);\n  float d2 = dot(v2, direction);\n  float d3 = dot(v3, direction);\n  vec3 w = exp(vec3(d1, d2, d3) * 40.0);\n  return w / (w.x + w.y + w.z);\n}\n\nvec3 getStructureNormal(\n  const vec3 direction,\n  const float jitter,\n  out vec3 a,\n  out vec3 b,\n  out vec3 c,\n  out vec3 weights\n) {\n  getIcosahedralVertices(direction, a, b, c);\n  sortVertices(a, b, c);\n  weights = getPentagonalWeights(direction, a, b, c);\n  return jitter < weights.x\n    ? a\n    : jitter < weights.x + weights.y\n      ? b\n      : c;\n}\n\nvec3 getStructureNormal(const vec3 direction, const float jitter) {\n  vec3 a, b, c, weights;\n  return getStructureNormal(direction, jitter, a, b, c, weights);\n}\n\n// Reference: https://github.com/huwb/volsample/blob/master/src/unity/Assets/Shaders/RayMarchCore.cginc\nvoid intersectStructuredPlanes(\n  const vec3 normal,\n  const vec3 rayOrigin,\n  const vec3 rayDirection,\n  const float samplePeriod,\n  out float stepOffset,\n  out float stepSize\n) {\n  float NoD = dot(rayDirection, normal);\n  stepSize = samplePeriod / abs(NoD);\n\n  // Skips leftover bit to get from rayOrigin to first strata plane.\n  stepOffset = -mod(dot(rayOrigin, normal), samplePeriod) / NoD;\n\n  // mod() gives different results depending on if the arg is negative or\n  // positive. This line makes it consistent, and ensures the first sample is in\n  // front of the viewer.\n  if (stepOffset < 0.0) {\n    stepOffset += stepSize;\n  }\n}\n";

// src/ShadowMaterial.ts
var ShadowMaterial = class extends RawShaderMaterial2 {
  constructor({
    parameterUniforms,
    layerUniforms,
    atmosphereUniforms
  }) {
    super({
      name: "ShadowMaterial",
      glslVersion: GLSL33,
      vertexShader: shadow_default2,
      fragmentShader: unrollLoops3(
        resolveIncludes3(shadow_default, {
          core: {
            math: math2,
            raySphereIntersection: raySphereIntersection2
          },
          types: types_default,
          parameters: parameters_default,
          structuredSampling: structuredSampling_default,
          clouds: clouds_default2
        })
      ),
      uniforms: {
        ...parameterUniforms,
        ...layerUniforms,
        ...atmosphereUniforms,
        inverseShadowMatrices: new Uniform3(
          Array.from({ length: 4 }, () => new Matrix43())
          // Populate the max number of elements
        ),
        reprojectionMatrices: new Uniform3(
          Array.from({ length: 4 }, () => new Matrix43())
          // Populate the max number of elements
        ),
        resolution: new Uniform3(new Vector26()),
        frame: new Uniform3(0),
        stbnTexture: new Uniform3(null),
        // Primary raymarch
        maxIterationCount: new Uniform3(defaults.shadow.maxIterationCount),
        minStepSize: new Uniform3(defaults.shadow.minStepSize),
        maxStepSize: new Uniform3(defaults.shadow.maxStepSize),
        minDensity: new Uniform3(defaults.shadow.minDensity),
        minExtinction: new Uniform3(defaults.shadow.minExtinction),
        minTransmittance: new Uniform3(defaults.shadow.minTransmittance),
        opticalDepthTailScale: new Uniform3(2)
      },
      defines: {
        SHADOW: "1",
        TEMPORAL_PASS: "1",
        TEMPORAL_JITTER: "1"
      }
    });
    this.localWeatherChannels = "rgba";
    this.cascadeCount = defaults.shadow.cascadeCount;
    this.temporalPass = true;
    this.temporalJitter = true;
    this.shapeDetail = defaults.shapeDetail;
    this.turbulence = defaults.turbulence;
    this.cascadeCount = defaults.shadow.cascadeCount;
  }
  setSize(width, height) {
    this.uniforms.resolution.value.set(width, height);
  }
};
__decorateClass([
  defineExpression2("LOCAL_WEATHER_CHANNELS", {
    validate: (value) => /^[rgba]{4}$/.test(value)
  })
], ShadowMaterial.prototype, "localWeatherChannels", 2);
__decorateClass([
  defineInt2("CASCADE_COUNT", { min: 1, max: 4 })
], ShadowMaterial.prototype, "cascadeCount", 2);
__decorateClass([
  define3("TEMPORAL_PASS")
], ShadowMaterial.prototype, "temporalPass", 2);
__decorateClass([
  define3("TEMPORAL_JITTER")
], ShadowMaterial.prototype, "temporalJitter", 2);
__decorateClass([
  define3("SHAPE_DETAIL")
], ShadowMaterial.prototype, "shapeDetail", 2);
__decorateClass([
  define3("TURBULENCE")
], ShadowMaterial.prototype, "turbulence", 2);

// src/ShadowResolveMaterial.ts
import {
  GLSL3 as GLSL34,
  RawShaderMaterial as RawShaderMaterial3,
  Uniform as Uniform4,
  Vector2 as Vector27
} from "three";
import {
  defineInt as defineInt3,
  resolveIncludes as resolveIncludes4,
  unrollLoops as unrollLoops4
} from "@takram/three-geospatial";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/shadowResolve.frag
var shadowResolve_default = 'precision highp float;\nprecision highp sampler2DArray;\n\n#define VARIANCE_9_SAMPLES 1\n#define VARIANCE_SAMPLER_ARRAY 1\n\n#include "varianceClipping"\n\nuniform sampler2DArray inputBuffer;\nuniform sampler2DArray historyBuffer;\n\nuniform vec2 texelSize;\nuniform float varianceGamma;\nuniform float temporalAlpha;\n\nin vec2 vUv;\n\nlayout(location = 0) out vec4 outputColor[CASCADE_COUNT];\n\nconst ivec2 neighborOffsets[9] = ivec2[9](\n  ivec2(-1, -1),\n  ivec2(-1, 0),\n  ivec2(-1, 1),\n  ivec2(0, -1),\n  ivec2(0, 0),\n  ivec2(0, 1),\n  ivec2(1, -1),\n  ivec2(1, 0),\n  ivec2(1, 1)\n);\n\nvec4 getClosestFragment(const ivec3 coord) {\n  vec4 result = vec4(1e7, 0.0, 0.0, 0.0);\n  vec4 neighbor;\n  #pragma unroll_loop_start\n  for (int i = 0; i < 9; ++i) {\n    neighbor = texelFetchOffset(\n      inputBuffer,\n      coord + ivec3(0, 0, CASCADE_COUNT),\n      0,\n      neighborOffsets[i]\n    );\n    if (neighbor.r < result.r) {\n      result = neighbor;\n    }\n  }\n  #pragma unroll_loop_end\n  return result;\n}\n\nvoid cascade(const int cascadeIndex, out vec4 outputColor) {\n  ivec3 coord = ivec3(gl_FragCoord.xy, cascadeIndex);\n  vec4 current = texelFetch(inputBuffer, coord, 0);\n\n  vec4 depthVelocity = getClosestFragment(coord);\n  vec2 velocity = depthVelocity.gb * texelSize;\n  vec2 prevUv = vUv - velocity;\n  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {\n    outputColor = current;\n    return; // Rejection\n  }\n\n  vec4 history = texture(historyBuffer, vec3(prevUv, float(cascadeIndex)));\n  vec4 clippedHistory = varianceClipping(inputBuffer, coord, current, history, varianceGamma);\n  outputColor = mix(clippedHistory, current, temporalAlpha);\n}\n\nvoid main() {\n  #pragma unroll_loop_start\n  for (int i = 0; i < 4; ++i) {\n    #if UNROLLED_LOOP_INDEX < CASCADE_COUNT\n    cascade(UNROLLED_LOOP_INDEX, outputColor[i]);\n    #endif // UNROLLED_LOOP_INDEX < CASCADE_COUNT\n  }\n  #pragma unroll_loop_end\n}\n';

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/shadowResolve.vert
var shadowResolve_default2 = "precision highp float;\n\nlayout(location = 0) in vec3 position;\n\nout vec2 vUv;\n\nvoid main() {\n  vUv = position.xy * 0.5 + 0.5;\n  gl_Position = vec4(position.xy, 1.0, 1.0);\n}\n";

// src/ShadowResolveMaterial.ts
var ShadowResolveMaterial = class extends RawShaderMaterial3 {
  constructor({
    inputBuffer = null,
    historyBuffer = null
  } = {}) {
    super({
      name: "ShadowResolveMaterial",
      glslVersion: GLSL34,
      vertexShader: shadowResolve_default2,
      fragmentShader: unrollLoops4(
        resolveIncludes4(shadowResolve_default, {
          varianceClipping: varianceClipping_default
        })
      ),
      uniforms: {
        inputBuffer: new Uniform4(inputBuffer),
        historyBuffer: new Uniform4(historyBuffer),
        texelSize: new Uniform4(new Vector27()),
        varianceGamma: new Uniform4(1),
        // Use a very slow alpha because a single flickering pixel can be highly
        // noticeable in shadow maps. This value can be increased if temporal
        // jitter is turned off in the shadows rendering, but it will suffer
        // from spatial aliasing.
        temporalAlpha: new Uniform4(0.01)
      },
      defines: {}
    });
    this.cascadeCount = defaults.shadow.cascadeCount;
  }
  setSize(width, height) {
    this.uniforms.texelSize.value.set(1 / width, 1 / height);
  }
};
__decorateClass([
  defineInt3("CASCADE_COUNT", { min: 1, max: 4 })
], ShadowResolveMaterial.prototype, "cascadeCount", 2);

// src/ShadowPass.ts
function createRenderTarget2(name) {
  const renderTarget = new WebGLArrayRenderTarget(1, 1, 1, {
    depthBuffer: false
  });
  renderTarget.texture.type = HalfFloatType2;
  renderTarget.texture.minFilter = LinearFilter2;
  renderTarget.texture.magFilter = LinearFilter2;
  renderTarget.texture.name = name;
  return renderTarget;
}
var ShadowPass = class extends PassBase {
  constructor({
    parameterUniforms,
    layerUniforms,
    atmosphereUniforms,
    ...options
  }) {
    super("ShadowPass", options);
    this.width = 0;
    this.height = 0;
    this.currentMaterial = new ShadowMaterial({
      parameterUniforms,
      layerUniforms,
      atmosphereUniforms
    });
    this.currentPass = new ShaderArrayPass(this.currentMaterial);
    this.resolveMaterial = new ShadowResolveMaterial();
    this.resolvePass = new ShaderArrayPass(this.resolveMaterial);
    this.initRenderTargets();
  }
  initialize(renderer, alpha, frameBufferType) {
    this.currentPass.initialize(renderer, alpha, frameBufferType);
    this.resolvePass.initialize(renderer, alpha, frameBufferType);
  }
  initRenderTargets() {
    this.currentRenderTarget?.dispose();
    this.resolveRenderTarget?.dispose();
    this.historyRenderTarget?.dispose();
    const current = createRenderTarget2("Shadow");
    const resolve = this.temporalPass ? createRenderTarget2("Shadow.A") : null;
    const history = this.temporalPass ? createRenderTarget2("Shadow.B") : null;
    this.currentRenderTarget = current;
    this.resolveRenderTarget = resolve;
    this.historyRenderTarget = history;
    const resolveUniforms = this.resolveMaterial.uniforms;
    resolveUniforms.inputBuffer.value = current.texture;
    resolveUniforms.historyBuffer.value = history?.texture ?? null;
  }
  copyShadow() {
    const shadow = this.shadow;
    const currentUniforms = this.currentMaterial.uniforms;
    for (let i = 0; i < shadow.cascadeCount; ++i) {
      const cascade = shadow.cascades[i];
      currentUniforms.inverseShadowMatrices.value[i].copy(cascade.inverseMatrix);
    }
  }
  copyReprojection() {
    const shadow = this.shadow;
    const uniforms = this.currentMaterial.uniforms;
    for (let i = 0; i < shadow.cascadeCount; ++i) {
      const cascade = shadow.cascades[i];
      uniforms.reprojectionMatrices.value[i].copy(cascade.matrix);
    }
  }
  swapBuffers() {
    invariant(this.historyRenderTarget != null);
    invariant(this.resolveRenderTarget != null);
    const nextResolve = this.historyRenderTarget;
    const nextHistory = this.resolveRenderTarget;
    this.resolveRenderTarget = nextResolve;
    this.historyRenderTarget = nextHistory;
    this.resolveMaterial.uniforms.historyBuffer.value = nextHistory.texture;
  }
  update(renderer, frame, deltaTime) {
    this.currentMaterial.uniforms.frame.value = frame;
    this.copyShadow();
    this.currentPass.render(renderer, null, this.currentRenderTarget);
    if (this.temporalPass) {
      invariant(this.resolveRenderTarget != null);
      this.resolvePass.render(renderer, null, this.resolveRenderTarget);
      this.copyReprojection();
      this.swapBuffers();
    }
  }
  setSize(width, height, depth2 = this.shadow.cascadeCount) {
    this.width = width;
    this.height = height;
    this.currentMaterial.cascadeCount = depth2;
    this.resolveMaterial.cascadeCount = depth2;
    this.currentMaterial.setSize(width, height);
    this.resolveMaterial.setSize(width, height);
    this.currentRenderTarget.setSize(
      width,
      height,
      this.temporalPass ? depth2 * 2 : depth2
      // For depth velocity
    );
    this.resolveRenderTarget?.setSize(width, height, depth2);
    this.historyRenderTarget?.setSize(width, height, depth2);
  }
  get outputBuffer() {
    if (this.temporalPass) {
      invariant(this.historyRenderTarget != null);
      return this.historyRenderTarget.texture;
    }
    return this.currentRenderTarget.texture;
  }
  get temporalPass() {
    return this.currentMaterial.temporalPass;
  }
  set temporalPass(value) {
    if (value !== this.temporalPass) {
      this.currentMaterial.temporalPass = value;
      this.initRenderTargets();
      this.setSize(this.width, this.height);
    }
  }
};

// src/uniforms.ts
import {
  Uniform as Uniform5,
  Vector3 as Vector34,
  Vector4 as Vector42
} from "three";
function createCloudParameterUniforms(instances) {
  return {
    // Participating medium
    scatteringCoefficient: new Uniform5(1),
    absorptionCoefficient: new Uniform5(0),
    // Weather and shape
    coverage: new Uniform5(0.3),
    localWeatherTexture: new Uniform5(instances.localWeatherTexture),
    localWeatherRepeat: new Uniform5(instances.localWeatherRepeat),
    localWeatherOffset: new Uniform5(instances.localWeatherOffset),
    shapeTexture: new Uniform5(instances.shapeTexture),
    shapeRepeat: new Uniform5(instances.shapeRepeat),
    shapeOffset: new Uniform5(instances.shapeOffset),
    shapeDetailTexture: new Uniform5(instances.shapeDetailTexture),
    shapeDetailRepeat: new Uniform5(instances.shapeDetailRepeat),
    shapeDetailOffset: new Uniform5(instances.shapeDetailOffset),
    turbulenceTexture: new Uniform5(instances.turbulenceTexture),
    turbulenceRepeat: new Uniform5(instances.turbulenceRepeat),
    turbulenceDisplacement: new Uniform5(350)
  };
}
function createCloudLayerUniforms() {
  return {
    minLayerHeights: new Uniform5(new Vector42()),
    maxLayerHeights: new Uniform5(new Vector42()),
    minIntervalHeights: new Uniform5(new Vector34()),
    maxIntervalHeights: new Uniform5(new Vector34()),
    densityScales: new Uniform5(new Vector42()),
    shapeAmounts: new Uniform5(new Vector42()),
    shapeDetailAmounts: new Uniform5(new Vector42()),
    weatherExponents: new Uniform5(new Vector42()),
    shapeAlteringBiases: new Uniform5(new Vector42()),
    coverageFilterWidths: new Uniform5(new Vector42()),
    minHeight: new Uniform5(0),
    maxHeight: new Uniform5(0),
    shadowTopHeight: new Uniform5(0),
    shadowBottomHeight: new Uniform5(0),
    shadowLayerMask: new Uniform5(new Vector42()),
    densityProfile: new Uniform5({
      expTerms: new Vector42(),
      exponents: new Vector42(),
      linearTerms: new Vector42(),
      constantTerms: new Vector42()
    })
  };
}
var shadowLayerMask = [0, 0, 0, 0];
function updateCloudLayerUniforms(uniforms, layers) {
  layers.packValues("altitude", uniforms.minLayerHeights.value);
  layers.packSums("altitude", "height", uniforms.maxLayerHeights.value);
  layers.packIntervalHeights(
    uniforms.minIntervalHeights.value,
    uniforms.maxIntervalHeights.value
  );
  layers.packValues("densityScale", uniforms.densityScales.value);
  layers.packValues("shapeAmount", uniforms.shapeAmounts.value);
  layers.packValues("shapeDetailAmount", uniforms.shapeDetailAmounts.value);
  layers.packValues("weatherExponent", uniforms.weatherExponents.value);
  layers.packValues("shapeAlteringBias", uniforms.shapeAlteringBiases.value);
  layers.packValues("coverageFilterWidth", uniforms.coverageFilterWidths.value);
  const densityProfile = uniforms.densityProfile.value;
  layers.packDensityProfiles("expTerm", densityProfile.expTerms);
  layers.packDensityProfiles("exponent", densityProfile.exponents);
  layers.packDensityProfiles("linearTerm", densityProfile.linearTerms);
  layers.packDensityProfiles("constantTerm", densityProfile.constantTerms);
  let totalMinHeight = Infinity;
  let totalMaxHeight = 0;
  let shadowBottomHeight = Infinity;
  let shadowTopHeight = 0;
  shadowLayerMask.fill(0);
  for (let i = 0; i < layers.length; ++i) {
    const { altitude, height, shadow } = layers[i];
    const maxHeight = altitude + height;
    if (height > 0) {
      if (altitude < totalMinHeight) {
        totalMinHeight = altitude;
      }
      if (shadow && altitude < shadowBottomHeight) {
        shadowBottomHeight = altitude;
      }
      if (maxHeight > totalMaxHeight) {
        totalMaxHeight = maxHeight;
      }
      if (shadow && maxHeight > shadowTopHeight) {
        shadowTopHeight = maxHeight;
      }
    }
    shadowLayerMask[i] = shadow ? 1 : 0;
  }
  if (totalMinHeight !== Infinity) {
    uniforms.minHeight.value = totalMinHeight;
    uniforms.maxHeight.value = totalMaxHeight;
  } else {
    invariant(totalMaxHeight === 0);
    uniforms.minHeight.value = 0;
  }
  if (shadowBottomHeight !== Infinity) {
    uniforms.shadowBottomHeight.value = shadowBottomHeight;
    uniforms.shadowTopHeight.value = shadowTopHeight;
  } else {
    invariant(shadowTopHeight === 0);
    uniforms.shadowBottomHeight.value = 0;
  }
  uniforms.shadowLayerMask.value.fromArray(shadowLayerMask);
}
function createAtmosphereUniforms(atmosphere, instances) {
  return {
    bottomRadius: new Uniform5(atmosphere.bottomRadius),
    topRadius: new Uniform5(atmosphere.topRadius),
    worldToECEFMatrix: new Uniform5(instances.worldToECEFMatrix),
    ecefToWorldMatrix: new Uniform5(instances.ecefToWorldMatrix),
    altitudeCorrection: new Uniform5(instances.altitudeCorrection),
    sunDirection: new Uniform5(instances.sunDirection)
  };
}

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/cloudsEffect.frag
var cloudsEffect_default = "uniform sampler2D cloudsBuffer;\n\nvoid mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {\n  #ifdef SKIP_RENDERING\n  outputColor = inputColor;\n  #else // SKIP_RENDERING\n  vec4 clouds = texture(cloudsBuffer, uv);\n  outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb;\n  outputColor.a = inputColor.a * (1.0 - clouds.a) + clouds.a;\n  #endif // SKIP_RENDERING\n}\n";

// src/CloudsEffect.ts
var vector3Scratch = /* @__PURE__ */ new Vector35();
var vector2Scratch = /* @__PURE__ */ new Vector28();
var rotationScratch = /* @__PURE__ */ new Matrix3();
var cloudsUniformKeys = [
  "maxIterationCount",
  "minStepSize",
  "maxStepSize",
  "maxRayDistance",
  "perspectiveStepScale",
  "minDensity",
  "minExtinction",
  "minTransmittance",
  "maxIterationCountToSun",
  "maxIterationCountToGround",
  "minSecondaryStepSize",
  "secondaryStepScale",
  "maxShadowFilterRadius",
  "maxShadowLengthIterationCount",
  "minShadowLengthStepSize",
  "maxShadowLengthRayDistance",
  "hazeDensityScale",
  "hazeExponent",
  "hazeScatteringCoefficient",
  "hazeAbsorptionCoefficient"
];
var cloudsMaterialParameterKeys = [
  "multiScatteringOctaves",
  "accurateSunSkyLight",
  "accuratePhaseFunction"
];
var shadowUniformKeys = [
  "maxIterationCount",
  "minStepSize",
  "maxStepSize",
  "minDensity",
  "minExtinction",
  "minTransmittance",
  "opticalDepthTailScale"
];
var shadowMaterialParameterKeys = [
  "temporalJitter"
];
var shadowPassParameterKeys = [
  "temporalPass"
];
var shadowMapsParameterKeys = [
  "cascadeCount",
  "mapSize",
  "maxFar",
  "farScale",
  "splitMode",
  "splitLambda"
];
var changeEvent = {
  type: "change"
};
var cloudsPassOptionsDefaults = {
  resolutionScale: defaults.resolutionScale,
  width: Resolution.AUTO_SIZE,
  height: Resolution.AUTO_SIZE
};
var CloudsEffect = class extends Effect {
  constructor(camera = new Camera2(), options, atmosphere = AtmosphereParameters2.DEFAULT) {
    super("CloudsEffect", cloudsEffect_default, {
      attributes: EffectAttribute.DEPTH,
      uniforms: /* @__PURE__ */ new Map([["cloudsBuffer", new Uniform6(null)]])
    });
    this.camera = camera;
    this.atmosphere = atmosphere;
    this.cloudLayers = CloudLayers.DEFAULT.clone();
    this.correctAltitude = true;
    // Mutable instances of cloud parameter uniforms
    this.localWeatherRepeat = new Vector28().setScalar(100);
    this.localWeatherOffset = new Vector28();
    this.shapeRepeat = new Vector35().setScalar(3e-4);
    this.shapeOffset = new Vector35();
    this.shapeDetailRepeat = new Vector35().setScalar(6e-3);
    this.shapeDetailOffset = new Vector35();
    this.turbulenceRepeat = new Vector28().setScalar(20);
    // Mutable instances of atmosphere parameter uniforms
    this.worldToECEFMatrix = new Matrix44();
    this.ecefToWorldMatrix = new Matrix44();
    this.altitudeCorrection = new Vector35();
    this.sunDirection = new Vector35();
    this.localWeatherVelocity = new Vector28();
    this.shapeVelocity = new Vector35();
    this.shapeDetailVelocity = new Vector35();
    this._atmosphereOverlay = null;
    this._atmosphereShadow = null;
    this._atmosphereShadowLength = null;
    this.events = new EventDispatcher();
    this.frame = 0;
    this.shadowCascadeCount = 0;
    this.shadowMapSize = new Vector28();
    this.onResolutionChange = () => {
      this.setSize(this.resolution.baseWidth, this.resolution.baseHeight);
    };
    this.skipRendering = true;
    const {
      resolutionScale,
      width,
      height,
      resolutionX = width,
      resolutionY = height
    } = {
      ...cloudsPassOptionsDefaults,
      ...options
    };
    this.shadowMaps = new CascadedShadowMaps({
      cascadeCount: defaults.shadow.cascadeCount,
      mapSize: defaults.shadow.mapSize,
      splitLambda: 0.6
    });
    this.parameterUniforms = createCloudParameterUniforms({
      localWeatherTexture: this.proceduralLocalWeather?.texture ?? null,
      localWeatherRepeat: this.localWeatherRepeat,
      localWeatherOffset: this.localWeatherOffset,
      shapeTexture: this.proceduralShape?.texture ?? null,
      shapeRepeat: this.shapeRepeat,
      shapeOffset: this.shapeOffset,
      shapeDetailTexture: this.proceduralShapeDetail?.texture ?? null,
      shapeDetailRepeat: this.shapeDetailRepeat,
      shapeDetailOffset: this.shapeDetailOffset,
      turbulenceTexture: this.proceduralTurbulence?.texture ?? null,
      turbulenceRepeat: this.turbulenceRepeat
    });
    this.layerUniforms = createCloudLayerUniforms();
    this.atmosphereUniforms = createAtmosphereUniforms(atmosphere, {
      worldToECEFMatrix: this.worldToECEFMatrix,
      ecefToWorldMatrix: this.ecefToWorldMatrix,
      altitudeCorrection: this.altitudeCorrection,
      sunDirection: this.sunDirection
    });
    const passOptions = {
      shadow: this.shadowMaps,
      parameterUniforms: this.parameterUniforms,
      layerUniforms: this.layerUniforms,
      atmosphereUniforms: this.atmosphereUniforms
    };
    this.shadowPass = new ShadowPass(passOptions);
    this.shadowPass.mainCamera = camera;
    this.cloudsPass = new CloudsPass(passOptions, atmosphere);
    this.cloudsPass.mainCamera = camera;
    this.clouds = definePropertyShorthand(
      defineUniformShorthand(
        {},
        this.cloudsPass.currentMaterial,
        cloudsUniformKeys
      ),
      this.cloudsPass.currentMaterial,
      cloudsMaterialParameterKeys
    );
    this.shadow = definePropertyShorthand(
      defineUniformShorthand(
        {},
        this.shadowPass.currentMaterial,
        shadowUniformKeys
      ),
      this.shadowPass.currentMaterial,
      shadowMaterialParameterKeys,
      this.shadowPass,
      shadowPassParameterKeys,
      this.shadowMaps,
      shadowMapsParameterKeys
    );
    this.resolution = new Resolution(
      this,
      resolutionX,
      resolutionY,
      resolutionScale
    );
    this.resolution.addEventListener("change", this.onResolutionChange);
  }
  get mainCamera() {
    return this.camera;
  }
  set mainCamera(value) {
    this.camera = value;
    this.shadowPass.mainCamera = value;
    this.cloudsPass.mainCamera = value;
  }
  initialize(renderer, alpha, frameBufferType) {
    this.shadowPass.initialize(renderer, alpha, frameBufferType);
    this.cloudsPass.initialize(renderer, alpha, frameBufferType);
  }
  updateSharedUniforms(deltaTime) {
    updateCloudLayerUniforms(this.layerUniforms, this.cloudLayers);
    const { parameterUniforms } = this;
    parameterUniforms.localWeatherOffset.value.add(
      vector2Scratch.copy(this.localWeatherVelocity).multiplyScalar(deltaTime)
    );
    parameterUniforms.shapeOffset.value.add(
      vector3Scratch.copy(this.shapeVelocity).multiplyScalar(deltaTime)
    );
    parameterUniforms.shapeDetailOffset.value.add(
      vector3Scratch.copy(this.shapeDetailVelocity).multiplyScalar(deltaTime)
    );
    const worldToECEFMatrix = this.worldToECEFMatrix;
    this.ecefToWorldMatrix.copy(worldToECEFMatrix).invert();
    const cameraPositionECEF = this.camera.getWorldPosition(vector3Scratch).applyMatrix4(this.worldToECEFMatrix);
    const altitudeCorrection = this.altitudeCorrection;
    if (this.correctAltitude) {
      getAltitudeCorrectionOffset(
        cameraPositionECEF,
        this.atmosphere.bottomRadius,
        this.ellipsoid,
        altitudeCorrection
      );
    } else {
      altitudeCorrection.setScalar(0);
    }
    const surfaceNormal = this.ellipsoid.getSurfaceNormal(
      cameraPositionECEF,
      vector3Scratch
    );
    const zenithAngle = this.sunDirection.dot(surfaceNormal);
    const distance = lerp2(1e6, 1e3, zenithAngle);
    const ecefToWorldRotation = rotationScratch.setFromMatrix4(worldToECEFMatrix).transpose();
    this.shadowMaps.update(
      this.camera,
      vector3Scratch.copy(this.sunDirection).applyMatrix3(ecefToWorldRotation),
      distance
    );
  }
  updateWeatherTextureChannels() {
    const value = this.cloudLayers.localWeatherChannels;
    this.cloudsPass.currentMaterial.localWeatherChannels = value;
    this.shadowPass.currentMaterial.localWeatherChannels = value;
  }
  updateAtmosphereComposition() {
    const { shadowMaps, shadowPass, cloudsPass } = this;
    const shadowUniforms = shadowPass.currentMaterial.uniforms;
    const cloudsUniforms = cloudsPass.currentMaterial.uniforms;
    const prevOverlay = this._atmosphereOverlay;
    const nextOverlay = Object.assign(this._atmosphereOverlay ?? {}, {
      map: cloudsPass.outputBuffer
    });
    if (prevOverlay !== nextOverlay) {
      this._atmosphereOverlay = nextOverlay;
      changeEvent.target = this;
      changeEvent.property = "atmosphereOverlay";
      this.events.dispatchEvent(changeEvent);
    }
    const prevShadow = this._atmosphereShadow;
    const nextShadow = Object.assign(this._atmosphereShadow ?? {}, {
      map: shadowPass.outputBuffer,
      mapSize: shadowMaps.mapSize,
      cascadeCount: shadowMaps.cascadeCount,
      intervals: cloudsUniforms.shadowIntervals.value,
      matrices: cloudsUniforms.shadowMatrices.value,
      inverseMatrices: shadowUniforms.inverseShadowMatrices.value,
      far: shadowMaps.far,
      topHeight: cloudsUniforms.shadowTopHeight.value
    });
    if (prevShadow !== nextShadow) {
      this._atmosphereShadow = nextShadow;
      changeEvent.target = this;
      changeEvent.property = "atmosphereShadow";
      this.events.dispatchEvent(changeEvent);
    }
    const prevShadowLength = this._atmosphereShadowLength;
    const nextShadowLength = cloudsPass.shadowLengthBuffer != null ? Object.assign(this._atmosphereShadowLength ?? {}, {
      map: cloudsPass.shadowLengthBuffer
    }) : null;
    if (prevShadowLength !== nextShadowLength) {
      this._atmosphereShadowLength = nextShadowLength;
      changeEvent.target = this;
      changeEvent.property = "atmosphereShadowLength";
      this.events.dispatchEvent(changeEvent);
    }
  }
  update(renderer, inputBuffer, deltaTime = 0) {
    const { shadowMaps, shadowPass, cloudsPass } = this;
    if (shadowMaps.cascadeCount !== this.shadowCascadeCount || !shadowMaps.mapSize.equals(this.shadowMapSize)) {
      const { width, height } = shadowMaps.mapSize;
      const depth2 = shadowMaps.cascadeCount;
      this.shadowMapSize.set(width, height);
      this.shadowCascadeCount = depth2;
      shadowPass.setSize(width, height, depth2);
      cloudsPass.setShadowSize(width, height, depth2);
    }
    this.proceduralLocalWeather?.render(renderer, deltaTime);
    this.proceduralShape?.render(renderer, deltaTime);
    this.proceduralShapeDetail?.render(renderer, deltaTime);
    this.proceduralTurbulence?.render(renderer, deltaTime);
    ++this.frame;
    this.updateSharedUniforms(deltaTime);
    this.updateWeatherTextureChannels();
    shadowPass.update(renderer, this.frame, deltaTime);
    cloudsPass.shadowBuffer = shadowPass.outputBuffer;
    cloudsPass.update(renderer, this.frame, deltaTime);
    this.updateAtmosphereComposition();
    this.uniforms.get("cloudsBuffer").value = this.cloudsPass.outputBuffer;
  }
  setSize(baseWidth, baseHeight) {
    const { resolution } = this;
    resolution.setBaseSize(baseWidth, baseHeight);
    const { width, height } = resolution;
    this.cloudsPass.setSize(width, height);
  }
  setDepthTexture(depthTexture, depthPacking) {
    this.shadowPass.setDepthTexture(depthTexture, depthPacking);
    this.cloudsPass.setDepthTexture(depthTexture, depthPacking);
  }
  // eslint-disable-next-line accessor-pairs
  set qualityPreset(value) {
    const { clouds, shadow, ...props } = qualityPresets[value];
    Object.assign(this, props);
    Object.assign(this.clouds, clouds);
    Object.assign(this.shadow, shadow);
  }
  // Textures
  get localWeatherTexture() {
    return this.proceduralLocalWeather ?? this.parameterUniforms.localWeatherTexture.value;
  }
  set localWeatherTexture(value) {
    if (value instanceof Texture || value == null) {
      this.proceduralLocalWeather = void 0;
      this.parameterUniforms.localWeatherTexture.value = value;
    } else {
      this.proceduralLocalWeather = value;
      this.parameterUniforms.localWeatherTexture.value = value.texture;
    }
  }
  get shapeTexture() {
    return this.proceduralShape ?? this.parameterUniforms.shapeTexture.value;
  }
  set shapeTexture(value) {
    if (value instanceof Data3DTexture || value == null) {
      this.proceduralShape = void 0;
      this.parameterUniforms.shapeTexture.value = value;
    } else {
      this.proceduralShape = value;
      this.parameterUniforms.shapeTexture.value = value.texture;
    }
  }
  get shapeDetailTexture() {
    return this.proceduralShapeDetail ?? this.parameterUniforms.shapeDetailTexture.value;
  }
  set shapeDetailTexture(value) {
    if (value instanceof Data3DTexture || value == null) {
      this.proceduralShapeDetail = void 0;
      this.parameterUniforms.shapeDetailTexture.value = value;
    } else {
      this.proceduralShapeDetail = value;
      this.parameterUniforms.shapeDetailTexture.value = value.texture;
    }
  }
  get turbulenceTexture() {
    return this.proceduralTurbulence ?? this.parameterUniforms.turbulenceTexture.value;
  }
  set turbulenceTexture(value) {
    if (value instanceof Texture || value == null) {
      this.proceduralTurbulence = void 0;
      this.parameterUniforms.turbulenceTexture.value = value;
    } else {
      this.proceduralTurbulence = value;
      this.parameterUniforms.turbulenceTexture.value = value.texture;
    }
  }
  get stbnTexture() {
    return this.cloudsPass.currentMaterial.uniforms.stbnTexture.value;
  }
  set stbnTexture(value) {
    this.cloudsPass.currentMaterial.uniforms.stbnTexture.value = value;
    this.shadowPass.currentMaterial.uniforms.stbnTexture.value = value;
  }
  // Rendering controls
  get resolutionScale() {
    return this.resolution.scale;
  }
  set resolutionScale(value) {
    this.resolution.scale = value;
  }
  get temporalUpscale() {
    return this.cloudsPass.temporalUpscale;
  }
  set temporalUpscale(value) {
    this.cloudsPass.temporalUpscale = value;
  }
  get lightShafts() {
    return this.cloudsPass.lightShafts;
  }
  set lightShafts(value) {
    this.cloudsPass.lightShafts = value;
  }
  get shapeDetail() {
    return this.cloudsPass.currentMaterial.shapeDetail;
  }
  set shapeDetail(value) {
    this.cloudsPass.currentMaterial.shapeDetail = value;
    this.shadowPass.currentMaterial.shapeDetail = value;
  }
  get turbulence() {
    return this.cloudsPass.currentMaterial.turbulence;
  }
  set turbulence(value) {
    this.cloudsPass.currentMaterial.turbulence = value;
    this.shadowPass.currentMaterial.turbulence = value;
  }
  get haze() {
    return this.cloudsPass.currentMaterial.haze;
  }
  set haze(value) {
    this.cloudsPass.currentMaterial.haze = value;
  }
  // Cloud parameter primitives
  get scatteringCoefficient() {
    return this.parameterUniforms.scatteringCoefficient.value;
  }
  set scatteringCoefficient(value) {
    this.parameterUniforms.scatteringCoefficient.value = value;
  }
  get absorptionCoefficient() {
    return this.parameterUniforms.absorptionCoefficient.value;
  }
  set absorptionCoefficient(value) {
    this.parameterUniforms.absorptionCoefficient.value = value;
  }
  get coverage() {
    return this.parameterUniforms.coverage.value;
  }
  set coverage(value) {
    this.parameterUniforms.coverage.value = value;
  }
  get turbulenceDisplacement() {
    return this.parameterUniforms.turbulenceDisplacement.value;
  }
  set turbulenceDisplacement(value) {
    this.parameterUniforms.turbulenceDisplacement.value = value;
  }
  // Scattering parameters
  get scatterAnisotropy1() {
    return this.cloudsPass.currentMaterial.scatterAnisotropy1;
  }
  set scatterAnisotropy1(value) {
    this.cloudsPass.currentMaterial.scatterAnisotropy1 = value;
  }
  get scatterAnisotropy2() {
    return this.cloudsPass.currentMaterial.scatterAnisotropy2;
  }
  set scatterAnisotropy2(value) {
    this.cloudsPass.currentMaterial.scatterAnisotropy2 = value;
  }
  get scatterAnisotropyMix() {
    return this.cloudsPass.currentMaterial.scatterAnisotropyMix;
  }
  set scatterAnisotropyMix(value) {
    this.cloudsPass.currentMaterial.scatterAnisotropyMix = value;
  }
  get skyLightScale() {
    return this.cloudsPass.currentMaterial.uniforms.skyLightScale.value;
  }
  set skyLightScale(value) {
    this.cloudsPass.currentMaterial.uniforms.skyLightScale.value = value;
  }
  get groundBounceScale() {
    return this.cloudsPass.currentMaterial.uniforms.groundBounceScale.value;
  }
  set groundBounceScale(value) {
    this.cloudsPass.currentMaterial.uniforms.groundBounceScale.value = value;
  }
  get powderScale() {
    return this.cloudsPass.currentMaterial.uniforms.powderScale.value;
  }
  set powderScale(value) {
    this.cloudsPass.currentMaterial.uniforms.powderScale.value = value;
  }
  get powderExponent() {
    return this.cloudsPass.currentMaterial.uniforms.powderExponent.value;
  }
  set powderExponent(value) {
    this.cloudsPass.currentMaterial.uniforms.powderExponent.value = value;
  }
  // Atmosphere composition
  get atmosphereOverlay() {
    return this._atmosphereOverlay;
  }
  get atmosphereShadow() {
    return this._atmosphereShadow;
  }
  get atmosphereShadowLength() {
    return this._atmosphereShadowLength;
  }
  // Atmosphere parameters
  get irradianceTexture() {
    return this.cloudsPass.currentMaterial.irradianceTexture;
  }
  set irradianceTexture(value) {
    this.cloudsPass.currentMaterial.irradianceTexture = value;
  }
  get scatteringTexture() {
    return this.cloudsPass.currentMaterial.scatteringTexture;
  }
  set scatteringTexture(value) {
    this.cloudsPass.currentMaterial.scatteringTexture = value;
  }
  get transmittanceTexture() {
    return this.cloudsPass.currentMaterial.transmittanceTexture;
  }
  set transmittanceTexture(value) {
    this.cloudsPass.currentMaterial.transmittanceTexture = value;
  }
  get singleMieScatteringTexture() {
    return this.cloudsPass.currentMaterial.singleMieScatteringTexture;
  }
  set singleMieScatteringTexture(value) {
    this.cloudsPass.currentMaterial.singleMieScatteringTexture = value;
  }
  get higherOrderScatteringTexture() {
    return this.cloudsPass.currentMaterial.higherOrderScatteringTexture;
  }
  set higherOrderScatteringTexture(value) {
    this.cloudsPass.currentMaterial.higherOrderScatteringTexture = value;
  }
  get ellipsoid() {
    return this.cloudsPass.currentMaterial.ellipsoid;
  }
  set ellipsoid(value) {
    this.cloudsPass.currentMaterial.ellipsoid = value;
  }
  get sunAngularRadius() {
    return this.cloudsPass.currentMaterial.sunAngularRadius;
  }
  set sunAngularRadius(value) {
    this.cloudsPass.currentMaterial.sunAngularRadius = value;
  }
};
__decorateClass([
  define4("SKIP_RENDERING")
], CloudsEffect.prototype, "skipRendering", 2);

// src/CloudShape.ts
import { resolveIncludes as resolveIncludes5 } from "@takram/three-geospatial";
import { math as math3 } from "@takram/three-geospatial/shaders";

// src/constants.ts
var CLOUD_SHAPE_TEXTURE_SIZE = 128;
var CLOUD_SHAPE_DETAIL_TEXTURE_SIZE = 32;
var ref = "45a1c6c1bb9fd38b3680fd120795ff4c32df68ff";
var DEFAULT_LOCAL_WEATHER_URL = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${ref}/packages/clouds/assets/local_weather.png`;
var DEFAULT_SHAPE_URL = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${ref}/packages/clouds/assets/shape.bin`;
var DEFAULT_SHAPE_DETAIL_URL = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${ref}/packages/clouds/assets/shape_detail.bin`;
var DEFAULT_TURBULENCE_URL = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${ref}/packages/clouds/assets/turbulence.png`;

// src/Procedural3DTexture.ts
import {
  Camera as Camera3,
  GLSL3 as GLSL35,
  LinearFilter as LinearFilter3,
  Mesh,
  NoColorSpace,
  PlaneGeometry,
  RawShaderMaterial as RawShaderMaterial4,
  RedFormat as RedFormat2,
  RepeatWrapping,
  Uniform as Uniform7,
  WebGL3DRenderTarget
} from "three";
var Procedural3DTextureBase = class {
  constructor({ size, fragmentShader }) {
    this.needsRender = true;
    this.camera = new Camera3();
    this.size = size;
    this.material = new RawShaderMaterial4({
      glslVersion: GLSL35,
      vertexShader: (
        /* glsl */
        `
        in vec3 position;
        out vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `
      ),
      fragmentShader,
      uniforms: {
        layer: new Uniform7(0)
      }
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.renderTarget = new WebGL3DRenderTarget(size, size, size, {
      depthBuffer: false,
      format: RedFormat2
    });
    const texture = this.renderTarget.texture;
    texture.minFilter = LinearFilter3;
    texture.magFilter = LinearFilter3;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.wrapR = RepeatWrapping;
    texture.colorSpace = NoColorSpace;
    texture.needsUpdate = true;
  }
  dispose() {
    this.renderTarget.dispose();
    this.material.dispose();
  }
  render(renderer, deltaTime) {
    if (!this.needsRender) {
      return;
    }
    this.needsRender = false;
    for (let layer = 0; layer < this.size; ++layer) {
      this.material.uniforms.layer.value = layer / this.size;
      renderer.setRenderTarget(this.renderTarget, layer);
      renderer.render(this.mesh, this.camera);
    }
    renderer.setRenderTarget(null);
  }
  get texture() {
    return this.renderTarget.texture;
  }
};

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/cloudShape.frag
var cloudShape_default = '// Based on the following work with slight modifications.\n// https://github.com/sebh/TileableVolumeNoise\n\n/**\n * The MIT License (MIT)\n *\n * Copyright(c) 2017 S\xE9bastien Hillaire\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the "Software"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n * SOFTWARE.\n */\n\nprecision highp float;\nprecision highp int;\n\n#include "core/math"\n#include "perlin"\n#include "tileableNoise"\n\nuniform float layer;\n\nin vec2 vUv;\n\nlayout(location = 0) out float outputColor;\n\nfloat getPerlinWorley(const vec3 point) {\n  int octaveCount = 3;\n  float frequency = 8.0;\n  float perlin = getPerlinNoise(point, frequency, octaveCount);\n  perlin = clamp(perlin, 0.0, 1.0);\n\n  float cellCount = 4.0;\n  vec3 noise = vec3(\n    1.0 - getWorleyNoise(point, cellCount * 2.0),\n    1.0 - getWorleyNoise(point, cellCount * 8.0),\n    1.0 - getWorleyNoise(point, cellCount * 14.0)\n  );\n  float fbm = dot(noise, vec3(0.625, 0.25, 0.125));\n  return remap(perlin, 0.0, 1.0, fbm, 1.0);\n}\n\nfloat getWorleyFbm(const vec3 point) {\n  float cellCount = 4.0;\n  vec4 noise = vec4(\n    1.0 - getWorleyNoise(point, cellCount * 2.0),\n    1.0 - getWorleyNoise(point, cellCount * 4.0),\n    1.0 - getWorleyNoise(point, cellCount * 8.0),\n    1.0 - getWorleyNoise(point, cellCount * 16.0)\n  );\n  vec3 fbm = vec3(\n    dot(noise.xyz, vec3(0.625, 0.25, 0.125)),\n    dot(noise.yzw, vec3(0.625, 0.25, 0.125)),\n    dot(noise.zw, vec2(0.75, 0.25))\n  );\n  return dot(fbm, vec3(0.625, 0.25, 0.125));\n}\n\nvoid main() {\n  vec3 point = vec3(vUv.x, vUv.y, layer);\n  float perlinWorley = getPerlinWorley(point);\n  float worleyFbm = getWorleyFbm(point);\n  outputColor = remap(perlinWorley, worleyFbm - 1.0, 1.0);\n}\n';

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/perlin.glsl
var perlin_default = '// Ported from GLM: https://github.com/g-truc/glm/blob/master/glm/gtc/noise.inl\n\n/**\n * OpenGL Mathematics (GLM)\n *\n * GLM is licensed under The Happy Bunny License or MIT License\n *\n * The Happy Bunny License (Modified MIT License)\n *\n * Copyright (c) 2005 - G-Truc Creation\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the "Software"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * Restrictions:\n *  By making use of the Software for military purposes, you choose to make a\n *  Bunny unhappy.\n *\n * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\n * THE SOFTWARE.\n *\n * The MIT License\n *\n * Copyright (c) 2005 - G-Truc Creation\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the "Software"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\n * THE SOFTWARE.\n */\n\nvec4 mod289(const vec4 x) {\n  return x - floor(x * (1.0 / 289.0)) * 289.0;\n}\n\nvec4 permute(const vec4 v) {\n  return mod289((v * 34.0 + 1.0) * v);\n}\n\nvec4 taylorInvSqrt(const vec4 r) {\n  return 1.79284291400159 - 0.85373472095314 * r;\n}\n\nvec4 fade(const vec4 v) {\n  return v * v * v * (v * (v * 6.0 - 15.0) + 10.0);\n}\n\n// Classic Perlin noise, periodic version\nfloat perlin(const vec4 position, const vec4 rep) {\n  vec4 Pi0 = mod(floor(position), rep); // Integer part modulo rep\n  vec4 Pi1 = mod(Pi0 + 1.0, rep); // Integer part + 1 mod rep\n  vec4 Pf0 = fract(position); // Fractional part for interpolation\n  vec4 Pf1 = Pf0 - 1.0; // Fractional part - 1.0\n  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);\n  vec4 iy = vec4(Pi0.y, Pi0.y, Pi1.y, Pi1.y);\n  vec4 iz0 = vec4(Pi0.z);\n  vec4 iz1 = vec4(Pi1.z);\n  vec4 iw0 = vec4(Pi0.w);\n  vec4 iw1 = vec4(Pi1.w);\n\n  vec4 ixy = permute(permute(ix) + iy);\n  vec4 ixy0 = permute(ixy + iz0);\n  vec4 ixy1 = permute(ixy + iz1);\n  vec4 ixy00 = permute(ixy0 + iw0);\n  vec4 ixy01 = permute(ixy0 + iw1);\n  vec4 ixy10 = permute(ixy1 + iw0);\n  vec4 ixy11 = permute(ixy1 + iw1);\n\n  vec4 gx00 = ixy00 / 7.0;\n  vec4 gy00 = floor(gx00) / 7.0;\n  vec4 gz00 = floor(gy00) / 6.0;\n  gx00 = fract(gx00) - 0.5;\n  gy00 = fract(gy00) - 0.5;\n  gz00 = fract(gz00) - 0.5;\n  vec4 gw00 = vec4(0.75) - abs(gx00) - abs(gy00) - abs(gz00);\n  vec4 sw00 = step(gw00, vec4(0));\n  gx00 -= sw00 * (step(0.0, gx00) - 0.5);\n  gy00 -= sw00 * (step(0.0, gy00) - 0.5);\n\n  vec4 gx01 = ixy01 / 7.0;\n  vec4 gy01 = floor(gx01) / 7.0;\n  vec4 gz01 = floor(gy01) / 6.0;\n  gx01 = fract(gx01) - 0.5;\n  gy01 = fract(gy01) - 0.5;\n  gz01 = fract(gz01) - 0.5;\n  vec4 gw01 = vec4(0.75) - abs(gx01) - abs(gy01) - abs(gz01);\n  vec4 sw01 = step(gw01, vec4(0.0));\n  gx01 -= sw01 * (step(0.0, gx01) - 0.5);\n  gy01 -= sw01 * (step(0.0, gy01) - 0.5);\n\n  vec4 gx10 = ixy10 / 7.0;\n  vec4 gy10 = floor(gx10) / 7.0;\n  vec4 gz10 = floor(gy10) / 6.0;\n  gx10 = fract(gx10) - 0.5;\n  gy10 = fract(gy10) - 0.5;\n  gz10 = fract(gz10) - 0.5;\n  vec4 gw10 = vec4(0.75) - abs(gx10) - abs(gy10) - abs(gz10);\n  vec4 sw10 = step(gw10, vec4(0.0));\n  gx10 -= sw10 * (step(0.0, gx10) - 0.5);\n  gy10 -= sw10 * (step(0.0, gy10) - 0.5);\n\n  vec4 gx11 = ixy11 / 7.0;\n  vec4 gy11 = floor(gx11) / 7.0;\n  vec4 gz11 = floor(gy11) / 6.0;\n  gx11 = fract(gx11) - 0.5;\n  gy11 = fract(gy11) - 0.5;\n  gz11 = fract(gz11) - 0.5;\n  vec4 gw11 = vec4(0.75) - abs(gx11) - abs(gy11) - abs(gz11);\n  vec4 sw11 = step(gw11, vec4(0.0));\n  gx11 -= sw11 * (step(0.0, gx11) - 0.5);\n  gy11 -= sw11 * (step(0.0, gy11) - 0.5);\n\n  vec4 g0000 = vec4(gx00.x, gy00.x, gz00.x, gw00.x);\n  vec4 g1000 = vec4(gx00.y, gy00.y, gz00.y, gw00.y);\n  vec4 g0100 = vec4(gx00.z, gy00.z, gz00.z, gw00.z);\n  vec4 g1100 = vec4(gx00.w, gy00.w, gz00.w, gw00.w);\n  vec4 g0010 = vec4(gx10.x, gy10.x, gz10.x, gw10.x);\n  vec4 g1010 = vec4(gx10.y, gy10.y, gz10.y, gw10.y);\n  vec4 g0110 = vec4(gx10.z, gy10.z, gz10.z, gw10.z);\n  vec4 g1110 = vec4(gx10.w, gy10.w, gz10.w, gw10.w);\n  vec4 g0001 = vec4(gx01.x, gy01.x, gz01.x, gw01.x);\n  vec4 g1001 = vec4(gx01.y, gy01.y, gz01.y, gw01.y);\n  vec4 g0101 = vec4(gx01.z, gy01.z, gz01.z, gw01.z);\n  vec4 g1101 = vec4(gx01.w, gy01.w, gz01.w, gw01.w);\n  vec4 g0011 = vec4(gx11.x, gy11.x, gz11.x, gw11.x);\n  vec4 g1011 = vec4(gx11.y, gy11.y, gz11.y, gw11.y);\n  vec4 g0111 = vec4(gx11.z, gy11.z, gz11.z, gw11.z);\n  vec4 g1111 = vec4(gx11.w, gy11.w, gz11.w, gw11.w);\n\n  vec4 norm00 = taylorInvSqrt(\n    vec4(dot(g0000, g0000), dot(g0100, g0100), dot(g1000, g1000), dot(g1100, g1100))\n  );\n  g0000 *= norm00.x;\n  g0100 *= norm00.y;\n  g1000 *= norm00.z;\n  g1100 *= norm00.w;\n\n  vec4 norm01 = taylorInvSqrt(\n    vec4(dot(g0001, g0001), dot(g0101, g0101), dot(g1001, g1001), dot(g1101, g1101))\n  );\n  g0001 *= norm01.x;\n  g0101 *= norm01.y;\n  g1001 *= norm01.z;\n  g1101 *= norm01.w;\n\n  vec4 norm10 = taylorInvSqrt(\n    vec4(dot(g0010, g0010), dot(g0110, g0110), dot(g1010, g1010), dot(g1110, g1110))\n  );\n  g0010 *= norm10.x;\n  g0110 *= norm10.y;\n  g1010 *= norm10.z;\n  g1110 *= norm10.w;\n\n  vec4 norm11 = taylorInvSqrt(\n    vec4(dot(g0011, g0011), dot(g0111, g0111), dot(g1011, g1011), dot(g1111, g1111))\n  );\n  g0011 *= norm11.x;\n  g0111 *= norm11.y;\n  g1011 *= norm11.z;\n  g1111 *= norm11.w;\n\n  float n0000 = dot(g0000, Pf0);\n  float n1000 = dot(g1000, vec4(Pf1.x, Pf0.y, Pf0.z, Pf0.w));\n  float n0100 = dot(g0100, vec4(Pf0.x, Pf1.y, Pf0.z, Pf0.w));\n  float n1100 = dot(g1100, vec4(Pf1.x, Pf1.y, Pf0.z, Pf0.w));\n  float n0010 = dot(g0010, vec4(Pf0.x, Pf0.y, Pf1.z, Pf0.w));\n  float n1010 = dot(g1010, vec4(Pf1.x, Pf0.y, Pf1.z, Pf0.w));\n  float n0110 = dot(g0110, vec4(Pf0.x, Pf1.y, Pf1.z, Pf0.w));\n  float n1110 = dot(g1110, vec4(Pf1.x, Pf1.y, Pf1.z, Pf0.w));\n  float n0001 = dot(g0001, vec4(Pf0.x, Pf0.y, Pf0.z, Pf1.w));\n  float n1001 = dot(g1001, vec4(Pf1.x, Pf0.y, Pf0.z, Pf1.w));\n  float n0101 = dot(g0101, vec4(Pf0.x, Pf1.y, Pf0.z, Pf1.w));\n  float n1101 = dot(g1101, vec4(Pf1.x, Pf1.y, Pf0.z, Pf1.w));\n  float n0011 = dot(g0011, vec4(Pf0.x, Pf0.y, Pf1.z, Pf1.w));\n  float n1011 = dot(g1011, vec4(Pf1.x, Pf0.y, Pf1.z, Pf1.w));\n  float n0111 = dot(g0111, vec4(Pf0.x, Pf1.y, Pf1.z, Pf1.w));\n  float n1111 = dot(g1111, Pf1);\n\n  vec4 fade_xyzw = fade(Pf0);\n  vec4 n_0w = mix(vec4(n0000, n1000, n0100, n1100), vec4(n0001, n1001, n0101, n1101), fade_xyzw.w);\n  vec4 n_1w = mix(vec4(n0010, n1010, n0110, n1110), vec4(n0011, n1011, n0111, n1111), fade_xyzw.w);\n  vec4 n_zw = mix(n_0w, n_1w, fade_xyzw.z);\n  vec2 n_yzw = mix(n_zw.xy, n_zw.zw, fade_xyzw.y);\n  float n_xyzw = mix(n_yzw.x, n_yzw.y, fade_xyzw.x);\n  return 2.2 * n_xyzw;\n}\n';

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/tileableNoise.glsl
var tileableNoise_default = '// Based on the following work with slight modifications.\n// https://github.com/sebh/TileableVolumeNoise\n\n/**\n * The MIT License (MIT)\n *\n * Copyright(c) 2017 S\xE9bastien Hillaire\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the "Software"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n * SOFTWARE.\n */\n\nfloat hash(const float n) {\n  return fract(sin(n + 1.951) * 43758.5453);\n}\n\nfloat noise(const vec3 x) {\n  vec3 p = floor(x);\n  vec3 f = fract(x);\n\n  f = f * f * (3.0 - 2.0 * f);\n  float n = p.x + p.y * 57.0 + 113.0 * p.z;\n  return mix(\n    mix(mix(hash(n + 0.0), hash(n + 1.0), f.x), mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),\n    mix(\n      mix(hash(n + 113.0), hash(n + 114.0), f.x),\n      mix(hash(n + 170.0), hash(n + 171.0), f.x),\n      f.y\n    ),\n    f.z\n  );\n}\n\nfloat getWorleyNoise(const vec3 p, const float cellCount) {\n  vec3 cell = p * cellCount;\n  float d = 1.0e10;\n  for (int x = -1; x <= 1; ++x) {\n    for (int y = -1; y <= 1; ++y) {\n      for (int z = -1; z <= 1; ++z) {\n        vec3 tp = floor(cell) + vec3(x, y, z);\n        tp = cell - tp - noise(mod(tp, cellCount / 1.0));\n        d = min(d, dot(tp, tp));\n      }\n    }\n  }\n  return clamp(d, 0.0, 1.0);\n}\n\nfloat getPerlinNoise(const vec3 point, const vec3 frequency, const int octaveCount) {\n  // Noise frequency factor between octave, forced to 2.\n  const float octaveFrequencyFactor = 2.0;\n\n  // Compute the sum for each octave.\n  float sum = 0.0;\n  float roughness = 0.5;\n  float weightSum = 0.0;\n  float weight = 1.0;\n  vec3 nextFrequency = frequency;\n  for (int i = 0; i < octaveCount; ++i) {\n    vec4 p = vec4(point.x, point.y, point.z, 0.0) * vec4(nextFrequency, 1.0);\n    float value = perlin(p, vec4(nextFrequency, 1.0));\n    sum += value * weight;\n    weightSum += weight;\n    weight *= roughness;\n    nextFrequency *= octaveFrequencyFactor;\n  }\n\n  return sum / weightSum; // Intentionally skip clamping.\n}\n\nfloat getPerlinNoise(const vec3 point, const float frequency, const int octaveCount) {\n  return getPerlinNoise(point, vec3(frequency), octaveCount);\n}\n';

// src/CloudShape.ts
var CloudShape = class extends Procedural3DTextureBase {
  constructor() {
    super({
      size: CLOUD_SHAPE_TEXTURE_SIZE,
      fragmentShader: resolveIncludes5(cloudShape_default, {
        core: { math: math3 },
        perlin: perlin_default,
        tileableNoise: tileableNoise_default
      })
    });
  }
};

// src/CloudShapeDetail.ts
import { resolveIncludes as resolveIncludes6 } from "@takram/three-geospatial";
import { math as math4 } from "@takram/three-geospatial/shaders";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/cloudShapeDetail.frag
var cloudShapeDetail_default = '// Based on the following work with slight modifications.\n// https://github.com/sebh/TileableVolumeNoise\n\n/**\n * The MIT License (MIT)\n *\n * Copyright(c) 2017 S\xE9bastien Hillaire\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the "Software"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n * SOFTWARE.\n */\n\nprecision highp float;\nprecision highp int;\n\n#include "core/math"\n#include "perlin"\n#include "tileableNoise"\n\nuniform float layer;\n\nin vec2 vUv;\n\nlayout(location = 0) out float outputColor;\n\nvoid main() {\n  vec3 point = vec3(vUv.x, vUv.y, layer);\n  float cellCount = 2.0;\n  vec4 noise = vec4(\n    1.0 - getWorleyNoise(point, cellCount * 1.0),\n    1.0 - getWorleyNoise(point, cellCount * 2.0),\n    1.0 - getWorleyNoise(point, cellCount * 4.0),\n    1.0 - getWorleyNoise(point, cellCount * 8.0)\n  );\n  vec3 fbm = vec3(\n    dot(noise.xyz, vec3(0.625, 0.25, 0.125)),\n    dot(noise.yzw, vec3(0.625, 0.25, 0.125)),\n    dot(noise.zw, vec2(0.75, 0.25))\n  );\n  outputColor = dot(fbm, vec3(0.625, 0.25, 0.125));\n}\n';

// src/CloudShapeDetail.ts
var CloudShapeDetail = class extends Procedural3DTextureBase {
  constructor() {
    super({
      size: CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
      fragmentShader: resolveIncludes6(cloudShapeDetail_default, {
        core: { math: math4 },
        perlin: perlin_default,
        tileableNoise: tileableNoise_default
      })
    });
  }
};

// src/LocalWeather.ts
import { resolveIncludes as resolveIncludes7 } from "@takram/three-geospatial";
import { math as math5 } from "@takram/three-geospatial/shaders";

// src/ProceduralTexture.ts
import {
  Camera as Camera4,
  GLSL3 as GLSL36,
  LinearFilter as LinearFilter4,
  LinearMipMapLinearFilter,
  Mesh as Mesh2,
  NoColorSpace as NoColorSpace2,
  PlaneGeometry as PlaneGeometry2,
  RawShaderMaterial as RawShaderMaterial5,
  RepeatWrapping as RepeatWrapping2,
  RGBAFormat,
  Uniform as Uniform8,
  WebGLRenderTarget as WebGLRenderTarget2
} from "three";
var ProceduralTextureBase = class {
  constructor({ size, fragmentShader }) {
    this.needsRender = true;
    this.camera = new Camera4();
    this.size = size;
    this.material = new RawShaderMaterial5({
      glslVersion: GLSL36,
      vertexShader: (
        /* glsl */
        `
        in vec3 position;
        out vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `
      ),
      fragmentShader,
      uniforms: {
        layer: new Uniform8(0)
      }
    });
    this.mesh = new Mesh2(new PlaneGeometry2(2, 2), this.material);
    this.renderTarget = new WebGLRenderTarget2(size, size, {
      depthBuffer: false,
      format: RGBAFormat
    });
    const texture = this.renderTarget.texture;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipMapLinearFilter;
    texture.magFilter = LinearFilter4;
    texture.wrapS = RepeatWrapping2;
    texture.wrapT = RepeatWrapping2;
    texture.colorSpace = NoColorSpace2;
    texture.needsUpdate = true;
  }
  dispose() {
    this.renderTarget.dispose();
    this.material.dispose();
  }
  render(renderer, deltaTime) {
    if (!this.needsRender) {
      return;
    }
    this.needsRender = false;
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(this.mesh, this.camera);
    renderer.setRenderTarget(null);
  }
  get texture() {
    return this.renderTarget.texture;
  }
};

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/localWeather.frag
var localWeather_default = 'precision highp float;\nprecision highp int;\n\n#include "core/math"\n#include "perlin"\n#include "tileableNoise"\n\nin vec2 vUv;\n\nlayout(location = 0) out vec4 outputColor;\n\nfloat getWorleyFbm(\n  const vec3 point,\n  float frequency,\n  float amplitude,\n  const float lacunarity,\n  const float gain,\n  const int octaveCount\n) {\n  float noise = 0.0;\n  for (int i = 0; i < octaveCount; ++i) {\n    noise += amplitude * (1.0 - getWorleyNoise(point, frequency));\n    frequency *= lacunarity;\n    amplitude *= gain;\n  }\n  return noise;\n}\n\nvoid main() {\n  vec3 point = vec3(vUv.x, vUv.y, 0.0);\n\n  // Mid clouds\n  {\n    float worley = getWorleyFbm(\n      point + vec3(0.5),\n      8.0, // frequency\n      0.4, // amplitude\n      2.0, // lacunarity\n      0.95, // gain\n      4 // octaveCount\n    );\n    worley = smoothstep(1.0, 1.4, worley);\n    outputColor.g = worley;\n  }\n\n  // Low clouds\n  {\n    float worley = getWorleyFbm(\n      point,\n      16.0, // frequency\n      0.4, // amplitude\n      2.0, // lacunarity\n      0.95, // gain\n      4 // octaveCount\n    );\n    worley = smoothstep(0.8, 1.4, worley);\n    outputColor.r = saturate(worley - outputColor.g);\n  }\n\n  // High clouds\n  {\n    float perlin = getPerlinNoise(\n      point,\n      vec3(6.0, 12.0, 1.0), // frequency\n      8 // octaveCount\n    );\n    perlin = smoothstep(-0.5, 0.5, perlin);\n    outputColor.b = perlin;\n  }\n\n  // Extra\n  {\n    float perlin = getPerlinNoise(\n      point + vec3(-19.1, 33.4, 47.2),\n      32.0, // frequency\n      4 // octaveCount\n    );\n    perlin = smoothstep(-0.5, 0.5, perlin);\n    outputColor.a = perlin;\n  }\n\n  outputColor.a = 1.0;\n}\n';

// src/LocalWeather.ts
var LocalWeather = class extends ProceduralTextureBase {
  constructor() {
    super({
      size: 512,
      fragmentShader: resolveIncludes7(localWeather_default, {
        core: { math: math5 },
        perlin: perlin_default,
        tileableNoise: tileableNoise_default
      })
    });
  }
};

// src/Turbulence.ts
import { resolveIncludes as resolveIncludes8 } from "@takram/three-geospatial";
import { math as math6 } from "@takram/three-geospatial/shaders";

// raw-text:/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/src/shaders/turbulence.frag
var turbulence_default = 'precision highp float;\nprecision highp int;\n\n#include "core/math"\n#include "perlin"\n#include "tileableNoise"\n\nin vec2 vUv;\n\nlayout(location = 0) out vec4 outputColor;\n\nconst vec3 frequency = vec3(12.0);\nconst int octaveCount = 3;\n\nfloat perlin(const vec3 point) {\n  return getPerlinNoise(point, frequency, octaveCount);\n}\n\nvec3 perlin3d(const vec3 point) {\n  float perlin1 = perlin(point);\n  float perlin2 = perlin(point.yzx + vec3(-19.1, 33.4, 47.2));\n  float perlin3 = perlin(point.zxy + vec3(74.2, -124.5, 99.4));\n  return vec3(perlin1, perlin2, perlin3);\n}\n\nvec3 curl(vec3 point) {\n  const float delta = 0.1;\n  vec3 dx = vec3(delta, 0.0, 0.0);\n  vec3 dy = vec3(0.0, delta, 0.0);\n  vec3 dz = vec3(0.0, 0.0, delta);\n\n  vec3 px0 = perlin3d(point - dx);\n  vec3 px1 = perlin3d(point + dx);\n  vec3 py0 = perlin3d(point - dy);\n  vec3 py1 = perlin3d(point + dy);\n  vec3 pz0 = perlin3d(point - dz);\n  vec3 pz1 = perlin3d(point + dz);\n\n  float x = py1.z - py0.z - pz1.y + pz0.y;\n  float y = pz1.x - pz0.x - px1.z + px0.z;\n  float z = px1.y - px0.y - py1.x + py0.x;\n\n  const float divisor = 1.0 / (2.0 * delta);\n  return normalize(vec3(x, y, z) * divisor);\n}\n\nvoid main() {\n  vec3 point = vec3(vUv.x, vUv.y, 0.0);\n  outputColor.rgb = 0.5 * curl(point) + 0.5;\n  outputColor.a = 1.0;\n}\n';

// src/Turbulence.ts
var Turbulence = class extends ProceduralTextureBase {
  constructor() {
    super({
      size: 128,
      fragmentShader: resolveIncludes8(turbulence_default, {
        core: { math: math6 },
        perlin: perlin_default,
        tileableNoise: tileableNoise_default
      })
    });
  }
};
export {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE,
  CloudLayer,
  CloudLayers,
  CloudShape,
  CloudShapeDetail,
  CloudsEffect,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  DensityProfile,
  LocalWeather,
  Procedural3DTextureBase,
  ProceduralTextureBase,
  Turbulence,
  cloudsPassOptionsDefaults
};
//# sourceMappingURL=index.js.map
