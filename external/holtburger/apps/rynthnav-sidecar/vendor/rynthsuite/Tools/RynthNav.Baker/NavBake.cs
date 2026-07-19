// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Tools/RynthNav.Baker/NavBake.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
// ADAPTED: RynthCore2.Raycast.GeometryLoader resolves to the local terrain-only shim (GeometryLoaderShim.cs), not AcClientReborn; bake params + tile header rewrite kept identical.
using System.Text;
using DotRecast.Core;
using DotRecast.Core.Numerics;
using DotRecast.Recast;
using DotRecast.Recast.Geom;
using DotRecast.Recast.Toolset;
using DotRecast.Recast.Toolset.Builder;
using DotRecast.Detour;
using DotRecast.Detour.Io;
using RynthCore.TerrainData;
using RynthCore.Plugin.RynthAi.Raycasting; // LandblockData

namespace RynthNav.Baker;

// Bakes AC landblocks into Detour tiles.
//  - Solo (--lb):    one self-contained tile per landblock.
//  - Tiled (--tiled): a whole region baked as ONE connected tiled navmesh, then
//    each tile serialized with its ABSOLUTE landblock coords in the header so the
//    plugin can stream a window of them into a multi-tile navmesh that connects.
internal static class NavBake
{
    private const float CL = LandblockData.CellLength;     // 24
    public const int VertsPerPoly = 6;
    // Tiled tiles align 1:1 to landblocks: tileSize(cells) * cellSize = 192.
    private const float TiledCellSize = 0.5f;
    private const int TiledTileSize = 384;                 // 384 * 0.5 = 192

    /// <summary>W1.3 water rule: count of fully-flooded terrain cells skipped this bake
    /// (diagnostic; reset per bake by the CLI).</summary>
    public static long WaterCellsSkipped;

    /// <summary>W1.3 water rule on/off (CLI --no-water disables it, for A/B verification).
    /// Default ON — fully-flooded cells are carved out to match retail physics.</summary>
    public static bool WaterRuleEnabled = true;

    private static RcVec3f AcToRec(double ewX, double nsY, double upZ) => new((float)ewX, (float)upZ, (float)nsY);
    private static (double ew, double ns, double up) RecToAc(RcVec3f v) => (v.X, v.Z, v.Y);

    // ── Geometry: append one landblock's terrain + obstacle triangles (Recast frame) ──
    public static bool AppendLandblock(TerrainSampler sampler, RynthCore2.Raycast.GeometryLoader? geo, uint lb, List<float> verts, List<int> faces)
    {
        LandblockData? land = sampler.LoadLandblock(lb);
        if (land == null) return false;

        void Tri(int a, int b, int c) { faces.Add(a); faces.Add(c); faces.Add(b); } // reversed winding (+Y up)
        int AddVtx(double ax, double ay, double az) { RcVec3f r = AcToRec(ax, ay, az); verts.Add(r.X); verts.Add(r.Y); verts.Add(r.Z); return verts.Count / 3 - 1; }

        int[,] vidx = new int[9, 9];
        for (int iy = 0; iy < 9; iy++)
            for (int ix = 0; ix < 9; ix++)
                vidx[ix, iy] = AddVtx(land.WorldOriginX + ix * CL, land.WorldOriginY + iy * CL, land.GetVertexZ(ix, iy));
        for (int cy = 0; cy < 8; cy++)
            for (int cx = 0; cx < 8; cx++)
            {
                // LOCAL ADDITION (W1.3 water rule): a cell whose FOUR corner vertices are
                // all water terrain is EntirelyWater and unwalkable — emit NO terrain
                // triangle (a hole) so Recast produces no walkable poly there, matching
                // the retail client's physics blocker. This is exactly ACE
                // LandblockStruct.CalcCellWater: cellFullyFlooded iff every corner has
                // SurfChar[terrainType]==1, which is true only for terrain types 16..20
                // (WaterRunning, WaterStandingFresh, WaterShallow{,Still}Sea, WaterDeepSea;
                // FauxWaterRunning=22 is NOT water). Partially-water cells (a ford/beach
                // edge with >=1 land corner) stay walkable, same as retail. Without this,
                // the underwater terrain floor bakes as walkable and routes cut across
                // lakes/rivers/ocean.
                if (WaterRuleEnabled && IsCellEntirelyWater(land, cx, cy)) { WaterCellsSkipped++; continue; }
                int sw = vidx[cx, cy], se = vidx[cx + 1, cy], nw = vidx[cx, cy + 1], ne = vidx[cx + 1, cy + 1];
                if (TerrainSampler.SwToNeCut(lb, cx, cy)) { Tri(sw, se, ne); Tri(sw, ne, nw); }
                else { Tri(sw, se, nw); Tri(se, ne, nw); }
            }

        if (geo != null)
        {
            void Append(List<RynthCore2.Raycast.GeometryLoader.TexTri> tris)
            {
                foreach (var t in tris)
                {
                    if (!Fin(t.A.X, t.A.Y, t.A.Z) || !Fin(t.B.X, t.B.Y, t.B.Z) || !Fin(t.C.X, t.C.Y, t.C.Z)) continue;
                    Tri(AddVtx(t.A.X, t.A.Y, t.A.Z), AddVtx(t.B.X, t.B.Y, t.B.Z), AddVtx(t.C.X, t.C.Y, t.C.Z));
                }
            }
            try
            {
                Append(geo.GetTexturedStaticObjects(lb));
                Append(geo.GetTexturedScatter(lb, (wx, wy) => { float z = land.GetTerrainZWorld(wx, wy); return float.IsNaN(z) ? land.GetNearestVertexHeightWorld(wx, wy) : z; }));
            }
            catch { }
        }
        return true;
    }

    private static RcNavMeshBuildSettings Settings(float radius, bool tiled, float cellSize)
    {
        float slopeDeg = (float)(Math.Acos(TerrainSampler.FloorZ) * 180.0 / Math.PI);
        return new RcNavMeshBuildSettings
        {
            cellSize = cellSize, cellHeight = 0.20f,
            agentHeight = 2.0f, agentRadius = radius, agentMaxClimb = 1.0f, agentMaxSlope = slopeDeg,
            minRegionSize = 8, mergedRegionSize = 20, partitioning = (int)RcPartition.WATERSHED,
            filterLowHangingObstacles = true, filterLedgeSpans = true, filterWalkableLowHeightSpans = true,
            edgeMaxLen = 12f, edgeMaxError = 1.3f, vertsPerPoly = VertsPerPoly, detailSampleDist = 6f, detailSampleMaxError = 1f,
            tiled = tiled, tileSize = tiled ? TiledTileSize : 0, keepInterResults = true, buildAll = true,
        };
    }

    private static bool Fin(float a, float b, float c) => float.IsFinite(a) && float.IsFinite(b) && float.IsFinite(c);

    // ── W1.3 water rule (retail parity: ACE LandblockStruct.SurfChar / CalcCellWater) ──
    // SurfChar[t]==1 (water) exactly for terrain types 16..20; everything else (incl.
    // FauxWaterRunning=22, a purely visual water surface) is dry land for physics.
    private static bool IsWaterTerrainType(int t) => t >= 16 && t <= 20;

    /// <summary>True iff cell (cx,cy)'s four corner vertices are ALL water terrain
    /// (retail "EntirelyWater" / fully-flooded cell = unwalkable).</summary>
    private static bool IsCellEntirelyWater(LandblockData land, int cx, int cy)
        => IsWaterTerrainType(TerrainSampler.GetTerrainType(land, cx,     cy))
        && IsWaterTerrainType(TerrainSampler.GetTerrainType(land, cx + 1, cy))
        && IsWaterTerrainType(TerrainSampler.GetTerrainType(land, cx,     cy + 1))
        && IsWaterTerrainType(TerrainSampler.GetTerrainType(land, cx + 1, cy + 1));

    // ── Solo bake (one self-contained tile) ─────────────────────────────────────
    public static int BakeLandblock(TerrainSampler sampler, RynthCore2.Raycast.GeometryLoader? geo, uint lb, string outDir, bool writeObj, float agentRadius)
    {
        var verts = new List<float>(); var faces = new List<int>();
        if (!AppendLandblock(sampler, geo, lb, verts, faces)) return -1;

        var geom = new RcSampleInputGeomProvider(verts.ToArray(), faces.ToArray());
        geom.CalculateNormals();
        var settings = Settings(agentRadius, tiled: false, cellSize: 0.45f);
        NavMeshBuildResult res = new SoloNavMeshBuilder().Build(geom, settings);
        if (!res.Success || res.NavMesh == null || res.RecastBuilderResults.Count == 0) return -1;
        RcBuilderResult rb = res.RecastBuilderResults[0];
        if (rb.Mesh.npolys == 0) return 0;

        DtMeshData md = new SoloNavMeshBuilder().BuildMeshData(geom, settings.cellSize, settings.cellHeight,
            settings.agentHeight, settings.agentRadius, settings.agentMaxClimb, rb);
        WriteTile(Path.Combine(outDir, $"nav_{lb:X4}.tile"), md);
        if (writeObj) ExportDetailObj(Path.Combine(outDir, $"nav_{lb:X4}.obj"), rb.MeshDetail, lb);
        return rb.Mesh.npolys;
    }

    // ── Tiled bake: a region as ONE connected navmesh, serialized per-tile ───────
    public static void BakeRegionTiled(TerrainSampler sampler, RynthCore2.Raycast.GeometryLoader? geo,
        int x0, int x1, int y0, int y1, string outDir, float agentRadius, out int tiles, out int empty)
    {
        tiles = 0; empty = 0;
        var verts = new List<float>(); var faces = new List<int>();
        int gathered = 0;
        // Gather a 1-landblock BORDER beyond the output rectangle so this chunk's
        // edge tiles share geometry context with neighbouring chunks — that makes
        // separately-baked chunks reconnect at their seams when both are loaded.
        for (int x = x0 - 1; x <= x1 + 1; x++)
            for (int y = y0 - 1; y <= y1 + 1; y++)
            {
                if (x < 0 || x > 255 || y < 0 || y > 255) continue;
                if (AppendLandblock(sampler, geo, (uint)((x << 8) | y), verts, faces)) gathered++;
            }
        if (gathered == 0) return;

        var geom = new RcSampleInputGeomProvider(verts.ToArray(), faces.ToArray());
        geom.CalculateNormals();
        var settings = Settings(agentRadius, tiled: true, cellSize: TiledCellSize);
        NavMeshBuildResult res = new TileNavMeshBuilder().Build(geom, settings);
        if (!res.Success || res.NavMesh == null) return;

        DtNavMesh nav = res.NavMesh;
        RcVec3f bmin = geom.GetMeshBoundsMin();
        int baseLbX = (int)Math.Round(bmin.X / 192.0); // Recast x = world EW = lbX*192
        int baseLbZ = (int)Math.Round(bmin.Z / 192.0); // Recast z = world NS = lbY*192

        for (int i = 0; i < nav.GetMaxTiles(); i++)
        {
            DtMeshTile? tile = nav.GetTile(i);
            if (tile?.data?.header == null) continue;
            DtMeshData md = tile.data;
            if (md.header.polyCount == 0) { empty++; continue; }
            int absLbX = baseLbX + md.header.x;
            int absLbY = baseLbZ + md.header.y;
            if (absLbX < x0 || absLbX > x1 || absLbY < y0 || absLbY > y1) continue; // border tile = context only
            md.header.x = absLbX; // rewrite to ABSOLUTE landblock coords (world-positioned grid)
            md.header.y = absLbY;
            uint lb = (uint)((absLbX << 8) | absLbY);
            WriteTile(Path.Combine(outDir, $"nav_{lb:X4}.tile"), md);
            tiles++;
        }
    }

    // ── Validation: reload two adjacent tiles like the plugin would, path across ──
    public static string ValidateConnectivity(string outDir, uint lbA, uint lbB)
    {
        var nav = new DtNavMesh();
        var p = new DtNavMeshParams { orig = new RcVec3f(0, 0, 0), tileWidth = 192f, tileHeight = 192f, maxTiles = 64, maxPolys = 1 << 16 };
        nav.Init(ref p, VertsPerPoly);
        foreach (uint lb in new[] { lbA, lbB })
        {
            string path = Path.Combine(outDir, $"nav_{lb:X4}.tile");
            if (!File.Exists(path)) return $"missing tile 0x{lb:X4}";
            DtMeshData md;
            using (var fr = File.OpenRead(path)) using (var br = new BinaryReader(fr)) md = new DtMeshDataReader().Read(br, VertsPerPoly);
            nav.AddTile(md, 0, 0, out _);
        }
        var q = new DtNavMeshQuery(nav);
        var filter = new DtQueryDefaultFilter();
        var half = new RcVec3f(8, 400, 8);
        RcVec3f a = new((((lbA >> 8) & 0xFF) * 192f) + 96f, 0, ((lbA & 0xFF) * 192f) + 96f);
        RcVec3f b = new((((lbB >> 8) & 0xFF) * 192f) + 96f, 0, ((lbB & 0xFF) * 192f) + 96f);
        q.FindNearestPoly(a, half, filter, out long ra, out RcVec3f pa, out _);
        q.FindNearestPoly(b, half, filter, out long rb2, out RcVec3f pb, out _);
        if (ra == 0 || rb2 == 0) return $"poly not found (ra={ra} rb={rb2})";
        Span<long> path2 = new long[256];
        var st = q.FindPath(ra, rb2, pa, pb, filter, path2, out int pc, 256);
        bool crosses = false;
        for (int i = 0; i < pc; i++) { nav.GetTileAndPolyByRef(path2[i], out DtMeshTile t, out _); if (t?.data?.header != null && (uint)((t.data.header.x << 8) | t.data.header.y) == lbB) { crosses = true; break; } }
        return $"FindPath {st.Succeeded()} corridor={pc} reaches-0x{lbB:X4}={crosses}";
    }

    private static void WriteTile(string path, DtMeshData md)
    {
        using var fs = File.Create(path);
        using var bw = new BinaryWriter(fs);
        new DtMeshDataWriter().Write(bw, md, RcByteOrder.LITTLE_ENDIAN, false);
    }

    private static void ExportDetailObj(string path, RcPolyMeshDetail d, uint lb)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# RynthNav detail mesh, landblock 0x{lb:X4}, AC frame (x=EW, y=NS, z=up)");
        for (int i = 0; i < d.nverts; i++)
        {
            var (ew, ns, up) = RecToAc(new RcVec3f(d.verts[i * 3], d.verts[i * 3 + 1], d.verts[i * 3 + 2]));
            sb.AppendLine($"v {ew:F3} {ns:F3} {up:F3}");
        }
        for (int m = 0; m < d.nmeshes; m++)
        {
            int bverts = d.meshes[m * 4 + 0], btris = d.meshes[m * 4 + 2], ntris = d.meshes[m * 4 + 3];
            for (int t = 0; t < ntris; t++)
            {
                int a = bverts + d.tris[(btris + t) * 4 + 0] + 1;
                int b = bverts + d.tris[(btris + t) * 4 + 1] + 1;
                int c = bverts + d.tris[(btris + t) * 4 + 2] + 1;
                sb.AppendLine($"f {a} {b} {c}");
            }
        }
        File.WriteAllText(path, sb.ToString());
    }
}
