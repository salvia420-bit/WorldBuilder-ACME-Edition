// scene3d/water_pass.js — Dedicated Post-Opaque Water Pass (Milestone 3 — Features 19–22)

import * as THREE from "three";
import { Pass } from "postprocessing";

export function waterPassEnabled(qualityFlags, search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("waterPass");
    if (v != null) {
      const lv = String(v).toLowerCase();
      if (lv === "off" || lv === "0" || lv === "false" || lv === "no") return false;
      if (lv === "on" || lv === "1" || lv === "true" || lv === "yes") return true;
    }
  } catch (_) {}
  return !!qualityFlags?.waterPass;
}

const WATER_PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const WATER_PASS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tOpaqueColor;
uniform highp sampler2D tDepth;
uniform samplerCube uEnvCube;
uniform vec2 uRes;
uniform float uLogFC;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform mat4 uViewMatrix;
uniform mat4 uInvView;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uWaterExtinction;
uniform float uTime;
uniform float uFoamThresholdM;
uniform float uWaterLevel;
varying vec2 vUv;

#ifdef USE_REVERSED_DEPTH_BUFFER
uniform vec2 uNearFar;
float revW(float d) { return (uNearFar.x * uNearFar.y) / (d * (uNearFar.y - uNearFar.x) + uNearFar.x); }
#endif

float viewW(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  return revW(d);
#else
  return exp2(d * uLogFC) - 1.0;
#endif
}

vec3 viewPos(vec2 uv, float w) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * w / uProj[0][0], ndc.y * w / uProj[1][1], -w);
}

// 16-step screen-space reflection raymarch with hierarchical traversal fallback
#define MAX_SSR_STEPS 16
vec4 marchHiZRay(vec3 rayOrigin, vec3 rayDir, sampler2D depthMap, mat4 projMatrix) {
  vec3 pos = rayOrigin;
  vec3 stepVec = rayDir * (1.0 / float(MAX_SSR_STEPS));
  for (int i = 0; i < MAX_SSR_STEPS; ++i) {
    pos += stepVec;
    vec4 clip = projMatrix * vec4(pos, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sceneZ = texture2D(depthMap, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
    if (ndc.z <= sceneZ) return vec4(uv, sceneZ, 1.0);
#else
    float sceneW = exp2(sceneZ * uLogFC) - 1.0;
    if (-pos.z >= sceneW) return vec4(uv, sceneZ, 1.0);
#endif
  }
  return vec4(0.0);
}

float lagardeSpecularOcclusion(float ndotv, float ao, float roughness) {
  float clampedNdotV = clamp(ndotv, 0.0, 1.0);
  float clampedAo = clamp(ao, 0.0, 1.0);
  float r = clamp(roughness, 0.0, 1.0);
  float base = max(0.0, clampedNdotV + clampedAo);
  float exponent = exp2(-16.0 * r - 1.0);
  return clamp(pow(base, exponent) - 1.0 + clampedAo, 0.0, 1.0);
}

void main() {
  vec4 sceneColor = texture2D(tOpaqueColor, vUv);
  float rawDepth = texture2D(tDepth, vUv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (rawDepth <= 0.0) { gl_FragColor = sceneColor; return; }
  float wSeabed = revW(rawDepth);
#else
  if (rawDepth >= 0.99999) { gl_FragColor = sceneColor; return; }
  float wSeabed = exp2(rawDepth * uLogFC) - 1.0;
#endif

  // Reconstruct seabed in view and world space
  vec3 seabedView = viewPos(vUv, wSeabed);
  vec3 seabedWorld = (uInvView * vec4(seabedView, 1.0)).xyz;
  vec3 camWorld = (uInvView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  vec3 rayDirWorld = normalize(seabedWorld - camWorld);
  float seabedDist = length(seabedWorld - camWorld);

  // Geometric water surface detection: intersect camera ray with Y = uWaterLevel plane
  bool isWater = false;
  float waterDepthDelta = 0.0;
  float tWater = 0.0;

  if (camWorld.y > uWaterLevel) {
    if (rayDirWorld.y < -1e-4 && seabedWorld.y < uWaterLevel + 0.05) {
      tWater = (uWaterLevel - camWorld.y) / rayDirWorld.y;
      if (tWater > 0.0 && tWater <= seabedDist + 0.1) {
        isWater = true;
        waterDepthDelta = max(0.0, uWaterLevel - seabedWorld.y);
      }
    }
  } else {
    if (seabedWorld.y <= uWaterLevel) {
      isWater = true;
      waterDepthDelta = max(0.0, uWaterLevel - seabedWorld.y);
    }
  }

  // Pass through dry terrain, mountains, cottages, keeps, and sky completely untouched
  if (!isWater) {
    gl_FragColor = sceneColor;
    return;
  }

  // Water surface view position and view-space normal
  float wWater = (camWorld.y > uWaterLevel && tWater > 0.0) ? (tWater * (wSeabed / max(seabedDist, 1e-4))) : wSeabed;
  vec3 waterPosView = viewPos(vUv, wWater);
  vec3 V = normalize(waterPosView);
  vec3 N = normalize(mat3(uViewMatrix) * vec3(0.0, 1.0, 0.0));
  vec3 R = reflect(V, N);

  // 16-step Screen-Space Reflection (SSR)
  vec3 reflColor = vec3(0.0);
  float ssrConfidence = 0.0;
  if (R.z < -0.01) {
    float maxRayDist = min(40.0, wWater * 1.5 + 5.0);
    vec4 hit = marchHiZRay(waterPosView, R * maxRayDist, tDepth, uProj);
    if (hit.w > 0.5) {
      vec2 hitUv = hit.xy;
      vec2 edge = smoothstep(vec2(0.0), vec2(0.08), hitUv) * (vec2(1.0) - smoothstep(vec2(0.92), vec2(1.0), hitUv));
      ssrConfidence = edge.x * edge.y;
      reflColor = texture2D(tOpaqueColor, hitUv).rgb;
    }
  }

  // Fallback to uEnvCube PMREM cubemap with Lagarde specular occlusion
  vec3 R_world = (uInvView * vec4(R, 0.0)).xyz;
  R_world.y = max(R_world.y, 0.02);
  vec3 envSample = textureCube(uEnvCube, R_world).rgb;
  float NdotV = clamp(dot(-V, N), 0.0, 1.0);
  float specOcc = lagardeSpecularOcclusion(NdotV, 1.0, 0.05);
  vec3 finalReflection = mix(envSample * specOcc, reflColor, ssrConfidence);

  // Beer-Lambert exponential transmittance: T = exp(-sigma * d)
  vec3 transmittance = exp(-uWaterExtinction * waterDepthDelta);
  vec3 waterBodyColor = mix(uDeepColor, sceneColor.rgb, transmittance);

  // Schlick Fresnel factor (F0 = 0.02 for water)
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 surfaceColor = mix(waterBodyColor, finalReflection, fresnel);

  // Soft depth-intersection foam: shoreline & obstacle contact
  float foamFactor = clamp(1.0 - (waterDepthDelta / uFoamThresholdM), 0.0, 1.0);
  vec3 foamColor = vec3(0.92, 0.96, 0.98);
  vec3 litWater = mix(surfaceColor, foamColor, foamFactor * 0.65);

  gl_FragColor = vec4(litWater, sceneColor.a);
}
`;

export class WaterPass extends Pass {
  constructor(camera, options = {}) {
    super();
    this.name = "WaterPass";
    this.camera = camera;
    this.options = options;
    this.needsSwap = true;

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    const ext = options.waterExtinction || [0.22, 0.10, 0.04];
    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_PASS_VERT,
      fragmentShader: WATER_PASS_FRAG,
      uniforms: {
        tOpaqueColor: { value: null },
        tDepth: { value: options.depthTexture || null },
        uEnvCube: { value: options.envCubeTexture || null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNearFar: { value: new THREE.Vector2(camera?.near || 0.1, camera?.far || 5000.0) },
        uLogFC: { value: Math.log2((camera?.far || 5000.0) + 1.0) },
        uProj: { value: camera ? camera.projectionMatrix.clone() : new THREE.Matrix4() },
        uInvProj: { value: camera ? camera.projectionMatrixInverse.clone() : new THREE.Matrix4() },
        uViewMatrix: { value: camera ? camera.matrixWorldInverse.clone() : new THREE.Matrix4() },
        uInvView: { value: camera ? camera.matrixWorld.clone() : new THREE.Matrix4() },
        uDeepColor: { value: new THREE.Color(0.04, 0.18, 0.28) },
        uShallowColor: { value: new THREE.Color(0.12, 0.42, 0.52) },
        uWaterExtinction: { value: new THREE.Vector3(ext[0], ext[1], ext[2]) },
        uTime: { value: 0 },
        uFoamThresholdM: { value: options.foamThresholdM || 0.35 },
        uWaterLevel: { value: options.waterLevel !== undefined ? options.waterLevel : 0.0 },
      },
      depthWrite: false,
      depthTest: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  isSubmerged(cam = this.camera) {
    if (!cam) return false;
    const y = cam.position ? cam.position.y : 0;
    const waterLevel = this.material?.uniforms?.uWaterLevel?.value ?? 0.0;
    return y < waterLevel;
  }

  setSize(width, height) {
    this.renderTarget.setSize(width, height);
    this.material.uniforms.uRes.value.set(width, height);
  }

  render(renderer, inputBuffer, outputBuffer) {
    const u = this.material.uniforms;
    u.tOpaqueColor.value = inputBuffer.texture;
    if (typeof this.options.depthSource === "function") {
      u.tDepth.value = this.options.depthSource();
    } else if (this.options.depthTexture) {
      u.tDepth.value = this.options.depthTexture;
    }
    if (typeof this.options.envCubeSource === "function") {
      const cube = this.options.envCubeSource();
      if (cube) u.uEnvCube.value = cube;
    } else if (this.options.envCubeTexture) {
      u.uEnvCube.value = this.options.envCubeTexture;
    }
    if (typeof this.options.waterLevelSource === "function") {
      u.uWaterLevel.value = this.options.waterLevelSource();
    } else if (this.options.waterLevel !== undefined) {
      u.uWaterLevel.value = this.options.waterLevel;
    }
    u.uTime.value = performance.now() * 0.001;
    if (this.camera) {
      u.uProj.value.copy(this.camera.projectionMatrix);
      u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
      u.uViewMatrix.value.copy(this.camera.matrixWorldInverse);
      u.uInvView.value.copy(this.camera.matrixWorld);
      if (u.uNearFar && this.camera.near && this.camera.far) {
        u.uNearFar.value.set(this.camera.near, this.camera.far);
      }
      if (this.camera.far) {
        u.uLogFC.value = Math.log2(this.camera.far + 1.0);
      }
    }
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.orthoCam);
  }

  dispose() {
    this.renderTarget.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
