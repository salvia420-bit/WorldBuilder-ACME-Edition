// scene3d/trail_map.js — the shared stomp / footprint trail map (Wave 0B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §2.2 / §3.1 ("STOMP"),
// §3.4 (snow prints) and §3.7 (mud prints). ONE render target, family-agnostic:
// grass reads it to flatten blades, snow reads it to dent drifts, mud reads it
// to keep a print. Nobody allocates a second one.
//
// WHAT IT IS
//   A single-channel (R8) THREE.WebGLRenderTarget covering a `2R × 2R` metre
//   square of AC ground centred on the player, PING-PONGED so no pass ever
//   reads and writes the same target. Each frame the fragment shader:
//     1. re-projects the previous frame's texel through the NEW centre (so the
//        map scrolls with the player instead of smearing),
//     2. subtracts a constant fade (`dt / recoverySec` — recovery is linear and
//        frame-rate independent),
//     3. `max()`es in up to MAX_STAMPS soft radial blobs at world positions
//        pushed by `stamp()` this frame.
//   No CPU readback, ever.
//
// THE SNAP (plan §3.1). The centre is quantised to the texel grid before it is
// used, so a sub-texel camera drift cannot shimmer the whole map. At the
// defaults (256² over 96 m) one texel is 0.375 m — coarse for one footprint,
// which is plan §8 risk 7: snow may want a second, smaller, higher-res map.
// Decide that in Wave 2A; do not silently re-purpose this one.
//
// TELEPORT. `clear()` MUST be called on any non-continuous player move
// (`@teleloc`, portal, lifestone) or a stomp scar appears at the arrival point.
// `terrain_vfx.js` owns that detection (a per-frame jump larger than one
// landblock) and calls it; a family should never need to.
//
// INJECTED THREE (the `particle_attach.js` idiom). This module imports nothing.
// `createTrailMap({ THREE, renderer })` takes both, and BOTH are optional:
// with no renderer the map still runs its full CPU bookkeeping (centre, snap,
// fade accumulator, stamp queue, teleport clears) and simply allocates no GPU
// resources. That is what makes `test_trail_map.mjs` a pure-node test and what
// makes `?nullRender=1` free.
//
// INVARIANTS (plan §5). This is a HOST module, not a registered VFX component:
// it is not swept by `vfx/lint_caps.js`. It still obeys the firewall — it reads
// only a world position + the frame clock and writes only its own render
// target. It adds no light, patches no material, and varies no program cache
// key. `?terrainTrail` ships OFF on every quality tier (§5.9).

// ---------------------------------------------------------------------------
// Defaults + pure helpers (no THREE, no renderer — the tested surface).
// ---------------------------------------------------------------------------

/** Shader-side stamp array length. Raising it recompiles the trail program. */
export const MAX_STAMPS = 8;

export const TRAIL_DEFAULTS = Object.freeze({
  resolution: 256,      // texels per side
  radiusM: 48,          // half-extent; the map covers 2*radiusM metres
  recoverySec: 4,       // seconds from full stomp back to zero
  stampRadiusM: 0.75,   // default blob radius for `stamp()`
  stampStrength: 1,     // default blob peak, 0..1
  teleportJumpM: 192,   // one landblock — beyond this a move is a teleport
});

// PER-FAMILY FADE. A texel here is ONE scalar in an R8 target — no room for a
// per-print age, owner or fade rate, and a second channel would need a second
// sampler the terrain shader does not have. So the three families that write
// the map share `recoverySec`, and the numbers they each ask for plus the
// longest-wins rule that reconciles them live in
// `vfx_flags.js::TRAIL_FAMILY_FADE_SEC` / `terrainTrailFadeSource` — with the
// flag readers, and NOT here, so the two families that consume them keep their
// "this module never imports trail_map.js" invariant.

/** Metres per texel for a given extent/resolution. */
export function texelSizeM(radiusM, resolution) {
  const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : TRAIL_DEFAULTS.radiusM;
  const n = Number.isFinite(resolution) && resolution >= 1 ? resolution : TRAIL_DEFAULTS.resolution;
  return (2 * r) / n;
}

/**
 * Quantise one centre axis to the texel grid. THE anti-shimmer step: without
 * it every sub-texel move re-samples the whole map on a new phase and the
 * whole trail crawls.
 */
export function snapCenterToTexel(v, texelM) {
  if (!Number.isFinite(v)) return 0;
  if (!Number.isFinite(texelM) || texelM <= 0) return v;
  return Math.round(v / texelM) * texelM;
}

/**
 * Fade subtracted from every texel this frame. Linear so "recovery ≈ N s" is
 * literally true, clamped to 1 so a tab-resume `dt` spike wipes the map rather
 * than doing something numerically strange, and 1 for a non-positive
 * `recoverySec` (instant recovery = trail disabled in practice).
 */
export function fadeAmountFor(dt, recoverySec) {
  if (!(Number.isFinite(recoverySec) && recoverySec > 0)) return 1;
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return Math.min(1, d / recoverySec);
}

/**
 * World (AC x, y) → trail UV for a given centre. Writes into `out` when given
 * (zero-alloc on the hot path). UVs outside [0,1] are OUTSIDE the map — the
 * shader treats that as "no trail", never as a clamped smear.
 */
export function trailUvFor(x, y, centerX, centerY, radiusM, out) {
  const extent = 2 * radiusM;
  const u = (x - centerX) / extent + 0.5;
  const v = (y - centerY) / extent + 0.5;
  if (out) { out.x = u; out.y = v; return out; }
  return { x: u, y: v };
}

/** Is this world point inside the current map footprint? */
export function trailCovers(x, y, centerX, centerY, radiusM) {
  return Math.abs(x - centerX) <= radiusM && Math.abs(y - centerY) <= radiusM;
}

/**
 * Did the player teleport between these two positions? Any move larger than a
 * landblock in one frame is discontinuous by construction (retail run speed is
 * ~6 m/s; 192 m in one frame is impossible).
 */
export function isTeleportJump(x0, y0, x1, y1, thresholdM) {
  const t = Number.isFinite(thresholdM) ? thresholdM : TRAIL_DEFAULTS.teleportJumpM;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy > t * t;
}

/**
 * Resolve the trail-map config from (URL > quality preset > fallback), in the
 * `gfx_relief.js::resolveGfxRelief` house form (plan §2.4): the master flag is
 * a STRICT exact-match opt-in, an unrecognised value warns loudly and does NOT
 * enable, and a `source` provenance object makes "why is my flag off?" a
 * one-line console read.
 *
 * The URL readers themselves live in `vfx_flags.js` (one flag, one reader);
 * this function only composes them with the preset bag.
 *
 * @param {object} readers  `{enabled, resolution, radiusM, recoverySec}` —
 *   the `vfx_flags.js` reader functions. Injected so this stays testable.
 */
export function resolveTrailMapConfig(readers) {
  const r = readers || {};
  const num = (fn, fallback) => {
    try {
      const v = typeof fn === "function" ? fn() : undefined;
      return Number.isFinite(v) ? v : fallback;
    } catch (_) { return fallback; }
  };
  let enabled = false;
  try { enabled = typeof r.enabled === "function" ? r.enabled() === true : false; } catch (_) { enabled = false; }
  return {
    enabled,
    resolution: Math.max(16, Math.min(2048, Math.round(num(r.resolution, TRAIL_DEFAULTS.resolution)))),
    radiusM: Math.max(4, Math.min(512, num(r.radiusM, TRAIL_DEFAULTS.radiusM))),
    recoverySec: Math.max(0.05, Math.min(300, num(r.recoverySec, TRAIL_DEFAULTS.recoverySec))),
  };
}

// ---------------------------------------------------------------------------
// GLSL. Built as strings so a node test can assert on them without a GL
// context; MAX_STAMPS is interpolated so raising the constant is one edit.
// ---------------------------------------------------------------------------

export const TRAIL_VERTEX_SHADER = `
varying vec2 vTrailUv;
void main() {
  vTrailUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const TRAIL_FRAGMENT_SHADER = `
precision highp float;
varying vec2 vTrailUv;
uniform sampler2D uPrev;
uniform vec2  uCenter;
uniform vec2  uPrevCenter;
uniform float uRadius;
uniform float uFade;
uniform int   uStampCount;
// xy = world position, z = radius (m), w = strength
uniform vec4  uStamps[${MAX_STAMPS}];

void main() {
  float extent = 2.0 * uRadius;
  vec2 world = uCenter + (vTrailUv - 0.5) * extent;

  // Re-project last frame through the NEW centre so the map scrolls with the
  // player. Outside the old footprint there is nothing to carry forward.
  vec2 prevUv = (world - uPrevCenter) / extent + 0.5;
  float v = 0.0;
  if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0) {
    v = max(0.0, texture2D(uPrev, prevUv).r - uFade);
  }

  for (int i = 0; i < ${MAX_STAMPS}; i++) {
    if (i >= uStampCount) break;
    vec4 s = uStamps[i];
    float d = distance(world, s.xy);
    // 1 at the centre, 0 at the rim.
    //
    // This used to be written smoothstep(s.z, 0.0, d) — i.e. edge0 = the
    // radius, edge1 = 0, so edge0 > edge1 ALWAYS (the JS side clamps the
    // radius to > 0 before it ever reaches this uniform). GLSL ES leaves
    // smoothstep UNDEFINED when edge0 >= edge1; it only worked because most
    // compilers emit the general clamp((x-edge0)/(edge1-edge0)) form, which
    // happens to invert cleanly. A compiler that specialises on edge0 < edge1
    // is entitled to return 0 for every texel — a permanently blank trail
    // map, with stampsDrawn still counting up and stats() still reporting the
    // feature healthy. The 1070 runs ANGLE/D3D11, so this is live risk on the
    // only real GPU in the fleet, not a theoretical portability note.
    // Spec-safe form, same curve: rise over [0, s.z], then invert.
    v = max(v, s.w * (1.0 - smoothstep(0.0, max(s.z, 1e-4), d)));
  }

  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// The map.
// ---------------------------------------------------------------------------

/**
 * Create a trail map.
 *
 * @param {object}   opts
 * @param {object}  [opts.THREE]        the three namespace. Omit ⇒ CPU-only.
 * @param {object}  [opts.renderer]     THREE.WebGLRenderer. Omit ⇒ CPU-only.
 * @param {number}  [opts.resolution]
 * @param {number}  [opts.radiusM]
 * @param {number}  [opts.recoverySec]
 * @param {string}  [opts.name]         diagnostic label
 * @returns {object} the trail-map handle (see `stats()` for the surface).
 */
export function createTrailMap(opts = {}) {
  const THREE = opts.THREE || null;
  const renderer = opts.renderer || null;
  const resolution = Math.max(16, Math.min(2048, Math.round(
    Number.isFinite(opts.resolution) ? opts.resolution : TRAIL_DEFAULTS.resolution)));
  const radiusM = Math.max(4, Math.min(512,
    Number.isFinite(opts.radiusM) ? opts.radiusM : TRAIL_DEFAULTS.radiusM));
  const recoverySec = Math.max(0.05, Math.min(300,
    Number.isFinite(opts.recoverySec) ? opts.recoverySec : TRAIL_DEFAULTS.recoverySec));
  const name = typeof opts.name === "string" ? opts.name : "terrain-trail";
  const texelM = texelSizeM(radiusM, resolution);

  // --- CPU state (always live) -------------------------------------------
  const state = {
    name,
    resolution,
    radiusM,
    recoverySec,
    texelM,
    centerX: 0,
    centerY: 0,
    prevCenterX: 0,
    prevCenterY: 0,
    centered: false,
    frames: 0,
    stampsQueued: 0,
    stampsDrawn: 0,
    stampsDropped: 0,
    clears: 0,
    teleportClears: 0,
    gpuFrames: 0,
    lastFade: 0,
  };
  // Bounded queue — a Wave-1 family with a runaway stamp loop must not grow
  // an unbounded array between frames.
  const pending = [];

  // --- GPU state (only with a THREE + renderer) --------------------------
  let gpu = null;
  if (THREE && renderer && typeof THREE.WebGLRenderTarget === "function") {
    try {
      const mkTarget = () => {
        const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
          format: THREE.RedFormat !== undefined ? THREE.RedFormat : undefined,
          type: THREE.UnsignedByteType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        });
        rt.texture.name = `${name}-rt`;
        return rt;
      };
      const stamps = [];
      for (let i = 0; i < MAX_STAMPS; i += 1) stamps.push(new THREE.Vector4(0, 0, 1, 0));
      const material = new THREE.ShaderMaterial({
        vertexShader: TRAIL_VERTEX_SHADER,
        fragmentShader: TRAIL_FRAGMENT_SHADER,
        uniforms: {
          uPrev: { value: null },
          uCenter: { value: new THREE.Vector2(0, 0) },
          uPrevCenter: { value: new THREE.Vector2(0, 0) },
          uRadius: { value: radiusM },
          uFade: { value: 0 },
          uStampCount: { value: 0 },
          uStamps: { value: stamps },
        },
        depthTest: false,
        depthWrite: false,
        // §5.7 — this quad never reaches the shadow depth pass (it is rendered
        // into an offscreen target by an explicit renderer.render call, not by
        // the scene graph), but say so anyway.
        toneMapped: false,
      });
      const geom = new THREE.PlaneGeometry(2, 2);
      const quad = new THREE.Mesh(geom, material);
      quad.frustumCulled = false;
      quad.castShadow = false;
      quad.receiveShadow = false;
      const scene = new THREE.Scene();
      scene.add(quad);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      gpu = {
        read: mkTarget(),
        write: mkTarget(),
        material,
        geom,
        quad,
        scene,
        camera,
        stamps,
      };
    } catch (_) {
      gpu = null; // fail-soft: CPU bookkeeping continues, nothing renders
    }
  }

  // Uniform bag families bind BY REFERENCE (plan §5.6) — the texture value is
  // swapped in place on every ping-pong so a material bound once stays correct.
  const uniforms = {
    uTrailMap: { value: gpu ? gpu.read.texture : null },
    uTrailCenter: { value: THREE && THREE.Vector2 ? new THREE.Vector2(0, 0) : { x: 0, y: 0 } },
    uTrailRadius: { value: radiusM },
    uTrailTexel: { value: texelM },
    uTrailEnabled: { value: gpu ? 1 : 0 },
  };

  function setCenter(x, y) {
    state.centerX = snapCenterToTexel(x, texelM);
    state.centerY = snapCenterToTexel(y, texelM);
    if (!state.centered) {
      state.prevCenterX = state.centerX;
      state.prevCenterY = state.centerY;
      state.centered = true;
    }
    uniforms.uTrailCenter.value.x = state.centerX;
    uniforms.uTrailCenter.value.y = state.centerY;
  }

  /** Queue a soft radial stomp at an AC world position. Silently dropped when
   *  the point is off-map or the frame's stamp budget is spent. */
  function stamp(x, y, blobRadiusM, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    state.stampsQueued += 1;
    if (pending.length >= MAX_STAMPS) { state.stampsDropped += 1; return false; }
    if (state.centered && !trailCovers(x, y, state.centerX, state.centerY, radiusM + 4)) {
      state.stampsDropped += 1;
      return false;
    }
    pending.push({
      x,
      y,
      r: Number.isFinite(blobRadiusM) && blobRadiusM > 0 ? blobRadiusM : TRAIL_DEFAULTS.stampRadiusM,
      s: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : TRAIL_DEFAULTS.stampStrength,
    });
    return true;
  }

  /** Wipe both targets and the queue. Call on ANY discontinuous player move. */
  function clear(reason) {
    pending.length = 0;
    state.clears += 1;
    if (reason === "teleport") state.teleportClears += 1;
    state.prevCenterX = state.centerX;
    state.prevCenterY = state.centerY;
    if (!gpu || !renderer) return;
    let prevTarget = null;
    // ⚠ Save and restore the CLEAR COLOR too. `setClearColor` is global renderer
    // state; leaving it black here would repaint the main scene's background on
    // the very next frame.
    let prevClear = null;
    let prevAlpha = 1;
    try { prevTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null; } catch (_) {}
    try {
      if (THREE && typeof THREE.Color === "function" && renderer.getClearColor) {
        prevClear = renderer.getClearColor(new THREE.Color());
        prevAlpha = typeof renderer.getClearAlpha === "function" ? renderer.getClearAlpha() : 1;
      }
    } catch (_) { prevClear = null; }
    try {
      for (const rt of [gpu.read, gpu.write]) {
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
      }
    } catch (_) { /* fail-soft */ } finally {
      try { renderer.setRenderTarget(prevTarget); } catch (_) {}
      try { if (prevClear) renderer.setClearColor(prevClear, prevAlpha); } catch (_) {}
    }
  }

  /**
   * Advance one frame.
   * @param {number} dt seconds since the last frame (`scene3d.frameTime.dt`).
   * @param {number} cx AC world x to centre on (the player).
   * @param {number} cy AC world y.
   */
  function update(dt, cx, cy) {
    state.frames += 1;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      const hadCenter = state.centered;
      const px = state.centerX;
      const py = state.centerY;
      setCenter(cx, cy);
      if (hadCenter && isTeleportJump(px, py, state.centerX, state.centerY, TRAIL_DEFAULTS.teleportJumpM)) {
        clear("teleport");
      }
    }
    const fade = fadeAmountFor(dt, recoverySec);
    state.lastFade = fade;

    const drawn = Math.min(pending.length, MAX_STAMPS);
    state.stampsDrawn += drawn;

    if (gpu && renderer) {
      const u = gpu.material.uniforms;
      u.uPrev.value = gpu.read.texture;
      u.uCenter.value.set(state.centerX, state.centerY);
      u.uPrevCenter.value.set(state.prevCenterX, state.prevCenterY);
      u.uFade.value = fade;
      u.uStampCount.value = drawn;
      for (let i = 0; i < drawn; i += 1) {
        const p = pending[i];
        gpu.stamps[i].set(p.x, p.y, p.r, p.s);
      }
      let prevTarget = null;
      let prevAutoClear = true;
      try {
        prevTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
        prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(gpu.write);
        renderer.render(gpu.scene, gpu.camera);
        state.gpuFrames += 1;
      } catch (_) { /* fail-soft: a dropped frame is not a broken client */ } finally {
        try { renderer.setRenderTarget(prevTarget); } catch (_) {}
        try { renderer.autoClear = prevAutoClear; } catch (_) {}
      }
      // Ping-pong. `uniforms.uTrailMap` is bound BY REFERENCE by consumers, so
      // swapping `.value` here is what makes them see this frame's result.
      const t = gpu.read;
      gpu.read = gpu.write;
      gpu.write = t;
      uniforms.uTrailMap.value = gpu.read.texture;
    }

    pending.length = 0;
    state.prevCenterX = state.centerX;
    state.prevCenterY = state.centerY;
  }

  /**
   * Release both render targets, the stamp program and the quad geometry.
   *
   * ⚠ OWNERSHIP GAP (2026-08-03 review): the ONLY caller in the tree is
   * `terrain_vfx.js::_resetTerrainVfx()`, whose own docstring labels it
   * "Test seam". `initTerrainVfx` has no re-entry guard, so a second init
   * (renderer re-create, WebGL context recovery, a 3D→2D→3D flip) orphans two
   * WebGLRenderTargets plus this program and geometry — and "GC reclaims GPU"
   * is false for three.js, the lesson R3#6 already paid for with the nameplate
   * cache. Wiring a real teardown call belongs in terrain_vfx.js, which is
   * outside this task's file ownership; flagged rather than reached into.
   * dispose() itself is idempotent, so the fix there is a one-liner.
   */
  function dispose() {
    pending.length = 0;
    if (!gpu) return;
    try { gpu.read.dispose(); } catch (_) {}
    try { gpu.write.dispose(); } catch (_) {}
    try { gpu.geom.dispose(); } catch (_) {}
    try { gpu.material.dispose(); } catch (_) {}
    try { gpu.scene.remove(gpu.quad); } catch (_) {}
    gpu = null;
    uniforms.uTrailMap.value = null;
    uniforms.uTrailEnabled.value = 0;
  }

  function stats() {
    return {
      name: state.name,
      gpu: !!gpu,
      resolution,
      radiusM,
      recoverySec,
      texelM,
      centerX: state.centerX,
      centerY: state.centerY,
      centered: state.centered,
      frames: state.frames,
      gpuFrames: state.gpuFrames,
      stampsQueued: state.stampsQueued,
      stampsDrawn: state.stampsDrawn,
      stampsDropped: state.stampsDropped,
      pending: pending.length,
      clears: state.clears,
      teleportClears: state.teleportClears,
      lastFade: state.lastFade,
    };
  }

  return {
    uniforms,
    get texture() { return gpu ? gpu.read.texture : null; },
    get hasGpu() { return !!gpu; },
    setCenter,
    stamp,
    update,
    clear,
    dispose,
    stats,
    // Test seam: the raw CPU state. Read-only by convention.
    _state: state,
    _pending: pending,
  };
}
