// Sky-state cache (originally Workstream Sky-C, gutted in K.6 cleanup).
//
// Before K.6: this controller wrote per-frame SkyState into
// THREE.DirectionalLight + THREE.AmbientLight + THREE.Fog AND published
// a `skyBackgroundColor` sink for the parametric Sky-D dome.
//
// After K.6: the atmosphere stack (atmosphere_lights, atmosphere_sky,
// atmosphere_pipeline) is the sole consumer of sun/sky/fog lighting,
// driven by Bruneton precomputed tables instead of ARGB lerps. The
// parametric dome / dirLight / ambLight / fog path is gone. This
// module's only remaining job is to pull SkyState from wasm each
// frame and stash it on `_lastState` so atmosphere_lights.tick,
// atmosphere_sky.tick, and cloud_overlay.tick can read a single
// shared snapshot without each calling getSkyState() on its own.
//
// Class name is preserved for backward compatibility with the existing
// `liveScene3d.skyLightingController._lastState` access patterns.

/**
 * Decode an ARGB u32 (0xAARRGGBB) into [a, r, g, b] u8 bytes. Kept
 * because `__internals` re-exports it for the Node ESM test that
 * verified the original parametric calibration; if you delete the
 * test, this helper goes too.
 */
function decodeArgb(u32) {
  const a = (u32 >>> 24) & 0xff;
  const r = (u32 >>> 16) & 0xff;
  const g = (u32 >>> 8) & 0xff;
  const b = u32 & 0xff;
  return [a, r, g, b];
}

/**
 * Snapshot a wasm-bindgen `SkyState` (or a plain-object mock) into a
 * plain JS object. The wasm handle's getters may throw post-`.free()`;
 * copying defensively means downstream consumers can stash the snapshot
 * for any duration without worrying about wasm lifetime.
 *
 * Mirrors the field names from `SkyStateSnapshot` in
 * `crates/holtburger-world/src/sky.rs` (camelCase via wasm-bindgen).
 *
 * Returns null if the snapshot is unusable (any getter throws).
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
      // Wave R1.C (2026-05-28) — acclient-faithful time-of-day fog color.
      // Separate from fogColorArgb (which stays byte-identical for the
      // clouds + weather classifier). Consumed ONLY at the distance-fog
      // apply site behind `?fogLerp=on`.
      fogColorArgbLerp: (state.fogColorArgbLerp >>> 0),
      fogMin: +state.fogMin,
      fogMax: +state.fogMax,
      worldFog: (state.worldFog >>> 0),
      timeOfDayNormalized: +state.timeOfDayNormalized,
      dayGroupIndex: (state.dayGroupIndex >>> 0),
    };
  } catch (_) {
    return null;
  } finally {
    if (typeof state.free === "function") {
      try { state.free(); } catch (_) {}
    }
  }
}

/**
 * Per-frame SkyState cache. Polls `sessionHandleAccessor()` for a
 * session each tick, calls `getSkyState()`, snapshots the result, and
 * stashes it on `_lastState`. Downstream subsystems
 * (atmosphere_lights, atmosphere_sky, cloud_overlay via sky_dome's
 * routing) read `_lastState` directly — no second wasm call.
 *
 * Class name `SkyLightingController` is preserved for the existing
 * `liveScene3d.skyLightingController._lastState` access pattern from
 * before K.6. The constructor still accepts the prior `sun`/`ambient`
 * options for source-compatibility with the construct site in
 * scene3d/index.js, but they're ignored.
 */
export class SkyLightingController {
  /**
   * @param {Object} opts
   * @param {Function} opts.sessionHandleAccessor - `() => SessionHandle
   *   | null`. Called each tick to fetch the wasm handle from which we
   *   pull `getSkyState()`.
   */
  constructor(opts) {
    const { sessionHandleAccessor } = opts || {};
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === "function"
        ? sessionHandleAccessor
        : () => null;
    this._lastState = null;
    this._tickCount = 0;
    this._nullStateTickCount = 0;
  }

  /**
   * Per-rAF tick. Cheap to call when SkyState is null. Wrapped in
   * try/catch by the caller (`loop.js`) so a thrown wasm-getter
   * doesn't kill the tick.
   *
   * @param {number} _dt - unused. Kept for API compat with prior
   *   tick(dt) signature.
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
    this._lastState = snap;
    this._tickCount += 1;
  }

  /** Cleanup is a no-op now; kept for API compat. */
  dispose() {}
}

// Internal helpers re-exported for the Node ESM test that asserts the
// SkyState snapshot/decode shape directly. Not part of the public API.
export const __internals = Object.freeze({
  decodeArgb,
  snapshotSkyState,
});
