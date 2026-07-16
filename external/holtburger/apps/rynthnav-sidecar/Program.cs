// Program.cs — RynthNav sidecar CLI.
//   serve --nav <dir> --portals <tsv> --listen 127.0.0.1:8767
//   bake  --ac <dats> --out <dir> --tiled <minX,maxX,minY,maxY hex> [--radius 2.0] [--geom <geomdir>]
// Bake loop is a port of upstream Tools/RynthNav.Baker/Program.cs (--tiled branch).
// With --geom, obstacle triangles (statics + buildings + scenery, pre-extracted by
// tools/GeomExtract) are fed through GeometryLoaderShim; without it, terrain-only.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DotRecast.Detour.Io;
using RynthCore.TerrainData;
using RynthNav.Baker;
using RynthNav.Sidecar;

string? GetArg(string name)
{
    for (int i = 0; i < args.Length - 1; i++)
        if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            return args[i + 1];
    return null;
}

string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
if (cmd == "tileinfo")
{
    // diagnostic: dump header fields of every tile in a dir
    string dir = args.Length > 1 ? args[1] : ".";
    foreach (var f in Directory.GetFiles(dir, "nav_*.tile").OrderBy(x => x))
    {
        using var fr = File.OpenRead(f);
        using var br = new BinaryReader(fr);
        var md = new DtMeshDataReader().Read(br, DetourRouter.VertsPerPoly);
        var h = md.header;
        Console.WriteLine($"{Path.GetFileName(f),-16} polys={h.polyCount,4} verts={h.vertCount,4} detailMeshes={h.detailMeshCount,4} detailTris={h.detailTriCount,5} xy=({h.x},{h.y}) bmin=({h.bmin.X:F0},{h.bmin.Y:F1},{h.bmin.Z:F0}) bmax=({h.bmax.X:F0},{h.bmax.Y:F1},{h.bmax.Z:F0})");
    }
    return 0;
}
if (cmd != "serve" && cmd != "bake")
{
    Console.Error.WriteLine("usage: RynthNav.Sidecar serve --nav <dir> --portals <tsv> [--listen 127.0.0.1:8767]");
    Console.Error.WriteLine("       RynthNav.Sidecar bake  --ac <dats> --out <dir> --tiled <minX,maxX,minY,maxY hex> [--radius 2.0] [--geom <geomdir>]");
    return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// bake
// ─────────────────────────────────────────────────────────────────────────────
if (cmd == "bake")
{
    string ac = GetArg("--ac") ?? "/home/wbterminal/ac_base_dats";
    string? outDir = GetArg("--out");
    string? tiled = GetArg("--tiled");
    string? geomDir = GetArg("--geom");
    float radius = float.TryParse(GetArg("--radius"), NumberStyles.Float, CultureInfo.InvariantCulture, out float rr) ? rr : 2.0f;
    if (outDir == null || tiled == null) { Console.Error.WriteLine("bake needs --out and --tiled"); return 1; }
    var p = tiled.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    if (p.Length != 4) { Console.Error.WriteLine("--tiled needs minX,maxX,minY,maxY (hex)"); return 1; }
    int x0 = Convert.ToInt32(p[0], 16), x1 = Convert.ToInt32(p[1], 16), y0 = Convert.ToInt32(p[2], 16), y1 = Convert.ToInt32(p[3], 16);
    Directory.CreateDirectory(outDir);

    Console.WriteLine($"RynthNav.Sidecar bake — dats={ac} out={outDir} region lbX 0x{x0:X2}..0x{x1:X2} lbY 0x{y0:X2}..0x{y1:X2} radius={radius}");
    using var sampler = new TerrainSampler();
    if (!sampler.Initialize(ac)) { Console.Error.WriteLine($"TerrainSampler init failed: {sampler.Status}"); return 1; }

    // Obstacles: pre-extracted geom files (tools/GeomExtract) when --geom is given;
    // otherwise geo=null => terrain-only tiles.
    using var shim = new RynthCore2.Raycast.GeometryLoader();
    RynthCore2.Raycast.GeometryLoader? geo = geomDir != null && shim.InitializeGeomDir(geomDir) ? shim : null;
    Console.WriteLine($"obstacles: {shim.StatusMessage}");

    NavBake.BakeRegionTiled(sampler, geo, x0, x1, y0, y1, outDir, radius, out int tiles, out int empty);
    Console.WriteLine($"tiled bake DONE: {tiles} tiles written, {empty} empty.");
    if (geo != null)
        Console.WriteLine($"obstacle triangles fed: {geo.TrianglesServed} across {geo.LandblocksServed} landblocks");
    if (x1 > x0) Console.WriteLine("connectivity X: " + NavBake.ValidateConnectivity(outDir, (uint)((x0 << 8) | y0), (uint)(((x0 + 1) << 8) | y0)));
    if (y1 > y0) Console.WriteLine("connectivity Y: " + NavBake.ValidateConnectivity(outDir, (uint)((x0 << 8) | y0), (uint)((x0 << 8) | (y0 + 1))));

    // Round-trip sanity: read one tile back the way DetourRouter.EnsureTile does.
    string? sample = Directory.GetFiles(outDir, "nav_*.tile").OrderBy(f => f).FirstOrDefault();
    if (sample != null)
    {
        using var fr = File.OpenRead(sample);
        using var br = new BinaryReader(fr);
        var md = new DtMeshDataReader().Read(br, DetourRouter.VertsPerPoly);
        Console.WriteLine($"round-trip {Path.GetFileName(sample)}: polys={md.header.polyCount} verts={md.header.vertCount} tileXY=({md.header.x},{md.header.y})");
    }

    // Provenance artifacts (§2 bake-base-dats-only: emit bake-source.sha256).
    var sha = new StringBuilder();
    foreach (var name in new[] { "client_portal.dat", "client_cell_1.dat" })
    {
        string path = Path.Combine(ac, name);
        if (!File.Exists(path)) { Console.Error.WriteLine($"missing {path} for sha256"); continue; }
        using var s = File.OpenRead(path);
        sha.Append(Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant()).Append("  ").Append(name).Append('\n');
        Console.WriteLine($"sha256 {name} done");
    }
    File.WriteAllText(Path.Combine(outDir, "bake-source.sha256"), sha.ToString());

    var bakeParams = new
    {
        region = new { minX = $"0x{x0:X2}", maxX = $"0x{x1:X2}", minY = $"0x{y0:X2}", maxY = $"0x{y1:X2}" },
        @params = new
        {
            vertsPerPoly = 6, cellSize = 0.5, tileSize = 384, cellHeight = 0.20,
            agentHeight = 2.0, agentRadius = radius, agentMaxClimb = 1.0,
            agentMaxSlope = Math.Acos(TerrainSampler.FloorZ) * 180.0 / Math.PI,
            partitioning = "WATERSHED",
        },
        terrainOnly = geo == null,
        geometry = geo != null ? "statics+scenery" : "terrain-only",
        geomDir = geo != null ? geomDir : null,
        source = ac,
        timestamp = DateTime.UtcNow.ToString("o"),
        toolRev = "rynthsuite@bf1fb52 vendored into rynthnav-sidecar",
    };
    File.WriteAllText(Path.Combine(outDir, "bake-params.json"),
        JsonSerializer.Serialize(bakeParams, new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine($"wrote {Path.Combine(outDir, "bake-source.sha256")} and bake-params.json");
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// serve
// ─────────────────────────────────────────────────────────────────────────────
{
    string navDir = GetArg("--nav") ?? "/mnt/wbterminal2/rynthnav-data";
    string portalsTsv = GetArg("--portals") ?? Path.Combine(AppContext.BaseDirectory, "data", "portals.tsv");
    string listen = GetArg("--listen") ?? "127.0.0.1:8767";

    var router = new DetourRouter(navDir, portalsTsv);
    Console.WriteLine($"RynthNav.Sidecar serve — nav={navDir} ({router.AvailableTileCount()} tiles on disk), portals={router.PortalCount}, listen=http://{listen}");

    var builder = WebApplication.CreateBuilder(Array.Empty<string>());
    builder.WebHost.UseUrls($"http://{listen}");
    var app = builder.Build();

    // CORS on EVERY response incl. errors; OPTIONS <any path> -> 204 (preflight).
    app.Use(async (ctx, next) =>
    {
        ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
        ctx.Response.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
        ctx.Response.Headers["Access-Control-Allow-Headers"] = "content-type";
        if (HttpMethods.IsOptions(ctx.Request.Method)) { ctx.Response.StatusCode = 204; return; }
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {ctx.Request.Method} {ctx.Request.Path}");
        await next();
    });

    static Task WriteJson(HttpContext ctx, int status, object payload)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(payload));
    }

    app.MapGet("/health", (HttpContext ctx) =>
        WriteJson(ctx, 200, new { ok = true, tiles = router.AvailableTileCount(), portals = router.PortalCount }));

    app.MapPost("/route", async (HttpContext ctx) =>
    {
        string body;
        using (var sr = new StreamReader(ctx.Request.Body)) body = await sr.ReadToEndAsync();
        JsonDocument doc;
        try { doc = JsonDocument.Parse(body); }
        catch (JsonException) { await WriteJson(ctx, 400, new { ok = false, error = "malformed JSON" }); return; }

        WorldPt start, goal;
        try
        {
            using (doc)
            {
                var root = doc.RootElement;
                var from = root.GetProperty("from");
                start = DetourRouter.LbLocalToWorld(
                    from.GetProperty("lb").GetUInt32(),
                    from.GetProperty("x").GetDouble(),
                    from.GetProperty("y").GetDouble(),
                    from.GetProperty("z").GetDouble());
                var to = root.GetProperty("to");
                if (to.TryGetProperty("lb", out var lbEl))
                {
                    goal = DetourRouter.LbLocalToWorld(
                        lbEl.GetUInt32(),
                        to.GetProperty("x").GetDouble(),
                        to.GetProperty("y").GetDouble(),
                        to.TryGetProperty("z", out var zEl) ? zEl.GetDouble() : start.Z);
                }
                else
                {
                    // {"ns":<deg>,"ew":<deg>} — /loc degrees; z resolved by the navmesh query.
                    goal = new WorldPt(
                        DetourRouter.DegToWorld(to.GetProperty("ew").GetDouble()),
                        DetourRouter.DegToWorld(to.GetProperty("ns").GetDouble()),
                        start.Z);
                }
            }
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
        {
            await WriteJson(ctx, 400, new { ok = false, error = $"malformed JSON: {ex.Message}" });
            return;
        }

        RouteOutcome outcome;
        try { outcome = router.Route(start, goal); }
        catch (Exception ex)
        {
            Console.WriteLine($"[route] planner exception: {ex}");
            await WriteJson(ctx, 200, new { ok = false, error = $"planner error: {ex.Message}" });
            return;
        }

        if (!outcome.Ok)
        {
            Console.WriteLine($"[route] FAIL: {outcome.Error}");
            await WriteJson(ctx, 200, new { ok = false, error = outcome.Error });
            return;
        }

        Console.WriteLine($"[route] ok: {outcome.Legs.Count} legs, est={outcome.EstUnits:F0}u, portals={outcome.PortalsUsed}, coverage={outcome.Coverage}");
        await WriteJson(ctx, 200, new
        {
            ok = true,
            legs = outcome.Legs.Select(l => new { lb = l.Lb, x = l.X, y = l.Y, z = l.Z, portal = l.Portal, label = l.Label }),
            estUnits = outcome.EstUnits,
            portalsUsed = outcome.PortalsUsed,
            coverage = outcome.Coverage,
        });
    });

    app.Run();
    return 0;
}
