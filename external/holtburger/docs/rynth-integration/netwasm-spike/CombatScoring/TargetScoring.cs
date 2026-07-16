// CombatScoring — first real .NET-wasm lift slice (netwasm-spike follow-up).
//
// The PURE target-scoring/selection core of RynthAi's CombatManager, lifted
// with C# semantics intact and every host dependency replaced by plain input
// DTOs. One selection tick = one pure state-transition:
//
//     (world snapshot, lock state, nowMs)  ->  (selection, new lock state)
//
// Lifted functions and their sources (all lines = Combat/CombatManager.cs in
// ~/rynthnav-inputs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/):
//   - ScanNearbyTargets filter chain (T2)          :574-653
//   - scan sort (T6)                               :657-662
//   - ScoreCandidate (T7/T8)                       :2212-2233
//   - HandleCombatTrigger lock+stickiness (T9)     :2170-2210
//   - Think target validation + scan grace (T10-12):1719-1783, DropTarget :1236-1246
//   - DisengageDistance hysteresis (T3)            :403-406, :621-622
//   - recently-killed suppression (T13)            :224-235, :608
//   - ProjectileNames (T5)                         :787-853
//
// Deliberately preserved quirks (do NOT "fix" without a ruling):
//   - GetHealthRatio returns -1 for "no update yet" (WorldObjectCache.cs:206);
//     the scan filter only excludes ==0, and ScoreCandidate clamps -1 to 0,
//     so an unknown-HP mob receives the FULL 50-point wounded bonus.
//   - Monster-rule priority uses FirstOrDefault — first rule in LIST ORDER
//     wins, not the best-matching rule (:2228-2231).
//   - The T10 scan grace only holds the lock when NO scanned alternative
//     exists; HandleCombatTrigger re-locks immediately when the locked target
//     is absent from the scan but another candidate is present (the locked
//     target simply isn't in the argmax to receive its +25).

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RynthNetwasm.CombatScoring;

// ── input DTOs (host state replaced by data) ────────────────────────────────

public sealed class MonsterRule
{
    public string Name = "";
    public int Priority = 1;
}

public sealed class ScoringConfig
{
    public double MonsterRange = 50.0;          // settings default (report 11 §7)
    public double MonsterDisengageRange = 0.0;  // 0 -> MonsterRange+3 (:403-406)
    public List<MonsterRule> MonsterRules = new();
}

public sealed class PlayerPose
{
    public bool HasPose = true;   // TryGetPlayerPose success (angle source only)
    public uint ObjCellId;
    public double X, Y, Z;        // landblock-local, AC Z-up
    public double QW = 1.0, QZ;   // z-rotation quaternion (heading source, :565-566)
}

public sealed class EntityState
{
    public int Id;
    public string Name = "";
    public int ObjectClass;        // AcObjectClass; 5 = Monster (AcGameEnums.cs:15)
    public bool IsPlayer;          // JS-side player filter input; C# path uses ObjectClass
    public int ItemType = 16;      // JS-side prop-1 filter input (ITEM_TYPE_CREATURE)
    public bool HasPosition = true;
    public uint ObjCellId;
    public double X, Y, Z;         // landblock-local, AC Z-up
    public float HealthRatio = -1f; // -1 = no update yet (WorldObjectCache.cs:206-210)
    public bool Attackable = true;
    public bool AttackableUnknown;          // T4 probe: weenie/desc-flags not yet populated.
                                            // RynthAi rules this ATTACKABLE (fail-open, Review §1.2-1.3);
                                            // webhost.js:346-349 fails CLOSED (flags unknown -> false).
    public bool HostHasIsAttackable = true; // T4: capability-absent host -> default attackable (:610)
    public bool LosBlocked;
    public bool Blacklisted;
    public bool UserNeverAttack;
    public double KilledMsAgo = -1; // >=0: a kill signal arrived this long ago; each impl applies its own TTL
}

public sealed class LockState
{
    public int LockedTargetId;
    public int ActiveTargetId;
    public double TargetLostScanAtMs = -1; // -1 == DateTime.MinValue (grace not armed)
}

public sealed class ScoringInput
{
    public double NowMs;
    public int PlayerId;
    public PlayerPose Player = new();
    public ScoringConfig Config = new();
    public LockState Lock = new();
    public List<EntityState> Entities = new();
}

// ── output DTOs ─────────────────────────────────────────────────────────────

public sealed class ScannedEntry
{
    public int Id;
    public string Name = "";
    public double Distance;
    public double Angle;   // absolute facing error, degrees; 180 = unknown
    public double Score;   // ScoreCandidate value (stickiness NOT included)
}

public sealed class ExclusionEntry
{
    public int Id;
    public string Rule = ""; // T2 exclusion class tag
}

public sealed class ScoringOutput
{
    public int SelectedTargetId;   // activeTargetId after the tick (0 = none)
    public int LockedTargetId;
    public bool Switched;          // HandleCombatTrigger changed the lock this tick
    public string? DropReason;     // set when a DropTarget fired this tick
    public double TargetLostScanAtMs = -1; // grace state to carry into the next tick
    public List<ScannedEntry> Scanned = new();
    public List<ExclusionEntry> Excluded = new();
}

// ── the lifted logic ────────────────────────────────────────────────────────

public static class TargetScoring
{
    // CombatManager.cs constants (report 11 §7 verified against source)
    public const double TARGET_SWITCH_STICKINESS = 25.0;      // :344
    public const double TARGET_SCAN_GRACE_MS = 1500.0;        // :159
    public const double RECENTLY_KILLED_SUPPRESS_MS = 4000.0; // :234 (confirmed-kill TTL; predicted-swap uses 2000)
    private const int OBJECT_CLASS_MONSTER = 5;               // AcGameEnums.cs:15

    // ProjectileNames — verbatim union of SpellShapes + VoidSpellShapes
    // (CombatManager.cs:787-796, :828-831, built at :842-851). T5.
    private static readonly HashSet<string> ProjectileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Flame Arc", "Ring of Fire", "Flame Streak", "Flame Bolt",
        "Frost Arc", "Frost Ring", "Frost Streak", "Frost Bolt",
        "Lightning Arc", "Shock Ring", "Lightning Streak", "Shock Wave",
        "Acid Arc", "Acid Ring", "Acid Streak", "Acid Stream",
        "Blade Arc", "Blade Ring", "Blade Streak", "Whirling Blade",
        "Force Arc", "Force Ring", "Force Streak", "Force Bolt",
        "Bludgeoning Arc", "Bludgeoning Ring", "Bludgeoning Streak",
        "Nether Arc", "Nether Ring", "Nether Streak", "Nether Bolt",
        "Corrosion Arc", "Corrosion Ring", "Corrosion Streak",
    };

    private static bool IsSpellProjectileName(string? name)
        => !string.IsNullOrEmpty(name) && ProjectileNames.Contains(name); // :852-853

    // :403-406
    private static double DisengageDistance(ScoringConfig c)
        => c.MonsterDisengageRange > c.MonsterRange ? c.MonsterDisengageRange : c.MonsterRange + 3;

    // WorldObjectCache.Distance (:887-909): 3D, landblock-local -> global (192m blocks).
    private static double Distance(PlayerPose p, EntityState e)
    {
        if (!e.HasPosition) return double.MaxValue;
        double gx1 = ((p.ObjCellId >> 24) & 0xFF) * 192.0 + p.X;
        double gy1 = ((p.ObjCellId >> 16) & 0xFF) * 192.0 + p.Y;
        double gx2 = ((e.ObjCellId >> 24) & 0xFF) * 192.0 + e.X;
        double gy2 = ((e.ObjCellId >> 16) & 0xFF) * 192.0 + e.Y;
        double dx = gx1 - gx2, dy = gy1 - gy2, dz = p.Z - e.Z;
        return Math.Sqrt(dx * dx + dy * dy + dz * dz);
    }

    // ScanNearbyTargets angle math (:559-567, :643-652).
    private static double Angle(PlayerPose p, EntityState e)
    {
        if (!p.HasPose || !e.HasPosition) return 180.0;
        double physYaw = 2.0 * Math.Atan2(p.QZ, p.QW) * (180.0 / Math.PI);
        double playerHeadingDeg = ((-physYaw) % 360.0 + 720.0) % 360.0;
        double desired = Math.Atan2(e.X - p.X, e.Y - p.Y) * (180.0 / Math.PI);
        if (desired < 0) desired += 360.0;
        double err = desired - playerHeadingDeg;
        while (err > 180.0) err -= 360.0;
        while (err < -180.0) err += 360.0;
        return Math.Abs(err);
    }

    private struct ScannedTarget // :346-352
    {
        public int Id;
        public double Distance;
        public double Angle;
        public string Name;
    }

    // ScoreCandidate (:2212-2233), verbatim math.
    private static double ScoreCandidate(in ScannedTarget c, float hpRatio, ScoringConfig cfg)
    {
        double maxDist = Math.Max(1.0, cfg.MonsterRange);
        double distScore = Math.Clamp((maxDist - c.Distance) / maxDist, 0.0, 1.0) * 100.0;
        double hpScore = (1.0 - Math.Clamp(hpRatio, 0f, 1f)) * 50.0;
        double threatScore = c.Distance < 3.0 ? 30.0 : 0.0;
        double facingScore = (1.0 - Math.Min(1.0, c.Angle / 180.0)) * 10.0;

        string targetName = c.Name;
        MonsterRule? rule = null; // FirstOrDefault over list order (:2228-2230)
        foreach (var r in cfg.MonsterRules)
        {
            if (!r.Name.Equals("Default", StringComparison.OrdinalIgnoreCase) &&
                targetName.IndexOf(r.Name, StringComparison.OrdinalIgnoreCase) >= 0)
            { rule = r; break; }
        }
        double priorityScore = rule != null ? Math.Max(0, rule.Priority - 1) * 5.0 : 0;

        return distScore + hpScore + threatScore + facingScore + priorityScore;
    }

    /// <summary>One selection tick — the Think() selection path (:1714-1783).</summary>
    public static ScoringOutput SelectTargetTick(ScoringInput inp)
    {
        var cfg = inp.Config;
        var outp = new ScoringOutput
        {
            SelectedTargetId = inp.Lock.ActiveTargetId,
            LockedTargetId = inp.Lock.LockedTargetId,
            TargetLostScanAtMs = inp.Lock.TargetLostScanAtMs,
        };
        var byId = new Dictionary<int, EntityState>();
        foreach (var e in inp.Entities) byId[e.Id] = e;

        double disengageLimit = DisengageDistance(cfg);

        // T11 lock-restore (:1719-1720)
        if (outp.LockedTargetId != 0 && outp.SelectedTargetId == 0)
            outp.SelectedTargetId = outp.LockedTargetId;

        // ── target validation (:1722-1740); target==null keeps the lock ──
        if (outp.SelectedTargetId != 0 && byId.TryGetValue(outp.SelectedTargetId, out var t))
        {
            if (t.Blacklisted) Drop(outp, "blacklisted");
            else if (IsSpellProjectileName(t.Name)) Drop(outp, "spell projectile (not a monster)");
            else if (t.ObjectClass != OBJECT_CLASS_MONSTER) Drop(outp, "became corpse");
            else if (t.HealthRatio == 0f) Drop(outp, "hp=0");
            else if (Distance(inp.Player, t) > disengageLimit) Drop(outp, "out of range");
        }

        // ── ScanNearbyTargets (:574-662) — T2 filter chain, order matters ──
        var scanned = new List<ScannedTarget>();
        var hpById = new Dictionary<int, float>();
        foreach (var e in inp.Entities)
        {
            if (e.Id == inp.PlayerId) continue;                            // self (:576)
            if (e.ObjectClass != OBJECT_CLASS_MONSTER)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "not-monster-class" }); continue; } // :577
            if (IsSpellProjectileName(e.Name))
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "spell-projectile" }); continue; }  // :582
            double dist = Distance(inp.Player, e);                         // :589
            if (e.UserNeverAttack)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "user-never-attack" }); continue; } // :595
            if (e.Blacklisted)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "blacklisted" }); continue; }       // :604
            if (e.KilledMsAgo >= 0 && e.KilledMsAgo < RECENTLY_KILLED_SUPPRESS_MS)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "recently-killed" }); continue; }   // :608, T13
            if (e.HostHasIsAttackable && !e.AttackableUnknown && !e.Attackable)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "not-attackable" }); continue; }    // :610; T4 unknown -> attackable (fail-open)
            if (e.HealthRatio == 0f)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "dead-not-corpse" }); continue; }   // :613
            bool isEngaged = e.Id != 0 && (e.Id == outp.SelectedTargetId || e.Id == outp.LockedTargetId);  // :621
            if (dist > (isEngaged ? Math.Max(cfg.MonsterRange, disengageLimit) : cfg.MonsterRange))
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "distance" }); continue; }          // :622, T3
            if (e.LosBlocked)
            { outp.Excluded.Add(new ExclusionEntry { Id = e.Id, Rule = "los-blocked" }); continue; }       // :637-641

            scanned.Add(new ScannedTarget { Id = e.Id, Distance = dist, Angle = Angle(inp.Player, e), Name = e.Name });
            hpById[e.Id] = e.HealthRatio;
        }

        // Sort (:657-662): closest first; tiebreak within 0.5yd by facing angle.
        scanned.Sort((a, b) =>
        {
            double dd = a.Distance - b.Distance;
            if (Math.Abs(dd) > 0.5) return dd < 0 ? -1 : 1;
            return a.Angle.CompareTo(b.Angle);
        });

        foreach (var c in scanned)
            outp.Scanned.Add(new ScannedEntry
            {
                Id = c.Id, Name = c.Name, Distance = c.Distance, Angle = c.Angle,
                Score = ScoreCandidate(c, hpById[c.Id], cfg),
            });

        // ── HandleCombatTrigger (:2170-2200) — utility argmax + stickiness ──
        if (scanned.Count > 0)
        {
            int bestId = 0;
            double bestScore = double.MinValue;
            foreach (var c in scanned)
            {
                double s = ScoreCandidate(c, hpById[c.Id], cfg);
                if (c.Id == outp.LockedTargetId) s += TARGET_SWITCH_STICKINESS; // :2182
                if (s > bestScore) { bestScore = s; bestId = c.Id; }
            }
            if (bestId != 0 && bestId != outp.LockedTargetId)               // :2186
            {
                outp.SelectedTargetId = bestId;                             // :2188-2189
                outp.LockedTargetId = bestId;
                outp.Switched = true;
            }
        }

        // ── idle / scan-grace (:1746-1783) ──
        if (outp.SelectedTargetId == 0) return outp; // idle (peace-swap not modeled)

        bool stillScanned = false;
        for (int i = 0; i < scanned.Count; i++)
            if (scanned[i].Id == outp.SelectedTargetId) { stillScanned = true; break; }
        if (!stillScanned)
        {
            if (outp.TargetLostScanAtMs < 0)
                outp.TargetLostScanAtMs = inp.NowMs;                        // :1776-1777
            if (inp.NowMs - outp.TargetLostScanAtMs > TARGET_SCAN_GRACE_MS)
                Drop(outp, "scan grace expired");                           // :1779-1780, T10
            return outp;
        }
        outp.TargetLostScanAtMs = -1;                                       // :1783
        return outp;
    }

    // DropTarget (:1236-1246), selection-relevant subset.
    private static void Drop(ScoringOutput o, string reason)
    {
        o.SelectedTargetId = 0;
        o.LockedTargetId = 0;
        o.TargetLostScanAtMs = -1;
        o.DropReason = reason;
    }

    // ── single JSON boundary (the [JSExport] surface calls this) ──
    public static string ScoreTargetsJson(string inputJson)
    {
        var inp = JsonSerializer.Deserialize(inputJson, ScoringJsonContext.Default.ScoringInput)
                  ?? throw new ArgumentException("null ScoringInput");
        var outp = SelectTargetTick(inp);
        return JsonSerializer.Serialize(outp, ScoringJsonContext.Default.ScoringOutput);
    }
}

// Source-generated JSON (trim/AOT-safe for the wasm publish). IncludeFields is
// REQUIRED — the DTOs use fields and System.Text.Json silently drops fields
// without it (the known trap).
[JsonSourceGenerationOptions(IncludeFields = true, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(ScoringInput))]
[JsonSerializable(typeof(ScoringOutput))]
internal partial class ScoringJsonContext : JsonSerializerContext
{
}
