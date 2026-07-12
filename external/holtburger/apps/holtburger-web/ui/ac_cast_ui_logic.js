// =============================================================================
// WS14 (2026-07-12) — pure cast-UI feedback logic (no DOM, no wasm)
// =============================================================================
//
// The combat-bar cast-busy sweep (patch A) and armed wrong-stance cue
// (patch B) are DOM-coupled inside plugins/combat-bar.js, so the *decision*
// pieces are factored out here as pure functions the unit tests
// (tests/test_ws14_ui_feedback.cjs) can exercise without jsdom. combat-bar.js
// imports and uses these directly — the tests lock the same code the plugin
// ships, not a mirror.
//
// Magic stance low byte — the only casting stance (index.html getCurrentStanceLow
// == 0x0049; combat-bar STANCE_MAGIC == 0x49; picking.js isInMagicStance).

export const STANCE_MAGIC_LOW = 0x0049;

/**
 * True when a TARGETED spell is armed but the player is NOT in Magic stance,
 * so the armed row can't actually fire until they enter Magic mode (the
 * picking.js dispatch only casts from the Magic branch). Untargeted self-spells
 * cast immediately on click regardless of stance, so they are never "wrong
 * stance". Patch B surfaces this as an amber cue instead of the ready-purple.
 *
 * @param {number} armedSpellId  window.__combatBarState.armedSpellId (0 = none)
 * @param {boolean} isUntargeted spell casts on self (no target arm needed)
 * @param {number} stanceLow     window.__getCurrentStanceLow() result
 * @returns {boolean}
 */
export function wrongStanceForArmed(armedSpellId, isUntargeted, stanceLow) {
  if (!(Number(armedSpellId) > 0)) return false;
  if (isUntargeted) return false;
  return (stanceLow | 0) !== STANCE_MAGIC_LOW;
}

/**
 * Pure cast-busy duration mapping the sweep relies on: the busy window
 * (== the on-screen cast) is `totalDurationS * 1000 / CAST_SPEED`, floored at
 * 400 ms so a very fast cast still shows a visible sweep, and defaulted to
 * 2000 ms when the spell has no known duration (table not loaded / unknown
 * spell). Mirrors entities.js `_castBusyUntilMs` sizing (÷ CAST_SPEED).
 *
 * @param {number} totalDurationS spell's totalDurationS (seconds), or falsy
 * @param {number} [speed=2.0]    CAST_SPEED (default-ON 2.0)
 * @returns {number} milliseconds
 */
export function castCooldownMs(totalDurationS, speed = 2.0) {
  const total = Number.isFinite(+totalDurationS) ? +totalDurationS : 0;
  const spd = Number(speed) || 2.0;
  return total > 0 ? Math.max(400, Math.round((total * 1000) / spd)) : 2000;
}

/**
 * Reduce a cast-lifecycle bus event to the sweep's next state. The combat-bar
 * subscribes to spellCastInitiated / spellCastResolved / spellCastRejected and
 * feeds each through this: a LOCAL caster's `initiated` turns the sweep on for
 * `estDurationMs` (or a fallback); a remote caster's is ignored; resolved /
 * rejected clear it. Mirrors the spellCastInitiated.attackerGuid local-filter
 * contract (§3.3): emit for all casters, let the consumer filter on identity.
 *
 * @param {{type:string, attackerGuid?:number, localGuid?:number,
 *          estDurationMs?:number, fallbackMs?:number}} event
 * @returns {{casting:boolean, ms:number, ignored?:boolean}}
 */
export function castSweepReducer(event) {
  const t = event?.type;
  if (t === "spellCastResolved" || t === "spellCastRejected") {
    return { casting: false, ms: 0 };
  }
  if (t === "spellCastInitiated") {
    const lg = (event.localGuid ?? 0) >>> 0;
    const who = event.attackerGuid;
    // Only the LOCAL caster's begin drives the local player's UI sweep.
    if (who != null && (who >>> 0) !== lg) {
      return { casting: false, ms: 0, ignored: true };
    }
    const ms = Number.isFinite(+event.estDurationMs)
      ? +event.estDurationMs
      : Number.isFinite(+event.fallbackMs) ? +event.fallbackMs : 2000;
    return { casting: true, ms };
  }
  return { casting: false, ms: 0, ignored: true };
}
