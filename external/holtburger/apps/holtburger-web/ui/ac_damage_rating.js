// Wave 7 / Phase 20 — Damage Rating rollup helper.
//
// Pure-function rollup of the player's predicted outgoing Damage Rating
// for a single hit. The acpedia Combat omnibus + Damage Rating pages
// describe DR as a flat additive: every active source contributes a
// signed integer that sums into the `(100 + DR) / 100` multiplier on
// outgoing damage. This helper covers the two skill-gated sources that
// the client can predict pre-hit (server is authoritative; mismatches
// reconcile via the eventual damage-dealt event):
//
//   - Recklessness (SkillType 50): +10 trained / +20 specialized,
//     gated on a UI-side power-band (10%–90% of the combat-bar slider
//     per the Combat omnibus page; the per-skill page disagrees with
//     20%–80% — see `docs/acpedia-combat-research-2026-05-26.md`).
//     Activates only when the slider lands inside the band.
//   - Sneak Attack (SkillType 51): +10 trained / +20 specialized,
//     gated on attacker-position-vs-defender-facing (90° rear
//     hemisphere per `Creature_Combat.cs:763`). The `hasSneak` flag
//     comes from upstream emitters (Phase 9 melee/missile, Phase 16
//     magic) that already ran the facing predicate.
//
// Both sources stack — a rear attack at 0.5 power with both skills
// specialized yields +40 DR (`{ base: 0, sneak: 20, reckless: 20,
// total: 40 }`).
//
// TODO (out of scope this phase): `base` is reserved for per-weapon /
// per-armor DR plumbed off the wire (PropertyInt `Damage_Rating`,
// `Damage_Resist_Rating`, etc). Surface from `WieldedWeaponEntry` once
// available; today `base` is always 0.

// SkillType enum values — see
// `external/holtburger/crates/holtburger-common/src/stats.rs:156-158`
// (`Recklessness = 50, SneakAttack = 51`). The TrainingLevel enum:
// `0=Unusable, 1=Untrained, 2=Trained, 3=Specialized` at
// `stats.rs:287`.
export const SKILL_RECKLESSNESS = 50;
export const SKILL_SNEAK_ATTACK = 51;

// TrainingLevel sentinels for the DR rollup. Same values as
// `plugins/combat-bar.js`'s `TRAINING_TRAINED` / `TRAINING_SPECIALIZED`
// constants. Re-exported here so the helper is self-contained.
export const TRAINING_UNUSABLE = 0;
export const TRAINING_UNTRAINED = 1;
export const TRAINING_TRAINED = 2;
export const TRAINING_SPECIALIZED = 3;

// Recklessness active band per the acpedia Combat omnibus page.
// Inclusive on both ends (band semantics are "inside the band" per the
// wiki; the per-skill page's "20–80%" is the dissenting source but the
// Combat omnibus is the more recent + canonical edit).
export const RECKLESSNESS_BAND_MIN = 0.10;
export const RECKLESSNESS_BAND_MAX = 0.90;

// DR contribution per training level. Matches the acpedia +10 trained /
// +20 specialized values. Both Recklessness and Sneak Attack share the
// same magnitude curve, so a single lookup table covers both.
const DR_BY_TRAINING = Object.freeze({
  [TRAINING_TRAINED]: 10,
  [TRAINING_SPECIALIZED]: 20,
});

/**
 * Reads the local player's training level for `skillType` from the
 * session handle's stats snapshot. Returns the integer training level
 * (0..3) or `null` when stats/skills aren't available yet (pre-login,
 * pre-PlayerDescription, accessor throws).
 *
 * Mirrors `plugins/combat-bar.js`'s `readRecklessnessTrainingLevel`
 * pattern. The wasm-side `playerStats().skills` is a flat `Vec<u32>`
 * of 5-tuples `[type, current, base, ranks, training]` sorted by
 * SkillType — see `src/lib.rs:13911-13915`.
 *
 * @param {number} skillType  SkillType enum value (see stats.rs).
 * @param {object|null} [sessionHandle]  Optional session handle for
 *   testing; falls back to `window.__sessionHandle`.
 * @returns {number|null}  TrainingLevel (0..3) or null.
 */
export function readTrainingLevel(skillType, sessionHandle = null) {
  try {
    const handle = sessionHandle
      ?? ((typeof window !== "undefined") ? window.__sessionHandle : null);
    if (!handle || typeof handle.playerStats !== "function") return null;
    const stats = handle.playerStats();
    const skills = stats?.skills;
    if (!skills) return null;
    const len = skills.length ?? 0;
    if (len === 0) return null;
    // 5-tuples: [type, current, base, ranks, training]
    for (let i = 0; i + 4 < len; i += 5) {
      if (skills[i] === skillType) {
        return skills[i + 4] ?? 0;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Computes the predicted outgoing Damage Rating rollup for the next
 * swing given the current power-bar slider value and whether the
 * sneak-attack facing predicate fired (from picking.js's upstream
 * `sneakAttackPredicted` event).
 *
 * Returns a `{ base, sneak, reckless, total }` breakdown so consumers
 * can surface individual sources (e.g. the HUD plugin shows the sneak
 * component; the combat-bar already visualizes the reckless band).
 *
 * @param {object} opts
 * @param {number} opts.powerLevel  Combat-bar slider value, 0..1.
 *   Used to gate Recklessness's 10%–90% active band.
 * @param {boolean} opts.hasSneak   Whether the upstream Sneak Attack
 *   facing predicate fired this swing.
 * @param {object|null} [opts.sessionHandle]  Optional session-handle
 *   override for testing.
 * @returns {{base: number, sneak: number, reckless: number, total: number}}
 */
export function computeDamageRatingRollup({ powerLevel, hasSneak, sessionHandle = null } = {}) {
  // base: placeholder for future per-weapon / per-armor DR plumbed
  // off the wire (PropertyInt Damage_Rating et al). Out of scope this
  // phase; documented TODO at the top of the module.
  const base = 0;

  // sneak: gated on the upstream facing predicate. The training-level
  // lookup is short-circuited when `hasSneak` is false to avoid a
  // pointless `playerStats()` call (the accessor is non-trivial; it
  // walks the wasm-side Entity props on every call).
  let sneak = 0;
  if (hasSneak) {
    const sneakTraining = readTrainingLevel(SKILL_SNEAK_ATTACK, sessionHandle);
    sneak = DR_BY_TRAINING[sneakTraining] ?? 0;
  }

  // reckless: gated on the power-bar landing inside the 10%–90% band.
  // Inclusive on both ends per the Combat omnibus reading. NaN /
  // non-numeric `powerLevel` → out of band (no bonus, no penalty).
  let reckless = 0;
  if (
    typeof powerLevel === "number"
    && Number.isFinite(powerLevel)
    && powerLevel >= RECKLESSNESS_BAND_MIN
    && powerLevel <= RECKLESSNESS_BAND_MAX
  ) {
    const recklessTraining = readTrainingLevel(SKILL_RECKLESSNESS, sessionHandle);
    reckless = DR_BY_TRAINING[recklessTraining] ?? 0;
  }

  const total = base + sneak + reckless;
  return { base, sneak, reckless, total };
}
