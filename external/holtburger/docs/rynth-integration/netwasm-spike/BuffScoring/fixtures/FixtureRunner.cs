// Console fixture runner for the BuffScoring slice.
// Generates multi-tick buff-scheduling scenarios, drives each through the C#
// scheduler via the SAME JSON boundary the wasm export uses
// (BuffScheduling.ScheduleBuffsJson), threading State forward tick-by-tick
// under a deterministic landing simulation, and writes fixtures.json:
//   { meta, scenarios: [ { name, rules[], note, <sim setup>, tickTimes,
//                          expected: { events, casts }, calls[] } ] }
// parity_check.cjs replays the SAME setup + tick schedule + landing sim
// against apps/holtburger-web/rynth/buff_loop.js (+ vitals.js) and compares
// the per-side cast/event sequences.
//
// Landing simulation (identical rules in parity_check.cjs — keep in sync):
//   - a cast of spellId at tc LANDS at tc+landsMs (500) unless silent[];
//     landed identity = landsAs[castId] ?? itself; registry remaining decays
//     from GetCustomSpellDurationS(GetSpellLevel(landedName)) (or override).
//     A landing replaces earlier same-family landings and shadows initial
//     same-family entries (recast refresh).
//   - VITAL casts never enter the registry (they are instant effects); their
//     pending is cleared by the "ou cast" chat fast-path (BuffManager.cs
//     :1824-1871) simulated at tc+chatMs (300). Self-BUFF chat/enchantment
//     fast-paths are deliberately NOT simulated — the slice models the
//     registry-poll confirm arm (B8), which is exactly what the JS port ships.
//   - initial registry entries may appear/disappear at offsets (dispel/death);
//     clearAtMs wipes everything (initial + landings) before that time.
//
// Determinism: seeded System.Random for the grind scenarios; no DateTime.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using RynthNetwasm.BuffScoring;

const int SEED = 24680;
const double T0 = 1_000_000.0;
const double LANDS_MS = 500;
const double CHAT_MS = 300;

string outPath = args.Length > 0 ? args[0] : "fixtures.json";
var scenarios = new List<JsonObject>();
int totalTicks = 0, totalCasts = 0;

// ── scenario setup model ────────────────────────────────────────────────────

var rng = new Random(SEED);

// ladder helper: family fam, tiers[] known-flags; id = fam*10+tier; tier 8 is
// the Incantation form (GetSpellLevel: StartsWith "Incantation" -> 8).
DesiredBuff Buff(string baseName, int fam, int maxTier, Dictionary<int, bool> tiers)
{
    var d = new DesiredBuff { BaseName = baseName, MaxTier = maxTier };
    foreach (var (tier, known) in tiers.OrderBy(kv => kv.Key))
    {
        string name = tier == 8 ? $"Incantation of {baseName} Self"
                                : $"{baseName} Self {Roman(tier)}";
        d.Ladder.Add(new SpellCandidate { Id = fam * 10 + tier, Name = name, Family = fam, Tier = tier, Known = known });
    }
    return d;
}
string Roman(int t) => t switch { 1 => "I", 2 => "II", 3 => "III", 4 => "IV", 5 => "V", 6 => "VI", 7 => "VII", _ => "VIII" };

Dictionary<int, bool> KnownTo(int max) // tiers 1..max known
{
    var d = new Dictionary<int, bool>();
    for (int t = 1; t <= max; t++) d[t] = true;
    return d;
}

List<double> Ticks(params (double from, double to, double step)[] spans)
{
    var l = new List<double>();
    foreach (var (from, to, step) in spans)
        for (double t = from; t <= to + 1e-9; t += step) l.Add(T0 + t);
    return l;
}
// standard warmup: login reads at T0 and T0+1000 (stable -> ready), then 250ms grid
List<double> Std(double horizonMs) => Ticks((0, 1000, 1000), (1250, horizonMs, 250));

// ── the C# tick loop + landing simulation ───────────────────────────────────

void Run(Scenario sc)
{
    var state = new SchedulerState();
    var landed = new List<(double landAt, int id, string name, int fam, double durS, int castNo)>();
    double? vitalChatClearAt = null; int vitalChatClearId = 0;
    int hp = sc.Vitals.HealthPct, stam = sc.Vitals.StaminaPct, mana = sc.Vitals.ManaPct;
    int castCounter = 0;
    var events = new JsonArray();
    var casts = new JsonArray();
    var calls = new JsonArray();

    foreach (double t in sc.TickTimes)
    {
        totalTicks++;
        foreach (var ev in sc.VitalsEvents.Where(e => T0 + e.AtMs <= t))
        { if (ev.Hp != null) hp = ev.Hp.Value; if (ev.Stam != null) stam = ev.Stam.Value; if (ev.Mana != null) mana = ev.Mana.Value; }

        // chat fast-path sim for VITAL pendings (BuffManager.cs:1824-1871)
        if (vitalChatClearAt != null && t >= vitalChatClearAt && state.PendingSpellId == vitalChatClearId)
        {
            state.PendingSpellId = 0; state.PendingSpellName = ""; state.PendingFamily = 0; state.PendingKnown = true;
            vitalChatClearAt = null;
        }

        // registry view at t
        var reg = new List<RegistryEntry>();
        foreach (var e in sc.InitialRegistry)
        {
            if (t < T0 + e.AppearsAtMs || t >= T0 + e.RemovedAtMs) continue;
            if (sc.ClearAtMs != null && t >= T0 + sc.ClearAtMs) continue;
            if (landed.Any(l => l.fam == e.Family && t >= l.landAt)) continue; // recast shadows
            reg.Add(new RegistryEntry
            {
                SpellId = e.SpellId, Name = e.Name, Family = e.Family, Permanent = e.Permanent,
                RemainingS = e.Permanent ? 0 : e.RemainingS - (t - (T0 + e.AppearsAtMs)) / 1000.0,
            });
        }
        foreach (var grp in landed.Where(l => t >= l.landAt).GroupBy(l => l.fam))
        {
            var l = grp.OrderBy(x => x.landAt).Last(); // newest landing per family wins
            if (sc.ClearAtMs != null && l.landAt < T0 + sc.ClearAtMs && t >= T0 + sc.ClearAtMs) continue;
            reg.Add(new RegistryEntry { SpellId = l.id, Name = l.name, Family = l.fam, RemainingS = l.durS - (t - l.landAt) / 1000.0 });
        }

        bool inMagic = sc.ModeAtMs != null ? (t >= T0 + sc.ModeAtMs ? true : sc.InMagicModeInitial) : sc.InMagicModeInitial;
        var input = new BuffInput
        {
            NowMs = t, Config = sc.Config, HasRegistryApi = true, Registry = reg,
            KnownSnapshotWarm = sc.KnownWarm, Desired = sc.Desired,
            InMagicMode = inMagic, CanCastNow = sc.CanCastNow, BusyCount = sc.BusyCount,
            Vitals = new VitalsInput
            {
                HealthPct = hp, StaminaPct = stam, ManaPct = mana,
                InCombat = sc.Vitals.InCombat, HasHealthKit = sc.Vitals.HasHealthKit,
                StamToHealthId = sc.Vitals.StamToHealthId, HealSelfId = sc.Vitals.HealSelfId,
                StamToManaId = sc.Vitals.StamToManaId, RevitalizeId = sc.Vitals.RevitalizeId,
            },
            State = state,
        };

        // through the SAME single JSON boundary the wasm export exposes
        string inJson = JsonSerializer.Serialize(input, BuffJsonContext.Default.BuffInput);
        string outJson = BuffScheduling.ScheduleBuffsJson(inJson);
        var output = JsonSerializer.Deserialize(outJson, BuffJsonContext.Default.BuffOutput)!;
        state = output.State;

        bool interesting = output.Action is not ("login-wait" or "interval-wait" or "hold-pending" or "idle");
        if (interesting || output.BatchStarted || output.BatchCompleted)
        {
            events.Add(new JsonObject
            {
                ["t"] = t - T0, ["action"] = output.Action, ["spellId"] = output.SpellId,
                ["family"] = output.Family, ["batchStarted"] = output.BatchStarted,
                ["batchCompleted"] = output.BatchCompleted, ["reason"] = output.Reason,
            });
            if (calls.Count < 8)
                calls.Add(new JsonObject { ["input"] = JsonNode.Parse(inJson), ["output"] = JsonNode.Parse(outJson) });
        }

        switch (output.Action)
        {
            case "cast-buff":
                totalCasts++;
                castCounter++;
                casts.Add(new JsonObject { ["t"] = t - T0, ["kind"] = "buff", ["id"] = output.SpellId });
                if (!sc.Silent.Contains(output.SpellId))
                {
                    var la = sc.LandsAs.TryGetValue(output.SpellId, out var v) ? v
                             : (output.SpellId, output.SpellName, output.Family);
                    double dur = sc.LandDurationOverrideS
                                 ?? BuffScheduling.GetCustomSpellDurationS(BuffScheduling.GetSpellLevel(la.Item2));
                    landed.Add((t + LANDS_MS, la.Item1, la.Item2, la.Item3, dur, castCounter));
                }
                break;
            case "vital-cast":
                totalCasts++;
                casts.Add(new JsonObject { ["t"] = t - T0, ["kind"] = "vital", ["id"] = output.SpellId });
                vitalChatClearAt = t + CHAT_MS; vitalChatClearId = output.SpellId;
                break;
            case "vital-kit":
                casts.Add(new JsonObject { ["t"] = t - T0, ["kind"] = "kit", ["id"] = 0 });
                break;
            case "mode-switch":
                casts.Add(new JsonObject { ["t"] = t - T0, ["kind"] = "mode", ["id"] = 0 });
                break;
        }
    }

    // JS-driver setup blobs: spell metadata + known ids derived from ladders/vitals
    var spellMeta = new JsonObject();
    var knownIds = new JsonArray();
    foreach (var d in sc.Desired)
        foreach (var c in d.Ladder)
        {
            spellMeta[c.Id.ToString()] = new JsonArray(c.Family, c.Tier);
            if (c.Known) knownIds.Add(c.Id);
        }
    foreach (var (la, _) in sc.LandsAs.Select(kv => (kv.Value, 0)))
        spellMeta[la.id.ToString()] = new JsonArray(la.fam, BuffScheduling.GetSpellLevel(la.name));
    foreach (int vid in new[] { sc.Vitals.StamToHealthId, sc.Vitals.HealSelfId, sc.Vitals.StamToManaId, sc.Vitals.RevitalizeId })
        if (vid != 0) knownIds.Add(vid);

    JsonArray DesiredJson()
    {
        var a = new JsonArray();
        foreach (var d in sc.Desired)
        {
            var lad = new JsonArray();
            foreach (var c in d.Ladder)
                lad.Add(new JsonObject { ["id"] = c.Id, ["name"] = c.Name, ["family"] = c.Family, ["tier"] = c.Tier, ["known"] = c.Known });
            a.Add(new JsonObject { ["baseName"] = d.BaseName, ["skillUsable"] = d.SkillUsable, ["maxTier"] = d.MaxTier, ["ladder"] = lad });
        }
        return a;
    }

    var initReg = new JsonArray();
    foreach (var e in sc.InitialRegistry)
        initReg.Add(new JsonObject
        {
            ["spellId"] = e.SpellId, ["name"] = e.Name, ["family"] = e.Family,
            ["remainingS"] = e.RemainingS, ["permanent"] = e.Permanent,
            ["appearsAtMs"] = e.AppearsAtMs,
            ["removedAtMs"] = e.RemovedAtMs == double.MaxValue ? null : (JsonNode)e.RemovedAtMs,
        });

    var vev = new JsonArray();
    foreach (var e in sc.VitalsEvents)
        vev.Add(new JsonObject { ["atMs"] = e.AtMs, ["hp"] = e.Hp, ["stam"] = e.Stam, ["mana"] = e.Mana });

    var landsAsJson = new JsonObject();
    foreach (var kv in sc.LandsAs)
        landsAsJson[kv.Key.ToString()] = new JsonObject { ["id"] = kv.Value.id, ["name"] = kv.Value.name, ["family"] = kv.Value.fam };

    scenarios.Add(new JsonObject
    {
        ["name"] = sc.Name,
        ["rules"] = new JsonArray(sc.Rules.Select(r => (JsonNode)r!).ToArray()),
        ["note"] = sc.Note,
        ["jsSkip"] = sc.JsSkip,
        ["kernelGate"] = sc.KernelGate,
        ["expectDiverge"] = sc.ExpectDiverge,
        ["config"] = new JsonObject
        {
            ["rebuffSecondsRemaining"] = sc.Config.RebuffSecondsRemaining,
            ["spellCastIntervalMs"] = sc.Config.SpellCastIntervalMs,
            ["enableBuffing"] = sc.Config.EnableBuffing,
            ["healAt"] = sc.Config.HealAt, ["restamAt"] = sc.Config.RestamAt, ["getManaAt"] = sc.Config.GetManaAt,
            ["topOffHp"] = sc.Config.TopOffHP, ["topOffStam"] = sc.Config.TopOffStam, ["topOffMana"] = sc.Config.TopOffMana,
        },
        ["knownWarm"] = sc.KnownWarm,
        ["inMagicModeInitial"] = sc.InMagicModeInitial,
        ["modeAtMs"] = sc.ModeAtMs,
        ["canCastNow"] = sc.CanCastNow,
        ["busyCount"] = sc.BusyCount,
        ["desired"] = DesiredJson(),
        ["knownIds"] = knownIds,
        ["spellMeta"] = spellMeta,
        ["vitals"] = new JsonObject
        {
            ["hp"] = sc.Vitals.HealthPct, ["stam"] = sc.Vitals.StaminaPct, ["mana"] = sc.Vitals.ManaPct,
            ["inCombat"] = sc.Vitals.InCombat, ["hasKit"] = sc.Vitals.HasHealthKit,
            ["stamToHealthId"] = sc.Vitals.StamToHealthId, ["healSelfId"] = sc.Vitals.HealSelfId,
            ["stamToManaId"] = sc.Vitals.StamToManaId, ["revitalizeId"] = sc.Vitals.RevitalizeId,
        },
        ["vitalsEvents"] = vev,
        ["initialRegistry"] = initReg,
        ["clearAtMs"] = sc.ClearAtMs,
        ["silent"] = new JsonArray(sc.Silent.Select(i => (JsonNode)i).ToArray()),
        ["landsAs"] = landsAsJson,
        ["landDurationOverrideS"] = sc.LandDurationOverrideS,
        ["tickTimes"] = new JsonArray(sc.TickTimes.Select(t => (JsonNode)(t - T0)).ToArray()),
        ["expected"] = new JsonObject { ["events"] = events, ["casts"] = casts },
        ["calls"] = calls,
    });
}

// convenience: healthy vitals (no vital arm fires: thresholds default 95 idle)
VitalsInput Healthy() => new() { HealthPct = 100, StaminaPct = 100, ManaPct = 100, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 };

RegEntry Reg(int fam, int tier, double remainingS, string? baseName = null, double appearsAtMs = 0, double removedAtMs = double.MaxValue)
{
    string bn = baseName ?? $"Fam{fam}";
    string name = tier == 8 ? $"Incantation of {bn} Self" : $"{bn} Self {Roman(tier)}";
    return new RegEntry { SpellId = fam * 10 + tier, Name = name, Family = fam, RemainingS = remainingS, AppearsAtMs = appearsAtMs, RemovedAtMs = removedAtMs };
}

// ── scenario catalog ────────────────────────────────────────────────────────
// Families: Strength=101, Endurance=102, Focus=103; probes use 104+.

Run(new Scenario
{
    Name = "empty-registry-initial-buffup", Rules = new[] { "B1", "B8", "B11", "B12" },
    Note = "3 desired, empty registry: login gate opens after 2 stable reads, auto-batch fires, all 3 cast+confirm in desired order, batch completes.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)), Buff("Endurance", 102, 8, KnownTo(7)), Buff("Focus", 103, 8, KnownTo(7)) },
    Vitals = Healthy(), TickTimes = Std(12_000),
});

Run(new Scenario
{
    Name = "login-gate-streaming-registry", Rules = new[] { "B1" },
    Note = "Registry grows during login streaming (entries appear at +500/+1500); the gate must wait for two equal 1s reads before the first cast.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry =
    {
        Reg(900, 1, 3000, "Bystander"),
        Reg(901, 1, 3000, "Onlooker", appearsAtMs: 500),
        Reg(902, 1, 3000, "Straggler", appearsAtMs: 1500),
    },
    Vitals = Healthy(), TickTimes = Ticks((0, 4000, 1000), (4250, 8000, 250)),
});

Run(new Scenario
{
    Name = "all-active-idle", Rules = new[] { "B3" },
    Note = "All desired families active with 3000s remaining: no batch, no casts, idle.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)), Buff("Endurance", 102, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength"), Reg(102, 7, 3000, "Endurance") },
    Vitals = Healthy(), TickTimes = Std(4000),
});

Run(new Scenario
{
    Name = "expiring-triggers-batch-realign", Rules = new[] { "B3", "B11", "B12" },
    Note = "One family at 250s (below 300s threshold), two healthy at 3000s: B11 batch recasts ALL THREE (timer alignment), not just the expiring one.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)), Buff("Endurance", 102, 8, KnownTo(7)), Buff("Focus", 103, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 250, "Strength"), Reg(102, 7, 3000, "Endurance"), Reg(103, 7, 3000, "Focus") },
    Vitals = Healthy(), TickTimes = Std(12_000),
});

Run(new Scenario
{
    Name = "expiry-boundary-above", Rules = new[] { "B3" },
    Note = "310s remaining, 4s horizon: stays above the 300s threshold on both sides -> no cast.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 310, "Strength") },
    Vitals = Healthy(), TickTimes = Std(4000),
});

Run(new Scenario
{
    Name = "expiry-boundary-below", Rules = new[] { "B3" },
    Note = "295s remaining: below threshold -> immediate batch + recast on both sides.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 295, "Strength") },
    Vitals = Healthy(), TickTimes = Std(5000),
});

Run(new Scenario
{
    Name = "permanent-presence-only-idle", Rules = new[] { "B6" },
    Note = "Desired buff present as a PERMANENT enchant: presence-only active, never recast.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { new RegEntry { SpellId = 1017, Name = "Strength Self VII", Family = 101, Permanent = true } },
    Vitals = Healthy(), TickTimes = Std(4000),
});

Run(new Scenario
{
    Name = "b4-upgrade-after-tier-drop", Rules = new[] { "B4", "B5" },
    ExpectDiverge = true,
    Note = "PROBE: family historically landed VII (achieved=7 learned from first read), then the registry swaps to a friend-cast V with 3000s left (+4s). C# IsBuffActive tier-upgrade (:1211-1214) recasts VII immediately at the next refresh; JS _isActiveReal (buff_loop.js:289-300) checks family presence+remaining only -> never upgrades.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry =
    {
        Reg(101, 7, 3500, "Strength", removedAtMs: 4000),
        Reg(101, 5, 3000, "Strength", appearsAtMs: 4000),
    },
    Vitals = Healthy(), TickTimes = Ticks((0, 1000, 1000), (1250, 4000, 250), (5000, 45_000, 5000), (45_250, 50_000, 250)),
});

Run(new Scenario
{
    Name = "b5-incantation-caps-no-flap", Rules = new[] { "B5", "B8" },
    ExpectDiverge = true,
    Note = "PROBE (found live): Incantation (nominal 8) lands skill-capped as VI. C# confirms BY FAMILY (:555-556) -> 1 cast, converged. JS _isActiveReal (buff_loop.js:288-300) matches the pending SPELL ID against spellFamily (learned only from landings) -> the VI landing does not confirm the Incantation cast -> phantom no-show strike + one wasted recast at the capped tier before converging. Fix: confirm via _familyForSpell (which falls back to spell metadata).",
    Desired = { Buff("Strength", 101, 8, KnownTo(8)) },
    LandsAs = { [1018] = (1016, "Strength Self VI", 101) },
    Vitals = Healthy(), TickTimes = Ticks((0, 1000, 1000), (1250, 8000, 250), (10_000, 40_000, 5000), (40_250, 42_000, 250)),
});

Run(new Scenario
{
    Name = "maxtier-skill-cap", Rules = new[] { "B4" },
    ExpectDiverge = true,
    Note = "PROBE: buffing skill caps the C# tier walk at 5 (GetHighestBuffSpellTier); the JS ladder (buff_loop.js:175-210) has no skill-tier concept and picks the highest KNOWN tier (7). Different spell cast.",
    Desired = { Buff("Strength", 101, 5, KnownTo(7)) },
    Vitals = Healthy(), TickTimes = Std(5000),
});

Run(new Scenario
{
    Name = "parked-family-batch-retrigger-loop", Rules = new[] { "B9", "B10", "B11" },
    ExpectDiverge = true,
    Note = "THE /god-loop PROBE: a silent (never-lands) buff gets no-showed twice and parked. C# AnyBuffBelowThreshold skips parked families (:824-827) -> batch completes and goes idle. JS _anyBelowThreshold (buff_loop.js:315-317) ignores parks -> the batch RETRIGGERS forever, recasting the healthy buff in a loop.",
    Desired =
    {
        new DesiredBuff { BaseName = "Phantom", MaxTier = 8, Ladder = { new SpellCandidate { Id = 1083, Name = "Phantom Ward III", Family = 108, Tier = 3, Known = true } } },
        Buff("Strength", 101, 8, KnownTo(7)),
    },
    Silent = { 1083 },
    Vitals = Healthy(), TickTimes = Std(15_000),
});

Run(new Scenario
{
    Name = "cold-snapshot-tier-down", Rules = new[] { "B9", "B4" },
    ExpectDiverge = true, KnownWarm = false,
    Note = "PROBE: cold spellbook snapshot; the tier-7 spell is 'known' to the lying oracle but silently dropped by the server. C# blacklists it after ONE no-show (cold path :572-573) and walks down to tier I. JS has no tier-down: it recasts VII, parks after 2 no-shows, and stays unbuffed.",
    Desired =
    {
        new DesiredBuff
        {
            BaseName = "Strength", MaxTier = 8,
            Ladder =
            {
                new SpellCandidate { Id = 1011, Name = "Strength Self I", Family = 101, Tier = 1, Known = true },
                new SpellCandidate { Id = 1017, Name = "Strength Self VII", Family = 101, Tier = 7, Known = true },
            },
        },
    },
    Silent = { 1017 },
    Vitals = Healthy(), TickTimes = Std(12_000),
});

Run(new Scenario
{
    Name = "confirm-below-threshold", Rules = new[] { "B8", "B3" },
    ExpectDiverge = true, LandDurationOverrideS = 250,
    Note = "PROBE: the cast lands with only 250s duration (< the 300s rebuff threshold). C# confirm tests expiry>now (:555-556) -> confirms, but the NEXT AnyBuffBelowThreshold retriggers the batch -> C# recasts forever. JS confirm uses _isActiveReal (threshold!) -> the landed cast reads as a no-show -> 2 casts then family parked. BOTH sides are pathological, differently.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    Vitals = Healthy(), TickTimes = Std(8000),
});

Run(new Scenario
{
    Name = "registry-same-family-wire-order", Rules = new[] { "B2" },
    ExpectDiverge = true,
    Note = "PROBE: two same-family registry rows, VII/3500s first then V/400s. C# RefreshFromLiveMemory keeps the LAST row (:1374) -> sees V, achieved=7 -> tier-upgrade recast. JS keeps max-remaining (buff_loop.js:264-267) -> sees VII -> idle. The C# last-wins overwrite is arguably the latent bug here.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3500, "Strength"), Reg(101, 5, 400, "Strength") },
    Vitals = Healthy(), TickTimes = Std(5000),
});

Run(new Scenario
{
    Name = "b13-death-recovery-direct", Rules = new[] { "B13", "B11" },
    Note = "Registry wiped at +5s (death). Driving buff_loop.tick() DIRECTLY, both sides re-sync within ~30s and batch-recast everything.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)), Buff("Endurance", 102, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength"), Reg(102, 7, 3000, "Endurance") },
    ClearAtMs = 5000,
    Vitals = Healthy(), TickTimes = Ticks((0, 1000, 1000), (1250, 6000, 250), (10_000, 30_000, 5000), (30_250, 40_000, 250)),
});

Run(new Scenario
{
    Name = "b13-death-recovery-kernelgate", Rules = new[] { "B13" },
    ExpectDiverge = true, KernelGate = true,
    Note = "PROBE: same death, but the JS side is driven through kernel.js's _buffNeeded gate (:55-59): active==desired -> buff.tick() is never called -> the 30s re-sync (B13) can never run -> JS NEVER rebuffs after death. C# OnHeartbeat is unconditional and recovers.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)), Buff("Endurance", 102, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength"), Reg(102, 7, 3000, "Endurance") },
    ClearAtMs = 5000,
    Vitals = Healthy(), TickTimes = Ticks((0, 1000, 1000), (1250, 6000, 250), (10_000, 30_000, 5000), (30_250, 40_000, 250)),
});

Run(new Scenario
{
    Name = "kernelgate-expiry-starvation", Rules = new[] { "B3", "B13" },
    ExpectDiverge = true, KernelGate = true,
    Note = "PROBE: buff at 400s remaining. C# stores expiry TIMESTAMPS -> detects the 300s crossing at ~+100s and recasts. JS families store a remaining-seconds SNAPSHOT refreshed only inside tick(); under the kernel gate (all-active -> no tick) the snapshot never decays -> JS never rebuffs at all.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 400, "Strength") },
    Vitals = Healthy(), TickTimes = Ticks((0, 1000, 1000), (1250, 3000, 250), (10_000, 150_000, 10_000)),
});

Run(new Scenario
{
    Name = "vitals-emergency-boundary-hp30", Rules = new[] { "B15" },
    ExpectDiverge = true,
    Note = "PROBE: hp exactly 30, stam 50, idle. C# emergency is hp<=30 (:733) -> Stamina-to-Health. JS is hp<30 (vitals.js:122) -> falls to the idle top-off arm -> Heal Self. Different spell at the boundary.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength") },
    Vitals = new VitalsInput { HealthPct = 30, StaminaPct = 50, ManaPct = 100, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(3000),
});

Run(new Scenario
{
    Name = "vitals-order-mana-vs-stam", Rules = new[] { "B16" },
    ExpectDiverge = true,
    Note = "PROBE: in combat, mana 20 (<40) AND stam 25 (<30, >15). C# checks mana BEFORE stamina (:759-760) -> Stamina-to-Mana. JS checks stamina first (vitals.js:133-146) -> Revitalize. Different first spell.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength") },
    Vitals = new VitalsInput { HealthPct = 100, StaminaPct = 25, ManaPct = 20, InCombat = true, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(3000),
});

Run(new Scenario
{
    Name = "vitals-emergency-stam-floor", Rules = new[] { "B15", "B1" },
    ExpectDiverge = true,
    Note = "PROBE (found live): hp 25, stam 18 (<=20 floor): the emergency arm is blocked on BOTH sides and both pick Heal Self — but C# vitals sit inside OnHeartbeat BEHIND the B1 login gate (:493-519), so no heal until the registry stabilizes (~1.5s); JS vitals.step has no login gate and heals from tick 0. Same spell, 2 extra leading JS casts. Cuts both ways: JS heals a dying char at login sooner; C# never casts before its state is trustworthy.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength") },
    Vitals = new VitalsInput { HealthPct = 25, StaminaPct = 18, ManaPct = 100, InCombat = true, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(3000),
});

Run(new Scenario
{
    Name = "vitals-healthkit-before-heal", Rules = new[] { "B16" },
    ExpectDiverge = true,
    Note = "PROBE: hp 50 in combat with a health kit. C# tries the kit before Heal Self (:754-757). The JS port has no kit concept -> casts Heal Self.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength") },
    Vitals = new VitalsInput { HealthPct = 50, StaminaPct = 100, ManaPct = 100, InCombat = true, HasHealthKit = true, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(3000),
});

Run(new Scenario
{
    Name = "vitals-no-progress-valve", Rules = new[] { "B16" },
    ExpectDiverge = true,
    Note = "PROBE: hp stuck at 50 in combat (spell too weak vs pool). C# has no give-up valve -> Heal Self forever. JS parks the hp axis after 6 no-progress casts (vitals.js:46-53, a deliberate web-port addition) -> stops at 6.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InitialRegistry = { Reg(101, 7, 3000, "Strength") },
    Vitals = new VitalsInput { HealthPct = 50, StaminaPct = 100, ManaPct = 100, InCombat = true, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(7000),
});

Run(new Scenario
{
    Name = "pending-buff-blocks-vitals", Rules = new[] { "B8", "B15" },
    ExpectDiverge = true,
    Note = "PROBE: a silent buff cast is pending when hp crashes to 20 at +1.6s. C#'s pending hold (:599) blocks ALL vitals until the 2.5s no-show resolves -> the emergency heal is ~2.1s late. JS (kernel order, vitals FIRST) heals immediately. Same cast sequence, life-threatening latency gap.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    Silent = { 1017 },
    VitalsEvents = { new VitalsEvent { AtMs = 1600, Hp = 20 } },
    Vitals = new VitalsInput { HealthPct = 100, StaminaPct = 100, ManaPct = 100, StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 },
    TickTimes = Std(8000),
});

Run(new Scenario
{
    Name = "busy-gate-blocks-all", Rules = new[] { "B14" },
    Note = "BusyCount=1 the whole run with a missing buff: no casts on either side.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    BusyCount = 1,
    Vitals = Healthy(), TickTimes = Std(3000),
});

Run(new Scenario
{
    Name = "mode-switch-then-cast", Rules = new[] { "B14" },
    Note = "Not in Magic mode until +3s (server-delayed flip): both sides attempt mode switches (different cadences: C# per-interval, JS 3s throttle), then cast once Magic. Cast sequences must match.",
    Desired = { Buff("Strength", 101, 8, KnownTo(7)) },
    InMagicModeInitial = false, ModeAtMs = 3000,
    Vitals = Healthy(), TickTimes = Std(8000),
});

Run(new Scenario
{
    Name = "armor-no-chat-timeout", Rules = new[] { "B7", "B8", "B9" },
    JsSkip = true,
    Note = "C#-only slice coverage (JS item enchants use the chat-plane B7 path, different mechanism): an Impenetrability cast gets zero chat -> 5s no-chat valve -> known spell NOT blacklisted -> retry -> second no-show parks the family.",
    Desired =
    {
        new DesiredBuff
        {
            BaseName = "Impenetrability", MaxTier = 8,
            Ladder = { new SpellCandidate { Id = 1096, Name = "Impenetrability VI", Family = 109, Tier = 6, Known = true } },
        },
    },
    Silent = { 1096 },
    Vitals = Healthy(), TickTimes = Std(16_000),
});

// seeded grinds: mixed remainings, agreement controls
for (int g = 0; g < 2; g++)
{
    var desired = new List<DesiredBuff>();
    var initial = new List<RegEntry>();
    string[] names = { "Strength", "Endurance", "Coordination", "Quickness", "Focus", "Willpower" };
    for (int i = 0; i < 6; i++)
    {
        int fam = 111 + g * 10 + i;
        int knownMax = 5 + rng.Next(3); // 5..7
        desired.Add(Buff(names[i], fam, 8, KnownTo(knownMax)));
        int roll = rng.Next(3);
        if (roll > 0) // 0 = missing entirely
        {
            double remaining = 100 + rng.Next(3900);
            initial.Add(Reg(fam, knownMax, remaining, names[i]));
        }
    }
    Run(new Scenario
    {
        Name = $"grind-seed-{(char)('a' + g)}", Rules = new[] { "B3", "B8", "B11", "B12" },
        Note = "Seeded mixed-remaining grind: batch iff any family is missing/below threshold, then recast ALL desired in order. Agreement control.",
        Desired = desired, InitialRegistry = initial,
        Vitals = Healthy(), TickTimes = Std(20_000),
    });
}

// ── write fixtures.json ─────────────────────────────────────────────────────

var root = new JsonObject
{
    ["meta"] = new JsonObject
    {
        ["slice"] = "BuffScoring",
        ["seed"] = SEED,
        ["t0Ms"] = T0,
        ["landsMs"] = LANDS_MS,
        ["chatMs"] = CHAT_MS,
        ["note"] = "tickTimes/atMs are offsets from t0Ms. expected.* computed by the C# slice via ScheduleBuffsJson. calls[] = up to 8 raw boundary input/output pairs per scenario for wasm-vs-native replay.",
    },
    ["scenarios"] = new JsonArray(scenarios.Cast<JsonNode>().ToArray()),
};

File.WriteAllText(outPath, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"wrote {outPath}: {scenarios.Count} scenarios, {totalTicks} C# ticks, {totalCasts} casts");

// ── setup model types (must follow all top-level statements) ────────────────

sealed class RegEntry
{
    public int SpellId; public string Name = ""; public int Family;
    public double RemainingS; public bool Permanent;
    public double AppearsAtMs = 0;           // offset from T0
    public double RemovedAtMs = double.MaxValue;
}

sealed class VitalsEvent { public double AtMs; public int? Hp, Stam, Mana; }

sealed class Scenario
{
    public required string Name;
    public required string[] Rules;
    public required string Note;
    public bool JsSkip;            // C#-only slice coverage (no JS counterpart)
    public bool KernelGate;        // JS driver applies kernel.js:55-59 _buffNeeded gate
    public bool ExpectDiverge;     // authored expectation (finding probe)
    public BuffConfig Config = new();
    public bool KnownWarm = true;
    public bool InMagicModeInitial = true;
    public double? ModeAtMs;       // offset: mode becomes Magic at T0+offset
    public bool CanCastNow = true;
    public int BusyCount;
    public List<DesiredBuff> Desired = new();
    public VitalsInput Vitals = new() { StamToHealthId = 9001, HealSelfId = 9002, StamToManaId = 9003, RevitalizeId = 9004 };
    public List<VitalsEvent> VitalsEvents = new();
    public List<RegEntry> InitialRegistry = new();
    public double? ClearAtMs;      // offset: registry wiped (death) at T0+offset
    public HashSet<int> Silent = new();                    // casts that never land
    public Dictionary<int, (int id, string name, int fam)> LandsAs = new(); // skill-capped landing
    public double? LandDurationOverrideS;
    public required List<double> TickTimes;                // absolute ms
}
