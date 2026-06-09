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

import * as THREE from 'three';

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

export class ACMoons {
  constructor() {
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
    // time-of-day. Flag `?skyObjLum=on` (default OFF → byte-identical: the
    // base uBrightness uniform is never re-scaled) makes tick() multiply
    // each moon's uBrightness by a sun-altitude factor that ramps from 1.0
    // at night down to a small daytime floor as the sun climbs. The flag is
    // captured ONCE here and consumed via `this._skyObjLum` in tick() — same
    // `this` scope, so no split-declaration ReferenceError.
    // render-audit T1d (skyObjLum): default-ON, opt-out via `?skyObjLum=off`.
    // Returns false only when the value is exactly "off"; any other value
    // (incl. absent param) and the no-window case default to ON. Pending
    // 1070 GPU eye-test before this becomes the committed default.
    this._skyObjLum = true;
    try {
      // eslint-disable-next-line no-undef
      const sp = new URLSearchParams(window.location.search).get('skyObjLum');
      this._skyObjLum = sp !== 'off';
    } catch (_) { /* no window → default ON */ }
    // Base uBrightness the meshes are constructed with (mirrors the
    // ShaderMaterial default 2.0); the modulation scales relative to it.
    this._moonBaseBrightness = 2.0;
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
    const pitchDeg = +(state && state.dirPitch);
    if (!Number.isFinite(pitchDeg)) return 1.0;
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
    const size = 2 * SKY_RADIUS * angularRadius;
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
      },
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      transparent: true,
      // Sky-pass material: no depth test needed because the world
      // pass that follows uses `clear=false, clearDepth=true` —
      // world geometry naturally overpaints us at world pixels
      // via the color buffer, and the cloud overlay (renderOrder
      // 999) composites OVER us at sky pixels.
      depthTest: false,
      depthWrite: false,
      // DoubleSide: PlaneGeometry's front face is +Z, but `lookAt`
      // orients the plane so its -Z points at the camera — i.e. the
      // back face is what we see. FrontSide (default) would render
      // nothing. DoubleSide makes the texture visible regardless of
      // which face the camera is looking at.
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
}
