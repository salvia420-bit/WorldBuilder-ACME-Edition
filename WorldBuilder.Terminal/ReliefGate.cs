using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace WorldBuilder.Terminal;

// ═════════════════════════════════════════════════════════════════════
//  ReliefGate — validation gate for relief-plan-apply.
//
//  C# port of the trial's selfcheck2.py (18 checks, same semantics),
//  generalized: the point-in-solid test is built from the ORIGINAL
//  mesh triangles via ray parity (openings closed with the summary's
//  portal-filler quads, majority vote over several ray directions so
//  the retail T-junction mesh cannot flip a single ray), and the
//  "border on original surface" test accepts any summary region plane
//  or the model's ground plane.
// ═════════════════════════════════════════════════════════════════════

public sealed record GateCheck(string Name, bool Pass, string Detail, double? Value = null, double? Limit = null);

public sealed class ReliefObjModel {
    public byte[] Bytes = Array.Empty<byte>();
    public List<RVec3> V = new();
    public List<RVec3> Vn = new();
    public List<RVec2> Vt = new();
    // faces: material, corner triplets (v,vt,vn — 1-based; 0 = missing)
    public List<(string Mat, (int V, int Vt, int Vn)[] C)> F = new();
    public List<string> MaterialOrder = new();

    public static ReliefObjModel Parse(byte[] bytes) {
        var m = new ReliefObjModel { Bytes = bytes };
        string? cur = null;
        foreach (var raw in Encoding.UTF8.GetString(bytes).Split('\n')) {
            var p = raw.TrimEnd('\r').Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (p.Length == 0) continue;
            switch (p[0]) {
                case "v": m.V.Add(new RVec3(D(p[1]), D(p[2]), D(p[3]))); break;
                case "vn": m.Vn.Add(new RVec3(D(p[1]), D(p[2]), D(p[3]))); break;
                case "vt": m.Vt.Add(new RVec2(D(p[1]), D(p[2]))); break;
                case "usemtl":
                    cur = p[1];
                    if (!m.MaterialOrder.Contains(cur)) m.MaterialOrder.Add(cur);
                    break;
                case "f":
                    var corners = new (int, int, int)[p.Length - 1];
                    for (int i = 1; i < p.Length; i++) {
                        var t = p[i].Split('/');
                        corners[i - 1] = (
                            t.Length > 0 && t[0] != "" ? int.Parse(t[0], CultureInfo.InvariantCulture) : 0,
                            t.Length > 1 && t[1] != "" ? int.Parse(t[1], CultureInfo.InvariantCulture) : 0,
                            t.Length > 2 && t[2] != "" ? int.Parse(t[2], CultureInfo.InvariantCulture) : 0);
                    }
                    m.F.Add((cur ?? "", corners));
                    break;
            }
        }
        return m;

        static double D(string s) => double.Parse(s, CultureInfo.InvariantCulture);
    }
}

public static class ReliefObjWriter {
    public static string Fmt(double x) {
        var s = Math.Round(x, 6).ToString("0.######", CultureInfo.InvariantCulture);
        return s == "-0" ? "0" : s;
    }

    /// <summary>Stable material-grouped order (first-appearance) — the exact order Append
    /// writes faces in, so gate metadata stays aligned with the parsed file's face order.</summary>
    public static List<ReliefTri> GroupOrder(List<ReliefTri> tris) {
        var matOrder = new List<string>();
        foreach (var t in tris) if (!matOrder.Contains(t.Material)) matOrder.Add(t.Material);
        var outList = new List<ReliefTri>(tris.Count);
        foreach (var m in matOrder) outList.AddRange(tris.Where(t => t.Material == m));
        return outList;
    }

    /// <summary>Append the generated tris after the original bytes — original file bytes are
    /// preserved verbatim as an exact prefix; additions reopen existing usemtl groups.</summary>
    public static byte[] Append(byte[] orig, ReliefObjModel origModel, List<ReliefTri> tris, string planName) {
        var sb = new StringBuilder();
        if (orig.Length > 0 && orig[^1] != (byte)'\n') sb.Append('\n');
        sb.Append($"# --- relief-plan-apply ({planName}): {tris.Count} triangles appended; all original v/vt/vn/f above are untouched\n");
        int bv = origModel.V.Count, bt = origModel.Vt.Count, bn = origModel.Vn.Count;
        var vL = new List<string>(); var nL = new List<string>(); var tL = new List<string>();
        var groups = new Dictionary<string, List<string>>();
        var matOrder = new List<string>();
        foreach (var tri in tris) {
            var ids = new int[3];
            for (int k = 0; k < 3; k++) {
                vL.Add($"v {Fmt(tri.P[k].X)} {Fmt(tri.P[k].Y)} {Fmt(tri.P[k].Z)}");
                nL.Add($"vn {Fmt(tri.Vn.X)} {Fmt(tri.Vn.Y)} {Fmt(tri.Vn.Z)}");
                tL.Add($"vt {Fmt(tri.Uv[k].X)} {Fmt(tri.Uv[k].Y)}");
                ids[k] = vL.Count; // same running index for v/vt/vn (per-corner flat layout)
            }
            if (!groups.TryGetValue(tri.Material, out var g)) {
                g = new List<string>(); groups[tri.Material] = g; matOrder.Add(tri.Material);
            }
            g.Add($"f {bv + ids[0]}/{bt + ids[0]}/{bn + ids[0]} " +
                  $"{bv + ids[1]}/{bt + ids[1]}/{bn + ids[1]} " +
                  $"{bv + ids[2]}/{bt + ids[2]}/{bn + ids[2]}");
        }
        foreach (var l in vL) sb.Append(l).Append('\n');
        foreach (var l in nL) sb.Append(l).Append('\n');
        foreach (var l in tL) sb.Append(l).Append('\n');
        foreach (var mat in matOrder) {
            sb.Append("usemtl ").Append(mat).Append('\n');
            foreach (var l in groups[mat]) sb.Append(l).Append('\n');
        }
        var tail = Encoding.UTF8.GetBytes(sb.ToString());
        var outBytes = new byte[orig.Length + tail.Length];
        Buffer.BlockCopy(orig, 0, outBytes, 0, orig.Length);
        Buffer.BlockCopy(tail, 0, outBytes, orig.Length, tail.Length);
        return outBytes;
    }
}

public static class ReliefGate {
    const int VertexCap = 32767;

    public static List<GateCheck> Run(byte[] origBytes, byte[] outBytes,
            ReliefSummary sum, ReliefPlan plan, List<ReliefTri> meta) {
        var checks = new List<GateCheck>();
        var orig = ReliefObjModel.Parse(origBytes);
        var full = ReliefObjModel.Parse(outBytes);
        var newF = full.F.Skip(orig.F.Count).ToList();

        // 1 ── prefix identity
        bool prefix = outBytes.Length >= origBytes.Length && outBytes.AsSpan(0, origBytes.Length).SequenceEqual(origBytes);
        checks.Add(new GateCheck("prefix-identity", prefix,
            $"original {origBytes.Length} bytes preserved as an exact prefix; {outBytes.Length - origBytes.Length} bytes appended"));

        // 2 ── index ranges
        bool idxOk = newF.All(f => f.C.All(c =>
            c.V >= 1 && c.V <= full.V.Count && c.Vt >= 1 && c.Vt <= full.Vt.Count && c.Vn >= 1 && c.Vn <= full.Vn.Count));
        checks.Add(new GateCheck("index-ranges", idxOk,
            $"v={full.V.Count} vt={full.Vt.Count} vn={full.Vn.Count}; all new face indices in range: {idxOk}"));
        if (!idxOk) return checks; // everything below dereferences indices

        // 3 ── full triplets, finite values
        bool trip = newF.All(f => f.C.Length == 3 && f.C.All(c => c.V > 0 && c.Vt > 0 && c.Vn > 0));
        bool finite = full.V.All(Fin3) && full.Vn.All(Fin3) &&
                      full.Vt.All(t => double.IsFinite(t.X) && double.IsFinite(t.Y));
        checks.Add(new GateCheck("full-triplets-finite", trip && finite,
            $"triangles with full v/vt/vn triplets: {trip}; all coordinates finite: {finite}"));

        // 4 ── faces only under pre-existing usemtl groups
        var origMats = orig.F.Select(f => f.Mat).ToHashSet();
        var newMats = newF.Select(f => f.Mat).Distinct().ToList();
        bool matOk = newMats.All(m => origMats.Contains(m));
        checks.Add(new GateCheck("faces-under-existing-usemtl", matOk,
            $"new-face materials: {string.Join(" + ", newMats)}; all pre-existing: {matOk}"));

        // 5 ── vertex budget
        var uniq = new HashSet<(long, long, long, long, long, long, long, long)>();
        foreach (var f in full.F)
            foreach (var c in f.C)
                uniq.Add((K(full.V[c.V - 1].X), K(full.V[c.V - 1].Y), K(full.V[c.V - 1].Z),
                          K(full.Vn[c.Vn - 1].X), K(full.Vn[c.Vn - 1].Y), K(full.Vn[c.Vn - 1].Z),
                          K(full.Vt[c.Vt - 1].X), K(full.Vt[c.Vt - 1].Y)));
        checks.Add(new GateCheck("vertex-budget", uniq.Count < VertexCap,
            $"{uniq.Count} unique (pos,normal,uv) vertices, cap {VertexCap}", uniq.Count, VertexCap));

        // geometry accessors for the new faces
        RVec3[] Pos(int fi) => newF[fi].C.Select(c => full.V[c.V - 1]).ToArray();
        RVec2[] Uv(int fi) => newF[fi].C.Select(c => full.Vt[c.Vt - 1]).ToArray();

        // 6 ── degenerate triangles
        double minArea = double.MaxValue, maxArea = 0;
        for (int i = 0; i < newF.Count; i++) {
            var P = Pos(i);
            double a = 0.5 * (P[1] - P[0]).Cross(P[2] - P[0]).Len();
            minArea = Math.Min(minArea, a); maxArea = Math.Max(maxArea, a);
        }
        checks.Add(new GateCheck("no-degenerate-tris", newF.Count > 0 && minArea > 1e-6,
            $"smallest new tri {minArea:0.######} sq-units, largest {maxArea:0.###}", minArea, 1e-6));

        // 7 ── emitted vn agrees with right-hand winding
        int mism = 0;
        for (int i = 0; i < newF.Count; i++) {
            var P = Pos(i);
            var g = (P[1] - P[0]).Cross(P[2] - P[0]).Norm();
            foreach (var c in newF[i].C)
                if (g.Dot(full.Vn[c.Vn - 1]) < 0.9999) mism++;
        }
        checks.Add(new GateCheck("normals-match-winding", mism == 0,
            $"{mism} corner normals disagree with face winding", mism, 0));

        // ── point-in-solid oracle from the ORIGINAL mesh + portal-filler quads ──
        var solidTris = new List<RVec3[]>();
        foreach (var f in orig.F)
            solidTris.Add(f.C.Select(c => orig.V[c.V - 1]).ToArray());
        foreach (var op in sum.Openings) {
            if (op.Corners.Length < 3) continue;
            for (int k = 2; k < op.Corners.Length; k++)
                solidTris.Add(new[] { op.Corners[0], op.Corners[k - 1], op.Corners[k] });
        }
        var rayDirs = new[] {
            new RVec3(0.2338, 0.5671, 0.8127).Norm(), new RVec3(-0.4123, 0.3319, 0.8471).Norm(),
            new RVec3(0.7753, -0.2231, 0.5907).Norm(), new RVec3(-0.6519, -0.4373, 0.6199).Norm(),
            new RVec3(0.1487, 0.9121, 0.3833).Norm(),
        };
        bool Inside(RVec3 p) {
            int odd = 0;
            foreach (var d in rayDirs) {
                int hits = 0;
                foreach (var t in solidTris)
                    if (RayTri(p, d, t)) hits++;
                if ((hits & 1) == 1) odd++;
            }
            return odd * 2 > rayDirs.Length;
        }

        // 8 ── every new face looks out of the original solid
        var inward = new List<string>();
        for (int i = 0; i < newF.Count; i++) {
            var P = Pos(i);
            var g = (P[1] - P[0]).Cross(P[2] - P[0]).Norm();
            var cen = (P[0] + P[1] + P[2]) * (1.0 / 3.0);
            if (Inside(cen + g * 0.02)) inward.Add(i < meta.Count ? meta[i].Tag : $"tri{i}");
        }
        checks.Add(new GateCheck("outward-facing", inward.Count == 0,
            inward.Count == 0 ? $"all {newF.Count} new faces look out of the original solid (ray-parity oracle, {solidTris.Count} tris incl. portal fillers)"
                              : $"{inward.Count} inward faces: {string.Join(", ", inward.Take(6))}", inward.Count, 0));

        // 9 ── no new vertex buried inside the original solid
        var newVerts = new List<RVec3>();
        foreach (var f in newF) foreach (var c in f.C) newVerts.Add(full.V[c.V - 1]);
        var buried = new List<RVec3>();
        foreach (var p in newVerts.DistinctBy(p => (K(p.X), K(p.Y), K(p.Z)))) {
            double dSurf = solidTris.Min(t => PointTriDist(p, t));
            if (dSurf < 1e-4) continue; // on the original surface
            if (Inside(p)) buried.Add(p);
        }
        checks.Add(new GateCheck("no-vertex-inside-solid", buried.Count == 0,
            buried.Count == 0 ? "all new vertices lie on or outside the original surface"
                              : $"{buried.Count} buried vertices, first at ({Fm(buried[0].X)}, {Fm(buried[0].Y)}, {Fm(buried[0].Z)})",
            buried.Count, 0));

        // ── added-shell edge map ──
        var edges = new Dictionary<((long, long, long), (long, long, long)), List<int>>();
        for (int i = 0; i < newF.Count; i++) {
            var P = Pos(i);
            for (int a = 0; a < 3; a++) {
                var k0 = K3(P[a]); var k1 = K3(P[(a + 1) % 3]);
                var key = k0.CompareTo(k1) <= 0 ? (k0, k1) : (k1, k0);
                if (!edges.TryGetValue(key, out var l)) edges[key] = l = new List<int>();
                l.Add(i);
            }
        }

        // 10 ── edge-manifold
        var nonMan = edges.Where(e => e.Value.Count > 2).ToList();
        checks.Add(new GateCheck("added-shell-edge-manifold", nonMan.Count == 0,
            $"{edges.Count} edges; {nonMan.Count} shared by >2 added faces", nonMan.Count, 0));

        // 11 ── open border edges lie on original surface planes (or the ground line)
        var border = edges.Where(e => e.Value.Count == 1).Select(e => e.Key).ToList();
        double worstBorder = 0; int badBorder = 0;
        foreach (var (k0, k1) in border) {
            foreach (var k in new[] { k0, k1 }) {
                var p = UnK3(k);
                double best = Math.Abs(p.Z - sum.BboxMin.Z);
                foreach (var r in sum.Regions.Values)
                    best = Math.Min(best, Math.Abs(r.N.Dot(p) - r.D));
                worstBorder = Math.Max(worstBorder, best);
                if (best > 5e-4) badBorder++;
            }
        }
        checks.Add(new GateCheck("borders-on-original-surface", badBorder == 0,
            $"{border.Count} border edges; worst endpoint distance to an original plane {worstBorder:0.######}; {badBorder} endpoints off-surface",
            worstBorder, 5e-4));

        // 12 ── no self-overlap within a feature (exact coplanar-pair clip)
        int overlaps = 0; string ovDetail = "";
        for (int i = 0; i < newF.Count && i < meta.Count; i++) {
            for (int j = i + 1; j < newF.Count && j < meta.Count; j++) {
                if (meta[i].Feature != meta[j].Feature) continue;
                var Pi = Pos(i); var Pj = Pos(j);
                var ni = (Pi[1] - Pi[0]).Cross(Pi[2] - Pi[0]).Norm();
                var nj = (Pj[1] - Pj[0]).Cross(Pj[2] - Pj[0]).Norm();
                if (Math.Abs(ni.Dot(nj)) < 0.99999) continue;
                if (Math.Abs(ni.Dot(Pj[0] - Pi[0])) > 1e-6) continue;
                double area = CoplanarTriOverlap(Pi, Pj, ni);
                if (area > 1e-6) {
                    overlaps++;
                    if (ovDetail == "") ovDetail = $"first: {meta[i].Tag} × {meta[j].Tag} area {area:0.####}";
                }
            }
        }
        checks.Add(new GateCheck("no-feature-self-overlap", overlaps == 0,
            overlaps == 0 ? "no coplanar overlap between faces of the same feature" : $"{overlaps} overlapping coplanar pairs; {ovDetail}",
            overlaps, 0));

        // 13 ── UV fold-seam continuity (same-projection-axis seams must be exact)
        char AxisOf(int fi) => ParentAxis(Pos(fi), Uv(fi));
        double worstSame = 0, worstCorner = 0; int sameSeams = 0, cornerSeams = 0;
        foreach (var kv in edges) {
            if (kv.Value.Count != 2) continue;
            int f1 = kv.Value[0], f2 = kv.Value[1];
            if (newF[f1].Mat != newF[f2].Mat) continue;
            // shared positions → uv of each face at those positions
            var uv1 = new Dictionary<(long, long, long), RVec2>();
            var P1 = Pos(f1); var U1 = Uv(f1);
            for (int a = 0; a < 3; a++) uv1[K3(P1[a])] = U1[a];
            var P2 = Pos(f2); var U2 = Uv(f2);
            double w = 0; int shared = 0;
            for (int a = 0; a < 3; a++)
                if (uv1.TryGetValue(K3(P2[a]), out var u)) {
                    w = Math.Max(w, Math.Max(Math.Abs(u.X - U2[a].X), Math.Abs(u.Y - U2[a].Y)));
                    shared++;
                }
            if (shared < 2) continue;
            if (AxisOf(f1) == AxisOf(f2)) { sameSeams++; worstSame = Math.Max(worstSame, w); }
            else { cornerSeams++; worstCorner = Math.Max(worstCorner, w); }
        }
        checks.Add(new GateCheck("uv-fold-seam-continuity", worstSame <= 1.5e-6,
            $"{sameSeams} same-projection seams, worst delta {worstSame:0.0e0}; {cornerSeams} corner seams (projection axis flips, like retail corners), worst du {worstCorner:0.###}",
            worstSame, 1.5e-6));

        // 14 ── UV registration: projection faces vs parent map + co-located original verts
        double worstReg = 0; string regDetail = "";
        for (int i = 0; i < newF.Count && i < meta.Count; i++) {
            if (meta[i].UvMode != "proj") continue;
            if (!sum.Regions.TryGetValue(meta[i].ParentRegion, out var reg)) continue;
            var P = Pos(i); var U = Uv(i);
            for (int a = 0; a < 3; a++) {
                var want = reg.Uv(P[a]);
                double dv = Math.Max(Math.Abs(want.X - U[a].X), Math.Abs(want.Y - U[a].Y));
                if (dv > worstReg) { worstReg = dv; regDetail = $"proj face {meta[i].Tag}"; }
            }
        }
        var origUv = new Dictionary<(string, (long, long, long)), List<RVec2>>();
        foreach (var f in orig.F)
            foreach (var c in f.C) {
                var key = (f.Mat, K3(orig.V[c.V - 1]));
                if (!origUv.TryGetValue(key, out var l)) origUv[key] = l = new List<RVec2>();
                l.Add(orig.Vt[c.Vt - 1]);
            }
        int coloc = 0;
        for (int i = 0; i < newF.Count; i++) {
            var P = Pos(i); var U = Uv(i);
            for (int a = 0; a < 3; a++) {
                if (!origUv.TryGetValue((newF[i].Mat, K3(P[a])), out var cands)) continue;
                coloc++;
                double dv = cands.Min(u => Math.Max(Math.Abs(u.X - U[a].X), Math.Abs(u.Y - U[a].Y)));
                if (dv > worstReg) { worstReg = dv; regDetail = $"co-located vert on {(i < meta.Count ? meta[i].Tag : "?")}"; }
            }
        }
        checks.Add(new GateCheck("uv-registration", worstReg <= 0.05,
            $"max deviation vs parent region map {worstReg:0.####} uv ({regDetail}); {coloc} vertices co-located with the original mesh",
            worstReg, 0.05));

        // 15 ── texel density within 15% of the parent region's
        double worstDens = 0; string densDetail = "";
        for (int i = 0; i < newF.Count && i < meta.Count; i++) {
            if (!sum.Regions.TryGetValue(meta[i].ParentRegion, out var reg)) continue;
            var P = Pos(i); var U = Uv(i);
            double a3 = 0.5 * (P[1] - P[0]).Cross(P[2] - P[0]).Len();
            double a2 = Math.Abs(0.5 * ((U[1].X - U[0].X) * (U[2].Y - U[0].Y) - (U[1].Y - U[0].Y) * (U[2].X - U[0].X)));
            if (a3 < 1e-9) continue;
            double dens = Math.Sqrt(a2 / a3), refDens = reg.UvDensity();
            if (refDens < 1e-9) continue;
            double dev = Math.Abs(dens / refDens - 1);
            if (dev > worstDens) { worstDens = dev; densDetail = meta[i].Tag; }
        }
        checks.Add(new GateCheck("texel-density", worstDens <= 0.15,
            $"worst density deviation {worstDens * 100:0.##}% vs parent region ({densDetail})", worstDens, 0.15));

        // 16 ── budget maxOffset: vertex distance from its feature's parent region plane
        double worstOff = 0; string offDetail = "";
        var featPlanes = new Dictionary<int, List<ReliefRegion>>();
        for (int i = 0; i < meta.Count; i++) {
            if (!featPlanes.TryGetValue(meta[i].Feature, out var l)) featPlanes[meta[i].Feature] = l = new List<ReliefRegion>();
            if (sum.Regions.TryGetValue(meta[i].ParentRegion, out var reg) && !l.Contains(reg)) l.Add(reg);
        }
        for (int i = 0; i < newF.Count && i < meta.Count; i++) {
            if (!featPlanes.TryGetValue(meta[i].Feature, out var regsOfFeat) || regsOfFeat.Count == 0) continue;
            foreach (var p in Pos(i)) {
                double d = regsOfFeat.Min(r => Math.Abs(r.N.Dot(p) - r.D));
                if (d > worstOff) { worstOff = d; offDetail = meta[i].Tag; }
            }
        }
        checks.Add(new GateCheck("max-offset", worstOff <= plan.MaxOffset + 1e-6,
            $"max vertex offset from the feature's parent planes {worstOff:0.####} (at {offDetail}), budget {plan.MaxOffset}",
            worstOff, plan.MaxOffset));

        // 17 ── no T-junctions inside the added shell
        var vertSet = newVerts.DistinctBy(p => (K(p.X), K(p.Y), K(p.Z))).ToList();
        int tjunc = 0; string tjDetail = "";
        foreach (var (k0, k1) in edges.Keys) {
            var a = UnK3(k0); var b = UnK3(k1);
            var ab = b - a; double len2 = ab.Dot(ab);
            if (len2 < 1e-12) continue;
            foreach (var p in vertSet) {
                double t = (p - a).Dot(ab) / len2;
                if (t < 1e-4 || t > 1 - 1e-4) continue;
                var q = a + ab * t;
                if ((p - q).Len() < 1e-5) {
                    tjunc++;
                    if (tjDetail == "") tjDetail = $"vertex ({Fm(p.X)}, {Fm(p.Y)}, {Fm(p.Z)}) splits edge ({Fm(a.X)},{Fm(a.Y)},{Fm(a.Z)})→({Fm(b.X)},{Fm(b.Y)},{Fm(b.Z)})";
                    break;
                }
            }
        }
        checks.Add(new GateCheck("no-added-t-junctions", tjunc == 0,
            tjunc == 0 ? "no added vertex lands mid-edge on another added edge" : $"{tjunc} edges T-junctioned; {tjDetail}",
            tjunc, 0));

        // 18 ── tri count within plan budget
        checks.Add(new GateCheck("tri-budget", newF.Count <= plan.MaxTris,
            $"{newF.Count} triangles added ({orig.F.Count} → {full.F.Count}), budget {plan.MaxTris}",
            newF.Count, plan.MaxTris));

        return checks;
    }

    // ── helpers ─────────────────────────────────────────────────────

    static bool Fin3(RVec3 v) => double.IsFinite(v.X) && double.IsFinite(v.Y) && double.IsFinite(v.Z);
    static long K(double v) => (long)Math.Round(v * 1e5);
    static (long, long, long) K3(RVec3 p) => (K(p.X), K(p.Y), K(p.Z));
    static RVec3 UnK3((long, long, long) k) => new(k.Item1 / 1e5, k.Item2 / 1e5, k.Item3 / 1e5);
    static string Fm(double v) => v.ToString("0.####", CultureInfo.InvariantCulture);

    /// <summary>Möller–Trumbore, counting hits with t > eps.</summary>
    static bool RayTri(RVec3 o, RVec3 d, RVec3[] tri) {
        var e1 = tri[1] - tri[0]; var e2 = tri[2] - tri[0];
        var pv = d.Cross(e2);
        double det = e1.Dot(pv);
        if (Math.Abs(det) < 1e-12) return false;
        double inv = 1.0 / det;
        var tv = o - tri[0];
        double u = tv.Dot(pv) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) return false;
        var qv = tv.Cross(e1);
        double v = d.Dot(qv) * inv;
        if (v < -1e-9 || u + v > 1 + 1e-9) return false;
        double t = e2.Dot(qv) * inv;
        return t > 1e-9;
    }

    static double PointTriDist(RVec3 p, RVec3[] tri) {
        // Ericson's closest-point-on-triangle
        var a = tri[0]; var b = tri[1]; var c = tri[2];
        var ab = b - a; var ac = c - a; var ap = p - a;
        double d1 = ab.Dot(ap), d2 = ac.Dot(ap);
        if (d1 <= 0 && d2 <= 0) return (p - a).Len();
        var bp = p - b;
        double d3 = ab.Dot(bp), d4 = ac.Dot(bp);
        if (d3 >= 0 && d4 <= d3) return (p - b).Len();
        double vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return (p - (a + ab * (d1 / (d1 - d3)))).Len();
        var cp = p - c;
        double d5 = ab.Dot(cp), d6 = ac.Dot(cp);
        if (d6 >= 0 && d5 <= d6) return (p - c).Len();
        double vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return (p - (a + ac * (d2 / (d2 - d6)))).Len();
        double va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
            double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            return (p - (b + (c - b) * w)).Len();
        }
        double den = 1.0 / (va + vb + vc);
        var q = a + ab * (vb * den) + ac * (vc * den);
        return (p - q).Len();
    }

    /// <summary>Dominant world axis of the u gradient — same heuristic as selfcheck2.py's
    /// parentmap (x,y components only), used to separate fold seams from corner seams.</summary>
    static char ParentAxis(RVec3[] P, RVec2[] U) {
        var e1 = P[1] - P[0]; var e2 = P[2] - P[0];
        double d1 = U[1].X - U[0].X, d2 = U[2].X - U[0].X;
        double det = e1.X * e2.Y - e1.Y * e2.X;
        if (Math.Abs(det) > 1e-9) {
            double dudx = (d1 * e2.Y - d2 * e1.Y) / det;
            double dudy = (e1.X * d2 - e2.X * d1) / det;
            return Math.Abs(dudx) > Math.Abs(dudy) ? 'x' : 'y';
        }
        return Math.Abs(e1.X) + Math.Abs(e2.X) > Math.Abs(e1.Y) + Math.Abs(e2.Y) ? 'x' : 'y';
    }

    /// <summary>Intersection area of two coplanar triangles (Sutherland–Hodgman in plane 2D).</summary>
    static double CoplanarTriOverlap(RVec3[] A, RVec3[] B, RVec3 n) {
        // build 2D frame on the plane
        var u = (A[1] - A[0]).Norm();
        var v = n.Cross(u).Norm();
        RVec2 To2(RVec3 p) => new((p - A[0]).Dot(u), (p - A[0]).Dot(v));
        var pa = A.Select(To2).ToList();
        var pb = B.Select(To2).ToList();
        if (SignedArea(pa) < 0) pa.Reverse();
        if (SignedArea(pb) < 0) pb.Reverse();
        var poly = pa;
        for (int i = 0; i < 3 && poly.Count > 0; i++) {
            var c0 = pb[i]; var c1 = pb[(i + 1) % 3];
            var next = new List<RVec2>();
            for (int j = 0; j < poly.Count; j++) {
                var s = poly[j]; var e = poly[(j + 1) % poly.Count];
                double ds = Side(c0, c1, s), de = Side(c0, c1, e);
                if (ds >= 0) next.Add(s);
                if ((ds > 0 && de < 0) || (ds < 0 && de > 0)) {
                    double t = ds / (ds - de);
                    next.Add(s + (e - s) * t);
                }
            }
            poly = next;
        }
        return poly.Count < 3 ? 0 : Math.Abs(SignedArea(poly));

        static double Side(RVec2 a, RVec2 b, RVec2 p) => (b.X - a.X) * (p.Y - a.Y) - (b.Y - a.Y) * (p.X - a.X);
        static double SignedArea(List<RVec2> p) {
            double s = 0;
            for (int i = 0; i < p.Count; i++) { var a = p[i]; var b = p[(i + 1) % p.Count]; s += a.X * b.Y - a.Y * b.X; }
            return 0.5 * s;
        }
    }
}
