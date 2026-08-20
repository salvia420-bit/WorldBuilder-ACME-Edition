using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using AcmeRedline.Services;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;
using NJsonSchema;

// AcmeRedline self-test: emit schema-v1 entries from real dat-grounded selection state, validate
// every line against tools/dat-patch/redline/schema_v1.json, and prove the triangle-index stream
// matches the pipeline's queue_worker._tri_stream convention byte-for-byte.
//
// Values are realistic and DAT-DERIVED: the GfxObj/Surface/RenderSurface ids and triangle indices
// are read out of client_portal.dat; positions, camera poses, author and prompt are invented.

const string Portal = "/home/wbterminal/ac_base_dats/client_portal.dat";
const string SchemaPath = "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch/redline/schema_v1.json";
string outDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
string outFile = Path.Combine(outDir, "redline.jsonl");

if (!File.Exists(Portal)) { Console.Error.WriteLine($"missing {Portal}"); return 2; }
if (!File.Exists(SchemaPath)) { Console.Error.WriteLine($"missing {SchemaPath}"); return 2; }

// --- Projection arithmetic self-test (offline) -------------------------------------------------
// The client MATRIX CONTENT is verified/cited (m_GState feeds D3D as VIEW/PROJECTION); this checks
// the arithmetic AcmeRedline layers on top — row-vector transform, perspective divide, viewport map
// with the D3D y-flip — catching a transpose or a flipped axis. With ViewProj = identity a world
// point's x,y should map linearly to the viewport, y inverted.
{
    var f = new Projection.Frame(System.Numerics.Matrix4x4.Identity, 1000, 600, valid: true);
    (System.Numerics.Vector3 w, float ex, float ey)[] cases = {
        (new(0, 0, 0),  500, 300),   // centre
        (new(1, 1, 0), 1000,   0),   // top-right (y flips)
        (new(-1, -1, 0),  0, 600),   // bottom-left
    };
    bool projOk = true;
    foreach (var (w, ex, ey) in cases) {
        if (!f.TryWorldToScreen(w, out var s) || Math.Abs(s.X - ex) > 0.5f || Math.Abs(s.Y - ey) > 0.5f) {
            Console.WriteLine($"PROJECTION FAIL: {w} -> {(f.TryWorldToScreen(w, out var d) ? d.ToString() : "behind")} expected ({ex},{ey})");
            projOk = false;
        }
    }
    Console.WriteLine($"projection arithmetic self-test = {(projOk ? "PASS" : "FAIL")}");
    if (!projOk) return 3;
}

var dat = new PortalDatabase(Portal, DatAccessType.Read);
string portalSha = Sha256File(Portal);
Console.WriteLine($"portal sha256 = {portalSha}");

var release = new ClientRelease { KitTag = "acme-r9", PortalSha256 = portalSha, HighresSha256 = null };
var entries = new List<RedlineEntry>();

// ---- Entry 1: TRIANGLES on 0x01000827 -----------------------------------------------------------
// Pick a couple of source polygons and let the plugin's own BuildFanTrianglePayload produce the
// fan-triangulated draw-stream indices + per-triangle footprint.
{
    const uint gid = 0x01000827u;
    if (!dat.TryGet<GfxObj>(gid, out var gfx) || gfx is null) { Console.Error.WriteLine("no 0x01000827"); return 2; }

    // Source polygons chosen to land some triangles past the drawn-only count (triDrawn) — the
    // all-polys vs drawn-only proof. Polygon 136 is the last polygon in the record.
    var pickedPolys = new List<int> { 8, 40, 136 };

    var (indices, footprint) = SelectionService.BuildFanTrianglePayload(gfx, pickedPolys);
    string recSha = Sha256Bytes(RecordBytes(dat, gid));

    // --- parity check against the pipeline's queue_worker._tri_stream ---
    var pipelineStream = PipelineTriStream(gfx);                       // (polyPos, (a,b,c)) list
    int triAll = pipelineStream.Count;
    int triDrawn = gfx.Polygons.OrderBy(kv => kv.Key)
                      .Where(kv => ((int)kv.Value.Stippling & 0x4) == 0)
                      .Sum(kv => Math.Max(0, kv.Value.VertexIds.Count - 2));
    var expected = Enumerable.Range(0, triAll)
                             .Where(i => pickedPolys.Contains(pipelineStream[i].poly))
                             .ToList();
    bool parity = indices.SequenceEqual(expected);
    Console.WriteLine($"0x01000827: triAll={triAll} triDrawn={triDrawn} picked={string.Join(",", pickedPolys)}");
    Console.WriteLine($"  emitted indices = [{string.Join(",", indices)}]");
    Console.WriteLine($"  pipeline stream parity = {parity}");
    Console.WriteLine($"  max index {(indices.Count > 0 ? indices.Max() : -1)} vs triDrawn {triDrawn} " +
                      $"(> triDrawn proves all-polys) : {(indices.Count > 0 && indices.Max() >= triDrawn)}");
    if (!parity) { Console.Error.WriteLine("PARITY FAILED — emit diverges from queue_worker._tri_stream"); return 3; }

    entries.Add(new RedlineEntry {
        Id = "rl-20260820-141500-a1b2",
        V = 1,
        CreatedAt = "2026-08-20T14:15:00.000Z",
        Author = "tailnet1",
        ClientRelease = release,
        World = new WorldContext { Landblock = "0x016C0107", Pos = new[] { 84.3f, 22.1f, 6.02f }, Heading = 137.5f },
        Camera = new CameraContext { Pos = new[] { 82.0f, 20.4f, 7.5f }, LookAt = new[] { 84.3f, 22.1f, 6.2f }, FovDeg = 55f },
        Selection = new Selection {
            Kind = SelectionKind.Triangles,
            Triangles = new TriangleSelection {
                GfxObjId = Hex.U32(gid),
                Indices = indices,
                Footprint = footprint,
                BaseRecordSha256 = recSha,
            },
        },
        Prompt = "these triangles bulge out where the wall should be flat; flatten the panel",
        Tags = new List<string> { "silhouette", "remove-detail" },
        Severity = 3,
        Attachments = new List<string>(),          // honest: no screenshot path (see CaptureService)
        Guards = new Guards { TerrainProtected = false, PaletteRoute = false },
        Status = new StatusBlock { State = RedlineStatus.Queued },
    });
}

// ---- Entry 2: TEXTURE on a real RenderSurface ---------------------------------------------------
// Resolve a real Surface(0x08) -> SurfaceTexture(0x05) -> RenderSurface(0x06) chain from 0x01000827.
{
    const uint gid = 0x01000827u;
    dat.TryGet<GfxObj>(gid, out var gfx);
    var chain = FirstTextureChain(dat, gfx!);
    if (chain is null) { Console.Error.WriteLine("no texture chain on 0x01000827"); return 2; }
    var (sId, stId, rsId) = chain.Value;
    Console.WriteLine($"texture chain: surf {Hex.U32(sId)} -> st {Hex.U32(stId)} -> rs {Hex.U32(rsId)}");

    entries.Add(new RedlineEntry {
        Id = "rl-20260820-141530-c7d9",
        V = 1,
        CreatedAt = "2026-08-20T14:15:30.000Z",
        Author = "tailnet1",
        ClientRelease = release,
        World = new WorldContext { Landblock = "0x016C0107", Pos = new[] { 84.3f, 22.1f, 6.02f }, Heading = 137.5f },
        Camera = new CameraContext { Pos = new[] { 82.0f, 20.4f, 7.5f }, LookAt = new[] { 84.3f, 22.1f, 6.2f }, FovDeg = 55f },
        Selection = new Selection {
            Kind = SelectionKind.Texture,
            RenderSurfaces = new List<SelectedRenderSurface> {
                new() {
                    RsId = Hex.U32(rsId),
                    SurfaceId = sId == 0 ? null : Hex.U32(sId),
                    SurfaceTextureId = stId == 0 ? null : Hex.U32(stId),
                    UvHints = new List<float[]> { new[] { 0.31f, 0.68f }, new[] { 0.40f, 0.72f } },
                },
            },
        },
        Prompt = "this texture is too blurry up close; should read as weathered granite",
        Tags = new List<string> { "too-blurry", "wrong-material" },
        Severity = 2,
        Attachments = new List<string>(),
        Guards = new Guards { TerrainProtected = false, PaletteRoute = false },
        Status = new StatusBlock { State = RedlineStatus.Queued },
    });
}

// ---- Entry 3: OBJECT (a bare architecture GfxObj, no Setup) --------------------------------------
{
    const uint gid = 0x01000827u;
    entries.Add(new RedlineEntry {
        Id = "rl-20260820-141600-4e0f",
        V = 1,
        CreatedAt = "2026-08-20T14:16:00.000Z",
        Author = "tailnet1",
        ClientRelease = release,
        World = new WorldContext { Landblock = "0x016C0107", Pos = new[] { 84.3f, 22.1f, 6.02f }, Heading = 137.5f },
        Camera = new CameraContext { Pos = new[] { 82.0f, 20.4f, 7.5f }, LookAt = new[] { 84.3f, 22.1f, 6.2f }, FovDeg = 55f },
        Selection = new Selection {
            Kind = SelectionKind.Object,
            Objects = new List<SelectedObject> {
                new() {
                    ObjectId = "0x8001A2B3",
                    SetupId = null,                       // schema: retail architecture has no Setup
                    GfxObjId = Hex.U32(gid),
                    WorldFrame = new WorldFrame { Pos = new[] { 84.3f, 22.1f, 6.02f }, Quat = new[] { 0.923f, 0f, 0f, 0.382f } },
                },
            },
        },
        Prompt = "whole model looks wrong scale next to the door",
        Tags = new List<string> { "other" },
        Severity = 1,
        Attachments = new List<string>(),
        Guards = new Guards { TerrainProtected = false, PaletteRoute = false },
        Status = new StatusBlock { State = RedlineStatus.Queued },
    });
}

// ---- Validate every entry against schema_v1.json #/definitions/entry -----------------------------
var schema = await JsonSchema.FromFileAsync(SchemaPath);
if (!schema.Definitions.TryGetValue("entry", out var entrySchema)) {
    Console.Error.WriteLine("schema has no #/definitions/entry"); return 2;
}

int bad = 0;
var lines = new List<string>();
foreach (var e in entries) {
    string line = RedlineJson.ToLine(e);
    lines.Add(line);
    var errors = entrySchema.Validate(line);
    if (errors.Count == 0) {
        Console.WriteLine($"VALID   {e.Id}  ({e.Selection!.Kind})");
    }
    else {
        bad++;
        Console.WriteLine($"INVALID {e.Id}");
        foreach (var err in errors) Console.WriteLine($"    {err.Kind} @ {err.Path}");
    }
}

if (bad == 0) {
    File.WriteAllText(outFile, string.Join("\n", lines) + "\n");
    Console.WriteLine($"\nwrote {entries.Count} entries -> {outFile}");
}
Console.WriteLine(bad == 0 ? "\nALL ENTRIES VALID against schema_v1.json #/definitions/entry"
                           : $"\n{bad} INVALID entrie(s)");
return bad == 0 ? 0 : 1;


// ------------------------------ helpers ------------------------------

static string Sha256File(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
static string Sha256Bytes(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

static byte[] RecordBytes(PortalDatabase dat, uint id) {
    if (!dat.TryGetFileBytes(id, out var bytes) || bytes is null)
        throw new InvalidOperationException($"no record bytes for 0x{id:X8}");
    return bytes;
}

// A faithful C# port of tools/dat-patch/redline/queue_worker.py:_tri_stream — over EVERY polygon
// in record order, fan (v[0], v[k], v[k+1]) for k=1..n-2 — used only to prove parity.
static List<(int poly, (short a, short b, short c) t)> PipelineTriStream(GfxObj gfx) {
    var outp = new List<(int, (short, short, short))>();
    int pi = 0;
    foreach (var kv in gfx.Polygons.OrderBy(k => k.Key)) {   // record order == ascending dense key
        var v = kv.Value.VertexIds;
        for (int k = 1; k + 1 < v.Count; k++) outp.Add((pi, (v[0], v[k], v[k + 1])));
        pi++;
    }
    return outp;
}

static (uint sId, uint stId, uint rsId)? FirstTextureChain(PortalDatabase dat, GfxObj gfx) {
    foreach (var sref in gfx.Surfaces) {
        uint sId = sref;
        if (sId == 0 || !dat.TryGet<Surface>(sId, out var surf) || surf is null) continue;
        uint stId = surf.OrigTextureId;
        if (stId == 0 || !dat.TryGet<SurfaceTexture>(stId, out var st) || st is null || st.Textures.Count == 0) continue;
        uint rsId = st.Textures[0];
        if (rsId != 0) return (sId, stId, rsId);
    }
    return null;
}
