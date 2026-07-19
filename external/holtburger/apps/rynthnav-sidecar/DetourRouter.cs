// DetourRouter.cs — the RynthNav global-router query layer, lifted from
// /mnt/wbterminal1/ac-refs/rynthsuite/Plugins/RynthCore.Plugin.RynthNav/RynthNavPlugin.cs @ bf1fb52:
//   EnsureNavMesh  :141-149  (DtNavMeshParams orig=(0,0,0), tileWidth=tileHeight=192, maxTiles=256, maxPolys=1<<16)
//   EnsureTile     :151-167  (nav_{lb:X4}.tile + DtMeshDataReader().Read(br,6) + AddTile)
//   LoadCorridorTo :222-239  (bounding-box corridor load, MaxCorridorTiles=220)
//   Replan         :595-627  (FindNearestPoly half-extents start (8,64,8) target (12,256,12),
//                             FindPath Span<long>[512], FindStraightPath Span<DtStraightPath>[512])
//   TSV parse      :562-568  (5 cols SrcNs SrcEw DstNs DstEw Name)
//   coord formulas :128-130,:295-296,:585-586,:707
// CRITICAL invariant carried over (:188,:237,:600): construct a NEW DtNavMeshQuery
// after ANY tile add/remove.
//
// Tile budget (env, read once at construction; laptop follow-up: promote to CLI flags):
//   RYNTHNAV_MAX_TILES       — DtNavMeshParams.maxTiles ceiling (default 1024, min 2).
//   RYNTHNAV_TILE_HIGH_WATER — LRU eviction high-water mark (default maxTiles-64,
//                              clamped to [1, maxTiles-1]). After each corridor load,
//                              least-recently-used tiles OUTSIDE the current request's
//                              corridor bounding box are evicted until the count is at
//                              or below this mark (mirrors upstream RynthNavPlugin's
//                              evict-far/keep-radius intent). Current-corridor tiles are
//                              never evicted; if they alone exceed the mark, the count
//                              stays above it (graceful, same straight-leg fallback as a
//                              missing tile once the hard ceiling bites).
//
// Composition: PortalRoute.Plan gives coarse RouteSteps in /loc degrees; between
// consecutive walk points we run the Detour corridor query for fine waypoints and
// convert every waypoint world -> (lb, x, y, z) legs. Segments with no tile
// coverage become straight-line legs split at landblock seams (<= ~40 m strides).

using System.Globalization;
using DotRecast.Core.Numerics;
using DotRecast.Detour;
using DotRecast.Detour.Io;
using RynthNav.Routing;

namespace RynthNav.Sidecar;

/// <summary>A world-frame point: wx = world EW metres, wy = world NS metres, Z = AC up.</summary>
public readonly record struct WorldPt(double Wx, double Wy, double Z);

/// <summary>A world-frame avoidance circle (contract v2, /route "avoid"): (Wx,Wy) centre in
/// world metres — same lbX*192+local frame DetourRouter uses internally — R radius in metres.
/// A poly touched by any of these is rejected from the Detour FindPath (see AvoidCircleFilter),
/// so a replan steers AROUND a physically blocked stitch instead of re-emitting it.</summary>
public readonly record struct AvoidCircle(double Wx, double Wy, double R);

/// <summary>An <see cref="IDtQueryFilter"/> that layers over an inner filter and ALSO rejects any
/// poly with a vertex OR its centroid inside one of the world-frame avoid circles. Recast tile
/// verts are Y-up packed as (wx, z_up, wy), so a vertex's world XY is (verts[3i], verts[3i+2]).
/// Used for FindPath only — start/goal snapping (FindNearestPoly) keeps the default filter so a
/// pose sitting next to the blockage still resolves onto the mesh.</summary>
internal sealed class AvoidCircleFilter : IDtQueryFilter
{
    private readonly IDtQueryFilter _inner;
    private readonly (double x, double y, double r2)[] _circles;

    public AvoidCircleFilter(IDtQueryFilter inner, IReadOnlyList<AvoidCircle> circles)
    {
        _inner = inner;
        _circles = new (double, double, double)[circles.Count];
        for (int i = 0; i < circles.Count; i++)
            _circles[i] = (circles[i].Wx, circles[i].Wy, circles[i].R * circles[i].R);
    }

    public bool PassFilter(long refs, DtMeshTile tile, DtPoly poly)
    {
        if (!_inner.PassFilter(refs, tile, poly)) return false;
        var verts = tile.data.verts;
        int n = poly.vertCount;
        double cx = 0, cy = 0;
        for (int i = 0; i < n; i++)
        {
            int vi = poly.verts[i] * 3;
            double vx = verts[vi], vy = verts[vi + 2];
            cx += vx; cy += vy;
            foreach (var (ax, ay, r2) in _circles)
            {
                double dx = vx - ax, dy = vy - ay;
                if (dx * dx + dy * dy <= r2) return false;   // a vertex is inside an avoid circle
            }
        }
        if (n > 0)
        {
            cx /= n; cy /= n;
            foreach (var (ax, ay, r2) in _circles)
            {
                double dx = cx - ax, dy = cy - ay;
                if (dx * dx + dy * dy <= r2) return false;    // the centroid is inside an avoid circle
            }
        }
        return true;
    }

    public float GetCost(RcVec3f pa, RcVec3f pb, long prevRef, DtMeshTile prevTile, DtPoly prevPoly,
        long curRef, DtMeshTile curTile, DtPoly curPoly, long nextRef, DtMeshTile nextTile, DtPoly nextPoly)
        => _inner.GetCost(pa, pb, prevRef, prevTile, prevPoly, curRef, curTile, curPoly, nextRef, nextTile, nextPoly);
}

public sealed class Leg
{
    public uint Lb;          // full 32-bit objCellId with correct outdoor cell in low 16 bits
    public float X, Y, Z;    // landblock-local AC Z-up metres (0..192)
    public bool Portal;
    public bool Stitch;      // contract v2: true = straight-line stitch (EmitStraightSeamSplit),
                             // NOT a validated Detour leg — may cut through carved obstacles.
    public string Label = "";
}

public sealed class RouteOutcome
{
    public bool Ok;
    public string Error = "";
    public List<Leg> Legs = new();
    public double EstUnits;
    public int PortalsUsed;
    public string Coverage = "detour"; // "detour" | "straight" | "mixed"
    // contract v2:
    public int StitchedLegs;           // count of legs with Stitch==true
    public bool Partial;               // at least one walk segment was not fully covered by the
                                       // Detour mesh and was closed with a straight stitch to
                                       // reach its goal (terminal short-fall OR full out-of-
                                       // coverage fallback). A clean end-to-end on-mesh route
                                       // has Partial==false.
    public int AvoidApplied;           // contract v2: count of "avoid" circles actually fed to the
                                       // FindPath filter for this route (0 when none supplied).
}

public sealed class DetourRouter
{
    public const int VertsPerPoly = 6;          // RynthNavPlugin.cs:31 / NavBake.cs:23
    private const int DefaultMaxTiles = 1024;   // RynthNavPlugin.cs:34 had 256; env RYNTHNAV_MAX_TILES overrides
    private const int MaxCorridorTiles = 220;   // RynthNavPlugin.cs:35
    private const double MaxStrideM = 40.0;     // executor progress-watchdog contract
    // contract v2: string-pull endpoint farther than this from the segment goal => close the
    // remainder with a FLAGGED straight stitch (was 15.0 and silently accepted the short
    // endpoint below that; the defect-1 wall-crossing gap was 12.5 m). ~4 m sits just above the
    // client's 3 m arrival radius, so a sub-4 m gap is within arrival tolerance and left as-is.
    private const double TerminalStitchGapM = 4.0;

    private readonly string _navDir;
    private readonly int _maxTiles;             // RYNTHNAV_MAX_TILES (see header)
    private readonly int _highWater;            // RYNTHNAV_TILE_HIGH_WATER (see header)
    private readonly List<PortalLink> _portals = new();
    private readonly object _gate = new();      // Kestrel is concurrent; navmesh state is not

    // Navmesh state — mutate only under _gate.
    private sealed class TileEntry { public long Ref; public long LastUsed; }
    private DtNavMesh? _navMesh;
    private DtNavMeshQuery? _query;
    private readonly Dictionary<uint, TileEntry> _loadedTiles = new();
    private long _useSeq;                                    // monotonic LRU clock
    private int _corMinX, _corMaxX = -1, _corMinY, _corMaxY = -1; // current request's corridor bbox (lb coords, incl. +1 margin)

    public int PortalCount => _portals.Count;
    public int LoadedTileCount { get { lock (_gate) return _loadedTiles.Count; } }
    public int MaxTilesConfigured => _maxTiles;
    public int TileHighWater => _highWater;

    /// <summary>Loaded tile lbs ordered least-recently-used first (diagnostic/test hook).</summary>
    public List<uint> LoadedTilesLruFirst()
    {
        lock (_gate) return _loadedTiles.OrderBy(kv => kv.Value.LastUsed).Select(kv => kv.Key).ToList();
    }

    public DetourRouter(string navDir, string portalsTsv)
    {
        _navDir = navDir;
        _maxTiles = Math.Max(2, ReadEnvInt("RYNTHNAV_MAX_TILES", DefaultMaxTiles));
        _highWater = Math.Clamp(ReadEnvInt("RYNTHNAV_TILE_HIGH_WATER", _maxTiles - 64), 1, _maxTiles - 1);
        LoadPortals(portalsTsv);
    }

    /// <summary>Positive-integer env override; unset/garbage/non-positive => fallback.</summary>
    private static int ReadEnvInt(string name, int fallback)
        => int.TryParse(Environment.GetEnvironmentVariable(name), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) && v > 0
            ? v : fallback;

    public int AvailableTileCount()
    {
        try { return Directory.Exists(_navDir) ? Directory.GetFiles(_navDir, "nav_*.tile").Length : 0; }
        catch { return 0; }
    }

    // ── portals.tsv (parse per RynthNavPlugin.cs:562-568) ───────────────────────
    private void LoadPortals(string path)
    {
        if (!File.Exists(path)) { Console.WriteLine($"[router] portals.tsv not found at {path} — portal routing off"); return; }
        foreach (var line in File.ReadAllLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var f = line.Split('\t');
            if (f.Length < 4) continue;
            if (!double.TryParse(f[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double sns)) continue;
            if (!double.TryParse(f[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double sew)) continue;
            if (!double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out double dns)) continue;
            if (!double.TryParse(f[3], NumberStyles.Float, CultureInfo.InvariantCulture, out double dew)) continue;
            _portals.Add(new PortalLink(sns, sew, dns, dew, f.Length > 4 ? f[4] : ""));
        }
        Console.WriteLine($"[router] loaded {_portals.Count} portals from {path}");
    }

    // ── coordinate bridge (RynthNavPlugin.cs:128-130,:295-296,:585-586,:707) ────
    public static double DegToWorld(double deg) => (deg * 10.0 + 1019.5) * 24.0;
    public static double WorldToDeg(double w) => (w / 24.0 - 1019.5) / 10.0;

    public static WorldPt LbLocalToWorld(uint objCellId, double x, double y, double z)
    {
        int lbX = (int)((objCellId >> 24) & 0xFF), lbY = (int)((objCellId >> 16) & 0xFF);
        return new WorldPt(lbX * 192.0 + x, lbY * 192.0 + y, z);
    }

    /// <summary>World metres -> leg frame: full objCellId (correct outdoor cell) + lb-local coords.</summary>
    public static Leg WorldToLeg(WorldPt p)
    {
        int lbX = Math.Clamp((int)Math.Floor(p.Wx / 192.0), 0, 255);
        int lbY = Math.Clamp((int)Math.Floor(p.Wy / 192.0), 0, 255);
        double lx = p.Wx - lbX * 192.0, ly = p.Wy - lbY * 192.0;
        int cellX = Math.Clamp((int)(lx / 24.0), 0, 7);
        int cellY = Math.Clamp((int)(ly / 24.0), 0, 7);
        uint cell = (uint)(1 + cellX * 8 + cellY);
        return new Leg
        {
            Lb = ((uint)lbX << 24) | ((uint)lbY << 16) | cell,
            X = (float)lx, Y = (float)ly, Z = (float)p.Z,
        };
    }

    // ── tile streaming (RynthNavPlugin.cs:141-167,:222-239) ─────────────────────
    private void EnsureNavMesh()
    {
        if (_navMesh != null) return;
        var nav = new DtNavMesh();
        var p = new DtNavMeshParams { orig = new RcVec3f(0, 0, 0), tileWidth = 192f, tileHeight = 192f, maxTiles = _maxTiles, maxPolys = 1 << 16 };
        nav.Init(ref p, VertsPerPoly);
        _navMesh = nav;
        _query = new DtNavMeshQuery(nav);
    }

    private bool EnsureTile(uint lb)
    {
        if (_loadedTiles.TryGetValue(lb, out var have)) { have.LastUsed = ++_useSeq; return true; }
        string path = Path.Combine(_navDir, $"nav_{lb:X4}.tile");
        if (!File.Exists(path)) return false;
        // Hard ceiling: make room by evicting the LRU tile outside the current corridor.
        // If every loaded tile is corridor-protected, degrade exactly like a missing
        // tile (caller falls back to straight legs) instead of thrashing the corridor.
        if (_loadedTiles.Count >= _maxTiles - 1 && !TryEvictLruOutsideCorridor()) return false;
        try
        {
            DtMeshData md;
            using (var fr = File.OpenRead(path)) using (var br = new BinaryReader(fr)) md = new DtMeshDataReader().Read(br, VertsPerPoly);
            EnsureNavMesh();
            if (!_navMesh!.AddTile(md, 0, 0, out long tileRef).Succeeded()) return false;
            _loadedTiles[lb] = new TileEntry { Ref = tileRef, LastUsed = ++_useSeq };
            return true;
        }
        catch { return false; }
    }

    /// <summary>lb inside the current request's corridor bbox (eviction-protected)?</summary>
    private bool InCorridor(uint lb)
    {
        int x = (int)((lb >> 8) & 0xFF), y = (int)(lb & 0xFF);
        return x >= _corMinX && x <= _corMaxX && y >= _corMinY && y <= _corMaxY;
    }

    /// <summary>Evict the least-recently-used tile outside the current corridor bbox.
    /// Callers run only inside LoadCorridor, whose trailing query rebuild covers the removal.</summary>
    private bool TryEvictLruOutsideCorridor()
    {
        uint victim = 0;
        TileEntry? oldest = null;
        foreach (var kv in _loadedTiles)
        {
            if (InCorridor(kv.Key)) continue;
            if (oldest == null || kv.Value.LastUsed < oldest.LastUsed) { victim = kv.Key; oldest = kv.Value; }
        }
        if (oldest == null) return false;
        _navMesh!.RemoveTile(oldest.Ref);
        _loadedTiles.Remove(victim);
        return true;
    }

    /// <summary>Load every tile in the bounding box between two world points (+1 lb margin),
    /// LRU-evict past the high-water mark, then rebuild the query.</summary>
    private void LoadCorridor(WorldPt a, WorldPt b)
    {
        EnsureNavMesh();
        // Clamp to the [0,255] landblock grid at the double level BEFORE the int
        // cast: an out-of-map goal (e.g. a 1e12-metre deg coord) otherwise
        // overflows the cast and blows minX..maxX out to billions, spinning this
        // loop for tens of minutes while /health stays green (batch-2 finding).
        int aX = (int)Math.Clamp(a.Wx / 192.0, 0, 255), aY = (int)Math.Clamp(a.Wy / 192.0, 0, 255);
        int bX = (int)Math.Clamp(b.Wx / 192.0, 0, 255), bY = (int)Math.Clamp(b.Wy / 192.0, 0, 255);
        int minX = Math.Min(aX, bX) - 1, maxX = Math.Max(aX, bX) + 1;
        int minY = Math.Min(aY, bY) - 1, maxY = Math.Max(aY, bY) + 1;
        _corMinX = minX; _corMaxX = maxX; _corMinY = minY; _corMaxY = maxY; // eviction protection
        int count = 0;
        for (int x = minX; x <= maxX && count < MaxCorridorTiles; x++)
            for (int y = minY; y <= maxY && count < MaxCorridorTiles; y++)
            {
                if (x < 0 || x > 255 || y < 0 || y > 255) continue;
                if (EnsureTile((uint)((x << 8) | y))) count++;
            }
        // High-water LRU sweep: shed tiles from previous corridors, never the current one.
        while (_loadedTiles.Count > _highWater && TryEvictLruOutsideCorridor()) { }
        // CRITICAL: new query after any tile add/remove (RynthNavPlugin.cs:188,:237,:600).
        _query = new DtNavMeshQuery(_navMesh!);
    }

    // ── route composition ────────────────────────────────────────────────────────
    // `avoid` (contract v2, optional): world-frame circles the Detour FindPath must route around.
    // Null/empty => byte-identical to the pre-avoid behavior (default filter only, AvoidApplied 0).
    public RouteOutcome Route(WorldPt start, WorldPt goal, IReadOnlyList<AvoidCircle>? avoid = null)
    {
        lock (_gate)
        {
            var res = new RouteOutcome();
            res.AvoidApplied = avoid?.Count ?? 0;
            double sNs = WorldToDeg(start.Wy), sEw = WorldToDeg(start.Wx);
            double gNs = WorldToDeg(goal.Wy), gEw = WorldToDeg(goal.Wx);

            var steps = PortalRoute.Plan(_portals, null, sNs, sEw, gNs, gEw, out double est, out int used);
            if (steps.Count == 0) { res.Error = "portal planner returned no steps"; return res; }
            res.EstUnits = est;
            res.PortalsUsed = used;

            bool anyDetour = false, anyStraight = false, anyPartial = false;
            var cur = start;
            for (int i = 0; i < steps.Count; i++)
            {
                var stp = steps[i];
                if (stp.UseRecall) { res.Error = "recall steps unsupported (no recalls configured)"; return res; }
                // Final step targets GOAL exactly; use the caller's coords, not the rounded degrees.
                var target = (i == steps.Count - 1)
                    ? goal
                    : new WorldPt(DegToWorld(stp.Ew), DegToWorld(stp.Ns), cur.Z);

                cur = AppendSegment(cur, target, res.Legs, stp.UsePortal, stp.Label, ref anyDetour, ref anyStraight, ref anyPartial, avoid);

                if (stp.UsePortal)
                {
                    var p = MatchPortal(stp);
                    if (p == null) { res.Error = $"portal step '{stp.Label}' has no matching portals.tsv row"; return res; }
                    // Teleport: next walk segment starts at the portal destination.
                    cur = new WorldPt(DegToWorld(p.Value.DstEw), DegToWorld(p.Value.DstNs), cur.Z);
                }
            }
            if (res.Legs.Count == 0) { res.Error = "plan produced no legs (start == goal?)"; return res; }
            // Any stitch present => at least "mixed"; the terminal-gap fix flips a would-be
            // "detour" plan to "mixed" the moment it gains a terminal stitch (anyStraight set).
            res.Coverage = anyDetour && anyStraight ? "mixed" : anyDetour ? "detour" : "straight";
            res.StitchedLegs = res.Legs.Count(l => l.Stitch);
            res.Partial = anyPartial;
            res.Ok = true;
            return res;
        }
    }

    private PortalLink? MatchPortal(RouteStep stp)
    {
        foreach (var p in _portals)
            if (Math.Abs(p.SrcNs - stp.Ns) < 1e-6 && Math.Abs(p.SrcEw - stp.Ew) < 1e-6 &&
                (string.IsNullOrEmpty(stp.Label) || p.Name == stp.Label))
                return p;
        return null;
    }

    /// <summary>Fine-path one walk segment. Returns the actual segment end point.</summary>
    private WorldPt AppendSegment(WorldPt from, WorldPt to, List<Leg> legs, bool portalArrival, string label,
        ref bool anyDetour, ref bool anyStraight, ref bool anyPartial, IReadOnlyList<AvoidCircle>? avoid)
    {
        LoadCorridor(from, to);
        var filter = new DtQueryDefaultFilter();
        // FindNearestPoly (start/goal snap) always uses the default filter — a pose next to the
        // blockage must still resolve onto the mesh. FindPath uses the avoid-layered filter so the
        // corridor routes AROUND the circles; when no avoiding path exists, the straight-stitch
        // fallback below still fires (route stays complete, tail flagged Stitch).
        IDtQueryFilter pathFilter = (avoid != null && avoid.Count > 0) ? new AvoidCircleFilter(filter, avoid) : filter;
        long sRef = 0, gRef = 0;
        RcVec3f sPt = default, gPt = default;
        if (_query != null)
        {
            // Recast frame is Y-up: (wx, z_up, wy). Half-extents per RynthNavPlugin.cs:605,:612,
            // with the START vertical widened 64 -> 256 (matching the target): the caller's z is
            // ADVISORY (a live pose is exact, but a portal-arrival coord, a stale/coarse pose, or
            // a director-supplied approximate z can sit tens of metres off terrain — e.g. AC
            // outdoor terrain routinely swings 100+ m over a few landblocks). A z that misses the
            // 64 m window made the whole segment fall to a blind straight-line even with good tiles
            // loaded — the exact soak-14 failure mode this bake is meant to kill. Outdoors there is
            // a single terrain surface, so a generous vertical snap is unambiguous; indoor multi-
            // level routing is the cell-graph router's job, not this one's.
            _query.FindNearestPoly(new RcVec3f((float)from.Wx, (float)from.Z, (float)from.Wy), new RcVec3f(8, 256, 8), filter, out sRef, out sPt, out _);
            _query.FindNearestPoly(new RcVec3f((float)to.Wx, (float)to.Z, (float)to.Wy), new RcVec3f(12, 256, 12), filter, out gRef, out gPt, out _);
        }

        int before = legs.Count;
        WorldPt end;
        if (sRef != 0 && gRef != 0)
        {
            Span<long> path = new long[512];
            _query!.FindPath(sRef, gRef, sPt, gPt, pathFilter, path, out int pc, 512);
            Span<DtStraightPath> sp = new DtStraightPath[512];
            int spc = 0;
            if (pc > 0) _query.FindStraightPath(sPt, gPt, path[..pc], pc, sp, out spc, 512, 0);
            if (spc >= 2)
            {
                anyDetour = true;
                var prev = new WorldPt(sPt.X, sPt.Z, sPt.Y);
                for (int i = 1; i < spc; i++)
                {
                    var wp = new WorldPt(sp[i].pos.X, sp[i].pos.Z, sp[i].pos.Y);
                    EmitStride(legs, prev, wp);
                    prev = wp;
                }
                // Partial corridor (target tile missing / FindPath partial / carved-obstacle
                // island edge): the string-pulled endpoint sits short of the segment goal.
                // Contract v2: close the remainder with a FLAGGED straight stitch whenever the
                // gap exceeds the arrival radius, instead of silently returning the short
                // endpoint as ok Detour coverage (defect 1). A sub-4 m gap is within the
                // client's arrival tolerance and is accepted as-is.
                if (Dist2D(prev, to) > TerminalStitchGapM)
                {
                    EmitStraightSeamSplit(legs, prev, to);
                    anyStraight = true;
                    anyPartial = true;   // a Detour segment ended short and was closed by a stitch
                    prev = to;
                }
                end = prev;
            }
            else
            {
                anyStraight = true;
                anyPartial = true;       // no usable Detour path: whole segment is an out-of-coverage stitch
                EmitStraightSeamSplit(legs, from, to);
                end = to;
            }
        }
        else
        {
            anyStraight = true;
            anyPartial = true;           // start/goal off-mesh: whole segment is an out-of-coverage stitch
            EmitStraightSeamSplit(legs, from, to);
            end = to;
        }

        // Arrival leg carries the step label; portal steps flag it (walk-in trigger).
        if (legs.Count == before && portalArrival)
            legs.Add(WorldToLeg(end)); // zero-length portal segment: still emit the arrival point
        if (legs.Count > before)
        {
            var last = legs[^1];
            if (portalArrival) last.Portal = true;
            if (!string.IsNullOrEmpty(label)) last.Label = label;
        }
        return end;
    }

    private static double Dist2D(WorldPt a, WorldPt b)
    {
        double dx = a.Wx - b.Wx, dy = a.Wy - b.Wy;
        return Math.Sqrt(dx * dx + dy * dy);
    }

    private static WorldPt Lerp(WorldPt a, WorldPt b, double t)
        => new(a.Wx + (b.Wx - a.Wx) * t, a.Wy + (b.Wy - a.Wy) * t, a.Z + (b.Z - a.Z) * t);

    /// <summary>Emit legs from a to b (exclusive of a), subdividing so consecutive legs are &lt;= ~40 m apart.</summary>
    private static void EmitStride(List<Leg> legs, WorldPt a, WorldPt b)
    {
        double d = Dist2D(a, b);
        if (d < 0.01) return;
        int n = Math.Max(1, (int)Math.Ceiling(d / MaxStrideM));
        for (int i = 1; i <= n; i++)
            legs.Add(WorldToLeg(Lerp(a, b, (double)i / n)));
    }

    /// <summary>Straight-fallback legs: split at landblock seams, then enforce the ~40 m stride.
    /// Every leg produced here is flagged <see cref="Leg.Stitch"/> (contract v2) — a straight
    /// stitch, not a validated Detour leg.</summary>
    private static void EmitStraightSeamSplit(List<Leg> legs, WorldPt a, WorldPt b)
    {
        double d = Dist2D(a, b);
        if (d < 0.01) return;
        int start = legs.Count;
        var ts = new List<double>();
        CollectSeamTs(a.Wx, b.Wx, ts);
        CollectSeamTs(a.Wy, b.Wy, ts);
        ts.Add(1.0);
        ts.Sort();
        double prevT = 0.0;
        var cur = a;
        foreach (double t in ts)
        {
            if (t <= prevT + 1e-9) continue;
            var pt = Lerp(a, b, t);
            EmitStride(legs, cur, pt);
            cur = pt;
            prevT = t;
        }
        for (int i = start; i < legs.Count; i++) legs[i].Stitch = true;
    }

    /// <summary>t values in (0,1) where the coordinate crosses a 192 m landblock seam.</summary>
    private static void CollectSeamTs(double a, double b, List<double> ts)
    {
        if (Math.Abs(b - a) < 1e-9) return;
        double lo = Math.Min(a, b), hi = Math.Max(a, b);
        for (int k = (int)Math.Ceiling(lo / 192.0); k * 192.0 < hi; k++)
        {
            double seam = k * 192.0;
            if (seam <= lo || seam >= hi) continue;
            double t = (seam - a) / (b - a);
            if (t > 1e-9 && t < 1.0 - 1e-9) ts.Add(t);
        }
    }
}
