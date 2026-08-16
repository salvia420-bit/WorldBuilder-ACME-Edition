using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// environment-append-geometry — the dungeon-geometry (environment-import) write
/// path. Appends OBJ render geometry to ONE CellStruct of an Environment (0x0D)
/// record inside a portal-DAT COPY, following the in-client-proven obj-import
/// template (447 buildings, 1070-gated 2026-08-15):
///
///   * appended DRAWN polygons only — physics polygons, Portals, CellBSP,
///     PhysicsBSP and DrawingBSP are carried VERBATIM (no BSP rebuild; retail
///     renders appended polys with the original tree, in-client proven);
///   * ConstructMesh-safe polygon defaults (the polyfix invariants):
///     Stippling=None, SidesType=Landblock(0), NegSurface=0, PosUVIndices
///     present and in range (each appended vertex carries exactly one UV);
///   * PosSurface is a CELL-LOCAL SURFACE INDEX (each EnvCell that instantiates
///     this CellStruct maps the index through its OWN surface array — the same
///     struct renders as stone in one dungeon and ice in another), selected in
///     the OBJ with <c>usemtl surf&lt;N&gt;</c>; faces before any usemtl get index 0.
///
/// Vertex keys continue the CellStruct VertexArray's ushort key space; polygon
/// keys continue the drawn-Polygons key space. Vertices are never shared with
/// the original mesh (appended shell stays independent, like obj-import).
/// </summary>
public partial class CommandEngine {

    public sealed record EnvironmentAppendResult(
        string DatPath, uint EnvId, uint CellStructIndex, bool DryRun,
        int AppendedVertices, int AppendedPolys, int NewVertexCount, int NewPolyCount);

    public EnvironmentAppendResult EnvironmentAppendGeometry(
        string datPath, uint envId, uint cellStructIndex, string objPath, bool dryRun) {

        var resolved = GuardWritableDatCopy(datPath);
        if ((envId >> 24) != 0x0D)
            throw new ArgumentException($"0x{envId:X8} is not an Environment id (expected the 0x0D prefix).");
        if (!File.Exists(objPath))
            throw new FileNotFoundException($"objPath not found: {objPath}");

        var (faces, positions, normals, uvs) = ParseObjForAppend(File.ReadAllText(objPath));
        if (faces.Count == 0)
            throw new InvalidOperationException("OBJ has no faces.");

        using var portal = new DRW.PortalDatabase(resolved,
            dryRun ? DRW.Options.DatAccessType.Read : DRW.Options.DatAccessType.ReadWrite);

        if (!portal.TryGet<DRW.DBObjs.Environment>(envId, out var env) || env == null)
            throw new InvalidOperationException($"Environment 0x{envId:X8} not found in {Path.GetFileName(resolved)}.");
        if (!env.Cells.TryGetValue(cellStructIndex, out var cs) || cs == null)
            throw new InvalidOperationException(
                $"Environment 0x{envId:X8} has no CellStruct {cellStructIndex} (has: {string.Join(",", env.Cells.Keys.OrderBy(k => k))}).");

        var verts = cs.VertexArray.Vertices;
        var polys = cs.Polygons;
        int nextVert = verts.Count == 0 ? 0 : verts.Keys.Max() + 1;
        int nextPoly = polys.Count == 0 ? 0 : polys.Keys.Max() + 1;

        // Dedupe appended vertices among themselves only (never against the
        // original mesh — Polygon.VertexIds is short, so the key space must
        // stay under 32768 either way).
        var newVerts = new List<(ushort key, SWVertex v)>();
        ushort GetOrAddVertex(Vector3 p, Vector3 n, Vector2 t) {
            foreach (var (key, v) in newVerts) {
                if (Vector3.DistanceSquared(v.Origin, p) < 1e-12f
                    && Vector3.DistanceSquared(v.Normal, n) < 1e-12f
                    && MathF.Abs(v.UVs[0].U - t.X) < 1e-6f
                    && MathF.Abs(v.UVs[0].V - t.Y) < 1e-6f)
                    return key;
            }
            if (nextVert > short.MaxValue)
                throw new InvalidOperationException(
                    "Vertex key space exhausted (Polygon.VertexIds is short; keys must stay <= 32767).");
            var nv = new SWVertex {
                Origin = p,
                Normal = Vector3.Normalize(n),
                UVs = new List<Vec2Duv> { new() { U = t.X, V = t.Y } },
            };
            var k = (ushort)nextVert++;
            newVerts.Add((k, nv));
            return k;
        }

        var newPolys = new List<(ushort key, Polygon p)>();
        foreach (var face in faces) {
            if (face.Corners.Count < 3)
                throw new InvalidOperationException("OBJ face with fewer than 3 corners.");
            if (face.Corners.Count > 255)
                throw new InvalidOperationException("OBJ face with more than 255 corners (Polygon._numVertices is a byte).");
            var ids = new List<short>(face.Corners.Count);
            Vector3 flat = ComputeFlatNormal(
                positions[face.Corners[0].V], positions[face.Corners[1].V], positions[face.Corners[2].V]);
            foreach (var c in face.Corners) {
                var p = positions[c.V];
                var n = c.Vn >= 0 && c.Vn < normals.Count ? normals[c.Vn] : flat;
                var t = c.Vt >= 0 && c.Vt < uvs.Count ? uvs[c.Vt] : Vector2.Zero;
                ids.Add((short)GetOrAddVertex(p, n, t));
            }
            if (nextPoly > ushort.MaxValue)
                throw new InvalidOperationException("Polygon key space exhausted.");
            newPolys.Add(((ushort)nextPoly++, new Polygon {
                VertexIds = ids,
                PosSurface = (short)face.SurfaceIndex,
                // ConstructMesh-safe defaults (polyfix invariants; see
                // ObjSingleMeshImporter for the in-client crash rationale):
                NegSurface = 0,
                Stippling = StipplingType.None,
                SidesType = CullMode.Landblock,
                PosUVIndices = Enumerable.Repeat((byte)0, ids.Count).ToList(),
            }));
        }

        if (!dryRun) {
            foreach (var (k, v) in newVerts) verts[k] = v;
            foreach (var (k, p) in newPolys) polys[k] = p;
            var result = portal.TryWriteFile(env);
            if (!result.Success)
                throw new InvalidOperationException($"TryWriteFile failed: {result.Error}");
        }

        return new EnvironmentAppendResult(
            resolved, envId, cellStructIndex, dryRun,
            newVerts.Count, newPolys.Count,
            verts.Count + (dryRun ? newVerts.Count : 0),
            polys.Count + (dryRun ? newPolys.Count : 0));
    }

    static Vector3 ComputeFlatNormal(Vector3 a, Vector3 b, Vector3 c) {
        var n = Vector3.Cross(b - a, c - a);
        return n.LengthSquared() < 1e-20f ? Vector3.UnitZ : Vector3.Normalize(n);
    }

    readonly record struct ObjCorner(int V, int Vt, int Vn);
    sealed record ObjFace(List<ObjCorner> Corners, int SurfaceIndex);

    /// <summary>Minimal OBJ parse for the append path: v/vn/vt + n-gon f lines,
    /// <c>usemtl surf&lt;N&gt;</c> selects the cell-local surface INDEX for
    /// subsequent faces (default 0). 1-based positive indices only.</summary>
    static (List<ObjFace> faces, List<Vector3> pos, List<Vector3> norm, List<Vector2> uv)
        ParseObjForAppend(string text) {
        var pos = new List<Vector3>();
        var norm = new List<Vector3>();
        var uv = new List<Vector2>();
        var faces = new List<ObjFace>();
        int surfIdx = 0;
        var ci = CultureInfo.InvariantCulture;
        foreach (var raw in text.Split('\n')) {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            var tok = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            switch (tok[0]) {
                case "v":
                    pos.Add(new Vector3(float.Parse(tok[1], ci), float.Parse(tok[2], ci), float.Parse(tok[3], ci)));
                    break;
                case "vn":
                    norm.Add(new Vector3(float.Parse(tok[1], ci), float.Parse(tok[2], ci), float.Parse(tok[3], ci)));
                    break;
                case "vt":
                    uv.Add(new Vector2(float.Parse(tok[1], ci), float.Parse(tok[2], ci)));
                    break;
                case "usemtl":
                    if (tok.Length > 1 && tok[1].StartsWith("surf", StringComparison.OrdinalIgnoreCase)
                        && int.TryParse(tok[1].AsSpan(4), out var n) && n >= 0)
                        surfIdx = n;
                    else
                        throw new InvalidOperationException(
                            $"usemtl '{(tok.Length > 1 ? tok[1] : "")}' — expected 'surf<N>' (a cell-local surface index).");
                    break;
                case "f": {
                    var corners = new List<ObjCorner>(tok.Length - 1);
                    for (int i = 1; i < tok.Length; i++) {
                        var parts = tok[i].Split('/');
                        int V = int.Parse(parts[0], ci);
                        int Vt = parts.Length > 1 && parts[1].Length > 0 ? int.Parse(parts[1], ci) : 0;
                        int Vn = parts.Length > 2 && parts[2].Length > 0 ? int.Parse(parts[2], ci) : 0;
                        if (V <= 0 || Vt < 0 || Vn < 0)
                            throw new InvalidOperationException("OBJ face uses non-positive indices (unsupported).");
                        corners.Add(new ObjCorner(V - 1, Vt - 1, Vn - 1));
                    }
                    faces.Add(new ObjFace(corners, surfIdx));
                    break;
                }
            }
        }
        return (faces, pos, norm, uv);
    }
}
