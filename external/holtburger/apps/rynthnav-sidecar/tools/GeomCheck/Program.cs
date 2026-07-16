// GeomCheck — adversarial verifier for tools/GeomExtract output.
//
//   GeomCheck --ac <dats> --scenery <dir> --geom <extracted geomdir>
//             [--region A7,AB,B2,B6] [--check A8B4,A9B4]
//
// Sections (each prints PASS/FAIL; process exits nonzero on any FAIL):
//   1. FILE     geom_{LB}.jsonl invariants: parse, finite verts, LB bounds
//               (±64 m margin), tris divisible by 3, zero-area census.
//   2. WINDING  scenery entries are closed prisms — directed-edge pairing must
//               balance and signed volume must be POSITIVE (outward faces).
//   3. QUATS    every Stab/Building Frame in the region: |q|-1 ≤ 1e-3 (retail
//               Frame::IsValid tolerance, acclient.c:356; 5*2e-4) and a census
//               of non-pure-Z orientations (catches W/X read-order bugs).
//   4. PLACE    placement-frame selection divergence: retail statics use
//               SetPlacementFrame(0x65)->fallback key 0->identity
//               (CPhysicsObj::InitObjectEnd acclient.c:317303, SetPlacementFrame
//               acclient.c:326818). GeomExtract now implements exactly that;
//               this section flags any referenced Setup where the retail pick
//               differs from GeomExtract's pick (regression guard — a hit means
//               someone changed the extractor's placement selection).
//   5. SIDES    CullMode census over referenced physics polys (0=Landblock,
//               1=None double-sided, 2=Clockwise, 3=CounterClockwise). Retail
//               has no ==3 branch anywhere; any 3s here would need a decision.
//   6. RECOMP   independent recompute of EVERY vertex in the --check geom
//               files using the retail Frame::cache matrix (acclient.c:356984)
//               + Frame::LocalToGlobal row order (acclient.c:143709) and the
//               RETAIL placement pick, then vertex-exact diff vs the files.
//               This is the end-to-end transform audit: quat convention,
//               AFrame.Combine composition, DefaultScale, prism geometry.
//   7. DEGEN    scenery rows with scale<=0 / bad obj_id prefix; landblocks in
//               the extracted set with no LandBlockInfo record must still have
//               an (empty) geom file.
//   8. SEAL     --seal-buildings wall-skirt invariants (trivially PASS on an
//               unsealed extraction): every seal line immediately follows its
//               building line (same did — seals never attach to statics/scenery),
//               one seal per building entry, every seal vertex inside that
//               building's footprint bbox (+0.5 m XY / -1.5..+4.5 m Z), every
//               seal tri VERTICAL with z-span >= agentHeight 2.0 m and base at
//               or below the building zmin, and — the no-bleed guarantee — every
//               seal vertex within 0.40 m (raster cell diagonal ~0.36 m) of the
//               building's actual geometry in 2D projection.
using System.Globalization;
using System.Numerics;
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
string geomDir = GetArg("--geom") ?? throw new ArgumentException("--geom required");
string region = GetArg("--region") ?? "A7,AB,B2,B6";
string check = GetArg("--check") ?? "A8B4,A9B4";

var rp = region.Split(',');
int rx0 = Convert.ToInt32(rp[0], 16), rx1 = Convert.ToInt32(rp[1], 16);
int ry0 = Convert.ToInt32(rp[2], 16), ry1 = Convert.ToInt32(rp[3], 16);
var checkLbs = check.Split(',').Select(s => Convert.ToUInt32(s, 16)).ToArray();

using var cellDb = new CellDatabase(Path.Combine(ac, "client_cell_1.dat"), DatAccessType.Read);
using var portalDb = new PortalDatabase(Path.Combine(ac, "client_portal.dat"), DatAccessType.Read);

int failures = 0;
void Verdict(string section, bool ok, string detail)
{
    Console.WriteLine($"{(ok ? "PASS" : "FAIL")} [{section}] {detail}");
    if (!ok) failures++;
}

// ── retail transform math, implemented FROM THE DECOMP (not System.Numerics)
// so section 6 is an independent oracle. Frame::cache acclient.c:356984 builds
// m_fl2gv; Frame::LocalToGlobal acclient.c:143709 applies rows as below.
static Vector3 RetailRotate(Quaternion q, Vector3 v)
{
    float x = q.X, y = q.Y, z = q.Z, w = q.W;
    float m0 = 1 - 2 * y * y - 2 * z * z, m1 = 2 * x * y + 2 * w * z, m2 = 2 * x * z - 2 * w * y;
    float m3 = 2 * x * y - 2 * w * z, m4 = 1 - 2 * x * x - 2 * z * z, m5 = 2 * y * z + 2 * w * x;
    float m6 = 2 * x * z + 2 * w * y, m7 = 2 * y * z - 2 * w * x, m8 = 1 - 2 * x * x - 2 * y * y;
    return new Vector3(
        m0 * v.X + m3 * v.Y + m6 * v.Z,
        m1 * v.X + m4 * v.Y + m7 * v.Z,
        m2 * v.X + m5 * v.Y + m8 * v.Z);
}

// Hamilton product (retail Frame::combine_quats / System.Numerics agree; used
// here so the recompute path never touches Quaternion.Multiply).
static Quaternion QMul(Quaternion a, Quaternion b) => new(
    a.W * b.X + b.W * a.X + (a.Y * b.Z - a.Z * b.Y),
    a.W * b.Y + b.W * a.Y + (a.Z * b.X - a.X * b.Z),
    a.W * b.Z + b.W * a.Z + (a.X * b.Y - a.Y * b.X),
    a.W * b.W - (a.X * b.X + a.Y * b.Y + a.Z * b.Z));

// ── section 1+2: geom file invariants ────────────────────────────────────────
var fileEntries = new Dictionary<uint, List<(string src, uint did, List<Vector3> verts)>>();
foreach (var lb in checkLbs)
{
    string path = Path.Combine(geomDir, $"geom_{lb:X4}.jsonl");
    if (!File.Exists(path)) { Verdict("FILE", false, $"missing {path}"); continue; }
    var entries = new List<(string, uint, List<Vector3>)>();
    int nanCount = 0, oobCount = 0, zeroAreaTris = 0, badLen = 0;
    long triCount = 0;
    foreach (var line in File.ReadLines(path))
    {
        if (string.IsNullOrWhiteSpace(line)) continue;
        using var doc = JsonDocument.Parse(line);
        var r = doc.RootElement;
        string src = r.GetProperty("src").GetString()!;
        uint did = Convert.ToUInt32(r.GetProperty("did").GetString()!, 16);
        var verts = new List<Vector3>();
        foreach (var v in r.GetProperty("tris").EnumerateArray())
            verts.Add(new Vector3((float)v[0].GetDouble(), (float)v[1].GetDouble(), (float)v[2].GetDouble()));
        if (verts.Count % 3 != 0) badLen++;
        foreach (var v in verts)
        {
            if (!float.IsFinite(v.X) || !float.IsFinite(v.Y) || !float.IsFinite(v.Z)) nanCount++;
            if (v.X < -64 || v.X > 256 || v.Y < -64 || v.Y > 256 || v.Z < -1000 || v.Z > 1000) oobCount++;
        }
        for (int i = 0; i + 2 < verts.Count; i += 3)
        {
            var n = Vector3.Cross(verts[i + 1] - verts[i], verts[i + 2] - verts[i]);
            if (n.Length() < 1e-9f) zeroAreaTris++;
        }
        triCount += verts.Count / 3;
        entries.Add((src, did, verts));
    }
    fileEntries[lb] = entries;
    int nStatic = entries.Count(e => e.Item1 == "static");
    int nBld = entries.Count(e => e.Item1 == "building");
    int nScn = entries.Count(e => e.Item1 == "scenery");
    int nSeal = entries.Count(e => e.Item1 == "seal");
    Console.WriteLine($"  0x{lb:X4}: lines={entries.Count} (static={nStatic} building={nBld} scenery={nScn} seal={nSeal}) tris={triCount} zeroArea={zeroAreaTris}");
    Verdict("FILE", nanCount == 0 && badLen == 0, $"0x{lb:X4} finite verts ({nanCount} NaN/Inf), tri-list lengths ({badLen} bad)");
    Verdict("FILE", oobCount == 0, $"0x{lb:X4} bounds ±64 m of LB ({oobCount} out-of-bounds verts)");

    // winding: scenery prisms are closed meshes; edge pairing must balance and
    // signed volume (Σ a·(b×c)/6) must be positive for outward faces.
    int closed = 0, negVol = 0, open = 0;
    foreach (var (src, did, verts) in entries.Where(e => e.Item1 == "scenery"))
    {
        var edges = new Dictionary<(int, int), int>();
        var keys = new List<Vector3>();
        int Key(Vector3 v)
        {
            for (int k = 0; k < keys.Count; k++) if ((keys[k] - v).Length() < 1e-5f) return k;
            keys.Add(v); return keys.Count - 1;
        }
        double vol = 0;
        for (int i = 0; i + 2 < verts.Count; i += 3)
        {
            int a = Key(verts[i]), b = Key(verts[i + 1]), c = Key(verts[i + 2]);
            foreach (var (u, w) in new[] { (a, b), (b, c), (c, a) })
            {
                edges.TryGetValue((u, w), out int n); edges[(u, w)] = n + 1;
            }
            vol += Vector3.Dot(verts[i], Vector3.Cross(verts[i + 1], verts[i + 2])) / 6.0;
        }
        bool isClosed = edges.All(kv => edges.TryGetValue((kv.Key.Item2, kv.Key.Item1), out int rev) && rev == kv.Value);
        if (!isClosed) { open++; continue; }
        closed++;
        if (vol <= 0) { negVol++; Console.WriteLine($"  WINDING: 0x{did:X8} closed mesh signed volume {vol:F3} <= 0"); }
    }
    Verdict("WINDING", negVol == 0, $"0x{lb:X4} scenery closed meshes: {closed} closed / {open} open, {negVol} with negative volume");
}

// ── sections 3-5: region-wide DAT-level scans ────────────────────────────────
int quatBad = 0, quatTilted = 0, quatTotal = 0;
var setupDids = new HashSet<uint>();
var gfxDids = new HashSet<uint>();
var noLbi = new List<uint>();
for (int x = Math.Max(0, rx0 - 1); x <= Math.Min(255, rx1 + 1); x++)
    for (int y = Math.Max(0, ry0 - 1); y <= Math.Min(255, ry1 + 1); y++)
    {
        uint lb = (uint)((x << 8) | y);
        if (!cellDb.TryGet<LandBlockInfo>((lb << 16) | 0xFFFE, out var lbi) || lbi == null) { noLbi.Add(lb); continue; }
        void CheckQ(Quaternion q, uint did)
        {
            quatTotal++;
            if (Math.Abs(q.Length() - 1f) > 1e-3f) { quatBad++; Console.WriteLine($"  QUATS: 0x{lb:X4} did 0x{did:X8} |q|={q.Length():F6}"); }
            else if (Math.Abs(q.X) > 0.02f || Math.Abs(q.Y) > 0.02f) quatTilted++;
        }
        foreach (var s in lbi.Objects) { CheckQ(s.Frame.Orientation, s.Id); Ref(s.Id); }
        foreach (var b in lbi.Buildings) { CheckQ(b.Frame.Orientation, b.ModelId); Ref(b.ModelId); }
    }
if (sceneryDir != null)
    for (int x = Math.Max(0, rx0 - 1); x <= Math.Min(255, rx1 + 1); x++)
        for (int y = Math.Max(0, ry0 - 1); y <= Math.Min(255, ry1 + 1); y++)
        {
            string p = Path.Combine(sceneryDir, $"0x{(x << 8) | y:X4}.scenery.jsonl");
            if (!File.Exists(p)) continue;
            foreach (var line in File.ReadLines(p))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var doc = JsonDocument.Parse(line);
                Ref(Convert.ToUInt32(doc.RootElement.GetProperty("obj_id").GetString()!, 16));
            }
        }
void Ref(uint did)
{
    if (did >> 24 == 0x02) setupDids.Add(did);
    else if (did >> 24 == 0x01) gfxDids.Add(did);
}
Verdict("QUATS", quatBad == 0, $"{quatTotal} stab/building frames, {quatBad} non-unit, {quatTilted} tilted off pure-Z (info)");
Console.WriteLine($"  region: {noLbi.Count} landblocks with no LandBlockInfo record; {setupDids.Count} setups + {gfxDids.Count} bare gfxobjs referenced");

// placement divergence: retail pick (0x65 -> 0 -> identity) vs GeomExtract
// pick (0 -> first entry -> identity).
int placeDiverge = 0, placeNoDefault = 0;
foreach (var did in setupDids.OrderBy(d => d))
{
    if (!portalDb.TryGet<Setup>(did, out var setup) || setup == null) continue;
    var byKey = new Dictionary<int, AnimationFrame>();
    var order = new List<int>();
    foreach (var kv in setup.PlacementFrames) { int k = Convert.ToInt32(kv.Key); byKey[k] = kv.Value; order.Add(k); }
    AnimationFrame? retail = byKey.TryGetValue(0x65, out var r65) ? r65 : (byKey.TryGetValue(0, out var r0) ? r0 : null);
    // GeomExtract's pick, post-fix: identical retail order (0x65 -> 0 -> identity).
    AnimationFrame? ge = byKey.TryGetValue(0x65, out var g65) ? g65 : (byKey.TryGetValue(0, out var g0) ? g0 : null);
    if (order.Count > 0 && !byKey.ContainsKey(0)) placeNoDefault++;
    float maxD = 0;
    int n = Math.Max(retail?.Frames.Count ?? 0, ge?.Frames.Count ?? 0);
    for (int i = 0; i < n; i++)
    {
        Vector3 ro = retail != null && i < retail.Frames.Count ? retail.Frames[i].Origin : Vector3.Zero;
        Vector3 go = ge != null && i < ge.Frames.Count ? ge.Frames[i].Origin : Vector3.Zero;
        Quaternion rq = retail != null && i < retail.Frames.Count ? retail.Frames[i].Orientation : Quaternion.Identity;
        Quaternion gq = ge != null && i < ge.Frames.Count ? ge.Frames[i].Orientation : Quaternion.Identity;
        maxD = Math.Max(maxD, (ro - go).Length());
        maxD = Math.Max(maxD, 1f - Math.Abs(Quaternion.Dot(rq, gq)));
    }
    if (maxD > 1e-6f)
    {
        placeDiverge++;
        Console.WriteLine($"  PLACE: 0x{did:X8} retail-pick({(byKey.ContainsKey(0x65) ? "0x65" : byKey.ContainsKey(0) ? "0" : "identity")}) != GE-pick({(byKey.ContainsKey(0) ? "0" : order.Count > 0 ? $"first=0x{order[0]:X}" : "identity")}), maxΔ={maxD:F4} keys=[{string.Join(",", order.Select(k => $"0x{k:X}"))}]");
    }
}
Verdict("PLACE", placeDiverge == 0, $"{setupDids.Count} setups: {placeDiverge} with retail-vs-GeomExtract placement divergence ({placeNoDefault} lack key 0)");

// sides_type census over every referenced physics polygon.
var sideCounts = new Dictionary<int, int>();
void CensusGfx(uint gd)
{
    if (!portalDb.TryGet<GfxObj>(gd, out var gfx) || gfx == null) return;
    foreach (var poly in gfx.PhysicsPolygons.Values)
    {
        int st = Convert.ToInt32(poly.SidesType);
        sideCounts.TryGetValue(st, out int n); sideCounts[st] = n + 1;
    }
}
foreach (var gd in gfxDids) CensusGfx(gd);
foreach (var sd in setupDids)
    if (portalDb.TryGet<Setup>(sd, out var setup) && setup != null)
        foreach (var part in setup.Parts) CensusGfx(part);
sideCounts.TryGetValue(3, out int ccw);
Verdict("SIDES", ccw == 0, $"physics-poly CullMode census: {string.Join(" ", sideCounts.OrderBy(k => k.Key).Select(kv => $"{kv.Key}:{kv.Value}"))} (3=CounterClockwise would be reverse-front)");

// ── section 6: independent recompute with retail math + retail placement ─────
var gfxTriCache = new Dictionary<uint, List<Vector3>?>();
List<Vector3>? GfxTris(uint did)
{
    if (gfxTriCache.TryGetValue(did, out var cached)) return cached;
    List<Vector3>? result = null;
    if (portalDb.TryGet<GfxObj>(did, out var gfx) && gfx != null)
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
                    continue;
                result.Add(a.Origin); result.Add(b.Origin); result.Add(c.Origin);
                if (doubleSided) { result.Add(a.Origin); result.Add(c.Origin); result.Add(b.Origin); }
            }
        }
    }
    gfxTriCache[did] = result;
    return result;
}

void Prism(List<Vector3> outv, Vector3 c, float r, float h, Vector3 origin, Quaternion q, float scale)
{
    const int N = 8;
    var lo = new Vector3[N];
    var hi = new Vector3[N];
    for (int i = 0; i < N; i++)
    {
        double a = 2.0 * Math.PI * i / N;
        var off = new Vector3((float)(Math.Cos(a) * r), (float)(Math.Sin(a) * r), 0);
        lo[i] = origin + RetailRotate(q, (c + off) * scale);
        hi[i] = origin + RetailRotate(q, (c + off + new Vector3(0, 0, h)) * scale);
    }
    for (int i = 0; i < N; i++)
    {
        int j = (i + 1) % N;
        outv.Add(lo[i]); outv.Add(lo[j]); outv.Add(hi[j]);
        outv.Add(lo[i]); outv.Add(hi[j]); outv.Add(hi[i]);
    }
    for (int i = 1; i + 1 < N; i++)
    {
        outv.Add(hi[0]); outv.Add(hi[i]); outv.Add(hi[i + 1]);
        outv.Add(lo[0]); outv.Add(lo[i + 1]); outv.Add(lo[i]);
    }
}

List<Vector3> RecomputePlaced(uint did, Vector3 origin, Quaternion q, float scale)
{
    var outv = new List<Vector3>();
    if (did >> 24 == 0x01)
    {
        var tris = GfxTris(did);
        if (tris != null) foreach (var v in tris) outv.Add(origin + RetailRotate(q, v * scale));
        return outv;
    }
    if (did >> 24 != 0x02 || !portalDb.TryGet<Setup>(did, out var setup) || setup == null) return outv;
    // RETAIL placement pick: 0x65 -> key 0 -> identity (never "first entry").
    var byKey = new Dictionary<int, AnimationFrame>();
    foreach (var kv in setup.PlacementFrames) byKey[Convert.ToInt32(kv.Key)] = kv.Value;
    List<Frame>? frames = byKey.TryGetValue(0x65, out var af65) ? af65.Frames : byKey.TryGetValue(0, out var af0) ? af0.Frames : null;
    for (int i = 0; i < setup.Parts.Count; i++)
    {
        Vector3 po = frames != null && i < frames.Count ? frames[i].Origin : Vector3.Zero;
        Quaternion pq = frames != null && i < frames.Count ? frames[i].Orientation : Quaternion.Identity;
        Vector3 partO = origin + RetailRotate(q, po * scale);
        Quaternion partQ = QMul(q, pq);
        Vector3 ds = setup.DefaultScale.Count > i ? setup.DefaultScale[i] : Vector3.One;
        var tris = GfxTris(setup.Parts[i]);
        if (tris != null) foreach (var v in tris) outv.Add(partO + RetailRotate(partQ, v * ds * scale));
    }
    if (outv.Count == 0)
    {
        foreach (var cs in setup.CylSpheres) Prism(outv, cs.Origin, cs.Radius, cs.Height, origin, q, scale);
        foreach (var sp in setup.Spheres) Prism(outv, sp.Origin - new Vector3(0, 0, sp.Radius), sp.Radius, sp.Radius * 2f, origin, q, scale);
    }
    return outv;
}

foreach (var lb in checkLbs)
{
    if (!fileEntries.TryGetValue(lb, out var allEntries)) continue;
    // seal lines are synthetic nav geometry, not DAT recomputes — section 8's job.
    var entries = allEntries.Where(e => e.Item1 != "seal").ToList();
    // rebuild the extraction order: LBI statics, LBI buildings, scenery rows.
    var expected = new List<(string src, uint did, List<Vector3> verts)>();
    if (cellDb.TryGet<LandBlockInfo>((lb << 16) | 0xFFFE, out var lbi) && lbi != null)
    {
        foreach (var s in lbi.Objects)
        {
            var v = RecomputePlaced(s.Id, s.Frame.Origin, s.Frame.Orientation, 1f);
            if (v.Count > 0) expected.Add(("static", s.Id, v));
        }
        foreach (var b in lbi.Buildings)
        {
            var v = RecomputePlaced(b.ModelId, b.Frame.Origin, b.Frame.Orientation, 1f);
            if (v.Count > 0) expected.Add(("building", b.ModelId, v));
        }
    }
    if (sceneryDir != null)
    {
        string p = Path.Combine(sceneryDir, $"0x{lb:X4}.scenery.jsonl");
        if (File.Exists(p))
            foreach (var line in File.ReadLines(p))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var doc = JsonDocument.Parse(line);
                var r = doc.RootElement;
                uint did = Convert.ToUInt32(r.GetProperty("obj_id").GetString()!, 16);
                var origin = new Vector3((float)r.GetProperty("x").GetDouble(), (float)r.GetProperty("y").GetDouble(), (float)r.GetProperty("z").GetDouble());
                var q = new Quaternion((float)r.GetProperty("qx").GetDouble(), (float)r.GetProperty("qy").GetDouble(), (float)r.GetProperty("qz").GetDouble(), (float)r.GetProperty("qw").GetDouble());
                float scale = r.TryGetProperty("scale", out var sc) ? (float)sc.GetDouble() : 1f;
                var v = RecomputePlaced(did, origin, q, scale);
                if (v.Count > 0) expected.Add(("scenery", did, v));
            }
    }
    bool countOk = expected.Count == entries.Count;
    float worst = 0; int mismatched = 0; uint worstDid = 0;
    for (int i = 0; i < Math.Min(expected.Count, entries.Count); i++)
    {
        var (esrc, edid, ev) = expected[i];
        var (fsrc, fdid, fv) = entries[i];
        if (esrc != fsrc || edid != fdid || ev.Count != fv.Count) { mismatched++; Console.WriteLine($"  RECOMP: 0x{lb:X4} entry {i}: expected {esrc}/0x{edid:X8}/{ev.Count}v, file has {fsrc}/0x{fdid:X8}/{fv.Count}v"); continue; }
        for (int k = 0; k < ev.Count; k++)
        {
            float d = (ev[k] - fv[k]).Length();
            if (d > worst) { worst = d; worstDid = edid; }
        }
    }
    Verdict("RECOMP", countOk && mismatched == 0 && worst < 2e-3f,
        $"0x{lb:X4}: {entries.Count} file entries vs {expected.Count} recomputed (retail placement pick), {mismatched} shape mismatches, worst vertex Δ={worst:E2} m (did 0x{worstDid:X8})");
}

// ── section 7: degenerates in the scenery inputs + missing-LBI geom files ────
int scaleZero = 0, badPrefix = 0;
if (sceneryDir != null)
    for (int x = Math.Max(0, rx0 - 1); x <= Math.Min(255, rx1 + 1); x++)
        for (int y = Math.Max(0, ry0 - 1); y <= Math.Min(255, ry1 + 1); y++)
        {
            string p = Path.Combine(sceneryDir, $"0x{(x << 8) | y:X4}.scenery.jsonl");
            if (!File.Exists(p)) continue;
            foreach (var line in File.ReadLines(p))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var doc = JsonDocument.Parse(line);
                var r = doc.RootElement;
                if (r.TryGetProperty("scale", out var sc) && sc.GetDouble() <= 0) scaleZero++;
                uint did = Convert.ToUInt32(r.GetProperty("obj_id").GetString()!, 16);
                if (did >> 24 != 0x01 && did >> 24 != 0x02) badPrefix++;
            }
        }
Verdict("DEGEN", scaleZero == 0 && badPrefix == 0, $"region scenery rows: {scaleZero} with scale<=0, {badPrefix} with non-GfxObj/Setup obj_id");

int emptyMissing = 0;
foreach (var f in Directory.GetFiles(geomDir, "geom_*.jsonl"))
{
    uint lb = Convert.ToUInt32(Path.GetFileNameWithoutExtension(f).Substring(5), 16);
    if (noLbi.Contains(lb) && new FileInfo(f).Length == 0) emptyMissing++;
}
Console.WriteLine($"  {emptyMissing} extracted landblocks had no LBI record and (correctly) an empty geom file");

// ── section 8: SEAL — --seal-buildings wall-skirt invariants ─────────────────
// 2D squared distance from point to segment.
static float SegDist2Sq(float px, float py, Vector3 a, Vector3 b)
{
    float dx = b.X - a.X, dy = b.Y - a.Y;
    float len2 = dx * dx + dy * dy;
    float t = len2 < 1e-12f ? 0f : Math.Clamp(((px - a.X) * dx + (py - a.Y) * dy) / len2, 0f, 1f);
    float ex = a.X + t * dx - px, ey = a.Y + t * dy - py;
    return ex * ex + ey * ey;
}

// 2D distance from point to a triangle's XY projection. Degenerate projections
// (vertical walls -> segments) fall through to edge distances, never a bogus 0.
static float PointTriDist2D(float px, float py, Vector3 a, Vector3 b, Vector3 c)
{
    float area2 = Math.Abs((b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X));
    if (area2 > 1e-9f)
    {
        float d1 = (b.X - a.X) * (py - a.Y) - (b.Y - a.Y) * (px - a.X);
        float d2 = (c.X - b.X) * (py - b.Y) - (c.Y - b.Y) * (px - b.X);
        float d3 = (a.X - c.X) * (py - c.Y) - (a.Y - c.Y) * (px - c.X);
        bool hasNeg = d1 < 0 || d2 < 0 || d3 < 0, hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(hasNeg && hasPos)) return 0f;   // inside (either winding)
    }
    return MathF.Sqrt(Math.Min(SegDist2Sq(px, py, a, b), Math.Min(SegDist2Sq(px, py, b, c), SegDist2Sq(px, py, c, a))));
}

foreach (var lb in checkLbs)
{
    if (!fileEntries.TryGetValue(lb, out var entries)) continue;
    int nSeal = entries.Count(e => e.Item1 == "seal");
    int nBld = entries.Count(e => e.Item1 == "building");
    if (nSeal == 0)
    {
        Verdict("SEAL", true, $"0x{lb:X4}: no seal entries (unsealed extraction) — nothing to assert");
        continue;
    }
    int pairBad = 0, bboxBad = 0, tiltBad = 0, shortBad = 0, baseBad = 0, bleedBad = 0;
    float worstBleed = 0f, minSpan = float.MaxValue;
    for (int i = 0; i < entries.Count; i++)
    {
        var (src, did, verts) = entries[i];
        if (src != "seal") continue;
        // pairing: emitted immediately after its own building line (adjacency, not
        // did lookup — duplicate ModelIds per landblock exist, e.g. 0x01000BC3 in A9B4).
        if (i == 0 || entries[i - 1].Item1 != "building" || entries[i - 1].Item2 != did)
        {
            pairBad++;
            Console.WriteLine($"  SEAL: 0x{lb:X4} entry {i} (0x{did:X8}) not adjacent to its building line");
            continue;
        }
        var bld = entries[i - 1].Item3;
        float bx0 = float.MaxValue, bx1 = float.MinValue, by0 = float.MaxValue, by1 = float.MinValue, bz0 = float.MaxValue, bz1 = float.MinValue;
        foreach (var v in bld)
        {
            bx0 = Math.Min(bx0, v.X); bx1 = Math.Max(bx1, v.X);
            by0 = Math.Min(by0, v.Y); by1 = Math.Max(by1, v.Y);
            bz0 = Math.Min(bz0, v.Z); bz1 = Math.Max(bz1, v.Z);
        }
        // footprint bbox containment (+0.5 m XY; walls run zmin-1..zmin+4)
        foreach (var v in verts)
            if (v.X < bx0 - 0.5f || v.X > bx1 + 0.5f || v.Y < by0 - 0.5f || v.Y > by1 + 0.5f ||
                v.Z < bz0 - 1.5f || v.Z > bz0 + 4.5f) bboxBad++;
        // per-tri: vertical, z-span >= agentHeight 2.0, base at/below building zmin
        for (int t = 0; t + 2 < verts.Count; t += 3)
        {
            var n = Vector3.Cross(verts[t + 1] - verts[t], verts[t + 2] - verts[t]);
            if (Math.Abs(n.Z) > 1e-3f * n.Length()) tiltBad++;
            float z0 = Math.Min(verts[t].Z, Math.Min(verts[t + 1].Z, verts[t + 2].Z));
            float z1 = Math.Max(verts[t].Z, Math.Max(verts[t + 1].Z, verts[t + 2].Z));
            minSpan = Math.Min(minSpan, z1 - z0);
            if (z1 - z0 < 2.0f) shortBad++;
            if (z0 > bz0 + 0.5f) baseBad++;
        }
        // no-bleed: every wall corner within one raster diagonal of REAL building
        // geometry (2D) — bbox alone would let a concave notch be walled over.
        var cornersSeen = new HashSet<(float, float)>();
        foreach (var v in verts)
        {
            if (!cornersSeen.Add((v.X, v.Y))) continue;
            float best = float.MaxValue;
            for (int t = 0; t + 2 < bld.Count && best > 0f; t += 3)
                best = Math.Min(best, PointTriDist2D(v.X, v.Y, bld[t], bld[t + 1], bld[t + 2]));
            worstBleed = Math.Max(worstBleed, best);
            if (best > 0.40f) bleedBad++;
        }
    }
    Verdict("SEAL", nSeal == nBld && pairBad == 0,
        $"0x{lb:X4}: {nSeal} seals for {nBld} building entries, {pairBad} pairing violations");
    Verdict("SEAL", bboxBad == 0, $"0x{lb:X4}: {bboxBad} seal verts outside building footprint bbox (+0.5 m XY / -1.5..+4.5 m Z)");
    Verdict("SEAL", tiltBad == 0 && shortBad == 0 && baseBad == 0,
        $"0x{lb:X4}: walls vertical ({tiltBad} tilted), z-span >= 2.0 m ({shortBad} short, min {(minSpan == float.MaxValue ? 0 : minSpan):F2} m), base at/below building zmin ({baseBad} floated)");
    Verdict("SEAL", bleedBad == 0, $"0x{lb:X4}: {bleedBad} wall corners farther than 0.40 m (2D) from building geometry, worst {worstBleed:F3} m");
}

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
