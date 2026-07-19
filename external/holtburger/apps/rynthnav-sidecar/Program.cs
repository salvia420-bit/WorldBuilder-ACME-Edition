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
    Console.Error.WriteLine("                              [--max-tiles N] [--tile-high-water N]");
    Console.Error.WriteLine("                              (tile budget: CLI flag > env RYNTHNAV_MAX_TILES / RYNTHNAV_TILE_HIGH_WATER > default 1024 / maxTiles-64)");
    Console.Error.WriteLine("       RynthNav.Sidecar bake  --ac <dats> --out <dir> --tiled <minX,maxX,minY,maxY hex> [--radius 2.0] [--geom <geomdir>]");
    Console.Error.WriteLine("       RynthNav.Sidecar tileinfo [dir]   (dump nav_*.tile header fields: polys/verts/detail/bbox)");
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

    NavBake.WaterCellsSkipped = 0;
    NavBake.WaterRuleEnabled = !args.Any(a => string.Equals(a, "--no-water", StringComparison.OrdinalIgnoreCase));
    if (!NavBake.WaterRuleEnabled) Console.WriteLine("WARNING: --no-water — fully-flooded cells baked as walkable (A/B/diagnostic only)");
    NavBake.BakeRegionTiled(sampler, geo, x0, x1, y0, y1, outDir, radius, out int tiles, out int empty);
    Console.WriteLine($"tiled bake DONE: {tiles} tiles written, {empty} empty. water cells skipped (fully-flooded, unwalkable): {NavBake.WaterCellsSkipped}");
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
    // A /route request is well under 1 KB; anything huge is a client bug. Kestrel
    // enforces this at body-read time (surfaced below as a JSON 413, CORS intact).
    const long MaxRouteBodyBytes = 64 * 1024;
    // World bounds: 256 landblocks x 192 m, +1 LB margin for edge /loc rounding.
    // Out-of-map goals MUST be rejected here: DetourRouter.LoadCorridor iterates the
    // full corridor bbox before clamping to [0,255], so a far-out goal (e.g. ns=1e6)
    // spins ~1e12 iterations INSIDE the route lock and wedges /route for everyone.
    const double WorldMax = 256 * 192.0;
    const double WorldMargin = 192.0;

    string navDir = GetArg("--nav") ?? "/mnt/wbterminal2/rynthnav-data";
    string portalsTsv = GetArg("--portals") ?? Path.Combine(AppContext.BaseDirectory, "data", "portals.tsv");
    string listen = GetArg("--listen") ?? "127.0.0.1:8767";

    // Tile-budget knobs: CLI flag > env var > DetourRouter default. DetourRouter reads
    // the env vars once in its constructor, so thread validated CLI values through the
    // process environment before construction (no constructor-signature change).
    foreach (var (flag, env) in new[] { ("--max-tiles", "RYNTHNAV_MAX_TILES"), ("--tile-high-water", "RYNTHNAV_TILE_HIGH_WATER") })
    {
        string? v = GetArg(flag);
        if (v == null) continue;
        if (!int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n) || n <= 0)
        { Console.Error.WriteLine($"{flag} needs a positive integer, got '{v}'"); return 1; }
        Environment.SetEnvironmentVariable(env, v);
    }

    var router = new DetourRouter(navDir, portalsTsv);
    Console.WriteLine($"RynthNav.Sidecar serve — nav={navDir} ({router.AvailableTileCount()} tiles on disk), portals={router.PortalCount}, listen=http://{listen}, maxTiles={router.MaxTilesConfigured}, tileHighWater={router.TileHighWater}");

    var builder = WebApplication.CreateBuilder(Array.Empty<string>());
    builder.WebHost.UseUrls($"http://{listen}");
    builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = MaxRouteBodyBytes);
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

    // ── /route request validation ─────────────────────────────────────────────
    // Contract: only a malformed REQUEST is a 400; planning failures stay HTTP 200
    // {"ok":false}. Every branch returns a well-formed JSON body (CORS via middleware).

    static string? FiniteNumber(JsonElement obj, string who, string name, out double v)
    {
        v = 0;
        if (!obj.TryGetProperty(name, out var el)) return $"missing '{who}.{name}'";
        if (el.ValueKind != JsonValueKind.Number) return $"'{who}.{name}' must be a number";
        v = el.GetDouble(); // JSON overflow (1e309) parses as Infinity — caught below
        if (!double.IsFinite(v)) return $"'{who}.{name}' must be finite";
        return null;
    }

    // {lb,x,y[,z]} point. lb must be a u32 objCellId; only its high word places the
    // point (LbLocalToWorld), so an odd LOW word (0, indoor cell, >0x40) is accepted
    // and degrades — indoor bots legitimately send indoor cell ids. x/y are lb-local
    // [0,192) with 0.5 m slack for seam-rounding floats. z: required unless zFallback.
    static string? LbPoint(JsonElement obj, string who, double? zFallback, out WorldPt pt)
    {
        pt = default;
        if (!obj.TryGetProperty("lb", out var lbEl)) return $"missing '{who}.lb'";
        if (lbEl.ValueKind != JsonValueKind.Number || !lbEl.TryGetUInt32(out uint lb))
            return $"'{who}.lb' must be an unsigned 32-bit integer objCellId";
        string? e;
        if ((e = FiniteNumber(obj, who, "x", out double x)) != null) return e;
        if ((e = FiniteNumber(obj, who, "y", out double y)) != null) return e;
        if (x < -0.5 || x > 192.5) return $"'{who}.x' outside landblock-local range [0,192)";
        if (y < -0.5 || y > 192.5) return $"'{who}.y' outside landblock-local range [0,192)";
        double z;
        if (obj.TryGetProperty("z", out var zEl))
        {
            if (zEl.ValueKind != JsonValueKind.Number || !double.IsFinite(z = zEl.GetDouble()))
                return $"'{who}.z' must be a finite number";
        }
        else if (zFallback != null) z = zFallback.Value;
        else return $"missing '{who}.z'";
        pt = DetourRouter.LbLocalToWorld(lb, x, y, z);
        return null;
    }

    // Optional "avoid":[{x,y,r}] — world-frame metres (lbX*192+local, same frame the router uses
    // internally), r > 0. Absent field => empty list => today's behavior exactly. A malformed
    // entry is a 400 (like any bad request field), never a silent drop.
    static string? ParseAvoid(JsonElement root, out List<AvoidCircle> avoid)
    {
        avoid = new List<AvoidCircle>();
        if (!root.TryGetProperty("avoid", out var arr)) return null;
        if (arr.ValueKind != JsonValueKind.Array) return "'avoid' must be an array of {x,y,r}";
        int i = 0;
        foreach (var el in arr.EnumerateArray())
        {
            string who = $"avoid[{i}]";
            if (el.ValueKind != JsonValueKind.Object) return $"'{who}' must be an object {{x,y,r}}";
            string? e;
            if ((e = FiniteNumber(el, who, "x", out double x)) != null) return e;
            if ((e = FiniteNumber(el, who, "y", out double y)) != null) return e;
            if ((e = FiniteNumber(el, who, "r", out double r)) != null) return e;
            if (r <= 0) return $"'{who}.r' must be positive";
            avoid.Add(new AvoidCircle(x, y, r));
            i++;
        }
        return null;
    }

    static string? ParseRouteRequest(JsonElement root, out WorldPt start, out WorldPt goal, out List<AvoidCircle> avoid)
    {
        start = default; goal = default; avoid = new List<AvoidCircle>();
        if (root.ValueKind != JsonValueKind.Object) return "request root must be a JSON object";
        if (!root.TryGetProperty("from", out var from)) return "missing 'from'";
        if (from.ValueKind != JsonValueKind.Object) return "'from' must be an object {lb,x,y,z}";
        string? e = LbPoint(from, "from", null, out start);
        if (e != null) return e;
        if (!root.TryGetProperty("to", out var to)) return "missing 'to'";
        if (to.ValueKind != JsonValueKind.Object) return "'to' must be an object ({lb,x,y[,z]} or {ns,ew})";
        bool hasLb = to.TryGetProperty("lb", out _);
        bool hasDeg = to.TryGetProperty("ns", out _) || to.TryGetProperty("ew", out _);
        if (hasLb && hasDeg) return "ambiguous 'to': send either {lb,x,y[,z]} or {ns,ew}, not both";
        if (hasLb) { if ((e = LbPoint(to, "to", start.Z, out goal)) != null) return e; }
        else if (!hasDeg) return "'to' needs either {lb,x,y[,z]} or {ns,ew}";
        else
        {
            // {"ns":<deg>,"ew":<deg>} — /loc degrees; z resolved by the navmesh query.
            if ((e = FiniteNumber(to, "to", "ns", out double nsDeg)) != null) return e;
            if ((e = FiniteNumber(to, "to", "ew", out double ewDeg)) != null) return e;
            goal = new WorldPt(DetourRouter.DegToWorld(ewDeg), DetourRouter.DegToWorld(nsDeg), start.Z);
            if (goal.Wx < -WorldMargin || goal.Wx > WorldMax + WorldMargin ||
                goal.Wy < -WorldMargin || goal.Wy > WorldMax + WorldMargin)
                return "'to' ns/ew outside world bounds (/loc range is about -102.0 .. 102.8 deg)";
        }
        return ParseAvoid(root, out avoid);
    }

    app.MapPost("/route", async (HttpContext ctx) =>
    {
        // content-type is deliberately not enforced: the body is parsed as JSON no
        // matter what the header says (garbage still fails the parse -> 400, never 500).
        string body;
        try { using var sr = new StreamReader(ctx.Request.Body); body = await sr.ReadToEndAsync(); }
        catch (BadHttpRequestException ex) // Kestrel MaxRequestBodySize -> 413 et al.
        {
            string msg = ex.StatusCode == StatusCodes.Status413PayloadTooLarge
                ? $"request body too large (limit {MaxRouteBodyBytes} bytes)" : "bad request body";
            Console.WriteLine($"[route] {ex.StatusCode}: {msg}");
            await WriteJson(ctx, ex.StatusCode, new { ok = false, error = msg });
            return;
        }
        JsonDocument doc;
        try { doc = JsonDocument.Parse(body); }
        catch (JsonException) { await WriteJson(ctx, 400, new { ok = false, error = "malformed JSON" }); return; }

        WorldPt start, goal;
        List<AvoidCircle> avoid;
        string? bad;
        try { using (doc) bad = ParseRouteRequest(doc.RootElement, out start, out goal, out avoid); }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        {
            // Belt-and-braces: ParseRouteRequest is TryGet-based and shouldn't throw.
            await WriteJson(ctx, 400, new { ok = false, error = $"malformed request: {ex.Message}" });
            return;
        }
        if (bad != null)
        {
            Console.WriteLine($"[route] 400: {bad}");
            await WriteJson(ctx, 400, new { ok = false, error = bad });
            return;
        }

        // Degenerate but legal: already at the goal. One arrival leg, not an error
        // (DetourRouter emits no legs under ~1 cm and would report a plan failure;
        // 5 cm also absorbs navmesh-snap wobble on the string-pull endpoints).
        double ddx = start.Wx - goal.Wx, ddy = start.Wy - goal.Wy;
        if (Math.Sqrt(ddx * ddx + ddy * ddy) < 0.05)
        {
            var arrive = DetourRouter.WorldToLeg(goal);
            await WriteJson(ctx, 200, new
            {
                ok = true,
                legs = new[] { new { lb = arrive.Lb, x = arrive.X, y = arrive.Y, z = arrive.Z, portal = false, stitch = false, label = "" } },
                estUnits = 0.0,
                portalsUsed = 0,
                coverage = "straight",
                stitchedLegs = 0,
                partial = false,
                avoidApplied = 0,
            });
            return;
        }

        RouteOutcome outcome;
        try { outcome = router.Route(start, goal, avoid); }
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

        Console.WriteLine($"[route] ok: {outcome.Legs.Count} legs ({outcome.StitchedLegs} stitch), est={outcome.EstUnits:F0}u, portals={outcome.PortalsUsed}, coverage={outcome.Coverage}, partial={outcome.Partial}, avoidApplied={outcome.AvoidApplied}");
        await WriteJson(ctx, 200, new
        {
            ok = true,
            legs = outcome.Legs.Select(l => new { lb = l.Lb, x = l.X, y = l.Y, z = l.Z, portal = l.Portal, stitch = l.Stitch, label = l.Label }),
            estUnits = outcome.EstUnits,
            portalsUsed = outcome.PortalsUsed,
            coverage = outcome.Coverage,
            stitchedLegs = outcome.StitchedLegs,
            partial = outcome.Partial,
            avoidApplied = outcome.AvoidApplied,
        });
    });

    // Wrong method / unknown path still answer well-formed JSON (CORS via middleware;
    // OPTIONS never reaches routing — the middleware answers preflight with 204).
    app.MapMethods("/route", new[] { "GET", "PUT", "DELETE", "PATCH", "HEAD" }, (HttpContext ctx) =>
        WriteJson(ctx, 405, new { ok = false, error = "use POST /route" }));
    app.MapFallback((HttpContext ctx) =>
        WriteJson(ctx, 404, new { ok = false, error = "not found (endpoints: GET /health, POST /route)" }));

    app.Run();
    return 0;
}
