namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 4 -- HLSL port of the takram three-clouds BEER SHADOW MAP (BSM) + LIGHT SHAFTS
    /// subsystem (vendor/takram-three-clouds/src/shaders/{shadow.frag,shadow.vert,shadowResolve.frag},
    /// the shadow-consuming half of clouds.frag, structuredSampling.glsl, varianceClipping.glsl, and
    /// @takram/three-geospatial/shaders/{cascadedShadowMaps,vogelDisk,interleavedGradientNoise}.glsl).
    ///
    /// This is the LAST piece dropped by the M2 cloud port (see CloudShader.cs class doc): cloud-on-cloud
    /// cascaded shadowing (dark undersides at scale) and crepuscular shafts through aerial perspective.
    ///
    /// WHAT THE BSM IS.  Three cascades of a 512x512 map are rendered from the SUN's view. Each texel
    /// raymarches DOWN the sun ray through the shadow-casting cloud layers and stores four numbers
    /// (shadow.frag marchClouds):
    ///     r = frontDepth        distance from the ray origin (top-of-shadow sphere) to the transmittance-
    ///                           weighted mean cloud front
    ///     g = meanExtinction    mean extinction over the samples that contributed
    ///     b = maxOpticalDepth   integrated extinction * stepSize
    ///     a = maxOpticalDepthTail   the analytic tail estimate past minTransmittance
    /// The main march then reconstructs the optical depth ABOVE any 3-D point p analytically
    /// (clouds.frag readShadowOpticalDepth):
    ///     distanceToFront = max(0, distanceToShadowTop(p) - distanceOffset - r)
    ///     opticalDepth    = min(b + a, g * distanceToFront)
    /// i.e. a Beer-Lambert slab of the mean extinction, capped by the true integrated depth. That is why
    /// it is a "Beer" shadow map and not a depth map: it is a cheap analytic transmittance oracle.
    ///
    /// PIPELINE SHAPE (see docs/lights-port/DESIGN-2026-08-22-cloud-bsm-shafts.md for the full graph):
    ///     pass S  PSCloudShadow        512x512 Texture2DArray[6], SIX RTVs in ONE draw
    ///                                  (slices 0-2 = per-cascade BSM, slices 3-5 = depth+velocity),
    ///                                  exactly takram's `outputColor[N]` + `outputDepthVelocity[N]`
    ///                                  MRT layout and its `coord + ivec3(0,0,CASCADE_COUNT)` indexing.
    ///     pass SR PSCloudShadowResolve 512x512 Texture2DArray[3] ping-pong, THREE RTVs in ONE draw
    ///                                  (shadowResolve.frag: closest-fragment velocity + variance clip).
    ///     ...then the existing pass A (raymarch) consumes the resolved array on t12.
    ///
    /// COORDINATE SPACE.  Everything here works in the shader's y-up "S space": GLOBAL AC metres rotated
    /// by acToShader, i.e. exactly `camShader` in CloudShader.cs PSClouds (landblock-local camera already
    /// corrected by cameraLbOffsetAC). ECEF = S + (0, bottomRadiusM, 0), so takram's worldToECEFMatrix /
    /// ecefToWorldMatrix / altitudeCorrection collapse to that single translate. The cascade view and
    /// orthographic matrices are built on the C# side in the SAME S space by CloudShadowCascades.cs.
    ///
    /// D3D vs GL CONVENTIONS (the two places this port is NOT byte-verbatim):
    ///   - clip-space V is flipped: shadow.frag does `clip = vUv*2-1` / `uv = clip.xy*0.5+0.5`; we do
    ///     `clip = (uv.x*2-1, 1-uv.y*2)` / `uv = (clip.x*0.5+0.5, 0.5-clip.y*0.5)`, matching PSClouds'
    ///     own NDC reconstruction. Render and lookup use the same convention, so the map is self-consistent.
    ///   - the ortho NEAR plane is clip z = 0 (D3D) rather than -1 (GL) in the `inverseShadowMatrices`
    ///     unprojection that produces the shadow ray origin.
    ///
    /// GATING.  Everything is off unless `cloudShadowOn` / `cloudShaftOn` are 1 (sky.cfg cloudshadow= /
    /// lightshafts=). With cloudShadowOn = 0 `sampleShadowOpticalDepth` returns 0 before touching a
    /// texture and the CloudShader.cs call site is guarded by an `if`, so the march is byte-identical to
    /// the current build and the C# side skips passes S and SR entirely.
    ///
    /// STRING COMPOSITION.  The helpers must be declared BEFORE CloudShader.Part (the main march calls
    /// them) while the shadow-map march itself must come AFTER it (it calls sampleWeatherC/sampleMediaC),
    /// so the source is assembled as:
    ///     AtmosphereShader.Hlsl + HelperPart + CloudShader.Part + MarchPart
    /// A handful of constants that CloudShader.Part declares later (perspectiveStepScale, cloudCameraNear,
    /// g_shadowTop) are therefore duplicated here under s_* names; every duplicate is flagged inline.
    ///
    /// Resources: t12 resolved BSM array (3 slices), t13 shadow-march output array (6 slices),
    /// t14 shadow history array (3 slices). s0 samLUT (clamp/linear) for BSM reads, s1 samWrap for STBN.
    /// </summary>
    internal static class CloudShadowShader {

        /// <summary>Full source for every cloud pass INCLUDING the BSM passes.</summary>
        public static string Hlsl => AtmosphereShader.Hlsl + HelperPart + CloudShader.Part + MarchPart;

        // ==============================================================================================
        //  PART 1 -- declared BEFORE CloudShader.Part: everything the MAIN march calls.
        // ==============================================================================================
        public const string HelperPart = @"
// ==========================================================================
//  M4 Beer Shadow Map -- consumption side (clouds.frag lines 113-249, 622-648)
//  Units: METRES.  Space: S (shader y-up global AC) unless a name says ECEF.
// ==========================================================================
Texture2DArray<float4> cloudShadowTex : register(t12);   // RESOLVED BSM, 3 slices (r,g,b,a as above)

// takram ShadowMaterial defines / CloudsMaterial defines. holtburger live values.
static const int SHADOW_CASCADE_COUNT = 3;
static const int SHADOW_SAMPLE_COUNT  = 8;

// Duplicated from CloudShader.Part because that string is appended AFTER this one:
//   s_perspectiveStepScale == perspectiveStepScale (takram clouds preset, 1.01)
//   s_cloudCameraNear      == cloudCameraNear      (10 m)
static const float s_perspectiveStepScale = 1.01;
static const float s_cloudCameraNear      = 10.0;

// Per-invocation frame state, seeded once by shadowBeginFrame() at the top of a pixel shader.
// (HLSL statics are per-invocation, so this is just a way to avoid threading five more
// parameters through marchCloudsC/marchOpticalDepthC.)
static float2 s_fragCoord;      // SV_Position.xy of the CONSUMING pixel (PCF noise)
static float3 s_camEcefM;       // camera position, ECEF metres (cascade depth)
static float3 s_sunShader;      // sun unit direction in S space
static float  s_shadowTopH;     // shadowTopHeight    (uniforms.ts: max height of shadow:true layers)
static float  s_shadowBottomH;  // shadowBottomHeight (uniforms.ts: min altitude of shadow:true layers)
static float4 s_shadowMask;     // shadowLayerMask    (1 per shadow:true layer, 0 otherwise)

// Multiplied into the local-weather read by sampleWeatherC (clouds.glsl `#ifdef SHADOW
// localWeather *= shadowLayerMask`). 1 everywhere for the main march -> exact identity.
static float4 s_weatherLayerMask = float4(1.0, 1.0, 1.0, 1.0);

// Written by marchOpticalDepthC (takram marchOpticalDepth's `out float rayDistance`): the distance
// of the LAST secondary sample, used as the BSM distanceOffset so the analytic slab only counts
// what the secondary sun march did NOT already integrate.
static float s_secondaryRayDistance;

/// Seed the per-invocation state above. Called once at the top of PSClouds / PSCloudShadow.
void shadowBeginFrame(float2 fragCoord, float3 cameraECEFm, float3 sunShader, bool storm) {
    s_fragCoord = fragCoord;
    s_camEcefM  = cameraECEFm;
    s_sunShader = sunShader;
    // cloud_storm_look.js FAIR_LAYERS / STORM_LAYERS `shadow:` flags, folded exactly the way
    // uniforms.ts updateCloudLayerUniforms folds them (shadowBottom = min altitude of the
    // shadow:true layers, shadowTop = max altitude+height, mask = per-channel flag):
    //   FAIR : r 750..1400 shadow, g 1000..2200 shadow, b cirrus no, a alto no
    //          -> bottom 750,  top 2200, mask (1,1,0,0)
    //   STORM: r 600..1250 shadow, g 850..2050 shadow, b cirrus no, a cumulonimbus 600..6600 shadow
    //          -> bottom 600,  top 6600, mask (1,1,0,1)
    // (s_shadowTopH is the same number CloudShader.Part calls g_shadowTop.)
    if (storm) {
        s_shadowBottomH = 600.0;  s_shadowTopH = 6600.0; s_shadowMask = float4(1.0, 1.0, 0.0, 1.0);
    } else {
        s_shadowBottomH = 750.0;  s_shadowTopH = 2200.0; s_shadowMask = float4(1.0, 1.0, 0.0, 0.0);
    }
}

// ---------------- small helpers (three-geospatial core/math, core/raySphereIntersection) ----------------
float shadowRemapC(float x, float a, float b) { return saturate((x - a) / (b - a)); }

// GLSL mod() (floor-based); HLSL fmod() truncates toward zero and differs for negative x.
float glslMod(float x, float y) { return x - y * floor(x / y); }

// raySphereFirstIntersection / raySphereSecondIntersection (scalar + float2 forms).
float raySphereFirstIntersection1(float3 origin, float3 dir, float radius) {
    float b = 2.0 * dot(dir, origin);
    float c = dot(origin, origin) - radius * radius;
    float disc = b * b - 4.0 * c;
    return disc < 0.0 ? -1.0 : (-b - sqrt(disc)) * 0.5;
}
float raySphereSecondIntersection1(float3 origin, float3 dir, float radius) {
    float b = 2.0 * dot(dir, origin);
    float c = dot(origin, origin) - radius * radius;
    float disc = b * b - 4.0 * c;
    return disc < 0.0 ? -1.0 : (-b + sqrt(disc)) * 0.5;
}
float2 raySphereFirstIntersection2(float3 origin, float3 dir, float2 radii) {
    float b = 2.0 * dot(dir, origin);
    float2 c = dot(origin, origin) - radii * radii;
    float2 disc = b * b - 4.0 * c;
    float2 mask = step(disc, float2(0.0, 0.0));
    return lerp((-b - sqrt(max(float2(0.0, 0.0), disc))) * 0.5, float2(-1.0, -1.0), mask);
}

// three-geospatial shaders/interleavedGradientNoise.glsl (Jimenez, SIGGRAPH 2014).
float interleavedGradientNoise(float2 coord) {
    const float3 magic = float3(0.06711056, 0.00583715, 52.9829189);
    return frac(magic.z * frac(dot(coord, magic.xy)));
}

// three-geospatial shaders/vogelDisk.glsl.
float2 vogelDisk(int index, int sampleCount, float phi) {
    const float goldenAngle = 2.39996322972865332;
    float r = sqrt(float(index) + 0.5) / sqrt(float(sampleCount));
    float theta = float(index) * goldenAngle + phi;
    return r * float2(cos(theta), sin(theta));
}

// ---------------- cascade selection (three-geospatial shaders/cascadedShadowMaps.glsl) ----------------
// getFadedCascadeIndex(viewMatrix, worldPosition, intervals, near, far, jitter), specialised:
// the reference computes viewZToOrthographicDepth(viewMatrix * worldPosition).z = (viewZ+near)/(near-far).
// With viewZ = -dot(p - camera, cameraForward) that is identically (dist - near) / (far - near), so we
// carry the camera forward axis in the cbuffer instead of a whole main-camera view matrix.
int getFadedCascadeIndexS(float3 positionECEF, float jitter) {
    float dist  = dot(positionECEF - s_camEcefM, cloudShadowCamFwd);
    float depth = (dist - cloudShadowNear) / (cloudShadowFar - cloudShadowNear);

    float2 interval;
    float intervalCenter, closestEdge, margin;
    int nextIndex = -1;
    int prevIndex = -1;
    float alpha = 0.0;   // the reference leaves this uninitialised; 0 = no fade

    [unroll] for (int i = 0; i < SHADOW_CASCADE_COUNT; ++i) {
        interval = shadowIntervals[i].xy;
        intervalCenter = (interval.x + interval.y) * 0.5;
        closestEdge = depth < intervalCenter ? interval.x : interval.y;
        margin = closestEdge * closestEdge * 0.5;
        interval += margin * float2(-0.5, 0.5);
        if (i < SHADOW_CASCADE_COUNT - 1) {
            if (depth >= interval.x && depth < interval.y) {
                prevIndex = nextIndex;
                nextIndex = i;
                alpha = saturate(min(depth - interval.x, interval.y - depth) / margin);
            }
        } else {
            // Do not fade out the last cascade.
            if (depth >= interval.x) {
                prevIndex = nextIndex;
                nextIndex = i;
                alpha = saturate((depth - interval.x) / margin);
            }
        }
    }
    return jitter <= alpha ? nextIndex : prevIndex;
}

// ---------------- BSM sampling (clouds.frag getShadowUv .. sampleShadowOpticalDepth) ----------------
// clouds.frag getShadowUv. Note the D3D V flip (see class doc).
float2 getShadowUvS(float3 positionS, int cascadeIndex) {
    float4 clip = mul(float4(positionS, 1.0), shadowMatrices[cascadeIndex]);
    clip /= clip.w;
    return float2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
}

// clouds.frag getDistanceToShadowTop: distance along the SUN direction to the top-of-shadow
// sphere, which is exactly where the BSM ray origin sits.
float getDistanceToShadowTop(float3 rayPositionECEF) {
    return raySphereSecondIntersection1(rayPositionECEF, s_sunShader, bottomRadiusM + s_shadowTopH);
}

// clouds.frag readShadowOpticalDepth (the Beer reconstruction; see the class doc).
float readShadowOpticalDepth(float2 uv, float distanceToTop, float distanceOffset, int cascadeIndex) {
    float4 shadow = cloudShadowTex.SampleLevel(samLUT, float3(uv, (float)cascadeIndex), 0.0);
    float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);
    return min(shadow.b + shadow.a, shadow.g * distanceToFront);
}

// clouds.frag sampleShadowOpticalDepthPCF (Vogel disk, IGN-rotated).
float sampleShadowOpticalDepthPCF(float3 positionS, float distanceToTop, float distanceOffset,
                                  float radius, int cascadeIndex) {
    float2 uv = getShadowUvS(positionS, cascadeIndex);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    if (radius < 0.1) return readShadowOpticalDepth(uv, distanceToTop, distanceOffset, cascadeIndex);

    // The reference rotates by interleavedGradientNoise(gl_FragCoord.xy + temporalJitter * resolution).
    // We have no sub-pixel TAA jitter in this pipeline, so the term is 0.
    float phi = interleavedGradientNoise(s_fragCoord) * (2.0 * PI);
    float2 texelSize = 1.0 / cloudShadowMapSize;
    float sum = 0.0;
    [unroll] for (int i = 0; i < SHADOW_SAMPLE_COUNT; ++i) {
        float2 offset = vogelDisk(i, SHADOW_SAMPLE_COUNT, phi);
        sum += readShadowOpticalDepth(uv + offset * radius * texelSize,
                                      distanceToTop, distanceOffset, cascadeIndex);
    }
    return sum / float(SHADOW_SAMPLE_COUNT);
}

// clouds.frag sampleShadowOpticalDepth. rayPosition is ECEF metres.
float sampleShadowOpticalDepth(float3 rayPositionECEF, float distanceOffset, float radius, float jitter) {
    if (cloudShadowOn < 0.5) return 0.0;   // knob off -> exact previous behaviour, no texture read
    float distanceToTop = getDistanceToShadowTop(rayPositionECEF);
    if (distanceToTop <= 0.0) return 0.0;
    float3 positionS = rayPositionECEF - float3(0.0, bottomRadiusM, 0.0);   // ecefToWorld
    int cascadeIndex = getFadedCascadeIndexS(rayPositionECEF, jitter);
    return cascadeIndex >= 0
        ? sampleShadowOpticalDepthPCF(positionS, distanceToTop, distanceOffset, radius, cascadeIndex)
        : 0.0;
}

// ---------------- light shafts (clouds.frag marchShadowLength) ----------------
// Integrates the SHADOWED fraction of the view ray: sum over the ray of (1 - exp(-opticalDepth)) * ds.
// The result is a LENGTH in metres that Bruneton's GetSkyRadianceToPoint subtracts from the in-scatter
// path (runtime.glsl: `d = max(d - shadow_length, 0)` + the shadow_transmittance branch), which is what
// makes the crepuscular rays appear.
float marchShadowLength(float3 rayOriginECEF, float3 rayDirection, float2 rayNearFar, float jitter) {
    float shadowLength = 0.0;
    float maxRayDistance = rayNearFar.y - rayNearFar.x;
    float stepSize = cloudShaftMinStep;
    float rayDistance = stepSize * jitter;
    const float attenuationFactor = 1.0 - 5e-4;   // declared but never applied in the reference
    float attenuation = 1.0;
    int iters = (int)cloudShaftIters;

    [loop] for (int i = 0; i < iters; ++i) {
        if (rayDistance > maxRayDistance) break;   // termination
        float3 position = rayDistance * rayDirection + rayOriginECEF;
        float opticalDepth = sampleShadowOpticalDepth(position, 0.0, 0.0, jitter);
        shadowLength += (1.0 - exp(-opticalDepth)) * stepSize * attenuation;
        stepSize *= s_perspectiveStepScale;
        rayDistance += stepSize;
    }
    return shadowLength;
}

// clouds.frag getShadowRayNearFar. `first`/`second` are the raySphereIntersections4 results already
// computed by getCloudRayNearFar for radii bottomRadius + (0, minHeight, maxHeight, shadowTopHeight),
// so .w is the shadow-top sphere and .x is the ground -- exactly the components the reference reads.
float2 getShadowRayNearFarC(float4 first, float4 second, float cameraHeight, bool hitsGround) {
    float2 nearFar;
    if (cameraHeight < s_shadowTopH) {
        nearFar = hitsGround ? float2(s_cloudCameraNear, first.x)
                             : float2(s_cloudCameraNear, second.w);
    } else {
        nearFar = float2(first.w, second.w);
        if (hitsGround) nearFar.y = first.x;   // clamp the ray at the ground
    }
    nearFar.y = min(nearFar.y, cloudShaftMaxDist);
    return nearFar;
}
";

        // ==============================================================================================
        //  PART 2 -- declared AFTER CloudShader.Part: the shadow-map RENDER + its temporal resolve.
        //  These call sampleWeatherC / sampleMediaC / insideLayerIntervals / getGlobeUv / selectLayers,
        //  all of which live in CloudShader.Part.
        // ==============================================================================================
        public const string MarchPart = @"
// ==========================================================================
//  M4 Beer Shadow Map -- production side (shadow.frag + shadowResolve.frag)
// ==========================================================================
Texture2DArray<float4> cloudShadowSrcTex  : register(t13);  // pass S output, 6 slices
Texture2DArray<float4> cloudShadowHistTex : register(t14);  // resolved history, 3 slices

// takram ShadowMaterial uniform, defaults.shadow: opticalDepthTailScale = 2.
static const float shadowOpticalDepthTailScale = 2.0;

// shadow.frag: per-cascade weather mip. TODO in the reference: derive from the main frustum.
static const float shadowMipLevels[4] = { 0.0, 0.5, 1.0, 2.0 };

// ---------------- structured volume sampling (structuredSampling.glsl) ----------------
// SVS introduces spatial aliasing but is TEMPORALLY STABLE, which matters at 512x512 where a single
// flickering texel is very visible. Reference: huwb/volsample + shadertoy ttVfDc.
void getIcosahedralVertices(float3 direction, out float3 v1, out float3 v2, out float3 v3) {
    const float a = 0.85065080835204;      // phi / sqrt(2 + phi)
    const float b = 0.5257311121191336;    // 1 / sqrt(2 + phi)
    const float kT  = 0.6180339887498948;  // 1 / phi
    const float kT2 = 0.38196601125010515; // 1 / phi^2
    float3 absD = abs(direction);
    float selector1 = dot(absD, float3(1.0, kT2, -kT));
    float selector2 = dot(absD, float3(-kT, 1.0, kT2));
    float selector3 = dot(absD, float3(kT2, -kT, 1.0));
    v1 = selector1 > 0.0 ? float3(a, b, 0.0) : float3(-b, 0.0, a);
    v2 = selector2 > 0.0 ? float3(0.0, a, b) : float3(a, -b, 0.0);
    v3 = selector3 > 0.0 ? float3(b, 0.0, a) : float3(0.0, a, -b);
    float3 octantSign = sign(direction);
    v1 *= octantSign;
    v2 *= octantSign;
    v3 *= octantSign;
}

void swapIfBigger(inout float4 a, inout float4 b) {
    if (a.w > b.w) { float4 t = a; a = b; b = t; }
}

void sortVertices(inout float3 a, inout float3 b, inout float3 c) {
    const float3 base = float3(0.5, 0.5, 1.0);
    float4 aw = float4(a, dot(a, base));
    float4 bw = float4(b, dot(b, base));
    float4 cw = float4(c, dot(c, base));
    swapIfBigger(aw, bw);
    swapIfBigger(bw, cw);
    swapIfBigger(aw, bw);
    a = aw.xyz; b = bw.xyz; c = cw.xyz;
}

float3 getPentagonalWeights(float3 direction, float3 v1, float3 v2, float3 v3) {
    float d1 = dot(v1, direction);
    float d2 = dot(v2, direction);
    float d3 = dot(v3, direction);
    float3 w = exp(float3(d1, d2, d3) * 40.0);
    return w / (w.x + w.y + w.z);
}

float3 getStructureNormal(float3 direction, float jitter) {
    float3 a, b, c;
    getIcosahedralVertices(direction, a, b, c);
    sortVertices(a, b, c);
    float3 weights = getPentagonalWeights(direction, a, b, c);
    return jitter < weights.x ? a : (jitter < weights.x + weights.y ? b : c);
}

// volsample RayMarchCore.cginc
void intersectStructuredPlanes(float3 normal, float3 rayOrigin, float3 rayDirection,
                               float samplePeriod, out float stepOffset, out float stepSize) {
    float NoD = dot(rayDirection, normal);
    stepSize = samplePeriod / abs(NoD);
    // Skip the leftover bit from rayOrigin to the first strata plane. GLSL mod(), not fmod().
    stepOffset = -glslMod(dot(rayOrigin, normal), samplePeriod) / NoD;
    // Make the sign consistent and ensure the first sample is in front of the viewer.
    if (stepOffset < 0.0) stepOffset += stepSize;
}

// ---------------- shadow.frag marchClouds ----------------
// Returns (frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail).
float4 shadowMarchClouds(float3 rayOriginECEF, float3 rayDirection, float maxRayDistance,
                         float jitter, float mipLevel) {
    float3 normal = getStructureNormal(rayDirection, jitter);
    float rayDistance, stepSize;
    intersectStructuredPlanes(
        normal, rayOriginECEF, rayDirection,
        clamp(maxRayDistance / max(cloudShadowIters, 1.0), cloudShadowMinStep, cloudShadowMaxStep),
        rayDistance, stepSize);

    rayDistance -= stepSize * jitter;   // TEMPORAL_JITTER (on in ShadowMaterial defines)

    float extinctionSum = 0.0;
    float maxOpticalDepth = 0.0;
    float maxOpticalDepthTail = 0.0;
    float transmittanceIntegral = 1.0;
    float weightedDistanceSum = 0.0;
    float transmittanceSum = 0.0;
    int sampleCount = 0;
    int iters = (int)cloudShadowIters;

    [loop] for (int i = 0; i < iters; ++i) {
        if (rayDistance > maxRayDistance) break;   // termination

        float3 position = rayDistance * rayDirection + rayOriginECEF;
        float height = length(position) - bottomRadiusM;

        if (insideLayerIntervals(height)) { rayDistance += stepSize; continue; }

        float2 uv = getGlobeUv(position);
        WeatherSample weather = sampleWeatherC(uv, height, mipLevel);

        if (any(weather.density > float4(minDensity, minDensity, minDensity, minDensity))) {
            MediaSample media = sampleMediaC(weather, position, uv, mipLevel, jitter);
            if (media.extinction > minExtinction) {
                extinctionSum += media.extinction;
                maxOpticalDepth += media.extinction * stepSize;
                transmittanceIntegral *= exp(-media.extinction * stepSize);
                weightedDistanceSum += rayDistance * transmittanceIntegral;
                transmittanceSum += transmittanceIntegral;
                ++sampleCount;
            }
        }

        if (transmittanceIntegral <= cloudShadowMinTrans) {
            // A large amount of optical depth accumulates in the tail beyond the point of minimum
            // transmittance; the expected value falls off exponentially with the number of samples
            // taken before reaching it. https://x.com/shotamatsuda/status/1886259549931520437
            maxOpticalDepthTail = min(
                shadowOpticalDepthTailScale * stepSize * exp(float(1 - sampleCount)),
                stepSize * 0.5);   // excessive optical depth only introduces aliasing
            break;                 // early termination
        }
        rayDistance += stepSize;
    }

    if (sampleCount == 0) return float4(maxRayDistance, 0.0, 0.0, 0.0);
    float frontDepth = min(weightedDistanceSum / transmittanceSum, maxRayDistance);
    float meanExtinction = extinctionSum / float(sampleCount);
    return float4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail);
}

// shadow.frag getRayNearFar: from the sun-side origin, down through the shadow slab.
void shadowGetRayNearFar(float3 sunPositionECEF, float3 rayDirection,
                         out float rayNear, out float rayFar) {
    float2 firstIntersections = raySphereFirstIntersection2(
        sunPositionECEF, rayDirection,
        bottomRadiusM + float2(s_shadowTopH, s_shadowBottomH));
    rayNear = max(0.0, firstIntersections.x);
    rayFar = firstIntersections.y;
    if (rayFar < 0.0) rayFar = 1e6;
}

// shadow.frag cascade()
void shadowCascade(int cascadeIndex, float mipLevel, float2 uv,
                   out float4 outColor, out float4 outDepthVelocity) {
    // clip -> S space via the cascade's inverse view-projection, at the ORTHO NEAR PLANE
    // (GL z = -1; D3D z = 0), then S -> ECEF. This is takram's worldToECEF + altitudeCorrection.
    float2 clip = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    float4 pt = mul(float4(clip, 0.0, 1.0), invShadowMatrices[cascadeIndex]);
    pt /= pt.w;
    float3 sunPositionECEF = pt.xyz + float3(0.0, bottomRadiusM, 0.0);

    float3 rayDirection = normalize(-s_sunShader);
    float rayNear, rayFar;
    shadowGetRayNearFar(sunPositionECEF, rayDirection, rayNear, rayFar);
    float3 rayOrigin = rayNear * rayDirection + sunPositionECEF;

    // clouds.glsl getSTBN (128x128x64 blue noise, wrapped; frame index is the z slice).
    float stbn = stbnTex.SampleLevel(samWrap,
        float3(s_fragCoord, fmod(cloudFrame, 64.0)) / float3(128.0, 128.0, 64.0), 0.0);

    float4 color = shadowMarchClouds(rayOrigin, rayDirection, rayFar - rayNear, stbn, mipLevel);
    outColor = color;

    // Velocity for the temporal resolve (TEMPORAL_PASS): reproject the mean cloud front with LAST
    // frame's cascade matrix. Stored in TEXELS, exactly like the reference (the resolve multiplies
    // by texelSize again).
    float3 frontPositionECEF = color.x * rayDirection + rayOrigin;
    float3 frontPositionS = frontPositionECEF - float3(0.0, bottomRadiusM, 0.0);
    float4 prevClip = mul(float4(frontPositionS, 1.0), shadowReprojMatrices[cascadeIndex]);
    prevClip /= prevClip.w;
    float2 prevUv = float2(prevClip.x * 0.5 + 0.5, 0.5 - prevClip.y * 0.5);
    float2 velocity = (uv - prevUv) * cloudShadowMapSize;
    outDepthVelocity = float4(color.x, velocity, 0.0);
}

// One draw, SIX render targets: slices 0-2 of the shadow array (BSM) and slices 3-5 (depth+velocity).
// That is takram's `layout(location = 0) out vec4 outputColor[CASCADE_COUNT]` +
// `layout(location = CASCADE_COUNT) out vec3 outputDepthVelocity[CASCADE_COUNT]` layout verbatim.
struct PSCloudShadowOut {
    float4 c0 : SV_Target0;
    float4 c1 : SV_Target1;
    float4 c2 : SV_Target2;
    float4 v0 : SV_Target3;
    float4 v1 : SV_Target4;
    float4 v2 : SV_Target5;
};

PSCloudShadowOut PSCloudShadow(VSOut i) {
    PSCloudShadowOut o;
    bool storm = cloudStorm > 0.5;
    selectLayers(storm);                                   // CloudShader.Part: the look tables
    float3 sunShader = normalize(mul(float4(sunDirAC, 0.0), acToShader).xyz);
    shadowBeginFrame(i.pos.xy, float3(0.0, 0.0, 0.0), sunShader, storm);
    s_weatherLayerMask = s_shadowMask;                     // clouds.glsl `#ifdef SHADOW`

    shadowCascade(0, shadowMipLevels[0], i.uv, o.c0, o.v0);
    shadowCascade(1, shadowMipLevels[1], i.uv, o.c1, o.v1);
    shadowCascade(2, shadowMipLevels[2], i.uv, o.c2, o.v2);
    return o;
}

// ---------------- shadowResolve.frag ----------------
// varianceClipping.glsl, VARIANCE_9_SAMPLES + VARIANCE_SAMPLER_ARRAY variant.
static const int2 shadowVarOffsets[8] = {
    int2(-1, -1), int2(-1, 1), int2(1, -1), int2(1, 1),
    int2(1, 0), int2(0, -1), int2(0, 1), int2(-1, 0)
};

// playdeadgames/temporal clipAABB.
float4 shadowClipAABB(float4 current, float4 history, float4 minColor, float4 maxColor) {
    float3 pClip = 0.5 * (maxColor.rgb + minColor.rgb);
    float3 eClip = 0.5 * (maxColor.rgb - minColor.rgb) + 1e-7;
    float4 vClip = history - float4(pClip, current.a);
    float3 vUnit = vClip.xyz / eClip;
    float3 aUnit = abs(vUnit);
    float maUnit = max(aUnit.x, max(aUnit.y, aUnit.z));
    if (maUnit > 1.0) return float4(pClip, current.a) + vClip / maUnit;
    return history;
}

// NVIDIA/Salvi variance clipping (GDC 2016). Neighbour coords are CLAMPED: GLSL texelFetchOffset is
// undefined out of range while D3D Load returns 0, which would drag the mean toward black at the edges.
float4 shadowVarianceClip(int3 coord, int2 maxCoord, float4 current, float4 history, float gamma) {
    float4 moment1 = current;
    float4 moment2 = current * current;
    [unroll] for (int k = 0; k < 8; ++k) {
        int2 c = clamp(coord.xy + shadowVarOffsets[k], int2(0, 0), maxCoord);
        float4 neighbor = cloudShadowSrcTex.Load(int4(c, coord.z, 0));
        moment1 += neighbor;
        moment2 += neighbor * neighbor;
    }
    const float N = 9.0;
    float4 mean = moment1 / N;
    float4 varianceGamma = sqrt(max(moment2 / N - mean * mean, 0.0)) * gamma;
    float4 minColor = mean - varianceGamma;
    float4 maxColor = mean + varianceGamma;
    return shadowClipAABB(clamp(mean, minColor, maxColor), history, minColor, maxColor);
}

// shadowResolve.frag getClosestFragment: 3x3 min over the DEPTH-VELOCITY slice (cascade + 3).
float4 shadowClosestFragment(int3 coord, int2 maxCoord) {
    float4 result = float4(1e7, 0.0, 0.0, 0.0);
    [unroll] for (int y = -1; y <= 1; ++y) {
        [unroll] for (int x = -1; x <= 1; ++x) {
            int2 c = clamp(coord.xy + int2(x, y), int2(0, 0), maxCoord);
            float4 neighbor = cloudShadowSrcTex.Load(int4(c, coord.z + SHADOW_CASCADE_COUNT, 0));
            if (neighbor.r < result.r) result = neighbor;
        }
    }
    return result;
}

// shadowResolve.frag cascade()
float4 shadowResolveCascade(int cascadeIndex, float2 uv, int2 pix, int2 maxCoord) {
    int3 coord = int3(pix, cascadeIndex);
    float4 current = cloudShadowSrcTex.Load(int4(coord, 0));
    if (cloudShadowHistValid < 0.5) return current;

    float4 depthVelocity = shadowClosestFragment(coord, maxCoord);
    float2 velocity = depthVelocity.gb / cloudShadowMapSize;   // texels -> uv (reference texelSize)
    float2 prevUv = uv - velocity;
    if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) return current;  // rejection

    float4 history = cloudShadowHistTex.SampleLevel(samLUT, float3(prevUv, (float)cascadeIndex), 0.0);
    float4 clippedHistory = shadowVarianceClip(coord, maxCoord, current, history, cloudShadowGamma);
    return lerp(clippedHistory, current, cloudShadowAlpha);
}

struct PSCloudShadowResolveOut {
    float4 c0 : SV_Target0;
    float4 c1 : SV_Target1;
    float4 c2 : SV_Target2;
};

PSCloudShadowResolveOut PSCloudShadowResolve(VSOut i) {
    PSCloudShadowResolveOut o;
    int2 pix = int2(i.pos.xy);
    int2 maxCoord = int2(cloudShadowMapSize) - int2(1, 1);
    o.c0 = shadowResolveCascade(0, i.uv, pix, maxCoord);
    o.c1 = shadowResolveCascade(1, i.uv, pix, maxCoord);
    o.c2 = shadowResolveCascade(2, i.uv, pix, maxCoord);
    return o;
}

// ---------------- debug view (clouds.frag DEBUG_SHOW_SHADOW_MAP getCascadedShadowMaps) ----------------
// sky.cfg output=10: the three cascades tiled 2x2 over the screen, scaled the way the reference does
// (r * 1e-5, g * 10, (b + a) * 0.01).
float4 PSCloudShadowDebug(VSOut i) : SV_TARGET {
    float2 uv = i.uv;
    float4 coord = float4(uv, uv - 0.5) * 2.0;
    float4 shadow = float4(0.0, 0.0, 0.0, 0.0);
    if (uv.y < 0.5) {
        if (uv.x < 0.5) shadow = cloudShadowTex.SampleLevel(samLUT, float3(coord.xy, 0.0), 0.0);
        else            shadow = cloudShadowTex.SampleLevel(samLUT, float3(coord.zy, 1.0), 0.0);
    } else {
        if (uv.x < 0.5) shadow = cloudShadowTex.SampleLevel(samLUT, float3(coord.xw, 2.0), 0.0);
    }
    const float frontDepthScale = 1e-5;
    const float meanExtinctionScale = 10.0;
    const float maxOpticalDepthScale = 0.01;
    float3 color = (shadow.rgb + float3(0.0, 0.0, shadow.a)) *
                   float3(frontDepthScale, meanExtinctionScale, maxOpticalDepthScale);
    return float4(saturate(color), 1.0);
}
";
    }
}
