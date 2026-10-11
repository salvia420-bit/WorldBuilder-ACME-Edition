// scene3d/ac_moons.js — Asheron's Call's two moons in the skybox.
//
// AC canon: there are two moons visible in the night skies of
// Auberean (Dereth's parent world).
//   - Alb'arel (light/tan) — the larger, primary moon. Wiki lore
//     describes "perfect geometry of lights on the dark side" — the
//     greenish dot cluster visible on the left of the source image.
//   - Rez'arel (red) — the smaller, cratered companion.
//
// Source images: 1024x1024 RGBA PNGs at
// scene3d/assets/moons/{albarel.png, rezarel.png}, swapped in
// 2026-05-18 from the prior 256x256 JPGs. Both are PNGs of the moon
// centered on dark background — background removal is shader-side
// via a circular alpha mask (no pre-processing of the source images,
// no chroma-key fragility).
//
// Alb'arel gets a procedural cloud swirl + a sparkling neon-green
// emission from the alien-city light cluster on the disc's left
// side. The new high-res Alb'arel image has the cloud layer
// REMOVED (vs the original cloud-swirl JPEG), so we generate the
// clouds in-shader to recreate the look of the prior asset.
//
// Each moon is a billboard plane attached to skyDome.skyScene with
// the same render-order semantics as cloud_overlay (renderOrder
// just below 999 so cloud overlay composites in front when both
// occupy the same pixel). The world pass that follows the sky pass
// uses `clear=false, clearDepth=true` so moon color is preserved
// across the world render — world geometry naturally overpaints
// the moons at world pixels.
//
// Orbital motion is purely visual: AC has no canonical moon orbital
// periods, so periods are picked for visual interest at the player's
// typical session length. `?moonSpeed=N` URL param scales the rate
// for debugging — speedMul=10 moves the moons across the sky in a
// minute or two.
//
// MOON FX (2026-10-11, `?moonFx` — DEFAULT ON, `=off` escape). Owner, on
// the 1070: "the clouds are getting throttled a little too hard so the
// inside is missing ... a little more paintbrushy, like a satellite image
// of clouds on jupiter ... make the moons look more 3d". The flag swaps
// the fragment shader (MOON_FX_FRAG below; MOON_FRAG is kept byte for
// byte as the `=off` path) and makes each quad 1.3x larger so a halo has
// room outside the disc; the visible disc is the same size. What it does:
//   - THE THROTTLE. The old cloud opacity folded back to zero once
//     cloudAmt * uCloudIntensity passed 3.5 (the round-4 "taper past
//     t=1.0"), and at the shipped uCloudIntensity=5 that is every dense
//     cloud pixel: 64% of the top-left cloud region drew nothing, so only
//     a ring at the mask edge survived. On top, a quadrant mask kept the
//     clouds to the top of the disc and a +0.05 bias painted a 25%
//     cloud-colour wash over the whole moon. The FX clouds have none of
//     the three: coverage is one smooth threshold of the cloud field, it
//     covers the whole sphere, and the only limb change is physical (the
//     slant path through the layer thickens it).
//   - JUPITER CLOUDS. A cloud field on the SPHERE (3D value noise on the
//     reconstructed normal, so it wraps and foreshortens toward the
//     limb): latitude bands with irregular widths, alternating zonal jets
//     shearing a warped, anisotropic fbm into brushed streaks, three
//     long-lived vortex ovals, emboss lighting and soft wisp edges. The
//     motion is a rigid rotation of the layer plus a two-phase flow
//     (each phase shears for 240 s and is cross-faded out before it
//     resets), so it animates forever without the shear winding up and
//     without unbounded noise coordinates. The flow clock integrates
//     uCloudSpeed in JS (moonCloudFlow, node-tested).
//   - A LIT SPHERE. The art is painted with a fixed sun from the right
//     (the left limb is in shadow — that is where the city lights sit).
//     The shader divides that baked light out (a light model fitted to
//     each PNG offline, the baked-dark limb refilled from the mirrored
//     lit side) and relights the albedo with the real sky sun (the same
//     night-ramped sun atmosphere_sky.js raymarches), so each moon shows
//     a true phase: lunar-Lambert shading, a soft terminator, a faint
//     earthshine floor, craters raised from texture luminance, cloud
//     shadows, a cloud-tinted atmosphere rim and a soft halo on Alb'arel,
//     a faint aureole on Rez'arel. A slow libration wobbles each surface
//     a few degrees. Near the horizon the disc reddens and loses contrast
//     (per-fragment airmass). By day the unlit part lets the sky through.
//     The city lights sharpen and brighten on the night side.
// Knobs: `?moonPhase=0..1` (0 = the art's own lighting) and the
// `window.__setMoon*` setters at the bottom; `window.__moonFxState()`
// reports what each moon is being lit with.

import * as THREE from 'three';
// NIGHT RAMP (2026-08-02, ?nightRamp — DEFAULT ON). With retail's 0.9 deg
// dirPitch floor this fade could only ever reach nightFrac ~0.42, capping the
// moons at ~0.62 brightness at the darkest hour of the AC day. Routing the
// authored pitch through the same art remap the sky uses lets them reach 1.0.
// Identity when the flag is off. See night_ramp.js.
// MOON FX: the night factor + the sun the moons are lit by come from the same
// remap, so the moons are lit by the sun the player sees set.
import { artSunPitchDeg, nightFactorFromArtPitch } from "./night_ramp.js";
import { sunDirFromHeadingPitch } from "./sun_direction.js";

// Sky-sphere radius the existing parametric moon sits at
// (skyDome.js:556 references it as "anchor 0x2000714 → paired body
// 0x1001f6a at (2066, 545, 0)"). Our AC moons sit on the same shell.
const SKY_RADIUS = 2000;

// Angular half-radii (radians of half-angle subtended by the moon at
// the viewer). Tuned 2026-05-18 against the AC reference screenshot
// (Alb'arel ~13.5% of screen height at 60° FOV); user requested
// another 25% on top to compensate for the modern display.
//
// 2026-05-18 second pass: Rez'arel further shrunk 20% (0.092 → 0.0736)
// per user feedback that the companion was reading too large relative
// to Alb'arel in the new high-res textures.
const ALB_ANGULAR_RADIUS = 0.115;  // Alb'arel — primary, larger (~6.6°, ~13° dia)
const REZ_ANGULAR_RADIUS = 0.0736; // Rez'arel — companion, smaller (~4.2°, ~8.4° dia)

// Orbital periods at speedMul=1, in milliseconds of wall time.
// Picked so a 5-10 min play session shows visible motion. AC's
// 11.34× compressed game time isn't used here — these orbits are
// purely visual; AC has no canonical lunar periods.
const ALB_PERIOD_MS = 30 * 60 * 1000; // 30 wall min
const REZ_PERIOD_MS = 15 * 60 * 1000; // 15 wall min (slightly faster)

const MOON_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Circular alpha mask + soft edge. The moon image is a centered disk
// against a dark background — we discard outside the disc radius
// (0.46 of UV space = 23% inset from each edge). Soft edge from
// 0.44..0.46 hides any compression boundary at the disc's edge.
// The Alb'arel green-light halo is allowed to bleed out to 0.50 so
// the alien city's glow extends slightly off the disc.
//
// `uBrightness` multiplies the moon color before output — boosting
// helps the disc punch through AerialPerspective scattering on the
// way to the canvas. 2.0 is a starting point; live-tune via
// `liveScene3d.acMoons.albMesh.material.uniforms.uBrightness.value`.
//
// uHasClouds: 1.0 only for Alb'arel. Toggles the in-shader cloud
// swirl + alien-city-light sparkle. Rez'arel stays bare (0.0).
//
// uCloudIntensity / uCloudSpeed / uCityIntensity / uCityPos:
// live-tunable knobs for the Alb'arel atmosphere. Each has a
// `window.__set*` setter (see bottom of file).
// Secondary "rune" lights below the main alien-city hotspot on
// Alb'arel form a Hagol (Younger Futhark Hagall ᚼ) snowflake-
// asterisk pattern — 1 center + 6 mid-ring + 6 outer-ring + 2
// asymmetry accents = 15. Each light has its own pulse period and
// a deterministic phase offset, so they flicker out of sync.
// NUM_MICRO_LIGHTS is the GLSL constant (declared inside the shader
// template literal below); ALB_NUM_MICRO_LIGHTS is the JS-side
// mirror used to size the uniform array on construction.
const ALB_NUM_MICRO_LIGHTS = 15;

const MOON_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform float uBrightness;
uniform float uTime;
uniform float uHasClouds;
uniform float uCloudIntensity;
uniform float uCloudSpeed;
uniform float uCityIntensity;
uniform vec2  uCityPos;
// Rez'arel "minor effects" knobs. Scintillation on bright crater
// highlights, plus warm shift on brights + cool limb darkening.
// Default 0.0 on Alb'arel (which has its own atmosphere); 1.0 on
// Rez'arel where these mercury-style touches live.
uniform float uScintEnabled;
uniform float uScintIntensity;

#define NUM_MICRO_LIGHTS 15
// Per-light data: (uv.x, uv.y, brightness, pulsePeriodSec)
uniform vec4  uMicroLights[NUM_MICRO_LIGHTS];

float mhash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float mfade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float mvnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = mhash21(i);
  float b = mhash21(i + vec2(1.0, 0.0));
  float c = mhash21(i + vec2(0.0, 1.0));
  float dd = mhash21(i + vec2(1.0, 1.0));
  float u = mfade(f.x);
  float v = mfade(f.y);
  return mix(mix(a, b, u), mix(c, dd, u), v);
}
float mfbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += mvnoise(p) * amp;
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 c = vUv - 0.5;
  float d = length(c);
  // Allow the city halo to bleed past the disc edge (cap at 0.50).
  // The surface itself still uses the tighter 0.46 cutoff for edge.
  if (d > 0.50) discard;
  float edge = 1.0 - smoothstep(0.44, 0.46, d);

  vec3 rgb = texture2D(map, vUv).rgb * uBrightness;
  float alpha = edge;

  if (uScintEnabled > 0.5) {
    // -- Crater-highlight scintillation -------------------------
    // Pick out the brightest pixels (sunlit crater edges + impact
    // flashes in the source texture) via luminance, then modulate
    // them with a per-pixel time-stepped hash. floor(uTime * 5.0)
    // makes the noise hold for ~200 ms before changing — that
    // stutter mimics actual atmospheric twinkle vs a smooth ripple
    // (which would read as the moon vibrating, not scintillating).
    float lum = max(max(rgb.r, rgb.g), rgb.b);
    float brightMask = smoothstep(0.55, 0.88, lum);
    float scintNoise = mhash21(floor(vUv * 220.0) + floor(uTime * 5.0));
    float scintMag = 0.30 * uScintIntensity;
    float scint = 1.0 + (scintNoise - 0.5) * scintMag;
    rgb *= mix(1.0, scint, brightMask);

    // -- Warm shift on bright spots -----------------------------
    // Tiny pull toward solar-illumination yellow-white so the
    // sunlit faces of craters read as warmer than the shadowed
    // walls. Lerp weighted by brightMask × 0.35.
    rgb = mix(rgb, rgb * vec3(1.06, 1.02, 0.92), brightMask * 0.35);

    // -- Cool limb darkening ------------------------------------
    // Faint blue-grey shift toward the disc edge — visual interest
    // only (Rez'arel has no atmosphere in canon). Keeps the moon
    // from reading as a flat disc cut out of paper.
    float limbMask = smoothstep(0.30, 0.46, d);
    rgb = mix(rgb, rgb * vec3(0.85, 0.88, 1.02), limbMask * 0.30);
  }

  if (uHasClouds > 0.5) {
    // -- Cloud swirl ----------------------------------------------
    // Domain-warped fbm storm. 2026-05-18 tuning pass: confined
    // mostly to the top-left quadrant with a slight bleed toward
    // the top-right near the disc center, drifting slowly for an
    // ominous look (darker grey-blue tint, lower default speed).
    float tSlow = uTime * 0.018 * uCloudSpeed;
    vec2 cloudUv = vUv * 3.2;
    float warpX = mvnoise(cloudUv * 0.55 + vec2(tSlow, 0.0)) - 0.5;
    float warpY = mvnoise(cloudUv * 0.55 + vec2(17.0, tSlow)) - 0.5;
    vec2 warped = cloudUv + vec2(warpX, warpY) * 1.3;
    float cloud = mfbm(warped + vec2(tSlow * 0.5, 0.0));

    // Quadrant mask: top-left dominant, soft taper out to (0.55,
    // 0.50). A secondary lobe bleeds into the top-right NEAR the
    // disc center (UV.x in [0.50, 0.72]) at ~45% strength so the
    // band appears to wrap around the upper hemisphere from the
    // left, fading by the time it reaches the right limb.
    // Mask widened 2026-05-18 round 3 (user: "400% more cloud").
    // TL extends further right (0.55→0.62) and lower (0.50→0.45);
    // TR bleed pushed to ~65% strength and reaches further across.
    float tlMask   = (1.0 - smoothstep(0.30, 0.62, vUv.x))
                   * smoothstep(0.45, 0.65, vUv.y);
    float trBleed  = smoothstep(0.50, 0.55, vUv.x)
                   * (1.0 - smoothstep(0.55, 0.80, vUv.x))
                   * smoothstep(0.45, 0.65, vUv.y) * 0.65;
    float quadMask = max(tlMask, trBleed);
    float discMask = 1.0 - smoothstep(0.30, 0.46, d);
    // Power exponent dropped 1.45 → 1.0 so more of the fbm range
    // qualifies as cloud; threshold offset relaxed so we stop
    // chopping the soft edges.
    float cloudAmt = pow(cloud, 1.0) * quadMask * discMask;
    cloudAmt = clamp(cloudAmt * 2.4 + 0.05, 0.0, 1.0);
    // Ominous: storm-grey with a cool blue lean. Reads as brooding
    // overcast rather than fair-weather cumulus.
    vec3 cloudCol = vec3(0.42, 0.45, 0.52);
    // 2026-05-18 round 4: prior code passed cloudAmt * uCloudIntensity
    // straight to mix(), which at uCloudIntensity=5.0 routinely
    // exceeded 1.0 in the densest spots. GLSL mix() doesn't clamp —
    // it linearly EXTRAPOLATES past cloudCol, producing saturated
    // blue artifacts in the cloud body. Fix: clamp the blend AND
    // taper opacity back down past t=1.0 so the would-be-blue
    // densest spots read as the cloud thinning into transparency,
    // matching user feedback "if those could just be transparent
    // then that would be perfectly".
    float t = cloudAmt * uCloudIntensity;
    float opacity = (t < 1.0) ? t : (1.0 - (t - 1.0) * 0.4);
    opacity = clamp(opacity, 0.0, 0.92);
    rgb = mix(rgb, cloudCol, opacity);

    // -- Main alien-city hotspot ----------------------------------
    // 2026-05-18: brightness baked-down to 0.20 of the prior value
    // (user feedback: -80%). Tight exp core + soft wide halo. Halo
    // extends past the disc edge so the light emanates.
    float cityDist = distance(vUv, uCityPos);
    float core = exp(-cityDist * 28.0);
    float halo = exp(-cityDist *  9.0) * 0.35;
    // 2026-05-19: renamed t to tm here because line ~231 already
    // declared float t = cloudAmt * uCloudIntensity in this same
    // scope. GLSL doesn't allow same-scope redefinition (caught via
    // Playwright Chromium validate-status; swiftshader was silently
    // permissive). Unblocks the FPS plan validation harnesses.
    // NOTE: no backticks in this comment — it lives inside a JS
    // template literal carrying the shader source.
    float tm = uTime;
    float sparkle =
        0.55
      + 0.30 * sin(tm * 3.17)
      + 0.20 * sin(tm * 7.71 + 1.1)
      + 0.18 * sin(tm * 13.9 + 0.4)
      + 0.18 * (mvnoise(vec2(tm * 4.0, 0.7)) - 0.5)
      + 0.22 * (mhash21(floor(vUv * 90.0) + floor(tm * 6.0)) - 0.5);
    sparkle = clamp(sparkle, 0.25, 1.6);
    vec3 neon = vec3(0.18, 1.05, 0.42);
    // Disc-boundary fade — shared by main hotspot + micro-lights.
    float emissionEdge = 1.0 - smoothstep(0.48, 0.50, d);
    vec3 mainEmission = neon * (core * 2.6 + halo) * sparkle * 0.20 * uCityIntensity;

    // -- Hagol micro-light array ----------------------------------
    // 15 secondary lights forming a Younger-Futhark Hagall ᚼ
    // snowflake-asterisk centered below the main hotspot. Each
    // light pulses at its own period (uMicroLights[i].w) with a
    // deterministic phase derived from its UV position so the
    // cluster never throbs in unison. Brightness per light is
    // ~5-10% of the prior baseline (user feedback: -90 to -95%).
    vec3 microEmission = vec3(0.0);
    float microAlphaAcc = 0.0;
    for (int i = 0; i < NUM_MICRO_LIGHTS; i++) {
      vec4 ml = uMicroLights[i];
      vec2 mlPos   = ml.xy;
      float mlBri  = ml.z;
      float mlPer  = max(ml.w, 0.1);
      float mlDist = distance(vUv, mlPos);
      // Per-light glow: tighter than the main hotspot (smaller dots).
      float mlCore = exp(-mlDist * 80.0);
      float mlHalo = exp(-mlDist * 22.0) * 0.30;
      // Per-light pulse phase from position hash, scaled to a full
      // cycle so the asterisk lights start out of sync.
      float mlPhase   = mhash21(mlPos * 31.7) * 6.2831853;
      float mlPulse   = 0.45 + 0.55 * sin(tm * 6.2831853 / mlPer + mlPhase);
      float mlTwinkle = 0.80 + 0.30 * sin(tm * 11.0 + mlPhase * 2.1);
      float mlScale   = mlBri * mlPulse * mlTwinkle * uCityIntensity;
      microEmission += neon * (mlCore * 1.4 + mlHalo) * mlScale;
      microAlphaAcc  = max(microAlphaAcc, (mlCore * 0.8 + mlHalo) * mlScale);
    }

    rgb += (mainEmission + microEmission) * emissionEdge;

    // Halo contributes its own alpha outside the disc so the
    // emission isn't clipped to the surface mask.
    float mainHaloAlpha = clamp(halo * 0.9 + core * 1.4, 0.0, 1.0)
                        * sparkle * 0.20 * uCityIntensity * emissionEdge;
    alpha = max(alpha, max(mainHaloAlpha, microAlphaAcc * emissionEdge));
  }

  gl_FragColor = vec4(rgb, alpha);
}
`;

// === MOON FX (2026-10-11, `?moonFx`, default ON) ==========================
// See the file header. Everything below this line up to `class ACMoons` is
// the FX path; MOON_FRAG above is the `=off` path and is never edited.

// The FX quad is this much larger than the legacy quad (same disc size on
// screen) so the halo and the city glow can fade out before the quad edge.
const MOON_FX_QUAD_SCALE = 1.3;
// Two-phase cloud flow: each phase shears the field for this long, then is
// cross-faded out and reset (see moonCloudFlow).
const MOON_CLOUD_FLOW_PERIOD_S = 240;
// Rigid rotation of Alb'arel's cloud layer at the reference speed, rad/s (a
// full turn in ~70 min — a feature crosses the visible disc in ~20 min,
// about the drift of the old swirl).
const MOON_CLOUD_ROT_RATE = 0.0015;
// uCloudSpeed value the flow rates above are tuned for (the shipped default).
// The flow clock advances at uCloudSpeed / this, so __setMoonCloudSpeed keeps
// its old meaning (0 freezes, 2x the default doubles the drift).
const MOON_CLOUD_SPEED_REF = 0.22;
// Seeds of the flow phases cycle through this many fields (keeps the noise
// domain offsets bounded however long the session runs).
const MOON_CLOUD_SEEDS = 64;

// Initial values of the shared FX knobs (each has a window.__setMoon* setter).
const MOON_FX_DEFAULTS = Object.freeze({
  // 1 = the moon is lit by the sky's sun (true phase); 0 = the art's own
  // painted lighting, as before (the new clouds / halo / rim stay).
  phase: 1.0,
  // Night-side floor ("earthshine"), relative to full sunlight. Small on
  // purpose: the composer's exposure 5 lifts darks a lot — 0.01 already
  // reads as a dim disc against the night sky.
  ambient: 0.010,
  // Texture-luminance relief (craters on Rez'arel, canyons on Alb'arel).
  relief: 1.0,
  // Soft halo just outside the disc (scaled by the lit fraction; night only).
  halo: 1.0,
  // Horizon extinction + contrast loss (per-fragment airmass).
  horizon: 1.0,
  // Cloud shadows on Alb'arel's surface.
  cloudShadow: 0.6,
  // Libration amplitude, degrees (yaw; pitch is half of it). 0 = off.
  libDeg: 6.0,
});
// Extinction per unit airmass above 1 (R, G, B) at uHorizon = 1. Deliberately
// gentle: ~3% / 7% / 13% off at 20 deg altitude, ~8% / 15% / 29% at 10 deg, a
// deep orange only in the last few degrees — "a little" reddening, as asked.
const MOON_EXTINCTION_K = [0.018, 0.036, 0.075];

// Per-moon FX constants. bakedSun / bakedShape / bakedNorm describe the light
// PAINTED INTO each PNG, fitted offline (2026-10-11) by least squares to the
// mask-normalised blurred luminance of the disc:
//   baked(n) = (amb + (1 - amb) * clamp((dot(n, B) + wrap) / (1 + wrap))^pow) * norm
// with n the sphere normal at a texel, B the painted sun (texture frame, +x =
// right, +y = up, +z = toward the viewer), and norm = 1 / disc mean, so the
// de-lit albedo keeps the picture's mean brightness. Alb'arel: a broad wrap
// gradient from the right (R^2 0.88); Rez'arel: a Lambert terminator near
// the left limb, sun 53 deg right of the viewer (R^2 0.79).
const MOON_FX_ALB = Object.freeze({
  bakedSun: [0.9847, -0.1101, 0.1351],
  bakedNorm: 3.3717,
  bakedShape: [1.0, 3.2413, 0.0693], // wrap, pow, amb
  // 0 = Lambert, 1 = Lommel-Seeliger. A cloudy atmosphere planet is mostly
  // Lambertian (darker toward the limb at full phase).
  lunarL: 0.30,
  rim: 1.0,
  rimColor: [0.45, 0.58, 0.85],
  haloColor: [0.50, 0.62, 0.90],
  // Libration: yaw / pitch periods (orbit ms, so ?moonSpeed scales them too)
  // and phase offsets (rad).
  libPeriodsMs: [7.3 * 60e3, 11.9 * 60e3],
  libPhase: [0.0, 1.3],
});
const MOON_FX_REZ = Object.freeze({
  bakedSun: [0.7892, 0.1293, 0.6003],
  bakedNorm: 1.8291,
  bakedShape: [0.0, 0.7385, 0.0787],
  // Airless, regolith: nearly flat at full phase (the real full Moon has
  // almost no limb darkening), a bright limb toward the sun at quarter.
  lunarL: 0.70,
  rim: 0.0,
  rimColor: [0.0, 0.0, 0.0],
  haloColor: [0.90, 0.55, 0.40],
  libPeriodsMs: [5.1 * 60e3, 8.7 * 60e3],
  libPhase: [2.1, 0.4],
});

// FX fragment shader. Same varyings / legacy uniforms as MOON_FRAG (so every
// existing knob keeps working) plus the FX uniforms. All UV-space constants
// are in the LEGACY quad's UV space (disc radius 0.46): uv below undoes the
// larger FX quad first. Frames: "view" = the billboard (+x right, +y up,
// +z toward the viewer, which is where lookAt points the quad's +Z);
// "body" = the textured sphere (view rotated by the libration uLib); "cloud"
// = body rotated about +y by the cloud layer's rigid rotation.
// NOTE: no backticks anywhere in here — this is a JS template literal.
const MOON_FX_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform float uBrightness;
uniform float uTime;
uniform float uHasClouds;
uniform float uCloudIntensity;
uniform float uCityIntensity;
uniform vec2  uCityPos;
uniform float uScintEnabled;
uniform float uScintIntensity;

#define NUM_MICRO_LIGHTS 15
// Per-light data: (uv.x, uv.y, brightness, pulsePeriodSec), texture UV.
uniform vec4  uMicroLights[NUM_MICRO_LIGHTS];

uniform float uQuadScale;    // FX quad size / legacy quad size
uniform vec3  uSunLocal;     // unit sun direction, view frame
uniform mat3  uLib;          // view -> body (libration)
uniform float uNight;        // 0 day .. 1 night (night_ramp band)
uniform float uPhase;        // 0 painted lighting .. 1 sun-lit sphere
uniform float uAmbient;      // night-side floor
uniform float uRelief;       // luminance bump strength
uniform float uLunarL;       // 0 Lambert .. 1 Lommel-Seeliger
uniform float uRim;          // atmosphere rim strength
uniform vec3  uRimColor;
uniform float uHalo;         // halo strength outside the disc
uniform vec3  uHaloColor;
uniform float uHorizon;      // horizon extinction strength
uniform vec3  uExtinctionK;  // extinction per airmass above 1 (RGB)
uniform float uMoonAlt;      // disc-centre altitude, rad
uniform float uAngRadius;    // disc angular radius, rad
uniform vec4  uBakedSun;     // xyz painted sun (body frame), w disc-mean norm
uniform vec3  uBakedShape;   // wrap, pow, amb of the painted light
uniform vec4  uCloudFlow;    // phase A time, phase B time, phase A weight, rigid rotation
uniform vec2  uCloudSeed;    // phase A seed, phase B seed
uniform float uCloudShadow;  // cloud shadow strength

#define MOON_R_UV 0.46
// Zonal jet speed inside a flow phase, rad/s per unit of the jet profile.
#define MOON_CLOUD_JET 0.0015
const vec3 MOON_LUMA = vec3(0.2126, 0.7152, 0.0722);

float mhash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float mhash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float mfade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float mvnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = mhash21(i);
  float b = mhash21(i + vec2(1.0, 0.0));
  float c = mhash21(i + vec2(0.0, 1.0));
  float dd = mhash21(i + vec2(1.0, 1.0));
  float u = mfade(f.x);
  float v = mfade(f.y);
  return mix(mix(a, b, u), mix(c, dd, u), v);
}
// 3D value noise, same hash family as mhash21.
float mvnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = vec3(mfade(f.x), mfade(f.y), mfade(f.z));
  float n000 = mhash31(i);
  float n100 = mhash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = mhash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = mhash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = mhash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = mhash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = mhash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = mhash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// Normalised fbm (mean ~0.5), at most 5 octaves.
float mfbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += mvnoise3(p) * amp;
    norm += amp;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum / norm;
}
vec3 mRotY(vec3 p, float a) {
  float ca = cos(a);
  float sa = sin(a);
  return vec3(p.x * ca + p.z * sa, p.y, p.z * ca - p.x * sa);
}
// Stretch the polar axis: features come out long along the bands.
vec3 mAniso(vec3 p, float k) { return vec3(p.x, p.y * k, p.z); }

// The light painted into the PNG at body normal n (see MOON_FX_ALB).
float mBaked(vec3 n) {
  float s = pow(clamp((dot(n, uBakedSun.xyz) + uBakedShape.x) / (1.0 + uBakedShape.x), 0.0, 1.0), uBakedShape.y);
  return (uBakedShape.z + (1.0 - uBakedShape.z) * s) * uBakedSun.w;
}

// Long-lived vortex ovals in the cloud frame: (lat, lon, radius, swirl).
// The swirl rotates the domain about the oval centre (Rodrigues) with an
// elliptical falloff, wider along the band; ring gathers a bright rim and
// a dense core so the ovals read as storms, not just bent streaks.
vec3 mVortex(vec3 p, vec4 vx, inout float ring) {
  vec3 v = vec3(cos(vx.x) * sin(vx.y), sin(vx.x), cos(vx.x) * cos(vx.y));
  vec3 east = normalize(vec3(v.z, 0.0, -v.x));
  vec3 north = cross(v, east);
  vec3 d = p - v;
  float dx = dot(d, east) / (vx.z * 1.7);
  float dy = dot(d, north) / vx.z;
  float rr = dx * dx + dy * dy;
  float a = vx.w * exp(-rr * 1.4);
  float ca = cos(a);
  float sa = sin(a);
  float rq = sqrt(rr) - 1.0;
  ring += exp(-rq * rq * 8.0) * 0.5 + exp(-rr * 2.0) * 0.35;
  return p * ca + cross(v, p) * sa + v * dot(v, p) * (1.0 - ca);
}

// One flow phase of Alb'arel's cloud field at cloud-frame normal nC.
// tk = the phase's local time (s, bounded), seed = its field, sd = offset
// toward the sun for the shadow / emboss lookup. Returns (turbulence,
// streaks, band profile, vortex ring); turbS = turbulence at nC + sd.
vec4 mCloudField(vec3 nC, float tk, float seed, vec3 sd, out float turbS) {
  float lat = asin(clamp(nC.y, -1.0, 1.0));
  // Alternating zonal jets plus an equatorial super-rotation.
  float jet = sin(lat * 9.0) + 0.6 * exp(-lat * lat / 0.04);
  vec3 p = mRotY(nC, jet * MOON_CLOUD_JET * tk);
  float ring = 0.0;
  p = mVortex(p, vec4(-0.38, -0.35, 0.16, 2.6), ring);
  p = mVortex(p, vec4(0.52, 0.55, 0.10, -2.2), ring);
  p = mVortex(p, vec4(0.18, 1.9, 0.09, 2.0), ring);
  vec3 so = fract(vec3(0.1731, 0.3497, 0.5891) * seed) * 37.0;
  // Domain warp, mostly along the band (east): shears the streaks into
  // festoons; a little north-south makes the band edges wavy.
  vec3 q = mAniso(p, 4.0) * 1.6 + so;
  float w1 = mfbm3(q + 3.1, 2);
  float w2 = mfbm3(q + 7.7, 2);
  vec3 east = normalize(vec3(p.z, 0.0, -p.x) + vec3(1.0e-5, 0.0, 0.0));
  vec3 north = cross(p, east);
  vec3 pw = p + east * ((w1 - 0.5) * 1.1) + north * ((w2 - 0.5) * 0.2);
  float turb = mfbm3(mAniso(pw, 4.0) * 2.6 + so, 5);
  // Brush bristles: a much more anisotropic single octave.
  float streak = mvnoise3(mAniso(pw, 9.0) * 5.72 + so);
  // Zones and belts of irregular width, mottled (no bands) near the poles.
  float latw = asin(clamp(pw.y, -1.0, 1.0));
  float band = sin(latw * 6.0 + 0.9 * sin(latw * 2.3 + 1.0) + 0.4)
             * (1.0 - smoothstep(0.95, 1.35, abs(latw)));
  turbS = mfbm3(mAniso(pw + sd, 4.0) * 2.6 + so, 3);
  return vec4(turb, streak, band, ring);
}

// A texture-UV point on the sphere (a city light) seen in the view frame.
vec3 mLightView(vec2 luv) {
  vec2 cb = (luv - 0.5) / MOON_R_UV;
  vec3 nb = vec3(cb, sqrt(max(1.0 - dot(cb, cb), 0.0)));
  return nb * uLib; // transpose(uLib) * nb: body -> view
}

void main() {
  // Legacy-quad UV (disc radius MOON_R_UV) and disc coordinates (radius 1).
  vec2 uv = 0.5 + (vUv - 0.5) * uQuadScale;
  vec2 c = (uv - 0.5) / MOON_R_UV;
  float r = length(c);
  float rMax = 0.5 * uQuadScale / MOON_R_UV;
  if (r > rMax) discard;
  float aa = max(fwidth(r) * 1.5, 0.004);

  // -- Sphere ----------------------------------------------------------
  // Orthographic sphere: the moon is far enough that every pixel sees it
  // along +z. Outside the disc c is left unnormalised so texture lookups
  // stay continuous across the limb (their result is masked away there).
  float mu = sqrt(max(1.0 - r * r, 0.0));
  vec3 nV = vec3(c, mu);
  vec3 nB = uLib * nV;
  // Orthographic back-projection onto the painted disc. Ignoring nB.z
  // mirrors the far hemisphere onto the near one, so a librated limb
  // never samples off the picture.
  vec2 tuv = 0.5 + nB.xy * MOON_R_UV;
  vec3 texel = texture2D(map, tuv).rgb;

  // -- Albedo: divide the painted light out ------------------------------
  // Where the painting is lit, texel / baked is the surface colour. Where it
  // is painted black (the left limb) there is nothing to recover, so the
  // albedo comes from the mirror-image texel on the lit side instead.
  float bk = mBaked(nB);
  vec3 nM = vec3(-nB.x, nB.y, nB.z);
  vec3 texelM = texture2D(map, 0.5 + nM.xy * MOON_R_UV).rgb;
  vec3 albedo = mix(texelM * min(1.0 / max(mBaked(nM), 1.0e-3), 3.0),
                    texel * min(1.0 / max(bk, 1.0e-3), 3.0),
                    smoothstep(0.15, 0.5, bk));

  // -- Relief: texture luminance as height -------------------------------
  // Offsets follow the on-screen texel footprint (one pixel), so the bump
  // stays at pixel scale whatever the zoom; the gradient is relative to the
  // local brightness, softened so dark texels do not turn into speckle.
  vec2 fwT = fwidth(tuv);
  float e = clamp(max(fwT.x, fwT.y), 1.0 / 1024.0, 1.0 / 96.0);
  float lc = dot(texel, MOON_LUMA);
  float lx = dot(texture2D(map, tuv + vec2(e, 0.0)).rgb, MOON_LUMA);
  float ly = dot(texture2D(map, tuv + vec2(0.0, e)).rgb, MOON_LUMA);
  vec2 grad = vec2(lx - lc, ly - lc) / (lc + 0.15);
  vec3 nL = normalize(nV - vec3(grad, 0.0) * (uRelief * 0.22));

  // -- Sunlight -------------------------------------------------------------
  vec3 S = normalize(uSunLocal);
  float ndl = dot(nV, S);    // geometric (no relief): alpha, haze, clouds
  float mu0 = dot(nL, S);
  // Soft terminator: C1 quadratic knee over +-0.06 instead of max(mu0, 0).
  float mu0s = mu0 > 0.06 ? mu0 : (mu0 < -0.06 ? 0.0 : (mu0 + 0.06) * (mu0 + 0.06) / 0.24);
  // Lunar-Lambert: 1.0 at the disc centre at full phase for any uLunarL.
  float dyn = 2.0 * uLunarL * mu0s / (mu0s + mu + 1.0e-3) + (1.0 - uLunarL) * mu0s;
  vec3 amb = uAmbient * (0.55 + 0.45 * mu) * vec3(0.70, 0.80, 1.0);
  vec3 rgb = mix(texel, albedo * (dyn + amb), uPhase) * uBrightness;

  if (uScintEnabled > 0.5) {
    // Rez'arel's touches from the legacy shader, now only where the sun
    // actually lights a crater (the twinkle cells stick to the surface).
    float lum = max(max(rgb.r, rgb.g), rgb.b);
    float brightMask = smoothstep(0.55, 0.88, lum);
    float scintNoise = mhash21(floor(tuv * 220.0) + floor(uTime * 5.0));
    float scint = 1.0 + (scintNoise - 0.5) * 0.30 * uScintIntensity;
    rgb *= mix(1.0, scint, brightMask);
    rgb = mix(rgb, rgb * vec3(1.06, 1.02, 0.92), brightMask * 0.35);
    float limbMask = smoothstep(0.652, 1.0, r);
    rgb = mix(rgb, rgb * vec3(0.85, 0.88, 1.02), limbMask * 0.30);
  }

  vec3 emissionOut = vec3(0.0); // city glow past the limb
  float cloudA = 0.0;
  if (uHasClouds > 0.5) {
    // -- Cloud field (two flow phases, variance-preserving blend) ----------
    vec3 nC = mRotY(nB, uCloudFlow.w);
    vec3 Sc = mRotY(uLib * S, uCloudFlow.w);
    float mu0c = dot(nC, Sc);
    // Toward the sun along the surface, longer at low sun (cloud height
    // 2.5% of the radius): where a cloud shadow lands / emboss samples.
    vec3 sd = (Sc - nC * mu0c) * (0.025 / max(mu0c, 0.18));
    float tsA;
    float tsB;
    vec4 fa = mCloudField(nC, uCloudFlow.x, uCloudSeed.x, sd, tsA);
    vec4 fb = mCloudField(nC, uCloudFlow.y, uCloudSeed.y, sd, tsB);
    float wA = uCloudFlow.z;
    float wB = 1.0 - wA;
    // Keeps the contrast constant through the cross-fade (two independent
    // fields averaged 50/50 would visibly soften every 120 s).
    float vn = inversesqrt(max(wA * wA + wB * wB, 1.0e-4));
    float turb = 0.5 + (wA * (fa.x - 0.5) + wB * (fb.x - 0.5)) * vn;
    float streak = 0.5 + (wA * (fa.y - 0.5) + wB * (fb.y - 0.5)) * vn;
    float turbS = 0.5 + (wA * (tsA - 0.5) + wB * (tsB - 0.5)) * vn;
    float band = fa.z * wA + fb.z * wB;
    float ring = fa.w * wA + fb.w * wB;
    float dens = 0.5 + 0.16 * band + 0.95 * (turb - 0.5) + 0.14 * ring + 0.10 * (streak - 0.5);
    float densS = 0.5 + 0.16 * band + 0.95 * (turbS - 0.5) + 0.14 * ring;
    // ONE soft threshold: no quadrant mask, no radial mask, no fold-back.
    // uCloudIntensity keeps its knob: 5 (shipped) = 1x, 0 = no clouds.
    float cov = clamp(smoothstep(0.35, 0.61, dens) * uCloudIntensity * 0.2, 0.0, 1.0);
    float covS = clamp(smoothstep(0.35, 0.61, densS) * uCloudIntensity * 0.2, 0.0, 1.0);
    // The only limb change is physical: the slant path through the layer.
    cov = 1.0 - pow(1.0 - cov, 1.0 / max(mu, 0.25));
    cloudA = cov * 0.9;

    // Ground under the clouds: shadows (sunlit side only), then the
    // atmosphere's own thin haze, thicker toward the limb.
    rgb *= 1.0 - covS * uCloudShadow * smoothstep(-0.05, 0.25, mu0) * uPhase;
    float hzLight = clamp((ndl + 0.2) / 1.2, 0.0, 1.0);
    float hz = (0.16 + 0.55 * (1.0 - mu) * (1.0 - mu)) * mix(1.0, clamp(hzLight * 1.5, 0.0, 1.0), uPhase);
    rgb = mix(rgb, vec3(0.10, 0.115, 0.15) * uBrightness * mix(1.0, hzLight, uPhase), hz);

    // Cloud colour: storm grey-blue troughs to pale tops, brushed by the
    // streaks; embossed by the density toward the sun; tops catch a warm
    // light at the terminator.
    float tone = clamp(clamp((dens - 0.43) / 0.35, 0.0, 1.0) * 0.75 + (streak - 0.5) * 0.7 + 0.12, 0.0, 1.0);
    vec3 ccol = mix(vec3(0.022, 0.027, 0.040), vec3(0.15, 0.155, 0.17), tone);
    float emb = clamp((dens - densS) * 3.0 + 0.8, 0.35, 1.3);
    float cLight = clamp((ndl + 0.12) / 1.12, 0.0, 1.0);
    vec3 dusk = mix(vec3(1.0, 0.78, 0.60), vec3(1.0), smoothstep(-0.05, 0.30, ndl));
    vec3 cl = mix(ccol * emb, ccol * (cLight * emb * dusk + amb * 0.8), uPhase) * uBrightness;
    rgb = mix(rgb, cl, cloudA);

    // -- Alien-city lights ------------------------------------------------
    // Same lights, same sparkle and pulse as MOON_FRAG, but each one is a
    // point on the sphere: it follows the libration, hides over the limb,
    // and on the night side its core brightens and its glow tightens
    // (a dark disc cannot hide a wide halo the way the old lit one did).
    vec3 neon = vec3(0.18, 1.05, 0.42);
    float tm = uTime;
    float sparkle =
        0.55
      + 0.30 * sin(tm * 3.17)
      + 0.20 * sin(tm * 7.71 + 1.1)
      + 0.18 * sin(tm * 13.9 + 0.4)
      + 0.18 * (mvnoise(vec2(tm * 4.0, 0.7)) - 0.5)
      + 0.22 * (mhash21(floor(uv * 90.0) + floor(tm * 6.0)) - 0.5);
    sparkle = clamp(sparkle, 0.25, 1.6);
    vec3 cityV = mLightView(uCityPos);
    float cityNight = 1.0 - smoothstep(-0.08, 0.22, dot(cityV, S));
    float cityVis = smoothstep(0.0, 0.1, cityV.z);
    float citySharp = mix(1.0, 2.2, cityNight * uPhase);
    float cityDist = distance(uv, 0.5 + cityV.xy * MOON_R_UV);
    float core = exp(-cityDist * 28.0 * citySharp);
    float halo = exp(-cityDist * 9.0 * citySharp) * 0.35;
    float gCore = mix(1.0, mix(0.8, 1.5, cityNight), uPhase) * cityVis;
    float gHalo = mix(1.0, mix(0.8, 0.30, cityNight), uPhase) * cityVis;
    vec3 mainEmission = neon * (core * 2.6 * gCore + halo * gHalo) * sparkle * 0.20 * uCityIntensity;

    vec3 microEmission = vec3(0.0);
    for (int i = 0; i < NUM_MICRO_LIGHTS; i++) {
      vec4 ml = uMicroLights[i];
      if (ml.z <= 0.0) continue;
      vec3 mlV = mLightView(ml.xy);
      float mlNight = 1.0 - smoothstep(-0.08, 0.22, dot(mlV, S));
      float mlSharp = mix(1.0, 1.6, mlNight * uPhase);
      float mlDist = distance(uv, 0.5 + mlV.xy * MOON_R_UV);
      float mlCore = exp(-mlDist * 80.0 * mlSharp);
      float mlHalo = exp(-mlDist * 22.0 * mlSharp) * 0.30;
      // Phase from the light's TEXTURE position, so it is stable under
      // libration (the screen position moves).
      float mlPhase = mhash21(ml.xy * 31.7) * 6.2831853;
      float mlPulse = 0.45 + 0.55 * sin(tm * 6.2831853 / max(ml.w, 0.1) + mlPhase);
      float mlTwinkle = 0.80 + 0.30 * sin(tm * 11.0 + mlPhase * 2.1);
      float mlScale = ml.z * mlPulse * mlTwinkle * uCityIntensity * smoothstep(0.0, 0.1, mlV.z);
      float gc = mix(1.0, mix(0.8, 1.6, mlNight), uPhase);
      float gh = mix(1.0, mix(0.8, 0.45, mlNight), uPhase);
      microEmission += neon * (mlCore * 1.4 * gc + mlHalo * gh) * mlScale;
    }
    vec3 em = mainEmission + microEmission;
    // Clouds veil the lights (they shine through the gaps) and the city
    // faintly lights the cloud undersides on the night side.
    rgb += em * (1.0 - 0.6 * cloudA)
         + neon * (exp(-cityDist * 9.0) * cityNight * cityVis * uPhase * cloudA * 0.004 * uCityIntensity);
    emissionOut = em * smoothstep(1.0 - aa, 1.0, r) * (1.0 - smoothstep(1.0, 1.12, r));

    // -- Atmosphere rim (fresnel) -------------------------------------------
    // Lit a little past the terminator; when the sun is behind the moon the
    // whole limb lights up (forward scattering).
    float fres = pow(1.0 - mu, 3.0);
    float rimLit = mix(1.0, smoothstep(-0.30, 0.55, ndl) + 0.8 * pow(max(-S.z, 0.0), 3.0), uPhase);
    rgb += uRimColor * (fres * rimLit * uRim * 0.35 * uBrightness);
  }

  // -- Disc edge + halo -------------------------------------------------------
  float edge = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  vec2 cdir = c / max(r, 1.0e-4);
  float litSide = mix(0.75, 0.5 + 0.5 * dot(cdir, S.xy), uPhase);
  float illum = mix(1.0, 0.5 * (1.0 + S.z), uPhase); // lit fraction
  float dr = max(r - 1.0, 0.0);
  // Alb'arel: a thin bright atmosphere ring + a soft glow, both strongest on
  // the lit limb. Rez'arel: only a faint aureole in the moon's own colour.
  float haloI = uHasClouds > 0.5
      ? (exp(-dr / 0.022) * 0.42 + exp(-dr / 0.10) * 0.14) * (litSide * litSide * 0.8 + 0.2)
      : exp(-dr / 0.10) * 0.045 * (litSide * 0.6 + 0.4);
  haloI *= smoothstep(1.0 - aa, 1.0, r) * (1.0 - smoothstep(rMax - 0.12, rMax, r));
  haloI *= uHalo * (0.3 + 0.7 * illum) * uNight;
  vec3 Lh = uHaloColor * (haloI * uBrightness * 0.25) + emissionOut;

  // -- Alpha ------------------------------------------------------------------
  // Night: the whole disc is opaque (the dark side hides the stars). Day:
  // the unlit part lets the sky through, as a daytime moon does.
  float litness = max(smoothstep(-0.05, 0.25, ndl), cloudA * clamp((ndl + 0.12) * 2.0, 0.0, 1.0));
  float aDisc = edge * mix(1.0, mix(0.18, 1.0, litness), (1.0 - uNight) * uPhase);
  // Halo / glow are added light: output L / a over coverage a, which the
  // normal blend turns into dst + L (less a little of dst).
  float aHalo = clamp(max(Lh.r, max(Lh.g, Lh.b)) * 4.0, 0.0, 0.6);
  float ao = 1.0 - (1.0 - aDisc) * (1.0 - aHalo);
  if (ao < 0.002) discard;

  // -- Horizon: extinction (reddening) + contrast loss, per fragment ----------
  // Kasten-Young airmass at this fragment's own altitude, so a rising moon
  // is redder at its bottom edge. Clamped at -1 deg (the formula's range).
  float altC = max(uMoonAlt + c.y * uAngRadius, -0.0175);
  float airmass = 1.0 / (sin(altC) + 0.50572 * pow(max(degrees(altC) + 6.07995, 0.5), -1.6364));
  vec3 ext = exp(-uExtinctionK * ((max(airmass, 1.0) - 1.0) * uHorizon));
  // Contrast loss starts past airmass 2 (below ~30 deg), at most 30%.
  float veil = clamp((airmass - 2.0) / 40.0, 0.0, 0.30) * min(uHorizon, 1.0);
  rgb = mix(rgb, vec3(0.060, 0.048, 0.036) * uBrightness * illum, veil);

  vec3 o = (rgb * aDisc + Lh * (1.0 - aDisc)) / ao;
  gl_FragColor = vec4(o * ext, ao);
}
`;

// Scratch for the per-frame FX update (never allocate in tick).
const _fxQInv = new THREE.Quaternion();
const _fxSunWorld = new THREE.Vector3();
const _fxFlow = { tA: 0, tB: 0, wA: 1, seedA: 0, seedB: 0, rot: 0 };
const _fxLib = { yaw: 0, pitch: 0 };

/**
 * `?moonFx` — DEFAULT ON. `off` / `0` / `false` / `no` restore the pre-FX
 * moons exactly (MOON_FRAG, the legacy quad size, no FX uniform writes).
 *
 * @param {string} [search] test seam; defaults to window.location.search
 * @returns {boolean}
 */
export function moonFxEnabled(search) {
  try {
    const s = typeof search === 'string' ? search
      : (typeof window !== 'undefined' && window.location ? window.location.search : '');
    const v = new URLSearchParams(s).get('moonFx');
    if (v == null) return true;
    const t = String(v).trim().toLowerCase();
    return !(t === 'off' || t === '0' || t === 'false' || t === 'no');
  } catch (_) {
    return true;
  }
}

/**
 * `?moonPhase=<0..1>` — initial phase strength (1 = lit by the sky's sun,
 * 0 = the painted lighting). Garbage / absent → the default.
 *
 * @param {string} [search] test seam; defaults to window.location.search
 * @returns {number}
 */
export function moonPhaseFlag(search) {
  try {
    const s = typeof search === 'string' ? search
      : (typeof window !== 'undefined' && window.location ? window.location.search : '');
    const raw = new URLSearchParams(s).get('moonPhase');
    if (raw == null || raw.trim() === '') return MOON_FX_DEFAULTS.phase;
    const v = Number(raw);
    if (!Number.isFinite(v)) return MOON_FX_DEFAULTS.phase;
    return Math.min(1, Math.max(0, v));
  } catch (_) {
    return MOON_FX_DEFAULTS.phase;
  }
}

/**
 * Sun direction (unit, three world) → a moon billboard's own frame (+x
 * right, +y up, +z toward the viewer). The billboard is parented to the sky
 * scene root, so its quaternion is its world rotation.
 *
 * @param {THREE.Vector3} sunWorld
 * @param {THREE.Quaternion} moonQuaternion
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} out
 */
export function moonSunLocal(sunWorld, moonQuaternion, out) {
  _fxQInv.copy(moonQuaternion).invert();
  return out.copy(sunWorld).applyQuaternion(_fxQInv).normalize();
}

/**
 * Phase seen from the viewer for a billboard-frame sun: the phase angle
 * (sun-moon-viewer, 0 = full, 180 = new) and the illuminated fraction of the
 * disc.
 *
 * @param {{x:number,y:number,z:number}} sunLocal
 * @returns {{phaseAngleDeg:number, illuminatedFraction:number}}
 */
export function moonPhaseInfo(sunLocal) {
  const len = Math.hypot(sunLocal.x, sunLocal.y, sunLocal.z) || 1;
  const z = Math.max(-1, Math.min(1, sunLocal.z / len));
  return {
    phaseAngleDeg: (Math.acos(z) * 180) / Math.PI,
    illuminatedFraction: 0.5 * (1 + z),
  };
}

/**
 * Alb'arel's cloud flow state at flow-clock `clockSec` (seconds at the
 * reference speed). Two phases, half a period apart: each shears its field
 * for MOON_CLOUD_FLOW_PERIOD_S with a local time in [-P/2, P/2), weighted
 * by a triangle that is exactly 0 when that phase resets (and its seed
 * changes), so the resets are invisible. wA + wB = 1. The rigid rotation is
 * wrapped to [0, 2pi) — a full turn is the identity, so the wrap is seamless.
 * Every value handed to the shader stays bounded however long the clock runs.
 *
 * @param {number} clockSec
 * @param {object} [out]
 * @returns {{tA:number,tB:number,wA:number,seedA:number,seedB:number,rot:number}}
 */
export function moonCloudFlow(clockSec, out = {}) {
  const P = MOON_CLOUD_FLOW_PERIOD_S;
  const t = Number.isFinite(clockSec) ? clockSec : 0;
  const ph = t / P;
  const phB = ph + 0.5;
  const fA = ph - Math.floor(ph);
  const fB = phB - Math.floor(phB);
  out.tA = (fA - 0.5) * P;
  out.tB = (fB - 0.5) * P;
  out.wA = 1 - Math.abs(2 * fA - 1);
  const n = MOON_CLOUD_SEEDS;
  out.seedA = ((Math.floor(ph) % n) + n) % n;
  out.seedB = ((Math.floor(phB) % n) + n) % n;
  const TAU = Math.PI * 2;
  const rot = (t * MOON_CLOUD_ROT_RATE) % TAU;
  out.rot = rot < 0 ? rot + TAU : rot;
  return out;
}

/**
 * Libration angles (radians) at orbit time `orbitMs`: a slow Lissajous
 * wobble, yaw amplitude `amplitudeDeg`, pitch half of it.
 *
 * @param {number} orbitMs
 * @param {number} amplitudeDeg
 * @param {number[]} periodsMs [yaw, pitch]
 * @param {number[]} phases [yaw, pitch] offsets, rad
 * @param {object} [out]
 * @returns {{yaw:number,pitch:number}}
 */
export function moonLibration(orbitMs, amplitudeDeg, periodsMs, phases, out = {}) {
  const a = (Math.max(0, +amplitudeDeg || 0) * Math.PI) / 180;
  const t = Number.isFinite(orbitMs) ? orbitMs : 0;
  const TAU = Math.PI * 2;
  out.yaw = a * Math.sin((TAU * (t % periodsMs[0])) / periodsMs[0] + phases[0]);
  out.pitch = 0.5 * a * Math.sin((TAU * (t % periodsMs[1])) / periodsMs[1] + phases[1]);
  return out;
}

/**
 * The view → body rotation the shader's uLib applies: yaw about +y, then
 * pitch about +x (body = Rx(pitch) * Ry(yaw) * view). Orthonormal, so the
 * shader's inverse (body → view, the city lights) is the transpose.
 *
 * @param {number} yaw
 * @param {number} pitch
 * @param {THREE.Matrix3} out
 * @returns {THREE.Matrix3} out
 */
export function moonLibrationMatrix(yaw, pitch, out) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return out.set(
    cy, 0, sy,
    sp * sy, cp, -sp * cy,
    -cp * sy, sp, cp * cy,
  );
}

/**
 * JS mirror of the shader's horizon airmass (Kasten & Young 1989), clamped
 * at -1 deg like the shader. 1 at the zenith, ~38 on the horizon.
 *
 * @param {number} altRad
 * @returns {number}
 */
export function moonAirmass(altRad) {
  const a = Math.max(Number.isFinite(altRad) ? altRad : 0, -0.0175);
  const deg = (a * 180) / Math.PI;
  return 1 / (Math.sin(a) + 0.50572 * Math.pow(Math.max(deg + 6.07995, 0.5), -1.6364));
}

export class ACMoons {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.fx] MOON FX on/off; default `?moonFx` (ON).
   *   Captured once — it picks the shader + quad size at load().
   * @param {number} [opts.phase] initial phase strength; default `?moonPhase`.
   */
  constructor(opts = {}) {
    this.albMesh = null;
    this.rezMesh = null;
    this._inSkyScene = null;
    this._startMs =
      (typeof performance !== 'undefined' && performance.now) ?
        performance.now() :
        Date.now();
    this._speedMul = 1;
    // Read `?moonSpeed=N` URL param if present.
    try {
      // eslint-disable-next-line no-undef
      const sp = new URLSearchParams(window.location.search).get('moonSpeed');
      const v = parseFloat(sp ?? '');
      if (Number.isFinite(v) && v > 0) this._speedMul = v;
    } catch (_) { /* default 1 */ }

    // === Wave R4.b — sky-object live luminosity (2026-05-29) =============
    // Retail dims sky objects toward dawn — the moon fades as the sun rises
    // (acclient.c:303122-303128, linear `(next - prev) * ratio + prev` lerp
    // of each object's luminosity between time-of-day keyframes). The moon
    // billboards here render at a FIXED uBrightness (2.0) regardless of
    // time-of-day. Flag `?skyObjLum` — **DEFAULT-ON**, opt-out via
    // `?skyObjLum=off`: the reader below is `sp !== 'off'`, so it returns false
    // ONLY for the literal "off"; any other value, an absent param, and the
    // no-window case are all ON. (2026-08-03: this block used to open "default
    // OFF → byte-identical: the base uBrightness uniform is never re-scaled" —
    // stale since the 2026-06-09 render-audit T1d flip and contradicted three
    // lines later. Same stale pair as the twin block in atmosphere_sky.js.)
    // When on, tick() multiplies each moon's uBrightness by a sun-altitude
    // factor that ramps from 1.0 at night down to a small daytime floor as the
    // sun climbs. The flag is captured ONCE here and consumed via
    // `this._skyObjLum` in tick() — same `this` scope, so no split-declaration
    // ReferenceError.
    // ⚠ Still awaiting its 1070 GPU eye-test — default-ON is the SHIPPED state,
    // not a validated one.
    this._skyObjLum = true;
    try {
      // eslint-disable-next-line no-undef
      const sp = new URLSearchParams(window.location.search).get('skyObjLum');
      this._skyObjLum = sp !== 'off';
    } catch (_) { /* no window → default ON */ }
    // Base uBrightness the meshes are constructed with (mirrors the
    // ShaderMaterial default 2.0); the modulation scales relative to it.
    this._moonBaseBrightness = 2.0;

    // MOON FX (2026-10-11, `?moonFx`, default ON) — see the file header.
    this._fx = typeof opts.fx === 'boolean' ? opts.fx : moonFxEnabled();
    this._fxPhase = Number.isFinite(opts.phase)
      ? Math.min(1, Math.max(0, opts.phase))
      : moonPhaseFlag();
    this._libDeg = MOON_FX_DEFAULTS.libDeg;
    // Flow clock (seconds at the reference cloud speed) + the last tick time
    // it was integrated at.
    this._cloudClock = 0;
    this._fxLastMs = null;
    // What the moons were last lit with (window.__moonFxState()).
    this._fxSunValid = false;
    this._fxNight = 1;
  }

  /**
   * Wave R4.b — moon brightness factor from sun altitude. Returns 1.0 at
   * night (full brightness) ramping linearly down to `MOON_DAY_FLOOR` once
   * the sun has climbed past the dawn band — the moon dims but doesn't fully
   * vanish (it stays faintly visible in AC's daytime sky). `dirPitch` is the
   * AC sun pitch in DEGREES (positive = above horizon); `sin(dirPitch)` is
   * the sun-altitude component. Mirrors the acclient per-keyframe linear
   * lerp intent.
   *
   * @param {Object} state — SkyState snapshot with `dirPitch` (deg)
   * @returns {number} brightness factor in [MOON_DAY_FLOOR, 1]
   */
  static moonBrightnessFactorFromSunAltitude(state) {
    const MOON_DAY_FLOOR = 0.35;
    const authored = +(state && state.dirPitch);
    if (!Number.isFinite(authored)) return 1.0;
    const pitchDeg = artSunPitchDeg(authored);
    const sunAlt = Math.sin(pitchDeg * Math.PI / 180);
    // Same dawn/dusk band as the star fade: +0.10 (full day) .. -0.10
    // (full night). nightFrac=1 at night, 0 by day.
    const SUN_DAY = 0.10;
    const SUN_NIGHT = -0.10;
    const t = (sunAlt - SUN_NIGHT) / (SUN_DAY - SUN_NIGHT);
    const nightFrac = 1.0 - Math.min(1.0, Math.max(0.0, t));
    return MOON_DAY_FLOOR + (1.0 - MOON_DAY_FLOOR) * nightFrac;
  }

  /**
   * Async-load both moon textures and build the billboard meshes.
   * Returns the instance for chaining.
   *
   * @param {string} [baseHref] Override the default
   *   `import.meta.url`-relative asset URL. Useful if you want to
   *   serve the textures from a different origin (CDN, etc.) than
   *   the module itself.
   */
  async load(baseHref) {
    const loader = new THREE.TextureLoader();
    const base = baseHref
      ? baseHref
      : new URL('./assets/moons/', import.meta.url).toString();
    const albUrl = base + 'albarel.png';
    const rezUrl = base + 'rezarel.png';
    // eslint-disable-next-line no-console
    console.log(`[ac-moons] loading textures: ${albUrl} ${rezUrl}`);
    const [albTex, rezTex] = await Promise.all([
      loader.loadAsync(albUrl),
      loader.loadAsync(rezUrl),
    ]);
    if (THREE.SRGBColorSpace) {
      albTex.colorSpace = THREE.SRGBColorSpace;
      rezTex.colorSpace = THREE.SRGBColorSpace;
    }
    // 1024x1024 sources — bump filter quality so the disc edge is
    // crisp at the angular sizes we render. Aniso 8 is supported by
    // every desktop GPU; the texture loader doesn't auto-set it.
    for (const t of [albTex, rezTex]) {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = 8;
      t.generateMipmaps = true;
      t.needsUpdate = true;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[ac-moons] textures decoded: ` +
        `alb=${albTex.image?.width}x${albTex.image?.height} ` +
        `rez=${rezTex.image?.width}x${rezTex.image?.height}`,
    );
    this.albMesh = this._buildMoonMesh(albTex, ALB_ANGULAR_RADIUS, true);
    this.rezMesh = this._buildMoonMesh(rezTex, REZ_ANGULAR_RADIUS, false);
    return this;
  }

  _buildMoonMesh(texture, angularRadius, hasClouds) {
    // Diameter on the sky shell = 2 * R * tan(half-angle), but for
    // small angles tan(θ) ≈ θ; using θ directly is fine here.
    // MOON FX: the quad grows by MOON_FX_QUAD_SCALE (room for the halo);
    // the shader scales its UVs back, so the disc keeps its size.
    const fx = this._fx;
    const size = 2 * SKY_RADIUS * angularRadius * (fx ? MOON_FX_QUAD_SCALE : 1);
    const geo = new THREE.PlaneGeometry(size, size);
    // Build the 15-light Hagol micro-array. Alb'arel uses the real
    // layout; Rez'arel passes zero-brightness entries so the shader
    // loop is a no-op (the uniform must still be bound — WebGL
    // doesn't allow leaving array uniforms unbound).
    const microLights = hasClouds
      ? ACMoons._buildHagolLayout()
      : ACMoons._zeroMicroLights();
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uBrightness: { value: 2.0 },
        uTime: { value: 0.0 },
        uHasClouds: { value: hasClouds ? 1.0 : 0.0 },
        // Defaults tuned 2026-05-18 round 2: heavier cloud
        // coverage, slower drift (ominous read), grey-blue tint
        // baked in the shader.
        uCloudIntensity: { value: 5.0 },
        // Drift halved 2026-05-18 round 4 (was 0.45) — user
        // wanted the cloud's motion across the sky slower.
        uCloudSpeed: { value: 0.22 },
        // uCityIntensity stays at 1.0 as a "scale everything"
        // knob. The main hotspot's -80% reduction is baked into
        // the shader (×0.20 multiplier) so it survives a knob
        // change; micro-lights carry their own per-light
        // brightness (0.05–0.10) in the uMicroLights array.
        uCityIntensity: { value: 1.0 },
        // City light cluster sits at the LEFT of Alb'arel's disc.
        // Sampled from the 1024x1024 source: green dots cluster at
        // ~(0.13, 0.49) UV. Devtools setter exposed below.
        uCityPos: { value: new THREE.Vector2(0.13, 0.49) },
        uMicroLights: { value: microLights },
        // Rez'arel: scintillation + warm/cool tints on. Alb'arel
        // skips this path — its atmosphere is the main visual
        // story and a second layer of bright-pixel modulation
        // would muddy the cloud band.
        uScintEnabled: { value: hasClouds ? 0.0 : 1.0 },
        uScintIntensity: { value: 0.85 },
        ...(fx ? this._fxUniforms(hasClouds ? MOON_FX_ALB : MOON_FX_REZ, angularRadius) : {}),
      },
      vertexShader: MOON_VERT,
      fragmentShader: fx ? MOON_FX_FRAG : MOON_FRAG,
      transparent: true,
      // Sky-pass material: no depth test needed because the world
      // pass that follows uses `clear=false, clearDepth=true` —
      // world geometry naturally overpaints us at world pixels
      // via the color buffer, and the cloud overlay (renderOrder
      // 999) composites OVER us at sky pixels.
      depthTest: false,
      depthWrite: false,
      // DoubleSide: harmless insurance. (2026-10-11, checked against
      // three r184 Object3D.lookAt: for a non-camera object it points
      // the mesh's +Z AT the target, so the camera sees the FRONT face,
      // +X is screen-right and +Y is toward the zenith — the frame the
      // MOON FX shader's "view" frame and moonSunLocal assume. An older
      // note here said the back face faced the camera; it does not.)
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Skip frustum culling — the mesh moves around the sky shell;
    // its bounding sphere doesn't track its position cheaply.
    mesh.frustumCulled = false;
    // Sky-pass render order: AFTER SkyMaterial (-1) and stars (-1)
    // so moons paint over sky background, BEFORE the cloud overlay
    // (999) so clouds composite over moons.
    mesh.renderOrder = 800;
    return mesh;
  }

  /**
   * Attach both moon meshes to skyDome.skyScene so they render in
   * the sky pass — between SkyMaterial / stars (renderOrder -1) and
   * the cloud overlay (renderOrder 999).
   *
   * Why this works despite skyScene having its own camera (skyCamera
   * positioned at the main camera each frame): tick() updates each
   * moon's WORLD position to `mainCamera.position + sky-direction
   * × SKY_RADIUS`. Since skyCamera is at mainCamera.position, the
   * moon's position relative to skyCamera is always the same offset
   * (camera-relative sky illusion). The earlier attempt with
   * absolute sky-shell coords failed because for a player at ~32k
   * world units (Holtburg), a moon at (2000, ...) is 45 km away,
   * past the 5000-unit far plane.
   */
  attachToSkyScene(skyScene) {
    if (!skyScene) return;
    if (this.albMesh) skyScene.add(this.albMesh);
    if (this.rezMesh) skyScene.add(this.rezMesh);
    this._inScene = skyScene;
  }

  detachFromSkyScene() {
    if (!this._inScene) return;
    if (this.albMesh) this._inScene.remove(this.albMesh);
    if (this.rezMesh) this._inScene.remove(this.rezMesh);
    this._inScene = null;
  }

  /**
   * Per-frame update — advances each moon's position along its
   * orbital arc. Call from the rAF tick after sky scene is set up.
   *
   * @param {number} [nowMs] Optional override of wall time; defaults
   *   to `performance.now()`. Useful for testing/capture.
   */
  tick(nowMs) {
    if (!this.albMesh || !this.rezMesh) return;
    // Look up the camera each tick via globals — avoids threading a
    // camera arg through every caller and self-heals if the active
    // camera changes mid-session (C-key cycle).
    const cam = (typeof window !== 'undefined') ?
      window.liveScene3d?.cameraSwitcher?.activeCamera : null;
    if (!cam || !cam.position) return;

    const t = (typeof nowMs === 'number' ? nowMs : performance.now()) -
      this._startMs;
    const ms = t * this._speedMul;
    // Shader time in seconds (drives cloud drift + city sparkle on
    // Alb'arel). Independent of speedMul — cloud animation should
    // run at wall-clock pace even when orbits are sped up for debug.
    const tSec = t * 0.001;
    if (this.albMesh?.material?.uniforms?.uTime) {
      this.albMesh.material.uniforms.uTime.value = tSec;
    }
    if (this.rezMesh?.material?.uniforms?.uTime) {
      this.rezMesh.material.uniforms.uTime.value = tSec;
    }

    // Wave R4.b — sky-object live luminosity (default OFF → no-op,
    // byte-identical). When `?skyObjLum=on`, dim the moons as the sun
    // rises. Read the shared SkyState snapshot from the same global the
    // camera lookup uses above (keeps the edit local to this file — no
    // loop.js/index.js plumbing change). Flag is the instance field
    // captured in the constructor (same `this` scope as here).
    if (this._skyObjLum) {
      // eslint-disable-next-line no-undef
      const skyState = (typeof window !== 'undefined')
        ? window.liveScene3d?.skyLightingController?._lastState
        : null;
      if (skyState) {
        const f = ACMoons.moonBrightnessFactorFromSunAltitude(skyState);
        const b = this._moonBaseBrightness * f;
        if (this.albMesh?.material?.uniforms?.uBrightness) {
          this.albMesh.material.uniforms.uBrightness.value = b;
        }
        if (this.rezMesh?.material?.uniforms?.uBrightness) {
          this.rezMesh.material.uniforms.uBrightness.value = b;
        }
      }
    }

    // Alb'arel — slower period, inclined ~30° to the horizon plane.
    const ang = (ms / ALB_PERIOD_MS) * Math.PI * 2;
    const az = ang;
    // alt oscillates -0.6..0.6 rad (~±34°) — visible above and below
    // the horizon over the orbital period.
    const alt = Math.sin(ang + 0.5) * 0.6;
    this._setMoonOnSphere(this.albMesh, az, alt, cam);

    // Rez'arel — faster period, steeper inclination, phase offset
    // so the two moons aren't usually overlapping on the sky.
    const ang2 = (ms / REZ_PERIOD_MS) * Math.PI * 2 + 2.1;
    const az2 = ang2;
    const alt2 = Math.sin(ang2 + 1.2) * 0.7;
    this._setMoonOnSphere(this.rezMesh, az2, alt2, cam);

    // MOON FX — after the placement above: the sun is expressed in each
    // billboard's freshly look-at'ed frame. `=off` never gets here.
    if (this._fx) this._tickFx(t, ms);
  }

  /**
   * MOON FX per-frame uniforms: the sky's sun in each moon's billboard
   * frame, the night factor, the disc altitude, the libration, and
   * Alb'arel's cloud-flow clock. Reads the same SkyState snapshot as the
   * skyObjLum block above; with no sky state yet each moon is lit from
   * the viewer (full phase), i.e. it looks like the art.
   *
   * @param {number} tMs wall ms since construction (cloud clock)
   * @param {number} orbitMs orbit ms (libration; scales with ?moonSpeed)
   */
  _tickFx(tMs, orbitMs) {
    // eslint-disable-next-line no-undef
    const skyState = (typeof window !== 'undefined')
      ? window.liveScene3d?.skyLightingController?._lastState
      : null;
    // (`+(null)` is 0, a perfectly finite heading — so test presence first.)
    const heading = skyState && skyState.dirHeading != null ? +skyState.dirHeading : NaN;
    const pitch = skyState && skyState.dirPitch != null ? +skyState.dirPitch : NaN;
    let haveSun = false;
    let night = 1.0;
    if (Number.isFinite(heading) && Number.isFinite(pitch)) {
      // The SKY's sun (night-ramped exactly as atmosphere_sky.js does it),
      // not the surface light's: the moons hang in that sky.
      const artPitch = artSunPitchDeg(pitch);
      sunDirFromHeadingPitch(heading, artPitch, _fxSunWorld);
      night = nightFactorFromArtPitch(artPitch);
      haveSun = true;
    }
    this._fxSunValid = haveSun;
    this._fxNight = night;

    // Cloud flow clock: integrate uCloudSpeed so a live speed change never
    // jumps the field. dt clamped so a backgrounded tab resumes smoothly.
    const albU = this.albMesh.material.uniforms;
    const dt = this._fxLastMs == null
      ? 0
      : Math.min(0.25, Math.max(0, (tMs - this._fxLastMs) * 0.001));
    this._fxLastMs = tMs;
    const speed = Math.max(0, +(albU.uCloudSpeed?.value) || 0);
    this._cloudClock += (dt * speed) / MOON_CLOUD_SPEED_REF;
    if (albU.uCloudFlow) {
      moonCloudFlow(this._cloudClock, _fxFlow);
      albU.uCloudFlow.value.set(_fxFlow.tA, _fxFlow.tB, _fxFlow.wA, _fxFlow.rot);
      albU.uCloudSeed.value.set(_fxFlow.seedA, _fxFlow.seedB);
    }

    this._tickFxMoon(this.albMesh, MOON_FX_ALB, orbitMs, haveSun, night);
    this._tickFxMoon(this.rezMesh, MOON_FX_REZ, orbitMs, haveSun, night);
  }

  _tickFxMoon(mesh, cfg, orbitMs, haveSun, night) {
    const u = mesh?.material?.uniforms;
    if (!u?.uSunLocal) return;
    if (haveSun) moonSunLocal(_fxSunWorld, mesh.quaternion, u.uSunLocal.value);
    else u.uSunLocal.value.set(0, 0, 1);
    u.uNight.value = night;
    const alt = mesh.userData.moonAltRad;
    u.uMoonAlt.value = Number.isFinite(alt) ? alt : 0.5;
    moonLibration(orbitMs, this._libDeg, cfg.libPeriodsMs, cfg.libPhase, _fxLib);
    moonLibrationMatrix(_fxLib.yaw, _fxLib.pitch, u.uLib.value);
  }

  /**
   * MOON FX uniforms for one moon (merged into the legacy set).
   * @param {object} cfg MOON_FX_ALB | MOON_FX_REZ
   * @param {number} angularRadius
   */
  _fxUniforms(cfg, angularRadius) {
    const D = MOON_FX_DEFAULTS;
    const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    return {
      uQuadScale: { value: MOON_FX_QUAD_SCALE },
      // Full phase until the first tick with a sky state.
      uSunLocal: { value: new THREE.Vector3(0, 0, 1) },
      uLib: { value: new THREE.Matrix3() },
      uNight: { value: 1.0 },
      uPhase: { value: this._fxPhase },
      uAmbient: { value: D.ambient },
      uRelief: { value: D.relief },
      uLunarL: { value: cfg.lunarL },
      uRim: { value: cfg.rim },
      uRimColor: { value: v3(cfg.rimColor) },
      uHalo: { value: D.halo },
      uHaloColor: { value: v3(cfg.haloColor) },
      uHorizon: { value: D.horizon },
      uExtinctionK: { value: v3(MOON_EXTINCTION_K) },
      uMoonAlt: { value: 0.5 },
      uAngRadius: { value: angularRadius },
      uBakedSun: {
        value: new THREE.Vector4(cfg.bakedSun[0], cfg.bakedSun[1], cfg.bakedSun[2], cfg.bakedNorm),
      },
      uBakedShape: { value: v3(cfg.bakedShape) },
      uCloudFlow: { value: new THREE.Vector4(0, -MOON_CLOUD_FLOW_PERIOD_S / 2, 0, 0) },
      uCloudSeed: { value: new THREE.Vector2(0, 0) },
      uCloudShadow: { value: D.cloudShadow },
    };
  }

  /**
   * Position the moon mesh at (azimuth, altitude) on a virtual sky
   * shell anchored to the camera. Computes:
   *
   *   moon_world = camera_world + offset
   *
   * where offset is the local sky-direction vector scaled to
   * SKY_RADIUS. This keeps the moon at a fixed apparent angular
   * position regardless of where the player walks — the classic
   * "sky at infinity" illusion done with finite distance.
   *
   * azimuth: 0 = three.js -Z (north); increases east-then-south-
   *   then-west (CW looking down from +Y).
   * altitude: -π/2 (nadir) .. +π/2 (zenith). 0 is on the horizon.
   */
  _setMoonOnSphere(mesh, azimuthRad, altitudeRad, camera) {
    const ca = Math.cos(altitudeRad);
    const lx = SKY_RADIUS * ca * Math.sin(azimuthRad);
    const ly = SKY_RADIUS * Math.sin(altitudeRad);
    const lz = -SKY_RADIUS * ca * Math.cos(azimuthRad);
    mesh.position.set(
      camera.position.x + lx,
      camera.position.y + ly,
      camera.position.z + lz,
    );
    // MOON FX reads the disc altitude for its horizon extinction.
    mesh.userData.moonAltRad = altitudeRad;
    // Billboard — always face the camera.
    mesh.lookAt(camera.position);
  }

  dispose() {
    this.detachFromSkyScene();
    const meshes = [this.albMesh, this.rezMesh];
    for (const m of meshes) {
      if (!m) continue;
      m.geometry?.dispose?.();
      m.material?.uniforms?.map?.value?.dispose?.();
      m.material?.dispose?.();
    }
    this.albMesh = null;
    this.rezMesh = null;
  }

  /**
   * Build the 15-light Hagol (Younger Futhark Hagall ᚼ) micro-light
   * layout for Alb'arel's alien city. 3 lines crossing at a center
   * below the main hotspot → 6 spokes, 60° apart. Each spoke has a
   * mid-ring + outer-ring light. 2 off-axis accents add organic
   * asymmetry. All UVs are below 0.49 (the user-requested cap so
   * nothing exceeds the existing main light's height) AND inside
   * the moon disc radius (0.46 from disc center).
   *
   * vec4 layout: (uv.x, uv.y, brightness, pulsePeriodSec).
   */
  static _buildHagolLayout() {
    const cx = 0.165;
    const cy = 0.36;
    const rMid = 0.045;
    const rOut = 0.085;
    const lights = [];
    // Center — slightly brighter than the ring lights, medium pulse.
    lights.push(new THREE.Vector4(cx, cy, 0.10, 25.0));
    // 6 spokes × 2 lights (mid ring + outer ring).
    // Periods are 5× the original tune (user feedback round 3:
    // "500% slower pulse"). Spans 9 s up to a full minute on the
    // outermost slow throb.
    const angles = [30, 90, 150, 210, 270, 330];
    const midPeriods = [9.0, 12.0, 15.5, 20.0, 27.5, 36.0];
    const outPeriods = [10.0, 16.5, 22.5, 30.0, 40.0, 60.0];
    for (let i = 0; i < 6; i += 1) {
      const a = (angles[i] * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      lights.push(
        new THREE.Vector4(cx + rMid * cos, cy + rMid * sin, 0.075, midPeriods[i]),
      );
      lights.push(
        new THREE.Vector4(cx + rOut * cos, cy + rOut * sin, 0.070, outPeriods[i]),
      );
    }
    // 2 asymmetry accents off the main axes (one upper-left toward
    // the gap between main light and the 150° spoke, one lower-right
    // outside the 330° spoke). Keeps the cluster from looking too
    // mechanical.
    lights.push(new THREE.Vector4(0.075, 0.43, 0.06, 45.0));
    lights.push(new THREE.Vector4(0.220, 0.30, 0.06, 18.5));
    return lights;
  }

  /**
   * Zero-brightness placeholder array — same length as the real
   * layout. Used for Rez'arel (and any future cloud-less moon) so
   * the uMicroLights uniform has a bound value but the shader loop
   * contributes nothing.
   */
  static _zeroMicroLights() {
    const out = [];
    for (let i = 0; i < ALB_NUM_MICRO_LIGHTS; i += 1) {
      out.push(new THREE.Vector4(0, 0, 0, 1));
    }
    return out;
  }
}

// Devtools setters for Alb'arel's cloud + city-light knobs. The
// material uniforms are also reachable via
// `liveScene3d.acMoons.albMesh.material.uniforms.<name>.value` but
// these mirror the pattern used by the cloud overlay / atmosphere
// stack so they're discoverable from the console.
if (typeof window !== 'undefined') {
  const albUniforms = () =>
    // eslint-disable-next-line no-undef
    window.liveScene3d?.acMoons?.albMesh?.material?.uniforms ?? null;
  // eslint-disable-next-line no-undef
  window.__setMoonCloudIntensity = (v) => {
    const u = albUniforms();
    if (!u?.uCloudIntensity) return null;
    u.uCloudIntensity.value = Math.max(0, +v);
    return u.uCloudIntensity.value;
  };
  // eslint-disable-next-line no-undef
  window.__setMoonCloudSpeed = (v) => {
    const u = albUniforms();
    if (!u?.uCloudSpeed) return null;
    u.uCloudSpeed.value = Math.max(0, +v);
    return u.uCloudSpeed.value;
  };
  // eslint-disable-next-line no-undef
  window.__setMoonCityIntensity = (v) => {
    const u = albUniforms();
    if (!u?.uCityIntensity) return null;
    u.uCityIntensity.value = Math.max(0, +v);
    return u.uCityIntensity.value;
  };
  // eslint-disable-next-line no-undef
  window.__setMoonCityPos = (x, y) => {
    const u = albUniforms();
    if (!u?.uCityPos?.value?.set) return null;
    u.uCityPos.value.set(+x, +y);
    return [u.uCityPos.value.x, u.uCityPos.value.y];
  };
  // Rez'arel scintillation intensity.
  const rezUniforms = () =>
    // eslint-disable-next-line no-undef
    window.liveScene3d?.acMoons?.rezMesh?.material?.uniforms ?? null;
  // eslint-disable-next-line no-undef
  window.__setMoonScintIntensity = (v) => {
    const u = rezUniforms();
    if (!u?.uScintIntensity) return null;
    u.uScintIntensity.value = Math.max(0, +v);
    return u.uScintIntensity.value;
  };

  // MOON FX knobs (2026-10-11). Same shape as the setters above: clamp, apply,
  // return the applied value — or null when the uniform is absent (FX off via
  // `?moonFx=off`, or the textures not loaded yet). Knobs that exist on both
  // moons set both; rim + cloud shadow are Alb'arel-only.
  const fxSetter = (name, lo, hi, which) => (v) => {
    const targets = which === 'alb' ? [albUniforms()] : [albUniforms(), rezUniforms()];
    let out = null;
    for (const u of targets) {
      if (!u?.[name]) continue;
      u[name].value = Math.min(hi, Math.max(lo, +v || 0));
      out = u[name].value;
    }
    return out;
  };
  // 1 = lit by the sky's sun (true phase), 0 = the art's painted lighting.
  // eslint-disable-next-line no-undef
  window.__setMoonPhase = fxSetter('uPhase', 0, 1);
  // Night-side floor (earthshine). Default 0.01.
  // eslint-disable-next-line no-undef
  window.__setMoonAmbient = fxSetter('uAmbient', 0, 1);
  // Crater / canyon relief from texture luminance. Default 1.
  // eslint-disable-next-line no-undef
  window.__setMoonRelief = fxSetter('uRelief', 0, 4);
  // Halo outside the disc (night only). Default 1.
  // eslint-disable-next-line no-undef
  window.__setMoonHalo = fxSetter('uHalo', 0, 4);
  // Horizon reddening + contrast loss. Default 1; 0 = off.
  // eslint-disable-next-line no-undef
  window.__setMoonHorizon = fxSetter('uHorizon', 0, 4);
  // Alb'arel atmosphere rim. Default 1.
  // eslint-disable-next-line no-undef
  window.__setMoonRim = fxSetter('uRim', 0, 4, 'alb');
  // Alb'arel cloud shadows on the ground. Default 0.6.
  // eslint-disable-next-line no-undef
  window.__setMoonCloudShadow = fxSetter('uCloudShadow', 0, 1, 'alb');
  // Libration amplitude in degrees (both moons). Default 6; 0 = still.
  // eslint-disable-next-line no-undef
  window.__setMoonLibration = (deg) => {
    // eslint-disable-next-line no-undef
    const m = window.liveScene3d?.acMoons;
    if (!m || !m._fx) return null;
    m._libDeg = Math.min(30, Math.max(0, +deg || 0));
    return m._libDeg;
  };
  // What the moons are lit with right now (eye-test aid): sun in each
  // billboard frame, phase angle, lit fraction, disc altitude, night factor.
  // eslint-disable-next-line no-undef
  window.__moonFxState = () => {
    // eslint-disable-next-line no-undef
    const m = window.liveScene3d?.acMoons;
    if (!m) return { enabled: null, loaded: false };
    const one = (mesh) => {
      const u = mesh?.material?.uniforms;
      if (!u?.uSunLocal) return null;
      const s = u.uSunLocal.value;
      const p = moonPhaseInfo(s);
      return {
        sunLocal: [+s.x.toFixed(4), +s.y.toFixed(4), +s.z.toFixed(4)],
        phaseAngleDeg: +p.phaseAngleDeg.toFixed(1),
        illuminatedFraction: +p.illuminatedFraction.toFixed(3),
        altDeg: +((u.uMoonAlt.value * 180) / Math.PI).toFixed(1),
        airmass: +moonAirmass(u.uMoonAlt.value).toFixed(2),
        phase: u.uPhase.value,
      };
    };
    return {
      enabled: !!m._fx,
      loaded: !!(m.albMesh && m.rezMesh),
      sunValid: !!m._fxSunValid,
      night: m._fxNight,
      librationDeg: m._libDeg,
      cloudClockSec: +(m._cloudClock || 0).toFixed(1),
      alb: one(m.albMesh),
      rez: one(m.rezMesh),
    };
  };
}

// Shader sources, exported for the node test (tests/ac_moons_fx.test.mjs pins
// MOON_FRAG byte-for-byte to the pre-FX source) and the GPU smoke.
export { MOON_FRAG, MOON_FX_FRAG, MOON_FX_QUAD_SCALE, MOON_FX_DEFAULTS, MOON_CLOUD_FLOW_PERIOD_S, MOON_CLOUD_SPEED_REF };
