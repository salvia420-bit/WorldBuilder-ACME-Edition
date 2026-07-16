// LootScoring — third .NET-wasm lift slice (netwasm-spike follow-up).
//
// The PURE loot rule-evaluation core of RynthAi, lifted with C# semantics
// intact and every host dependency replaced by plain input DTOs. One
// evaluation = one pure single-call function (no clock, no state machine):
//
//     (item property bag, character context, loot profile)  ->  verdict
//
// Lifted functions and their sources (paths relative to
// /mnt/wbterminal1/ac-refs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/):
//   - VTank rule matcher + all 31 node types      Loot/VTankLootEvaluator.cs:140-332
//   - VTank character/host context semantics      Loot/VTankLootEvaluator.cs:16-131 (VTankLootContext)
//   - native (SDK) condition evaluator            Loot/LootEvaluator.cs:10-75
//   - first-match classification + verdict shape  CorpseOpenController.cs:1373-1424 (ClassifyItemAgainstProfile)
//   - regex cache semantics (bad pattern => null) Meta/RegexCache.cs:18-49
//   - CharacterSkills stub/fallback semantics     Combat/AcStubs.cs:322-453
//   - item.Values(key, default) property reads    Combat/AcStubs.cs:104-114
//   - VTank action codes / DisabledRule contract  ../../Shared/RynthCore.LootSdk/VTank/VTankLootProfile.cs:6-13,:87-105
//   - node type ids                               ../../Shared/RynthCore.LootSdk/VTank/VTankNodeTypes.cs:10-40
//
// Deliberately preserved quirks (do NOT "fix" without a ruling):
//   - VTank DamagePercentGE returns false UNCONDITIONALLY
//     (VTankLootEvaluator.cs:172, mirrors VTank source) while the native
//     DamagePercentGECondition really computes DamageMod*100 >= value
//     (LootEvaluator.cs:28) — same predicate name, opposite semantics.
//   - VTank MinDamageGE returns false when MAX_DAMAGE (int 54) is 0
//     (VTankLootEvaluator.cs:254-255); the native MinDamageGECondition has no
//     zero guard, so maxDamage=0 evaluates 0 >= value (LootEvaluator.cs:69-74).
//   - Any exception inside a VTank rule's condition loop (unknown node type,
//     unparseable data line) fails THAT RULE only (:145-158 try/catch); the
//     profile scan continues with the next rule.
//   - A bad/empty regex pattern in the VTank path caches null => no match
//     (RegexCache.cs:29,:37-39); the native StringValueCondition constructs
//     the Regex directly and a bad pattern THROWS out of Classify
//     (LootEvaluator.cs:58 has no catch) — surfaced here as Verdict="error".
//   - MatchSlotExactPalette parses its data lines BEFORE the ctx-null
//     optimistic return (:263-265), so a bad slot line fails the rule even
//     with no character context; CharacterSkillGE short-circuits on null ctx
//     BEFORE parsing (:184) — the null-ctx/parse order differs per node type
//     and is preserved condition-by-condition.
//   - Rule priority is parsed and carried but NOT used for ordering — the
//     profile scan is strict list order, first match wins
//     (CorpseOpenController.cs:1398-1406; VTankLootProfile.cs:66-68).
//   - VTank ctx GetSkill defaults to (0,0) when the host read fails
//     (VTankLootEvaluator.cs / VTankLootContext.GetSkill:33-42), but the
//     native path's CharacterSkills indexer falls back to a "capable stub"
//     (training=2, buffed=250) on a failed read (AcStubs.cs:346-405) — the
//     two evaluators have DIFFERENT unknown-skill defaults.
//
// Out of scope (documented, not modeled): the ManaStone consumable override
// and mana-tap fallback (CorpseOpenController.cs:1305-1414) — stateful
// inventory-count logic layered AROUND the pure rule evaluation; KeepUpTo
// keep-count tallies (only ManaStone rules enforce a count in the source).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace RynthNetwasm.LootScoring;

// ── input DTOs (host state replaced by data) ────────────────────────────────

/// <summary>One spell on the item: id + resolved name. Replaces
/// Host.GetObjectSpellIds + SpellTableStub.GetById name resolution
/// (VTankLootContext.cs:97-128). Name = "" when the spell table had no entry
/// (SpellTableStub miss => info?.Name ?? string.Empty, :123-124).</summary>
public sealed class SpellEntry
{
    public long Id;
    public string Name = "";
}

/// <summary>Wide item property bag — replaces WorldObject + WorldObjectCache
/// property reads (AcStubs.cs:104-114). Bags are keyed by SType property id
/// (stringified for JSON); a missing key reads as the caller's default,
/// exactly like Cache.Get*Property miss.</summary>
public sealed class ItemState
{
    public int Id;
    public string Name = "";
    public int ObjectClass;                                  // AcObjectClass (AcGameEnums.cs:8-56)
    public Dictionary<string, int> IntValues = new();        // STypeInt id -> value
    public Dictionary<string, double> DoubleValues = new();  // STypeFloat id -> value
    public Dictionary<string, string> StringValues = new();  // STypeString id -> value
    public Dictionary<string, bool> BoolValues = new();      // STypeBool id -> value (wideness; no lifted rule reads bools)
    public Dictionary<string, long> DataValues = new();      // STypeDID id -> value (wideness; no lifted rule reads dataIds)
    public List<SpellEntry> Spells = new();
    public bool HostHasSpellIds = true;   // Host.HasGetObjectSpellIds (VTankLootContext.cs:101)
    public bool HostHasPalettes = true;   // Host.HasGetObjectPalettes (VTankLootContext.cs:82)
    public List<long> PaletteSubIds = new(); // GetObjectPalettes subIds; offsets unused by the evaluator (:266)
}

/// <summary>(Buffed, Base) skill pair — VTankLootContext.GetSkill result
/// (VTankLootContext.cs:33-42; "Base" == training proxy, :39).</summary>
public sealed class SkillEntry
{
    public int Buffed;
    public int Base;
}

/// <summary>Character-side context. null LootInput.Character == null
/// VTankLootContext / null CharacterSkills — several conditions then pass
/// optimistically (VTankLootEvaluator.cs:174,:184-188; LootEvaluator.cs:29).</summary>
public sealed class CharacterState
{
    public int Level;               // STypeInt 25 read (VTankLootContext.cs:44-53)
    public int MainPackEmptySlots;  // replaces the 102-minus-used inventory walk (VTankLootContext.cs:55-74)
    public Dictionary<string, SkillEntry> Skills = new(); // STypeSkill id -> skill; missing => VTank (0,0), native stub (2,250)
}

public sealed class VtankCondition
{
    public int NodeType;                     // VTankNodeTypes.cs:10-40
    public List<string> DataLines = new();   // VTankLootProfile.cs:28-34
}

public sealed class VtankRule
{
    public string Name = "";
    public int Priority;                     // preserved, NOT used for ordering (VTankLootProfile.cs:66-68)
    public int Action = 1;                   // VTankLootAction: 1 Keep, 2 Salvage, 3 Sell, 4 Read, 10 KeepUpTo (VTankLootProfile.cs:6-13)
    public int? KeepCount;
    public List<VtankCondition> Conditions = new();
}

public sealed class VtankProfile
{
    public List<VtankRule> Rules = new();
}

/// <summary>Flattened union of the 13 typed LootCondition subclasses
/// (LootModel.cs:21-80); T carries the JsonPolymorphic discriminator name.</summary>
public sealed class NativeCondition
{
    public string T = "";        // ObjectClass|LongGE|LongLE|LongE|LongNE|LongFlag|DoubleGE|DoubleLE|String|TotalRatingsGE|MinDamageGE|DmgPctGE|SkillGE
    public int Key;
    public int IntValue;
    public double DoubleValue;
    public string Pattern = "";
    public int ObjectClass;
    public int Skill;            // AcSkillType (AcGameEnums.cs:188-199)
    public int FlagValue;
}

public sealed class NativeRule
{
    public string Name = "";
    public bool Enabled = true;              // LootEvaluator.cs:35 gate
    public string Action = "Keep";           // LootAction enum name (LootModel.cs:10-17)
    public int KeepCount = 1;
    public List<NativeCondition> Conditions = new();
}

public sealed class NativeProfile
{
    public List<NativeRule> Rules = new();
}

public sealed class LootInput
{
    public ItemState Item = new();
    public CharacterState? Character;   // null => ctx-null / skills-null optimistic paths
    public VtankProfile? Vtank;         // exactly one of Vtank / Native should be set
    public NativeProfile? Native;
}

// ── output DTOs ─────────────────────────────────────────────────────────────

/// <summary>Per-rule reason row: why each rule up to the match did/didn't fire.</summary>
public sealed class RuleTrace
{
    public int Index;
    public string Name = "";
    public bool Matched;
    public int FirstFailedCondition = -1;   // index into the rule's condition list
    public string FailedCondition = "";     // "nodeType N" / native T / "exception X" / "disabled"
}

public sealed class LootOutput
{
    public string Verdict = "no-loot";  // "keep" | "salvage" | "no-loot" | "error"
    public bool Matched;
    public int RuleIndex = -1;
    public string RuleName = "";
    public string Action = "";          // matched rule's action name ("" when unmatched — Classify's (Sell,null) is ignored by the caller, CorpseOpenController.cs:1373-1379)
    public bool IsSalvage;
    public List<RuleTrace> Trace = new();
    public string? Error;               // exception TYPE name when Verdict=="error" (kept message-free for wasm/native byte parity)
}

// ── the lifted logic ────────────────────────────────────────────────────────

public static class LootScoring
{
    // VTankNodeTypes.cs:10-40
    private const int SpellNameMatch = 0;
    private const int StringValueMatch = 1;
    private const int LongValKeyLE = 2;
    private const int LongValKeyGE = 3;
    private const int DoubleValKeyLE = 4;
    private const int DoubleValKeyGE = 5;
    private const int DamagePercentGE = 6;
    private const int ObjectClassNode = 7;
    private const int SpellCountGE = 8;
    private const int SpellMatch = 9;
    private const int MinDamageGE = 10;
    private const int LongValKeyFlagExists = 11;
    private const int LongValKeyE = 12;
    private const int LongValKeyNE = 13;
    private const int AnySimilarColor = 14;
    private const int SimilarColorArmorType = 15;
    private const int SlotSimilarColor = 16;
    private const int SlotExactPalette = 17;
    private const int CharacterSkillGE = 1000;
    private const int CharacterMainPackEmptySlotsGE = 1001;
    private const int CharacterLevelGE = 1002;
    private const int CharacterLevelLE = 1003;
    private const int CharacterBaseSkill = 1004;
    private const int BuffedMedianDamageGE = 2000;
    private const int BuffedMissileDamageGE = 2001;
    private const int BuffedLongValKeyGE = 2003;
    private const int BuffedDoubleValKeyGE = 2005;
    private const int CalcdBuffedTinkedDamageGE = 2006;
    private const int TotalRatingsGE = 2007;
    private const int CalcedBuffedTinkedTargetMeleeGE = 2008;
    private const int DisabledRule = 9999;

    // LootEvaluator.cs:12 — rating STypeInt keys (370-376, 379; 377/378 excluded)
    private static readonly int[] RatingKeys = { 370, 371, 372, 373, 374, 375, 376, 379 };

    // ── property-bag reads (AcStubs.cs:104-114 Values(key, default)) ─────────

    private static string K(int key) => key.ToString(CultureInfo.InvariantCulture);

    private static int GetInt(ItemState it, int key, int def)
        => it.IntValues != null && it.IntValues.TryGetValue(K(key), out int v) ? v : def;

    private static double GetDouble(ItemState it, int key, double def)
        => it.DoubleValues != null && it.DoubleValues.TryGetValue(K(key), out double v) ? v : def;

    private static string GetString(ItemState it, int key, string def)
        => it.StringValues != null && it.StringValues.TryGetValue(K(key), out string? v) ? v : def;

    // ── VTankLootContext mirrors ─────────────────────────────────────────────

    // GetSkill (VTankLootContext.cs:33-42): failed host read => (0, 0).
    private static SkillEntry VtankSkill(CharacterState ch, int stypeSkill)
        => ch.Skills != null && ch.Skills.TryGetValue(K(stypeSkill), out SkillEntry? s) && s != null
            ? s : new SkillEntry { Buffed = 0, Base = 0 };

    // GetItemSpellIds gated on Host.HasGetObjectSpellIds (VTankLootContext.cs:100-111).
    private static List<SpellEntry> Spells(ItemState it)
        => it.HostHasSpellIds ? (it.Spells ?? new List<SpellEntry>()) : new List<SpellEntry>();

    // GetItemPalettes gated on Host.HasGetObjectPalettes (VTankLootContext.cs:78-95).
    private static List<long> Palettes(ItemState it)
        => it.HostHasPalettes ? (it.PaletteSubIds ?? new List<long>()) : new List<long>();

    // ── regex cache (Meta/RegexCache.cs:18-49) ───────────────────────────────
    // Interpreter instances cached by (pattern, options); a bad OR EMPTY
    // pattern caches/returns null and callers treat null as "no match".

    private static readonly Dictionary<(string, RegexOptions), Regex?> RxCache = new();

    private static Regex? CachedRegex(string pattern, RegexOptions options)
    {
        if (string.IsNullOrEmpty(pattern)) return null;                 // RegexCache.cs:29
        var key = (pattern, options);
        if (RxCache.TryGetValue(key, out Regex? hit)) return hit;
        Regex? rx;
        try { rx = new Regex(pattern, options | RegexOptions.CultureInvariant); } // :37
        catch { rx = null; }                                            // :38 bad pattern => null => no match
        RxCache[key] = rx;
        return rx;
    }

    private static bool CachedIsMatch(string input, string pattern, RegexOptions options)
    {
        Regex? rx = CachedRegex(pattern, options);                      // RegexCache.cs:43-49
        if (rx is null) return false;
        try { return rx.IsMatch(input ?? ""); }
        catch { return false; }
    }

    // ── data-line parse helpers (VTankLootEvaluator.cs:319-331) ──────────────

    private static int ReadInt(IList<string> d, int idx)
        => int.Parse(d[idx], NumberStyles.Integer, CultureInfo.InvariantCulture);          // :321-322

    private static double ReadDouble(IList<string> d, int idx)
        => double.Parse(d[idx], NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture); // :324-325

    // ── VTank condition dispatch (VTankLootEvaluator.cs:161-198) ─────────────

    private static bool MatchVtankCondition(VtankCondition cond, ItemState item, CharacterState? ctx)
    {
        List<string> d = cond.DataLines ?? new List<string>();
        switch (cond.NodeType)
        {
            case SpellNameMatch:            // :166
                return MatchSpellNameMatch(item, ctx, d);
            case StringValueMatch:          // :167
                return MatchStringValue(item, d);
            case LongValKeyLE:              // :168 — (value, key) pair, Long(d) (:328)
                return GetInt(item, ReadIntKey(d), 0) <= ReadInt(d, 0);
            case LongValKeyGE:              // :169
                return GetInt(item, ReadIntKey(d), 0) >= ReadInt(d, 0);
            case DoubleValKeyLE:            // :170 — Double(d) (:329)
                return GetDouble(item, ReadIntKey(d), 0.0) <= ReadDouble(d, 0);
            case DoubleValKeyGE:            // :171
                return GetDouble(item, ReadIntKey(d), 0.0) >= ReadDouble(d, 0);
            case DamagePercentGE:           // :172 — VTank source returns false unconditionally
                return false;
            case ObjectClassNode:           // :173
                return item.ObjectClass == ReadInt(d, 0);
            case SpellCountGE:              // :174 — null ctx short-circuits BEFORE parsing
                return ctx is null || Spells(item).Count >= ReadInt(d, 0);
            case SpellMatch:                // :175
                return MatchSpellMatch(item, ctx, d);
            case MinDamageGE:               // :176
                return MatchMinDamageGE(item, d);
            case LongValKeyFlagExists:      // :177 — (flag, key)
                return (GetInt(item, ReadIntKey(d), 0) & ReadInt(d, 0)) != 0;
            case LongValKeyE:               // :178
                return GetInt(item, ReadIntKey(d), 0) == ReadInt(d, 0);
            case LongValKeyNE:              // :179
                return GetInt(item, ReadIntKey(d), 0) != ReadInt(d, 0);
            case AnySimilarColor:           // :180 — needs portal.dat, optimistic true
            case SimilarColorArmorType:     // :181
            case SlotSimilarColor:          // :182
                return true;
            case SlotExactPalette:          // :183
                return MatchSlotExactPalette(item, ctx, d);
            case CharacterSkillGE:          // :184 — null ctx short-circuits BEFORE parsing
                return ctx is null || VtankSkill(ctx, ReadInt(d, 1)).Buffed >= ReadInt(d, 0);
            case CharacterMainPackEmptySlotsGE: // :185
                return ctx is null || ctx.MainPackEmptySlots >= ReadInt(d, 0);
            case CharacterLevelGE:          // :186
                return ctx is null || ctx.Level >= ReadInt(d, 0);
            case CharacterLevelLE:          // :187
                return ctx is null || ctx.Level <= ReadInt(d, 0);
            case CharacterBaseSkill:        // :188
                return MatchCharacterBaseSkill(ctx, d);
            case BuffedMedianDamageGE:      // :189
                return MatchBuffedMedianDamageGE(item, d);
            case BuffedMissileDamageGE:     // :190
                return MatchBuffedMissileDamageGE(item, d);
            case BuffedLongValKeyGE:        // :191 — DoubleKey(d) (:331): double threshold vs int key
                return GetInt(item, ReadIntKey(d), 0) >= ReadDouble(d, 0);
            case BuffedDoubleValKeyGE:      // :192
                return GetDouble(item, ReadIntKey(d), 0.0) >= ReadDouble(d, 0);
            case CalcdBuffedTinkedDamageGE: // :193 — raw int 54 vs double threshold
                return GetInt(item, 54, 0) >= ReadDouble(d, 0);
            case TotalRatingsGE:            // :194
                return MatchTotalRatingsGE(item, d);
            case CalcedBuffedTinkedTargetMeleeGE: // :195 — not implemented, false
                return false;
            case DisabledRule:              // :196
                return MatchDisabledRule(d);
            default:                        // :197
                throw new InvalidOperationException($"Unsupported VTank loot node type {cond.NodeType}.");
        }
    }

    // Long()/Double()/DoubleKey() all read the KEY from slot 1 (:328-331).
    private static int ReadIntKey(IList<string> d) => ReadInt(d, 1);

    // MatchSpellNameMatch (:212-220): null ctx => optimistic true BEFORE the
    // regex is built (so a bad pattern with no ctx still passes).
    private static bool MatchSpellNameMatch(ItemState item, CharacterState? ctx, IList<string> d)
    {
        if (ctx is null) return true;                                   // :214
        Regex? rx = CachedRegex(d[0], RegexOptions.IgnoreCase);         // :215
        if (rx is null) return false;                                   // :216
        foreach (SpellEntry sp in Spells(item))                         // :217 (GetItemSpellNames)
            if (!string.IsNullOrEmpty(sp.Name) && rx.IsMatch(sp.Name)) return true; // :218
        return false;                                                   // :219
    }

    // MatchStringValue (:222-228) — no ctx involvement.
    private static bool MatchStringValue(ItemState item, IList<string> d)
    {
        string pattern = d[0];                                          // :224
        int key = ReadInt(d, 1);                                        // :225
        string value = GetString(item, key, string.Empty);              // :226
        return CachedIsMatch(value, pattern, RegexOptions.IgnoreCase);  // :227
    }

    // MatchSpellMatch (:230-249): positive rx null => false; count of names
    // matching pos and NOT neg must reach d[2].
    private static bool MatchSpellMatch(ItemState item, CharacterState? ctx, IList<string> d)
    {
        if (ctx is null) return true;                                   // :232
        string pos = d[0];                                              // :233
        string neg = d[1];                                              // :234
        int count = ReadInt(d, 2);                                      // :235
        Regex? rxPos = CachedRegex(pos, RegexOptions.IgnoreCase);       // :236
        if (rxPos is null) return false;                                // :237
        Regex? rxNeg = string.IsNullOrWhiteSpace(neg)
            ? null
            : CachedRegex(neg, RegexOptions.IgnoreCase);                // :238-240
        int c = 0;
        foreach (SpellEntry sp in Spells(item))                         // :242
        {
            string name = sp.Name;
            if (string.IsNullOrEmpty(name)) continue;                   // :244
            if (rxPos.IsMatch(name) && (rxNeg is null || !rxNeg.IsMatch(name)))
                if (++c >= count) return true;                          // :245-246
        }
        return false;                                                   // :248
    }

    // MatchMinDamageGE (:251-259): maxDamage==0 => false (unlike the native path).
    private static bool MatchMinDamageGE(ItemState item, IList<string> d)
    {
        double threshold = ReadDouble(d, 0);                            // :253
        int maxDamage = GetInt(item, 54, 0);                            // :254
        if (maxDamage == 0) return false;                               // :255
        double variance = GetDouble(item, 22, 0.0);                     // :256 (DoubleValueKey.DamageVariance = 22, AcStubs.cs:49)
        double minDamage = maxDamage - (variance * maxDamage);          // :257
        return minDamage >= threshold;                                  // :258
    }

    // MatchSlotExactPalette (:261-271): parses BEFORE the ctx-null return;
    // no palettes => optimistic true; slot out of range => false; low 24 bits compare.
    private static bool MatchSlotExactPalette(ItemState item, CharacterState? ctx, IList<string> d)
    {
        int slot = ReadInt(d, 0);                                       // :263
        uint targetPaletteId = (uint)ReadInt(d, 1);                     // :264
        if (ctx is null) return true;                                   // :265
        List<long> subIds = Palettes(item);                             // :266
        if (subIds.Count == 0) return true;                             // :267
        if (slot < 0 || slot >= subIds.Count) return false;             // :268
        uint actual = (uint)subIds[slot];                               // :269
        return (actual & 0x00FFFFFFu) == (targetPaletteId & 0x00FFFFFFu); // :270
    }

    // MatchCharacterBaseSkill (:273-281): parses all three lines, THEN ctx-null true.
    private static bool MatchCharacterBaseSkill(CharacterState? ctx, IList<string> d)
    {
        int skillId = ReadInt(d, 0);                                    // :275
        int min = ReadInt(d, 1);                                        // :276
        int max = ReadInt(d, 2);                                        // :277
        if (ctx is null) return true;                                   // :278
        int baseVal = VtankSkill(ctx, skillId).Base;                    // :279
        return baseVal >= min && baseVal <= max;                        // :280
    }

    // MatchBuffedMedianDamageGE (:283-291).
    private static bool MatchBuffedMedianDamageGE(ItemState item, IList<string> d)
    {
        double threshold = ReadDouble(d, 0);                            // :285
        int maxDamage = GetInt(item, 54, 0);                            // :286
        if (maxDamage == 0) return false;                               // :287
        double variance = GetDouble(item, 22, 0.0);                     // :288
        double minDamage = maxDamage - (variance * maxDamage);          // :289
        return (minDamage + maxDamage) / 2.0 >= threshold;              // :290
    }

    // MatchBuffedMissileDamageGE (:293-301): elemental bonus (float 152)
    // defaults 1.0 and clamps up to 1.0.
    private static bool MatchBuffedMissileDamageGE(ItemState item, IList<string> d)
    {
        double threshold = ReadDouble(d, 0);                            // :295
        int maxDamage = GetInt(item, 54, 0);                            // :296
        if (maxDamage == 0) return false;                               // :297
        double elemBonus = GetDouble(item, 152, 1.0);                   // :298
        if (elemBonus < 1.0) elemBonus = 1.0;                           // :299
        return maxDamage * elemBonus >= threshold;                      // :300
    }

    // MatchTotalRatingsGE (:303-310): int keys 370-376 + 379 (377/378 skipped).
    private static bool MatchTotalRatingsGE(ItemState item, IList<string> d)
    {
        double threshold = ReadDouble(d, 0);                            // :305
        int total =
            GetInt(item, 370, 0) + GetInt(item, 371, 0) + GetInt(item, 372, 0) + GetInt(item, 373, 0) +
            GetInt(item, 374, 0) + GetInt(item, 375, 0) + GetInt(item, 376, 0) + GetInt(item, 379, 0); // :306-308
        return total >= threshold;                                      // :309
    }

    // MatchDisabledRule (:312-317): "true" (trimmed, case-insensitive) disables.
    private static bool MatchDisabledRule(IList<string> d)
    {
        string raw = d.Count > 0 ? d[0] : "false";                      // :314
        bool isDisabled = string.Equals(raw.Trim(), "true", StringComparison.OrdinalIgnoreCase); // :315
        return !isDisabled;                                             // :316
    }

    // ── VTank rule matcher (VTankLootEvaluator.cs:140-159) ───────────────────

    private static bool MatchVtankRule(VtankRule rule, ItemState item, CharacterState? ctx, RuleTrace trace)
    {
        List<VtankCondition> conds = rule.Conditions ?? new List<VtankCondition>();
        if (conds.Count == 0) { trace.Matched = true; return true; }    // :143 unconditional rule
        int i = -1;
        try                                                             // :145
        {
            for (i = 0; i < conds.Count; i++)                           // :148
            {
                if (!MatchVtankCondition(conds[i], item, ctx))          // :150
                {
                    trace.FirstFailedCondition = i;
                    trace.FailedCondition = $"nodeType {conds[i].NodeType}";
                    return false;                                       // :151
                }
            }
            trace.Matched = true;
            return true;                                                // :153
        }
        catch (Exception ex)                                            // :155-158 — any throw fails the rule
        {
            trace.FirstFailedCondition = i;
            trace.FailedCondition = $"exception {ex.GetType().Name} (nodeType {(i >= 0 && i < conds.Count ? conds[i].NodeType : -1)})";
            return false;
        }
    }

    // VTankLootAction names (VTankLootProfile.cs:6-13).
    private static string VtankActionName(int action) => action switch
    {
        1 => "Keep",
        2 => "Salvage",
        3 => "Sell",
        4 => "Read",
        10 => "KeepUpTo",
        _ => action.ToString(CultureInfo.InvariantCulture),
    };

    // First-match profile scan (CorpseOpenController.cs:1394-1424).
    private static LootOutput EvaluateVtank(VtankProfile profile, ItemState item, CharacterState? ctx)
    {
        var outp = new LootOutput();
        List<VtankRule> rules = profile.Rules ?? new List<VtankRule>();
        VtankRule? matched = null;
        int matchedIndex = -1;
        for (int ri = 0; ri < rules.Count; ri++)                        // :1398
        {
            var trace = new RuleTrace { Index = ri, Name = rules[ri].Name ?? "" };
            outp.Trace.Add(trace);
            if (MatchVtankRule(rules[ri], item, ctx, trace))            // :1400
            {
                matched = rules[ri];
                matchedIndex = ri;
                break;                                                  // :1402-1404 first match wins
            }
        }
        if (matched == null)                                            // :1408 (mana-tap fallback not modeled)
            return outp;                                                // Verdict stays "no-loot"

        outp.Matched = true;
        outp.RuleIndex = matchedIndex;
        outp.RuleName = string.IsNullOrWhiteSpace(matched.Name)
            ? $"#{matchedIndex}"
            : matched.Name.Trim();                                      // :1417-1419
        outp.Action = VtankActionName(matched.Action);                  // :1420
        outp.IsSalvage = matched.Action == 2;                           // :1421 (VTankLootAction.Salvage)
        outp.Verdict = outp.IsSalvage ? "salvage" : "keep";             // matched => loot (:1422 return true)
        return outp;
    }

    // ── native (SDK) evaluator (LootEvaluator.cs:10-75) ──────────────────────

    // AcSkillType -> STypeSkill (AcStubs.cs:413-453), lifted verbatim.
    private static int AcSkillTypeToSTypeSkill(int skill) => skill switch
    {
        1 => 6,    // MeleeDefense
        2 => 7,    // MissileDefense
        3 => 15,   // MagicDefense
        4 => 32,   // ItemEnchantment
        5 => 33,   // LifeMagic
        6 => 31,   // CreatureEnchantment
        7 => 34,   // WarMagic
        8 => 43,   // VoidMagic
        9 => 44,   // HeavyWeapons
        10 => 45,  // LightWeapons
        11 => 46,  // FinesseWeapons
        12 => 41,  // TwoHandedCombat
        13 => 48,  // Shield
        14 => 49,  // DualWield
        15 => 50,  // Recklessness
        16 => 51,  // SneakAttack
        17 => 52,  // DirtyFighting
        18 => 14,  // ArcaneLore
        19 => 29,  // ArmorTinkering
        20 => 18,  // ItemTinkering
        21 => 30,  // MagicItemTinkering
        22 => 28,  // WeaponTinkering
        23 => 40,  // Salvaging
        24 => 24,  // Run
        25 => 22,  // Jump
        26 => 36,  // Loyalty
        27 => 35,  // Leadership
        28 => 20,  // Deception
        29 => 21,  // Healing
        30 => 23,  // Lockpick
        31 => 39,  // Cooking
        32 => 37,  // Fletching
        33 => 38,  // Alchemy
        34 => 16,  // ManaConversion
        35 => 27,  // AssessCreature
        36 => 19,  // AssessPerson
        37 => 54,  // Summoning
        _ => 0,
    };

    // CharacterSkills indexer collapsed to its pure shape (AcStubs.cs:342-407):
    // unmappable skill (stype 0) or failed/absent read => capable stub buffed 250;
    // a present entry is used as-is (the zero-artifact/_lastGood machinery is
    // stateful session-repair logic with no pure-input equivalent).
    private static int NativeSkillBuffed(CharacterState ch, int acSkillType)
    {
        int stype = AcSkillTypeToSTypeSkill(acSkillType);
        if (stype == 0) return 250;                                     // AcStubs.cs:350-351
        if (ch.Skills != null && ch.Skills.TryGetValue(K(stype), out SkillEntry? s) && s != null)
            return s.Buffed;                                            // :353-380 successful read
        return 250;                                                     // :396-405 read-failed capable stub
    }

    // LootEvaluator.Evaluate (LootEvaluator.cs:14-31).
    private static bool EvaluateNativeCondition(NativeCondition c, ItemState item, CharacterState? skills)
    {
        switch (c.T)
        {
            case "ObjectClass":     return item.ObjectClass == c.ObjectClass;                  // :17
            case "LongGE":          return GetInt(item, c.Key, 0) >= c.IntValue;               // :18
            case "LongLE":          return GetInt(item, c.Key, 0) <= c.IntValue;               // :19
            case "LongE":           return GetInt(item, c.Key, 0) == c.IntValue;               // :20
            case "LongNE":          return GetInt(item, c.Key, 0) != c.IntValue;               // :21
            case "LongFlag":        return (GetInt(item, c.Key, 0) & c.FlagValue) != 0;        // :22
            case "DoubleGE":        return GetDouble(item, c.Key, 0.0) >= c.DoubleValue;       // :23
            case "DoubleLE":        return GetDouble(item, c.Key, 0.0) <= c.DoubleValue;       // :24
            case "String":                                                                     // :25, :55-60
                // Direct Regex.IsMatch — NOT the cache: an empty pattern matches
                // everything and a BAD pattern THROWS (no catch anywhere up the
                // native path; surfaced by the boundary as Verdict="error").
                return Regex.IsMatch(GetString(item, c.Key, string.Empty), c.Pattern,
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            case "TotalRatingsGE":                                                             // :26, :62-67
            {
                int total = 0;
                foreach (int k in RatingKeys) total += GetInt(item, k, 0);
                return total >= c.IntValue;
            }
            case "MinDamageGE":                                                                // :27, :69-74 — NO maxDamage==0 guard
            {
                int maxDamage = GetInt(item, 54, 0);
                double variance = GetDouble(item, 22, 0.0);
                return maxDamage - variance * maxDamage >= c.DoubleValue;
            }
            case "DmgPctGE":        return GetDouble(item, 62, 0.0) * 100.0 >= c.DoubleValue;  // :28 (DamageMod = 62)
            case "SkillGE":                                                                    // :29
                return skills == null || NativeSkillBuffed(skills, c.Skill) >= c.IntValue;
            default:                return true;                                               // :30 unknown => optimistic pass
        }
    }

    // LootEvaluator.Matches (:33-39) + Classify (:45-51), with the caller's
    // null-rule => no-loot interpretation (CorpseOpenController.cs:1373-1379).
    private static LootOutput EvaluateNative(NativeProfile profile, ItemState item, CharacterState? skills)
    {
        var outp = new LootOutput();
        List<NativeRule> rules = profile.Rules ?? new List<NativeRule>();
        for (int ri = 0; ri < rules.Count; ri++)                        // Classify :48 foreach, list order
        {
            NativeRule rule = rules[ri];
            var trace = new RuleTrace { Index = ri, Name = rule.Name ?? "" };
            outp.Trace.Add(trace);
            if (!rule.Enabled)                                          // Matches :35
            {
                trace.FailedCondition = "disabled";
                continue;
            }
            bool all = true;
            List<NativeCondition> conds = rule.Conditions ?? new List<NativeCondition>();
            for (int ci = 0; ci < conds.Count; ci++)                    // Matches :36-37
            {
                if (!EvaluateNativeCondition(conds[ci], item, skills))
                {
                    trace.FirstFailedCondition = ci;
                    trace.FailedCondition = conds[ci].T;
                    all = false;
                    break;
                }
            }
            if (!all) continue;
            trace.Matched = true;                                       // Classify :49 first match wins
            outp.Matched = true;
            outp.RuleIndex = ri;
            outp.RuleName = string.IsNullOrWhiteSpace(rule.Name) ? "rule" : rule.Name.Trim(); // CorpseOpenController.cs:1383
            outp.Action = rule.Action ?? "";
            outp.IsSalvage = string.Equals(rule.Action, "Salvage", StringComparison.Ordinal); // :1382 (enum compare)
            outp.Verdict = outp.IsSalvage ? "salvage" : "keep";
            return outp;
        }
        // Classify :50 returns (LootAction.Sell, null); the caller treats the
        // null rule as no-match => leave on corpse (:1373-1379).
        return outp;
    }

    // ── entry ────────────────────────────────────────────────────────────────

    public static LootOutput Evaluate(LootInput inp)
    {
        if (inp.Vtank != null) return EvaluateVtank(inp.Vtank, inp.Item, inp.Character);
        if (inp.Native != null) return EvaluateNative(inp.Native, inp.Item, inp.Character);
        throw new ArgumentException("LootInput carries neither a Vtank nor a Native profile.");
    }

    // ── single JSON boundary (the [JSExport] surface calls this) ──
    public static string EvaluateLootJson(string inputJson)
    {
        LootOutput outp;
        try
        {
            LootInput inp = JsonSerializer.Deserialize(inputJson, LootJsonContext.Default.LootInput)
                            ?? throw new ArgumentException("null LootInput");
            outp = Evaluate(inp);
        }
        catch (Exception ex)
        {
            // The native path deliberately propagates bad-regex exceptions
            // (LootEvaluator.cs:58); across the JSON boundary that becomes an
            // "error" verdict carrying the exception TYPE name only (messages
            // can differ between runtimes; type names cannot).
            outp = new LootOutput { Verdict = "error", Error = ex.GetType().Name };
        }
        return JsonSerializer.Serialize(outp, LootJsonContext.Default.LootOutput);
    }
}

// Source-generated JSON (trim/AOT-safe for the wasm publish). IncludeFields is
// REQUIRED — the DTOs use fields and System.Text.Json silently drops fields
// without it (the known trap).
[JsonSourceGenerationOptions(IncludeFields = true, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(LootInput))]
[JsonSerializable(typeof(LootOutput))]
internal partial class LootJsonContext : JsonSerializerContext
{
}
