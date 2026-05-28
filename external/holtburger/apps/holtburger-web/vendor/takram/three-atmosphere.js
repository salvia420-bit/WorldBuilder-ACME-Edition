// node_modules/@takram/three-atmosphere/build/shared.js
import { BlendFunction as Jt, Effect as Qt, EffectAttribute as en, Pass as tn, Selection as nn, RenderPass as rn, DepthCopyPass as Ze, ClearPass as an, DepthMaskMaterial as on, DepthTestStrategy as sn, ShaderPass as cn } from "postprocessing";
import { Vector3 as p2, Color as ae, Uniform as d2, Camera as St, Vector2 as oe, Matrix4 as D2, RawShaderMaterial as vt, Quaternion as un, HalfFloatType as k, MeshBasicMaterial as ln, DepthTexture as dn, UnsignedIntType as hn, WebGLRenderTarget as Et, RedFormat as mn, RGBADepthPacking as X0, LessEqualDepth as fn, BasicDepthPacking as gn, Matrix3 as w0, Mesh as pn, PlaneGeometry as Tn, Scene as Sn, FloatType as _e, GLSL3 as He, CustomBlending as vn, NoBlending as En, AddEquation as Je, OneFactor as Y0, RGBAFormat as Rt, LinearFilter as D0, ClampToEdgeWrapping as U0, NoColorSpace as _t, WebGL3DRenderTarget as Rn, Loader as _n, Data3DTexture as ge, DataTexture as Qe, LightProbe as xn, BufferGeometry as Mn, InterleavedBuffer as et, InterleavedBufferAttribute as pe, Sphere as An, DirectionalLight as wn } from "three";
import { radians as xt, Ellipsoid as F0, define as w2, defineInt as yn, unrollLoops as Cn, resolveIncludes as W, Geodetic as Dn, saturate as In, remap as Pn, reinterpretType as be, clamp as tt, isTypedArray as nt, Float16Array as Mt, isFloatLinearSupported as At, EXR3DTextureLoader as Te, EXRTextureLoader as rt, DataTextureLoader as O0, parseFloat16Array as L0 } from "@takram/three-geospatial";
import { vogelDisk as Nn, interleavedGradientNoise as On, cascadedShadowMaps as Ln, raySphereIntersection as wt, transform as Hn, math as bn, packing as Un, depth as yt } from "@takram/three-geospatial/shaders";

// node_modules/@takram/three-atmosphere/build/shared2.js
import { Matrix3 as E, Vector3 as c } from "three";
var T = "eac103980f20c0956f2d3215833e73514be08462";
var S = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${T}/packages/atmosphere/assets`;
var d = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${T}/packages/atmosphere/assets/stars.bin`;
var f = 64;
var A = 16;
var i = 32;
var _ = 128;
var R = 32;
var u = 8;
var U = u * R;
var g = _;
var N = i;
var C = 256;
var p = 64;
var w = 1 / 1e3;
var h = 100;
var D = /* @__PURE__ */ new E(
  3.2406255,
  -1.537208,
  -0.4986286,
  -0.9689307,
  1.8757561,
  0.0415175,
  0.0557101,
  -0.2040211,
  1.0569959
);
var I = /* @__PURE__ */ new c();
function X(t2, a, e2, s) {
  const n2 = e2.projectOnSurface(
    t2,
    I
  );
  return n2 != null ? e2.getOsculatingSphereCenter(n2, a, s).negate() : s.setScalar(0);
}
var l = true;
var r = "Invariant failed";
function G(t2, a) {
  if (!t2) {
    if (l)
      throw new Error(r);
    var e2 = r;
    throw new Error(e2);
  }
}
var H = typeof window < "u" && window.requestIdleCallback != null ? window.requestIdleCallback : function(a, e2 = {}) {
  const n2 = e2.timeout ?? 1, o = performance.now();
  return setTimeout(() => {
    a({
      get didTimeout() {
        return e2.timeout != null ? false : performance.now() - o - 1 > n2;
      },
      timeRemaining() {
        return Math.max(0, 1 + (performance.now() - o));
      }
    });
  }, 1);
};

// node_modules/@takram/three-atmosphere/build/shared3.js
var e = `// Based on: https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/functions.glsl

/**
 * Copyright (c) 2017 Eric Bruneton
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 *
 * Precomputed Atmospheric Scattering
 * Copyright (c) 2008 INRIA
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

Number ClampCosine(const Number mu) {
  return clamp(mu, Number(-1.0), Number(1.0));
}

Length ClampDistance(const Length d) {
  return max(d, 0.0 * m);
}

Length ClampRadius(const AtmosphereParameters atmosphere, const Length r) {
  return clamp(r, atmosphere.bottom_radius, atmosphere.top_radius);
}

Length SafeSqrt(const Area a) {
  return sqrt(max(a, 0.0 * m2));
}

Length DistanceToTopAtmosphereBoundary(const AtmosphereParameters atmosphere,
    const Length r, const Number mu) {
  assert(r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  Area discriminant = r * r * (mu * mu - 1.0) +
      atmosphere.top_radius * atmosphere.top_radius;
  return ClampDistance(-r * mu + SafeSqrt(discriminant));
}

Length DistanceToBottomAtmosphereBoundary(const AtmosphereParameters atmosphere,
    const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  Area discriminant = r * r * (mu * mu - 1.0) +
      atmosphere.bottom_radius * atmosphere.bottom_radius;
  return ClampDistance(-r * mu - SafeSqrt(discriminant));
}

bool RayIntersectsGround(const AtmosphereParameters atmosphere,
    const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  return mu < 0.0 && r * r * (mu * mu - 1.0) +
      atmosphere.bottom_radius * atmosphere.bottom_radius >= 0.0 * m2;
}

Number GetTextureCoordFromUnitRange(const Number x, const int texture_size) {
  return 0.5 / Number(texture_size) + x * (1.0 - 1.0 / Number(texture_size));
}

vec2 GetTransmittanceTextureUvFromRMu(const AtmosphereParameters atmosphere,
    const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  // Distance to top atmosphere boundary for a horizontal ray at ground level.
  Length H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
      atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the horizon.
  Length rho =
      SafeSqrt(r * r - atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the top atmosphere boundary for the ray (r,mu), and its minimum
  // and maximum values over all mu - obtained for (r,1) and (r,mu_horizon).
  Length d = DistanceToTopAtmosphereBoundary(atmosphere, r, mu);
  Length d_min = atmosphere.top_radius - r;
  Length d_max = rho + H;
  Number x_mu = (d - d_min) / (d_max - d_min);
  Number x_r = rho / H;
  return vec2(GetTextureCoordFromUnitRange(x_mu, TRANSMITTANCE_TEXTURE_WIDTH),
              GetTextureCoordFromUnitRange(x_r, TRANSMITTANCE_TEXTURE_HEIGHT));
}

DimensionlessSpectrum GetTransmittanceToTopAtmosphereBoundary(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  vec2 uv = GetTransmittanceTextureUvFromRMu(atmosphere, r, mu);
  // @shotamatsuda: Added for the precomputation stage in half-float precision.
  #ifdef TRANSMITTANCE_PRECISION_LOG
  // Manually interpolate the transmittance instead of the optical depth.
  const vec2 size = vec2(TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT);
  const vec3 texel_size = vec3(1.0 / size, 0.0);
  vec2 coord = (uv * size) - 0.5;
  vec2 i = (floor(coord) + 0.5) * texel_size.xy;
  vec2 f = fract(coord);
  vec4 t1 = exp(-texture(transmittance_texture, i));
  vec4 t2 = exp(-texture(transmittance_texture, i + texel_size.xz));
  vec4 t3 = exp(-texture(transmittance_texture, i + texel_size.zy));
  vec4 t4 = exp(-texture(transmittance_texture, i + texel_size.xy));
  return DimensionlessSpectrum(mix(mix(t1, t2, f.x), mix(t3, t4, f.x), f.y));
  #else // TRANSMITTANCE_PRECISION_LOG
  return DimensionlessSpectrum(texture(transmittance_texture, uv));
  #endif // TRANSMITTANCE_PRECISION_LOG
}

DimensionlessSpectrum GetTransmittance(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu, const Length d,
    const bool ray_r_mu_intersects_ground) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  assert(d >= 0.0 * m);

  Length r_d = ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
  Number mu_d = ClampCosine((r * mu + d) / r_d);

  if (ray_r_mu_intersects_ground) {
    return min(
        GetTransmittanceToTopAtmosphereBoundary(
            atmosphere, transmittance_texture, r_d, -mu_d) /
        GetTransmittanceToTopAtmosphereBoundary(
            atmosphere, transmittance_texture, r, -mu),
        DimensionlessSpectrum(1.0));
  } else {
    return min(
        GetTransmittanceToTopAtmosphereBoundary(
            atmosphere, transmittance_texture, r, mu) /
        GetTransmittanceToTopAtmosphereBoundary(
            atmosphere, transmittance_texture, r_d, mu_d),
        DimensionlessSpectrum(1.0));
  }
}

DimensionlessSpectrum GetTransmittanceToSun(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu_s) {
  Number sin_theta_h = atmosphere.bottom_radius / r;
  Number cos_theta_h = -sqrt(max(1.0 - sin_theta_h * sin_theta_h, 0.0));
  return GetTransmittanceToTopAtmosphereBoundary(
          atmosphere, transmittance_texture, r, mu_s) *
      smoothstep(-sin_theta_h * atmosphere.sun_angular_radius / rad,
                 sin_theta_h * atmosphere.sun_angular_radius / rad,
                 mu_s - cos_theta_h);
}

InverseSolidAngle RayleighPhaseFunction(const Number nu) {
  InverseSolidAngle k = 3.0 / (16.0 * PI * sr);
  return k * (1.0 + nu * nu);
}

InverseSolidAngle MiePhaseFunction(const Number g, const Number nu) {
  InverseSolidAngle k = 3.0 / (8.0 * PI * sr) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

vec4 GetScatteringTextureUvwzFromRMuMuSNu(const AtmosphereParameters atmosphere,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  assert(nu >= -1.0 && nu <= 1.0);

  // Distance to top atmosphere boundary for a horizontal ray at ground level.
  Length H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
      atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the horizon.
  Length rho =
      SafeSqrt(r * r - atmosphere.bottom_radius * atmosphere.bottom_radius);
  Number u_r = GetTextureCoordFromUnitRange(rho / H, SCATTERING_TEXTURE_R_SIZE);

  // Discriminant of the quadratic equation for the intersections of the ray
  // (r,mu) with the ground (see RayIntersectsGround).
  Length r_mu = r * mu;
  Area discriminant =
      r_mu * r_mu - r * r + atmosphere.bottom_radius * atmosphere.bottom_radius;
  Number u_mu;
  if (ray_r_mu_intersects_ground) {
    // Distance to the ground for the ray (r,mu), and its minimum and maximum
    // values over all mu - obtained for (r,-1) and (r,mu_horizon).
    Length d = -r_mu - SafeSqrt(discriminant);
    Length d_min = r - atmosphere.bottom_radius;
    Length d_max = rho;
    u_mu = 0.5 - 0.5 * GetTextureCoordFromUnitRange(d_max == d_min ? 0.0 :
        (d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
  } else {
    // Distance to the top atmosphere boundary for the ray (r,mu), and its
    // minimum and maximum values over all mu - obtained for (r,1) and
    // (r,mu_horizon).
    Length d = -r_mu + SafeSqrt(discriminant + H * H);
    Length d_min = atmosphere.top_radius - r;
    Length d_max = rho + H;
    u_mu = 0.5 + 0.5 * GetTextureCoordFromUnitRange(
        (d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
  }

  Length d = DistanceToTopAtmosphereBoundary(
      atmosphere, atmosphere.bottom_radius, mu_s);
  Length d_min = atmosphere.top_radius - atmosphere.bottom_radius;
  Length d_max = H;
  Number a = (d - d_min) / (d_max - d_min);
  Length D = DistanceToTopAtmosphereBoundary(
      atmosphere, atmosphere.bottom_radius, atmosphere.mu_s_min);
  Number A = (D - d_min) / (d_max - d_min);
  // An ad-hoc function equal to 0 for mu_s = mu_s_min (because then d = D and
  // thus a = A), equal to 1 for mu_s = 1 (because then d = d_min and thus
  // a = 0), and with a large slope around mu_s = 0, to get more texture
  // samples near the horizon.
  Number u_mu_s = GetTextureCoordFromUnitRange(
      max(1.0 - a / A, 0.0) / (1.0 + a), SCATTERING_TEXTURE_MU_S_SIZE);

  Number u_nu = (nu + 1.0) / 2.0;
  return vec4(u_nu, u_mu_s, u_mu, u_r);
}

vec2 GetIrradianceTextureUvFromRMuS(const AtmosphereParameters atmosphere,
    const Length r, const Number mu_s) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  Number x_r = (r - atmosphere.bottom_radius) /
      (atmosphere.top_radius - atmosphere.bottom_radius);
  Number x_mu_s = mu_s * 0.5 + 0.5;
  return vec2(GetTextureCoordFromUnitRange(x_mu_s, IRRADIANCE_TEXTURE_WIDTH),
              GetTextureCoordFromUnitRange(x_r, IRRADIANCE_TEXTURE_HEIGHT));
}

IrradianceSpectrum GetIrradiance(
    const AtmosphereParameters atmosphere,
    const IrradianceTexture irradiance_texture,
    const Length r, const Number mu_s) {
  vec2 uv = GetIrradianceTextureUvFromRMuS(atmosphere, r, mu_s);
  return IrradianceSpectrum(texture(irradiance_texture, uv));
}
`;
var t = `// Based on: https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/definitions.glsl

/**
 * Copyright (c) 2017 Eric Bruneton
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

#define assert(x)

#define Length float
#define Wavelength float
#define Angle float
#define SolidAngle float
#define Power float
#define LuminousPower float

#define Number float
#define InverseLength float
#define Area float
#define Volume float
#define NumberDensity float
#define Irradiance float
#define Radiance float
#define SpectralPower float
#define SpectralIrradiance float
#define SpectralRadiance float
#define SpectralRadianceDensity float
#define ScatteringCoefficient float
#define InverseSolidAngle float
#define LuminousIntensity float
#define Luminance float
#define Illuminance float

// A generic function from Wavelength to some other type.
#define AbstractSpectrum vec3
// A function from Wavelength to Number.
#define DimensionlessSpectrum vec3
// A function from Wavelength to SpectralPower.
#define PowerSpectrum vec3
// A function from Wavelength to SpectralIrradiance.
#define IrradianceSpectrum vec3
// A function from Wavelength to SpectralRadiance.
#define RadianceSpectrum vec3
// A function from Wavelength to SpectralRadianceDensity.
#define RadianceDensitySpectrum vec3
// A function from Wavelength to ScatteringCoefficient.
#define ScatteringSpectrum vec3

// A position in 3D (3 length values).
#define Position vec3
// A unit direction vector in 3D (3 unit-less values).
#define Direction vec3
// A vector of 3 luminance values.
#define Luminance3 vec3
// A vector of 3 illuminance values.
#define Illuminance3 vec3

#define TransmittanceTexture sampler2D
#define AbstractScatteringTexture sampler3D
#define ReducedScatteringTexture sampler3D
#define ScatteringTexture sampler3D
#define ScatteringDensityTexture sampler3D
#define IrradianceTexture sampler2D

const Length m = 1.0;
const Wavelength nm = 1.0;
const Angle rad = 1.0;
const SolidAngle sr = 1.0;
const Power watt = 1.0;
const LuminousPower lm = 1.0;

#if !defined(PI)
const float PI = 3.14159265358979323846;
#endif // !defined(PI)

const Length km = 1000.0 * m;
const Area m2 = m * m;
const Volume m3 = m * m * m;
const Angle pi = PI * rad;
const Angle deg = pi / 180.0;
const Irradiance watt_per_square_meter = watt / m2;
const Radiance watt_per_square_meter_per_sr = watt / (m2 * sr);
const SpectralIrradiance watt_per_square_meter_per_nm = watt / (m2 * nm);
const SpectralRadiance watt_per_square_meter_per_sr_per_nm = watt / (m2 * sr * nm);
const SpectralRadianceDensity watt_per_cubic_meter_per_sr_per_nm = watt / (m3 * sr * nm);
const LuminousIntensity cd = lm / sr;
const LuminousIntensity kcd = 1000.0 * cd;
const Luminance cd_per_square_meter = cd / m2;
const Luminance kcd_per_square_meter = kcd / m2;

struct DensityProfileLayer {
  Length width;
  Number exp_term;
  InverseLength exp_scale;
  InverseLength linear_term;
  Number constant_term;
};

struct DensityProfile {
  DensityProfileLayer layers[2];
};

// See AtmosphereParameter.ts for further details.
struct AtmosphereParameters {
  IrradianceSpectrum solar_irradiance;
  Angle sun_angular_radius;
  Length bottom_radius;
  Length top_radius;
  DensityProfile rayleigh_density;
  ScatteringSpectrum rayleigh_scattering;
  DensityProfile mie_density;
  ScatteringSpectrum mie_scattering;
  ScatteringSpectrum mie_extinction;
  Number mie_phase_function_g;
  DensityProfile absorption_density;
  ScatteringSpectrum absorption_extinction;
  DimensionlessSpectrum ground_albedo;
  Number mu_s_min;
};
`;
var n = `// Based on: https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/functions.glsl

/**
 * Copyright (c) 2017 Eric Bruneton
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 *
 * Precomputed Atmospheric Scattering
 * Copyright (c) 2008 INRIA
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

#ifdef COMBINED_SCATTERING_TEXTURES
vec3 GetExtrapolatedSingleMieScattering(
    const AtmosphereParameters atmosphere, const vec4 scattering) {
  // Algebraically this can never be negative, but rounding errors can produce
  // that effect for sufficiently short view rays.
  // @shotamatsuda: Avoid division by infinitesimal values.
  // See https://github.com/takram-design-engineering/three-geospatial/issues/47
  if (scattering.r < 1e-5) {
    return vec3(0.0);
  }
  return scattering.rgb * scattering.a / scattering.r *
	    (atmosphere.rayleigh_scattering.r / atmosphere.mie_scattering.r) *
	    (atmosphere.mie_scattering / atmosphere.rayleigh_scattering);
}
#endif // COMBINED_SCATTERING_TEXTURES

IrradianceSpectrum GetCombinedScattering(
    const AtmosphereParameters atmosphere,
    const ReducedScatteringTexture scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground,
    out IrradianceSpectrum single_mie_scattering) {
  vec4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(
      atmosphere, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  Number tex_coord_x = uvwz.x * Number(SCATTERING_TEXTURE_NU_SIZE - 1);
  Number tex_x = floor(tex_coord_x);
  Number lerp = tex_coord_x - tex_x;
  vec3 uvw0 = vec3((tex_x + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
  vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
#ifdef COMBINED_SCATTERING_TEXTURES
  vec4 combined_scattering =
      texture(scattering_texture, uvw0) * (1.0 - lerp) +
      texture(scattering_texture, uvw1) * lerp;
  IrradianceSpectrum scattering = IrradianceSpectrum(combined_scattering);
  single_mie_scattering =
      GetExtrapolatedSingleMieScattering(atmosphere, combined_scattering);
#else // COMBINED_SCATTERING_TEXTURES
  IrradianceSpectrum scattering = IrradianceSpectrum(
      texture(scattering_texture, uvw0) * (1.0 - lerp) +
      texture(scattering_texture, uvw1) * lerp);
  single_mie_scattering = IrradianceSpectrum(
      texture(single_mie_scattering_texture, uvw0) * (1.0 - lerp) +
      texture(single_mie_scattering_texture, uvw1) * lerp);
#endif // COMBINED_SCATTERING_TEXTURES
  return scattering;
}

// @shotamatsuda: Added for reading higher-order scattering texture.
#ifdef HAS_HIGHER_ORDER_SCATTERING_TEXTURE
IrradianceSpectrum GetScattering(
    const AtmosphereParameters atmosphere,
    const ReducedScatteringTexture scattering_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground) {
  vec4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(
      atmosphere, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  Number tex_coord_x = uvwz.x * Number(SCATTERING_TEXTURE_NU_SIZE - 1);
  Number tex_x = floor(tex_coord_x);
  Number lerp = tex_coord_x - tex_x;
  vec3 uvw0 = vec3((tex_x + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
  vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
  IrradianceSpectrum scattering = IrradianceSpectrum(
      texture(scattering_texture, uvw0) * (1.0 - lerp) +
      texture(scattering_texture, uvw1) * lerp);
  return scattering;
}
#endif // HAS_HIGHER_ORDER_SCATTERING_TEXTURE

RadianceSpectrum GetSkyRadiance(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ReducedScatteringTexture scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    Position camera, const Direction view_ray, const Length shadow_length,
    const Direction sun_direction,
    out DimensionlessSpectrum transmittance) {
  // Compute the distance to the top atmosphere boundary along the view ray,
  // assuming the viewer is in space (or NaN if the view ray does not intersect
  // the atmosphere).
  Length r = length(camera);
  Length rmu = dot(camera, view_ray);
  // @shotamatsuda: Use SafeSqrt instead.
  // See: https://github.com/takram-design-engineering/three-geospatial/pull/26
  Length distance_to_top_atmosphere_boundary = -rmu -
      SafeSqrt(rmu * rmu - r * r +
          atmosphere.top_radius * atmosphere.top_radius);
  // If the viewer is in space and the view ray intersects the atmosphere, move
  // the viewer to the top atmosphere boundary (along the view ray):
  if (distance_to_top_atmosphere_boundary > 0.0 * m) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = atmosphere.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  } else if (r > atmosphere.top_radius) {
    // If the view ray does not intersect the atmosphere, simply return 0.
    transmittance = DimensionlessSpectrum(1.0);
    return RadianceSpectrum(0.0 * watt_per_square_meter_per_sr_per_nm);
  }
  // Compute the r, mu, mu_s and nu parameters needed for the texture lookups.
  Number mu = rmu / r;
  Number mu_s = dot(camera, sun_direction) / r;
  Number nu = dot(view_ray, sun_direction);

  // @shotamatsuda: For rendering points below the bottom atmosphere.
  #ifdef GROUND
  bool ray_r_mu_intersects_ground = RayIntersectsGround(atmosphere, r, mu);
  #else // GROUND
  bool ray_r_mu_intersects_ground = false;
  #endif // GROUND

  transmittance = ray_r_mu_intersects_ground ? DimensionlessSpectrum(0.0) :
      GetTransmittanceToTopAtmosphereBoundary(
          atmosphere, transmittance_texture, r, mu);
  IrradianceSpectrum single_mie_scattering;
  IrradianceSpectrum scattering;
  if (shadow_length == 0.0 * m) {
    scattering = GetCombinedScattering(
        atmosphere, scattering_texture, single_mie_scattering_texture,
        r, mu, mu_s, nu, ray_r_mu_intersects_ground,
        single_mie_scattering);
  } else {
    // Case of light shafts (shadow_length is the total length noted l in our
    // paper): we omit the scattering between the camera and the point at
    // distance l, by implementing Eq. (18) of the paper (shadow_transmittance
    // is the T(x,x_s) term, scattering is the S|x_s=x+lv term).
    Length d = shadow_length;
    Length r_p =
        ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
    Number mu_p = (r * mu + d) / r_p;
    Number mu_s_p = (r * mu_s + d * nu) / r_p;

    scattering = GetCombinedScattering(
        atmosphere, scattering_texture, single_mie_scattering_texture,
        r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground,
        single_mie_scattering);
    DimensionlessSpectrum shadow_transmittance =
        GetTransmittance(atmosphere, transmittance_texture,
            r, mu, shadow_length, ray_r_mu_intersects_ground);
    // @shotamatsuda: Occlude only single Rayleigh scattering by the shadow.
#ifdef HAS_HIGHER_ORDER_SCATTERING_TEXTURE
    IrradianceSpectrum higher_order_scattering = GetScattering(
        atmosphere, higher_order_scattering_texture,
        r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground);
    IrradianceSpectrum single_scattering = scattering - higher_order_scattering;
    scattering = single_scattering * shadow_transmittance + higher_order_scattering;
#else // HAS_HIGHER_ORDER_SCATTERING_TEXTURE
    scattering = scattering * shadow_transmittance;
#endif // HAS_HIGHER_ORDER_SCATTERING_TEXTURE
    single_mie_scattering = single_mie_scattering * shadow_transmittance;
  }
  return scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
      MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
}

// @shotamatsuda: Returns the point on the ray closest to the origin.
vec3 ClosestPointOnRay(const Position camera, const Position point) {
  Position ray = point - camera;
  Number t = clamp(-dot(camera, ray) / dot(ray, ray), 0.0, 1.0);
  return camera + t * ray;
}

vec2 RaySphereIntersections(
    const Position camera, const Direction direction, const Length radius) {
  float b = 2.0 * dot(direction, camera);
  float c = dot(camera, camera) - radius * radius;
  float discriminant = b * b - 4.0 * c;
  float Q = sqrt(discriminant);
  return vec2(-b - Q, -b + Q) * 0.5;
}

// @shotamatsuda: Clip the view ray at the bottom atmosphere boundary.
bool ClipAtBottomAtmosphere(
    const AtmosphereParameters atmosphere,
    const Direction view_ray, inout Position camera, inout Position point) {
  const Length eps = 0.0;
  Length bottom_radius = atmosphere.bottom_radius + eps;
  Length r_camera = length(camera);
  Length r_point = length(point);
  bool camera_below = r_camera < bottom_radius;
  bool point_below = r_point < bottom_radius;

  vec2 t = RaySphereIntersections(camera, view_ray, bottom_radius);
  Position intersection = camera + view_ray * (camera_below ? t.y : t.x);
  camera = camera_below ? intersection : camera;
  point = point_below ? intersection : point;

  return camera_below && point_below;
}

RadianceSpectrum GetSkyRadianceToPoint(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ReducedScatteringTexture scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    Position camera, Position point, const Length shadow_length,
    const Direction sun_direction, out DimensionlessSpectrum transmittance) {
  // @shotamatsuda: Avoid artifacts when the ray does not intersect the top
  // atmosphere boundary.
  if (length(ClosestPointOnRay(camera, point)) > atmosphere.top_radius) {
    transmittance = vec3(1.0);
    return vec3(0.0);
  }

  Direction view_ray = normalize(point - camera);
  if (ClipAtBottomAtmosphere(atmosphere, view_ray, camera, point)) {
    transmittance = vec3(1.0);
    return vec3(0.0);
  }

  // Compute the distance to the top atmosphere boundary along the view ray,
  // assuming the viewer is in space (or NaN if the view ray does not intersect
  // the atmosphere).
  Length r = length(camera);
  Length rmu = dot(camera, view_ray);
  // @shotamatsuda: Use SafeSqrt instead.
  // See: https://github.com/takram-design-engineering/three-geospatial/pull/26
  Length distance_to_top_atmosphere_boundary = -rmu -
      SafeSqrt(rmu * rmu - r * r +
          atmosphere.top_radius * atmosphere.top_radius);
  // If the viewer is in space and the view ray intersects the atmosphere, move
  // the viewer to the top atmosphere boundary (along the view ray):
  if (distance_to_top_atmosphere_boundary > 0.0 * m) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = atmosphere.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  }

  // Compute the r, mu, mu_s and nu parameters for the first texture lookup.
  Number mu = rmu / r;
  Number mu_s = dot(camera, sun_direction) / r;
  Number nu = dot(view_ray, sun_direction);
  Length d = length(point - camera);
  bool ray_r_mu_intersects_ground = RayIntersectsGround(atmosphere, r, mu);

  // @shotamatsuda: Hack to avoid rendering artifacts near the horizon, due to
  // finite atmosphere texture resolution and finite floating point precision.
  // See: https://github.com/ebruneton/precomputed_atmospheric_scattering/pull/32
  if (!ray_r_mu_intersects_ground) {
    Number mu_horizon = -SafeSqrt(1.0 -
        (atmosphere.bottom_radius * atmosphere.bottom_radius) / (r * r));
    const Number eps = 0.004;
    mu = max(mu, mu_horizon + eps);
  }

  transmittance = GetTransmittance(atmosphere, transmittance_texture,
      r, mu, d, ray_r_mu_intersects_ground);

  IrradianceSpectrum single_mie_scattering;
  IrradianceSpectrum scattering = GetCombinedScattering(
      atmosphere, scattering_texture, single_mie_scattering_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground,
      single_mie_scattering);

  // Compute the r, mu, mu_s and nu parameters for the second texture lookup.
  // If shadow_length is not 0 (case of light shafts), we want to ignore the
  // scattering along the last shadow_length meters of the view ray, which we
  // do by subtracting shadow_length from d (this way scattering_p is equal to
  // the S|x_s=x_0-lv term in Eq. (17) of our paper).
  d = max(d - shadow_length, 0.0 * m);
  Length r_p = ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
  Number mu_p = (r * mu + d) / r_p;
  Number mu_s_p = (r * mu_s + d * nu) / r_p;

  IrradianceSpectrum single_mie_scattering_p;
  IrradianceSpectrum scattering_p = GetCombinedScattering(
      atmosphere, scattering_texture, single_mie_scattering_texture,
      r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground,
      single_mie_scattering_p);

  // Combine the lookup results to get the scattering between camera and point.
  DimensionlessSpectrum shadow_transmittance = transmittance;
  if (shadow_length > 0.0 * m) {
    // This is the T(x,x_s) term in Eq. (17) of our paper, for light shafts.
    shadow_transmittance = GetTransmittance(atmosphere, transmittance_texture,
        r, mu, d, ray_r_mu_intersects_ground);
  }
  // @shotamatsuda: Occlude only single Rayleigh scattering by the shadow.
#ifdef HAS_HIGHER_ORDER_SCATTERING_TEXTURE
  IrradianceSpectrum higher_order_scattering = GetScattering(
      atmosphere, higher_order_scattering_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  IrradianceSpectrum single_scattering = scattering - higher_order_scattering;
  IrradianceSpectrum higher_order_scattering_p = GetScattering(
      atmosphere, higher_order_scattering_texture,
      r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground);
  IrradianceSpectrum single_scattering_p =
      scattering_p - higher_order_scattering_p;
  scattering =
      single_scattering - shadow_transmittance * single_scattering_p +
      higher_order_scattering - transmittance * higher_order_scattering_p;
#else // HAS_HIGHER_ORDER_SCATTERING_TEXTURE
  scattering = scattering - shadow_transmittance * scattering_p;
#endif // HAS_HIGHER_ORDER_SCATTERING_TEXTURE

  single_mie_scattering =
      single_mie_scattering - shadow_transmittance * single_mie_scattering_p;
#ifdef COMBINED_SCATTERING_TEXTURES
  single_mie_scattering = GetExtrapolatedSingleMieScattering(
      atmosphere, vec4(scattering, single_mie_scattering.r));
#endif // COMBINED_SCATTERING_TEXTURES

  // Hack to avoid rendering artifacts when the sun is below the horizon.
  single_mie_scattering = single_mie_scattering *
      smoothstep(Number(0.0), Number(0.01), mu_s);

  return scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
      MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
}

IrradianceSpectrum GetSunAndSkyIrradiance(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const IrradianceTexture irradiance_texture,
    const Position point, const Direction normal, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  Length r = length(point);
  Number mu_s = dot(point, sun_direction) / r;

  // Indirect irradiance (approximated if the surface is not horizontal).
  sky_irradiance = GetIrradiance(atmosphere, irradiance_texture, r, mu_s) *
      (1.0 + dot(normal, point) / r) * 0.5;

  // Direct irradiance.
  return atmosphere.solar_irradiance *
      GetTransmittanceToSun(
          atmosphere, transmittance_texture, r, mu_s) *
      max(dot(normal, sun_direction), 0.0);
}

// @shotamatsuda: Added for the clouds.
IrradianceSpectrum GetSunAndSkyScalarIrradiance(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const IrradianceTexture irradiance_texture,
    const Position point, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  Length r = length(point);
  Number mu_s = dot(point, sun_direction) / r;

  // Indirect irradiance. Integral over sphere yields 2\u03C0.
  sky_irradiance = GetIrradiance(atmosphere, irradiance_texture, r, mu_s) *
      2.0 * PI;

  // Direct irradiance. Omit the cosine term.
  return atmosphere.solar_irradiance *
      GetTransmittanceToSun(atmosphere, transmittance_texture, r, mu_s);
}

Luminance3 GetSolarLuminance() {
  return ATMOSPHERE.solar_irradiance /
      (PI * ATMOSPHERE.sun_angular_radius * ATMOSPHERE.sun_angular_radius) *
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

Luminance3 GetSkyLuminance(
    const Position camera, Direction view_ray, const Length shadow_length,
    const Direction sun_direction, out DimensionlessSpectrum transmittance) {
  return GetSkyRadiance(ATMOSPHERE, transmittance_texture,
      scattering_texture, single_mie_scattering_texture,
      camera, view_ray, shadow_length, sun_direction,
      transmittance) * SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

Luminance3 GetSkyLuminanceToPoint(
    const Position camera, const Position point, const Length shadow_length,
    const Direction sun_direction, out DimensionlessSpectrum transmittance) {
  return GetSkyRadianceToPoint(ATMOSPHERE, transmittance_texture,
      scattering_texture, single_mie_scattering_texture,
      camera, point, shadow_length, sun_direction, transmittance) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

Illuminance3 GetSunAndSkyIlluminance(
    const Position p, const Direction normal, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  IrradianceSpectrum sun_irradiance = GetSunAndSkyIrradiance(
      ATMOSPHERE, transmittance_texture, irradiance_texture, p, normal,
      sun_direction, sky_irradiance);
  sky_irradiance *= SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  return sun_irradiance * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

// @shotamatsuda: Added for the clouds.
Illuminance3 GetSunAndSkyScalarIlluminance(
    const Position p, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  IrradianceSpectrum sun_irradiance = GetSunAndSkyScalarIrradiance(
      ATMOSPHERE, transmittance_texture, irradiance_texture, p,
      sun_direction, sky_irradiance);
  sky_irradiance *= SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  return sun_irradiance * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

#define GetSolarRadiance GetSolarLuminance
#define GetSkyRadiance GetSkyLuminance
#define GetSkyRadianceToPoint GetSkyLuminanceToPoint
#define GetSunAndSkyIrradiance GetSunAndSkyIlluminance
#define GetSunAndSkyScalarIrradiance GetSunAndSkyScalarIlluminance
`;
var r2 = `// Based on: https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/functions.glsl

/**
 * Copyright (c) 2017 Eric Bruneton
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 *
 * Precomputed Atmospheric Scattering
 * Copyright (c) 2008 INRIA
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

Number GetLayerDensity(const DensityProfileLayer layer, const Length altitude) {
  Number density = layer.exp_term * exp(layer.exp_scale * altitude) +
      layer.linear_term * altitude + layer.constant_term;
  return clamp(density, Number(0.0), Number(1.0));
}

Number GetProfileDensity(const DensityProfile profile, const Length altitude) {
  DensityProfileLayer layers[2] = profile.layers;
  return altitude < layers[0].width
    ? GetLayerDensity(layers[0], altitude)
    : GetLayerDensity(layers[1], altitude);
}

Length ComputeOpticalLengthToTopAtmosphereBoundary(
    const AtmosphereParameters atmosphere, const DensityProfile profile,
    const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  // Number of intervals for the numerical integration.
  const int SAMPLE_COUNT = 500;
  // The integration step, i.e. the length of each integration interval.
  Length dx =
      DistanceToTopAtmosphereBoundary(atmosphere, r, mu) / Number(SAMPLE_COUNT);
  // Integration loop.
  Length result = 0.0 * m;
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    Length d_i = Number(i) * dx;
    // Distance between the current sample point and the planet center.
    Length r_i = sqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r);
    // Number density at the current sample point (divided by the number density
    // at the bottom of the atmosphere, yielding a dimensionless number).
    Number y_i = GetProfileDensity(profile, r_i - atmosphere.bottom_radius);
    // Sample weight (from the trapezoidal rule).
    Number weight_i = i == 0 || i == SAMPLE_COUNT ? 0.5 : 1.0;
    result += y_i * weight_i * dx;
  }
  return result;
}

DimensionlessSpectrum ComputeTransmittanceToTopAtmosphereBoundary(
    const AtmosphereParameters atmosphere, const Length r, const Number mu) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  vec3 optical_depth = (
      atmosphere.rayleigh_scattering *
          ComputeOpticalLengthToTopAtmosphereBoundary(
              atmosphere, atmosphere.rayleigh_density, r, mu) +
      atmosphere.mie_extinction *
          ComputeOpticalLengthToTopAtmosphereBoundary(
              atmosphere, atmosphere.mie_density, r, mu) +
      atmosphere.absorption_extinction *
          ComputeOpticalLengthToTopAtmosphereBoundary(
              atmosphere, atmosphere.absorption_density, r, mu));
  // @shotamatsuda: Added for the precomputation stage in half-float precision.
  #ifdef TRANSMITTANCE_PRECISION_LOG
  return optical_depth;
  #else // TRANSMITTANCE_PRECISION_LOG
  return exp(-optical_depth);
  #endif // TRANSMITTANCE_PRECISION_LOG
}

Number GetUnitRangeFromTextureCoord(const Number u, const int texture_size) {
  return (u - 0.5 / Number(texture_size)) / (1.0 - 1.0 / Number(texture_size));
}

void GetRMuFromTransmittanceTextureUv(const AtmosphereParameters atmosphere,
    const vec2 uv, out Length r, out Number mu) {
  assert(uv.x >= 0.0 && uv.x <= 1.0);
  assert(uv.y >= 0.0 && uv.y <= 1.0);
  Number x_mu = GetUnitRangeFromTextureCoord(uv.x, TRANSMITTANCE_TEXTURE_WIDTH);
  Number x_r = GetUnitRangeFromTextureCoord(uv.y, TRANSMITTANCE_TEXTURE_HEIGHT);
  // Distance to top atmosphere boundary for a horizontal ray at ground level.
  Length H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
      atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the horizon, from which we can compute r:
  Length rho = H * x_r;
  r = sqrt(rho * rho + atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the top atmosphere boundary for the ray (r,mu), and its minimum
  // and maximum values over all mu - obtained for (r,1) and (r,mu_horizon) -
  // from which we can recover mu:
  Length d_min = atmosphere.top_radius - r;
  Length d_max = rho + H;
  Length d = d_min + x_mu * (d_max - d_min);
  mu = d == 0.0 * m ? Number(1.0) : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = ClampCosine(mu);
}

DimensionlessSpectrum ComputeTransmittanceToTopAtmosphereBoundaryTexture(
    const AtmosphereParameters atmosphere, const vec2 frag_coord) {
  const vec2 TRANSMITTANCE_TEXTURE_SIZE =
      vec2(TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT);
  Length r;
  Number mu;
  GetRMuFromTransmittanceTextureUv(
      atmosphere, frag_coord / TRANSMITTANCE_TEXTURE_SIZE, r, mu);
  return ComputeTransmittanceToTopAtmosphereBoundary(atmosphere, r, mu);
}

void ComputeSingleScatteringIntegrand(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const Length d, const bool ray_r_mu_intersects_ground,
    out DimensionlessSpectrum rayleigh, out DimensionlessSpectrum mie) {
  Length r_d = ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
  Number mu_s_d = ClampCosine((r * mu_s + d * nu) / r_d);
  DimensionlessSpectrum transmittance =
      GetTransmittance(
          atmosphere, transmittance_texture, r, mu, d,
          ray_r_mu_intersects_ground) *
      GetTransmittanceToSun(
          atmosphere, transmittance_texture, r_d, mu_s_d);
  rayleigh = transmittance * GetProfileDensity(
      atmosphere.rayleigh_density, r_d - atmosphere.bottom_radius);
  mie = transmittance * GetProfileDensity(
      atmosphere.mie_density, r_d - atmosphere.bottom_radius);
}

Length DistanceToNearestAtmosphereBoundary(const AtmosphereParameters atmosphere,
    Length r, Number mu, bool ray_r_mu_intersects_ground) {
  if (ray_r_mu_intersects_ground) {
    return DistanceToBottomAtmosphereBoundary(atmosphere, r, mu);
  } else {
    return DistanceToTopAtmosphereBoundary(atmosphere, r, mu);
  }
}

void ComputeSingleScattering(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground,
    out IrradianceSpectrum rayleigh, out IrradianceSpectrum mie) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  assert(nu >= -1.0 && nu <= 1.0);

  // Number of intervals for the numerical integration.
  const int SAMPLE_COUNT = 50;
  // The integration step, i.e. the length of each integration interval.
  Length dx =
      DistanceToNearestAtmosphereBoundary(atmosphere, r, mu,
          ray_r_mu_intersects_ground) / Number(SAMPLE_COUNT);
  // Integration loop.
  DimensionlessSpectrum rayleigh_sum = DimensionlessSpectrum(0.0);
  DimensionlessSpectrum mie_sum = DimensionlessSpectrum(0.0);
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    Length d_i = Number(i) * dx;
    // The Rayleigh and Mie single scattering at the current sample point.
    DimensionlessSpectrum rayleigh_i;
    DimensionlessSpectrum mie_i;
    ComputeSingleScatteringIntegrand(atmosphere, transmittance_texture,
        r, mu, mu_s, nu, d_i, ray_r_mu_intersects_ground, rayleigh_i, mie_i);
    // Sample weight (from the trapezoidal rule).
    Number weight_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
    rayleigh_sum += rayleigh_i * weight_i;
    mie_sum += mie_i * weight_i;
  }
  rayleigh = rayleigh_sum * dx * atmosphere.solar_irradiance *
      atmosphere.rayleigh_scattering;
  mie = mie_sum * dx * atmosphere.solar_irradiance * atmosphere.mie_scattering;
}

void GetRMuMuSNuFromScatteringTextureUvwz(const AtmosphereParameters atmosphere,
    const vec4 uvwz, out Length r, out Number mu, out Number mu_s,
    out Number nu, out bool ray_r_mu_intersects_ground) {
  assert(uvwz.x >= 0.0 && uvwz.x <= 1.0);
  assert(uvwz.y >= 0.0 && uvwz.y <= 1.0);
  assert(uvwz.z >= 0.0 && uvwz.z <= 1.0);
  assert(uvwz.w >= 0.0 && uvwz.w <= 1.0);

  // Distance to top atmosphere boundary for a horizontal ray at ground level.
  Length H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
      atmosphere.bottom_radius * atmosphere.bottom_radius);
  // Distance to the horizon.
  Length rho =
      H * GetUnitRangeFromTextureCoord(uvwz.w, SCATTERING_TEXTURE_R_SIZE);
  r = sqrt(rho * rho + atmosphere.bottom_radius * atmosphere.bottom_radius);

  if (uvwz.z < 0.5) {
    // Distance to the ground for the ray (r,mu), and its minimum and maximum
    // values over all mu - obtained for (r,-1) and (r,mu_horizon) - from which
    // we can recover mu:
    Length d_min = r - atmosphere.bottom_radius;
    Length d_max = rho;
    Length d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(
        1.0 - 2.0 * uvwz.z, SCATTERING_TEXTURE_MU_SIZE / 2);
    mu = d == 0.0 * m ? Number(-1.0) :
        ClampCosine(-(rho * rho + d * d) / (2.0 * r * d));
    ray_r_mu_intersects_ground = true;
  } else {
    // Distance to the top atmosphere boundary for the ray (r,mu), and its
    // minimum and maximum values over all mu - obtained for (r,1) and
    // (r,mu_horizon) - from which we can recover mu:
    Length d_min = atmosphere.top_radius - r;
    Length d_max = rho + H;
    Length d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(
        2.0 * uvwz.z - 1.0, SCATTERING_TEXTURE_MU_SIZE / 2);
    mu = d == 0.0 * m ? Number(1.0) :
        ClampCosine((H * H - rho * rho - d * d) / (2.0 * r * d));
    ray_r_mu_intersects_ground = false;
  }

  Number x_mu_s =
      GetUnitRangeFromTextureCoord(uvwz.y, SCATTERING_TEXTURE_MU_S_SIZE);
  Length d_min = atmosphere.top_radius - atmosphere.bottom_radius;
  Length d_max = H;
  Length D = DistanceToTopAtmosphereBoundary(
      atmosphere, atmosphere.bottom_radius, atmosphere.mu_s_min);
  Number A = (D - d_min) / (d_max - d_min);
  Number a = (A - x_mu_s * A) / (1.0 + x_mu_s * A);
  Length d = d_min + min(a, A) * (d_max - d_min);
  mu_s = d == 0.0 * m ? Number(1.0) :
     ClampCosine((H * H - d * d) / (2.0 * atmosphere.bottom_radius * d));

  nu = ClampCosine(uvwz.x * 2.0 - 1.0);
}

void GetRMuMuSNuFromScatteringTextureFragCoord(
    const AtmosphereParameters atmosphere, const vec3 frag_coord,
    out Length r, out Number mu, out Number mu_s, out Number nu,
    out bool ray_r_mu_intersects_ground) {
  const vec4 SCATTERING_TEXTURE_SIZE = vec4(
      SCATTERING_TEXTURE_NU_SIZE - 1,
      SCATTERING_TEXTURE_MU_S_SIZE,
      SCATTERING_TEXTURE_MU_SIZE,
      SCATTERING_TEXTURE_R_SIZE);
  Number frag_coord_nu =
      floor(frag_coord.x / Number(SCATTERING_TEXTURE_MU_S_SIZE));
  Number frag_coord_mu_s =
      mod(frag_coord.x, Number(SCATTERING_TEXTURE_MU_S_SIZE));
  vec4 uvwz =
      vec4(frag_coord_nu, frag_coord_mu_s, frag_coord.y, frag_coord.z) /
          SCATTERING_TEXTURE_SIZE;
  GetRMuMuSNuFromScatteringTextureUvwz(
      atmosphere, uvwz, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  // Clamp nu to its valid range of values, given mu and mu_s.
  nu = clamp(nu, mu * mu_s - sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)),
      mu * mu_s + sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)));
}

void ComputeSingleScatteringTexture(const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture, const vec3 frag_coord,
    out IrradianceSpectrum rayleigh, out IrradianceSpectrum mie) {
  Length r;
  Number mu;
  Number mu_s;
  Number nu;
  bool ray_r_mu_intersects_ground;
  GetRMuMuSNuFromScatteringTextureFragCoord(atmosphere, frag_coord,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  ComputeSingleScattering(atmosphere, transmittance_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground, rayleigh, mie);
}

AbstractSpectrum GetScattering(
    const AtmosphereParameters atmosphere,
    const AbstractScatteringTexture scattering_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground) {
  vec4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(
      atmosphere, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  Number tex_coord_x = uvwz.x * Number(SCATTERING_TEXTURE_NU_SIZE - 1);
  Number tex_x = floor(tex_coord_x);
  Number lerp = tex_coord_x - tex_x;
  vec3 uvw0 = vec3((tex_x + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
  vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / Number(SCATTERING_TEXTURE_NU_SIZE),
      uvwz.z, uvwz.w);
  return AbstractSpectrum(texture(scattering_texture, uvw0) * (1.0 - lerp) +
      texture(scattering_texture, uvw1) * lerp);
}

RadianceSpectrum GetScattering(
    const AtmosphereParameters atmosphere,
    const ReducedScatteringTexture single_rayleigh_scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const ScatteringTexture multiple_scattering_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground,
    const int scattering_order) {
  if (scattering_order == 1) {
    IrradianceSpectrum rayleigh = GetScattering(
        atmosphere, single_rayleigh_scattering_texture, r, mu, mu_s, nu,
        ray_r_mu_intersects_ground);
    IrradianceSpectrum mie = GetScattering(
        atmosphere, single_mie_scattering_texture, r, mu, mu_s, nu,
        ray_r_mu_intersects_ground);
    return rayleigh * RayleighPhaseFunction(nu) +
        mie * MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
  } else {
    return GetScattering(
        atmosphere, multiple_scattering_texture, r, mu, mu_s, nu,
        ray_r_mu_intersects_ground);
  }
}

IrradianceSpectrum GetIrradiance(
    const AtmosphereParameters atmosphere,
    const IrradianceTexture irradiance_texture,
    const Length r, const Number mu_s);

RadianceDensitySpectrum ComputeScatteringDensity(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ReducedScatteringTexture single_rayleigh_scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const ScatteringTexture multiple_scattering_texture,
    const IrradianceTexture irradiance_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const int scattering_order) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  assert(nu >= -1.0 && nu <= 1.0);
  assert(scattering_order >= 2);

  // Compute unit direction vectors for the zenith, the view direction omega and
  // and the sun direction omega_s, such that the cosine of the view-zenith
  // angle is mu, the cosine of the sun-zenith angle is mu_s, and the cosine of
  // the view-sun angle is nu. The goal is to simplify computations below.
  vec3 zenith_direction = vec3(0.0, 0.0, 1.0);
  vec3 omega = vec3(sqrt(1.0 - mu * mu), 0.0, mu);
  Number sun_dir_x = omega.x == 0.0 ? 0.0 : (nu - mu * mu_s) / omega.x;
  Number sun_dir_y = sqrt(max(1.0 - sun_dir_x * sun_dir_x - mu_s * mu_s, 0.0));
  vec3 omega_s = vec3(sun_dir_x, sun_dir_y, mu_s);

  const int SAMPLE_COUNT = 16;
  const Angle dphi = pi / Number(SAMPLE_COUNT);
  const Angle dtheta = pi / Number(SAMPLE_COUNT);
  RadianceDensitySpectrum rayleigh_mie =
      RadianceDensitySpectrum(0.0 * watt_per_cubic_meter_per_sr_per_nm);

  // Nested loops for the integral over all the incident directions omega_i.
  for (int l = 0; l < SAMPLE_COUNT; ++l) {
    Angle theta = (Number(l) + 0.5) * dtheta;
    Number cos_theta = cos(theta);
    Number sin_theta = sin(theta);
    bool ray_r_theta_intersects_ground =
        RayIntersectsGround(atmosphere, r, cos_theta);

    // The distance and transmittance to the ground only depend on theta, so we
    // can compute them in the outer loop for efficiency.
    Length distance_to_ground = 0.0 * m;
    DimensionlessSpectrum transmittance_to_ground = DimensionlessSpectrum(0.0);
    DimensionlessSpectrum ground_albedo = DimensionlessSpectrum(0.0);
    if (ray_r_theta_intersects_ground) {
      distance_to_ground =
          DistanceToBottomAtmosphereBoundary(atmosphere, r, cos_theta);
      transmittance_to_ground =
          GetTransmittance(atmosphere, transmittance_texture, r, cos_theta,
              distance_to_ground, true /* ray_intersects_ground */);
      ground_albedo = atmosphere.ground_albedo;
    }

    for (int m = 0; m < 2 * SAMPLE_COUNT; ++m) {
      Angle phi = (Number(m) + 0.5) * dphi;
      vec3 omega_i =
          vec3(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
      SolidAngle domega_i = (dtheta / rad) * (dphi / rad) * sin(theta) * sr;

      // The radiance L_i arriving from direction omega_i after n-1 bounces is
      // the sum of a term given by the precomputed scattering texture for the
      // (n-1)-th order:
      Number nu1 = dot(omega_s, omega_i);
      RadianceSpectrum incident_radiance = GetScattering(atmosphere,
          single_rayleigh_scattering_texture, single_mie_scattering_texture,
          multiple_scattering_texture, r, omega_i.z, mu_s, nu1,
          ray_r_theta_intersects_ground, scattering_order - 1);

      // and of the contribution from the light paths with n-1 bounces and whose
      // last bounce is on the ground. This contribution is the product of the
      // transmittance to the ground, the ground albedo, the ground BRDF, and
      // the irradiance received on the ground after n-2 bounces.
      vec3 ground_normal =
          normalize(zenith_direction * r + omega_i * distance_to_ground);
      IrradianceSpectrum ground_irradiance = GetIrradiance(
          atmosphere, irradiance_texture, atmosphere.bottom_radius,
          dot(ground_normal, omega_s));
      incident_radiance += transmittance_to_ground *
          ground_albedo * (1.0 / (PI * sr)) * ground_irradiance;

      // The radiance finally scattered from direction omega_i towards direction
      // -omega is the product of the incident radiance, the scattering
      // coefficient, and the phase function for directions omega and omega_i
      // (all this summed over all particle types, i.e. Rayleigh and Mie).
      Number nu2 = dot(omega, omega_i);
      Number rayleigh_density = GetProfileDensity(
          atmosphere.rayleigh_density, r - atmosphere.bottom_radius);
      Number mie_density = GetProfileDensity(
          atmosphere.mie_density, r - atmosphere.bottom_radius);
      rayleigh_mie += incident_radiance * (
          atmosphere.rayleigh_scattering * rayleigh_density *
              RayleighPhaseFunction(nu2) +
          atmosphere.mie_scattering * mie_density *
              MiePhaseFunction(atmosphere.mie_phase_function_g, nu2)) *
          domega_i;
    }
  }
  return rayleigh_mie;
}

RadianceSpectrum ComputeMultipleScattering(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ScatteringDensityTexture scattering_density_texture,
    const Length r, const Number mu, const Number mu_s, const Number nu,
    const bool ray_r_mu_intersects_ground) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu >= -1.0 && mu <= 1.0);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  assert(nu >= -1.0 && nu <= 1.0);

  // Number of intervals for the numerical integration.
  const int SAMPLE_COUNT = 50;
  // The integration step, i.e. the length of each integration interval.
  Length dx =
      DistanceToNearestAtmosphereBoundary(
          atmosphere, r, mu, ray_r_mu_intersects_ground) /
              Number(SAMPLE_COUNT);
  // Integration loop.
  RadianceSpectrum rayleigh_mie_sum =
      RadianceSpectrum(0.0 * watt_per_square_meter_per_sr_per_nm);
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    Length d_i = Number(i) * dx;

    // The r, mu and mu_s parameters at the current integration point (see the
    // single scattering section for a detailed explanation).
    Length r_i =
        ClampRadius(atmosphere, sqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r));
    Number mu_i = ClampCosine((r * mu + d_i) / r_i);
    Number mu_s_i = ClampCosine((r * mu_s + d_i * nu) / r_i);

    // The Rayleigh and Mie multiple scattering at the current sample point.
    RadianceSpectrum rayleigh_mie_i =
        GetScattering(
            atmosphere, scattering_density_texture, r_i, mu_i, mu_s_i, nu,
            ray_r_mu_intersects_ground) *
        GetTransmittance(
            atmosphere, transmittance_texture, r, mu, d_i,
            ray_r_mu_intersects_ground) *
        dx;
    // Sample weight (from the trapezoidal rule).
    Number weight_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
    rayleigh_mie_sum += rayleigh_mie_i * weight_i;
  }
  return rayleigh_mie_sum;
}

RadianceDensitySpectrum ComputeScatteringDensityTexture(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ReducedScatteringTexture single_rayleigh_scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const ScatteringTexture multiple_scattering_texture,
    const IrradianceTexture irradiance_texture,
    const vec3 frag_coord, const int scattering_order) {
  Length r;
  Number mu;
  Number mu_s;
  Number nu;
  bool ray_r_mu_intersects_ground;
  GetRMuMuSNuFromScatteringTextureFragCoord(atmosphere, frag_coord,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  return ComputeScatteringDensity(atmosphere, transmittance_texture,
      single_rayleigh_scattering_texture, single_mie_scattering_texture,
      multiple_scattering_texture, irradiance_texture, r, mu, mu_s, nu,
      scattering_order);
}

RadianceSpectrum ComputeMultipleScatteringTexture(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const ScatteringDensityTexture scattering_density_texture,
    const vec3 frag_coord, out Number nu) {
  Length r;
  Number mu;
  Number mu_s;
  bool ray_r_mu_intersects_ground;
  GetRMuMuSNuFromScatteringTextureFragCoord(atmosphere, frag_coord,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  return ComputeMultipleScattering(atmosphere, transmittance_texture,
      scattering_density_texture, r, mu, mu_s, nu,
      ray_r_mu_intersects_ground);
}

IrradianceSpectrum ComputeDirectIrradiance(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const Length r, const Number mu_s) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu_s >= -1.0 && mu_s <= 1.0);

  Number alpha_s = atmosphere.sun_angular_radius / rad;
  // Approximate average of the cosine factor mu_s over the visible fraction of
  // the Sun disc.
  Number average_cosine_factor =
    mu_s < -alpha_s ? 0.0 : (mu_s > alpha_s ? mu_s :
        (mu_s + alpha_s) * (mu_s + alpha_s) / (4.0 * alpha_s));

  return atmosphere.solar_irradiance *
      GetTransmittanceToTopAtmosphereBoundary(
          atmosphere, transmittance_texture, r, mu_s) * average_cosine_factor;

}

IrradianceSpectrum ComputeIndirectIrradiance(
    const AtmosphereParameters atmosphere,
    const ReducedScatteringTexture single_rayleigh_scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const ScatteringTexture multiple_scattering_texture,
    const Length r, const Number mu_s, const int scattering_order) {
  assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
  assert(mu_s >= -1.0 && mu_s <= 1.0);
  assert(scattering_order >= 1);

  const int SAMPLE_COUNT = 32;
  const Angle dphi = pi / Number(SAMPLE_COUNT);
  const Angle dtheta = pi / Number(SAMPLE_COUNT);

  IrradianceSpectrum result =
      IrradianceSpectrum(0.0 * watt_per_square_meter_per_nm);
  vec3 omega_s = vec3(sqrt(1.0 - mu_s * mu_s), 0.0, mu_s);
  for (int j = 0; j < SAMPLE_COUNT / 2; ++j) {
    Angle theta = (Number(j) + 0.5) * dtheta;
    for (int i = 0; i < 2 * SAMPLE_COUNT; ++i) {
      Angle phi = (Number(i) + 0.5) * dphi;
      vec3 omega =
          vec3(cos(phi) * sin(theta), sin(phi) * sin(theta), cos(theta));
      SolidAngle domega = (dtheta / rad) * (dphi / rad) * sin(theta) * sr;

      Number nu = dot(omega, omega_s);
      result += GetScattering(atmosphere, single_rayleigh_scattering_texture,
          single_mie_scattering_texture, multiple_scattering_texture,
          r, omega.z, mu_s, nu, false /* ray_r_theta_intersects_ground */,
          scattering_order) *
              omega.z * domega;
    }
  }
  return result;
}

void GetRMuSFromIrradianceTextureUv(const AtmosphereParameters atmosphere,
    const vec2 uv, out Length r, out Number mu_s) {
  assert(uv.x >= 0.0 && uv.x <= 1.0);
  assert(uv.y >= 0.0 && uv.y <= 1.0);
  Number x_mu_s = GetUnitRangeFromTextureCoord(uv.x, IRRADIANCE_TEXTURE_WIDTH);
  Number x_r = GetUnitRangeFromTextureCoord(uv.y, IRRADIANCE_TEXTURE_HEIGHT);
  r = atmosphere.bottom_radius +
      x_r * (atmosphere.top_radius - atmosphere.bottom_radius);
  mu_s = ClampCosine(2.0 * x_mu_s - 1.0);
}

const vec2 IRRADIANCE_TEXTURE_SIZE =
    vec2(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT);

IrradianceSpectrum ComputeDirectIrradianceTexture(
    const AtmosphereParameters atmosphere,
    const TransmittanceTexture transmittance_texture,
    const vec2 frag_coord) {
  Length r;
  Number mu_s;
  GetRMuSFromIrradianceTextureUv(
      atmosphere, frag_coord / IRRADIANCE_TEXTURE_SIZE, r, mu_s);
  return ComputeDirectIrradiance(atmosphere, transmittance_texture, r, mu_s);
}

IrradianceSpectrum ComputeIndirectIrradianceTexture(
    const AtmosphereParameters atmosphere,
    const ReducedScatteringTexture single_rayleigh_scattering_texture,
    const ReducedScatteringTexture single_mie_scattering_texture,
    const ScatteringTexture multiple_scattering_texture,
    const vec2 frag_coord, const int scattering_order) {
  Length r;
  Number mu_s;
  GetRMuSFromIrradianceTextureUv(
      atmosphere, frag_coord / IRRADIANCE_TEXTURE_SIZE, r, mu_s);
  return ComputeIndirectIrradiance(atmosphere,
      single_rayleigh_scattering_texture, single_mie_scattering_texture,
      multiple_scattering_texture, r, mu_s, scattering_order);
}
`;

// node_modules/@takram/three-atmosphere/build/shared.js
var Fn = /* @__PURE__ */ new p2(0.2126, 0.7152, 0.0722);
var zn = [
  "solarIrradiance",
  "sunAngularRadius",
  "bottomRadius",
  "topRadius",
  "rayleighDensity",
  "rayleighScattering",
  "mieDensity",
  "mieScattering",
  "mieExtinction",
  "miePhaseFunctionG",
  "absorptionDensity",
  "absorptionExtinction",
  "groundAlbedo",
  "muSMin",
  "skyRadianceToLuminance",
  "sunRadianceToLuminance"
];
function kn(n2, e2) {
  if (e2 != null)
    for (const t2 of zn) {
      const r3 = e2[t2];
      r3 != null && (n2[t2] instanceof p2 ? n2[t2].copy(r3) : n2[t2] = r3);
    }
}
var v0 = class {
  constructor(e2, t2, r3, i2, a) {
    this.width = e2, this.expTerm = t2, this.expScale = r3, this.linearTerm = i2, this.constantTerm = a;
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  toUniform() {
    return new d2({
      width: this.width,
      exp_term: this.expTerm,
      exp_scale: this.expScale,
      linear_term: this.linearTerm,
      constant_term: this.constantTerm
    });
  }
};
var ie = class ie2 {
  constructor(e2) {
    this.solarIrradiance = new p2(1.474, 1.8504, 1.91198), this.sunAngularRadius = 4675e-6, this.bottomRadius = 636e4, this.topRadius = 642e4, this.rayleighDensity = [
      new v0(0, 0, 0, 0, 0),
      new v0(0, 1, -0.125, 0, 0)
    ], this.rayleighScattering = new p2(5802e-6, 0.013558, 0.0331), this.mieDensity = [
      new v0(0, 0, 0, 0, 0),
      new v0(0, 1, -0.833333, 0, 0)
    ], this.mieScattering = new p2(3996e-6, 3996e-6, 3996e-6), this.mieExtinction = new p2(444e-5, 444e-5, 444e-5), this.miePhaseFunctionG = 0.8, this.absorptionDensity = [
      new v0(25, 0, 0, 1 / 15, -2 / 3),
      new v0(0, 0, 0, -1 / 15, 8 / 3)
    ], this.absorptionExtinction = new p2(65e-5, 1881e-6, 85e-6), this.groundAlbedo = new ae().setScalar(0.1), this.muSMin = Math.cos(xt(120)), this.sunRadianceToLuminance = new p2(98242.786222, 69954.398112, 66475.012354), this.skyRadianceToLuminance = new p2(114974.916437, 71305.954816, 65310.548555), this.sunRadianceToRelativeLuminance = new p2(), this.skyRadianceToRelativeLuminance = new p2(), kn(this, e2);
    const t2 = Fn.dot(this.sunRadianceToLuminance);
    this.sunRadianceToRelativeLuminance.copy(this.sunRadianceToLuminance).divideScalar(t2), this.skyRadianceToRelativeLuminance.copy(this.skyRadianceToLuminance).divideScalar(t2);
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  toUniform() {
    return new d2({
      solar_irradiance: this.solarIrradiance,
      sun_angular_radius: this.sunAngularRadius,
      bottom_radius: this.bottomRadius * w,
      top_radius: this.topRadius * w,
      rayleigh_density: {
        layers: this.rayleighDensity.map((e2) => e2.toUniform().value)
      },
      rayleigh_scattering: this.rayleighScattering,
      mie_density: {
        layers: this.mieDensity.map((e2) => e2.toUniform().value)
      },
      mie_scattering: this.mieScattering,
      mie_extinction: this.mieExtinction,
      mie_phase_function_g: this.miePhaseFunctionG,
      absorption_density: {
        layers: this.absorptionDensity.map((e2) => e2.toUniform().value)
      },
      absorption_extinction: this.absorptionExtinction,
      ground_albedo: this.groundAlbedo,
      mu_s_min: this.muSMin
    });
  }
};
ie.DEFAULT = /* @__PURE__ */ new ie();
var n0 = ie;
var Vn = `precision highp sampler2DArray;

#include "core/depth"
#include "core/math"
#include "core/packing"
#include "core/transform"
#ifdef HAS_SHADOW
#include "core/raySphereIntersection"
#include "core/cascadedShadowMaps"
#include "core/interleavedGradientNoise"
#include "core/vogelDisk"
#endif // HAS_SHADOW

#include "bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform sampler2D normalBuffer;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 inverseProjectionMatrix;
uniform mat4 inverseViewMatrix;
uniform float bottomRadius;
uniform mat4 worldToECEFMatrix;
uniform float geometricErrorCorrectionAmount;
uniform vec3 sunDirection;
uniform float cosSunAngularRadius;
uniform vec3 moonDirection;
uniform float moonAngularRadius;
uniform float lunarRadianceScale;
uniform float albedoScale;

#include "sky"

#ifdef HAS_LIGHTING_MASK
uniform sampler2D lightingMaskBuffer;
#endif // HAS_LIGHTING_MASK

// prettier-ignore
#define LIGHTING_MASK_CHANNEL_ LIGHTING_MASK_CHANNEL

#ifdef HAS_OVERLAY
uniform sampler2D overlayBuffer;
#endif // HAS_OVERLAY

#ifdef HAS_SHADOW
uniform sampler2DArray shadowBuffer;
uniform vec2 shadowIntervals[SHADOW_CASCADE_COUNT];
uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT];
uniform mat4 inverseShadowMatrices[SHADOW_CASCADE_COUNT];
uniform float shadowFar;
uniform float shadowTopHeight;
uniform float shadowRadius;
uniform sampler3D stbnTexture;
uniform int frame;
#endif // HAS_SHADOW

#ifdef HAS_SHADOW_LENGTH
uniform sampler2D shadowLengthBuffer;
#endif // HAS_SHADOW_LENGTH

varying vec3 vCameraPosition;
varying vec3 vRayDirection;
varying vec3 vGeometryAltitudeCorrection;
varying vec3 vEllipsoidRadiiSquared;

vec3 readNormal(const vec2 uv, out bool degenerate) {
  vec3 normal = texture(normalBuffer, uv).xyz;
  degenerate = normal == vec3(0.0);
  #ifdef OCT_ENCODED_NORMAL
  return unpackVec2ToNormal(normal.xy);
  #else // OCT_ENCODED_NORMAL
  return 2.0 * normal - 1.0;
  #endif // OCT_ENCODED_NORMAL
}

void correctGeometricError(inout vec3 positionECEF, inout vec3 normalECEF) {
  // TODO: The error is pronounced at the edge of the ellipsoid due to the
  // large difference between the sphere position and the unprojected position
  // at the current fragment. Calculating the sphere position from the fragment
  // UV may resolve this.

  // Correct way is slerp, but this will be small-angle interpolation anyways.
  vec3 sphereNormal = normalize(positionECEF / vEllipsoidRadiiSquared);
  vec3 spherePosition = ATMOSPHERE.bottom_radius * sphereNormal;
  normalECEF = mix(normalECEF, sphereNormal, geometricErrorCorrectionAmount);
  positionECEF = mix(positionECEF, spherePosition, geometricErrorCorrectionAmount);
}

#if defined(SUN_LIGHT) || defined(SKY_LIGHT)

vec3 getSunSkyIrradiance(
  const vec3 positionECEF,
  const vec3 normal,
  const vec3 inputColor,
  const float sunTransmittance
) {
  // Assume lambertian BRDF. If both SUN_LIGHT and SKY_LIGHT are not defined,
  // regard the inputColor as radiance at the texel.
  vec3 diffuse = inputColor * albedoScale * RECIPROCAL_PI;
  vec3 skyIrradiance;
  vec3 sunIrradiance = GetSunAndSkyIrradiance(positionECEF, normal, sunDirection, skyIrradiance);

  #ifdef HAS_SHADOW
  sunIrradiance *= sunTransmittance;
  #endif // HAS_SHADOW

  #if defined(SUN_LIGHT) && defined(SKY_LIGHT)
  return diffuse * (sunIrradiance + skyIrradiance);
  #elif defined(SUN_LIGHT)
  return diffuse * sunIrradiance;
  #elif defined(SKY_LIGHT)
  return diffuse * skyIrradiance;
  #endif // defined(SUN_LIGHT) && defined(SKY_LIGHT)
}

#endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)

#if defined(TRANSMITTANCE) || defined(INSCATTER)

void applyTransmittanceInscatter(const vec3 positionECEF, float shadowLength, inout vec3 radiance) {
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(
    vCameraPosition,
    positionECEF,
    shadowLength,
    sunDirection,
    transmittance
  );
  #ifdef TRANSMITTANCE
  radiance = radiance * transmittance;
  #endif // TRANSMITTANCE
  #ifdef INSCATTER
  radiance = radiance + inscatter;
  #endif // INSCATTER
}

#endif // defined(TRANSMITTANCE) || defined(INSCATTER)

#ifdef HAS_SHADOW

float getSTBN() {
  ivec3 size = textureSize(stbnTexture, 0);
  vec3 scale = 1.0 / vec3(size);
  return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;
}

vec2 getShadowUv(const vec3 worldPosition, const int cascadeIndex) {
  vec4 clip = shadowMatrices[cascadeIndex] * vec4(worldPosition, 1.0);
  clip /= clip.w;
  return clip.xy * 0.5 + 0.5;
}

float getDistanceToShadowTop(const vec3 positionECEF) {
  // Distance to the top of the shadows along the sun direction, which matches
  // the ray origin of BSM.
  return raySphereSecondIntersection(
    positionECEF / METER_TO_LENGTH_UNIT, // TODO: Make units consistent
    sunDirection,
    vec3(0.0),
    bottomRadius + shadowTopHeight
  );
}

float readShadowOpticalDepth(const vec2 uv, const float distanceToTop, const int cascadeIndex) {
  // r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));
  // Omit adding maxOpticalDepthTail to avoid pronounced aliasing. Ground
  // shadow will be attenuated by inscatter anyways.
  return min(shadow.b, shadow.g * max(0.0, distanceToTop - shadow.r));
}

float sampleShadowOpticalDepthPCF(
  const vec3 worldPosition,
  const float distanceToTop,
  const float radius,
  const int cascadeIndex
) {
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }

  vec2 texelSize = vec2(1.0) / vec2(textureSize(shadowBuffer, 0).xy);
  float sum = 0.0;
  vec2 offset;
  #pragma unroll_loop_start
  for (int i = 0; i < 16; ++i) {
    #if UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
    offset = vogelDisk(
      UNROLLED_LOOP_INDEX,
      SHADOW_SAMPLE_COUNT,
      interleavedGradientNoise(gl_FragCoord.xy) * PI2
    );
    sum += readShadowOpticalDepth(uv + offset * radius * texelSize, distanceToTop, cascadeIndex);
    #endif // UNROLLED_LOOP_INDEX < SHADOW_SAMPLE_COUNT
  }
  #pragma unroll_loop_end
  return sum / float(SHADOW_SAMPLE_COUNT);
}

float sampleShadowOpticalDepth(
  const vec3 worldPosition,
  const vec3 positionECEF,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(positionECEF);
  if (distanceToTop <= 0.0) {
    return 0.0;
  }
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(worldPosition, distanceToTop, radius, cascadeIndex)
    : 0.0;
}

float getShadowRadius(const vec3 worldPosition) {
  vec4 clip = shadowMatrices[0] * vec4(worldPosition, 1.0);
  clip /= clip.w;

  // Offset by 1px in each direction in shadow's clip coordinates.
  vec2 shadowSize = vec2(textureSize(shadowBuffer, 0));
  vec3 offset = vec3(2.0 / shadowSize, 0.0);
  vec4 clipX = clip + offset.xzzz;
  vec4 clipY = clip + offset.zyzz;

  // Convert back to world space.
  vec4 worldX = inverseShadowMatrices[0] * clipX;
  vec4 worldY = inverseShadowMatrices[0] * clipY;

  // Project into the main camera's clip space.
  mat4 viewProjectionMatrix = projectionMatrix * viewMatrix;
  vec4 projected = viewProjectionMatrix * vec4(worldPosition, 1.0);
  vec4 projectedX = viewProjectionMatrix * worldX;
  vec4 projectedY = viewProjectionMatrix * worldY;
  projected /= projected.w;
  projectedX /= projectedX.w;
  projectedY /= projectedY.w;

  // Take the mean of pixel sizes.
  vec2 center = (projected.xy * 0.5 + 0.5) * resolution;
  vec2 offsetX = (projectedX.xy * 0.5 + 0.5) * resolution;
  vec2 offsetY = (projectedY.xy * 0.5 + 0.5) * resolution;
  float size = max(length(offsetX - center), length(offsetY - center));

  return remapClamped(size, 10.0, 50.0, 0.0, shadowRadius);
}

#endif // HAS_SHADOW

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  #if defined(HAS_LIGHTING_MASK) && defined(DEBUG_SHOW_LIGHTING_MASK)
  outputColor.rgb = vec3(texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_);
  outputColor.a = 1.0;
  return;
  #endif // defined(HAS_LIGHTING_MASK) && defined(DEBUG_SHOW_LIGHTING_MASK)

  float shadowLength = 0.0;
  #ifdef HAS_SHADOW_LENGTH
  shadowLength = texture(shadowLengthBuffer, uv).r;
  #endif // HAS_SHADOW_LENGTH

  #ifdef HAS_OVERLAY
  vec4 overlay = texture(overlayBuffer, uv);
  if (overlay.a == 1.0) {
    outputColor = overlay;
    return;
  }
  #endif // HAS_OVERLAY

  vec3 rayDirection = normalize(vRayDirection);
  vec3 dRDdx = dFdx(rayDirection);
  vec3 dRDdy = dFdy(rayDirection);
  float fragmentAngle = length(dRDdx + dRDdy) / length(rayDirection);

  float depth = readDepthValue(depthBuffer, uv);
  if (depth >= 1.0 - 1e-8) {
    #ifdef SKY
    outputColor.rgb = getSkyRadiance(
      vCameraPosition,
      rayDirection,
      shadowLength,
      sunDirection,
      moonDirection,
      moonAngularRadius,
      lunarRadianceScale,
      fragmentAngle
    );
    outputColor.a = 1.0;
    #else // SKY
    outputColor = inputColor;
    #endif // SKY

    #ifdef HAS_OVERLAY
    outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;
    #endif // HAS_OVERLAY
    return;
  }
  depth = reverseLogDepth(depth, cameraNear, cameraFar);

  // Reconstruct position and normal in world space.
  vec3 viewPosition = screenToView(
    uv,
    depth,
    getViewZ(depth),
    projectionMatrix,
    inverseProjectionMatrix
  );
  vec3 worldPosition = (inverseViewMatrix * vec4(viewPosition, 1.0)).xyz;
  vec3 positionECEF = (worldToECEFMatrix * vec4(worldPosition, 1.0)).xyz;
  positionECEF = positionECEF * METER_TO_LENGTH_UNIT + vGeometryAltitudeCorrection;

  vec3 viewNormal;
  bool degenerateNormal = false;
  #ifdef RECONSTRUCT_NORMAL
  vec3 dVPdx = dFdx(viewPosition);
  vec3 dVPdy = dFdy(viewPosition);
  viewNormal = normalize(cross(dVPdx, dVPdy));
  #elif defined(HAS_NORMALS)
  viewNormal = readNormal(uv, degenerateNormal);
  #endif // defined(HAS_NORMALS)

  #if defined(RECONSTRUCT_NORMAL) || defined(HAS_NORMALS)
  vec3 worldNormal = (inverseViewMatrix * vec4(viewNormal, 0.0)).xyz;
  vec3 normalECEF = (worldToECEFMatrix * vec4(worldNormal, 0.0)).xyz;
  #else // defined(RECONSTRUCT_NORMAL) || defined(HAS_NORMALS)
  vec3 normalECEF = normalize(positionECEF);
  #endif // defined(RECONSTRUCT_NORMAL) || defined(HAS_NORMALS)

  #ifdef CORRECT_GEOMETRIC_ERROR
  correctGeometricError(positionECEF, normalECEF);
  #endif // CORRECT_GEOMETRIC_ERROR

  #ifdef HAS_SHADOW
  float stbn = getSTBN();
  float radius = getShadowRadius(worldPosition);
  float opticalDepth = sampleShadowOpticalDepth(worldPosition, positionECEF, radius, stbn);
  float sunTransmittance = exp(-opticalDepth);
  #else // HAS_SHADOW
  float sunTransmittance = 1.0;
  #endif // HAS_SHADOW

  vec3 radiance;
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)
  // WORKAROUND: When both post-process lighting and sky options are enabled,
  // stars have degenerate normals. We use this to disable irradiance, which is
  // irrelevant for them.
  if (!degenerateNormal) {
    radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);
  } else {
    radiance = inputColor.rgb;
  }
  #ifdef HAS_LIGHTING_MASK
  float lightingMask = texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_;
  radiance = mix(inputColor.rgb, radiance, lightingMask);
  #endif // HAS_LIGHTING_MASK
  #else // defined(SUN_LIGHT) || defined(SKY_LIGHT)
  radiance = inputColor.rgb;
  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)

  #if defined(TRANSMITTANCE) || defined(INSCATTER)
  applyTransmittanceInscatter(positionECEF, shadowLength, radiance);
  #endif // defined(TRANSMITTANCE) || defined(INSCATTER)

  outputColor = vec4(radiance, inputColor.a);

  #ifdef HAS_OVERLAY
  outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;
  #endif // HAS_OVERLAY
}
`;
var Bn = `uniform mat4 inverseViewMatrix;
uniform mat4 inverseProjectionMatrix;
uniform vec3 cameraPosition;
uniform mat4 worldToECEFMatrix;
uniform vec3 altitudeCorrection;
uniform float geometricErrorCorrectionAmount;
uniform vec3 ellipsoidRadii;

varying vec3 vCameraPosition;
varying vec3 vRayDirection;
varying vec3 vGeometryAltitudeCorrection;
varying vec3 vEllipsoidRadiiSquared;

void getCameraRay(out vec3 origin, out vec3 direction) {
  bool isPerspective = inverseProjectionMatrix[2][3] != 0.0; // 4th entry in the 3rd column

  if (isPerspective) {
    // Calculate the camera ray for a perspective camera.
    vec4 viewPosition = inverseProjectionMatrix * vec4(position, 1.0);
    vec4 worldDirection = inverseViewMatrix * vec4(viewPosition.xyz, 0.0);
    origin = cameraPosition;
    direction = worldDirection.xyz;
  } else {
    // Unprojected points to calculate direction.
    vec4 nearPoint = inverseProjectionMatrix * vec4(position.xy, -1.0, 1.0);
    vec4 farPoint = inverseProjectionMatrix * vec4(position.xy, -0.9, 1.0);
    nearPoint /= nearPoint.w;
    farPoint /= farPoint.w;

    // Calculate world values.
    vec4 worldDirection = inverseViewMatrix * vec4(farPoint.xyz - nearPoint.xyz, 0.0);
    vec4 worldOrigin = inverseViewMatrix * nearPoint;

    // Outputs
    direction = worldDirection.xyz;
    origin = worldOrigin.xyz;
  }
}

void mainSupport() {
  vec3 direction, origin;
  getCameraRay(origin, direction);

  vec3 cameraPositionECEF = (worldToECEFMatrix * vec4(origin, 1.0)).xyz;
  vCameraPosition = (cameraPositionECEF + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vRayDirection = (worldToECEFMatrix * vec4(direction, 0.0)).xyz;

  vGeometryAltitudeCorrection = altitudeCorrection * METER_TO_LENGTH_UNIT;
  // Gradually turn off the altitude correction on geometries as the geometric
  // error correction takes effect, because that on the ideal sphere will be
  // over corrected.
  // See: https://github.com/takram-design-engineering/three-geospatial/pull/23#issuecomment-2542914656
  #ifdef CORRECT_GEOMETRIC_ERROR
  vGeometryAltitudeCorrection *= 1.0 - geometricErrorCorrectionAmount;
  #endif // CORRECT_GEOMETRIC_ERROR

  vec3 radii = ellipsoidRadii * METER_TO_LENGTH_UNIT;
  vEllipsoidRadiiSquared = radii * radii;
}
`;
var Ct = `vec3 getLunarRadiance(const float moonAngularRadius) {
  // Not a physical number but the order of 10^-6 relative to the sun may fit.
  vec3 radiance =
    ATMOSPHERE.solar_irradiance *
    0.000002 /
    (PI * moonAngularRadius * moonAngularRadius) *
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
  return radiance;
}

float intersectSphere(const vec3 ray, const vec3 point, const float radius) {
  vec3 P = -point;
  float PoR = dot(P, ray);
  float D = dot(P, P) - radius * radius;
  return -PoR - sqrt(PoR * PoR - D);
}

float orenNayarDiffuse(const vec3 L, const vec3 V, const vec3 N) {
  float NoL = dot(N, L);
  float NoV = dot(N, V);
  float s = dot(L, V) - NoL * NoV;
  float t = mix(1.0, max(NoL, NoV), step(0.0, s));
  return max(0.0, NoL) * (0.62406015 + 0.41284404 * s / t);
}

vec3 getSkyRadiance(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const float shadowLength,
  const vec3 sunDirection,
  const vec3 moonDirection,
  const float moonAngularRadius,
  const float lunarRadianceScale,
  const float fragmentAngle
) {
  vec3 transmittance;
  vec3 radiance = GetSkyRadiance(
    cameraPosition,
    rayDirection,
    shadowLength,
    sunDirection,
    transmittance
  );

  // Rendering celestial objects without perspective doesn't make sense.
  #ifdef PERSPECTIVE_CAMERA

  #ifdef SUN
  float viewDotSun = dot(rayDirection, sunDirection);
  if (viewDotSun > cosSunAngularRadius) {
    float angle = acos(clamp(viewDotSun, -1.0, 1.0));
    float antialias = smoothstep(
      ATMOSPHERE.sun_angular_radius,
      ATMOSPHERE.sun_angular_radius - fragmentAngle,
      angle
    );
    radiance += transmittance * GetSolarRadiance() * antialias;
  }
  #endif // SUN

  #ifdef MOON
  float intersection = intersectSphere(rayDirection, moonDirection, moonAngularRadius);
  if (intersection > 0.0) {
    vec3 normal = normalize(moonDirection - rayDirection * intersection);
    float diffuse = orenNayarDiffuse(-sunDirection, rayDirection, normal);
    float viewDotMoon = dot(rayDirection, moonDirection);
    float angle = acos(clamp(viewDotMoon, -1.0, 1.0));
    float antialias = smoothstep(moonAngularRadius, moonAngularRadius - fragmentAngle, angle);
    radiance +=
      transmittance *
      getLunarRadiance(moonAngularRadius) *
      lunarRadianceScale *
      diffuse *
      antialias;
  }
  #endif // MOON

  #endif // PERSPECTIVE_CAMERA

  return radiance;
}
`;
var Wn = Object.defineProperty;
var L = (n2, e2, t2, r3) => {
  for (var i2 = void 0, a = n2.length - 1, o; a >= 0; a--)
    (o = n2[a]) && (i2 = o(e2, t2, i2) || i2);
  return i2 && Wn(e2, t2, i2), i2;
};
var jn = /* @__PURE__ */ new p2();
var Xn = /* @__PURE__ */ new p2();
var Yn = /* @__PURE__ */ new Dn();
var Kn = {
  blendFunction: Jt.NORMAL,
  octEncodedNormal: false,
  reconstructNormal: false,
  ellipsoid: F0.WGS84,
  correctAltitude: true,
  correctGeometricError: true,
  sunLight: false,
  skyLight: false,
  transmittance: true,
  inscatter: true,
  albedoScale: 1,
  sky: false,
  sun: true,
  moon: true,
  moonAngularRadius: 45e-4,
  // ≈ 15.5 arcminutes
  lunarRadianceScale: 1,
  ground: true
};
var H2 = class extends Qt {
  constructor(e2 = new St(), t2, r3 = n0.DEFAULT) {
    const {
      blendFunction: i2,
      normalBuffer: a = null,
      octEncodedNormal: o,
      reconstructNormal: c2,
      irradianceTexture: s = null,
      scatteringTexture: l2 = null,
      transmittanceTexture: h2 = null,
      singleMieScatteringTexture: m = null,
      higherOrderScatteringTexture: f2 = null,
      ellipsoid: v,
      correctAltitude: T2,
      correctGeometricError: E2,
      sunDirection: x,
      sunLight: y,
      skyLight: I2,
      transmittance: N2,
      inscatter: b,
      albedoScale: U2,
      sky: z,
      sun: F,
      moon: q,
      moonDirection: Z,
      moonAngularRadius: i0,
      lunarRadianceScale: a0,
      ground: J
    } = { ...Kn, ...t2 };
    super(
      "AerialPerspectiveEffect",
      Cn(
        W(Vn, {
          core: {
            depth: yt,
            packing: Un,
            math: bn,
            transform: Hn,
            raySphereIntersection: wt,
            cascadedShadowMaps: Ln,
            interleavedGradientNoise: On,
            vogelDisk: Nn
          },
          bruneton: {
            common: e,
            definitions: t,
            runtime: n
          },
          sky: Ct
        })
      ),
      {
        blendFunction: i2,
        vertexShader: Bn,
        attributes: en.DEPTH,
        // prettier-ignore
        uniforms: new Map(
          Object.entries({
            normalBuffer: new d2(a),
            projectionMatrix: new d2(new D2()),
            viewMatrix: new d2(new D2()),
            inverseProjectionMatrix: new d2(new D2()),
            inverseViewMatrix: new d2(new D2()),
            cameraPosition: new d2(new p2()),
            bottomRadius: new d2(r3.bottomRadius),
            ellipsoidRadii: new d2(new p2()),
            worldToECEFMatrix: new d2(new D2()),
            altitudeCorrection: new d2(new p2()),
            geometricErrorCorrectionAmount: new d2(0),
            sunDirection: new d2(x?.clone() ?? new p2()),
            cosSunAngularRadius: new d2(r3.sunAngularRadius),
            albedoScale: new d2(U2),
            moonDirection: new d2(Z?.clone() ?? new p2()),
            moonAngularRadius: new d2(i0),
            lunarRadianceScale: new d2(a0),
            // Composition and shadow
            overlayBuffer: new d2(null),
            shadowBuffer: new d2(null),
            shadowMapSize: new d2(new oe()),
            shadowIntervals: new d2([]),
            shadowMatrices: new d2([]),
            inverseShadowMatrices: new d2([]),
            shadowFar: new d2(0),
            shadowTopHeight: new d2(0),
            shadowRadius: new d2(3),
            stbnTexture: new d2(null),
            frame: new d2(0),
            shadowLengthBuffer: new d2(null),
            // Lighting mask
            lightingMaskBuffer: new d2(null),
            // Uniforms for atmosphere functions
            ATMOSPHERE: r3.toUniform(),
            SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: new d2(r3.sunRadianceToRelativeLuminance),
            SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: new d2(r3.skyRadianceToRelativeLuminance),
            irradiance_texture: new d2(s),
            scattering_texture: new d2(l2),
            transmittance_texture: new d2(h2),
            single_mie_scattering_texture: new d2(null),
            higher_order_scattering_texture: new d2(null)
          })
        ),
        // prettier-ignore
        defines: /* @__PURE__ */ new Map([
          ["TRANSMITTANCE_TEXTURE_WIDTH", C.toFixed(0)],
          ["TRANSMITTANCE_TEXTURE_HEIGHT", p.toFixed(0)],
          ["SCATTERING_TEXTURE_R_SIZE", i.toFixed(0)],
          ["SCATTERING_TEXTURE_MU_SIZE", _.toFixed(0)],
          ["SCATTERING_TEXTURE_MU_S_SIZE", R.toFixed(0)],
          ["SCATTERING_TEXTURE_NU_SIZE", u.toFixed(0)],
          ["IRRADIANCE_TEXTURE_WIDTH", f.toFixed(0)],
          ["IRRADIANCE_TEXTURE_HEIGHT", A.toFixed(0)],
          ["METER_TO_LENGTH_UNIT", w.toFixed(7)]
        ])
      }
    ), this.camera = e2, this.atmosphere = r3, this.overlay = null, this.shadow = null, this.shadowLength = null, this.lightingMask = null, this.hasNormals = false, this.combinedScatteringTextures = false, this.hasHigherOrderScatteringTexture = false, this.shadowSampleCount = 8, this.octEncodedNormal = o, this.reconstructNormal = c2, this.singleMieScatteringTexture = m, this.higherOrderScatteringTexture = f2, this.ellipsoid = v, this.correctAltitude = T2, this.correctGeometricError = E2, this.sunLight = y, this.skyLight = I2, this.transmittance = N2, this.inscatter = b, this.sky = z, this.sun = F, this.moon = q, this.ground = J;
  }
  get mainCamera() {
    return this.camera;
  }
  set mainCamera(e2) {
    this.camera = e2;
  }
  copyCameraSettings(e2) {
    const {
      projectionMatrix: t2,
      matrixWorldInverse: r3,
      projectionMatrixInverse: i2,
      matrixWorld: a
    } = e2, o = this.uniforms;
    o.get("projectionMatrix").value.copy(t2), o.get("viewMatrix").value.copy(r3), o.get("inverseProjectionMatrix").value.copy(i2), o.get("inverseViewMatrix").value.copy(a);
    const c2 = e2.getWorldPosition(
      o.get("cameraPosition").value
    ), s = o.get("worldToECEFMatrix").value, l2 = jn.copy(c2).applyMatrix4(s);
    try {
      const m = Yn.setFromECEF(l2).height, f2 = Xn.set(0, this.ellipsoid.maximumRadius, -Math.max(0, m)).applyMatrix4(t2);
      o.get("geometricErrorCorrectionAmount").value = In(
        Pn(f2.y, 41.5, 13.8, 0, 1)
      );
    } catch {
      return;
    }
    const h2 = o.get("altitudeCorrection");
    this.correctAltitude ? X(
      l2,
      this.atmosphere.bottomRadius,
      this.ellipsoid,
      h2.value
    ) : h2.value.setScalar(0);
  }
  updateOverlay() {
    let e2 = false;
    const { uniforms: t2, defines: r3, overlay: i2 } = this, a = r3.has("HAS_OVERLAY"), o = i2 != null;
    return o !== a && (o ? r3.set("HAS_OVERLAY", "1") : (r3.delete("HAS_OVERLAY"), t2.get("overlayBuffer").value = null), e2 = true), o && (t2.get("overlayBuffer").value = i2.map), e2;
  }
  updateShadow() {
    let e2 = false;
    const { uniforms: t2, defines: r3, shadow: i2 } = this, a = r3.has("HAS_SHADOW"), o = i2 != null;
    if (o !== a && (o ? r3.set("HAS_SHADOW", "1") : (r3.delete("HAS_SHADOW"), t2.get("shadowBuffer").value = null), e2 = true), o) {
      const c2 = r3.get("SHADOW_CASCADE_COUNT"), s = `${i2.cascadeCount}`;
      c2 !== s && (r3.set("SHADOW_CASCADE_COUNT", i2.cascadeCount.toFixed(0)), e2 = true), t2.get("shadowBuffer").value = i2.map, t2.get("shadowMapSize").value = i2.mapSize, t2.get("shadowIntervals").value = i2.intervals, t2.get("shadowMatrices").value = i2.matrices, t2.get("inverseShadowMatrices").value = i2.inverseMatrices, t2.get("shadowFar").value = i2.far, t2.get("shadowTopHeight").value = i2.topHeight;
    }
    return e2;
  }
  updateShadowLength() {
    let e2 = false;
    const { uniforms: t2, defines: r3, shadowLength: i2 } = this, a = r3.has("HAS_SHADOW_LENGTH"), o = i2 != null;
    return o !== a && (o ? r3.set("HAS_SHADOW_LENGTH", "1") : (r3.delete("HAS_SHADOW_LENGTH"), t2.get("shadowLengthBuffer").value = null), e2 = true), o && (t2.get("shadowLengthBuffer").value = i2.map), e2;
  }
  updateLightingMask() {
    let e2 = false;
    const { uniforms: t2, defines: r3, lightingMask: i2 } = this, a = r3.has("HAS_LIGHTING_MASK"), o = i2 != null;
    if (o !== a && (o ? r3.set("HAS_LIGHTING_MASK", "1") : (r3.delete("HAS_LIGHTING_MASK"), t2.get("lightingMaskBuffer").value = null), e2 = true), o) {
      t2.get("lightingMaskBuffer").value = i2.map;
      const c2 = r3.get("LIGHTING_MASK_CHANNEL"), s = i2.channel;
      s !== c2 && (/^[rgba]$/.test(s) ? (r3.set("LIGHTING_MASK_CHANNEL", s), e2 = true) : console.error(`Expression validation failed: ${s}`));
    }
    return e2;
  }
  update(e2, t2, r3) {
    this.copyCameraSettings(this.camera);
    let i2 = false;
    i2 ||= this.updateOverlay(), i2 ||= this.updateShadow(), i2 ||= this.updateShadowLength(), i2 ||= this.updateLightingMask(), i2 && this.setChanged(), ++this.uniforms.get("frame").value;
  }
  get normalBuffer() {
    return this.uniforms.get("normalBuffer").value;
  }
  set normalBuffer(e2) {
    this.uniforms.get("normalBuffer").value = e2, this.hasNormals = e2 != null;
  }
  get irradianceTexture() {
    return this.uniforms.get("irradiance_texture").value;
  }
  set irradianceTexture(e2) {
    this.uniforms.get("irradiance_texture").value = e2;
  }
  get scatteringTexture() {
    return this.uniforms.get("scattering_texture").value;
  }
  set scatteringTexture(e2) {
    this.uniforms.get("scattering_texture").value = e2;
  }
  get transmittanceTexture() {
    return this.uniforms.get("transmittance_texture").value;
  }
  set transmittanceTexture(e2) {
    this.uniforms.get("transmittance_texture").value = e2;
  }
  get singleMieScatteringTexture() {
    return this.uniforms.get("single_mie_scattering_texture").value;
  }
  set singleMieScatteringTexture(e2) {
    this.uniforms.get("single_mie_scattering_texture").value = e2, this.combinedScatteringTextures = e2 == null;
  }
  get higherOrderScatteringTexture() {
    return this.uniforms.get("higher_order_scattering_texture").value;
  }
  set higherOrderScatteringTexture(e2) {
    this.uniforms.get("higher_order_scattering_texture").value = e2, this.hasHigherOrderScatteringTexture = e2 != null;
  }
  get ellipsoid() {
    return this._ellipsoid;
  }
  set ellipsoid(e2) {
    this._ellipsoid = e2, this.uniforms.get("ellipsoidRadii").value.copy(e2.radii);
  }
  get worldToECEFMatrix() {
    return this.uniforms.get("worldToECEFMatrix").value;
  }
  get sunDirection() {
    return this.uniforms.get("sunDirection").value;
  }
  get sunAngularRadius() {
    return this.uniforms.get("ATMOSPHERE").value.sun_angular_radius;
  }
  set sunAngularRadius(e2) {
    this.uniforms.get("ATMOSPHERE").value.sun_angular_radius = e2, this.uniforms.get("cosSunAngularRadius").value = Math.cos(e2);
  }
  get albedoScale() {
    return this.uniforms.get("albedoScale").value;
  }
  set albedoScale(e2) {
    this.uniforms.get("albedoScale").value = e2;
  }
  get moonDirection() {
    return this.uniforms.get("moonDirection").value;
  }
  get moonAngularRadius() {
    return this.uniforms.get("moonAngularRadius").value;
  }
  set moonAngularRadius(e2) {
    this.uniforms.get("moonAngularRadius").value = e2;
  }
  get lunarRadianceScale() {
    return this.uniforms.get("lunarRadianceScale").value;
  }
  set lunarRadianceScale(e2) {
    this.uniforms.get("lunarRadianceScale").value = e2;
  }
  get stbnTexture() {
    return this.uniforms.get("stbnTexture").value;
  }
  set stbnTexture(e2) {
    this.uniforms.get("stbnTexture").value = e2;
  }
  get shadowRadius() {
    return this.uniforms.get("shadowRadius").value;
  }
  set shadowRadius(e2) {
    this.uniforms.get("shadowRadius").value = e2;
  }
};
L([
  w2("OCT_ENCODED_NORMAL")
], H2.prototype, "octEncodedNormal");
L([
  w2("RECONSTRUCT_NORMAL")
], H2.prototype, "reconstructNormal");
L([
  w2("HAS_NORMALS")
], H2.prototype, "hasNormals");
L([
  w2("COMBINED_SCATTERING_TEXTURES")
], H2.prototype, "combinedScatteringTextures");
L([
  w2("HAS_HIGHER_ORDER_SCATTERING_TEXTURE")
], H2.prototype, "hasHigherOrderScatteringTexture");
L([
  w2("CORRECT_GEOMETRIC_ERROR")
], H2.prototype, "correctGeometricError");
L([
  w2("SUN_LIGHT")
], H2.prototype, "sunLight");
L([
  w2("SKY_LIGHT")
], H2.prototype, "skyLight");
L([
  w2("TRANSMITTANCE")
], H2.prototype, "transmittance");
L([
  w2("INSCATTER")
], H2.prototype, "inscatter");
L([
  w2("SKY")
], H2.prototype, "sky");
L([
  w2("SUN")
], H2.prototype, "sun");
L([
  w2("MOON")
], H2.prototype, "moon");
L([
  w2("GROUND")
], H2.prototype, "ground");
L([
  yn("SHADOW_SAMPLE_COUNT", { min: 1, max: 16 })
], H2.prototype, "shadowSampleCount");
var $n = Object.defineProperty;
var Dt = (n2, e2, t2, r3) => {
  for (var i2 = void 0, a = n2.length - 1, o; a >= 0; a--)
    (o = n2[a]) && (i2 = o(e2, t2, i2) || i2);
  return i2 && $n(e2, t2, i2), i2;
};
var qn = /* @__PURE__ */ new p2();
function Zn(n2, e2) {
  let t2 = "", r3 = "";
  for (let i2 = 1; i2 < e2; ++i2)
    t2 += `layout(location = ${i2}) out float renderTarget${i2};
`, r3 += `renderTarget${i2} = 0.0;
`;
  return n2.replace("#include <mrt_layout>", t2).replace("#include <mrt_output>", r3);
}
var Be = {
  ellipsoid: F0.WGS84,
  correctAltitude: true,
  renderTargetCount: 1
};
var se = class extends vt {
  constructor(e2, t2 = n0.DEFAULT) {
    const {
      irradianceTexture: r3 = null,
      scatteringTexture: i2 = null,
      transmittanceTexture: a = null,
      singleMieScatteringTexture: o = null,
      higherOrderScatteringTexture: c2 = null,
      ellipsoid: s,
      correctAltitude: l2,
      sunDirection: h2,
      sunAngularRadius: m,
      renderTargetCount: f2,
      ...v
    } = { ...Be, ...e2 };
    super({
      toneMapped: false,
      depthWrite: false,
      depthTest: false,
      ...v,
      // prettier-ignore
      uniforms: {
        cameraPosition: new d2(new p2()),
        worldToECEFMatrix: new d2(new D2()),
        altitudeCorrection: new d2(new p2()),
        sunDirection: new d2(h2?.clone() ?? new p2()),
        cosSunAngularRadius: new d2(t2.sunAngularRadius),
        // Uniforms for atmosphere functions
        ATMOSPHERE: t2.toUniform(),
        SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: new d2(t2.sunRadianceToRelativeLuminance),
        SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: new d2(t2.skyRadianceToRelativeLuminance),
        irradiance_texture: new d2(r3),
        scattering_texture: new d2(i2),
        transmittance_texture: new d2(a),
        single_mie_scattering_texture: new d2(null),
        higher_order_scattering_texture: new d2(null),
        ...v.uniforms
      },
      defines: {
        PI: `${Math.PI}`,
        TRANSMITTANCE_TEXTURE_WIDTH: C.toFixed(0),
        TRANSMITTANCE_TEXTURE_HEIGHT: p.toFixed(0),
        SCATTERING_TEXTURE_R_SIZE: i.toFixed(0),
        SCATTERING_TEXTURE_MU_SIZE: _.toFixed(0),
        SCATTERING_TEXTURE_MU_S_SIZE: R.toFixed(0),
        SCATTERING_TEXTURE_NU_SIZE: u.toFixed(0),
        IRRADIANCE_TEXTURE_WIDTH: f.toFixed(0),
        IRRADIANCE_TEXTURE_HEIGHT: A.toFixed(0),
        METER_TO_LENGTH_UNIT: w.toFixed(7),
        ...v.defines
      }
    }), this.atmosphere = t2, this.combinedScatteringTextures = false, this.hasHigherOrderScatteringTexture = false, this.singleMieScatteringTexture = o, this.higherOrderScatteringTexture = c2, this.ellipsoid = s, this.correctAltitude = l2, m != null && (this.sunAngularRadius = m), this.renderTargetCount = f2;
  }
  copyCameraSettings(e2) {
    const t2 = this.uniforms, r3 = e2.getWorldPosition(
      t2.cameraPosition.value
    ), i2 = qn.copy(r3).applyMatrix4(t2.worldToECEFMatrix.value), a = t2.altitudeCorrection.value;
    this.correctAltitude ? X(
      i2,
      this.atmosphere.bottomRadius,
      this.ellipsoid,
      a
    ) : a.setScalar(0);
  }
  onBeforeCompile(e2, t2) {
    e2.fragmentShader = Zn(
      e2.fragmentShader,
      this.renderTargetCount
    );
  }
  onBeforeRender(e2, t2, r3, i2, a, o) {
    this.copyCameraSettings(r3);
  }
  get irradianceTexture() {
    return this.uniforms.irradiance_texture.value;
  }
  set irradianceTexture(e2) {
    this.uniforms.irradiance_texture.value = e2;
  }
  get scatteringTexture() {
    return this.uniforms.scattering_texture.value;
  }
  set scatteringTexture(e2) {
    this.uniforms.scattering_texture.value = e2;
  }
  get transmittanceTexture() {
    return this.uniforms.transmittance_texture.value;
  }
  set transmittanceTexture(e2) {
    this.uniforms.transmittance_texture.value = e2;
  }
  get singleMieScatteringTexture() {
    return this.uniforms.single_mie_scattering_texture.value;
  }
  set singleMieScatteringTexture(e2) {
    this.uniforms.single_mie_scattering_texture.value = e2, this.combinedScatteringTextures = e2 == null;
  }
  get higherOrderScatteringTexture() {
    return this.uniforms.higher_order_scattering_texture.value;
  }
  set higherOrderScatteringTexture(e2) {
    this.uniforms.higher_order_scattering_texture.value = e2, this.hasHigherOrderScatteringTexture = e2 != null;
  }
  get worldToECEFMatrix() {
    return this.uniforms.worldToECEFMatrix.value;
  }
  get sunDirection() {
    return this.uniforms.sunDirection.value;
  }
  get sunAngularRadius() {
    return this.uniforms.ATMOSPHERE.value.sun_angular_radius;
  }
  set sunAngularRadius(e2) {
    this.uniforms.ATMOSPHERE.value.sun_angular_radius = e2, this.uniforms.cosSunAngularRadius.value = Math.cos(e2);
  }
  /** @package */
  get renderTargetCount() {
    return this._renderTargetCount;
  }
  /** @package */
  set renderTargetCount(e2) {
    e2 !== this.renderTargetCount && (this._renderTargetCount = e2, this.needsUpdate = true);
  }
};
Dt([
  w2("COMBINED_SCATTERING_TEXTURES")
], se.prototype, "combinedScatteringTextures");
Dt([
  w2("HAS_HIGHER_ORDER_SCATTERING_TEXTURE")
], se.prototype, "hasHigherOrderScatteringTexture");
var Jn = 173.1446326846693;
var It = 14959787069098932e-8;
var g2 = 0.017453292519943295;
var at = 57.29577951308232;
var Qn = 365.24217;
var ot = /* @__PURE__ */ new Date("2000-01-01T12:00:00Z");
var X2 = 2 * Math.PI;
var e0 = 3600 * (180 / Math.PI);
var x0 = 484813681109536e-20;
var er = 10800 * 60;
var tr = 2 * er;
var nr = 6378.1366;
var rr = nr / It;
var ir = 81.30056;
var We = 2959122082855911e-19;
var xe = 2825345909524226e-22;
var Me = 8459715185680659e-23;
var Ae = 1292024916781969e-23;
var we = 1524358900784276e-23;
function l0(n2) {
  if (!Number.isFinite(n2))
    throw console.trace(), `Value is not a finite number: ${n2}`;
  return n2;
}
function E0(n2) {
  return n2 - Math.floor(n2);
}
var S2;
(function(n2) {
  n2.Sun = "Sun", n2.Moon = "Moon", n2.Mercury = "Mercury", n2.Venus = "Venus", n2.Earth = "Earth", n2.Mars = "Mars", n2.Jupiter = "Jupiter", n2.Saturn = "Saturn", n2.Uranus = "Uranus", n2.Neptune = "Neptune", n2.Pluto = "Pluto", n2.SSB = "SSB", n2.EMB = "EMB", n2.Star1 = "Star1", n2.Star2 = "Star2", n2.Star3 = "Star3", n2.Star4 = "Star4", n2.Star5 = "Star5", n2.Star6 = "Star6", n2.Star7 = "Star7", n2.Star8 = "Star8";
})(S2 || (S2 = {}));
var ar = [
  S2.Star1,
  S2.Star2,
  S2.Star3,
  S2.Star4,
  S2.Star5,
  S2.Star6,
  S2.Star7,
  S2.Star8
];
var or = [
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 },
  { ra: 0, dec: 0, dist: 0 }
];
function sr(n2) {
  const e2 = ar.indexOf(n2);
  return e2 >= 0 ? or[e2] : null;
}
function Pt(n2) {
  const e2 = sr(n2);
  return e2 && e2.dist > 0 ? e2 : null;
}
var V;
(function(n2) {
  n2[n2.From2000 = 0] = "From2000", n2[n2.Into2000 = 1] = "Into2000";
})(V || (V = {}));
var M0 = {
  Mercury: [
    [
      [
        [4.40250710144, 0, 0],
        [0.40989414977, 1.48302034195, 26087.9031415742],
        [0.050462942, 4.47785489551, 52175.8062831484],
        [0.00855346844, 1.16520322459, 78263.70942472259],
        [0.00165590362, 4.11969163423, 104351.61256629678],
        [34561897e-11, 0.77930768443, 130439.51570787099],
        [7583476e-11, 3.71348404924, 156527.41884944518]
      ],
      [
        [26087.90313685529, 0, 0],
        [0.01131199811, 6.21874197797, 26087.9031415742],
        [0.00292242298, 3.04449355541, 52175.8062831484],
        [75775081e-11, 6.08568821653, 78263.70942472259],
        [19676525e-11, 2.80965111777, 104351.61256629678]
      ]
    ],
    [
      [
        [0.11737528961, 1.98357498767, 26087.9031415742],
        [0.02388076996, 5.03738959686, 52175.8062831484],
        [0.01222839532, 3.14159265359, 0],
        [0.0054325181, 1.79644363964, 78263.70942472259],
        [0.0012977877, 4.83232503958, 104351.61256629678],
        [31866927e-11, 1.58088495658, 130439.51570787099],
        [7963301e-11, 4.60972126127, 156527.41884944518]
      ],
      [
        [0.00274646065, 3.95008450011, 26087.9031415742],
        [99737713e-11, 3.14159265359, 0]
      ]
    ],
    [
      [
        [0.39528271651, 0, 0],
        [0.07834131818, 6.19233722598, 26087.9031415742],
        [0.00795525558, 2.95989690104, 52175.8062831484],
        [0.00121281764, 6.01064153797, 78263.70942472259],
        [21921969e-11, 2.77820093972, 104351.61256629678],
        [4354065e-11, 5.82894543774, 130439.51570787099]
      ],
      [
        [0.0021734774, 4.65617158665, 26087.9031415742],
        [44141826e-11, 1.42385544001, 52175.8062831484]
      ]
    ]
  ],
  Venus: [
    [
      [
        [3.17614666774, 0, 0],
        [0.01353968419, 5.59313319619, 10213.285546211],
        [89891645e-11, 5.30650047764, 20426.571092422],
        [5477194e-11, 4.41630661466, 7860.4193924392],
        [3455741e-11, 2.6996444782, 11790.6290886588],
        [2372061e-11, 2.99377542079, 3930.2096962196],
        [1317168e-11, 5.18668228402, 26.2983197998],
        [1664146e-11, 4.25018630147, 1577.3435424478],
        [1438387e-11, 4.15745084182, 9683.5945811164],
        [1200521e-11, 6.15357116043, 30639.856638633]
      ],
      [
        [10213.28554621638, 0, 0],
        [95617813e-11, 2.4640651111, 10213.285546211],
        [7787201e-11, 0.6247848222, 20426.571092422]
      ]
    ],
    [
      [
        [0.05923638472, 0.26702775812, 10213.285546211],
        [40107978e-11, 1.14737178112, 20426.571092422],
        [32814918e-11, 3.14159265359, 0]
      ],
      [
        [0.00287821243, 1.88964962838, 10213.285546211]
      ]
    ],
    [
      [
        [0.72334820891, 0, 0],
        [0.00489824182, 4.02151831717, 10213.285546211],
        [1658058e-11, 4.90206728031, 20426.571092422],
        [1378043e-11, 1.12846591367, 11790.6290886588],
        [1632096e-11, 2.84548795207, 7860.4193924392],
        [498395e-11, 2.58682193892, 9683.5945811164],
        [221985e-11, 2.01346696541, 19367.1891622328],
        [237454e-11, 2.55136053886, 15720.8387848784]
      ],
      [
        [34551041e-11, 0.89198706276, 10213.285546211]
      ]
    ]
  ],
  Earth: [
    [
      [
        [1.75347045673, 0, 0],
        [0.03341656453, 4.66925680415, 6283.0758499914],
        [34894275e-11, 4.62610242189, 12566.1516999828],
        [3417572e-11, 2.82886579754, 3.523118349],
        [3497056e-11, 2.74411783405, 5753.3848848968],
        [3135899e-11, 3.62767041756, 77713.7714681205],
        [2676218e-11, 4.41808345438, 7860.4193924392],
        [2342691e-11, 6.13516214446, 3930.2096962196],
        [1273165e-11, 2.03709657878, 529.6909650946],
        [1324294e-11, 0.74246341673, 11506.7697697936],
        [901854e-11, 2.04505446477, 26.2983197998],
        [1199167e-11, 1.10962946234, 1577.3435424478],
        [857223e-11, 3.50849152283, 398.1490034082],
        [779786e-11, 1.17882681962, 5223.6939198022],
        [99025e-10, 5.23268072088, 5884.9268465832],
        [753141e-11, 2.53339052847, 5507.5532386674],
        [505267e-11, 4.58292599973, 18849.2275499742],
        [492392e-11, 4.20505711826, 775.522611324],
        [356672e-11, 2.91954114478, 0.0673103028],
        [284125e-11, 1.89869240932, 796.2980068164],
        [242879e-11, 0.34481445893, 5486.777843175],
        [317087e-11, 5.84901948512, 11790.6290886588],
        [271112e-11, 0.31486255375, 10977.078804699],
        [206217e-11, 4.80646631478, 2544.3144198834],
        [205478e-11, 1.86953770281, 5573.1428014331],
        [202318e-11, 2.45767790232, 6069.7767545534],
        [126225e-11, 1.08295459501, 20.7753954924],
        [155516e-11, 0.83306084617, 213.299095438]
      ],
      [
        [6283.0758499914, 0, 0],
        [0.00206058863, 2.67823455808, 6283.0758499914],
        [4303419e-11, 2.63512233481, 12566.1516999828]
      ],
      [
        [8721859e-11, 1.07253635559, 6283.0758499914]
      ]
    ],
    [
      [],
      [
        [0.00227777722, 3.4137662053, 6283.0758499914],
        [3805678e-11, 3.37063423795, 12566.1516999828]
      ]
    ],
    [
      [
        [1.00013988784, 0, 0],
        [0.01670699632, 3.09846350258, 6283.0758499914],
        [13956024e-11, 3.05524609456, 12566.1516999828],
        [308372e-10, 5.19846674381, 77713.7714681205],
        [1628463e-11, 1.17387558054, 5753.3848848968],
        [1575572e-11, 2.84685214877, 7860.4193924392],
        [924799e-11, 5.45292236722, 11506.7697697936],
        [542439e-11, 4.56409151453, 3930.2096962196],
        [47211e-10, 3.66100022149, 5884.9268465832],
        [85831e-11, 1.27079125277, 161000.6857376741],
        [57056e-11, 2.01374292245, 83996.84731811189],
        [55736e-11, 5.2415979917, 71430.69561812909],
        [174844e-11, 3.01193636733, 18849.2275499742],
        [243181e-11, 4.2734953079, 11790.6290886588]
      ],
      [
        [0.00103018607, 1.10748968172, 6283.0758499914],
        [1721238e-11, 1.06442300386, 12566.1516999828]
      ],
      [
        [4359385e-11, 5.78455133808, 6283.0758499914]
      ]
    ]
  ],
  Mars: [
    [
      [
        [6.20347711581, 0, 0],
        [0.18656368093, 5.0503710027, 3340.6124266998],
        [0.01108216816, 5.40099836344, 6681.2248533996],
        [91798406e-11, 5.75478744667, 10021.8372800994],
        [27744987e-11, 5.97049513147, 3.523118349],
        [10610235e-11, 2.93958560338, 2281.2304965106],
        [12315897e-11, 0.84956094002, 2810.9214616052],
        [8926784e-11, 4.15697846427, 0.0172536522],
        [8715691e-11, 6.11005153139, 13362.4497067992],
        [6797556e-11, 0.36462229657, 398.1490034082],
        [7774872e-11, 3.33968761376, 5621.8429232104],
        [3575078e-11, 1.6618650571, 2544.3144198834],
        [4161108e-11, 0.22814971327, 2942.4634232916],
        [3075252e-11, 0.85696614132, 191.4482661116],
        [2628117e-11, 0.64806124465, 3337.0893083508],
        [2937546e-11, 6.07893711402, 0.0673103028],
        [2389414e-11, 5.03896442664, 796.2980068164],
        [2579844e-11, 0.02996736156, 3344.1355450488],
        [1528141e-11, 1.14979301996, 6151.533888305],
        [1798806e-11, 0.65634057445, 529.6909650946],
        [1264357e-11, 3.62275122593, 5092.1519581158],
        [1286228e-11, 3.06796065034, 2146.1654164752],
        [1546404e-11, 2.91579701718, 1751.539531416],
        [1024902e-11, 3.69334099279, 8962.4553499102],
        [891566e-11, 0.18293837498, 16703.062133499],
        [858759e-11, 2.4009381194, 2914.0142358238],
        [832715e-11, 2.46418619474, 3340.5951730476],
        [83272e-10, 4.49495782139, 3340.629680352],
        [712902e-11, 3.66335473479, 1059.3819301892],
        [748723e-11, 3.82248614017, 155.4203994342],
        [723861e-11, 0.67497311481, 3738.761430108],
        [635548e-11, 2.92182225127, 8432.7643848156],
        [655162e-11, 0.48864064125, 3127.3133312618],
        [550474e-11, 3.81001042328, 0.9803210682],
        [55275e-10, 4.47479317037, 1748.016413067],
        [425966e-11, 0.55364317304, 6283.0758499914],
        [415131e-11, 0.49662285038, 213.299095438],
        [472167e-11, 3.62547124025, 1194.4470102246],
        [306551e-11, 0.38052848348, 6684.7479717486],
        [312141e-11, 0.99853944405, 6677.7017350506],
        [293198e-11, 4.22131299634, 20.7753954924],
        [302375e-11, 4.48618007156, 3532.0606928114],
        [274027e-11, 0.54222167059, 3340.545116397],
        [281079e-11, 5.88163521788, 1349.8674096588],
        [231183e-11, 1.28242156993, 3870.3033917944],
        [283602e-11, 5.7688543494, 3149.1641605882],
        [236117e-11, 5.75503217933, 3333.498879699],
        [274033e-11, 0.13372524985, 3340.6797370026],
        [299395e-11, 2.78323740866, 6254.6266625236]
      ],
      [
        [3340.61242700512, 0, 0],
        [0.01457554523, 3.60433733236, 3340.6124266998],
        [0.00168414711, 3.92318567804, 6681.2248533996],
        [20622975e-11, 4.26108844583, 10021.8372800994],
        [3452392e-11, 4.7321039319, 3.523118349],
        [2586332e-11, 4.60670058555, 13362.4497067992],
        [841535e-11, 4.45864030426, 2281.2304965106]
      ],
      [
        [58152577e-11, 2.04961712429, 3340.6124266998],
        [13459579e-11, 2.45738706163, 6681.2248533996]
      ]
    ],
    [
      [
        [0.03197134986, 3.76832042431, 3340.6124266998],
        [0.00298033234, 4.10616996305, 6681.2248533996],
        [0.00289104742, 0, 0],
        [31365539e-11, 4.4465105309, 10021.8372800994],
        [34841e-9, 4.7881254926, 13362.4497067992]
      ],
      [
        [0.00217310991, 6.04472194776, 3340.6124266998],
        [20976948e-11, 3.14159265359, 0],
        [12834709e-11, 1.60810667915, 6681.2248533996]
      ]
    ],
    [
      [
        [1.53033488271, 0, 0],
        [0.1418495316, 3.47971283528, 3340.6124266998],
        [0.00660776362, 3.81783443019, 6681.2248533996],
        [46179117e-11, 4.15595316782, 10021.8372800994],
        [8109733e-11, 5.55958416318, 2810.9214616052],
        [7485318e-11, 1.77239078402, 5621.8429232104],
        [5523191e-11, 1.3643630377, 2281.2304965106],
        [382516e-10, 4.49407183687, 13362.4497067992],
        [2306537e-11, 0.09081579001, 2544.3144198834],
        [1999396e-11, 5.36059617709, 3337.0893083508],
        [2484394e-11, 4.9254563992, 2942.4634232916],
        [1960195e-11, 4.74249437639, 3344.1355450488],
        [1167119e-11, 2.11260868341, 5092.1519581158],
        [1102816e-11, 5.00908403998, 398.1490034082],
        [899066e-11, 4.40791133207, 529.6909650946],
        [992252e-11, 5.83861961952, 6151.533888305],
        [807354e-11, 2.10217065501, 1059.3819301892],
        [797915e-11, 3.44839203899, 796.2980068164],
        [740975e-11, 1.49906336885, 2146.1654164752]
      ],
      [
        [0.01107433345, 2.03250524857, 3340.6124266998],
        [0.00103175887, 2.37071847807, 6681.2248533996],
        [128772e-9, 0, 0],
        [1081588e-10, 2.70888095665, 10021.8372800994]
      ],
      [
        [44242249e-11, 0.47930604954, 3340.6124266998],
        [8138042e-11, 0.86998389204, 6681.2248533996]
      ]
    ]
  ],
  Jupiter: [
    [
      [
        [0.59954691494, 0, 0],
        [0.09695898719, 5.06191793158, 529.6909650946],
        [0.00573610142, 1.44406205629, 7.1135470008],
        [0.00306389205, 5.41734730184, 1059.3819301892],
        [97178296e-11, 4.14264726552, 632.7837393132],
        [72903078e-11, 3.64042916389, 522.5774180938],
        [64263975e-11, 3.41145165351, 103.0927742186],
        [39806064e-11, 2.29376740788, 419.4846438752],
        [38857767e-11, 1.27231755835, 316.3918696566],
        [27964629e-11, 1.7845459182, 536.8045120954],
        [1358973e-10, 5.7748104079, 1589.0728952838],
        [8246349e-11, 3.5822792584, 206.1855484372],
        [8768704e-11, 3.63000308199, 949.1756089698],
        [7368042e-11, 5.0810119427, 735.8765135318],
        [626315e-10, 0.02497628807, 213.299095438],
        [6114062e-11, 4.51319998626, 1162.4747044078],
        [4905396e-11, 1.32084470588, 110.2063212194],
        [5305285e-11, 1.30671216791, 14.2270940016],
        [5305441e-11, 4.18625634012, 1052.2683831884],
        [4647248e-11, 4.69958103684, 3.9321532631],
        [3045023e-11, 4.31676431084, 426.598190876],
        [2609999e-11, 1.56667394063, 846.0828347512],
        [2028191e-11, 1.06376530715, 3.1813937377],
        [1764763e-11, 2.14148655117, 1066.49547719],
        [1722972e-11, 3.88036268267, 1265.5674786264],
        [1920945e-11, 0.97168196472, 639.897286314],
        [1633223e-11, 3.58201833555, 515.463871093],
        [1431999e-11, 4.29685556046, 625.6701923124],
        [973272e-11, 4.09764549134, 95.9792272178]
      ],
      [
        [529.69096508814, 0, 0],
        [0.00489503243, 4.2208293947, 529.6909650946],
        [0.00228917222, 6.02646855621, 7.1135470008],
        [30099479e-11, 4.54540782858, 1059.3819301892],
        [2072092e-10, 5.45943156902, 522.5774180938],
        [12103653e-11, 0.16994816098, 536.8045120954],
        [6067987e-11, 4.42422292017, 103.0927742186],
        [5433968e-11, 3.98480737746, 419.4846438752],
        [4237744e-11, 5.89008707199, 14.2270940016]
      ],
      [
        [47233601e-11, 4.32148536482, 7.1135470008],
        [30649436e-11, 2.929777887, 529.6909650946],
        [14837605e-11, 3.14159265359, 0]
      ]
    ],
    [
      [
        [0.02268615702, 3.55852606721, 529.6909650946],
        [0.00109971634, 3.90809347197, 1059.3819301892],
        [0.00110090358, 0, 0],
        [8101428e-11, 3.60509572885, 522.5774180938],
        [6043996e-11, 4.25883108339, 1589.0728952838],
        [6437782e-11, 0.30627119215, 536.8045120954]
      ],
      [
        [78203446e-11, 1.52377859742, 529.6909650946]
      ]
    ],
    [
      [
        [5.20887429326, 0, 0],
        [0.25209327119, 3.49108639871, 529.6909650946],
        [0.00610599976, 3.84115365948, 1059.3819301892],
        [0.00282029458, 2.57419881293, 632.7837393132],
        [0.00187647346, 2.07590383214, 522.5774180938],
        [86792905e-11, 0.71001145545, 419.4846438752],
        [72062974e-11, 0.21465724607, 536.8045120954],
        [65517248e-11, 5.9799588479, 316.3918696566],
        [29134542e-11, 1.67759379655, 103.0927742186],
        [30135335e-11, 2.16132003734, 949.1756089698],
        [23453271e-11, 3.54023522184, 735.8765135318],
        [22283743e-11, 4.19362594399, 1589.0728952838],
        [23947298e-11, 0.2745803748, 7.1135470008],
        [13032614e-11, 2.96042965363, 1162.4747044078],
        [970336e-10, 1.90669633585, 206.1855484372],
        [12749023e-11, 2.71550286592, 1052.2683831884],
        [7057931e-11, 2.18184839926, 1265.5674786264],
        [6137703e-11, 6.26418240033, 846.0828347512],
        [2616976e-11, 2.00994012876, 1581.959348283]
      ],
      [
        [0.0127180152, 2.64937512894, 529.6909650946],
        [61661816e-11, 3.00076460387, 1059.3819301892],
        [53443713e-11, 3.89717383175, 522.5774180938],
        [31185171e-11, 4.88276958012, 536.8045120954],
        [41390269e-11, 0, 0]
      ]
    ]
  ],
  Saturn: [
    [
      [
        [0.87401354025, 0, 0],
        [0.11107659762, 3.96205090159, 213.299095438],
        [0.01414150957, 4.58581516874, 7.1135470008],
        [0.00398379389, 0.52112032699, 206.1855484372],
        [0.00350769243, 3.30329907896, 426.598190876],
        [0.00206816305, 0.24658372002, 103.0927742186],
        [792713e-9, 3.84007056878, 220.4126424388],
        [23990355e-11, 4.66976924553, 110.2063212194],
        [16573588e-11, 0.43719228296, 419.4846438752],
        [14906995e-11, 5.76903183869, 316.3918696566],
        [1582029e-10, 0.93809155235, 632.7837393132],
        [14609559e-11, 1.56518472, 3.9321532631],
        [13160301e-11, 4.44891291899, 14.2270940016],
        [15053543e-11, 2.71669915667, 639.897286314],
        [13005299e-11, 5.98119023644, 11.0457002639],
        [10725067e-11, 3.12939523827, 202.2533951741],
        [5863206e-11, 0.23656938524, 529.6909650946],
        [5227757e-11, 4.20783365759, 3.1813937377],
        [6126317e-11, 1.76328667907, 277.0349937414],
        [5019687e-11, 3.17787728405, 433.7117378768],
        [459255e-10, 0.61977744975, 199.0720014364],
        [4005867e-11, 2.24479718502, 63.7358983034],
        [2953796e-11, 0.98280366998, 95.9792272178],
        [387367e-10, 3.22283226966, 138.5174968707],
        [2461186e-11, 2.03163875071, 735.8765135318],
        [3269484e-11, 0.77492638211, 949.1756089698],
        [1758145e-11, 3.2658010994, 522.5774180938],
        [1640172e-11, 5.5050445305, 846.0828347512],
        [1391327e-11, 4.02333150505, 323.5054166574],
        [1580648e-11, 4.37265307169, 309.2783226558],
        [1123498e-11, 2.83726798446, 415.5524906121],
        [1017275e-11, 3.71700135395, 227.5261894396],
        [848642e-11, 3.1915017083, 209.3669421749]
      ],
      [
        [213.2990952169, 0, 0],
        [0.01297370862, 1.82834923978, 213.299095438],
        [0.00564345393, 2.88499717272, 7.1135470008],
        [93734369e-11, 1.06311793502, 426.598190876],
        [0.00107674962, 2.27769131009, 206.1855484372],
        [40244455e-11, 2.04108104671, 220.4126424388],
        [19941774e-11, 1.2795439047, 103.0927742186],
        [10511678e-11, 2.7488034213, 14.2270940016],
        [6416106e-11, 0.38238295041, 639.897286314],
        [4848994e-11, 2.43037610229, 419.4846438752],
        [4056892e-11, 2.92133209468, 110.2063212194],
        [3768635e-11, 3.6496533078, 3.9321532631]
      ],
      [
        [0.0011644133, 1.17988132879, 7.1135470008],
        [91841837e-11, 0.0732519584, 213.299095438],
        [36661728e-11, 0, 0],
        [15274496e-11, 4.06493179167, 206.1855484372]
      ]
    ],
    [
      [
        [0.04330678039, 3.60284428399, 213.299095438],
        [0.00240348302, 2.85238489373, 426.598190876],
        [84745939e-11, 0, 0],
        [30863357e-11, 3.48441504555, 220.4126424388],
        [34116062e-11, 0.57297307557, 206.1855484372],
        [1473407e-10, 2.11846596715, 639.897286314],
        [9916667e-11, 5.79003188904, 419.4846438752],
        [6993564e-11, 4.7360468972, 7.1135470008],
        [4807588e-11, 5.43305312061, 316.3918696566]
      ],
      [
        [0.00198927992, 4.93901017903, 213.299095438],
        [36947916e-11, 3.14159265359, 0],
        [17966989e-11, 0.5197943111, 426.598190876]
      ]
    ],
    [
      [
        [9.55758135486, 0, 0],
        [0.52921382865, 2.39226219573, 213.299095438],
        [0.01873679867, 5.2354960466, 206.1855484372],
        [0.01464663929, 1.64763042902, 426.598190876],
        [0.00821891141, 5.93520042303, 316.3918696566],
        [0.00547506923, 5.0153261898, 103.0927742186],
        [0.0037168465, 2.27114821115, 220.4126424388],
        [0.00361778765, 3.13904301847, 7.1135470008],
        [0.00140617506, 5.70406606781, 632.7837393132],
        [0.00108974848, 3.29313390175, 110.2063212194],
        [69006962e-11, 5.94099540992, 419.4846438752],
        [61053367e-11, 0.94037691801, 639.897286314],
        [48913294e-11, 1.55733638681, 202.2533951741],
        [34143772e-11, 0.19519102597, 277.0349937414],
        [32401773e-11, 5.47084567016, 949.1756089698],
        [20936596e-11, 0.46349251129, 735.8765135318],
        [9796004e-11, 5.20477537945, 1265.5674786264],
        [11993338e-11, 5.98050967385, 846.0828347512],
        [208393e-9, 1.52102476129, 433.7117378768],
        [15298404e-11, 3.0594381494, 529.6909650946],
        [6465823e-11, 0.17732249942, 1052.2683831884],
        [11380257e-11, 1.7310542704, 522.5774180938],
        [3419618e-11, 4.94550542171, 1581.959348283]
      ],
      [
        [0.0618298134, 0.2584351148, 213.299095438],
        [0.00506577242, 0.71114625261, 206.1855484372],
        [0.00341394029, 5.79635741658, 426.598190876],
        [0.00188491195, 0.47215589652, 220.4126424388],
        [0.00186261486, 3.14159265359, 0],
        [0.00143891146, 1.40744822888, 7.1135470008]
      ],
      [
        [0.00436902572, 4.78671677509, 213.299095438]
      ]
    ]
  ],
  Uranus: [
    [
      [
        [5.48129294297, 0, 0],
        [0.09260408234, 0.89106421507, 74.7815985673],
        [0.01504247898, 3.6271926092, 1.4844727083],
        [0.00365981674, 1.89962179044, 73.297125859],
        [0.00272328168, 3.35823706307, 149.5631971346],
        [70328461e-11, 5.39254450063, 63.7358983034],
        [68892678e-11, 6.09292483287, 76.2660712756],
        [61998615e-11, 2.26952066061, 2.9689454166],
        [61950719e-11, 2.85098872691, 11.0457002639],
        [2646877e-10, 3.14152083966, 71.8126531507],
        [25710476e-11, 6.11379840493, 454.9093665273],
        [2107885e-10, 4.36059339067, 148.0787244263],
        [17818647e-11, 1.74436930289, 36.6485629295],
        [14613507e-11, 4.73732166022, 3.9321532631],
        [11162509e-11, 5.8268179635, 224.3447957019],
        [1099791e-10, 0.48865004018, 138.5174968707],
        [9527478e-11, 2.95516862826, 35.1640902212],
        [7545601e-11, 5.236265824, 109.9456887885],
        [4220241e-11, 3.23328220918, 70.8494453042],
        [40519e-9, 2.277550173, 151.0476698429],
        [3354596e-11, 1.0654900738, 4.4534181249],
        [2926718e-11, 4.62903718891, 9.5612275556],
        [349034e-10, 5.48306144511, 146.594251718],
        [3144069e-11, 4.75199570434, 77.7505439839],
        [2922333e-11, 5.35235361027, 85.8272988312],
        [2272788e-11, 4.36600400036, 70.3281804424],
        [2051219e-11, 1.51773566586, 0.1118745846],
        [2148602e-11, 0.60745949945, 38.1330356378],
        [1991643e-11, 4.92437588682, 277.0349937414],
        [1376226e-11, 2.04283539351, 65.2203710117],
        [1666902e-11, 3.62744066769, 380.12776796],
        [1284107e-11, 3.11347961505, 202.2533951741],
        [1150429e-11, 0.93343589092, 3.1813937377],
        [1533221e-11, 2.58594681212, 52.6901980395],
        [1281604e-11, 0.54271272721, 222.8603229936],
        [1372139e-11, 4.19641530878, 111.4301614968],
        [1221029e-11, 0.1990065003, 108.4612160802],
        [946181e-11, 1.19253165736, 127.4717966068],
        [1150989e-11, 4.17898916639, 33.6796175129]
      ],
      [
        [74.7815986091, 0, 0],
        [0.00154332863, 5.24158770553, 74.7815985673],
        [24456474e-11, 1.71260334156, 1.4844727083],
        [9258442e-11, 0.4282973235, 11.0457002639],
        [8265977e-11, 1.50218091379, 63.7358983034],
        [915016e-10, 1.41213765216, 149.5631971346]
      ]
    ],
    [
      [
        [0.01346277648, 2.61877810547, 74.7815985673],
        [623414e-9, 5.08111189648, 149.5631971346],
        [61601196e-11, 3.14159265359, 0],
        [9963722e-11, 1.61603805646, 76.2660712756],
        [992616e-10, 0.57630380333, 73.297125859]
      ],
      [
        [34101978e-11, 0.01321929936, 74.7815985673]
      ]
    ],
    [
      [
        [19.21264847206, 0, 0],
        [0.88784984413, 5.60377527014, 74.7815985673],
        [0.03440836062, 0.32836099706, 73.297125859],
        [0.0205565386, 1.7829515933, 149.5631971346],
        [0.0064932241, 4.52247285911, 76.2660712756],
        [0.00602247865, 3.86003823674, 63.7358983034],
        [0.00496404167, 1.40139935333, 454.9093665273],
        [0.00338525369, 1.58002770318, 138.5174968707],
        [0.00243509114, 1.57086606044, 71.8126531507],
        [0.00190522303, 1.99809394714, 1.4844727083],
        [0.00161858838, 2.79137786799, 148.0787244263],
        [0.00143706183, 1.38368544947, 11.0457002639],
        [93192405e-11, 0.17437220467, 36.6485629295],
        [71424548e-11, 4.24509236074, 224.3447957019],
        [89806014e-11, 3.66105364565, 109.9456887885],
        [39009723e-11, 1.66971401684, 70.8494453042],
        [46677296e-11, 1.39976401694, 35.1640902212],
        [39025624e-11, 3.36234773834, 277.0349937414],
        [36755274e-11, 3.88649278513, 146.594251718],
        [30348723e-11, 0.70100838798, 151.0476698429],
        [29156413e-11, 3.180563367, 77.7505439839],
        [22637073e-11, 0.72518687029, 529.6909650946],
        [11959076e-11, 1.7504339214, 984.6003316219],
        [25620756e-11, 5.25656086672, 380.12776796]
      ],
      [
        [0.01479896629, 3.67205697578, 74.7815985673]
      ]
    ]
  ],
  Neptune: [
    [
      [
        [5.31188633046, 0, 0],
        [0.0179847553, 2.9010127389, 38.1330356378],
        [0.01019727652, 0.48580922867, 1.4844727083],
        [0.00124531845, 4.83008090676, 36.6485629295],
        [42064466e-11, 5.41054993053, 2.9689454166],
        [37714584e-11, 6.09221808686, 35.1640902212],
        [33784738e-11, 1.24488874087, 76.2660712756],
        [16482741e-11, 7727998e-11, 491.5579294568],
        [9198584e-11, 4.93747051954, 39.6175083461],
        [899425e-10, 0.27462171806, 175.1660598002]
      ],
      [
        [38.13303563957, 0, 0],
        [16604172e-11, 4.86323329249, 1.4844727083],
        [15744045e-11, 2.27887427527, 38.1330356378]
      ]
    ],
    [
      [
        [0.03088622933, 1.44104372644, 38.1330356378],
        [27780087e-11, 5.91271884599, 76.2660712756],
        [27623609e-11, 0, 0],
        [15355489e-11, 2.52123799551, 36.6485629295],
        [15448133e-11, 3.50877079215, 39.6175083461]
      ]
    ],
    [
      [
        [30.07013205828, 0, 0],
        [0.27062259632, 1.32999459377, 38.1330356378],
        [0.01691764014, 3.25186135653, 36.6485629295],
        [0.00807830553, 5.18592878704, 1.4844727083],
        [0.0053776051, 4.52113935896, 35.1640902212],
        [0.00495725141, 1.5710564165, 491.5579294568],
        [0.00274571975, 1.84552258866, 175.1660598002],
        [1201232e-10, 1.92059384991, 1021.2488945514],
        [0.00121801746, 5.79754470298, 76.2660712756],
        [0.00100896068, 0.3770272493, 73.297125859],
        [0.00135134092, 3.37220609835, 39.6175083461],
        [7571796e-11, 1.07149207335, 388.4651552382]
      ]
    ]
  ]
};
function cr(n2) {
  var e2, t2, r3, i2, a, o, c2;
  const s = 2e3 + (n2 - 14) / Qn;
  return s < -500 ? (e2 = (s - 1820) / 100, -20 + 32 * e2 * e2) : s < 500 ? (e2 = s / 100, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, a = t2 * r3, o = r3 * r3, 10583.6 - 1014.41 * e2 + 33.78311 * t2 - 5.952053 * r3 - 0.1798452 * i2 + 0.022174192 * a + 0.0090316521 * o) : s < 1600 ? (e2 = (s - 1e3) / 100, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, a = t2 * r3, o = r3 * r3, 1574.2 - 556.01 * e2 + 71.23472 * t2 + 0.319781 * r3 - 0.8503463 * i2 - 5050998e-9 * a + 0.0083572073 * o) : s < 1700 ? (e2 = s - 1600, t2 = e2 * e2, r3 = e2 * t2, 120 - 0.9808 * e2 - 0.01532 * t2 + r3 / 7129) : s < 1800 ? (e2 = s - 1700, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, 8.83 + 0.1603 * e2 - 59285e-7 * t2 + 13336e-8 * r3 - i2 / 1174e3) : s < 1860 ? (e2 = s - 1800, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, a = t2 * r3, o = r3 * r3, c2 = r3 * i2, 13.72 - 0.332447 * e2 + 68612e-7 * t2 + 41116e-7 * r3 - 37436e-8 * i2 + 121272e-10 * a - 1699e-10 * o + 875e-12 * c2) : s < 1900 ? (e2 = s - 1860, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, a = t2 * r3, 7.62 + 0.5737 * e2 - 0.251754 * t2 + 0.01680668 * r3 - 4473624e-10 * i2 + a / 233174) : s < 1920 ? (e2 = s - 1900, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, -2.79 + 1.494119 * e2 - 0.0598939 * t2 + 61966e-7 * r3 - 197e-6 * i2) : s < 1941 ? (e2 = s - 1920, t2 = e2 * e2, r3 = e2 * t2, 21.2 + 0.84493 * e2 - 0.0761 * t2 + 20936e-7 * r3) : s < 1961 ? (e2 = s - 1950, t2 = e2 * e2, r3 = e2 * t2, 29.07 + 0.407 * e2 - t2 / 233 + r3 / 2547) : s < 1986 ? (e2 = s - 1975, t2 = e2 * e2, r3 = e2 * t2, 45.45 + 1.067 * e2 - t2 / 260 - r3 / 718) : s < 2005 ? (e2 = s - 2e3, t2 = e2 * e2, r3 = e2 * t2, i2 = t2 * t2, a = t2 * r3, 63.86 + 0.3345 * e2 - 0.060374 * t2 + 17275e-7 * r3 + 651814e-9 * i2 + 2373599e-11 * a) : s < 2050 ? (e2 = s - 2e3, 62.92 + 0.32217 * e2 + 5589e-6 * e2 * e2) : s < 2150 ? (e2 = (s - 1820) / 100, -20 + 32 * e2 * e2 - 0.5628 * (2150 - s)) : (e2 = (s - 1820) / 100, -20 + 32 * e2 * e2);
}
var ur = cr;
function st(n2) {
  return n2 + ur(n2) / 86400;
}
var t0 = class _t0 {
  /**
   * @param {FlexibleDateTime} date
   *      A JavaScript Date object, a numeric UTC value expressed in J2000 days, or another AstroTime object.
   */
  constructor(e2) {
    if (e2 instanceof _t0) {
      this.date = e2.date, this.ut = e2.ut, this.tt = e2.tt;
      return;
    }
    const t2 = 1e3 * 3600 * 24;
    if (e2 instanceof Date && Number.isFinite(e2.getTime())) {
      this.date = e2, this.ut = (e2.getTime() - ot.getTime()) / t2, this.tt = st(this.ut);
      return;
    }
    if (Number.isFinite(e2)) {
      this.date = new Date(ot.getTime() + e2 * t2), this.ut = e2, this.tt = st(this.ut);
      return;
    }
    throw "Argument must be a Date object, an AstroTime object, or a numeric UTC Julian date.";
  }
  /**
   * @brief Creates an `AstroTime` value from a Terrestrial Time (TT) day value.
   *
   * This function can be used in rare cases where a time must be based
   * on Terrestrial Time (TT) rather than Universal Time (UT).
   * Most developers will want to invoke `new AstroTime(ut)` with a universal time
   * instead of this function, because usually time is based on civil time adjusted
   * by leap seconds to match the Earth's rotation, rather than the uniformly
   * flowing TT used to calculate solar system dynamics. In rare cases
   * where the caller already knows TT, this function is provided to create
   * an `AstroTime` value that can be passed to Astronomy Engine functions.
   *
   * @param {number} tt
   *      The number of days since the J2000 epoch as expressed in Terrestrial Time.
   *
   * @returns {AstroTime}
   *      An `AstroTime` object for the specified terrestrial time.
   */
  static FromTerrestrialTime(e2) {
    let t2 = new _t0(e2);
    for (; ; ) {
      const r3 = e2 - t2.tt;
      if (Math.abs(r3) < 1e-12)
        return t2;
      t2 = t2.AddDays(r3);
    }
  }
  /**
   * Formats an `AstroTime` object as an [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601)
   * date/time string in UTC, to millisecond resolution.
   * Example: `2018-08-17T17:22:04.050Z`
   * @returns {string}
   */
  toString() {
    return this.date.toISOString();
  }
  /**
   * Returns a new `AstroTime` object adjusted by the floating point number of days.
   * Does NOT modify the original `AstroTime` object.
   *
   * @param {number} days
   *      The floating point number of days by which to adjust the given date and time.
   *      Positive values adjust the date toward the future, and
   *      negative values adjust the date toward the past.
   *
   * @returns {AstroTime}
   */
  AddDays(e2) {
    return new _t0(this.ut + e2);
  }
};
function r0(n2) {
  return n2 instanceof t0 ? n2 : new t0(n2);
}
function lr(n2) {
  function e2(f2) {
    return f2 % tr * x0;
  }
  const t2 = n2.tt / 36525, r3 = e2(128710479305e-5 + t2 * 1295965810481e-4), i2 = e2(335779.526232 + t2 * 17395272628478e-4), a = e2(107226070369e-5 + t2 * 1602961601209e-3), o = e2(450160.398036 - t2 * 69628905431e-4);
  let c2 = Math.sin(o), s = Math.cos(o), l2 = (-172064161 - 174666 * t2) * c2 + 33386 * s, h2 = (92052331 + 9086 * t2) * s + 15377 * c2, m = 2 * (i2 - a + o);
  return c2 = Math.sin(m), s = Math.cos(m), l2 += (-13170906 - 1675 * t2) * c2 - 13696 * s, h2 += (5730336 - 3015 * t2) * s - 4587 * c2, m = 2 * (i2 + o), c2 = Math.sin(m), s = Math.cos(m), l2 += (-2276413 - 234 * t2) * c2 + 2796 * s, h2 += (978459 - 485 * t2) * s + 1374 * c2, m = 2 * o, c2 = Math.sin(m), s = Math.cos(m), l2 += (2074554 + 207 * t2) * c2 - 698 * s, h2 += (-897492 + 470 * t2) * s - 291 * c2, c2 = Math.sin(r3), s = Math.cos(r3), l2 += (1475877 - 3633 * t2) * c2 + 11817 * s, h2 += (73871 - 184 * t2) * s - 1924 * c2, {
    dpsi: -135e-6 + l2 * 1e-7,
    deps: 388e-6 + h2 * 1e-7
  };
}
function Nt(n2) {
  var e2 = n2.tt / 36525, t2 = ((((-434e-10 * e2 - 576e-9) * e2 + 20034e-7) * e2 - 1831e-7) * e2 - 46.836769) * e2 + 84381.406;
  return t2 / 3600;
}
var K0;
function Ot(n2) {
  if (!K0 || Math.abs(K0.tt - n2.tt) > 1e-6) {
    const e2 = lr(n2), t2 = Nt(n2), r3 = t2 + e2.deps / 3600;
    K0 = {
      tt: n2.tt,
      dpsi: e2.dpsi,
      deps: e2.deps,
      ee: e2.dpsi * Math.cos(t2 * g2) / 15,
      mobl: t2,
      tobl: r3
    };
  }
  return K0;
}
function dr(n2, e2) {
  const t2 = n2 * g2, r3 = Math.cos(t2), i2 = Math.sin(t2);
  return [
    e2[0],
    e2[1] * r3 - e2[2] * i2,
    e2[1] * i2 + e2[2] * r3
  ];
}
function hr(n2, e2) {
  return dr(Nt(n2), e2);
}
function mr(n2) {
  const e2 = n2.tt / 36525;
  function t2(R2, _2) {
    const A2 = [];
    let C2;
    for (C2 = 0; C2 <= _2 - R2; ++C2)
      A2.push(0);
    return { min: R2, array: A2 };
  }
  function r3(R2, _2, A2, C2) {
    const P = [];
    for (let Q = 0; Q <= _2 - R2; ++Q)
      P.push(t2(A2, C2));
    return { min: R2, array: P };
  }
  function i2(R2, _2, A2) {
    const C2 = R2.array[_2 - R2.min];
    return C2.array[A2 - C2.min];
  }
  function a(R2, _2, A2, C2) {
    const P = R2.array[_2 - R2.min];
    P.array[A2 - P.min] = C2;
  }
  let o, c2, s, l2, h2, m, f2, v, T2, E2, x, y, I2, N2, b, U2, z, F, q, Z, i0, a0, J, N0 = r3(-6, 6, 1, 4), p0 = r3(-6, 6, 1, 4);
  function z0(R2, _2) {
    return i2(N0, R2, _2);
  }
  function k0(R2, _2) {
    return i2(p0, R2, _2);
  }
  function V0(R2, _2, A2) {
    return a(N0, R2, _2, A2);
  }
  function B0(R2, _2, A2) {
    return a(p0, R2, _2, A2);
  }
  function $e(R2, _2, A2, C2, P) {
    P(R2 * A2 - _2 * C2, _2 * A2 + R2 * C2);
  }
  function M(R2) {
    return Math.sin(X2 * R2);
  }
  f2 = e2 * e2, T2 = 0, J = 0, x = 0, y = 3422.7;
  var W0 = M(0.19833 + 0.05611 * e2), le = M(0.27869 + 0.04508 * e2), de = M(0.16827 - 0.36903 * e2), he = M(0.34734 - 5.37261 * e2), me = M(0.10498 - 5.37899 * e2), j0 = M(0.42681 - 0.41855 * e2), qt = M(0.14943 - 5.37511 * e2);
  for (F = 0.84 * W0 + 0.31 * le + 14.27 * de + 7.26 * he + 0.28 * me + 0.24 * j0, q = 2.94 * W0 + 0.31 * le + 14.27 * de + 9.34 * he + 1.12 * me + 0.83 * j0, Z = -6.4 * W0 - 1.89 * j0, i0 = 0.21 * W0 + 0.31 * le + 14.27 * de - 88.7 * he - 15.3 * me + 0.24 * j0 - 1.86 * qt, a0 = F - Z, v = -3332e-9 * M(0.59734 - 5.37261 * e2) - 539e-9 * M(0.35498 - 5.37899 * e2) - 64e-9 * M(0.39943 - 5.37511 * e2), I2 = X2 * E0(0.60643382 + 1336.85522467 * e2 - 313e-8 * f2) + F / e0, N2 = X2 * E0(0.37489701 + 1325.55240982 * e2 + 2565e-8 * f2) + q / e0, b = X2 * E0(0.99312619 + 99.99735956 * e2 - 44e-8 * f2) + Z / e0, U2 = X2 * E0(0.25909118 + 1342.2278298 * e2 - 892e-8 * f2) + i0 / e0, z = X2 * E0(0.82736186 + 1236.85308708 * e2 - 397e-8 * f2) + a0 / e0, h2 = 1; h2 <= 4; ++h2) {
    switch (h2) {
      case 1:
        s = N2, c2 = 4, l2 = 1.000002208;
        break;
      case 2:
        s = b, c2 = 3, l2 = 0.997504612 - 2495388e-9 * e2;
        break;
      case 3:
        s = U2, c2 = 4, l2 = 1.000002708 + 139.978 * v;
        break;
      case 4:
        s = z, c2 = 6, l2 = 1;
        break;
      default:
        throw `Internal error: I = ${h2}`;
    }
    for (V0(0, h2, 1), V0(1, h2, Math.cos(s) * l2), B0(0, h2, 0), B0(1, h2, Math.sin(s) * l2), m = 2; m <= c2; ++m)
      $e(z0(m - 1, h2), k0(m - 1, h2), z0(1, h2), k0(1, h2), (R2, _2) => (V0(m, h2, R2), B0(m, h2, _2)));
    for (m = 1; m <= c2; ++m)
      V0(-m, h2, z0(m, h2)), B0(-m, h2, -k0(m, h2));
  }
  function qe(R2, _2, A2, C2) {
    for (var P = { x: 1, y: 0 }, Q = [0, R2, _2, A2, C2], j = 1; j <= 4; ++j)
      Q[j] !== 0 && $e(P.x, P.y, z0(Q[j], j), k0(Q[j], j), (fe, T0) => (P.x = fe, P.y = T0));
    return P;
  }
  function u2(R2, _2, A2, C2, P, Q, j, fe) {
    var T0 = qe(P, Q, j, fe);
    T2 += R2 * T0.y, J += _2 * T0.y, x += A2 * T0.x, y += C2 * T0.x;
  }
  u2(13.902, 14.06, -1e-3, 0.2607, 0, 0, 0, 4), u2(0.403, -4.01, 0.394, 23e-4, 0, 0, 0, 3), u2(2369.912, 2373.36, 0.601, 28.2333, 0, 0, 0, 2), u2(-125.154, -112.79, -0.725, -0.9781, 0, 0, 0, 1), u2(1.979, 6.98, -0.445, 0.0433, 1, 0, 0, 4), u2(191.953, 192.72, 0.029, 3.0861, 1, 0, 0, 2), u2(-8.466, -13.51, 0.455, -0.1093, 1, 0, 0, 1), u2(22639.5, 22609.07, 0.079, 186.5398, 1, 0, 0, 0), u2(18.609, 3.59, -0.094, 0.0118, 1, 0, 0, -1), u2(-4586.465, -4578.13, -0.077, 34.3117, 1, 0, 0, -2), u2(3.215, 5.44, 0.192, -0.0386, 1, 0, 0, -3), u2(-38.428, -38.64, 1e-3, 0.6008, 1, 0, 0, -4), u2(-0.393, -1.43, -0.092, 86e-4, 1, 0, 0, -6), u2(-0.289, -1.59, 0.123, -53e-4, 0, 1, 0, 4), u2(-24.42, -25.1, 0.04, -0.3, 0, 1, 0, 2), u2(18.023, 17.93, 7e-3, 0.1494, 0, 1, 0, 1), u2(-668.146, -126.98, -1.302, -0.3997, 0, 1, 0, 0), u2(0.56, 0.32, -1e-3, -37e-4, 0, 1, 0, -1), u2(-165.145, -165.06, 0.054, 1.9178, 0, 1, 0, -2), u2(-1.877, -6.46, -0.416, 0.0339, 0, 1, 0, -4), u2(0.213, 1.02, -0.074, 54e-4, 2, 0, 0, 4), u2(14.387, 14.78, -0.017, 0.2833, 2, 0, 0, 2), u2(-0.586, -1.2, 0.054, -0.01, 2, 0, 0, 1), u2(769.016, 767.96, 0.107, 10.1657, 2, 0, 0, 0), u2(1.75, 2.01, -0.018, 0.0155, 2, 0, 0, -1), u2(-211.656, -152.53, 5.679, -0.3039, 2, 0, 0, -2), u2(1.225, 0.91, -0.03, -88e-4, 2, 0, 0, -3), u2(-30.773, -34.07, -0.308, 0.3722, 2, 0, 0, -4), u2(-0.57, -1.4, -0.074, 0.0109, 2, 0, 0, -6), u2(-2.921, -11.75, 0.787, -0.0484, 1, 1, 0, 2), u2(1.267, 1.52, -0.022, 0.0164, 1, 1, 0, 1), u2(-109.673, -115.18, 0.461, -0.949, 1, 1, 0, 0), u2(-205.962, -182.36, 2.056, 1.4437, 1, 1, 0, -2), u2(0.233, 0.36, 0.012, -25e-4, 1, 1, 0, -3), u2(-4.391, -9.66, -0.471, 0.0673, 1, 1, 0, -4), u2(0.283, 1.53, -0.111, 6e-3, 1, -1, 0, 4), u2(14.577, 31.7, -1.54, 0.2302, 1, -1, 0, 2), u2(147.687, 138.76, 0.679, 1.1528, 1, -1, 0, 0), u2(-1.089, 0.55, 0.021, 0, 1, -1, 0, -1), u2(28.475, 23.59, -0.443, -0.2257, 1, -1, 0, -2), u2(-0.276, -0.38, -6e-3, -36e-4, 1, -1, 0, -3), u2(0.636, 2.27, 0.146, -0.0102, 1, -1, 0, -4), u2(-0.189, -1.68, 0.131, -28e-4, 0, 2, 0, 2), u2(-7.486, -0.66, -0.037, -86e-4, 0, 2, 0, 0), u2(-8.096, -16.35, -0.74, 0.0918, 0, 2, 0, -2), u2(-5.741, -0.04, 0, -9e-4, 0, 0, 2, 2), u2(0.255, 0, 0, 0, 0, 0, 2, 1), u2(-411.608, -0.2, 0, -0.0124, 0, 0, 2, 0), u2(0.584, 0.84, 0, 71e-4, 0, 0, 2, -1), u2(-55.173, -52.14, 0, -0.1052, 0, 0, 2, -2), u2(0.254, 0.25, 0, -17e-4, 0, 0, 2, -3), u2(0.025, -1.67, 0, 31e-4, 0, 0, 2, -4), u2(1.06, 2.96, -0.166, 0.0243, 3, 0, 0, 2), u2(36.124, 50.64, -1.3, 0.6215, 3, 0, 0, 0), u2(-13.193, -16.4, 0.258, -0.1187, 3, 0, 0, -2), u2(-1.187, -0.74, 0.042, 74e-4, 3, 0, 0, -4), u2(-0.293, -0.31, -2e-3, 46e-4, 3, 0, 0, -6), u2(-0.29, -1.45, 0.116, -51e-4, 2, 1, 0, 2), u2(-7.649, -10.56, 0.259, -0.1038, 2, 1, 0, 0), u2(-8.627, -7.59, 0.078, -0.0192, 2, 1, 0, -2), u2(-2.74, -2.54, 0.022, 0.0324, 2, 1, 0, -4), u2(1.181, 3.32, -0.212, 0.0213, 2, -1, 0, 2), u2(9.703, 11.67, -0.151, 0.1268, 2, -1, 0, 0), u2(-0.352, -0.37, 1e-3, -28e-4, 2, -1, 0, -1), u2(-2.494, -1.17, -3e-3, -17e-4, 2, -1, 0, -2), u2(0.36, 0.2, -0.012, -43e-4, 2, -1, 0, -4), u2(-1.167, -1.25, 8e-3, -0.0106, 1, 2, 0, 0), u2(-7.412, -6.12, 0.117, 0.0484, 1, 2, 0, -2), u2(-0.311, -0.65, -0.032, 44e-4, 1, 2, 0, -4), u2(0.757, 1.82, -0.105, 0.0112, 1, -2, 0, 2), u2(2.58, 2.32, 0.027, 0.0196, 1, -2, 0, 0), u2(2.533, 2.4, -0.014, -0.0212, 1, -2, 0, -2), u2(-0.344, -0.57, -0.025, 36e-4, 0, 3, 0, -2), u2(-0.992, -0.02, 0, 0, 1, 0, 2, 2), u2(-45.099, -0.02, 0, -1e-3, 1, 0, 2, 0), u2(-0.179, -9.52, 0, -0.0833, 1, 0, 2, -2), u2(-0.301, -0.33, 0, 14e-4, 1, 0, 2, -4), u2(-6.382, -3.37, 0, -0.0481, 1, 0, -2, 2), u2(39.528, 85.13, 0, -0.7136, 1, 0, -2, 0), u2(9.366, 0.71, 0, -0.0112, 1, 0, -2, -2), u2(0.202, 0.02, 0, 0, 1, 0, -2, -4), u2(0.415, 0.1, 0, 13e-4, 0, 1, 2, 0), u2(-2.152, -2.26, 0, -66e-4, 0, 1, 2, -2), u2(-1.44, -1.3, 0, 14e-4, 0, 1, -2, 2), u2(0.384, -0.04, 0, 0, 0, 1, -2, -2), u2(1.938, 3.6, -0.145, 0.0401, 4, 0, 0, 0), u2(-0.952, -1.58, 0.052, -0.013, 4, 0, 0, -2), u2(-0.551, -0.94, 0.032, -97e-4, 3, 1, 0, 0), u2(-0.482, -0.57, 5e-3, -45e-4, 3, 1, 0, -2), u2(0.681, 0.96, -0.026, 0.0115, 3, -1, 0, 0), u2(-0.297, -0.27, 2e-3, -9e-4, 2, 2, 0, -2), u2(0.254, 0.21, -3e-3, 0, 2, -2, 0, -2), u2(-0.25, -0.22, 4e-3, 14e-4, 1, 3, 0, -2), u2(-3.996, 0, 0, 4e-4, 2, 0, 2, 0), u2(0.557, -0.75, 0, -9e-3, 2, 0, 2, -2), u2(-0.459, -0.38, 0, -53e-4, 2, 0, -2, 2), u2(-1.298, 0.74, 0, 4e-4, 2, 0, -2, 0), u2(0.538, 1.14, 0, -0.0141, 2, 0, -2, -2), u2(0.263, 0.02, 0, 0, 1, 1, 2, 0), u2(0.426, 0.07, 0, -6e-4, 1, 1, -2, -2), u2(-0.304, 0.03, 0, 3e-4, 1, -1, 2, 0), u2(-0.372, -0.19, 0, -27e-4, 1, -1, -2, 2), u2(0.418, 0, 0, 0, 0, 0, 4, 0), u2(-0.33, -0.04, 0, 0, 3, 0, 2, 0);
  function B(R2, _2, A2, C2, P) {
    return R2 * qe(_2, A2, C2, P).y;
  }
  E2 = 0, E2 += B(-526.069, 0, 0, 1, -2), E2 += B(-3.352, 0, 0, 1, -4), E2 += B(44.297, 1, 0, 1, -2), E2 += B(-6, 1, 0, 1, -4), E2 += B(20.599, -1, 0, 1, 0), E2 += B(-30.598, -1, 0, 1, -2), E2 += B(-24.649, -2, 0, 1, 0), E2 += B(-2, -2, 0, 1, -2), E2 += B(-22.571, 0, 1, 1, -2), E2 += B(10.985, 0, -1, 1, -2), T2 += 0.82 * M(0.7736 - 62.5512 * e2) + 0.31 * M(0.0466 - 125.1025 * e2) + 0.35 * M(0.5785 - 25.1042 * e2) + 0.66 * M(0.4591 + 1335.8075 * e2) + 0.64 * M(0.313 - 91.568 * e2) + 1.14 * M(0.148 + 1331.2898 * e2) + 0.21 * M(0.5918 + 1056.5859 * e2) + 0.44 * M(0.5784 + 1322.8595 * e2) + 0.24 * M(0.2275 - 5.7374 * e2) + 0.28 * M(0.2965 + 2.6929 * e2) + 0.33 * M(0.3132 + 6.3368 * e2), o = U2 + J / e0;
  let Zt = (1.000002708 + 139.978 * v) * (18518.511 + 1.189 + x) * Math.sin(o) - 6.24 * Math.sin(3 * o) + E2;
  return {
    geo_eclip_lon: X2 * E0((I2 + T2 / e0) / X2),
    geo_eclip_lat: Math.PI / (180 * 3600) * Zt,
    distance_au: e0 * rr / (0.999953253 * y)
  };
}
function Lt(n2, e2) {
  return [
    n2.rot[0][0] * e2[0] + n2.rot[1][0] * e2[1] + n2.rot[2][0] * e2[2],
    n2.rot[0][1] * e2[0] + n2.rot[1][1] * e2[1] + n2.rot[2][1] * e2[2],
    n2.rot[0][2] * e2[0] + n2.rot[1][2] * e2[1] + n2.rot[2][2] * e2[2]
  ];
}
function Ht(n2, e2, t2) {
  const r3 = bt(e2, t2);
  return Lt(r3, n2);
}
function bt(n2, e2) {
  const t2 = n2.tt / 36525;
  let r3 = 84381.406, i2 = ((((-951e-10 * t2 + 132851e-9) * t2 - 114045e-8) * t2 - 1.0790069) * t2 + 5038.481507) * t2, a = ((((3337e-10 * t2 - 467e-9) * t2 - 772503e-8) * t2 + 0.0512623) * t2 - 0.025754) * t2 + r3, o = ((((-56e-9 * t2 + 170663e-9) * t2 - 121197e-8) * t2 - 2.3814292) * t2 + 10.556403) * t2;
  r3 *= x0, i2 *= x0, a *= x0, o *= x0;
  const c2 = Math.sin(r3), s = Math.cos(r3), l2 = Math.sin(-i2), h2 = Math.cos(-i2), m = Math.sin(-a), f2 = Math.cos(-a), v = Math.sin(o), T2 = Math.cos(o), E2 = T2 * h2 - l2 * v * f2, x = T2 * l2 * s + v * f2 * h2 * s - c2 * v * m, y = T2 * l2 * c2 + v * f2 * h2 * c2 + s * v * m, I2 = -v * h2 - l2 * T2 * f2, N2 = -v * l2 * s + T2 * f2 * h2 * s - c2 * T2 * m, b = -v * l2 * c2 + T2 * f2 * h2 * c2 + s * T2 * m, U2 = l2 * m, z = -m * h2 * s - c2 * f2, F = -m * h2 * c2 + f2 * s;
  if (e2 === V.Into2000)
    return new I0([
      [E2, x, y],
      [I2, N2, b],
      [U2, z, F]
    ]);
  if (e2 === V.From2000)
    return new I0([
      [E2, I2, U2],
      [x, N2, z],
      [y, b, F]
    ]);
  throw "Invalid precess direction";
}
function fr(n2) {
  const e2 = 0.779057273264 + 0.00273781191135448 * n2.ut, t2 = n2.ut % 1;
  let r3 = 360 * ((e2 + t2) % 1);
  return r3 < 0 && (r3 += 360), r3;
}
var $0;
function gr(n2) {
  if (!$0 || $0.tt !== n2.tt) {
    const e2 = n2.tt / 36525;
    let t2 = 15 * Ot(n2).ee;
    const r3 = fr(n2);
    let a = ((t2 + 0.014506 + ((((-368e-10 * e2 - 29956e-9) * e2 - 44e-8) * e2 + 1.3915817) * e2 + 4612.156534) * e2) / 3600 + r3) % 360 / 15;
    a < 0 && (a += 24), $0 = {
      tt: n2.tt,
      st: a
    };
  }
  return $0.st;
}
function pr(n2) {
  const e2 = r0(n2);
  return gr(e2);
}
function Tr(n2, e2, t2) {
  const r3 = Ut(e2, t2);
  return Lt(r3, n2);
}
function Ut(n2, e2) {
  const t2 = Ot(n2), r3 = t2.mobl * g2, i2 = t2.tobl * g2, a = t2.dpsi * x0, o = Math.cos(r3), c2 = Math.sin(r3), s = Math.cos(i2), l2 = Math.sin(i2), h2 = Math.cos(a), m = Math.sin(a), f2 = h2, v = -m * o, T2 = -m * c2, E2 = m * s, x = h2 * o * s + c2 * l2, y = h2 * c2 * s - o * l2, I2 = m * l2, N2 = h2 * o * l2 - c2 * s, b = h2 * c2 * l2 + o * s;
  if (e2 === V.From2000)
    return new I0([
      [f2, E2, I2],
      [v, x, N2],
      [T2, y, b]
    ]);
  if (e2 === V.Into2000)
    return new I0([
      [f2, v, T2],
      [E2, x, y],
      [I2, N2, b]
    ]);
  throw "Invalid precess direction";
}
var G2 = class {
  constructor(e2, t2, r3, i2) {
    this.x = e2, this.y = t2, this.z = r3, this.t = i2;
  }
  /**
   * Returns the length of the vector in astronomical units (AU).
   * @returns {number}
   */
  Length() {
    return Math.hypot(this.x, this.y, this.z);
  }
};
var Sr = class {
  constructor(e2, t2, r3, i2, a, o, c2) {
    this.x = e2, this.y = t2, this.z = r3, this.vx = i2, this.vy = a, this.vz = o, this.t = c2;
  }
};
var Gt = class {
  constructor(e2, t2, r3) {
    this.lat = l0(e2), this.lon = l0(t2), this.dist = l0(r3);
  }
};
var vr = class {
  constructor(e2, t2, r3, i2) {
    this.ra = l0(e2), this.dec = l0(t2), this.dist = l0(r3), this.vec = i2;
  }
};
var I0 = class {
  constructor(e2) {
    this.rot = e2;
  }
};
function ye(n2) {
  const e2 = r0(n2), t2 = mr(e2), r3 = t2.distance_au * Math.cos(t2.geo_eclip_lat), i2 = [
    r3 * Math.cos(t2.geo_eclip_lon),
    r3 * Math.sin(t2.geo_eclip_lon),
    t2.distance_au * Math.sin(t2.geo_eclip_lat)
  ], a = hr(e2, i2), o = Ht(a, e2, V.Into2000);
  return new G2(o[0], o[1], o[2], e2);
}
function y0(n2, e2, t2) {
  let r3 = 1, i2 = 0;
  for (let a of n2) {
    let o = 0;
    for (let [s, l2, h2] of a)
      o += s * Math.cos(l2 + e2 * h2);
    let c2 = r3 * o;
    t2 && (c2 %= X2), i2 += c2, r3 *= e2;
  }
  return i2;
}
function Se(n2, e2) {
  let t2 = 1, r3 = 0, i2 = 0, a = 0;
  for (let o of n2) {
    let c2 = 0, s = 0;
    for (let [l2, h2, m] of o) {
      let f2 = h2 + e2 * m;
      c2 += l2 * m * Math.sin(f2), a > 0 && (s += l2 * Math.cos(f2));
    }
    i2 += a * r3 * s - t2 * c2, r3 = t2, t2 *= e2, ++a;
  }
  return i2;
}
var b0 = 365250;
var Ce = 0;
var De = 1;
var Ie = 2;
function Pe(n2) {
  return new O(n2[0] + 44036e-11 * n2[1] - 190919e-12 * n2[2], -479966e-12 * n2[0] + 0.917482137087 * n2[1] - 0.397776982902 * n2[2], 0.397776982902 * n2[1] + 0.917482137087 * n2[2]);
}
function Ft(n2, e2, t2) {
  const r3 = t2 * Math.cos(e2), i2 = Math.cos(n2), a = Math.sin(n2);
  return [
    r3 * i2,
    r3 * a,
    t2 * Math.sin(e2)
  ];
}
function Q0(n2, e2) {
  const t2 = e2.tt / b0, r3 = y0(n2[Ce], t2, true), i2 = y0(n2[De], t2, false), a = y0(n2[Ie], t2, false), o = Ft(r3, i2, a);
  return Pe(o).ToAstroVector(e2);
}
function Er(n2, e2) {
  const t2 = e2 / b0, r3 = y0(n2[Ce], t2, true), i2 = y0(n2[De], t2, false), a = y0(n2[Ie], t2, false), o = Se(n2[Ce], t2), c2 = Se(n2[De], t2), s = Se(n2[Ie], t2), l2 = Math.cos(r3), h2 = Math.sin(r3), m = Math.cos(i2), f2 = Math.sin(i2), v = +(s * m * l2) - a * f2 * l2 * c2 - a * m * h2 * o, T2 = +(s * m * h2) - a * f2 * h2 * c2 + a * m * l2 * o, E2 = +(s * f2) + a * m * c2, x = Ft(r3, i2, a), y = [
    v / b0,
    T2 / b0,
    E2 / b0
  ], I2 = Pe(x), N2 = Pe(y);
  return new d0(e2, I2, N2);
}
function q0(n2, e2, t2, r3) {
  const i2 = r3 / (r3 + We), a = Q0(M0[t2], e2);
  n2.x += i2 * a.x, n2.y += i2 * a.y, n2.z += i2 * a.z;
}
function Rr(n2) {
  const e2 = new G2(0, 0, 0, n2);
  return q0(e2, n2, S2.Jupiter, xe), q0(e2, n2, S2.Saturn, Me), q0(e2, n2, S2.Uranus, Ae), q0(e2, n2, S2.Neptune, we), e2;
}
var Ne = 51;
var _r = 29200;
var A0 = 146;
var Y = 201;
var o0 = [
  [-73e4, [-26.118207232108, -14.376168177825, 3.384402515299], [0.0016339372163656, -0.0027861699588508, -0.0013585880229445]],
  [-700800, [41.974905202127, -0.448502952929, -12.770351505989], [73458569351457e-17, 0.0022785014891658, 48619778602049e-17]],
  [-671600, [14.706930780744, 44.269110540027, 9.353698474772], [-0.00210001479998, 22295915939915e-17, 70143443551414e-17]],
  [-642400, [-29.441003929957, -6.43016153057, 6.858481011305], [84495803960544e-17, -0.0030783914758711, -0.0012106305981192]],
  [-613200, [39.444396946234, -6.557989760571, -13.913760296463], [0.0011480029005873, 0.0022400006880665, 35168075922288e-17]],
  [-584e3, [20.2303809507, 43.266966657189, 7.382966091923], [-0.0019754081700585, 53457141292226e-17, 75929169129793e-17]],
  [-554800, [-30.65832536462, 2.093818874552, 9.880531138071], [61010603013347e-18, -0.0031326500935382, -99346125151067e-17]],
  [-525600, [35.737703251673, -12.587706024764, -14.677847247563], [0.0015802939375649, 0.0021347678412429, 19074436384343e-17]],
  [-496400, [25.466295188546, 41.367478338417, 5.216476873382], [-0.0018054401046468, 8328308359951e-16, 80260156912107e-17]],
  [-467200, [-29.847174904071, 10.636426313081, 12.297904180106], [-63257063052907e-17, -0.0029969577578221, -74476074151596e-17]],
  [-438e3, [30.774692107687, -18.236637015304, -14.945535879896], [0.0020113162005465, 0.0019353827024189, -20937793168297e-19]],
  [-408800, [30.243153324028, 38.656267888503, 2.938501750218], [-0.0016052508674468, 0.0011183495337525, 83333973416824e-17]],
  [-379600, [-27.288984772533, 18.643162147874, 14.023633623329], [-0.0011856388898191, -0.0027170609282181, -49015526126399e-17]],
  [-350400, [24.519605196774, -23.245756064727, -14.626862367368], [0.0024322321483154, 0.0016062008146048, -23369181613312e-17]],
  [-321200, [34.505274805875, 35.125338586954, 0.557361475637], [-0.0013824391637782, 0.0013833397561817, 84823598806262e-17]],
  [-292e3, [-23.275363915119, 25.818514298769, 15.055381588598], [-0.0016062295460975, -0.0023395961498533, -24377362639479e-17]],
  [-262800, [17.050384798092, -27.180376290126, -13.608963321694], [0.0028175521080578, 0.0011358749093955, -49548725258825e-17]],
  [-233600, [38.093671910285, 30.880588383337, -1.843688067413], [-0.0011317697153459, 0.0016128814698472, 84177586176055e-17]],
  [-204400, [-18.197852930878, 31.932869934309, 15.438294826279], [-0.0019117272501813, -0.0019146495909842, -19657304369835e-18]],
  [-175200, [8.528924039997, -29.618422200048, -11.805400994258], [0.0031034370787005, 5139363329243e-16, -77293066202546e-17]],
  [-146e3, [40.94685725864, 25.904973592021, -4.256336240499], [-83652705194051e-17, 0.0018129497136404, 8156422827306e-16]],
  [-116800, [-12.326958895325, 36.881883446292, 15.217158258711], [-0.0021166103705038, -0.001481442003599, 17401209844705e-17]],
  [-87600, [-0.633258375909, -30.018759794709, -9.17193287495], [0.0032016994581737, -25279858672148e-17, -0.0010411088271861]],
  [-58400, [42.936048423883, 20.344685584452, -6.588027007912], [-50525450073192e-17, 0.0019910074335507, 77440196540269e-17]],
  [-29200, [-5.975910552974, 40.61180995846, 14.470131723673], [-0.0022184202156107, -0.0010562361130164, 33652250216211e-17]],
  [0, [-9.875369580774, -27.978926224737, -5.753711824704], [0.0030287533248818, -0.0011276087003636, -0.0012651326732361]],
  [29200, [43.958831986165, 14.214147973292, -8.808306227163], [-14717608981871e-17, 0.0021404187242141, 71486567806614e-17]],
  [58400, [0.67813676352, 43.094461639362, 13.243238780721], [-0.0022358226110718, -63233636090933e-17, 47664798895648e-17]],
  [87600, [-18.282602096834, -23.30503958666, -1.766620508028], [0.0025567245263557, -0.0019902940754171, -0.0013943491701082]],
  [116800, [43.873338744526, 7.700705617215, -10.814273666425], [23174803055677e-17, 0.0022402163127924, 62988756452032e-17]],
  [146e3, [7.392949027906, 44.382678951534, 11.629500214854], [-0.002193281545383, -21751799585364e-17, 59556516201114e-17]],
  [175200, [-24.981690229261, -16.204012851426, 2.466457544298], [0.001819398914958, -0.0026765419531201, -0.0013848283502247]],
  [204400, [42.530187039511, 0.845935508021, -12.554907527683], [65059779150669e-17, 0.0022725657282262, 51133743202822e-17]],
  [233600, [13.999526486822, 44.462363044894, 9.669418486465], [-0.0021079296569252, 17533423831993e-17, 69128485798076e-17]],
  [262800, [-29.184024803031, -7.371243995762, 6.493275957928], [93581363109681e-17, -0.0030610357109184, -0.0012364201089345]],
  [292e3, [39.831980671753, -6.078405766765, -13.909815358656], [0.0011117769689167, 0.0022362097830152, 36230548231153e-17]],
  [321200, [20.294955108476, 43.417190420251, 7.450091985932], [-0.0019742157451535, 53102050468554e-17, 75938408813008e-17]],
  [350400, [-30.66999230216, 2.318743558955, 9.973480913858], [45605107450676e-18, -0.0031308219926928, -99066533301924e-17]],
  [379600, [35.626122155983, -12.897647509224, -14.777586508444], [0.0016015684949743, 0.0021171931182284, 18002516202204e-17]],
  [408800, [26.133186148561, 41.232139187599, 5.00640132622], [-0.0017857704419579, 86046232702817e-17, 80614690298954e-17]],
  [438e3, [-29.57674022923, 11.863535943587, 12.631323039872], [-72292830060955e-17, -0.0029587820140709, -708242964503e-15]],
  [467200, [29.910805787391, -19.159019294, -15.013363865194], [0.0020871080437997, 0.0018848372554514, -38528655083926e-18]],
  [496400, [31.375957451819, 38.050372720763, 2.433138343754], [-0.0015546055556611, 0.0011699815465629, 83565439266001e-17]],
  [525600, [-26.360071336928, 20.662505904952, 14.414696258958], [-0.0013142373118349, -0.0026236647854842, -42542017598193e-17]],
  [554800, [22.599441488648, -24.508879898306, -14.484045731468], [0.0025454108304806, 0.0014917058755191, -30243665086079e-17]],
  [584e3, [35.877864013014, 33.894226366071, -0.224524636277], [-0.0012941245730845, 0.0014560427668319, 84762160640137e-17]],
  [613200, [-21.538149762417, 28.204068269761, 15.321973799534], [-0.001731211740901, -0.0021939631314577, -1631691327518e-16]],
  [642400, [13.971521374415, -28.339941764789, -13.083792871886], [0.0029334630526035, 91860931752944e-17, -59939422488627e-17]],
  [671600, [39.526942044143, 28.93989736011, -2.872799527539], [-0.0010068481658095, 0.001702113288809, 83578230511981e-17]],
  [700800, [-15.576200701394, 34.399412961275, 15.466033737854], [-0.0020098814612884, -0.0017191109825989, 70414782780416e-18]],
  [73e4, [4.24325283709, -30.118201690825, -10.707441231349], [0.0031725847067411, 1609846120227e-16, -90672150593868e-17]]
];
var O = class _O {
  constructor(e2, t2, r3) {
    this.x = e2, this.y = t2, this.z = r3;
  }
  clone() {
    return new _O(this.x, this.y, this.z);
  }
  ToAstroVector(e2) {
    return new G2(this.x, this.y, this.z, e2);
  }
  static zero() {
    return new _O(0, 0, 0);
  }
  quadrature() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  add(e2) {
    return new _O(this.x + e2.x, this.y + e2.y, this.z + e2.z);
  }
  sub(e2) {
    return new _O(this.x - e2.x, this.y - e2.y, this.z - e2.z);
  }
  incr(e2) {
    this.x += e2.x, this.y += e2.y, this.z += e2.z;
  }
  decr(e2) {
    this.x -= e2.x, this.y -= e2.y, this.z -= e2.z;
  }
  mul(e2) {
    return new _O(e2 * this.x, e2 * this.y, e2 * this.z);
  }
  div(e2) {
    return new _O(this.x / e2, this.y / e2, this.z / e2);
  }
  mean(e2) {
    return new _O((this.x + e2.x) / 2, (this.y + e2.y) / 2, (this.z + e2.z) / 2);
  }
  neg() {
    return new _O(-this.x, -this.y, -this.z);
  }
};
var d0 = class _d0 {
  constructor(e2, t2, r3) {
    this.tt = e2, this.r = t2, this.v = r3;
  }
  clone() {
    return new _d0(this.tt, this.r, this.v);
  }
  sub(e2) {
    return new _d0(this.tt, this.r.sub(e2.r), this.v.sub(e2.v));
  }
};
function xr(n2) {
  let [e2, [t2, r3, i2], [a, o, c2]] = n2;
  return new d0(e2, new O(t2, r3, i2), new O(a, o, c2));
}
function Z0(n2, e2, t2, r3) {
  const i2 = r3 / (r3 + We), a = Er(M0[t2], e2);
  return n2.r.incr(a.r.mul(i2)), n2.v.incr(a.v.mul(i2)), a;
}
function H0(n2, e2, t2) {
  const r3 = t2.sub(n2), i2 = r3.quadrature();
  return r3.mul(e2 / (i2 * Math.sqrt(i2)));
}
var je = class {
  constructor(e2) {
    let t2 = new d0(e2, new O(0, 0, 0), new O(0, 0, 0));
    this.Jupiter = Z0(t2, e2, S2.Jupiter, xe), this.Saturn = Z0(t2, e2, S2.Saturn, Me), this.Uranus = Z0(t2, e2, S2.Uranus, Ae), this.Neptune = Z0(t2, e2, S2.Neptune, we), this.Jupiter.r.decr(t2.r), this.Jupiter.v.decr(t2.v), this.Saturn.r.decr(t2.r), this.Saturn.v.decr(t2.v), this.Uranus.r.decr(t2.r), this.Uranus.v.decr(t2.v), this.Neptune.r.decr(t2.r), this.Neptune.v.decr(t2.v), this.Sun = new d0(e2, t2.r.mul(-1), t2.v.mul(-1));
  }
  Acceleration(e2) {
    let t2 = H0(e2, We, this.Sun.r);
    return t2.incr(H0(e2, xe, this.Jupiter.r)), t2.incr(H0(e2, Me, this.Saturn.r)), t2.incr(H0(e2, Ae, this.Uranus.r)), t2.incr(H0(e2, we, this.Neptune.r)), t2;
  }
};
var ce = class _ce {
  constructor(e2, t2, r3, i2) {
    this.tt = e2, this.r = t2, this.v = r3, this.a = i2;
  }
  clone() {
    return new _ce(this.tt, this.r.clone(), this.v.clone(), this.a.clone());
  }
};
var zt = class {
  constructor(e2, t2) {
    this.bary = e2, this.grav = t2;
  }
};
function te(n2, e2, t2, r3) {
  return new O(e2.x + n2 * (t2.x + n2 * r3.x / 2), e2.y + n2 * (t2.y + n2 * r3.y / 2), e2.z + n2 * (t2.z + n2 * r3.z / 2));
}
function ct(n2, e2, t2) {
  return new O(e2.x + n2 * t2.x, e2.y + n2 * t2.y, e2.z + n2 * t2.z);
}
function Oe(n2, e2) {
  const t2 = n2 - e2.tt, r3 = new je(n2), i2 = te(t2, e2.r, e2.v, e2.a), a = r3.Acceleration(i2).mean(e2.a), o = te(t2, e2.r, e2.v, a), c2 = e2.v.add(a.mul(t2)), s = r3.Acceleration(o), l2 = new ce(n2, o, c2, s);
  return new zt(r3, l2);
}
var Mr = [];
function kt(n2, e2) {
  const t2 = Math.floor(n2);
  return t2 < 0 ? 0 : t2 >= e2 ? e2 - 1 : t2;
}
function Le(n2) {
  const e2 = xr(n2), t2 = new je(e2.tt), r3 = e2.r.add(t2.Sun.r), i2 = e2.v.add(t2.Sun.v), a = t2.Acceleration(r3), o = new ce(e2.tt, r3, i2, a);
  return new zt(t2, o);
}
function Ar(n2, e2) {
  const t2 = o0[0][0];
  if (e2 < t2 || e2 > o0[Ne - 1][0])
    return null;
  const r3 = kt((e2 - t2) / _r, Ne - 1);
  if (!n2[r3]) {
    const a = n2[r3] = [];
    a[0] = Le(o0[r3]).grav, a[Y - 1] = Le(o0[r3 + 1]).grav;
    let o, c2 = a[0].tt;
    for (o = 1; o < Y - 1; ++o)
      a[o] = Oe(c2 += A0, a[o - 1]).grav;
    c2 = a[Y - 1].tt;
    var i2 = [];
    for (i2[Y - 1] = a[Y - 1], o = Y - 2; o > 0; --o)
      i2[o] = Oe(c2 -= A0, i2[o + 1]).grav;
    for (o = Y - 2; o > 0; --o) {
      const s = o / (Y - 1);
      a[o].r = a[o].r.mul(1 - s).add(i2[o].r.mul(s)), a[o].v = a[o].v.mul(1 - s).add(i2[o].v.mul(s)), a[o].a = a[o].a.mul(1 - s).add(i2[o].a.mul(s));
    }
  }
  return n2[r3];
}
function ut(n2, e2, t2) {
  let r3 = Le(n2);
  const i2 = Math.ceil((e2 - r3.grav.tt) / t2);
  for (let a = 0; a < i2; ++a)
    r3 = Oe(a + 1 === i2 ? e2 : r3.grav.tt + t2, r3.grav);
  return r3;
}
function wr(n2, e2) {
  let t2, r3, i2;
  const a = Ar(Mr, n2.tt);
  if (a) {
    const o = kt((n2.tt - a[0].tt) / A0, Y - 1), c2 = a[o], s = a[o + 1], l2 = c2.a.mean(s.a), h2 = te(n2.tt - c2.tt, c2.r, c2.v, l2), m = ct(n2.tt - c2.tt, c2.v, l2), f2 = te(n2.tt - s.tt, s.r, s.v, l2), v = ct(n2.tt - s.tt, s.v, l2), T2 = (n2.tt - c2.tt) / A0;
    t2 = h2.mul(1 - T2).add(f2.mul(T2)), r3 = m.mul(1 - T2).add(v.mul(T2));
  } else {
    let o;
    n2.tt < o0[0][0] ? o = ut(o0[0], n2.tt, -A0) : o = ut(o0[Ne - 1], n2.tt, +A0), t2 = o.grav.r, r3 = o.grav.v, i2 = o.bary;
  }
  return i2 || (i2 = new je(n2.tt)), t2 = t2.sub(i2.Sun.r), r3 = r3.sub(i2.Sun.v), new Sr(t2.x, t2.y, t2.z, r3.x, r3.y, r3.z, n2);
}
function G0(n2, e2) {
  var t2 = r0(e2);
  if (n2 in M0)
    return Q0(M0[n2], t2);
  if (n2 === S2.Pluto) {
    const o = wr(t2);
    return new G2(o.x, o.y, o.z, t2);
  }
  if (n2 === S2.Sun)
    return new G2(0, 0, 0, t2);
  if (n2 === S2.Moon) {
    var r3 = Q0(M0.Earth, t2), i2 = ye(t2);
    return new G2(r3.x + i2.x, r3.y + i2.y, r3.z + i2.z, t2);
  }
  if (n2 === S2.EMB) {
    const o = Q0(M0.Earth, t2), c2 = ye(t2), s = 1 + ir;
    return new G2(o.x + c2.x / s, o.y + c2.y / s, o.z + c2.z / s, t2);
  }
  if (n2 === S2.SSB)
    return Rr(t2);
  const a = Pt(n2);
  if (a) {
    const o = new Gt(a.dec, 15 * a.ra, a.dist);
    return Or(o, t2);
  }
  throw `HelioVector: Unknown body "${n2}"`;
}
function yr(n2, e2) {
  let t2 = e2, r3 = 0;
  for (let i2 = 0; i2 < 10; ++i2) {
    const a = n2(t2), o = a.Length() / Jn;
    if (o > 1)
      throw "Object is too distant for light-travel solver.";
    const c2 = e2.AddDays(-o);
    if (r3 = Math.abs(c2.tt - t2.tt), r3 < 1e-9)
      return a;
    t2 = c2;
  }
  throw `Light-travel time solver did not converge: dt = ${r3}`;
}
var Cr = class {
  constructor(e2, t2, r3, i2) {
    this.observerBody = e2, this.targetBody = t2, this.aberration = r3, this.observerPos = i2;
  }
  Position(e2) {
    this.aberration && (this.observerPos = G0(this.observerBody, e2));
    const t2 = G0(this.targetBody, e2);
    return new G2(t2.x - this.observerPos.x, t2.y - this.observerPos.y, t2.z - this.observerPos.z, e2);
  }
};
function Dr(n2, e2, t2, r3) {
  const i2 = r0(n2);
  if (Pt(t2)) {
    const c2 = G0(t2, i2), s = G0(e2, i2);
    return new G2(c2.x - s.x, c2.y - s.y, c2.z - s.z, i2);
  }
  let a;
  a = G0(e2, i2);
  const o = new Cr(e2, t2, r3, a);
  return yr((c2) => o.Position(c2), i2);
}
function Ir(n2, e2, t2) {
  const r3 = r0(e2);
  switch (n2) {
    case S2.Earth:
      return new G2(0, 0, 0, r3);
    case S2.Moon:
      return ye(r3);
    default:
      const i2 = Dr(r3, S2.Earth, n2, t2);
      return i2.t = r3, i2;
  }
}
var lt;
(function(n2) {
  n2[n2.Pericenter = 0] = "Pericenter", n2[n2.Apocenter = 1] = "Apocenter";
})(lt || (lt = {}));
function Pr(n2, e2) {
  return new I0([
    [
      e2.rot[0][0] * n2.rot[0][0] + e2.rot[1][0] * n2.rot[0][1] + e2.rot[2][0] * n2.rot[0][2],
      e2.rot[0][1] * n2.rot[0][0] + e2.rot[1][1] * n2.rot[0][1] + e2.rot[2][1] * n2.rot[0][2],
      e2.rot[0][2] * n2.rot[0][0] + e2.rot[1][2] * n2.rot[0][1] + e2.rot[2][2] * n2.rot[0][2]
    ],
    [
      e2.rot[0][0] * n2.rot[1][0] + e2.rot[1][0] * n2.rot[1][1] + e2.rot[2][0] * n2.rot[1][2],
      e2.rot[0][1] * n2.rot[1][0] + e2.rot[1][1] * n2.rot[1][1] + e2.rot[2][1] * n2.rot[1][2],
      e2.rot[0][2] * n2.rot[1][0] + e2.rot[1][2] * n2.rot[1][1] + e2.rot[2][2] * n2.rot[1][2]
    ],
    [
      e2.rot[0][0] * n2.rot[2][0] + e2.rot[1][0] * n2.rot[2][1] + e2.rot[2][0] * n2.rot[2][2],
      e2.rot[0][1] * n2.rot[2][0] + e2.rot[1][1] * n2.rot[2][1] + e2.rot[2][1] * n2.rot[2][2],
      e2.rot[0][2] * n2.rot[2][0] + e2.rot[1][2] * n2.rot[2][1] + e2.rot[2][2] * n2.rot[2][2]
    ]
  ]);
}
function Nr(n2, e2, t2) {
  const r3 = l0(t2) * g2, i2 = Math.cos(r3), a = Math.sin(r3), o = (e2 + 1) % 3, c2 = (e2 + 2) % 3, s = e2;
  let l2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  return l2[o][o] = i2 * n2.rot[o][o] - a * n2.rot[o][c2], l2[o][c2] = a * n2.rot[o][o] + i2 * n2.rot[o][c2], l2[o][s] = n2.rot[o][s], l2[c2][o] = i2 * n2.rot[c2][o] - a * n2.rot[c2][c2], l2[c2][c2] = a * n2.rot[c2][o] + i2 * n2.rot[c2][c2], l2[c2][s] = n2.rot[c2][s], l2[s][o] = i2 * n2.rot[s][o] - a * n2.rot[s][c2], l2[s][c2] = a * n2.rot[s][o] + i2 * n2.rot[s][c2], l2[s][s] = n2.rot[s][s], new I0(l2);
}
function Or(n2, e2) {
  e2 = r0(e2);
  const t2 = n2.lat * g2, r3 = n2.lon * g2, i2 = n2.dist * Math.cos(t2);
  return new G2(i2 * Math.cos(r3), i2 * Math.sin(r3), n2.dist * Math.sin(t2), e2);
}
function Lr(n2) {
  const e2 = Hr(n2);
  return new vr(e2.lon / 15, e2.lat, e2.dist, n2);
}
function Hr(n2) {
  const e2 = n2.x * n2.x + n2.y * n2.y, t2 = Math.sqrt(e2 + n2.z * n2.z);
  let r3, i2;
  if (e2 === 0) {
    if (n2.z === 0)
      throw "Zero-length vector not allowed.";
    i2 = 0, r3 = n2.z < 0 ? -90 : 90;
  } else
    i2 = at * Math.atan2(n2.y, n2.x), i2 < 0 && (i2 += 360), r3 = at * Math.atan2(n2.z, Math.sqrt(e2));
  return new Gt(r3, i2, t2);
}
function br(n2) {
  n2 = r0(n2);
  const e2 = bt(n2, V.From2000), t2 = Ut(n2, V.From2000);
  return Pr(e2, t2);
}
var dt;
(function(n2) {
  n2.Penumbral = "penumbral", n2.Partial = "partial", n2.Annular = "annular", n2.Total = "total";
})(dt || (dt = {}));
var ht;
(function(n2) {
  n2[n2.Invalid = 0] = "Invalid", n2[n2.Ascending = 1] = "Ascending", n2[n2.Descending = -1] = "Descending";
})(ht || (ht = {}));
var Vt = class {
  constructor(e2, t2, r3, i2) {
    this.ra = e2, this.dec = t2, this.spin = r3, this.north = i2;
  }
};
function Ur(n2) {
  const e2 = Tr([0, 0, 1], n2, V.Into2000), t2 = Ht(e2, n2, V.Into2000), r3 = new G2(t2[0], t2[1], t2[2], n2), i2 = Lr(r3), a = 190.41375788700253 + 360.9856122880876 * n2.ut;
  return new Vt(i2.ra, i2.dec, a, r3);
}
function Gr(n2, e2) {
  const t2 = r0(e2), r3 = t2.tt, i2 = r3 / 36525;
  let a, o, c2;
  switch (n2) {
    case S2.Sun:
      a = 286.13, o = 63.87, c2 = 84.176 + 14.1844 * r3;
      break;
    case S2.Mercury:
      a = 281.0103 - 0.0328 * i2, o = 61.4155 - 49e-4 * i2, c2 = 329.5988 + 6.1385108 * r3 + 0.01067257 * Math.sin(g2 * (174.7910857 + 4.092335 * r3)) - 112309e-8 * Math.sin(g2 * (349.5821714 + 8.18467 * r3)) - 1104e-7 * Math.sin(g2 * (164.3732571 + 12.277005 * r3)) - 2539e-8 * Math.sin(g2 * (339.1643429 + 16.36934 * r3)) - 571e-8 * Math.sin(g2 * (153.9554286 + 20.461675 * r3));
      break;
    case S2.Venus:
      a = 272.76, o = 67.16, c2 = 160.2 - 1.4813688 * r3;
      break;
    case S2.Earth:
      return Ur(t2);
    case S2.Moon:
      const f2 = g2 * (125.045 - 0.0529921 * r3), v = g2 * (250.089 - 0.1059842 * r3), T2 = g2 * (260.008 + 13.0120009 * r3), E2 = g2 * (176.625 + 13.3407154 * r3), x = g2 * (357.529 + 0.9856003 * r3), y = g2 * (311.589 + 26.4057084 * r3), I2 = g2 * (134.963 + 13.064993 * r3), N2 = g2 * (276.617 + 0.3287146 * r3), b = g2 * (34.226 + 1.7484877 * r3), U2 = g2 * (15.134 - 0.1589763 * r3), z = g2 * (119.743 + 36096e-7 * r3), F = g2 * (239.961 + 0.1643573 * r3), q = g2 * (25.053 + 12.9590088 * r3);
      a = 269.9949 + 31e-4 * i2 - 3.8787 * Math.sin(f2) - 0.1204 * Math.sin(v) + 0.07 * Math.sin(T2) - 0.0172 * Math.sin(E2) + 72e-4 * Math.sin(y) - 52e-4 * Math.sin(U2) + 43e-4 * Math.sin(q), o = 66.5392 + 0.013 * i2 + 1.5419 * Math.cos(f2) + 0.0239 * Math.cos(v) - 0.0278 * Math.cos(T2) + 68e-4 * Math.cos(E2) - 29e-4 * Math.cos(y) + 9e-4 * Math.cos(I2) + 8e-4 * Math.cos(U2) - 9e-4 * Math.cos(q), c2 = 38.3213 + (13.17635815 - 14e-13 * r3) * r3 + 3.561 * Math.sin(f2) + 0.1208 * Math.sin(v) - 0.0642 * Math.sin(T2) + 0.0158 * Math.sin(E2) + 0.0252 * Math.sin(x) - 66e-4 * Math.sin(y) - 47e-4 * Math.sin(I2) - 46e-4 * Math.sin(N2) + 28e-4 * Math.sin(b) + 52e-4 * Math.sin(U2) + 4e-3 * Math.sin(z) + 19e-4 * Math.sin(F) - 44e-4 * Math.sin(q);
      break;
    case S2.Mars:
      a = 317.269202 - 0.10927547 * i2 + 68e-6 * Math.sin(g2 * (198.991226 + 19139.4819985 * i2)) + 238e-6 * Math.sin(g2 * (226.292679 + 38280.8511281 * i2)) + 52e-6 * Math.sin(g2 * (249.663391 + 57420.7251593 * i2)) + 9e-6 * Math.sin(g2 * (266.18351 + 76560.636795 * i2)) + 0.419057 * Math.sin(g2 * (79.398797 + 0.5042615 * i2)), o = 54.432516 - 0.05827105 * i2 + 51e-6 * Math.cos(g2 * (122.433576 + 19139.9407476 * i2)) + 141e-6 * Math.cos(g2 * (43.058401 + 38280.8753272 * i2)) + 31e-6 * Math.cos(g2 * (57.663379 + 57420.7517205 * i2)) + 5e-6 * Math.cos(g2 * (79.476401 + 76560.6495004 * i2)) + 1.591274 * Math.cos(g2 * (166.325722 + 0.5042615 * i2)), c2 = 176.049863 + 350.891982443297 * r3 + 145e-6 * Math.sin(g2 * (129.071773 + 19140.0328244 * i2)) + 157e-6 * Math.sin(g2 * (36.352167 + 38281.0473591 * i2)) + 4e-5 * Math.sin(g2 * (56.668646 + 57420.929536 * i2)) + 1e-6 * Math.sin(g2 * (67.364003 + 76560.2552215 * i2)) + 1e-6 * Math.sin(g2 * (104.79268 + 95700.4387578 * i2)) + 0.584542 * Math.sin(g2 * (95.391654 + 0.5042615 * i2));
      break;
    case S2.Jupiter:
      const Z = g2 * (99.360714 + 4850.4046 * i2), i0 = g2 * (175.895369 + 1191.9605 * i2), a0 = g2 * (300.323162 + 262.5475 * i2), J = g2 * (114.012305 + 6070.2476 * i2), N0 = g2 * (49.511251 + 64.3 * i2);
      a = 268.056595 - 6499e-6 * i2 + 117e-6 * Math.sin(Z) + 938e-6 * Math.sin(i0) + 1432e-6 * Math.sin(a0) + 3e-5 * Math.sin(J) + 215e-5 * Math.sin(N0), o = 64.495303 + 2413e-6 * i2 + 5e-5 * Math.cos(Z) + 404e-6 * Math.cos(i0) + 617e-6 * Math.cos(a0) - 13e-6 * Math.cos(J) + 926e-6 * Math.cos(N0), c2 = 284.95 + 870.536 * r3;
      break;
    case S2.Saturn:
      a = 40.589 - 0.036 * i2, o = 83.537 - 4e-3 * i2, c2 = 38.9 + 810.7939024 * r3;
      break;
    case S2.Uranus:
      a = 257.311, o = -15.175, c2 = 203.81 - 501.1600928 * r3;
      break;
    case S2.Neptune:
      const p0 = g2 * (357.85 + 52.316 * i2);
      a = 299.36 + 0.7 * Math.sin(p0), o = 43.46 - 0.51 * Math.cos(p0), c2 = 249.978 + 541.1397757 * r3 - 0.48 * Math.sin(p0);
      break;
    case S2.Pluto:
      a = 132.993, o = -6.163, c2 = 302.695 + 56.3625225 * r3;
      break;
    default:
      throw `Invalid body: ${n2}`;
  }
  const s = o * g2, l2 = a * g2, h2 = Math.cos(s), m = new G2(h2 * Math.cos(l2), h2 * Math.sin(l2), Math.sin(s), t2);
  return new Vt(a / 15, o, c2, m);
}
var Fr = 1e-3 / It;
var Bt = /* @__PURE__ */ new p2();
var zr = /* @__PURE__ */ new p2();
var kr = /* @__PURE__ */ new p2();
var Wt = /* @__PURE__ */ new D2();
var Vr = /* @__PURE__ */ new D2();
var Br = /* @__PURE__ */ new un();
function P0(n2) {
  return n2 instanceof t0 ? n2 : (
    // Prefer number to be JS timestamp.
    new t0(n2 instanceof Date ? n2 : new Date(n2))
  );
}
function jt(n2, e2 = new p2()) {
  const { x: t2, y: r3, z: i2 } = n2;
  return e2.set(t2, r3, i2);
}
function Wr(n2, e2 = new D2()) {
  const [t2, r3, i2] = n2.rot;
  return e2.set(
    t2[0],
    r3[0],
    i2[0],
    0,
    t2[1],
    r3[1],
    i2[1],
    0,
    t2[2],
    r3[2],
    i2[2],
    0,
    0,
    0,
    0,
    1
  );
}
function Xe(n2, e2 = new D2()) {
  const t2 = P0(n2), r3 = Nr(br(t2), 2, -15 * pr(t2));
  return Wr(r3, e2);
}
function bi(n2, e2 = new D2()) {
  const t2 = P0(n2), r3 = Gr(S2.Moon, t2), i2 = jt(r3.north, Bt), a = xt(r3.spin), c2 = zr.set(0, 0, 1).cross(i2).normalize().applyQuaternion(Br.setFromAxisAngle(i2, a)).normalize(), s = kr.copy(i2).cross(c2).normalize();
  return e2.makeBasis(c2, s, i2);
}
function ue(n2, e2, t2, r3, i2) {
  const a = Ir(n2, e2, false);
  if (jt(a, t2), r3 != null) {
    const o = Xe(e2, Vr).transpose();
    t2.sub(
      Bt.copy(r3).applyMatrix4(o).multiplyScalar(Fr)
    );
  }
  return t2.normalize();
}
function Ui(n2, e2 = new p2(), t2) {
  return ue(S2.Sun, P0(n2), e2, t2);
}
function Gi(n2, e2 = new p2(), t2) {
  return ue(S2.Moon, P0(n2), e2, t2);
}
function Fi(n2, e2 = new p2(), t2) {
  const r3 = P0(n2);
  return ue(S2.Sun, r3, e2, t2).applyMatrix4(
    Xe(r3, Wt)
  );
}
function zi(n2, e2 = new p2(), t2) {
  const r3 = P0(n2);
  return ue(S2.Moon, r3, e2, t2).applyMatrix4(
    Xe(r3, Wt)
  );
}
function Xt(n2) {
  return Math.sqrt(Math.max(n2, 0));
}
function jr(n2) {
  return Math.max(n2, 0);
}
function Xr(n2, e2, t2) {
  const { bottomRadius: r3 } = n2;
  return t2 < 0 && e2 ** 2 * (t2 ** 2 - 1) + r3 ** 2 >= 0;
}
function Yr(n2, e2, t2) {
  const { topRadius: r3 } = n2, i2 = e2 ** 2 * (t2 ** 2 - 1) + r3 ** 2;
  return jr(-e2 * t2 + Xt(i2));
}
function ne(n2, e2) {
  return 0.5 / e2 + n2 * (1 - 1 / e2);
}
var Kr = /* @__PURE__ */ new p2();
var mt = /* @__PURE__ */ new p2();
var $r = /* @__PURE__ */ new p2();
var ft = /* @__PURE__ */ new WeakMap();
function qr(n2) {
  be(n2.image);
  let e2 = nt(n2.image.data) ? n2.image.data : nt(n2.userData.imageData) ? n2.userData.imageData : void 0;
  if (n2.type === k && e2 instanceof Uint16Array) {
    const t2 = ft.get(e2.buffer);
    t2 == null ? (e2 = new Mt(e2.buffer), ft.set(e2.buffer, e2)) : e2 = t2;
  }
  return e2;
}
function J0(n2, e2, t2) {
  const r3 = e2 * 4;
  return t2.set(n2[r3], n2[r3 + 1], n2[r3 + 2]);
}
function Yt(n2, e2, t2) {
  const r3 = qr(n2);
  if (r3 == null)
    return t2.setScalar(0);
  be(n2.image);
  const { width: i2, height: a } = n2.image, o = tt(e2.x, 0, 1) * (i2 - 1), c2 = tt(e2.y, 0, 1) * (a - 1), s = Math.floor(o), l2 = Math.floor(c2), h2 = o - s, m = c2 - l2, f2 = h2, v = m, T2 = s % i2, E2 = (T2 + 1) % i2, x = l2 % a, y = (x + 1) % a, I2 = J0(r3, x * i2 + T2, Kr), N2 = J0(r3, x * i2 + E2, mt), b = I2.lerp(N2, f2), U2 = J0(r3, y * i2 + T2, mt), z = J0(r3, y * i2 + E2, $r), F = U2.lerp(z, f2);
  return t2.copy(b.lerp(F, v));
}
function Zr(n2, e2, t2, r3) {
  const { topRadius: i2, bottomRadius: a } = n2, o = Math.sqrt(i2 ** 2 - a ** 2), c2 = Xt(e2 ** 2 - a ** 2), s = Yr(n2, e2, t2), l2 = i2 - e2, h2 = c2 + o, m = (s - l2) / (h2 - l2), f2 = c2 / o;
  return r3.set(
    ne(m, C),
    ne(f2, p)
  );
}
var Jr = /* @__PURE__ */ new p2();
var ve = /* @__PURE__ */ new p2();
var Qr = /* @__PURE__ */ new oe();
function ei(n2, e2, t2, r3 = new ae(), {
  ellipsoid: i2 = F0.WGS84,
  correctAltitude: a = true
} = {}, o = n0.DEFAULT) {
  const c2 = Jr.copy(e2);
  if (a) {
    const T2 = i2.projectOnSurface(
      e2,
      ve
    );
    T2 != null && c2.sub(
      i2.getOsculatingSphereCenter(
        T2,
        o.bottomRadius,
        ve
      )
    );
  }
  const s = ve;
  let l2 = c2.length(), h2 = c2.dot(t2);
  const { topRadius: m } = o, f2 = -h2 - Math.sqrt(h2 ** 2 - l2 ** 2 + m ** 2);
  if (f2 > 0 && (l2 = m, h2 += f2), l2 > m)
    s.set(1, 1, 1);
  else {
    const T2 = h2 / l2;
    if (Xr(o, l2, T2))
      s.setScalar(0);
    else {
      const x = Zr(o, l2, T2, Qr);
      Yt(n2, x, s);
    }
  }
  const v = s.multiply(o.solarIrradiance).multiply(o.sunRadianceToRelativeLuminance);
  return r3.setFromVector3(v);
}
var ti = `// Based on: https://github.com/pmndrs/postprocessing/blob/v6.37.4/src/materials/glsl/depth-mask.frag

#include <common>
#include <packing>

#include "core/depth"

#ifdef GL_FRAGMENT_PRECISION_HIGH
uniform highp sampler2D depthBuffer0;
uniform highp sampler2D depthBuffer1;
#else // GL_FRAGMENT_PRECISION_HIGH
uniform mediump sampler2D depthBuffer0;
uniform mediump sampler2D depthBuffer1;
#endif // GL_FRAGMENT_PRECISION_HIGH

uniform sampler2D inputBuffer;
uniform vec2 cameraNearFar;
uniform bool inverted;

float getViewZ(const float depth) {
  #ifdef PERSPECTIVE_CAMERA
  return perspectiveDepthToViewZ(depth, cameraNearFar.x, cameraNearFar.y);
  #else // PERSPECTIVE_CAMERA
  return orthographicDepthToViewZ(depth, cameraNearFar.x, cameraNearFar.y);
  #endif // PERSPECTIVE_CAMERA
}

varying vec2 vUv;

void main() {
  vec2 depth;

  #if DEPTH_PACKING_0 == 3201
  depth.x = unpackRGBAToDepth(texture2D(depthBuffer0, vUv));
  #else // DEPTH_PACKING_0 == 3201
  depth.x = reverseLogDepth(texture2D(depthBuffer0, vUv).r, cameraNearFar.x, cameraNearFar.y);
  #endif // DEPTH_PACKING_0 == 3201

  #if DEPTH_PACKING_1 == 3201
  depth.y = unpackRGBAToDepth(texture2D(depthBuffer1, vUv));
  #else // DEPTH_PACKING_1 == 3201
  depth.y = reverseLogDepth(texture2D(depthBuffer1, vUv).r, cameraNearFar.x, cameraNearFar.y);
  #endif // DEPTH_PACKING_1 == 3201

  bool isMaxDepth = depth.x == 1.0;

  #ifdef PERSPECTIVE_CAMERA
  depth.x = viewZToOrthographicDepth(getViewZ(depth.x), cameraNearFar.x, cameraNearFar.y);
  depth.y = viewZToOrthographicDepth(getViewZ(depth.y), cameraNearFar.x, cameraNearFar.y);
  #endif // PERSPECTIVE_CAMERA

  #if DEPTH_TEST_STRATEGY == 0
  // Decide based on depth test.
  bool keep = depthTest(depth.x, depth.y);

  #elif DEPTH_TEST_STRATEGY == 1
  // Always keep max depth.
  bool keep = isMaxDepth || depthTest(depth.x, depth.y);

  #else // DEPTH_TEST_STRATEGY
  // Always discard max depth.
  bool keep = !isMaxDepth && depthTest(depth.x, depth.y);

  #endif // DEPTH_TEST_STRATEGY

  if (inverted) {
    keep = !keep;
  }
  if (keep) {
    gl_FragColor = texture2D(inputBuffer, vUv);
  } else {
    discard;
  }
}
`;
var ki = class extends tn {
  constructor(e2, t2) {
    super("LightingMaskPass"), this.selection = new nn(), this.needsSwap = false, this.needsDepthTexture = true, this.renderPass = new rn(e2, t2, new ln()), this.renderPass.ignoreBackground = true, this.renderPass.skipShadowMapUpdate = true, this.renderPass.selection = this.selection, this.depthTexture = new dn(1, 1, hn), this.renderTarget = new Et(1, 1, {
      format: mn,
      depthTexture: this.depthTexture
    }), this.depthCopyPass0 = new Ze({ depthPacking: X0 }), this.depthCopyPass1 = new Ze({ depthPacking: X0 }), this.clearPass = new an(true, false, false), this.clearPass.overrideClearColor = new ae(16777215), this.clearPass.overrideClearAlpha = 1;
    const r3 = new on();
    r3.fragmentShader = W(ti, {
      core: { depth: yt }
    }), r3.uniforms.inverted = new d2(false), r3.copyCameraSettings(t2), r3.depthBuffer0 = this.depthCopyPass0.texture, r3.depthPacking0 = X0, r3.depthBuffer1 = this.depthCopyPass1.texture, r3.depthPacking1 = X0, r3.depthMode = fn, r3.maxDepthStrategy = sn.DISCARD_MAX_DEPTH, this.depthMaskMaterial = r3, this.depthMaskPass = new cn(r3);
  }
  // eslint-disable-next-line accessor-pairs
  set mainScene(e2) {
    this.renderPass.mainScene = e2;
  }
  // eslint-disable-next-line accessor-pairs
  set mainCamera(e2) {
    this.renderPass.mainCamera = e2, this.depthMaskMaterial.copyCameraSettings(e2);
  }
  initialize(e2, t2, r3) {
    this.renderPass.initialize(e2, t2, r3), this.clearPass.initialize(e2, t2, r3), this.depthMaskPass.initialize(e2, t2, r3);
  }
  setDepthTexture(e2, t2 = gn) {
    this.depthCopyPass0.setDepthTexture(e2, t2), this.depthCopyPass1.setDepthTexture(this.depthTexture, t2);
  }
  render(e2, t2, r3, i2, a) {
    const o = e2.autoClear;
    e2.autoClear = false, this.depthCopyPass0.render(e2, null, null), this.renderPass.render(e2, this.renderTarget, null), this.depthCopyPass1.render(e2, null, null), this.clearPass.render(e2, this.renderTarget, null), this.depthMaskPass.render(e2, null, this.renderTarget), e2.autoClear = o;
  }
  setSize(e2, t2) {
    this.renderTarget.setSize(e2, t2), this.depthCopyPass0.setSize(e2, t2), this.depthCopyPass1.setSize(e2, t2);
  }
  get texture() {
    return this.renderTarget.texture;
  }
  get selectionLayer() {
    return this.selection.layer;
  }
  set selectionLayer(e2) {
    this.selection.layer = e2;
  }
  get inverted() {
    return this.depthMaskMaterial.uniforms.inverted.value;
  }
  set inverted(e2) {
    this.depthMaskMaterial.uniforms.inverted.value = e2;
  }
};
var ni = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

uniform sampler2D transmittanceTexture;

layout(location = 0) out vec4 outputColor;

void main() {
  vec3 deltaIrradiance;
  vec3 irradiance;
  deltaIrradiance = ComputeDirectIrradianceTexture(
    ATMOSPHERE,
    transmittanceTexture,
    gl_FragCoord.xy
  );
  irradiance = vec3(0.0);
  outputColor = vec4(OUTPUT, 1.0);
}
`;
var ri = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

uniform mat3 luminanceFromRadiance;
uniform sampler3D singleRayleighScatteringTexture;
uniform sampler3D singleMieScatteringTexture;
uniform sampler3D multipleScatteringTexture;
uniform int scatteringOrder;

layout(location = 0) out vec4 outputColor;

void main() {
  vec3 deltaIrradiance;
  vec3 irradiance;
  deltaIrradiance = ComputeIndirectIrradianceTexture(
    ATMOSPHERE,
    singleRayleighScatteringTexture,
    singleMieScatteringTexture,
    multipleScatteringTexture,
    gl_FragCoord.xy,
    scatteringOrder
  );
  irradiance = luminanceFromRadiance * deltaIrradiance;
  outputColor = vec4(OUTPUT, 1.0);
}
`;
var ii = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

uniform mat3 luminanceFromRadiance;
uniform sampler2D transmittanceTexture;
uniform sampler3D scatteringDensityTexture;
uniform int layer;

layout(location = 0) out vec4 outputColor;

void main() {
  vec4 deltaMultipleScattering;
  vec4 scattering;
  float nu;
  deltaMultipleScattering.rgb = ComputeMultipleScatteringTexture(
    ATMOSPHERE,
    transmittanceTexture,
    scatteringDensityTexture,
    vec3(gl_FragCoord.xy, float(layer) + 0.5),
    nu
  );
  deltaMultipleScattering.a = 1.0;
  scattering = vec4(
    luminanceFromRadiance * deltaMultipleScattering.rgb / RayleighPhaseFunction(nu),
    0.0
  );
  outputColor = OUTPUT;
}
`;
var ai = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

uniform sampler2D transmittanceTexture;
uniform sampler3D singleRayleighScatteringTexture;
uniform sampler3D singleMieScatteringTexture;
uniform sampler3D multipleScatteringTexture;
uniform sampler2D irradianceTexture;
uniform int scatteringOrder;
uniform int layer;

layout(location = 0) out vec4 scatteringDensity;

void main() {
  scatteringDensity.rgb = ComputeScatteringDensityTexture(
    ATMOSPHERE,
    transmittanceTexture,
    singleRayleighScatteringTexture,
    singleMieScatteringTexture,
    multipleScatteringTexture,
    irradianceTexture,
    vec3(gl_FragCoord.xy, float(layer) + 0.5),
    scatteringOrder
  );
  scatteringDensity.a = 1.0;
}
`;
var oi = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

uniform mat3 luminanceFromRadiance;
uniform sampler2D transmittanceTexture;
uniform int layer;

layout(location = 0) out vec4 outputColor;

void main() {
  vec4 deltaRayleigh;
  vec4 deltaMie;
  vec4 scattering;
  vec4 singleMieScattering;
  ComputeSingleScatteringTexture(
    ATMOSPHERE,
    transmittanceTexture,
    vec3(gl_FragCoord.xy, float(layer) + 0.5),
    deltaRayleigh.rgb,
    deltaMie.rgb
  );
  deltaRayleigh.a = 1.0;
  deltaMie.a = 1.0;
  scattering = vec4(
    luminanceFromRadiance * deltaRayleigh.rgb,
    (luminanceFromRadiance * deltaMie.rgb).r
  );
  singleMieScattering.rgb = luminanceFromRadiance * deltaMie.rgb;
  singleMieScattering.a = 1.0;
  outputColor = OUTPUT;
}
`;
var si = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"
#include "bruneton/common"
#include "bruneton/precompute"

uniform AtmosphereParameters ATMOSPHERE;

layout(location = 0) out vec4 transmittance;

void main() {
  transmittance.rgb = ComputeTransmittanceToTopAtmosphereBoundaryTexture(
    ATMOSPHERE,
    gl_FragCoord.xy
  );
  transmittance.a = 1.0;
}
`;
var ci = (
  /* glsl */
  `
  precision highp float;
  in vec2 position;
  void main() {
    gl_Position = vec4(position, 1.0, 1.0);
  }
`
);
function re(n2, e2, t2) {
  const r3 = new Et(e2, t2, {
    depthBuffer: false,
    type: n2,
    format: Rt
  }), i2 = r3.texture;
  return i2.minFilter = D0, i2.magFilter = D0, i2.wrapS = U0, i2.wrapT = U0, i2.colorSpace = _t, r3;
}
function C0(n2, e2, t2, r3) {
  const i2 = new Rn(e2, t2, r3, {
    depthBuffer: false,
    type: n2,
    format: Rt
  }), a = i2.texture;
  return a.minFilter = D0, a.magFilter = D0, a.wrapS = U0, a.wrapT = U0, a.wrapR = U0, a.colorSpace = _t, i2;
}
function ui(n2) {
  const e2 = n2[Symbol.iterator]();
  return new Promise((t2, r3) => {
    const i2 = () => {
      try {
        const { value: a, done: o } = e2.next();
        o === true ? t2(a) : H(i2);
      } catch (a) {
        r3(a instanceof Error ? a : new Error());
      }
    };
    H(i2);
  });
}
async function gt(n2, e2, t2) {
  const { width: r3, height: i2 } = e2, a = t2.type === k ? new Uint16Array(r3 * i2 * 4) : new Float32Array(r3 * i2 * 4);
  await n2.readRenderTargetPixelsAsync(
    e2,
    0,
    0,
    e2.width,
    e2.height,
    a
  ), t2.userData.imageData = a;
}
var li = class {
  constructor(e2) {
    this.lambdas = new p2(), this.luminanceFromRadiance = new w0(), e2 === k && (this.opticalDepth = re(
      e2,
      C,
      p
    )), this.deltaIrradiance = re(
      e2,
      f,
      A
    ), this.deltaRayleighScattering = C0(
      e2,
      U,
      g,
      N
    ), this.deltaMieScattering = C0(
      e2,
      U,
      g,
      N
    ), this.deltaScatteringDensity = C0(
      e2,
      U,
      g,
      N
    ), this.deltaMultipleScattering = this.deltaRayleighScattering;
  }
  dispose() {
    this.opticalDepth?.dispose(), this.deltaIrradiance.dispose(), this.deltaRayleighScattering.dispose(), this.deltaMieScattering.dispose(), this.deltaScatteringDensity.dispose();
  }
};
var R0 = class extends vt {
  constructor(e2) {
    super({
      glslVersion: He,
      vertexShader: ci,
      ...e2,
      defines: {
        TRANSMITTANCE_TEXTURE_WIDTH: C.toFixed(0),
        TRANSMITTANCE_TEXTURE_HEIGHT: p.toFixed(0),
        SCATTERING_TEXTURE_R_SIZE: i.toFixed(0),
        SCATTERING_TEXTURE_MU_SIZE: _.toFixed(0),
        SCATTERING_TEXTURE_MU_S_SIZE: R.toFixed(0),
        SCATTERING_TEXTURE_NU_SIZE: u.toFixed(0),
        IRRADIANCE_TEXTURE_WIDTH: f.toFixed(0),
        IRRADIANCE_TEXTURE_HEIGHT: A.toFixed(0),
        ...e2.defines
      }
    });
  }
  // eslint-disable-next-line accessor-pairs
  set additive(e2) {
    this.transparent = e2, this.blending = e2 ? vn : En, this.blendEquation = Je, this.blendEquationAlpha = Je, this.blendSrc = Y0, this.blendDst = Y0, this.blendSrcAlpha = Y0, this.blendDstAlpha = Y0;
  }
  setUniforms(e2) {
    const t2 = this.uniforms;
    t2.luminanceFromRadiance != null && t2.luminanceFromRadiance.value.copy(e2.luminanceFromRadiance), t2.singleRayleighScatteringTexture != null && (t2.singleRayleighScatteringTexture.value = e2.deltaRayleighScattering.texture), t2.singleMieScatteringTexture != null && (t2.singleMieScatteringTexture.value = e2.deltaMieScattering.texture), t2.multipleScatteringTexture != null && (t2.multipleScatteringTexture.value = e2.deltaMultipleScattering.texture), t2.scatteringDensityTexture != null && (t2.scatteringDensityTexture.value = e2.deltaScatteringDensity.texture), t2.irradianceTexture != null && (t2.irradianceTexture.value = e2.deltaIrradiance.texture);
  }
};
var Vi = class {
  constructor(e2, {
    type: t2 = At(e2) ? _e : k,
    combinedScattering: r3 = true,
    higherOrderScattering: i2 = true
  } = {}) {
    this.transmittanceMaterial = new R0({
      fragmentShader: W(si, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      })
    }), this.directIrradianceMaterial = new R0({
      fragmentShader: W(ni, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      }),
      uniforms: {
        transmittanceTexture: new d2(null)
      }
    }), this.singleScatteringMaterial = new R0({
      fragmentShader: W(oi, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      }),
      uniforms: {
        luminanceFromRadiance: new d2(new w0()),
        transmittanceTexture: new d2(null),
        layer: new d2(0)
      }
    }), this.scatteringDensityMaterial = new R0({
      fragmentShader: W(ai, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      }),
      uniforms: {
        transmittanceTexture: new d2(null),
        singleRayleighScatteringTexture: new d2(null),
        singleMieScatteringTexture: new d2(null),
        multipleScatteringTexture: new d2(null),
        irradianceTexture: new d2(null),
        scatteringOrder: new d2(0),
        layer: new d2(0)
      }
    }), this.indirectIrradianceMaterial = new R0({
      fragmentShader: W(ri, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      }),
      uniforms: {
        luminanceFromRadiance: new d2(new w0()),
        singleRayleighScatteringTexture: new d2(null),
        singleMieScatteringTexture: new d2(null),
        multipleScatteringTexture: new d2(null),
        scatteringOrder: new d2(0)
      }
    }), this.multipleScatteringMaterial = new R0({
      fragmentShader: W(ii, {
        bruneton: {
          common: e,
          definitions: t,
          precompute: r2
        }
      }),
      uniforms: {
        luminanceFromRadiance: new d2(new w0()),
        transmittanceTexture: new d2(null),
        scatteringDensityTexture: new d2(null),
        layer: new d2(0)
      }
    }), this.mesh = new pn(new Tn(2, 2)), this.scene = new Sn().add(this.mesh), this.camera = new St(), this.updating = false, this.renderer = e2, this.type = t2, this.transmittanceRenderTarget = re(
      t2,
      C,
      p
    ), this.scatteringRenderTarget = C0(
      t2,
      U,
      g,
      N
    ), this.irradianceRenderTarget = re(
      t2,
      f,
      A
    ), r3 || (this.singleMieScatteringRenderTarget = C0(
      t2,
      U,
      g,
      N
    )), i2 && (this.higherOrderScatteringRenderTarget = C0(
      t2,
      U,
      g,
      N
    )), this.textures = {
      transmittanceTexture: this.transmittanceRenderTarget.texture,
      scatteringTexture: this.scatteringRenderTarget.texture,
      irradianceTexture: this.irradianceRenderTarget.texture,
      singleMieScatteringTexture: this.singleMieScatteringRenderTarget?.texture,
      higherOrderScatteringTexture: this.higherOrderScatteringRenderTarget?.texture
    };
  }
  render3DRenderTarget(e2, t2) {
    for (let r3 = 0; r3 < e2.depth; ++r3)
      t2.uniforms.layer.value = r3, this.renderer.setRenderTarget(e2, r3), this.renderer.render(this.scene, this.camera);
  }
  computeTransmittance(e2) {
    const t2 = this.transmittanceMaterial;
    delete t2.defines.TRANSMITTANCE_PRECISION_LOG, t2.needsUpdate = true, this.mesh.material = t2, this.renderer.setRenderTarget(e2.renderTarget), this.renderer.render(this.scene, this.camera);
  }
  computeOpticalDepth(e2) {
    const t2 = this.transmittanceMaterial;
    t2.defines.TRANSMITTANCE_PRECISION_LOG = "1", t2.needsUpdate = true, this.mesh.material = t2, this.renderer.setRenderTarget(e2.renderTarget), this.renderer.render(this.scene, this.camera);
  }
  computeDirectIrradiance(e2) {
    const t2 = this.directIrradianceMaterial;
    t2.defines.OUTPUT = e2.output, t2.additive = e2.additive, this.type === k ? t2.defines.TRANSMITTANCE_PRECISION_LOG = "1" : delete t2.defines.TRANSMITTANCE_PRECISION_LOG, t2.needsUpdate = true;
    const r3 = t2.uniforms;
    r3.transmittanceTexture.value = e2.context.opticalDepth?.texture ?? this.transmittanceRenderTarget.texture, this.mesh.material = t2, this.renderer.setRenderTarget(e2.renderTarget), this.renderer.render(this.scene, this.camera);
  }
  computeSingleScattering(e2) {
    const t2 = this.singleScatteringMaterial;
    t2.defines.OUTPUT = e2.output, t2.additive = e2.additive, this.type === k ? t2.defines.TRANSMITTANCE_PRECISION_LOG = "1" : delete t2.defines.TRANSMITTANCE_PRECISION_LOG, t2.needsUpdate = true;
    const r3 = t2.uniforms;
    r3.transmittanceTexture.value = e2.context.opticalDepth?.texture ?? this.transmittanceRenderTarget.texture, t2.setUniforms(e2.context), this.mesh.material = t2, this.render3DRenderTarget(e2.renderTarget, t2);
  }
  computeScatteringDensity(e2) {
    const t2 = this.scatteringDensityMaterial;
    this.type === k ? t2.defines.TRANSMITTANCE_PRECISION_LOG = "1" : delete t2.defines.TRANSMITTANCE_PRECISION_LOG, t2.needsUpdate = true;
    const r3 = t2.uniforms;
    r3.transmittanceTexture.value = e2.context.opticalDepth?.texture ?? this.transmittanceRenderTarget.texture, r3.scatteringOrder.value = e2.scatteringOrder, t2.setUniforms(e2.context), this.mesh.material = t2, this.render3DRenderTarget(e2.renderTarget, t2);
  }
  computeIndirectIrradiance(e2) {
    const t2 = this.indirectIrradianceMaterial;
    t2.defines.OUTPUT = e2.output, t2.additive = e2.additive, t2.needsUpdate = true;
    const r3 = t2.uniforms;
    r3.scatteringOrder.value = e2.scatteringOrder - 1, t2.setUniforms(e2.context), this.mesh.material = t2, this.renderer.setRenderTarget(e2.renderTarget), this.renderer.render(this.scene, this.camera);
  }
  computeMultipleScattering(e2) {
    const t2 = this.multipleScatteringMaterial;
    t2.defines.OUTPUT = e2.output, t2.additive = e2.additive, this.type === k ? t2.defines.TRANSMITTANCE_PRECISION_LOG = "1" : delete t2.defines.TRANSMITTANCE_PRECISION_LOG, t2.needsUpdate = true;
    const r3 = t2.uniforms;
    r3.transmittanceTexture.value = e2.context.opticalDepth?.texture ?? this.transmittanceRenderTarget.texture, t2.setUniforms(e2.context), this.mesh.material = t2, this.render3DRenderTarget(e2.renderTarget, t2);
  }
  *precompute(e2, t2) {
    this.computeTransmittance({
      renderTarget: this.transmittanceRenderTarget
    }), this.type === k && (G(e2.opticalDepth != null), this.computeOpticalDepth({
      renderTarget: e2.opticalDepth
    })), this.computeDirectIrradiance({
      renderTarget: e2.deltaIrradiance,
      context: e2,
      output: "deltaIrradiance",
      additive: false
    }), this.computeDirectIrradiance({
      renderTarget: this.irradianceRenderTarget,
      context: e2,
      output: "irradiance",
      additive: t2
    }), this.renderer.setRenderTarget(null), yield, this.computeSingleScattering({
      renderTarget: e2.deltaRayleighScattering,
      context: e2,
      output: "deltaRayleigh",
      additive: false
    }), this.computeSingleScattering({
      renderTarget: e2.deltaMieScattering,
      context: e2,
      output: "deltaMie",
      additive: false
    }), this.computeSingleScattering({
      renderTarget: this.scatteringRenderTarget,
      context: e2,
      output: "scattering",
      additive: t2
    }), this.singleMieScatteringRenderTarget != null && this.computeSingleScattering({
      renderTarget: this.singleMieScatteringRenderTarget,
      context: e2,
      output: "singleMieScattering",
      additive: t2
    }), this.renderer.setRenderTarget(null), yield;
    for (let r3 = 2; r3 <= 4; ++r3)
      this.computeScatteringDensity({
        renderTarget: e2.deltaScatteringDensity,
        context: e2,
        scatteringOrder: r3
      }), this.computeIndirectIrradiance({
        renderTarget: e2.deltaIrradiance,
        context: e2,
        scatteringOrder: r3,
        output: "deltaIrradiance",
        additive: false
      }), this.computeIndirectIrradiance({
        renderTarget: this.irradianceRenderTarget,
        context: e2,
        scatteringOrder: r3,
        output: "irradiance",
        additive: true
      }), this.computeMultipleScattering({
        renderTarget: e2.deltaMultipleScattering,
        context: e2,
        output: "deltaMultipleScattering",
        additive: false
      }), this.computeMultipleScattering({
        renderTarget: this.scatteringRenderTarget,
        context: e2,
        output: "scattering",
        additive: true
      }), this.higherOrderScatteringRenderTarget != null && this.computeMultipleScattering({
        renderTarget: this.higherOrderScatteringRenderTarget,
        context: e2,
        output: "scattering",
        additive: true
      }), this.renderer.setRenderTarget(null), yield;
  }
  async update(e2 = n0.DEFAULT) {
    this.updating = true;
    const t2 = e2.toUniform();
    this.transmittanceMaterial.uniforms.ATMOSPHERE = t2, this.directIrradianceMaterial.uniforms.ATMOSPHERE = t2, this.singleScatteringMaterial.uniforms.ATMOSPHERE = t2, this.scatteringDensityMaterial.uniforms.ATMOSPHERE = t2, this.indirectIrradianceMaterial.uniforms.ATMOSPHERE = t2, this.multipleScatteringMaterial.uniforms.ATMOSPHERE = t2;
    const r3 = this.renderer, i2 = new li(this.type);
    i2.lambdas.set(680, 550, 440), i2.luminanceFromRadiance.identity();
    const a = r3.autoClear;
    return r3.autoClear = false, await ui(this.precompute(i2, false)), r3.autoClear = a, i2.dispose(), await gt(
      this.renderer,
      this.transmittanceRenderTarget,
      this.transmittanceRenderTarget.texture
    ), await gt(
      this.renderer,
      this.irradianceRenderTarget,
      this.irradianceRenderTarget.texture
    ), this.updating = false, this.disposeQueue?.(), this.textures;
  }
  dispose(e2 = {}) {
    if (this.updating) {
      this.disposeQueue = () => {
        this.dispose(e2), this.disposeQueue = void 0;
      };
      return;
    }
    const { textures: t2 = true } = e2;
    t2 || (this.transmittanceRenderTarget.textures.splice(0, 1), this.scatteringRenderTarget.textures.splice(0, 1), this.irradianceRenderTarget.textures.splice(0, 1), this.singleMieScatteringRenderTarget?.textures.splice(0, 1), this.higherOrderScatteringRenderTarget?.textures.splice(0, 1)), this.transmittanceRenderTarget.dispose(), this.scatteringRenderTarget.dispose(), this.irradianceRenderTarget.dispose(), this.singleMieScatteringRenderTarget?.dispose(), this.higherOrderScatteringRenderTarget?.dispose(), this.transmittanceMaterial.dispose(), this.directIrradianceMaterial.dispose(), this.singleScatteringMaterial.dispose(), this.scatteringDensityMaterial.dispose(), this.indirectIrradianceMaterial.dispose(), this.multipleScatteringMaterial.dispose(), this.mesh.geometry.dispose();
  }
};
function di(n2) {
  var e2 = [];
  if (n2.length === 0)
    return "";
  if (typeof n2[0] != "string")
    throw new TypeError("Url must be a string. Received " + n2[0]);
  if (n2[0].match(/^[^/:]+:\/*$/) && n2.length > 1) {
    var t2 = n2.shift();
    n2[0] = t2 + n2[0];
  }
  n2[0].match(/^file:\/\/\//) ? n2[0] = n2[0].replace(/^([^/:]+):\/*/, "$1:///") : n2[0] = n2[0].replace(/^([^/:]+):\/*/, "$1://");
  for (var r3 = 0; r3 < n2.length; r3++) {
    var i2 = n2[r3];
    if (typeof i2 != "string")
      throw new TypeError("Url must be a string. Received " + i2);
    i2 !== "" && (r3 > 0 && (i2 = i2.replace(/^[\/]+/, "")), r3 < n2.length - 1 ? i2 = i2.replace(/[\/]+$/, "") : i2 = i2.replace(/[\/]+$/, "/"), e2.push(i2));
  }
  var a = e2.join("/");
  a = a.replace(/\/(\?|&|#[^!])/g, "$1");
  var o = a.split("?");
  return a = o.shift() + (o.length > 0 ? "?" : "") + o.join("&"), a;
}
function hi() {
  var n2;
  return typeof arguments[0] == "object" ? n2 = arguments[0] : n2 = [].slice.call(arguments), di(n2);
}
var pt = {
  width: C,
  height: p
};
var _0 = {
  width: U,
  height: g,
  depth: N
};
var Tt = {
  width: f,
  height: A
};
var Bi = class extends _n {
  constructor({
    format: e2 = "exr",
    type: t2 = k,
    combinedScattering: r3 = true,
    higherOrderScattering: i2 = true
  } = {}, a) {
    super(a), this.format = e2, this.type = t2, this.combinedScattering = r3, this.higherOrderScattering = i2;
  }
  setType(e2) {
    return this.type = At(e2) ? _e : k, this;
  }
  load(e2, t2, r3, i2) {
    const a = {}, o = ({
      key: c2,
      loader: s,
      path: l2
    }) => (s.setRequestHeader(this.requestHeader), s.setPath(this.path), s.setWithCredentials(this.withCredentials), s.load(
      hi(e2, l2),
      (h2) => {
        h2.type = this.type, this.type === _e && (be(h2.image), h2.image.data != null && (h2.image.data = new Float32Array(
          new Mt(h2.image.data?.buffer)
        ))), h2.minFilter = D0, h2.magFilter = D0, a[`${c2}Texture`] = h2, a.irradianceTexture != null && a.scatteringTexture != null && a.transmittanceTexture != null && (this.combinedScattering || a.singleMieScatteringTexture != null) && (!this.higherOrderScattering || a.higherOrderScatteringTexture != null) && t2?.(a);
      },
      r3,
      i2
    ));
    return this.format === "exr" ? {
      transmittanceTexture: o({
        key: "transmittance",
        loader: new rt(pt, this.manager),
        path: "transmittance.exr"
      }),
      scatteringTexture: o({
        key: "scattering",
        loader: new Te(_0, this.manager),
        path: "scattering.exr"
      }),
      irradianceTexture: o({
        key: "irradiance",
        loader: new rt(Tt, this.manager),
        path: "irradiance.exr"
      }),
      singleMieScatteringTexture: this.combinedScattering ? void 0 : o({
        key: "singleMieScattering",
        loader: new Te(_0, this.manager),
        path: "single_mie_scattering.exr"
      }),
      higherOrderScatteringTexture: this.higherOrderScattering ? o({
        key: "higherOrderScattering",
        loader: new Te(_0, this.manager),
        path: "higher_order_scattering.exr"
      }) : void 0
    } : {
      transmittanceTexture: o({
        key: "transmittance",
        loader: new O0(
          Qe,
          L0,
          pt,
          this.manager
        ),
        path: "transmittance.bin"
      }),
      scatteringTexture: o({
        key: "scattering",
        loader: new O0(
          ge,
          L0,
          _0,
          this.manager
        ),
        path: "scattering.bin"
      }),
      irradianceTexture: o({
        key: "irradiance",
        loader: new O0(
          Qe,
          L0,
          Tt,
          this.manager
        ),
        path: "irradiance.bin"
      }),
      singleMieScatteringTexture: this.combinedScattering ? void 0 : o({
        key: "singleMieScattering",
        loader: new O0(
          ge,
          L0,
          _0,
          this.manager
        ),
        path: "single_mie_scattering.bin"
      }),
      higherOrderScatteringTexture: this.higherOrderScattering ? o({
        key: "higherOrderScattering",
        loader: new O0(
          ge,
          L0,
          _0,
          this.manager
        ),
        path: "higher_order_scattering.bin"
      }) : void 0
    };
  }
};
function mi({ topRadius: n2, bottomRadius: e2 }, t2, r3, i2) {
  const a = (t2 - e2) / (n2 - e2), o = r3 * 0.5 + 0.5;
  return i2.set(
    ne(o, f),
    ne(a, A)
  );
}
var fi = 1 / Math.sqrt(Math.PI);
var Ee = Math.sqrt(3) / (2 * Math.sqrt(Math.PI));
var gi = /* @__PURE__ */ new p2();
var Re = /* @__PURE__ */ new p2();
var pi = /* @__PURE__ */ new oe();
var Ti = /* @__PURE__ */ new w0();
var Si = {
  ellipsoid: F0.WGS84,
  correctAltitude: true
};
var Wi = class extends xn {
  constructor(e2, t2 = n0.DEFAULT) {
    super(), this.atmosphere = t2, this.worldToECEFMatrix = new D2();
    const {
      irradianceTexture: r3 = null,
      ellipsoid: i2,
      correctAltitude: a,
      sunDirection: o
    } = { ...Si, ...e2 };
    this.irradianceTexture = r3, this.ellipsoid = i2, this.correctAltitude = a, this.sunDirection = o?.clone() ?? new p2();
  }
  update() {
    if (this.irradianceTexture == null)
      return;
    const e2 = this.worldToECEFMatrix, t2 = Ti.setFromMatrix4(e2).transpose(), i2 = this.getWorldPosition(gi).applyMatrix4(e2);
    if (this.correctAltitude) {
      const m = this.ellipsoid.projectOnSurface(
        i2,
        Re
      );
      m != null && i2.add(
        X(
          m,
          this.atmosphere.bottomRadius,
          this.ellipsoid,
          Re
        )
      );
    }
    const a = i2.length(), o = i2.dot(this.sunDirection) / a, c2 = mi(this.atmosphere, a, o, pi), s = Yt(this.irradianceTexture, c2, Re);
    s.multiply(this.atmosphere.skyRadianceToRelativeLuminance);
    const l2 = this.ellipsoid.getSurfaceNormal(i2).applyMatrix3(t2), h2 = this.sh.coefficients;
    h2[0].copy(s).multiplyScalar(fi), h2[1].copy(s).multiplyScalar(Ee * l2.y), h2[2].copy(s).multiplyScalar(Ee * l2.z), h2[3].copy(s).multiplyScalar(Ee * l2.x);
  }
};
var vi = `precision highp float;
precision highp sampler3D;

#define RECIPROCAL_PI 0.3183098861837907

#include "core/raySphereIntersection"

#include "bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform vec3 sunDirection;
uniform float cosSunAngularRadius;
uniform vec3 moonDirection;
uniform float moonAngularRadius;
uniform float lunarRadianceScale;
uniform vec3 groundAlbedo;

#include "sky"

#ifdef HAS_SHADOW_LENGTH
uniform sampler2D shadowLengthBuffer;
#endif // HAS_SHADOW_LENGTH

in vec2 vUv;
in vec3 vCameraPosition;
in vec3 vRayDirection;

layout(location = 0) out vec4 outputColor;

#include <mrt_layout>

void main() {
  float shadowLength = 0.0;
  #ifdef HAS_SHADOW_LENGTH
  shadowLength = texture(shadowLengthBuffer, vUv).r;
  #endif // HAS_SHADOW_LENGTH

  vec3 cameraPosition = vCameraPosition;
  vec3 rayDirection = normalize(vRayDirection);
  vec3 dRDdx = dFdx(rayDirection);
  vec3 dRDdy = dFdy(rayDirection);
  float fragmentAngle = length(dRDdx + dRDdy) / length(rayDirection);

  #ifdef GROUND_ALBEDO

  float r = length(cameraPosition);
  float mu = dot(cameraPosition, rayDirection) / r;
  bool intersectsGround = RayIntersectsGround(ATMOSPHERE, r, mu);
  if (intersectsGround) {
    float distanceToGround = raySphereFirstIntersection(
      cameraPosition,
      rayDirection,
      ATMOSPHERE.bottom_radius
    );
    vec3 groundPosition = rayDirection * distanceToGround + cameraPosition;
    vec3 surfaceNormal = normalize(groundPosition);
    vec3 skyIrradiance;
    vec3 sunIrradiance = GetSunAndSkyIrradiance(
      cameraPosition,
      surfaceNormal,
      sunDirection,
      skyIrradiance
    );
    vec3 transmittance;
    vec3 inscatter = GetSkyRadianceToPoint(
      cameraPosition,
      ATMOSPHERE.bottom_radius * surfaceNormal,
      shadowLength,
      sunDirection,
      transmittance
    );
    vec3 radiance = groundAlbedo * RECIPROCAL_PI * (sunIrradiance + skyIrradiance);
    outputColor.rgb = radiance * transmittance + inscatter;
  } else {
    outputColor.rgb = getSkyRadiance(
      cameraPosition,
      rayDirection,
      shadowLength,
      sunDirection,
      moonDirection,
      moonAngularRadius,
      lunarRadianceScale,
      fragmentAngle
    );
  }

  #else // GROUND_ALBEDO

  outputColor.rgb = getSkyRadiance(
    cameraPosition,
    rayDirection,
    shadowLength,
    sunDirection,
    moonDirection,
    moonAngularRadius,
    lunarRadianceScale,
    fragmentAngle
  );

  #endif // GROUND_ALBEDO

  outputColor.a = 1.0;

  #include <mrt_output>
}
`;
var Ei = `precision highp float;
precision highp sampler3D;

uniform mat4 inverseProjectionMatrix;
uniform mat4 inverseViewMatrix;
uniform vec3 cameraPosition;
uniform mat4 worldToECEFMatrix;
uniform vec3 altitudeCorrection;

layout(location = 0) in vec3 position;

out vec2 vUv;
out vec3 vCameraPosition;
out vec3 vRayDirection;

void getCameraRay(out vec3 origin, out vec3 direction) {
  bool isPerspective = inverseProjectionMatrix[2][3] != 0.0; // 4th entry in the 3rd column

  if (isPerspective) {
    // Calculate the camera ray for a perspective camera.
    vec4 viewPosition = inverseProjectionMatrix * vec4(position, 1.0);
    vec4 worldDirection = inverseViewMatrix * vec4(viewPosition.xyz, 0.0);
    origin = cameraPosition;
    direction = worldDirection.xyz;
  } else {
    // Unprojected points to calculate direction.
    vec4 nearPoint = inverseProjectionMatrix * vec4(position.xy, -1.0, 1.0);
    vec4 farPoint = inverseProjectionMatrix * vec4(position.xy, -0.9, 1.0);
    nearPoint /= nearPoint.w;
    farPoint /= farPoint.w;

    // Calculate world values
    vec4 worldDirection = inverseViewMatrix * vec4(farPoint.xyz - nearPoint.xyz, 0.0);
    vec4 worldOrigin = inverseViewMatrix * nearPoint;

    // Outputs
    direction = worldDirection.xyz;
    origin = worldOrigin.xyz;
  }
}

void main() {
  vUv = position.xy * 0.5 + 0.5;

  vec3 direction, origin;
  getCameraRay(origin, direction);

  vec3 cameraPositionECEF = (worldToECEFMatrix * vec4(origin, 1.0)).xyz;
  vCameraPosition = (cameraPositionECEF + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vRayDirection = (worldToECEFMatrix * vec4(direction, 0.0)).xyz;

  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
var Ri = Object.defineProperty;
var Ye = (n2, e2, t2, r3) => {
  for (var i2 = void 0, a = n2.length - 1, o; a >= 0; a--)
    (o = n2[a]) && (i2 = o(e2, t2, i2) || i2);
  return i2 && Ri(e2, t2, i2), i2;
};
var _i = {
  ...Be,
  sun: true,
  moon: true,
  moonAngularRadius: 45e-4,
  // ≈ 15.5 arcminutes
  lunarRadianceScale: 1,
  ground: true,
  groundAlbedo: new ae(0)
};
var Ke = class extends se {
  constructor(e2) {
    const {
      sun: t2,
      moon: r3,
      moonDirection: i2,
      moonAngularRadius: a,
      lunarRadianceScale: o,
      ground: c2,
      groundAlbedo: s,
      ...l2
    } = { ..._i, ...e2 };
    super({
      name: "SkyMaterial",
      glslVersion: He,
      vertexShader: Ei,
      fragmentShader: W(vi, {
        core: { raySphereIntersection: wt },
        bruneton: {
          common: e,
          definitions: t,
          runtime: n
        },
        sky: Ct
      }),
      ...l2,
      uniforms: {
        inverseProjectionMatrix: new d2(new D2()),
        inverseViewMatrix: new d2(new D2()),
        moonDirection: new d2(i2?.clone() ?? new p2()),
        moonAngularRadius: new d2(a),
        lunarRadianceScale: new d2(o),
        groundAlbedo: new d2(s.clone()),
        shadowLengthBuffer: new d2(null),
        ...l2.uniforms
      },
      defines: {
        PERSPECTIVE_CAMERA: "1"
      },
      depthWrite: false,
      depthTest: true
    }), this.shadowLength = null, this.sun = t2, this.moon = r3, this.ground = c2;
  }
  onBeforeRender(e2, t2, r3, i2, a, o) {
    super.onBeforeRender(e2, t2, r3, i2, a, o);
    const { uniforms: c2, defines: s } = this;
    c2.inverseProjectionMatrix.value.copy(r3.projectionMatrixInverse), c2.inverseViewMatrix.value.copy(r3.matrixWorld);
    const l2 = s.PERSPECTIVE_CAMERA != null, h2 = r3.isPerspectiveCamera === true;
    h2 !== l2 && (h2 ? s.PERSPECTIVE_CAMERA = "1" : delete s.PERSPECTIVE_CAMERA, this.needsUpdate = true);
    const m = this.groundAlbedo, f2 = s.GROUND_ALBEDO != null, v = m.r !== 0 || m.g !== 0 || m.b !== 0;
    v !== f2 && (v ? this.defines.GROUND_ALBEDO = "1" : delete this.defines.GROUND_ALBEDO, this.needsUpdate = true);
    const T2 = this.shadowLength, E2 = s.HAS_SHADOW_LENGTH != null, x = T2 != null;
    x !== E2 && (x ? s.HAS_SHADOW_LENGTH = "1" : (delete s.HAS_SHADOW_LENGTH, c2.shadowLengthBuffer.value = null), this.needsUpdate = true), x && (c2.shadowLengthBuffer.value = T2.map);
  }
  get moonDirection() {
    return this.uniforms.moonDirection.value;
  }
  get moonAngularRadius() {
    return this.uniforms.moonAngularRadius.value;
  }
  set moonAngularRadius(e2) {
    this.uniforms.moonAngularRadius.value = e2;
  }
  get lunarRadianceScale() {
    return this.uniforms.lunarRadianceScale.value;
  }
  set lunarRadianceScale(e2) {
    this.uniforms.lunarRadianceScale.value = e2;
  }
  get groundAlbedo() {
    return this.uniforms.groundAlbedo.value;
  }
};
Ye([
  w2("SUN")
], Ke.prototype, "sun");
Ye([
  w2("MOON")
], Ke.prototype, "moon");
Ye([
  w2("GROUND")
], Ke.prototype, "ground");
var ji = class extends Mn {
  constructor(e2) {
    super();
    const t2 = new Int16Array(e2), r3 = new Uint8Array(e2), i2 = new et(t2, 5), a = new et(r3, 10);
    this.setAttribute(
      "position",
      new pe(i2, 3, 0, true)
    ), this.setAttribute(
      "magnitude",
      new pe(a, 1, 6, true)
    ), this.setAttribute(
      "color",
      new pe(a, 3, 7, true)
    ), this.boundingSphere = new An(new p2(), 1);
  }
};
var xi = `precision highp float;
precision highp sampler3D;

#include "bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform vec3 sunDirection;

in vec3 vCameraPosition;
in vec3 vRayDirection;

layout(location = 0) out vec4 outputColor;

#include <mrt_layout>

in vec3 vColor;

void main() {
  #if !defined(PERSPECTIVE_CAMERA)
  outputColor = vec4(0.0);
  discard; // Rendering celestial objects without perspective doesn't make sense.
  #endif // !defined(PERSPECTIVE_CAMERA)

  #ifdef BACKGROUND
  vec3 rayDirection = normalize(vRayDirection);
  float r = length(vCameraPosition);
  float mu = dot(vCameraPosition, rayDirection) / r;

  if (RayIntersectsGround(ATMOSPHERE, r, mu)) {
    discard;
  }

  vec3 transmittance;
  vec3 radiance = GetSkyRadiance(
    vCameraPosition,
    normalize(vRayDirection),
    0.0, // Shadow length
    sunDirection,
    transmittance
  );
  radiance += transmittance * vColor;
  outputColor = vec4(radiance, 1.0);
  #else // BACKGROUND
  outputColor = vec4(vColor, 1.0);
  #endif // BACKGROUND

  #include <mrt_output>
}
`;
var Mi = `precision highp float;
precision highp sampler3D;

#define saturate(x) clamp(x, 0.0, 1.0)

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 viewMatrix;
uniform mat4 matrixWorld;
uniform vec3 cameraPosition;
uniform float cameraFar;
uniform mat4 worldToECEFMatrix;
uniform vec3 altitudeCorrection;
uniform float pointSize;
uniform vec2 magnitudeRange;
uniform float intensity;

layout(location = 0) in vec3 position;
layout(location = 1) in float magnitude;
layout(location = 2) in vec3 color;

out vec3 vCameraPosition;
out vec3 vRayDirection;
out vec3 vEllipsoidCenter;
out vec3 vColor;

void main() {
  // Magnitude is stored between 0 to 1 within the given range.
  float m = mix(magnitudeRange.x, magnitudeRange.y, magnitude);
  vec3 v = pow(vec3(10.0), -vec3(magnitudeRange, m) / 2.5);
  vColor = vec3(intensity * color);
  vColor *= saturate((v.z - v.y) / (v.x - v.y));

  #ifdef BACKGROUND
  vec3 worldDirection = normalize(matrixWorld * vec4(position, 1.0)).xyz;
  vec3 cameraPositionECEF = (worldToECEFMatrix * vec4(cameraPosition, 1.0)).xyz;
  vCameraPosition = (cameraPositionECEF + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vRayDirection = (worldToECEFMatrix * vec4(worldDirection, 0.0)).xyz;
  gl_Position =
    projectionMatrix * viewMatrix * vec4(cameraPosition + worldDirection * cameraFar, 1.0);
  #else // BACKGROUND
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif // BACKGROUND

  gl_PointSize = pointSize;
}
`;
var Ai = Object.defineProperty;
var Kt = (n2, e2, t2, r3) => {
  for (var i2 = void 0, a = n2.length - 1, o; a >= 0; a--)
    (o = n2[a]) && (i2 = o(e2, t2, i2) || i2);
  return i2 && Ai(e2, t2, i2), i2;
};
var wi = {
  ...Be,
  pointSize: 1,
  intensity: 1,
  background: true,
  ground: true
};
var $t = class extends se {
  constructor(e2) {
    const { pointSize: t2, intensity: r3, background: i2, ground: a, ...o } = {
      ...wi,
      ...e2
    };
    super({
      name: "StarsMaterial",
      glslVersion: He,
      vertexShader: Mi,
      fragmentShader: W(xi, {
        bruneton: {
          common: e,
          definitions: t,
          runtime: n
        }
      }),
      ...o,
      uniforms: {
        projectionMatrix: new d2(new D2()),
        modelViewMatrix: new d2(new D2()),
        viewMatrix: new d2(new D2()),
        matrixWorld: new d2(new D2()),
        cameraFar: new d2(0),
        pointSize: new d2(0),
        magnitudeRange: new d2(new oe(-2, 8)),
        intensity: new d2(r3),
        ...o.uniforms
      },
      defines: {
        PERSPECTIVE_CAMERA: "1"
      },
      depthWrite: true,
      depthTest: true
    }), this.pointSize = t2, this.background = i2, this.ground = a;
  }
  onBeforeRender(e2, t2, r3, i2, a, o) {
    super.onBeforeRender(e2, t2, r3, i2, a, o);
    const c2 = this.uniforms;
    c2.projectionMatrix.value.copy(r3.projectionMatrix), c2.modelViewMatrix.value.copy(r3.modelViewMatrix), c2.viewMatrix.value.copy(r3.matrixWorldInverse), c2.matrixWorld.value.copy(a.matrixWorld), c2.cameraFar.value = r3.far, c2.pointSize.value = this.pointSize * e2.getPixelRatio();
    const s = r3.isPerspectiveCamera === true;
    this.defines.PERSPECTIVE_CAMERA != null !== s && (s ? this.defines.PERSPECTIVE_CAMERA = "1" : delete this.defines.PERSPECTIVE_CAMERA, this.needsUpdate = true);
  }
  get magnitudeRange() {
    return this.uniforms.magnitudeRange.value;
  }
  get intensity() {
    return this.uniforms.intensity.value;
  }
  set intensity(e2) {
    this.uniforms.intensity.value = e2;
  }
};
Kt([
  w2("BACKGROUND")
], $t.prototype, "background");
Kt([
  w2("GROUND")
], $t.prototype, "ground");
var yi = /* @__PURE__ */ new p2();
var Ci = /* @__PURE__ */ new w0();
var Di = {
  ellipsoid: F0.WGS84,
  correctAltitude: true,
  distance: 1
};
var Xi = class extends wn {
  constructor(e2, t2 = n0.DEFAULT) {
    super(), this.atmosphere = t2, this.worldToECEFMatrix = new D2();
    const {
      irradianceTexture: r3 = null,
      ellipsoid: i2,
      correctAltitude: a,
      sunDirection: o,
      distance: c2
    } = { ...Di, ...e2 };
    this.transmittanceTexture = r3, this.ellipsoid = i2, this.correctAltitude = a, this.sunDirection = o?.clone() ?? new p2(), this.distance = c2;
  }
  update() {
    const e2 = this.worldToECEFMatrix, t2 = Ci.setFromMatrix4(e2).transpose();
    if (this.position.copy(this.sunDirection).applyMatrix3(t2).normalize().multiplyScalar(this.distance).add(this.target.position), this.transmittanceTexture == null)
      return;
    const r3 = this.target.getWorldPosition(yi).applyMatrix4(e2);
    ei(
      this.transmittanceTexture,
      r3,
      this.sunDirection,
      this.color,
      {
        ellipsoid: this.ellipsoid,
        correctAltitude: this.correctAltitude
      },
      this.atmosphere
    );
  }
};
export {
  H2 as AerialPerspectiveEffect,
  se as AtmosphereMaterialBase,
  n0 as AtmosphereParameters,
  S as DEFAULT_PRECOMPUTED_TEXTURES_URL,
  d as DEFAULT_STARS_DATA_URL,
  v0 as DensityProfileLayer,
  A as IRRADIANCE_TEXTURE_HEIGHT,
  f as IRRADIANCE_TEXTURE_WIDTH,
  ki as LightingMaskPass,
  w as METER_TO_LENGTH_UNIT,
  Vi as PrecomputedTexturesGenerator,
  Bi as PrecomputedTexturesLoader,
  N as SCATTERING_TEXTURE_DEPTH,
  g as SCATTERING_TEXTURE_HEIGHT,
  _ as SCATTERING_TEXTURE_MU_SIZE,
  R as SCATTERING_TEXTURE_MU_S_SIZE,
  u as SCATTERING_TEXTURE_NU_SIZE,
  i as SCATTERING_TEXTURE_R_SIZE,
  U as SCATTERING_TEXTURE_WIDTH,
  h as SKY_RENDER_ORDER,
  Wi as SkyLightProbe,
  Ke as SkyMaterial,
  ji as StarsGeometry,
  $t as StarsMaterial,
  Xi as SunDirectionalLight,
  p as TRANSMITTANCE_TEXTURE_HEIGHT,
  C as TRANSMITTANCE_TEXTURE_WIDTH,
  D as XYZ_TO_SRGB,
  Kn as aerialPerspectiveEffectOptionsDefaults,
  Be as atmosphereMaterialParametersBaseDefaults,
  Wr as fromAstroRotationMatrix,
  jt as fromAstroVector,
  X as getAltitudeCorrectionOffset,
  Xe as getECIToECEFRotationMatrix,
  zi as getMoonDirectionECEF,
  Gi as getMoonDirectionECI,
  bi as getMoonFixedToECIRotationMatrix,
  Fi as getSunDirectionECEF,
  Ui as getSunDirectionECI,
  ei as getSunLightColor,
  Si as skyLightProbeParametersDefaults,
  _i as skyMaterialParametersDefaults,
  wi as starsMaterialParametersDefaults,
  Di as sunDirectionalLightParametersDefaults,
  P0 as toAstroTime
};
