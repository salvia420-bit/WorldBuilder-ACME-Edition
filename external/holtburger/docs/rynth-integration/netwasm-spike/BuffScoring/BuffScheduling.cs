// BuffScoring — second .NET-wasm lift slice (netwasm-spike follow-up; the
// "next largest-value lift" recommended by the CombatScoring slice / report 15).
//
// The PURE self-buff scheduling core of RynthAi's BuffManager, lifted with C#
// semantics intact and every host dependency replaced by plain input DTOs.
// One buff heartbeat = one pure state-transition:
//
//     (registry snapshot, spell ladders, vitals, gates, scheduler state, nowMs)
//         ->  (action + chosen spell + reasons, new scheduler state)
//
// Lifted functions and their sources (all lines = Combat/BuffManager.cs in
// ~/rynthnav-inputs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/ unless noted):
//   - OnHeartbeat decision spine                          :474-715
//     login stabilization gate (B1)                       :493-519, :465-472
//     periodic 30 s re-sync (B13)                         :521-531, :463
//     pending self-buff confirm/no-show (B8/B9)           :539-599, :53-54, :156-158
//     pending armor no-chat timeout (B8 item arm)         :601-658, :46
//     cast interval + cast/busy gates (B14)               :661-684
//   - CheckVitals (B15/B16)                               :717-763
//   - AnyBuffBelowThreshold (B11 trigger)                 :814-831
//   - CheckAndCastSelfBuffs selection loop (B10/B11/B12)  :833-943
//   - IsBuffActive (B3/B4/B5/B6/B12)                      :1148-1232
//   - RecordAchievedTier (B5)                             :1251-1256
//   - GetSpellLevel (roman-tier parser)                   :1268-1294
//   - GetCustomSpellDuration (tier -> seconds)            :1302-1311
//   - RefreshFromLiveMemory registry rebuild (B2/B6)      :1318-1399
//   - IsItemEnchantment (player-vs-item registry split)   :954-974
//   - SpellManager.GetDynamicSelfBuffId tier walk         SpellManager.cs:170-209
//     + TryGetId known/blacklist semantics                SpellManager.cs:327-361
//
// Host deps replaced by data:
//   - ReadPlayerEnchantments + GetServerTime  -> Registry list (remaining at NowMs)
//   - SpellTableStub/SpellDatabase name walk  -> per-buff Ladder of SpellCandidates
//   - CharacterSkills / GetHighestBuffSpellTier -> SkillUsable + MaxTier inputs
//   - EnsureMagicMode (wand/stance machinery) -> InMagicMode input; a needed
//     flip is reported as Action="mode-switch" (and consumes the cast-interval
//     window, faithful to :1961/:2120 setting _lastCastAttempt)
//   - CastGateWatchdog.CanCastNow / BusyCount -> CanCastNow / BusyCount inputs
//   - the game clock (DateTime.Now everywhere) -> injectable NowMs (report 15's
//     clock note: no serverTime() shim needed — the caller passes now in)
//
// Deliberately preserved quirks (do NOT "fix" without a ruling):
//   - RefreshFromLiveMemory keys _ramBuffTimers by family with LAST-entry-wins
//     overwrite (:1374) — two same-family registry entries (tier overlap) keep
//     whichever came last in wire order, NOT the longest-remaining one. The JS
//     port keeps max-remaining (buff_loop.js:264-267); a probe fixture flags it.
//   - The login gate returns on the SAME tick it opens (:518) — the first cast
//     can only happen on the next heartbeat.
//   - CheckVitals' emergency/heal arms RETURN AttemptVitalCast's result
//     (:736,:757): an unresolvable vital spell (id=0) aborts the whole vitals
//     block for this tick (mana/stam arms are NOT reached from the heal arm).
//   - Vitals order is heal -> mana -> stamina (:754-760); the JS port does
//     heal -> stamina -> mana (vitals.js:129-146).
//   - Self-buff confirm tests Expiration > now (:555-556) — NOT the rebuff
//     threshold; a buff landing with < RebuffSecondsRemaining left still
//     confirms.
//   - AnyBuffBelowThreshold skips fail-cooldown-parked families (:824-827) so a
//     parked family can't retrigger the auto-batch (the /god loop fix, B10).
//   - The no-show path does NOT add the family to _forceRebuffCastFamilies
//     (:575-595) — the selector skips it via the cooldown park instead.

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RynthNetwasm.BuffScoring;

// ── input DTOs (host state replaced by data) ────────────────────────────────

public sealed class BuffConfig
{
    public bool EnableBuffing = true;          // LegacyUiSettings.cs:29
    public int RebuffSecondsRemaining = 300;   // LegacyUiSettings.cs:151 (B3)
    public int SpellCastIntervalMs = 400;      // LegacyUiSettings.cs:181 (B14)
    public int HealAt = 60;                    // LegacyUiSettings.cs:95-97 (B16 in-combat)
    public int RestamAt = 30;
    public int GetManaAt = 40;
    public int TopOffHP = 95;                  // LegacyUiSettings.cs:98-100 (B16 idle)
    public int TopOffStam = 95;
    public int TopOffMana = 95;
}

/// <summary>One resolvable spell in a buff family's tier ladder — replaces the
/// SpellDatabase name->id walk (SpellManager.cs:179-207) with data.</summary>
public sealed class SpellCandidate
{
    public int Id;
    public string Name = "";
    public int Family;
    public int Tier;          // the walk tier this name pattern belongs to
    public bool Known = true; // main-thread spellbook membership (SpellManager.cs:29)
}

public sealed class DesiredBuff
{
    public string BaseName = "";
    public bool SkillUsable = true; // IsSkillUsable (:1892)
    public int MaxTier = 8;         // GetHighestBuffSpellTier result (SpellManager.cs:143-148)
    public List<SpellCandidate> Ladder = new();
}

/// <summary>One ReadPlayerEnchantments row at NowMs (B2). RemainingS is
/// expiry − serverNow, already computed by the host boundary.</summary>
public sealed class RegistryEntry
{
    public int SpellId;
    public string Name = "";   // "" = unresolved by SpellTableStub -> dropped (:1349-1352)
    public int Family;
    public double RemainingS;
    public bool Permanent;     // engine reports no expiry (B6, :1362-1371)
}

public sealed class VitalsInput // B15/B16 (:717-763)
{
    public int HealthPct = 100;
    public int StaminaPct = 100;
    public int ManaPct = 100;
    public bool InCombat;      // HasCloseThreat(MonsterRange) (:745)
    public bool HasHealthKit;  // AttemptHealthKitUse would succeed (:776-796)
    // FindBestSpellId results for the four vital bases; 0 = unresolvable.
    public int StamToHealthId;
    public int HealSelfId;
    public int StamToManaId;
    public int RevitalizeId;
}

/// <summary>_ramBuffTimers entry (:63-73, :108). ExpiresAtMs on the NowMs clock.</summary>
public sealed class FamilyTimer
{
    public int Family;
    public string SpellName = "";
    public int Level;
    public double ExpiresAtMs;
    public bool Permanent;     // presence-only sentinel (B6, :78)
}

/// <summary>_itemSpellTimers entry (:100-106, :118) — armor/weapon enchants (B7).</summary>
public sealed class ItemTimer
{
    public int Family;
    public string SpellName = "";
    public int Level;
    public double ExpiresAtMs;
}

public sealed class FamilyInt { public int Family; public int Value; }
public sealed class FamilyMs  { public int Family; public double UntilMs; }

/// <summary>Everything BuffManager keeps between heartbeats, as data.</summary>
public sealed class SchedulerState
{
    public bool RegistryReady;                       // _liveBuffsRefreshed (:460)
    public double LoginStartAtMs = -1;               // _loginRefreshStartAt (:470); -1 = MinValue
    public int LastLoginCount = -1;                  // _lastLoginRefreshCount (:471)
    public double LastLiveRefreshAttemptMs = -1e15;  // _lastLiveRefreshAttempt (:461)
    public double LastPeriodicRefreshMs = -1e15;     // _lastPeriodicRefreshAt (:462)
    public double LastCastAttemptMs = -1e15;         // _lastCastAttempt (:18)
    public double LastSelfBuffPollAtMs = -1e15;      // _lastSelfBuffPollAt (:55)
    public int PendingSpellId;                       // _pendingSpellId (:39)
    public string PendingSpellName = "";             // SpellTableStub.GetById surrogate
    public int PendingFamily;
    public bool PendingKnown = true;                 // for the armor confirmedKnown check (:610)
    public bool ForceRebuffing;                      // _isForceRebuffing (:38)
    public List<int> ForceRebuffCastFamilies = new();// (:128)
    public List<FamilyInt> NoShowCounts = new();     // _silentNoShowCounts (:156)
    public List<FamilyMs> FailCooldownUntil = new(); // _buffFailCooldownUntil (:140)
    public List<FamilyInt> AchievedTier = new();     // _familyAchievedTier (:114, B5)
    public List<int> UnresolvableIds = new();        // SpellManager._unresolvableSpellIds (SpellManager.cs:21)
    public List<FamilyTimer> RamTimers = new();      // _ramBuffTimers
    public List<ItemTimer> ItemTimers = new();       // _itemSpellTimers
}

public sealed class BuffInput
{
    public double NowMs;
    public BuffConfig Config = new();
    public VitalsInput Vitals = new();
    public bool HasRegistryApi = true;  // HasReadPlayerEnchantments && HasGetServerTime && serverNow>0 (:1320-1325)
    public List<RegistryEntry> Registry = new();
    public bool KnownSnapshotWarm = true; // SpellManager.IsKnownSnapshotWarm (SpellManager.cs:265)
    public List<DesiredBuff> Desired = new(); // BuildDynamicBuffList output IN ORDER (:1607-1662)
    public bool InMagicMode = true;     // CurrentCombatMode == Magic (:1934)
    public bool CanCastNow = true;      // CastGateWatchdog.CanCastNow (:679)
    public int BusyCount;               // (:233, :679)
    public SchedulerState State = new();
}

// ── output DTOs ─────────────────────────────────────────────────────────────

public sealed class BuffOutput
{
    /// <summary>What this heartbeat decided:
    /// login-wait | login-ready | hold-pending | confirmed | no-show-retry |
    /// no-show-parked | no-chat-timeout | interval-wait | gate-blocked |
    /// vital-kit | vital-cast | mode-switch | cast-buff | idle | buffing-disabled</summary>
    public string Action = "";
    public int SpellId;          // cast-buff / vital-cast: the spell issued
    public int Family;
    public string SpellName = "";
    public string BaseName = ""; // cast-buff: which desired entry fired
    public string Reason = "";   // LastBuffSkipReason-style trail (:241)
    public bool BatchStarted;    // B11 auto-batch flipped on this tick (:838-853)
    public bool BatchCompleted;  // FR pass fell through (:700-706)
    public bool RefreshedRegistry;
    public List<string> SkipReasons = new(); // per-desired skip trail this pass
    public SchedulerState State = new();
}

// ── the lifted logic ────────────────────────────────────────────────────────

public static class BuffScheduling
{
    // BuffManager.cs constants (report 11 §B verified against source)
    public const double LoginRefreshMaxWaitMs = 20_000;     // :472 (B1)
    public const double PeriodicRefreshIntervalMs = 30_000; // :463 (B13)
    public const double SelfBuffConfirmMs = 600;            // :53 (B8)
    public const double SelfBuffGiveUpMs = 2500;            // :54 (B8)
    public const double SelfBuffPollThrottleMs = 250;       // :551
    public const double NoChatResolveTimeoutMs = 5000;      // :46 (B8 item arm)
    public const int SilentNoShowThreshold = 2;             // :157 (B9)
    public const double SilentNoShowCooldownMs = 30 * 60_000; // :158 (B9)
    public const double BuffFailCooldownMs = 120_000;       // :141 (B10)
    public const double PermanentSentinelS = 86_400.0 * 365;// :1371 (B6)
    public const int EmergencyHpPct = 30;                   // :733 (B15) — note <=
    public const int EmergencyStamFloorPct = 20;            // :733 (B15) — note >
    public const int ManaRechargeStamFloorPct = 15;         // :759 (B16) — note >

    // Working view of the list-shaped state (rebuilt per tick).
    private sealed class Ctx
    {
        public required BuffInput In;
        public required SchedulerState St;
        public required BuffOutput Out;
        public Dictionary<int, FamilyTimer> Ram = new();
        public Dictionary<int, ItemTimer> Item = new();
        public Dictionary<int, int> NoShows = new();
        public Dictionary<int, double> Cooldown = new();
        public Dictionary<int, int> Achieved = new();
        public HashSet<int> Unresolvable = new();
        public HashSet<int> FrFamilies = new();
        public double Now;
    }

    /// <summary>One buff heartbeat — the OnHeartbeat decision spine (:474-715).
    /// Mutates and returns input.State as output.State.</summary>
    public static BuffOutput ScheduleBuffTick(BuffInput inp)
    {
        var st = inp.State;
        var outp = new BuffOutput { State = st };
        var cx = new Ctx { In = inp, St = st, Out = outp, Now = inp.NowMs };
        foreach (var t in st.RamTimers) cx.Ram[t.Family] = t;
        foreach (var t in st.ItemTimers) cx.Item[t.Family] = t;
        foreach (var e in st.NoShowCounts) cx.NoShows[e.Family] = e.Value;
        foreach (var e in st.FailCooldownUntil) cx.Cooldown[e.Family] = e.UntilMs;
        foreach (var e in st.AchievedTier) cx.Achieved[e.Family] = e.Value;
        foreach (var i in st.UnresolvableIds) cx.Unresolvable.Add(i);
        foreach (var f in st.ForceRebuffCastFamilies) cx.FrFamilies.Add(f);

        Tick(cx);

        // write the working view back to the list-shaped state
        st.RamTimers = new List<FamilyTimer>(cx.Ram.Values);
        st.ItemTimers = new List<ItemTimer>(cx.Item.Values);
        st.NoShowCounts = Pack(cx.NoShows);
        st.AchievedTier = Pack(cx.Achieved);
        st.FailCooldownUntil = PackMs(cx.Cooldown);
        st.UnresolvableIds = new List<int>(cx.Unresolvable);
        st.ForceRebuffCastFamilies = new List<int>(cx.FrFamilies);
        return outp;
    }

    private static List<FamilyInt> Pack(Dictionary<int, int> d)
    {
        var l = new List<FamilyInt>();
        foreach (var kv in d) l.Add(new FamilyInt { Family = kv.Key, Value = kv.Value });
        l.Sort((a, b) => a.Family.CompareTo(b.Family)); // deterministic JSON
        return l;
    }

    private static List<FamilyMs> PackMs(Dictionary<int, double> d)
    {
        var l = new List<FamilyMs>();
        foreach (var kv in d) l.Add(new FamilyMs { Family = kv.Key, UntilMs = kv.Value });
        l.Sort((a, b) => a.Family.CompareTo(b.Family));
        return l;
    }

    private static void Tick(Ctx cx)
    {
        var inp = cx.In; var st = cx.St; var outp = cx.Out; double now = cx.Now;

        // ── B1 login stabilization gate (:493-519) ──
        if (!st.RegistryReady)
        {
            if (now - st.LastLiveRefreshAttemptMs > 1000)
            {
                st.LastLiveRefreshAttemptMs = now;
                int n = RefreshFromRegistry(cx);
                if (n >= 0)
                {
                    outp.RefreshedRegistry = true;
                    if (st.LoginStartAtMs < 0) st.LoginStartAtMs = now;     // :501
                    bool stable = n == st.LastLoginCount;                    // :505
                    bool timedOut = now - st.LoginStartAtMs > LoginRefreshMaxWaitMs; // :506
                    st.LastLoginCount = n;
                    if (stable || timedOut)
                    {
                        st.RegistryReady = true;
                        outp.Action = "login-ready";
                        outp.Reason = $"registry stable={stable} timedOut={timedOut} ({n} families)";
                        return; // :518 — no cast on the tick the gate opens
                    }
                }
            }
            outp.Action = "login-wait"; // :516-518
            return;
        }

        // ── B13 periodic re-sync (:521-531) ──
        if (now - st.LastPeriodicRefreshMs > PeriodicRefreshIntervalMs)
        {
            st.LastPeriodicRefreshMs = now;
            if (RefreshFromRegistry(cx) >= 0) outp.RefreshedRegistry = true;
        }

        // ── pending-cast resolution (:539-659) ──
        if (st.PendingSpellId != 0)
        {
            bool pendingIsArmor = IsItemEnchantment(st.PendingSpellName); // :542
            if (!pendingIsArmor)
            {
                // SELF-BUFF: registry-confirmed (:544-599)
                double sinceCastMs = now - st.LastCastAttemptMs;
                if (sinceCastMs > SelfBuffConfirmMs && now - st.LastSelfBuffPollAtMs > SelfBuffPollThrottleMs)
                {
                    st.LastSelfBuffPollAtMs = now;
                    if (RefreshFromRegistry(cx) >= 0) outp.RefreshedRegistry = true;
                    bool active = cx.Ram.TryGetValue(st.PendingFamily, out var pt)
                                  && (pt.Permanent || pt.ExpiresAtMs > now);  // :555-556 (NOT threshold-checked)
                    if (active)
                    {
                        if (st.ForceRebuffing) cx.FrFamilies.Add(st.PendingFamily); // :562 (B12)
                        outp.Action = "confirmed";
                        outp.SpellId = st.PendingSpellId;
                        outp.Family = st.PendingFamily;
                        ClearPending(st);
                    }
                    else if (sinceCastMs > SelfBuffGiveUpMs)
                    {
                        // B9 silent-no-show valve (:566-595)
                        bool cold = !inp.KnownSnapshotWarm;                   // :572
                        if (cold) cx.Unresolvable.Add(st.PendingSpellId);     // :573 tier-down
                        int fam = st.PendingFamily;
                        int noShow = cx.NoShows.TryGetValue(fam, out int prev) ? prev + 1 : 1; // :580
                        cx.NoShows[fam] = noShow;
                        bool parked = false;
                        if (noShow >= SilentNoShowThreshold)                  // :583
                        {
                            cx.Cooldown[fam] = now + SilentNoShowCooldownMs;  // :585
                            parked = true;
                        }
                        outp.Action = parked ? "no-show-parked" : "no-show-retry";
                        outp.SpellId = st.PendingSpellId;
                        outp.Family = fam;
                        outp.Reason = (cold ? "cold snapshot -> blacklisted, tier-down" : "warm snapshot -> retry")
                                      + $" noShows={noShow}/{SilentNoShowThreshold}";
                        ClearPending(st);
                    }
                }
                if (st.PendingSpellId != 0) { outp.Action = "hold-pending"; return; } // :599
            }
            else
            {
                // ARMOR/ITEM: chat-authoritative; here only the no-chat valve (:601-658).
                if (now - st.LastCastAttemptMs > NoChatResolveTimeoutMs)
                {
                    bool confirmedKnown = inp.KnownSnapshotWarm && st.PendingKnown; // :610
                    if (!confirmedKnown) cx.Unresolvable.Add(st.PendingSpellId);    // :611-612
                    int fam = st.PendingFamily;
                    if (fam != 0)                                                    // :635-646
                    {
                        int noShow = cx.NoShows.TryGetValue(fam, out int prev) ? prev + 1 : 1;
                        cx.NoShows[fam] = noShow;
                        if (noShow >= SilentNoShowThreshold)
                            cx.Cooldown[fam] = now + SilentNoShowCooldownMs;
                    }
                    outp.Action = "no-chat-timeout";
                    outp.SpellId = st.PendingSpellId;
                    outp.Family = fam;
                    outp.Reason = confirmedKnown ? "known -> lag/busy, NOT blacklisted" : "blacklisted -> tier-down";
                    ClearPending(st);
                }
                if (st.PendingSpellId != 0) { outp.Action = "hold-pending"; return; } // :657
            }
            // resolved this tick — C# falls through to the interval gate (:661)
        }

        // ── B14 pacing (:661-665) ──
        if (now - st.LastCastAttemptMs < inp.Config.SpellCastIntervalMs)
        {
            if (outp.Action == "") outp.Action = "interval-wait";
            return;
        }

        // ── cast gate + busy (:679-684) ──
        if (!inp.CanCastNow || inp.BusyCount > 0)
        {
            outp.Reason = inp.BusyCount > 0 ? "busy (BusyCount>0)" : "cast gate closed (CanCastNow=false)"; // :681
            if (outp.Action == "") outp.Action = "gate-blocked";
            return;
        }

        // ── B15/B16 vitals (:686-690 -> :717-763) ──
        if (CheckVitals(cx)) return;

        // ── buffs (:692-707) ──
        if (inp.Config.EnableBuffing)
        {
            if (CheckAndCastSelfBuffs(cx)) return;
            if (st.ForceRebuffing) // :700-706 — FR pass fell through: complete
            {
                st.ForceRebuffing = false;
                cx.FrFamilies.Clear();
                outp.BatchCompleted = true;
            }
            if (outp.Action == "") outp.Action = "idle";
        }
        else if (outp.Action == "") outp.Action = "buffing-disabled";
    }

    private static void ClearPending(SchedulerState st)
    {
        st.PendingSpellId = 0;
        st.PendingSpellName = "";
        st.PendingFamily = 0;
        st.PendingKnown = true;
    }

    // ── CheckVitals (:717-763) — verbatim decision structure ──
    private static bool CheckVitals(Ctx cx)
    {
        var v = cx.In.Vitals; var outp = cx.Out;

        // Emergency override (:733-737): HP critical + stam available. NOTE the
        // arm RETURNS AttemptVitalCast's result — an unresolvable spell aborts
        // vitals entirely this tick (no fall-through to the threshold arms).
        if (v.HealthPct <= EmergencyHpPct && v.StaminaPct > EmergencyStamFloorPct)
            return AttemptVitalCast(cx, v.StamToHealthId, "Stamina to Health Self", "EMERGENCY hp<=30 stam>20");

        // Threshold set by hunting state (:739-752). Strict "<"; 0 disables.
        int hpT   = v.InCombat ? cx.In.Config.HealAt    : cx.In.Config.TopOffHP;
        int manaT = v.InCombat ? cx.In.Config.GetManaAt : cx.In.Config.TopOffMana;
        int stamT = v.InCombat ? cx.In.Config.RestamAt  : cx.In.Config.TopOffStam;

        if (v.HealthPct < hpT) // :754-758 — kit first, then Heal Self; arm returns either way
        {
            if (v.HasHealthKit)
            {
                cx.St.LastCastAttemptMs = cx.Now; // :791
                outp.Action = "vital-kit";
                outp.Reason = $"hp<{hpT} healthkit";
                return true;
            }
            return AttemptVitalCast(cx, v.HealSelfId, "Heal Self", $"hp<{hpT}");
        }
        if (v.ManaPct < manaT && v.StaminaPct > ManaRechargeStamFloorPct)   // :759 — mana BEFORE stamina
            return AttemptVitalCast(cx, v.StamToManaId, "Stamina to Mana Self", $"mana<{manaT} stam>15");
        if (v.StaminaPct < stamT)                                            // :760
            return AttemptVitalCast(cx, v.RevitalizeId, "Revitalize Self", $"stam<{stamT}");
        return false;
    }

    // AttemptVitalCast (:765-774). id==0 -> false (caller's arm returns false ->
    // OnHeartbeat continues into buffs). Mode flip yields but counts handled.
    private static bool AttemptVitalCast(Ctx cx, int spellId, string name, string why)
    {
        if (spellId == 0) return false;                       // :768
        if (!cx.In.InMagicMode)                               // :769 EnsureMagicMode
        {
            cx.St.LastCastAttemptMs = cx.Now;                 // :1961/:2120
            cx.Out.Action = "mode-switch";
            cx.Out.Reason = $"vitals: {why}";
            return true;
        }
        cx.St.PendingSpellId = spellId;                       // :770
        cx.St.PendingSpellName = name;
        cx.St.PendingFamily = FamilyOf(cx, spellId);
        cx.St.LastCastAttemptMs = cx.Now;                     // :772
        cx.Out.Action = "vital-cast";
        cx.Out.SpellId = spellId;
        cx.Out.SpellName = name;
        cx.Out.Reason = why;
        return true;
    }

    private static int FamilyOf(Ctx cx, int spellId)
    {
        foreach (var d in cx.In.Desired)
            foreach (var c in d.Ladder)
                if (c.Id == spellId) return c.Family;
        return 0;
    }

    // ── AnyBuffBelowThreshold (:814-831) — the B11 trigger, parked-aware ──
    private static bool AnyBuffBelowThreshold(Ctx cx, int thresholdSec)
    {
        foreach (var buff in cx.In.Desired)
        {
            if (!buff.SkillUsable) continue;                     // :820
            var cand = FindBestSpell(cx, buff);
            if (cand == null) continue;                          // :822
            if (cx.Cooldown.TryGetValue(cand.Family, out double until) && cx.Now < until)
                continue;                                        // :824-827 — parked can't retrigger
            if (!IsBuffActive(cx, cand, thresholdSec)) return true; // :828
        }
        return false;
    }

    // ── CheckAndCastSelfBuffs (:833-943) ──
    private static bool CheckAndCastSelfBuffs(Ctx cx)
    {
        var st = cx.St; var outp = cx.Out;

        // B11 auto batch-rebuff trigger (:838-853): do NOT clear timers, do NOT
        // clear cooldowns (only explicit ForceFullRebuff does, :396-407).
        if (!st.ForceRebuffing && AnyBuffBelowThreshold(cx, cx.In.Config.RebuffSecondsRemaining))
        {
            st.ForceRebuffing = true;
            cx.FrFamilies.Clear();
            outp.BatchStarted = true;
        }

        foreach (var buff in cx.In.Desired) // :858
        {
            if (!buff.SkillUsable)
            { outp.SkipReasons.Add($"skill not usable: {buff.BaseName}"); continue; } // :861-865

            var cand = FindBestSpell(cx, buff);
            if (cand == null)
            { outp.SkipReasons.Add($"not known / unresolvable: {buff.BaseName}"); continue; } // :869-873

            if (IsBuffActive(cx, cand, null))
            { outp.SkipReasons.Add($"already active: {buff.BaseName} (id={cand.Id})"); continue; } // :876-880

            // B10 hard-fail / no-show cooldown (:886-894) — checked AFTER IsBuffActive
            if (cand.Family != 0 && cx.Cooldown.TryGetValue(cand.Family, out double until) && cx.Now < until)
            { outp.SkipReasons.Add($"fail-cooldown: {buff.BaseName} (fam={cand.Family})"); continue; }

            if (!cx.In.InMagicMode) // :896-913 EnsureMagicMode(forBuff) — swap machinery out of slice
            {
                st.LastCastAttemptMs = cx.Now;   // :1961/:2120
                outp.Action = "mode-switch";
                outp.Reason = $"buff: {buff.BaseName}";
                return true;                     // :913 — yield, keep Buffing
            }

            // CAST (:916-940). Timers recorded only on confirmation, never here.
            st.PendingSpellId = cand.Id;
            st.PendingSpellName = cand.Name;
            st.PendingFamily = cand.Family;
            st.PendingKnown = cand.Known;
            st.LastCastAttemptMs = cx.Now;       // :929
            outp.Action = "cast-buff";
            outp.SpellId = cand.Id;
            outp.Family = cand.Family;
            outp.SpellName = cand.Name;
            outp.BaseName = buff.BaseName;
            return true;                          // :940
        }
        return false;                             // :942
    }

    // ── FindBestSpellId (:945-946 -> SpellManager.GetDynamicSelfBuffId
    //    SpellManager.cs:170-209) — tier walk maxTier..1 over the data ladder,
    //    with TryGetId's known/blacklist semantics (SpellManager.cs:327-361). ──
    private static SpellCandidate? FindBestSpell(Ctx cx, DesiredBuff buff)
    {
        for (int tier = buff.MaxTier; tier >= 1; tier--)
            foreach (var c in buff.Ladder)
            {
                if (c.Tier != tier) continue;
                if (cx.In.KnownSnapshotWarm)
                {
                    if (c.Known) return c;        // SpellManager.cs:335-339 — snapshot wins
                }
                else if (!cx.Unresolvable.Contains(c.Id))
                {
                    return c;                     // SpellManager.cs:342-358 — cold: the
                }                                 // mis-bound oracle lies "known"; only the
                                                  // empirical blacklist bounds the walk
            }
        return null;
    }

    // ── IsBuffActive (:1148-1232) ──
    private static bool IsBuffActive(Ctx cx, SpellCandidate spell, int? rebufferSecOverride)
    {
        // Force Rebuff: only families cast THIS cycle count (B12, :1156-1157)
        if (cx.St.ForceRebuffing) return cx.FrFamilies.Contains(spell.Family);

        int targetLevel = GetSpellLevel(spell.Name);                     // :1159
        int rebufferSec = Math.Max(0, rebufferSecOverride ?? cx.In.Config.RebuffSecondsRemaining); // :1163

        if (IsItemEnchantment(spell.Name)) // :1173-1195 — item timer dict (B7)
        {
            if (cx.Item.TryGetValue(spell.Family, out var it))
            {
                if (it.Level < targetLevel) return false;                // :1177-1181 tier-upgrade
                if (cx.Now < it.ExpiresAtMs - rebufferSec * 1000.0) return true; // :1182-1186
            }
            return false;
        }

        if (cx.Ram.TryGetValue(spell.Family, out var timer)) // :1198
        {
            // B5 incantation cap: target capped at highest OBSERVED landing (:1207-1209)
            int effectiveTarget = targetLevel;
            if (cx.Achieved.TryGetValue(spell.Family, out int achieved) && achieved < effectiveTarget)
                effectiveTarget = achieved;
            if (timer.Level < effectiveTarget) return false;             // :1211-1214 B4 tier-upgrade
            if (timer.Permanent) return true;                            // :78 sentinel can't underflow
            if (cx.Now < timer.ExpiresAtMs - rebufferSec * 1000.0) return true; // :1216-1219 B3
        }
        return false;                                                    // :1224-1231
    }

    // ── RefreshFromLiveMemory (:1318-1399) — registry -> family timers (B2/B6) ──
    private static int RefreshFromRegistry(Ctx cx)
    {
        if (!cx.In.HasRegistryApi) return -1;                            // :1320-1325

        // Preserve unexpired item-enchant names living in the ram dict (:1335-1343)
        var preserved = new Dictionary<int, FamilyTimer>();
        foreach (var kv in cx.Ram)
            if ((kv.Value.Permanent || kv.Value.ExpiresAtMs > cx.Now) && IsItemEnchantment(kv.Value.SpellName))
                preserved[kv.Key] = kv.Value;

        cx.Ram.Clear();                                                  // :1345
        foreach (var e in cx.In.Registry)
        {
            if (string.IsNullOrEmpty(e.Name)) continue;                  // :1349-1352 unresolved id
            bool isPermanent = e.Permanent || e.RemainingS > PermanentSentinelS; // :1371
            if (!isPermanent && e.RemainingS <= 0) continue;             // :1355-1359 expired

            int level = GetSpellLevel(e.Name);                           // :1373
            cx.Ram[e.Family] = new FamilyTimer                           // :1374 — LAST wins (quirk)
            {
                Family = e.Family,
                SpellName = e.Name,
                Level = level,
                ExpiresAtMs = isPermanent ? double.MaxValue : cx.Now + e.RemainingS * 1000.0,
                Permanent = isPermanent,
            };
            RecordAchievedTier(cx, e.Family, level);                     // :1383 (B5)
        }
        foreach (var kv in preserved)                                    // :1390-1391 TryAdd
            if (!cx.Ram.ContainsKey(kv.Key)) cx.Ram[kv.Key] = kv.Value;
        return cx.Ram.Count;                                             // :1398
    }

    // RecordAchievedTier (:1251-1256) — max-of-observed landings.
    private static void RecordAchievedTier(Ctx cx, int family, int landedLevel)
    {
        if (landedLevel <= 0) return;
        if (!cx.Achieved.TryGetValue(family, out int cur) || landedLevel > cur)
            cx.Achieved[family] = landedLevel;
    }

    // ── GetSpellLevel (:1268-1294) — verbatim, including check order ──
    public static int GetSpellLevel(string n)
    {
        if (n.StartsWith("Incantation")) return 8;
        if (n.Contains(" VIII")) return 8;  // must precede " VII"
        if (n.Contains(" VII")) return 7;
        if (n.Contains(" VI")) return 6;
        if (n.Contains(" V")) return 5;
        if (n.Contains(" IV")) return 4;
        if (n.Contains(" III")) return 3;
        if (n.Contains(" II")) return 2;
        if (n.EndsWith(" I") || n.Contains(" I ")) return 1;

        if (n.Contains("Mastery") || n.Contains("Blessing") || n.Contains("Aura of") ||
            n.Contains("Intervention") || n.Contains("Trance") || n.Contains("Recovery") ||
            n.Contains("Robustify") || n.Contains("Persistence") || n.Contains("Robustification") ||
            n.Contains("Might of the Lugians") || n.Contains("Preservance") || n.Contains("Perseverance") ||
            n.Contains("Honed Control") || n.Contains("Hastening") || n.Contains("Inner Calm") ||
            n.Contains("Mind Blossom") || n.Contains("Infected Caress") || n.Contains("Elysa's Sight") ||
            n.Contains("Infected Spirit") || n.Contains("Atlan's Alacrity") || n.Contains("Cragstone's Will") ||
            n.Contains("Brogard's Defiance") || n.Contains("Olthoi's Bane") || n.Contains("Swordsman's Bane") ||
            n.Contains("Swordman's Bane") || n.Contains("Tusker's Bane") || n.Contains("Inferno's Bane") ||
            n.Contains("Gelidite's Bane") || n.Contains("Astyrrian's Bane") || n.Contains("Archer's Bane"))
            return 7;

        return 1;
    }

    // GetCustomSpellDuration (:1302-1311), augs=0 (GetArchmageEnduranceCount is
    // a stub returning 0, :1296-1300). Used by the fixture landing simulation.
    public static double GetCustomSpellDurationS(int spellLevel)
    {
        double baseSeconds = 1800;
        if (spellLevel == 6) baseSeconds = 2700;
        else if (spellLevel == 7) baseSeconds = 3600;
        else if (spellLevel == 8) baseSeconds = 5400;
        return baseSeconds;
    }

    // ── IsItemEnchantment (:954-974) — verbatim name table ──
    private static readonly string[] ItemSpellNames =
    {
        "Impenetrability", "Brogard's Defiance", "Acid Bane", "Olthoi's Bane",
        "Blade Bane", "Swordsman's Bane", "Swordman's Bane", "Bludgeoning Bane", "Tusker's Bane",
        "Flame Bane", "Inferno's Bane", "Frost Bane", "Gelidite's Bane",
        "Lightning Bane", "Astyrrian's Bane", "Piercing Bane", "Archer's Bane",
        "Blood Drinker", "Aura of Infected Caress",
        "Hermetic Link", "Aura of Mystic's Blessing",
        "Heart Seeker", "Aura of Elysa's Sight",
        "Spirit Drinker", "Aura of Infected Spirit Carress", "Aura of Infected Spirit Caress",
        "Swift Killer", "Aura of Atlan's Alacrity",
        "Defender", "Aura of Cragstone's Will",
    };

    public static bool IsItemEnchantment(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        foreach (string s in ItemSpellNames)
            if (name.IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }

    // ── single JSON boundary (the [JSExport] surface calls this) ──
    public static string ScheduleBuffsJson(string inputJson)
    {
        var inp = JsonSerializer.Deserialize(inputJson, BuffJsonContext.Default.BuffInput)
                  ?? throw new ArgumentException("null BuffInput");
        var outp = ScheduleBuffTick(inp);
        return JsonSerializer.Serialize(outp, BuffJsonContext.Default.BuffOutput);
    }
}

// Source-generated JSON (trim/AOT-safe for the wasm publish). IncludeFields is
// REQUIRED — the DTOs use fields and System.Text.Json silently drops fields
// without it (the known trap).
[JsonSourceGenerationOptions(IncludeFields = true, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(BuffInput))]
[JsonSerializable(typeof(BuffOutput))]
internal partial class BuffJsonContext : JsonSerializerContext
{
}
