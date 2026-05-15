// brunetonStubs.glsl — Clouds-B Bruneton runtime decouple.
//
// Drop-in replacement for the takram-three-atmosphere bruneton/runtime
// shader chunk. Keeps the same 3 short-form function signatures that
// clouds.frag + clouds.vert call (per the original runtime's #define
// rewrites at lines 459-461), but drives them from our synthetic
// uSunColor / uAmbientColor / uHorizonColor / uFogDensity / uSunIntensity
// uniforms instead of Bruneton's precomputed atmospheric scattering
// tables.
//
// The Bruneton `common.glsl` and `definitions.glsl` chunks remain in
// place (still imported from takram-three-atmosphere) for their type
// aliases (IrradianceSpectrum / RadianceSpectrum / Position / etc.) +
// the AtmosphereParameters struct. The atmosphere-uniforms-and-textures
// declared in clouds.vert (line 6-14) stay declared so the shader
// compiles; they're left unbound by the TS side and our stub functions
// don't read them.
//
// Wired into CloudsMaterial.ts's resolveIncludes() call as the
// `atmosphere.bruneton.runtime` slot. See [[project_holtburger_clouds_a_done_2026-05-15]]
// + docs/skybox-volumetric-clouds-handoff-2026-05-15.md for the bigger
// volumetric-clouds plan.

uniform vec3 uSunColor;       // DayGroup.dirColor (ARGB → RGB)
uniform vec3 uAmbientColor;   // DayGroup.ambColor (ARGB → RGB)
uniform vec3 uHorizonColor;   // DayGroup.fogColor (ARGB → RGB)
uniform float uFogDensity;    // derived from DayGroup.fogMin/fogMax
uniform float uSunIntensity;  // default 1.0

// ---- Short-form lighting functions ----------------------------------
// These are the names clouds.frag + clouds.vert call directly. The
// upstream Bruneton runtime block had `#define`s that rewrote these to
// `*Illuminance` variants — we don't redefine those macros, so the
// preprocessor leaves the names alone and they bind to our stubs.

// 4-arg form (sky_irradiance is out-param). Used by clouds.frag:426
// inside the per-fragment cloud lighting evaluator.
IrradianceSpectrum GetSunAndSkyIrradiance(
    const Position p, const Direction normal, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  float sunCos = clamp(dot(normalize(normal), normalize(sun_direction)), 0.0, 1.0);
  sky_irradiance = uAmbientColor;
  return uSunColor * sunCos * uSunIntensity;
}

// 3-arg scalar form (no surface normal). Used by clouds.vert:47-64 as
// vGroundIrradiance + vCloudsIrradiance varyings (min/maxSun pair),
// and by clouds.frag:440 inside the per-fragment cloud lighting eval.
//
// Convention: takram's Bruneton precomputes a scalar irradiance that
// assumes the sun comes from `sun_direction` and hits a point at `p`
// in ECEF coordinates. We approximate: use the y-component (upward)
// of the *position* as a "how high above the horizon" proxy, and the
// y-component of sun_direction as "how high is the sun above the
// horizon". Both feed a smooth ramp.
IrradianceSpectrum GetSunAndSkyScalarIrradiance(
    const Position p, const Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  // Sun elevation drives intensity (low sun = warm grazing, dusk-like).
  // Bruneton's full model accounts for atmospheric absorption; here we
  // just lerp via a smooth elevation curve.
  float sunUp = clamp(normalize(sun_direction).y, 0.0, 1.0);
  float dayMix = smoothstep(0.0, 0.3, sunUp);
  sky_irradiance = uAmbientColor;
  return uSunColor * uSunIntensity * (0.2 + 0.8 * dayMix);
}

// 5-arg sky-radiance-to-point form. Used by clouds.frag:708 for the
// atmospheric-perspective compositing pass that fades distant cloud
// fragments into the horizon haze.
RadianceSpectrum GetSkyRadianceToPoint(
    const Position camera, const Position point, const Length shadow_length,
    const Direction sun_direction, out DimensionlessSpectrum transmittance) {
  float dist = length(camera - point);
  float fogAmount = 1.0 - exp(-uFogDensity * dist);
  transmittance = vec3(1.0 - fogAmount);
  return uHorizonColor * fogAmount;
}
