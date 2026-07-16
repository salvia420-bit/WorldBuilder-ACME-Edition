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

public sealed class Leg
{
    public uint Lb;          // full 32-bit objCellId with correct outdoor cell in low 16 bits
    public float X, Y, Z;    // landblock-local AC Z-up metres (0..192)
    public bool Portal;
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
}

public sealed class DetourRouter
{
    public const int VertsPerPoly = 6;          // RynthNavPlugin.cs:31 / NavBake.cs:23
    private const int MaxTiles = 256;           // RynthNavPlugin.cs:34 — raise if served region exceeds 256 tiles
    private const int MaxCorridorTiles = 220;   // RynthNavPlugin.cs:35
    private const double MaxStrideM = 40.0;     // executor progress-watchdog contract
    private const double TerminalGapM = 15.0;   // string-pull endpoint farther than this from target => straight tail

    private readonly string _navDir;
    private readonly List<PortalLink> _portals = new();
    private readonly object _gate = new();      // Kestrel is concurrent; navmesh state is not

    // Navmesh state — mutate only under _gate.
    private DtNavMesh? _navMesh;
    private DtNavMeshQuery? _query;
    private readonly HashSet<uint> _loadedTiles = new();

    public int PortalCount => _portals.Count;
    public int LoadedTileCount { get { lock (_gate) return _loadedTiles.Count; } }

    public DetourRouter(string navDir, string portalsTsv)
    {
        _navDir = navDir;
        LoadPortals(portalsTsv);
    }

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
        var p = new DtNavMeshParams { orig = new RcVec3f(0, 0, 0), tileWidth = 192f, tileHeight = 192f, maxTiles = MaxTiles, maxPolys = 1 << 16 };
        nav.Init(ref p, VertsPerPoly);
        _navMesh = nav;
        _query = new DtNavMeshQuery(nav);
    }

    private bool EnsureTile(uint lb)
    {
        if (_loadedTiles.Contains(lb)) return true;
        if (_loadedTiles.Count >= MaxTiles - 1) return false;
        string path = Path.Combine(_navDir, $"nav_{lb:X4}.tile");
        if (!File.Exists(path)) return false;
        try
        {
            DtMeshData md;
            using (var fr = File.OpenRead(path)) using (var br = new BinaryReader(fr)) md = new DtMeshDataReader().Read(br, VertsPerPoly);
            EnsureNavMesh();
            _navMesh!.AddTile(md, 0, 0, out _);
            _loadedTiles.Add(lb);
            return true;
        }
        catch { return false; }
    }

    /// <summary>Load every tile in the bounding box between two world points (+1 lb margin), then rebuild the query.</summary>
    private void LoadCorridor(WorldPt a, WorldPt b)
    {
        EnsureNavMesh();
        int aX = (int)(a.Wx / 192.0), aY = (int)(a.Wy / 192.0);
        int bX = (int)(b.Wx / 192.0), bY = (int)(b.Wy / 192.0);
        int minX = Math.Min(aX, bX) - 1, maxX = Math.Max(aX, bX) + 1;
        int minY = Math.Min(aY, bY) - 1, maxY = Math.Max(aY, bY) + 1;
        int count = 0;
        for (int x = minX; x <= maxX && count < MaxCorridorTiles; x++)
            for (int y = minY; y <= maxY && count < MaxCorridorTiles; y++)
            {
                if (x < 0 || x > 255 || y < 0 || y > 255) continue;
                if (EnsureTile((uint)((x << 8) | y))) count++;
            }
        // CRITICAL: new query after any tile add/remove (RynthNavPlugin.cs:188,:237,:600).
        _query = new DtNavMeshQuery(_navMesh!);
    }

    // ── route composition ────────────────────────────────────────────────────────
    public RouteOutcome Route(WorldPt start, WorldPt goal)
    {
        lock (_gate)
        {
            var res = new RouteOutcome();
            double sNs = WorldToDeg(start.Wy), sEw = WorldToDeg(start.Wx);
            double gNs = WorldToDeg(goal.Wy), gEw = WorldToDeg(goal.Wx);

            var steps = PortalRoute.Plan(_portals, null, sNs, sEw, gNs, gEw, out double est, out int used);
            if (steps.Count == 0) { res.Error = "portal planner returned no steps"; return res; }
            res.EstUnits = est;
            res.PortalsUsed = used;

            bool anyDetour = false, anyStraight = false;
            var cur = start;
            for (int i = 0; i < steps.Count; i++)
            {
                var stp = steps[i];
                if (stp.UseRecall) { res.Error = "recall steps unsupported (no recalls configured)"; return res; }
                // Final step targets GOAL exactly; use the caller's coords, not the rounded degrees.
                var target = (i == steps.Count - 1)
                    ? goal
                    : new WorldPt(DegToWorld(stp.Ew), DegToWorld(stp.Ns), cur.Z);

                cur = AppendSegment(cur, target, res.Legs, stp.UsePortal, stp.Label, ref anyDetour, ref anyStraight);

                if (stp.UsePortal)
                {
                    var p = MatchPortal(stp);
                    if (p == null) { res.Error = $"portal step '{stp.Label}' has no matching portals.tsv row"; return res; }
                    // Teleport: next walk segment starts at the portal destination.
                    cur = new WorldPt(DegToWorld(p.Value.DstEw), DegToWorld(p.Value.DstNs), cur.Z);
                }
            }
            if (res.Legs.Count == 0) { res.Error = "plan produced no legs (start == goal?)"; return res; }
            res.Coverage = anyDetour && anyStraight ? "mixed" : anyDetour ? "detour" : "straight";
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
        ref bool anyDetour, ref bool anyStraight)
    {
        LoadCorridor(from, to);
        var filter = new DtQueryDefaultFilter();
        long sRef = 0, gRef = 0;
        RcVec3f sPt = default, gPt = default;
        if (_query != null)
        {
            // Recast frame is Y-up: (wx, z_up, wy). Half-extents per RynthNavPlugin.cs:605,:612.
            _query.FindNearestPoly(new RcVec3f((float)from.Wx, (float)from.Z, (float)from.Wy), new RcVec3f(8, 64, 8), filter, out sRef, out sPt, out _);
            _query.FindNearestPoly(new RcVec3f((float)to.Wx, (float)to.Z, (float)to.Wy), new RcVec3f(12, 256, 12), filter, out gRef, out gPt, out _);
        }

        int before = legs.Count;
        WorldPt end;
        if (sRef != 0 && gRef != 0)
        {
            Span<long> path = new long[512];
            _query!.FindPath(sRef, gRef, sPt, gPt, filter, path, out int pc, 512);
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
                // Partial corridor (target tile missing / FindPath partial): straight tail.
                if (Dist2D(prev, to) > TerminalGapM)
                {
                    EmitStraightSeamSplit(legs, prev, to);
                    anyStraight = true;
                    prev = to;
                }
                end = prev;
            }
            else
            {
                anyStraight = true;
                EmitStraightSeamSplit(legs, from, to);
                end = to;
            }
        }
        else
        {
            anyStraight = true;
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

    /// <summary>Straight-fallback legs: split at landblock seams, then enforce the ~40 m stride.</summary>
    private static void EmitStraightSeamSplit(List<Leg> legs, WorldPt a, WorldPt b)
    {
        double d = Dist2D(a, b);
        if (d < 0.01) return;
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
