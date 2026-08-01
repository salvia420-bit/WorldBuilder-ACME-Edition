// scene3d/ground_fog.js — the effect-agnostic camera-centred ground-fog ring
// (Wave 3A; design plan `docs/2026-07-31-terrain-vfx-plan.md` §3.5 item 3).
//
// WHY IT IS SHARED AND NOT `terrain_swamp_fog.js`. The plan names the flag
// `?terrainGroundFog` and calls the module "new shared `scene3d/ground_fog.js`"
// because SNOW (§3.4 "low blowing ground-haze") and VOLCANO (§3.6 ash haze)
// compose the same thing with a different palette and a different family set.
// So NOTHING in this file mentions swamp: the consumer supplies the colour, the
// opacity, the card size, the lift band, the family gate and the seed;
// `terrain_swamp.js` is simply its first caller.
//
// WHAT THIS OWNS
//   The BILLBOARD — a camera-facing soft card, its distance/height/near fades,
//   and the optional soft-particle fade against the scene depth buffer.
// WHAT IT DELEGATES
//   PLACEMENT, residency and amortisation to the shared
//   `terrain_scatter.js::createScatterPool` (world-anchored fixed-slot torus
//   grid ⇒ hash-stable per world cell, oracle grounding, family gating, leading
//   -edge re-entry, degenerate-instance culling). A "camera-centred ring" that
//   re-derived its own placement would be a fork of that pool with worse
//   properties: teleport away and back would not reproduce the same bank.
//   ⚠ CONSEQUENCE: the pool rounds `count` UP to a perfect square, so a
//   requested 24 becomes 25. `groundFog.count` (== `pool.count`) is
//   AUTHORITATIVE; the tier number is a request.
//
// "HORIZONTAL BILLBOARDS" vs "BILLBOARDS FACE THE CAMERA" — the plan asks for
// both (§3.5 item 3 says large soft HORIZONTAL billboards; the test spec says
// they FACE THE CAMERA). A flat, ground-parallel quad cannot face the camera,
// so the reconciliation is a CYLINDRICAL billboard: the card is free to spin
// about the WORLD-UP axis to face the eye, but its up vector is pinned to world
// up and the card is authored wide and short (26 m x 5.5 m at the swamp
// defaults) and anchored 0.2..1.5 m above the sampled ground. Read edge-on from
// player height it is a low horizontal bank; walk around it and it never
// shears. That is the standard fog-card construction and it is why there is no
// pop when the camera orbits.
//
// ⚠ THE DEPTH READ IS AN OPT-IN, AND THE REASON IS NOT TASTE (plan trap T4 +
// `OPTICAL_EFFECTS_HANDOFF.md`). A soft-particle fade needs the depth of the
// OPAQUE scene at the same pixel. The only scene-depth texture this client owns
// is `atmosphere_pipeline.js`'s `sceneDepthTexture`, and it is attached to BOTH
// composer ping-pong targets — i.e. it is the LIVE depth attachment while the
// world pass (which is where these cards draw) is running. Sampling it from a
// world-pass material is a framebuffer feedback loop; ANGLE may reject the draw
// outright. So:
//   * the soft-particle path is fully implemented here (log-depth decode,
//     NEAREST sampling, sentinel-aware threshold — all three mandated),
//   * it is INERT until BOTH `setSceneDepthTexture(tex)` has been handed a
//     texture AND `softnessM > 0`,
//   * `softnessM` ships 0 on every quality tier and is reachable only as
//     `?terrainGroundFogSoftness=N` — the 1070 adjudication knob,
//   * and the failure mode is SAFE: no texture ⇒ threshold sentinel stays 0 ⇒
//     the shader never samples and the fog is VISIBLE (the 2026-05-18
//     cloud_overlay lesson: visible-over-everything is the safe failure for a
//     depth wire, invisible is not).
// Without the depth read the card still soft-fades: analytically, by height
// within the card, by distance through `hbScatterFade`, and by proximity to the
// near plane. That is what ships.
//
// INJECTED THREE (the `terrain_scatter.js` / `trail_map.js` idiom). This module
// imports THREE from nowhere: `createGroundFog({THREE, ...})` takes it and it
// is OPTIONAL — with no THREE the ring still runs its full CPU bookkeeping and
// builds no GPU object. That is what makes `test_ground_fog.mjs` cheap and
// `?nullRender=1` free.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component, so
// `vfx/lint_caps.js` does not sweep it — it obeys the firewall anyway. Reads:
// static terrain (through the oracle), a server-derived player position, the
// frame clock. Writes: its own buffers and its own material's uniforms. It adds
// NO LIGHT (§5.2), varies no program cache key (§5.4 — one material, no
// per-instance key), uses no `Math.random` (§5.5), binds the clock by the
// caller's value each frame (§5.6) and sets `castShadow = false` (§5.7).
//
// COORDINATE FRAME: AC world metres (+X east, +Y north, +Z up), the frame
// inside `terrainGroup`. Do not run coordinates through `acToThree`.

import { createScatterPool, SCATTER_FADE_GLSL } from "./terrain_scatter.js";

// ---------------------------------------------------------------------------
// Defaults + pure helpers (no THREE — the directly tested surface).
// ---------------------------------------------------------------------------

/**
 * Effect-agnostic defaults. A consumer overrides what it cares about; the
 * values here are a neutral grey haze, NOT swamp green (see the header).
 */
export const GROUND_FOG_DEFAULTS = Object.freeze({
  count: 24,             // requested cards; the pool rounds UP to a square
  radiusM: 56,           // half-extent of the ring; it covers 2x this
  liftMinM: 0.2,         // plan §3.5: z = height + 0.2..1.5
  liftMaxM: 1.5,
  cardWidthM: 26,        // wide and short — a bank, not a curtain
  cardHeightM: 5.5,
  widthJitter: 0.35,     // +/- fraction, hash-stable per world cell
  colour: [0.72, 0.74, 0.72],
  opacity: 0.15,
  softnessM: 0,          // 0 ⇒ the depth soft-particle term is OFF (see header)
  nearFadeM: 3.0,        // fade out inside this many metres of the eye
  driftHz: 0.013,        // slow breathing of the bank opacity
  driftAmount: 0.35,     // fraction of opacity the breath modulates
  fadeFraction: 0.35,    // ring fade band, as a fraction of radiusM
  seed: 0x60f06001,
  renderOrder: 2,        // under sand streamers (3), over opaque terrain
});

/** The sentinel that means "a real depth texture is wired" (cloud_overlay.js's
 *  0.9999 convention). 0 means "no depth provided — never sample". */
export const GROUND_FOG_DEPTH_SENTINEL = 0.9999;

/**
 * `logDepthBufFC` for a given camera far plane — the SAME expression
 * `atmosphere_pipeline.js` uses for `hbLogDepthFC` and the same one three
 * itself feeds `logDepthBufFC`. Exported so the test can assert the decode
 * round-trips instead of trusting a magic number.
 *
 * @param {number} cameraFar
 * @returns {number}
 */
export function groundFogLogDepthFC(cameraFar) {
  const far = Number.isFinite(cameraFar) && cameraFar > 1 ? cameraFar : 10000;
  return 2.0 / Math.log2(far + 1.0);
}

/**
 * The JS twin of the shader's log-depth decode (plan trap T4):
 * `dist = exp2(2*d/FC) - 1`. The forward transform three writes is
 * `gl_FragDepth = log2(1 + viewZ) * logDepthBufFC * 0.5`, so this inverts it to
 * EYE-FORWARD METRES. Treating log depth as linear puts the occluder at a
 * wildly wrong distance — which is the whole trap.
 *
 * @param {number} depth01 the RAW depth-buffer texel, [0,1]
 * @param {number} logDepthFC
 * @returns {number} eye-forward metres
 */
export function decodeLogDepthToMetres(depth01, logDepthFC) {
  const fc = Number.isFinite(logDepthFC) && logDepthFC > 0 ? logDepthFC : groundFogLogDepthFC(10000);
  const d = Number.isFinite(depth01) ? depth01 : 1;
  return Math.pow(2, (2 * d) / fc) - 1;
}

/**
 * The soft-particle response, CPU twin of the fragment's `soft` term.
 * `sceneDistM <= 0` (no occluder / sky / sentinel-rejected texel) ⇒ 1 (opaque
 * as authored); `softnessM <= 0` ⇒ 1 (the term is disabled).
 *
 * @param {number} sceneDistM eye-forward distance of the OPAQUE scene
 * @param {number} fragDistM  eye-forward distance of this fog fragment
 * @param {number} softnessM  the fade band in metres
 */
export function softParticleFade(sceneDistM, fragDistM, softnessM) {
  if (!(softnessM > 0)) return 1;
  if (!(sceneDistM > 0)) return 1;
  const t = (sceneDistM - fragDistM) / softnessM;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ---------------------------------------------------------------------------
// GLSL. Exported strings so the shader contract is asserted without a GPU (the
// `terrain.js` / `terrain_sand.js` convention).
//
// ⚠ NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal.
// ---------------------------------------------------------------------------

export const GROUND_FOG_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js + the fill below).
attribute vec3 aOffset;    // AC world anchor (x, y, z = ground + lift)
attribute vec2 aScale;     // (width, height) in metres
attribute vec4 aCard;      // (phase01, opacity, spare, spare)

uniform float uTime;       // the shared clock, pushed per frame
uniform float uDriftHz;
uniform float uDriftAmount;

varying vec2 vQuadUv;
varying float vAlpha;
varying float vViewDist;   // eye-forward metres of THIS vertex
varying vec4 vClip;

${SCATTER_FADE_GLSL}

void main() {
  // The anchor in view space. instanceMatrix carries the world translation AND
  // the pool's 0/1 live scale, so a degenerate (wrong-family / unbaked /
  // out-of-ring) instance collapses to a point and is zero-area here too.
  vec4 anchorView = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 anchorWorldish = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // CYLINDRICAL BILLBOARD (see the module header). Object space is AC space, so
  // object +Z is world up; carry it into view space and build the card basis
  // there. In view space the eye looks down -Z, so the direction TO the eye is
  // +Z and right = cross(up, toEye).
  vec3 upView = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 toEye = vec3(0.0, 0.0, 1.0);
  vec3 rightView = cross(upView, toEye);
  float rl = length(rightView);
  // Degenerate only when the camera looks straight down the up axis; then any
  // horizontal basis is as good as another, so fall back to view-right.
  rightView = (rl > 1e-4) ? (rightView / rl) : vec3(1.0, 0.0, 0.0);

  vec3 viewPos = anchorView.xyz
    + rightView * (position.x * aScale.x)
    + upView * (position.y * aScale.y);

  // Distance blend, identical in form to the pool's CPU fadeFor() (LINEAR).
  float fade = hbScatterFade(anchorWorldish.xy);

  // Slow breathing so a static bank does not read as a decal. Deterministic:
  // the shared clock plus the instance's own hash phase, never a random.
  float breath = 1.0 - uDriftAmount
    + uDriftAmount * (0.5 + 0.5 * sin(6.2831853 * (uTime * uDriftHz + aCard.x)));

  vAlpha = fade * aCard.y * breath;
  vQuadUv = uv;
  vViewDist = -viewPos.z;
  vClip = projectionMatrix * vec4(viewPos, 1.0);
  gl_Position = vClip;
}
`;

export const GROUND_FOG_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;
uniform float uOpacity;
uniform float uNearFadeM;
// SOFT-PARTICLE trio. All three are mandated by the plan (trap T4) and
// OPTICAL_EFFECTS_HANDOFF.md: the buffer is LOGARITHMIC so it must be decoded,
// the R9 290 regressed on HalfFloat depth with LINEAR filtering so the sampler
// must be NEAREST, and the threshold is a SENTINEL so an unbound sampler (which
// returns 0 in WebGL2) can never be mistaken for "an occluder at zero metres".
uniform sampler2D uSceneDepth;
uniform float uDepthThreshold;   // 0.0 = no depth wired ⇒ never sample
uniform float uLogDepthFC;       // 2.0 / log2(cameraFar + 1.0)
uniform float uSoftnessM;        // 0.0 = the soft-particle term is disabled

varying vec2 vQuadUv;
varying float vAlpha;
varying float vViewDist;
varying vec4 vClip;

void main() {
  // The card: soft everywhere, softest at the top (fog thins as it lifts) and
  // feathered at both ends so neighbouring banks blend instead of tiling.
  vec2 c = vQuadUv * 2.0 - 1.0;
  float across = 1.0 - abs(c.x);
  float up = 1.0 - vQuadUv.y;
  float mask = pow(max(across, 0.0), 1.6) * pow(max(up, 0.0), 1.25);

  // Near-plane fade: never let the camera end up inside an opaque slab.
  float near = clamp(vViewDist / max(uNearFadeM, 1e-3), 0.0, 1.0);

  // SOFT PARTICLE. Inert unless a depth texture was wired (sentinel > 0) AND a
  // softness band was asked for.
  float soft = 1.0;
  if (uDepthThreshold > 0.0 && uSoftnessM > 0.0) {
    vec2 uvScreen = vClip.xy / max(vClip.w, 1e-6) * 0.5 + 0.5;
    float d = texture2D(uSceneDepth, uvScreen).r;
    // Sentinel-aware: at/over the threshold is sky or an unwritten texel, i.e.
    // NO occluder — leave the fog at full strength rather than dissolving it.
    if (d < uDepthThreshold) {
      // LOG-DEPTH DECODE (plan trap T4). The JS twin is
      // ground_fog.js::decodeLogDepthToMetres.
      float sceneDist = exp2(2.0 * d / uLogDepthFC) - 1.0;
      soft = clamp((sceneDist - vViewDist) / uSoftnessM, 0.0, 1.0);
    }
  }

  float a = mask * vAlpha * near * soft * uOpacity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColour, a);
}
`;

/** The per-instance attribute schema a ground-fog ring allocates. */
export const GROUND_FOG_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aCard", itemSize: 4 },
]);

// ---------------------------------------------------------------------------
// The ring.
// ---------------------------------------------------------------------------

function _cardGeometry(THREE) {
  // A unit quad in the local XY plane with its ORIGIN AT THE BOTTOM EDGE, so
  // the anchor height is the foot of the bank and `aScale.y` lifts it. Built by
  // hand rather than with PlaneGeometry so winding and uv are explicit.
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -0.5, 0.0, 0,
    0.5, 0.0, 0,
    0.5, 1.0, 0,
    -0.5, 1.0, 0,
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  geom.name = "ground-fog-card";
  return geom;
}

/**
 * Create a camera-centred ground-fog ring.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only ring.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} [opts.oracle] the terrain oracle, or a GETTER. Use
 *   the getter form with the spine: `ctx.oracle`/`frameCtx.oracle` is LIVE and
 *   must never be stashed (wave-0 handoff §5).
 * @param {number[]} [opts.families] FAM_* ids the fog may sit on. Omitted ⇒
 *   every family (the pool never imports `terrain_families.js`), which for fog
 *   means the CONSUMER must pass the gate — including keeping FAM_WATER out
 *   (plan §3.8.1).
 * @param {number} [opts.count]    cards (rounded UP to a perfect square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.seed]
 * @param {string} [opts.name]
 * @param {object} [opts.tuning]   any GROUND_FOG_DEFAULTS override.
 * @param {number} [opts.cameraFar] for the log-depth constant (default 10000).
 */
export function createGroundFog(opts = {}) {
  const THREE = opts.THREE || null;
  const name = typeof opts.name === "string" ? opts.name : "ground-fog";
  const tuning = { ...GROUND_FOG_DEFAULTS, ...(opts.tuning || {}) };
  const count = Math.max(1, Math.round(
    Number.isFinite(opts.count) ? opts.count : tuning.count,
  ));
  const radiusM = Math.min(1024, Math.max(4,
    Number.isFinite(opts.radiusM) ? opts.radiusM : tuning.radiusM));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : tuning.seed) | 0;
  const softnessM = Math.max(0, Number.isFinite(opts.softnessM) ? opts.softnessM : tuning.softnessM);

  const uniforms = {
    uTime: { value: 0 },
    uDriftHz: { value: tuning.driftHz },
    uDriftAmount: { value: tuning.driftAmount },
    uColour: { value: null },
    uOpacity: { value: tuning.opacity },
    uNearFadeM: { value: tuning.nearFadeM },
    uSceneDepth: { value: null },
    uDepthThreshold: { value: 0 },       // SENTINEL — no depth wired yet
    uLogDepthFC: { value: groundFogLogDepthFC(opts.cameraFar) },
    uSoftnessM: { value: softnessM },
  };

  let geometry = null;
  let material = null;

  // Build geometry + material BEFORE the pool: the pool needs a material to
  // build the mesh. `opts.uniforms` (the wave-1B rough edge the snow agent
  // landed) lets the pool publish its four scatter uniforms straight INTO this
  // bag, so there is no placeholder-then-repoint dance.
  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _cardGeometry(THREE);
      uniforms.uColour.value = new THREE.Color(
        tuning.colour[0], tuning.colour[1], tuning.colour[2],
      );
      material = new THREE.ShaderMaterial({
        vertexShader: GROUND_FOG_VERTEX_GLSL,
        fragmentShader: GROUND_FOG_FRAGMENT_GLSL,
        uniforms,
        transparent: true,
        // §3.5: depth-write OFF. The cards are unsorted against each other by
        // construction (they are a ring, not a stack) and writing depth would
        // let the nearest card punch a hole in every other transparent surface.
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.name = name;
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name,
    count,
    radiusM,
    seed,
    shape: "disc",
    fadeFraction: tuning.fadeFraction,
    jitter: 1,
    families: opts.families || null,
    attributes: GROUND_FOG_SCHEMA.map((a) => ({ ...a })),
    uniforms,
    // A ring of ~25 cards can be fully re-scattered in one frame; there is no
    // amortisation win and a partial lap would leave a visible hole.
    sliceSize: Math.max(1, count),
    scanBudget: Math.max(1, count),
    fill(ctx) {
      // Lift: 0.2..1.5 m above the sampled ground (plan §3.5), hash-stable.
      const lift = tuning.liftMinM + ctx.rand(3) * (tuning.liftMaxM - tuning.liftMinM);
      ctx.z += lift;
      const wJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.widthJitter;
      const hJ = 1 + (ctx.rand(5) - 0.5) * 2 * tuning.widthJitter;
      ctx.set("aScale", tuning.cardWidthM * wJ, tuning.cardHeightM * hJ);
      ctx.set(
        "aCard",
        ctx.rand(6),                        // breathing phase
        (0.6 + ctx.rand(7) * 0.4) * ctx.fade,
        0,
        0,
      );
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,   // the shader reads instanceMatrix (see the GLSL)
    frustumCulled: false,        // the ring follows the player
  });

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = name;
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
    mesh.renderOrder = tuning.renderOrder;
  }

  const state = {
    frames: 0,
    lastRescattered: 0,
    depthWired: false,
    depthFilter: null,
    built: !!mesh,
  };

  return {
    pool,
    uniforms,
    /** AUTHORITATIVE card count — the pool rounded the request up to a square. */
    get count() { return pool.count; },
    get requestedCount() { return count; },
    get radiusM() { return radiusM; },
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },

    /**
     * Wire (or unwire) the scene depth texture for the soft-particle fade.
     *
     * ⚠ Read the module header before calling this with the composer's own
     * depth texture from inside the world pass. NEAREST is forced here rather
     * than assumed: `THREE.DepthTexture` defaults to NEAREST today, but the
     * R9 290 HalfFloat/LINEAR regression is exactly the kind of thing a future
     * refactor re-introduces by handing us someone else's texture.
     *
     * @param {object|null} tex
     */
    setSceneDepthTexture(tex) {
      if (!tex) {
        uniforms.uSceneDepth.value = null;
        uniforms.uDepthThreshold.value = 0;   // sentinel: never sample
        state.depthWired = false;
        state.depthFilter = null;
        return false;
      }
      if (THREE && THREE.NearestFilter !== undefined) {
        if (tex.minFilter !== THREE.NearestFilter || tex.magFilter !== THREE.NearestFilter) {
          tex.minFilter = THREE.NearestFilter;
          tex.magFilter = THREE.NearestFilter;
          tex.needsUpdate = true;
        }
        state.depthFilter = "nearest";
      }
      uniforms.uSceneDepth.value = tex;
      uniforms.uDepthThreshold.value = GROUND_FOG_DEPTH_SENTINEL;
      state.depthWired = true;
      return true;
    },

    /** Update the log-depth constant when the camera's far plane changes. */
    setCameraFar(far) {
      uniforms.uLogDepthFC.value = groundFogLogDepthFC(far);
      return uniforms.uLogDepthFC.value;
    },

    /**
     * Effect-agnostic re-tint — the seam SNOW and VOLCANO reuse (plan §3.5:
     * "design it effect-agnostic"). Every field is optional.
     * @param {{colour?:number[], opacity?:number, softnessM?:number,
     *   nearFadeM?:number, driftHz?:number, driftAmount?:number}} p
     */
    setPalette(p = {}) {
      if (Array.isArray(p.colour) && uniforms.uColour.value
          && typeof uniforms.uColour.value.setRGB === "function") {
        uniforms.uColour.value.setRGB(p.colour[0], p.colour[1], p.colour[2]);
      }
      if (Number.isFinite(p.opacity)) uniforms.uOpacity.value = Math.max(0, p.opacity);
      if (Number.isFinite(p.softnessM)) uniforms.uSoftnessM.value = Math.max(0, p.softnessM);
      if (Number.isFinite(p.nearFadeM)) uniforms.uNearFadeM.value = Math.max(0, p.nearFadeM);
      if (Number.isFinite(p.driftHz)) uniforms.uDriftHz.value = p.driftHz;
      if (Number.isFinite(p.driftAmount)) uniforms.uDriftAmount.value = Math.max(0, p.driftAmount);
      return uniforms;
    },

    /** Per-frame: push the clock and re-centre the ring on the player. */
    update(dt, tSec, px, py, pz) {
      state.frames += 1;
      uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },

    /** Host-side toggle for park/quality churn (§5.3 keeps `.visible` OUT of
     *  registered components and IN host modules like this one). */
    setVisible(on) {
      if (mesh) mesh.visible = !!on;   // vfx-lint-allow: host module, not a registered component
      return !!on;
    },

    dispose() {
      // The pool owns the mesh (it built it) and deliberately never disposes
      // the geometry/material it was handed — those are ours.
      try { pool.dispose(); } catch (_) { /* fail-soft */ }
      mesh = null;
      if (geometry) { try { geometry.dispose(); } catch (_) {} geometry = null; }
      if (material) { try { material.dispose(); } catch (_) {} material = null; }
    },

    stats() {
      return {
        built: !!mesh,
        count: pool.count,
        requestedCount: count,
        radiusM,
        frames: state.frames,
        lastRescattered: state.lastRescattered,
        depthWired: state.depthWired,
        depthFilter: state.depthFilter,
        softnessM: uniforms.uSoftnessM.value,
        depthThreshold: uniforms.uDepthThreshold.value,
        pool: pool.stats(),
      };
    },
  };
}

export default createGroundFog;
