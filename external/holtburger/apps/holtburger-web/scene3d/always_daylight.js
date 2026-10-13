// scene3d/always_daylight.js — the "Always daylight outdoors" option
// (Options → Character → Visual; CharacterOption 0x05 = CharacterOptions2
// PersistentAtDay). Until 2026-10-11 the checkbox only reached the server:
// nothing in the renderer read the bit, so the sky kept the real time of day.
//
// Retail: the option is `LScape::SetDay` (acclient.c:306897), applied from the
// player module at login (:452815) and on every option change (case 5,
// :452973), and by the `/day` command (`ClientCommunicationSystem::DoDay`,
// :412745). With `LScape::m_fAlwaysDaylight` set, `set_landscape_lighting`
// (:307016) lights the landscape from `CRegionDesc::GetLighting(0.5, …)` — the
// region's Midsong (noon) keyframes — instead of the current time of day.
//
// Here the wasm sky evaluator drives the sun, the sky, the fog and the ground
// light together, so the option pins the evaluator's whole outdoor clock to
// Midsong through `setSkyTimeOverride(0.5)` (the sticky override `?skytime=<h>`
// uses) and clears it with NaN when the option goes off. Retail left the sky
// dome on the real clock; a night sky over a noon-lit landscape cannot be drawn
// here without splitting the atmosphere from its sun, so the sky follows too.
// Indoors nothing reads the outdoor clock, so "outdoors" still holds.
//
// The override lives on the evaluator, which `populateSkyDescFromRegion`
// replaces on every EnteredWorld (src/lib.rs) — so the pin is re-asserted at
// every poll while the option is on, not set once. A `?skytime` debug pin or
// accel cycle owns the clock instead (index.html skips this driver then).
//
// SetDay also zeroes `LScape::next_light_tick`, so retail re-lights the ground
// on the very next frame. Each applied pin edge (pinned, or unpinned) resets
// the shared landscape light clock the same way (`retail_light_tick.js`);
// without it the ground kept the old light for up to 15 s under the new sky.
// `?lightTickReset=off` skips the reset.
// Pure (no DOM / three imports) so node tests can import it.

import { retailLightTick, lightTickResetEnabled } from "./retail_light_tick.js";

/** `holtburger_common::CharacterOption::AlwaysDaylightOutdoors`. */
export const ALWAYS_DAYLIGHT_OPTION = 0x05;
/** Retail's `GetLighting` argument: Midsong, the middle of the day. */
export const ALWAYS_DAYLIGHT_TIME_OF_DAY = 0.5;
/** Option re-read and pin re-assert cadence. */
export const ALWAYS_DAYLIGHT_POLL_MS = 250;

/** The option bit from the session, false when it cannot be read. */
export function readAlwaysDaylight(handle) {
  try {
    if (handle && typeof handle.isCharacterOptionEnabled === "function") {
      return !!handle.isCharacterOptionEnabled(ALWAYS_DAYLIGHT_OPTION);
    }
  } catch (_) {
    /* unknown index / freed handle: the option reads off */
  }
  return false;
}

/** `setSkyTimeOverride` → applied? (false until the SkyDesc has landed). */
function setSkyClock(handle, timeOfDay) {
  try {
    if (handle && typeof handle.setSkyTimeOverride === "function") {
      return !!handle.setSkyTimeOverride(timeOfDay);
    }
  } catch (_) {
    /* pre-sky / stale pkg: nothing applied */
  }
  return false;
}

/**
 * The per-login driver; index.html calls `tick(handle, nowMs)` on every net
 * pump. It re-reads the option every `ALWAYS_DAYLIGHT_POLL_MS`. While the
 * option is on it pins the sky clock — on every pump until the wasm reports
 * the pin applied, then once per poll. When the option goes off it clears the
 * pin it set, and only a pin it set: with the option off from login it never
 * touches the clock.
 *
 * Each applied edge — pinned false→true, and the unpin — resets the landscape
 * light clock (`LScape::SetDay`). The per-poll re-asserts of a held pin do not.
 *
 * @param {object} [opts]
 * @param {object} [opts.lightTick]  the clock to reset (tests); default the
 *   shared `retailLightTick`.
 * @param {string} [opts.search]     URL search for `?lightTickReset`.
 */
export function createAlwaysDaylight(opts = {}) {
  const lightTick = opts.lightTick || retailLightTick;
  const resetLight = lightTickResetEnabled(opts.search);
  let on = false;
  let pinned = false;
  let nextPollMs = -Infinity;
  let lightResets = 0;
  function setDay() {
    if (!resetLight) return;
    try {
      lightTick.reset();
      lightResets += 1;
    } catch (_) {
      /* a broken clock must not stop the pin */
    }
  }
  return {
    tick(handle, nowMs) {
      const poll = !(nowMs < nextPollMs);
      if (poll) {
        on = readAlwaysDaylight(handle);
        nextPollMs = nowMs + ALWAYS_DAYLIGHT_POLL_MS;
      }
      if (on) {
        if (poll || !pinned) {
          const was = pinned;
          pinned = setSkyClock(handle, ALWAYS_DAYLIGHT_TIME_OF_DAY);
          if (pinned && !was) setDay();
        }
      } else if (pinned) {
        setSkyClock(handle, NaN);
        pinned = false;
        setDay();
      }
    },
    /** Probe/diag snapshot. */
    state() {
      return { on, pinned, lightResets };
    },
  };
}
