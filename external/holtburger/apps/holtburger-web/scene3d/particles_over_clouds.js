// scene3d/particles_over_clouds.js — `?particlesOverClouds` (2026-10-07,
// DEFAULT ON, `=off` escape). The zero-dependency half: the flag, the registry
// particle_manager.js hands its draw objects to, and the per-frame collect.
// The composer half (the split post chain and the late draw pass) lives in
// atmosphere_pipeline.js.
//
// THE BUG (owner, 1070 playtest: "clouds are over particle effect shouldnt
// be"). With `?cloudsMainPass` (default on since 2026-10-05) the volumetric
// clouds are composited by AerialPerspectiveEffect INSIDE the post chain,
// AFTER the world RenderPass. Particles are drawn in that world pass with
// `depthWrite: false` (additive) so where a fire plume, spell or portal swirl
// covers the sky the depth buffer still holds the far plane; CloudsEffect
// raymarches to infinity on those pixels and AerialPerspective lays the cloud
// (`rgb * (1 - overlay.a) + overlay.rgb`, or `outputColor = overlay` for opaque
// cloud) over a pixel that already contains the particle. The composite is
// cloud OVER (particle OVER sky); it must be particle OVER (cloud OVER sky).
// The legacy overlay path (`?cloudsMainPass=off`) does not have the bug: its
// quad is drawn by the SKY pass, before the world.
//
// THE FIX. Particles are drawn AFTER the cloud + aerial composite, still in
// HDR, still before bloom/vignette/tone mapping:
//
//   EffectPass[HeatHaze, Clouds, AerialPerspective]  -> private target T
//   ParticlesOverClouds: the particle draw objects   -> T, depth-tested
//                        against the composer's scene depth texture
//   EffectPass[Bloom, Vignette, ToneMapping, Dithering]  reads T
//
// Each frame the pipeline collects the particle draw objects (instanced
// buckets + per-mesh slot meshes) from the sources registered here, hides them
// (`visible = false`) for the composer's world pass, then draws exactly those
// objects in the late pass and restores them. Nothing is reparented and no
// layer mask changes, so every other render of the main scene (the direct
// fallback path, wireframe, `?atmosphere=off`) and every test that inspects the
// scene graph sees the old structure.
//
// NOT collected (stay in the world pass, i.e. behind the clouds):
//   - the sky chain (`skyGlow` nebula sheets, the storm lightning box): owner
//     rule 2026-10-07, "very subtle gaseous and never blocked the clouds";
//   - lit materials (`?particleUnlit=off`): the late scene has no lights;
//   - anything not visible, detached from the scene, under a hidden ancestor, or
//     off the camera's layer mask (the world pass would not have drawn it).
//
// No imports: particle_manager.js registers into this module and must not pull
// postprocessing / takram into the lazily loaded particles chunk.

const OFF_FORMS = new Set(["off", "0", "false", "no"]);

/**
 * `?particlesOverClouds` — DEFAULT ON (absent / garbage ⇒ on); `off|0|false|no`
 * restores the legacy single post-chain pass with particles in the world pass.
 * @param {string} [search] test seam; defaults to `location.search`
 * @returns {boolean}
 */
export function particlesOverCloudsEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("particlesOverClouds");
    if (v == null) return true;
    return !OFF_FORMS.has(String(v).trim().toLowerCase());
  } catch (_) {
    return true;
  }
}

// ── Source registry ──────────────────────────────────────────────────────────
// A source is `(out: Object3D[]) => void` and pushes candidate draw objects.
// Registered at module load by particle_manager.js (every ParticleManager plus
// the shared alpha buckets) and play_effect_vfx.js (the live placeholder spell
// bursts). Candidates are filtered by `collectLateFx`.
const _sources = new Set();

/** Register a late-FX source. Idempotent. Returns an unregister function. */
export function registerLateFxSource(fn) {
  if (typeof fn !== "function") return () => {};
  _sources.add(fn);
  return () => _sources.delete(fn);
}

export function unregisterLateFxSource(fn) {
  return _sources.delete(fn);
}

export function lateFxSourceCount() {
  return _sources.size;
}

/**
 * three r184 `materialNeedsLights` (WebGLRenderer). Such a material in the
 * light-less late scene would render black, so it stays in the world pass.
 */
export function materialNeedsLights(m) {
  if (!m) return false;
  return !!(m.isMeshLambertMaterial || m.isMeshToonMaterial || m.isMeshPhongMaterial ||
    m.isMeshStandardMaterial || m.isShadowMaterial || (m.isShaderMaterial && m.lights === true));
}

/** True when the world pass would draw `o`: visible up to `root`, attached to it. */
function _drawnUnder(o, root) {
  for (let p = o; p; p = p.parent) {
    if (p.visible === false) return false;
    if (p === root) return true;
  }
  return false;
}

const _seen = new Set();

/**
 * Collect this frame's late-FX draw objects into `out` (cleared first): every
 * registered source's candidates, deduped, minus anything the world pass would
 * not have drawn and anything with a lit material.
 *
 * @param {object[]} out reused array
 * @param {object} root the main scene (ancestry + visibility root)
 * @param {number} layerMask the world pass's camera layer mask
 * @param {object} [stats] optional counters ({candidates, rejectedLit, sourceErrors})
 * @returns {object[]} `out`
 */
export function collectLateFx(out, root, layerMask, stats = null) {
  out.length = 0;
  for (const fn of _sources) {
    try { fn(out); } catch (_) { if (stats) stats.sourceErrors = (stats.sourceErrors | 0) + 1; }
  }
  if (stats) stats.candidates = out.length;
  let w = 0;
  let lit = 0;
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    if (!o || _seen.has(o)) continue;
    _seen.add(o);
    if (!o.layers || (o.layers.mask & layerMask) === 0) continue;
    if (!_drawnUnder(o, root)) continue;
    const m = o.material;
    if (!m) continue;
    if (Array.isArray(m) ? m.some(materialNeedsLights) : materialNeedsLights(m)) { lit++; continue; }
    out[w++] = o;
  }
  out.length = w;
  _seen.clear();
  if (stats) stats.rejectedLit = lit;
  return out;
}
