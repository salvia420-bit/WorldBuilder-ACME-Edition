# Holtburger-web sky → HLSL/D3D11 porting spec (2026-08-21)

Porting bible for the **live in-process sky port** (AcmeSky plugin): render the real
holtburger-web sky with our own D3D11 device inside the retail AC client and composite
onto the client's D3D9 backbuffer. Retail client is fixed-function D3D9 (no shaders), so
"live volumetric on the client's own renderer" is impossible — we run a *private* D3D11
device and composite via readback. This spec = what to port.

Source repo root for all paths below:
`external/holtburger/apps/holtburger-web/`

Scope = the `?atmosphere=on` + `?clouds=on` stack ("Sky-K"): a takram three-geospatial
port — Bruneton precomputed-scattering atmosphere + `@takram/three-clouds` volumetric
raymarcher + takram star field. All rendering is GLSL (three.js ShaderMaterial / pmndrs
Effect). Only the sun-direction / time-of-day model is Rust/wasm.

## Milestone mapping (this project)
- **M0 (in progress):** D3D11 offscreen → CPU readback → D3D9 dynamic texture →
  fullscreen quad in the `GameSky::Draw(0)` slot. Trivial test pattern. Behind
  `ACMESKY_LIVE=1`. Proves two-device coexistence + composite + fps. NO shaders yet.
- **M1 = Phase 1 below (atmosphere).  M2 = Phase 3 (clouds).  M3 = stars + day/night + weather.**

---

## 1. Passes, in order
Two three.js scenes (skyScene w/ its own skyCamera mirroring the main camera; world
scene), one pmndrs EffectComposer, HalfFloat ping-pong RTs + 2× MSAA.
`scene3d/atmosphere_pipeline.js` (createAtmospherePipeline).

1. skyRenderPass — SkyMaterial fullscreen quad + stars Points (clears color+depth)
2. (opt) skyCapturePass — horizon dissolve, default OFF
3. worldMaskPass — camera layer mask
4. worldRenderPass — world geometry, clear=false clearDepth=true (world paints over sky)
5. (opt) portal/indoor passes, default OFF
6. fxPass EffectPass, in HDR until tonemap:
   heatHaze? → **AerialPerspectiveEffect** → horizonDissolve? → lensFlare(off) →
   **bloom** (threshold .85, intensity 1.0, mipmapBlur) → vignette? →
   **ToneMappingEffect(AGX)** → **DitheringEffect**

**Clouds = separate pipeline** (`scene3d/cloud_overlay.js`): own mini EffectComposer
(RenderPass + EffectPass(CloudsEffect)) raymarched to a HalfFloat RT in preRender(),
then a fullscreen composite quad (premultipliedAlpha, depthTest/Write false, renderOrder
999) draws it over the finished frame. **Clouds are depth-UNAWARE vs world** (no terrain
occlusion) — simplifies our composite (draw clouds last, over everything).

Net order to reproduce: atmosphere gradient + sun/moon disc → stars → [world] →
aerial persp over depth → bloom → AGX tonemap+exposure → clouds composited last.

## 2. Shaders

### Atmosphere (Bruneton precomputed)
Port clean GLSL: `vendor/takram-three-clouds/shaders/bruneton-reference/{definitions,common,precompute,runtime}.glsl`.
Runtime fns the sky/aerial passes call: `GetSkyRadiance(cam,viewRay,shadowLen,sunDir,out transmittance)`,
`GetSkyRadianceToPoint(...)`, `GetSunAndSkyIrradiance`, `GetSolarLuminance`.
Phases (common.glsl:193): Rayleigh (3/16π)(1+ν²); Mie Cornette-Shanks g=0.8.
LUTs are **pre-baked EXR, shipped** (`scene3d/atmosphere_runtime.js` PrecomputedTexturesLoader).
GPU precompute generator is a fallback/tool. **Port: bake LUTs offline, ship them.** Port
`GetUnitRangeFromTextureCoord`/`GetTextureCoordFromUnitRange` and the 4D→3D scattering
packing (ν×μ_s = 8×32 = 256 across width) exactly.

### SkyMaterial (sky + sun/moon disc)
Minified `vendor/takram/three-atmosphere.js` class `Ke` (~L5404); clean logic = sky include
+ bruneton runtime. Fullscreen quad `gl_Position=vec4(pos.xy,1,1)` (far plane). Vertex
reconstructs per-pixel camera ray → ECEF (×METER_TO_LENGTH_UNIT 0.001). Fragment
`GetSkyRadiance` + analytic sun disc (sunAngularRadius) + moon disc. depthWrite false.

### Stars
Minified class `$t` (~L5623), THREE.Points. mag→brightness Pogson `10^(-mag/2.5)`,
magnitudeRange (-2,8). `gl_Position = proj*view*(cameraPos + worldDir*cameraFar)`.
Fragment adds atmospheric extinction, discards below horizon. intensity ×= nightFrac.
Needs ECI→ECEF rotation.

### Volumetric clouds
Port `vendor/takram-three-clouds/src/shaders/clouds.frag` + `types.glsl` + `parameters.glsl`;
noise `cloudShape.frag`/`cloudShapeDetail.frag`/`turbulence.frag`; helpers
`tileableNoise.glsl`/`perlin.glsl`.
- marchClouds (clouds.frag:472): ≤ maxIterationCount (500, low=200); stepSize grows
  ×perspectiveStepScale 1.01; maxStepSize 1000m; maxRayDistance 2e5m; blue-noise jitter;
  2-level empty skip; early-out transmittance ≤ 1e-2; Frostbite energy-conserving integ.
- marchOpticalDepth (:346): sun steps 2 (high=3 to ground) + Beer Shadow Map.
- density (types.glsl): sampleWeather (coverage remap) → sampleMedia (low-freq erosion +
  hi-freq detail + turbulence + vertical getLayerDensity). 4 layers as vec4 lanes.
- scatter: dual-lobe HG g=(0.7,-0.2) mix 0.5; 8 multi-scatter octaves; powder
  1−0.8·exp(−ext·150); Beer exp(−ext·step); ambient + ground bounce albedo 0.3.

### Tonemap
takram emits linear HDR (toneMapped:false). Host applies **AgX** with
`toneMappingExposure = 5` (?exposure, [0.1,20]). Port = exposure×5 then AgX final pass.

## 3. Per-frame uniforms
- Camera: inverseProjection, inverseView, cameraPosition, cameraFar, projection/view.
- **ECEF (load-bearing):** worldToECEFMatrix = translate(0, bottomRadius=6_360_000, 0);
  correctAltitude=false; altitudeCorrection=(0,0,0). Shader works in **km** (×0.001).
  Dereth is a sphere, not WGS-84 — without this the camera goes ~18km underground.
- **sunDirection** (only time-driven uniform), y-up three.js:
  x=cos(pitch)sin(head), y=sin(pitch), z=−cos(pitch)cos(head). heading 0=north, CW.
  From wasm getSkyState → {dirHeading,dirPitch} deg (sun_direction.js:49).
  Retail Dereth sun never sets (pitch floors 0.9°); `?nightRamp` (default ON) remaps
  pitch [0.9,20]→[−14,20] for the sky raymarch only, so night is possible.
- Sun/moon disc: sunAngularRadius 0.004675→**0.03** (AC look); moon 0.0045→**0.025**.
- Star intensity ×= nightFrac (sin(sunPitch) ramp over altitude [−0.10,+0.10]).
- Clouds: sunDirection, cameraHeight=max(0,cam.y); coverage 0.3 default / 0.5 fair /
  0.55 storm; 4 layers (r,g,b,a) altitude/height/densityScale/coverageFilterWidth:
  r 750/650/0.2/0.6, g 1000/1200/0.2/0.6, b(cirrus) 7500/500/0.003/0.5,
  a(alto) 3500/600/0.004/0.5; storm swaps cumulonimbus on ch a (600/6000/0.05, inverted).
  wind ≈ (SPEED·0.8, SPEED·0.6), SPEED=7.7e-5·scale tiles/s ≈25km/h. Only binary is_storm
  reaches the renderer (fair vs storm look).
- Atmosphere constants (AtmosphereParameters.DEFAULT, Bruneton Earth):
  solarIrradiance (1.474,1.8504,1.91198); bottomR 6_360_000; topR 6_420_000;
  rayleigh (0.005802,0.013558,0.0331)/km H=8km; mie 0.003996 ext 0.00444 g0.8 H=1.2km;
  ozone (0.00065,0.001881,0.000085) tent 25±15km; groundAlbedo 0.1; muSMin cos120°.
  radiance→luminance sun (98242.79,69954.40,66475.01) sky (114974.92,71305.95,65310.55).

## 4. Assets to ship
Atmosphere LUTs (`scene3d/assets/atmosphere/`, half-float, LinearFilter, ClampToEdge):
transmittance.exr 256×64 (2D); scattering.exr 256×128×32 (3D, Mie in alpha);
irradiance.exr 64×16 (2D); higher_order_scattering.exr 256×128×32 (3D);
single_mie_scattering.exr (unused when combined). Convert EXR→DDS/half-float bin for D3D11.
Stars: `node_modules/@takram/three-atmosphere/assets/stars.bin` = 90_960 B = 9_096×10:
int16[3] ECI pos (off0), uint8 mag (off6), uint8[3] rgb (off7). (Ship local copy.)
Clouds (`assets/clouds/`, all prebaked):
shape.bin 128³ R8 (2_097_152B) repeat, shapeRepeat 0.0003/m (~3.3km tile);
shape_detail.bin 32³ R8 (32_768B), shapeDetailRepeat 0.006 (~167m);
turbulence.png 128² RGBA8 mip repeat, turbulenceRepeat 20;
local_weather.png (default) / local_weather_nasa.png (?wxMap=nasa) /
local_weather_dereth.png — 512² RGBA8 mip repeat, coverage 1 ch/layer, a=storm cores,
localWeatherRepeat 100;
stbn.bin 128×128×64 R8 blue noise NearestFilter repeat (1_048_576B).

## 5. Integration / entry points
Entry `scene3d/index.js` (~L5407 ?atmosphere=on): AtmosphereRuntime (loads LUTs) →
createAtmospherePipeline. AtmosphereSky (`atmosphere_sky.js`) builds SkyMaterial quad +
stars into skyScene. CloudOverlay (`?clouds=on`, ~L5285) wraps CloudVolume → CloudsEffect.
Camera: skyCamera mirrors main each frame. Time/sun: SkyStateCache (`sky_lighting.js`)
polls session.getSkyState(); AtmosphereSky.tick reads dirHeading/dirPitch.
Sun/time model in Rust: `crates/holtburger-world/src/sky.rs` — SkyEvalState computes
time_of_day_normalized = (world_seconds mod 7620)/7620, lerps region SkyDesc SkyTimeOfDay
keyframes (from PhatSDK SkyDesc.cpp). Celestial rotation advances 11.34× wall-clock.
**Only sun dir + time-of-day + fog color come from wasm; all rendering is GLSL.** Noise
volumes are prebaked assets (ship the .bin directly). We can reimplement the sun model.

## 6. Prioritized port order
- **Phase 1 (atmosphere only, smallest faithful subset):** bake/convert 3 core LUTs;
  port bruneton-reference/{definitions,common,runtime}.glsl → HLSL (GetSkyRadiance +
  phases + LUT coord map); fullscreen quad (z=w=1), ray→ECEF (translate(0,6.36e6,0),
  correctAltitude=false, ×0.001), feed sunDirection, sun disc 0.03; exposure×5 + AgX.
  → physically-lit sky gradient + sun + horizon at all times of day.
- **Phase 2 stars:** stars.bin points, Pogson mag, ECI→ECEF, nightFrac fade. Cheap, big night payoff.
- **Phase 3 clouds (largest):** port clouds.frag + types.glsl; ship the 5 cloud assets;
  4-layer FAIR + coverage 0.5 + sun + wind; render offscreen, composite premult-alpha
  last (depth-unaware OK). Start low/medium preset (200–500 primary, 1–2 sun steps).
- **Phase 4 (optional) aerial perspective:** GetSkyRadianceToPoint over scene depth —
  needs retail depth in our device; skip (Bruneton fog over ~1km Dereth is near-invisible).

## Key files
pipeline `scene3d/atmosphere_pipeline.js`; LUT load `scene3d/atmosphere_runtime.js`;
sky+stars `scene3d/atmosphere_sky.js`; sun vec `scene3d/sun_direction.js`; night ramp
`scene3d/night_ramp.js`; clouds `scene3d/cloud_overlay.js`+`cloud_volume.js`+`cloud_storm_look.js`;
sun/time `crates/holtburger-world/src/sky.rs`. Shaders:
`vendor/takram-three-clouds/shaders/bruneton-reference/*.glsl` (atmo) +
`vendor/takram-three-clouds/src/shaders/{clouds.frag,types.glsl,cloudShape.frag,cloudShapeDetail.frag}`;
constants `node_modules/@takram/three-atmosphere/src/AtmosphereParameters.ts`.
