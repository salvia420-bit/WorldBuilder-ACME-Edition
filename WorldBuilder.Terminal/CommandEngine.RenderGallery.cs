using System.Globalization;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  Render Gallery — wirerender wave (2026-05-XX)
    //
    //  Curates a small set of landblocks from the spin wave's gazetteer
    //  state, runs render-preview + describe-landblock per pick, and
    //  bundles the results plus a Tailwind viewer template into one
    //  self-contained directory. Companion to emit-static-site: the
    //  Leaflet view explores everything; the gallery is the curated
    //  showcase.
    // ─────────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions GalleryJsonOpts = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    // ── Snapshot accessors used by RenderGalleryCurator (read-only views) ────

    internal IReadOnlyDictionary<ushort, LandblockDescriber.TownContext> GetTownGazetteerSnapshot()
        => _townGazetteer;

    internal IReadOnlyDictionary<ushort, List<SpawnRecord>> GetSpawnGazetteerSnapshot()
        => _spawnGazetteer;

    internal IReadOnlyList<(ushort LbKey, string Region)> GetRegionAnchorsSnapshot() {
        // Region anchor LB keys come from the lbX/lbY pair on each anchor.
        // The list mirrors what the per-LB describer attributes when no
        // closer anchor exists.
        var result = new List<(ushort, string)>(_regionAnchors.Count);
        foreach (var a in _regionAnchors) {
            ushort lb = LbKey((uint)a.LbX, (uint)a.LbY);
            result.Add((lb, a.Region));
        }
        return result;
    }

    /// <summary>
    /// Enumerate dungeon landblock keys discovered via document storage.
    /// Used by the curator's dungeon picker.
    /// </summary>
    public IReadOnlyList<ushort> ListDungeonLandblockKeys() {
        RequireProject();
        return ListDungeonDocIds(_projectManager.CurrentProject!, null);
    }

    /// <summary>
    /// Cell count for a dungeon LB. Returns 0 when the LB has no dungeon doc
    /// or the doc fails to load.
    /// </summary>
    public int GetDungeonCellCount(ushort lbKey) {
        RequireProject();
        try {
            var dungeon = GetDungeonDoc(lbKey);
            return dungeon?.Cells.Count ?? 0;
        } catch { return 0; }
    }

    // ── emit-render-gallery ───────────────────────────────────────────

    public RenderGalleryResult EmitRenderGallery(
            string outDir,
            IReadOnlyList<ushort>? lbFilter = null,
            int autoTowns = 5, int autoZones = 5,
            int autoDungeons = 5, int autoRegions = 5,
            int radius = 1, int resolution = 1536,
            bool useSprites = true, bool overlay = true) {
        RequireProject();
        try {
            Directory.CreateDirectory(outDir);
            var rendersDir = Path.Combine(outDir, "renders");
            var descDir = Path.Combine(outDir, "desc");
            Directory.CreateDirectory(rendersDir);
            Directory.CreateDirectory(descDir);

            // Resolve picks: explicit filter wins (slug becomes "lb_HHHH"
            // and category "explicit"), otherwise call the curator. The
            // curator covers the four pick families per the wirerender
            // spec; explicit is for pinned views.
            List<RenderGalleryCurator.Pick> picks;
            if (lbFilter is { Count: > 0 }) {
                picks = new List<RenderGalleryCurator.Pick>(lbFilter.Count);
                foreach (var lb in lbFilter) {
                    picks.Add(new RenderGalleryCurator.Pick(
                        lb, $"LB 0x{lb:X4}", "explicit",
                        $"Explicit pick — LB 0x{lb:X4}", null, null));
                }
            } else {
                picks = RenderGalleryCurator.Curate(this, autoTowns, autoZones, autoDungeons, autoRegions);
            }

            var picksInfo = new List<RenderGalleryPickInfo>();
            int totalSpawnCount = 0;
            var coveredLbs = new HashSet<ushort>();

            for (int i = 0; i < picks.Count; i++) {
                var pick = picks[i];
                string slug = $"{(i + 1):D2}_{Slugify(pick.Title, pick.LbKey)}";
                uint lbX = (uint)((pick.LbKey >> 8) & 0xFF);
                uint lbY = (uint)(pick.LbKey & 0xFF);
                string renderRel = $"renders/{slug}.png";
                string descRel = $"desc/{slug}.json";
                string renderAbs = Path.Combine(outDir, renderRel);
                string descAbs = Path.Combine(outDir, descRel);

                int renderedCount = 0;
                try {
                    var renderResult = RenderPreview(
                        lbX, lbY, radius, resolution, overlay,
                        outputPath: renderAbs, useSprites: useSprites);
                    renderedCount = renderResult.ObjectCount;
                } catch (Exception ex) {
                    Console.Error.WriteLine($"[RenderGallery] Render failed for {slug}: {ex.Message}");
                    // Skip describe too if render fails — the pick is unusable.
                    continue;
                }

                int spawnsHere = 0;
                try {
                    var desc = DescribeLandblock(lbX, lbY);
                    File.WriteAllText(descAbs,
                        SerializeDescriptionForGallery(desc, out spawnsHere));
                } catch (Exception ex) {
                    Console.Error.WriteLine($"[RenderGallery] Describe failed for {slug}: {ex.Message}");
                    File.WriteAllText(descAbs,
                        JsonSerializer.Serialize(new {
                            error = ex.Message,
                            landblock = $"0x{pick.LbKey:X4}",
                        }, GalleryJsonOpts));
                }

                coveredLbs.Add(pick.LbKey);
                totalSpawnCount += spawnsHere;
                picksInfo.Add(new RenderGalleryPickInfo(
                    slug, pick.Title, pick.Category,
                    $"0x{pick.LbKey:X4}", (int)lbX, (int)lbY,
                    renderRel, descRel,
                    pick.SpawnCount ?? (spawnsHere > 0 ? spawnsHere : (int?)null),
                    pick.CellCount,
                    renderedCount,
                    pick.Note));
            }

            // manifest.json — gallery-wide pick metadata
            var manifestObj = new {
                protocolVersion = 1,
                generated = DateTime.UtcNow.ToString("o"),
                projectName = _projectManager.CurrentProject?.Name ?? "Unknown",
                radius, resolution, useSprites, overlay,
                pickCount = picksInfo.Count,
                lbsCovered = coveredLbs.Count,
                totalSpawnCount,
                picks = picksInfo,
            };
            string manifestPath = Path.Combine(outDir, "manifest.json");
            File.WriteAllText(manifestPath,
                JsonSerializer.Serialize(manifestObj, new JsonSerializerOptions(GalleryJsonOpts) {
                    WriteIndented = true,
                }));

            // Also emit manifest.js so the viewer can load the data without
            // fetch() (file:// works). Mirrors the static site's JSONP pattern.
            string manifestJsPath = Path.Combine(outDir, "manifest.js");
            File.WriteAllText(manifestJsPath,
                "var RENDER_GALLERY = " + JsonSerializer.Serialize(manifestObj, GalleryJsonOpts) + ";\n");

            // Copy the Tailwind viewer template + asset(s) verbatim.
            string indexPath = Path.Combine(outDir, "index.html");
            CopyRenderGalleryTemplate(outDir);

            return new RenderGalleryResult(
                Success: true,
                PicksRendered: picksInfo.Count,
                LbsCovered: coveredLbs.Count,
                TotalSpawnCount: totalSpawnCount,
                OutDir: outDir,
                IndexPath: indexPath,
                ManifestPath: manifestPath,
                Picks: picksInfo);
        } catch (Exception ex) {
            return new RenderGalleryResult(false, 0, 0, 0, outDir, "", "", new(), ex.Message);
        }
    }

    /// <summary>
    /// Emit a manifest+JSON view of the description that's small enough for
    /// the side panel without dropping the fields the viewer needs.
    /// Strips the per-object index when it exceeds 500 entries (the panel
    /// doesn't render it; saves bytes for dense LBs).
    /// </summary>
    private static string SerializeDescriptionForGallery(
            LandblockDescriber.LandblockDescriptionResult desc, out int spawnCount) {
        // Body is non-nullable on the result type, but the compiler still
        // flags the chained `?.` above as creating a nullable local. Read
        // it directly — describe-landblock always populates Body.
        spawnCount = desc.Body.Spawns?.Count ?? 0;
        // Trim ObjectIndex when very large — the viewer's side panel uses
        // the structured Spawns + Structures + verbal fields, not the raw
        // per-object index. 500 is an arbitrary "small enough" cap.
        var trimmed = desc.Body.ObjectIndex.Count > 500
            ? desc with { Body = desc.Body with { ObjectIndex = new() } }
            : desc;
        return JsonSerializer.Serialize(trimmed, GalleryJsonOpts);
    }

    private static string Slugify(string title, ushort lbKey) {
        if (string.IsNullOrWhiteSpace(title)) return $"lb_{lbKey:x4}";
        var sb = new StringBuilder(title.Length);
        foreach (var c in title.ToLowerInvariant()) {
            if (char.IsLetterOrDigit(c)) sb.Append(c);
            else if (sb.Length > 0 && sb[sb.Length - 1] != '_') sb.Append('_');
        }
        var s = sb.ToString().Trim('_');
        if (s.Length == 0) s = $"lb_{lbKey:x4}";
        if (s.Length > 60) s = s.Substring(0, 60).TrimEnd('_');
        return s;
    }

    private static void CopyRenderGalleryTemplate(string outDir) {
        // Mirror StaticSiteEmitter.ResolveStaticSiteRoot pattern: prefer the
        // template next to the running assembly (CopyToOutputDirectory) with
        // a source-tree fallback so `dotnet run` from the repo also works.
        var asmDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string? templateRoot = null;
        if (asmDir != null) {
            var beside = Path.Combine(asmDir, "RenderGallery");
            if (Directory.Exists(beside)) templateRoot = beside;
            else {
                var sourceTree = Path.GetFullPath(Path.Combine(asmDir, "..", "..", "..", "RenderGallery"));
                if (Directory.Exists(sourceTree)) templateRoot = sourceTree;
            }
        }
        if (templateRoot == null) {
            // Last-ditch: write a minimal index that surfaces the manifest
            // as JSON so callers can still consume the deliverable.
            File.WriteAllText(Path.Combine(outDir, "index.html"),
                MinimalFallbackIndex());
            return;
        }
        foreach (var src in Directory.EnumerateFiles(templateRoot, "*", SearchOption.AllDirectories)) {
            var rel = Path.GetRelativePath(templateRoot, src);
            var dst = Path.Combine(outDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            File.Copy(src, dst, overwrite: true);
        }
    }

    private static string MinimalFallbackIndex() => """
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Render Gallery (fallback)</title></head>
<body style="font-family:system-ui;max-width:60rem;margin:2rem auto;">
<h1>Render Gallery — fallback view</h1>
<p>The Tailwind template was not found alongside the binary. Manifest:</p>
<pre id="m">loading…</pre>
<script src="manifest.js"></script>
<script>document.getElementById('m').textContent = JSON.stringify(window.RENDER_GALLERY, null, 2);</script>
</body></html>
""";

    // ── serve-render-gallery ──────────────────────────────────────────────────

    /// <summary>
    /// Serve a directory over HTTP using a minimal C# HttpListener (no
    /// Python dependency). Returns immediately with a process-handle ID
    /// for the listener thread; the listener runs in the background until
    /// the engine exits.
    /// </summary>
    public ServeRenderGalleryResult ServeRenderGallery(string outDir, int port = 8090, string bind = "0.0.0.0") {
        try {
            if (!Directory.Exists(outDir)) {
                return new ServeRenderGalleryResult(false, "", null, 0, port, bind, outDir,
                    $"Output directory not found: {outDir}");
            }
            string prefix = $"http://{bind}:{port}/";
            var listener = new HttpListener();
            // HttpListener requires "+" or "*" for any-host on Windows; on
            // Linux/macOS, "0.0.0.0" works directly. Translate eagerly.
            var safePrefix = prefix.Replace("0.0.0.0", "+");
            listener.Prefixes.Add(safePrefix);
            try {
                listener.Start();
            } catch (HttpListenerException ex) {
                return new ServeRenderGalleryResult(false, "", null, 0, port, bind, outDir,
                    $"Failed to bind {safePrefix}: {ex.Message}");
            }

            var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            string baseUrl = $"http://{(bind == "0.0.0.0" ? "localhost" : bind)}:{port}/";
            string? tailscaleUrl = TryDetectTailscaleIp() is string tsIp
                ? $"http://{tsIp}:{port}/"
                : null;

            // Background pump: serve files out of outDir until the engine
            // exits or the listener is forcibly closed. Each request is
            // self-contained; no per-listener state worth tracking here
            // beyond the directory.
            var rootFull = Path.GetFullPath(outDir);
            var pump = new System.Threading.Thread(() => RunStaticServer(listener, rootFull)) {
                IsBackground = true,
                Name = $"render-gallery-server-{port}",
            };
            pump.Start();

            return new ServeRenderGalleryResult(
                Success: true,
                Url: baseUrl,
                TailscaleUrl: tailscaleUrl,
                Pid: pid,
                Port: port,
                Bind: bind,
                OutDir: rootFull);
        } catch (Exception ex) {
            return new ServeRenderGalleryResult(false, "", null, 0, port, bind, outDir, ex.Message);
        }
    }

    private static void RunStaticServer(HttpListener listener, string rootFull) {
        // Why a hand-rolled handler: no NuGet dependency, no ASP.NET. The
        // gallery dist is a few PNGs + JSON files — an 80-line dispatcher
        // serves it correctly. Errors degrade to plain-text 404/500 so a
        // misconfigured tailnet client can read them.
        while (listener.IsListening) {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { return; }
            try {
                ServeRequest(ctx, rootFull);
            } catch (Exception ex) {
                try {
                    ctx.Response.StatusCode = 500;
                    using var sw = new StreamWriter(ctx.Response.OutputStream);
                    sw.Write($"500: {ex.Message}");
                } catch { }
            } finally {
                try { ctx.Response.Close(); } catch { }
            }
        }
    }

    private static void ServeRequest(HttpListenerContext ctx, string rootFull) {
        string urlPath = ctx.Request.Url?.AbsolutePath ?? "/";
        if (urlPath == "/") urlPath = "/index.html";
        // Path safety: collapse and verify the resolved file lives under
        // rootFull. Without this, a `..%2F..%2Fetc%2Fpasswd` request would
        // walk out of outDir and serve arbitrary files. HttpListener
        // already URL-decodes the path; combining + GetFullPath catches
        // traversal even when the OS strips redundant separators.
        var rel = urlPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var resolved = Path.GetFullPath(Path.Combine(rootFull, rel));
        if (!resolved.StartsWith(rootFull, StringComparison.Ordinal)) {
            ctx.Response.StatusCode = 403;
            return;
        }
        if (!File.Exists(resolved)) {
            ctx.Response.StatusCode = 404;
            using var sw = new StreamWriter(ctx.Response.OutputStream);
            sw.Write($"404: {urlPath}");
            return;
        }
        ctx.Response.ContentType = GuessMime(resolved);
        ctx.Response.StatusCode = 200;
        using var fs = File.OpenRead(resolved);
        fs.CopyTo(ctx.Response.OutputStream);
    }

    private static string GuessMime(string path) {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch {
            ".html" or ".htm" => "text/html; charset=utf-8",
            ".js" => "application/javascript; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".svg" => "image/svg+xml",
            ".webp" => "image/webp",
            ".woff" => "font/woff",
            ".woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
    }

    private static string? TryDetectTailscaleIp() {
        // Tailscale advertises IPs in the 100.64.0.0/10 carrier-NAT range
        // (CGNAT). Pick the first IPv4 NIC address in that range; if none
        // is present, return null so callers know the host isn't on a
        // tailnet.
        try {
            foreach (var nic in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()) {
                if (nic.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                var props = nic.GetIPProperties();
                foreach (var u in props.UnicastAddresses) {
                    if (u.Address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) continue;
                    var bytes = u.Address.GetAddressBytes();
                    if (bytes.Length != 4) continue;
                    if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127) {
                        return u.Address.ToString();
                    }
                }
            }
        } catch { /* not all hosts allow NIC enumeration; non-fatal */ }
        return null;
    }
}
