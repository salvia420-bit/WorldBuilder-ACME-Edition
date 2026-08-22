namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 1 -- HLSL for the live Bruneton precomputed-scattering atmosphere.
    ///
    /// This is a faithful HLSL port of holtburger-web's sky path:
    ///   vendor/takram-three-clouds/shaders/bruneton-reference/{definitions,common,runtime}.glsl
    ///   node_modules/@takram/three-atmosphere/src/shaders/{sky.glsl,sky.frag}
    /// with the runtime specialised for the sky quad: shadow_length = 0, no GROUND branch,
    /// COMBINED_SCATTERING_TEXTURES (Mie packed in scattering.alpha), no higher-order texture.
    ///
    /// The vertex shader is the SAME fullscreen triangle as Milestone 0. The pixel shader
    /// reconstructs a per-pixel world-space camera ray (invProj * invView), maps ray origin +
    /// direction from AC world space into the shader's y-up ECEF space via <c>acToShader</c>
    /// (a pure rotation the host can swap at runtime), applies the ECEF translate
    /// (0, bottomRadius, 0) and the meter->kilometre scale, then evaluates GetSkyRadiance +
    /// an analytic sun/moon disc, tonemaps (exposure * AgX) and writes to the 8-bit RT.
    ///
    /// Coordinate convention (documented so the client can be corrected if the sky is
    /// upside-down / sideways):
    ///   AC world space is X=east, Y=north, Z=up (right-handed, z-up).
    ///   ⚠ BUT the client's D3D RENDER world (what WorldToView/ViewToClip actually transform)
    ///   is that world with y and z SWAPPED (Y-up). Decomp proof: Render::update_viewpoint
    ///   builds the view matrix with columns (Xaxis, Zaxis, Yaxis) / translation (p.x,p.z,p.y),
    ///   and PrimD3DRender::ScreenToViewTransform (the client's own pick-ray unproject) assigns
    ///   its output components to dir->x, dir->z, dir->y. The pixel shader therefore swizzles
    ///   the reconstructed ray and camera .xzy back to AC (E,N,U) before <c>acToShader</c>
    ///   (worldSwizzle knob, default ON). This was the "sky rolled 90°, up points north" bug —
    ///   and its horizon sliced the screen vertically, which is what looked like a separate
    ///   "scattering seam" (CPU replica: tools shipped in scratch skysim reproduced both).
    ///   The shader/three.js space is y-up ECEF; the canonical AC->three map is
    ///   (x,y,z)_ac -> (x, z, -y)_three  (east->x, up->y, north->-z), matching
    ///   scene3d/sun_direction.js. That is <c>acToShader</c> mode 0 (the default).
    ///   The host builds <c>acToShader</c> in C# from an env-selected axis mode so the whole
    ///   mapping (camera ray AND sun/moon direction) can be re-oriented WITHOUT editing HLSL.
    /// </summary>
    internal static class AtmosphereShader {

        // Milestone-0 test pattern kept verbatim so ACMESKY_TESTPATTERN=1 can fall back to it.
        // (VSMain here is shared by both the test pattern and the atmosphere PS.)
        public const string Hlsl = @"
// ==========================================================================
//  cbuffer -- must match AtmosphereParamsCb in LiveSkyCompositor.cs EXACTLY.
// ==========================================================================
cbuffer SkyParams : register(b0) {
    row_major float4x4 invProj;     // inverse(ViewToClip)     : NDC -> view
    row_major float4x4 invView;     // inverse(WorldToView)    : view -> AC world
    row_major float4x4 acToShader;  // AC(E,N,U) -> shader y-up ECEF (pure rotation)
    float3 cameraPosAC;   float _pad0;   // AC world-space camera position (metres)
    float3 sunDirAC;      float _pad1;   // AC-space sun unit direction (E,N,U)
    float3 moonDirAC;     float _pad2;   // AC-space moon unit direction (E,N,U)
    float2 resolution;    float time; float exposure;
    float bottomRadiusM;  float meterToUnit; float sunAngRadius;  float sunAngRadiusPhys;
    float moonAngRadius;  float lunarScale;  float lutFlipV;      float outputMode;
    float rayMode;        float worldSwizzle; float _pad4; float _pad5;
    // --- M3 stars ---
    row_major float4x4 worldToClip;   // forward render-world -> clip (WorldToView * ViewToClip)
    row_major float4x4 eciToShader;   // star ECI unit dir -> shader y-up space (sidereal rotation)
    float starIntensity;  float starMagMin; float starMagMax; float _pad7;
};

// ==========================================================================
//  Milestone-0 test pattern (debug fallback).
// ==========================================================================
struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut VSMain(uint vid : SV_VertexID) {
    VSOut o;
    float2 uv = float2((vid << 1) & 2, vid & 2);
    o.uv = uv;
    o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

float4 PSTest(VSOut i) : SV_TARGET {
    float2 uv = i.uv;
    float bands = frac((uv.x + uv.y) * 6.0 - time * 0.5);
    float plasma = 0.5 + 0.5 * sin((uv.x * 10.0) + time) * cos((uv.y * 10.0) - time * 1.3);
    float3 col = float3(bands, plasma, 1.0 - bands);
    col = lerp(col, float3(uv.x, uv.y, 0.5 + 0.5 * sin(time)), 0.35);
    return float4(col, 1.0);
}

// ==========================================================================
//  Bruneton atmosphere (ported).  Units: KILOMETRES.
// ==========================================================================
static const float PI = 3.14159265358979323846;

static const int TRANSMITTANCE_TEXTURE_WIDTH  = 256;
static const int TRANSMITTANCE_TEXTURE_HEIGHT = 64;
static const int SCATTERING_TEXTURE_R_SIZE    = 32;
static const int SCATTERING_TEXTURE_MU_SIZE   = 128;
static const int SCATTERING_TEXTURE_MU_S_SIZE = 32;
static const int SCATTERING_TEXTURE_NU_SIZE   = 8;
static const int IRRADIANCE_TEXTURE_WIDTH     = 64;
static const int IRRADIANCE_TEXTURE_HEIGHT    = 16;

// AtmosphereParameters.DEFAULT, scaled to km (METER_TO_LENGTH_UNIT = 1/1000).
static const float3 solar_irradiance      = float3(1.474, 1.8504, 1.91198);
static const float  bottom_radius         = 6360.0;
static const float  top_radius            = 6420.0;
static const float3 rayleigh_scattering   = float3(0.005802, 0.013558, 0.0331);
static const float3 mie_scattering        = float3(0.003996, 0.003996, 0.003996);
static const float  mie_phase_function_g  = 0.8;
static const float  mu_s_min              = -0.5;  // cos(120 deg)

// Relative-luminance conversion (matches @takram sunRadianceToRelativeLuminance /
// skyRadianceToRelativeLuminance = radianceToLuminance / dot(LUMA, sunRadToLum)).
static const float3 SUN_RAD_TO_LUM = float3(1.29742301, 0.92382116, 0.87790474);
static const float3 SKY_RAD_TO_LUM = float3(1.51834920, 0.94166750, 0.86252701);

Texture2D<float4> transmittance_texture : register(t0);
Texture3D<float4> scattering_texture    : register(t1);
Texture2D<float4> irradiance_texture     : register(t2);
SamplerState samLUT : register(s0);

float4 sampleTransmittance(float2 uv) {
    if (lutFlipV > 0.5) uv.y = 1.0 - uv.y;
    return transmittance_texture.SampleLevel(samLUT, uv, 0);
}
float4 sampleScattering(float3 uvw) {
    if (lutFlipV > 0.5) uvw.y = 1.0 - uvw.y;
    return scattering_texture.SampleLevel(samLUT, uvw, 0);
}

float ClampCosine(float mu)   { return clamp(mu, -1.0, 1.0); }
float ClampDistance(float d)  { return max(d, 0.0); }
float ClampRadius(float r)    { return clamp(r, bottom_radius, top_radius); }
float SafeSqrt(float a)       { return sqrt(max(a, 0.0)); }

float DistanceToTopAtmosphereBoundary(float r, float mu) {
    float disc = r * r * (mu * mu - 1.0) + top_radius * top_radius;
    return ClampDistance(-r * mu + SafeSqrt(disc));
}

float GetTextureCoordFromUnitRange(float x, int texSize) {
    return 0.5 / float(texSize) + x * (1.0 - 1.0 / float(texSize));
}

float2 GetTransmittanceTextureUvFromRMu(float r, float mu) {
    float H = sqrt(top_radius * top_radius - bottom_radius * bottom_radius);
    float rho = SafeSqrt(r * r - bottom_radius * bottom_radius);
    float d = DistanceToTopAtmosphereBoundary(r, mu);
    float d_min = top_radius - r;
    float d_max = rho + H;
    float x_mu = (d - d_min) / (d_max - d_min);
    float x_r = rho / H;
    return float2(GetTextureCoordFromUnitRange(x_mu, TRANSMITTANCE_TEXTURE_WIDTH),
                  GetTextureCoordFromUnitRange(x_r, TRANSMITTANCE_TEXTURE_HEIGHT));
}

float3 GetTransmittanceToTopAtmosphereBoundary(float r, float mu) {
    float2 uv = GetTransmittanceTextureUvFromRMu(r, mu);
    return sampleTransmittance(uv).rgb;
}

float RayleighPhaseFunction(float nu) {
    float k = 3.0 / (16.0 * PI);
    return k * (1.0 + nu * nu);
}
float MiePhaseFunction(float g, float nu) {
    float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
    return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

float4 GetScatteringTextureUvwzFromRMuMuSNu(float r, float mu, float mu_s, float nu,
        bool intersectsGround) {
    float H = sqrt(top_radius * top_radius - bottom_radius * bottom_radius);
    float rho = SafeSqrt(r * r - bottom_radius * bottom_radius);
    float u_r = GetTextureCoordFromUnitRange(rho / H, SCATTERING_TEXTURE_R_SIZE);

    float r_mu = r * mu;
    float discriminant = r_mu * r_mu - r * r + bottom_radius * bottom_radius;
    float u_mu;
    if (intersectsGround) {
        float d = -r_mu - SafeSqrt(discriminant);
        float d_min = r - bottom_radius;
        float d_max = rho;
        u_mu = 0.5 - 0.5 * GetTextureCoordFromUnitRange(
            d_max == d_min ? 0.0 : (d - d_min) / (d_max - d_min),
            SCATTERING_TEXTURE_MU_SIZE / 2);
    } else {
        float d = -r_mu + SafeSqrt(discriminant + H * H);
        float d_min = top_radius - r;
        float d_max = rho + H;
        u_mu = 0.5 + 0.5 * GetTextureCoordFromUnitRange(
            (d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
    }

    float d = DistanceToTopAtmosphereBoundary(bottom_radius, mu_s);
    float d_min = top_radius - bottom_radius;
    float d_max = H;
    float a = (d - d_min) / (d_max - d_min);
    float D = DistanceToTopAtmosphereBoundary(bottom_radius, mu_s_min);
    float A = (D - d_min) / (d_max - d_min);
    float u_mu_s = GetTextureCoordFromUnitRange(
        max(1.0 - a / A, 0.0) / (1.0 + a), SCATTERING_TEXTURE_MU_S_SIZE);

    float u_nu = (nu + 1.0) / 2.0;
    return float4(u_nu, u_mu_s, u_mu, u_r);
}

// COMBINED_SCATTERING_TEXTURES: Mie packed in scattering.alpha.
float3 GetExtrapolatedSingleMieScattering(float4 scattering) {
    if (scattering.r < 1e-5) return float3(0.0, 0.0, 0.0);
    return scattering.rgb * scattering.a / scattering.r *
        (rayleigh_scattering.r / mie_scattering.r) *
        (mie_scattering / rayleigh_scattering);
}

float3 GetCombinedScattering(float r, float mu, float mu_s, float nu,
        bool intersectsGround, out float3 single_mie) {
    float4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(r, mu, mu_s, nu, intersectsGround);
    float tex_coord_x = uvwz.x * float(SCATTERING_TEXTURE_NU_SIZE - 1);
    float tex_x = floor(tex_coord_x);
    float lerpv = tex_coord_x - tex_x;
    float3 uvw0 = float3((tex_x + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
    float3 uvw1 = float3((tex_x + 1.0 + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
    float4 combined = sampleScattering(uvw0) * (1.0 - lerpv) + sampleScattering(uvw1) * lerpv;
    single_mie = GetExtrapolatedSingleMieScattering(combined);
    return combined.rgb;
}

// Sky quad specialisation: shadow_length = 0, no GROUND branch.
float3 GetSkyRadiance(float3 camera, float3 view_ray, float3 sun_direction,
        out float3 transmittance) {
    float r = length(camera);
    float rmu = dot(camera, view_ray);
    float dist_to_top = -rmu - SafeSqrt(rmu * rmu - r * r + top_radius * top_radius);
    if (dist_to_top > 0.0) {
        camera = camera + view_ray * dist_to_top;
        r = top_radius;
        rmu += dist_to_top;
    } else if (r > top_radius) {
        transmittance = float3(1.0, 1.0, 1.0);
        return float3(0.0, 0.0, 0.0);
    }
    float mu = rmu / r;
    float mu_s = dot(camera, sun_direction) / r;
    float nu = dot(view_ray, sun_direction);
    bool intersectsGround = false;

    transmittance = GetTransmittanceToTopAtmosphereBoundary(r, mu);
    float3 single_mie;
    float3 scattering = GetCombinedScattering(r, mu, mu_s, nu, intersectsGround, single_mie);
    return scattering * RayleighPhaseFunction(nu) +
           single_mie * MiePhaseFunction(mie_phase_function_g, nu);
}

float3 GetSolarRadiance() {
    return solar_irradiance / (PI * sunAngRadiusPhys * sunAngRadiusPhys) * SUN_RAD_TO_LUM;
}
float3 GetLunarRadiance() {
    return solar_irradiance * 0.000002 / (PI * moonAngRadius * moonAngRadius) * SUN_RAD_TO_LUM;
}

// intersectSphere from sky.glsl (moon disc).
float intersectSphere(float3 ray, float3 pt, float radius) {
    float3 P = -pt;
    float PoR = dot(P, ray);
    float D = dot(P, P) - radius * radius;
    return -PoR - sqrt(PoR * PoR - D);
}
float orenNayarDiffuse(float3 L, float3 V, float3 N) {
    float NoL = dot(N, L);
    float NoV = dot(N, V);
    float s = dot(L, V) - NoL * NoV;
    float t = lerp(1.0, max(NoL, NoV), step(0.0, s));
    return max(0.0, NoL) * (0.62406015 + 0.41284404 * s / t);
}

// ==========================================================================
//  AgX tonemap (matches three.js r16x AGXToneMapping, pmndrs ToneMappingEffect AGX).
// ==========================================================================
static const float3x3 LINEAR_SRGB_TO_LINEAR_REC2020 = float3x3(
    0.6274, 0.0691, 0.0164,
    0.3293, 0.9195, 0.0880,
    0.0433, 0.0113, 0.8956);
static const float3x3 LINEAR_REC2020_TO_LINEAR_SRGB = float3x3(
     1.6605, -0.1246, -0.0182,
    -0.5876,  1.1329, -0.1006,
    -0.0728, -0.0083,  1.1187);
static const float3x3 AgXInsetMatrix = float3x3(
    0.856627153315983, 0.137318972929847,  0.11189821299995,
    0.0951212405381588, 0.761241990602591, 0.0767994186031903,
    0.0482516061458583, 0.101439036467562, 0.811302368396859);
static const float3x3 AgXOutsetMatrix = float3x3(
     1.1271005818144368, -0.1413297634984383,  -0.14132976349843826,
    -0.11060664309660323, 1.157823702216272,   -0.11060664309660294,
    -0.016493938717834573,-0.016493938717834257, 1.2519364065950405);

float3 agxContrastApprox(float3 x) {
    float3 x2 = x * x;
    float3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x +
           0.4298 * x2 + 0.1191 * x - 0.00232;
}
// NOTE: three.js stores these matrices column-major and does M*v; HLSL mul(v, M)
// with a row-major literal reproduces the same product.
float3 agxToneMapping(float3 color) {
    const float AgxMinEv = -12.47393;
    const float AgxMaxEv = 4.026069;
    color = mul(color, LINEAR_SRGB_TO_LINEAR_REC2020);
    color = mul(color, AgXInsetMatrix);
    color = max(color, 1e-10);
    color = log2(color);
    color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
    color = clamp(color, 0.0, 1.0);
    color = agxContrastApprox(color);
    color = mul(color, AgXOutsetMatrix);
    color = pow(max(float3(0.0, 0.0, 0.0), color), float3(2.2, 2.2, 2.2));
    color = mul(color, LINEAR_REC2020_TO_LINEAR_SRGB);
    color = clamp(color, 0.0, 1.0);
    return color;
}

float3 linearToSrgb(float3 c) {
    c = saturate(c);
    float3 lo = c * 12.92;
    float3 hi = 1.055 * pow(c, 1.0 / 2.4) - 0.055;
    float3 useHi = step(0.0031308, c);
    return lerp(lo, hi, useHi);
}

// Shared tonemap tail (atmosphere + stars must match exactly).
float3 FinalColor(float3 radiance) {
    float3 color = radiance * exposure;
    if (outputMode < 1.5) {
        color = agxToneMapping(color);
        if (outputMode < 0.5) color = linearToSrgb(color);
    } else if (outputMode < 2.5) {
        color = saturate(color);
    } else {
        color = saturate(linearToSrgb(color));
    }
    return color;
}

// ==========================================================================
//  Atmosphere pixel shader.
// ==========================================================================
float4 PSAtmosphere(VSOut i) : SV_TARGET {
    // Per-pixel world-space ray (AC space): unproject far point, subtract camera.
    // rayMode selects a ray-reconstruction VARIANT so the correct one can be found live (the sky is
    // rolled ~90deg and matrix transposes did nothing -- they only rescale z/w, leaving the view x:y
    // ratio, hence the ray azimuth, unchanged). 4-9 manipulate the NDC screen axes, which DO rotate/
    // flip the reconstructed ray:
    //   0 row-vector both (baseline)     1 transpose invProj      2 transpose invView   3 transpose both
    //   4 swap NDC x<->y                 5 negate NDC y           6 negate NDC x
    //   7 swap + negate-x (rotate)       8 swap + negate-y (rotate other way)
    //   9 build NDC from SV_Position/resolution instead of the interpolated uv
    float2 nb = float2(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0);   // baseline NDC
    float2 ndc;
    if      (rayMode < 3.5) ndc = nb;                        // 0-3 baseline NDC (+ transpose variants)
    else if (rayMode < 4.5) ndc = float2(nb.y,  nb.x);       // 4 swap
    else if (rayMode < 5.5) ndc = float2(nb.x, -nb.y);       // 5 negate y
    else if (rayMode < 6.5) ndc = float2(-nb.x, nb.y);       // 6 negate x
    else if (rayMode < 7.5) ndc = float2(-nb.y, nb.x);       // 7 swap + negate-x
    else if (rayMode < 8.5) ndc = float2(nb.y, -nb.x);       // 8 swap + negate-y
    else                    ndc = float2(i.pos.x / resolution.x * 2.0 - 1.0,
                                          1.0 - i.pos.y / resolution.y * 2.0);  // 9 from SV_Position
    float4 clip = float4(ndc, 1.0, 1.0);
    bool tProj = (rayMode == 1.0) || (rayMode == 3.0);
    bool tView = (rayMode == 2.0) || (rayMode == 3.0);
    float4 vpos = tProj ? mul(invProj, clip) : mul(clip, invProj);
    vpos /= vpos.w;
    float4 wp = tView ? mul(invView, float4(vpos.xyz, 1.0)) : mul(float4(vpos.xyz, 1.0), invView);
    // The client's D3D pipeline runs in a Y-UP render world: the AC world with y and z SWAPPED.
    // Proof: PrimD3DRender::ScreenToViewTransform (acclient.c, the client's own pick-ray
    // unproject) assigns the three unprojected components to dir->x, dir->z, dir->y, and
    // Render::update_viewpoint builds WorldToView with columns (Xaxis, Zaxis, Yaxis) and
    // translation (p.x, p.z, p.y). So wp/cameraPosAC here are (E, U, N); swizzle .xzy maps them
    // back to AC (E, N, U). worldSwizzle (sky.cfg) = escape hatch, default ON.
    float3 dirRW = normalize(wp.xyz - cameraPosAC);
    bool swz = worldSwizzle > 0.5;
    float3 dirAC = swz ? dirRW.xzy : dirRW;
    float3 camPosAc = swz ? cameraPosAC.xzy : cameraPosAC;

    // AC (E,N,U) -> shader y-up space, then ECEF translate + metre->km.
    float3 camShader = mul(float4(camPosAc, 1.0), acToShader).xyz;
    float3 dirShader = normalize(mul(float4(dirAC, 0.0), acToShader).xyz);
    float3 sunShader = normalize(mul(float4(sunDirAC, 0.0), acToShader).xyz);
    float3 moonShader = normalize(mul(float4(moonDirAC, 0.0), acToShader).xyz);

    // Debug ray-basis visualisation (no env var needed -- driven by the sky.cfg file).
    //   mode 4 = AC-space ray direction as color (rayDir*0.5+0.5): a correct, continuous
    //            basis has NO vertical seam and its 'up' tint moves smoothly top<->bottom.
    //   mode 5 = shader-space (post acToShader) ray direction, to confirm zenith maps to +Y.
    if (outputMode > 3.5 && outputMode < 4.5) return float4(dirAC * 0.5 + 0.5, 1.0);
    if (outputMode > 4.5) return float4(dirShader * 0.5 + 0.5, 1.0);

    float3 cameraKm = (camShader + float3(0.0, bottomRadiusM, 0.0)) * meterToUnit;

    float3 transmittance;
    float3 radiance = GetSkyRadiance(cameraKm, dirShader, sunShader, transmittance);
    radiance *= SKY_RAD_TO_LUM;

    // Sun/moon discs are skipped when the view ray hits the ground (reference behavior;
    // without this the sun disc leaks through the below-horizon sky, which terrain
    // normally overdraws but sea/cliff sightlines would reveal).
    float rG = length(cameraKm);
    float muG = dot(cameraKm, dirShader) / rG;
    bool hitsGround = muG < 0.0 && rG * rG * (muG * muG - 1.0) + bottom_radius * bottom_radius >= 0.0;

    // Analytic sun disc.
    float fragAngle = length(ddx(dirShader) + ddy(dirShader)) / max(length(dirShader), 1e-6);
    float viewDotSun = dot(dirShader, sunShader);
    if (!hitsGround && viewDotSun > cos(sunAngRadius)) {
        float angle = acos(clamp(viewDotSun, -1.0, 1.0));
        float aa = smoothstep(sunAngRadius, sunAngRadius - fragAngle, angle);
        radiance += transmittance * GetSolarRadiance() * aa;
    }

    // Moon disc (subtle).
    if (!hitsGround && lunarScale > 0.0) {
        float isect = intersectSphere(dirShader, moonShader, moonAngRadius);
        if (isect > 0.0) {
            float3 nrm = normalize(moonShader - dirShader * isect);
            float diffuse = orenNayarDiffuse(-sunShader, dirShader, nrm);
            float angle = acos(clamp(dot(dirShader, moonShader), -1.0, 1.0));
            float aa = smoothstep(moonAngRadius, moonAngRadius - fragAngle, angle);
            radiance += transmittance * GetLunarRadiance() * lunarScale * diffuse * aa;
        }
    }

    // Tonemap: exposure then AgX (holtburger: toneMappingExposure = 5, AGX final pass).
    return float4(FinalColor(radiance), 1.0);
}

// ==========================================================================
//  M3 stars -- takram StarsMaterial (stars.vert/stars.frag) ported.
//  Drawn as a 9,096-vertex PointList AFTER the atmosphere quad, into the SAME
//  RT with no blending: each 1px star recomputes sky radiance at its pixel and
//  adds transmittance * starColor, exactly like the reference (BACKGROUND path).
//  Star data reaches the VS as a StructuredBuffer decoded host-side from
//  stars.bin (int16[3] ECI dir, u8 mag, u8[3] rgb per star).
// ==========================================================================
struct StarVert { float4 posMag; float4 rgb; };   // posMag.xyz = ECI unit dir, .w = mag 0..1
StructuredBuffer<StarVert> stars : register(t3);

struct StarVSOut {
    float4 pos : SV_POSITION;
    float3 dirShader : TEXCOORD0;   // shader-space (y-up) star direction
    float3 color : TEXCOORD1;       // Pogson-scaled linear color
};

StarVSOut VSStars(uint vid : SV_VertexID) {
    StarVSOut o;
    StarVert s = stars[vid];

    // ECI -> shader y-up (sidereal rotation, host-computed per frame).
    float3 dirShader = normalize(mul(float4(s.posMag.xyz, 0.0), eciToShader).xyz);
    o.dirShader = dirShader;

    // Pogson magnitude ramp (stars.vert): m stored 0..1 across magnitudeRange.
    float m = lerp(starMagMin, starMagMax, s.posMag.w);
    float3 v = pow(float3(10.0, 10.0, 10.0),
                   -float3(starMagMin, starMagMax, m) / 2.5);
    o.color = starIntensity * s.rgb.xyz * saturate((v.z - v.y) / (v.x - v.y));

    // Project the DIRECTION through the client camera: shader -> AC (inverse of
    // acToShader = its transpose = HLSL mul(matrix, vector)) -> render world
    // (the y/z swizzle, matching PSAtmosphere) -> forward worldToClip with w=0
    // (point at infinity; xy/w is distance-independent). Depth is forced to
    // mid-range: we have no depth buffer, but the rasterizer still clips z.
    float3 dirAC = mul(acToShader, float4(dirShader, 0.0)).xyz;
    float3 dirRW = worldSwizzle > 0.5 ? dirAC.xzy : dirAC;
    float4 clip = mul(float4(dirRW, 0.0), worldToClip);
    if (clip.w <= 1e-6) {
        o.pos = float4(0.0, 0.0, -2.0, 1.0);   // behind the camera -> clipped away
    } else {
        o.pos = float4(clip.x, clip.y, 0.5 * clip.w, clip.w);
    }
    return o;
}

float4 PSStars(StarVSOut i) : SV_TARGET {
    // Camera in ECEF km -- identical prologue to PSAtmosphere.
    float3 camPosAc = worldSwizzle > 0.5 ? cameraPosAC.xzy : cameraPosAC;
    float3 camShader = mul(float4(camPosAc, 1.0), acToShader).xyz;
    float3 cameraKm = (camShader + float3(0.0, bottomRadiusM, 0.0)) * meterToUnit;
    float3 dirShader = normalize(i.dirShader);
    float3 sunShader = normalize(mul(float4(sunDirAC, 0.0), acToShader).xyz);

    // stars.frag: discard when the ray hits the ground (star below horizon).
    float r = length(cameraKm);
    float mu = dot(cameraKm, dirShader) / r;
    float disc = r * r * (mu * mu - 1.0) + bottom_radius * bottom_radius;
    if (mu < 0.0 && disc >= 0.0) { clip(-1.0); }

    float3 transmittance;
    float3 radiance = GetSkyRadiance(cameraKm, dirShader, sunShader, transmittance);
    radiance *= SKY_RAD_TO_LUM;
    radiance += transmittance * i.color;
    return float4(FinalColor(radiance), 1.0);
}
";
    }
}
