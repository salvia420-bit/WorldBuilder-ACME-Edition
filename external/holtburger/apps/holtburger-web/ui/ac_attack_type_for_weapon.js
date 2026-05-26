/**
 * AttackType inference from an equipped weapon — Wave 1 / Phase 3 of
 * the CombatManeuverTable fixes plan (docs/cmt-fixes-plan-2026-05-26.md).
 *
 * Replaces the hardcoded `ATTACK_TYPE_SLASH` in `scene3d/picking.js:441`
 * so the CMT lookup actually keys on the player's wielded weapon
 * instead of always assuming Slash.
 *
 * ## Sources cross-referenced
 *
 * - **ACE enum (canonical):**
 *   `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`
 *   defines `Undef=0x0000, Punch=0x0001, Thrust=0x0002, Slash=0x0004,
 *   Kick=0x0008, OffhandPunch=0x0010, DoubleSlash=0x0020, …`.
 *   `Unarmed = Punch | Kick | OffhandPunch` — but the CMT runtime
 *   looks up the *primary* AttackType bit, not the composite, so we
 *   emit `Punch` alone for unarmed (matching the dominant retail
 *   row in `CombatManeuverTable.cs::GetMotion`).
 *
 * - **ACE weapon dispatch (the function we'd port if W_AttackType were
 *   on the wire):**
 *   `~/ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050`
 *   `GetAttackType(MotionStance, powerLevel, offhand)` reads
 *   `W_AttackType` (= `PropertyInt::AttackType = 47` per
 *   `~/ace-server/Source/ACE.Entity/Enum/Properties/PropertyInt.cs:78`)
 *   off the weapon entity, then mutates by stance + powerLevel +
 *   ThrustThreshold (DualWieldCombat / SwordShieldCombat / SwordCombat
 *   branches + the universal `Thrust | Slash → Thrust below threshold,
 *   Slash above` collapse on lines 1154-1160). **Note:** `GetAttackType`
 *   itself NEVER branches on `WeaponType` — every dispatch decision is
 *   driven off `W_AttackType` bits. For TwoHandedCombat stance there is
 *   no special-case branch at all; the raw `W_AttackType` is returned
 *   (after the universal Thrust|Slash collapse).
 *
 *   We CANNOT directly port that today — `PropertyInt::AttackType` is
 *   NOT surfaced on the entity-update wire (see TODO in
 *   `scene3d/entities.js#getEquippedWeapon`). The fallback used here
 *   keys off the equip-slot bitmask + ItemType, which is what we DO
 *   have. Stance + power-threshold awareness lands in Wave 2 Phase 4
 *   alongside the candidate-selection algorithm fix.
 *
 * - **Retail WeaponType enum (for cross-check):**
 *   `~/ac-headers/acclient.h:7095 enum WeaponType` —
 *   `Undef=0x0, Unarmed=0x1, Sword=0x2, Axe=0x3, Mace=0x4, Spear=0x5,
 *   Dagger=0x6, Staff=0x7, Bow=0x8, Crossbow=0x9, Thrown=0xA,
 *   TwoHanded=0xB, Magic=0xC`. ACE mirrors this in
 *   `~/ace-server/Source/ACE.Entity/Enum/WeaponType.cs`.
 *   `PropertyInt::WeaponType = 353` (per
 *   `~/ace-server/Source/ACE.Entity/Enum/Properties/PropertyInt.cs:556`)
 *   carries it on the wire. Not surfaced today either; same TODO.
 *
 * - **EquipMask we DO have (from `holtburger_common::properties::EquipMask`):**
 *   `MELEE_WEAPON=0x00100000, SHIELD=0x00200000, MISSILE_WEAPON=0x00400000,
 *   MISSILE_AMMO=0x00800000, CASTER=0x01000000, TWO_HANDED=0x02000000`.
 *
 * ## Precedence (Wave 6 / Phase 15, 2026-05-26)
 *
 * Effective precedence after Phase 15 wired `W_AttackType` through to
 * the renderer:
 *
 *   1. **Wire `W_AttackType`** — if `weapon.attackType` is non-zero,
 *      return that bitmask verbatim. Multi-bit values
 *      (e.g. `Thrust|Slash = 0x06` for many swords,
 *      `DoubleSlash|DoubleThrust = 0xA0` for daggers) are passed
 *      through as-is; `getCombatManeuver` handles the multi-bit
 *      branch via the picker's `IsThrustSlash` family. Source:
 *      `PropertyInt::AttackType = 47` on the weapon entity, surfaced
 *      via `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`
 *      onto `EquippedWeaponJs.attackType` and `InventoryItem.attackType`.
 *   2. **EquipMask heuristic** — when `attackType` is `0` or missing
 *      (pre-property-arrival ObjectCreate, or non-weapon items that
 *      somehow reach this helper) the legacy equip-slot mapping
 *      kicks in. Still useful because PropertyInt 47 sometimes lags
 *      the equip-slot bit by a packet or two during fast equip
 *      cycles.
 *   3. **Undef fallback** — caller's `ATTACK_TYPE_SLASH` constant in
 *      `picking.js` fills in when this helper returns `0`.
 *
 * ## Mapping table (Wave 6 wire-first, with Waves 1+2+5 fallback)
 *
 *   | Input                                                | AttackType returned                   |
 *   |------------------------------------------------------|---------------------------------------|
 *   | `weapon === null`  (unarmed)                         | `Punch  = 0x01`                       |
 *   | `weapon.attackType > 0` (wire path)                  | `weapon.attackType` verbatim          |
 *   | `equipMask & TWO_HANDED`   (wire 0, fallback)        | `Slash  = 0x04`  (legacy heuristic)   |
 *   | `equipMask & MELEE_WEAPON` (wire 0, fallback)        | `Slash  = 0x04`                       |
 *   | `equipMask & MISSILE_WEAPON` (wire 0, fallback)      | `Undef  = 0x00`  (see Phase 6 audit)  |
 *   | `equipMask & MISSILE_AMMO`   (wire 0, fallback)      | `Undef  = 0x00`  (see Phase 6 audit)  |
 *   | `equipMask & CASTER`         (wire 0, fallback)      | `Undef  = 0x00`  (magic path)         |
 *   | anything else (e.g. SHIELD-only)                     | `Undef  = 0x00`                       |
 *
 * Why `Slash` for all melee weapons in this iteration:
 *   - Dominant retail AttackType for sword / axe / mace / two-handed
 *     families in the live CMT 0x30000000 is `Slash` (the maneuver
 *     table has `SlashHigh`, `SlashMed`, `SlashLow` rows for
 *     SwordCombat, TwoHandedCombat, etc).
 *   - Dagger families carry `Thrust | Slash` in `W_AttackType` at
 *     retail; ACE's `GetAttackType` collapses to `Thrust` below the
 *     ThrustThreshold power-bar position and `Slash` above. Without
 *     stance + power on this code path (Wave 2), the safer single
 *     choice is `Slash` because the CMT actually has `SlashMed` rows
 *     under DaggerCombat stance, while `ThrustMed` is a separate row
 *     that gets handled in Wave 2 Phase 4 when stance-awareness is
 *     wired.
 *   - Unmapped (caster / ranged / shield-only) returns `Undef = 0` so
 *     the caller falls back to the existing `ATTACK_TYPE_SLASH`
 *     constant — keeps combat working while we extend coverage.
 *
 * ### Phase 13 (Two-Handed Combat AttackType) audit finding — 2026-05-26 (Wave 5)
 *
 * **The hardcoded `Slash` for TWO_HANDED is wrong for two-handed
 * spears/polearms and for two-handed swords at low power.** Two-Handed
 * Combat (Skill 44) is a *single* skill spanning multiple weapon-type
 * families, and ACE's `GetAttackType` reads each weapon's own
 * `W_AttackType` rather than discriminating by family.
 *
 * Survey of 646 TwoHandedCombat weapons in
 * `external/LSD-Partial-2025-02-23_16-15/weenies/` (every weenie with
 * `WeaponSkill (PropertyInt 48) == Skill.TwoHandedCombat (44)`):
 *
 *   | WeaponType (PropertyInt 353) | Dominant W_AttackType (PropertyInt 47) |
 *   |------------------------------|-----------------------------------------|
 *   | Axe (3)                      | Slash         — 253/253  (100%)         |
 *   | Mace (4)                     | Slash         — 64/65    (98%)          |
 *   | Sword (2)                    | Thrust\|Slash — 85/102   (84%)          |
 *   | Staff (7)                    | Thrust\|Slash — 38/41    (93%)          |
 *   | Spear (5)                    | Thrust        — 38/43    (88%)          |
 *   | Dagger (6)                   | DoubleSlash\|DoubleThrust — 15/41 (37%) |
 *   | Unarmed (1)                  | Punch         — 46/48    (96%)          |
 *
 * Net: Slash is correct for Axes/Maces (covers ~318 of 646 = 49%) but
 * **incorrect for Spears (88% Thrust) and incorrect for ~half of Swords
 * (Thrust|Slash → power-threshold-driven, currently we'd emit Slash even
 * at 0% power where retail would emit Thrust)**. Roughly 35-40% of
 * two-handed weapons play the wrong CMT row under the current logic.
 *
 * **Resolution (Wave 6 / Phase 15, 2026-05-26):** wire surfacing
 * shipped — `WieldedWeaponEntry`/`EquippedWeaponJs`/`InventoryItem` in
 * `apps/holtburger-web/src/lib.rs` now all carry `attack_type: u32`
 * populated via `entity.get_int_prop(PropertyInt::AttackType)` at the
 * `apply_inventory_object_create` and `publish_player_inventory_snapshot`
 * sites. `inferAttackTypeForWeapon` prefers the wire value verbatim
 * when non-zero (single- or multi-bit) and only falls back to the
 * EquipMask heuristic for pre-property-arrival ObjectCreate events.
 * Two-handed spears now play the Thrust family, swords play
 * Thrust|Slash (handled at lookup time by the picker's
 * `IsThrustSlash` branch in `getCombatManeuver`).
 *
 * The historical decision rationale (kept here because the underlying
 * tradeoffs are still relevant for any future "we can't ship wire X"
 * call) was:
 *   1. A wcid-keyed lookup table (option a) would need ~646 entries for
 *      TwoHandedCombat alone, ~3,000+ for full melee coverage. It would
 *      diverge from retail every time a server adds custom weapons (any
 *      ACE shard with houserules). Brittle.
 *   2. A name-substring lookup (option b) is even worse — names are
 *      localized and decorative (Frost Partizan = Spear; Burnja's Board
 *      with Nails = Mace; Ultimate Singularity Spear vs Phantom Spear =
 *      both Spears with different W_AttackType because of mutator runs).
 *   3. The real fix was wire surfacing — done in Phase 15. ACE already
 *      populates `PropertyInt::AttackType` on the server side for any
 *      wielded weapon; we just needed to thread it through the wasm
 *      bridge. Porting `WorldObject_Weapon.cs:1050 GetAttackType`
 *      verbatim (stance/powerLevel branch tree, including the
 *      ThrustThreshold collapse) is still a follow-on if Wave 2 Phase 4
 *      ever needs more nuance — today the multi-bit `Thrust|Slash`
 *      values pass through to the CMT picker which handles them via
 *      `IsThrustSlash`.
 *
 * ### Phase 14 (Light Weapons / Unarmed) audit finding — 2026-05-26 (Wave 5)
 *
 * `inferAttackTypeForWeapon(null) → Punch (0x01)` is CORRECT for the
 * wire-level AttackType code. The post-Master-of-Arms (Feb 2012) reality
 * is that unarmed swings are gated by **LightWeapons (Skill enum value
 * 47)** — see `~/ace-server/Source/ACE.Entity/Enum/Skill.cs:58` — not by
 * a separate Unarmed skill. The acpedia Light Weapons page confirms
 * "Also helps you punch and kick" — the skill explicitly subsumes
 * pre-MoA UnarmedCombat. Skill-gating happens server-side; the
 * AttackType code we send to the CMT stays `Punch = 0x01` (or `Kick`,
 * see Phase 21 below).
 *
 * ### Phase 21 (Unarmed AttackType height vs power audit) — 2026-05-26 (Wave 7)
 *
 * **Resolution: retail/ACE resolves unarmed AttackType via POWER LEVEL,
 * not attack height, and there is NO separate "Jab" AttackType.**
 *
 * Five-source audit (in priority order):
 *
 *   1. **ACE swing dispatch — `Player_Melee.cs:462`:**
 *      ```csharp
 *      // ~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:440-475
 *      // GetSwingAnimation():
 *      var weapon = GetEquippedMeleeWeapon();
 *      if (weapon != null) {
 *          AttackType = weapon.GetAttackType(stance, PowerLevel, offhand);
 *      } else {
 *          // ← THE UNARMED BRANCH (the one we cared about):
 *          AttackType = PowerLevel > KickThreshold && !IsDualWieldAttack
 *              ? AttackType.Kick
 *              : AttackType.Punch;
 *      }
 *      ```
 *      with `KickThreshold = 0.75f` declared at `Player_Melee.cs:432`.
 *      Unarmed never reaches `WorldObject_Weapon.cs:1050 GetAttackType`
 *      at all (no weapon entity to read `W_AttackType` from); the unarmed
 *      AttackType decision lives entirely in `Player_Melee.GetSwingAnimation`.
 *
 *   2. **CMT 0x30000000 HandCombat (stance 0x8000003C) row inventory:**
 *      Direct dump via `crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs`
 *      against `~/ac_base_dats/client_portal.dat` (2026-05-26):
 *      ```
 *      h=High (1):  Punch motion=0x10000065, Kick motion=0x10000068,
 *                   OffhandPunch motion=0x10000062
 *      h=Med  (2):  Punch motion=0x10000063, Punch motion=0x10000066,
 *                   Kick motion=0x10000069
 *      h=Low  (3):  Punch motion=0x10000064, Punch motion=0x10000067,
 *                   Kick motion=0x1000006A
 *      ```
 *      Both Kick AND Punch rows exist at all three heights, so the CMT
 *      data itself rules out the "Kick is height-gated" hypothesis. The
 *      AttackType column is what discriminates them.
 *
 *   3. **MotionCommand enum (`MotionCommand.cs:407-412` only has
 *      `PunchFastHigh/Med/Low` and `PunchSlowHigh/Med/Low` for offhand
 *      duals — `0x1000018f` through `0x10000194`). The base HandCombat
 *      motion clips at `0x10000062`-`0x1000006A` are named
 *      `AttackHigh1/2/3`, `AttackMed1/2/3`, `AttackLow1/2/3` per
 *      `data/motion-command-names.json` — they're GENERIC motion slots
 *      whose semantic identity (Punch vs Kick) is supplied by the CMT
 *      row's `attackType` field. There is NO `Jab*` entry in the entire
 *      `MotionCommand.cs` enum.
 *
 *   4. **Retail acclient.c (Hex-Rays decomp):** the only hits on "Kick"
 *      / "Punch" outside of the motion-string label table (`OffhandKick`,
 *      `PunchFastHigh`, etc. at `acclient.c:43841`-`43862`) are
 *      `gmAllegianceUI::CloseKickConfirmationDialog` and friends — i.e.
 *      the allegiance "kick vassal" UI dialog, totally unrelated to
 *      combat. There is no client-side power-threshold-driven AttackType
 *      selection in the retail client. The client sends the swing
 *      request + power slider; the server picks the AttackType and the
 *      resulting motion command. This matches ACE's architecture
 *      (combat dispatch is server-authoritative).
 *
 *   5. **acpedia Combat omnibus (`_ref_Combat.txt:152-165`):** the
 *      maneuver table verbatim:
 *      ```
 *      Kick   | Unarmed | Full   | 150%
 *      Punch  | Unarmed | Medium | 100%
 *      Jab    | Unarmed | Low    |  50%
 *      ```
 *      The "Full/Medium/Low" column is **Power Bar** (the table header
 *      sequence "Maneuver / Weapon Class / Power Bar / Damage"). The
 *      "Jab" entry is the wiki's marketing name for a low-power Punch
 *      — there is no Jab AttackType enum value (`AttackType.cs:8-25`),
 *      no Jab MotionCommand, and no server-side Jab branch. At low and
 *      medium power, ACE emits `AttackType.Punch` and the CMT runtime's
 *      multi-candidate Punch rows (two Punch motions per Med/Low height)
 *      give the visual variety the wiki labels "Jab" vs "Punch".
 *
 * **Implementation:** extended `inferAttackTypeForWeapon(weapon, opts)`
 * with optional `opts.powerLevel: number` (0..1) + `opts.isDualWield:
 * boolean`. When `weapon == null` (unarmed):
 *
 *   - `powerLevel > 0.75 && !isDualWield` → `Kick = 0x08`
 *   - otherwise → `Punch = 0x01`
 *
 * The `!isDualWield` clause exactly mirrors `Player_Melee.cs:462`
 * (`!IsDualWieldAttack`). Backward-compat: callers passing only the
 * weapon argument (one-arg form) get the legacy `Punch = 0x01` answer
 * regardless of power. Wiring `opts.powerLevel` from `picking.js` and
 * `index.html`'s `dispatchRemoteSwing` call sites is a follow-on (the
 * power slider state is already in scope there per
 * `picking.js:462 cb.powerLevel`); the signature extension here is
 * non-breaking. The legacy `Skill.UnarmedCombat` (Skill enum value 14,
 * `Skill.cs:26`) is retained in ACE only for legacy/data-migration
 * paths — see `WorldObject_Weapon.cs:851` for the legacy-skill compat
 * list in `GetImbuedSkillType`. It is NOT what gates unarmed swings on
 * post-MoA servers.
 *
 * ### Phase 22 (Two-handed-spear "visual jab" quirk) — 2026-05-26 (Wave 8)
 *
 * **User clarification (2026-05-26):** "the two hand spear (there are a
 * variety of spear or spearlike two hand weapons) do use a jabbing-type
 * animation." Phase 21's dismissal of "Jab" above is about the
 * `AttackType` / `MotionCommand` enums — verified, no `Jab*` value
 * exists. But the *visual* jab the user describes is real: it's the
 * forward-thrust motion clip the CMT returns when a two-handed spear
 * (Pike / Halberd / Naginata / Yari / Partizan / Glaive / Lance / etc.)
 * is swung. The clip resolves via the bog-standard CMT lookup —
 * `(stance = TwoHandedSwordCombat, height, AttackType = Thrust)` →
 * `ThrustHigh/Med/Low` motion clips. No special enum, no special
 * branch; just the correct AttackType bitmask flowing through the
 * existing pipeline.
 *
 * **The stance two-handed spears use is `TwoHandedSwordCombat
 * (0x80000044)`, NOT `TwoHandedStaffCombat (0x80000045)`.** Empirically
 * confirmed by Wave 8 audit. Two evidence sources agree:
 *
 *   1. **ACE source — `Creature_Combat.GetWeaponStance`:**
 *      ```csharp
 *      // ~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs:330-334
 *      case CombatStyle.TwoHanded:
 *          // MotionStance.TwoHandedStaffCombat doesn't appear to do anything
 *          // Additionally, PropertyInt.WeaponType isn't always included, and
 *          // the 2handed weapons that do appear to use WeaponType.TwoHanded
 *          combatStance = MotionStance.TwoHandedSwordCombat;
 *          break;
 *      ```
 *      ACE collapses ALL `CombatStyle.TwoHanded` weapons — pikes,
 *      halberds, naginatas, tetsubo, nodachi, two-handed swords — into
 *      one stance. The thrust-vs-slash distinction is carried entirely
 *      by `W_AttackType` (PropertyInt 47).
 *
 *   2. **CMT 0x30000000 audit — `dump_two_handed_spear_motions.rs`:**
 *      Direct dump against `~/ac_base_dats/client_portal.dat`
 *      (2026-05-26) confirmed:
 *      ```
 *      TwoHandedSwordCombat   High     Thrust   0x2   ThrustHigh (0x1000005A)
 *      TwoHandedSwordCombat   Medium   Thrust   0x2   ThrustMed  (0x10000058)
 *      TwoHandedSwordCombat   Low      Thrust   0x2   ThrustLow  (0x10000059)
 *      ── per-stance counts ──
 *      0x80000044 TwoHandedSwordCombat -> 3 rows (Thrust-family)
 *      0x80000045 TwoHandedStaffCombat -> 0 rows
 *      ```
 *      The `TwoHandedStaffCombat` stance literally has zero rows in the
 *      retail CMT — empirical confirmation of ACE's "doesn't appear to
 *      do anything" comment. Every two-handed weapon's CMT lookup
 *      lands under `0x80000044`.
 *
 * **Resolved motion family (the "jab" clips):**
 *
 *   | AttackHeight | Motion u32   | Motion name |
 *   |--------------|--------------|-------------|
 *   | High (1)     | `0x1000005A` | `ThrustHigh` |
 *   | Medium (2)   | `0x10000058` | `ThrustMed`  |
 *   | Low (3)      | `0x10000059` | `ThrustLow`  |
 *
 * These three motion clips ARE the visual "jab" the wiki / community
 * describes — forward-thrust animation, polearm/spear-shaped weapon
 * thrust forward. Same clip set the two-handed sword community calls a
 * "thrust"; the difference is purely the weapon mesh hanging off the
 * skeleton.
 *
 * **LSD weenie corroboration** (Wave 8 sample, all
 * `WeaponSkill (48) = 41 TwoHandedCombat`, all
 * `DefaultCombatStyle (46) = 8 TwoHanded`):
 *
 *   | wcid  | name                       | WeaponType (353) | W_AttackType (47) |
 *   |-------|----------------------------|------------------|-------------------|
 *   | 41046 | Pike                       | 11 (TwoHanded)   | 0x02 (Thrust)     |
 *   | 41041 | Magari Yari                | 11 (TwoHanded)   | 0x02 (Thrust)     |
 *   | 41635 | Ravenous Two Handed Spear  | 11 (TwoHanded)   | 0x02 (Thrust)     |
 *   | 41708 | Phantom Two Handed Spear   | 11 (TwoHanded)   | 0x02 (Thrust)     |
 *   | 42664 | Spear of Lost Truths       | 11 (TwoHanded)   | 0x02 (Thrust)     |
 *   | 29974 | Partizan (HeavyWeapons)    |  5 (Spear)       | 0x02 (Thrust)     |
 *   | 29970 | Partizan (LightWeapons)    |  5 (Spear)       | 0x02 (Thrust)     |
 *
 * Note `WeaponType` straddles two values for two-handed spears:
 * `Spear (5)` for pre-MoA-era weenies like Partizan, `TwoHanded (11)`
 * for Pikes/Yari/etc. This doesn't matter for stance resolution —
 * `GetWeaponStance` keys on `DefaultCombatStyle (8)` only and ignores
 * `WeaponType` entirely. The thrust-vs-slash distinction comes from
 * `W_AttackType` exclusively. (Some Halberd/Glaive variants carry
 * `Thrust|Slash = 0x06`; some Tetsubo/Nodachi carry pure `Slash =
 * 0x04`. All route through `TwoHandedSwordCombat` and have their
 * thrust component resolved here when the picker collapses multi-bit
 * `W_AttackType` via the `IsThrustSlash` branch.)
 *
 * **Pipeline tie-in:** Wave 6 / Phase 15 surfaced `W_AttackType` on the
 * wire (`apply_inventory_object_create` → `EquippedWeaponJs.attackType`
 * / `InventoryItem.attackType`); Wave 7 / Phase 21's
 * `inferAttackTypeForWeapon` returns it verbatim. So a Pike with
 * `W_AttackType = 0x02` arrives at `getCombatManeuver(stance =
 * TwoHandedSwordCombat, height, attackType = 0x02)` and resolves to one
 * of `ThrustHigh/Med/Low` — the visual jab — automatically. No code
 * change needed; this docstring section just documents *why* the visual
 * matches the wiki's terminology despite no `Jab*` enum value existing.
 *
 * **Audit script:**
 *   `crates/holtburger-dat/examples/dump_two_handed_spear_motions.rs`
 *   Run via
 *   `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
 *    cargo run -p holtburger-dat --example dump_two_handed_spear_motions`
 *
 * ### Phase 6 (ranged) audit finding — 2026-05-26 (Wave 2)
 *
 * **CMT 0x30000000 has ZERO rows for ranged stances.** The audit
 * script at `crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs`
 * confirms: of the 102 maneuvers in the live retail table, every row
 * is one of `HandCombat (0x8000003C)`, `SwordCombat (0x8000003E)`,
 * `SwordShieldCombat (0x80000040)`, `TwoHandedSwordCombat
 * (0x80000044)`, or `DualWieldCombat (0x80000046)`. There is no row
 * with stance `BowCombat (0x8000003F)`, `CrossbowCombat (0x80000041)`,
 * `SlingCombat (0x80000043)`, `ThrownWeaponCombat (0x80000047)`, or
 * `AtlatlCombat (0x8000013B)`.
 *
 * This matches ACE's server-side behaviour: `Player_Missile.cs:207`
 * picks `aimLevel` (a `MotionCommand.AimHighN` / `AimLowN` /
 * `AimLevel` value) directly from the projectile's z-angle in
 * `Creature_Missile.cs::GetAimLevel`, then plays that motion via
 * `EnqueueMotionPersist(actionChain, aimLevel)` at line 227. It never
 * calls `CombatTable.GetMotion(...)` for missile attacks.
 *
 * Implication for Phase 6:
 *   1. The ranged AttackType code we'd extend this helper with does
 *      not exist. There IS no CMT-table answer for the ranged path.
 *   2. Returning `Undef` for `MISSILE_WEAPON` / `MISSILE_AMMO` is the
 *      *correct* CMT answer — `getCombatManeuver(BowCombat, ...,
 *      Slash, ...)` will miss for any AttackType (the row isn't
 *      there), so the caller (`picking.js` missile branch) drops to
 *      `setSwingPose` after `getCombatManeuver` returns `null`. The
 *      Wave 1 fallback constant in `picking.js` would also miss for
 *      ranged stances, so the behaviour is the same either way.
 *   3. The real Phase 6 follow-on is a separate aim-level dispatch:
 *      port `Creature_Missile.cs:GetAimLevel` (z-angle → AimHigh*N* /
 *      AimLow*N* enum), then call `setSwingMotion(localGuid,
 *      aimLevel)` directly. That's NOT a CMT lookup — it's a parallel
 *      motion-dispatch path. Tracked as Wave 3 work; out of scope for
 *      Phase 6 as defined.
 *
 * Net Wave 2 change for this file: ranged branch stays `Undef`, but
 * the rationale shifts from "Phase 6 pending audit" → "audit
 * complete; ranged motions are not in the CMT, full stop." The
 * picking.js wiring (`scene3d/picking.js` missile branch) still
 * benefits from going through the helper + `getCombatManeuver` + the
 * `setSwingMotion`/`setSwingPose` fallback chain so the diag layer
 * sees the same shape for ranged attempts (miss reason = ranged
 * stance, will be visible in `motionByStance` once Phase 1's diag
 * captures missile swings).
 *
 * ## TODO (follow-ons surfaced by Wave 5 audits)
 *
 * - ~~**Surface `W_AttackType` (PropertyInt 47) on `InventoryItem`**~~
 *   **DONE — Wave 6 / Phase 15 (2026-05-26).** Both
 *   `EquippedWeaponJs` and `InventoryItem` now carry `attack_type: u32`
 *   populated from `PropertyInt::AttackType`; `inferAttackTypeForWeapon`
 *   prefers it over the EquipMask heuristic. Two-handed spears now
 *   play Thrust*, swords pass through Thrust|Slash to the CMT picker's
 *   `IsThrustSlash` branch. `W_WeaponType` (PropertyInt 353) surfacing
 *   is still open but lower priority — `GetAttackType` ignores
 *   WeaponType anyway, so it's only needed for the future damage /
 *   classification follow-ons.
 * - ~~**Height-aware AttackType selection for unarmed**~~
 *   **DONE — Wave 7 / Phase 21 (2026-05-26).** Audit established it's
 *   POWER-level driven (not height) and there's no Jab AttackType — see
 *   the "Phase 21 (Unarmed AttackType height vs power audit)" section
 *   above for the five-source audit. The helper now accepts
 *   `opts.powerLevel` (0..1) and `opts.isDualWield` and returns
 *   `Kick = 0x08` when `powerLevel > 0.75 && !isDualWield` for unarmed,
 *   matching `Player_Melee.cs:462` verbatim. Existing one-arg callers
 *   still get the legacy `Punch = 0x01` answer (backward-compat).
 *   Wiring `opts.powerLevel` through from the picking.js melee branch
 *   and the index.html dispatchRemoteSwing call site is a thin follow-on
 *   (the power slider value is already in scope at both sites).
 * - Wave 3 (ranged aim-level): port `Creature_Missile.cs::GetAimLevel`
 *   (z-angle → AimHigh{15,30,45,60,75,90} / AimLevel / AimLow{...})
 *   into a sibling helper at `ui/ac_aim_level_for_velocity.js` and
 *   call it from the picking.js missile branch alongside (or instead
 *   of) `getCombatManeuver`. The CMT lookup will always miss for
 *   ranged stances per the audit above; the aim-level dispatch is a
 *   separate motion path. **Shipped 2026-05-26 (Wave 3 Phase 7).**
 */

/**
 * ACE AttackType enum (subset). Verbatim bit values from
 * `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`. Only the
 * primary single-bit types are exported because the CMT runtime
 * indexes on single bits (`MotionStance, AttackHeight, AttackType
 * single-bit`), not composite flags. Composite values like
 * `Unarmed = Punch | Kick | OffhandPunch` are not useful for the
 * lookup key — they'd never match a single-bit table row.
 *
 * @type {Readonly<{
 *   Undef: 0, Punch: 1, Thrust: 2, Slash: 4, Kick: 8,
 *   OffhandPunch: 16, DoubleSlash: 32, TripleSlash: 64,
 *   DoubleThrust: 128, TripleThrust: 256,
 *   OffhandThrust: 512, OffhandSlash: 1024,
 *   OffhandDoubleSlash: 2048, OffhandTripleSlash: 4096,
 *   OffhandDoubleThrust: 8192, OffhandTripleThrust: 16384
 * }>}
 */
export const ATTACK_TYPE = Object.freeze({
  Undef:               0x0000,
  Punch:               0x0001,
  Thrust:              0x0002,
  Slash:               0x0004,
  Kick:                0x0008,
  OffhandPunch:        0x0010,
  DoubleSlash:         0x0020,
  TripleSlash:         0x0040,
  DoubleThrust:        0x0080,
  TripleThrust:        0x0100,
  OffhandThrust:       0x0200,
  OffhandSlash:        0x0400,
  OffhandDoubleSlash:  0x0800,
  OffhandTripleSlash:  0x1000,
  OffhandDoubleThrust: 0x2000,
  OffhandTripleThrust: 0x4000,
});

// EquipMask bit subset we actually inspect. Mirrors
// `holtburger_common::properties::EquipMask` (Rust crate at
// `crates/holtburger-common/src/properties/inventory.rs:158`).
const EQUIP_MASK_MELEE_WEAPON   = 0x00100000;
const EQUIP_MASK_SHIELD         = 0x00200000;  // unused but documented
const EQUIP_MASK_MISSILE_WEAPON = 0x00400000;
const EQUIP_MASK_MISSILE_AMMO   = 0x00800000;
const EQUIP_MASK_CASTER         = 0x01000000;
const EQUIP_MASK_TWO_HANDED     = 0x02000000;

// Reference the SHIELD constant so the future bidirectional-shield
// branch (Wave 2 Phase 4's SwordShieldCombat stance handling) has a
// named bit to point at, and so linters don't strip the doc-only
// constant from the file. No runtime effect.
void EQUIP_MASK_SHIELD;

/**
 * Shape of the weapon record this helper consumes. Matches the subset
 * of `InventoryItem` fields `entities.js#getEquippedWeapon` returns.
 *
 * @typedef {Object} EquippedWeapon
 * @property {number} guid         — weapon item GUID
 * @property {number} wcid         — weenie class id
 * @property {number} itemType     — `ItemType` bitmask (MeleeWeapon=0x1,
 *                                   MissileWeapon=0x100, Caster=0x8000)
 * @property {number} equipMask    — equip-slot bitmask
 * @property {number} [attackType] — `W_AttackType` bitmask
 *                                   (`PropertyInt::AttackType = 47`)
 *                                   from the weapon entity. `0` /
 *                                   missing = pre-property-arrival;
 *                                   fall back to EquipMask heuristic.
 *                                   Wave 6 / Phase 15 (2026-05-26).
 * @property {string} [name]       — display name, debug only
 */

/**
 * Optional inputs that refine the AttackType decision. Today only the
 * unarmed (null-weapon) branch consults them; all weapon branches read
 * directly from `weapon.attackType` / `weapon.equipMask` instead.
 *
 * @typedef {Object} InferAttackTypeOpts
 * @property {number}  [powerLevel]  Combat-bar power, 0..1. Only used
 *                                   for the unarmed branch (`weapon ==
 *                                   null`). When `> 0.75 && !isDualWield`
 *                                   the helper returns `Kick = 0x08`
 *                                   instead of `Punch = 0x01`,
 *                                   matching `Player_Melee.cs:462`.
 *                                   Omitted/NaN/undefined → treated as
 *                                   0 (Punch).
 * @property {boolean} [isDualWield] Whether the swing is part of a
 *                                   dual-wield combo. Mirrors ACE's
 *                                   `IsDualWieldAttack` check at
 *                                   `Player_Melee.cs:462` — dual-wield
 *                                   unarmed swings can't kick (the
 *                                   offhand fist takes the slot).
 *                                   Default `false`.
 */

/**
 * Infer the primary AttackType bitmask for the given equipped weapon
 * record. See module docstring for the full mapping table + ACE
 * source citations.
 *
 * **Precedence (Wave 6 / Phase 15, 2026-05-26 + Wave 7 / Phase 21):**
 *   1. **Unarmed** (`weapon == null`): power-driven Kick/Punch per
 *      `Player_Melee.cs:462`. `opts.powerLevel > 0.75 && !opts.isDualWield`
 *      → `Kick = 0x08`; otherwise → `Punch = 0x01`. One-arg callers
 *      (no opts) get the legacy `Punch = 0x01` answer (backward-compat).
 *   2. Wire `W_AttackType` (`weapon.attackType`) when non-zero — used
 *      verbatim; may carry multi-bit values like `Thrust|Slash = 0x06`
 *      which the CMT picker resolves at lookup time.
 *   3. EquipMask heuristic — legacy fallback for pre-property-arrival
 *      ObjectCreate events.
 *   4. `Undef = 0` — caller's fallback constant kicks in.
 *
 * Return value can be either a single-bit or multi-bit
 * `ATTACK_TYPE` value. Single bits are the common CMT-row key
 * (`r.tree.get(stance).get(height).get(attackType)` per
 * `ACE.DatLoader/FileTypes/CombatManeuverTable.cs::Unpack`); multi-bit
 * values (Thrust|Slash, DoubleSlash|DoubleThrust) are handled by the
 * downstream `getCombatManeuver` lookup via the `IsThrustSlash`
 * branch.
 *
 * @param {EquippedWeapon | null | undefined} weapon
 * @param {InferAttackTypeOpts} [opts]  optional refinement inputs;
 *                                       currently only used by the
 *                                       unarmed branch. Omit for
 *                                       legacy (Wave 6) behaviour.
 * @returns {number} `ATTACK_TYPE.*` bitmask (single- or multi-bit when
 *   the wire path is used; single-bit Punch/Kick/Slash/Undef from the
 *   legacy heuristic fallback).
 */
export function inferAttackTypeForWeapon(weapon, opts) {
  // Unarmed — Wave 7 / Phase 21 (2026-05-26): power-driven Kick/Punch.
  // ACE's `Unarmed = Punch | Kick | OffhandPunch` composite is for
  // damage calc, not for animation table lookup; the *animation* AttackType
  // is one of {Punch, Kick, OffhandPunch} resolved per-swing.
  //
  // **Decision (`Player_Melee.cs:462`):**
  //   ```csharp
  //   AttackType = PowerLevel > KickThreshold && !IsDualWieldAttack
  //       ? AttackType.Kick   // 0x08, full PB
  //       : AttackType.Punch; // 0x01, medium-or-lower PB
  //   ```
  //   where `KickThreshold = 0.75f` at `Player_Melee.cs:432`.
  //
  // **Skill gating (post-Master-of-Arms, Feb 2012):** Unarmed strikes
  // are gated by `Skill.LightWeapons` (Skill enum value 47, per
  // `~/ace-server/Source/ACE.Entity/Enum/Skill.cs:58`), NOT by a
  // separate Unarmed skill. The legacy `Skill.UnarmedCombat` (value
  // 14) exists in ACE only for pre-MoA data-migration paths.
  //
  // **No "Jab" AttackType:** the acpedia Combat omnibus lists
  // "Jab (Low PB / 50%)" as a third unarmed maneuver, but
  // (a) `AttackType.cs:8-25` has no Jab value, (b)
  // `MotionCommand.cs` has no Jab* entry, and (c) the CMT actually
  // carries TWO Punch motions per non-High height (`0x10000063` +
  // `0x10000066` at h=Med; `0x10000064` + `0x10000067` at h=Low) —
  // the picker's alternation or power-subdivision logic in
  // `getCombatManeuver` is what gives the wiki's "Jab" vs "Punch"
  // visual variety at low power. The wire-level AttackType is
  // `Punch` in both cases.
  //
  // Backward-compat: callers passing only the weapon argument
  // (no opts) get the legacy `Punch = 0x01` answer regardless of
  // power. Verified against Wave 6's 4-case precedence check
  // (`inferAttackTypeForWeapon(null) → 0x01`) — see plan line 948.
  if (weapon == null) {
    const powerLevel = Number.isFinite(opts?.powerLevel) ? opts.powerLevel : 0;
    const isDualWield = opts?.isDualWield === true;
    // `>` not `>=` to match ACE's `PowerLevel > KickThreshold` exactly.
    if (powerLevel > 0.75 && !isDualWield) return ATTACK_TYPE.Kick;
    return ATTACK_TYPE.Punch;
  }

  // ── Wave 6 / Phase 15 (2026-05-26): wire `W_AttackType` ──
  // `PropertyInt::AttackType = 47` is now surfaced on both the local
  // (`InventoryItem.attackType`) and non-local
  // (`EquippedWeaponJs.attackType`) paths via the wasm bridge — see
  // `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`
  // and `publish_player_inventory_snapshot`. When the property is on
  // the entity (non-zero bitmask), return it verbatim. Don't mask,
  // don't AND — multi-bit values like `Thrust|Slash = 0x06` (most
  // swords) and `DoubleSlash|DoubleThrust = 0xA0` (daggers) need to
  // reach `getCombatManeuver` intact so its `IsThrustSlash` branch
  // can resolve them at lookup time. Closes the Phase 13 two-handed
  // limitation: spears now resolve to `Thrust = 0x02` instead of
  // `Slash = 0x04`. Falls through to the EquipMask heuristic when
  // `attackType` is 0 (pre-property-arrival ObjectCreate, or
  // non-weapon items that somehow reach this code).
  const wireAttackType = (weapon.attackType ?? 0) >>> 0;
  if (wireAttackType !== 0) return wireAttackType;

  const mask = (weapon.equipMask ?? 0) >>> 0;

  // Casters use the magic combat path (CastTargeted / CastUntargeted),
  // which doesn't go through CombatManeuverTable. Return Undef so the
  // caller's fallback constant kicks in — the picking.js melee branch
  // shouldn't even be reached when the player is in MagicCombat stance,
  // so this is defensive only.
  if (mask & EQUIP_MASK_CASTER) return ATTACK_TYPE.Undef;

  // Ranged (bow / crossbow / thrown) + ammo: stays Undef post-Phase-6
  // audit (2026-05-26). The audit
  // (`crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs`) found
  // ZERO ranged-stance rows in retail CMT 0x30000000 — every row uses
  // HandCombat / SwordCombat / SwordShieldCombat /
  // TwoHandedSwordCombat / DualWieldCombat. There IS no AttackType
  // code under which the AimHighN/AimLowN motions live, because the
  // ranged motion dispatch in retail goes through aim-angle
  // (`Creature_Missile.cs::GetAimLevel`) instead of through the CMT
  // at all. See module docstring §"Phase 6 (ranged) audit finding"
  // for the full reasoning. Returning Undef means the caller will
  // hit `getCombatManeuver(...) === null` and fall back to
  // `setSwingPose` — which is also what happens server-side: ACE's
  // missile path doesn't use CMT, it calls `EnqueueMotionPersist`
  // directly with an aim-level motion.
  if (mask & (EQUIP_MASK_MISSILE_WEAPON | EQUIP_MASK_MISSILE_AMMO)) {
    return ATTACK_TYPE.Undef;
  }

  // Melee or two-handed weapon — primary CMT row is Slash. Reached
  // only when `weapon.attackType === 0`, which happens during the
  // brief window between the equip-slot bit arriving and PropertyInt
  // 47 landing on the entity (or for items where the server didn't
  // populate W_AttackType). Wave 6 / Phase 15 (2026-05-26) wired the
  // wire path above; this branch is the legacy heuristic that keeps
  // pre-property-arrival ObjectCreate events working.
  //
  // **Historical Phase 13 limitation (Wave 5):** the LSD weenie
  // survey (646 retail TwoHandedCombat weapons) showed ~35-40% of
  // two-handed weapons have a non-Slash dominant W_AttackType
  // (Spears 88% Thrust, Swords 84% Thrust|Slash, Daggers
  // DoubleSlash|DoubleThrust). The wire path above resolves this in
  // steady state — only the property-not-arrived-yet window still
  // sees the legacy `Slash` answer.
  if (mask & (EQUIP_MASK_MELEE_WEAPON | EQUIP_MASK_TWO_HANDED)) {
    return ATTACK_TYPE.Slash;
  }

  // Shield-only / unrecognized — let the caller fall back. This path
  // is reached when the wielded item carries no weapon bit (very rare
  // — usually means the inventory snapshot caught the entity mid-
  // unequip and the slot mask hasn't refreshed yet).
  return ATTACK_TYPE.Undef;
}
