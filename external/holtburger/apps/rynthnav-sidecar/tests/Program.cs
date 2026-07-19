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
    // AAB5 is the fixture's water-heavy NE corner: its within-lb route legitimately mixes
    // real Detour legs with water-gap stitches (contract-v2 flags them; pre-fix the <=15 m
    // tail-swallow hid the short-fall as pure "detour"). The LRU invariant only needs the
    // corridor query to have RUN — i.e. coverage != "straight" (some Detour poly was used).
    Check(res2.Ok && res2.Coverage != "straight", "T2e corner-2 route ok, Detour ran (detour|mixed)", $"cov={res2.Coverage} err={res2.Error}");
}

// ── T3: add -> evict -> re-add round-trip; query rebuilt after eviction ──────
{
    var r = MakeRouter("6", "4"); // corner corridor = 4 tiles; two corners can't coexist
    var res1 = RouteWithin(r, 0xA7, 0xB2);
    Check(res1.Ok && res1.Coverage == "detour" && Sorted(r.LoadedTilesLruFirst()).SequenceEqual(s1),
        "T3a corner-1 loaded", $"cov={res1.Coverage} tiles={Hex(r.LoadedTilesLruFirst())}");
    var res2 = RouteWithin(r, 0xAA, 0xB5);
    // Post-eviction the FRESH query must still find Detour polys for corner-2 (water-heavy
    // AAB5 => "mixed", not pure "detour"; see T2e). "straight" would mean a broken query.
    Check(res2.Ok && res2.Coverage != "straight", "T3b corner-2 routes ok post-eviction, Detour ran (fresh query works)", $"ok={res2.Ok} cov={res2.Coverage} err={res2.Error}");
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

// Leg (lb,x,y) -> world metres, to compare a leg endpoint against a requested WorldPt.
(double wx, double wy) LegWorld(Leg l) => (((l.Lb >> 24) & 0xFF) * 192.0 + l.X, ((l.Lb >> 16) & 0xFF) * 192.0 + l.Y);

// ── T7 (contract v2, check a): off-mesh / out-of-region goal ─────────────────
// A goal well outside the baked fixture bbox has no tile: no Detour path, so the
// whole segment is an out-of-coverage stitch. Tail must be flagged and reach the goal.
{
    var r = MakeRouter(null, null);
    var goal = In(0xC0, 0xB3, 96, 96);              // far east of A7..AA x B2..B5
    var res = r.Route(In(0xA7, 0xB2, 24, 24), goal);
    Check(res.Ok && res.Legs.Count > 0, "T7a out-of-region route returns legs", $"ok={res.Ok} err={res.Error}");
    Check(res.Legs.Count > 0 && res.Legs[^1].Stitch, "T7b tail leg is stitch:true", res.Legs.Count > 0 ? $"stitch={res.Legs[^1].Stitch}" : "no legs");
    Check(res.Partial, "T7c route is partial:true", $"partial={res.Partial}");
    Check(res.StitchedLegs == res.Legs.Count(l => l.Stitch) && res.StitchedLegs > 0, "T7d stitchedLegs counts flagged legs", $"stitchedLegs={res.StitchedLegs} counted={res.Legs.Count(l => l.Stitch)}");
    var (twx, twy) = LegWorld(res.Legs[^1]);
    Check(Math.Abs(twx - goal.Wx) < 0.5 && Math.Abs(twy - goal.Wy) < 0.5, "T7e final leg is AT the requested goal", $"tail=({twx:F1},{twy:F1}) goal=({goal.Wx:F1},{goal.Wy:F1})");
}

// ── T8 (contract v2, check b): a clean on-mesh route has no stitches ─────────
{
    var r = MakeRouter(null, null);
    var res = RouteWithin(r, 0xA8, 0xB3);           // fully on-mesh interior landblock
    Check(res.Ok && res.Coverage == "detour", "T8a on-mesh route ok/detour", $"cov={res.Coverage} err={res.Error}");
    Check(res.StitchedLegs == 0, "T8b stitchedLegs==0", $"stitchedLegs={res.StitchedLegs}");
    Check(!res.Partial, "T8c partial==false", $"partial={res.Partial}");
    Check(res.Legs.All(l => !l.Stitch), "T8d no leg flagged stitch", Hex(res.Legs.Where(l => l.Stitch).Select(l => l.Lb)));
}

// ── T9 (contract v2, check c): terminal stitch flips detour -> mixed ─────────
// On-mesh start; goal ~8 m past the fixture's west edge. FindNearestPoly snaps the
// goal onto the edge poly (within its 12 m half-extent) so Detour DOES run, but the
// string-pull lands short of the requested point -> a flagged terminal stitch closes
// the gap. Coverage must become "mixed" (was silently "detour" before the fix).
{
    var r = MakeRouter(null, null);
    var goal = In(0xA6, 0xB3, 184, 96);
    var res = r.Route(In(0xA7, 0xB3, 96, 96), goal);
    Check(res.Ok, "T9a edge-overshoot route ok", res.Error);
    Check(res.Coverage == "mixed", "T9b terminal stitch flips coverage detour->mixed", $"cov={res.Coverage}");
    Check(res.StitchedLegs >= 1 && res.Partial, "T9c stitched tail present and partial:true", $"stitchedLegs={res.StitchedLegs} partial={res.Partial}");
    Check(res.Legs.Count > 0 && res.Legs[^1].Stitch, "T9d final (gap-closing) leg is stitch:true", res.Legs.Count > 0 ? $"stitch={res.Legs[^1].Stitch}" : "no legs");
    Check(res.Legs.Any(l => !l.Stitch), "T9e real Detour legs precede the stitch tail", "");
    var (twx, twy) = LegWorld(res.Legs[^1]);
    Check(Math.Abs(twx - goal.Wx) < 0.5 && Math.Abs(twy - goal.Wy) < 0.5, "T9f stitched tail reaches the requested goal", $"tail=({twx:F1},{twy:F1}) goal=({goal.Wx:F1},{goal.Wy:F1})");
}

Console.WriteLine($"\n{pass} passed, {fail} failed");
return fail == 0 ? 0 : 1;
