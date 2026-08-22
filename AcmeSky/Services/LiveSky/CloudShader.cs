namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 2 -- HLSL port of the takram three-clouds volumetric raymarcher
    /// (vendor/takram-three-clouds/src/shaders/{clouds.frag,types.glsl,clouds.glsl,parameters.glsl}),
    /// specialised to the holtburger configuration:
    ///
    ///   - Quality: takram "medium" preset (SHAPE_DETAIL on, TURBULENCE off, lightShafts off,
    ///     accurateSunSkyLight off, 8 multi-scattering octaves, dual-lobe HG (0.7,-0.2,mix .5),
    ///     POWDER (0.8/150), GROUND_BOUNCE 1 step, sun march 2 steps).
    ///   - Layers: holtburger FAIR look (cloud_storm_look.js 2026-08-01): cumulus r 750/650/.2,
    ///     stratus g 1000/1200/.2, cirrus b 7500/500/.003, alto a 3500/600/.004; coverage 0.5.
    ///   - DROPPED vs reference (documented simplifications): Beer Shadow Map (secondary sun
    ///     march only -- distant self-shadowing is softer), temporal reprojection/upscaling
    ///     (we march at a reduced-res RT every frame; STBN jitter carries the banding load),
    ///     scene-depth clamp (depth-unaware composite, terrain overdraws the backdrop anyway),
    ///     HAZE (holtburger FAIR haze is near-invisible at 3e-5).
    ///
    /// The string is COMPILED APPENDED to AtmosphereShader.Hlsl: it reuses the SkyParams cbuffer,
    /// samLUT (clamp), the Bruneton LUTs t0-t2 and every runtime function already ported there
    /// (GetCombinedScattering has both ground branches, which GetSkyRadianceToPoint needs).
    /// New resources: t4 local weather (RGBA8+mips), t5 shape 128^3 R8, t6 shape detail 32^3 R8,
    /// t7 STBN 128x128x64 R8, t8 the cloud RT for the composite pass, s1 wrap sampler.
    ///
    /// Radiance is LUMINANCE-scaled exactly like the sky path (the reference's
    /// GetSunAndSkyScalarIlluminance / GetSkyLuminanceToPoint wrappers).
    /// </summary>
    internal static class CloudShader {

        /// <summary>Full source for the cloud passes: atmosphere part + cloud part.</summary>
        public static string Hlsl => AtmosphereShader.Hlsl + Part;

        public const string Part = @"
// ==========================================================================
//  M2 volumetric clouds (takram three-clouds port).  Units: METERS
//  (Bruneton lookups scale by meterToUnit into km).
// ==========================================================================
Texture2D<float4> localWeatherTex : register(t4);
Texture3D<float>  shapeTex        : register(t5);
Texture3D<float>  shapeDetailTex  : register(t6);
Texture3D<float>  stbnTex         : register(t7);
Texture2D<float4> cloudBufTex     : register(t8);
SamplerState samWrap : register(s1);

static const float RECIPROCAL_PI  = 0.3183098861837907;
static const float RECIPROCAL_PI2 = 0.15915494309189535;
static const float RECIPROCAL_PI4 = 0.07957747154594767;

// --- holtburger FAIR layers (cloud_storm_look.js) ---
static const float4 minLayerHeights = float4(750.0, 1000.0, 7500.0, 3500.0);
static const float4 maxLayerHeights = float4(1400.0, 2200.0, 8000.0, 4100.0);
// Gaps between merged layer spans [750,2200],[3500,4100],[7500,8000] (packIntervalHeights):
static const float3 minIntervalHeights = float3(2200.0, 4100.0, 0.0);
static const float3 maxIntervalHeights = float3(3500.0, 7500.0, 0.0);
static const float4 densityScales = float4(0.2, 0.2, 0.003, 0.004);
static const float4 shapeAmounts = float4(1.0, 1.0, 0.4, 0.5);
static const float4 shapeDetailAmounts = float4(1.0, 1.0, 0.0, 0.0);
static const float4 weatherExponents = float4(1.0, 1.0, 1.0, 1.0);
static const float4 shapeAlteringBiases = float4(0.35, 0.35, 0.35, 0.35);
static const float4 coverageFilterWidths = float4(0.6, 0.6, 0.5, 0.5);
static const float cloudMinHeight = 750.0;
static const float cloudMaxHeight = 8000.0;
static const float shadowTopHeight = 2200.0;   // top of the shadow-flagged layers (r,g)
// DensityProfile DEFAULT (0, 0, 0.75, 0.25) per layer:
static const float4 profExpTerms = float4(0.0, 0.0, 0.0, 0.0);
static const float4 profExponents = float4(0.0, 0.0, 0.0, 0.0);
static const float4 profLinearTerms = float4(0.75, 0.75, 0.75, 0.75);
static const float4 profConstantTerms = float4(0.25, 0.25, 0.25, 0.25);

// --- participating medium + march parameters (takram 'medium' preset) ---
static const float scatteringCoefficient = 1.0;
static const float absorptionCoefficient = 0.0;
static const float minDensity = 1e-4;
static const float minExtinction = 1e-4;
static const float minTransmittanceC = 1e-2;
static const float minStepSize = 100.0;
static const float maxStepSize = 1000.0;
static const float cloudMaxRayDistance = 1e5;
static const float perspectiveStepScale = 1.01;
static const int   maxIterationCountToSun = 2;
static const int   maxIterationCountToGround = 1;
static const float minSecondaryStepSize = 100.0;
static const float secondaryStepScale = 2.0;
static const float cloudCameraNear = 10.0;

// --- lighting ---
static const int   MULTI_SCATTERING_OCTAVES = 8;
static const float2 scatterAnisotropy = float2(0.7, -0.2);
static const float scatterAnisotropyMix = 0.5;
static const float skyLightScale = 1.0;
static const float groundBounceScale = 1.0;
static const float powderScale = 0.8;
static const float powderExponent = 150.0;

// --- shape / weather mapping ---
static const float2 localWeatherRepeat = float2(100.0, 100.0);
static const float3 shapeRepeat = float3(0.0003, 0.0003, 0.0003);
static const float3 shapeDetailRepeat = float3(0.006, 0.006, 0.006);

// ---------------- helpers (three-geospatial core/math + raySphereIntersection) ----------------
float remapC1(float x, float a, float b) { return saturate((x - a) / (b - a)); }
float4 remapC4(float4 x, float4 a, float4 b) { return saturate((x - a) / (b - a)); }
float remapF(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }

void raySphereIntersections4(float3 origin, float3 dir, float4 radii,
                             out float4 first, out float4 second) {
    float b = 2.0 * dot(dir, origin);
    float4 c = dot(origin, origin) - radii * radii;
    float4 disc = b * b - 4.0 * c;
    float4 mask = step(disc, float4(0.0, 0.0, 0.0, 0.0));
    float4 q = sqrt(max(float4(0.0, 0.0, 0.0, 0.0), disc));
    first  = lerp((-b - q) * 0.5, float4(-1.0, -1.0, -1.0, -1.0), mask);
    second = lerp((-b + q) * 0.5, float4(-1.0, -1.0, -1.0, -1.0), mask);
}

// clouds.glsl getCubeSphereUv (globe weather mapping)
float2 getGlobeUv(float3 position) {
    float3 n = normalize(position);
    float3 f = abs(n);
    float3 c = n / max(f.x, max(f.y, f.z));
    float2 m;
    if (f.y > f.x && f.y > f.z) {
        m = c.y > 0.0 ? float2(-n.x, n.z) : n.xz;
    } else if (f.x > f.y && f.x > f.z) {
        m = c.x > 0.0 ? n.yz : float2(-n.y, n.z);
    } else {
        m = c.z > 0.0 ? n.xy : float2(n.x, -n.y);
    }
    float2 m2 = m * m;
    float q = dot(m2.xy, float2(-2.0, 2.0)) - 3.0;
    float q2 = q * q;
    float2 uv;
    uv.x = sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(max(-24.0 * m2.x + q2, 0.0))) * (m.x > 0.0 ? 1.0 : -1.0);
    uv.y = sqrt(6.0 / (3.0 - uv.x * uv.x)) * m.y;
    return uv * 0.5 + 0.5;
}

float getMipLevelCloud(float2 uv) {
    const float mipLevelScale = 0.1;
    float2 coord = uv * cloudRes;
    float2 dx = ddx(coord);
    float2 dy = ddy(coord);
    float deltaMaxSqr = max(dot(dx, dx), dot(dy, dy)) * mipLevelScale;
    return max(0.0, 0.5 * log2(max(1.0, deltaMaxSqr)));
}

bool insideLayerIntervals(float height) {
    bool3 gt = height > minIntervalHeights;
    bool3 lt = height < maxIntervalHeights;
    return (gt.x && lt.x) || (gt.y && lt.y) || (gt.z && lt.z);
}

// ---------------- weather + media sampling (clouds.glsl) ----------------
struct WeatherSample { float4 heightFraction; float4 density; };

float4 shapeAlteringFunction(float4 heightFraction, float4 bias) {
    float4 biased = pow(max(heightFraction, 0.0), bias);
    float4 x = clamp(biased * 2.0 - 1.0, -1.0, 1.0);
    return 1.0 - x * x;
}

WeatherSample sampleWeatherC(float2 uv, float height, float mipLevel) {
    WeatherSample weather;
    weather.heightFraction = remapC4(float4(height, height, height, height),
                                     minLayerHeights, maxLayerHeights);
    float4 localWeather = pow(max(localWeatherTex.SampleLevel(
        samWrap, uv * localWeatherRepeat + cloudWeatherOfs, mipLevel), 0.0), weatherExponents);
    float4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);
    float4 factor = 1.0 - cloudCoverage * heightScale;
    weather.density = remapC4(
        lerp(localWeather, float4(1.0, 1.0, 1.0, 1.0), coverageFilterWidths),
        factor, factor + coverageFilterWidths);
    return weather;
}

float4 getLayerDensity(float4 heightFraction) {
    return profExpTerms * exp(profExponents * heightFraction) +
           profLinearTerms * heightFraction + profConstantTerms;
}

struct MediaSample { float density; float4 weight; float scattering; float extinction; };

MediaSample sampleMediaC(WeatherSample weather, float3 position, float2 uv,
                         float mipLevel, float jitter) {
    float4 density = weather.density;

    float3 surfaceNormal = normalize(position);
    float localWeatherSpeed = length(cloudWeatherOfs);
    float3 evolution = -surfaceNormal * localWeatherSpeed * 2e4;

    float3 shapePosition = (position + evolution) * shapeRepeat;
    float shape = shapeTex.SampleLevel(samWrap, shapePosition, 0.0);
    density = remapC4(density, (1.0 - shape) * shapeAmounts, float4(1.0, 1.0, 1.0, 1.0));

    // SHAPE_DETAIL
    if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {
        float3 detailPosition = position * shapeDetailRepeat;
        float detail = shapeDetailTex.SampleLevel(samWrap, detailPosition, 0.0);
        float4 modifier = lerp(
            float4(pow(detail, 6.0).xxxx),
            float4((1.0 - detail).xxxx),
            remapC4(weather.heightFraction, float4(0.2, 0.2, 0.2, 0.2), float4(0.4, 0.4, 0.4, 0.4)));
        modifier = lerp(float4(0.0, 0.0, 0.0, 0.0), modifier, shapeDetailAmounts);
        density = remapC4(density * 2.0, modifier * 0.5, float4(1.0, 1.0, 1.0, 1.0));
    }

    density = saturate(density * densityScales * getLayerDensity(weather.heightFraction));

    MediaSample media;
    float densitySum = density.x + density.y + density.z + density.w;
    media.density = densitySum;
    media.weight = density / max(densitySum, 1e-7);
    media.scattering = densitySum * scatteringCoefficient;
    media.extinction = densitySum * absorptionCoefficient + media.scattering;
    return media;
}

// ---------------- phase + multiple scattering ----------------
float2 henyeyGreenstein2(float2 g, float cosTheta) {
    float2 g2 = g * g;
    return RECIPROCAL_PI4 *
        ((1.0 - g2) / max(float2(1e-7, 1e-7), pow(1.0 + g2 - 2.0 * g * cosTheta, float2(1.5, 1.5))));
}

float cloudPhase(float cosTheta, float attenuation) {
    float2 weights = float2(1.0 - scatterAnisotropyMix, scatterAnisotropyMix);
    return dot(henyeyGreenstein2(scatterAnisotropy * attenuation, cosTheta), weights);
}

float approximateMultipleScattering(float opticalDepth, float cosTheta) {
    float3 coeffs = float3(1.0, 1.0, 1.0);            // a, b, c
    const float3 attenuation = float3(0.5, 0.5, 0.5);
    float scattering = 0.0;
    [unroll] for (int i = 0; i < MULTI_SCATTERING_OCTAVES; ++i) {
        float beerLambert = exp(-opticalDepth * coeffs.y);
        scattering += coeffs.x * beerLambert * cloudPhase(cosTheta, coeffs.z);
        coeffs *= attenuation;
    }
    return scattering;
}

// ---------------- Bruneton additions (runtime.glsl) in LUMINANCE units ----------------
float4 sampleIrradianceLut(float2 uv) {
    if (lutFlipV > 0.5) uv.y = 1.0 - uv.y;
    return irradiance_texture.SampleLevel(samLUT, uv, 0);
}

float3 GetIrradianceLum(float r, float mu_s) {
    float x_r = (r - bottom_radius) / (top_radius - bottom_radius);
    float x_mu_s = mu_s * 0.5 + 0.5;
    float2 uv = float2(GetTextureCoordFromUnitRange(x_mu_s, IRRADIANCE_TEXTURE_WIDTH),
                       GetTextureCoordFromUnitRange(x_r, IRRADIANCE_TEXTURE_HEIGHT));
    return sampleIrradianceLut(uv).rgb;
}

float3 GetTransmittanceToSunB(float r, float mu_s) {
    float sin_theta_h = bottom_radius / r;
    float cos_theta_h = -sqrt(max(1.0 - sin_theta_h * sin_theta_h, 0.0));
    return GetTransmittanceToTopAtmosphereBoundary(r, mu_s) *
        smoothstep(-sin_theta_h * sunAngRadiusPhys, sin_theta_h * sunAngRadiusPhys,
                   mu_s - cos_theta_h);
}

// GetSunAndSkyScalarIlluminance: sun/sky luminance-scaled irradiance, no cosine term.
float3 GetSunAndSkyScalarIrradianceLum(float3 pointKm, float3 sunDir, out float3 skyIrradiance) {
    float r = max(length(pointKm), bottom_radius);
    float mu_s = dot(pointKm, sunDir) / r;
    skyIrradiance = GetIrradianceLum(r, mu_s) * (2.0 * PI) * SKY_RAD_TO_LUM;
    return solar_irradiance * GetTransmittanceToSunB(r, mu_s) * SUN_RAD_TO_LUM;
}

bool RayIntersectsGroundB(float r, float mu) {
    return mu < 0.0 && r * r * (mu * mu - 1.0) + bottom_radius * bottom_radius >= 0.0;
}

float3 GetTransmittanceB(float r, float mu, float d, bool intersectsGround) {
    float r_d = ClampRadius(sqrt(d * d + 2.0 * r * mu * d + r * r));
    float mu_d = ClampCosine((r * mu + d) / r_d);
    if (intersectsGround) {
        return min(GetTransmittanceToTopAtmosphereBoundary(r_d, -mu_d) /
                   GetTransmittanceToTopAtmosphereBoundary(r, -mu),
                   float3(1.0, 1.0, 1.0));
    } else {
        return min(GetTransmittanceToTopAtmosphereBoundary(r, mu) /
                   GetTransmittanceToTopAtmosphereBoundary(r_d, mu_d),
                   float3(1.0, 1.0, 1.0));
    }
}

// GetSkyLuminanceToPoint (shadow_length = 0, COMBINED textures, no higher-order).
float3 GetSkyRadianceToPointLum(float3 cameraKm, float3 pointKm, float3 sunDir,
                                out float3 transmittance) {
    transmittance = float3(1.0, 1.0, 1.0);

    // ClosestPointOnRay guard
    {
        float3 ray = pointKm - cameraKm;
        float t = clamp(-dot(cameraKm, ray) / dot(ray, ray), 0.0, 1.0);
        if (length(cameraKm + t * ray) > top_radius) return float3(0.0, 0.0, 0.0);
    }

    float3 view_ray = normalize(pointKm - cameraKm);

    // ClipAtBottomAtmosphere
    {
        float rc = length(cameraKm), rp = length(pointKm);
        bool cameraBelow = rc < bottom_radius;
        bool pointBelow = rp < bottom_radius;
        float b = 2.0 * dot(view_ray, cameraKm);
        float cq = dot(cameraKm, cameraKm) - bottom_radius * bottom_radius;
        float disc = b * b - 4.0 * cq;
        float q = sqrt(max(disc, 0.0));
        float2 t2v = float2(-b - q, -b + q) * 0.5;
        float3 isect = cameraKm + view_ray * (cameraBelow ? t2v.y : t2v.x);
        cameraKm = cameraBelow ? isect : cameraKm;
        pointKm = pointBelow ? isect : pointKm;
        if (cameraBelow && pointBelow) return float3(0.0, 0.0, 0.0);
    }

    float r = length(cameraKm);
    float rmu = dot(cameraKm, view_ray);
    float dist_to_top = -rmu - SafeSqrt(rmu * rmu - r * r + top_radius * top_radius);
    if (dist_to_top > 0.0) {
        cameraKm = cameraKm + view_ray * dist_to_top;
        r = top_radius;
        rmu += dist_to_top;
    }

    float mu = rmu / r;
    float mu_s = dot(cameraKm, sunDir) / r;
    float nu = dot(view_ray, sunDir);
    float d = length(pointKm - cameraKm);
    bool intersectsGround = RayIntersectsGroundB(r, mu);

    // Horizon-artifact hack (three-geospatial PR#32).
    if (!intersectsGround) {
        float mu_horizon = -SafeSqrt(1.0 - (bottom_radius * bottom_radius) / (r * r));
        mu = max(mu, mu_horizon + 0.004);
    }

    transmittance = GetTransmittanceB(r, mu, d, intersectsGround);

    float3 single_mie;
    float3 scattering = GetCombinedScattering(r, mu, mu_s, nu, intersectsGround, single_mie);

    float r_p = ClampRadius(sqrt(d * d + 2.0 * r * mu * d + r * r));
    float mu_p = (r * mu + d) / r_p;
    float mu_s_p = (r * mu_s + d * nu) / r_p;

    float3 single_mie_p;
    float3 scattering_p = GetCombinedScattering(r_p, mu_p, mu_s_p, nu, intersectsGround, single_mie_p);

    scattering = scattering - transmittance * scattering_p;
    single_mie = single_mie - transmittance * single_mie_p;
    // COMBINED_SCATTERING_TEXTURES re-extrapolation
    single_mie = GetExtrapolatedSingleMieScattering(float4(scattering, single_mie.r));
    single_mie = single_mie * smoothstep(0.0, 0.01, mu_s);

    return (scattering * RayleighPhaseFunction(nu) +
            single_mie * MiePhaseFunction(mie_phase_function_g, nu)) * SKY_RAD_TO_LUM;
}

// ---------------- secondary march + ground bounce (clouds.frag) ----------------
float marchOpticalDepthC(float3 rayOrigin, float3 rayDirection, int maxIter,
                         float mipLevel, float jitter) {
    int iterationCount = (int)max(0.0, remapF(mipLevel, 0.0, 1.0, float(maxIter + 1), 1.0) - jitter);
    if (iterationCount == 0) return 0.5;   // reference fudge factor
    float stepSize = minSecondaryStepSize / float(iterationCount);
    float nextDistance = stepSize * jitter;
    float opticalDepth = 0.0;
    [loop] for (int i = 0; i < iterationCount; ++i) {
        float rayDistance = nextDistance;
        float3 position = rayDistance * rayDirection + rayOrigin;
        float2 uv = getGlobeUv(position);
        float height = length(position) - bottomRadiusM;
        WeatherSample weather = sampleWeatherC(uv, height, mipLevel);
        MediaSample media = sampleMediaC(weather, position, uv, mipLevel, jitter);
        opticalDepth += media.extinction * stepSize;
        nextDistance += stepSize;
        stepSize *= secondaryStepScale;
    }
    return opticalDepth;
}

float3 approximateRadianceFromGroundC(float3 position, float3 surfaceNormal, float height,
                                      float mipLevel, float jitter, float3 sunShaderDir) {
    float opticalDepthToGround = marchOpticalDepthC(position, -surfaceNormal,
                                                    maxIterationCountToGround, mipLevel, jitter);
    float3 skyIrradiance;
    float3 sunIrradiance = GetSunAndSkyScalarIrradianceLum(
        (position - surfaceNormal * height) * meterToUnit, sunShaderDir, skyIrradiance);
    const float groundAlbedo = 0.3;
    float3 groundIrradiance = skyIrradiance + (1.0 - cloudCoverage) * sunIrradiance;
    float3 bouncedRadiance = groundAlbedo * RECIPROCAL_PI * groundIrradiance;
    return bouncedRadiance * exp(-opticalDepthToGround);
}

// ---------------- primary march (clouds.frag marchClouds) ----------------
float4 marchCloudsC(float3 rayOrigin, float3 rayDirection, float2 rayNearFar, float cosTheta,
                    float jitter, float rayStartTexelsPerPixel, float3 sunShaderDir,
                    float3 cloudsIrrMinSun, float3 cloudsIrrMinSky,
                    float3 cloudsIrrMaxSun, float3 cloudsIrrMaxSky,
                    out float frontDepth) {
    float3 radianceIntegral = float3(0.0, 0.0, 0.0);
    float transmittanceIntegral = 1.0;
    float weightedDistanceSum = 0.0;
    float transmittanceSum = 0.0;

    float maxRayDist = rayNearFar.y - rayNearFar.x;
    float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;
    float rayDistance = stepSize * jitter * 2.0;
    int iters = (int)cloudIters;

    [loop] for (int i = 0; i < iters; ++i) {
        if (rayDistance > maxRayDist) break;

        float3 position = rayDistance * rayDirection + rayOrigin;
        float height = length(position) - bottomRadiusM;
        float mipLevel = log2(max(1.0, rayStartTexelsPerPixel + rayDistance * 1e-5));

        if (insideLayerIntervals(height)) {
            stepSize *= perspectiveStepScale;
            rayDistance += lerp(stepSize, maxStepSize, min(1.0, mipLevel));
            continue;
        }

        float2 uv = getGlobeUv(position);
        WeatherSample weather = sampleWeatherC(uv, height, mipLevel);

        if (!any(weather.density > float4(minDensity, minDensity, minDensity, minDensity))) {
            stepSize *= perspectiveStepScale;
            rayDistance += lerp(stepSize, maxStepSize, min(1.0, mipLevel));
            continue;
        }

        MediaSample media = sampleMediaC(weather, position, uv, mipLevel, jitter);

        if (media.extinction > minExtinction) {
            // Sun+sky irradiance at this height (non-accurate path: lerp of precomputed
            // min/max-height values, computed once in the PS prologue).
            float alpha = remapC1(height, cloudMinHeight, cloudMaxHeight);
            float3 skyIrradiance = lerp(cloudsIrrMinSky, cloudsIrrMaxSky, alpha);
            float3 sunIrradiance = lerp(cloudsIrrMinSun, cloudsIrrMaxSun, alpha);
            float3 surfaceNormal = normalize(position);

            float opticalDepth = marchOpticalDepthC(position, sunShaderDir,
                                                    maxIterationCountToSun, mipLevel, jitter);
            // (Beer Shadow Map contribution dropped -- see class doc.)

            float3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);

            // GROUND_BOUNCE
            if (height < shadowTopHeight && mipLevel < 0.5) {
                float3 groundRadiance = approximateRadianceFromGroundC(
                    position, surfaceNormal, height, mipLevel, jitter, sunShaderDir);
                radiance += groundRadiance * RECIPROCAL_PI4 * groundBounceScale;
            }

            float skyGradient = dot(weather.heightFraction * 0.5 + 0.5, media.weight);
            radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;

            radiance *= media.scattering;

            // POWDER
            radiance *= 1.0 - powderScale * exp(-media.extinction * powderExponent);

            // Frostbite energy-conserving integration.
            float transmittance = exp(-media.extinction * stepSize);
            float clampedExtinction = max(media.extinction, 1e-7);
            float3 scatteringIntegral = (radiance - radiance * transmittance) / clampedExtinction;
            radianceIntegral += transmittanceIntegral * scatteringIntegral;
            transmittanceIntegral *= transmittance;

            weightedDistanceSum += rayDistance * transmittanceIntegral;
            transmittanceSum += transmittanceIntegral;
        }

        if (transmittanceIntegral <= minTransmittanceC) break;

        stepSize *= perspectiveStepScale;
        rayDistance += stepSize;
    }

    frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;
    return float4(radianceIntegral,
                  remapC1(transmittanceIntegral, 1.0, minTransmittanceC));
}

// ---------------- ray setup (clouds.frag main) ----------------
float2 getCloudRayNearFar(float3 cameraECEFm, float3 rayDirection, float cameraHeight,
                          bool hitsGroundC) {
    float4 first, second;
    raySphereIntersections4(cameraECEFm, rayDirection,
        bottomRadiusM + float4(0.0, cloudMinHeight, cloudMaxHeight, shadowTopHeight),
        first, second);
    float2 nearFar;
    if (cameraHeight < cloudMinHeight) {
        if (hitsGroundC) {
            nearFar = float2(-1.0, -1.0);
        } else {
            nearFar = float2(second.y, second.z);
            nearFar.y = min(nearFar.y, cloudMaxRayDistance);
        }
    } else if (cameraHeight < cloudMaxHeight) {
        nearFar = hitsGroundC ? float2(cloudCameraNear, first.y)
                              : float2(cloudCameraNear, second.z);
    } else {
        nearFar = float2(first.z, second.z);
        if (hitsGroundC) nearFar.y = first.y;
    }
    return nearFar;
}

// ---------------- pixel shaders ----------------
float4 PSClouds(VSOut i) : SV_TARGET {
    // Camera ray -- identical reconstruction to PSAtmosphere (baseline raymode).
    float2 ndc = float2(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0);
    float4 clipP = float4(ndc, 1.0, 1.0);
    float4 vpos = mul(clipP, invProj);
    vpos /= vpos.w;
    float4 wp = mul(float4(vpos.xyz, 1.0), invView);
    float3 dirRW = normalize(wp.xyz - cameraPosAC);
    bool swz = worldSwizzle > 0.5;
    float3 dirAC = swz ? dirRW.xzy : dirRW;
    float3 camPosAc = swz ? cameraPosAC.xzy : cameraPosAC;

    float3 dirShader = normalize(mul(float4(dirAC, 0.0), acToShader).xyz);
    float3 camShader = mul(float4(camPosAc, 1.0), acToShader).xyz;
    float3 sunShader = normalize(mul(float4(sunDirAC, 0.0), acToShader).xyz);

    float3 cameraECEFm = camShader + float3(0.0, bottomRadiusM, 0.0);
    float cameraHeight = length(cameraECEFm) - bottomRadiusM;
    float cosTheta = dot(sunShader, dirShader);

    float rE = length(cameraECEFm);
    float muE = dot(cameraECEFm, dirShader) / rE;
    bool hitsGroundC = muE < 0.0 &&
        rE * rE * (muE * muE - 1.0) + bottomRadiusM * bottomRadiusM >= 0.0;

    float2 rayNearFar = getCloudRayNearFar(cameraECEFm, dirShader, cameraHeight, hitsGroundC);
    if (rayNearFar.x < 0.0 || rayNearFar.y < 0.0 || rayNearFar.y <= rayNearFar.x)
        return float4(0.0, 0.0, 0.0, 0.0);

    // STBN jitter (takram stbn.bin: 128x128 xy, 64 frame slices).
    float stbn = stbnTex.SampleLevel(samWrap,
        float3(i.pos.xy, fmod(cloudFrame, 64.0)) / float3(128.0, 128.0, 64.0), 0.0);

    float3 rayOrigin = rayNearFar.x * dirShader + cameraECEFm;
    float2 globeUv = getGlobeUv(rayOrigin);
    float mipLevel = getMipLevelCloud(globeUv * localWeatherRepeat);
    mipLevel = lerp(0.0, mipLevel, min(1.0, 0.2 * cameraHeight / cloudMaxHeight));

    // Per-pixel sun/sky irradiance at the cloud min/max heights (clouds.vert
    // sampleSunSkyIrradiance -- effectively constant across the fullscreen quad).
    float3 surfaceNormalCam = normalize(cameraECEFm);
    float2 radiiKm = (bottomRadiusM + float2(cloudMinHeight, cloudMaxHeight)) * meterToUnit;
    float3 irrMinSky, irrMaxSky;
    float3 irrMinSun = GetSunAndSkyScalarIrradianceLum(surfaceNormalCam * radiiKm.x, sunShader, irrMinSky);
    float3 irrMaxSun = GetSunAndSkyScalarIrradianceLum(surfaceNormalCam * radiiKm.y, sunShader, irrMaxSky);

    float frontDepthM;
    float4 color = marchCloudsC(rayOrigin, dirShader, rayNearFar, cosTheta, stbn,
                                pow(2.0, mipLevel), sunShader,
                                irrMinSun, irrMinSky, irrMaxSun, irrMaxSky, frontDepthM);

    if (frontDepthM >= 0.0) {
        // Aerial perspective between the camera and the cloud front.
        float frontDepth = rayNearFar.x + frontDepthM;
        float3 frontPosition = cameraECEFm + frontDepth * dirShader;
        float3 apTransmittance;
        float3 inscatter = GetSkyRadianceToPointLum(cameraECEFm * meterToUnit,
                                                    frontPosition * meterToUnit,
                                                    sunShader, apTransmittance);
        // AP debug bisection: 7 = inscatter only, 8 = transmittance only, 9=front depth.
        if (outputMode > 6.5 && outputMode < 7.5) return float4(inscatter, 1.0);
        if (outputMode > 7.5 && outputMode < 8.5) return float4(apTransmittance, 1.0);
        if (outputMode > 8.5) return float4(frontDepth.xxx / cloudMaxRayDistance, 1.0);
        color.rgb = color.rgb * apTransmittance + inscatter * color.a;
    }
    return color;   // premultiplied HDR radiance + alpha, into the half-res cloud RT
}

// Composite the cloud RT over the sky (premultiplied-over blend state is set by the host).
// Mirrors holtburger's overlay shader: discard non-contributing pixels, tonemap like the sky.
float4 PSCloudComposite(VSOut i) : SV_TARGET {
    float4 c = cloudBufTex.SampleLevel(samLUT, i.uv, 0);
    if (outputMode > 6.5) return float4(saturate(c.rgb), 1.0);   // AP debug: raw values
    if (outputMode > 5.5) return float4(FinalColor(c.rgb), 1.0); // 6: clouds-only (black bg)
    float lum = max(c.r, max(c.g, c.b));
    if (c.a < 0.05 || lum < 0.02) { clip(-1.0); }
    return float4(FinalColor(c.rgb), c.a);
}
";
    }
}
