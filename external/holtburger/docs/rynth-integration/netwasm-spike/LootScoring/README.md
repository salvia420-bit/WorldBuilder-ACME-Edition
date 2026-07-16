# LootScoring — third .NET-wasm lift slice (2026-07-16)

Follow-up to the BuffScoring slice (`../BuffScoring/README.md`, whose
"Recommended NEXT lift slice" section specifies this one): **loot
rule-evaluation** — the pure item-classification core of RynthAi
(`Loot/VTankLootEvaluator.cs` all 31 VTank node types + the native SDK
`Loot/LootEvaluator.cs`, composed exactly as
`CorpseOpenController.ClassifyItemAgainstProfile` does), extracted as a pure
C# slice with host dependencies replaced by a wide item-property-bag DTO,
compiled to browser wasm, and parity-tested against the shipped JS loot brain
(`apps/holtburger-web/rynth/loot_loop.js`). No clock, no state machine —
single-call fixtures like CombatScoring's.

## Layout

| File | What |
|---|---|
| `LootScoring.cs` (743 L) | The pure lift. One classification = `Evaluate(LootInput) -> LootOutput` (verdict keep/salvage/no-loot + matched rule + per-rule reasons trace); single JSON boundary `EvaluateLootJson` (source-gen'd `System.Text.Json`, `IncludeFields=true` — the DTOs are fields). Every block cites its `Loot/VTankLootEvaluator.cs`, `Loot/LootEvaluator.cs`, `CorpseOpenController.cs`, `Meta/RegexCache.cs`, or `Combat/AcStubs.cs` source lines. Host property lookups are replaced by int/double/string/bool/dataId bags keyed by SType property id, plus name/objectClass/spells/palettes and a character context (level, pack slots, skills). |
| `wasm/` | `[JSExport]` surface (`evaluateLoot(json) -> json`, `version()` = `loot-scoring-netwasm-1`) + browser-wasm csproj. |
| `fixtures/` | Console runner: 94 deterministic scenarios (seed 54321) → `fixtures.json` with C#-computed expectations. Runs through the SAME JSON boundary the wasm export uses. (The 40–80 aim was deliberately exceeded to cover every node type of BOTH evaluators plus the cross-evaluator quirk-pairs.) |
| `fixtures.json` | Committed fixture corpus (inputs + expected C# outputs + per-scenario `jsMap` telling the parity harness how/whether the profile maps onto the JS model). Byte-identical across regenerations (verified with `cmp`). |
| `parity_check.cjs` | Replays fixture inputs against the real `loot_loop.js` LOOT-state decision path (mock RynthWebHost mirroring `webhost.js` contracts — `_live()` undefined-on-miss, `host.s.moveItem` seam — under a frozen `Date.now`) and classifies agree / DIVERGE per scenario, splitting divergences into expected-by-design (JS subset) vs genuine. |
| `run_wasm.mjs` | Loads the published AppBundle in Node and replays ALL fixtures through wasm — proves mono-wasm reproduces native C# (94/94, exact deep equality — the outputs carry no floats). |

## Reproduce

```sh
# fixtures (any net10 SDK)
dotnet build fixtures/LootScoring.Fixtures.csproj -c Release --artifacts-path /tmp/ls-art
dotnet /tmp/ls-art/bin/LootScoring.Fixtures/release/LootScoring.Fixtures.dll fixtures.json

# JS parity (node >= 20)
node parity_check.cjs

# wasm build (needs `dotnet workload install wasm-tools`) + wasm-vs-native parity
dotnet publish wasm/LootScoring.Wasm.csproj -c Release --artifacts-path /tmp/ls-art
node run_wasm.mjs /tmp/ls-art/bin/LootScoring.Wasm/release_browser-wasm/AppBundle
```

Verified on wbterminal (the 8 GB laptop, dotnet SDK 10.0.203) 2026-07-16:
fixtures deterministic (byte-identical rerun, `cmp` clean), `NETWASM PARITY:
94/94 scenarios match native C#`. Bundle: 8.9 MB raw / ~3.0 MB gzip
(dotnet.native.wasm 2.9 MB, CoreLib 1.3 MB, System.Text.Json 215 KB, the
slice itself `LootScoring.Wasm.wasm` **82 KB**). Same ICU-dead-weight caveat
as the siblings (`InvariantGlobalization` would drop ~2.6 MB — do NOT enable
it casually here: the lifted parsers are already pinned to
`CultureInfo.InvariantCulture` but the regex paths use `IgnoreCase`, whose
non-invariant casing tables are part of the retail-faithful semantics).

## Parity results (2026-07-16, wbterminal): 65 agree, 28 diverge (all expected-by-design), 1 C#-error-path

The JS loot loop's ENTIRE rule model is one min-value gate —
`(TryGetObjectIntProperty(item, 19) ?? 0) >= minValue` (`loot_loop.js:163-164`)
— so the parity plane is **pickup vs skip**. All 10 scenarios whose profile IS
expressible in that model (`jsMap.mappable`) agree, including the boundary
(`value == minValue` kept on both sides: C# `>=`, JS skip-test `value <
minValue`) and the missing-property case (C# `Values(19,0)` default 0, JS
`?? 0` — same fail-closed direction). 3 of the 65 agreements are
"agree-pickup" only: C# says *salvage*, JS picks the item up with no salvage
plane to put it on. **Zero genuine divergences inside the shared domain** —
the JS gate is a faithful (tiny) subset.

### What JS lacks (measured, per scenario — the C#-only predicate surface)

`loot_loop.js` has no rule list at all, so everything below exists only in C#:

- **All VTank node types except a Value floor**: SpellNameMatch/SpellMatch/
  SpellCountGE (spell planes), StringValueMatch (regex on string props),
  LongValKey LE/E/NE/FlagExists on arbitrary keys, DoubleValKey LE/GE,
  MinDamageGE/BuffedMedianDamageGE/BuffedMissileDamageGE/
  CalcdBuffedTinkedDamageGE (damage math), TotalRatingsGE, ObjectClass,
  SlotExactPalette + the three optimistic color nodes, the five Character*
  context gates, DisabledRule, and the two hardwired-false nodes
  (DamagePercentGE, CalcedBuffedTinkedTargetMeleeGE).
- **Action planes**: no salvage/sell/read/keep-up-to — every JS decision is
  binary pickup (`salvage-verdict-vs-pickup`, `keepupto-count-not-enforced`).
- **Rule structure**: no multi-rule first-match ordering, no per-rule enable,
  no AND-composition (`first-match-order`, `disabled-rule-skipped`,
  `multi-condition-and-one-fails`).
- **Character context**: no skills/level/pack-slots inputs at all.

28/28 divergences fall in these planes; the per-gap breakdown is printed by
`parity_check.cjs`.

### Genuine findings (not previously documented anywhere)

1. **JS has no appraisal gate — late-appraising items are permanently
   skipped.** `loot_loop.js:163` reads Value(19) the instant the corpse
   enumerates and `items.shift()` (`:162`) removes the item from the work
   list either way — one evaluation, ever. The C# controller explicitly
   requests appraisal and holds classification inside an assess window
   because "numeric/spell conditions require appraisal data ... before that,
   item.Values(...) lacks appraisal" (`CorpseOpenController.cs:915-997`,
   `ItemNeedsAppraisalForLoot`). webhost.js EXPOSES the needed contract
   (`HasAppraisalData`, `webhost.js:405-407`; `GetLastIdTime` `:408-410`) —
   loot_loop just never calls it. With `minValue > 0`, an item whose Value
   streams in 200 ms after ViewContents is silently left on the corpse.
   Fixture `value-missing-prop` pins the (agreeing) instantaneous verdict;
   the finding is the missing re-check, which no single-call fixture can
   express.
2. **Opposite zero-config polarity** (`empty-profile-default-polarity`): JS
   defaults `minValue = 0` (`loot_loop.js:19`) → `0 >= 0` → **loots every
   item on every corpse**; C# with an empty/absent profile matches nothing →
   **loots nothing** (`CorpseOpenController.cs:1373-1379`: null rule = leave
   on corpse). Both are "no configuration", with opposite grind outcomes
   (pack fills with trash vs corpses stripped of nothing).
3. **Cross-evaluator C# quirk-pairs** — the lift put both C# evaluators under
   one fixture corpus for the first time, and they disagree with EACH OTHER
   on five predicates (worth rulings before either is treated as canon):
   - **DamagePercentGE**: VTank node is hardwired `false`
     (`VTankLootEvaluator.cs:172`); the native condition really computes
     `DamageMod(62)*100 >= value` (`LootEvaluator.cs:28`)
     (`damage-percent-always-false` vs `native-dmgpct-real-math`).
   - **MinDamageGE at maxDamage 0**: VTank returns false
     (`VTankLootEvaluator.cs:254-255`); native has no zero guard, so
     `0 >= 0` passes (`LootEvaluator.cs:69-74`)
     (`mindamage-zero-maxdamage` vs `native-mindamage-zero-max`).
   - **Empty regex pattern**: VTank's RegexCache returns null → NO match
     (`Meta/RegexCache.cs:29`); native `Regex.IsMatch(value, "")` matches
     EVERYTHING (`LootEvaluator.cs:58`)
     (`spellname-empty-pattern` vs `native-string-empty-pattern-matches-all`).
   - **Bad regex pattern**: VTank caches null → condition false, profile
     scan survives (`RegexCache.cs:37-39`); native THROWS out of
     `Classify` with no catch anywhere up the loot path — a single corrupt
     pattern in a native profile kills the whole classification tick
     (`native-string-bad-regex-throws`, surfaced by the slice boundary as
     `Verdict="error", Error="RegexParseException"`).
   - **Unknown condition/node type**: VTank throws → that RULE fails but
     the scan continues (`VTankLootEvaluator.cs:155-158,:197`,
     `unknown-node-type-fails-rule-only`); native passes optimistically
     (`LootEvaluator.cs:30`, `native-unknown-condition-optimistic`) —
     forward-compat rules fail-closed in one evaluator and fail-open in the
     other.
   - **Unknown-skill defaults**: VTank ctx reads (0,0) on a failed skill
     read (`VTankLootEvaluator.cs` / VTankLootContext:36-41) while the
     native path's CharacterSkills falls back to a capable stub buffed=250
     (`Combat/AcStubs.cs:346-405`) — the same `Skill >= 240` gate REJECTS in
     a VTank profile and PASSES in a native one
     (`charskill-unknown-skill-zero` vs `native-skillge-missing-skill-stub`).

### Preserved C# quirks (single-evaluator, pinned by fixtures)

- Rule `Priority` is parsed but never used — strict list order, first match
  wins (`priority-does-not-reorder`; `VTankLootProfile.cs:66-68`).
- `SlotExactPalette` parses its data lines BEFORE the null-ctx optimistic
  return, `CharacterSkillGE` short-circuits BEFORE parsing — the same corrupt
  data line fails one node type and passes the other under a null context
  (`slot-palette-parse-before-null-ctx` vs `charskill-null-ctx-short-circuit`;
  `VTankLootEvaluator.cs:263-265` vs `:184`).
- `ReadDouble` accepts thousands separators, `ReadInt` does not
  (`thousands-separator-double`; `:321-325`).
- TotalRatings sums int keys 370-376 + 379 and must skip 377/378
  (`total-ratings-boundary-and-377-excluded`; `:306-308`).
- Elemental bonus (float 152) clamps UP to 1.0 in BuffedMissileDamageGE
  (`buffed-missile-elem-clamped`; `:298-299`).
- Any matched rule loots — Sell/Read/KeepUpTo actions still return pickup
  (`sell-action-still-loots`; `CorpseOpenController.cs:1420-1423`).

## Caveat — what this slice is NOT

It is the pure classification verdict only. Not modeled (documented in the
source header): the ManaStone consumable override and mana-tap fallback
(`CorpseOpenController.cs:1305-1414` — stateful inventory-count logic layered
AROUND the rule evaluation), KeepUpTo count enforcement (only ManaStone rules
tally counts in the source), the RegexCache 2048-entry clear (irrelevant
single-call), and CharacterSkills' `_lastGood`/zero-artifact session-repair
statefulness (collapsed to its pure fallback shape). The JS parity harness
drives only the LOOT-state verdict branch of `loot_loop.js` — corpse
find/approach/open/confirm pacing are timer state machinery, not
classification, and belong to a later slice if ever.

## Recommended NEXT lift slice

The BuffScoring README's runner-up stands: the **CombatManager cast
serializer / face gate (P-rules)** — timer-heavy, so it needs BuffScoring's
multi-tick harness shape rather than this slice's single-call one. A cheaper
alternative surfaced by finding #1 here: lift the **corpse assess-window
scheduler** (`CorpseOpenController.cs:915-1050`) and use its fixtures to spec
the appraisal-gate fix that `loot_loop.js` needs anyway.
