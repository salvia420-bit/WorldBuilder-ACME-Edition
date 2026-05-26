# CombatManeuverTable (DAT 0x30) — Sequenced Fixes Plan

**Created:** 2026-05-26
**Repo root:** `/home/wbterminal/WorldBuilder-ACME-Edition`
**Target subtree:** `external/holtburger/apps/holtburger-web/`
**Branch:** `master` (commit pattern: `feat(holtburger-web): ...`)

## Status

| Phase | Deficiency | Wave | State |
|-------|------------|------|-------|
| 1 | #6 Diag has no motion-u32 histogram | 1 | **shipped** 2026-05-26 |
| 2 | #1 `ATTACK_TYPE_SLASH = 8` is Kick's value | 1 | **shipped** 2026-05-26 |
| 3 | #3 AttackType not inferred from weapon | 1 | **shipped** 2026-05-26 |
| 4 | #5 Power-slider candidate selection is a guess | 2 | **shipped** 2026-05-26 |
| 5 | #2 Remote-player swings skip CMT | 2 | **shipped** 2026-05-26 |
| 6 | #4 Missile branch never queries CMT | 2 | **shipped** 2026-05-26 (audit re-scoped — see Wave 2 finding) |
| 7 | Missile aim-level dispatch (Wave 2 follow-on) | 3 | **shipped** 2026-05-26 |
| 8 | Recklessness band overlay on combat-bar | 4 | **shipped** 2026-05-26 |
| 9 | Defender-facing Sneak Attack prediction (JS-only) | 5 | **shipped** 2026-05-26 |
| 10 | Shield CMT-row audit (wiki-vs-data divergence found) | 5 | **shipped** 2026-05-26 |
| 11 | PowerLevel/AccuracyLevel STypeFloat surface (FloatKey 92/93) | 5 | **shipped** 2026-05-26 |
| 12 | Spell-shape classifier (War 6 shapes + Void 5 shapes from SpellId) | 5 | **shipped** 2026-05-26 |
| 13 | Two-Handed Combat AttackType audit (limitation documented) | 5 | **shipped** 2026-05-26 |
| 14 | Light Weapons / Unarmed audit (post-MoA mapping confirmed) | 5 | **shipped** 2026-05-26 |
| 15 | W_AttackType (PropertyInt 47) wire surfacing | 6 | **shipped** 2026-05-26 |
| 16 | Magic-side Sneak Attack prediction (extend Phase 9 to spell-cast path) | 6 | **shipped** 2026-05-26 |
| 17 | Magic-shape classifier UI surface in spell-picker | 6 | **shipped** 2026-05-26 |
| 18 | Acclient.c shield-Backhand runtime gate investigation (wiki was wrong) | 6 | **shipped** 2026-05-26 |

## Background (for any agent picking this up cold)

The 0x30 `CombatManeuverTable` is a single retail record (`0x30000000`) that maps `(MotionStance, AttackHeight, AttackType)` → `[MotionCommand]` candidates. ACE's server calls it during a swing to decide which animation clip the client should play. Our parser at `external/holtburger/crates/holtburger-dat/src/file_type/combat_maneuver_table.rs` is bit-correct against all four sources (ACE.DatLoader, DRW, Chorizite retail-offset confirmation, `acclient.c:501918` decomp). The JS runtime at `external/holtburger/apps/holtburger-web/ui/ac_combat_maneuver.js` mirrors ACE's `GetMotion` rebuild into a Stance→Height→Type tree. The local-player melee swing path (`scene3d/picking.js:430-458`) wires it into `entities.js:1820 setSwingMotion` which then drives Three.js mixer playback.

The bugs we're fixing all live in *consumers* of the runtime, not the parser or runtime itself.

## Reference files (absolute paths — agents read-only unless modifying)

- **ACE server logic** — `/home/wbterminal/ace-server/Source/ACE.DatLoader/FileTypes/CombatManeuverTable.cs` (canonical Unpack + GetMotion)
- **ACE entity defs** — `/home/wbterminal/ace-server/Source/ACE.DatLoader/Entity/CombatManeuver.cs` (5×u32 wire format)
- **ACE combat dispatch** — `/home/wbterminal/ace-server/Source/ACE.Server/WorldObjects/Player_Combat.cs` (weapon → AttackType, GetCombatManeuver call-site)
- **ACE enums** — `/home/wbterminal/ace-server/Source/ACE.Entity/Enum/AttackType.cs` (`Slash=0x04, Kick=0x08, Punch=0x01, Thrust=0x02, …`)
- **Retail decomp** — `/home/wbterminal/ac-headers/acclient.c` (search for `CombatManeuverTable::` — Unpack at line 501918, Get at line 407721 used by 408537 site)
- **Retail offsets** — `/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/ACBindings/Generated/Dats/DBObjs/CombatManeuverTable.cs`
- **DRW XML schema** — `/home/wbterminal/WorldBuilder-ACME-Edition/external/DatReaderWriter/DatReaderWriter/dats.xml:4171` + `:3302` (CombatManeuver type) + AttackType enum near line ~5800

## Build / test commands

- **Wasm build (touches `src/lib.rs`):** `cd external/holtburger/apps/holtburger-web && ./scripts/build-wasm.sh` (or whatever the project's build script is — agents should `cat` the README / `package.json` first)
- **Cargo parity test (touches `crates/holtburger-dat/`):** `cd external/holtburger && cargo test -p holtburger-dat combat_maneuver_table_parity` (skipped if `HOLTBURGER_PORTAL_DAT` env var unset)
- **JS-only changes:** no build needed; Firefox hard-reloads ES modules. For Chrome on the 1070, use `/clear-cache` (browser-resident ESM cache trap — see existing notes).

## Wave 1 — independent, can run in parallel

### Phase 1: Diag motion-u32 histogram (deficiency #6)

**Owner:** `Agent A`
**Files touched:**
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` (extend `attachCombat`)
- `external/holtburger/apps/holtburger-web/ui/ac_combat_maneuver.js` (add `tableId` to hit payload only; do NOT change candidate-selection algorithm — that's Phase 4)

**What to do:**

1. In `scene3d/diag/combat.js`, extend `combat` object with:
   - `motionHistogram: Map<motion_u32, count>` — incremented in `onLookupHit`
   - `motionByStance: Map<stance_u32, Map<motion_u32, count>>` — same hit, nested
   - Both surfaced via `summary()` (just counts/sizes) and full export via `snapshot()`
2. In `ui/ac_combat_maneuver.js:135` (`onLookupHit` call), add `tableId` to the payload (sourced from the `r.id` you have in scope).
3. Generate a motion-name lookup table at `external/holtburger/apps/holtburger-web/data/motion-command-names.json` from `/home/wbterminal/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs`. Write a one-shot Node script under `scripts/multi-agent/` (or `apps/holtburger-web/scripts/`) that parses the enum and emits `{ "0x10000068": "SlashMed", … }`. Run it once; commit the JSON. Diag's `snapshot()` should join motion u32s against this table so output reads `SlashMed` instead of raw hex.

**Acceptance criteria:**
- `window.__diag.combat.snapshot()` returns an object with non-empty `motionHistogram` after at least one melee swing.
- Each entry shows `{ motion: <u32>, motionName: <string>, count: <int> }`.
- Existing diag fields (`hits`, `misses`, `failures`, `loaded`, `missByReason`) untouched.
- No regression: `scene3d/diag/combat.js`'s exports list unchanged callers.

**Validation:**
- Manual smoke: load `?renderer=3d`, swing 5 times, run `JSON.stringify(window.__diag.combat.snapshot(), null, 2)` in console. Expect at least one motion in the histogram.
- Save baseline at `external/holtburger/apps/holtburger-web/docs/cmt-diag-baseline-pre-fix.json`.

---

### Phase 2: Fix `ATTACK_TYPE_SLASH` value (deficiency #1)

**Owner:** `Agent A` (bundled with Phase 1; same agent)
**Files touched:**
- `external/holtburger/apps/holtburger-web/scene3d/picking.js`

**What to do:**

`scene3d/picking.js:11` currently has:
```js
const ATTACK_TYPE_SLASH = 8;
```
Change to:
```js
const ATTACK_TYPE_SLASH = 4;  // ACE AttackType.Slash; 0x08 was Kick — fixed 2026-05-26
```

**Acceptance criteria:**
- File diff is a single-line change.
- Phase 1 baseline capture re-run shows histogram has shifted away from `KickHigh*` / `KickMed*` / `KickLow*` toward `SlashHigh*` / `SlashMed*` / `SlashLow*` for sword-stance swings.

**Validation:**
- After Phase 1 lands, swing 5 times with a sword. Snapshot diag. Save delta capture at `apps/holtburger-web/docs/cmt-diag-post-slash-fix.json`. Confirm motion histogram now resolves Slash family for SwordCombat stance.

---

### Phase 3: Infer AttackType from equipped weapon (deficiency #3)

**Owner:** `Agent B`
**Files touched (creates + edits):**
- NEW: `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js`
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (add `getEquippedWeapon(guid)` accessor)
- `external/holtburger/apps/holtburger-web/scene3d/picking.js:441` (replace hardcoded `ATTACK_TYPE_SLASH`)

**What to do:**

1. **Investigate where weapon data lives on entities.** Grep `inst.meta` / ObjDesc in `scene3d/entities.js` for the weapon slot / weapon WCID / weapon setup ID. Confirm what's available pre-attack. If the current ObjDesc parse already surfaces "equipped weapon" — great, expose it via a new method. If not, add it (see ACE `Source/Network/Structure/ObjDesc.cs` for the wire layout).
2. **Create `ui/ac_attack_type_for_weapon.js`** with:
   ```js
   export const ATTACK_TYPE = Object.freeze({
     Undef: 0x0000, Punch: 0x0001, Thrust: 0x0002,
     Slash: 0x0004, Kick: 0x0008, // …
   });
   /**
    * Returns the primary AttackType bitmask for the given equipped weapon.
    * Unarmed → Punch. Sword/axe/mace family → Slash. Dagger → Thrust at low,
    * Slash at mid/high (decision deferred to caller; this returns the
    * primary type). Bow/Crossbow/Thrown deferred to Phase 6.
    *
    * Seed mapping from ACE.Server/WorldObjects/Player_Combat.cs (see
    * GetAttackType + weapon-skill switch). Cross-checked against
    * acclient.h weapon-type enum so values match retail classification.
    */
   export function inferAttackTypeForWeapon(weapon) { … }
   ```
   Source the weapon-skill → AttackType mapping from ACE `Player_Combat.cs` (read the file, port the switch). Document the mapping table inline so future agents can audit it.
3. **Add `entities.js#getEquippedWeapon(guid)`** that returns `{ weaponWcid, weaponSetupId, weaponMask } | null` (or whatever fields the inference uses). If the data isn't currently tracked per entity, surface it from the existing ObjDesc parse.
4. **Replace `picking.js:441`:**
   ```js
   import { inferAttackTypeForWeapon } from "../ui/ac_attack_type_for_weapon.js";
   // …
   const weapon = liveScene3d.entityManager.getEquippedWeapon?.(localGuid) ?? null;
   const attackType = inferAttackTypeForWeapon(weapon);
   const motionCmd = getCombatManeuver(stance, safeHeight, attackType, slider);
   ```
   Keep the existing `ATTACK_TYPE_SLASH` constant in place as a fallback if `inferAttackTypeForWeapon` returns `Undef` (some weapon classes the helper doesn't cover yet shouldn't break combat).

**Acceptance criteria:**
- New module exports `inferAttackTypeForWeapon(weapon)` + `ATTACK_TYPE` enum object.
- `entities.js` exposes `getEquippedWeapon(guid)` returning weapon info or `null`.
- `picking.js` no longer hardcodes the AttackType for melee.
- Unarmed (no weapon) returns `Punch (1)`.
- Standard sword (WeaponSkill = HeavyWeapons + heavy/standard sword WCID) returns `Slash (4)`.
- Standard dagger returns `Thrust (2)` OR `Slash (4)` — pick one with a comment citing ACE's behavior; mid-height swings can be either per retail.
- Unmapped weapon → returns `Undef (0)` and picking.js falls back to the constant.

**Validation:**
- With Phase 1's diag, swing unarmed → motion histogram dominated by `Punch*`.
- Equip a sword (ACE `/create` a "Hilted Dagger" or similar in dev DB) → `Slash*` motions.
- No regressions in pure code: `node --check ui/ac_attack_type_for_weapon.js`, `node --check scene3d/entities.js`, `node --check scene3d/picking.js`.

---

## Wave 2 — blocked on Wave 1 (do not start yet)

### Phase 4: Power-slider candidate selection (deficiency #5)

**Blocked on:** Phase 1 (need diag to validate) + Phase 3 (need correct AttackType so candidates are meaningful).

**Files touched:**
- `external/holtburger/apps/holtburger-web/ui/ac_combat_maneuver.js:132-134`

**What to do:**

1. Trace retail behavior:
   - `/home/wbterminal/ac-headers/acclient.c` — search for `CombatManeuverTable::Get(` call sites (`grep -n` around line 408537). Determine whether the retail client uses a power-bar threshold, `prevMotion`-alternation, or random selection among candidates.
   - `/home/wbterminal/ace-server/Source/ACE.Server/WorldObjects/Player_Combat.cs` — find how the server picks which maneuver to send back (look for `DoSwingMotion`, `HandleActionAttack`). The client should match server-authoritative selection.
2. Replace the naive `floor(p * len)` in `ac_combat_maneuver.js:132-134` with the algorithm retail uses. If it's `prevMotion`-driven, the function signature needs to accept `prevMotion` (read from `inst.lastSwingMotion` or wherever the entity-manager stamps the last fired motion).
3. Add `candidateIdx` to the diag's `onLookupHit` payload so the histogram shows distribution across candidates per (stance, height, type).

**Acceptance criteria:**
- Algorithm cited in comment with the retail / ACE source file:line.
- For SwordCombat+Medium+Slash (returns `[SlashMed, BackhandMed]`), the picker resolves deterministically given inputs; not floor-of-power.
- Phase 1 diag's `motionHistogram` shows both candidates fire over a 10-swing sequence (not just one).

---

### Phase 5: Remote-player swings via CMT (deficiency #2)

**Blocked on:** Phase 3 (uses `inferAttackTypeForWeapon`) + Phase 1 (validation).

**Files touched:**
- `external/holtburger/apps/holtburger-web/index.html` (the `damageTaken` / `evadedAttacker` handler at lines ~8612-8619)
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (add `getStance(guid)` accessor if not present)

**What to do:**

1. Confirm `inst.currentStance` is set from `UpdateMotion` (entity update kind=5) for non-local entities. If not, fix that first.
2. Replace the `setSwingPose(g)` calls in `index.html:8612-8619` with a CMT-driven dispatch using Phase 3's helper:
   ```js
   const stance = em.getStance?.(g) ?? 0;
   const weapon = em.getEquippedWeapon?.(g) ?? null;
   const attackType = inferAttackTypeForWeapon(weapon);
   const ATTACK_HEIGHT_MEDIUM = 2;
   const motionCmd = getCombatManeuver(stance, ATTACK_HEIGHT_MEDIUM, attackType, 0.5);
   if (motionCmd) em.setSwingMotion(g, motionCmd);
   else em.setSwingPose(g);
   ```
3. Note: drudges and other non-human creatures currently swing nothing because `setSwingPose` returns early on non-human rigs (`entities.js:1800 if (!isHuman) return`). After this fix, `setSwingMotion` → motion-table classify → fetches the *real* monster swing clip. That's the win.

**Acceptance criteria:**
- Local-player combat against `@create 7 drudge`: drudges now play their actual swing clip, not nothing.
- Diag motion histogram for remote attackers populates.
- Fallback to `setSwingPose` only when CMT lookup misses entirely.

---

### Phase 6: Missile branch CMT integration (deficiency #4)

**Blocked on:** Phase 3 (extends `inferAttackTypeForWeapon` for ranged weapons).

**Files touched:**
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` (extend for ranged)
- `external/holtburger/apps/holtburger-web/scene3d/picking.js:420-428` (missile branch)

**What to do:**

1. Dump retail CMT 0x30000000 via WB.Terminal (`worldbuilder-terminal` skill at `~/.claude/skills/worldbuilder-terminal/`) or via the existing parity test infrastructure. Filter to ranged stances (BowCombat / CrossbowCombat / ThrownWeaponCombat). Confirm which AttackType codes the rows use — likely `Slash=4` (the `AimHigh*` motions live under it) but verify.
2. Extend `inferAttackTypeForWeapon` with ranged-weapon branches.
3. Wire `picking.js:420-428`'s missile path to call `getCombatManeuver` + `setSwingMotion` the same way the melee branch already does.

**Acceptance criteria:**
- Equip a bow, attack: character draws + releases with `AimHighN` / `AimLowN` clip.
- Diag shows ranged motion u32s in histogram filtered by ranged stance.
- Charge-to-range logic in `picking.js` unchanged.

---

## Wave 1 results — shipped 2026-05-26

### Phase 1 — Diag motion histogram + motion-name lookup

**Agent:** A (general-purpose subagent)
**Files:**
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` (+67 / -2): added `motionHistogram: Map<u32, count>` and `motionByStance: Map<stance, Map<u32, count>>` accumulated in `onLookupHit`; surfaced via extended `summary()` (`motionsDistinct`, `stancesWithHits`) and `snapshot()` (full histograms with motion-name join + descending count sort); `reset()` also clears them. `hitsSample` entries now carry `tableId` (hex) + `motionName` so the existing ring buffer is human-readable too.
- `external/holtburger/apps/holtburger-web/ui/ac_combat_maneuver.js` (+1 / -1): added `tableId: r.id` to the `onLookupHit` payload at line 135. **Candidate-selection algorithm at line 132-134 deliberately untouched — that's Phase 4 (Wave 2).**
- `external/holtburger/apps/holtburger-web/scripts/gen-motion-command-names.cjs` (NEW, 83 lines): one-shot parser over `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs`. Emits the hex→name JSON used by the diag layer.
- `external/holtburger/apps/holtburger-web/data/motion-command-names.json` (NEW, 411 lines, 409 distinct motion entries): committed lookup table. Examples: `"0x1000005c": "SlashMed"`, `"0x10000068": "KickMed"`, `"0x10000049": "AimHigh1"`.

**Snapshot shape after Phase 1:**
```js
{
  ts, loaded, cached, failures, hits, hitsSample, misses, missByReason,   // unchanged shape
  motionHistogram: { "0x1000005c": { motionName: "SlashMed", count: 3 }, … },  // sorted desc
  motionByStance:  { "0x0000000f": { "0x1000005c": { motionName, count }, … } },
  motionNamesLoaded: true|false
}
```

### Phase 2 — `ATTACK_TYPE_SLASH = 4` (was Kick at `0x08`)

**Agent:** A (bundled)
**Files:**
- `external/holtburger/apps/holtburger-web/scene3d/picking.js:11` — was `const ATTACK_TYPE_SLASH = 8;` (`Kick`); now `const ATTACK_TYPE_SLASH = ATTACK_TYPE.Slash;` (`= 4`). Constant kept as the safety fallback when Phase 3's inference returns `Undef`. Date-cited comment added.

### Phase 3 — Infer AttackType from equipped weapon

**Agent:** B (general-purpose subagent)
**Files:**
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` (NEW, 217 lines): exports `ATTACK_TYPE` frozen enum + `inferAttackTypeForWeapon(weapon)`. Mapping table cited inline from `ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050`, `ace-server/Source/ACE.Entity/Enum/AttackType.cs`, `ac-headers/acclient.h:7095`, and `crates/holtburger-common/src/properties/inventory.rs:158` (EquipMask bits).
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (+117): new `getEquippedWeapon(guid)` accessor. Returns `{ guid, wcid, itemType, equipMask, name }` for local player by walking `window.__sessionHandle.playerInventory()` for the first item with `equipMask & (MELEE_WEAPON | MISSILE_WEAPON | CASTER | TWO_HANDED)`. **Returns `null` for non-local entities** — see "Wave 1 finding" below.
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` (+47 / -13): imports the helper, replaces the hardcoded `ATTACK_TYPE_SLASH` at the melee CMT call site, keeps the constant as fallback when inference returns `Undef`.

**Mapping table (Wave 1, equip-slot-based heuristic):**

| Input (`weapon`) | Returns |
|---|---|
| `null/undefined` (unarmed) | `Punch = 0x01` |
| `equipMask & MELEE_WEAPON (0x00100000)` | `Slash = 0x04` |
| `equipMask & TWO_HANDED (0x02000000)` | `Slash = 0x04` |
| `equipMask & MISSILE_WEAPON (0x00400000)` | `Undef = 0x00` (Phase 6) |
| `equipMask & MISSILE_AMMO (0x00800000)` | `Undef = 0x00` (Phase 6) |
| `equipMask & CASTER (0x01000000)` | `Undef = 0x00` (magic path; not CMT-driven) |
| shield-only / unknown | `Undef = 0x00` |

9/9 smoke tests in the helper pass. `node --check` clean on all 5 JS files modified across Phases 1-3.

### Wave 1 finding — surface area for Phase 5

**Equipped weapon is NOT carried on per-entity ObjDesc.** `inst.meta` carries `modelChanges` / `textureChanges` / `subPalettes` for the wielding character's appearance, but the wielded item's WCID / equipMask are NOT propagated to the JS layer for remote entities. They ARE on the wire (`apply_inventory_object_create` at `src/lib.rs:15333` extracts `wielder_id`) but currently only consumed for the local player's `playerInventory()`.

**Implication for Phase 5 (remote-player CMT swings):** before wiring remote attackers through the CMT, we either:
1. Extend `apply_inventory_object_create` to track wielded items per-entity-GUID (wasm-side index from `wielder_id` → `Vec<EquippedItem>`), and expose via a new wasm getter; or
2. Read `W_AttackType` (PropertyInt 45) / `W_WeaponType` (PropertyInt 89) directly off the weapon weenie if the wire ever sends it (rare for monsters; common for player-equipped items via Object_SendForceObjdesc).

**Recommended.** Option 1 — properly surface the wielding state we already receive. Estimate: ~80-120 LOC across `crates/holtburger-protocol` (or wherever inventory ObjectCreate lives), `src/lib.rs` (new wasm getter `entity_equipped_weapon(guid)`), and `scene3d/entities.js` (extend `getEquippedWeapon(guid)` to consult the new wasm side for non-local GUIDs).

TODO breadcrumbs are already baked into the helper at `ui/ac_attack_type_for_weapon.js` and `scene3d/entities.js#getEquippedWeapon`, citing `src/lib.rs:15349` as the surfacing point.

### Validation status

- All 5 JS files: `node --check` PASS.
- Generator script: clean run, 409 motion entries, 0 duplicates.
- Browser smoke: deferred to Wave 2 dispatch — the diag snapshot can be captured via Playwright (`apps/holtburger-web/capture_*.cjs` pattern) but is OUT of agent scope per the dispatch instructions. Save outputs to `apps/holtburger-web/docs/cmt-diag-baseline-pre-fix.json` + `cmt-diag-post-slash-fix.json` when running.
- Pre-existing TypeScript diagnostics in `index.js`, `cells.js`, `statics.js`, `buildings.js` are unrelated to this work (untouched by either agent).

## Wave 2 results — shipped 2026-05-26

### Phase 4 — Power-slider candidate selection (ACE-ported)

**Agent:** C
**Files (+102 / -8 over 3 files):**
- `external/holtburger/apps/holtburger-web/ui/ac_combat_maneuver.js` (+76 / -8): replaced `floor(p * len)` with the ACE-ported picker. Added `prevMotion` and `opts.isThrustSlash` to `getCombatManeuver`'s signature (backward-compat defaults).
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` (+18 / -2): module-scoped `prevMeleeMotion` inside the `setupClickPicking` closure (intentionally NOT a field on `EntityInstance`); melee call site passes it through and stamps after each successful lookup.
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` (+8): `hitsSample` entries now record `candidateIdx`, `subdivision`, `prevMotion`.

**Algorithm ground-truth.** Ported verbatim from `~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:440-475` (identical in-repo copy at `external/ACE/Source/ACE.Server/WorldObjects/Player_Melee.cs:440`):

```csharp
var subdivision = 0.33f;
if (weapon != null && weapon.IsThrustSlash) subdivision = 0.66f;
var motion = motions.Count > 1 && PowerLevel < subdivision
    ? motions[1]   // lower-powered backhand
    : motions[0];  // higher-powered swing (always slot 0)
```

`IsThrustSlash` per `WorldObject_Weapon.cs:1039-1048` reads `W_AttackType & (Slash|Thrust)` — that PropertyInt isn't yet on the inventory wire, so the JS picker defaults `subdivision = 0.33` and accepts `opts.isThrustSlash` for callers that have it. `prevMotion` plumbed through but unused by the active picker (the retail alternation path in `CombatManeuverTable.cs:88-101` is commented out; kept forward-compat).

**Acceptance.** Synthetic 10-power sweep over SwordCombat+Medium+Slash `[SlashMed, BackhandMed]` produces `{SlashMed:5, BackhandMed:5}` (both candidates fire); IsThrustSlash branch flips threshold to 0.66 as expected.

### Phase 5 — Remote-player CMT swings (with wire plumbing)

**Agent:** D (took the full end-to-end including the Wave 1 finding's prerequisite)
**Files (+405 / -34 over 3 files):**
- `external/holtburger/apps/holtburger-web/src/lib.rs` (+230 / -8): new `SessionHandle.wielder_index: Rc<RefCell<HashMap<u32 wielder_guid, Vec<WieldedWeaponEntry>>>>` populated in `apply_inventory_object_create` (line 15421) when `wielder_id != world.player.guid`, cleaned in `apply_inventory_object_delete` on three paths (item un-equip, wielder despawn, empty bucket prune). New wasm export `entityEquippedWeapon(guid) → EquippedWeaponJs?` returning `{ guid, wcid, itemType, equipMask, name }`. Matches the local-player shape.
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (+119 / -16): `getEquippedWeapon(guid)` now consults the new wasm getter for non-local GUIDs; new `getStance(guid)` accessor; `inst.currentStance` mirrored in `setMotion` so it stays in sync with the `UpdateMotion` (kind=5) entity events. **Critical fix:** removed the `isHuman` gate at `entities.js:2005` that was silently dropping drudge/monster swings — the link-table classification path is rig-agnostic per `swing-classification-spec-2026-05-19.md §8.2`.
- `external/holtburger/apps/holtburger-web/index.html` (+56 / -10): 2 ES-module imports added at the existing `<script type="module">` header; `damageTaken` / `evadedAttacker` handlers now call `dispatchRemoteSwing` which runs `getStance → getEquippedWeapon → inferAttackTypeForWeapon → getCombatManeuver → setSwingMotion` with `setSwingPose` fallback only on lookup miss.

**Acceptance.** `cargo check -p holtburger-web --target wasm32-unknown-unknown` clean (18 pre-existing warnings, 0 new). `wasm-pack build` succeeded; generated `pkg/holtburger_web.d.ts` exposes `entityEquippedWeapon` + `EquippedWeaponJs`. Drudge swing call-chain confirmed end-to-end via trace: `dispatchRemoteSwing` → CMT lookup → `classifyMotionCommandTyped` (rig-agnostic) → `animationCache.get` → mixer playback.

### Phase 6 — Missile branch (audit re-scoped via discovery)

**Agent:** E
**Critical finding.** The Phase 6 audit at `crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs` revealed that **CMT 0x30000000 contains ZERO rows for ranged stances.** All 102 retail maneuvers cover only `HandCombat (0x8000003C)`, `SwordCombat (0x8000003E)`, `SwordShieldCombat (0x80000040)`, `TwoHandedSwordCombat (0x80000044)`, and `DualWieldCombat (0x80000046)`. The plan doc's "AttackType code to discover for ranged stances" had no answer — because the missile dispatch in ACE / retail goes through `Creature_Missile.cs::GetAimLevel` (called from `Player_Missile.cs:207`) which picks an `AimHighN` / `AimLevel` / `AimLowN` motion directly from projectile z-angle, bypassing the CMT entirely.

**Files (+422 / -13 over 3 files):**
- NEW `external/holtburger/crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs` (326 lines): opens portal.dat, dumps CMT 0x30000000 ranged-stance rows + per-stance AttackType summary + all-rows diag. Reproducible audit.
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` (+57 / -11): docstring updated with the audit finding; `MISSILE_WEAPON` / `MISSILE_AMMO` branches stay `Undef = 0` with explicit comment that this is the correct CMT-query answer (the helper isn't broken; the table just doesn't carry ranged data).
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` (+39 / -2): missile branch now mirrors the melee structure — `inferAttackTypeForWeapon → getCombatManeuver → setSwingMotion` with `setSwingPose` fallback. The CMT lookup will always miss for ranged stances (by design), so the visible behavior is the existing `setSwingPose` fallback — but the diag layer now records the misses, giving Wave 3's `ui/ac_aim_level_for_velocity.js` a clean slot to plug into.

**Acceptance.** Audit script compiles + runs clean against `~/ac_base_dats/client_portal.dat`. `cargo test -p holtburger-dat --test combat_maneuver_table_parity` PASS (4/4). `node --check` clean on the two JS files.

### Wave 2 follow-on for Wave 3

The audit reframed Phase 6 from "missile CMT integration" to "missile aim-level dispatch" (since the CMT doesn't carry the data). Wave 3 scope:

- Port `Creature_Missile.cs::GetAimLevel:435` to a new `ui/ac_aim_level_for_velocity.js`.
- Surface projectile z-angle (or velocity vector) on the client side so the helper has its input.
- Replace `picking.js`'s missile-branch `setSwingPose` fallback with `setSwingMotion(localGuid, aimLevelMotion)`.
- Same dispatch for remote ranged attackers via `dispatchRemoteSwing` in `index.html` — the helper-chain plumbing is already in place; only the data source for the motion u32 changes.

---

## Wave 3 — missile aim-level dispatch (single phase, single agent)

### Phase 7: Port GetAimLevel + wire into local + remote missile paths

**Status:** **shipped** 2026-05-26
**Owner:** Agent F
**Blocked on:** Wave 2 (shipped — Phase 6 audit established the necessity; Phase 5 surfaced equipped weapons on non-local entities).

#### Pre-investigated facts (use these directly — they have been verified)

1. **The formula** — `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Missile.cs:435-472`:
   ```csharp
   public static MotionCommand GetAimLevel(Vector3 velocity) {
     var zAngle = Vector3.Normalize(velocity).Z * 90.0f;
     // 13 buckets at 15° intervals:
     // zAngle ≥ 82.5    → AimHigh90
     // zAngle ≥ 67.5    → AimHigh75
     // zAngle ≥ 52.5    → AimHigh60
     // zAngle ≥ 37.5    → AimHigh45
     // zAngle ≥ 22.5    → AimHigh30
     // zAngle ≥ 7.5     → AimHigh15
     // zAngle > -7.5    → AimLevel
     // zAngle > -22.5   → AimLow15
     // zAngle > -37.5   → AimLow30
     // zAngle > -52.5   → AimLow45
     // zAngle > -67.5   → AimLow60
     // zAngle > -82.5   → AimLow75
     // else             → AimLow90
   }
   ```

2. **MotionCommand enum values** (from `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs:37-49`):
   ```
   AimLevel  = 0x4000001E
   AimHigh15 = 0x4000001F   AimLow15 = 0x40000025
   AimHigh30 = 0x40000020   AimLow30 = 0x40000026
   AimHigh45 = 0x40000021   AimLow45 = 0x40000027
   AimHigh60 = 0x40000022   AimLow60 = 0x40000028
   AimHigh75 = 0x40000023   AimLow75 = 0x40000029
   AimHigh90 = 0x40000024   AimLow90 = 0x4000002A
   ```
   All 13 are in the committed `external/holtburger/apps/holtburger-web/data/motion-command-names.json`.

3. **GetAimVelocity** at `Creature_Missile.cs:236-252` factors in gravity-compensated arc via `GetProjectileVelocity`. For the *client-side prediction* role, this matters less — the server is authoritative, and the wire's UpdateMotion (kind=5) event will correct any drift. Using direct-line direction `(target - origin)` normalized is a reasonable approximation. Note this as a TODO + accept the prediction-quality trade-off.

4. **Eye height** — `Creature_Missile.cs:242`: `origin.Z += Height * ProjSpawnHeight`. Same prediction-quality argument — skip for v1, leave a TODO.

5. **Existing stance-classifier infrastructure:**
   - `RANGED_STANCES = new Set([0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c])` already exists in `plugins/combat-bar.js:315` (and mirrored in `index.html`). Reuse or hoist to a shared module — your call.
   - `window.__getCurrentStanceLow()` returns the local player's current stance enum low-16.
   - For remote entities, Phase 5 already added `em.getStance(guid)`.

6. **Existing AC-world-coords accessors:**
   - Local player pose: `playerWorldPose(sessionHandle)` → `{ x, y, z }` AC coords. Imported from `scene3d/util.js` (verify the path).
   - Entity AC position: `entityAcPosition(entityManager, guid)` → `{ x, y, z }`.
   - Both already imported in `picking.js` for the existing charge-to-range distance calculation (look at line ~417-419).

#### Files to touch

- **NEW** `external/holtburger/apps/holtburger-web/ui/ac_aim_level_for_velocity.js` (~80 LOC including the constant table + doc comment)
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` — missile branch only (~line 441 area, after the Phase 6 helper-chain wiring). Replace the CMT-miss `setSwingPose` fallback with the aim-level motion.
- `external/holtburger/apps/holtburger-web/index.html` — `dispatchRemoteSwing` already routes through the helper chain (Phase 5); add a branch that detects ranged stance and uses `getAimLevelForVelocity(localPose - attackerPose)` instead of CMT lookup.
- **Optional but recommended:** new shared `ui/ac_motion_stance.js` exporting `RANGED_STANCES` / `MELEE_STANCES` sets + `isRangedStance(stance)` / `isMeleeStance(stance)` helpers so `combat-bar.js`, `index.html`, and the missile branches stop duplicating the set. If you choose to refactor, update all three call sites in one commit.

#### What to do (sequential within the agent)

1. **Create `ui/ac_aim_level_for_velocity.js`** with:
   - Export `AIM_MOTIONS` frozen object listing all 13 u32 codes by name.
   - Export `getAimLevelForVelocity({ x, y, z })` implementing the formula. Validate against the buckets above. Accept a zero/null vector → return `AimLevel`.
   - JSDoc citing `Creature_Missile.cs:435` + the prediction-quality trade-off + the eye-height TODO.

2. **Wire `picking.js` missile branch.** After Phase 6's `getCombatManeuver` call returns `motionCmd = null` (always for ranged stances), compute the aim-level motion as the fallback:
   ```js
   const targetAcPos = entityAcPosition(em, targetGuid);
   const aimVelocity = targetAcPos && pose
     ? { x: targetAcPos.x - pose.x, y: targetAcPos.y - pose.y, z: targetAcPos.z - pose.z }
     : { x: 0, y: 0, z: 0 };
   const aimMotion = getAimLevelForVelocity(aimVelocity);
   const finalMotion = motionCmd ?? aimMotion;  // CMT first (currently always misses for ranged), aim-level fallback
   // … existing setSwingMotion / setSwingPose dispatch
   ```
   The existing `setSwingPose` fallback only fires now if BOTH CMT misses AND aim-level returns 0 — which the formula guarantees never happens (it always returns one of the 13 motions). So the missile branch effectively always plays a real motion clip post-Wave-3.

3. **Wire `index.html` dispatchRemoteSwing.** For ranged-stance remote attackers:
   ```js
   const isRanged = RANGED_STANCES.has(stance);  // stance is already in scope
   let resolvedMotion = null;
   if (isRanged) {
     const attackerPos = em.getAcPosition?.(g) ?? null;  // confirm accessor exists; if not, add to entities.js
     const localPos = playerWorldPose(sessionHandle);
     if (attackerPos && localPos) {
       const v = { x: localPos.x - attackerPos.x, y: localPos.y - attackerPos.y, z: localPos.z - attackerPos.z };
       resolvedMotion = getAimLevelForVelocity(v);
     }
   } else {
     resolvedMotion = getCombatManeuver(stance, ATTACK_HEIGHT_MEDIUM, attackType, 0.5);
   }
   if (resolvedMotion) em.setSwingMotion(g, resolvedMotion);
   else em.setSwingPose(g);
   ```

4. **Diag observability.** In `scene3d/diag/combat.js`, add a small counter `aimLevelInvocations: { local: 0, remote: 0 }` incremented from the two call sites. Surface via `summary()`. Don't add a separate histogram (the existing motion histogram captures distribution; aim-level motions show up there naturally).

#### Acceptance criteria

- `node --check` clean on every JS file modified.
- `getAimLevelForVelocity({ x: 1, y: 0, z: 0 })` → `AimLevel` (0x4000001E) — horizontal.
- `getAimLevelForVelocity({ x: 0, y: 0, z: 1 })` → `AimHigh90` (0x40000024) — straight up.
- `getAimLevelForVelocity({ x: 0, y: 0, z: -1 })` → `AimLow90` (0x4000002A) — straight down.
- `getAimLevelForVelocity({ x: 1, y: 0, z: 1 })` → `AimHigh45` (0x40000021) — 45° up (`zAngle = 0.707 * 90 = 63.6 → bucket ≥ 52.5 → AimHigh60`). Wait — that's `AimHigh60`, not 45. Re-verify by computing: `normalize(1, 0, 1).z = 0.707`, `0.707 * 90 = 63.63`, falls into `≥ 52.5 → AimHigh60`. Good — that's the right answer. The agent should ship a unit-test with hand-computed expected values for 4-5 edge cases.
- Local-player missile fire: console log `[fire-attack] missile … aimMotion=AimHighN` (or similar — render via `motion-command-names.json` if you want it readable).
- Remote ranged attacker: drudge with bow hits player → `dispatchRemoteSwing` resolves to an `Aim*` motion u32 and plays the clip.

#### Reporting back

Files changed (paths + line counts), the formula's edge-case unit-test results (4-5 cases with expected vs actual), and any surprises. Under 400 words.

**Don't commit — parent agent handles commits.**

### Wave 3 results — shipped 2026-05-26

**Files (+278 / -26 over 5 files):**

- NEW `external/holtburger/apps/holtburger-web/ui/ac_aim_level_for_velocity.js` (149 lines): `AIM_MOTIONS` frozen object + `getAimLevelForVelocity({x, y, z})`. Direct port of `Creature_Missile.cs:435-472`. JSDoc cites the ACE source + prediction-quality trade-off + eye-height TODO.
- NEW `external/holtburger/apps/holtburger-web/test_ac_aim_level_for_velocity.mjs` (178 lines): 16-case unit test mirroring the project's existing `test_quality_preset.mjs` pattern. All 16 PASS.
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` (+33 / -10): missile branch computes `aimMotion = getAimLevelForVelocity(targetAc - pose)` after the (always-missing) CMT lookup; `finalMotion = motionCmd || aimMotion`; diag's `onAimLevel({scope: "local"})` fires per swing; console log carries `aimMotion=0x…`.
- `external/holtburger/apps/holtburger-web/index.html` (+66 / -16): `dispatchRemoteSwing` branches on `RANGED_STANCES.has(stance)` — ranged paths through `getAimLevelForVelocity(localPose - attackerPos)`, melee stays on CMT lookup.
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` (+30): new `aimLevelInvocations: { local, remote }` counter + `onAimLevel(meta)` method; surfaced in `summary()` and `snapshot()`; cleared in `reset()`.

**Unit-test results (16/16 PASS):**

| Case | Expected | Got |
|---|---|---|
| `(1, 0, 0)` horizontal | AimLevel 0x4000001E | 0x4000001E |
| `(0, 0, 1)` straight up | AimHigh90 0x40000024 | 0x40000024 |
| `(0, 0, -1)` straight down | AimLow90 0x4000002A | 0x4000002A |
| `(1, 0, 1)` 45° xz (zAngle 63.6°) | AimHigh60 0x40000022 | 0x40000022 |
| `(0, 0, 0)` zero guard | AimLevel 0x4000001E | 0x4000001E |
| boundary `zAngle == 82.5` `>=` | AimHigh90 | ✓ |
| boundary `zAngle == -7.5` strict `>` | AimLow15 | ✓ |
| NaN / null / undefined guards | AimLevel | ✓ |

Plus frozen-object invariant + 30°-down trig case + 7 other boundary tests, all PASS.

**Optional refactor:** SKIPPED. Three call sites still duplicate `RANGED_STANCES` (`plugins/combat-bar.js:315`, `plugins/stance-toggle.js`, `index.html:1949`). Agent F judged the bloat-vs-benefit balance tipped to keep scope tight. TODO already existed in the duplicate sites.

**Net visible behavior:**
- Local player fires a bow → character now plays the correct `Aim*` clip (high arc on long shots, low aim on close targets) instead of `setSwingPose` vibe-pose.
- Remote ranged attacker fires at us → their character plays the correct `Aim*` clip via `dispatchRemoteSwing` for the first time.
- Drudge with bow (combined with Phase 5's `isHuman` gate removal) now plays its actual ranged attack motion instead of nothing.

---

## Wave 4 — Recklessness power-band overlay (RynthSuite + wiki cross-ref)

### Background

The RynthSuite cross-ref (this doc's earlier section) surfaced that RynthCore caps power at `0.8f` for Recklessness-trained characters. The acpedia research (`external/holtburger/docs/acpedia-combat-research-2026-05-26.md`) confirms Recklessness's active power-band is a UI overlay — *not* server-enforced — and gives the canonical band as **10–90%** (Combat omnibus page) or 20–80% (Recklessness skill page; sources disagree). Both pages agree on the *direction*: a contiguous middle band where the +10 DR (trained) / +20 DR (specialized) bonus activates.

RynthSuite's 0.8 cap matches the skill page's "80%" upper bound — so the cap is a UI-side gameplay nuance that we should mirror visually (let the player see when they're inside the band, outside the band, or in the "safe Recklessness-trained" zone below 80%).

### Phase 8: Recklessness band overlay on combat-bar

**Status:** pending
**Owner:** Agent G
**Blocked on:** Wave 3 (shipped). No new wire surface needed — `sessionHandle.player.skills()` already returns `Vec<u32>` flat-packed as `[type, current, base, ranks, training, ...]` per `src/lib.rs:13963`. `SkillType::Recklessness = 50` and `TrainingLevel::{Unusable=0, Untrained=1, Trained=2, Specialized=3}` are defined in `external/holtburger/crates/holtburger-common/src/stats.rs:156` + `:287`.

#### Files to touch

- `external/holtburger/apps/holtburger-web/plugins/combat-bar.js` — the power-slider rendering lives here. Add the band overlay rendering + skill-state reactivity.
- *(possibly)* a tiny helper module if the band-drawing math grows — but inline is fine if it fits the existing combat-bar.js shape.

#### What to do

1. **Read Recklessness skill state.** On `combat-bar` activate (or via the event the slider listens to today), call `sessionHandle.player.skills()`, walk the flat array in 5-tuples, find the entry where `type === 50` (Recklessness). The `training` field (index 4 in the tuple) gives `TrainingLevel` (0/1/2/3).

2. **Draw the band.** If `training === 2` (Trained) or `training === 3` (Specialized), overlay a translucent colored band on the slider between **10% and 90%** of its width. Color suggestion: muted red/orange to match AC's red-X "danger" aesthetic (recklessness = risk). The band visually shows where the player gets BOTH the +DR bonus AND the incoming-damage penalty. Outside the band: no bonus, no penalty. **Do not enforce the band as a cap** — player can swing anywhere; we just visualize.

3. **Tooltip / label.** When hovering the band, show "Recklessness active: +10 DR" (trained) or "+20 DR" (specialized), plus the incoming-damage penalty caveat. Match the existing combat-bar tooltip style.

4. **Reactivity.** If the player gets trained/specialized mid-session (e.g., via a redistribution gem during testing), re-read skill state and re-draw. Listen for `kind=15` skill-update events (or whatever event the existing skill-panel uses) — read the existing handler to find it.

5. **The 0.8 sweet-spot tick (optional).** RynthSuite's 0.8 cap is the "safe Recklessness-trained" boundary — full bonus, but inside the band so the penalty applies, and importantly *the band's risk is still bounded* (Recklessness damage scales linearly inside the band). Drawing a small tick at 0.8 within the band would be a nice power-user touch but isn't required for v1.

#### What NOT to do

- **Do NOT enforce a power cap.** RynthSuite caps bot-driven swings at 0.8 because the AI doesn't want to take maximum incoming damage; for a human player, capping their swing would be paternalistic. Just show them where the danger zone is.
- **Do NOT modify the slider's wire payload.** The slider value sent on `sessionHandle.attack(targetGuid, height, slider)` stays as-is. The band is purely visual.
- **Do NOT touch the magic/spell-picker form of combat-bar.** Recklessness doesn't apply to magic per the wiki — no band needed when in a magic stance. The existing stance-conditional rendering already handles this; just guard your band code on the melee/missile branches.

#### Acceptance criteria

- Untrained / Unusable Recklessness: no band drawn (existing slider unchanged).
- Trained: red band 10%–90% with "+10 DR" tooltip.
- Specialized: same band, "+20 DR" tooltip.
- Magic stance: no band (band code gated to non-magic stances).
- Missile stance: band still drawn (Recklessness applies to missile per the wiki).
- `node --check` clean.
- No regression in existing combat-bar tests (whatever exists under `apps/holtburger-web/`).

#### Reporting

Files changed (paths + line counts), the skill-state lookup approach used, screenshot or DOM snapshot proving the band renders for each training level (or — if you can't drive the browser — a clear note that visual validation is deferred to the user). Under 300 words. **Don't commit — parent agent handles commits.**

### Wave 4 results — shipped 2026-05-26

**Agent:** G
**Files (+146 / -1, one file):**
- `external/holtburger/apps/holtburger-web/plugins/combat-bar.js` — module-level `SKILL_TYPE_RECKLESSNESS = 50` + `readRecklessnessTrainingLevel()` helper walks `window.__sessionHandle.playerStats().skills` (the flat `[type, current, base, ranks, training, …]` Vec<u32>) in 5-tuples and returns the Recklessness training level. New CSS classes `hb-cb-power-wrap` (relative-positioned slider wrapper) + `hb-cb-power-band` / `hb-cb-power-band-spec` (10%–90% overlay between slider track and thumb). `refreshRecklessnessBand()` called at render and re-called on every `playerStatsUpdated` event via `__pluginClient.events.on(...)`; teardown wired into `bodyEl.__reckBandDispose` and chained into `activate()`'s dispose list alongside `__powerMeterDispose` / `__spellPickerDispose` / `__stanceHeaderDispose`. Magic-stance defense via `currentStanceIsMagic()` early-return.

**Visual treatment:**
- Trained: `rgba(220, 80, 40, 0.18)` fill / `rgba(220, 80, 40, 0.32)` border.
- Specialized: `rgba(220, 80, 40, 0.26)` fill / `rgba(240, 100, 60, 0.45)` border (slightly punchier for +20 vs +10).
- Band geometry: `left: 10%; width: 80%; height: 10px;` vertically centered on slider track; z-index 0 behind slider thumb's z-index 1.
- Tooltip via native `title` attr matching `tab.title` / `combat-hud.js` style: `"Recklessness active: +10 Damage Rating (also +10 incoming non-crit damage from all sources). Band is 10%–90% of the power bar."` (or +20 for Spec).

**Wire payload:** untouched. `state.powerLevel`, `syncWindowState`, and the slider's `input`/`change` listeners are unchanged; raw slider value still flows to `window.__combatBarState.powerLevel` → `picking.js` → `sessionHandle.attack(targetGuid, height, slider)`. Band is purely visual per the acpedia + RynthSuite cross-ref.

**Validation:** `node --check` clean. Browser-side visual validation deferred — DOM snapshot when band is active: `<span class="hb-cb-power-wrap"><span class="hb-cb-power-band hb-cb-power-band-spec" title="…+20…" style=""></span><input type="range" …></span>`.

**Net visible behavior:**
- Player trained in Recklessness sees a red band between 10% and 90% of their melee/missile power slider, signaling "swing here for +10 DR (and +10 incoming non-crit damage)". Player swings outside the band → no bonus, no penalty.
- Specialized Recklessness → punchier band + "+20" tooltip.
- Magic stance → no band (combat-bar transforms to spell picker anyway; redundant guard for safety).
- Mid-session redistribution (e.g. respec gem) → `playerStatsUpdated` event re-runs the band check; UI updates without reload.

### Wave 4 follow-on candidates (deferred to Wave 5)

See "Wave 5" section below.

---

## Wave 5 — wiki-research follow-ons (5 agents, parallel)

Six phases, five agents — Phases 13 + 14 are bundled into one agent because both audit `ui/ac_attack_type_for_weapon.js`. All other file paths are disjoint, so the 5 agents dispatch in parallel with no merge risk.

### Pre-investigated facts (verified before dispatch)

- **PowerLevel and AccuracyLevel are FloatKey 92 and 93, NOT 86/87.** RynthSuite's `AcStubs.cs:56-57` claims `PowerLevel = 86 / AccuracyLevel = 87`; that disagrees with both our enum at `crates/holtburger-common/src/properties/property_keys/floats.rs:104-105` AND ACE's authoritative enum at `ace-server/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs:108-109`, which both have **92/93**. Use our canonical values; RynthSuite likely has a stale/divergent enum.
- **PropertyFloat is already plumbed through.** `crates/holtburger-world/src/handlers/properties.rs:120-143` already routes `PrivateUpdatePropertyFloat` / `PublicUpdatePropertyFloat` into `WorldState.player.float_properties`. Phase 11 just needs a wasm getter; no protocol-parser change required.
- **Skills are already surfaced.** `sessionHandle.player.skills()` returns `Vec<u32>` flat-packed as `[type, current, base, ranks, training, …]` per `src/lib.rs:13963`. `TwoHandedCombat = 41` (`crates/holtburger-common/src/stats.rs:140`).
- **AttackType.cs.** Heavy/Light/Finesse/TwoHandedCombat all use `Slash`, `Thrust`, etc — the bitmask values from `ace-server/Source/ACE.Entity/Enum/AttackType.cs`.
- **The acpedia "Light Weapons covers unarmed" finding does NOT invalidate `inferAttackTypeForWeapon(null) → Punch (0x01)`.** Our helper is correct for the WIRE TYPE; the skill that GATES the swing is LightWeapons (45), but the AttackType code passed to the CMT stays `Punch`. Phase 14 is an audit + comment update, not a logic change.

### Phase 9 — Defender-facing Sneak Attack prediction (JS-only)

**Owner:** Agent H
**Scope:** Per the acpedia wiki, Sneak Attack gates on attacker-position-vs-defender-facing. To predict the bonus client-side (and let the UI show "Sneak attack ready" when the player is behind their target), we sample the defender's last-known heading from the entity manager at swing-fire and compute `dot(attackerForward, defenderForward) < threshold`.

**Files:**
- NEW `external/holtburger/apps/holtburger-web/ui/ac_sneak_attack_predict.js` — exports `isAttackerBehindDefender({attackerPose, defenderPose, defenderHeadingRad})` plus a `SNEAK_ATTACK_CONE_RAD` constant.
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` — melee + missile branches. After resolving `motionCmd` / `aimMotion`, call the predictor; if true, fire `__pluginClient.events.emit("sneakAttackPredicted", {targetGuid, attackType, ...})` so plugins can light up an indicator.
- *(Do NOT add a magic branch in this phase — wiki notes Sneak Attack applies to spells too, but spell-cast paths fan out into the magic stance picker, which is a different code path; deferred to a separate phase.)*

**Acceptance:**
- Pure helper: given AC-coord poses + defender yaw, returns boolean.
- Wired into picking.js's melee + missile fire paths.
- New event `sneakAttackPredicted` fires when the predicate is true.
- `node --check` clean. No wire-side changes.

### Phase 10 — Shield "One-Handed (Shield)" CMT-row Backhand-absence audit

**Owner:** Agent I
**Scope:** The acpedia Combat omnibus page (line 181) states shields "only protect the front" and the per-stance maneuver table omits Backhand under the "One-Handed (Shield)" column. Verify this against retail CMT 0x30000000 data: are there zero `Backhand*` MotionCommand rows for the `SwordShieldCombat (0x80000040)` stance?

**Files:**
- NEW `external/holtburger/crates/holtburger-dat/tests/shield_stance_no_backhand_audit.rs` — parity-test pattern matching `combat_maneuver_table_parity.rs`. Walks CMT 0x30000000, filters to stance `0x80000040`, asserts no motion u32 in the rows maps to a `Backhand*` name (cross-check against `apps/holtburger-web/data/motion-command-names.json`'s name table).

**Acceptance:**
- `cargo test -p holtburger-dat shield_stance_no_backhand_audit` PASSes when run with `HOLTBURGER_PORTAL_DAT` set; gracefully skips otherwise (mirroring `combat_maneuver_table_parity.rs:16`).
- Test report (paste of cargo output) shows the per-stance motion counts and confirms the absence.
- If the audit *finds* Backhand* rows for the shield stance, REPORT IT — that's a wiki-contradicts-data finding worth surfacing rather than silently failing.

### Phase 11 — PowerLevel/AccuracyLevel surface for diag

**Owner:** Agent J
**Scope:** Add wasm getters for the player's current `PowerLevel` (FloatKey 92) and `AccuracyLevel` (FloatKey 93). Surface in the diag layer so we can see the SERVER's authoritative power state vs the local slider value — useful for catching desync.

**Files:**
- `external/holtburger/apps/holtburger-web/src/lib.rs` — new wasm-exported method on `SessionHandle` returning `{ powerLevel: f32, accuracyLevel: f32 }` (or two getters). Reads from `state.player.float_properties.get(&FloatKey::PowerLevel)` etc.
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` — surface in `summary()` and `snapshot()` as `serverPowerLevel` / `serverAccuracyLevel`. Compare against slider state if accessible.

**Acceptance:**
- New wasm method present and callable from JS.
- Diag snapshot includes the values (or `null` if not yet received from server).
- `cargo check -p holtburger-web --target wasm32-unknown-unknown` clean.
- `node --check` clean on diag/combat.js.

### Phase 12 — Spell-shape classifier (six War + five Void shapes)

**Owner:** Agent K
**Scope:** Build a SpellId → `(school, shape, level)` lookup so the renderer knows whether a spell-cast event should spawn a single bolt, an arc, a streak, a volley, a wall, a ring, or a blast. The wind-up animation stays uniform; the *projectile pattern* is what differs. Magic stance's spell-picker can already fire spells; this phase just classifies the resulting `Cast*` events for the projectile spawner.

**Files:**
- NEW `external/holtburger/apps/holtburger-web/ui/ac_spell_shape.js` — exports `SPELL_SHAPE` const enum (`Bolt`, `Arc`, `Streak`, `Volley`, `Wall`, `Ring`, `Blast`) + `SPELL_SCHOOL` const enum (`War`, `Void`, `Creature`, `Item`, `Life`) + `classifySpell(spellId) → { school, shape, level } | null`.
- NEW `external/holtburger/apps/holtburger-web/data/spell-shapes.json` — generated lookup table. Source the mapping from the LSD spell data at `external/LSD-Partial-2025-02-23_16-15/spells/` (or wherever spell weenies live in this repo). Write a one-shot Node script under `apps/holtburger-web/scripts/` that parses the LSD spell JSON, classifies each spell by name-pattern (e.g., `Bolt` in name → `Bolt` shape, `Streak` → `Streak`, etc.), and emits the JSON.

**Acceptance:**
- Helper exports the two enums + classifier.
- `classifySpell` returns expected values for a few hand-picked test cases (`Lightning Bolt 1` → `{school: War, shape: Bolt, level: 1}`, `Nether Streak VII` → `{school: Void, shape: Streak, level: 7}`, etc.). Ship a few inline unit tests.
- The script is idempotent and committed alongside the JSON it generates.
- War Magic produces 6 distinct shapes (arc / ring / wall / bolt / volley / blast). Void Magic produces 5 (no wall, no volley; adds DoT/debuff into a separate shape bucket or leave as `null` shape).
- No wiring into picking.js or index.html in this phase — that's the renderer side, separate ticket.

### Phase 13 + 14 (bundled) — Two-Handed Combat audit + Light Weapons unarmed audit

**Owner:** Agent L (bundled because both touch `ui/ac_attack_type_for_weapon.js`)

**Phase 13 — Two-Handed Combat:**
- Investigate `ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050` (`GetAttackType`) and ACE's `WeaponType` enum: what AttackType bitmask is returned for two-handed weapons (`Slash`, `Thrust`, both)?
- Today our `inferAttackTypeForWeapon` returns `Slash = 0x04` for the `TWO_HANDED (0x02000000)` equipMask. Verify this matches retail: are two-handed swords slash-only? Are polearms thrust? Some weapons multi-class?
- If retail differentiates (e.g., polearm should be Thrust, two-handed sword Slash), split the TWO_HANDED branch by `WeaponType` if the data is available, OR leave as Slash with a comment explaining the limitation.

**Phase 14 — Light Weapons unarmed:**
- The wiki research surfaced that **Light Weapons (skill 45) covers unarmed (punch and kick)**. There's no separate Unarmed skill post-MoA.
- Our `inferAttackTypeForWeapon(null) → Punch (0x01)` is **correct** for the wire type. The skill-gating happens server-side.
- Audit the helper's docstring: ensure the "unarmed" branch comment cites LightWeapons (45), not a phantom Unarmed skill. Also note that "kick" is `AttackType.Kick = 0x08` in ACE's enum — our helper currently always returns `Punch` for unarmed; whether to return `Kick` for some condition (e.g., low height?) is server-side per CMT row.
- This is an audit + comment update, not a logic change.

**Files:**
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` — extend or comment-update; both phases land in this file.

**Acceptance:**
- Phase 13 either adds a TWO_HANDED sub-branch with `WeaponType` discrimination (Slash for swords, Thrust for spears/polearms) OR leaves as-is with a documented limitation citing the ACE source.
- Phase 14's audit confirms the helper's docstring accurately reflects post-MoA skill mapping. No phantom Unarmed references.
- `node --check` clean.
- Mapping table at the top of the helper updated to reflect the audit findings.

### Wave 5 results — shipped 2026-05-26

#### Phase 9 (Agent H) — Sneak-attack predictor

**Files (3, +368 / -0):**
- NEW `external/holtburger/apps/holtburger-web/ui/ac_sneak_attack_predict.js` (270 lines): `isAttackerBehindDefender({attackerPose, defenderPose, defenderHeadingRad})` + `SNEAK_ATTACK_CONE_RAD`. 8/8 inline unit tests PASS.
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (+43): new `getHeading(guid)` accessor using the same `atan2` extraction as `getLocalPlayerHeading`.
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` (+55): both melee and missile fire closures (inside `fireOnce`) re-sample pose + target heading, call the predictor, fire `sneakAttackPredicted` event when behind.

**Cone angle.** Ported VERBATIM from `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs:762-763`:
```csharp
var angle = creatureTarget.GetAngle(this);  // signed angle defender→attacker in defender's local frame
var behind = Math.Abs(angle) > 90.0f;       // 180° rear hemisphere
```
So `SNEAK_ATTACK_CONE_RAD = Math.PI / 2`. AC forward-vector convention `(-sin h, cos h, 0)` cross-verified against `Position.cs:80-83` (`Vector3.Transform(Vector3.UnitY, Rotation)`) and existing `getLocalPlayerHeading`. Wire payload unchanged. Magic-cast prediction deferred (different spell-picker dispatch path).

#### Phase 10 (Agent I) — Shield CMT audit (WIKI WAS WRONG)

**Files (1 NEW, 165 lines):**
- NEW `external/holtburger/crates/holtburger-dat/tests/shield_stance_backhand_audit.rs`. Final polarity: positive assertion locking in the retail-data shape (3 Backhand rows under SwordShieldCombat, one per AttackHeight).

**Finding.** acpedia's Combat omnibus page claims "shields only protect the front" and visually omits Backhand under the "One-Handed (Shield)" column. Retail CMT 0x30000000 actually contains **3 Backhand rows under SwordShieldCombat**, one per AttackHeight (Low/Medium/High), all keyed `attack_type=0x0004` (Slash). The motion-name→height mapping is *inverted* (Low height swings BackhandHigh, etc — a separate retail quirk).

Interpretation open question: either the wiki is wrong, or retail leaves the data in but gates the motions at runtime via a different check (`acclient.c` swing path, or ACE's `Player_Melee.GetSwingAnimation` filter). The test does NOT resolve this — it locks in current retail data and acts as a regression guard.

**Test result.** PASS against `~/ac_base_dats/client_portal.dat`: `Shield stance has 15 maneuvers; 15 unique motions; Backhand* motions found: 3` in 1.03s. Skipped cleanly when `HOLTBURGER_PORTAL_DAT` is unset.

#### Phase 11 (Agent J) — PowerLevel/AccuracyLevel wasm getter

**Files (2, +94 / -0):**
- `external/holtburger/apps/holtburger-web/src/lib.rs` (+60): new `#[wasm_bindgen(js_name = playerPowerState)] pub fn player_power_state(&self) -> Vec<f32>` reading `world.entities.get(world.player.guid).get_float_prop(PropertyFloat::{PowerLevel,AccuracyLevel})` via the existing `LatestStats` shared cell. Returns 2-element `[PowerLevel, AccuracyLevel]` with NaN for un-received values.
- `external/holtburger/apps/holtburger-web/scene3d/diag/combat.js` (+34): `summary()` + `snapshot()` now carry `serverPowerLevel` / `serverAccuracyLevel` (read-on-demand from the wasm getter, NaN normalized to `null` for clean JSON).

**Important correction.** RynthSuite's `AcStubs.cs:56-57` claims `PowerLevel = 86 / AccuracyLevel = 87`. That's wrong — verified against `crates/holtburger-common/src/properties/property_keys/floats.rs:104-105` AND `ace-server/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs:108-109` which both have **92 / 93**. The original RynthSuite follow-on note in this doc has been corrected.

#### Phase 12 (Agent K) — Spell-shape classifier

**Files (4, +847 / -0):**
- NEW `external/holtburger/apps/holtburger-web/ui/ac_spell_shape.js` (290): `SPELL_SHAPE` (7-shape projectile superset + Self), `SPELL_SCHOOL` (6-school ACE-canonical), `classifySpell(spellId) → { school, shape, level } | null`. Lazy-fetch in browser; sync-preload for Node tests.
- NEW `external/holtburger/apps/holtburger-web/data/spell-shapes.json` (274.6 KB, 6,266 entries, sorted by SpellId).
- NEW `external/holtburger/apps/holtburger-web/scripts/gen-spell-shapes.cjs` (295): one-shot generator joining `data/spells-catalog.json` (the existing committed catalog from LSD) with name/description pattern-matching for shape classification.
- NEW `external/holtburger/apps/holtburger-web/test_ac_spell_shape.mjs` (262): 30/30 unit tests PASS.

**Per-(school, shape) buckets:**
| School | Counts |
|---|---|
| War | Arc=62 · Blast=51 · Bolt=121 · Ring=93 · Streak=53 · Volley=76 · Wall=32 · Self=203 (691 total) |
| Void | Arc=8 · Blast=8 · Bolt=8 · Ring=3 · Streak=9 · Self=40 (76 total) |
| Life | Self=1501 |
| Item | Self=1079 |
| Creature | Self=2919 |

War uses all 7 projectile shapes (including Streak from Slumbering Giant — wiki research had said 6 but Streak is correct per data). Void uses exactly the 5 from the wiki (no Wall, no Volley). Spot-check examples: `Lightning Bolt I → War/Bolt`, `Nether Streak VII → Void/Streak`, `Os' Wall → War/Wall`, `Firestorm → War/Volley`, `Festering Curse III → Void/Self`.

Helper not yet wired into picking.js / index.html / spell-picker — that's renderer-side work (separate ticket).

#### Phase 13 + 14 (Agent L) — TwoHanded + LightWeapons audits

**Files (1, +141 / -0 comments-only):**
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` — audit + comment update; helper logic unchanged.

**Phase 13 finding.** ACE's `WorldObject_Weapon.cs:1050 GetAttackType` reads `W_AttackType` (PropertyInt 47) and never branches on WeaponType; every dispatch is driven off the raw bitmask. Survey of all 646 retail TwoHandedCombat weapons in `external/LSD-Partial-2025-02-23_16-15/weenies/` shows:
- Axe 100% Slash, Mace 98% Slash
- Spear 88% Thrust
- Sword 84% Thrust|Slash
- Staff 93% Thrust|Slash
- Dagger 37% DoubleSlash|DoubleThrust

So the hardcoded `Slash` for the TWO_HANDED equipMask is **wrong for ~35–40%** of two-handed weapons. Chose option (c): keep as `Slash` with a documented limitation citing the wire-side fix needed (surface PropertyInt 47 + PropertyInt 353 on the `WieldedWeaponEntry` wasm struct, see breadcrumb pointing at `src/lib.rs:15421`).

**Critical citation fix.** The pre-existing docstring had **wrong PropertyInt key numbers** (AttackType=45, WeaponType=89). Real values are 47 and 353 per `PropertyInt.cs:78` and `:556`. Fixed.

**Phase 14 finding.** Helper's docstring did NOT reference a phantom "Unarmed skill" — it correctly cited the AttackType composite. Updated comment now explicitly cites `Skill.LightWeapons` (Skill enum value 47, `Skill.cs:58`) as the post-MoA gating skill, with a note that legacy `Skill.UnarmedCombat` (value 14, `Skill.cs:26`) survives in ACE only for pre-MoA data-migration paths.

Added a documented limitation: helper always returns `Punch (0x01)` regardless of power, while acpedia maps unarmed Full PB → Kick, Medium → Punch, Low → Jab. Height-aware AttackType selection tracked as a TODO with two implementation paths.

### Wave 5 validation summary

| Check | Result |
|---|---|
| `node --check` on all 7 modified/new JS files | PASS |
| `cargo check -p holtburger-web --target wasm32-unknown-unknown` | PASS (18 pre-existing warnings, 0 new) |
| `wasm-pack build --target web --dev` | PASS, `playerPowerState` in `pkg/holtburger_web.d.ts:2920` |
| `cargo test -p holtburger-dat --test shield_stance_backhand_audit` (with portal.dat) | PASS in 1.03s |
| `node test_ac_aim_level_for_velocity.mjs` (Phase 7 regression check) | 16/16 PASS |
| `node test_ac_spell_shape.mjs` | 30/30 PASS |
| Sneak-attack predictor smoke (parent agent verified) | PASS |

### Single commit + push

`feat(holtburger-web): CMT fixes wave 5 — sneak-attack predict + shield audit + power-level surface + spell shapes + weapon-type audits`.

### What's still parked after Wave 5

See Wave 6 below.

---

## Wave 6 — wire surfacing + magic-side completeness (4 agents, parallel)

Four phases, four agents — all file-disjoint, dispatch in parallel.

### Pre-investigated facts

- **PropertyInt::AttackType = 47** exists in `crates/holtburger-common/src/properties/property_keys/ints.rs:55`. Already used at `crates/holtburger-world/src/assessment.rs:823-826` via `object.get_int_prop(PropertyInt::AttackType).map(|bits| AttackType::from_bits_truncate(bits as u32))`. Just needs to flow into `WieldedWeaponEntry`.
- **`WieldedWeaponEntry`** is defined at `src/lib.rs:14099-14112` with five fields (`item_guid, wcid, name, item_type, equip_mask`). Populated at `src/lib.rs:15460-15466` from `apply_inventory_object_create`.
- **`EquippedWeaponJs`** is the wasm-exported struct at `src/lib.rs:14126-14132`, returned by `SessionHandle::entity_equipped_weapon`. Phase 15 extends both structs.
- **Magic-cast dispatch lives at `scene3d/picking.js:319-329`** — `castTargetedSpell(guid, spellId)` inside the `isInMagicStance` branch of `onPointerDown`. Phase 16 wires the sneak-attack predictor here.
- **Spell picker lives at `plugins/combat-bar.js:908 renderSpellPicker`**. Phase 17 surfaces shape icons here.
- **`classifySpell(spellId)`** from Wave 5 Phase 12 returns `{ school, shape, level }` — Phase 17 consumes this directly. Lazy-loads `data/spell-shapes.json` on first call.

### Phase 15 — W_AttackType (PropertyInt 47) wire surfacing

**Owner:** Agent M
**Goal:** Surface the weapon's `W_AttackType` bitmask on `EquippedWeaponJs` and through `inferAttackTypeForWeapon` so two-handed weapons get the correct AttackType (closes Phase 13's documented limitation). Spear → Thrust, Sword → Thrust|Slash, etc.

**Files:**
- `external/holtburger/apps/holtburger-web/src/lib.rs`:
  - `WieldedWeaponEntry` (struct at line 14099): add `attack_type: u32`. Populate at line 15460ish from `entity.get_int_prop(PropertyInt::AttackType).map(|bits| bits as u32).unwrap_or(0)`.
  - `EquippedWeaponJs` (struct at line 14126): add `attack_type: u32`. Add a `#[wasm_bindgen(getter)] pub fn attack_type(&self) -> u32` method.
  - Wherever `EquippedWeaponJs` is constructed from `WieldedWeaponEntry` (search for the construction site — likely in `SessionHandle::entity_equipped_weapon`), populate the new field.
- Local-player path: `playerInventory()` returns `InventoryItem` structs. Find where those are constructed (`apply_inventory_object_create` probably has the local branch too) and add the same `attack_type` field. Expose to JS.
- `external/holtburger/apps/holtburger-web/scene3d/entities.js`:
  - `getEquippedWeapon(guid)` (Agent B's Wave 1 work) — extend the returned object to include `attackType: weapon.attackType ?? 0` for both local + non-local branches.
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js`:
  - Update `inferAttackTypeForWeapon(weapon)` to **prefer `weapon.attackType` when non-zero**, falling back to the existing EquipMask heuristics. If the bitmask has multiple bits set (e.g., `Thrust|Slash = 0x06`), return the bitmask as-is — `getCombatManeuver` already handles multi-bit lookup via the picker's IsThrustSlash branch.
  - Update the mapping-table comment to document the new precedence: wire `W_AttackType` > EquipMask heuristic > Undef fallback.
  - Remove or update the TODO breadcrumb at the bottom that says PropertyInt 47 isn't surfaced; now it is.

**Acceptance:**
- `cargo check -p holtburger-web --target wasm32-unknown-unknown` clean.
- `wasm-pack build` succeeds and `pkg/holtburger_web.d.ts` shows `attack_type` on `EquippedWeaponJs`.
- `node --check` clean on entities.js + ac_attack_type_for_weapon.js.
- `inferAttackTypeForWeapon({attackType: 0x02, equipMask: 0x02000000})` (a two-handed spear) returns `0x02` (Thrust), not `0x04` (Slash from old TWO_HANDED branch).
- `inferAttackTypeForWeapon({attackType: 0x06, equipMask: 0x00100000})` (sword with both Thrust+Slash) returns `0x06`.
- `inferAttackTypeForWeapon({attackType: 0, equipMask: 0x00100000})` (no wire AttackType — fallback) returns `0x04` (Slash) per existing heuristic.

**Hard constraints:**
- Do NOT touch `picking.js` call sites or the CMT lookup itself — the helper's return value already feeds correctly into `getCombatManeuver`.
- Do NOT remove the EquipMask fallback — pre-PropertyInt-arrival ObjectCreate events still need the existing classification.

### Phase 16 — Magic-side Sneak Attack prediction

**Owner:** Agent N
**Goal:** Extend Phase 9's `sneakAttackPredicted` event to fire on magic spell casts, since the acpedia wiki confirms Sneak Attack works for War + Void Magic (facing-gated like melee/missile).

**Files:**
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` — the magic branch at lines 319-329 (`isInMagicStance && castTargetedSpell`). After the `sessionHandle.castTargetedSpell(guid, spellId)` call, sample defender pose + heading and fire the predictor:
  ```js
  if (spellId !== 0) {
    const targetPos = entityAcPosition(em, guid);
    const targetHeadingRad = em.getHeading?.(guid) ?? null;
    if (targetPos && targetHeadingRad != null && pose) {
      if (isAttackerBehindDefender({
        attackerPose: pose,
        defenderPose: targetPos,
        defenderHeadingRad: targetHeadingRad,
      })) {
        window.__pluginClient?.events?.emit?.("sneakAttackPredicted", {
          attackerGuid: localGuid,
          defenderGuid: guid,
          attackType: null,  // magic — no melee AttackType bitmask applies
          spellId,
          scope: "local-magic",
        });
      }
    }
    sessionHandle.castTargetedSpell(guid, spellId);
  }
  ```
  Confirm `pose`, `em`, `localGuid` are in scope at line 319 (they might not be — read the surrounding code carefully and add the needed lookups).

**Acceptance:**
- `node --check` clean on picking.js.
- Event fires only when in magic stance AND a spell is armed AND the target is in the rear cone.
- `scope: "local-magic"` lets plugins distinguish magic Sneak Attack from melee/missile.

**Hard constraints:**
- Do NOT touch the melee/missile branches (Phase 9 already wired them).
- Do NOT modify `ui/ac_sneak_attack_predict.js` — the predictor is already correctly generic.
- Do NOT touch `combat-bar.js`'s spell picker (Phase 17 territory).
- The `attackType: null` in the event payload is intentional — magic doesn't have a CMT AttackType bitmask. Plugins consuming the event should handle `null`.

### Phase 17 — Magic-shape classifier UI surface in spell-picker

**Owner:** Agent O
**Goal:** Surface Wave 5 Phase 12's spell-shape classifier in the spell-picker UI so the user sees what projectile pattern each spell will produce (Bolt / Arc / Streak / Volley / Wall / Ring / Blast / Self).

**Files:**
- `external/holtburger/apps/holtburger-web/plugins/combat-bar.js` — `renderSpellPicker` function around line 908. For each spell button, after fetching the spell name, also call `classifySpell(spellId)` and surface the shape:
  - Either as a small icon (single-letter badge: "B" for Bolt, "S" for Streak, "A" for Arc, "V" for Volley, "W" for Wall, "R" for Ring, "X" for Blast, no icon for Self/non-projectile)
  - Or as a tooltip suffix: "Lightning Bolt I (Bolt)"
  - Or both — pick what fits the existing combat-bar aesthetic.
- Import `classifySpell` from `../ui/ac_spell_shape.js`. The classifier is async on first call (lazy-loads JSON); cache the result or pre-warm at picker open.

**Hard constraints:**
- Do NOT wire spell-shape into projectile spawning — that's renderer work for a separate ticket. This phase is UI-surface only.
- Do NOT touch `ui/ac_spell_shape.js` — Wave 5 just shipped it; use as-is.
- Do NOT touch `picking.js` (Phase 16 territory).
- Magic stance only; don't add shape badges to melee/missile combat-bar configurations (they don't have spell IDs).

**Acceptance:**
- `node --check` clean on combat-bar.js.
- Open spell-picker in magic stance → each spell button shows its shape badge or tooltip.
- Non-projectile spells (Self) either show no badge or a "Self" badge — your call.
- Empty / unclassified spells fall back gracefully.

### Phase 18 — Acclient.c shield-Backhand runtime gate investigation

**Owner:** Agent P
**Goal:** Resolve the wiki-vs-data divergence from Wave 5 Phase 10. Retail CMT 0x30000000 contains 3 Backhand rows under SwordShieldCombat (Low/Med/High, all Slash), but the acpedia Combat omnibus page omits them. Either the wiki is wrong, OR retail blocks the motions at runtime via a separate gate. Find which.

**Investigation steps:**
1. Grep `/home/wbterminal/ac-headers/acclient.c` for the `CombatManeuverTable::Get` call site (around line 408537). Read 100-200 lines of surrounding context.
2. Look for any code that filters MotionCommand results before playing them — e.g., shield-equipped check, weapon-type check, backhand-specific block.
3. Cross-check ACE's `Player_Melee.GetSwingAnimation` (`~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:440-475`) — does the server-side picker filter out Backhand for shield wearers? Look at the full method, not just the picker we ported.
4. Check `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs` for any "if shield equipped, drop backhand" logic.

**Deliverables:**
- Update `external/holtburger/crates/holtburger-dat/tests/shield_stance_backhand_audit.rs`'s doc-comment with the **resolution**: either (a) "retail gates Backhand at acclient.c:XXX via Y check" with the citation, OR (b) "no runtime gate found — the wiki is just wrong; retail will swing Backhand for shield-wearers when the CMT row is hit".
- If you find a runtime gate, also note the implication for OUR renderer: do we need to mirror the gate client-side, or does the server already filter and only send us non-Backhand motions on UpdateMotion (kind=5)?

**Files:**
- `external/holtburger/crates/holtburger-dat/tests/shield_stance_backhand_audit.rs` — doc-comment update only. NO test logic changes.
- *(optional)* a small standalone doc at `external/holtburger/docs/shield-backhand-runtime-gate-2026-05-26.md` if your findings warrant ~200+ words.

**Hard constraints:**
- Read-only investigation across acclient.c + ACE. No production code changes.
- Do NOT modify the test's assertion logic — the 3-rows-found assertion is correct; only the doc-comment narrative is in scope.

**Acceptance:**
- Concrete finding in the doc comment with file:line citation OR explicit "no gate found" statement after due-diligence search.
- If a doc was written, it cites all sources read.

**Reporting (for all 4 agents):**

Files changed (paths + line counts), key findings, validation steps, any surprises. Under 350 words each. **Don't commit — parent agent handles commits after all 4 finish.**

### Wave 6 results — shipped 2026-05-26

#### Phase 15 (Agent M) — W_AttackType wire surfacing

**Files (3, +239 / -91):**
- `external/holtburger/apps/holtburger-web/src/lib.rs` (+84 / -2): added `attack_type: u32` to `WieldedWeaponEntry` (line 14099), `EquippedWeaponJs` (line 14126), AND `InventoryItem` (line 13991, the local-player twin). New `#[wasm_bindgen(getter, js_name = attackType)]` on both Js structs. Populated in `apply_inventory_object_create` (line 15431) via `entity.get_int_prop(PropertyInt::AttackType).map(|bits| bits as u32).unwrap_or(0)`, in `entity_equipped_weapon` (line 16386), and in `publish_player_inventory_snapshot` (line 20062).
- `external/holtburger/apps/holtburger-web/scene3d/entities.js` (+25 / -7): `getEquippedWeapon(guid)` emits `attackType: (… ?? 0) >>> 0` on BOTH local-player (playerInventory loop) and non-local (entityEquippedWeapon wasm call) branches.
- `external/holtburger/apps/holtburger-web/ui/ac_attack_type_for_weapon.js` (+130 / -82): wire-first precedence — `inferAttackTypeForWeapon(weapon)` returns `weapon.attackType` verbatim when non-zero (preserves multi-bit values for the picker's `IsThrustSlash` branch); falls through to existing EquipMask heuristic otherwise. Mapping table + module docstring updated. Phase 13 "limitation" section now reads "Resolution"; old TODO replaced with strikethrough + done note.

**Verified acceptance (parent reran):**
- `inferAttackTypeForWeapon({attackType: 0x02, equipMask: 0x02000000})` → `0x02` (two-handed spear: Thrust). ✓
- `inferAttackTypeForWeapon({attackType: 0x06, equipMask: 0x00100000})` → `0x06` (sword: Thrust|Slash). ✓
- `inferAttackTypeForWeapon({attackType: 0, equipMask: 0x00100000})` → `0x04` (fallback: Slash). ✓
- `inferAttackTypeForWeapon(null)` → `0x01` (unarmed: Punch). ✓

`cargo check wasm32` clean (18 pre-existing warnings, 0 new). `wasm-pack build` PASS; `pkg/holtburger_web.d.ts` shows `readonly attackType: number` on both `EquippedWeaponJs` and `InventoryItem`.

#### Phase 16 (Agent N) — Magic-side Sneak Attack prediction

**Files (1, +33 / -0):**
- `external/holtburger/apps/holtburger-web/scene3d/picking.js` — magic-cast branch at line 327 inside `onPointerDown`. Wraps `castTargetedSpell` with the predictor call, fires `sneakAttackPredicted` event with `scope: "local-magic"` + `attackType: null` (magic has no CMT AttackType bitmask). Pure observational; cast fires regardless of predictor match. `try/catch` wrap so prediction faults never block the cast. Reuses Phase 9's `isAttackerBehindDefender` import; all helper poses (`playerWorldPose`, `entityAcPosition`, `em.getHeading`, `getLocalPlayerGuid`) were already in scope.

#### Phase 17 (Agent O) — Spell-shape UI in spell-picker

**Files (1, +122 / -2):**
- `external/holtburger/apps/holtburger-web/plugins/combat-bar.js` — `renderSpellPicker` now annotates each spell button with a **single-letter color-coded badge** (`B`/`A`/`S`/`V`/`W`/`R`/`X`/`·`) AND a tooltip suffix (`"Lightning Bolt I (Bolt)"`). 14px fixed-width badge column prevents layout jitter. Render-with-placeholder + 50ms poll-on-load strategy: initial render shows empty badges (table lazy-loads), `setInterval(50ms)` polls `isShapeTableLoaded()` and re-renders once on load (cleanup hooked into existing `bodyEl.__spellPickerDispose` chain, 3s safety stop). Mirrors the `loadCatalog().then(renderRows())` pattern next door.

Per-shape badge colors: Bolt=blue, Arc=purple, Streak=amber, Volley=pink, Wall=mint, Ring=yellow, Blast=orange, Self=dim-gray-transparent. Recklessness band code (Wave 4) untouched.

DOM output example:
```html
<button class="hb-cb-spell" data-spell-id="75" title="Lightning Bolt I (Bolt)">
  <span class="hb-cb-spell-action">ARM</span>
  <span class="hb-cb-spell-shape" data-shape="Bolt">B</span>
  <span class="hb-cb-spell-name">Lightning Bolt I</span>
  <span class="hb-cb-spell-tag">War</span>
</button>
```

#### Phase 18 (Agent P) — Shield-Backhand runtime gate investigation

**Conclusion: THE WIKI IS WRONG. No runtime gate exists.** Read-only investigation across retail acclient.c (lines 407409–410069) and the entire ACE.Server tree found ZERO code paths filtering `Backhand*` MotionCommands from CMT results for shield-equipped attackers. The only retail `CombatManeuverTable::Get` call site (`acclient.c:408537`) treats the table as a boolean "do we have CMT data?" readiness gate; rows are never iterated. ACE's `Player_Melee.GetSwingAnimation`, `Monster_Melee.GetCombatManeuver`, `Creature_Combat`, `WorldObject_Weapon.GetAttackType`, and `CombatManeuverTable.GetMotion` all play whatever the dictionary lookup returns.

**Red herring caught:** The Backhand* enum values (`0x1000005E/5F/60`) are reused as **input-event keystroke IDs** in retail's `HandleCombatAction` / `HandleMagicAction` UI dispatch (acclient.c lines 254022–254030, 407471, 410027–410055). A naive grep for those hex values looks like motion filtering at first glance — it's not.

**Files (2, +93 / new 190):**
- `external/holtburger/crates/holtburger-dat/tests/shield_stance_backhand_audit.rs` — doc-comment header extended with full "Resolution" section, cited sources (file:line ranges), implication for our renderer. **Test logic untouched.**
- NEW `external/holtburger/docs/shield-backhand-runtime-gate-2026-05-26.md` (190 lines) — standalone deep-dive doc.

**Implication for our renderer:** Nothing to mirror. Our `Player_Melee` port + `ui/ac_combat_maneuver.js` picker already match ACE+retail (trust the table). Server-authoritative `UpdateMotion` (kind=5) broadcasts the resolved MotionCommand verbatim and our pose pipeline plays it as-is. The Wave 5 Phase 10 open question is closed.

### Wave 6 validation summary

| Check | Result |
|---|---|
| `node --check` on 4 modified JS files | PASS |
| `cargo check -p holtburger-web --target wasm32-unknown-unknown` | PASS (18 pre-existing warnings, 0 new) |
| `wasm-pack build` | PASS; `attackType` on `EquippedWeaponJs` + `InventoryItem` confirmed |
| `cargo test -p holtburger-dat shield_stance_backhand_audit` (with portal.dat) | PASS in 1.03s |
| `inferAttackTypeForWeapon` 4-case precedence check | 4/4 PASS |

## Coordination notes for agents

- All Wave 1 phases edit *different files* except `ui/ac_combat_maneuver.js`, which Phase 1 touches at line ~135 (telemetry only) and Phase 4 touches at line ~132 (algorithm). Phases 1 and 4 are in different waves, so no collision.
- **Phase 3's investigation step (where does weapon data live on entities) might surface that ObjDesc parsing already exposes the weapon — in which case the entities.js change is trivial. If it doesn't, flag the scope expansion in your handoff instead of silently adding ObjDesc plumbing.**
- Each agent should report back with: files changed, line counts, validation steps performed (and their output), any blockers or scope changes. Reports go into the "Wave N results" section of this doc.
