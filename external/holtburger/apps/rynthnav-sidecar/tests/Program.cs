// tests/Program.cs — assert-runner for DetourRouter's tile budget + LRU eviction
// (RYNTHNAV_MAX_TILES / RYNTHNAV_TILE_HIGH_WATER, see DetourRouter.cs header).
//
// Needs a baked tile fixture covering lbX A7..AA x lbY B2..B5 (terrain-only is fine):
//   dotnet ../bin/Release/net10.0/RynthNav.Sidecar.dll bake \
//     --ac ~/ac_base_dats --out <dir> --tiled A7,AA,B2,B5
// Run:
//   dotnet run -c Release -- --nav <dir>        (or RYNTHNAV_TEST_NAV_DIR=<dir>)
//
// Why 4x4 and not smaller: LoadCorridor pads the bbox by +1 lb, so proving
// "eviction never touches the CURRENT corridor" needs two corridors whose padded
// bboxes are disjoint — corner routes in a 4x4 fixture are the smallest such pair.

using System.Reflection;
using RynthNav.Sidecar;

string? navDir = null;
for (int i = 0; i < args.Length - 1; i++)
    if (args[i] == "--nav") navDir = args[i + 1];
navDir ??= Environment.GetEnvironmentVariable("RYNTHNAV_TEST_NAV_DIR");
if (navDir == null || !Directory.Exists(navDir) || Directory.GetFiles(navDir, "nav_*.tile").Length < 16)
{
    Console.Error.WriteLine("need --nav <dir> (or RYNTHNAV_TEST_NAV_DIR) pointing at a baked A7,AA,B2,B5 fixture — see header comment for the bake command");
    return 2;
}

int pass = 0, fail = 0;
void Check(bool cond, string name, string detail = "")
{
    if (cond) { pass++; Console.WriteLine($"PASS {name}"); }
    else { fail++; Console.WriteLine($"FAIL {name}{(detail.Length > 0 ? " — " + detail : "")}"); }
}

// Env vars are read once in the ctor, so scope them to construction only.
DetourRouter MakeRouter(string? maxTiles, string? highWater)
{
    Environment.SetEnvironmentVariable("RYNTHNAV_MAX_TILES", maxTiles);
    Environment.SetEnvironmentVariable("RYNTHNAV_TILE_HIGH_WATER", highWater);
    try { return new DetourRouter(navDir!, Path.Combine(navDir!, "no-such-portals.tsv")); }
    finally
    {
        Environment.SetEnvironmentVariable("RYNTHNAV_MAX_TILES", null);
        Environment.SetEnvironmentVariable("RYNTHNAV_TILE_HIGH_WATER", null);
    }
}

// Fixture tiles span heights 28..126 (Recast Y); z=77 keeps FindNearestPoly's
// (8,64,8) vertical half-extent over the whole surface.
const double Z = 77.0;
WorldPt In(int lbX, int lbY, double x, double y)
    => DetourRouter.LbLocalToWorld((uint)((lbX << 24) | (lbY << 16) | 1), x, y, Z);
// A short route inside one landblock; corridor bbox = that lb +1 margin.
RouteOutcome RouteWithin(DetourRouter r, int lbX, int lbY)
    => r.Route(In(lbX, lbY, 24, 24), In(lbX, lbY, 168, 168));

uint[] Sorted(IEnumerable<uint> xs) => xs.OrderBy(x => x).ToArray();
string Hex(IEnumerable<uint> xs) => string.Join(",", xs.Select(x => x.ToString("X4")));
// Corner-corridor tile sets inside the 4x4 fixture (bbox +1 margin clipped to baked files).
var s1 = Sorted(new uint[] { 0xA7B2, 0xA7B3, 0xA8B2, 0xA8B3 }); // route within A7B2
var s2 = Sorted(new uint[] { 0xA9B4, 0xA9B5, 0xAAB4, 0xAAB5 }); // route within AAB5

// ── T1: env parsing — defaults, garbage, explicit, clamps ────────────────────
{
    var r = MakeRouter(null, null);
    Check(r.MaxTilesConfigured == 1024 && r.TileHighWater == 960, "T1a env unset -> 1024/960", $"got {r.MaxTilesConfigured}/{r.TileHighWater}");
    r = MakeRouter("banana", "-3");
    Check(r.MaxTilesConfigured == 1024 && r.TileHighWater == 960, "T1b garbage -> defaults", $"got {r.MaxTilesConfigured}/{r.TileHighWater}");
    r = MakeRouter("0", "0");
    Check(r.MaxTilesConfigured == 1024 && r.TileHighWater == 960, "T1c non-positive -> defaults", $"got {r.MaxTilesConfigured}/{r.TileHighWater}");
    r = MakeRouter("6", "4");
    Check(r.MaxTilesConfigured == 6 && r.TileHighWater == 4, "T1d explicit 6/4 honored", $"got {r.MaxTilesConfigured}/{r.TileHighWater}");
    r = MakeRouter("6", "99");
    Check(r.TileHighWater == 5, "T1e high water clamped to maxTiles-1", $"got {r.TileHighWater}");
    r = MakeRouter("1", null);
    Check(r.MaxTilesConfigured == 2 && r.TileHighWater == 1, "T1f maxTiles floor 2, default high water clamped to 1", $"got {r.MaxTilesConfigured}/{r.TileHighWater}");
}

// ── T2: LRU ordering under a roomy budget (no eviction involved) ─────────────
{
    var r = MakeRouter(null, null);
    var res1 = RouteWithin(r, 0xA7, 0xB2);
    Check(res1.Ok && res1.Coverage == "detour", "T2a corner-1 route ok/detour", $"ok={res1.Ok} cov={res1.Coverage} err={res1.Error}");
    Check(Sorted(r.LoadedTilesLruFirst()).SequenceEqual(s1), "T2b corner-1 loads exactly its 4 tiles", Hex(r.LoadedTilesLruFirst()));
    var res2 = RouteWithin(r, 0xAA, 0xB5);
    var lru = r.LoadedTilesLruFirst();
    Check(lru.Count == 8 && Sorted(lru.Take(4)).SequenceEqual(s1) && Sorted(lru.Skip(4)).SequenceEqual(s2),
        "T2c after corner-2: corner-1 tiles are LRU-first", Hex(lru));
    RouteWithin(r, 0xA7, 0xB2); // touch corner-1 again
    lru = r.LoadedTilesLruFirst();
    Check(lru.Count == 8 && Sorted(lru.Take(4)).SequenceEqual(s2) && Sorted(lru.Skip(4)).SequenceEqual(s1),
        "T2d re-touch flips LRU order", Hex(lru));
    Check(res2.Ok && res2.Coverage == "detour", "T2e corner-2 route ok/detour", $"cov={res2.Coverage} err={res2.Error}");
}

// ── T3: add -> evict -> re-add round-trip; query rebuilt after eviction ──────
{
    var r = MakeRouter("6", "4"); // corner corridor = 4 tiles; two corners can't coexist
    var res1 = RouteWithin(r, 0xA7, 0xB2);
    Check(res1.Ok && res1.Coverage == "detour" && Sorted(r.LoadedTilesLruFirst()).SequenceEqual(s1),
        "T3a corner-1 loaded", $"cov={res1.Coverage} tiles={Hex(r.LoadedTilesLruFirst())}");
    var res2 = RouteWithin(r, 0xAA, 0xB5);
    Check(res2.Ok && res2.Coverage == "detour", "T3b corner-2 routes ok/detour post-eviction (fresh query works)", $"ok={res2.Ok} cov={res2.Coverage} err={res2.Error}");
    Check(Sorted(r.LoadedTilesLruFirst()).SequenceEqual(s2),
        "T3c corner-1 fully evicted, corner-2 corridor fully retained", Hex(r.LoadedTilesLruFirst()));
    var res3 = RouteWithin(r, 0xA7, 0xB2); // re-add the evicted tiles
    Check(res3.Ok && res3.Coverage == "detour" && Sorted(r.LoadedTilesLruFirst()).SequenceEqual(s1),
        "T3d evicted tiles re-add cleanly (round-trip)", $"cov={res3.Coverage} tiles={Hex(r.LoadedTilesLruFirst())}");
}

// ── T4: current-corridor tiles are never evicted, even above high water ──────
{
    var r = MakeRouter("4", "2"); // hard cap 3 < corridor demand 4, high water 2 < corridor
    var res = RouteWithin(r, 0xA7, 0xB2);
    var tiles = r.LoadedTilesLruFirst();
    Check(res.Ok, "T4a route ok under starved budget", res.Error);
    Check(tiles.Count == 3, "T4b hard cap holds at maxTiles-1", $"count={tiles.Count}");
    Check(tiles.All(t => s1.Contains(t)), "T4c every survivor is a current-corridor tile", Hex(tiles));
    Check(tiles.Count > r.TileHighWater, "T4d protected corridor may sit above high water (no thrash)", $"{tiles.Count} <= {r.TileHighWater}");
}

// ── T5: route spanning more tiles than maxTiles degrades gracefully ──────────
{
    var r = MakeRouter("6", "4");
    var res = r.Route(In(0xA7, 0xB2, 24, 24), In(0xAA, 0xB5, 168, 168)); // 16 baked tiles in bbox
    Check(res.Ok && res.Legs.Count > 0, "T5a whole-region route still returns legs", $"ok={res.Ok} err={res.Error}");
    Check(r.LoadedTileCount == 5, "T5b loaded tiles capped at maxTiles-1", $"count={r.LoadedTileCount}");
}

// ── T6: corridor cap constant untouched (interplay contract) ─────────────────
{
    var f = typeof(DetourRouter).GetField("MaxCorridorTiles", BindingFlags.NonPublic | BindingFlags.Static);
    Check(f != null && (int)f!.GetRawConstantValue()! == 220, "T6 MaxCorridorTiles still 220", $"got {f?.GetRawConstantValue()}");
}

Console.WriteLine($"\n{pass} passed, {fail} failed");
return fail == 0 ? 0 : 1;
