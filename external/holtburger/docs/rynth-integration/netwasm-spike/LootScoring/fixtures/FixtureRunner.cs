// Console fixture runner for the LootScoring slice.
// Generates synthetic-but-realistic loot-classification scenarios, runs each
// through the C# evaluator via the SAME JSON boundary the wasm export uses
// (LootScoring.EvaluateLootJson), and writes fixtures.json:
//   { meta, scenarios: [ { name, rules[], note, jsMap, input, expected } ] }
// parity_check.cjs replays `input` against apps/holtburger-web/rynth/loot_loop.js
// (whose whole rule model is a single min-value gate) and compares pickup
// decisions against `expected` (the C# answer). `jsMap` tells the parity
// harness how to configure the JS loop (minValue) and whether the scenario's
// profile is even expressible in the JS model (mappable) — non-mappable
// divergences are expected-by-design, with `gap` naming what JS lacks.
//
// Determinism: seeded System.Random (stable algorithm for seeded instances);
// same seed -> byte-identical fixtures.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RynthNetwasm.LootScoring;

const int SEED = 54321;
const int ITEM_ID_BASE = 0x60000001;

string outPath = args.Length > 0 ? args[0] : "fixtures.json";
var rng = new Random(SEED);
var scenarios = new List<JsonObject>();
int nextItemId = ITEM_ID_BASE;

// ── builders ────────────────────────────────────────────────────────────────

ItemState Item(string name, int objectClass = 1, Action<ItemState>? mut = null)
{
    var it = new ItemState { Id = nextItemId++, Name = name, ObjectClass = objectClass };
    it.StringValues["1"] = name; // STypeString 1 = Name (AcStubs.cs:36)
    mut?.Invoke(it);
    return it;
}

CharacterState Char135()
    => new()
    {
        Level = 135,
        MainPackEmptySlots = 24,
        Skills = new Dictionary<string, SkillEntry>
        {
            ["33"] = new SkillEntry { Buffed = 320, Base = 290 }, // LifeMagic (STypeSkill 33)
            ["34"] = new SkillEntry { Buffed = 300, Base = 260 }, // WarMagic (STypeSkill 34)
            ["6"]  = new SkillEntry { Buffed = 410, Base = 355 }, // MeleeDefense (STypeSkill 6)
        },
    };

VtankCondition C(int nodeType, params string[] dataLines)
    => new() { NodeType = nodeType, DataLines = new List<string>(dataLines) };

VtankRule VR(string name, int action, params VtankCondition[] conds)
    => new() { Name = name, Action = action, Priority = 1, Conditions = new List<VtankCondition>(conds) };

LootInput VIn(ItemState item, CharacterState? ch, params VtankRule[] rules)
    => new() { Item = item, Character = ch, Vtank = new VtankProfile { Rules = new List<VtankRule>(rules) } };

NativeRule NR(string name, string action, params NativeCondition[] conds)
    => new() { Name = name, Action = action, Conditions = new List<NativeCondition>(conds) };

LootInput NIn(ItemState item, CharacterState? ch, params NativeRule[] rules)
    => new() { Item = item, Character = ch, Native = new NativeProfile { Rules = new List<NativeRule>(rules) } };

void Add(string name, string[] rules, string note, LootInput input,
         bool jsMappable = false, int jsMinValue = 0, string jsGap = "")
{
    // Run through the SAME single JSON boundary the wasm export exposes.
    string inJson = JsonSerializer.Serialize(input, LootJsonContext.Default.LootInput);
    string outJson = LootScoring.EvaluateLootJson(inJson);
    scenarios.Add(new JsonObject
    {
        ["name"] = name,
        ["rules"] = new JsonArray(Array.ConvertAll(rules, r => (JsonNode)r!)),
        ["note"] = note,
        ["jsMap"] = new JsonObject
        {
            ["mappable"] = jsMappable,
            ["minValue"] = jsMinValue,
            ["gap"] = jsGap,
        },
        ["input"] = JsonNode.Parse(inJson),
        ["expected"] = JsonNode.Parse(outJson),
    });
}

// Convenience: a single-rule "value floor" profile — the ONLY VTank profile
// shape the JS loop can express (loot_loop.js:163-164 value >= minValue).
VtankRule ValueFloor(int min) => VR("value floor", 1, C(3 /*LongValKeyGE*/, min.ToString(), "19"));

// ── A. JS-mappable value-gate scenarios (shared domain with loot_loop.js) ───

Add("value-above-gate", new[] { "vtank:LongValKeyGE", "jsgate" },
    "Value 25000 vs floor 10000: C# keep; JS picks up. Agree.",
    VIn(Item("Gold Haucondiah", 4, it => it.IntValues["19"] = 25000), Char135(), ValueFloor(10000)),
    jsMappable: true, jsMinValue: 10000);

Add("value-exact-boundary", new[] { "vtank:LongValKeyGE", "jsgate", "boundary" },
    "Value exactly at the floor: C# >= keeps; JS `value < minValue` skip-test also keeps. Agree at the boundary.",
    VIn(Item("Silver Pyreal Cache", 7, it => it.IntValues["19"] = 10000), Char135(), ValueFloor(10000)),
    jsMappable: true, jsMinValue: 10000);

Add("value-below-gate", new[] { "vtank:LongValKeyGE", "jsgate" },
    "Value 500 vs floor 10000: both leave it.",
    VIn(Item("Chipped Gem", 11, it => it.IntValues["19"] = 500), Char135(), ValueFloor(10000)),
    jsMappable: true, jsMinValue: 10000);

Add("value-missing-prop", new[] { "vtank:LongValKeyGE", "jsgate", "missing-prop" },
    "No Value(19) at all (unappraised/unstreamed): C# Values(19,0)=0 -> no-loot; JS `?? 0` -> skip. Same fail-closed direction — but see the appraisal-gate finding in the README (C# waits for appraisal upstream, JS never does).",
    VIn(Item("Unappraised Amulet", 4), Char135(), ValueFloor(10000)),
    jsMappable: true, jsMinValue: 10000);

Add("value-zero-gate-zero", new[] { "vtank:LongValKeyGE", "jsgate", "boundary" },
    "Value 0 vs floor 0: 0 >= 0 both sides -> keep.",
    VIn(Item("Worthless Trinket", 8, it => it.IntValues["19"] = 0), Char135(), ValueFloor(0)),
    jsMappable: true, jsMinValue: 0);

Add("unconditional-keep-all", new[] { "vtank:unconditional", "jsgate" },
    "Rule with zero conditions matches everything (VTankLootEvaluator.cs:143); JS minValue=0 also picks up everything. Agree.",
    VIn(Item("Anything At All", 8, it => it.IntValues["19"] = 3), Char135(), VR("keep all", 1)),
    jsMappable: true, jsMinValue: 0);

Add("empty-profile-default-polarity", new[] { "polarity", "jsgate" },
    "GENUINE-POLARITY PROBE: zero rules -> C# leaves EVERYTHING (no match = leave on corpse, CorpseOpenController.cs:1373-1379); the JS default minValue=0 (loot_loop.js:19) loots EVERYTHING. Opposite no-config defaults.",
    VIn(Item("Rusty Dagger", 1, it => it.IntValues["19"] = 40), Char135()),
    jsMappable: false, jsMinValue: 0, jsGap: "default polarity: JS keep-all vs C# leave-all");

Add("salvage-verdict-vs-pickup", new[] { "vtank:action", "salvage-plane" },
    "Salvage rule matches: C# verdict 'salvage'; JS has no salvage plane — with minValue 0 it picks the item up, agreeing at pickup level only.",
    VIn(Item("Sturdy Iron Shield", 2, it => { it.IntValues["19"] = 900; it.IntValues["105"] = 8; }), Char135(),
        VR("salvage wm8", 2, C(3, "8", "105"))),
    jsMappable: false, jsMinValue: 0, jsGap: "no salvage action plane in JS");

Add("sell-action-still-loots", new[] { "vtank:action" },
    "Action=Sell (3) is still a pickup — ClassifyItemAgainstProfile returns true for ANY matched rule (CorpseOpenController.cs:1420-1423). Verdict 'keep'.",
    VIn(Item("Vendor Trash Sceptre", 31, it => it.IntValues["19"] = 6000), Char135(),
        VR("sell it", 3, C(3, "5000", "19"))),
    jsMappable: true, jsMinValue: 5000);

Add("keepupto-count-not-enforced", new[] { "vtank:action" },
    "KeepUpTo (10) with KeepCount 3: the pure classifier does NOT tally counts (only the ManaStone override does) — verdict 'keep', KeepCount informational.",
    VIn(Item("Healing Kit", 29, it => it.IntValues["19"] = 250), Char135(),
        new VtankRule { Name = "kits x3", Action = 10, KeepCount = 3, Priority = 1, Conditions = new List<VtankCondition> { C(7, "29") } }),
    jsMappable: false, jsMinValue: 0, jsGap: "ObjectClass predicate; keep-count plane");

// ── B. VTank node-type coverage (C#-only predicates; JS runs its value gate) ─

const string GAP_ALL = "predicate not expressible in JS min-value gate";

Add("spellname-match-hit", new[] { "vtank:SpellNameMatch" },
    "Item carries 'Epic Strength'; pattern ^Epic matches -> keep.",
    VIn(Item("Chitin Bracers", 2, it =>
        {
            it.IntValues["19"] = 800;
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
            it.Spells.Add(new SpellEntry { Id = 2073, Name = "Minor Fealty" });
        }), Char135(),
        VR("epics", 1, C(0, "^Epic"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellname-match-miss", new[] { "vtank:SpellNameMatch" },
    "No spell matches ^Epic -> no-loot; JS (minValue 0) picks it up anyway. Expected divergence.",
    VIn(Item("Chitin Greaves", 2, it =>
        {
            it.IntValues["19"] = 800;
            it.Spells.Add(new SpellEntry { Id = 2073, Name = "Minor Fealty" });
        }), Char135(),
        VR("epics", 1, C(0, "^Epic"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellname-bad-regex", new[] { "vtank:SpellNameMatch", "regex" },
    "Pattern '(' fails to compile: RegexCache caches null -> condition false -> no-loot (RegexCache.cs:37-39; VTankLootEvaluator.cs:215-216).",
    VIn(Item("Runed Baton", 31, it => it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" })), Char135(),
        VR("broken pattern", 1, C(0, "("))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellname-empty-pattern", new[] { "vtank:SpellNameMatch", "regex" },
    "Empty pattern: RegexCache.Get returns null for IsNullOrEmpty (RegexCache.cs:29) -> false (the native String condition treats '' as match-all — see native-string-empty-pattern).",
    VIn(Item("Runed Baton", 31, it => it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" })), Char135(),
        VR("empty pattern", 1, C(0, ""))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellname-null-ctx-optimistic", new[] { "vtank:SpellNameMatch", "null-ctx" },
    "Character=null: SpellNameMatch returns true BEFORE building the (bad) regex (VTankLootEvaluator.cs:214) -> keep.",
    VIn(Item("Runed Baton", 31), null,
        VR("broken pattern", 1, C(0, "("))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellname-unresolvable-spell-skipped", new[] { "vtank:SpellNameMatch" },
    "Spell id with no table entry resolves to '' (SpellTableStub miss, VTankLootContext.cs:123-124) and is skipped by the IsNullOrEmpty guard (:218) -> no-loot.",
    VIn(Item("Strange Idol", 8, it => it.Spells.Add(new SpellEntry { Id = 99999, Name = "" })), Char135(),
        VR("any spell name", 1, C(0, "."))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("stringvalue-name-match", new[] { "vtank:StringValueMatch", "regex" },
    "StringValueMatch pattern 'Sword' on key 1 (Name) matches 'Fine Sword' case-insensitively -> keep.",
    VIn(Item("Fine sword", 1, it => it.IntValues["19"] = 100), Char135(),
        VR("swords", 1, C(1, "Sword", "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("stringvalue-bad-regex", new[] { "vtank:StringValueMatch", "regex" },
    "Bad pattern via RegexCache.IsMatch -> false -> no-loot (RegexCache.cs:43-49).",
    VIn(Item("Fine Sword", 1), Char135(),
        VR("broken", 1, C(1, "[", "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("long-le", new[] { "vtank:LongValKeyLE", "boundary" },
    "Burden(5) 350 <= 350 -> keep (boundary equality on LE).",
    VIn(Item("Light Buckler", 2, it => it.IntValues["5"] = 350), Char135(),
        VR("light things", 1, C(2, "350", "5"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("long-e", new[] { "vtank:LongValKeyE" },
    "MaterialType(131) == 61 exact -> keep.",
    VIn(Item("Gold Cache", 11, it => it.IntValues["131"] = 61), Char135(),
        VR("gold only", 1, C(12, "61", "131"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("long-ne", new[] { "vtank:LongValKeyNE" },
    "MaterialType(131) != 61 with material 20 present -> keep.",
    VIn(Item("Granite Chunk", 11, it => it.IntValues["131"] = 20), Char135(),
        VR("not gold", 1, C(13, "61", "131"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("long-flag-exists", new[] { "vtank:LongValKeyFlagExists" },
    "Locations(9) bitmask 0x6000 & flag 0x2000 -> nonzero -> keep.",
    VIn(Item("Twin-Slot Ring", 4, it => it.IntValues["9"] = 0x6000), Char135(),
        VR("ring slot", 1, C(11, "8192", "9"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("long-flag-missing", new[] { "vtank:LongValKeyFlagExists" },
    "Flag not set -> false -> no-loot.",
    VIn(Item("Bracelet", 4, it => it.IntValues["9"] = 0x4000), Char135(),
        VR("ring slot", 1, C(11, "8192", "9"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("double-ge-boundary", new[] { "vtank:DoubleValKeyGE", "boundary" },
    "SalvageWorkmanship-ish double key 167 at exactly the threshold -> keep (>=).",
    VIn(Item("Amber Chunk", 11, it => it.DoubleValues["167"] = 9.5), Char135(),
        VR("wm 9.5+", 1, C(5, "9.5", "167"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("double-le", new[] { "vtank:DoubleValKeyLE" },
    "DamageVariance(22) 0.35 <= 0.4 -> keep.",
    VIn(Item("Steady Spear", 1, it => it.DoubleValues["22"] = 0.35), Char135(),
        VR("low variance", 1, C(4, "0.4", "22"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("double-missing-defaults-zero", new[] { "vtank:DoubleValKeyGE", "missing-prop" },
    "Missing double key reads 0.0 (Values default) -> 0 >= 1.1 false -> no-loot.",
    VIn(Item("Plain Rock", 8), Char135(),
        VR("needs 1.1", 1, C(5, "1.1", "167"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("damage-percent-always-false", new[] { "vtank:DamagePercentGE", "quirk" },
    "QUIRK: VTank DamagePercentGE is false UNCONDITIONALLY (VTankLootEvaluator.cs:172) even with DamageMod present — contrast native-dmgpct-real-math.",
    VIn(Item("Deadly Bow", 9, it => it.DoubleValues["62"] = 1.55), Char135(),
        VR("dmg%", 1, C(6, "10"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("objectclass-match", new[] { "vtank:ObjectClass" },
    "ObjectClass 42 (Scroll) == rule's 42 -> keep.",
    VIn(Item("Scroll of Fireworks", 42, it => it.IntValues["19"] = 5), Char135(),
        VR("scrolls", 1, C(7, "42"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellcount-ge", new[] { "vtank:SpellCountGE" },
    "2 spells >= 2 -> keep.",
    VIn(Item("Doubly Enchanted Cap", 2, it =>
        {
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
            it.Spells.Add(new SpellEntry { Id = 4312, Name = "Epic Coordination" });
        }), Char135(),
        VR("2+ spells", 1, C(8, "2"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellcount-host-lacks-spellids", new[] { "vtank:SpellCountGE", "capability" },
    "Host without GetObjectSpellIds -> spell list reads empty (VTankLootContext.cs:101-111) -> 0 >= 1 false.",
    VIn(Item("Maybe-Enchanted Cap", 2, it =>
        {
            it.HostHasSpellIds = false;
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
        }), Char135(),
        VR("1+ spells", 1, C(8, "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellcount-null-ctx", new[] { "vtank:SpellCountGE", "null-ctx" },
    "Character=null short-circuits to true BEFORE parsing the count line (VTankLootEvaluator.cs:174) — even an unparseable count passes.",
    VIn(Item("Cap", 2), null,
        VR("bogus count", 1, C(8, "not-a-number"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellmatch-neg-filter", new[] { "vtank:SpellMatch", "regex" },
    "pos 'Epic' neg 'Coordination' count 2: Epic Strength counts, Epic Coordination is negated -> 1 < 2 -> no-loot.",
    VIn(Item("Twice-Epic Girth", 2, it =>
        {
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
            it.Spells.Add(new SpellEntry { Id = 4312, Name = "Epic Coordination" });
            it.Spells.Add(new SpellEntry { Id = 2073, Name = "Minor Fealty" });
        }), Char135(),
        VR("2 epics no coord", 1, C(9, "Epic", "Coordination", "2"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellmatch-count-met", new[] { "vtank:SpellMatch", "regex" },
    "Same item, count 1 -> Epic Strength alone satisfies -> keep.",
    VIn(Item("Twice-Epic Girth", 2, it =>
        {
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
            it.Spells.Add(new SpellEntry { Id = 4312, Name = "Epic Coordination" });
        }), Char135(),
        VR("1 epic no coord", 1, C(9, "Epic", "Coordination", "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellmatch-blank-neg", new[] { "vtank:SpellMatch", "regex" },
    "Blank negative pattern is treated as 'no negative filter' (IsNullOrWhiteSpace -> null, VTankLootEvaluator.cs:238-240) -> both epics count -> keep.",
    VIn(Item("Twice-Epic Girth", 2, it =>
        {
            it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" });
            it.Spells.Add(new SpellEntry { Id = 4312, Name = "Epic Coordination" });
        }), Char135(),
        VR("2 epics", 1, C(9, "Epic", "  ", "2"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("spellmatch-bad-pos-regex", new[] { "vtank:SpellMatch", "regex" },
    "Bad positive pattern -> null -> false (VTankLootEvaluator.cs:236-237).",
    VIn(Item("Girth", 2, it => it.Spells.Add(new SpellEntry { Id = 4305, Name = "Epic Strength" })), Char135(),
        VR("broken", 1, C(9, "(", "", "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("mindamage-ge", new[] { "vtank:MinDamageGE" },
    "max 30, variance 0.5 -> min 15 >= 12 -> keep.",
    VIn(Item("Keen Blade", 1, it => { it.IntValues["54"] = 30; it.DoubleValues["22"] = 0.5; }), Char135(),
        VR("min dmg 12", 1, C(10, "12"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("mindamage-zero-maxdamage", new[] { "vtank:MinDamageGE", "quirk" },
    "QUIRK: maxDamage==0 -> false even against threshold 0 (VTankLootEvaluator.cs:254-255) — contrast native-mindamage-zero-max.",
    VIn(Item("Dull Club", 1, it => it.DoubleValues["22"] = 0.1), Char135(),
        VR("min dmg 0", 1, C(10, "0"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("thousands-separator-double", new[] { "vtank:MinDamageGE", "parse" },
    "ReadDouble uses NumberStyles.AllowThousands (VTankLootEvaluator.cs:324-325): threshold '1,500' parses as 1500 -> 20 >= 1500 false. (ReadInt does NOT allow thousands.)",
    VIn(Item("Modest Mace", 1, it => { it.IntValues["54"] = 25; it.DoubleValues["22"] = 0.2; }), Char135(),
        VR("comma threshold", 1, C(10, "1,500"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("similar-color-optimistic-trio", new[] { "vtank:AnySimilarColor", "vtank:SimilarColorArmorType", "vtank:SlotSimilarColor" },
    "All three portal.dat color nodes are optimistic true (VTankLootEvaluator.cs:180-182) -> keep.",
    VIn(Item("Dyed Cuirass", 2, it => it.IntValues["19"] = 77), Char135(),
        VR("colors", 1,
            C(14, "255", "0", "0", "10", "10"),
            C(15, "0", "255", "0", "10", "10", "2"),
            C(16, "0", "0", "255", "10", "10", "1"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("slot-palette-match", new[] { "vtank:SlotExactPalette" },
    "Slot 0 subId 0x04001234 vs target 0x0F001234: low-24-bit compare strips the 0x04/0x0F prefixes -> match (VTankLootEvaluator.cs:270).",
    VIn(Item("Painted Helm", 2, it => { it.PaletteSubIds.Add(0x04001234); it.PaletteSubIds.Add(0x04002222); }), Char135(),
        VR("exact palette", 1, C(17, "0", ((int)0x0F001234).ToString()))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("slot-palette-out-of-range", new[] { "vtank:SlotExactPalette" },
    "Slot 5 with only 2 palettes -> false (VTankLootEvaluator.cs:268).",
    VIn(Item("Painted Helm", 2, it => { it.PaletteSubIds.Add(0x04001234); it.PaletteSubIds.Add(0x04002222); }), Char135(),
        VR("slot 5", 1, C(17, "5", ((int)0x04001234).ToString()))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("slot-palette-no-palettes-optimistic", new[] { "vtank:SlotExactPalette" },
    "No palette data -> optimistic true (VTankLootEvaluator.cs:267); also covers HasGetObjectPalettes=false (VTankLootContext.cs:82).",
    VIn(Item("Unpainted Helm", 2, it => it.HostHasPalettes = false), Char135(),
        VR("any palette", 1, C(17, "0", "1234"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("slot-palette-parse-before-null-ctx", new[] { "vtank:SlotExactPalette", "null-ctx", "order", "parse" },
    "ORDER PROBE: SlotExactPalette parses its lines BEFORE the ctx-null return (VTankLootEvaluator.cs:263-265) — bad slot line + null ctx -> exception -> rule FALSE (contrast charskill-null-ctx-short-circuit).",
    VIn(Item("Helm", 2), null,
        VR("bad slot line", 1, C(17, "not-a-slot", "1234"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("charskill-ge", new[] { "vtank:CharacterSkillGE" },
    "WarMagic (STypeSkill 34) buffed 300 >= 250 -> keep.",
    VIn(Item("War Staff", 31, it => it.IntValues["19"] = 100), Char135(),
        VR("war 250+", 1, C(1000, "250", "34"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("charskill-unknown-skill-zero", new[] { "vtank:CharacterSkillGE", "missing-prop" },
    "Skill absent from the character bag -> VTank ctx (0,0) (VTankLootContext.cs:36-41) -> 0 >= 100 false (contrast native-skillge-missing-skill-stub).",
    VIn(Item("Void Orb", 31), Char135(),
        VR("void 100+", 1, C(1000, "100", "43"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("charskill-null-ctx-short-circuit", new[] { "vtank:CharacterSkillGE", "null-ctx", "order" },
    "Character=null short-circuits to true BEFORE any parse (VTankLootEvaluator.cs:184) — unparseable lines pass.",
    VIn(Item("Orb", 31), null,
        VR("bogus", 1, C(1000, "junk", "junk"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("packslots-ge", new[] { "vtank:CharacterMainPackEmptySlotsGE" },
    "24 empty slots >= 10 -> keep.",
    VIn(Item("Bulky Trophy", 8, it => it.IntValues["19"] = 44), Char135(),
        VR("room for it", 1, C(1001, "10"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("level-ge-boundary", new[] { "vtank:CharacterLevelGE", "boundary" },
    "Level 135 >= 135 -> keep.",
    VIn(Item("High-Level Bauble", 4), Char135(),
        VR("135+", 1, C(1002, "135"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("level-le-fails", new[] { "vtank:CharacterLevelLE" },
    "Level 135 <= 50 false -> no-loot.",
    VIn(Item("Newbie Token", 8), Char135(),
        VR("lowbie only", 1, C(1003, "50"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("base-skill-range", new[] { "vtank:CharacterBaseSkill", "boundary" },
    "MeleeDefense base 355 in [300,355] (inclusive both ends, VTankLootEvaluator.cs:280) -> keep.",
    VIn(Item("Parry Blade", 1), Char135(),
        VR("md band", 1, C(1004, "6", "300", "355"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("buffed-median-damage-boundary", new[] { "vtank:BuffedMedianDamageGE", "boundary" },
    "max 40 variance 0.3 -> min 28, median 34 >= 34 -> keep.",
    VIn(Item("Balanced Axe", 1, it => { it.IntValues["54"] = 40; it.DoubleValues["22"] = 0.3; }), Char135(),
        VR("median 34", 1, C(2000, "34"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("buffed-missile-elem-clamped", new[] { "vtank:BuffedMissileDamageGE", "quirk" },
    "ElementalDamageBonus(152)=0.5 clamps UP to 1.0 (VTankLootEvaluator.cs:298-299): 20*1.0 >= 20 -> keep.",
    VIn(Item("Weak-Element Bow", 9, it => { it.IntValues["54"] = 20; it.DoubleValues["152"] = 0.5; }), Char135(),
        VR("missile 20", 1, C(2001, "20"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("buffed-missile-elem-multiplies", new[] { "vtank:BuffedMissileDamageGE" },
    "152=1.4 -> 20*1.4=28 >= 25 -> keep.",
    VIn(Item("Charged Bow", 9, it => { it.IntValues["54"] = 20; it.DoubleValues["152"] = 1.4; }), Char135(),
        VR("missile 25", 1, C(2001, "25"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("buffed-longval-double-threshold", new[] { "vtank:BuffedLongValKeyGE", "parse" },
    "BuffedLongValKeyGE reads its threshold as a DOUBLE (DoubleKey, VTankLootEvaluator.cs:191,:331): int ArmorLevel(28) 251 >= 250.5 -> keep.",
    VIn(Item("Stout Breastplate", 2, it => it.IntValues["28"] = 251), Char135(),
        VR("al 250.5", 1, C(2003, "250.5", "28"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("buffed-doubleval-ge", new[] { "vtank:BuffedDoubleValKeyGE" },
    "Double key 29 (WeaponDefense) 1.18 >= 1.15 -> keep.",
    VIn(Item("Defender Blade", 1, it => it.DoubleValues["29"] = 1.18), Char135(),
        VR("wd 1.15", 1, C(2005, "1.15", "29"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("calcd-buffed-tinked", new[] { "vtank:CalcdBuffedTinkedDamageGE" },
    "Raw int 54 (25) >= 24.5 (double threshold) -> keep (VTankLootEvaluator.cs:193).",
    VIn(Item("Tinkerable Sword", 1, it => it.IntValues["54"] = 25), Char135(),
        VR("tinked 24.5", 1, C(2006, "24.5"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("total-ratings-boundary-and-377-excluded", new[] { "vtank:TotalRatingsGE", "boundary", "quirk" },
    "Ratings 370..376,379 sum to 40 >= 40 -> keep; keys 377/378 hold junk that must NOT be counted (VTankLootEvaluator.cs:306-308).",
    VIn(Item("Rated Cloak", 3, it =>
        {
            it.IntValues["370"] = 5; it.IntValues["371"] = 5; it.IntValues["372"] = 5; it.IntValues["373"] = 5;
            it.IntValues["374"] = 5; it.IntValues["375"] = 5; it.IntValues["376"] = 5; it.IntValues["379"] = 5;
            it.IntValues["377"] = 99; it.IntValues["378"] = 99;
        }), Char135(),
        VR("ratings 40", 1, C(2007, "40"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("tinked-target-melee-always-false", new[] { "vtank:CalcedBuffedTinkedTargetMeleeGE", "quirk" },
    "Not implemented -> false unconditionally (VTankLootEvaluator.cs:195).",
    VIn(Item("Any Weapon", 1, it => it.IntValues["54"] = 50), Char135(),
        VR("melee calc", 1, C(2008, "0.5", "300", "300"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("disabled-rule-skipped", new[] { "vtank:DisabledRule", "order" },
    "Rule 0 carries DisabledRule 'true' -> false (VTankLootProfile.cs:87-105 contract); rule 1 matches -> RuleIndex 1.",
    VIn(Item("Valuable Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("disabled catch-all", 1, C(9999, "true")),
        ValueFloor(5000)),
    jsMinValue: 0, jsGap: "DisabledRule plane (JS would need per-rule enable)");

Add("disabled-rule-false-passes", new[] { "vtank:DisabledRule" },
    "DisabledRule 'false' returns true (enabled) and the rest of the rule evaluates -> keep.",
    VIn(Item("Valuable Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("enabled floor", 1, C(9999, "false"), C(3, "5000", "19"))),
    jsMappable: true, jsMinValue: 5000);

Add("disabled-rule-mixed-case-trimmed", new[] { "vtank:DisabledRule", "parse" },
    "' TRUE ' trims + case-insensitively disables (VTankLootEvaluator.cs:314-315).",
    VIn(Item("Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("weirdly disabled", 1, C(9999, " TRUE "), C(3, "1", "19"))),
    jsMinValue: 0, jsGap: "DisabledRule plane");

Add("unknown-node-type-fails-rule-only", new[] { "vtank:unknown", "exception" },
    "Node type 4242 throws InvalidOperationException (VTankLootEvaluator.cs:197) -> caught (:155-158) -> rule 0 false; rule 1 still matches. The profile scan SURVIVES unknown nodes.",
    VIn(Item("Future Item", 8, it => it.IntValues["19"] = 7000), Char135(),
        VR("from-the-future", 1, C(4242, "whatever")),
        ValueFloor(5000)),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("bad-int-parse-fails-rule", new[] { "vtank:LongValKeyGE", "exception", "parse" },
    "Unparseable value line '12x' throws FormatException -> rule false (VTankLootEvaluator.cs:155-158).",
    VIn(Item("Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("corrupt line", 1, C(3, "12x", "19"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("missing-data-line-fails-rule", new[] { "vtank:LongValKeyGE", "exception" },
    "LongValKeyGE with only one data line -> ArgumentOutOfRangeException on the key read -> rule false.",
    VIn(Item("Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("truncated", 1, C(3, "5000"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("first-match-order", new[] { "order" },
    "Rules 0 (Keep) and 1 (Salvage) BOTH match; list order wins -> Keep from rule 0 (CorpseOpenController.cs:1398-1406).",
    VIn(Item("Contested Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        VR("keep gems", 1, C(7, "11")),
        VR("salvage gems", 2, C(7, "11"))),
    jsMinValue: 0, jsGap: "ObjectClass predicate; first-match rule ordering");

Add("priority-does-not-reorder", new[] { "order", "quirk" },
    "QUIRK: rule 1 has Priority 99 but the scan is strict list order (priority is preserved-only, VTankLootProfile.cs:66-68) -> rule 0 wins.",
    VIn(Item("Contested Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        new VtankRule { Name = "low prio first", Action = 1, Priority = 1, Conditions = new List<VtankCondition> { C(7, "11") } },
        new VtankRule { Name = "high prio second", Action = 2, Priority = 99, Conditions = new List<VtankCondition> { C(7, "11") } }),
    jsMinValue: 0, jsGap: "ObjectClass predicate; rule ordering");

Add("multi-condition-and", new[] { "vtank:and" },
    "Conditions AND together (all must match, VTankLootEvaluator.cs:148-153): class Gem + value floor + workmanship floor -> keep only when all hold.",
    VIn(Item("Prime Gem", 11, it => { it.IntValues["19"] = 20000; it.IntValues["105"] = 9; }), Char135(),
        VR("prime gems", 1, C(7, "11"), C(3, "15000", "19"), C(3, "8", "105"))),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("multi-condition-and-one-fails", new[] { "vtank:and" },
    "Same rule, workmanship too low -> second condition kills it -> no-loot; trace pins FirstFailedCondition=2.",
    VIn(Item("Lesser Gem", 11, it => { it.IntValues["19"] = 20000; it.IntValues["105"] = 3; }), Char135(),
        VR("prime gems", 1, C(7, "11"), C(3, "15000", "19"), C(3, "8", "105"))),
    jsMinValue: 0, jsGap: GAP_ALL);

// ── C. native (SDK LootModel) profile scenarios ─────────────────────────────

Add("native-longge-keep", new[] { "native:LongGE" },
    "Native LongValKeyGECondition Value(19) 12000 >= 10000 -> keep (LootEvaluator.cs:18).",
    NIn(Item("Native Bauble", 4, it => it.IntValues["19"] = 12000), Char135(),
        NR("value floor", "Keep", new NativeCondition { T = "LongGE", Key = 19, IntValue = 10000 })),
    jsMappable: true, jsMinValue: 10000);

Add("native-disabled-rule-skipped", new[] { "native:Enabled", "order" },
    "Enabled=false rule is skipped outright (LootEvaluator.cs:35); rule 1 matches.",
    NIn(Item("Native Gem", 11, it => it.IntValues["19"] = 9000), Char135(),
        new NativeRule { Name = "off", Enabled = false, Action = "Keep", Conditions = new List<NativeCondition>() },
        NR("gems", "Keep", new NativeCondition { T = "ObjectClass", ObjectClass = 11 })),
    jsMinValue: 0, jsGap: "ObjectClass predicate; per-rule enable plane");

Add("native-no-match-null-rule", new[] { "native:Classify" },
    "No rule matches: Classify returns (Sell, null) (LootEvaluator.cs:50) and the caller treats null rule as leave-on-corpse (CorpseOpenController.cs:1373-1379) -> no-loot.",
    NIn(Item("Unwanted Shard", 8, it => it.IntValues["19"] = 3), Char135(),
        NR("high floor", "Keep", new NativeCondition { T = "LongGE", Key = 19, IntValue = 50000 })),
    jsMappable: true, jsMinValue: 50000);

Add("native-salvage-action", new[] { "native:action", "salvage-plane" },
    "Native Salvage action -> verdict 'salvage' (CorpseOpenController.cs:1381-1383).",
    NIn(Item("Salvage Fodder", 2, it => it.IntValues["19"] = 200), Char135(),
        NR("salvage armor", "Salvage", new NativeCondition { T = "ObjectClass", ObjectClass = 2 })),
    jsMinValue: 0, jsGap: "ObjectClass predicate; no salvage plane in JS");

Add("native-string-empty-pattern-matches-all", new[] { "native:String", "regex", "quirk" },
    "QUIRK: native EvalString uses raw Regex.IsMatch (LootEvaluator.cs:55-60) — an EMPTY pattern matches everything (contrast spellname-empty-pattern where the cache returns null -> false).",
    NIn(Item("Anything Named", 8), Char135(),
        NR("empty pattern", "Keep", new NativeCondition { T = "String", Key = 1, Pattern = "" })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-string-bad-regex-throws", new[] { "native:String", "regex", "exception", "quirk" },
    "QUIRK: a bad native pattern THROWS out of Classify (LootEvaluator.cs:58 has no catch; VTank path caches null instead) -> boundary surfaces Verdict='error' Error='RegexParseException'.",
    NIn(Item("Crash Test Dummy", 8), Char135(),
        NR("broken", "Keep", new NativeCondition { T = "String", Key = 1, Pattern = "(" })),
    jsMinValue: 0, jsGap: "error path: C# native profile throws, JS just gates on value");

Add("native-skillge-null-skills", new[] { "native:SkillGE", "null-ctx" },
    "skills==null passes optimistically (LootEvaluator.cs:29).",
    NIn(Item("Skill-Gated Wand", 31), null,
        NR("war 400", "Keep", new NativeCondition { T = "SkillGE", Skill = 7, IntValue = 400 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-skillge-missing-skill-stub", new[] { "native:SkillGE", "quirk" },
    "QUIRK: skill absent from the bag -> CharacterSkills capable-stub buffed=250 (AcStubs.cs:396-405) -> 250 >= 240 KEEPS (the VTank ctx would read 0 and fail — see charskill-unknown-skill-zero).",
    NIn(Item("Void Wand", 31), Char135(),
        NR("void 240", "Keep", new NativeCondition { T = "SkillGE", Skill = 8, IntValue = 240 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-skillge-real-read", new[] { "native:SkillGE" },
    "WarMagic (AcSkillType 7 -> STypeSkill 34, AcStubs.cs:421) buffed 300 >= 280 -> keep.",
    NIn(Item("War Wand", 31), Char135(),
        NR("war 280", "Keep", new NativeCondition { T = "SkillGE", Skill = 7, IntValue = 280 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-unknown-condition-optimistic", new[] { "native:unknown", "quirk" },
    "QUIRK: an unknown native condition type passes optimistically (LootEvaluator.cs:30 `_ => true`) — the VTank path throws/fails instead (unknown-node-type-fails-rule-only).",
    NIn(Item("Forward-Compat Relic", 8, it => it.IntValues["19"] = 5), Char135(),
        NR("future cond", "Keep", new NativeCondition { T = "SomeFutureCondition", IntValue = 1 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-dmgpct-real-math", new[] { "native:DmgPctGE", "quirk" },
    "QUIRK PAIR: native DamagePercentGE really computes DamageMod(62)*100 >= value (LootEvaluator.cs:28): 1.55*100=155 >= 150 -> keep, while the VTank node of the same name is hardwired false (damage-percent-always-false).",
    NIn(Item("Deadly Bow", 9, it => it.DoubleValues["62"] = 1.55), Char135(),
        NR("dmg 150%", "Keep", new NativeCondition { T = "DmgPctGE", DoubleValue = 150 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-mindamage-zero-max", new[] { "native:MinDamageGE", "quirk" },
    "QUIRK PAIR: native MinDamageGE has NO maxDamage==0 guard (LootEvaluator.cs:69-74): 0 - v*0 = 0 >= 0 -> keep, while the VTank node returns false (mindamage-zero-maxdamage).",
    NIn(Item("Dull Club", 1, it => it.DoubleValues["22"] = 0.1), Char135(),
        NR("min dmg 0", "Keep", new NativeCondition { T = "MinDamageGE", DoubleValue = 0 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-total-ratings", new[] { "native:TotalRatingsGE" },
    "Native rating sum over the same 8 keys (LootEvaluator.cs:12,:62-67): 22 >= 20 -> keep.",
    NIn(Item("Rated Sash", 3, it => { it.IntValues["370"] = 10; it.IntValues["376"] = 7; it.IntValues["379"] = 5; }), Char135(),
        NR("ratings 20", "Keep", new NativeCondition { T = "TotalRatingsGE", IntValue = 20 })),
    jsMinValue: 0, jsGap: GAP_ALL);

Add("native-objectclass-and-doublege", new[] { "native:ObjectClass", "native:DoubleGE" },
    "AND of ObjectClass==MissileWeapon and DamageMod-ish double: both hold -> keep (Matches, LootEvaluator.cs:33-39).",
    NIn(Item("Slick Bow", 9, it => it.DoubleValues["62"] = 1.42), Char135(),
        NR("good bows", "Keep",
            new NativeCondition { T = "ObjectClass", ObjectClass = 9 },
            new NativeCondition { T = "DoubleGE", Key = 62, DoubleValue = 1.4 })),
    jsMinValue: 0, jsGap: GAP_ALL);

// ── D. randomized grind scenarios (seeded) ──────────────────────────────────
// A fixed 5-rule VTank profile vs randomized corpse items. jsMap uses the
// profile's value-floor rule (15000) as the closest JS approximation — every
// divergence isolates a predicate plane JS lacks.

VtankRule[] GrindProfile() => new[]
{
    VR("disabled trap", 1, C(9999, "true")),                       // never matches
    VR("epics", 1, C(0, "^Epic ")),                                // SpellNameMatch
    VR("salvage rated", 2, C(2007, "18")),                         // TotalRatingsGE -> Salvage
    VR("value floor", 1, C(3, "15000", "19")),                     // the JS-expressible part
    VR("heavy hitters", 1, C(10, "22")),                           // MinDamageGE
};

string[] grindNames = { "Chitin Bracers", "Gold Cache", "Runed Baton", "Slick Bow", "Rated Cloak", "Keen Blade", "Plain Rock", "Fine Sword" };
string[] grindSpells = { "Epic Strength", "Major Coordination", "Minor Fealty", "Epic Armor" };
int[] grindClasses = { 1, 2, 4, 9, 11, 31, 42 };

for (int i = 0; i < 12; i++)
{
    var it = Item($"{grindNames[rng.Next(grindNames.Length)]} #{i}", grindClasses[rng.Next(grindClasses.Length)]);
    it.IntValues["19"] = rng.Next(0, 30001);                       // Value
    if (rng.Next(2) == 0) it.IntValues["54"] = rng.Next(0, 41);    // MAX_DAMAGE
    if (rng.Next(2) == 0) it.DoubleValues["22"] = Math.Round(rng.NextDouble() * 0.9, 3); // variance
    int nSpells = rng.Next(4);
    for (int s = 0; s < nSpells; s++)
        it.Spells.Add(new SpellEntry { Id = 2000 + rng.Next(3000), Name = grindSpells[rng.Next(grindSpells.Length)] });
    if (rng.Next(3) == 0)
    {
        it.IntValues["370"] = rng.Next(0, 12);
        it.IntValues["374"] = rng.Next(0, 12);
        it.IntValues["379"] = rng.Next(0, 12);
    }
    Add($"grind-random-{i:00}", new[] { "grind", "vtank:mixed" },
        "Randomized item vs the fixed 5-rule grind profile; jsMinValue approximates only the value-floor rule (15000). Divergences isolate the predicate planes JS lacks.",
        VIn(it, Char135(), GrindProfile()),
        jsMinValue: 15000,
        jsGap: "SpellNameMatch/TotalRatingsGE/MinDamageGE/DisabledRule/salvage planes");
}

// ── write fixtures.json ─────────────────────────────────────────────────────
var root = new JsonObject
{
    ["meta"] = new JsonObject
    {
        ["generator"] = "LootScoring.Fixtures (netwasm-spike lift slice 3)",
        ["seed"] = SEED,
        ["count"] = scenarios.Count,
        ["contract"] = "expected = C# LootScoring.Evaluate via EvaluateLootJson (the wasm boundary)",
        ["jsCounterpart"] = "apps/holtburger-web/rynth/loot_loop.js LOOT-state value gate (loot_loop.js:159-173)",
    },
    ["scenarios"] = new JsonArray(scenarios.ToArray()),
};
File.WriteAllText(outPath, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine($"wrote {scenarios.Count} scenarios -> {outPath}");
