// Sky pass host (originally the parametric Sky-D dome + celestial-body
// renderer, gutted in K.6 cleanup).
//
// Before K.6: hosted a 32×16 gradient sphere (Sky-D), parametric
// SkyObject rotators (Sky-E/G — sun, moon, cloud bands, stars,
// weather streaks fetched from client_portal.dat via Sky-Assets +
// populateCelestialBodies), per-celestial particle chains (Sky-J P5),
// natural-sky override path (__naturalSky), and a horizon-gradient
// uniform sink driven by SkyLightingController.skyBackgroundColor.
// Roughly 1,876 LoC.
//
// After K.6: the takram atmosphere stack (SkyMaterial + stars +
// AerialPerspective + volumetric clouds) is the sole renderer of
// every celestial element. The parametric DAT-driven path is gone.
// This module's only remaining job is to host the sky-pass scene
// (`skyScene`) + sky-pass camera (`skyCamera`) so atmosphere_sky,
// ac_moons, aurora, and cloud_overlay have a common parent for the
// pre-world render pass, and to drive the per-frame indoor flip +
// cloud-overlay tick.
//
// Class name `SkyDome` is preserved for backward compatibility with
// the existing `liveScene3d.skyDome` access patterns from before K.6.

import * as THREE from "three";

const SKY_CAMERA_NEAR = 0.1;
const SKY_CAMERA_FAR = 50000.0;
// SKY-SEEN-OUTSIDE (2026-08-04) — `?skySeenOutside` (default ON; `=off`
// escape). See the `_lastSkyBlocked` comment in tick().
const SKY_SEEN_OUTSIDE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("skySeenOutside")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// Scratch for the sky-bird anchor placement (per-rAF; never allocate in tick).
const _skyBirdPosScratch = new THREE.Vector3();

// === W1 — parametric weather SkyObject billboard host (2026-05-29) ======
//
// Retail weather is per-DayGroup SkyObjects (streak GfxObjs 0x01004C42/44,
// SetupModel rain 0x02000588/... carrying PhysicsScript droplets) gated by
// a begin/end time-window + a `properties` bitmask. The parametric renderer
// that drew these was gutted in K.6, leaving `setParametricSkyObjectsVisible`
// a no-op. This host re-adds a MINIMAL version: for the weather/cloud
// SkyObjects in the active DayGroup that are visible in the current window,
// it draws a UV-scrolling billboard on the sky dome (texOffsetX/Y from the
// already-decoded tex_velocity drives the texture scroll; 0x01 → additive
// blend, else alpha). It is conservatively flag-gated (`?skyWeather=on`) and
// fully fail-soft — any missing piece silently no-ops to current behavior.
//
// Properties bits (validated in sky.rs probe vs real client_portal.dat):
//   0x01 = additive blend, 0x02 = scrolling cloud band, 0x04 = weather
//   streak, 0x08 = PhysicsScript-bound.
const SKY_PROP_ADDITIVE = 0x01;
const SKY_PROP_CLOUD_BAND = 0x02;
const SKY_PROP_WEATHER_STREAK = 0x04;
// A billboard is a "weather/cloud" object iff it carries the cloud-band OR
// weather-streak bit. (PhysicsScript droplets — 0x08 / 0x02xxxxxx — are NOT
// drawn here; see the TODO in `_ensureWeatherPool`.)
const SKY_WEATHER_MASK = SKY_PROP_CLOUD_BAND | SKY_PROP_WEATHER_STREAK;

// Max distinct weather billboards we'll host. Retail Dereth DayGroups carry
// a single cloud band + at most a couple of weather streaks, so a small
// fixed pool covers it; extras silently overflow (no-op).
const WEATHER_POOL_SIZE = 4;
// Billboard placement on the dome: a large quad parked high above the
// camera, tilted to face down toward the player. Sized to fill a wide swath
// of sky without clipping the SkyMaterial backdrop.
const WEATHER_BILLBOARD_SIZE = 9000.0;
const WEATHER_BILLBOARD_ALTITUDE = 3500.0;

// --- Takram-environment radiance compensation -----------------------------
// The weather billboards live in `skyScene`, which renders one of TWO ways
// depending on whether the takram atmosphere stack has loaded:
//   • atmosphere OFF / not-yet-loaded → SkyDome.renderSkyPass does a direct
//     `renderer.render(skyScene)` in LDR. A MeshBasicMaterial streak at its
//     authored ~0.8 grey reads correctly.
//   • atmosphere ON → `skyScene` is a RenderPass INSIDE the EffectComposer
//     (atmosphere_pipeline.js:163-166), so it flows through a HalfFloat HDR
//     buffer and the final AGX `ToneMappingEffect` (renderer itself is
//     NoToneMapping + exposure 5). Against the physically-scaled HDR sky
//     radiance, an LDR ~0.8 streak gets crushed to near-invisible by AGX —
//     unlike the cloud overlay, which composites AFTER the composer and so
//     dodges the tonemap entirely.
// Fix: when the atmosphere pipeline is live we boost the billboard color
// into HDR so AGX maps it back up into the visible range. `atmospherePipeline`
// is null until the Bruneton bake completes, so reading it per-frame also
// rides the lazy-load transition (LDR → HDR) cleanly. The exact HDR gain is
// an eye-test tuning knob on the 1070 (atmosphere is offline here): default
// is conservative; override with `?skyWeatherGain=<float>`.
const WEATHER_GAIN_LDR = 1.0;
const WEATHER_GAIN_HDR_DEFAULT = 3.5;

/**
 * Parse `?skyWeather=on` once. Returns true only for the literal value
 * "on" (case-insensitive). Mirrors the URL-flag pattern used across the
 * scene (try/catch so the Node harness without `window` doesn't throw).
 */
let _skyWeatherFlagCache;
function readSkyWeatherFlag() {
  if (_skyWeatherFlagCache !== undefined) return _skyWeatherFlagCache;
  try {
    if (typeof window === "undefined" || !window.location) {
      _skyWeatherFlagCache = false;
      return false;
    }
    const v = new URLSearchParams(window.location.search).get("skyWeather");
    _skyWeatherFlagCache = typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    _skyWeatherFlagCache = false;
  }
  return _skyWeatherFlagCache;
}

/**
 * Parse `?skyWeatherGain=<float>` once — the HDR radiance boost applied to
 * weather billboards when the takram atmosphere composer is driving the sky
 * pass (so AGX tonemapping doesn't crush them). Falls back to the
 * conservative default; ignored (1.0) on the legacy LDR path.
 */
let _skyWeatherGainCache;
function readSkyWeatherHdrGain() {
  if (_skyWeatherGainCache !== undefined) return _skyWeatherGainCache;
  let g = WEATHER_GAIN_HDR_DEFAULT;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("skyWeatherGain");
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n > 0) g = n;
    }
  } catch (_) { /* Node harness / no window → default */ }
  _skyWeatherGainCache = g;
  return g;
}

// === Task #4 (2026-06-23) — sky-object particle (bird/aurora) chain ==========
//
// Region SkyObjects carry a `default_pes` (0x33 PhysicsScript) that walks to
// ParticleType.Swarm emitters — the "birds in the sky" (e.g. 0x330007db →
// 0x32000455/456/457). The W1 weather path above draws billboards only and
// never walked this chain (its own TODO), so the sky swarms never rendered.
// `?skyBirds` is **default-ON** (2026-06-23 user directive); `?skyBirds=off` is
// the escape. Wires the chain via the shared scenery ParticleManager + chain
// walker (`statics.js::attachSkyParticleChain`), anchored to a camera-following
// group so the swarm orbits overhead. `?skyBirdAlt=<m>` tunes the overhead
// altitude (AC Z-up). Reuses the fixed Swarm trajectory + CallPES loop +
// gfxobj→surface material from tasks #1-#3. (Visual still pending a 1070 A/B;
// shipped default-on per directive, `=off` reverts to the empty-sky behavior.)
const SKY_BIRD_ALTITUDE_DEFAULT = 40.0;
let _skyBirdsFlagCache;
function readSkyBirdsFlag() {
  if (_skyBirdsFlagCache !== undefined) return _skyBirdsFlagCache;
  let on = true; // default-on; only `?skyBirds=off` disables.
  try {
    if (typeof window !== "undefined" && window.location) {
      on = new URLSearchParams(window.location.search)
        .get("skyBirds")?.toLowerCase() !== "off";
    }
  } catch (_) { on = true; }
  _skyBirdsFlagCache = on;
  return on;
}
let _skyBirdAltCache;
function readSkyBirdAltitude() {
  if (_skyBirdAltCache !== undefined) return _skyBirdAltCache;
  let a = SKY_BIRD_ALTITUDE_DEFAULT;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("skyBirdAlt");
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n)) a = n;
    }
  } catch (_) { /* default */ }
  _skyBirdAltCache = a;
  return a;
}

/**
 * Build a small procedural streak texture (vertical translucent streaks on
 * a transparent ground) used for the UV-scrolling weather billboards. The
 * real DAT GfxObj texture-resolution pipeline (Sky-Assets) was removed in
 * K.6, so we synthesize a streak field that reads as a weather band when
 * scrolled. Returns null if no DOM canvas is available (Node harness).
 */
function buildStreakTexture() {
  if (typeof document === "undefined" || !document.createElement) return null;
  const W = 128, H = 128;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, H);
  // Scatter ~70 vertical streaks of varying length/alpha.
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * W;
    const len = 8 + Math.random() * 40;
    const y = Math.random() * H;
    const a = 0.15 + Math.random() * 0.45;
    const grad = ctx.createLinearGradient(x, y, x, y + len);
    grad.addColorStop(0, `rgba(200,214,230,0)`);
    grad.addColorStop(0.5, `rgba(200,214,230,${a})`);
    grad.addColorStop(1, `rgba(200,214,230,0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.6 + Math.random() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6); // tile so scrolling reads as a dense field
  tex.needsUpdate = true;
  return tex;
}

/**
 * Minimal sky-pass host. Owns the scene + camera that atmosphere_sky
 * (takram SkyMaterial + stars), ac_moons (AC moon billboards),
 * aurora (Hagol overlay), and cloud_overlay (volumetric clouds)
 * paint into during the pre-world render pass.
 */
export class SkyDome {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene — root world scene (kept for API
   *   compat with the prior dome implementation; unused post-K.6).
   * @param {Function} [opts.sessionHandleAccessor] — `() => SessionHandle
   *   | null`. Called each tick to fetch the wasm handle that exposes
   *   `isCurrentCellIndoor()` — the indoor short-circuit gate for
   *   skipping the sky render pass when the player is inside a
   *   dungeon / building.
   * @param {Object} [opts.liveScene3dRef] — reference to the live
   *   scene3d hash; used to pull the cached SkyState
   *   (`skyLightingController._lastState`) and forward it into
   *   `cloudOverlay.tick(state)` without a second wasm call.
   */
  constructor(opts) {
    const { scene, sessionHandleAccessor, liveScene3dRef = null } = opts || {};
    if (!scene) {
      throw new Error("SkyDome: opts.scene required");
    }
    this.scene = scene;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === "function"
        ? sessionHandleAccessor
        : () => null;
    this.liveScene3dRef = liveScene3dRef;

    // === Sky scene + camera (separate render pass) ====================
    //
    // The sky pass renders BEFORE the world pass in
    // atmosphere_pipeline.js's EffectComposer. It clears color + depth,
    // then renders this scene with this camera (which mirrors the main
    // camera each tick via syncSkyCamera). The subsequent world pass
    // runs with `clear=false, clearDepth=true` so sky color is
    // preserved and world depth-tests fresh.
    this.skyScene = new THREE.Scene();
    this.skyScene.name = "sky_scene";
    this.skyScene.fog = null;
    this.skyCamera = new THREE.PerspectiveCamera(
      60,
      1,
      SKY_CAMERA_NEAR,
      SKY_CAMERA_FAR,
    );
    this.skyCamera.name = "sky_camera";

    // === Sky cell (camera-anchored Group) =============================
    //
    // Kept as an empty Group for backward compatibility with code
    // paths that read `skyDome.skyCell` (e.g. atmosphere_sky.js's
    // detach() path). The cell still follows the main camera each
    // tick — useful if any future sky-internal mesh wants the
    // camera-anchored frame without each owner re-implementing the
    // copy.
    this.skyCell = new THREE.Group();
    this.skyCell.name = "sky_cell";
    this.skyCell.rotation.x = -Math.PI / 2;
    this.skyScene.add(this.skyCell);

    // Cloud overlay handle, attached lazily via setCloudOverlay().
    this.cloudOverlay = null;

    // === W1 — weather billboard host state ============================
    // Flag-gated (`?skyWeather=on`); pool + shared texture built lazily on
    // the first weather update so the default path pays nothing.
    this._skyWeatherEnabled = readSkyWeatherFlag();
    // Task #4 — sky-object Swarm particle chain (birds/aurora). Default OFF.
    this._skyBirdsEnabled = readSkyBirdsFlag();
    this._skyBirdAltitude = readSkyBirdAltitude();
    this._skyBirdAnchor = null;        // lazy camera-following THREE.Group
    this._skyBirdChainsAttached = null; // Set<pesObjectId>, lazy
    this._skyBirdChainWarned = false;
    this._weatherPool = null;     // THREE.Mesh[] or null until built
    this._weatherTex = null;      // shared CanvasTexture (cloned per-mesh)
    this._weatherTexBuilt = false;
    this._weatherVisibleCount = 0; // introspection for capture scripts
    // Takram-environment radiance gain (see WEATHER_GAIN_* above): boosts
    // billboard color into HDR when the atmosphere composer (AGX tonemap)
    // drives the sky pass, so streaks survive the tonemap. Default-soft on
    // the legacy LDR path. Per-frame re-evaluated from atmospherePipeline.
    this._weatherHdrGain = readSkyWeatherHdrGain();
    this._weatherAtmosActive = false; // last-seen atmosphere-pipeline state

    // Indoor short-circuit state. Read by renderSkyPass +
    // atmosphere_pipeline.preFrameSkySync.
    this._lastIsIndoor = false;
    this._lastSkyRendered = false;

    // Tick counters (capture scripts inspect these).
    this._tickCount = 0;
    this._indoorTickCount = 0;
  }

  /**
   * Attach the cloud overlay so its quad lives in the sky scene
   * (renderOrder=999, painted after every other sky-pass mesh) and
   * its per-frame tick runs from `SkyDome.tick`.
   *
   * @param {import('./cloud_overlay.js').CloudOverlay|null} cloudOverlay
   */
  setCloudOverlay(cloudOverlay) {
    this.cloudOverlay = cloudOverlay;
    if (cloudOverlay && typeof cloudOverlay.attachToSkyScene === "function") {
      cloudOverlay.attachToSkyScene(this.skyScene);
    }
  }

  /**
   * Master toggle for the W1 weather billboard host. Pre-K.6 this hid
   * every parametric SkyObject rotator; the rotators are gone, but W1
   * re-introduces a small weather-billboard pool, so this now hides /
   * shows that pool (and is the back-compat entry point any stale caller
   * may still hit). No-op when the pool hasn't been built or when the
   * `?skyWeather` flag is off.
   */
  setParametricSkyObjectsVisible(visible) {
    if (!this._weatherPool) return;
    const v = !!visible;
    for (const m of this._weatherPool) {
      if (m) m.visible = v && m.userData._weatherActive === true;
    }
  }

  /**
   * Lazily build the weather billboard pool the first time we have a
   * weather SkyObject to draw. Each entry is a large camera-facing quad
   * parked high on the dome with its own scrollable texture clone. Built
   * into `skyScene` so it renders in the pre-world sky pass alongside the
   * atmosphere + clouds. Returns false if the pool can't be built (no
   * canvas / no texture) so callers fail soft.
   *
   * TODO (W1 droplets): SetupModel rain (0x02xxxxxx + PhysicsScript
   * 0x33xxxxxx) carries near-camera droplet particles. Wiring those needs
   * the PhysicsScript → CreateParticleHook → ParticleEmitter chain walker
   * (reachable via the entities/play_effect_vfx executor) anchored to the
   * camera. Out of scope for W1's first cut — the near-camera synthetic
   * RainSystem already covers ground-level precipitation; this host draws
   * only the celestial-dome streak/cloud bands.
   */
  _ensureWeatherPool() {
    if (this._weatherPool) return true;
    if (!this._weatherTexBuilt) {
      this._weatherTexBuilt = true;
      this._weatherTex = buildStreakTexture();
    }
    if (!this._weatherTex) return false; // Node harness / no canvas
    const pool = [];
    for (let i = 0; i < WEATHER_POOL_SIZE; i++) {
      const tex = this._weatherTex.clone();
      tex.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const geom = new THREE.PlaneGeometry(
        WEATHER_BILLBOARD_SIZE,
        WEATHER_BILLBOARD_SIZE
      );
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `weather-skyobj-${i}`;
      mesh.frustumCulled = false;
      // Park high above the camera (sky pass camera tracks the main camera
      // each frame; sky scene is small so altitude in scene units is fine).
      mesh.position.set(0, WEATHER_BILLBOARD_ALTITUDE, 0);
      // Lay flat-ish so it reads as an overhead band rather than a wall.
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 980; // after sky material, before cloud overlay (999)
      mesh.visible = false;
      mesh.userData._weatherActive = false;
      mesh.userData._ownTex = tex;
      this.skyScene.add(mesh);
      pool.push(mesh);
    }
    this._weatherPool = pool;
    return true;
  }

  /**
   * W1 per-frame weather update. Driven from `loop.js::tickWeatherState`
   * with the active DayGroup's SkyObject snapshots
   * (`sessionHandle.getSkyObjectStates()`). For each weather/cloud
   * SkyObject that is visible in its time-window (the Rust `visible`
   * flag already applies the begin/end gate), bind a billboard, set its
   * blend mode from the additive bit, and scroll its texture by the
   * decoded `texOffsetX/Y` (which the Rust evaluator accumulates from
   * tex_velocity). Hidden entirely indoors and when `?skyWeather` is off.
   *
   * @param {Array|null} skyObjects  `getSkyObjectStates()` snapshot array
   * @param {boolean} indoor
   */
  updateWeatherSkyObjects(skyObjects, indoor) {
    if (!this._skyWeatherEnabled) return; // flag-gated (W1 conservative)
    // Indoor → hide everything (no weather through ceilings).
    if (indoor) {
      this._weatherVisibleCount = 0;
      if (this._weatherPool) {
        for (const m of this._weatherPool) {
          if (m) { m.visible = false; m.userData._weatherActive = false; }
        }
      }
      return;
    }
    if (!Array.isArray(skyObjects) || skyObjects.length === 0) {
      // No snapshot → leave whatever state we had; hide to fail soft.
      this._weatherVisibleCount = 0;
      if (this._weatherPool) {
        for (const m of this._weatherPool) {
          if (m) { m.visible = false; m.userData._weatherActive = false; }
        }
      }
      return;
    }

    // Takram radiance compensation: when the atmosphere composer is live the
    // sky pass is AGX-tonemapped, so boost billboard color into HDR; on the
    // legacy LDR direct-render path leave it at the authored value. Reading
    // `atmospherePipeline` here also rides the lazy-load LDR→HDR transition.
    const atmosActive = !!this.liveScene3dRef?.atmospherePipeline;
    this._weatherAtmosActive = atmosActive;
    const colorGain = atmosActive ? this._weatherHdrGain : WEATHER_GAIN_LDR;

    // Collect the visible weather/cloud SkyObjects for this frame.
    let slot = 0;
    let built = false;
    for (const o of skyObjects) {
      if (!o || slot >= WEATHER_POOL_SIZE) break;
      let visible, props, ox, oy;
      try {
        visible = !!o.visible;
        props = (o.properties >>> 0) || 0;
        ox = +o.texOffsetX;
        oy = +o.texOffsetY;
      } catch (_) {
        continue;
      }
      if (!visible) continue;
      if ((props & SKY_WEATHER_MASK) === 0) continue; // not weather/cloud

      if (!built) {
        if (!this._ensureWeatherPool()) return; // can't build → no-op
        built = true;
      }
      const mesh = this._weatherPool[slot];
      if (!mesh) break;
      const mat = mesh.material;
      const tex = mesh.userData._ownTex;
      // UV scroll from the accumulated tex_velocity offset ([0,1)).
      if (tex && tex.offset) {
        tex.offset.set(
          Number.isFinite(ox) ? ox : 0,
          Number.isFinite(oy) ? oy : 0
        );
      }
      // Blend mode: additive (0x01) for glow-y streaks, else normal alpha.
      const wantAdditive = (props & SKY_PROP_ADDITIVE) !== 0;
      const wantBlend = wantAdditive
        ? THREE.AdditiveBlending
        : THREE.NormalBlending;
      if (mat.blending !== wantBlend) {
        mat.blending = wantBlend;
        mat.needsUpdate = true;
      }
      // HDR/LDR radiance gain (takram AGX-aware). color is a plain uniform,
      // so no needsUpdate; guard only to skip the redundant setScalar.
      if (mesh.userData._appliedGain !== colorGain) {
        mat.color.setScalar(colorGain);
        mesh.userData._appliedGain = colorGain;
      }
      mesh.visible = true;
      mesh.userData._weatherActive = true;
      slot += 1;
    }

    // Hide any leftover pool entries not bound this frame.
    if (this._weatherPool) {
      for (let i = slot; i < this._weatherPool.length; i++) {
        const m = this._weatherPool[i];
        if (m) { m.visible = false; m.userData._weatherActive = false; }
      }
    }
    this._weatherVisibleCount = slot;
  }

  /**
   * Per-rAF tick. (1) anchor `skyCell` at the camera so any cell-
   * resident mesh stays compass-locked. (2) read the indoor flag
   * from wasm so renderSkyPass can short-circuit. (3) forward the
   * cached SkyState into the cloud overlay so it doesn't need its
   * own getSkyState() wasm call.
   *
   * @param {number} _dt
   * @param {THREE.Camera} camera
   */
  /**
   * Task #4 (2026-06-23) — realize Region SkyObject Swarm chains (the birds in
   * the sky). For each VISIBLE SkyObject carrying a `default_pes` (0x33), attach
   * its CreateParticle→ParticleEmitter(Swarm) chain ONCE to the camera-following
   * `_skyBirdAnchor`, via the shared scenery ParticleManager
   * (`statics.js::attachSkyParticleChain` — reuses the fixed Swarm trajectory,
   * the CallPES loop, and the gfxobj→surface material). Idempotent per
   * pesObjectId. Gated by `?skyBirds=on`; no-op without the snapshot/exports.
   * Called from loop.js::tickWeatherState with `getSkyObjectStates()`.
   * @param {Array|null} skyObjects getSkyObjectStates() snapshot
   * @param {object|null} wasmExports
   */
  updateSkyParticleChains(skyObjects, wasmExports) {
    if (!this._skyBirdsEnabled) return;
    if (!Array.isArray(skyObjects) || skyObjects.length === 0 || !wasmExports) return;
    const scene3d = this.liveScene3dRef;
    if (!scene3d) return;
    if (!this._skyBirdAnchor) {
      this._skyBirdAnchor = new THREE.Group();
      this._skyBirdAnchor.name = "sky-bird-anchor";
      this._skyBirdAnchor.frustumCulled = false;
      // FRAME INVARIANT (2026-08-03): `_runStaticParticleChain` parents the
      // Swarm emitters straight under this anchor, and every other caller
      // hands it an anchor under `staticsGroup` — so the DAT emitter offsets
      // and trajectories are AC-frame (Z-up). Parent under `worldRoot` (the
      // rotation.x = -PI/2 AC frame) so +Z is genuinely up. The root scene is
      // Y-up: hanging the swarm there rendered it on its side. Fall back to
      // the root scene if worldRoot is absent — tick() converts through the
      // parent's own matrix either way, so the placement stays correct.
      const frame = scene3d.worldRoot ?? this.scene;
      frame.add(this._skyBirdAnchor); // world-scale particles, AC frame
      // worldToLocal reads matrixWorld; seed it so the FIRST tick (which can
      // precede the first render) already converts against the real transform.
      frame.updateWorldMatrix(true, false);
      this._skyBirdChainsAttached = new Set();
    }
    for (const o of skyObjects) {
      if (!o) continue;
      let pes = 0;
      let vis = true;
      try {
        pes = (o.pesObjectId >>> 0);
        vis = (typeof o.visible === "boolean") ? o.visible : true;
      } catch (_) { continue; }
      if (pes === 0 || !vis) continue;
      if (this._skyBirdChainsAttached.has(pes)) continue;
      this._skyBirdChainsAttached.add(pes); // guard set BEFORE the async attach
      // eslint-disable-next-line no-await-in-loop -- fire-and-forget, not awaited
      import("./statics.js")
        .then((m) =>
          m.attachSkyParticleChain(scene3d, this._skyBirdAnchor, pes, wasmExports, `sky:${pes}`)
        )
        .catch((e) => {
          this._skyBirdChainsAttached.delete(pes); // allow a retry next snapshot
          if (!this._skyBirdChainWarned) {
            this._skyBirdChainWarned = true;
            // eslint-disable-next-line no-console
            console.warn(
              `[sky-birds] chain attach for 0x${pes.toString(16)} failed:`, e
            );
          }
        });
    }
  }

  tick(_dt, camera) {
    this._tickCount += 1;

    if (camera && camera.position) {
      this.skyCell.position.copy(camera.position);
    }

    const session = this.sessionHandleAccessor();
    let isIndoor = false;
    if (session && typeof session.isCurrentCellIndoor === "function") {
      try {
        isIndoor = !!session.isCurrentCellIndoor();
      } catch (_) {
        isIndoor = this._lastIsIndoor;
      }
    }
    this._lastIsIndoor = isIndoor;
    // SKY-SEEN-OUTSIDE (2026-08-04, `?skySeenOutside`, default ON; `=off`
    // restores the old any-indoor blackout). `_lastSkyBlocked` is the flag the
    // SKY PASS gates on (atmosphere_pipeline.preFrameSkySync + the legacy
    // renderSkyPass short-circuit below) — everything else keeps reading
    // `_lastIsIndoor` unchanged (birds stay hidden under cottage ceilings,
    // weather SkyObjects, the W5 loop flag, the indoor layer split).
    // A building interior is a SeenOutside EnvCell (`flags & 0x01`,
    // env_cell.rs:32): its doorway/windows show terrain — which the Phase 5
    // indoor render deliberately keeps visible — so blanking the sky there
    // painted the doorway view against a dead clear color. Retail feeds the
    // outdoor bed into a cell when (outdoor OR seen_outside)
    // (acclient.c:146721/146746 — the same rule the Phase 4 ambient-sound
    // gate ported); the sky pass now follows it. Dungeon cells are not
    // SeenOutside, so they keep the blackout. Typeof-guarded: a stale pkg/
    // without the getter degrades to the old behavior.
    let skyBlocked = isIndoor;
    if (
      SKY_SEEN_OUTSIDE_ON &&
      isIndoor &&
      session &&
      typeof session.isCurrentCellSeenOutside === "function"
    ) {
      try {
        skyBlocked = !session.isCurrentCellSeenOutside();
      } catch (_) { /* keep isIndoor */ }
    }
    this._lastSkyBlocked = skyBlocked;

    // Task #4 — keep the sky-swarm (bird) anchor overhead, following the camera.
    // Hidden indoors (no birds through ceilings). The emitters tick on the
    // shared static ParticleManager; only the anchor transform moves here, so
    // the Swarm particles orbit around the player wherever they go.
    //
    // 2026-08-03 — OVERHEAD IS +Y IN THREE.JS WORLD SPACE, converted into the
    // anchor's parent frame (AC Z-up under worldRoot). `camera` is unparented,
    // so `camera.position` is already world space. The old code added the
    // altitude to `camera.position.z` while the anchor hung in the Y-up root
    // scene, which parked the swarm 40 m SOUTH at exact eye height instead of
    // overhead — the whole default-ON feature never reached the sky.
    if (this._skyBirdAnchor) {
      if (camera && camera.position && !isIndoor) {
        this._skyBirdAnchor.visible = true;
        _skyBirdPosScratch.copy(camera.position);
        _skyBirdPosScratch.y += this._skyBirdAltitude;
        const frame = this._skyBirdAnchor.parent;
        if (frame) frame.worldToLocal(_skyBirdPosScratch);
        this._skyBirdAnchor.position.copy(_skyBirdPosScratch);
      } else {
        this._skyBirdAnchor.visible = false;
      }
    }

    if (this.cloudOverlay) {
      const cachedState =
        this.liveScene3dRef?.skyLightingController?._lastState ?? null;
      this.cloudOverlay.tick(cachedState);
    }

    if (isIndoor) {
      this._indoorTickCount += 1;
    }
  }

  /**
   * Sync the sky camera with the main world camera. Position +
   * quaternion + fov + aspect mirror so the projection matrix
   * aligns. Called from atmosphere_pipeline's preFrameSkySync each
   * frame.
   *
   * @param {THREE.Camera} mainCamera
   */
  syncSkyCamera(mainCamera) {
    if (!mainCamera) return;
    this.skyCamera.position.copy(mainCamera.position);
    this.skyCamera.quaternion.copy(mainCamera.quaternion);
    if (typeof mainCamera.fov === "number") {
      this.skyCamera.fov = mainCamera.fov;
    }
    if (typeof mainCamera.aspect === "number") {
      this.skyCamera.aspect = mainCamera.aspect;
    }
    this.skyCamera.updateProjectionMatrix();
  }

  /**
   * Direct-render path for the indoor short-circuit case. The
   * atmosphere composer normally drives the sky pass as an
   * EffectComposer RenderPass; this method is kept for the legacy
   * direct-render path that runs when atmosphere mode isn't fully
   * wired (e.g. early in init before AtmosphereRuntime resolves).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} mainCamera
   * @param {number} [dt=0]
   */
  renderSkyPass(renderer, mainCamera, dt = 0) {
    if (!renderer || !mainCamera) {
      this._lastSkyRendered = false;
      return;
    }
    // SKY-SEEN-OUTSIDE (2026-08-04): gate on the composite sky-block flag
    // (indoor AND not SeenOutside) so cottage interiors keep their sky;
    // `?? _lastIsIndoor` covers a tick() not having run yet this frame.
    if (this._lastSkyBlocked ?? this._lastIsIndoor) {
      this._lastSkyRendered = false;
      return;
    }
    this.syncSkyCamera(mainCamera);
    if (this.cloudOverlay) {
      this.cloudOverlay.preRender(renderer, dt, mainCamera);
    }
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.render(this.skyScene, this.skyCamera);
    renderer.autoClear = prevAutoClear;
    if (this.cloudOverlay) {
      this.cloudOverlay.renderOverlay(renderer);
    }
    this._lastSkyRendered = true;
  }

  /** Capture-script introspection: did renderSkyPass actually draw last frame? */
  wasSkyRenderedLastFrame() {
    return !!this._lastSkyRendered;
  }

  dispose() {
    if (this.cloudOverlay && typeof this.cloudOverlay.dispose === "function") {
      try { this.cloudOverlay.dispose(); } catch (_) { /* tear-down */ }
    }
    // Task #4 sky-swarm teardown (2026-08-03). The Swarm emitters live on the
    // SHARED static ParticleManager, not on anything this dispose() nulls — so
    // without an explicit reap they keep ticking 60x/s for the rest of the
    // session with no owner (the R1#10 shape). Reap by the SAME `sky:<pes>`
    // owner key the attach used, so the key can never drift, then drop the
    // anchor and the idempotence guard (a stale guard would make a later
    // re-init silently skip every chain).
    if (this._skyBirdChainsAttached) {
      const keys = [...this._skyBirdChainsAttached].map((pes) => `sky:${pes}`);
      this._skyBirdChainsAttached.clear();
      // Dynamic import mirrors the attach path — keeps sky_dome a leaf module.
      import("./particles/owner_registry.js")
        .then((m) => {
          for (const k of keys) {
            try { m.ownerRegistry.destroyAllForOwner(k); } catch (_) { /* tear-down */ }
          }
        })
        .catch(() => { /* tear-down: nothing left to reap into */ });
      this._skyBirdChainsAttached = null;
    }
    if (this._skyBirdAnchor) {
      if (this._skyBirdAnchor.parent) {
        this._skyBirdAnchor.parent.remove(this._skyBirdAnchor);
      }
      this._skyBirdAnchor = null;
    }
    // W1 — free the weather billboard pool + its textures.
    if (this._weatherPool) {
      for (const m of this._weatherPool) {
        if (!m) continue;
        if (m.parent) m.parent.remove(m);
        m.geometry?.dispose?.();
        m.userData?._ownTex?.dispose?.();
        m.material?.dispose?.();
      }
      this._weatherPool = null;
    }
    this._weatherTex?.dispose?.();
    this._weatherTex = null;
    if (this.skyScene) this.skyScene.fog = null;
    this.cloudOverlay = null;
    this.skyScene = null;
    this.skyCamera = null;
    this.skyCell = null;
  }
}
