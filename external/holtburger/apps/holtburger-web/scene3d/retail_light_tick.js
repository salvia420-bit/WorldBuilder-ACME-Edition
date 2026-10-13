// scene3d/retail_light_tick.js — the landscape's ONE retail light clock.
//
// Retail: `LScape::UseTime` (acclient.c:307222) re-lights the whole landscape
// (`set_landscape_lighting`) only when `LScape::next_light_tick` expires, then
// re-arms it `sky_info->light_tick_size` later (Dereth's Region DAT carries
// 15 s; the no-region fallback is 3 s, acclient.c:307294). `LScape::SetDay`
// (acclient.c:306897) — the "Always daylight outdoors" option at login
// (:452816), on every option change (:452974) and `/day` (:412745) — zeroes
// `next_light_tick` (and `next_tick`), so the very next frame re-lights the
// landscape from the new sky.
//
// Here the landscape light has two consumers: the terrain Gouraud term
// (`loop.js` tickTerrainSunDir) and the pebble field (`terrain_rock.js`). They
// used to keep two private 15 s timers on unrelated phases, and neither was
// reset when `always_daylight.js` pinned or unpinned the sky clock, so the sky
// jumped to Midsong while the ground kept the old light for up to 15 s. Both
// now read this one clock: `sync()` returns the light epoch, and whichever
// consumer asks first in a frame advances it. `always_daylight.js` calls
// `reset()` on its pin edges (retail SetDay).
//
// FRAME ORDER. Both consumers run BEFORE `skyLightingController.tick` in
// loop.js, so at reset time `_lastState` still holds the pre-pin sky. A
// `reset()` therefore arms a tick that fires only once the controller's
// `_tickCount` has advanced past its value at (or just after) the reset, so
// the first re-light reads a post-pin SkyState, as retail's does (UseTime
// evaluates the sky before the light tick in the same call). The 15 s deadline
// keeps running meanwhile, so a stalled sky controller cannot wedge the clock.
//
// `?lightTickReset=off` restores the old behaviour: no reset on the option
// edges, and the pebbles keep their own timer on the VFX clock.
// Pure (no DOM / three imports) so node tests can import it.

/**
 * Dereth's `skyInfo.lightTickSize` (portal 0x13000000), seconds. acclient's
 * no-region fallback is 3.0 (acclient.c:307294) and the SkyDesc ctor seeds
 * 20.0 (acclient.c:301477); 15 is what the shipped client used in Dereth.
 */
export const RETAIL_LIGHT_TICK_SEC = 15.0;

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?lightTickReset=off|0|false` disables the shared clock + SetDay reset. */
export function lightTickResetEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("lightTickReset");
    return !isOff(v);
  } catch (_) {
    return true;
  }
}

/**
 * LIVE monotonic seconds. NOT `scene3d.frameTime.tsSec`: frameTime is stamped
 * only by the rAF tick and FREEZES under `?renderOnDemand=1` (the RP3
 * throttle-clock note in loop.js tickPerFrame); a frozen clock would wedge the
 * light tick after its first firing.
 */
export function retailLightNowSec() {
  return (typeof performance !== "undefined" && performance && typeof performance.now === "function")
    ? performance.now() * 0.001
    : Date.now() * 0.001;
}

/**
 * One light clock.
 *
 * @param {object} [opts]
 * @param {number} [opts.periodSec]  the tick, default `RETAIL_LIGHT_TICK_SEC`.
 * @param {Function} [opts.now]      seconds source, default `retailLightNowSec`.
 *   Every caller of one clock shares this source; nobody passes a time in, so
 *   two consumers cannot mix clock bases.
 */
export function createRetailLightTick(opts = {}) {
  const periodSec = Number.isFinite(opts.periodSec) && opts.periodSec > 0
    ? opts.periodSec
    : RETAIL_LIGHT_TICK_SEC;
  const now = typeof opts.now === "function" ? opts.now : retailLightNowSec;
  let nextLightTick = -Infinity;
  let epoch = 0;
  // A pending `reset()`: fire once the sky snapshot is newer than `armedAt`.
  let armed = false;
  let armedAt = null;
  let resets = 0;
  let fires = 0;

  function nowSec() {
    const t = +now();
    return Number.isFinite(t) ? t : 0;
  }
  function fire(t) {
    nextLightTick = t + periodSec;
    epoch += 1;
    fires += 1;
  }

  /**
   * True when THIS call advanced the epoch. `stateTick` is the sky snapshot's
   * freshness stamp (`skyLightingController._tickCount`); a caller without
   * one never satisfies a pending reset, but still keeps the 15 s cadence.
   */
  function due(stateTick) {
    const t = nowSec();
    if (armed && Number.isFinite(stateTick)) {
      if (armedAt === null) {
        armedAt = stateTick;
      } else if (stateTick > armedAt) {
        armed = false;
        armedAt = null;
        fire(t);
        return true;
      }
    }
    // The deadline does NOT clear a pending reset: a deadline that lands in
    // the frame or two before the post-reset sky tick would otherwise re-light
    // from the pre-reset sky and hold it for a whole tick.
    if (!(t < nextLightTick)) {
      fire(t);
      return true;
    }
    return false;
  }

  return {
    due,
    /** Advance if due; returns the current light epoch. */
    sync(stateTick) {
      due(stateTick);
      return epoch;
    },
    /**
     * `LScape::SetDay`: re-light on the next frame that sees a sky snapshot
     * newer than `stateTick` (or, when it is omitted, newer than the first
     * one a `due()` sees after this call).
     */
    reset(stateTick) {
      armed = true;
      armedAt = Number.isFinite(stateTick) ? stateTick : null;
      resets += 1;
    },
    /** Re-light from the current snapshot at the next `due()` (devtools). */
    invalidate() {
      nextLightTick = -Infinity;
    },
    get epoch() {
      return epoch;
    },
    stats() {
      return { epoch, nextLightTick, periodSec, armed, armedAt, resets, fires };
    },
  };
}

/** The landscape's clock: terrain Gouraud + pebbles + the SetDay reset. */
export const retailLightTick = createRetailLightTick();
