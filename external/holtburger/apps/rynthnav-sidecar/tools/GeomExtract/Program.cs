// GeomExtract — pre-extracts static-object collision triangles for the RynthNav
// obstacle-aware navmesh bake, so the sidecar's serve/bake path never needs a
// DAT-parsing dependency.
//
//   GeomExtract --ac <dats> --scenery <dist scenery dir> --out <geomdir>
//               --tiled <minX,maxX,minY,maxY hex>
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
if (outDir == null || tiled == null)
{
    Console.Error.WriteLine("usage: GeomExtract --ac <dats> --scenery <dir> --out <geomdir> --tiled minX,maxX,minY,maxY (hex)");
    return 1;
}
var p = tiled.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
if (p.Length != 4) { Console.Error.WriteLine("--tiled needs minX,maxX,minY,maxY (hex)"); return 1; }
int x0 = Convert.ToInt32(p[0], 16), x1 = Convert.ToInt32(p[1], 16), y0 = Convert.ToInt32(p[2], 16), y1 = Convert.ToInt32(p[3], 16);
Directory.CreateDirectory(outDir);

using var cellDb = new CellDatabase(Path.Combine(ac, "client_cell_1.dat"), DatAccessType.Read);
using var portalDb = new PortalDatabase(Path.Combine(ac, "client_portal.dat"), DatAccessType.Read);

Console.WriteLine($"GeomExtract — dats={ac} scenery={sceneryDir ?? "(none)"} out={outDir}");
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
int lbCount = 0, totalObjects = 0, totalBuildings = 0, totalScenery = 0;
long totalTris = 0;

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
Console.WriteLine($"gfxobjs without physics polys (non-collidable, skipped): {gfxNoPhysics}; model DID lookup misses: {modelMisses}");
return 0;
