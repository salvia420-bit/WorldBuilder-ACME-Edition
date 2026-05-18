// scene3d/ac_moons.js — Asheron's Call's two moons in the skybox.
//
// AC canon: there are two moons visible in the night skies of
// Auberean (Dereth's parent world).
//   - Alb'arel (light/tan) — the larger, primary moon. Wiki lore
//     describes "perfect geometry of lights on the dark side" — the
//     greenish dot cluster visible on the left of the source image.
//   - Rez'arel (red) — the smaller, cratered companion.
//
// Source images: fandom wiki imagedump (2020-03 snapshot) at
// scene3d/assets/moons/{albarel.jpg, rezarel.jpg}. Both are 256x256
// JPEGs of the moon centered on a dark navy background (NOT pure
// black). Background-removal is done shader-side via a circular
// alpha mask — the moons are clearly centered circular disks, so
// `discard` outside a UV-distance threshold is the cleanest path
// (no pre-processing of the source images, no chroma-key fragility).
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
// the viewer). Bumped 2× from initial 0.04/0.032 because at 1080p
// the original sizes were too easy to miss against the atmosphere
// scatter — dialing them back later is a 1-line change.
const ALB_ANGULAR_RADIUS = 0.080; // Alb'arel — primary, larger (~4.6°)
const REZ_ANGULAR_RADIUS = 0.064; // Rez'arel — companion, smaller (~3.7°)

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
// against a dark-navy background — we just discard outside the disc
// radius (0.46 of UV space = 23% inset from each edge, matches the
// padding the wiki screenshots have around the moon). Soft edge from
// 0.44..0.46 hides the JPEG block boundary at the disc's edge.
//
// `uBrightness` multiplies the moon color before output — boosting
// helps the disc punch through AerialPerspective scattering on the
// way to the canvas. 2.0 is a starting point; live-tune via
// `liveScene3d.acMoons.albMesh.material.uniforms.uBrightness.value`.
const MOON_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform float uBrightness;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c);
  if (d > 0.46) discard;
  float edge = 1.0 - smoothstep(0.44, 0.46, d);
  vec3 rgb = texture2D(map, vUv).rgb * uBrightness;
  gl_FragColor = vec4(rgb, edge);
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
    const albUrl = base + 'albarel.jpg';
    const rezUrl = base + 'rezarel.jpg';
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
    // eslint-disable-next-line no-console
    console.log(
      `[ac-moons] textures decoded: ` +
        `alb=${albTex.image?.width}x${albTex.image?.height} ` +
        `rez=${rezTex.image?.width}x${rezTex.image?.height}`,
    );
    this.albMesh = this._buildMoonMesh(albTex, ALB_ANGULAR_RADIUS);
    this.rezMesh = this._buildMoonMesh(rezTex, REZ_ANGULAR_RADIUS);
    return this;
  }

  _buildMoonMesh(texture, angularRadius) {
    // Diameter on the sky shell = 2 * R * tan(half-angle), but for
    // small angles tan(θ) ≈ θ; using θ directly is fine here.
    const size = 2 * SKY_RADIUS * angularRadius;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uBrightness: { value: 2.0 },
      },
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
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
    // Render BEFORE the cloud overlay (which is at 999) so clouds
    // can composite over the moons. Higher than typical scene
    // objects (default 0) so we're definitely sky-pass material.
    mesh.renderOrder = 900;
    return mesh;
  }

  /**
   * Attach both moon meshes to the sky scene so they're rendered as
   * part of the sky pass. Mirrors the cloud_overlay.attachToSkyScene
   * pattern — render-order semantics give us depth-correct occlusion
   * via the world pass that follows.
   */
  attachToSkyScene(skyScene) {
    if (!skyScene) return;
    if (this.albMesh) skyScene.add(this.albMesh);
    if (this.rezMesh) skyScene.add(this.rezMesh);
    this._inSkyScene = skyScene;
  }

  detachFromSkyScene() {
    if (!this._inSkyScene) return;
    if (this.albMesh) this._inSkyScene.remove(this.albMesh);
    if (this.rezMesh) this._inSkyScene.remove(this.rezMesh);
    this._inSkyScene = null;
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
    const t = (typeof nowMs === 'number' ? nowMs : performance.now()) -
      this._startMs;
    const ms = t * this._speedMul;

    // Alb'arel — slower period, inclined ~30° to the horizon plane.
    const ang = (ms / ALB_PERIOD_MS) * Math.PI * 2;
    const az = ang;
    // alt oscillates -0.6..0.6 rad (~±34°) — visible above and below
    // the horizon over the orbital period.
    const alt = Math.sin(ang + 0.5) * 0.6;
    this._setMoonOnSphere(this.albMesh, az, alt);

    // Rez'arel — faster period, steeper inclination, phase offset
    // so the two moons aren't usually overlapping on the sky.
    const ang2 = (ms / REZ_PERIOD_MS) * Math.PI * 2 + 2.1;
    const az2 = ang2;
    const alt2 = Math.sin(ang2 + 1.2) * 0.7;
    this._setMoonOnSphere(this.rezMesh, az2, alt2);
  }

  /**
   * Position the moon mesh on the sky shell at (azimuth, altitude)
   * and orient it to face the sky camera (which sits at the sky
   * scene origin since skyCell anchors to camera).
   *
   * azimuth: 0 = three.js -Z (north after worldRoot rotation, but
   *   the sky scene lives outside worldRoot so we use three.js
   *   raw axes — z- is "north" of the sky scene).
   * altitude: -π/2 (nadir) .. +π/2 (zenith). 0 is on the horizon.
   */
  _setMoonOnSphere(mesh, azimuthRad, altitudeRad) {
    const ca = Math.cos(altitudeRad);
    const x = SKY_RADIUS * ca * Math.sin(azimuthRad);
    const y = SKY_RADIUS * Math.sin(altitudeRad);
    const z = -SKY_RADIUS * ca * Math.cos(azimuthRad);
    mesh.position.set(x, y, z);
    // Billboard — always face the origin (sky-scene-local camera
    // position). Cheap because the moon mesh is just a plane.
    mesh.lookAt(0, 0, 0);
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
