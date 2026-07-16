// Console fixture runner for the CombatScoring slice.
// Generates synthetic-but-realistic selection scenarios, runs each through the
// C# scoring via the SAME JSON boundary the wasm export uses
// (TargetScoring.ScoreTargetsJson), and writes fixtures.json:
//   { meta, scenarios: [ { name, rules[], note, input, expected } ] }
// parity_check.cjs replays `input` against apps/holtburger-web/rynth/combat_loop.js
// and compares against `expected` (the C# answer).
//
// Determinism: seeded System.Random (stable algorithm for seeded instances);
// same seed -> byte-identical fixtures.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RynthNetwasm.CombatScoring;

const int SEED = 12345;
const int PLAYER_ID = 0x0F000001;
const uint PLAYER_CELL = 0xA9B40015; // some outdoor LB (0xA9B4), local cell
const double NOW_MS = 1_000_000.0;

string outPath = args.Length > 0 ? args[0] : "fixtures.json";
var rng = new Random(SEED);
var scenarios = new List<JsonObject>();

PlayerPose Player(double x = 96, double y = 96, double z = 0, double qw = 1, double qz = 0, bool hasPose = true)
    => new() { HasPose = hasPose, ObjCellId = PLAYER_CELL, X = x, Y = y, Z = z, QW = qw, QZ = qz };

EntityState Mob(int id, string name, double dx, double dy, float hp = 1f, double dz = 0)
    => new()
    {
        Id = id, Name = name, ObjectClass = 5, ItemType = 16,
        ObjCellId = PLAYER_CELL, X = 96 + dx, Y = 96 + dy, Z = dz, HealthRatio = hp,
    };

ScoringInput Input(List<EntityState> ents, ScoringConfig? cfg = null, LockState? lk = null, PlayerPose? p = null)
    => new()
    {
        NowMs = NOW_MS, PlayerId = PLAYER_ID,
        Player = p ?? Player(),
        Config = cfg ?? new ScoringConfig(),
        Lock = lk ?? new LockState(),
        Entities = ents,
    };

void Add(string name, string[] rules, string note, ScoringInput input)
{
    // Run through the SAME single JSON boundary the wasm export exposes.
    string inJson = JsonSerializer.Serialize(input, ScoringJsonContext.Default.ScoringInput);
    string outJson = TargetScoring.ScoreTargetsJson(inJson);
    scenarios.Add(new JsonObject
    {
        ["name"] = name,
        ["rules"] = new JsonArray(Array.ConvertAll(rules, r => (JsonNode)r!)),
        ["note"] = note,
        ["input"] = JsonNode.Parse(inJson),
        ["expected"] = JsonNode.Parse(outJson),
    });
}

// ── hand-authored divergence probes ─────────────────────────────────────────

Add("wounded-far-vs-healthy-near", new[] { "T7" },
    "C# hpScore(0-50) prefers the wounded far mob; JS 100-d has no hp term.",
    Input(new List<EntityState> { Mob(0x10000001, "Drudge Skulker", 0, 20), Mob(0x10000002, "Drudge Lurker", 0, 30, 0.15f) }));

Add("facing-behind-vs-ahead", new[] { "T7" },
    "Equal-ish distance; C# facingScore(0-10) prefers the mob ahead; JS prefers strictly nearer.",
    Input(new List<EntityState> { Mob(0x10000003, "Mite Snippet", 0, 10), Mob(0x10000004, "Mite Crawler", 0.5, -9.6) }));

Add("threat-range-bonus", new[] { "T7" },
    "Both in melee band; agreement expected (threat bonus applies to the nearer one anyway).",
    Input(new List<EntityState> { Mob(0x10000005, "Rat", 0, 2.5f), Mob(0x10000006, "Rat", 0, 4) }));

Add("priority-rule-shared", new[] { "T8" },
    "olthoi rule priority 10 -> +45 on both sides; both should pick the Olthoi over the nearer Drudge.",
    Input(new List<EntityState> { Mob(0x10000007, "Olthoi Warrior", 0, 35), Mob(0x10000008, "Drudge Skulker", 0, 15) },
        new ScoringConfig { MonsterRules = { new MonsterRule { Name = "olthoi", Priority = 10 } } }));

Add("priority-first-match-vs-max", new[] { "T8" },
    "Two rules match 'Olthoi Soldier'. C# FirstOrDefault takes list-order first (p3 -> +10); JS takes max (p10 -> +45).",
    Input(new List<EntityState> { Mob(0x10000009, "Olthoi Soldier", 0, 38), Mob(0x1000000A, "Drudge Sneaker", 0, 25) },
        new ScoringConfig { MonsterRules = {
            new MonsterRule { Name = "olthoi", Priority = 3 },
            new MonsterRule { Name = "olthoi soldier", Priority = 10 } } }));

Add("stickiness-hold", new[] { "T9" },
    "Locked target; alternative better by <25 -> both hold the lock.",
    Input(new List<EntityState> { Mob(0x1000000B, "Shreth", 0, 20), Mob(0x1000000C, "Shreth", 0, 14) },
        lk: new LockState { LockedTargetId = 0x1000000B, ActiveTargetId = 0x1000000B }));

Add("stickiness-switch", new[] { "T9" },
    "SCALE-MISMATCH PROBE: 23yd-closer alt. C# distScore is 2pts/yd so +46 beats stickiness 25 -> switch; JS 100-d is 1pt/yd so +23 < 25 -> hold. The tuned constant 25 assumed the C# score scale.",
    Input(new List<EntityState> { Mob(0x1000000D, "Shreth", 0, 35), Mob(0x1000000E, "Shreth", 0, 12) },
        lk: new LockState { LockedTargetId = 0x1000000D, ActiveTargetId = 0x1000000D }));

Add("stickiness-switch-both", new[] { "T9" },
    "33yd-closer alt: clears the stickiness threshold on BOTH scales -> both switch (control for the scale-mismatch probe).",
    Input(new List<EntityState> { Mob(0x10000041, "Shreth", 0, 38), Mob(0x10000042, "Shreth", 0, 5) },
        lk: new LockState { LockedTargetId = 0x10000041, ActiveTargetId = 0x10000041 }));

Add("stickiness-exact-tie", new[] { "T9" },
    "Alt exactly locked+25 (hasPose=false so facing is uniform). C# argmax: strict '>' resolves by scan order (nearer alt first) -> switch; JS strict '>' -> hold.",
    Input(new List<EntityState> { Mob(0x1000000F, "Gromnie", 0, 30), Mob(0x10000010, "Gromnie", 0, 17.5f) },
        lk: new LockState { LockedTargetId = 0x1000000F, ActiveTargetId = 0x1000000F },
        p: Player(hasPose: false)));

Add("scan-grace-hold-no-alternative", new[] { "T10", "T12" },
    "Locked target vanished from the world snapshot entirely. C# treats a world-filter null as a transient miss and holds through the 1500ms grace; the shipped JS tick() kill-confirms on !pos IMMEDIATELY (combat_loop.js:308-321) -> false kill + 30s suppression on a transient entity-stream miss.",
    Input(new List<EntityState>(),
        lk: new LockState { LockedTargetId = 0x10000011, ActiveTargetId = 0x10000011 }));

Add("scan-grace-expired", new[] { "T10" },
    "Locked target lost 2000ms ago (>1500) -> both drop; nothing to re-acquire.",
    Input(new List<EntityState>(),
        lk: new LockState { LockedTargetId = 0x10000012, ActiveTargetId = 0x10000012, TargetLostScanAtMs = NOW_MS - 2000 }));

var losLost = Mob(0x10000013, "Tumerok Scout", 0, 18);
losLost.LosBlocked = true;
Add("scan-grace-with-alternative", new[] { "T10" },
    "Locked target LOS-blocked this tick, alternative visible. C# re-locks the alternative IMMEDIATELY (lock absent from argmax); JS holds the lock through the full 1500ms grace.",
    Input(new List<EntityState> { losLost, Mob(0x10000014, "Tumerok Warrior", 0, 22) },
        lk: new LockState { LockedTargetId = 0x10000013, ActiveTargetId = 0x10000013 }));

var killed6s = Mob(0x10000015, "Drudge Ravener", 0, 10);
killed6s.KilledMsAgo = 6000;
Add("recently-killed-6s", new[] { "T13", "T2" },
    "Kill signal 6s ago: C# TTL is 4000ms -> re-acquirable (and nearest wins); JS TTL is 30000ms -> excluded.",
    Input(new List<EntityState> { killed6s, Mob(0x10000016, "Drudge Ravener", 0, 25) }));

var killed3s = Mob(0x10000017, "Drudge Ravener", 0, 10);
killed3s.KilledMsAgo = 3000;
Add("recently-killed-3s", new[] { "T13", "T2" },
    "Kill signal 3s ago: suppressed on both sides.",
    Input(new List<EntityState> { killed3s, Mob(0x10000018, "Drudge Ravener", 0, 25) }));

var killed35s = Mob(0x10000019, "Drudge Ravener", 0, 10);
killed35s.KilledMsAgo = 35_000;
Add("recently-killed-35s", new[] { "T13", "T2" },
    "Kill signal 35s ago: past both TTLs -> both re-acquire.",
    Input(new List<EntityState> { killed35s, Mob(0x1000001A, "Drudge Ravener", 0, 25) }));

Add("dead-not-corpse", new[] { "T2" },
    "hp==0 excluded on both sides; both pick the live mob.",
    Input(new List<EntityState> { Mob(0x1000001B, "Mosswart", 0, 8, 0f), Mob(0x1000001C, "Mosswart", 0, 20) }));

Add("unknown-hp-full-bonus", new[] { "T7", "T2" },
    "HealthRatio -1 (no update yet) passes the ==0 filter and C# clamps -1->0 => FULL 50pt wounded bonus for an unknown-HP mob. JS ignores hp in scoring.",
    Input(new List<EntityState> { Mob(0x1000001D, "Banderling", 0, 20, -1f), Mob(0x1000001E, "Banderling", 0, 15) }));

var pl1 = new EntityState { Id = 0x50000123, Name = "Xerxes", ObjectClass = 24, IsPlayer = true, ItemType = 16, ObjCellId = PLAYER_CELL, X = 96, Y = 101, HealthRatio = 1f };
var pl2 = new EntityState { Id = 0x50000456, Name = "Salvia", ObjectClass = 24, IsPlayer = true, ItemType = 16, ObjCellId = PLAYER_CELL, X = 99, Y = 96, HealthRatio = 1f };
Add("players-excluded", new[] { "T2" },
    "Players in the mix (nearer than the mob) -> both exclude, pick the monster.",
    Input(new List<EntityState> { pl1, pl2, Mob(0x1000001F, "Rat", 0, 12) }));

var guidRangeMob = new EntityState { Id = 0x5A00BEEF, Name = "Shadow Sliver", ObjectClass = 5, IsPlayer = false, ItemType = 16, ObjCellId = PLAYER_CELL, X = 96, Y = 104, HealthRatio = 1f };
Add("monster-in-player-guid-range", new[] { "T2" },
    "Monster whose guid falls in 0x50000000-0x5FFFFFFF: C# classifies by ObjectClass -> includes; JS guid-range heuristic excludes it.",
    Input(new List<EntityState> { guidRangeMob, Mob(0x10000020, "Shadow Sliver", 0, 15) }));

var crossLb = new EntityState { Id = 0x10000021, Name = "Auroch", ObjectClass = 5, ItemType = 16, ObjCellId = 0xAAB40011, X = 96 - 192 + 30, Y = 96, HealthRatio = 1f };
Add("cross-landblock-neighbor", new[] { "T2" },
    "Mob in the adjacent LB, global distance 30: C# global-frame distance includes it; JS same-LB gate excludes it.",
    Input(new List<EntityState> { crossLb, Mob(0x10000022, "Auroch", 0, 35) }));

Add("distance-45", new[] { "T2", "T3" },
    "Mob at 45: inside C# MonsterRange(50), outside JS's hardcoded 40 -> C# picks it, JS sees nothing.",
    Input(new List<EntityState> { Mob(0x10000023, "Reedshark", 0, 45) }));

Add("engaged-hysteresis-52", new[] { "T3" },
    "Locked target stepped back to 52 (disengage = MonsterRange+3 = 53): C# retains via hysteresis; JS excludes >40 but holds via scan grace -> same chosen id by different mechanisms.",
    Input(new List<EntityState> { Mob(0x10000024, "Zefir", 0, 52) },
        lk: new LockState { LockedTargetId = 0x10000024, ActiveTargetId = 0x10000024 }));

Add("engaged-hysteresis-55-with-alt", new[] { "T3", "T12" },
    "Locked target at 55 (> disengage 53): C# validation drops 'out of range' and re-locks the alternative same tick; JS holds the stale lock through grace.",
    Input(new List<EntityState> { Mob(0x10000025, "Zefir", 0, 55), Mob(0x10000026, "Zefir", 0, 30) },
        lk: new LockState { LockedTargetId = 0x10000025, ActiveTargetId = 0x10000025 }));

Add("spell-projectile-excluded", new[] { "T5" },
    "'Flame Bolt' misclassified as Monster: C# name-excludes it (T5); JS has no projectile-name filter and will target it.",
    Input(new List<EntityState> { Mob(0x10000027, "Flame Bolt", 0, 6), Mob(0x10000028, "Scalded Wisp", 0, 14) }));

var vendor = Mob(0x10000029, "Aun Ralirea", 0, 5);
vendor.Attackable = false;
Add("not-attackable-vendor", new[] { "T2" },
    "Attackable=false (vendor/NPC with Monster class): both exclude.",
    Input(new List<EntityState> { vendor, Mob(0x1000002A, "Sclavus", 0, 18) }));

var freshSpawn = Mob(0x1000002B, "Olthoi Grub", 0, 9);
freshSpawn.AttackableUnknown = true;
Add("attackable-unknown-t4", new[] { "T4" },
    "Desc-flags/weenie not yet populated: RynthAi T4 fails OPEN (attackable) -> C# targets it; webhost.js:346-349 fails CLOSED -> JS excludes it.",
    Input(new List<EntityState> { freshSpawn, Mob(0x1000002C, "Olthoi Grub", 0, 16) }));

var blacklisted = Mob(0x1000002D, "Ruschk Sadist", 0, 7);
blacklisted.Blacklisted = true;
Add("blacklisted-mob", new[] { "T15", "T2" },
    "Blacklisted (confirmed-miss) mob: C# excludes; the shipped JS loop has no blacklist input at all and targets it.",
    Input(new List<EntityState> { blacklisted, Mob(0x1000002E, "Ruschk Warder", 0, 21) }));

var neverAttack = Mob(0x1000002F, "Paroxysm Wisp", 0, 7);
neverAttack.UserNeverAttack = true;
Add("user-never-attack", new[] { "T2" },
    "User never-attack list: C# excludes; the shipped JS loop has no such input and targets it.",
    Input(new List<EntityState> { neverAttack, Mob(0x10000030, "Wisp", 0, 21) }));

Add("empty-world", new[] { "T2" }, "No entities at all -> both select nothing.",
    Input(new List<EntityState>()));

Add("locked-validation-corpse", new[] { "T12" },
    "Locked target reclassified to corpse (ObjectClass!=Monster): C# drops 'became corpse' and re-locks the alt same tick; JS excludes it from scan (itemType filter) and holds via grace.",
    Input(new List<EntityState>
        {
            new EntityState { Id = 0x10000031, Name = "Drudge Prowler", ObjectClass = 8, ItemType = 1, ObjCellId = PLAYER_CELL, X = 96, Y = 106, HealthRatio = 0f },
            Mob(0x10000032, "Drudge Prowler", 0, 18),
        },
        lk: new LockState { LockedTargetId = 0x10000031, ActiveTargetId = 0x10000031 }));

Add("locked-died-hp0-with-alt", new[] { "T12" },
    "Locked target hp->0 (dead-not-corpse): C# validation drops 'hp=0' and re-locks the alt same tick; JS _selectTarget holds it (its kill-check lives in tick(), one tick later).",
    Input(new List<EntityState> { Mob(0x10000033, "Gromnie", 0, 10, 0f), Mob(0x10000034, "Gromnie", 0, 24) },
        lk: new LockState { LockedTargetId = 0x10000033, ActiveTargetId = 0x10000033 }));

// ── randomized grind scenarios in the SHARED domain ─────────────────────────
// (same LB, dist<40, known hp, ids outside the player-guid range, no rules —
//  so any disagreement isolates the scoring-formula difference, T7)
string[] mobNames = { "Drudge Skulker", "Mite Snippet", "Gromnie", "Rat", "Shreth", "Mosswart", "Banderling", "Reedshark" };
for (int i = 0; i < 10; i++)
{
    int n = 3 + rng.Next(6);
    var ents = new List<EntityState>();
    for (int j = 0; j < n; j++)
    {
        double ang = rng.NextDouble() * 2 * Math.PI;
        double d = 3 + rng.NextDouble() * 36; // 3..39
        float hp = 0.2f + (float)rng.NextDouble() * 0.8f;
        ents.Add(Mob(0x11000000 + i * 0x100 + j, mobNames[rng.Next(mobNames.Length)],
            Math.Sin(ang) * d, Math.Cos(ang) * d, hp));
    }
    // Half the scenarios carry a pre-existing lock on a random mob.
    LockState? lk = null;
    if (i % 2 == 1)
    {
        int pick = ents[rng.Next(ents.Count)].Id;
        lk = new LockState { LockedTargetId = pick, ActiveTargetId = pick };
    }
    Add($"grind-random-{i:00}", new[] { "T7", "T9" },
        "Randomized shared-domain grind scene; disagreements isolate the scoring-formula gap (C# multi-term vs JS 100-d).",
        Input(ents, lk: lk));
}

// Randomized mixed scenes: players + a dead mob + a priority rule, still <40.
for (int i = 0; i < 5; i++)
{
    var ents = new List<EntityState>();
    int n = 2 + rng.Next(4);
    for (int j = 0; j < n; j++)
    {
        double ang = rng.NextDouble() * 2 * Math.PI;
        double d = 4 + rng.NextDouble() * 34;
        ents.Add(Mob(0x12000000 + i * 0x100 + j, mobNames[rng.Next(mobNames.Length)],
            Math.Sin(ang) * d, Math.Cos(ang) * d, 0.2f + (float)rng.NextDouble() * 0.8f));
    }
    ents.Add(new EntityState { Id = 0x50000700 + i, Name = "PlayerKilledSteve", ObjectClass = 24, IsPlayer = true, ItemType = 16, ObjCellId = PLAYER_CELL, X = 96 + 3, Y = 96 + 3, HealthRatio = 1f });
    var dead = Mob(0x12000090 + i, "Rat", 1, -4, 0f);
    ents.Add(dead);
    var cfg = new ScoringConfig { MonsterRules = { new MonsterRule { Name = "gromnie", Priority = 4 } } };
    Add($"mixed-random-{i:00}", new[] { "T2", "T7", "T8" },
        "Mixed scene: players + dead mob + priority rule, shared domain.",
        Input(ents, cfg));
}

// ── write fixtures.json ─────────────────────────────────────────────────────
var root = new JsonObject
{
    ["meta"] = new JsonObject
    {
        ["generator"] = "CombatScoring.Fixtures (netwasm-spike lift slice 1)",
        ["seed"] = SEED,
        ["count"] = scenarios.Count,
        ["contract"] = "expected = C# TargetScoring.SelectTargetTick via ScoreTargetsJson (the wasm boundary)",
        ["playerId"] = PLAYER_ID,
        ["nowMs"] = NOW_MS,
    },
    ["scenarios"] = new JsonArray(scenarios.ToArray()),
};
File.WriteAllText(outPath, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine($"wrote {scenarios.Count} scenarios -> {outPath}");
