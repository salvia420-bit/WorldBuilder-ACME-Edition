# AcmeSky M4 — Beer Shadow Map + light shafts port design

**Date** 2026-08-22 · **Branch** `integ/all-20260813` · **Status** DRAFT (shader + CPU cascade math landed as new
files; the four consuming diffs below are NOT applied)

Ports the takram three-clouds cascaded **Beer Shadow Map** (BSM) and **shadow-length / light-shafts**
subsystem from holtburger-web (WebGL/three.js) into AcmeSky's own D3D11 (ps_5_0, Vortice) sky device.
This is the last visual gap called out in `CloudShader.cs`'s class doc:

> STILL DROPPED vs the full takram stack (the one remaining gap): the Beer Shadow Map + light shafts
> (a cascaded shadow-pass subsystem) and temporal reprojection.

(Temporal reprojection landed as M2.2 `PSCloudResolve`; this document closes the rest.)

## 0. Files

| File | State | Contents |
|---|---|---|
| `AcmeSky/Services/LiveSky/CloudShadowShader.cs` | **NEW, compiles** | The complete HLSL: `PSCloudShadow`, `PSCloudShadowResolve`, `PSCloudShadowDebug`, plus every helper the main march calls (`sampleShadowOpticalDepth`, `marchShadowLength`, `getFadedCascadeIndexS`, `getShadowRayNearFarC`). |
| `AcmeSky/Services/LiveSky/CloudShadowCascades.cs` | **NEW, compiles** | CPU per-frame cascade splits + sun-view/ortho matrices (`CascadedShadowMaps.ts` + `splitFrustum.ts` + `FrustumCorners.ts`). |
| `AtmosphereShader.cs`, `CloudShader.cs`, `LiveSkyCompositor.cs`, `SkyConfig.cs` | diffs in §7 | **not touched** — apply by hand. |

## 1. What the BSM actually is

Three cascades of a 512×512 map are rendered **from the sun's view**. Each texel marches *down* the sun ray
through the shadow-casting cloud layers and stores four numbers (`shadow.frag` `marchClouds`):

```
r = frontDepth          distance from the ray origin (top-of-shadow sphere) to the
                        transmittance-weighted mean cloud front
g = meanExtinction      mean extinction over the contributing samples
b = maxOpticalDepth     Σ extinction · stepSize
a = maxOpticalDepthTail analytic estimate of the depth past minTransmittance
```

The main march then reconstructs the optical depth *above* an arbitrary point analytically
(`clouds.frag` `readShadowOpticalDepth`):

```
distanceToFront = max(0, distanceToShadowTop(p) − distanceOffset − r)
opticalDepth    = min(b + a, g · distanceToFront)
```

— a Beer–Lambert slab of the mean extinction, capped by the true integrated depth. It is a cheap
**analytic transmittance oracle**, not a depth map. `distanceOffset` is the distance the secondary sun
march already covered (`marchOpticalDepth`'s `out rayDistance`), so the two never double-count.

`marchShadowLength` then integrates `(1 − exp(−opticalDepth)) · ds` along the *view* ray, producing a
**length in metres** that Bruneton's `GetSkyRadianceToPoint` subtracts from the in-scatter path
(`runtime.glsl`: `d = max(d − shadow_length, 0)` plus the `shadow_transmittance` branch). That subtraction
is what makes crepuscular rays appear.

## 2. Pass graph

`RenderAndUpload` currently runs: **atmosphere quad → stars → pass A (cloud raymarch, MRT) → pass R
(temporal resolve, ping-pong) → pass B (premultiplied composite) → readback**.

Two passes slot in *before* pass A (the BSM must exist before the march that samples it):

```
  atmosphere quad  (PSAtmosphere, full-res B8G8R8A8)
  stars            (PSStars, PointList)
+ pass S   PSCloudShadow         512×512 ×6 RTVs, ONE Draw(3)      ~0.6–1.5 ms
+ pass SR  PSCloudShadowResolve  512×512 ×3 RTVs, ONE Draw(3)      <0.1 ms
  pass A   PSClouds              cloudRes MRT (color + depthVel)   now also reads t12
  pass R   PSCloudResolve        cloudRes ping-pong
  pass B   PSCloudComposite      full-res, premultiplied over
  CopyResource → Map → D3D9 upload → DrawPrimitiveUP
```

Ordering rules (mirrors `CloudsEffect.update`: `shadowPass.update(...)` then `cloudsPass.update(...)`):

1. `CloudShadowCascades.Update(...)` runs **once per frame in `BuildCb`**, before the cbuffer is mapped.
   It rotates this frame's `Matrix[]` into `ReprojectionMatrix[]` first, so during frame *N*'s render the
   reprojection matrices hold frame *N−1*'s — exactly `ShadowPass.copyReprojection`'s ordering.
2. Pass S writes the current BSM + depth/velocity; pass SR variance-clips it against the history and
   ping-pongs. The main march reads the **resolved** array (`ShadowPass.outputBuffer` returns the buffer
   already swapped into `historyRenderTarget`).
3. `cloudShadowHistValid` is 0 on the first frame after (re)creation, on a resize, and after a landblock
   teleport — pass SR then passes `current` straight through, exactly like `cloudHistValid` does today.

### 2.1 Why a Texture2DArray, not an atlas

takram renders all cascades in **one** fragment pass via MRT into a `WebGLArrayRenderTarget`
(`outputColor[N]` at locations 0…N−1, `outputDepthVelocity[N]` at locations N…2N−1, i.e. array slices
`coord + ivec3(0,0,CASCADE_COUNT)`). D3D11 allows **8 simultaneous RTVs**; 3 cascades × 2 outputs = **6**,
so the whole thing is one `Draw(3)` with six RTVs bound, each an `ArraySize = 1` view onto a distinct slice
of one `ArraySize = 6` texture. That is *both* one pass **and** faithful to the reference layout.

A 3-tile atlas in one RT would be strictly worse here:

* it needs a manual per-tile UV clamp on **every** BSM read (the PCF Vogel disk at
  `maxShadowFilterRadius = 6` texels reaches across tile borders and would bleed a neighbouring cascade in);
* the reference's out-of-bounds test `uv.x < 0 || uv.x > 1 || …` (which returns 0 optical depth — the
  "outside this cascade" signal) becomes a tile-relative test that no longer matches the source;
* `Texture2DArray.SampleLevel(s, float3(uv, slice), 0)` maps 1:1 to `texture(sampler2DArray, vec3(uv, i))`,
  so the ported code stays literal;
* it saves nothing: the pass count is identical (one draw either way).

## 3. Render targets

| Name | Dim | Format | Bind | Notes |
|---|---|---|---|---|
| `_shadowRt` | 512×512, `ArraySize = 6` | `R16G16B16A16_Float` | RT \| SRV | slices 0–2 BSM, 3–5 depth+velocity. 6 RTVs (`Texture2DArray`, `FirstArraySlice = k`, `ArraySize = 1`) + 1 whole-array SRV. |
| `_shadowResolveRt[2]` | 512×512, `ArraySize = 3` | `R16G16B16A16_Float` | RT \| SRV | ping-pong. 3 RTVs each + 1 array SRV each. |

Memory: 512·512·8 B = 2 MiB/slice → 6 + 3 + 3 = 12 slices = **24 MiB**. Negligible.

Half-float range check: `frontDepth` can reach `1e6` (the `rayFar` fallback in
`shadow.frag getRayNearFar`); fp16 max is 65 504, so **`r` saturates to +Inf for total-miss texels**.
takram has the identical exposure (`HalfFloatType` render target) and it is benign — a miss texel has
`g = 0`, so `readShadowOpticalDepth` returns `min(0 + 0, 0 · anything) = 0`, and `Inf · 0` never happens
because `g` multiplies `distanceToFront`, not `r`. `distanceToFront = max(0, top − offset − Inf) = 0`.
Both paths give 0. Do **not** "fix" this by clamping `rayFar` — it would change the miss encoding.

`LinearFilter` + clamp addressing on the array SRV, i.e. the existing `samLUT` (s0). No mips.

## 4. Register map

| Slot | Bound | Owner |
|---|---|---|
| t0–t2 | Bruneton LUTs | M1 |
| t3 | star StructuredBuffer (VS) | M3 |
| t4–t7 | weather, shape, shapeDetail, STBN | M2 |
| t8 | cloud RT (resolve/composite input) | M2 / M2.2 |
| t9 | turbulence | M2 |
| t10–t11 | cloud velocity, cloud history | M2.2 |
| **t12** | **resolved BSM array (3 slices)** — pass A | **M4** |
| **t13** | **pass-S output array (6 slices)** — pass SR | **M4** |
| **t14** | **BSM history array (3 slices)** — pass SR | **M4** |
| s0 | `samLUT` (clamp, linear) — also the BSM sampler | M1 |
| s1 | `samWrap` — also the shadow pass's STBN sampler | M2 |

Pass S binds t4–t7 + t9 (it re-uses `sampleWeatherC`/`sampleMediaC`). Pass SR binds t13 + t14 only.
Pass A additionally binds t12. Unbind t13/t14 after pass SR and t12 after pass A (t12's resource becomes a
render target again next frame).

## 5. Cascade math — who computes what

All of it is `CloudShadowCascades.Update(...)`, called once per frame from `BuildCb`.

**Space.** takram runs the cascades in three.js *world* space and converts to ECEF in the shader. We run
them directly in the shader's **S space** — GLOBAL AC metres rotated by `acToShader`, y-up, sea level at
`y = 0`, i.e. exactly `camShader` in `PSClouds` after the `cameraLbOffsetAC` correction. Then
`ECEF = S + (0, bottomRadiusM, 0)`, so takram's `worldToECEFMatrix` / `ecefToWorldMatrix` /
`altitudeCorrection` collapse to that one translate (applied inside the shader). Keeping the matrices in S
rather than ECEF also keeps the magnitudes at ≤ ~50 km instead of 6 360 km, which matters for fp32 shadow
UVs. Because S is *global*, the cascade matrices stay continuous across landblock transitions — the
temporal history does not have to be dropped when `cameraLbOffsetAC` changes.

**Per frame, in order** (`CascadedShadowMaps.update`):

1. `far = shadowFar` (sky.cfg `cloudshadowfar`, default **5000 m** = holtburger's measured `shadowMaps.far`;
   `maxFar = null`, `farScale = 1` there, so it is just `camera.far`).
2. **Frustum corners** (`FrustumCorners.setFromCamera`). three unprojects GL NDC z = ±1; D3D's near plane is
   z = 0, so we unproject `(±1, ±1, 0)` through `invProj` and recover `near = |near[0].z|`. For a
   perspective camera the far corner clamped to `far` is simply `near[i] · (far / |near[i].z|)` — identical
   to three's `corner.multiplyScalar(min(far/absZ, 1))`, and it needs no far plane from the client
   projection at all. Corner order is three's: `[0]=(1,1) [1]=(1,−1) [2]=(−1,−1) [3]=(−1,1)`, so `0`↔`2`
   is the diagonal.
3. **Splits** — `splitFrustum('practical', 3, near, far, λ = 0.6)` (`CloudsEffect` passes `splitLambda: 0.6`):

   ```
   uniform_i     = (near + (far−near)·(i+1)/count) / far
   logarithmic_i = (near · (far/near)^((i+1)/count)) / far
   split_i       = lerp(uniform_i, logarithmic_i, λ)
   ```

   With `near = 10`, `far = 5000`, `count = 3`, `λ = 0.6` this gives
   `splits = [0.14339, 0.34253, 1.0]` → intervals `(0, 0.14339) (0.14339, 0.34253) (0.34253, 1.0)`
   → cascade far distances ≈ **725 m, 1 719 m, 5 000 m**. Use these as the arithmetic self-check.
4. **Light orientation** — three's `Matrix4.lookAt(0, −sunDirection, UP)`: a rotation whose **+Z axis *is*
   `sunDirection`**, `x = normalize(cross(UP, z))`, `y = cross(z, x)`. Returned row-vector, so it maps
   light → S; `S → light` is its transpose. `cameraToLight = viewToS · transpose(lightOrientation)`.
5. **Per cascade**
   * `radius = getFrustumRadius(...)` = ½·max(far-plane diagonal, whole-frustum diagonal), plus the
     `fade` expansion `0.25 · (far[0].z/(far−near))² · (far−near)`.
   * `projection = ortho(−r, r, −r, r, near = −margin = 0, far = 2r + margin)`.
     `System.Numerics.CreateOrthographicOffCenter` is RH with clip z ∈ [0,1], matching the shader's
     `clip z = 0` near-plane unprojection.
   * bbox of the 8 split-frustum corners in light space; `center = bbox.center`, `center.z = bbox.max.z`.
   * **texel snapping**: `center.xy = round(center.xy / texelSize) · texelSize`, `texelSize = 2r / 512`.
     This is what stops the cascade shimmering as the camera moves.
   * `center → S` via `lightOrientation`; `position = sunDirection · distance + center`, where
     `distance = lerp(1e6, 1e3, dot(sunDir, surfaceNormal))` (`CloudsEffect.updateSharedUniforms` — the
     light is pushed further out as the sun approaches the horizon).
   * `view = CreateLookAt(position, position + sunDir, UP)`. This reproduces three's
     `inverseViewMatrix.lookAt(center, position, UP).setPosition(position)`, whose **+Z axis is
     −sunDirection** (three's `lookAt` computes `z = eye − target`). The effect is that the shadow map is
     mirrored horizontally versus a naive build, and that the cascade centre sits *behind* the ortho volume.
     Both are harmless because render and lookup share the matrix, and because only `clip.xy` is ever read.
     **Ported verbatim; do not "correct" it** — correcting one side without the other flips the map.
   * `Matrix[k] = view · projection` (row-vector), `InverseMatrix[k] = invert(Matrix[k])`.
6. **Camera forward** for the cascade-depth test is taken from the near-plane centroid
   (`normalize(centroidS − camS)`) so the client's view handedness never matters.

**Cascade selection in-shader.** `getFadedCascadeIndex` needs
`viewZToOrthographicDepth((viewMatrix · p).z, near, far) = (viewZ + near)/(near − far)`. With
`viewZ = −dot(p − camera, forward)` that is identically `(dist − near)/(far − near)`, so we carry a
`float3 cloudShadowCamFwd` instead of a whole main-camera view matrix. The fade logic (per-interval margin
`closestEdge²·0.5`, interval widened by `margin·(−0.5, +0.5)`, stochastic pick `jitter <= alpha`) is
ported line-for-line, including the "don't fade out the last cascade" branch and the `−1` (= no cascade)
return.

## 6. cbuffer additions

Appended to `SkyParams` / `SkyCb` (append-only, 16-byte aligned, C# field-for-field). Current `SkyCb` is
**688 B**; this adds **704 B** → **1 392 B**.

| HLSL | C# | Bytes | Source |
|---|---|---|---|
| `row_major float4x4 shadowMatrices[3]` | `Matrix4x4 ShadowMatrix0/1/2` | 192 | `CloudsMaterial.shadowMatrices` (`cascade.matrix`) |
| `row_major float4x4 invShadowMatrices[3]` | `Matrix4x4 InvShadowMatrix0/1/2` | 192 | `ShadowMaterial.inverseShadowMatrices` |
| `row_major float4x4 shadowReprojMatrices[3]` | `Matrix4x4 ShadowReproj0/1/2` | 192 | `ShadowMaterial.reprojectionMatrices` |
| `float4 shadowIntervals[3]` (`.xy`) | `Vector4 ShadowInterval0/1/2` | 48 | `CloudsMaterial.shadowIntervals` |
| `float3 cloudShadowCamFwd; float cloudShadowOn;` | `Vector3 + float` | 16 | derived / sky.cfg |
| `float cloudShadowFar; float cloudShadowNear; float2 cloudShadowMapSize;` | 4 floats | 16 | `shadowFar`, `cameraNear`, `1/shadowTexelSize` |
| `float cloudShadowIters; float cloudShadowMinStep; float cloudShadowMaxStep; float cloudShadowMinTrans;` | 4 floats | 16 | `defaults.shadow` 50 / 100 / 1000 / 1e-4 |
| `float cloudShadowFilterRadius; float cloudShadowGamma; float cloudShadowAlpha; float cloudShadowHistValid;` | 4 floats | 16 | 6 / 4 / 0.05 / runtime |
| `float cloudShaftOn; float cloudShaftIters; float cloudShaftMinStep; float cloudShaftMaxDist;` | 4 floats | 16 | 0/1 / 500 / 50 / 2e5 |

An HLSL `float4x4` array element is 16-byte aligned and 64 B long, so three consecutive `Matrix4x4` fields
in the C# struct map exactly onto `float4x4 name[3]`; likewise `float4 name[3]` ↔ three `Vector4`.

**Note on `_pad` fields:** none of the new lines need one — every group is exactly one or more 16-byte
registers. Keep it that way if you extend it.

## 7. The diffs

Four files, all append/insert-only. **Not applied** — apply by hand.

### 7.1 `AtmosphereShader.cs` — cbuffer (append at the end of `SkyParams`)

```diff
     // --- landblock-local camera fix (Render::update_viewpoint is Frame::globaltolocal) ---
     float3 cameraLbOffsetAC;     float _padB;  // (lbx*192, lby*192, 0): local AC -> GLOBAL AC
     float3 prevCameraLbOffsetAC; float _padC;  // last frame's offset (velocity reprojection)
+    // --- M4 Beer shadow map (cloud-on-cloud cascaded shadows) + light shafts ---
+    // Built in S space (global AC * acToShader, y-up, sea level y=0) by CloudShadowCascades.cs.
+    row_major float4x4 shadowMatrices[3];        // S -> cascade clip           (cascade.matrix)
+    row_major float4x4 invShadowMatrices[3];     // cascade clip -> S           (cascade.inverseMatrix)
+    row_major float4x4 shadowReprojMatrices[3];  // PREV frame's shadowMatrices (reprojection)
+    float4 shadowIntervals[3];                   // .xy = normalised (near,far) split depth
+    float3 cloudShadowCamFwd; float cloudShadowOn;
+    float cloudShadowFar;   float cloudShadowNear;   float2 cloudShadowMapSize;
+    float cloudShadowIters; float cloudShadowMinStep; float cloudShadowMaxStep; float cloudShadowMinTrans;
+    float cloudShadowFilterRadius; float cloudShadowGamma; float cloudShadowAlpha; float cloudShadowHistValid;
+    float cloudShaftOn; float cloudShaftIters; float cloudShaftMinStep; float cloudShaftMaxDist;
 };
```

> `GetSkyRadianceToPointLum` is **not** in `AtmosphereShader.cs` — it lives in `CloudShader.Part`
> (the M1 sky quad specialises `GetSkyRadiance`, which has no `shadow_length` argument at all). Its
> plumbing is §7.2c. If light shafts are later wanted in the **sky** as well as at cloud fronts, that
> needs `GetSkyRadiance`'s own `shadow_length` branch (`runtime.glsl` lines 179–201) — see §10.

### 7.2 `CloudShader.cs`

**(a) record the secondary march distance** — takram's `marchOpticalDepth(..., out float rayDistance)`.
The reference leaves it unwritten on the `iterationCount == 0` early return, so we initialise it to 0.

```diff
 float marchOpticalDepthC(float3 rayOrigin, float3 rayDirection, int maxIter,
                          float mipLevel, float jitter) {
+    s_secondaryRayDistance = 0.0;   // takram marchOpticalDepth's `out float rayDistance`
     int iterationCount = (int)max(0.0, remapF(mipLevel, 0.0, 1.0, float(maxIter + 1), 1.0) - jitter);
     if (iterationCount == 0) return 0.5;   // reference fudge factor
     float stepSize = minSecondaryStepSize / float(iterationCount);
     float nextDistance = stepSize * jitter;
     float opticalDepth = 0.0;
     [loop] for (int i = 0; i < iterationCount; ++i) {
         float rayDistance = nextDistance;
+        s_secondaryRayDistance = rayDistance;
         float3 position = rayDistance * rayDirection + rayOrigin;
```

**(b) shadow layer mask** — `clouds.glsl` `#ifdef SHADOW localWeather *= shadowLayerMask`.
`s_weatherLayerMask` is `float4(1,1,1,1)` for every pass except `PSCloudShadow`, so this is an exact
identity multiply in the main march.

```diff
     float4 localWeather = pow(max(localWeatherTex.SampleLevel(
         samWrap, wuv, mipLevel), 0.0), g_wExp);
+    localWeather *= s_weatherLayerMask;   // clouds.glsl: #ifdef SHADOW localWeather *= shadowLayerMask
     float4 heightScale = shapeAlteringFunction(weather.heightFraction, g_bias);
```

**(c) `GetSkyRadianceToPointLum` — the `shadow_length` argument** (`runtime.glsl`
`GetSkyRadianceToPoint`, lines 318–360). With `shadowLengthKm == 0` this is bit-identical to today:
`max(d − 0, 0) == d` and `shadow_transmittance == transmittance`.

```diff
-// GetSkyLuminanceToPoint (shadow_length = 0, COMBINED textures, no higher-order).
-float3 GetSkyRadianceToPointLum(float3 cameraKm, float3 pointKm, float3 sunDir,
-                                out float3 transmittance) {
+// GetSkyLuminanceToPoint (COMBINED textures, no higher-order). shadowLengthKm > 0 = light shafts.
+float3 GetSkyRadianceToPointLum(float3 cameraKm, float3 pointKm, float shadowLengthKm,
+                                float3 sunDir, out float3 transmittance) {
```
```diff
     float3 single_mie;
     float3 scattering = GetCombinedScattering(r, mu, mu_s, nu, intersectsGround, single_mie);
 
+    // Light shafts: ignore the scattering along the last shadowLength of the view ray, which we do by
+    // subtracting it from d (the S|x_s=x_0-lv term of Eq. 17 in the Bruneton paper).
+    d = max(d - shadowLengthKm, 0.0);
     float r_p = ClampRadius(sqrt(d * d + 2.0 * r * mu * d + r * r));
     float mu_p = (r * mu + d) / r_p;
     float mu_s_p = (r * mu_s + d * nu) / r_p;
 
     float3 single_mie_p;
     float3 scattering_p = GetCombinedScattering(r_p, mu_p, mu_s_p, nu, intersectsGround, single_mie_p);
 
-    scattering = scattering - transmittance * scattering_p;
-    single_mie = single_mie - transmittance * single_mie_p;
+    // T(x,x_s) in Eq. 17.
+    float3 shadow_transmittance = transmittance;
+    if (shadowLengthKm > 0.0) shadow_transmittance = GetTransmittanceB(r, mu, d, intersectsGround);
+
+    scattering = scattering - shadow_transmittance * scattering_p;
+    single_mie = single_mie - shadow_transmittance * single_mie_p;
     single_mie = GetExtrapolatedSingleMieScattering(float4(scattering, single_mie.r));
```

**(d) the BSM contribution in `marchCloudsC`** (`clouds.frag` lines 545–556):

```diff
             float opticalDepth = marchOpticalDepthC(position, sunShaderDir,
                                                     (int)cloudSunSteps, mipLevel, jitter);
-            // (Beer Shadow Map contribution dropped -- see class doc.)
+            // M4 Beer Shadow Map: the analytic optical depth ABOVE this sample, counting only what is
+            // further than the secondary march already covered. PCF only when the sun nears the horizon.
+            if (cloudShadowOn > 0.5 && height < s_shadowTopH) {
+                opticalDepth += sampleShadowOpticalDepth(
+                    position,
+                    s_secondaryRayDistance,
+                    cloudShadowFilterRadius * shadowRemapC(dot(sunShaderDir, surfaceNormal), 0.1, 0.0),
+                    jitter);
+            }
```

**(e) `getCloudRayNearFar` also yields the shadow ray** — the `raySphereIntersections4` call already uses
radii `bottomRadiusM + (0, minH, maxH, shadowTop)`, so `.w` *is* the shadow-top sphere and `.x` the ground:
exactly the components `clouds.frag getShadowRayNearFar` reads.

```diff
 float2 getCloudRayNearFar(float3 cameraECEFm, float3 rayDirection, float cameraHeight,
-                          bool hitsGroundC, out float2 hazeNearFar) {
+                          bool hitsGroundC, out float2 hazeNearFar, out float2 shadowNearFar) {
```
```diff
     } else {
         hazeNearFar = float2(cloudCameraNear, second.z);
         if (hitsGroundC) hazeNearFar.y = first.x;
     }
+    shadowNearFar = getShadowRayNearFarC(first, second, cameraHeight, hitsGroundC);
     return nearFar;
 }
```

**(f) haze picks up the shadow length** (`clouds.frag approximateHaze`). With `shadowLength == 0`,
`shadowExpTerm == 0` ⇒ `shadowOpticalDepth == opticalDepth` ⇒ `shadowTransmittance == transmittance`:
bit-identical to today.

```diff
 float4 approximateHazeC(float3 rayOrigin, float3 rayDirection, float maxRayDistance,
-                        float cosTheta, float cameraHeight, float3 gndSun, float3 gndSky) {
+                        float cosTheta, float cameraHeight, float3 gndSun, float3 gndSky,
+                        float shadowLength) {
```
```diff
     float expTerm = 1.0 - exp(-maxRayDistance * exponent);
-    float opticalDepth = expTerm * linearTerm;
-    float transmittance = saturate(1.0 - exp(-opticalDepth));
-
-    float3 inscatter = gndSun * cloudPhase(cosTheta, 1.0) * transmittance;
+    // Derive the optical depths separately for with and without shadow length.
+    float shadowExpTerm = 1.0 - exp(-min(maxRayDistance, shadowLength) * exponent);
+    float opticalDepth = expTerm * linearTerm;
+    float shadowOpticalDepth = max((expTerm - shadowExpTerm) * linearTerm, 0.0);
+    float transmittance = saturate(1.0 - exp(-opticalDepth));
+    float shadowTransmittance = saturate(1.0 - exp(-shadowOpticalDepth));
+
+    float3 inscatter = gndSun * cloudPhase(cosTheta, 1.0) * shadowTransmittance;
     inscatter += gndSky * RECIPROCAL_PI4 * skyLightScale * transmittance;
```

**(g) `PSClouds`** — seed the per-invocation shadow state, march the shafts, feed AP + haze.

```diff
     float cameraHeight = length(cameraECEFm) - bottomRadiusM;
     float cosTheta = dot(sunShader, dirShader);
+    // M4: seed the per-invocation BSM state (fragment coord for PCF noise, camera for the cascade
+    // depth test, sun direction, and the storm-dependent shadow layer heights/mask).
+    shadowBeginFrame(i.pos.xy, cameraECEFm, sunShader, cloudStorm > 0.5);
```
```diff
-    float2 hazeNearFar;
+    float2 hazeNearFar, shadowRayNearFar;
     float2 rayNearFar = getCloudRayNearFar(cameraECEFm, dirShader, cameraHeight, hitsGroundC,
-                                           hazeNearFar);
+                                           hazeNearFar, shadowRayNearFar);
```
```diff
     float4 color = float4(0.0, 0.0, 0.0, 0.0);
+    float shadowLength = 0.0;
+    bool hitClouds = false;
     bool marchable = rayNearFar.x >= 0.0 && rayNearFar.y > rayNearFar.x;
```
```diff
         if (frontDepthM >= 0.0) {
+            hitClouds = true;
             // Aerial perspective between the camera and the cloud front.
             float frontDepth = rayNearFar.x + frontDepthM;
             float3 frontPosition = cameraECEFm + frontDepth * dirShader;
+
+            // Shadow length must be computed BEFORE applying aerial perspective, and the ray is clamped
+            // at the cloud front, interpolated by alpha for smoother edges (clouds.frag main).
+            shadowRayNearFar.y = lerp(shadowRayNearFar.y,
+                                      min(frontDepth, shadowRayNearFar.y), color.a);
+            if (cloudShaftOn > 0.5 && shadowRayNearFar.x >= 0.0 && shadowRayNearFar.y >= 0.0) {
+                shadowLength = marchShadowLength(shadowRayNearFar.x * dirShader + cameraECEFm,
+                                                 dirShader, shadowRayNearFar, stbn);
+            }
+
             float3 apTransmittance;
             float3 inscatter = GetSkyRadianceToPointLum(cameraECEFm * meterToUnit,
                                                         frontPosition * meterToUnit,
+                                                        shadowLength * meterToUnit,
                                                         sunShader, apTransmittance);
```
```diff
         }
     }
 
+    // No cloud front: the shafts still run over the full shadow ray (clouds.frag main, !hitClouds).
+    if (!hitClouds && cloudShaftOn > 0.5 &&
+        shadowRayNearFar.x >= 0.0 && shadowRayNearFar.y >= 0.0) {
+        shadowLength = marchShadowLength(shadowRayNearFar.x * dirShader + cameraECEFm,
+                                         dirShader, shadowRayNearFar, stbn);
+    }
+
     // HAZE (cloudHazeDensity = 0 disables; storm look raises it 10x).
     if (cloudHazeDensity > 0.0 && hazeNearFar.y > hazeNearFar.x) {
         float4 haze = approximateHazeC(cloudCameraNear * dirShader + cameraECEFm, dirShader,
                                        hazeNearFar.y - hazeNearFar.x, cosTheta, cameraHeight,
-                                       gndSun, gndSky);
+                                       gndSun, gndSky, shadowLength);
         color.rgb = lerp(color.rgb, haze.rgb, haze.a);
         color.a = color.a * (1.0 - haze.a) + haze.a;
     }
     o.color = color;   // premultiplied HDR radiance + alpha, into the cloud RT
+    // Phase-2 hook: park the shadow length in the (currently unused) velocity-MRT alpha so a future
+    // sky pass can read it. Nothing samples .a today; PSCloudResolve reads only .r and .gb.
+    o.depthVel.a = shadowLength * meterToUnit;
     return o;
 }
```

### 7.3 `SkyConfig.cs`

```diff
         public float CloudTaaAlpha = 0.1f; // current-frame blend weight (holtburger temporalAlpha)
+        // --- M4 Beer shadow map (takram defaults.shadow + holtburger measured values) ---
+        public float CloudShadow;               // 1 = BSM (cloud-on-cloud cascaded shadows)
+        public float CloudShadowFar = 5000f;    // cascade far distance (m) = holtburger shadowMaps.far
+        public float CloudShadowIters = 50f;    // shadow-map march iterations (defaults.shadow)
+        public float CloudShadowMinStep = 100f; // defaults.shadow.minStepSize
+        public float CloudShadowMaxStep = 1000f;// defaults.shadow.maxStepSize
+        public float CloudShadowMinTrans = 1e-4f; // defaults.shadow.minTransmittance
+        public float CloudShadowFilter = 6f;    // CloudsMaterial maxShadowFilterRadius
+        public float CloudShadowGamma = 4f;     // resolve varianceGamma (holtburger anti-cycling)
+        public float CloudShadowAlpha = 0.05f;  // resolve temporalAlpha (holtburger anti-cycling)
+        // --- M4 light shafts (defaults.clouds shadow-length block) ---
+        public float LightShafts;               // 1 = marchShadowLength -> aerial perspective + haze
+        public float ShaftIters = 500f;         // maxShadowLengthIterationCount
+        public float ShaftMinStep = 50f;        // minShadowLengthStepSize
+        public float ShaftMaxDist = 200000f;    // maxShadowLengthRayDistance
+        public float CloudFrameFreeze = -1f;    // >=0: pin the STBN slice (A/B bit-identity gate)
```
```diff
-                case "output": if (F(val, out var o)) Output = Math.Clamp(o, 0f, 9f); break;   // 6 = clouds-only, 7 AP-inscatter, 8 AP-transmittance, 9 front-depth
+                case "output": if (F(val, out var o)) Output = Math.Clamp(o, 0f, 10f); break;  // 6 clouds-only, 7 AP-inscatter, 8 AP-transmittance, 9 front-depth, 10 BSM cascades
```
```diff
                 case "campitch": if (F(val, out var cp)) CamPitch = Math.Clamp(cp, -89f, 89f); break;
+                case "cloudshadow": if (F(val, out var csh)) CloudShadow = Math.Clamp(csh, 0f, 1f); break;
+                case "cloudshadowfar": if (F(val, out var csf)) CloudShadowFar = Math.Clamp(csf, 200f, 50000f); break;
+                case "cloudshadowiters": if (F(val, out var csi)) CloudShadowIters = Math.Clamp(csi, 1f, 200f); break;
+                case "cloudshadowminstep": if (F(val, out var csm)) CloudShadowMinStep = Math.Clamp(csm, 10f, 2000f); break;
+                case "cloudshadowmaxstep": if (F(val, out var csx)) CloudShadowMaxStep = Math.Clamp(csx, 50f, 5000f); break;
+                case "cloudshadowmintrans": if (F(val, out var cst)) CloudShadowMinTrans = Math.Clamp(cst, 1e-6f, 0.5f); break;
+                case "cloudshadowfilter": if (F(val, out var csr)) CloudShadowFilter = Math.Clamp(csr, 0f, 16f); break;
+                case "cloudshadowgamma": if (F(val, out var csg)) CloudShadowGamma = Math.Clamp(csg, 0.1f, 64f); break;
+                case "cloudshadowalpha": if (F(val, out var csa)) CloudShadowAlpha = Math.Clamp(csa, 0.01f, 1f); break;
+                case "lightshafts": if (F(val, out var ls)) LightShafts = Math.Clamp(ls, 0f, 1f); break;
+                case "shaftiters": if (F(val, out var si)) ShaftIters = Math.Clamp(si, 0f, 500f); break;
+                case "shaftminstep": if (F(val, out var sms)) ShaftMinStep = Math.Clamp(sms, 5f, 1000f); break;
+                case "shaftmaxdist": if (F(val, out var smd)) ShaftMaxDist = Math.Clamp(smd, 1000f, 500000f); break;
+                case "cloudframefreeze": if (F(val, out var cff)) CloudFrameFreeze = Math.Clamp(cff, -1f, 63f); break;
```

`CloudShadow` / `LightShafts` land at **0** (byte-identical to today). Flip both defaults to `1` in the
same file once §9 is green — per the project's *default-on-no-eyetest-gate* rule, a validated gate ships
default-ON with a `=0` escape hatch. Note `shadowFar` and the shadow-map size are **not** live-tunable on
their own: changing `cloudshadowfar` is fine (matrices are rebuilt every frame), but changing the map size
would need target recreation, so it is fixed at 512 (takram `defaults.shadow.mapSize`; `ultra` uses 1024 —
add it later as an init-time knob like `wxmap` if wanted).

### 7.4 `LiveSkyCompositor.cs`

**(a) fields**

```diff
         private ID3D11PixelShader? _psCloudResolve;
+        // --- M4 Beer shadow map ---
+        private ID3D11PixelShader? _psCloudShadow, _psCloudShadowResolve, _psCloudShadowDebug;
+        private ID3D11Texture2D? _shadowRt;                         // ArraySize 6: 0-2 BSM, 3-5 depthVel
+        private readonly ID3D11RenderTargetView?[] _shadowRtv = new ID3D11RenderTargetView?[6];
+        private ID3D11ShaderResourceView? _shadowSrv;
+        private readonly ID3D11Texture2D?[] _shadowResolveRt = new ID3D11Texture2D?[2];
+        private readonly ID3D11RenderTargetView?[] _shadowResolveRtv0 = new ID3D11RenderTargetView?[3];
+        private readonly ID3D11RenderTargetView?[] _shadowResolveRtv1 = new ID3D11RenderTargetView?[3];
+        private readonly ID3D11ShaderResourceView?[] _shadowResolveSrv = new ID3D11ShaderResourceView?[2];
+        private int _shadowResolveIdx;
+        private bool _shadowHistValid;
+        private bool _shadowUsable;
+        private const int ShadowMapSize = 512;                      // takram defaults.shadow.mapSize
+        private readonly CloudShadowCascades _cascades = new CloudShadowCascades();
```

**(b) compile** — inside `TryInitClouds`, after `_psCloudResolve`. Note **every** cloud PS now compiles
from `CloudShadowShader.Hlsl` (= `AtmosphereShader.Hlsl + HelperPart + CloudShader.Part + MarchPart`);
`PSClouds` calls the helpers unconditionally and gates them on `cloudShadowOn` at runtime, so there is one
shader variant, not two.

```diff
-                var psb = Compiler.Compile(CloudShader.Hlsl, "PSClouds", "acmesky_clouds.hlsl", "ps_5_0",
+                string src = CloudShadowShader.Hlsl;
+                var psb = Compiler.Compile(src, "PSClouds", "acmesky_clouds.hlsl", "ps_5_0",
                     ShaderFlags.OptimizationLevel3, EffectFlags.None);
                 _psClouds = _dev!.CreatePixelShader(psb.Span, null);
-                var pcb = Compiler.Compile(CloudShader.Hlsl, "PSCloudComposite", ...);
+                var pcb = Compiler.Compile(src, "PSCloudComposite", ...);
                 _psCloudComposite = _dev.CreatePixelShader(pcb.Span, null);
-                var prb = Compiler.Compile(CloudShader.Hlsl, "PSCloudResolve", ...);
+                var prb = Compiler.Compile(src, "PSCloudResolve", ...);
                 _psCloudResolve = _dev.CreatePixelShader(prb.Span, null);
+                var psh = Compiler.Compile(src, "PSCloudShadow", "acmesky_clouds.hlsl", "ps_5_0",
+                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
+                _psCloudShadow = _dev.CreatePixelShader(psh.Span, null);
+                var psr = Compiler.Compile(src, "PSCloudShadowResolve", "acmesky_clouds.hlsl", "ps_5_0",
+                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
+                _psCloudShadowResolve = _dev.CreatePixelShader(psr.Span, null);
+                var psd = Compiler.Compile(src, "PSCloudShadowDebug", "acmesky_clouds.hlsl", "ps_5_0",
+                    ShaderFlags.OptimizationLevel3, EffectFlags.None);
+                _psCloudShadowDebug = _dev.CreatePixelShader(psd.Span, null);
+                EnsureShadowTargets();
+                _shadowUsable = _psCloudShadow is not null && _psCloudShadowResolve is not null &&
+                                _shadowRt is not null;
```

**(c) target creation** (new method, next to `EnsureCloudTarget`)

```csharp
/// <summary>Create the 512x512 BSM texture arrays: one ArraySize=6 march target (slices 0-2 = BSM,
/// 3-5 = depth+velocity, takram's outputColor[N]/outputDepthVelocity[N] layout) and two ArraySize=3
/// resolve targets for the ping-pong. Fixed size, so this runs once.</summary>
private void EnsureShadowTargets() {
    if (_shadowRt is not null) return;
    var desc = new Texture2DDescription {
        Width = ShadowMapSize, Height = ShadowMapSize, MipLevels = 1, ArraySize = 6,
        Format = Format.R16G16B16A16_Float,
        SampleDescription = new SampleDescription(1, 0),
        Usage = ResourceUsage.Default,
        BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
        CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
    };
    _shadowRt = _dev!.CreateTexture2D(in desc);
    for (int k = 0; k < 6; k++) _shadowRtv[k] = CreateSliceRtv(_shadowRt, k);
    _shadowSrv = _dev.CreateShaderResourceView(_shadowRt);   // whole 6-slice array

    var rdesc = desc; rdesc.ArraySize = 3;
    for (int b = 0; b < 2; b++) {
        _shadowResolveRt[b] = _dev.CreateTexture2D(in rdesc);
        var rtvs = b == 0 ? _shadowResolveRtv0 : _shadowResolveRtv1;
        for (int k = 0; k < 3; k++) rtvs[k] = CreateSliceRtv(_shadowResolveRt[b]!, k);
        _shadowResolveSrv[b] = _dev.CreateShaderResourceView(_shadowResolveRt[b]);
    }
    _shadowHistValid = false;
    _cascades.Invalidate();
}

private ID3D11RenderTargetView CreateSliceRtv(ID3D11Texture2D tex, int slice) {
    var d = new RenderTargetViewDescription {
        Format = Format.R16G16B16A16_Float,
        ViewDimension = RenderTargetViewDimension.Texture2DArray,
    };
    d.Texture2DArray.MipSlice = 0;
    d.Texture2DArray.FirstArraySlice = (uint)slice;
    d.Texture2DArray.ArraySize = 1;
    return _dev!.CreateRenderTargetView(tex, d);
}
```

**(d) the passes** — insert in `RenderAndUpload`, immediately **before** the `// pass A: raymarch` block,
inside the same `if (atmo && _cloudsUsable && ...)` guard:

```csharp
// pass S + SR (M4): render the three Beer-shadow-map cascades from the sun's view and resolve
// them temporally. Skipped entirely when the knob is off -> byte-identical to the M2.2 build.
bool bsm = _shadowUsable && p.CloudShadowOn > 0.5f;
ID3D11ShaderResourceView? bsmSrv = null;
if (bsm) {
    _ctx.RSSetViewport(0f, 0f, ShadowMapSize, ShadowMapSize, 0f, 1f);
    _ctx.OMSetRenderTargets(new[] {
        _shadowRtv[0]!, _shadowRtv[1]!, _shadowRtv[2]!,
        _shadowRtv[3]!, _shadowRtv[4]!, _shadowRtv[5]!,
    }, null);
    _ctx.PSSetShader(_psCloudShadow);
    _ctx.PSSetSampler(1, _samplerWrap);
    _ctx.PSSetShaderResources(4, new[] {
        _texWeather!.Srv!, _texShape!.Srv!, _texShapeDetail!.Srv!, _texStbn!.Srv!,
    });
    _ctx.PSSetShaderResource(9, _texTurbulence!.Srv!);
    _ctx.Draw(3, 0);

    int cur = _shadowResolveIdx, prev = 1 - _shadowResolveIdx;
    _ctx.OMSetRenderTargets(cur == 0 ? _shadowResolveRtv0! : _shadowResolveRtv1!, null);
    _ctx.PSSetShader(_psCloudShadowResolve);
    _ctx.PSSetShaderResource(13, _shadowSrv!);
    _ctx.PSSetShaderResource(14, _shadowResolveSrv[prev]!);
    _ctx.Draw(3, 0);
    _ctx.PSSetShaderResources(13, new ID3D11ShaderResourceView[] { null!, null! });  // t13,t14
    bsmSrv = _shadowResolveSrv[cur]!;
    _shadowResolveIdx = prev;
    _shadowHistValid = true;
}
```

then in the existing pass A block, after `_ctx.PSSetShaderResource(9, _texTurbulence!.Srv!);`:

```csharp
if (bsm) _ctx.PSSetShaderResource(12, bsmSrv!);
```

and after pass A's `Draw`, before pass R:

```csharp
if (bsm) _ctx.PSSetShaderResources(12, new ID3D11ShaderResourceView[] { null! });
```

Debug view (`output = 10`), drawn **instead of** pass B. (Pass A still runs and, because `PSClouds`'
existing `outputMode > 8.5` branch fires, writes front-depth into the cloud RT — harmless, the RT is then
unused. Skipping pass A entirely at `output=10` would also skip the BSM read that makes the view worth
having, so leave it.)

```csharp
if (bsm && p.OutputMode > 9.5f) {
    _ctx.RSSetViewport(0f, 0f, w, h, 0f, 1f);
    _ctx.OMSetRenderTargets(_rtv!, null);
    _ctx.PSSetShader(_psCloudShadowDebug);
    _ctx.PSSetShaderResource(12, bsmSrv!);
    _ctx.Draw(3, 0);
    _ctx.PSSetShaderResources(12, new ID3D11ShaderResourceView[] { null! });
}
```

**(e) `BuildCb`** — after the existing landblock-offset block (it needs `cb.CameraLbOffsetAC`) and before
the sun computation is fine, **but** the cascades need the sun direction, so move the call to the very end
of `BuildCb`, after `cb.SunDirAC` is set:

```csharp
// --- M4 BSM: cascade splits + sun-view matrices, in the shader's S space ---
cb.CloudShadowOn = (_cfg.Clouds > 0f && _shadowUsable) ? _cfg.CloudShadow : 0f;
cb.CloudShaftOn = (cb.CloudShadowOn > 0f) ? _cfg.LightShafts : 0f;   // shafts need the BSM
if (cb.CloudShadowOn > 0f) {
    _cascades.Update(cb.InvView, cb.InvProj, cam.WorldPos, cb.CameraLbOffsetAC,
                     _acToShader, _cfg.WorldSwizzle > 0.5f, cb.SunDirAC,
                     cb.BottomRadiusM, _cfg.CloudShadowFar, ShadowMapSize);
    cb.ShadowMatrix0 = _cascades.Matrix[0];
    cb.ShadowMatrix1 = _cascades.Matrix[1];
    cb.ShadowMatrix2 = _cascades.Matrix[2];
    cb.InvShadowMatrix0 = _cascades.InverseMatrix[0];
    cb.InvShadowMatrix1 = _cascades.InverseMatrix[1];
    cb.InvShadowMatrix2 = _cascades.InverseMatrix[2];
    cb.ShadowReproj0 = _cascades.ReprojectionMatrix[0];
    cb.ShadowReproj1 = _cascades.ReprojectionMatrix[1];
    cb.ShadowReproj2 = _cascades.ReprojectionMatrix[2];
    cb.ShadowInterval0 = _cascades.Interval[0];
    cb.ShadowInterval1 = _cascades.Interval[1];
    cb.ShadowInterval2 = _cascades.Interval[2];
    cb.CloudShadowCamFwd = _cascades.CameraForwardS;
    cb.CloudShadowNear = _cascades.CameraNear;
    cb.CloudShadowFar = _cascades.Far;
}
cb.CloudShadowMapSize = new Vector2(ShadowMapSize, ShadowMapSize);
cb.CloudShadowIters = _cfg.CloudShadowIters;
cb.CloudShadowMinStep = _cfg.CloudShadowMinStep;
cb.CloudShadowMaxStep = _cfg.CloudShadowMaxStep;
cb.CloudShadowMinTrans = _cfg.CloudShadowMinTrans;
cb.CloudShadowFilterRadius = _cfg.CloudShadowFilter;
cb.CloudShadowGamma = _cfg.CloudShadowGamma;
cb.CloudShadowAlpha = _cfg.CloudShadowAlpha;
cb.CloudShadowHistValid = _shadowHistValid ? 1f : 0f;
cb.CloudShaftIters = _cfg.ShaftIters;
cb.CloudShaftMinStep = _cfg.ShaftMinStep;
cb.CloudShaftMaxDist = _cfg.ShaftMaxDist;
```

and the STBN-freeze gate used by the A/B test in §9:

```diff
-            cb.CloudFrame = (++_cloudFrameIndex) % 64;
+            cb.CloudFrame = _cfg.CloudFrameFreeze >= 0f
+                ? MathF.Floor(_cfg.CloudFrameFreeze)
+                : (++_cloudFrameIndex) % 64;
```

**(f) `DisposeD3D11`** — release the three shaders, `_shadowRt`, the 6 + 3 + 3 RTVs, the 3 SRVs, and set
`_shadowUsable = _shadowHistValid = false` plus `_cascades.Invalidate()`.

**(g) history invalidation** — set `_shadowHistValid = false` and call `_cascades.Invalidate()` wherever
`_cloudHistValid = false` is set today (target recreation), and additionally when `cam.CellId`'s landblock
changes by more than one landblock in a frame (a teleport). S space is global so a *walk* across a
landblock boundary needs no invalidation.

## 8. Knobs

| Key | Default | Meaning |
|---|---|---|
| `cloudshadow` | `0` → `1` after validation | Beer shadow map on/off. `0` = byte-identical to today. |
| `cloudshadowfar` | `5000` | Cascade far distance, m. holtburger's measured `shadowMaps.far`. |
| `cloudshadowiters` | `50` | `defaults.shadow.maxIterationCount`. |
| `cloudshadowminstep` / `cloudshadowmaxstep` | `100` / `1000` | `defaults.shadow`. |
| `cloudshadowmintrans` | `1e-4` | `defaults.shadow.minTransmittance`. |
| `cloudshadowfilter` | `6` | `maxShadowFilterRadius`; PCF only kicks in below ~5.6° sun elevation. |
| `cloudshadowgamma` / `cloudshadowalpha` | `4` / `0.05` | Shadow resolve `varianceGamma` / `temporalAlpha` — **holtburger's anti-cycling overrides**, not takram's `1` / `0.01` (see `cloud_volume.js`: γ=1, α=0.01 makes the terrain shadow term pulse on the 64-frame STBN cycle). |
| `lightshafts` | `0` → `1` after validation | `marchShadowLength` → aerial perspective + haze. Requires `cloudshadow=1`. |
| `shaftiters` | `500` | `maxShadowLengthIterationCount`. The first thing to cut on a perf miss. |
| `shaftminstep` | `50` | `minShadowLengthStepSize`. |
| `shaftmaxdist` | `200000` | `maxShadowLengthRayDistance`. |
| `cloudframefreeze` | `-1` | Pin the STBN slice (0–63) so two builds render bit-identical frames. |
| `output` | `0` | `10` = BSM cascade atlas debug view (new). |

## 9. Validation plan (1070, skydump-based)

Everything is off-screen/headless per the fleet rules; the artefact is `C:\Temp\acdt\skydump-N.bmp`
(`dump=1`, rotating 8) plus the once-per-second `acmesky: LIVE frame #N` log line, whose ΔN **is** the fps
meter. Batch the whole sequence into one 1070 session.

**V0 — bit-identity gate (must pass before anything else).**
`sky.cfg`: `time=0.30 storm=0 cloudtaa=0 cloudframefreeze=7 campitch=15 dump=1 cloudshadow=0 lightshafts=0`.
Capture 8 dumps on the **old** build and 8 on the **new** build, `sha256sum` them. With the STBN slice
pinned, TAA off and time forced, the frame is deterministic: the sets must match **exactly**. This is the
empirical proof of the analytic claim (every §7 change with the knobs at 0 is an IEEE identity:
`×1.0`, `max(d−0,0)`, `shadowTransmittance == transmittance`, a dead store, and a false `if`).

**V1 — cascade arithmetic.** Log `_cascades.Interval[]` and `Far`/`CameraNear` once per second. Expect
intervals `(0, 0.1434) (0.1434, 0.3425) (0.3425, 1.0)` and cascade far distances ≈ 725 / 1 719 / 5 000 m
for `near=10, far=5000, λ=0.6`. A mismatch means the projection unproject or `nearDist` recovery is wrong.

**V2 — BSM content.** `cloudshadow=1 output=10 storm=0 time=0.30`. Expect three tiles (top-left, top-right,
bottom-left; bottom-right black — only 3 cascades). Green (`meanExtinction × 10`) must show a recognisable
cloud footprint, red (`frontDepth × 1e-5`) a smooth gradient, blue (`(b+a) × 0.01`) the dense cores.
Failure modes to read off this view:
* all black → cascade matrices degenerate, or the sun ray misses the shadow sphere (check `s_shadowTopH`);
* uniform grey with no structure → the layer mask is 0 (all layers `shadow:false`) or `selectLayers` ran with
  the wrong storm flag;
* cascade 0 identical to cascade 2 → the ortho radius is not shrinking, i.e. the split lerp is wrong;
* visible shimmer as the camera moves → texel snapping broken (check `texelWidth = 2r/512`).

**V3 — the actual effect.** `storm=1 time=0.28 campitch=20 cloudcoverstorm=0.55`, A/B `cloudshadow=0` vs `1`.
Metric: mean luminance of the lower third of the cloud band in the dump (a small BMP-reading script; the
`_sampMid`/`_sampHorizon` samples in the existing log line are a coarse proxy). Expect a clear **drop** —
this is the "dark undersides at scale" the whole feature exists for — with no change above the deck.

**V4 — cascade seams.** Slowly pan/`@teleloc` outward and watch for a hard ring at ~725 m and ~1 719 m.
There should be none: `getFadedCascadeIndex`'s stochastic margin (`closestEdge²·0.5`) dithers the
transition with the STBN jitter. A visible ring means `shadowIntervals` and the depth normalisation
disagree (i.e. `cloudShadowNear`/`cloudShadowFar` do not match what `CloudShadowCascades` split on).

**V5 — temporal stability.** `cloudshadow=1 cloudframefreeze=-1`, 20-dump burst, mean consecutive-frame |Δ|
over the sky band — same metric that fixed the γ=2 → γ=4 cycling. Expect ≲ 1.1 (flat). If it pulses on a
64-frame period, `cloudshadowgamma`/`cloudshadowalpha` did not take, or `cloudShadowHistValid` is stuck at 0
(ping-pong index not advancing).

**V6 — shafts.** `lightshafts=1 output=7` (AP in-scatter only) with a low sun and broken cloud. Expect
radial streaks converging on the sun. `output=8` (AP transmittance) must be **unchanged** by the shafts —
`shadow_length` only touches the in-scatter term, never the transmittance return. That is a sharp
correctness check on the §7.2c diff.

**V7 — perf.** ΔN from the log line at 1080p, five arms, 30 s each, in one session:
`(shadow 0 / shafts 0)`, `(1/0)`, `(1/1, shaftiters 500)`, `(1/1, shaftiters 150)`, `(1/1, cloudres 0.5)`.
Record the table in this doc.

## 10. Perf budget (GTX 1070, 1080p)

Reference point: pass A is already the dominant GPU cost — `cloudres=1` → 1920×1080 = 2.07 M pixels × up to
`clouditers=500` primary iterations, each with a weather + shape + detail + turbulence read and (with
`cloudaccurate=1`) per-sample Bruneton irradiance.

| Pass | Work | Estimate |
|---|---|---|
| S (`PSCloudShadow`) | 512² = 262 k px × 3 cascades × ≤50 SVS iterations = ≤39.3 M sample-iterations *worst case*, cut hard by the `insideLayerIntervals` skip, the `minDensity` skip and the `minTransmittance=1e-4` early-out. ≈ **4 %** of pass A's worst case. | **0.6–1.5 ms** |
| SR (`PSCloudShadowResolve`) | 512² × 3 × (9 variance Loads + 9 closest-fragment Loads) ≈ 14 M texel loads, no ALU to speak of. | **< 0.1 ms** |
| A, BSM term | +1 `Texture2DArray` sample per *contributing* sample (not per iteration). PCF's 8 taps only engage when `dot(sun, normal) < ~0.098`, i.e. sun elevation below ~5.6°. | **+5–12 %** of pass A (up to +25 % at sunrise/sunset) |
| A, shafts | up to `shaftiters=500` iterations of `sampleShadowOpticalDepth` **per pixel, full res**. | **the risk** — see below |

**The shafts are the only real cost.** takram itself flags `lightShafts` as *"Expensive"* and disables it in
its `low` and `medium` presets. The march length is bounded by `shadowRayNearFar`, which is clamped at the
cloud front when clouds are hit — so looking *up* at a deck the span is a few km and the ray terminates in
~40–60 steps (step grows ×1.01 per iteration). Looking at the **horizon** with a clear sky the span reaches
`shaftmaxdist = 200 km`; the geometric series `50·(1.01ⁿ−1)/0.01` hits 200 km at n ≈ 340, so a horizon-heavy
frame can genuinely burn ~340 dependent texture reads per pixel. Mitigations, in order of preference:

1. `shaftiters=150` (caps the march at ~50·(1.01¹⁵⁰−1)/0.01 ≈ 17 km — plenty for a visible shaft, and the
   `1 − exp(−opticalDepth)` term has long saturated by then);
2. `cloudres=0.5` — the shafts are computed inside the cloud pass, so the resolution scale applies to them
   too and the temporal resolve hides most of the softening;
3. `shaftmaxdist=50000`.

**Context that flatters all of this:** `RenderAndUpload` already ends in `CopyResource` + `Map(Read)` +
a per-row `memcpy` into a D3D9 dynamic texture — a full CPU readback of the frame, every frame, which
serialises the GPU and dwarfs a 512² pass. The two new passes will partly hide inside that stall.

## 11. Risks

1. **Six simultaneous RTVs onto one texture.** Legal in D3D11 (distinct subresources, no overlap) but if
   the debug layer or a driver objects, split `_shadowRt` into two `ArraySize=3` textures and change
   `shadowClosestFragment` / `shadowVarianceClip` to read the second one. Both functions are three lines;
   the only reason to prefer the single texture is that it matches takram's `coord + ivec3(0,0,N)` layout
   literally. **Low risk, trivial fallback.**
2. **fp16 `frontDepth` overflow.** `rayFar` falls back to `1e6` on a total miss; fp16 max is 65 504 so `r`
   becomes +Inf. Analysed in §3 — both consumers give 0 either way. Do **not** clamp `rayFar`; that would
   change the miss encoding. Worth an explicit V2 check that miss texels read as black, not NaN.
3. **The mirrored light basis.** three's `lookAt(center, position)` puts +Z along −sunDirection, so the
   shadow map is horizontally mirrored and the cascade centre sits outside the ortho volume. Ported
   verbatim in `CloudShadowCascades.LightOrientation` + `CreateLookAt(position, position + sunS, up)`.
   **If someone "fixes" one side and not the other the shadows will be mirrored about the sun azimuth** —
   a subtle, plausible-looking wrong. Called out in the file's XML doc; keep it there.
4. **Sun at zenith / nadir degeneracy.** `cross(UP, sunDir)` collapses when the sun is straight overhead.
   three nudges `up`; the port does too (both in `LightOrientation` and at the `CreateLookAt` site). Test
   `time=0.5` (local noon) explicitly in V2 — a NaN cascade matrix shows as an all-black or all-white BSM.
5. **D3D vs GL V flip.** Two sites (`clip = uv*2−1` in the render, `uv = clip*0.5+0.5` in the lookup) plus
   the velocity reprojection. They must **all** agree. If the shadows are vertically mirrored relative to
   the clouds, exactly one of the three was missed. `output=10` plus V3 catches it.
6. **`cloudShadowNear`/`Far` drift.** The shader's cascade-depth normalisation must use the same
   `near`/`far` the CPU split on. They travel in the cbuffer from `CloudShadowCascades` for exactly this
   reason — never re-derive them in the shader. V4 is the detector.
7. **`shadowFar = 5000 m` vs `cloudMaxRayDistance = 200 km`.** Cloud samples beyond 5 km fall into the last
   cascade regardless (`getFadedCascadeIndex` returns `SHADOW_CASCADE_COUNT-1` for anything past its start)
   but their `getShadowUv` lands outside [0,1] and returns 0 optical depth. So **distant clouds get no BSM
   term** and are lit by the secondary sun march alone — exactly as in holtburger. If the far field looks
   flat next to the near field, that is the reference behaviour, not a bug; raising `cloudshadowfar`
   trades cascade resolution for reach.
8. **Storm-look shadow slab is 3× taller** (600–6 600 m vs 750–2 200 m) while `cloudshadowiters` stays 50,
   so the storm BSM is ~3× coarser along the ray. Expect softer cumulonimbus shadowing. If it reads as
   banding, raise `cloudshadowiters` for storm only (a new knob) rather than lowering `minStepSize`.
9. **Perf regression at sunrise/sunset**, where the PCF radius opens to 8 taps *and* the sun-angle-dependent
   light `distance` grows to 1e6 m. Both are reference behaviour; V7's arms should include `time=0.26`.
10. **The `attenuationFactor = 1 − 5e-4` in `marchShadowLength` is dead code** in takram (declared, never
    applied to `attenuation`). Ported verbatim with a comment. Do not "activate" it — that would change
    the shaft falloff away from the reference.

## 12. Out of scope (Phase 2)

takram also feeds `shadowLength` into the **sky's** aerial perspective (`AtmosphereEffect` reads
`cloudsPass.shadowLengthBuffer`), so shafts appear across the whole sky and over scene geometry, not just at
cloud fronts. AcmeSky cannot do that yet: `PSAtmosphere` runs *before* the cloud pass, and there is no scene
depth buffer on our device. The path, if wanted:

1. Reorder to clouds-then-sky, or add a third full-res pass that re-evaluates the sky with shafts.
2. Port `GetSkyRadiance`'s `shadow_length` branch (`runtime.glsl` 179–201: the "case of light shafts"
   `d = shadow_length` / `ray_r_mu_intersects_ground` re-parameterisation) — `AtmosphereShader.cs`'s
   `GetSkyRadiance` is currently the `shadow_length = 0` specialisation and drops it entirely.
3. Temporally resolve the shadow-length buffer separately (takram gives it its own history and its own
   `shadowLengthHistoryBuffer` in `CloudsPass`).

The `o.depthVel.a = shadowLength * meterToUnit` line in §7.2g parks the value so step 3 has something to
read. Nothing samples that channel today.
