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

  if (uHasClouds > 0.5) {
    // -- Cloud swirl ----------------------------------------------
    // Domain-warped fbm to mimic the prior albarel JPEG's storm
    // pattern (a hurricane-like band wrapping the upper part of the
    // disc). Two-rate drift so the cloud appears to slowly evolve.
    float tSlow = uTime * 0.018 * uCloudSpeed;
    vec2 cloudUv = vUv * 3.2;
    float warpX = mvnoise(cloudUv * 0.55 + vec2(tSlow, 0.0)) - 0.5;
    float warpY = mvnoise(cloudUv * 0.55 + vec2(17.0, tSlow)) - 0.5;
    vec2 warped = cloudUv + vec2(warpX, warpY) * 1.3;
    float cloud = mfbm(warped + vec2(tSlow * 0.5, 0.0));
    // Upper-band bias matches where the prior cloud streak sat.
    float upBias = smoothstep(0.35, 0.85, vUv.y);
    // Keep the cloud inside the surface disc (no painting off-moon).
    float discMask = 1.0 - smoothstep(0.30, 0.46, d);
    float cloudAmt = pow(cloud, 1.6) * upBias * discMask;
    cloudAmt = clamp(cloudAmt * 1.8 - 0.25, 0.0, 1.0);
    vec3 cloudCol = vec3(0.88, 0.84, 0.78);
    rgb = mix(rgb, cloudCol, cloudAmt * uCloudIntensity);

    // -- Alien-city emission --------------------------------------
    // Hotspot at uCityPos (Alb'arel left side by default). Two
    // exponential falloffs: tight core + soft wide halo. Halo is
    // allowed to extend beyond the surface disc up to d=0.50 so
    // the glow reads as light "emanating".
    float cityDist = distance(vUv, uCityPos);
    float core = exp(-cityDist * 28.0);
    float halo = exp(-cityDist *  9.0) * 0.35;
    // Sparkle: layered sines (different periods, no rational ratio)
    // plus a per-pixel hash mod-time so adjacent fragments scintillate
    // out of phase — gives the "many little lights" impression.
    float t = uTime;
    float sparkle =
        0.55
      + 0.30 * sin(t * 3.17)
      + 0.20 * sin(t * 7.71 + 1.1)
      + 0.18 * sin(t * 13.9 + 0.4)
      + 0.18 * (mvnoise(vec2(t * 4.0, 0.7)) - 0.5)
      + 0.22 * (mhash21(floor(vUv * 90.0) + floor(t * 6.0)) - 0.5);
    sparkle = clamp(sparkle, 0.25, 1.6);
    vec3 neon = vec3(0.18, 1.05, 0.42);
    vec3 emission = neon * (core * 2.6 + halo) * sparkle * uCityIntensity;
    // Fade emission as it crosses the disc boundary into open sky.
    float emissionEdge = 1.0 - smoothstep(0.48, 0.50, d);
    rgb += emission * emissionEdge;

    // Halo contributes its own alpha outside the disc so the
    // emission isn't clipped to the surface mask.
    float haloAlpha = clamp(halo * 0.9 + core * 1.4, 0.0, 1.0)
                    * sparkle * uCityIntensity * emissionEdge;
    alpha = max(alpha, haloAlpha);
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
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uBrightness: { value: 2.0 },
        uTime: { value: 0.0 },
        uHasClouds: { value: hasClouds ? 1.0 : 0.0 },
        uCloudIntensity: { value: 0.75 },
        uCloudSpeed: { value: 1.0 },
        uCityIntensity: { value: 1.0 },
        // City light cluster sits at the LEFT of Alb'arel's disc.
        // Sampled from the new 1024x1024 source: green dots cluster
        // at ~(0.13, 0.49) in UV space. Devtools setter exposed
        // below so the user can nudge if the texture changes again.
        uCityPos: { value: new THREE.Vector2(0.13, 0.49) },
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
}
