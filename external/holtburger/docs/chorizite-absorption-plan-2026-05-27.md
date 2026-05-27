# Chorizite absorption plan — improve holtburger-web 3D render

**Audience:** team agents planning + executing PRs against `external/holtburger/apps/holtburger-web/` and adjacent crates.

**Goal:** systematically absorb high-ROI assets from `/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/` (Tier 1-5 vendored, 23-repo C# AC plugin ecosystem) to improve retail parity, fix protocol gaps, and unlock deferred features.

**Source-of-truth dependency:** `external/chorizite/` is read-mostly reference. We port to Rust (`crates/holtburger-*`) or JS (`apps/holtburger-web/`), we don't depend on it at runtime.

---

## What's already absorbed (don't redo)

| Asset | Used in |
|---|---|
| `ACBindings/Generated/UI/Elements/gmPaperDollUI.cs` | Wave 12 + Wave 16 inventory panel |
| `ACBindings/Generated/Net/Types/MotionData.cs` | Wave 7.3 blend-hint audit (negative finding) |
| `ACBindings/Generated/Net/Types/ClothingTable.cs` | Wave 7.2 ClothingTable reader |
| `Chorizite.Common/Enums/{EquipMask, MotionCommand, ItemType}.cs` | Multiple — Wave 8 motion classifier, Wave 12 paperdoll, Wave 13 inventory |
| `Chorizite.ACProtocol/` wire format types | Wave 1.A0 dep-graph spike, Wave 1 wire-conformance fixtures |
| `Chorizite/Chorizite.NativeClientBootstrapper/AcClient/UIElementId.cs` | Wave 12 + Wave 16 paperdoll element-id symbolic names |

Established convention via `feedback_use_existing_dat_tools.md`: before writing custom extraction code, survey WB.Terminal + DatReaderWriter + Chorizite ACBindings + crates/holtburger-dat/examples.

---

## Wave priorities (ordered by ROI)

### Wave A — READING_GUIDE absorption (read-only, ~1 hour, BLOCKING for other waves)

The Chorizite team wrote five `READING_GUIDE.md` files across the vendored tiers. These are **load-bearing required reading** because they document:
- Per-file coverage maps (what we should/shouldn't port)
- Integration gotchas (upstream bugs, vitae semantics, tiebreak precedence)
- Pre-flagged native-only vs portable code
- PR sketches with line numbers for missing items

**Files to read:**
- `external/chorizite/Chorizite.ACProtocol/READING_GUIDE.md` (~1500 LOC) — XML schema, opcode taxonomy, S2C/C2S parity matrix. **Identifies 12 S2C + 1 C2S messages missing from holtburger-protocol.**
- `external/chorizite/ACPlugin/READING_GUIDE.md` (~2400 LOC) — per-file coverage, integration gotchas (Lifestone dispatch bug, `SkillFormula.HasAttribute2` upstream bug, vitae semantics), port plan with line numbers
- `external/chorizite/Chorizite.Common/READING_GUIDE.md` (~900 LOC) — **identifies 18 missing enums** in workspace + PR sketch to fill 5 critical ones (see Wave B)
- `external/chorizite/ACBindings/READING_GUIDE.md` — symbol bindings walkthrough, Hex-Rays decomp quality notes
- `external/chorizite/Chorizite/READING_GUIDE.md` (if present) — plugin-host architecture (not portable but informs S2C/C2S taxonomy)

**Deliverable:** one consolidated handoff doc at `external/holtburger/docs/chorizite-reading-guide-summary-YYYY-MM-DD.md` that:
- Quotes the most load-bearing findings verbatim (with citations)
- Indexes the "PR sketches" each READING_GUIDE provides
- Flags upstream bugs the Chorizite team has documented

**Exit gate:** any subsequent wave references this summary doc instead of grep-spelunking the READING_GUIDEs from scratch.

---

### Wave B — Missing Chorizite.Common enums (small, fast, multi-wave-unblocking, ~2 hours)

**Source:** `external/chorizite/Chorizite.Common/Enums/` (per Wave A's READING_GUIDE.md §5).

**5 critical enums missing from `crates/holtburger-common/`:**

1. **`ObjectClass`** — unlocks typed WorldObject subclass dispatch (currently we use generic Entity for everything). Drives equipment slot logic, NPC categorization, container vs item distinction. ~30 LOC.
2. **`SpellType`** — spell categorization (war/life/item/creature/void + heritage). Unlocks Phase G+ spellbook filters. ~10 LOC.
3. **`SpellFlags`** — `SelfTargeted`, `NotTargeted`, `Stickly`, etc. Used by `Chorizite.Common.SpellComponent` decisions. ~15 LOC.
4. **`SpellComponentType`** — component category (scarab/herb/talisman/etc.). For the spell research UI. ~10 LOC.
5. **`SpellBookFilterOptions`** — spell-school filter bitmask. For Phase H spellbook filter UI. ~10 LOC.

**Per enum:**
- Add to `crates/holtburger-common/src/enums/` (or wherever `EquipMask`/`MotionCommand` live)
- Add `Display`/`FromPrimitive`/`TryFrom<u32>` impls following the existing pattern
- Add unit test asserting bit values match `Chorizite.Common/Enums/<Name>.cs` line-by-line
- Cite the Chorizite source file line in the doc-comment

**Validation:** `cargo test -p holtburger-common --lib` PASS with 5 new tests.

**Unlocks:** subsequent waves can rely on these enums (especially `ObjectClass` for Wave C+).

---

### Wave C — ACPlugin Character/Skill/Vital/Attribute math port (medium, ~1 day, retail-parity-load-bearing)

**Source:** `external/chorizite/ACPlugin/API/Character.cs` (~820 LOC) + `SkillInfo.cs` + `VitalInfo.cs` + `AttributeInfo.cs`.

These files contain byte-for-byte retail game math:
- Skill multiplier tables
- Attribute derivation formulas (Strength → Coordination → etc. dependencies)
- Vital max calculations (Health/Stamina/Mana from attributes + level)
- Vitae cost/recovery formulas (death penalty math)
- Skill rank → skill-credits conversion
- Trained vs Specialized differentials

**Why it matters for 3D render:** these formulas drive:
- Vitals HUD bar fill ratios (we have wire data but compute display values approximately)
- Spell-cast manacost preview tooltips (Wave 4.x established the surface; math is approximation)
- Combat damage preview / DR HUD (need byte-correct skill formulas to match server)
- Charge attack power scaling (Wave 4.2 hold-at-peak; max power depends on skill formula)

**Port targets** (mirror existing `crates/holtburger-core/src/client/` layout):
- `crates/holtburger-core/src/client/character_info.rs` ← Character.cs
- `crates/holtburger-core/src/client/skill_info.rs` ← SkillInfo.cs
- `crates/holtburger-core/src/client/vital_info.rs` ← VitalInfo.cs
- `crates/holtburger-core/src/client/attribute_info.rs` ← AttributeInfo.cs

**Integration gotchas (from Wave A's ACPlugin READING_GUIDE.md):**
- `SkillFormula.HasAttribute2` is an upstream bug — Chorizite documents the workaround
- Vitae semantics: vitae stacks vs single-instance differs from naive percent math
- Tiebreak precedence in trained-vs-specialized skill credits

**Validation:**
- Per-formula unit tests with retail reference values (Chorizite tests provide oracles)
- `cargo test -p holtburger-core --lib` passes with 30+ new tests
- Vitals HUD bar fill ratios match server-broadcast values to ≤0.5% drift over N=1000 random states

**Wire integration:** existing `apply_self_update_motion` path + `Player_Inventory` snapshot already carry the input data; this wave adds the math layer.

---

### Wave D — gmInventoryUI + gmCharacterCreationUI port (medium, ~1-2 days per panel)

**Source:** `external/chorizite/ACBindings/Generated/UI/Elements/gmInventoryUI.cs` + `gmCharacterCreationUI.cs` + `gmCGHeritagePage.cs` + `gmCGSkillsPage.cs` + `gmCGSummaryPage.cs`.

Same Hex-Rays-C# → JS-render port pattern Wave 12 + 14 + 16 used for gmPaperDollUI. The class files declare:
- Child element pointers (every clickable region)
- Layout DIDs (where to read positioning from portal.dat)
- Per-element default state (visible/dim/hidden)

**Wave D.1 — gmInventoryUI completeness pass**

We've done a lot of inventory panel work already. Run a focused diff against `gmInventoryUI.cs`:
- Audit every `UIElement_*` field — do we render it?
- Check the InitPanel / PostInit method for layout DIDs we missed
- Particular gaps: `m_burdenButton` (the "Slots" toggle button we noticed in `User-Interface-10.webp`), squelch/options shortcuts, drag-to-3D-character semantics

**Validation:** walk every gmInventoryUI field with a "rendered? Y/N" column. Any "N" gets a one-line follow-up issue. Estimated 5-15 unrendered items.

**Wave D.2 — gmCharacterCreationUI (deferred until character creation needed)**

Three-page wizard for heritage/skills/summary. Each page is its own gm class. ~400 LOC per page port. Defer until we want to support new-character creation (currently we autospawn into existing characters).

---

### Wave E — Wire-format gaps (medium, ~3-5 days)

**Source:** `external/chorizite/Chorizite.ACProtocol/protocol.xml` (~8500 LOC — the human-readable XSD that GENERATES all 600+ `.cs` wire-type files).

Per Wave A's READING_GUIDE.md §S2C/C2S Parity, Chorizite parses 600+ wire messages; we parse ~45. The READING_GUIDE pre-identifies **12 S2C + 1 C2S messages missing from our protocol crate**.

**Use Wave A's summary doc to drive Wave E:**
1. Identify the 13 specific missing opcodes
2. Categorize by impact:
   - **Critical** (player can't see their state): allegiance updates, vendor stock changes, mid-fight stat updates
   - **Important** (features partially work): contract tracker, emote table, enchantment registry overlays
   - **Optional** (deferred features): DAT patch download (skip per existing convention)
3. Port the critical + important set to `crates/holtburger-protocol/src/messages/`

**Pattern:** every new message needs:
- Pack/unpack in protocol crate (matching ACProtocol's `.cs` generated file structure)
- Routing in `apps/holtburger-web/src/lib.rs` recv loop
- Renderer consumption (entity manager / HUD update / plugin event)
- Fixture in `apps/holtburger-web/validate_wire_conformance.cjs`

**Validation:** wire-conformance count rises from 31 → 40+. Each new fixture is byte-for-byte pack/unpack round-trip.

---

### Wave F — High-value DAT type readers (medium-large, ~1 week)

**Source:** `external/chorizite/ACBindings/Generated/Net/Types/`. 182 wire-protocol structs. We have parsers for ~12.

**Priority types to port** (per Wave A's READING_GUIDE.md priorities):

1. **`CSpellBase.cs`** — full spell record (casting cost formula, school, range, components). Replaces our LSD-derived `spells-catalog.json` with byte-correct ACE-driven data. Unlocks Phase H+ spellbook features.

2. **`CEnchantmentRegistry.cs`** — overlay spell definitions. When a Strength I buff is on the player, this is the runtime registry showing the +10 STR overlay. Unlocks proper buff-bar (we have stub `buffs-hud.js`).

3. **`CAllegianceProfile.cs` + `AllegianceHierarchy.cs`** — allegiance member trees, monarchy chain, allegiance chat permissions. Unlocks F8 allegiance panel UI.

4. **`VendorProfile.cs`** — full vendor roster + buyback price formula. Wave 7 shipped a buy/sell wire primitive; this completes the vendor stock display.

5. **`CContractTracker.cs`** — active quests + objectives. Unlocks F7 contracts panel.

6. **`CEmoteTable.cs`** — emote definitions (Wave 9 used the soul-emote catalog from ChatPoseTable; this is the broader emote table including animation hooks).

**Per type:** new parser in `crates/holtburger-dat/src/file_type/<name>.rs` + parser-parity test against retail portal.dat + `HOLTBURGER_PORTAL_DAT` env. Pattern matches existing parsers.

**Validation:** parser tests against actual retail DAT bytes pass byte-for-byte.

---

### Wave G — Optional polish (low priority, defer)

**Source:** scattered across `external/chorizite/`.

- **`Chorizite.Common/` smaller enums** beyond Wave B's 5 (13 more flagged in READING_GUIDE — most are niche)
- **`ACPlugin/API/World.cs`** beyond what's already in our reference (820 LOC; some methods cover features we haven't built)
- **`DatReaderWriter.Extensions/`** — inspiration for admin tooling (title management, texture upload). Not directly portable but useful concepts.

---

## What NOT to port (skip)

- **`Chorizite.Launcher`** — Windows native; DLL injection; inapplicable to web
- **`Chorizite.NativeClientBootstrapper/`** — same
- **`Chorizite.Injector/`** (not vendored per existing VENDORED.md decision)
- **`RmlUiPlugin/`** + `assets/panels/*.rml` — C++ HTML renderer; we use real DOM
- **`DDD_*` wire messages (0xF7E3+)** — runtime DAT patch download; we don't support live DAT updates
- **`StandaloneLoader.cs` / `ACChoriziteBackend.cs`** — DLL injection bootstrapping

---

## Cross-cutting conventions for all waves

- **Cite Chorizite source file:line in doc-comments** when porting (so future audits can verify). Example:
  ```rust
  /// Maps a skill rank to its skill-credit cost.
  ///
  /// Ported from chorizite ACPlugin/API/SkillInfo.cs:142-178
  /// (Chorizite team flagged HasAttribute2 upstream bug; see
  /// READING_GUIDE.md §Skill Formulas for workaround.)
  pub fn skill_credit_cost(rank: u32) -> u32 { ... }
  ```

- **Add `chorizite` to validation harnesses** so we catch upstream drift. Wave 1 wire-conformance + parser-parity tests are the templates.

- **Don't import Chorizite as a runtime dependency.** Port and own. Chorizite's docs and source are reference; we maintain our copy.

- **Validate against retail portal.dat** when parsers are involved. Use `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat cargo test -p holtburger-dat`.

- **Coordinate with READING_GUIDE.md gotchas.** Every wave that touches an area should reference the corresponding READING_GUIDE's gotcha section.

- **Disk pressure** — scratch logs to `/mnt/wbterminal1/tmp/claude-scratch/chorizite-waves/`.

---

## Estimated wave sizes

| Wave | Phases | Surface | Risk | Estimated time |
|---|---|---|---|---|
| A | READING_GUIDE absorption | docs only | Low | 1-2 hours |
| B | 5 missing enums | crates/holtburger-common | Low | 2 hours |
| C | Character/Skill/Vital/Attribute math | crates/holtburger-core | Medium | 1 day |
| D.1 | gmInventoryUI completeness | apps/holtburger-web/plugins/inventory.js | Low-Med | 1 day |
| D.2 | gmCharacterCreationUI | new plugin | Medium | 2 days (deferred) |
| E | Wire-format gaps (13 messages) | crates/holtburger-protocol + apps/holtburger-web/src/lib.rs | Med-High | 3-5 days |
| F | DAT type readers (6 types) | crates/holtburger-dat + apps/holtburger-web | Medium | 1 week |
| G | Optional polish | various | Low | open-ended |

**Total estimated effort for Waves A-F:** ~2-3 weeks of focused work.

---

## Key citations (for fast reference)

- Vendored manifest: `external/chorizite/VENDORED.md`
- 5 READING_GUIDEs: `external/chorizite/{Chorizite.ACProtocol,ACPlugin,Chorizite.Common,ACBindings,Chorizite}/READING_GUIDE.md`
- Wire schema source-of-truth: `external/chorizite/Chorizite.ACProtocol/protocol.xml`
- UI symbolic names: `external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/AcClient/UIElementId.cs:205-625`
- Existing port baseline: this session's commits `421f82f2` through `2a9a1c0d` for movement+inventory pattern
- Existing convention: `~/.claude/projects/-home-wbterminal/memory/feedback_use_existing_dat_tools.md`

---

## Recommended start

**Wave A first** (read-only, blocks nothing). Then split:
- **Wave B + Wave D.1 in parallel** (low risk, different code surfaces)
- **Wave C** sequentially (Character/Skill math is load-bearing for many features)
- **Wave E** after Wave A's summary doc identifies the 13 specific opcodes
- **Wave F** as a 1-week dedicated effort once Wave A-E land
