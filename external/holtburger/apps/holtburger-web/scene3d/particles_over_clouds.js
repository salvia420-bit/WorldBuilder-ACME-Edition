// scene3d/particles_over_clouds.js — `?particlesOverClouds` (2026-10-07,
// DEFAULT ON, `=off` escape). The zero-dependency half: the flag, the registry
// particle_manager.js hands its draw objects to, and the per-frame collect —
// plus (2026-10-20, `?lateFxWarm`) the late / glow program warm the tunnel
// runs (`warmLateFx`, bottom of the file). The composer half (the split post
// chain and the late draw pass) lives in atmosphere_pipeline.js.
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

/**
 * `?particlesOverHaze` — SKY-1 remainder (2026-10-18 follow-up). DEFAULT ON
 * (absent / garbage ⇒ on, owner rule: no eye-test gate); `off|0|false|no`
 * keeps the particles in the world pass. It changes the low / mid frame: the
 * particles leave the MSAA world target and draw after, not sorted with, the
 * other world transparents. The UNSPLIT chain (no clouds in the post chain: low / mid, or
 * `?clouds=off`, `?cloudsMainPass=off`, `?particlesOverClouds=off`) draws the
 * same particle objects right after the `?layerHaze` pass, into the buffer the
 * haze wrote, so the haze no longer fogs them by the depth behind them. No
 * private target there (atmosphere_pipeline.js, ParticlesOverCloudsPass
 * `ownTarget: false`).
 * @param {string} [search] test seam; defaults to `location.search`
 * @returns {boolean}
 */
export function particlesOverHazeEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("particlesOverHaze");
    if (v == null) return true;
    return !OFF_FORMS.has(String(v).trim().toLowerCase());
  } catch (_) {
    return true;
  }
}

// ── Source registry ──────────────────────────────────────────────────────────
// A source is `(out: Object3D[], opts?) => void` and pushes candidate draw
// objects. Registered at module load by particle_manager.js (every
// ParticleManager plus the shared alpha buckets) and play_effect_vfx.js (the
// live placeholder spell bursts). Candidates are filtered by `collectLateFx`.
// 2026-10-20 (improvement hunt streaming-hitch-1): `opts` is `{ all: true }`
// only from the program warm (`collectLateFxAll`): push EVERY draw object you
// hold — parked (count 0), hidden, detached — not just this frame's. A source
// whose objects exist only while drawn (or that ignores `opts`) is fine: it
// just gives the warm less. The per-frame collect never passes `opts`.
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

// ── Late-pass hooks (2026-10-09, `?particleFx` soft particles) ───────────────
// `{ before(renderer, depthTexture, camera), after() }` pairs the late pass
// calls around its particle draw. particle_fx.js registers one to copy the
// scene depth (attached to the late target, so not sampleable during the draw)
// into a linear-depth texture for soft particles. Kept here so the composer
// never imports the particles chunk.
const _hooks = new Set();

/** Register a late-pass hook pair. Idempotent per object. Returns an unregister function. */
export function registerLateFxHooks(h) {
  if (!h || (typeof h.before !== "function" && typeof h.after !== "function")) return () => {};
  _hooks.add(h);
  return () => _hooks.delete(h);
}

/**
 * Before the late draw (target not yet bound). `width`/`height` are the late
 * target's pixel size (what gl_FragCoord addresses during the draw). Never throws.
 */
export function runLateFxBefore(renderer, depthTexture, camera, width, height) {
  for (const h of _hooks) {
    if (typeof h.before !== "function") continue;
    try { h.before(renderer, depthTexture, camera, width, height); } catch (_) { /* a hook never breaks the frame */ }
  }
}

/** After the late draw, always (also when it was skipped). Never throws. */
export function runLateFxAfter() {
  for (const h of _hooks) {
    if (typeof h.after !== "function") continue;
    try { h.after(); } catch (_) { /* a hook never breaks the frame */ }
  }
}

export function lateFxHookCount() {
  return _hooks.size;
}

// ── Tier-1 `?fxGlow` provider (2026-10-10) ───────────────────────────────────
// The composer's glow effect (vfx/fx_glow_effect.js) draws every additive FX
// bucket a second time, into its own half-res glow buffer. The composer must
// not import the particles chunk, so particle_manager.js registers a provider:
//   collect(out, opts) push the additive FX buckets that hold instances
//                     (`opts.all`, the program warm: every additive FX bucket)
//   materialFor(im)   that bucket's glow-variant material (cached on the bucket)
//   setFrame(opts)    per-frame glow uniforms (scene depth, size, decode, strength)
let _glowProvider = null;

/** Register the glow provider (one; the latest wins). Returns an unregister function. */
export function registerFxGlowProvider(p) {
  if (!p || typeof p.collect !== "function" || typeof p.materialFor !== "function") return () => {};
  _glowProvider = p;
  return () => { if (_glowProvider === p) _glowProvider = null; };
}

/** The registered glow provider, or null before the particles chunk loaded. */
export function fxGlowProvider() {
  return _glowProvider;
}

// ── Tier-2 glow extras (2026-10-10) ──────────────────────────────────────────
// Non-bucket objects that also send light to the glow buffer: the ambient
// fireflies (vfx/fx_fields.js) and the level-up lens flare (vfx/fx_showcase.js).
// A source is `{ collect(out, opts?), setFrame?(opts) }`; `collect` pushes
// `{ object, material }` pairs — the glow effect draws a twin of `object`
// (same geometry, same matrixWorld) with `material`, after calling the
// source's `setFrame` with the glow pass's frame inputs (scene depth, size,
// depth decode, strength), exactly what the bucket provider gets. `collect`
// gets `{ all: true }` from the program warm only (see the source registry).
const _glowExtras = new Set();

/** Register a glow-extras source. Idempotent. Returns an unregister function. */
export function registerFxGlowExtras(src) {
  if (!src || typeof src.collect !== "function") return () => {};
  _glowExtras.add(src);
  return () => _glowExtras.delete(src);
}

/** The registered glow-extras sources (the glow effect iterates them). */
export function fxGlowExtraSources() {
  return _glowExtras;
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

// ── Late-FX program warm (2026-10-20, improvement hunt streaming-hitch-1) ────
// `?lateFxWarm` — DEFAULT ON (absent / garbage ⇒ on), `off|0|false|no` escape.
//
// THE GAP. The late pass draws into its own Scene (atmosphere_pipeline.js
// ParticlesOverCloudsPass.render: `scene.fog = worldScene.fog; scene.children =
// objs`) — a scene with NO lights — and three r184 puts the light counts
// (numDirLights … numLightProbes) into EVERY program key, MeshBasic and
// ShaderMaterial included (WebGLPrograms getProgramCacheKeyParameters).
// compile() never sets `materialProperties.__version`, so the first real draw
// of a material always re-derives its key from the scene it is drawn in. No
// warm built that key:
//   - the tunnel warm (portal_space.js warmWorldPrograms) visits the late pass
//     as a scene pass, but between frames its `children` is the empty
//     `_noChildren`: 0 materials;
//   - the same warm compiles the (hidden) buckets in the MAIN scene, with the
//     world's lights — the variant a split (indoor / doorway punch) frame draws
//     them with, never the late one;
//   - the `?fxGlow` twins (vfx/fx_glow_effect.js) draw in another light-less,
//     fog-less private scene (`glowScene`) and only exist once drawn;
//   - asyncLink defers main-scene draws only (async_link_guard.js), so a late
//     or glow draw whose program is missing links synchronously, in-frame —
//     the first sight of each FX class (1070 10-11 bench, ultra: frames over
//     100 ms 15.5 with legacy FX vs 37 with all FX; unattributed share).
// THE WARM. `warmLateFx` asks every source for ALL its objects (`{all: true}`:
// a parked or hidden bucket draws with the same program once shown), lends
// them to the late pass's own Scene with the world's Fog object — the exact key
// the late draw derives: no lights, the same fog — compiles them against a
// non-null target (the late target T / the composer buffer: same target class),
// and puts the Scene back. Likewise every glow twin, in the glow scene. Real
// objects only, no proxies: a placeholder geometry changes the key (its
// attributes are key bits) and a new FX material would latch particle_fx.js's
// tier variants (`_tier1Variant`, at the FIRST FX material) before the CSM
// state exists. The FX key per blend is constant, and three shares a program
// by key, so one warmed bucket of a class also covers the buckets of that
// class made later. Pixel-identical: compile only, nothing drawn, every
// borrowed field restored.

let _lateFxWarmOn = null;

/**
 * `?lateFxWarm` — DEFAULT ON; `off|0|false|no` skips the late / glow program
 * warm (those programs link at their first draw, as before). Memoised.
 * @param {string} [search] test seam; defaults to `location.search` (memoised)
 * @returns {boolean}
 */
export function lateFxWarmEnabled(search) {
  const read = (s) => {
    try {
      const v = new URLSearchParams(s).get("lateFxWarm");
      if (v == null) return true;
      return !OFF_FORMS.has(String(v).trim().toLowerCase());
    } catch (_) {
      return true;
    }
  };
  if (typeof search === "string") return read(search);
  if (_lateFxWarmOn === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    _lateFxWarmOn = read(s);
  }
  return _lateFxWarmOn;
}

/** Test / A-B seam: force the flag (`null` re-reads the URL on next use). */
export function setLateFxWarmFlag(on) {
  _lateFxWarmOn = on == null ? null : !!on;
}

const LATE_FX_ALL = Object.freeze({ all: true });

/**
 * Every late-FX draw object the sources HOLD (the program warm): each source
 * gets `{all: true}`. Deduped; lit materials dropped (they never draw in the
 * late pass). No visibility / ancestry / layer filter: none of those is a
 * program-key bit.
 * @param {object[]} out reused array (cleared first)
 * @returns {object[]} `out`
 */
export function collectLateFxAll(out) {
  out.length = 0;
  for (const fn of _sources) {
    try { fn(out, LATE_FX_ALL); } catch (_) { /* a source never breaks the warm */ }
  }
  let w = 0;
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    if (!o || _seen.has(o)) continue;
    _seen.add(o);
    const m = o.material;
    if (!m) continue;
    if (Array.isArray(m) ? m.some(materialNeedsLights) : materialNeedsLights(m)) continue;
    out[w++] = o;
  }
  out.length = w;
  _seen.clear();
  return out;
}

/**
 * Every glow twin the `?fxGlow` effect can draw (the program warm), as
 * `{ object, material, instanced }`: the provider's additive FX buckets
 * (`instanced`: the effect's InstancedMesh twin, `materialFor` = the glow
 * variant the effect would draw it with) and the glow extras (a plain Mesh
 * twin) — all of them, drawn or not.
 * @param {object[]} out reused array (cleared first)
 * @returns {object[]} `out`
 */
export function collectFxGlowAll(out) {
  out.length = 0;
  const p = _glowProvider;
  if (p) {
    const list = [];
    try { p.collect(list, LATE_FX_ALL); } catch (_) { list.length = 0; }
    for (const b of list) {
      if (!b || !b.geometry || _seen.has(b)) continue;
      _seen.add(b);
      let mat = null;
      try { mat = p.materialFor(b); } catch (_) { mat = null; }
      if (mat) out.push({ object: b, material: mat, instanced: true });
    }
    _seen.clear();
  }
  for (const src of _glowExtras) {
    const list = [];
    try { src.collect(list, LATE_FX_ALL); } catch (_) { continue; }
    for (const e of list) {
      if (e && e.object && e.object.geometry && e.material) out.push({ object: e.object, material: e.material, instanced: false });
    }
  }
  return out;
}

// source object → its warm-only glow twin (never drawn, never parented).
const _glowWarmTwins = new WeakMap();

/**
 * The twin fx_glow_effect.js would draw for `e`, built from the source object's
 * own class (this module imports nothing): a bucket's is
 * `new InstancedMesh(bucket.geometry, glowMat, 1)` sharing the bucket's
 * instanceMatrix / instanceColor (FxGlowEffect._twin); an extra's is
 * `new Mesh(object.geometry, material)` — only taken when the object IS a plain
 * Mesh, whose constructor that is. null when the shape does not match (that
 * twin links at its first draw, as before). (three r184 sets `type` in Mesh
 * and SkinnedMesh only — an InstancedMesh / BatchedMesh also reads "Mesh",
 * hence the is* flags.)
 */
function _glowWarmTwin(e) {
  const o = e.object;
  const okShape = e.instanced
    ? o.isInstancedMesh === true && !o.isSkinnedMesh && !o.isBatchedMesh
    : o.isMesh === true && o.type === "Mesh" && !o.isInstancedMesh && !o.isSkinnedMesh && !o.isBatchedMesh;
  if (!okShape || typeof o.constructor !== "function") return null;
  let t = _glowWarmTwins.get(o);
  if (!t || t.geometry !== o.geometry) {
    try {
      t = e.instanced ? new o.constructor(o.geometry, e.material, 1) : new o.constructor(o.geometry, e.material);
    } catch (_) {
      return null;
    }
    t.frustumCulled = false;
    t.matrixAutoUpdate = false;
    _glowWarmTwins.set(o, t);
  }
  t.material = e.material;
  if (e.instanced) {
    t.instanceMatrix = o.instanceMatrix;
    t.instanceColor = o.instanceColor;
  }
  return t;
}

const _warmObjs = [];
const _warmGlow = [];
const _warmTwins = [];

// Lend `objs` to `scene` (children + fog) for one warm call; always restored.
function _warmInScene(renderer, scene, objs, fog, camera, opts) {
  const prevChildren = scene.children;
  const prevFog = scene.fog;
  try {
    scene.children = objs;
    scene.fog = fog;
    const r = opts.warm(renderer, scene, camera, opts.target, opts.seen instanceof WeakMap ? { seen: opts.seen } : {});
    return { compiled: (r && r.compiled) | 0, materials: (r && r.materials) || null };
  } catch (_) {
    return { compiled: 0, materials: null }; // links at its first draw, as before
  } finally {
    scene.children = prevChildren;
    scene.fog = prevFog;
  }
}

/**
 * Warm the late-pass and glow programs (see the block comment above). Runs
 * outside render() (compile resets three's render state); starts links only.
 *
 * @param {object} renderer THREE.WebGLRenderer
 * @param {object} camera the late pass's camera (the key does not depend on it)
 * @param {{
 *   scene?: object,      // the late pass's private Scene (ParticlesOverCloudsPass.scene); omit = no late pass
 *   fog?: object|null,   // the world scene's Fog (the late draw shares the OBJECT)
 *   target: object,      // a non-null target (shader_prewarm getWarmTarget()); null ⇒ nothing is warmed
 *   warm: Function,      // shader_prewarm warmSceneMaterials (injected: this module imports nothing)
 *   seen?: WeakMap,      // the warm memo (material → keys compiled)
 *   glowScene?: object,  // FxGlowEffect.glowScene when `?fxGlow` built the effect; omit = none
 * }} opts
 * @returns {{objects: number, compiled: number, materials: Set|null,
 *   glowObjects: number, glowCompiled: number, glowMaterials: Set|null}}
 */
export function warmLateFx(renderer, camera, opts = {}) {
  const res = { objects: 0, compiled: 0, materials: null, glowObjects: 0, glowCompiled: 0, glowMaterials: null };
  if (!lateFxWarmEnabled() || !renderer || !camera || !opts || typeof opts.warm !== "function" || !opts.target) return res;
  const scene = opts.scene;
  if (scene && scene.isScene === true) {
    const objs = collectLateFxAll(_warmObjs);
    res.objects = objs.length;
    if (objs.length) {
      const r = _warmInScene(renderer, scene, objs, opts.fog ?? null, camera, opts);
      res.compiled = r.compiled;
      res.materials = r.materials;
    }
    objs.length = 0;
  }
  const glowScene = opts.glowScene;
  if (glowScene && glowScene.isScene === true) {
    const entries = collectFxGlowAll(_warmGlow);
    const twins = _warmTwins;
    twins.length = 0;
    for (const e of entries) {
      const t = _glowWarmTwin(e);
      if (t) twins.push(t);
    }
    res.glowObjects = twins.length;
    if (twins.length) {
      // The glow scene's own fog (none): the glow draw renders that scene as is.
      const r = _warmInScene(renderer, glowScene, twins, glowScene.fog ?? null, camera, opts);
      res.glowCompiled = r.compiled;
      res.glowMaterials = r.materials;
    }
    twins.length = 0;
    entries.length = 0;
  }
  return res;
}
