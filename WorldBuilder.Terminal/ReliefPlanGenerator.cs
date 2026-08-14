using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WorldBuilder.Terminal;

// ═════════════════════════════════════════════════════════════════════
//  relief-plan-apply — deterministic relief-plan generator.
//
//  Consumes a gfxobj-region-summary JSON plus a declarative "relief
//  plan" (authored by an artist model) and emits validated additive
//  render geometry appended to the model's obj-export OBJ. The artist
//  model never emits raw geometry; this generator owns all vertex /
//  UV / winding / split bookkeeping. Geometry + UV logic is a faithful
//  generalization of the hand-built trial (scratchpad gen.py):
//    · faces coplanar-extended from a parent region evaluate the
//      region's fitted uvMap after projecting the query point onto the
//      region plane (u = M·p' + c);
//    · RETURN faces (ledges / reveals / soffits / caps) are UNFOLDED
//      about the hinge edge they share with their parent face, so the
//      texture continues across the fold with zero seam;
//    · every band segment is split at the coordinates of adjacent band
//      ends so no added edge T-junctions against a neighbour.
// ═════════════════════════════════════════════════════════════════════

// ── plan / summary data model ────────────────────────────────────────

public readonly record struct RVec3(double X, double Y, double Z) {
    public static RVec3 operator +(RVec3 a, RVec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static RVec3 operator -(RVec3 a, RVec3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public static RVec3 operator *(RVec3 a, double s) => new(a.X * s, a.Y * s, a.Z * s);
    public static RVec3 operator -(RVec3 a) => new(-a.X, -a.Y, -a.Z);
    public double Dot(RVec3 o) => X * o.X + Y * o.Y + Z * o.Z;
    public RVec3 Cross(RVec3 o) => new(Y * o.Z - Z * o.Y, Z * o.X - X * o.Z, X * o.Y - Y * o.X);
    public double Len() => Math.Sqrt(Dot(this));
    public RVec3 Norm() { var l = Len(); return l > 1e-12 ? this * (1.0 / l) : new RVec3(0, 0, 0); }
}

public readonly record struct RVec2(double X, double Y) {
    public static RVec2 operator +(RVec2 a, RVec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static RVec2 operator -(RVec2 a, RVec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static RVec2 operator *(RVec2 a, double s) => new(a.X * s, a.Y * s);
    public double Dot(RVec2 o) => X * o.X + Y * o.Y;
    public double Len() => Math.Sqrt(Dot(this));
    public RVec2 Norm() { var l = Len(); return l > 1e-12 ? this * (1.0 / l) : new RVec2(0, 0); }
}

public sealed class ReliefRegion {
    public string Id = "";
    public string Material = "";
    public RVec3 N;            // plane normal, n·p = D
    public double D;
    public RVec3 Origin, UAxis, VAxis;
    public List<RVec2> Outer = new();
    public List<(List<RVec2> Loop, bool TouchesGround)> Holes = new();
    public double[][] M = { new double[3], new double[3] }; // uv = M·p + C
    public double[] C = new double[2];
    public double Residual;
    public bool LoopsFailed;   // summary could not extract boundary loops for this region

    public RVec3 World(RVec2 uv) => Origin + UAxis * uv.X + VAxis * uv.Y;

    /// <summary>Project p onto the region plane, then evaluate the fitted affine uv map.</summary>
    public RVec2 Uv(RVec3 p) {
        var q = p - N * (N.Dot(p) - D);
        return new RVec2(
            M[0][0] * q.X + M[0][1] * q.Y + M[0][2] * q.Z + C[0],
            M[1][0] * q.X + M[1][1] * q.Y + M[1][2] * q.Z + C[1]);
    }

    /// <summary>UV area scale of the fitted map restricted to the plane (texel density).</summary>
    public double UvDensity() {
        RVec2 mu = new(
            M[0][0] * UAxis.X + M[0][1] * UAxis.Y + M[0][2] * UAxis.Z,
            M[1][0] * UAxis.X + M[1][1] * UAxis.Y + M[1][2] * UAxis.Z);
        RVec2 mv = new(
            M[0][0] * VAxis.X + M[0][1] * VAxis.Y + M[0][2] * VAxis.Z,
            M[1][0] * VAxis.X + M[1][1] * VAxis.Y + M[1][2] * VAxis.Z);
        return Math.Sqrt(Math.Abs(mu.X * mv.Y - mu.Y * mv.X));
    }
}

public sealed class ReliefOpening {
    public int Poly;
    public RVec3[] Corners = Array.Empty<RVec3>();
    public string AttachedRegion = "";
}

public sealed class ReliefSummary {
    public string GfxObjHex = "";
    public uint GfxObjId;
    public RVec3 BboxMin, BboxMax;
    public List<ReliefOpening> Openings = new();
    public Dictionary<string, ReliefRegion> Regions = new();
    public List<string> Materials = new();
    public int PhysicsPolyCount, RenderPolyCount;
    public bool Unstructured;

    public static ReliefSummary Parse(string path) {
        var node = JsonNode.Parse(File.ReadAllText(path))
            ?? throw new InvalidDataException("summary JSON is empty");
        var s = new ReliefSummary();
        s.GfxObjHex = node["gfxObj"]?.GetValue<string>()
            ?? throw new InvalidDataException("summary has no top-level 'gfxObj' — multi-model summaries are not supported by relief-plan-apply v1");
        s.GfxObjId = Convert.ToUInt32(s.GfxObjHex.Replace("0x", ""), 16);
        var bb = node["bbox"]!.AsArray();
        s.BboxMin = V3(bb[0]!); s.BboxMax = V3(bb[1]!);
        s.PhysicsPolyCount = node["physicsPolyCount"]?.GetValue<int>() ?? 0;
        s.RenderPolyCount = node["renderPolyCount"]?.GetValue<int>() ?? 0;
        s.Unstructured = node["unstructured"]?.GetValue<bool>() ?? false;
        foreach (var o in node["openings"]?.AsArray() ?? new JsonArray()) {
            var op = new ReliefOpening {
                Poly = o!["poly"]?.GetValue<int>() ?? 0,
                AttachedRegion = o["attachedRegion"]?.GetValue<string>() ?? "",
                Corners = o["corners"]!.AsArray().Select(c => V3(c!)).ToArray()
            };
            s.Openings.Add(op);
        }
        foreach (var kv in node["materials"]?.AsObject() ?? new JsonObject())
            s.Materials.Add(kv.Key);
        foreach (var r in node["regions"]?.AsArray() ?? new JsonArray()) {
            var reg = new ReliefRegion {
                Id = r!["id"]!.GetValue<string>(),
                Material = r["material"]!.GetValue<string>(),
                N = V3(r["plane"]!["n"]!),
                D = r["plane"]!["d"]!.GetValue<double>(),
                Origin = V3(r["basis"]!["origin"]!),
                UAxis = V3(r["basis"]!["uAxis"]!),
                VAxis = V3(r["basis"]!["vAxis"]!),
                Residual = r["uvMap"]?["residual"]?.GetValue<double>() ?? double.MaxValue,
                LoopsFailed = r["loopsFailed"]?.GetValue<bool>() ?? false,
            };
            foreach (var p in r["outer"]?.AsArray() ?? new JsonArray())
                reg.Outer.Add(new RVec2(p![0]!.GetValue<double>(), p[1]!.GetValue<double>()));
            if (reg.Outer.Count == 0) reg.LoopsFailed = true;
            foreach (var h in r["holes"]?.AsArray() ?? new JsonArray()) {
                var loop = h!["loop"]!.AsArray()
                    .Select(p => new RVec2(p![0]!.GetValue<double>(), p[1]!.GetValue<double>())).ToList();
                reg.Holes.Add((loop, h["touchesGround"]?.GetValue<bool>() ?? false));
            }
            var mj = r["uvMap"]?["M"]?.AsArray();
            var cj = r["uvMap"]?["c"]?.AsArray();
            if (mj != null && cj != null) {
                for (int i = 0; i < 2; i++)
                    for (int j = 0; j < 3; j++)
                        reg.M[i][j] = mj[i]![j]!.GetValue<double>();
                reg.C[0] = cj[0]!.GetValue<double>(); reg.C[1] = cj[1]!.GetValue<double>();
            }
            s.Regions[reg.Id] = reg;
        }
        return s;

        static RVec3 V3(JsonNode n) {
            var a = n.AsArray();
            return new RVec3(a[0]!.GetValue<double>(), a[1]!.GetValue<double>(), a[2]!.GetValue<double>());
        }
    }
}

public sealed class ReliefFeature {
    public string Op = "";
    public List<string> Regions = new();
    public double Proud, Height, Band;
    public int Opening = -1;
    public bool Reveal = true;
    public bool BreakAtGroundHoles = true;
    public double[] ZRange = Array.Empty<double>();
    public string Material = "inherit";
}

public sealed class ReliefPlan {
    public string GfxObjHex = "";
    public List<ReliefFeature> Features = new();
    public int MaxTris = 200;
    public double MaxOffset = 0.25;

    public static ReliefPlan Parse(string path) {
        var node = JsonNode.Parse(File.ReadAllText(path))
            ?? throw new InvalidDataException("plan JSON is empty");
        var p = new ReliefPlan {
            GfxObjHex = node["gfxObj"]?.GetValue<string>()
                ?? throw new InvalidDataException("plan has no 'gfxObj'"),
        };
        if (node["budget"] is JsonNode b) {
            p.MaxTris = b["maxTris"]?.GetValue<int>() ?? p.MaxTris;
            p.MaxOffset = b["maxOffset"]?.GetValue<double>() ?? p.MaxOffset;
        }
        foreach (var f in node["features"]?.AsArray() ?? new JsonArray()) {
            var ft = new ReliefFeature { Op = f!["op"]?.GetValue<string>() ?? "" };
            foreach (var r in f["regions"]?.AsArray() ?? new JsonArray())
                ft.Regions.Add(r!.GetValue<string>());
            ft.Proud = f["proud"]?.GetValue<double>() ?? 0;
            ft.Height = f["height"]?.GetValue<double>() ?? 0;
            ft.Band = f["band"]?.GetValue<double>() ?? 0;
            ft.Opening = f["opening"]?.GetValue<int>() ?? -1;
            ft.Reveal = f["reveal"]?.GetValue<bool>() ?? true;
            ft.BreakAtGroundHoles = f["breakAtGroundHoles"]?.GetValue<bool>() ?? true;
            ft.Material = f["material"]?.GetValue<string>() ?? "inherit";
            if (f["zRange"] is JsonArray za)
                ft.ZRange = za.Select(z => z!.GetValue<double>()).ToArray();
            p.Features.Add(ft);
        }
        return p;
    }
}

/// <summary>One diagnostic the artist model uses to repair its plan.</summary>
public sealed record ReliefPlanError(int Feature, string Op, string Code, string Message, object? Data = null);

public sealed class ReliefTri {
    public string Material = "";
    public RVec3[] P = new RVec3[3];
    public RVec2[] Uv = new RVec2[3];
    public RVec3 Vn;               // emitted normal == geometric normal after winding fix
    public string Tag = "";
    public int Feature;
    public string UvMode = "proj"; // "proj" | "unfold"
    public string ParentRegion = "";
}

// ── generator ────────────────────────────────────────────────────────

public sealed class ReliefPlanGenerator {
    const double ResidualMax = 0.01;   // refuse UV-space authoring beyond this fit error
    const double GroundEps = 1e-4;     // "vertex sits on the ground line" tolerance
    const double ChainEps = 5e-4;      // endpoint matching tolerance when chaining segments
    const double SurroundGap = 0.05;   // clearance between a plinth break and a door surround

    public readonly List<ReliefTri> Tris = new();
    public readonly List<ReliefPlanError> Errors = new();
    public readonly List<string> Warnings = new();

    readonly ReliefSummary _sum;
    readonly ReliefPlan _plan;
    int _fi;

    public ReliefPlanGenerator(ReliefSummary sum, ReliefPlan plan) { _sum = sum; _plan = plan; }

    public bool Run() {
        for (_fi = 0; _fi < _plan.Features.Count; _fi++) {
            var f = _plan.Features[_fi];
            switch (f.Op) {
                case "plinth": OpPlinth(f); break;
                case "opening_surround": OpOpeningSurround(f); break;
                case "belt_course": OpBeltCourse(f); break;
                default:
                    Err("unknown-op", $"op '{f.Op}' is not in the registry",
                        new { knownOps = new[] { "plinth", "opening_surround", "belt_course" } });
                    break;
            }
        }
        return Errors.Count == 0;
    }

    void Err(string code, string msg, object? data = null) =>
        Errors.Add(new ReliefPlanError(_fi, _fi < _plan.Features.Count ? _plan.Features[_fi].Op : "?", code, msg, data));

    // ── shared emission ─────────────────────────────────────────────

    /// <summary>Quad → two tris; intended CCW seen from outside; winding auto-fixed against n.</summary>
    void Quad(string mat, string parentRegion, string uvMode,
              RVec3 a, RVec3 b, RVec3 c, RVec3 d, Func<RVec3, RVec2> uvf, RVec3 intendedN, string tag) {
        foreach (var tri in new[] { new[] { a, b, c }, new[] { a, c, d } }) {
            var g = (tri[1] - tri[0]).Cross(tri[2] - tri[0]);
            if (g.Len() < 1e-9) { Err("degenerate-quad", $"degenerate triangle in {tag}"); return; }
            var gn = g.Norm();
            var t = tri;
            if (gn.Dot(intendedN) < 0) { t = new[] { tri[0], tri[2], tri[1] }; gn = -gn; }
            Tris.Add(new ReliefTri {
                Material = mat, P = t, Uv = t.Select(uvf).ToArray(), Vn = gn,
                Tag = tag, Feature = _fi, UvMode = uvMode, ParentRegion = parentRegion,
            });
        }
    }

    /// <summary>
    /// Unfold UV: a return face rotated flat about the hinge edge it shares with its parent
    /// face continues the parent's UV axis: virtual point = hinge foot + w · (distance from
    /// hinge), evaluated through the parent region's projected uv map. On the hinge itself
    /// the virtual point equals the real point, so the fold seam is exactly continuous.
    /// </summary>
    static Func<RVec3, RVec2> UnfoldUv(ReliefRegion reg, RVec3 h0, RVec3 hingeDir, RVec3 w) {
        var hd = hingeDir.Norm();
        var wn = w.Norm();
        return q => {
            var rel = q - h0;
            double t = rel.Dot(hd);
            var perp = rel - hd * t;
            var pv = h0 + hd * t + wn * perp.Len();
            return reg.Uv(pv);
        };
    }

    bool ResolveRegions(ReliefFeature f, out List<ReliefRegion> regs) {
        regs = new List<ReliefRegion>();
        foreach (var id in f.Regions) {
            if (!_sum.Regions.TryGetValue(id, out var r)) {
                Err("unknown-region", $"region '{id}' not in summary",
                    new { availableRegions = _sum.Regions.Keys.ToArray() });
                return false;
            }
            if (r.LoopsFailed) {
                Err("loops-failed", $"region '{id}' has no usable boundary loops (summary flagged loopsFailed); relief ops are refused on it",
                    new { region = id });
                return false;
            }
            if (r.Residual > ResidualMax) {
                Err("uv-residual", $"region '{id}' uvMap residual {r.Residual} > {ResidualMax}; UV-space authoring is unsafe here",
                    new { region = id, residual = r.Residual, limit = ResidualMax });
                return false;
            }
            regs.Add(r);
        }
        return true;
    }

    string MatFor(ReliefFeature f, ReliefRegion reg) {
        if (f.Material == "inherit") return reg.Material;
        if (!_sum.Materials.Contains(f.Material)) {
            Err("unknown-material", $"material '{f.Material}' not among the model's usemtl groups",
                new { availableMaterials = _sum.Materials });
            return reg.Material;
        }
        return f.Material;
    }

    // ── segment chaining (shared by plinth & belt) ──────────────────

    sealed class Seg {
        public RVec2 A, B;        // oriented so outward normal = (dir.y, -dir.x)
        public RVec2 N2;          // outward horizontal normal
        public ReliefRegion Region = null!;
        public RVec2 OffA, OffB;  // offset (proud) endpoints after mitring
        public bool FreeA, FreeB; // no neighbour at this end
    }

    static long Q(double v) => (long)Math.Round(v / ChainEps);
    static (long, long) QK(RVec2 p) => (Q(p.X), Q(p.Y));

    /// <summary>Chain oriented 2D segments end→start; mitre offset corners; mark free ends.
    /// Returns chains (each a list of segs) or null on ambiguity (diag emitted).</summary>
    List<List<Seg>>? ChainSegments(List<Seg> segs, double proud) {
        var byStart = new Dictionary<(long, long), Seg>();
        foreach (var s in segs) {
            var k = QK(s.A);
            if (byStart.ContainsKey(k)) {
                Err("ambiguous-chain", "two band segments start at the same point — self-touching ground circuit; cannot build a simple ring",
                    new { point = new[] { s.A.X, s.A.Y }, regions = segs.Where(x => QK(x.A) == k).Select(x => x.Region.Id).ToArray() });
                return null;
            }
            byStart[k] = s;
        }
        var byEnd = new Dictionary<(long, long), Seg>();
        foreach (var s in segs) {
            var k = QK(s.B);
            if (byEnd.ContainsKey(k)) {
                Err("ambiguous-chain", "two band segments end at the same point — self-touching ground circuit",
                    new { point = new[] { s.B.X, s.B.Y } });
                return null;
            }
            byEnd[k] = s;
        }

        var chains = new List<List<Seg>>();
        var used = new HashSet<Seg>();
        // open chains first (deterministic: start at the lexicographically smallest free start)
        foreach (var s0 in segs.Where(s => !byEnd.ContainsKey(QK(s.A)))
                               .OrderBy(s => QK(s.A))) {
            var chain = new List<Seg>();
            var cur = s0;
            while (cur != null && used.Add(cur)) {
                chain.Add(cur);
                byStart.TryGetValue(QK(cur.B), out cur);
            }
            chains.Add(chain);
        }
        // remaining are rings
        foreach (var s0 in segs.Where(s => !used.Contains(s)).OrderBy(s => QK(s.A))) {
            if (used.Contains(s0)) continue;
            var chain = new List<Seg>();
            var cur = s0;
            while (cur != null && used.Add(cur)) {
                chain.Add(cur);
                byStart.TryGetValue(QK(cur.B), out cur);
            }
            chains.Add(chain);
        }

        // weld endpoints (average) + compute offsets
        foreach (var chain in chains) {
            bool ring = chain.Count > 1 && QK(chain[^1].B) == QK(chain[0].A)
                     || chain.Count == 1 && QK(chain[0].B) == QK(chain[0].A);
            for (int i = 0; i < chain.Count; i++) {
                var s = chain[i];
                var prev = i > 0 ? chain[i - 1] : (ring ? chain[^1] : null);
                var next = i < chain.Count - 1 ? chain[i + 1] : (ring ? chain[0] : null);
                if (prev != null) {
                    var weld = (s.A + prev.B) * 0.5;
                    s.A = weld; prev.B = weld;
                }
                s.FreeA = prev == null; s.FreeB = next == null;
            }
            for (int i = 0; i < chain.Count; i++) {
                var s = chain[i];
                var prev = i > 0 ? chain[i - 1] : (ring ? chain[^1] : null);
                var next = i < chain.Count - 1 ? chain[i + 1] : (ring ? chain[0] : null);
                if (!Offset(s.A, s.N2, prev?.N2, out s.OffA)) return null;
                if (!Offset(s.B, s.N2, next?.N2, out s.OffB)) return null;
            }
        }
        return chains;

        bool Offset(RVec2 p, RVec2 n, RVec2? other, out RVec2 o) {
            if (other is not RVec2 n2) { o = p + n * proud; return true; }
            double den = 1 + n.Dot(n2);
            if (den < 0.1) {
                o = p;
                Err("reflex-corner", "near-180° corner between band segments; mitre undefined",
                    new { point = new[] { p.X, p.Y } });
                return false;
            }
            o = p + (n + n2) * (proud / den);   // exact intersection of the two offset lines
            return true;
        }
    }

    // ── op: plinth ──────────────────────────────────────────────────

    void OpPlinth(ReliefFeature f) {
        if (!ResolveRegions(f, out var regs)) return;
        if (regs.Count == 0) { Err("no-regions", "plinth needs at least one region"); return; }
        double T = f.Proud, H = f.Height;
        if (T <= 0 || H <= 0) { Err("bad-params", "plinth needs proud > 0 and height > 0", new { f.Proud, f.Height }); return; }

        foreach (var r in regs)
            if (Math.Abs(r.N.Z) > 0.2) {
                Err("not-a-wall", $"region '{r.Id}' plane is not vertical (n.z={r.N.Z:0.###}); plinth is only defined on walls",
                    new { region = r.Id, normal = new[] { r.N.X, r.N.Y, r.N.Z } });
                return;
            }

        // ground level = lowest outer-loop vertex over the listed regions
        double zg = double.MaxValue;
        foreach (var r in regs)
            foreach (var p in r.Outer)
                zg = Math.Min(zg, r.World(p).Z);

        // collect ground edges as oriented 2D segments
        var segs = new List<Seg>();
        foreach (var r in regs) {
            var n2 = new RVec2(r.N.X, r.N.Y).Norm();
            var dir = new RVec2(-n2.Y, n2.X);        // outward normal = (dir.y, -dir.x)
            int cnt = r.Outer.Count;
            for (int i = 0; i < cnt; i++) {
                var a3 = r.World(r.Outer[i]);
                var b3 = r.World(r.Outer[(i + 1) % cnt]);
                if (Math.Abs(a3.Z - zg) > GroundEps || Math.Abs(b3.Z - zg) > GroundEps) continue;
                var a = new RVec2(a3.X, a3.Y); var b = new RVec2(b3.X, b3.Y);
                if ((b - a).Len() < 1e-6) continue;
                if ((b - a).Dot(dir) < 0) (a, b) = (b, a);
                segs.Add(new Seg { A = a, B = b, N2 = n2, Region = r });
            }
        }
        if (segs.Count == 0) {
            Err("no-ground-edges", "none of the listed regions has an outer-loop edge at the ground line",
                new { groundZ = zg, regions = f.Regions });
            return;
        }

        // subtract touchesGround openings/holes (widened where a surround will sit)
        if (f.BreakAtGroundHoles) segs = SubtractGroundBreaks(segs, zg);
        if (segs.Count == 0) { Err("all-broken", "every ground edge was consumed by ground-hole breaks"); return; }

        var chains = ChainSegments(segs, T);
        if (chains == null) return;

        int si = 0;
        foreach (var chain in chains) {
            foreach (var s in chain) {
                var mat = MatFor(f, s.Region);
                var n3 = new RVec3(s.N2.X, s.N2.Y, 0);
                RVec3 P(RVec2 p, double z) => new(p.X, p.Y, z);
                double zt = zg + H;

                // outer face — pure projection of the parent wall map
                Quad(mat, s.Region.Id, "proj",
                    P(s.OffA, zg), P(s.OffB, zg), P(s.OffB, zt), P(s.OffA, zt),
                    q => s.Region.Uv(q), n3, $"plinth-face{si}");

                // top ledge — unfolded from the outer face about the shared convex top edge
                var hingeDir = P(s.OffB, zt) - P(s.OffA, zt);
                var ledgeUv = UnfoldUv(s.Region, P(s.OffA, zt), hingeDir, new RVec3(0, 0, 1));
                Quad(mat, s.Region.Id, "unfold",
                    P(s.OffA, zt), P(s.OffB, zt), P(s.B, zt), P(s.A, zt),
                    ledgeUv, new RVec3(0, 0, 1), $"plinth-ledge{si}");

                // end caps at breaks — unfolded from the outer face about the outer vertical edge
                var d2 = (s.B - s.A).Norm();
                if (s.FreeA) EmitCap(s, mat, s.A, s.OffA, new RVec2(-d2.X, -d2.Y), zg, zt, $"plinth-capA{si}");
                if (s.FreeB) EmitCap(s, mat, s.B, s.OffB, d2, zg, zt, $"plinth-capB{si}");
                si++;
            }
        }

        void EmitCap(Seg s, string mat, RVec2 corner, RVec2 ocorner, RVec2 outDir, double z0, double z1, string tag) {
            RVec3 C0 = new(corner.X, corner.Y, z0), C1 = new(corner.X, corner.Y, z1);
            RVec3 O0 = new(ocorner.X, ocorner.Y, z0), O1 = new(ocorner.X, ocorner.Y, z1);
            var uv = UnfoldUv(s.Region, O0, new RVec3(0, 0, 1), new RVec3(outDir.X, outDir.Y, 0));
            Quad(mat, s.Region.Id, "unfold", C0, O0, O1, C1, uv, new RVec3(outDir.X, outDir.Y, 0), tag);
        }
    }

    /// <summary>Clip ground segments against touchesGround openings/holes on their region's
    /// wall line; breaks under a planned opening_surround are widened by band + gap.</summary>
    List<Seg> SubtractGroundBreaks(List<Seg> segs, double zg) {
        // break intervals per region: (region, tMin, tMax) along the wall-line direction
        var breaks = new List<(string Region, double T0, double T1)>();
        for (int oi = 0; oi < _sum.Openings.Count; oi++) {
            var op = _sum.Openings[oi];
            double zLo = op.Corners.Min(c => c.Z);
            if (Math.Abs(zLo - zg) > 1e-3) continue;                       // not a ground opening
            if (!_sum.Regions.TryGetValue(op.AttachedRegion, out var reg)) continue;
            var n2 = new RVec2(reg.N.X, reg.N.Y).Norm();
            var dir = new RVec2(-n2.Y, n2.X);
            double t0 = double.MaxValue, t1 = double.MinValue;
            foreach (var c in op.Corners) {
                double t = new RVec2(c.X, c.Y).Dot(dir);
                t0 = Math.Min(t0, t); t1 = Math.Max(t1, t);
            }
            double widen = 0;
            foreach (var g in _plan.Features)
                if (g.Op == "opening_surround" && g.Opening == oi)
                    widen = Math.Max(widen, g.Band + SurroundGap);
            breaks.Add((op.AttachedRegion, t0 - widen, t1 + widen));
        }
        foreach (var kv in _sum.Regions) {                                  // holes not in openings
            foreach (var (loop, tg) in kv.Value.Holes) {
                if (!tg) continue;
                var reg = kv.Value;
                var n2 = new RVec2(reg.N.X, reg.N.Y).Norm();
                var dir = new RVec2(-n2.Y, n2.X);
                double t0 = double.MaxValue, t1 = double.MinValue;
                foreach (var p in loop) {
                    var w = reg.World(p);
                    double t = new RVec2(w.X, w.Y).Dot(dir);
                    t0 = Math.Min(t0, t); t1 = Math.Max(t1, t);
                }
                double widen = 0;
                for (int oi = 0; oi < _sum.Openings.Count; oi++) {
                    var op = _sum.Openings[oi];
                    if (op.AttachedRegion != kv.Key) continue;
                    double ot0 = double.MaxValue, ot1 = double.MinValue;
                    foreach (var c in op.Corners) {
                        double t = new RVec2(c.X, c.Y).Dot(dir);
                        ot0 = Math.Min(ot0, t); ot1 = Math.Max(ot1, t);
                    }
                    if (ot0 > t1 || ot1 < t0) continue;                     // no overlap
                    foreach (var g in _plan.Features)
                        if (g.Op == "opening_surround" && g.Opening == oi)
                            widen = Math.Max(widen, g.Band + SurroundGap);
                }
                breaks.Add((kv.Key, t0 - widen, t1 + widen));
            }
        }
        if (breaks.Count == 0) return segs;

        var outSegs = new List<Seg>();
        foreach (var s in segs) {
            var dir = (s.B - s.A).Norm();
            double ta = s.A.Dot(dir), tb = s.B.Dot(dir);
            var intervals = new List<(double, double)> { (ta, tb) };
            foreach (var (regId, b0, b1) in breaks) {
                if (regId != s.Region.Id) continue;
                var next = new List<(double, double)>();
                foreach (var (i0, i1) in intervals) {
                    if (b1 <= i0 + 1e-9 || b0 >= i1 - 1e-9) { next.Add((i0, i1)); continue; }
                    if (b0 > i0 + 1e-6) next.Add((i0, b0));
                    if (b1 < i1 - 1e-6) next.Add((b1, i1));
                }
                intervals = next;
            }
            foreach (var (i0, i1) in intervals) {
                if (i1 - i0 < 1e-4) continue;
                outSegs.Add(new Seg {
                    A = s.A + dir * (i0 - ta), B = s.A + dir * (i1 - ta),
                    N2 = s.N2, Region = s.Region
                });
            }
        }
        return outSegs;
    }

    // ── op: opening_surround ────────────────────────────────────────

    void OpOpeningSurround(ReliefFeature f) {
        if (f.Opening < 0 || f.Opening >= _sum.Openings.Count) {
            Err("bad-opening-index", $"opening index {f.Opening} out of range; the summary has {_sum.Openings.Count} openings (0..{_sum.Openings.Count - 1})",
                new { requested = f.Opening, available = _sum.Openings.Select((o, i) => new { index = i, attachedRegion = o.AttachedRegion }).ToArray() });
            return;
        }
        var op = _sum.Openings[f.Opening];
        if (!_sum.Regions.TryGetValue(op.AttachedRegion, out var reg)) {
            Err("unknown-region", $"opening {f.Opening} attached region '{op.AttachedRegion}' missing from summary");
            return;
        }
        if (reg.Residual > ResidualMax) {
            Err("uv-residual", $"attached region '{reg.Id}' uvMap residual {reg.Residual} > {ResidualMax}",
                new { region = reg.Id, residual = reg.Residual, limit = ResidualMax });
            return;
        }
        double W = f.Band, PR = f.Proud;
        if (W <= 0 || PR <= 0) { Err("bad-params", "opening_surround needs band > 0 and proud > 0", new { f.Band, f.Proud }); return; }
        if (op.Corners.Length != 4) { Err("bad-opening", $"opening {f.Opening} is not a quad ({op.Corners.Length} corners)"); return; }

        // require a rectangle with two z levels and horizontal top/bottom edges
        var zsQ = op.Corners.Select(c => Math.Round(c.Z, 4)).Distinct().OrderBy(z => z).ToArray();
        if (zsQ.Length != 2) {
            Err("bad-opening", $"opening {f.Opening} corners span {zsQ.Length} distinct z levels; surround v1 needs an upright rectangle",
                new { zLevels = zsQ });
            return;
        }
        double zLo = zsQ[0], zHi = zsQ[1];
        var lo = op.Corners.Where(c => Math.Abs(c.Z - zLo) < 1e-3).ToArray();
        var hi = op.Corners.Where(c => Math.Abs(c.Z - zHi) < 1e-3).ToArray();
        if (lo.Length != 2 || hi.Length != 2) { Err("bad-opening", "opening corners are not 2+2 across z levels"); return; }

        var e1 = (new RVec3(lo[1].X, lo[1].Y, 0) - new RVec3(lo[0].X, lo[0].Y, 0)).Norm();
        // orient e1 to the wall's chain direction: outward n2 → dir = (-n.y, n.x)
        var n2w = new RVec2(reg.N.X, reg.N.Y).Norm();
        var walk = new RVec3(-n2w.Y, n2w.X, 0);
        if (e1.Dot(walk) < 0) e1 = -e1;

        var origin = lo[0];                                    // param t along e1 from origin
        double span = (lo[1] - lo[0]).Dot(e1);
        if (span < 0) { origin = lo[1]; span = -span; }
        double t0 = 0, t1 = span;
        bool ground = Math.Abs(zLo - _sum.BboxMin.Z) < 1e-3;

        var nOut = reg.N;                                      // wall outward normal
        RVec3 WallPt(double t, double z) => origin + e1 * t + new RVec3(0, 0, z - zLo);
        RVec3 FacePt(double t, double z) => WallPt(t, z) + nOut * PR;

        double TL = t0 - W, TR = t1 + W, ZT = zHi + W, ZB = ground ? zLo : zLo - W;
        var mat = MatFor(f, reg);
        if (!f.Reveal)
            Warnings.Add($"feature {_fi} (opening_surround): reveal:false requested, but the reveal faces are " +
                         "required to close the added shell at the opening edges; they are emitted anyway.");

        Func<RVec3, RVec2> proj = q => reg.Uv(q);

        // z breakpoints for the vertical strips (fact 4: every band segment is split at the
        // coordinates of adjacent band ends so nothing T-junctions against a neighbour)
        var zCuts = ground ? new[] { zLo, zHi, ZT } : new[] { ZB, zLo, zHi, ZT };

        // ── band faces on the proud plane ──
        void Face(double ta, double tb, double za, double zb, string tag) =>
            Quad(mat, reg.Id, "proj", FacePt(ta, za), FacePt(tb, za), FacePt(tb, zb), FacePt(ta, zb),
                 proj, nOut, tag);
        for (int i = 0; i + 1 < zCuts.Length; i++) {          // jambs: full height, split at each cut
            Face(TL, t0, zCuts[i], zCuts[i + 1], $"srd-jambL-{i}");
            Face(t1, TR, zCuts[i], zCuts[i + 1], $"srd-jambR-{i}");
        }
        Face(t0, t1, zHi, ZT, "srd-head");                     // head band between the jambs
        if (!ground) Face(t0, t1, ZB, zLo, "srd-sill");        // sill band below the opening

        // ── vertical returns, unfolded about their shared vertical hinge on the face plane ──
        // outer returns at TL / TR continue the band outward; reveals at t0 / t1 continue it
        // into the opening. Both run from the proud face back to the wall plane.
        void RetV(double tc, RVec3 wDir, double za, double zb, string tag) {
            RVec3 F0 = FacePt(tc, za), F1 = FacePt(tc, zb);
            RVec3 W0 = WallPt(tc, za), W1 = WallPt(tc, zb);
            var uv = UnfoldUv(reg, F0, new RVec3(0, 0, 1), wDir);
            var nInt = wDir; // cap faces along the wall direction
            Quad(mat, reg.Id, "unfold", F0, W0, W1, F1, uv, nInt, tag);
        }
        for (int i = 0; i + 1 < zCuts.Length; i++) {           // outer returns split like the jambs
            RetV(TL, -e1, zCuts[i], zCuts[i + 1], $"srd-outerL-{i}");
            RetV(TR, e1, zCuts[i], zCuts[i + 1], $"srd-outerR-{i}");
        }
        RetV(t0, e1, zLo, zHi, "srd-revealL");                 // reveals line the opening jambs
        RetV(t1, -e1, zLo, zHi, "srd-revealR");

        // ── horizontal returns, unfolded about their horizontal hinge on the face plane ──
        void RetH(double zc, RVec3 wDir, double ta, double tb, string tag) {
            RVec3 F0 = FacePt(ta, zc), F1 = FacePt(tb, zc);
            RVec3 W0 = WallPt(ta, zc), W1 = WallPt(tb, zc);
            var uv = UnfoldUv(reg, F0, e1, wDir);
            Quad(mat, reg.Id, "unfold", F0, F1, W1, W0, uv, wDir, tag);
        }
        RetH(ZT, new RVec3(0, 0, 1), TL, t0, "srd-capL");      // top caps, split at t0/t1
        RetH(ZT, new RVec3(0, 0, 1), t0, t1, "srd-capM");
        RetH(ZT, new RVec3(0, 0, 1), t1, TR, "srd-capR");
        RetH(zHi, new RVec3(0, 0, -1), t0, t1, "srd-soffit");  // head soffit
        if (!ground) {
            RetH(ZB, new RVec3(0, 0, -1), TL, t0, "srd-botL"); // bottom caps
            RetH(ZB, new RVec3(0, 0, -1), t0, t1, "srd-botM");
            RetH(ZB, new RVec3(0, 0, -1), t1, TR, "srd-botR");
            RetH(zLo, new RVec3(0, 0, 1), t0, t1, "srd-sillTop"); // closes the sill into the opening
        }
    }

    // ── op: belt_course ─────────────────────────────────────────────

    void OpBeltCourse(ReliefFeature f) {
        if (!ResolveRegions(f, out var regs)) return;
        if (regs.Count == 0) { Err("no-regions", "belt_course needs at least one region"); return; }
        if (f.ZRange.Length != 2 || f.ZRange[0] >= f.ZRange[1]) {
            Err("bad-params", "belt_course needs zRange [z0, z1] with z0 < z1", new { zRange = f.ZRange });
            return;
        }
        double Qp = f.Proud;
        if (Qp <= 0) { Err("bad-params", "belt_course needs proud > 0", new { f.Proud }); return; }
        double z0 = f.ZRange[0], z1 = f.ZRange[1];
        if (z1 < _sum.BboxMin.Z || z0 > _sum.BboxMax.Z) {
            Err("zrange-outside-model", $"zRange [{z0}, {z1}] lies outside the model bbox z [{_sum.BboxMin.Z}, {_sum.BboxMax.Z}]",
                new { zRange = f.ZRange, modelZ = new[] { _sum.BboxMin.Z, _sum.BboxMax.Z } });
            return;
        }

        // per region: wall-line segment at each z level, clipped to the region polygon
        var lines0 = new Dictionary<string, (RVec2 A, RVec2 B)>();
        var lines1 = new Dictionary<string, (RVec2 A, RVec2 B)>();
        foreach (var r in regs) {
            if (Math.Abs(r.N.Z) > 0.7) {
                Err("not-a-wall", $"region '{r.Id}' is near-horizontal (n.z={r.N.Z:0.###}); belt_course needs wall-like planes",
                    new { region = r.Id });
                return;
            }
            foreach (var (z, store) in new[] { (z0, lines0), (z1, lines1) }) {
                if (!WallLineAt(r, z, out var a, out var b, out var why)) {
                    Err("zrange-outside-region", $"region '{r.Id}': {why}",
                        new { region = r.Id, z, zRange = f.ZRange, regionZ = RegionZRange(r) });
                    return;
                }
                store[r.Id] = (a, b);
            }
        }

        // build oriented segs at each level and chain them
        List<Seg> Mk(Dictionary<string, (RVec2 A, RVec2 B)> lines) {
            var list = new List<Seg>();
            foreach (var r in regs) {
                var (a, b) = lines[r.Id];
                var n2 = new RVec2(r.N.X, r.N.Y).Norm();
                var dir = new RVec2(-n2.Y, n2.X);
                if ((b - a).Dot(dir) < 0) (a, b) = (b, a);
                list.Add(new Seg { A = a, B = b, N2 = n2, Region = r });
            }
            return list;
        }
        var c0 = ChainSegments(Mk(lines0), Qp); if (c0 == null) return;
        var c1 = ChainSegments(Mk(lines1), Qp); if (c1 == null) return;
        var flat0 = c0.SelectMany(c => c).ToDictionary(s => s.Region.Id);
        var flat1 = c1.SelectMany(c => c).ToDictionary(s => s.Region.Id);
        // canonical order: ring chains rotate to start at their smallest region id, so the
        // two z levels compare rotation-independently (pairing itself is by region id)
        List<string> Canon(List<List<Seg>> chains) {
            var all = new List<string>();
            foreach (var ch in chains.OrderBy(ch => ch.Select(s => s.Region.Id).Min(StringComparer.Ordinal), StringComparer.Ordinal)) {
                var ids = ch.Select(s => s.Region.Id).ToList();
                bool ring = ch.Count > 1 && !ch[0].FreeA && !ch[^1].FreeB;
                if (ring) {
                    int k = ids.IndexOf(ids.Min(StringComparer.Ordinal)!);
                    ids = ids.Skip(k).Concat(ids.Take(k)).ToList();
                }
                all.AddRange(ids);
            }
            return all;
        }
        var order0 = Canon(c0);
        var order1 = Canon(c1);
        if (!order0.SequenceEqual(order1)) {
            Err("belt-chain-mismatch", "band segment order differs between the two z levels; the listed regions do not form one consistent wrap",
                new { atZ0 = order0, atZ1 = order1 });
            return;
        }

        int bi = 0;
        foreach (var rid in order0) {
            var s0 = flat0[rid]; var s1 = flat1[rid];
            var reg = s0.Region;
            var mat = MatFor(f, reg);
            RVec3 O00 = new(s0.OffA.X, s0.OffA.Y, z0), O01 = new(s0.OffB.X, s0.OffB.Y, z0);
            RVec3 O10 = new(s1.OffA.X, s1.OffA.Y, z1), O11 = new(s1.OffB.X, s1.OffB.Y, z1);
            RVec3 W00 = new(s0.A.X, s0.A.Y, z0), W01 = new(s0.B.X, s0.B.Y, z0);
            RVec3 W10 = new(s1.A.X, s1.A.Y, z1), W11 = new(s1.B.X, s1.B.Y, z1);
            var n3 = new RVec3(s0.N2.X, s0.N2.Y, 0);

            // outer band face (translate of the wall plane → same normal, projection uv)
            Quad(mat, rid, "proj", O00, O01, O11, O10, q => reg.Uv(q), n3, $"belt-face{bi}");

            // top return (faces +z): unfold about the outer top edge, w = "up" in the face plane
            var hdT = (O11 - O10).Norm();
            var upFace = (O10 - O00) - hdT * (O10 - O00).Dot(hdT);
            var uvT = UnfoldUv(reg, O10, O11 - O10, upFace);
            Quad(mat, rid, "unfold", O10, O11, W11, W10, uvT, new RVec3(0, 0, 1), $"belt-top{bi}");

            // bottom return (faces -z): unfold about the outer bottom edge, w = "down"
            var hdB = (O01 - O00).Norm();
            var dnFace = (O00 - O10) - hdB * (O00 - O10).Dot(hdB);
            var uvB = UnfoldUv(reg, O00, O01 - O00, dnFace);
            Quad(mat, rid, "unfold", O01, O00, W00, W01, uvB, new RVec3(0, 0, -1), $"belt-bot{bi}");
            bi++;
        }
    }

    static double[] RegionZRange(ReliefRegion r) {
        double zmin = double.MaxValue, zmax = double.MinValue;
        foreach (var p in r.Outer) { var w = r.World(p); zmin = Math.Min(zmin, w.Z); zmax = Math.Max(zmax, w.Z); }
        return new[] { zmin, zmax };
    }

    /// <summary>Intersect region plane with horizontal plane z, clip the line to the outer
    /// polygon; succeeds only when the clip is a single span.</summary>
    bool WallLineAt(ReliefRegion r, double z, out RVec2 a, out RVec2 b, out string why) {
        a = b = default; why = "";
        // line: points p with n·p = d and p.z = z  →  in (u,v) space
        // p = O + u·U + v·V ; z: O.z + u·U.z + v·V.z = z
        // The (u,v) line: u·U.z + v·V.z = z - O.z  (plane eq is automatic).
        double A = r.UAxis.Z, B = r.VAxis.Z, Cz = z - r.Origin.Z;
        var cuts = new List<double>();  // parameter along the line, in (u,v) space
        // param the line: pick base point + direction in (u,v)
        RVec2 p0, d2;
        if (Math.Abs(B) > Math.Abs(A)) { p0 = new RVec2(0, Cz / B); d2 = new RVec2(1, -A / B).Norm(); }
        else if (Math.Abs(A) > 1e-9) { p0 = new RVec2(Cz / A, 0); d2 = new RVec2(-B / A, 1).Norm(); }
        else { why = $"region plane is horizontal in (u,v); no line at z={z}"; return false; }

        int n = r.Outer.Count;
        for (int i = 0; i < n; i++) {
            var e0 = r.Outer[i]; var e1 = r.Outer[(i + 1) % n];
            // signed distance of polygon verts from the line
            double s0 = Cross2(d2, e0 - p0), s1 = Cross2(d2, e1 - p0);
            if (s0 == s1) continue;
            if ((s0 > 0 && s1 > 0) || (s0 < 0 && s1 < 0)) continue;
            double t = s0 / (s0 - s1);
            var hit = e0 + (e1 - e0) * t;
            cuts.Add((hit - p0).Dot(d2));
        }
        cuts.Sort();
        // dedupe near-coincident cuts (line through a vertex)
        var ded = new List<double>();
        foreach (var t in cuts)
            if (ded.Count == 0 || t - ded[^1] > 1e-6) ded.Add(t);
        if (ded.Count < 2) { why = $"z={z} does not cross the region's outer loop"; return false; }
        if (ded.Count > 2) { why = $"z={z} crosses the region outline {ded.Count} times; belt v1 needs a single span"; return false; }
        var wa = r.World(p0 + d2 * ded[0]);
        var wb = r.World(p0 + d2 * ded[1]);
        a = new RVec2(wa.X, wa.Y); b = new RVec2(wb.X, wb.Y);
        if ((b - a).Len() < 1e-6) { why = $"z={z} span on the region is degenerate"; return false; }
        return true;

        static double Cross2(RVec2 u, RVec2 v) => u.X * v.Y - u.Y * v.X;
    }
}
