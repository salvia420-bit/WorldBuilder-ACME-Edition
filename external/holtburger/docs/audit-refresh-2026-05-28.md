# Audit refresh — Wave 4 / 5 / 7 scope verification (2026-05-28)

**Author:** Wave 8 (audit-refresh) agent
**Trigger:** 4 of 9 prior Wave-1+2 agents found their tasks already partially or
wholly addressed by post-J4 commits. Re-verifying remaining briefs against
`master HEAD` before dispatching Waves 4, 5, 7 from the original 15-opportunity menu.

## Methodology

- Cross-referenced cited file:line in each pending brief against current `master HEAD`.
- `git log -S "<token>"` pickaxe across the cited symbols over the last 14 days.
- Read the cited source files to verify the TODO/stub/deferral comment still describes the live state.
- Categorized each as **STILL OPEN** / **PARTIAL** / **CLOSED** / **PIVOT**.
- Walked the wasm `pkg/holtburger_web.d.ts` and `apps/holtburger-web/src/lib.rs`
  to confirm the wasm-export surface for every C2S opcode each agent depends on.
- Walked the ACE-server (`~/ace-server/`) and Chorizite (`external/chorizite/`)
  trees to verify the citations in the briefs actually point at real files.

---

## Findings

### Wave 4.A — Train Skills UI

**Verdict: PARTIAL — wire layer present, wasm + UI missing; brief citations need correction**

- **Cited claim (brief):** "ship the skill-training panel … `PrivateUpdateSkill` is wired; only the panel + C2S opcode are missing."
- **Master HEAD state:**
  - **C2S opcodes (RaiseSkill 0x0046, TrainSkill 0x0047) are ALREADY in the protocol crate.**
    - `crates/holtburger-protocol/src/opcodes.rs:439-441`
    - `crates/holtburger-protocol/src/messages/player/actions.rs:68-118` (`RaiseSkillActionData` + `TrainSkillActionData` full pack/unpack with parity tests)
    - `crates/holtburger-protocol/src/messages/game_action.rs:98-99, 349-353, 779-789` (full pack/unpack wired into `GameAction` enum)
  - **`ClientCommand::RaiseSkill` and `ClientCommand::TrainSkill` are ALREADY in core**
    - `crates/holtburger-core/src/client/types.rs:536-543`
    - `crates/holtburger-core/src/client/commands.rs:178-179, 862-878` (routes to `send_game_action`)
  - **CLI app already drives the commands** at `apps/holtburger-cli/src/pages/game/domains/progression.rs:25-34` and `apps/holtburger-cli/src/pages/game/panels/dashboard/tabs/character/tab.rs:97`.
  - **`apps/holtburger-web/src/lib.rs` has ZERO wasm export** for these — confirmed by `grep "fn raise_skill\|fn train_skill"` (no matches), `grep "TrainSkill\|RaiseSkill" src/lib.rs` (zero hits).
  - **No `plugins/train-skills.js`** exists; `plugins/character-info.js` renders skills read-only (lines 17, 397, 609-634 — pure display of `[id, cur, base, trained_state, xp]` tuples).
- **Brief-citation errors (require correction before dispatch):**
  - `external/chorizite/ACBindings/Generated/UI/Elements/gmTrainSkillsUI.cs` **does not exist**. The actual UI binding is at `external/chorizite/ACBindings/Generated/UI/Elements/gmSkillUI.cs` (288 LOC). It already includes `TrainSkill(...)`, `RaiseSelectedSkill`, `TrainSkillDialogCallback`, `DisplaySelectionFooter_Untrained`, `ExperiencePointsToRaiseSkillTenLevels`, etc.
  - `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionRaiseSkill.cs` **does exist** and is a one-liner that dispatches to `Player.HandleActionRaiseSkill`. `GameActionTrainSkill.cs` also exists. Both confirmed.
  - The brief's "Wave C ported `SkillInfo` math" claim is accurate — see `crates/holtburger-core/src/client/skill_info.rs` and the `computeSkillBase`/`computeSkillCurrent` wasm exports at `pkg/holtburger_web.d.ts:5163-5182`.
- **Recommendation:**
  - **Replace** the `gmTrainSkillsUI.cs` citation with `gmSkillUI.cs` (entirely different filename in vendored Chorizite).
  - **Reduce scope** — protocol layer + ClientCommand routing is done. The agent only needs:
    1. Two `#[wasm_bindgen]` exports on `SessionHandle` (`raise_skill(skill_id, xp_spent)` and `train_skill(skill_id, credits)`) that mirror `useObject` (`src/lib.rs:20633-20641`).
    2. A new `plugins/train-skills.js` modeled on `character-info.js` (skill list + train/raise buttons + cost preview).
    3. Wire fixture for at least one of the two opcodes in `validate_wire_conformance.cjs`.
  - The cited "Wave C math" usage stays: cost preview uses `computeSkillBase` etc. as the wave intended.
- **Effort delta:** S–M → S (~half of original scope). Protocol layer carries less risk than the brief implies.

---

### Wave 4.B — Remote-entity buff/debuff

**Verdict: STILL OPEN — brief is accurate; small ACE-citation polish**

- **Cited claim (brief):** "`plugins/buffs-hud.js` only renders self-buffs. Add target_guid dispatch and a per-nameplate bar so we can see debuff stacks on raid targets and ally buffs."
- **Master HEAD state:**
  - Wire layer is complete on the inbound side (`crates/holtburger-protocol/src/messages/magic/events.rs:256` — `MagicDispelEnchantmentEventData` has `target` field).
  - **But the dispatch path drops non-player enchantments on the floor.** `crates/holtburger-world/src/player/mutations.rs:440-462` (`upsert_enchantment`), `:464-488` (`upsert_multiple_enchantments`), `:490-505` (`remove_enchantment`), `:507-524` (`remove_multiple_enchantments`), `:526` (`purge_enchantments`) — every one starts with `if target != self.guid { return false; }`. So remote-entity enchantments **arrive on the wire, then are explicitly discarded** in `holtburger-world` before they reach the wasm publisher.
  - `apps/holtburger-web/src/lib.rs:19400-19401` only exposes `playerEnchantments` (self). No `entityEnchantments(guid)` wasm export.
  - `plugins/buffs-hud.js` (820 LOC) reads only `handle.playerEnchantments()` (line 654, 672) and `client.character` (self). No per-entity / nameplate integration anywhere — confirmed by `grep "target_guid\|targetGuid"` (zero hits).
  - `scene3d/nameplate_sprite.js` exists but has no enchantment integration — confirmed by `grep "enchantment\|buff"` (zero hits).
- **Citation correction:** the brief references `OnMagic_DispelEnchantment 0x02C4`. Actual opcode at `crates/holtburger-protocol/src/opcodes.rs:654` is `MagicDispelEnchantment = 0x02C7`. `0x02C4` is `MagicUpdateMultipleEnchantments` (`opcodes.rs:644`). Both opcodes exist and are fully unpacked; the routing/discard happens further downstream in `holtburger-world`.
- **Recommendation:**
  - Keep the brief as-is on scope (the work is real and required).
  - Correct the opcode citation: `MagicDispelEnchantment 0x02C7` (the brief says 0x02C4).
  - Add a sub-task: lift the `target != self.guid` guard in `mutations.rs` AND/OR plumb a parallel `entity_enchantments_index: HashMap<u32, Vec<Enchantment>>` on `SessionHandle` (mirrors the `physics_script_table_index` pattern from CMT Wave 16). The latter is non-invasive; the former requires `WorldState` shape changes. Recommend the index pattern.
- **Effort delta:** M → M (unchanged). The work surface is correctly scoped; only citation polish needed.

---

### Wave 5.A — Tradeskill wire layer

**Verdict: PARTIAL — wire primitive `UseWithTarget` is in protocol+core; wasm export + recv handler missing; cited "GameActionDoTradeSkillAttempt.cs" does NOT exist in ACE**

- **Cited claim (brief):** "The `UseWithTarget` wire is live but our app has zero handler logic. ACE's `GameActionDoTradeSkillAttempt.cs` … is the entire missing layer."
- **Master HEAD state:**
  - `UseWithTargetActionData` exists with full pack/unpack: `crates/holtburger-protocol/src/messages/object/types.rs:516-537`. Test fixtures + parity at `:648`.
  - `GameAction::UseWithTarget` enum + dispatch: `crates/holtburger-protocol/src/messages/game_action.rs:85, 310-312, 714-718`.
  - `ClientCommand::UseWithTarget`: `crates/holtburger-core/src/client/types.rs:580`, sent at `commands.rs:436-450` via `send_game_action`.
  - CLI uses it: `apps/holtburger-cli/src/pages/game/domains/inventory.rs:158`.
  - **NO `useWithTarget` wasm export in `src/lib.rs`** — confirmed by `grep "useWithTarget\|use_with_target" src/lib.rs` (zero hits). Wasm side has `useObject` but not `useWithTarget`.
- **Brief citation error:**
  - **`GameActionDoTradeSkillAttempt.cs` DOES NOT EXIST.** Verified by `ls ~/ace-server/Source/ACE.Server/Network/GameAction/Actions/` (8 files matching `Trade|Skill`; none is `DoTradeSkillAttempt`). The real ACE flow is: `GameActionUseWithTarget.cs:15` → `session.Player.HandleActionUseWithTarget(...)` → `WorldObjects/Player_Use.cs:29` (which routes to `RecipeManager.cs`).
  - The actual ACE server module is `~/ace-server/Source/ACE.Server/Managers/RecipeManager.cs` (~1071 LOC).
- **Recommendation:**
  - **Pivot the brief's ACE citation:** strike "`GameActionDoTradeSkillAttempt.cs`" → replace with "`GameActionUseWithTarget.cs:15` → `Player_Use.cs:29` (HandleActionUseWithTarget) → `Managers/RecipeManager.cs`".
  - Real scope is small: one wasm export `useWithTarget(itemGuid, targetGuid)` mirroring `useObject` (`src/lib.rs:20633`); recv-loop already dispatches via `ClientCommand`. ACE responds with chat messages + `InventoryChange`/`UpdateObject` (those flow back through the existing handlers).
  - Wire fixture for `UseWithTarget` already exists at `crates/holtburger-protocol/src/messages/object/types.rs:648`. Just promote to the JS conformance harness.
- **Effort delta:** M (brief) → S (real). The brief over-scopes — most of the wire is shipped.

---

### Wave 5.B — Tradeskill data layer (CCraftTable DAT parser)

**Verdict: PIVOT — `CCraftTable` DAT type DOES NOT EXIST in ACE / retail. ACE uses DB-backed `Recipe` tables, not DAT.**

- **Cited claim (brief):** "port the `CCraftTable` DAT type if not already there. Refs: ACE.DatLoader `CraftTable.cs`; cross-check DRW dats.xml against retail bytes."
- **Master HEAD state:**
  - **NO `CraftTable.cs` exists in ACE.DatLoader** — confirmed by `find ~/ace-server -name "CraftTable*.cs"` (zero hits).
  - **NO `CraftTable.cs` / `CCraftTable.cs` exists in Chorizite vendored** — confirmed by `find external/chorizite -name "*Craft*"` (zero hits) and `find external/chorizite/ACBindings/Generated -name "*Craft*"` (zero hits).
  - **There is no DAT prefix for CraftTable.** `crates/holtburger-dat/src/file_type/mod.rs` enumerates all known DAT prefixes; 0x30 = CombatManeuverTable, 0x31 = LanguageString, 0x32 = ParticleEmitter, 0x33 = PhysicsScript, 0x34 = PhysicsScriptTable. **No CraftTable prefix.**
  - **ACE recipes are DATABASE-backed**, not DAT-backed. Models live at `~/ace-server/Source/ACE.Database/Models/World/Recipe*.cs` (RecipeModsInt, RecipeRequirementsBool, RecipeRequirementsString, RecipeRequirementsDID, RecipeModsIID, RecipeModsFloat, RecipeSQLWriter, RecipeRequirementsIID, etc. — ~10 model classes). The actual recipe data is loaded from MySQL/SQLite into in-memory `Recipe` objects and accessed through `~/ace-server/Source/ACE.Server/Managers/RecipeManager.cs`.
  - **A partial crafting module already exists in workspace:** `crates/holtburger-world/src/crafting/{mod.rs, salvage.rs}` (316 LOC of salvage logic). Other tradeskills (tinker/imbue/dye) are absent.
- **Recommendation:**
  - **Pivot or kill this brief.** There is no DAT to parse. The correct port path is either:
    - (a) Bundle the ACE recipe DB as a runtime asset (JSON dump from ACE's SQL) and have the client display the predicted outcome — purely informational, since the server is authoritative.
    - (b) Skip client-side recipe data entirely — let the ACE server be the recipe oracle (server sends success/failure + result back through existing chat + InventoryChange opcodes which 5.A's `useWithTarget` already exercises).
  - Recommended pivot: **skip 5.B as written; replace with a server-driven flow** using existing chat + inventory event paths. The agent's effort would otherwise go toward building a non-existent parser.
- **Effort delta:** M (brief) → 0 (skip) OR S (JSON dump from ACE recipe SQL). Eliminates ~1 week of misdirected work.

---

### Wave 5.C — Tradeskill UI

**Verdict: STILL OPEN — but downstream of 5.A; brief citations need correction**

- **Cited claim (brief):** "new `plugins/tradeskill.js` … invocation surface (use-item-on-item drag-drop in inventory; or a NPC-triggered tradeskill panel)."
- **Master HEAD state:**
  - **`plugins/trade-panel.js` EXISTS** but it is **player-to-player TRADE** (peer-to-peer item exchange via `openTrade/addToTrade/acceptTrade` — `src/lib.rs:21218-21290`), NOT tradeskill. Confirmed by reading `plugins/trade-panel.js:1-23` ("floating peer-to-peer trade window"). Naming collision risk: a `plugins/tradeskill.js` is the right name; brief is correct.
  - No tradeskill-related UI exists anywhere; `grep -ri "tradeskill" plugins/` returns zero.
  - Drag-drop precedent in `plugins/inventory.js:734` (mime `application/x-hb-inv-guid`) IS confirmed and usable.
- **Brief citation error:**
  - **`external/chorizite/ACBindings/Generated/UI/Elements/gmCraftRecipeUI.cs` DOES NOT EXIST.** Confirmed by `find external/chorizite/ACBindings/Generated -name "gm*Craft*"` (zero hits). No `gmCraftRecipeUI` in the 93 `gm*UI.cs` element files. Retail's UI for tradeskills was the existing **examine + UseWithTarget popup confirmation** flow, not a dedicated panel. The brief's reference is fabricated.
- **Recommendation:**
  - **Strike the `gmCraftRecipeUI.cs` reference**. There is no retail UI to port. The agent should:
    1. Build a minimal confirmation popup that appears after `useWithTarget` is fired (await ACE's response chat message).
    2. Surface success/failure visually (chat overlay + animation on the affected inventory item).
  - Or **defer 5.C entirely** until 5.A's wasm export + ACE round-trip is demonstrably working. The "UI" may be as small as a toast in the existing chat-panel.
- **Effort delta:** S (brief) → XS (real). Most of the surface is "let the existing chat + inventory plugins display the result."

---

### Wave 7.A — Real templates Launch/Splatter/Spark

**Verdict: PIVOT — the placeholder count was already corrected by Wave 2.C; the 124-IDs claim is stale. Real gap: 23 ambient-state IDs no retail table contains; 4 sentinels; everything else already resolves via `_tryResolveRealVfx` when the entity has a table.**

- **Cited claim (brief):** "124 remaining PlayScript IDs still hit the placeholder branch. Port each to a `ParticleManager` emitter template … highest-traffic combat IDs."
- **Master HEAD state:**
  - **The 124-placeholder count is wrong.** Wave 2.C / Phase 55 (commit `a8bcea72` on 2026-05-28) corrected this to **27** (4 sentinels + 23 ambient-state IDs). See `data/playscript-canonical-physics-scripts.json:1-8`:
    - `_unique_scripts_total: 2015`
    - `_canonical_mappings: 147` (PScript IDs with a retail-table mapping)
    - `_absent_play_script_ids` lists exactly **27 entries**: 4 sentinels (Invalid/Test1-3), PortalEntry/Exit (2), SpecialState1-10 (10) + SpecialStateRed/Orange/.../Black (8), EnchantUpGrey/DownGrey (2), WeddingSteele (1).
  - **The real-VFX resolver already chains through to spawned emitters** for the 147 mapped IDs (when the entity carries a `physicsScriptTableDid`). See `scene3d/play_effect_vfx.js:1258-1278` (`_onPlayEffect`): if `getPhysicsScriptTableDid(targetGuid) != 0`, the real chain runs; placeholder is the fallback.
  - **Placeholder coverage is now 170 of 174** PlayScript enum entries (only the 4 sentinels are unhandled). See `play_effect_vfx.js:2146-2148` ("shipped=170 (Launch + Explode + 48 from Phase 37 + 51 from Phase 47 + 69 from Phase 54)"). The placeholder PATH gets used when:
    - The entity has no PhysicsScriptTable DID (`missNoTable` counter), OR
    - The entity has a table but that table has no entry for this script ID (`missNoScriptId` — happens for the 27 unmapped IDs above).
  - **The "real template" work the brief envisioned doesn't have a target** — there's no body of PlayScript IDs that lack both a retail table mapping AND a placeholder. Where the brief wants to add `ParticleEmitterInfo` POJOs derived from `CreateParticle` hooks, the existing `_tryResolveRealVfx` already does exactly that: `fetchPhysicsScriptTable(did)` → `pickScriptEntry(entries, speed)` → `fetchPhysicsScript(scriptDid)` → for each `CreateParticle`, `fetchParticleEmitter(emitterId)` → `wm.addEmitter(...)`. The chain is shipped at lines 940-1214.
- **What's actually still open (the real gap):**
  - The 27 IDs in `_absent_play_script_ids` will NEVER resolve through the real chain (no retail table contains them). The placeholders are the only visual; this is by design.
  - The visibility limiter is **per-entity table population** (7.C's framing).
  - But even that is mostly shipped — see 7.C verdict below.
- **Recommendation:**
  - **Strike Waves 7.A and 7.B entirely.** Their framing is based on the pre-Wave-2.C 124-placeholder count which is now provably wrong.
  - Replace with a follow-on that hardens the 27-ID placeholder set (e.g. confirm each placeholder is visually distinguishable; add lockdown assertions). This is far smaller scope than the wave envisioned.
- **Effort delta:** M (brief) → 0 (skip 7.A/B).

---

### Wave 7.B — Real templates Explode/Health/Shield/Enchant

**Verdict: PIVOT / CLOSED — same conclusion as 7.A.**

- **Cited claim:** "Explode (0x05, 70 unique scripts) + Health/Shield/Enchant."
- **Master HEAD state:** Same as 7.A — the placeholder + real-chain split is already comprehensive. All of Explode/Health/Shield/Enchant placeholders are shipped (see `_HEALTH_UP_IDS`, `_HEALTH_DOWN_IDS`, `_SHIELD_IDS`, `_ENCHANT_UP_IDS`, `_ENCHANT_DOWN_IDS` in the `_COVERAGE_FAMILIES` table at `play_effect_vfx.js:2152-2196`). When entities carry a `physicsScriptTableDid`, the real chain resolves to actual emitters.
- **Recommendation:** **Strike Wave 7.B.** Roll into the 7.A note about hardening placeholders if it's even needed.
- **Effort delta:** M (brief) → 0 (skip).

---

### Wave 7.C — physicsScriptTableDid per-entity population

**Verdict: CLOSED — already comprehensively populated for every entity via `apply_inventory_object_create` and refreshed on `UpdateObject`.**

- **Cited claim (brief):** "most entities lack `physicsScriptTableDid` so the real-VFX resolver never even attempts. Audit `scene3d/entities.js` to find where the field is populated and extend coverage to all entity classes that should have a table."
- **Master HEAD state:**
  - **Population happens on the wasm side, NOT in `scene3d/entities.js`.** The brief misidentifies the layer.
  - `apps/holtburger-web/src/lib.rs:17436-17484` — `resolve_physics_script_table_did(entity)` implements the full retail two-source chain:
    1. `PhysicsDesc.PhsTableID` (runtime override, `petable_id` field, populated by `description.rs:960-966` hydration).
    2. Falls back to `Setup.default_phstable_id` (sync DAT read from `client_portal.dat` via `ResourceKey::new("eor/portal", setup_id)`).
  - **Called on EVERY ObjectCreate** at `src/lib.rs:17535-17541` (inside `apply_inventory_object_create`), storing into both `entity.physics_script_table_did` and the shared `physics_script_table_index: HashMap<u32, u32>`.
  - **Refreshed on EVERY UpdateObject** at `src/lib.rs:24749-24762` — re-resolves and updates the index when the DID changes.
  - **JS accessor at** `scene3d/entities.js:2480-2490` (`getPhysicsScriptTableDid(guid)`) just forwards to the wasm getter `entityPhysicsScriptTableDid`. No per-class extraction logic to extend.
  - **The brief's premise is wrong** — entities without DIDs lack one because their retail Setup truly has no `default_phstable_id` (e.g. inert scenery, walls). That's the correct retail behavior per `acclient.c:320335-320343` (CPhysicsObj::play_script no-ops when table is null).
- **Recommendation:**
  - **Strike Wave 7.C.** The work is comprehensively shipped.
  - If there's ever doubt, add a diag counter for "entities-without-table that should-have-table" — but the population logic itself is closed.
- **Effort delta:** S-M (brief) → 0 (skip).

---

## Summary table

| Wave | Original brief | Verdict | Effort delta |
|---|---|---|---|
| 4.A | Train Skills UI — wasm + plugin | PARTIAL | S–M → S (protocol+core layer shipped; brief overstates remaining scope) |
| 4.B | Remote-entity buff/debuff | STILL OPEN | M → M (citation correction: opcode is 0x02C7 not 0x02C4) |
| 5.A | Tradeskill wire layer | PARTIAL | M → S (wire is mostly shipped; just needs wasm export of useWithTarget) |
| 5.B | Tradeskill data (CCraftTable parser) | PIVOT | M → 0 (no such DAT type; ACE uses DB recipes) |
| 5.C | Tradeskill UI | STILL OPEN | S → XS (no retail UI to port; just toast on success/failure) |
| 7.A | Launch/Splatter/Spark templates | PIVOT / CLOSED | M → 0 (Wave 2.C corrected 124→27; remaining 27 are unmapppable by design) |
| 7.B | Explode/Health/Shield/Enchant templates | PIVOT / CLOSED | M → 0 (same conclusion as 7.A) |
| 7.C | physicsScriptTableDid per-entity population | CLOSED | S-M → 0 (already comprehensive — both `ObjectCreate` + `UpdateObject` refresh) |

**Totals:** 8 tasks audited → 1 STILL OPEN (4.B), 2 PARTIAL (4.A + 5.A — both reduced), 1 STILL OPEN with XS scope (5.C), 4 PIVOT/CLOSED (5.B + 7.A + 7.B + 7.C).

**Audit-staleness scale:** **5 of 8** Wave-4/5/7 tasks are CLOSED or have significantly-reduced scope — a higher staleness rate than the Wave 1+2 audit (4 of 9). The post-J4 audit doc is now demonstrably **>1 week stale** and continuing to spawn agents from it wastes compute.

---

## Recommended brief corrections

### Wave 4.A
- **Replace** `gmTrainSkillsUI.cs` citation → `external/chorizite/ACBindings/Generated/UI/Elements/gmSkillUI.cs` (288 LOC; contains `TrainSkill`, `RaiseSelectedSkill`, `TrainSkillDialogCallback`, `DisplaySelectionFooter_Untrained`, `ExperiencePointsToRaiseSkillTenLevels`).
- **Reduce scope:** strike "new C2S opcode if missing" — they exist. Strike `crates/holtburger-protocol/src/messages/` — no protocol changes needed. Agent only needs (a) two `#[wasm_bindgen]` exports, (b) `plugins/train-skills.js`, (c) one fixture promoted into the JS conformance harness.

### Wave 4.B
- **Correct opcode citation:** `MagicDispelEnchantment 0x02C7` (not 0x02C4). 0x02C4 is `MagicUpdateMultipleEnchantments`.
- **Add sub-task** on the holtburger-world side: lift the `if target != self.guid` guard or (preferred) plumb an `entity_enchantments_index` per the `physics_script_table_index` pattern.

### Wave 5.A
- **Strike** the `GameActionDoTradeSkillAttempt.cs` citation — the file does not exist in ACE.
- **Replace** with: `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionUseWithTarget.cs:15` → `WorldObjects/Player_Use.cs:29` → `Managers/RecipeManager.cs` (~1071 LOC, all crafting logic).
- **Reduce scope** to: one wasm export `useWithTarget(itemGuid, targetGuid)` modeled on `useObject` (`src/lib.rs:20633`).

### Wave 5.B
- **Skip entirely.** No DAT parser to write. Either bundle ACE's recipe SQL as a JSON dump, or let server be the recipe oracle (recommended: skip).

### Wave 5.C
- **Strike** the `gmCraftRecipeUI.cs` citation — file does not exist in ACBindings (no retail tradeskill panel UI; retail used examine + UseWithTarget popup).
- **Reduce scope** to a minimal success/failure toast that listens to ACE's existing chat-message + InventoryChange responses.

### Wave 7.A / 7.B
- **Skip both.** The 124-placeholder claim was corrected by Wave 2.C (commit `a8bcea72`) to 27 (all by-design unmappable). The placeholder coverage is at 170/174 enum entries. Real-VFX chain already resolves the 147 mapped IDs end-to-end.

### Wave 7.C
- **Skip.** Population is comprehensive — both `ObjectCreate` (`src/lib.rs:17535`) and `UpdateObject` (`src/lib.rs:24749`) paths refresh `physics_script_table_index`. Entities without a DID truly lack one in retail.

---

## Net wave plan after refresh

| Wave | Agents after refresh | Real surface |
|---|---|---|
| 4 | 2 (4.A reduced, 4.B as-is) | Train Skills wasm + plugin (4.A); remote-entity buff dispatch (4.B) |
| 5 | 1 (just 5.A reduced + 5.C as XS) | useWithTarget wasm export + minimal success toast |
| 7 | 0 — all closed | n/a |

**Cleanup savings:** ~1-2 weeks of orchestrator + agent time saved by closing 5.B + 7.A + 7.B + 7.C.

**Highest-value follow-ons:** the unfilled gap surfaced by this audit is **enchantment-on-remote-entity dispatch** (Wave 4.B) — without it, raid healers can't see if their group's buffs landed, and PvP players can't tell if their debuffs stuck. That's the only audit task with full STILL-OPEN status at original scope.

---

## Audit method gaps

- Did NOT exercise the live wasm build (would catch d.ts surface drift that grep misses).
- Did NOT check ACE-server commit log for newer recipe/skill mechanics changes that might affect the wire shape.
- Did NOT verify that the existing `UseWithTarget` ClientCommand path actually receives an ACE response on a live tradeskill attempt — only verified the send-side wiring.

These gaps are acceptable for a 1-agent scope-refresh pass; the recommended pivots stand even under stricter validation.
