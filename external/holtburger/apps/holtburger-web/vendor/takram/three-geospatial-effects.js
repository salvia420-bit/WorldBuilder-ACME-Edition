// node_modules/@takram/three-geospatial-effects/build/index.js
import { RawImageData as f2, LookupTexture as i } from "postprocessing";
import { reinterpretType as n } from "@takram/three-geospatial";

// node_modules/@takram/three-geospatial-effects/build/shared.js
import { BlendFunction as v, Effect as f, EffectAttribute as d, RenderPass as A, Resolution as h, ShaderPass as g, MipmapBlurPass as P, KawaseBlurPass as z, KernelSize as D } from "postprocessing";
import { Uniform as s, ShaderLib as l, HalfFloatType as m, ShaderMaterial as U, NoBlending as S, Vector2 as T, WebGLRenderTarget as w, Matrix4 as x } from "three";
import { define as p, resolveIncludes as b, reinterpretType as M } from "@takram/three-geospatial";
import { turbo as F, depth as B, packing as C, transform as O } from "@takram/three-geospatial/shaders";
var N = `#include "core/depth"
#include "core/turbo"

uniform float near;
uniform float far;

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  float depth = readDepthValue(depthBuffer, uv);
  depth = reverseLogDepth(depth, cameraNear, cameraFar);
  depth = linearizeDepth(depth, near, far) / far;

  #ifdef USE_TURBO
  vec3 color = turbo(1.0 - depth);
  #else // USE_TURBO
  vec3 color = vec3(depth);
  #endif // USE_TURBO

  outputColor = vec4(color, inputColor.a);
}
`;
var L = Object.defineProperty;
var j = (o, e, t, i2) => {
  for (var n2 = void 0, r = o.length - 1, a; r >= 0; r--)
    (a = o[r]) && (n2 = a(e, t, n2) || n2);
  return n2 && L(e, t, n2), n2;
};
var G = {
  blendFunction: v.SRC,
  useTurbo: false,
  near: 1,
  far: 1e3
};
var H = class extends f {
  constructor(e) {
    const { blendFunction: t, useTurbo: i2, near: n2, far: r } = {
      ...G,
      ...e
    };
    super(
      "DepthEffect",
      b(N, {
        core: { depth: B, turbo: F }
      }),
      {
        blendFunction: t,
        attributes: d.DEPTH,
        uniforms: new Map(
          Object.entries({
            near: new s(n2),
            far: new s(r)
          })
        )
      }
    ), this.useTurbo = i2;
  }
  get near() {
    return this.uniforms.get("near").value;
  }
  set near(e) {
    this.uniforms.get("near").value = e;
  }
  get far() {
    return this.uniforms.get("far").value;
  }
  set far(e) {
    this.uniforms.get("far").value = e;
  }
};
j([
  p("USE_TURBO")
], H.prototype, "useTurbo");
var V = `#define DITHERING

#include <dithering_pars_fragment>

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  outputColor = vec4(saturate(dithering(inputColor.rgb)), inputColor.a);
}
`;
var $ = {
  blendFunction: v.NORMAL
};
var le = class extends f {
  constructor(e) {
    const { blendFunction: t } = {
      ...$,
      ...e
    };
    super("DitheringEffect", V, {
      blendFunction: t
    });
  }
};
var R = /* @__PURE__ */ Symbol("SETUP");
function I(o) {
  const e = o.vertexShader.replace(
    /* glsl */
    "#include <fog_pars_vertex>",
    /* glsl */
    `
        #include <fog_pars_vertex>
        #include <normal_pars_vertex>
      `
  ).replace(
    /* glsl */
    "#include <defaultnormal_vertex>",
    /* glsl */
    `
        #include <defaultnormal_vertex>
        #include <normal_vertex>
      `
  ).replace(
    /* glsl */
    "#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )",
    /* glsl */
    "#if 1"
  ).replace(
    /* glsl */
    "#include <clipping_planes_vertex>",
    /* glsl */
    `
        #include <clipping_planes_vertex>
        vViewPosition = - mvPosition.xyz;
      `
  );
  o.vertexShader = /* glsl */
  `
    #undef FLAT_SHADED
    varying vec3 vViewPosition;
    ${e}
  `;
  const t = o.fragmentShader.replace(
    /#ifndef FLAT_SHADED\s+varying vec3 vNormal;\s+#endif/m,
    /* glsl */
    "#include <normal_pars_fragment>"
  ).replace(
    /* glsl */
    "#include <common>",
    /* glsl */
    `
        #include <common>
        #include <packing>
      `
  ).replace(
    /* glsl */
    "#include <specularmap_fragment>",
    /* glsl */
    `
        #include <specularmap_fragment>
        #include <normal_fragment_begin>
        #include <normal_fragment_maps>
      `
  );
  return o.fragmentShader = /* glsl */
  `
    #undef FLAT_SHADED
    varying vec3 vViewPosition;
    ${t}
  `, o;
}
function c(o, { type: e } = {}) {
  if (o[R] === true)
    return o;
  e === "basic" && I(o);
  const t = e === "physical" ? (
    /* glsl */
    `
          vec4(
            packNormalToVec2(normal),
            metalnessFactor,
            roughnessFactor
          )
        `
  ) : (
    /* glsl */
    `
          vec4(
            packNormalToVec2(normal),
            reflectivity,
            0.0
          );
        `
  );
  return o.fragmentShader = /* glsl */
  `
    layout(location = 1) out vec4 outputBuffer1;

    #if !defined(USE_ENVMAP)
      uniform float reflectivity;
    #endif // !defined(USE_ENVMAP)

    ${C}
    ${o.fragmentShader.replace(
    /}\s*$/m,
    // Assume the last curly brace is of main()
    /* glsl */
    `
          outputBuffer1 = ${t};
        }
      `
  )}
  `, o[R] = true, o;
}
function k() {
  c(l.lambert), c(l.phong), c(l.basic, { type: "basic" }), c(l.standard, { type: "physical" }), c(l.physical, { type: "physical" });
}
var ce = class extends A {
  constructor(e, t, i2, n2) {
    super(t, i2, n2), this.geometryTexture = e.texture.clone(), this.geometryTexture.isRenderTargetTexture = true, this.geometryTexture.type = m, k();
  }
  render(e, t, i2, n2, r) {
    t != null && (t.textures[1] = this.geometryTexture), super.render(e, t, null), t != null && (t.textures.length = 1);
  }
  setSize(e, t) {
    M(this.geometryTexture.image), this.geometryTexture.image.width = e, this.geometryTexture.image.height = t;
  }
};
var W = `#include <common>

uniform sampler2D inputBuffer;

uniform float thresholdLevel;
uniform float thresholdRange;

in vec2 vCenterUv1;
in vec2 vCenterUv2;
in vec2 vCenterUv3;
in vec2 vCenterUv4;
in vec2 vRowUv1;
in vec2 vRowUv2;
in vec2 vRowUv3;
in vec2 vRowUv4;
in vec2 vRowUv5;
in vec2 vRowUv6;
in vec2 vRowUv7;
in vec2 vRowUv8;
in vec2 vRowUv9;

float clampToBorder(const vec2 uv) {
  return float(uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0);
}

// Reference: https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom
void main() {
  vec3 color = 0.125 * texture(inputBuffer, vec2(vRowUv5)).rgb;
  vec4 weight =
    0.03125 *
    vec4(
      clampToBorder(vRowUv1),
      clampToBorder(vRowUv3),
      clampToBorder(vRowUv7),
      clampToBorder(vRowUv9)
    );
  color += weight.x * texture(inputBuffer, vec2(vRowUv1)).rgb;
  color += weight.y * texture(inputBuffer, vec2(vRowUv3)).rgb;
  color += weight.z * texture(inputBuffer, vec2(vRowUv7)).rgb;
  color += weight.w * texture(inputBuffer, vec2(vRowUv9)).rgb;

  weight =
    0.0625 *
    vec4(
      clampToBorder(vRowUv2),
      clampToBorder(vRowUv4),
      clampToBorder(vRowUv6),
      clampToBorder(vRowUv8)
    );
  color += weight.x * texture(inputBuffer, vec2(vRowUv2)).rgb;
  color += weight.y * texture(inputBuffer, vec2(vRowUv4)).rgb;
  color += weight.z * texture(inputBuffer, vec2(vRowUv6)).rgb;
  color += weight.w * texture(inputBuffer, vec2(vRowUv8)).rgb;

  weight =
    0.125 *
    vec4(
      clampToBorder(vRowUv2),
      clampToBorder(vRowUv4),
      clampToBorder(vRowUv6),
      clampToBorder(vRowUv8)
    );
  color += weight.x * texture(inputBuffer, vec2(vCenterUv1)).rgb;
  color += weight.y * texture(inputBuffer, vec2(vCenterUv2)).rgb;
  color += weight.z * texture(inputBuffer, vec2(vCenterUv3)).rgb;
  color += weight.w * texture(inputBuffer, vec2(vCenterUv4)).rgb;

  // WORKAROUND: Avoid screen flashes if the input buffer contains NaN texels.
  // See: https://github.com/takram-design-engineering/three-geospatial/issues/7
  if (any(isnan(color))) {
    gl_FragColor = vec4(vec3(0.0), 1.0);
    return;
  }

  float l = luminance(color);
  float scale = saturate(smoothstep(thresholdLevel, thresholdLevel + thresholdRange, l));
  gl_FragColor = vec4(color * scale, 1.0);
}
`;
var K = `uniform vec2 texelSize;

out vec2 vCenterUv1;
out vec2 vCenterUv2;
out vec2 vCenterUv3;
out vec2 vCenterUv4;
out vec2 vRowUv1;
out vec2 vRowUv2;
out vec2 vRowUv3;
out vec2 vRowUv4;
out vec2 vRowUv5;
out vec2 vRowUv6;
out vec2 vRowUv7;
out vec2 vRowUv8;
out vec2 vRowUv9;

void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  vCenterUv1 = uv + texelSize * vec2(-1.0, 1.0);
  vCenterUv2 = uv + texelSize * vec2(1.0, 1.0);
  vCenterUv3 = uv + texelSize * vec2(-1.0, -1.0);
  vCenterUv4 = uv + texelSize * vec2(1.0, -1.0);
  vRowUv1 = uv + texelSize * vec2(-2.0, 2.0);
  vRowUv2 = uv + texelSize * vec2(0.0, 2.0);
  vRowUv3 = uv + texelSize * vec2(2.0, 2.0);
  vRowUv4 = uv + texelSize * vec2(-2.0, 0.0);
  vRowUv5 = uv + texelSize;
  vRowUv6 = uv + texelSize * vec2(2.0, 0.0);
  vRowUv7 = uv + texelSize * vec2(-2.0, -2.0);
  vRowUv8 = uv + texelSize * vec2(0.0, -2.0);
  vRowUv9 = uv + texelSize * vec2(2.0, -2.0);

  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
var Z = {
  thresholdLevel: 10,
  thresholdRange: 1
};
var Q = class extends U {
  constructor(e) {
    const {
      inputBuffer: t = null,
      thresholdLevel: i2,
      thresholdRange: n2,
      ...r
    } = {
      ...Z,
      ...e
    };
    super({
      name: "DownsampleThresholdMaterial",
      fragmentShader: W,
      vertexShader: K,
      blending: S,
      toneMapped: false,
      depthWrite: false,
      depthTest: false,
      ...r,
      uniforms: {
        inputBuffer: new s(t),
        texelSize: new s(new T()),
        thresholdLevel: new s(i2),
        thresholdRange: new s(n2),
        ...r.uniforms
      }
    });
  }
  setSize(e, t) {
    this.uniforms.texelSize.value.set(1 / e, 1 / t);
  }
  get inputBuffer() {
    return this.uniforms.inputBuffer.value;
  }
  set inputBuffer(e) {
    this.uniforms.inputBuffer.value = e;
  }
  get thresholdLevel() {
    return this.uniforms.thresholdLevel.value;
  }
  set thresholdLevel(e) {
    this.uniforms.thresholdLevel.value = e;
  }
  get thresholdRange() {
    return this.uniforms.thresholdRange.value;
  }
  set thresholdRange(e) {
    this.uniforms.thresholdRange.value = e;
  }
};
var X = `#include <common>

#define SQRT_2 0.7071067811865476

uniform sampler2D inputBuffer;

uniform vec2 texelSize;
uniform float ghostAmount;
uniform float haloAmount;
uniform float chromaticAberration;

in vec2 vUv;
in vec2 vAspectRatio;

vec3 sampleGhost(const vec2 direction, const vec3 color, const float offset) {
  vec2 suv = clamp(1.0 - vUv + direction * offset, 0.0, 1.0);
  vec3 result = texture(inputBuffer, suv).rgb * color;

  // Falloff at the perimeter.
  float d = clamp(length(0.5 - suv) / (0.5 * SQRT_2), 0.0, 1.0);
  result *= pow(1.0 - d, 3.0);
  return result;
}

vec4 sampleGhosts(float amount) {
  vec3 color = vec3(0.0);
  vec2 direction = vUv - 0.5;
  color += sampleGhost(direction, vec3(0.8, 0.8, 1.0), -5.0);
  color += sampleGhost(direction, vec3(1.0, 0.8, 0.4), -1.5);
  color += sampleGhost(direction, vec3(0.9, 1.0, 0.8), -0.4);
  color += sampleGhost(direction, vec3(1.0, 0.8, 0.4), -0.2);
  color += sampleGhost(direction, vec3(0.9, 0.7, 0.7), -0.1);
  color += sampleGhost(direction, vec3(0.5, 1.0, 0.4), 0.7);
  color += sampleGhost(direction, vec3(0.5, 0.5, 0.5), 1.0);
  color += sampleGhost(direction, vec3(1.0, 1.0, 0.6), 2.5);
  color += sampleGhost(direction, vec3(0.5, 0.8, 1.0), 10.0);
  return vec4(color * amount, 1.0);
}

// Reference: https://john-chapman.github.io/2017/11/05/pseudo-lens-flare.html
float cubicRingMask(const float x, const float radius, const float thickness) {
  float v = min(abs(x - radius) / thickness, 1.0);
  return 1.0 - v * v * (3.0 - 2.0 * v);
}

vec3 sampleHalo(const float radius) {
  vec2 direction = normalize((vUv - 0.5) / vAspectRatio) * vAspectRatio;
  vec3 offset = vec3(texelSize.x * chromaticAberration) * vec3(-1.0, 0.0, 1.0);
  vec2 suv = fract(1.0 - vUv + direction * radius);
  vec3 result = vec3(
    texture(inputBuffer, suv + direction * offset.r).r,
    texture(inputBuffer, suv + direction * offset.g).g,
    texture(inputBuffer, suv + direction * offset.b).b
  );

  // Falloff at the center and perimeter.
  vec2 wuv = (vUv - vec2(0.5, 0.0)) / vAspectRatio + vec2(0.5, 0.0);
  float d = saturate(distance(wuv, vec2(0.5)));
  result *= cubicRingMask(d, 0.45, 0.25);
  return result;
}

vec4 sampleHalos(const float amount) {
  vec3 color = vec3(0.0);
  color += sampleHalo(0.3);
  return vec4(color, 1.0) * amount;
}

void main() {
  gl_FragColor += sampleGhosts(ghostAmount);
  gl_FragColor += sampleHalos(haloAmount);
}

`;
var Y = `uniform vec2 texelSize;

out vec2 vUv;
out vec2 vAspectRatio;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  vAspectRatio = vec2(texelSize.x / texelSize.y, 1.0);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
var q = {
  ghostAmount: 1e-3,
  haloAmount: 1e-3,
  chromaticAberration: 10
};
var J = class extends U {
  constructor(e) {
    const {
      inputBuffer: t = null,
      ghostAmount: i2,
      haloAmount: n2,
      chromaticAberration: r,
      ...a
    } = {
      ...q,
      ...e
    };
    super({
      name: "LensFlareFeaturesMaterial",
      fragmentShader: X,
      vertexShader: Y,
      blending: S,
      toneMapped: false,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        inputBuffer: new s(t),
        texelSize: new s(new T()),
        ghostAmount: new s(i2),
        haloAmount: new s(n2),
        chromaticAberration: new s(r),
        ...a.uniforms
      }
    });
  }
  setSize(e, t) {
    this.uniforms.texelSize.value.set(1 / e, 1 / t);
  }
  get inputBuffer() {
    return this.uniforms.inputBuffer.value;
  }
  set inputBuffer(e) {
    this.uniforms.inputBuffer.value = e;
  }
  get ghostAmount() {
    return this.uniforms.ghostAmount.value;
  }
  set ghostAmount(e) {
    this.uniforms.ghostAmount.value = e;
  }
  get haloAmount() {
    return this.uniforms.haloAmount.value;
  }
  set haloAmount(e) {
    this.uniforms.haloAmount.value = e;
  }
  get chromaticAberration() {
    return this.uniforms.chromaticAberration.value;
  }
  set chromaticAberration(e) {
    this.uniforms.chromaticAberration.value = e;
  }
};
var ee = `uniform sampler2D bloomBuffer;
uniform sampler2D featuresBuffer;
uniform float intensity;

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  vec3 bloom = texture(bloomBuffer, uv).rgb;
  vec3 features = texture(featuresBuffer, uv).rgb;
  outputColor = vec4(inputColor.rgb + (bloom + features) * intensity, inputColor.a);
}
`;
var te = {
  blendFunction: v.NORMAL,
  resolutionScale: 0.5,
  width: h.AUTO_SIZE,
  height: h.AUTO_SIZE,
  intensity: 5e-3
};
var ve = class extends f {
  constructor(e) {
    const {
      blendFunction: t,
      resolutionScale: i2,
      width: n2,
      height: r,
      resolutionX: a = n2,
      resolutionY: u = r,
      intensity: E
    } = {
      ...te,
      ...e
    };
    super("LensFlareEffect", ee, {
      blendFunction: t,
      attributes: d.CONVOLUTION,
      uniforms: new Map(
        Object.entries({
          bloomBuffer: new s(null),
          featuresBuffer: new s(null),
          intensity: new s(1)
        })
      )
    }), this.onResolutionChange = () => {
      this.setSize(this.resolution.baseWidth, this.resolution.baseHeight);
    }, this.renderTarget1 = new w(1, 1, {
      depthBuffer: false,
      type: m
    }), this.renderTarget1.texture.name = "LensFlare.Target1", this.renderTarget2 = new w(1, 1, {
      depthBuffer: false,
      type: m
    }), this.renderTarget2.texture.name = "LensFlare.Target2", this.thresholdMaterial = new Q(), this.thresholdPass = new g(this.thresholdMaterial), this.blurPass = new P(), this.blurPass.levels = 8, this.preBlurPass = new z({
      kernelSize: D.SMALL
    }), this.featuresMaterial = new J(), this.featuresPass = new g(this.featuresMaterial), this.uniforms.get("bloomBuffer").value = this.blurPass.texture, this.uniforms.get("featuresBuffer").value = this.renderTarget1.texture, this.resolution = new h(
      this,
      a,
      u,
      i2
    ), this.resolution.addEventListener("change", this.onResolutionChange), this.intensity = E;
  }
  initialize(e, t, i2) {
    this.thresholdPass.initialize(e, t, i2), this.blurPass.initialize(e, t, i2), this.preBlurPass.initialize(e, t, i2), this.featuresPass.initialize(e, t, i2);
  }
  update(e, t, i2) {
    this.thresholdPass.render(e, t, this.renderTarget1), this.blurPass.render(e, this.renderTarget1, null), this.preBlurPass.render(e, this.renderTarget1, this.renderTarget2), this.featuresPass.render(e, this.renderTarget2, this.renderTarget1);
  }
  setSize(e, t) {
    const i2 = this.resolution;
    i2.setBaseSize(e, t);
    const { width: n2, height: r } = i2;
    this.renderTarget1.setSize(n2, r), this.renderTarget2.setSize(n2, r), this.thresholdMaterial.setSize(n2, r), this.blurPass.setSize(n2, r), this.preBlurPass.setSize(n2, r), this.featuresMaterial.setSize(n2, r);
  }
  get intensity() {
    return this.uniforms.get("intensity").value;
  }
  set intensity(e) {
    this.uniforms.get("intensity").value = e;
  }
  get thresholdLevel() {
    return this.thresholdMaterial.thresholdLevel;
  }
  set thresholdLevel(e) {
    this.thresholdMaterial.thresholdLevel = e;
  }
  get thresholdRange() {
    return this.thresholdMaterial.thresholdRange;
  }
  set thresholdRange(e) {
    this.thresholdMaterial.thresholdRange = e;
  }
};
var ne = `#include "core/depth"
#include "core/packing"
#include "core/transform"

uniform highp sampler2D normalBuffer;

uniform mat4 projectionMatrix;
uniform mat4 inverseProjectionMatrix;

vec3 reconstructNormal(const vec2 uv) {
  float depth = readDepthValue(depthBuffer, uv);
  depth = reverseLogDepth(depth, cameraNear, cameraFar);
  vec3 position = screenToView(
    uv,
    depth,
    getViewZ(depth),
    projectionMatrix,
    inverseProjectionMatrix
  );
  vec3 dx = dFdx(position);
  vec3 dy = dFdy(position);
  return normalize(cross(dx, dy));
}

vec3 readNormal(const vec2 uv) {
  #ifdef OCT_ENCODED
  return unpackVec2ToNormal(texture(normalBuffer, uv).xy);
  #else // OCT_ENCODED
  return 2.0 * texture(normalBuffer, uv).xyz - 1.0;
  #endif // OCT_ENCODED
}

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  #ifdef RECONSTRUCT_FROM_DEPTH
  vec3 normal = reconstructNormal(uv);
  #else // RECONSTRUCT_FROM_DEPTH
  vec3 normal = readNormal(uv);
  #endif // RECONSTRUCT_FROM_DEPTH

  outputColor = vec4(normal * 0.5 + 0.5, inputColor.a);
}
`;
var re = Object.defineProperty;
var _ = (o, e, t, i2) => {
  for (var n2 = void 0, r = o.length - 1, a; r >= 0; r--)
    (a = o[r]) && (n2 = a(e, t, n2) || n2);
  return n2 && re(e, t, n2), n2;
};
var oe = {
  blendFunction: v.SRC,
  octEncoded: false,
  reconstructFromDepth: false
};
var y = class extends f {
  constructor(e, t) {
    const {
      blendFunction: i2,
      normalBuffer: n2 = null,
      octEncoded: r,
      reconstructFromDepth: a
    } = {
      ...oe,
      ...t
    };
    super(
      "NormalEffect",
      b(ne, {
        core: {
          depth: B,
          packing: C,
          transform: O
        }
      }),
      {
        blendFunction: i2,
        attributes: d.DEPTH,
        uniforms: new Map(
          Object.entries({
            normalBuffer: new s(n2),
            projectionMatrix: new s(new x()),
            inverseProjectionMatrix: new s(new x())
          })
        )
      }
    ), this.camera = e, e != null && (this.mainCamera = e), this.octEncoded = r, this.reconstructFromDepth = a;
  }
  get mainCamera() {
    return this.camera;
  }
  set mainCamera(e) {
    this.camera = e;
  }
  update(e, t, i2) {
    const n2 = this.uniforms, r = n2.get("projectionMatrix"), a = n2.get("inverseProjectionMatrix"), u = this.camera;
    u != null && (r.value.copy(u.projectionMatrix), a.value.copy(u.projectionMatrixInverse));
  }
  get normalBuffer() {
    return this.uniforms.get("normalBuffer").value;
  }
  set normalBuffer(e) {
    this.uniforms.get("normalBuffer").value = e;
  }
};
_([
  p("OCT_ENCODED")
], y.prototype, "octEncoded");
_([
  p("RECONSTRUCT_FROM_DEPTH")
], y.prototype, "reconstructFromDepth");

// node_modules/@takram/three-geospatial-effects/build/index.js
function p2(e) {
  n(e.image);
  const { width: t, height: s2 } = e.image;
  if (t !== s2)
    throw new Error("Hald CLUT image must be square.");
  const o = Math.cbrt(t * s2);
  if (o % 1 !== 0)
    throw new Error("Hald CLUT image must be cubic.");
  const { data: r } = f2.from(e.image), a = new i(r, o);
  return a.name = e.name, a.type = e.type, e.colorSpace = a.colorSpace, a;
}
export {
  H as DepthEffect,
  le as DitheringEffect,
  ce as GeometryPass,
  ve as LensFlareEffect,
  y as NormalEffect,
  p2 as createHaldLookupTexture,
  G as depthEffectOptionsDefaults,
  $ as ditheringOptionsDefaults,
  te as lensFlareEffectOptionsDefaults,
  oe as normalEffectOptionsDefaults,
  k as setupMaterialsForGeometryPass
};
