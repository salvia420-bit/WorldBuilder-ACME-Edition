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
// **Wave 10 / Phase 29 (2026-05-26)** — per-weapon `base` contribution
// is now wired off the equipped weapon's `PropertyFloat::DamageMod = 63`
// (ACE `BaseDamageMod.cs:52`: `weapon.GetProperty(PropertyFloat.DamageMod)
// ?? 1.0f`). The conversion to additive DR-percent is
// `base = round((damageMod - 1.0) * 100)`, clamped at 0 for neutral or
// sub-neutral weapons (DamageMod ≤ 1.0). So a Yumi (DamageMod 1.5)
// contributes `+50`, Crystal Sword (1.0) contributes `0`, and a damaged
// weapon (0.8) contributes `0` (we don't surface negative DR here
// because acpedia frames DR as a flat *additive bonus*, and a weapon's
// sub-1.0 multiplier composes into the final damage *multiplicatively*,
// not via the +/- DR channel). Source the weapon either via the
// `weapon` opt (caller-provided plain object with `damageMod`) or by
// scanning `sessionHandle.playerInventory()` for the primary-weapon
// equip-slot occupant.
//
// Out of scope for now: per-armor PropertyInt `Damage_Resist_Rating`
// (defender side) and weapon-enchantment `EnchantmentManager.GetDamageMod`
// stacking. Both are server-resolved and arrive via the existing
// damage-event stream; this helper covers the predictable client-side
// weapon base only.

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

// EquipMask bits that mark a "primary weapon". Mirrors
// `scene3d/entities.js#getEquippedWeapon`'s local branch + the wasm-side
// `SessionHandle::entity_equipped_weapon`'s `PRIMARY_WEAPON_BITS` so the
// three call sites resolve the same item. See
// `holtburger_common::properties::EquipMask` for the canonical bit
// definitions.
const _PRIMARY_WEAPON_BITS_DR =
    0x00100000 /* MELEE_WEAPON */
  | 0x00400000 /* MISSILE_WEAPON */
  | 0x01000000 /* CASTER */
  | 0x02000000 /* TWO_HANDED */;

/**
 * Resolve the equipped weapon's `damageMod` (PropertyFloat 63) for the
 * DR-rollup `base` conversion. Resolution order:
 *   1. Explicit `weapon.damageMod` (caller-provided).
 *   2. `sessionHandle.playerInventory()` scan for the primary-weapon
 *      equip-slot occupant — mirrors `scene3d/entities.js#
 *      getEquippedWeapon` local branch precisely.
 *   3. `1.0` fallback (neutral; matches ACE `BaseDamageMod.cs:52`'s
 *      `weapon.GetProperty(PropertyFloat.DamageMod) ?? 1.0f`).
 *
 * Never throws; defensive against missing inventory accessor, NaN
 * values, non-numeric `damageMod`, etc. — the caller treats `1.0` as
 * the safe neutral fallback regardless of the failure mode.
 *
 * @param {{damageMod?: number}|null|undefined} weapon
 * @param {object|null} sessionHandle
 * @returns {number}  Resolved damageMod (defaults to 1.0).
 */
function _resolveEquippedWeaponDamageMod(weapon, sessionHandle) {
  // 1. Caller-provided weapon record — fast path. Validate the
  //    `damageMod` field is a real number; anything else falls
  //    through.
  if (weapon && typeof weapon === "object") {
    const dm = Number(weapon.damageMod);
    if (Number.isFinite(dm)) return dm;
  }

  // 2. Scan `sessionHandle.playerInventory()` for the local player's
  //    primary weapon. The accessor is the same wasm export
  //    `scene3d/entities.js#getEquippedWeapon` reads.
  try {
    const handle =
      sessionHandle
      ?? ((typeof window !== "undefined") ? window.__sessionHandle : null);
    if (!handle || typeof handle.playerInventory !== "function") return 1.0;
    const inventory = handle.playerInventory();
    if (!Array.isArray(inventory) || inventory.length === 0) return 1.0;
    for (const item of inventory) {
      const mask = (item?.equipMask ?? 0) >>> 0;
      if ((mask & _PRIMARY_WEAPON_BITS_DR) === 0) continue;
      const dm = Number(item.damageMod);
      return Number.isFinite(dm) ? dm : 1.0;
    }
  } catch {
    // Defensive: any wasm-bridge surprise falls back to neutral.
  }

  // 3. No weapon, no session, no PropertyFloat 63 yet — neutral.
  return 1.0;
}

/**
 * Computes the predicted outgoing Damage Rating rollup for the next
 * swing given the current power-bar slider value and whether the
 * sneak-attack facing predicate fired (from picking.js's upstream
 * `sneakAttackPredicted` event).
 *
 * Returns a `{ base, sneak, reckless, total, currentPowerMod,
 * accuracyMod }` breakdown so consumers can surface individual sources
 * (e.g. the HUD plugin shows the sneak component; the combat-bar
 * already visualizes the reckless band).
 *
 * **Wave 9 / Phase 28 (2026-05-26)** — `currentPowerMod` / `accuracyMod`
 * carry the SERVER's resolved power/accuracy modifiers
 * (`PropertyFloat::CurrentPowerMod = 23` and `AccuracyMod = 24` per
 * `holtburger_common::properties::PropertyFloat`), which are **distinct
 * from** the `powerLevel` argument (that's the local slider input
 * position). These are observational additions for diag/UI consumers —
 * the `total` math is unchanged (`base + sneak + reckless`); the
 * resolved modifiers DO NOT contribute to `total`. When provided as
 * explicit `currentPowerMod` / `accuracyMod` opts, those values flow
 * through unchanged (NaN → null). When `sessionHandle` is given and
 * exposes a `playerResolvedModifiers()` getter (the wasm-side
 * `SessionHandle::playerResolvedModifiers` export), it is consulted as
 * a fallback for any opt that wasn't passed.
 *
 * @param {object} opts
 * @param {number} opts.powerLevel  Combat-bar slider value, 0..1.
 *   Used to gate Recklessness's 10%–90% active band.
 * @param {boolean} opts.hasSneak   Whether the upstream Sneak Attack
 *   facing predicate fired this swing.
 * @param {object|null} [opts.sessionHandle]  Optional session-handle
 *   override for testing.
 * @param {number|null|undefined} [opts.currentPowerMod]  Optional
 *   server-resolved CurrentPowerMod. When omitted, falls back to
 *   `sessionHandle.playerResolvedModifiers()[0]` if available.
 * @param {number|null|undefined} [opts.accuracyMod]  Optional
 *   server-resolved AccuracyMod. When omitted, falls back to
 *   `sessionHandle.playerResolvedModifiers()[1]` if available.
 * @param {{damageMod?: number}|null|undefined} [opts.weapon]  Optional
 *   pre-resolved equipped-weapon record (the shape
 *   `scene3d/entities.js#getEquippedWeapon` returns). When provided,
 *   `damageMod` flows straight into the `base` conversion. When
 *   omitted, the helper falls back to `sessionHandle.playerInventory()`
 *   and scans for the primary-weapon equip-slot occupant.
 * @returns {{base: number, sneak: number, reckless: number, total: number, currentPowerMod: number|null, accuracyMod: number|null}}
 */
export function computeDamageRatingRollup({
  powerLevel,
  hasSneak,
  sessionHandle = null,
  currentPowerMod,
  accuracyMod,
  weapon,
} = {}) {
  // base: per-weapon DR contribution (Wave 10 / Phase 29).
  // Source order:
  //   1. Explicit `weapon.damageMod` opt (caller-side; lets HUD plugins
  //      pre-resolve via `scene3d/entities.js#getEquippedWeapon(localGuid)`
  //      and avoid two inventory scans per frame).
  //   2. `sessionHandle.playerInventory()` scan for the primary-weapon
  //      equip-slot occupant — mirrors the entities.js local branch.
  //   3. `1.0` (neutral; contributes 0 base DR).
  // Conversion: `base = round((damageMod - 1.0) * 100)`. Clamped at 0
  // for sub-1.0 (damaged/penalty) weapons since acpedia's DR channel is
  // an additive *bonus*. ACE `BaseDamageMod.cs:13` documents
  // `DamageMod = 1.0f` as the multiplier's neutral baseline.
  const resolvedDamageMod = _resolveEquippedWeaponDamageMod(weapon, sessionHandle);
  const base =
    resolvedDamageMod > 1.0
      ? Math.round((resolvedDamageMod - 1.0) * 100)
      : 0;

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

  // Phase 28: server-resolved CurrentPowerMod / AccuracyMod surface.
  // Observational only — DO NOT fold into `total`. Resolution order:
  //   1. Explicit `currentPowerMod`/`accuracyMod` opts (caller-side).
  //   2. `sessionHandle.playerResolvedModifiers()` if the method exists.
  //   3. `null` (no surface available).
  // NaN normalized to null at every step (mirrors the diag layer's
  // `_readServerResolvedModifiers` Phase 11 pattern).
  let resolvedFromHandle = null;
  if (
    (currentPowerMod === undefined || accuracyMod === undefined)
    && sessionHandle
    && typeof sessionHandle.playerResolvedModifiers === "function"
  ) {
    try {
      const arr = sessionHandle.playerResolvedModifiers();
      if (arr && arr.length >= 2) {
        resolvedFromHandle = [Number(arr[0]), Number(arr[1])];
      }
    } catch {
      resolvedFromHandle = null;
    }
  }
  const _normalizeMod = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const cpmOut = _normalizeMod(
    currentPowerMod !== undefined ? currentPowerMod : (resolvedFromHandle ? resolvedFromHandle[0] : null),
  );
  const amOut = _normalizeMod(
    accuracyMod !== undefined ? accuracyMod : (resolvedFromHandle ? resolvedFromHandle[1] : null),
  );

  const total = base + sneak + reckless;
  return {
    base,
    sneak,
    reckless,
    total,
    currentPowerMod: cpmOut,
    accuracyMod: amOut,
  };
}
