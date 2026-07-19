// GeomExtract — pre-extracts static-object collision triangles for the RynthNav
// obstacle-aware navmesh bake, so the sidecar's serve/bake path never needs a
// DAT-parsing dependency.
//
//   GeomExtract --ac <dats> --scenery <dist scenery dir> --out <geomdir>
//               --tiled <minX,maxX,minY,maxY hex> [--no-seal-buildings]
//
// For every landblock in the region (PLUS a 1-lb border, matching the border
// NavBake.BakeRegionTiled gathers for seam context):
//   1. cell.dat LandBlockInfo (id = (lb<<16)|0xFFFE): Objects[] (Stab: model DID
//      + Frame) and Buildings[] (BuildingInfo: model DID + Frame).
//   2. {sceneryDir}/0x{LB:X4}.scenery.jsonl (our dist bake's procedural scenery,
//      landblock-local AC coords + uniform scale). Missing file = no scenery.
// Every model resolves to LANDBLOCK-LOCAL AC Z-up triangles written as
// geom_{LB:X4}.jsonl, one line per placed object:
//   {"src":"static"|"building"|"scenery","did":"0x????????","tris":[[x,y,z],...]}
// where tris is a FLAT vertex list, 3 consecutive entries = 1 triangle.
// An extracted-but-empty landblock still gets a (zero-line) geom file so the
// bake can distinguish "no obstacles" from "never extracted".
//
// Geometry provenance (verified against retail + ACE, 2026-07-16):
//   - Collision geometry is the GfxObj's PHYSICS polygon set (GfxObjFlags.HasPhysics
//     -> PhysicsPolygons), NOT the render Polygons — retail collides with physics
//     polys only (CPhysicsPart::find_obj_collisions uses physics BSP/polys); GfxObjs
//     without physics data are non-collidable props.
//   - Triangle winding: fan (v0, v_i, v_i+1) in ORIGINAL vertex order. Retail
//     CPolygon::make_plane (acclient.c:359628) computes the plane normal as
//     sum (v_i - v0) x (v_i+1 - v0), i.e. the original winding IS the retail
//     front face; up-facing floors are CCW-from-+Z, which is exactly what
//     NavBake.AppendLandblock's Tri() reversal + AcToRec remap expects (same
//     convention as its terrain triangles). Double-sided polys
//     (CullMode.None) additionally emit the reversed face.
//   - Setup (0x02) part placement, per ACE PartArray/AFrame.Combine
//     (ACE.Server/Physics/Animation/AFrame.cs:51):
//       partQ = objQ * placementQ_i
//       partO = objO + objQ * (placementO_i * objScale)
//       vertex = partO + partQ * (v * (DefaultScale_i * objScale))
//     using PlacementFrames[0x65 Placement.Resting] — retail statics, buildings
//     and scenery are ALL placed via CPhysicsObj::InitObjectEnd ->
//     CPartArray::SetPlacementFrame(0x65) (acclient.c:317303; buildings reach it
//     through CBuildingObj::makeBuilding -> InitObjectEnd, acclient.c:719153),
//     and CPartArray::SetPlacementFrame's fallback (acclient.c:326818) is key 0
//     specifically, then identity — NEVER an arbitrary entry. 26 of 110 setups
//     in the Holtburg region have 0x65 differing from 0 by up to 0.56 m (part
//     displacement), so preferring 0 here shifted real obstacle footprints.
//     ParentIndex is an animation concern only.
//   - Setups whose parts yield ZERO physics triangles (typical scenery: trees,
//     rocks — e.g. 0x02000246 has one CylSphere r=0.85 h=3.334 and part GfxObjs
//     with no physics polys) fall back to the Setup's CylSpheres/Spheres
//     collision volumes, emitted as closed 8-sided prisms. That mirrors retail,
//     where such objects collide via the setup's cylsphere list, not part BSPs.
//
// Building seal (DEFAULT ON; pass --no-seal-buildings to reopen doorways):
//   Retail collides buildings as CBuildingObj PHYSICS (walls block, doorways are
//   genuinely open — they lead into the building's 0x0100xxxx interior EnvCells,
//   which the OUTDOOR bake does not contain). The walkable terrain/floor polys
//   under a building however DO get baked and connect to the outside through
//   those open doorways, so Detour routes THROUGH houses whose interiors don't
//   exist in the navmesh (batch-1 finding; e.g. Holtburg 0x01000827 has openings
//   at ~48° and ~197°). Sealing is a bake-time ROUTING decision, not a physics
//   change: each building entry is followed by a {"src":"seal",...} entry holding
//   a vertical wall skirt along the building's footprint boundary, tall enough
//   (zmin-1 .. zmin+4, i.e. >= agentHeight 2.0 above any plausible perimeter
//   terrain) that Recast rasterizes an unwalkable column there — outdoor routes
//   go AROUND the building. Re-extract without the flag to reopen doorways once
//   indoor navigation exists.
//   Footprint: the building's placed physics tris projected to XY and rasterized
//   on a 0.25 m grid (cell covered iff any tri overlaps it, 2D SAT); the skirt
//   follows covered/uncovered cell boundaries, so concave footprints (L-courts)
//   stay open and no wall strays more than one cell diagonal (~0.36 m) from real
//   building geometry. Vertical quads are unwalkable to Recast regardless of
//   winding (slope filter), and a span merged under a wall keeps the wall's
//   unwalkable top — unlike a "solid cap" alternative, whose up-facing top would
//   itself become a walkable roof island within agentMaxClimb reach of terrain
//   in the worst case. Statics/scenery are never sealed (only Buildings[] are
//   CBuildingObj with enterable interiors).
//   Portal gate (2026-07-19): a seal only closes doorways that lead into
//   interior EnvCells, so it is emitted ONLY when the BuildingInfo has at least
//   one BuildingPortal (bld.Portals.Count > 0 — each portal's OtherCellId links
//   an interior 0x0100xxxx cell). Buildings with no portals are not enterable
//   shells: city-wall / gatehouse pieces (e.g. Arwic GfxObj family
//   0x01002D20-26) stored as lbi.Buildings entries but with open pass-throughs.
//   Sealing those walled the town compound into a disconnected navmesh island,
//   so their seal is skipped (logged one line each; counted in totals).
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;
using DatReaderWriter.Types;

string? GetArg(string name)
{
    for (int i = 0; i < args.Length - 1; i++)
        if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            return args[i + 1];
    return null;
}

string ac = GetArg("--ac") ?? "/home/wbterminal/ac_base_dats";
string? sceneryDir = GetArg("--scenery");
string? outDir = GetArg("--out");
string? tiled = GetArg("--tiled");
// Building-seal is DEFAULT ON (routing must go around houses, not through open
// doorways — see header). Pass --no-seal-buildings to restore terrain-through
// footprints (e.g. for future indoor-entry bakes). --seal-buildings still accepted
// as an explicit no-op for back-compat with existing scripts.
bool sealBuildings = !args.Any(a => string.Equals(a, "--no-seal-buildings", StringComparison.OrdinalIgnoreCase));
if (outDir == null || tiled == null)
{
    Console.Error.WriteLine("usage: GeomExtract --ac <dats> --scenery <dir> --out <geomdir> --tiled minX,maxX,minY,maxY (hex) [--no-seal-buildings]");
    return 1;
}
var p = tiled.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
if (p.Length != 4) { Console.Error.WriteLine("--tiled needs minX,maxX,minY,maxY (hex)"); return 1; }
int x0 = Convert.ToInt32(p[0], 16), x1 = Convert.ToInt32(p[1], 16), y0 = Convert.ToInt32(p[2], 16), y1 = Convert.ToInt32(p[3], 16);
Directory.CreateDirectory(outDir);

using var cellDb = new CellDatabase(Path.Combine(ac, "client_cell_1.dat"), DatAccessType.Read);
using var portalDb = new PortalDatabase(Path.Combine(ac, "client_portal.dat"), DatAccessType.Read);

Console.WriteLine($"GeomExtract — dats={ac} scenery={sceneryDir ?? "(none)"} out={outDir}{(sealBuildings ? " [seal-buildings]" : "")}");
Console.WriteLine($"region lbX 0x{x0:X2}..0x{x1:X2} lbY 0x{y0:X2}..0x{y1:X2} (+1 lb border for NavBake seam context)");

// ── model-local triangle cache (unscaled; scale applied at placement) ─────────
var gfxTriCache = new Dictionary<uint, List<Vector3>?>();   // flat verts, 3 per tri
var setupCache = new Dictionary<uint, Setup?>();
int gfxNoPhysics = 0, modelMisses = 0;

List<Vector3>? GfxTris(uint did)
{
    if (gfxTriCache.TryGetValue(did, out var cached)) return cached;
    List<Vector3>? result = null;
    if (portalDb.TryGet<GfxObj>(did, out var gfx) && gfx != null)
    {
        if (gfx.PhysicsPolygons.Count == 0)
        {
            gfxNoPhysics++;                       // non-collidable prop (no physics data)
            result = new List<Vector3>();
        }
        else
        {
            result = new List<Vector3>();
            foreach (var poly in gfx.PhysicsPolygons.Values)
            {
                var ids = poly.VertexIds;
                if (ids.Count < 3) continue;
                bool doubleSided = poly.SidesType == DatReaderWriter.Enums.CullMode.None;
                for (int i = 1; i + 1 < ids.Count; i++)
                {
                    if (!gfx.VertexArray.Vertices.TryGetValue((ushort)ids[0], out var a) ||
                        !gfx.VertexArray.Vertices.TryGetValue((ushort)ids[i], out var b) ||
                        !gfx.VertexArray.Vertices.TryGetValue((ushort)ids[i + 1], out var c))
                        continue;                 // rare dat corruption: skip vertex refs that don't resolve
                    result.Add(a.Origin); result.Add(b.Origin); result.Add(c.Origin);
                    if (doubleSided) { result.Add(a.Origin); result.Add(c.Origin); result.Add(b.Origin); }
                }
            }
        }
    }
    else modelMisses++;
    gfxTriCache[did] = result;
    return result;
}

Setup? GetSetup(uint did)
{
    if (setupCache.TryGetValue(did, out var cached)) return cached;
    Setup? s = portalDb.TryGet<Setup>(did, out var setup) ? setup : null;
    if (s == null) modelMisses++;
    setupCache[did] = s;
    return s;
}

// Closed 8-sided prism (vertical cylinder approximation) in model-local space:
// base center `c`, radius `r`, extends up `h`. Wound so outward/up faces are
// the front (CCW-from-outside), matching the physics-poly convention.
void EmitPrism(List<Vector3> outv, Vector3 c, float r, float h, Vector3 origin, Quaternion q, float scale)
{
    const int N = 8;
    var lo = new Vector3[N];
    var hi = new Vector3[N];
    for (int i = 0; i < N; i++)
    {
        double a = 2.0 * Math.PI * i / N;
        var off = new Vector3((float)(Math.Cos(a) * r), (float)(Math.Sin(a) * r), 0);
        lo[i] = origin + Vector3.Transform((c + off) * scale, q);
        hi[i] = origin + Vector3.Transform((c + off + new Vector3(0, 0, h)) * scale, q);
    }
    for (int i = 0; i < N; i++)
    {
        int j = (i + 1) % N;
        // side quad, outward-facing
        outv.Add(lo[i]); outv.Add(lo[j]); outv.Add(hi[j]);
        outv.Add(lo[i]); outv.Add(hi[j]); outv.Add(hi[i]);
    }
    for (int i = 1; i + 1 < N; i++)
    {
        // top cap, up-facing (CCW from +Z)
        outv.Add(hi[0]); outv.Add(hi[i]); outv.Add(hi[i + 1]);
        // bottom cap, down-facing
        outv.Add(lo[0]); outv.Add(lo[i + 1]); outv.Add(lo[i]);
    }
}

// ── --seal-buildings: footprint wall skirt (see header block for rationale) ──
const float SealGrid = 0.25f;   // footprint raster resolution (m); bake cellSize is 0.5
const float SealBelow = 1.0f;   // skirt extends below building zmin (bury into terrain)
const float SealAbove = 4.0f;   // ... and above (>= agentHeight 2.0 + terrain-slope slack)

// 2D separating-axis triangle-vs-cell test (XY projection). Degenerate
// projections (vertical walls -> segments) still resolve correctly: SAT with
// the two distinct edge normals is exactly the segment-vs-box test.
static bool TriBoxOverlap2D(Vector3 a, Vector3 b, Vector3 c, float x0, float y0, float x1, float y1)
{
    float tx0 = Math.Min(a.X, Math.Min(b.X, c.X)), tx1 = Math.Max(a.X, Math.Max(b.X, c.X));
    float ty0 = Math.Min(a.Y, Math.Min(b.Y, c.Y)), ty1 = Math.Max(a.Y, Math.Max(b.Y, c.Y));
    if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1) return false;   // box axes
    Span<(float ax, float ay)> axes = stackalloc[]
    {
        (a.Y - b.Y, b.X - a.X), (b.Y - c.Y, c.X - b.X), (c.Y - a.Y, a.X - c.X),
    };
    foreach (var (ax, ay) in axes)                                    // triangle edge normals
    {
        float pa = ax * a.X + ay * a.Y, pb = ax * b.X + ay * b.Y, pc = ax * c.X + ay * c.Y;
        float tmin = Math.Min(pa, Math.Min(pb, pc)), tmax = Math.Max(pa, Math.Max(pb, pc));
        float b00 = ax * x0 + ay * y0, b01 = ax * x0 + ay * y1, b10 = ax * x1 + ay * y0, b11 = ax * x1 + ay * y1;
        if (tmax < Math.Min(Math.Min(b00, b01), Math.Min(b10, b11)) ||
            tmin > Math.Max(Math.Max(b00, b01), Math.Max(b10, b11))) return false;
    }
    return true;
}

// Vertical wall skirt along the rasterized-footprint boundary of one placed
// building. Returns a flat vertex list (2 tris per merged boundary run).
List<Vector3> SealSkirt(List<Vector3> verts, out int segments)
{
    segments = 0;
    var outv = new List<Vector3>();
    float minx = float.MaxValue, maxx = float.MinValue, miny = float.MaxValue, maxy = float.MinValue, minz = float.MaxValue;
    foreach (var v in verts)
    {
        minx = Math.Min(minx, v.X); maxx = Math.Max(maxx, v.X);
        miny = Math.Min(miny, v.Y); maxy = Math.Max(maxy, v.Y);
        minz = Math.Min(minz, v.Z);
    }
    if (minx > maxx) return outv;
    // grid padded by one empty ring so the footprint boundary is always interior
    int nx = (int)Math.Ceiling((maxx - minx) / SealGrid) + 3;
    int ny = (int)Math.Ceiling((maxy - miny) / SealGrid) + 3;
    float ox = minx - SealGrid, oy = miny - SealGrid;
    var cov = new bool[nx, ny];
    for (int t = 0; t + 2 < verts.Count; t += 3)
    {
        Vector3 a = verts[t], b = verts[t + 1], c = verts[t + 2];
        float tx0 = Math.Min(a.X, Math.Min(b.X, c.X)), tx1 = Math.Max(a.X, Math.Max(b.X, c.X));
        float ty0 = Math.Min(a.Y, Math.Min(b.Y, c.Y)), ty1 = Math.Max(a.Y, Math.Max(b.Y, c.Y));
        int i0 = Math.Max(0, (int)((tx0 - ox) / SealGrid)), i1 = Math.Min(nx - 1, (int)((tx1 - ox) / SealGrid));
        int j0 = Math.Max(0, (int)((ty0 - oy) / SealGrid)), j1 = Math.Min(ny - 1, (int)((ty1 - oy) / SealGrid));
        for (int i = i0; i <= i1; i++)
            for (int j = j0; j <= j1; j++)
                if (!cov[i, j] && TriBoxOverlap2D(a, b, c,
                        ox + i * SealGrid, oy + j * SealGrid, ox + (i + 1) * SealGrid, oy + (j + 1) * SealGrid))
                    cov[i, j] = true;
    }
    float zb = minz - SealBelow, zt = minz + SealAbove;
    int runs = 0;
    void Wall(float x0, float y0, float x1, float y1)
    {
        outv.Add(new Vector3(x0, y0, zb)); outv.Add(new Vector3(x1, y1, zb)); outv.Add(new Vector3(x1, y1, zt));
        outv.Add(new Vector3(x0, y0, zb)); outv.Add(new Vector3(x1, y1, zt)); outv.Add(new Vector3(x0, y0, zt));
        runs++;
    }
    // covered/uncovered cell boundaries, merged into maximal runs. A wall blocks
    // identically from both sides, so runs may merge across side flips.
    for (int i = 1; i < nx; i++)        // wall planes at x = ox + i*grid
        for (int j = 0; j < ny;)
        {
            if (cov[i - 1, j] == cov[i, j]) { j++; continue; }
            int j0 = j;
            while (j < ny && cov[i - 1, j] != cov[i, j]) j++;
            Wall(ox + i * SealGrid, oy + j0 * SealGrid, ox + i * SealGrid, oy + j * SealGrid);
        }
    for (int j = 1; j < ny; j++)        // wall planes at y = oy + j*grid
        for (int i = 0; i < nx;)
        {
            if (cov[i, j - 1] == cov[i, j]) { i++; continue; }
            int i0 = i;
            while (i < nx && cov[i, j - 1] != cov[i, j]) i++;
            Wall(ox + i0 * SealGrid, oy + j * SealGrid, ox + i * SealGrid, oy + j * SealGrid);
        }
    segments = runs;
    return outv;
}

// Resolve one placed model to landblock-local triangles (flat vertex list).
List<Vector3> PlaceModel(uint did, Vector3 origin, Quaternion q, float scale)
{
    var outv = new List<Vector3>();
    void EmitGfx(uint gfxDid, Vector3 o, Quaternion rot, Vector3 vscale)
    {
        var tris = GfxTris(gfxDid);
        if (tris == null) return;
        foreach (var v in tris)
            outv.Add(o + Vector3.Transform(v * vscale, rot));
    }

    switch (did >> 24)
    {
        case 0x01:
            EmitGfx(did, origin, q, new Vector3(scale));
            break;
        case 0x02:
        {
            var setup = GetSetup(did);
            if (setup == null) return outv;
            int n = setup.Parts.Count;
            // Retail placement pick: 0x65 (Placement.Resting, what InitObjectEnd
            // applies to every static/building/scenery object) -> key 0 -> identity.
            List<Frame>? frames = null;
            foreach (var kv in setup.PlacementFrames)
            {
                int key = Convert.ToInt32(kv.Key);
                if (key == 0x65) { frames = kv.Value.Frames; break; }
                if (key == 0 && frames == null) frames = kv.Value.Frames;
            }
            for (int i = 0; i < n; i++)
            {
                uint partDid = setup.Parts[i];
                Vector3 po = Vector3.Zero;
                Quaternion pq = Quaternion.Identity;
                if (frames != null && i < frames.Count)
                {
                    po = frames[i].Origin;
                    pq = frames[i].Orientation;
                }
                // ACE AFrame.Combine: origin = objO + objQ*(placementO*objScale); orientation = objQ*placementQ
                Vector3 partO = origin + Vector3.Transform(po * scale, q);
                Quaternion partQ = Quaternion.Multiply(q, pq);
                Vector3 ds = (setup.DefaultScale.Count > i) ? setup.DefaultScale[i] : Vector3.One;
                EmitGfx(partDid, partO, partQ, ds * scale);
            }
            // Scenery-style fallback: no part physics polys -> setup collision volumes.
            if (outv.Count == 0)
            {
                foreach (var cs in setup.CylSpheres)
                    EmitPrism(outv, cs.Origin, cs.Radius, cs.Height, origin, q, scale);
                foreach (var sp in setup.Spheres)
                    EmitPrism(outv, sp.Origin - new Vector3(0, 0, sp.Radius), sp.Radius, sp.Radius * 2f, origin, q, scale);
            }
            break;
        }
        default:
            Console.WriteLine($"  WARN: unexpected model DID 0x{did:X8} (not GfxObj/Setup) — skipped");
            break;
    }
    return outv;
}

// ── per-landblock extraction ─────────────────────────────────────────────────
var json = new JsonSerializerOptions(); // default: shortest round-trip floats
int lbCount = 0, totalObjects = 0, totalBuildings = 0, totalScenery = 0, totalSeals = 0, totalSealsSkipped = 0;
long totalTris = 0, totalSealTris = 0;

void WriteEntry(StreamWriter w, string src, uint did, List<Vector3> verts, ref long triAccum)
{
    if (verts.Count == 0) return;
    var sb = new StringBuilder();
    sb.Append("{\"src\":\"").Append(src).Append("\",\"did\":\"0x").Append(did.ToString("X8")).Append("\",\"tris\":[");
    for (int i = 0; i < verts.Count; i++)
    {
        if (i > 0) sb.Append(',');
        var v = verts[i];
        sb.Append('[').Append(v.X.ToString("R", CultureInfo.InvariantCulture))
          .Append(',').Append(v.Y.ToString("R", CultureInfo.InvariantCulture))
          .Append(',').Append(v.Z.ToString("R", CultureInfo.InvariantCulture)).Append(']');
    }
    sb.Append("]}");
    w.WriteLine(sb.ToString());
    triAccum += verts.Count / 3;
}

for (int x = Math.Max(0, x0 - 1); x <= Math.Min(255, x1 + 1); x++)
    for (int y = Math.Max(0, y0 - 1); y <= Math.Min(255, y1 + 1); y++)
    {
        uint lb = (uint)((x << 8) | y);
        int nObj = 0, nBld = 0, nScn = 0;
        long nTri = 0;
        string outPath = Path.Combine(outDir, $"geom_{lb:X4}.jsonl");
        using var w = new StreamWriter(outPath, false, new UTF8Encoding(false));

        // 1. LandBlockInfo statics + buildings (landblock-local frames already).
        uint lbiId = (lb << 16) | 0xFFFE;
        if (cellDb.TryGet<LandBlockInfo>(lbiId, out var lbi) && lbi != null)
        {
            foreach (var stab in lbi.Objects)
            {
                var verts = PlaceModel(stab.Id, stab.Frame.Origin, stab.Frame.Orientation, 1.0f);
                WriteEntry(w, "static", stab.Id, verts, ref nTri);
                nObj++;
            }
            foreach (var bld in lbi.Buildings)
            {
                var verts = PlaceModel(bld.ModelId, bld.Frame.Origin, bld.Frame.Orientation, 1.0f);
                WriteEntry(w, "building", bld.ModelId, verts, ref nTri);
                nBld++;
                // Nav-seal skirt rides directly after its building line (GeomCheck
                // SEAL pairs them by adjacency; duplicate ModelIds per LB exist).
                // A seal exists ONLY to close doorways that lead into interior
                // EnvCells (interiors are off-mesh). BuildingInfo.Portals lists those
                // interior links (each BuildingPortal.OtherCellId -> a 0x0100xxxx
                // interior cell); a building with no portals (city-wall segments,
                // pass-through gatehouse arches — e.g. Arwic 0x01002D20-26) has NO
                // doorway to close, so sealing it would wall off a genuinely open
                // gap and disconnect the outdoor navmesh. Seal iff Portals.Count > 0.
                if (sealBuildings && verts.Count > 0)
                {
                    if (bld.Portals.Count > 0)
                    {
                        var skirt = SealSkirt(verts, out int segs);
                        WriteEntry(w, "seal", bld.ModelId, skirt, ref nTri);
                        totalSeals++; totalSealTris += skirt.Count / 3;
                        Console.WriteLine($"  seal 0x{lb:X4}/0x{bld.ModelId:X8}: {skirt.Count / 3} wall tris in {segs} boundary runs");
                    }
                    else
                    {
                        totalSealsSkipped++;
                        Console.WriteLine($"  seal-skip 0x{lb:X4}/0x{bld.ModelId:X8}: no interior portals — seal skipped");
                    }
                }
            }
        }

        // 2. Pre-baked procedural scenery (landblock-local AC coords + uniform scale).
        if (sceneryDir != null)
        {
            string scnPath = Path.Combine(sceneryDir, $"0x{lb:X4}.scenery.jsonl");
            if (File.Exists(scnPath))
            {
                foreach (var line in File.ReadLines(scnPath))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    uint did = Convert.ToUInt32(r.GetProperty("obj_id").GetString()!, 16);
                    var origin = new Vector3(
                        (float)r.GetProperty("x").GetDouble(),
                        (float)r.GetProperty("y").GetDouble(),
                        (float)r.GetProperty("z").GetDouble());
                    // System.Numerics.Quaternion ctor is (x, y, z, w).
                    var q = new Quaternion(
                        (float)r.GetProperty("qx").GetDouble(),
                        (float)r.GetProperty("qy").GetDouble(),
                        (float)r.GetProperty("qz").GetDouble(),
                        (float)r.GetProperty("qw").GetDouble());
                    float scale = r.TryGetProperty("scale", out var sc) ? (float)sc.GetDouble() : 1.0f;
                    var verts = PlaceModel(did, origin, q, scale);
                    WriteEntry(w, "scenery", did, verts, ref nTri);
                    nScn++;
                }
            }
        }

        lbCount++;
        totalObjects += nObj; totalBuildings += nBld; totalScenery += nScn; totalTris += nTri;
        if (nObj + nBld + nScn > 0)
            Console.WriteLine($"0x{lb:X4}: statics={nObj} buildings={nBld} scenery={nScn} tris={nTri}");
    }

Console.WriteLine($"DONE: {lbCount} landblocks -> {outDir}");
Console.WriteLine($"totals: statics={totalObjects} buildings={totalBuildings} scenery={totalScenery} tris={totalTris}");
if (sealBuildings)
    Console.WriteLine($"seal-buildings: {totalSeals} buildings sealed, {totalSealsSkipped} skipped (no interior portals), {totalSealTris} wall tris (routing-only; re-extract without --seal-buildings to reopen doorways)");
Console.WriteLine($"gfxobjs without physics polys (non-collidable, skipped): {gfxNoPhysics}; model DID lookup misses: {modelMisses}");
return 0;
