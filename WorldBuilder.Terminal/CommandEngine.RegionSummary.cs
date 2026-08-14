using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using DatReaderWriter.Extensions;
using DatReaderWriter.Extensions.DBObjs;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;

namespace WorldBuilder.Terminal;

// ═════════════════════════════════════════════════════════════════════
//  gfxobj-region-summary — per-model region summary exporter.
//
//  Preprocesses a GfxObj mesh (or every distinct part of a Setup) from
//  the project DATs into structured JSON an artist model consumes to
//  author "relief plans": coplanar same-material face regions with
//  boundary loops (outer + holes), least-squares UV affine fits,
//  region adjacency with dihedral classification, and a material table
//  with downscaled texture thumbnails. Read-only against the DATs.
// ═════════════════════════════════════════════════════════════════════

public record GfxObjRegionSummaryResult(
    string DatId, string DatType, bool Success,
    string? OutputPath = null, int ModelCount = 0, int RegionCount = 0,
    int MaterialCount = 0, int ThumbnailCount = 0, int UnstructuredModels = 0,
    List<string>? Warnings = null, string? Error = null);

public partial class CommandEngine {

    const double RsQuantumInv = 1e5;      // vertex quantization: round(coord * 1e5)
    const double RsNormalDotMin = 0.999;  // coplanar-region normal test
    const double RsMinEdgeLen = 1e-4;     // adjacency edges shorter than this are ignored

    // ── tiny double-precision vector ────────────────────────────────
    readonly record struct V3d(double X, double Y, double Z) {
        public static readonly V3d Zero = new(0, 0, 0);
        public static V3d operator +(V3d a, V3d b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static V3d operator -(V3d a, V3d b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static V3d operator *(V3d a, double s) => new(a.X * s, a.Y * s, a.Z * s);
        public static V3d operator -(V3d a) => new(-a.X, -a.Y, -a.Z);
        public double Dot(V3d o) => X * o.X + Y * o.Y + Z * o.Z;
        public V3d Cross(V3d o) => new(Y * o.Z - Z * o.Y, Z * o.X - X * o.Z, X * o.Y - Y * o.X);
        public double Len() => Math.Sqrt(Dot(this));
        public V3d Norm() { var l = Len(); return l > 1e-12 ? this * (1.0 / l) : Zero; }
        public double[] Arr() => new[] { RsR(X), RsR(Y), RsR(Z) };
    }

    static double RsR(double v) { var r = Math.Round(v, 6); return r == 0 ? 0 : r; }

    sealed class RsFace {
        public int Key;                  // polygon dictionary key
        public Polygon Poly = null!;
        public ushort[] RawIds = null!;  // stored corner vertex ids (aligned with UV index lists)
        public V3d[] RawPos = null!;     // stored corner positions (aligned with RawIds)
        public int[] Corners = null!;    // canonical (quantized) vertex ids, consecutive dups removed
        public V3d Normal;               // outward unit normal
        public double D;                 // n · p
        public double Area;
        public V3d Centroid;
        public uint MaterialDid;
        public bool DoubleSided;         // NegSurface >= 0 (back face rendered)
        public bool Reversed;            // material came from NegSurface only (rare)
        public int Region = -1;
    }

    public GfxObjRegionSummaryResult GfxObjRegionSummary(uint datId, string outputPath,
        bool thumbnails = true, string? thumbDir = null, int maxThumbDim = 128) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;

        bool isSetup = (datId >> 24) == 0x02;
        bool isGfxObj = (datId >> 24) == 0x01;
        string datType = isSetup ? "Setup" : isGfxObj ? "GfxObj" : "Unknown";
        string hexId = $"0x{datId:X8}";
        if (!isSetup && !isGfxObj)
            return new GfxObjRegionSummaryResult(hexId, datType, false,
                Error: "ID must be 0x01xxxxxx (GfxObj) or 0x02xxxxxx (Setup).");
        if (maxThumbDim < 8) maxThumbDim = 8;

        var warnings = new List<string>();
        var gfxIds = new List<uint>();
        if (isSetup) {
            if (!dats.TryGet<Setup>(datId, out var setup) || setup == null)
                return new GfxObjRegionSummaryResult(hexId, datType, false, Error: "Setup not found in DATs.");
            foreach (var part in setup.Parts.Distinct()) {
                if ((part >> 24) != 0x01) { warnings.Add($"Setup part 0x{part:X8} is not a GfxObj; skipped."); continue; }
                gfxIds.Add(part);
            }
            if (gfxIds.Count == 0)
                return new GfxObjRegionSummaryResult(hexId, datType, false, Error: "Setup has no GfxObj parts.");
        }
        else gfxIds.Add(datId);

        var outDir = Path.GetDirectoryName(Path.GetFullPath(outputPath)) ?? ".";
        Directory.CreateDirectory(outDir);
        var baseName = Path.GetFileNameWithoutExtension(outputPath);
        var thumbDirAbs = thumbnails
            ? (string.IsNullOrWhiteSpace(thumbDir) ? Path.Combine(outDir, baseName + "_thumbs") : Path.GetFullPath(thumbDir!))
            : null;

        try {
            DatEasyWriter? writer = null;
            int thumbCount = 0, regionTotal = 0, unstructuredModels = 0;
            var allMaterialDids = new HashSet<uint>();
            // surfaceDid -> shared material entry (thumbnails decoded once even across Setup parts)
            var materialCache = new Dictionary<uint, Dictionary<string, object?>>();
            try {
                if (thumbnails) {
                    Directory.CreateDirectory(thumbDirAbs!);
                    writer = new DatEasyWriter(project.BaseDatDirectory);
                }

                var models = new List<Dictionary<string, object?>>();
                foreach (var gid in gfxIds) {
                    if (!dats.TryGet<GfxObj>(gid, out var gfx) || gfx == null) {
                        if (isSetup) { warnings.Add($"GfxObj 0x{gid:X8} not found; skipped."); continue; }
                        return new GfxObjRegionSummaryResult(hexId, datType, false, Error: "GfxObj not found in DATs.");
                    }
                    var m = BuildModelSummary(gid, gfx, dats, writer, thumbDirAbs, outDir, maxThumbDim,
                        materialCache, allMaterialDids, warnings, ref thumbCount);
                    regionTotal += (int)(m["regionCount"] ?? 0);
                    if (m["unstructured"] is bool u && u) unstructuredModels++;
                    models.Add(m);
                }
                if (models.Count == 0)
                    return new GfxObjRegionSummaryResult(hexId, datType, false, Error: "No summarizable GfxObjs.");

                object root = isSetup
                    ? new Dictionary<string, object?> {
                        ["setup"] = hexId,
                        ["partCount"] = models.Count,
                        ["models"] = models,
                    }
                    : models[0];

                var json = JsonSerializer.Serialize(root, RsJsonOpts);
                File.WriteAllText(outputPath, json);
            }
            finally { writer?.Dispose(); }

            return new GfxObjRegionSummaryResult(hexId, datType, true, outputPath,
                gfxIds.Count, regionTotal, allMaterialDids.Count, thumbCount, unstructuredModels,
                warnings.Count > 0 ? warnings : null);
        }
        catch (Exception ex) {
            return new GfxObjRegionSummaryResult(hexId, datType, false, Error: ex.Message,
                Warnings: warnings.Count > 0 ? warnings : null);
        }
    }

    static readonly JsonSerializerOptions RsJsonOpts = new() { WriteIndented = true };

    Dictionary<string, object?> BuildModelSummary(uint gfxId, GfxObj gfx,
        WorldBuilder.Shared.Lib.IDatReaderWriter dats, DatEasyWriter? writer,
        string? thumbDirAbs, string outDir, int maxThumbDim,
        Dictionary<uint, Dictionary<string, object?>> materialCache,
        HashSet<uint> allMaterialDids, List<string> warnings, ref int thumbCount) {

        // ── canonical (quantized) vertex table ──────────────────────
        var canonPos = new List<V3d>();
        var canonIndex = new Dictionary<(long, long, long), int>();
        int Canon(V3d p) {
            var k = ((long)Math.Round(p.X * RsQuantumInv),
                     (long)Math.Round(p.Y * RsQuantumInv),
                     (long)Math.Round(p.Z * RsQuantumInv));
            if (canonIndex.TryGetValue(k, out var i)) return i;
            i = canonPos.Count; canonPos.Add(p); canonIndex[k] = i;
            return i;
        }

        // ── build faces ──────────────────────────────────────────────
        // NoPos-stippled polygons are retail portal-opening fillers (doors,
        // windows): invisible geometry that exactly covers each opening.
        // They are excluded from regions/materials/triCount and instead used
        // as authoritative hole descriptions (see portalFaces below).
        var faces = new List<RsFace>();
        var portalFaces = new List<RsFace>();
        int facesWithPos = 0, facesWithNeg = 0, triStored = 0, triEffective = 0;
        var bbMin = new V3d(double.MaxValue, double.MaxValue, double.MaxValue);
        var bbMax = new V3d(double.MinValue, double.MinValue, double.MinValue);

        foreach (var kv in gfx.Polygons.OrderBy(k => k.Key)) {
            var poly = kv.Value;
            if (poly.VertexIds == null || poly.VertexIds.Count < 3) continue;
            bool isPortal = (poly.Stippling & StipplingType.NoPos) != 0;

            var rawIds = new List<ushort>();
            var rawPos = new List<V3d>();
            var vnSum = V3d.Zero;
            bool bad = false;
            foreach (short sv in poly.VertexIds) {
                if (sv < 0 || !gfx.VertexArray.Vertices.TryGetValue((ushort)sv, out var v) || v == null) { bad = true; break; }
                rawIds.Add((ushort)sv);
                rawPos.Add(new V3d(v.Origin.X, v.Origin.Y, v.Origin.Z));
                vnSum += new V3d(v.Normal.X, v.Normal.Y, v.Normal.Z);
            }
            if (bad) { warnings.Add($"0x{gfxId:X8} poly {kv.Key}: unresolvable vertex id; skipped."); continue; }

            bool hasPos = poly.PosSurface >= 0 && poly.PosSurface < gfx.Surfaces.Count;
            bool hasNeg = poly.NegSurface >= 0 && poly.NegSurface < gfx.Surfaces.Count;
            if (!isPortal) {
                if (hasPos) facesWithPos++;
                if (hasNeg) facesWithNeg++;
                if (!hasPos && !hasNeg) { warnings.Add($"0x{gfxId:X8} poly {kv.Key}: no valid surface index; skipped."); continue; }
            }

            // canonical corners, cyclic consecutive-dup removal
            var cids = new List<int>();
            foreach (var p in rawPos) {
                int c = Canon(p);
                if (cids.Count == 0 || cids[^1] != c) cids.Add(c);
            }
            while (cids.Count > 1 && cids[0] == cids[^1]) cids.RemoveAt(cids.Count - 1);

            if (!isPortal) {
                foreach (var p in rawPos) {
                    bbMin = new V3d(Math.Min(bbMin.X, p.X), Math.Min(bbMin.Y, p.Y), Math.Min(bbMin.Z, p.Z));
                    bbMax = new V3d(Math.Max(bbMax.X, p.X), Math.Max(bbMax.Y, p.Y), Math.Max(bbMax.Z, p.Z));
                }
                triStored += rawPos.Count - 2;
                triEffective += (rawPos.Count - 2) * ((hasPos ? 1 : 0) + (hasNeg ? 1 : 0));
            }

            if (cids.Count < 3) continue; // degenerate after quantization: counted, not regioned

            // Newell normal from stored winding
            var n = V3d.Zero;
            for (int i = 0; i < rawPos.Count; i++) {
                var a = rawPos[i]; var b = rawPos[(i + 1) % rawPos.Count];
                n = new V3d(n.X + (a.Y - b.Y) * (a.Z + b.Z),
                            n.Y + (a.Z - b.Z) * (a.X + b.X),
                            n.Z + (a.X - b.X) * (a.Y + b.Y));
            }
            double area = n.Len() * 0.5;
            var un = n.Norm();
            // orient outward using the stored vertex normals (positive-side convention)
            if (vnSum.Len() > 1e-9 && un.Dot(vnSum) < 0) un = -un;
            bool reversed = !isPortal && !hasPos; // material only on the negative side → outward is the back
            if (reversed) un = -un;

            var centroid = V3d.Zero;
            foreach (var p in rawPos) centroid += p;
            centroid *= 1.0 / rawPos.Count;

            var face = new RsFace {
                Key = kv.Key, Poly = poly,
                RawIds = rawIds.ToArray(), RawPos = rawPos.ToArray(), Corners = cids.ToArray(),
                Normal = un, D = un.Dot(centroid), Area = area, Centroid = centroid,
                MaterialDid = isPortal ? 0 : gfx.Surfaces[hasPos ? poly.PosSurface : poly.NegSurface],
                DoubleSided = hasPos && hasNeg, Reversed = reversed,
            };
            if (isPortal) portalFaces.Add(face); else faces.Add(face);
        }

        var diagV = bbMax - bbMin;
        double diag = faces.Count > 0 ? diagV.Len() : 0;
        double dTol = Math.Max(1e-6, 1e-3 * diag);
        double groundEps = Math.Max(1e-3, 1e-4 * diag);

        // ── edge → faces map (unordered canonical vertex pair) ──────
        var edgeFaces = new Dictionary<long, List<int>>();
        static long EKey(int a, int b) => a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
        for (int fi = 0; fi < faces.Count; fi++) {
            var c = faces[fi].Corners;
            for (int i = 0; i < c.Length; i++) {
                int a = c[i], b = c[(i + 1) % c.Length];
                if (a == b) continue;
                var k = EKey(a, b);
                if (!edgeFaces.TryGetValue(k, out var l)) edgeFaces[k] = l = new List<int>();
                l.Add(fi);
            }
        }

        // ── region growth: same material + coplanar + edge-connected ─
        int nRegions = 0;
        for (int seed = 0; seed < faces.Count; seed++) {
            if (faces[seed].Region >= 0) continue;
            int rid = nRegions++;
            var stack = new Stack<int>();
            stack.Push(seed); faces[seed].Region = rid;
            while (stack.Count > 0) {
                var f = faces[stack.Pop()];
                var c = f.Corners;
                for (int i = 0; i < c.Length; i++) {
                    int a = c[i], b = c[(i + 1) % c.Length];
                    if (a == b) continue;
                    foreach (var gi in edgeFaces[EKey(a, b)]) {
                        var g = faces[gi];
                        if (g.Region >= 0 || g.MaterialDid != f.MaterialDid) continue;
                        if (f.Normal.Dot(g.Normal) <= RsNormalDotMin) continue;
                        if (Math.Abs(f.D - g.D) >= dTol) continue;
                        g.Region = rid; stack.Push(gi);
                    }
                }
            }
        }
        var regionFaces = new List<int>[nRegions];
        for (int r = 0; r < nRegions; r++) regionFaces[r] = new List<int>();
        for (int fi = 0; fi < faces.Count; fi++) regionFaces[faces[fi].Region].Add(fi);

        // order regions by area desc for stable, artist-friendly ids
        var regionOrder = Enumerable.Range(0, nRegions)
            .OrderByDescending(r => regionFaces[r].Sum(fi => faces[fi].Area))
            .ThenBy(r => regionFaces[r].Min(fi => faces[fi].Key))
            .ToArray();
        var regionName = new string[nRegions];
        for (int i = 0; i < regionOrder.Length; i++) regionName[regionOrder[i]] = $"R{i}";

        // ── region planes + vertex sets (pass A) ────────────────────
        var regionNormal = new V3d[nRegions];
        var regionD = new double[nRegions];
        var regionVertSet = new HashSet<int>[nRegions];
        for (int r = 0; r < nRegions; r++) {
            var fl = regionFaces[r];
            var n = V3d.Zero;
            foreach (var fi in fl) n += faces[fi].Normal * faces[fi].Area;
            n = n.Norm();
            if (n.Len() < 0.5) n = faces[fl[0]].Normal;
            regionNormal[r] = n;
            var verts = new HashSet<int>();
            foreach (var fi in fl) foreach (var c in faces[fi].Corners) verts.Add(c);
            regionVertSet[r] = verts;
            double d = 0;
            foreach (var v in verts) d += n.Dot(canonPos[v]);
            regionD[r] = d / Math.Max(1, verts.Count);
        }

        // attach each portal-opening filler poly to the coplanar region it
        // shares the most vertices with (openings are cut into exactly one
        // region's face fan; T-junction meshes make them invisible to pure
        // border-loop chaining, so the filler is the authoritative hole)
        var regionPortals = new List<RsFace>[nRegions];
        for (int r = 0; r < nRegions; r++) regionPortals[r] = new List<RsFace>();
        var openings = new List<object>();
        foreach (var pf in portalFaces) {
            int bestR = -1, bestShared = 1;
            for (int r = 0; r < nRegions; r++) {
                if (Math.Abs(pf.Normal.Dot(regionNormal[r])) <= RsNormalDotMin) continue;
                if (Math.Abs(regionNormal[r].Dot(pf.Centroid) - regionD[r]) >= dTol) continue;
                int shared = pf.Corners.Count(c => regionVertSet[r].Contains(c));
                if (shared > bestShared) { bestShared = shared; bestR = r; }
            }
            if (bestR >= 0) regionPortals[bestR].Add(pf);
            openings.Add(new Dictionary<string, object?> {
                ["poly"] = pf.Key,
                ["corners"] = pf.RawPos.Select(p => p.Arr()).ToList(),
                ["attachedRegion"] = bestR >= 0 ? $"@{bestR}" : null, // patched to R-name below
            });
        }

        // ── per-region summaries (pass B) ────────────────────────────
        var regionJson = new Dictionary<int, Dictionary<string, object?>>();
        int loopsFailedCount = 0;
        for (int r = 0; r < nRegions; r++) {
            var fl = regionFaces[r];
            double areaSum = fl.Sum(fi => faces[fi].Area);
            var n = regionNormal[r];
            double d = regionD[r];
            var regionVerts = regionVertSet[r];
            double planarity = 0, minZ = double.MaxValue;
            foreach (var v in regionVerts) {
                planarity = Math.Max(planarity, Math.Abs(n.Dot(canonPos[v]) - d));
                minZ = Math.Min(minZ, canonPos[v].Z);
            }

            // basis: in-plane "up" preferred so walls read as (horizontal, vertical)
            V3d ua, va;
            var zAxis = new V3d(0, 0, 1);
            if (Math.Abs(n.Z) < 0.99) {
                va = (zAxis - n * n.Dot(zAxis)).Norm();
                ua = va.Cross(n); // ua × va = n
            }
            else {
                var xAxis = new V3d(1, 0, 0);
                ua = (xAxis - n * n.Dot(xAxis)).Norm();
                va = n.Cross(ua);
            }
            var centroid = V3d.Zero;
            foreach (var v in regionVerts) centroid += canonPos[v];
            centroid *= 1.0 / Math.Max(1, regionVerts.Count);
            var origin = centroid - n * (n.Dot(centroid) - d); // projected onto plane

            // border loops
            var loops = RsChainLoops(fl, faces, edgeFaces, canonPos, out bool loopsFailed);
            if (loopsFailed) loopsFailedCount++;

            object? outer = null;
            var holes = new List<object>();
            var holeCidSets = new List<HashSet<int>>();
            List<double[]> Project(IEnumerable<int> cids) => cids.Select(cid => {
                var q = canonPos[cid] - origin;
                return new[] { q.Dot(ua), q.Dot(va) };
            }).ToList();
            static double SignedArea(List<double[]> pts) {
                double s = 0;
                for (int i = 0; i < pts.Count; i++) {
                    var p0 = pts[i]; var p1 = pts[(i + 1) % pts.Count];
                    s += p0[0] * p1[1] - p1[0] * p0[1];
                }
                return s * 0.5;
            }
            if (!loopsFailed && loops != null && loops.Count > 0) {
                var projected = loops.Select(loop => Project(loop)).ToList();
                int outerIdx = 0; double best = -1;
                var sa = new double[projected.Count];
                for (int i = 0; i < projected.Count; i++) {
                    sa[i] = SignedArea(projected[i]);
                    if (Math.Abs(sa[i]) > best) { best = Math.Abs(sa[i]); outerIdx = i; }
                }
                for (int i = 0; i < projected.Count; i++) {
                    bool wantCcw = i == outerIdx;
                    if ((sa[i] > 0) != wantCcw) { projected[i].Reverse(); loops[i].Reverse(); }
                    var coords = projected[i].Select(p => new[] { RsR(p[0]), RsR(p[1]) }).ToList();
                    if (i == outerIdx) outer = coords;
                    else {
                        double holeMinZ = loops[i].Min(cid => canonPos[cid].Z);
                        holes.Add(new Dictionary<string, object?> {
                            ["loop"] = coords,
                            ["touchesGround"] = holeMinZ <= minZ + groundEps,
                        });
                        holeCidSets.Add(new HashSet<int>(loops[i]));
                    }
                }
            }

            // portal-opening fillers attached to this region become holes,
            // unless an interior border loop already describes the same opening
            foreach (var pf in regionPortals[r]) {
                if (holeCidSets.Any(hs => pf.Corners.Count(c => hs.Contains(c)) >= 2)) continue;
                var proj = Project(pf.Corners);
                if (SignedArea(proj) > 0) proj.Reverse(); // holes wind CW
                double holeMinZ = pf.Corners.Min(cid => canonPos[cid].Z);
                holes.Add(new Dictionary<string, object?> {
                    ["loop"] = proj.Select(p => new[] { RsR(p[0]), RsR(p[1]) }).ToList(),
                    ["touchesGround"] = holeMinZ <= minZ + groundEps,
                    ["fromPortal"] = true,
                });
            }

            // UV affine fit (2D basis fit → composed to 3D, so M·n = 0 by construction)
            var uvMap = RsFitUv(fl, faces, gfx, origin, ua, va, warnings, gfxId);

            var entry = new Dictionary<string, object?> {
                ["id"] = regionName[r],
                ["material"] = $"surface_0x{faces[fl[0]].MaterialDid:X8}",
                ["doubleSided"] = fl.All(fi => faces[fi].DoubleSided),
                ["plane"] = new Dictionary<string, object?> { ["n"] = n.Arr(), ["d"] = RsR(d) },
                ["planarity"] = RsR(planarity),
                ["faces"] = fl.Select(fi => faces[fi].Key).OrderBy(k => k).ToList(),
                ["area"] = RsR(areaSum),
                ["basis"] = new Dictionary<string, object?> {
                    ["origin"] = origin.Arr(), ["uAxis"] = ua.Arr(), ["vAxis"] = va.Arr(),
                },
                ["outer"] = outer,
                ["holes"] = holes,
                ["uvMap"] = uvMap,
            };
            if (loopsFailed) entry["loopsFailed"] = true;
            regionJson[r] = entry;
        }

        // ── adjacency ────────────────────────────────────────────────
        // key: (regionA, regionB) → aggregated over all shared border edges
        var adjAgg = new Dictionary<(int, int), (double len, double angleLen, double convexLen, double concaveLen, double coplanarLen)>();
        foreach (var kv in edgeFaces) {
            if (kv.Value.Count != 2) continue; // non-manifold or boundary edges don't classify
            int fa = kv.Value[0], fb = kv.Value[1];
            int ra = faces[fa].Region, rb = faces[fb].Region;
            if (ra == rb) continue;
            int a = (int)(kv.Key >> 32), b = (int)(kv.Key & 0xFFFFFFFF);
            double len = (canonPos[a] - canonPos[b]).Len();
            if (len <= 1e-9) continue;
            var nA = regionNormal[ra]; var nB = regionNormal[rb];
            double dot = Math.Clamp(nA.Dot(nB), -1, 1);
            double angle = Math.Acos(dot) * 180.0 / Math.PI;
            var mid = (canonPos[a] + canonPos[b]) * 0.5;
            double side = nA.Dot(faces[fb].Centroid - mid);
            var key = ra < rb ? (ra, rb) : (rb, ra);
            adjAgg.TryGetValue(key, out var agg);
            agg.len += len; agg.angleLen += angle * len;
            if (angle < 1.0) agg.coplanarLen += len;
            else if (side < 0) agg.convexLen += len;
            else agg.concaveLen += len;
            adjAgg[key] = agg;
        }
        var adjacency = new List<object>();
        foreach (var kv in adjAgg.OrderBy(k => regionName[k.Key.Item1]).ThenBy(k => regionName[k.Key.Item2])) {
            var agg = kv.Value;
            if (agg.len <= RsMinEdgeLen) continue;
            string cls = agg.coplanarLen >= agg.convexLen && agg.coplanarLen >= agg.concaveLen ? "coplanar"
                : agg.convexLen >= agg.concaveLen ? "convex" : "concave";
            adjacency.Add(new object[] {
                regionName[kv.Key.Item1], regionName[kv.Key.Item2], cls,
                RsR(agg.angleLen / agg.len), RsR(agg.len),
            });
        }

        // ── physics vs render polygon comparison ────────────────────
        string PolySig(Polygon poly) {
            var ids = new List<int>();
            foreach (short sv in poly.VertexIds) {
                if (sv < 0 || !gfx.VertexArray.Vertices.TryGetValue((ushort)sv, out var v) || v == null) return "?";
                ids.Add(Canon(new V3d(v.Origin.X, v.Origin.Y, v.Origin.Z)));
            }
            ids.Sort();
            return string.Join(",", ids.Distinct());
        }
        static Dictionary<string, int> Multiset(IEnumerable<Polygon> polys, Func<Polygon, string> sig) {
            var m = new Dictionary<string, int>();
            foreach (var p in polys) { var s = sig(p); m[s] = m.GetValueOrDefault(s) + 1; }
            return m;
        }
        int renderPolyCount = gfx.Polygons.Count;
        int physicsPolyCount = gfx.PhysicsPolygons?.Count ?? 0;
        bool isCollisionHull = false;
        if (physicsPolyCount > 0) {
            var mr = Multiset(gfx.Polygons.Values, PolySig);
            var mp = Multiset(gfx.PhysicsPolygons!.Values, PolySig);
            isCollisionHull = mr.Count == mp.Count && mr.All(kv => mp.GetValueOrDefault(kv.Key) == kv.Value)
                && !mr.ContainsKey("?") ;
        }

        // ── materials table + thumbnails ─────────────────────────────
        var materialDids = new SortedSet<uint>();
        foreach (var f in faces) {
            materialDids.Add(f.MaterialDid);
            if (f.Poly.NegSurface >= 0 && f.Poly.NegSurface < gfx.Surfaces.Count)
                materialDids.Add(gfx.Surfaces[f.Poly.NegSurface]);
        }
        var materials = new Dictionary<string, object?>();
        foreach (var did in materialDids) {
            allMaterialDids.Add(did);
            if (!materialCache.TryGetValue(did, out var entry)) {
                entry = RsBuildMaterialEntry(did, dats, writer, thumbDirAbs, outDir, maxThumbDim,
                    warnings, ref thumbCount);
                materialCache[did] = entry;
            }
            materials[$"surface_0x{did:X8}"] = entry;
        }

        // ── unstructured heuristic ───────────────────────────────────
        // A mesh defeats the region model when its regions barely merge
        // (organic shells: every face its own plane) or when most borders
        // fail to chain. Small boxy models legitimately have singleton
        // regions, so the merge test only applies at >= 20 faces.
        int mergedFaces = regionFaces.Where(l => l.Count >= 2).Sum(l => l.Count);
        double mergedFrac = faces.Count > 0 ? (double)mergedFaces / faces.Count : 0;
        double loopFailFrac = nRegions > 0 ? (double)loopsFailedCount / nRegions : 0;
        bool unstructured = (faces.Count >= 20 && mergedFrac < 0.3) || (faces.Count >= 4 && loopFailFrac > 0.5);

        // patch opening attachments to final region names
        foreach (Dictionary<string, object?> op in openings) {
            if (op["attachedRegion"] is string s && s.StartsWith('@'))
                op["attachedRegion"] = regionName[int.Parse(s[1..])];
        }

        bool hasDegrade = gfx.DIDDegrade != 0;
        return new Dictionary<string, object?> {
            ["gfxObj"] = $"0x{gfxId:X8}",
            ["triCount"] = triEffective,
            ["facesStored"] = renderPolyCount,
            ["facesEffective"] = facesWithPos + facesWithNeg,
            ["triCountStored"] = triStored,
            ["portalPolyCount"] = portalFaces.Count,
            ["openings"] = openings,
            ["vertCount"] = gfx.VertexArray.Vertices.Count,
            ["uniquePositions"] = canonPos.Count,
            ["bbox"] = faces.Count > 0
                ? new[] { bbMin.Arr(), bbMax.Arr() }
                : null,
            ["flags"] = new Dictionary<string, object?> {
                ["value"] = $"0x{(uint)gfx.Flags:X}",
                ["hasPhysics"] = (gfx.Flags & GfxObjFlags.HasPhysics) != 0,
                ["hasDrawing"] = (gfx.Flags & GfxObjFlags.HasDrawing) != 0,
                ["hasDIDDegrade"] = (gfx.Flags & GfxObjFlags.HasDIDDegrade) != 0,
            },
            ["sortCenter"] = new[] { RsR(gfx.SortCenter.X), RsR(gfx.SortCenter.Y), RsR(gfx.SortCenter.Z) },
            ["didDegrade"] = hasDegrade ? $"0x{gfx.DIDDegrade:X8}" : null,
            ["isCollisionHull"] = isCollisionHull,
            ["physicsPolyCount"] = physicsPolyCount,
            ["renderPolyCount"] = renderPolyCount,
            ["materials"] = materials,
            ["regionCount"] = nRegions,
            ["regions"] = regionOrder.Select(r => regionJson[r]).ToList(),
            ["adjacency"] = adjacency,
            ["unstructured"] = unstructured,
        };
    }

    // Border edges (used exactly once inside the region) chained into closed
    // loops of canonical vertex ids. Returns null + loopsFailed on non-manifold
    // borders (vertex degree != 2, dead ends, unconsumed edges).
    static List<List<int>>? RsChainLoops(List<int> regionFaceIdx, List<RsFace> faces,
        Dictionary<long, List<int>> edgeFaces, List<V3d> canonPos, out bool loopsFailed) {
        loopsFailed = false;
        var inRegion = new HashSet<int>(regionFaceIdx);
        var edgeUse = new Dictionary<long, int>();
        static long EKey(int a, int b) => a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
        foreach (var fi in regionFaceIdx) {
            var c = faces[fi].Corners;
            for (int i = 0; i < c.Length; i++) {
                int a = c[i], b = c[(i + 1) % c.Length];
                if (a == b) continue;
                var k = EKey(a, b);
                edgeUse[k] = edgeUse.GetValueOrDefault(k) + 1;
            }
        }
        var border = edgeUse.Where(kv => kv.Value == 1).Select(kv => kv.Key).ToList();
        if (border.Count == 0) { loopsFailed = true; return null; }

        var adj = new Dictionary<int, List<int>>();
        foreach (var k in border) {
            int a = (int)(k >> 32), b = (int)(k & 0xFFFFFFFF);
            if (!adj.TryGetValue(a, out var la)) adj[a] = la = new List<int>();
            if (!adj.TryGetValue(b, out var lb)) adj[b] = lb = new List<int>();
            la.Add(b); lb.Add(a);
        }
        if (adj.Values.Any(l => l.Count != 2)) { loopsFailed = true; return null; }

        var visited = new HashSet<long>();
        var loops = new List<List<int>>();
        foreach (var k in border) {
            if (visited.Contains(k)) continue;
            int start = (int)(k >> 32), prev = start, cur = (int)(k & 0xFFFFFFFF);
            visited.Add(k);
            var loop = new List<int> { start, cur };
            while (cur != start) {
                var nbrs = adj[cur];
                int next = nbrs[0] == prev ? nbrs[1] : nbrs[0];
                var ek = EKey(cur, next);
                if (visited.Contains(ek)) { loopsFailed = true; return null; }
                visited.Add(ek);
                prev = cur; cur = next;
                if (cur != start) loop.Add(cur);
                if (loop.Count > border.Count + 1) { loopsFailed = true; return null; }
            }
            if (loop.Count < 3) { loopsFailed = true; return null; }
            loops.Add(loop);
        }
        if (visited.Count != border.Count) { loopsFailed = true; return null; }
        return loops;
    }

    // Least-squares affine fit of the region's first-UV channel against
    // position, solved in the 2D plane basis (so the gradient along the
    // plane normal is zero by construction), then composed back to 3D:
    // uv = M·p + c with M·n = 0.
    static Dictionary<string, object?>? RsFitUv(List<int> regionFaceIdx, List<RsFace> faces,
        GfxObj gfx, V3d origin, V3d ua, V3d va, List<string> warnings, uint gfxId) {
        var samples = new List<(double q1, double q2, double u, double v, V3d p)>();
        foreach (var fi in regionFaceIdx) {
            var f = faces[fi];
            var uvList = f.Reversed ? f.Poly.NegUVIndices : f.Poly.PosUVIndices;
            for (int i = 0; i < f.RawIds.Length; i++) {
                if (!gfx.VertexArray.Vertices.TryGetValue(f.RawIds[i], out var vert) || vert == null) continue;
                if (vert.UVs == null || vert.UVs.Count == 0) continue;
                int uvIdx = (uvList != null && i < uvList.Count) ? uvList[i] : 0;
                if (uvIdx >= vert.UVs.Count) uvIdx = 0;
                var p = f.RawPos[i];
                var q = p - origin;
                samples.Add((q.Dot(ua), q.Dot(va), vert.UVs[uvIdx].U, vert.UVs[uvIdx].V, p));
            }
        }
        if (samples.Count < 3) return null;

        static double[]? Solve3(double[,] A, double[] y) {
            // gaussian elimination with partial pivoting on 3x3
            var m = new double[3, 4];
            for (int i = 0; i < 3; i++) { for (int j = 0; j < 3; j++) m[i, j] = A[i, j]; m[i, 3] = y[i]; }
            for (int col = 0; col < 3; col++) {
                int piv = col;
                for (int r2 = col + 1; r2 < 3; r2++) if (Math.Abs(m[r2, col]) > Math.Abs(m[piv, col])) piv = r2;
                if (Math.Abs(m[piv, col]) < 1e-12) return null;
                if (piv != col) for (int j = 0; j < 4; j++) (m[col, j], m[piv, j]) = (m[piv, j], m[col, j]);
                for (int r2 = 0; r2 < 3; r2++) {
                    if (r2 == col) continue;
                    double fq = m[r2, col] / m[col, col];
                    for (int j = 0; j < 4; j++) m[r2, j] -= fq * m[col, j];
                }
            }
            return new[] { m[0, 3] / m[0, 0], m[1, 3] / m[1, 1], m[2, 3] / m[2, 2] };
        }

        var xtx = new double[3, 3];
        var xtu = new double[3];
        var xtv = new double[3];
        foreach (var s in samples) {
            var row = new[] { s.q1, s.q2, 1.0 };
            for (int i = 0; i < 3; i++) {
                for (int j = 0; j < 3; j++) xtx[i, j] += row[i] * row[j];
                xtu[i] += row[i] * s.u;
                xtv[i] += row[i] * s.v;
            }
        }
        var cu = Solve3(xtx, xtu);
        var cv = Solve3(xtx, xtv);
        if (cu == null || cv == null) return null; // collinear samples — no honest fit

        // compose to 3D: uv_row(p) = a*(ua·(p-o)) + b*(va·(p-o)) + c
        V3d mu = ua * cu[0] + va * cu[1];
        V3d mv = ua * cv[0] + va * cv[1];
        double ku = cu[2] - mu.Dot(origin);
        double kv2 = cv[2] - mv.Dot(origin);

        double residual = 0;
        foreach (var s in samples) {
            residual = Math.Max(residual, Math.Abs(mu.Dot(s.p) + ku - s.u));
            residual = Math.Max(residual, Math.Abs(mv.Dot(s.p) + kv2 - s.v));
        }

        static string Affine(string lhs, V3d m, double c) {
            var terms = new List<string>();
            var axes = new[] { ("x", m.X), ("y", m.Y), ("z", m.Z) };
            foreach (var (name, coef) in axes) {
                if (RsR(coef) == 0) continue;
                terms.Add(terms.Count == 0
                    ? $"{RsR(coef).ToString(System.Globalization.CultureInfo.InvariantCulture)}*{name}"
                    : (coef >= 0 ? $"+ {RsR(coef).ToString(System.Globalization.CultureInfo.InvariantCulture)}*{name}"
                                 : $"- {RsR(-coef).ToString(System.Globalization.CultureInfo.InvariantCulture)}*{name}"));
            }
            if (Math.Abs(c) >= 1e-7 || terms.Count == 0)
                terms.Add(terms.Count == 0
                    ? RsR(c).ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : (c >= 0 ? $"+ {RsR(c).ToString(System.Globalization.CultureInfo.InvariantCulture)}"
                              : $"- {RsR(-c).ToString(System.Globalization.CultureInfo.InvariantCulture)}"));
            return $"{lhs} = {string.Join(" ", terms)}";
        }

        return new Dictionary<string, object?> {
            ["u"] = Affine("u", mu, ku),
            ["v"] = Affine("v", mv, kv2),
            ["M"] = new[] { mu.Arr(), mv.Arr() },
            ["c"] = new[] { RsR(ku), RsR(kv2) },
            ["residual"] = RsR(residual),
            ["samples"] = samples.Count,
        };
    }

    // Material entry: surface metadata + a downscaled PNG thumbnail decoded
    // through the existing RenderSurfaceExtensions path (no new decoder).
    Dictionary<string, object?> RsBuildMaterialEntry(uint surfaceDid,
        WorldBuilder.Shared.Lib.IDatReaderWriter dats, DatEasyWriter? writer,
        string? thumbDirAbs, string outDir, int maxThumbDim,
        List<string> warnings, ref int thumbCount) {

        var entry = new Dictionary<string, object?> {
            ["surfaceFlags"] = null, ["origTextureId"] = null, ["renderSurfaceId"] = null,
            ["width"] = null, ["height"] = null, ["format"] = null,
            ["thumbnail"] = null,
            ["translucency"] = null, ["luminosity"] = null, ["diffuse"] = null,
        };
        if (!dats.TryGet<Surface>(surfaceDid, out var surf) || surf == null) {
            entry["thumbnailReason"] = "surface-not-found";
            warnings.Add($"Surface 0x{surfaceDid:X8} not found in DATs.");
            return entry;
        }
        entry["surfaceFlags"] = $"0x{(uint)surf.Type:X8}";
        entry["surfaceFlagNames"] = surf.Type.ToString();
        entry["translucency"] = RsR(surf.Translucency);
        entry["luminosity"] = RsR(surf.Luminosity);
        entry["diffuse"] = RsR(surf.Diffuse);

        if (surf.OrigTextureId == 0) {
            entry["colorValue"] = $"0x{surf.ColorValue:X8}";
            entry["thumbnailReason"] = "solid-color";
            return entry;
        }
        entry["origTextureId"] = $"0x{surf.OrigTextureId:X8}";

        if (!dats.TryGet<SurfaceTexture>(surf.OrigTextureId, out var st) || st == null
            || st.Textures == null || st.Textures.Count == 0) {
            entry["thumbnailReason"] = "surfacetexture-not-found";
            return entry;
        }
        // Textures[] holds resolution variants of the same art; take the last
        // (retail picks by clip-map scale; last is the conventional full-res pick).
        uint rsId = st.Textures[^1];
        entry["renderSurfaceId"] = $"0x{rsId:X8}";

        if (!dats.TryGet<RenderSurface>(rsId, out var rs) || rs == null) {
            entry["thumbnailReason"] = "rendersurface-not-found";
            return entry;
        }
        entry["width"] = rs.Width;
        entry["height"] = rs.Height;
        entry["format"] = rs.Format.ToString();

        if (writer == null || thumbDirAbs == null) return entry; // thumbnails disabled

        bool paletted = rs.Format == PixelFormat.PFID_P8 || rs.Format == PixelFormat.PFID_INDEX16;
        if (paletted && rs.DefaultPaletteId == 0) {
            entry["thumbnailReason"] = "paletted-no-default-palette";
            return entry;
        }
        var thumbPath = Path.Combine(thumbDirAbs, $"surface_0x{surfaceDid:X8}.png");
        try {
            bool clipMap = (surf.Type & SurfaceType.Base1ClipMap) != 0;
            var saved = rs.SaveToImageFile(thumbPath, writer, clipMap);
            if (!saved.Success) {
                entry["thumbnailReason"] = paletted ? "paletted-no-default-palette" : (saved.Error ?? "decode-failed");
                return entry;
            }
            using (var img = SixLabors.ImageSharp.Image.Load(thumbPath)) {
                if (Math.Max(img.Width, img.Height) > maxThumbDim) {
                    img.Mutate(x => x.Resize(new ResizeOptions {
                        Mode = ResizeMode.Max,
                        Size = new SixLabors.ImageSharp.Size(maxThumbDim, maxThumbDim),
                    }));
                    img.Save(thumbPath);
                }
            }
            entry["thumbnail"] = Path.GetRelativePath(outDir, thumbPath).Replace('\\', '/');
            thumbCount++;
        }
        catch (Exception ex) {
            entry["thumbnailReason"] = paletted ? "paletted-no-default-palette" : ex.Message;
            if (File.Exists(thumbPath)) { try { File.Delete(thumbPath); } catch { /* best effort */ } }
        }
        return entry;
    }
}
