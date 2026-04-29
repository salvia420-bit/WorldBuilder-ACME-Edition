using System.Reflection;
using System.Text;
using System.Text.Json;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Terminal;

/// <summary>
/// Composes the per-project static deliverable: tile pyramid, sprite atlas,
/// per-LB descriptions and dungeon graphs, gazetteer overlays, frontend
/// bundle, and a top-level <c>manifest.js</c> that lets the frontend list
/// every project that's been emitted into the same dist root.
///
/// Multi-project support is non-destructive: a second invocation against a
/// different project slug merges into the existing dist rather than wiping
/// it. The manifest gets updated to include both.
/// </summary>
public static class StaticSiteEmitter {

    private static readonly JsonSerializerOptions JsonOpts = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public sealed record EmissionStats(
        string ProjectSlug,
        string OutDir,
        int LbsDescribed,
        int DungeonsEmitted,
        int OverlaysEmitted,
        int TilesAtMaxZoom,
        int FrontendFilesCopied,
        int ManifestProjectCount);

    public static EmissionStats Emit(CommandEngine engine, string projectSlug, string outDir,
            IReadOnlyList<ushort>? lbFilter, int maxZoom, int minZoom,
            bool emitObjectTier, bool emitFloorTier, int throttleMs = 0) {
        Directory.CreateDirectory(outDir);

        var p = engine.ProjectManager.CurrentProject!;
        var projectsDir = Path.Combine(outDir, "projects");
        var projectDir = Path.Combine(projectsDir, projectSlug);
        Directory.CreateDirectory(projectDir);

        // 1. Tile pyramid → projects/<slug>/tiles/
        var tilesDir = Path.Combine(projectDir, "tiles");
        var pyramidResult = engine.EmitTilePyramid(
            lbFilter, tilesDir, maxZoom, minZoom,
            dirtyOnly: false, emitObjectLayer: emitObjectTier, emitFloorLayer: emitFloorTier,
            throttleMs: throttleMs);

        // 2. Sprite atlas: copy from project sprites/ into dist sprites/.
        int spriteCopyCount = CopyProjectSpritesIfPresent(p.ProjectDirectory, projectDir);

        // 3. Per-LB descriptions and dungeon graphs.
        var (described, dungeonsEmitted, lbList, dungeonLbs) =
            EmitPerLbAssets(engine, projectDir, lbFilter);

        // 4. Overlays from the project's gazetteer files (if present).
        int overlayCount = EmitOverlays(p.ProjectDirectory, projectDir);

        // 5. meta.js — index of LB list, dungeon LBs, floor counts.
        EmitMeta(projectDir, projectSlug, lbList, dungeonLbs, engine);

        // 6. Frontend bundle. Copy from the assembly's StaticSite/ resources
        //    (resolved relative to the binary, with a source-tree fallback so
        //    `dotnet run` from the repo also works).
        int frontendCopied = CopyFrontendBundle(outDir);

        // 7. manifest.js — merges with existing for multi-project.
        int projectCount = WriteManifest(outDir, projectSlug, p.Name ?? projectSlug,
            pyramidResult.MaxZoom, pyramidResult.MinZoom);

        // 8. README per-project (one paragraph).
        File.WriteAllText(Path.Combine(projectDir, "README.txt"),
            $"Project: {projectSlug}\n" +
            $"Generated: {DateTime.UtcNow:O}\n\n" +
            "This folder is the static-site deliverable for one WorldBuilder " +
            "project. Open ../../index.html in any browser (file:// works) to " +
            "view it. Re-running emit-static-site against a different project " +
            "into the same parent folder appends to the manifest rather than " +
            "replacing it.\n");

        return new EmissionStats(projectSlug, outDir, described, dungeonsEmitted, overlayCount,
            pyramidResult.ExteriorTilesAtMaxZoom, frontendCopied, projectCount);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Per-LB assets: desc/<lbHex>.js + dungeons/<lbHex>.js
    // ────────────────────────────────────────────────────────────────────

    private static (int described, int dungeonsEmitted,
                    List<string> lbList, List<string> dungeonLbs) EmitPerLbAssets(
            CommandEngine engine, string projectDir, IReadOnlyList<ushort>? lbFilter) {
        var descDir = Path.Combine(projectDir, "desc");
        var dungeonsDir = Path.Combine(projectDir, "dungeons");
        Directory.CreateDirectory(descDir);
        Directory.CreateDirectory(dungeonsDir);

        var lbsToProcess = ResolveLbList(engine, lbFilter);
        var lbList = new List<string>();
        var dungeonLbs = new List<string>();
        int described = 0, dungeonsEmitted = 0;

        foreach (var lbKey in lbsToProcess) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);
            string hex = $"0x{lbKey:X4}";

            try {
                var desc = engine.DescribeLandblock(lbX, lbY);
                File.WriteAllText(Path.Combine(descDir, $"{hex}.js"),
                    BuildLoadCall("LOAD_DESC", hex, JsonSerializer.Serialize(desc, JsonOpts)));
                described++;
                lbList.Add(hex);
            } catch {
                // LBs without terrain or doc may throw; skip silently.
            }

            // Dungeon graph: only if the LB has a populated dungeon doc.
            try {
                int floorCount = engine.GetDungeonFloorCount(lbKey);
                if (floorCount > 0) {
                    var dungeonPayload = BuildDungeonPayload(engine, lbKey, floorCount);
                    File.WriteAllText(Path.Combine(dungeonsDir, $"{hex}.js"),
                        BuildLoadCall("LOAD_DUNGEON", hex, dungeonPayload));
                    dungeonsEmitted++;
                    dungeonLbs.Add(hex);
                }
            } catch { /* skip cleanly */ }
        }

        return (described, dungeonsEmitted, lbList, dungeonLbs);
    }

    private static string BuildDungeonPayload(CommandEngine engine, ushort lbKey, int floorCount) {
        // The dungeon payload is a join of cell footprints + per-floor describer
        // results. The frontend uses cell polygons to render the floor map and
        // the verbal summary in the side panel.
        uint lbX = (uint)((lbKey >> 8) & 0xFF);
        uint lbY = (uint)(lbKey & 0xFF);
        var floors = new List<object>(floorCount);
        for (int f = 0; f < floorCount; f++) {
            var fr = engine.DescribeFloor(lbX, lbY, f);
            floors.Add(new {
                index = fr.FloorIndex,
                zMin = fr.ZMin, zMax = fr.ZMax,
                cellCount = fr.CellCount,
                cellResidentObjects = fr.CellResidentObjects,
                looseObjectsInFloor = fr.LooseObjectsInFloor,
                verbal = fr.Verbal,
            });
        }
        return JsonSerializer.Serialize(new {
            landblock = $"0x{lbKey:X4}",
            floorCount,
            floors,
        }, JsonOpts);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Overlays
    // ────────────────────────────────────────────────────────────────────

    private static int EmitOverlays(string projectSrcDir, string projectDistDir) {
        var overlaysDir = Path.Combine(projectDistDir, "overlays");
        Directory.CreateDirectory(overlaysDir);
        int count = 0;
        count += CopyGazetteerAsOverlay(projectSrcDir, overlaysDir, "town_gazetteer.json", "towns") ? 1 : 0;
        count += CopyGazetteerAsOverlay(projectSrcDir, overlaysDir, "poi_gazetteer.json", "pois") ? 1 : 0;
        count += CopyGazetteerAsOverlay(projectSrcDir, overlaysDir, "spawn_gazetteer.json", "spawns") ? 1 : 0;
        // Synthetic landblock grid overlay — every LB is a 192×192 wu square
        // anchored at (lbX*192, lbY*192). The frontend draws grid lines from
        // this list.
        File.WriteAllText(Path.Combine(overlaysDir, "grid.js"),
            BuildLoadOverlay("grid",
                JsonSerializer.Serialize(new {
                    landblockSize = 192,
                    worldExtent = 49152,
                    gridSize = 256,
                }, JsonOpts)));
        count++;
        return count;
    }

    private static bool CopyGazetteerAsOverlay(string srcDir, string overlaysDir, string srcName, string overlayName) {
        var src = Path.Combine(srcDir, srcName);
        if (!File.Exists(src)) return false;
        var raw = File.ReadAllText(src);
        // Validate it's parseable JSON; if not, skip.
        try { using var _ = JsonDocument.Parse(raw); }
        catch { return false; }
        File.WriteAllText(Path.Combine(overlaysDir, $"{overlayName}.js"),
            BuildLoadOverlay(overlayName, raw));
        return true;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Sprite atlas copy
    // ────────────────────────────────────────────────────────────────────

    private static int CopyProjectSpritesIfPresent(string projectSrcDir, string projectDistDir) {
        var srcSprites = Path.Combine(projectSrcDir, "sprites");
        if (!Directory.Exists(srcSprites)) return 0;
        var dstSprites = Path.Combine(projectDistDir, "sprites");
        Directory.CreateDirectory(dstSprites);

        int copied = 0;
        var atlasPng = Path.Combine(srcSprites, "atlas.png");
        if (File.Exists(atlasPng)) {
            File.Copy(atlasPng, Path.Combine(dstSprites, "atlas.png"), overwrite: true);
            copied++;
        }
        // Re-emit the manifest as a JSONP-style atlas.js so file:// works
        // without fetch().
        var manifestPath = Path.Combine(srcSprites, "manifest.jsonl");
        if (File.Exists(manifestPath)) {
            var entries = new Dictionary<string, object>();
            foreach (var line in File.ReadLines(manifestPath)) {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var modelId = root.GetProperty("modelId").GetString() ?? "";
                entries[modelId] = new {
                    x = root.GetProperty("x").GetInt32(),
                    y = root.GetProperty("y").GetInt32(),
                    w = root.GetProperty("w").GetInt32(),
                    h = root.GetProperty("h").GetInt32(),
                    worldBounds = new[] {
                        root.GetProperty("worldBounds")[0].GetSingle(),
                        root.GetProperty("worldBounds")[1].GetSingle(),
                    },
                };
            }
            var atlasJs = "const SPRITE_ATLAS = " + JsonSerializer.Serialize(entries, JsonOpts) + ";\n";
            File.WriteAllText(Path.Combine(dstSprites, "atlas.js"), atlasJs);
            copied++;
        }
        return copied;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Frontend bundle copy
    // ────────────────────────────────────────────────────────────────────

    private static int CopyFrontendBundle(string outDir) {
        var staticSiteRoot = ResolveStaticSiteRoot();
        if (staticSiteRoot == null) return 0;
        int copied = 0;
        foreach (var src in Directory.EnumerateFiles(staticSiteRoot, "*", SearchOption.AllDirectories)) {
            var rel = Path.GetRelativePath(staticSiteRoot, src);
            var dst = Path.Combine(outDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            File.Copy(src, dst, overwrite: true);
            copied++;
        }
        return copied;
    }

    private static string? ResolveStaticSiteRoot() {
        // Prefer next to the running assembly (works for `dotnet publish`
        // outputs and Content<CopyToOutputDirectory>). Fall back to the
        // source tree relative to the assembly so `dotnet run` from the repo
        // also works without a build-output copy.
        var asmDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (asmDir != null) {
            var beside = Path.Combine(asmDir, "StaticSite");
            if (Directory.Exists(beside)) return beside;
            // bin/Debug/net8.0 → ../../../StaticSite when CopyToOutputDirectory hasn't run
            var sourceTree = Path.GetFullPath(Path.Combine(asmDir, "..", "..", "..", "StaticSite"));
            if (Directory.Exists(sourceTree)) return sourceTree;
        }
        return null;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Manifest + meta
    // ────────────────────────────────────────────────────────────────────

    private static void EmitMeta(string projectDir, string slug,
            List<string> lbList, List<string> dungeonLbs, CommandEngine engine) {
        var floorCounts = new Dictionary<string, int>();
        foreach (var hex in dungeonLbs) {
            if (ushort.TryParse(hex.AsSpan(2), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var lbKey)) {
                try {
                    floorCounts[hex] = engine.GetDungeonFloorCount(lbKey);
                } catch { }
            }
        }
        var meta = new {
            slug,
            lbList = lbList.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            dungeonLbs = dungeonLbs.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            floorCounts,
            generated = DateTime.UtcNow.ToString("o"),
        };
        // Why: top-level `const` in a classic <script> is script-scoped — it
        // does NOT create a property on `window`, so `window['PROJECT_<slug>']`
        // returns undefined when the frontend tries to look it up. `var` does
        // attach to window, which is the JSONP convention.
        var js = $"var PROJECT_{SafeSlugForJs(slug)} = " + JsonSerializer.Serialize(meta, JsonOpts) + ";\n";
        File.WriteAllText(Path.Combine(projectDir, "meta.js"), js);
    }

    private static int WriteManifest(string outDir, string slug, string projectName,
            int maxZoom, int minZoom) {
        var manifestPath = Path.Combine(outDir, "manifest.js");
        // Existing manifest? Parse out the projects array (best-effort) and
        // merge. Why: re-running emit-static-site against a second project
        // must show both; nuking the manifest defeats multi-project support.
        var projects = new Dictionary<string, ManifestProject>(StringComparer.Ordinal);
        if (File.Exists(manifestPath)) {
            try {
                var existing = ReadManifestProjects(File.ReadAllText(manifestPath));
                foreach (var (k, v) in existing) projects[k] = v;
            } catch { /* corrupt manifest → start fresh */ }
        }
        projects[slug] = new ManifestProject(slug, projectName, maxZoom, minZoom,
            DateTime.UtcNow.ToString("o"));

        var ordered = projects.Values.OrderBy(p => p.Slug, StringComparer.Ordinal).ToArray();
        var manifestObj = new {
            protocolVersion = 1,
            generated = DateTime.UtcNow.ToString("o"),
            defaultProject = ordered[0].Slug,
            projects = ordered.Select(p => new {
                slug = p.Slug, name = p.Name,
                maxZoom = p.MaxZoom, minZoom = p.MinZoom,
                generated = p.Generated,
                metaPath = $"projects/{p.Slug}/meta.js",
            }).ToArray(),
        };
        // Same `var`-not-`const` reasoning as meta.js: top-level const in a
        // classic <script> doesn't create a window property.
        var js = "var MANIFEST = " + JsonSerializer.Serialize(manifestObj, JsonOpts) + ";\n";
        File.WriteAllText(manifestPath, js);
        return ordered.Length;
    }

    private sealed record ManifestProject(string Slug, string Name, int MaxZoom, int MinZoom, string Generated);

    private static Dictionary<string, ManifestProject> ReadManifestProjects(string manifestJs) {
        var result = new Dictionary<string, ManifestProject>(StringComparer.Ordinal);
        // Strip the `const MANIFEST = ` prefix and trailing `;` to recover JSON.
        var trimmed = manifestJs.TrimStart();
        // Accept both `var` (current emitter) and `const` (legacy dists from
        // the initial Phase 4 emit) so the merge path doesn't break against
        // a manifest a previous version produced.
        const string varPrefix = "var MANIFEST = ";
        const string constPrefix = "const MANIFEST = ";
        string prefix;
        if (trimmed.StartsWith(varPrefix, StringComparison.Ordinal)) prefix = varPrefix;
        else if (trimmed.StartsWith(constPrefix, StringComparison.Ordinal)) prefix = constPrefix;
        else return result;
        var json = trimmed.Substring(prefix.Length).TrimEnd().TrimEnd(';');
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("projects", out var arr)) return result;
        foreach (var p in arr.EnumerateArray()) {
            string slug = p.GetProperty("slug").GetString() ?? "";
            if (string.IsNullOrEmpty(slug)) continue;
            result[slug] = new ManifestProject(
                slug,
                p.TryGetProperty("name", out var n) ? n.GetString() ?? slug : slug,
                p.TryGetProperty("maxZoom", out var mxz) ? mxz.GetInt32() : 12,
                p.TryGetProperty("minZoom", out var mnz) ? mnz.GetInt32() : 3,
                p.TryGetProperty("generated", out var g) ? g.GetString() ?? "" : "");
        }
        return result;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────────────

    private static string BuildLoadCall(string fnName, string lbHex, string jsonPayload) =>
        $"{fnName}('{lbHex}', {jsonPayload});\n";

    private static string BuildLoadOverlay(string overlayName, string jsonPayload) =>
        $"LOAD_OVERLAY('{overlayName}', {jsonPayload});\n";

    private static string SafeSlugForJs(string slug) {
        var sb = new StringBuilder(slug.Length);
        foreach (var c in slug) {
            sb.Append(char.IsLetterOrDigit(c) ? c : '_');
        }
        if (sb.Length == 0 || char.IsDigit(sb[0])) sb.Insert(0, '_');
        return sb.ToString();
    }

    private static List<ushort> ResolveLbList(CommandEngine engine, IReadOnlyList<ushort>? lbFilter) {
        if (lbFilter is { Count: > 0 }) return new List<ushort>(lbFilter);
        var ids = engine.ProjectManager.CurrentProject!.DocumentManager.DocumentStorageService
            .ListDocumentIdsAsync().GetAwaiter().GetResult();
        var keys = new HashSet<ushort>();
        foreach (var id in ids) {
            string? hex = id.StartsWith("landblock_", StringComparison.Ordinal) ? id.Substring("landblock_".Length)
                : id.StartsWith("dungeon_", StringComparison.Ordinal) ? id.Substring("dungeon_".Length)
                : null;
            if (hex == null) continue;
            if (ushort.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var k))
                keys.Add(k);
        }
        return keys.OrderBy(k => k).ToList();
    }
}
