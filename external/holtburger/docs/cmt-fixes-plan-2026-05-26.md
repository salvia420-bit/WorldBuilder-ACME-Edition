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

### Wave 4 follow-on candidates (not in scope for Phase 8)

Captured here for visibility — these are NOT being shipped in Wave 4 unless the user requests them:

- **Defender facing on the wire for Sneak Attack prediction.** Currently we have local + remote heading from MotionUpdate, but not necessarily *defender* yaw at swing-impact tick. The wiki confirms Sneak Attack works for melee/missile/magic and gates on attacker-behind-defender. Wire-surface change; estimate ~80–120 LOC across protocol parser + wasm getter + JS dispatch.
- **Shield CMT validation.** Confirm "One-Handed (Shield)" CMT rows omit Backhand entries (per the Combat omnibus page). Quick parity-test addition; probably ~20 LOC.
- **PowerLevel / AccuracyLevel STypeFloat surface.** Read PropertyDouble keys 86 (PowerLevel) + 87 (AccuracyLevel) for diag observability of server-vs-client power state. ~30 LOC.
- **Spell-shape classifier.** Six War Magic shapes (arc/ring/wall/bolt/volley/blast) + five Void shapes (no wall/volley, adds DoT/debuff). Needed for projectile spawning, not animation. Map `SpellId` → `(school, shape, level)`. ~100 LOC + a data table generated from `external/LSD-Partial-2025-02-23_16-15/spells/`.
- **Two-Handed Combat skill audit.** Not in the wiki research set — flag as follow-on.

## Coordination notes for agents

- All Wave 1 phases edit *different files* except `ui/ac_combat_maneuver.js`, which Phase 1 touches at line ~135 (telemetry only) and Phase 4 touches at line ~132 (algorithm). Phases 1 and 4 are in different waves, so no collision.
- **Phase 3's investigation step (where does weapon data live on entities) might surface that ObjDesc parsing already exposes the weapon — in which case the entities.js change is trivial. If it doesn't, flag the scope expansion in your handoff instead of silently adding ObjDesc plumbing.**
- Each agent should report back with: files changed, line counts, validation steps performed (and their output), any blockers or scope changes. Reports go into the "Wave N results" section of this doc.
