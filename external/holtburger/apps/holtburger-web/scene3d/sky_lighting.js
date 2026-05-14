// Workstream Sky-C (2026-05-11) — dynamic sky lighting + fog controller.
//
// Consumes the wasm-side SkyState (Workstream Sky-B, `crates/holtburger-
// world/src/sky.rs`) via `window.__sessionHandle.getSkyState()` and
// drives THREE.DirectionalLight (sun) + THREE.AmbientLight + THREE.Fog
// from the lerped ARGB + brightness + heading/pitch + fog distance
// fields. Polled per-rAF; idempotent when `getSkyState` returns null
// (pre-populator) — the static Phase 7.6 defaults stay in place until
// the SkyDesc shadow lands.
//
// **Calibration findings** (verified by upstream-doc sample
// `dir_heading=90, dir_pitch=67.35` at Dereth noon and confirmed by
// the noon position eye-test below):
//
//   1. **`dir_heading` + `dir_pitch` are DEGREES** in the wire-from-
//      DAT path (despite the wasm-side d.ts docstring claiming
//      radians). The d.ts is a downstream-doc artefact; the real DAT
//      bytes per `crates/holtburger-dat/src/file_type/region.rs:251-252`
//      are raw f32 with no degrees→radians conversion in the parser.
//      At Dereth noon the heading is 90.0 (NOT 90 radians = ~14 full
//      turns), pitch 67.35 (NOT 67 radians = ~10 turns). Apply
//      `* π / 180` here to enter three.js's radian world.
//
//   2. **Pitch convention: pitch=0 → horizon, pitch=π/2 → zenith.**
//      Confirmed by `sky.rs:521-524`: "sin(p * pi) arc: 0 at horizon
//      (p=0), 1 at zenith (p=0.5)". So `y = distance * sin(pitch)` is
//      the up component; at noon (pitch=67.35°) y ≈ 0.923 * distance,
//      strongly positive (sun above horizon — sensible).
//
//   3. **Heading convention: AC measures heading on the world XY plane
//      from +Y (north), CW, in degrees.** At Dereth noon (h=90°), the
//      sun is due east. We project (heading, pitch) into AC unit
//      vector `(cos(pitch)*sin(heading), cos(pitch)*cos(heading),
//      sin(pitch))` then transform AC→three via the same
//      `(ax, ay, az) → (ax, az, -ay)` rotation that `acToThree` in
//      `scene3d/adapter.js` performs for cameras + scene-root lights.
//
// **Hooking into the Phase 7.6 lighting handles.** `setupSceneLighting`
// in `scene3d/lighting.js` creates a DirectionalLight (sun) +
// AmbientLight + optional HemisphereLight under a `lights` Group at
// the scene root. The Phase 7.6 `tickLightingForCellState` flips
// `sun.visible` + adjusts `ambient.intensity` on indoor/outdoor
// transitions. Sky-C TAKES OVER the same handles (`scene3d.lighting`)
// — it overrides `sun.color`/`sun.intensity`/`sun.position` and
// `ambient.color`/`ambient.intensity` on every tick when SkyState is
// available. The two controllers DO compose: Phase 7.6's indoor
// toggle is preserved (it sets `sun.visible` based on
// `isCurrentCellIndoor()`), and Sky-C's per-frame overrides happen
// AFTER Phase 7.6's tick in `loop.js` — when indoor, Sky-C still
// computes the would-be outdoor values but the sun's `.visible=false`
// flag (set by Phase 7.6) keeps it from rendering. Outdoor: Sky-C's
// dynamic values are the final word.
//
// **`scene.fog` ownership.** The Phase 7.0+ Scene was created in
// `init3D` with no fog. Sky-C's constructor assigns `scene.fog = new
// THREE.Fog(...)` on first tick when fog data is available, then
// updates `.color/.near/.far` per tick.
//
// **`window.liveScene3d.skyBackgroundColor` sink.** Sky-D's sky-dome
// renderer will sample this to drive its horizon-gradient. Sky-C
// publishes the raw ARGB u32 from `state.fog_color_argb` on every
// applied tick (the fog colour is the horizon's atmospheric tint —
// what the dome's lowest band should fade INTO at the horizon).
// Sky-D's commit may swap this for an interpolated horizon-vs-zenith
// pair, but the sink path is committed now so Sky-D can wire to it
// without coordination.
//
// **Fallback.** Before `hasSkyDesc()` returns true, the sun/ambient/
// fog stay at Phase 7.6's static defaults set by `setupSceneLighting`
// (warm sun, cool ambient, NO fog). Sky-C's tick is a no-op until the
// first `getSkyState()` returns non-null. A separate "default sky"
// path applies sensible non-Sky-B defaults (warm sun southeast 60°
// elevation, gray ambient, blue fog) when the controller is
// instantiated WITHOUT a session-handle accessor (the Node ESM test
// uses this path).

import * as THREE from "three";

// ---- Default values used pre-Sky-B-population ----------------------
// These approximate Phase 7.6's defaults but add a fog so the controller
// has a non-null `scene.fog` on construction. Once a real SkyState
// lands, the per-tick path overrides everything.
const DEFAULT_DIR_COLOR_ARGB = 0xfffad797; // warm sun (matches Sky-B noon)
const DEFAULT_DIR_BRIGHT = 1.0;
const DEFAULT_HEADING_DEG = 45.0; // SE-ish
const DEFAULT_PITCH_DEG = 60.0; // high
const DEFAULT_AMB_COLOR_ARGB = 0xff808080; // mid gray
const DEFAULT_AMB_BRIGHT = 0.4;
const DEFAULT_FOG_COLOR_ARGB = 0xff9cb3d9; // sky blue
const DEFAULT_FOG_MIN = 200.0;
// World-expand step 1 Objective 9 (2026-05-14): raised from 800.0 to
// 2500.0 to cover the 13×13 LB ring's corner-to-centre diagonal
// (~1.77 km) when no wasm SkyState has landed yet. Region 0x13's
// per-DayGroup `max_world_fog` lerp still drives colour + density
// curves once a SkyState arrives; we only floor the draw distance.
const DEFAULT_FOG_MAX = 2500.0;
// Per-tick floor on `fog.far`. Applied in `_applyState` so even at
// midnight (typically low `max_world_fog` per DayGroup) the ring is
// still visible. The upstream `state.fogMax` is intentionally NOT
// mutated — only the resulting `fog.far` is clamped — so the colour /
// density curves driven by Region 0x13 remain authoritative.
const FOG_FAR_FLOOR = 2500.0;

// Distance from world origin at which to position the directional
// light. three.js DirectionalLight is a parallel light — distance
// does NOT affect shading, only positions the shadow camera. We use
// 1000 m so a hypothetical future shadow-camera setup has the sun
// outside the 9-LB neighbourhood's bounding sphere; for the
// non-shadow path it's a cosmetic choice.
const SUN_POSITION_DISTANCE = 1000.0;

/**
 * Decode an ARGB u32 (0xAARRGGBB) into a [a, r, g, b] tuple of u8.
 */
function decodeArgb(u32) {
  const a = (u32 >>> 24) & 0xff;
  const r = (u32 >>> 16) & 0xff;
  const g = (u32 >>> 8) & 0xff;
  const b = u32 & 0xff;
  return [a, r, g, b];
}

/**
 * Project (heading, pitch) in DEGREES into a three.js Y-up world-
 * space position vector at radius `distance`. AC's convention is
 * heading measured on the world XY plane from +Y (north) CW, pitch
 * measured above the horizon. The AC unit vector is
 *
 *     (cos(pitch) * sin(heading),  // AC east
 *      cos(pitch) * cos(heading),  // AC north
 *      sin(pitch))                 // AC up
 *
 * Then the AC→three transform `(ax, ay, az) → (ax, az, -ay)` (same
 * rotation `worldRoot.rotation.x = -π/2` applies to its children)
 * gives:
 *
 *     three_x =  cos(pitch) * sin(heading)         [east]
 *     three_y =  sin(pitch)                        [up]
 *     three_z = -cos(pitch) * cos(heading)         [south]
 *
 * Returns `[x, y, z]` multiplied by `distance`. The directional
 * light's `.position` is in three.js world coords; with target at
 * origin, light shines FROM this position TOWARD origin (i.e. from
 * heading + pitch above the horizon, into the scene).
 */
function sunPositionFromHeadingPitch(headingDeg, pitchDeg, distance) {
  const headingRad = (headingDeg * Math.PI) / 180.0;
  const pitchRad = (pitchDeg * Math.PI) / 180.0;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const x = distance * cp * Math.sin(headingRad);
  const y = distance * sp;
  const z = -distance * cp * Math.cos(headingRad);
  return [x, y, z];
}

/**
 * Snapshot a wasm-bindgen `SkyState` (or a plain-object mock with the
 * same field shape) into a plain JS object. The wasm handle's getters
 * may throw post-`.free()`; copying defensively means the controller
 * can stash `_lastState` for capture scripts to inspect without
 * worrying about wasm lifetime.
 *
 * Mirrors the field names from `SkyStateSnapshot` in
 * `crates/holtburger-world/src/sky.rs` (camelCase via wasm-bindgen).
 *
 * Returns null if the snapshot is unusable (key getter throws).
 */
function snapshotSkyState(state) {
  if (!state) return null;
  try {
    return {
      dirColorArgb: (state.dirColorArgb >>> 0),
      dirBright: +state.dirBright,
      dirHeading: +state.dirHeading,
      dirPitch: +state.dirPitch,
      ambColorArgb: (state.ambColorArgb >>> 0),
      ambBright: +state.ambBright,
      fogColorArgb: (state.fogColorArgb >>> 0),
      fogMin: +state.fogMin,
      fogMax: +state.fogMax,
      worldFog: (state.worldFog >>> 0),
      timeOfDayNormalized: +state.timeOfDayNormalized,
      dayGroupIndex: (state.dayGroupIndex >>> 0),
    };
  } catch (_) {
    return null;
  } finally {
    // Free the wasm handle if present — caller doesn't need it after
    // the snapshot. Defensive try/catch: plain-object mocks have no
    // `.free`.
    if (typeof state.free === "function") {
      try { state.free(); } catch (_) {}
    }
  }
}

/**
 * Driver for THREE.DirectionalLight + THREE.AmbientLight + THREE.Fog
 * from the wasm SkyState. Instantiated by `init3D` after
 * `setupSceneLighting` runs (so it takes over the already-existing
 * sun + ambient handles).
 *
 * Per-rAF: `tick(dt)` polls `sessionHandleAccessor()` for a session,
 * calls `.getSkyState()`, and writes the lerped values onto the
 * three.js handles. When `getSkyState` returns null (pre-populator),
 * the tick is a no-op — the static Phase 7.6 lighting stays in
 * effect.
 *
 * **Public state.** After each non-null tick, `_lastState` carries the
 * snapshot the controller applied. Capture scripts read this to
 * assert the controller IS driving lights (not just instantiated).
 *
 * **`skyBackgroundColorArgb`.** Sky-D's sky-dome consumes this as the
 * horizon-band tint. Stashed on the controller AND on
 * `liveScene3d.skyBackgroundColor` for cross-module access.
 */
export class SkyLightingController {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene - the root three.js Scene; the
   *   controller will assign `scene.fog` on first tick.
   * @param {THREE.DirectionalLight} opts.sun - existing sun light from
   *   `setupSceneLighting`. The controller overrides color, intensity,
   *   and position per tick. `.visible` is left alone (Phase 7.6
   *   owns that flag via the indoor/outdoor toggle).
   * @param {THREE.AmbientLight} opts.ambient - existing ambient light.
   *   The controller overrides color + intensity per tick.
   * @param {Function} opts.sessionHandleAccessor - `() => SessionHandle
   *   | null`. Read each tick; the SessionHandle's `getSkyState()` +
   *   `hasSkyDesc()` are the data sources.
   * @param {Object} [opts.liveScene3dRef] - reference to the
   *   `liveScene3d` object on which to publish
   *   `skyBackgroundColor`. Optional; the controller works
   *   stand-alone for the Node ESM test (which doesn't construct a
   *   liveScene3d).
   * @param {Object} [opts.fogOptions] - overrides for fog
   *   construction. `{ near, far, color }`. Defaults map from
   *   Sky-C's fallback values when no SkyState has been seen yet.
   */
  constructor(opts) {
    const {
      scene,
      sun,
      ambient,
      sessionHandleAccessor,
      liveScene3dRef = null,
      fogOptions = null,
    } = opts || {};
    if (!scene) {
      throw new Error("SkyLightingController: opts.scene required");
    }
    if (!sun) {
      throw new Error("SkyLightingController: opts.sun required");
    }
    if (!ambient) {
      throw new Error("SkyLightingController: opts.ambient required");
    }
    this.scene = scene;
    this.dirLight = sun;
    this.ambLight = ambient;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === "function"
        ? sessionHandleAccessor
        : () => null;
    this.liveScene3dRef = liveScene3dRef;

    // Construct the fog with sensible defaults; the first non-null
    // tick will overwrite color + near + far.
    const initialFogColor = fogOptions?.color ?? DEFAULT_FOG_COLOR_ARGB;
    const initialFogNear = fogOptions?.near ?? DEFAULT_FOG_MIN;
    const initialFogFar = fogOptions?.far ?? DEFAULT_FOG_MAX;
    const [, fr, fg, fb] = decodeArgb(initialFogColor);
    this.fog = new THREE.Fog(
      new THREE.Color(fr / 255, fg / 255, fb / 255),
      initialFogNear,
      initialFogFar
    );
    this.scene.fog = this.fog;

    // skyBackgroundColor sink — published on construction so Sky-D can
    // read a non-null value even before the first SkyState arrives.
    this.skyBackgroundColorArgb = initialFogColor;
    if (this.liveScene3dRef) {
      this.liveScene3dRef.skyBackgroundColor = initialFogColor;
    }

    // Last applied snapshot — capture scripts inspect this to verify
    // the controller IS driving lights (not just constructed). Null
    // until the first non-null tick.
    this._lastState = null;
    // Tick counter — useful for capture scripts that want to know how
    // many real ticks landed.
    this._tickCount = 0;
    // No-state tick counter — capture scripts can distinguish
    // "controller never ran" from "controller ran but populator never
    // fired".
    this._nullStateTickCount = 0;
  }

  /**
   * Apply Sky-C's fallback defaults (used when `useFallback()` is
   * called explicitly, NOT in the per-tick path which leaves the
   * Phase 7.6 statics alone for null SkyState).
   *
   * Per the workstream prompt: "warm-sun directional at 60° elevation
   * southeast, gray ambient, blue fog. This way the viewport never
   * goes black on init."
   */
  useFallback() {
    const fallbackState = {
      dirColorArgb: DEFAULT_DIR_COLOR_ARGB,
      dirBright: DEFAULT_DIR_BRIGHT,
      dirHeading: DEFAULT_HEADING_DEG,
      dirPitch: DEFAULT_PITCH_DEG,
      ambColorArgb: DEFAULT_AMB_COLOR_ARGB,
      ambBright: DEFAULT_AMB_BRIGHT,
      fogColorArgb: DEFAULT_FOG_COLOR_ARGB,
      fogMin: DEFAULT_FOG_MIN,
      fogMax: DEFAULT_FOG_MAX,
      worldFog: 0,
      timeOfDayNormalized: 0.5,
      dayGroupIndex: 0,
    };
    this._applyState(fallbackState);
  }

  /**
   * Per-rAF tick. Cheap to call when SkyState is null (a few field
   * reads + a return). Wrapped in try/catch by the caller (`loop.js`)
   * so a thrown wasm-getter doesn't kill the tick.
   *
   * @param {number} _dt - frame delta in seconds. Currently unused —
   *   the lerp is done on the wasm side from the absolute world-time
   *   anchor, so JS-side dt isn't needed. Reserved for future
   *   client-side smoothing of the discretized wasm output.
   */
  tick(_dt) {
    const session = this.sessionHandleAccessor();
    if (!session || typeof session.getSkyState !== "function") {
      this._nullStateTickCount += 1;
      return;
    }
    let state;
    try {
      state = session.getSkyState();
    } catch (_) {
      this._nullStateTickCount += 1;
      return;
    }
    if (!state) {
      this._nullStateTickCount += 1;
      return;
    }
    const snap = snapshotSkyState(state);
    if (!snap) {
      this._nullStateTickCount += 1;
      return;
    }
    this._applyState(snap);
    this._tickCount += 1;
  }

  /**
   * Write a snapshotted SkyState onto the three.js handles. Split out
   * from `tick` so the Node ESM test can mock state directly without
   * a real session-handle accessor.
   *
   * @param {Object} state - the plain-object snapshot from
   *   `snapshotSkyState` (or a hand-built equivalent for tests).
   */
  _applyState(state) {
    // 1. Directional light — color, intensity, position.
    const [, dr, dg, db] = decodeArgb(state.dirColorArgb);
    this.dirLight.color.setRGB(dr / 255, dg / 255, db / 255);
    this.dirLight.intensity = state.dirBright;
    const [sx, sy, sz] = sunPositionFromHeadingPitch(
      state.dirHeading,
      state.dirPitch,
      SUN_POSITION_DISTANCE
    );
    this.dirLight.position.set(sx, sy, sz);
    if (this.dirLight.target && this.dirLight.target.position) {
      this.dirLight.target.position.set(0, 0, 0);
    }

    // 2. Ambient — color, intensity.
    const [, ar, ag, ab] = decodeArgb(state.ambColorArgb);
    this.ambLight.color.setRGB(ar / 255, ag / 255, ab / 255);
    this.ambLight.intensity = state.ambBright;

    // 3. Fog — color, near, far.
    const [, fr, fg, fb] = decodeArgb(state.fogColorArgb);
    if (this.fog && this.fog.color) {
      this.fog.color.setRGB(fr / 255, fg / 255, fb / 255);
      // Clamp negatives — `Fog.near < 0` doesn't error but is
      // physically meaningless; max(0, ...) is a defensive floor.
      this.fog.near = Math.max(0, state.fogMin);
      // World-expand step 1 Objective 9 (2026-05-14): floor at
      // FOG_FAR_FLOOR (2500 m) so the 13×13 ring stays visible even at
      // night when Region 0x13's DayGroup `max_world_fog` lerps low.
      // `state.fogMax` itself is unchanged so colour / density curves
      // still drive correctly upstream.
      this.fog.far = Math.max(this.fog.near + 1.0, state.fogMax, FOG_FAR_FLOOR);
    }

    // 4. skyBackgroundColor sink for Sky-D.
    this.skyBackgroundColorArgb = state.fogColorArgb;
    if (this.liveScene3dRef) {
      this.liveScene3dRef.skyBackgroundColor = state.fogColorArgb;
    }

    this._lastState = state;
  }

  /**
   * Cleanup. Removes `scene.fog`. The sun + ambient handles are owned
   * by Phase 7.6's `setupSceneLighting` — leave them in place; the
   * caller's `lighting.dispose()` removes them when the scene tears
   * down.
   */
  dispose() {
    if (this.scene.fog === this.fog) {
      this.scene.fog = null;
    }
  }
}

// Expose Sky-C's canonical constants so capture scripts + the Node
// ESM test can assert the exact values without re-deriving them.
export const SKY_LIGHTING_CONSTANTS = Object.freeze({
  DEFAULT_DIR_COLOR_ARGB,
  DEFAULT_DIR_BRIGHT,
  DEFAULT_HEADING_DEG,
  DEFAULT_PITCH_DEG,
  DEFAULT_AMB_COLOR_ARGB,
  DEFAULT_AMB_BRIGHT,
  DEFAULT_FOG_COLOR_ARGB,
  DEFAULT_FOG_MIN,
  DEFAULT_FOG_MAX,
  SUN_POSITION_DISTANCE,
});

// Internal helpers re-exported for the Node ESM test (so the test can
// verify the calibration math directly without standing up a full
// SkyLightingController). NOT part of the public API.
export const __internals = Object.freeze({
  decodeArgb,
  sunPositionFromHeadingPitch,
  snapshotSkyState,
});
