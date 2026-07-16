// GeometryLoaderShim.cs — local stand-in for AcClientReborn's RynthCore2.Raycast.GeometryLoader,
// which is NOT vendored (AcClientReborn is not in our tree).
//
// It provides exactly the members NavBake.cs touches, in the exact upstream
// namespace, so the vendored NavBake.cs compiles verbatim:
//   - nested TexTri (A/B/C vertices with .X/.Y/.Z)
//   - GetTexturedStaticObjects(uint lb)
//   - GetTexturedScatter(uint lb, heightAt)
//   - Initialize(string) / InitializeGeomDir(string)
//   - StatusMessage, IDisposable
//
// TWO MODES:
//   1. Initialize(acPath)          -> always false: no DAT parser here (the serve
//      path stays dependency-free). Callers fall back to TERRAIN-ONLY tiles.
//   2. InitializeGeomDir(geomDir)  -> true when the dir exists. Obstacle
//      triangles are read from pre-extracted geom_{LB:X4}.jsonl files produced
//      by tools/GeomExtract (LandBlockInfo statics + buildings from cell.dat,
//      plus dist-bake scenery), one JSON object per line:
//        {"src":"static"|"building"|"scenery","did":"0x...","tris":[[x,y,z],...]}
//      "tris" is a FLAT vertex list in LANDBLOCK-LOCAL AC coords (Z-up),
//      3 consecutive vertices = 1 triangle, front face wound CCW (retail
//      CPolygon::make_plane convention). This loader adds the lb -> world
//      offset (lbX*192, lbY*192) so the triangles ride the same frame as
//      NavBake.AppendLandblock's terrain verts (which are world AC coords fed
//      through AcToRec).
//      A missing geom file for a landblock = warn once + terrain-only for that
//      landblock (never fails the bake). An existing-but-empty file means
//      "extracted, genuinely no obstacles" and is silent.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace RynthCore2.Raycast;

public sealed class GeometryLoader : IDisposable
{
    /// <summary>One textured triangle (AC frame: x=EW, y=NS, z=up).</summary>
    public sealed class TexTri
    {
        public System.Numerics.Vector3 A;
        public System.Numerics.Vector3 B;
        public System.Numerics.Vector3 C;
    }

    private string? _geomDir;
    private readonly HashSet<uint> _warnedMissing = new();
    public int TrianglesServed { get; private set; }
    public int LandblocksServed { get; private set; }

    public string StatusMessage { get; private set; } =
        "GeometryLoaderShim: no --geom dir given — TERRAIN-ONLY bake (no building/scatter obstacles)";

    /// <summary>Always false: there is no DAT-parsing geometry source in this build (use --geom).</summary>
    public bool Initialize(string acFolderPath) => false;

    /// <summary>Pre-extracted geometry mode: serve triangles from geom_{LB:X4}.jsonl files.</summary>
    public bool InitializeGeomDir(string geomDir)
    {
        if (!Directory.Exists(geomDir))
        {
            StatusMessage = $"GeometryLoaderShim: geom dir not found: {geomDir} — TERRAIN-ONLY bake";
            return false;
        }
        _geomDir = geomDir;
        int n = Directory.GetFiles(geomDir, "geom_*.jsonl").Length;
        StatusMessage = $"GeometryLoaderShim: statics+scenery obstacles from {geomDir} ({n} geom files)";
        return true;
    }

    public List<TexTri> GetTexturedStaticObjects(uint lb)
    {
        var result = new List<TexTri>();
        if (_geomDir == null) return result;

        string path = Path.Combine(_geomDir, $"geom_{lb:X4}.jsonl");
        if (!File.Exists(path))
        {
            if (_warnedMissing.Add(lb))
                Console.WriteLine($"[geom] WARN: no geom file for 0x{lb:X4} ({path}) — terrain-only for this landblock");
            return result;
        }

        float ox = ((lb >> 8) & 0xFF) * 192f;   // lb -> world offset, same frame as terrain verts
        float oy = (lb & 0xFF) * 192f;
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException)
            {
                Console.WriteLine($"[geom] WARN: malformed line in {path} — skipped");
                continue;
            }
            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("tris", out var tris) || tris.ValueKind != JsonValueKind.Array)
                    continue;
                int count = tris.GetArrayLength();
                var pts = new System.Numerics.Vector3[3];
                int have = 0;
                foreach (var v in tris.EnumerateArray())
                {
                    pts[have] = new System.Numerics.Vector3(
                        (float)v[0].GetDouble() + ox,
                        (float)v[1].GetDouble() + oy,
                        (float)v[2].GetDouble());
                    if (++have == 3)
                    {
                        result.Add(new TexTri { A = pts[0], B = pts[1], C = pts[2] });
                        have = 0;
                    }
                }
                if (have != 0)
                    Console.WriteLine($"[geom] WARN: {path}: tris length {count} not divisible by 3 — trailing vertices dropped");
            }
        }
        TrianglesServed += result.Count;
        LandblocksServed++;
        return result;
    }

    /// <summary>Scatter is pre-baked into the geom files (src="scenery") and served
    /// via GetTexturedStaticObjects — nothing extra here.</summary>
    public List<TexTri> GetTexturedScatter(uint lb, Func<float, float, float> heightAt) => new();

    public void Dispose() { }
}
