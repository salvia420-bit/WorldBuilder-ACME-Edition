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
        int ObjectTilesAtMaxZoom,
        int FloorTilesWritten,
        int FrontendFilesCopied,
        int ManifestProjectCount,
        int DiagnosticCount);

    private sealed record Diagnostic(string Severity, string Source, string Message);

    public static EmissionStats Emit(CommandEngine engine, string projectSlug, string outDir,
            IReadOnlyList<ushort>? lbFilter, int maxZoom, int minZoom,
            bool emitObjectTier, bool emitFloorTier, int throttleMs = 0,
            string tileFormat = "png") {
        Directory.CreateDirectory(outDir);

        var p = engine.ProjectManager.CurrentProject!;
        var projectsDir = Path.Combine(outDir, "projects");
        var projectDir = Path.Combine(projectsDir, projectSlug);
        Directory.CreateDirectory(projectDir);

        // Diagnostics aggregated across every step. Surfaced via the
        // diagnostics.js overlay (the frontend reads it on boot) and in the
        // EmissionStats so a stdin/stdout caller knows whether to look.
        var diagnostics = new List<Diagnostic>();

        // 1. Tile pyramid → projects/<slug>/tiles/
        var tilesDir = Path.Combine(projectDir, "tiles");
        var pyramidResult = engine.EmitTilePyramid(
            lbFilter, tilesDir, maxZoom, minZoom,
            dirtyOnly: false, emitObjectLayer: emitObjectTier, emitFloorLayer: emitFloorTier,
            throttleMs: throttleMs, tileFormat: tileFormat);

        // 2. Sprite atlas: copy from project sprites/ into dist sprites/.
        int spriteCopyCount = CopyProjectSpritesIfPresent(p.ProjectDirectory, projectDir, diagnostics);

        // 3. Per-LB descriptions and dungeon graphs.
        var (described, dungeonsEmitted, lbList, dungeonLbs) =
            EmitPerLbAssets(engine, projectDir, lbFilter, diagnostics);

        // 4. Overlays from the project's gazetteer files (if present).
        // The spawns overlay is filtered to the emitted lbList (millions of
        // spawn records won't fit in a single overlay file the browser can
        // parse — without the filter the JSONP grew to 80MB+ and stalled the
        // boot loader at ~4%).
        var (overlayCount, overlayNames) = EmitOverlays(engine, p.ProjectDirectory, projectDir, lbList, diagnostics);

        // 4b. Spawn-sprite coverage: count how many spawn-gazetteer entries
        //     resolve to a sprite atlas hit vs. fall through to a category
        //     glyph (often a 4px dot — the "small dark circle" failure
        //     mode). Surfaced as info-tier diagnostics so a frontend user
        //     can see how much of the world is rendering as glyphs and
        //     drill into the top wcids that need atlas coverage.
        ReportSpawnSpriteCoverage(engine, lbList, diagnostics);

        // 5. meta.js — index of LB list, dungeon LBs, floor counts, overlay names.
        EmitMeta(projectDir, projectSlug, lbList, dungeonLbs, overlayNames, engine, tileFormat);

        // 5b. dungeons.js — per-LB floor count + per-floor cell count map.
        // Exposed as JSONP (LOAD_DUNGEONS) so the frontend can surface the
        // per-floor density in floor-selector tooltips without a second
        // round-trip per dungeon LB. Independent of meta.js so a frontend
        // can opt into the richer view without breaking older dists.
        EmitDungeonsManifest(projectDir, dungeonLbs, engine);

        // 5c. search_index.js — flat list of NPCs/towns/dungeons for the
        // index/list views. Frontend filters client-side; no server search
        // round-trip. Capped at 5MB-after-gzip; CommandEngine bounds NPCs
        // to 5000 entries.
        EmitSearchIndex(projectDir, lbList, dungeonLbs, engine);

        // 6. Frontend bundle. Copy from the assembly's StaticSite/ resources
        //    (resolved relative to the binary, with a source-tree fallback so
        //    `dotnet run` from the repo also works).
        int frontendCopied = CopyFrontendBundle(outDir, diagnostics);

        // 7. manifest.js — merges with existing for multi-project.
        int projectCount = WriteManifest(outDir, projectSlug, p.Name ?? projectSlug,
            pyramidResult.MaxZoom, pyramidResult.MinZoom, diagnostics);

        // 8. README per-project (one paragraph).
        File.WriteAllText(Path.Combine(projectDir, "README.txt"),
            $"Project: {projectSlug}\n" +
            $"Generated: {DateTime.UtcNow:O}\n\n" +
            "This folder is the static-site deliverable for one WorldBuilder " +
            "project. Open ../../index.html in any browser (file:// works) to " +
            "view it. Re-running emit-static-site against a different project " +
            "into the same parent folder appends to the manifest rather than " +
            "replacing it.\n");

        // 9. diagnostics.js — must be the last thing written so it captures
        //    issues raised by every preceding step.
        WriteDiagnosticsOverlay(projectDir, diagnostics);

        return new EmissionStats(projectSlug, outDir, described, dungeonsEmitted, overlayCount,
            pyramidResult.ExteriorTilesAtMaxZoom, pyramidResult.ObjectTilesAtMaxZoom,
            pyramidResult.FloorTilesWritten, frontendCopied, projectCount, diagnostics.Count);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Per-LB assets: desc/<lbHex>.js + dungeons/<lbHex>.js
    // ────────────────────────────────────────────────────────────────────

    private static (int described, int dungeonsEmitted,
                    List<string> lbList, List<string> dungeonLbs) EmitPerLbAssets(
            CommandEngine engine, string projectDir, IReadOnlyList<ushort>? lbFilter,
            List<Diagnostic> diagnostics) {
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

            // "Expected" misses: LBs without terrain or document state.
            // Anything else (IOException, OOM, NRE from a regression) we
            // surface — silent catch-all hid bugs as a quiet count drop.
            try {
                var desc = engine.DescribeLandblock(lbX, lbY);
                File.WriteAllText(Path.Combine(descDir, $"{hex}.js"),
                    BuildLoadCall("LOAD_DESC", hex, JsonSerializer.Serialize(desc, JsonOpts)));
                described++;
                lbList.Add(hex);
            } catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException
                                            or FileNotFoundException) {
                // Expected — LB has no doc / no terrain. Don't even add to
                // diagnostics; this is the steady-state for "describe every
                // possible LB key" scans.
            } catch (Exception ex) {
                diagnostics.Add(new Diagnostic("warning", "describe:" + hex,
                    $"DescribeLandblock threw {ex.GetType().Name}: {ex.Message}"));
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
            } catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException
                                            or FileNotFoundException) {
                // Expected — no dungeon doc.
            } catch (Exception ex) {
                diagnostics.Add(new Diagnostic("warning", "dungeon:" + hex,
                    $"GetDungeonFloorCount threw {ex.GetType().Name}: {ex.Message}"));
            }
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

    private static (int count, List<string> names) EmitOverlays(CommandEngine engine,
            string projectSrcDir, string projectDistDir, IReadOnlyList<string> lbList,
            List<Diagnostic> diagnostics) {
        var overlaysDir = Path.Combine(projectDistDir, "overlays");
        Directory.CreateDirectory(overlaysDir);

        // Spawns overlay is always emitted from the in-memory gazetteer (joined
        // with WeenieIndex for canonical title / icon DID). This unifies the
        // wire shape across LSD, ACE-DB, and synthetic sources — previously
        // CopyGazetteerAsOverlay only worked when spawn_gazetteer.json (LSD
        // shape) was present, so projects using ace_spawn_records.jsonl had an
        // empty spawns overlay even with thousands of records loaded.
        var names = new List<string>();
        int count = 0;
        if (EmitSpawnsOverlay(engine, overlaysDir, lbList, diagnostics)) {
            count++;
            names.Add("spawns");
        }

        // Pre-compute the wcid set across the emitted lbList. Used to trim
        // creature/npc rosters to wcids the project actually uses — the rosters
        // are world-wide arrays without per-record position, so without this
        // filter every emit shipped the full ~5MB of creature + NPC templates
        // even for a 9-LB region.
        var wcidsInLbList = engine.WcidsInLbs(lbList);

        // OverlaySources (everything except spawns):
        //   srcName     — gazetteer JSON in the project directory.
        //   overlayName — final overlays/<overlayName>.js name.
        //   filterMode  — how to trim to lbList:
        //                 None         → byte-copy as-is (small, world-wide is fine)
        //                 LbDictKey    → JSON object keyed by "0xLLLL" → keep matching keys
        //                 LbFieldArr   → JSON array, each rec has "landblock":"0xLLLL"
        //                 WcidFieldArr → JSON array, each rec has "wcid":int → keep wcids in spawns
        //   missingNote — stub message for the diagnostics overlay when
        //                 the source isn't present (so the frontend can
        //                 surface "no creatures: source missing" instead
        //                 of failing the JSONP load silently).
        var overlaySources = new (string srcName, string overlayName, OverlayFilterMode mode, string missingNote)[] {
            ("town_gazetteer.json",     "towns",     OverlayFilterMode.None,         "no town_gazetteer.json in project"),
            ("poi_gazetteer.json",      "pois",      OverlayFilterMode.LbDictKey,    "no poi_gazetteer.json in project"),
            ("creature_gazetteer.json", "creatures", OverlayFilterMode.WcidFieldArr, "no creature_gazetteer.json (run ace-db ingest-creatures)"),
            ("npc_gazetteer.json",      "npcs",      OverlayFilterMode.WcidFieldArr, "no npc_gazetteer.json (run ace-db ingest-npcs)"),
            ("housing_gazetteer.json",  "housing",   OverlayFilterMode.LbFieldArr,   "no housing_gazetteer.json (run ace-db ingest-housing)"),
        };
        foreach (var (src, overlay, mode, note) in overlaySources) {
            if (CopyGazetteerAsOverlay(projectSrcDir, overlaysDir, src, overlay, mode, lbList, wcidsInLbList, diagnostics)) {
                count++;
            } else {
                // Always emit an empty stub so the frontend's JSONP loader
                // sees LOAD_OVERLAY('<name>', []) — no 404, no silent
                // failure. The diagnostic captures the 'why missing'.
                File.WriteAllText(Path.Combine(overlaysDir, $"{overlay}.js"),
                    BuildLoadOverlay(overlay, "[]"));
                diagnostics.Add(new Diagnostic("info", "overlay:" + overlay, note));
            }
            names.Add(overlay);
        }

        // Synthetic landblock grid overlay — config-only payload. The frontend
        // synthesizes grid lines locally; this payload exists so the frontend
        // can boot-assert it against its own constants (parallel to the
        // coordSystem contract). Bumping any value here without updating the
        // frontend is a load-time error rather than a silent visual drift.
        File.WriteAllText(Path.Combine(overlaysDir, "grid.js"),
            BuildLoadOverlay("grid",
                JsonSerializer.Serialize(new {
                    landblockSize = 192,
                    worldExtent = 49152,
                    gridSize = 256,
                }, JsonOpts)));
        count++;
        names.Add("grid");

        // Named-zone overlay — Voronoi tessellation of region centroids,
        // clipped to the world bounding rectangle. One feature per region;
        // properties carry the region name and the centroid for the label
        // anchor. Emitted as GeoJSON wrapped in the same JSONP loader as
        // every other overlay so file:// loading still works.
        if (EmitZonesOverlay(engine, overlaysDir, diagnostics)) {
            count++;
            names.Add("zones");
        } else {
            File.WriteAllText(Path.Combine(overlaysDir, "zones.js"),
                BuildLoadOverlay("zones",
                    JsonSerializer.Serialize(new { type = "FeatureCollection", features = Array.Empty<object>() }, JsonOpts)));
            diagnostics.Add(new Diagnostic("info", "overlay:zones",
                "no region anchors loaded — zones layer will be empty"));
            names.Add("zones");
            count++;
        }

        // diagnostics.js is written by Emit() at the very end so it captures
        // every preceding step's findings. Reserve its name in the overlay
        // list here so the frontend iterates it like any other overlay.
        names.Add("diagnostics");
        count++;
        return (count, names);
    }

    /// <summary>
    /// Emit overlays/spawns.js from the engine's in-memory spawn gazetteer
    /// joined against WeenieIndex. Filtered to the lbList that the per-LB
    /// emit actually wrote tiles for — without this filter, a small lbFilter
    /// emit would still produce a world-scale (80MB+) overlay that the
    /// frontend can't parse. When lbList is empty (full-world emit), all
    /// spawns are included.
    /// </summary>
    private static bool EmitSpawnsOverlay(CommandEngine engine, string overlaysDir,
            IReadOnlyList<string> lbList, List<Diagnostic> diagnostics) {
        var payload = engine.BuildSpawnsOverlayPayload();

        // Filter to the LBs actually emitted in this run. Frontend overlay
        // markers reference LBs by hex key; ones outside the project's lbList
        // would render at correct world coords but be invisible (no tiles
        // beneath them) and bloat the JSONP. The lbList strings already match
        // the "0xXXXX" key shape BuildSpawnsOverlayPayload uses.
        if (lbList.Count > 0) {
            var keep = new HashSet<string>(lbList, StringComparer.OrdinalIgnoreCase);
            var filtered = new Dictionary<string, IReadOnlyList<object>>(keep.Count);
            foreach (var (lbHex, recs) in payload) {
                if (keep.Contains(lbHex)) filtered[lbHex] = recs;
            }
            payload = filtered;
        }

        int totalSpawns = 0;
        foreach (var recs in payload.Values) totalSpawns += recs.Count;

        if (totalSpawns == 0) {
            // Match the missing-source stub shape so the frontend's loader
            // doesn't see a JSONP 404 — same defensive emit as the legacy
            // CopyGazetteerAsOverlay fallback.
            File.WriteAllText(Path.Combine(overlaysDir, "spawns.js"),
                BuildLoadOverlay("spawns", "{}"));
            diagnostics.Add(new Diagnostic("info", "overlay:spawns",
                "no spawns loaded — run ace-db ingest-spawns or ingest-spawn-maps"));
            return false;
        }

        File.WriteAllText(Path.Combine(overlaysDir, "spawns.js"),
            BuildLoadOverlay("spawns", JsonSerializer.Serialize(payload, JsonOpts)));
        diagnostics.Add(new Diagnostic("info", "overlay:spawns",
            $"emitted {totalSpawns:N0} spawns across {payload.Count:N0} landblocks"));
        return true;
    }

    private static void ReportSpawnSpriteCoverage(CommandEngine engine,
            IReadOnlyList<string> lbList, List<Diagnostic> diagnostics) {
        // Convert the lbList (hex strings produced by EmitPerLbAssets) back to
        // ushort keys for the analyzer. EmitPerLbAssets keeps everything in
        // sync via the same `0xXXXX` formatter.
        var lbKeys = new List<ushort>(lbList.Count);
        foreach (var hex in lbList) {
            var s = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? hex.Substring(2) : hex;
            if (ushort.TryParse(s, System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var k)) {
                lbKeys.Add(k);
            }
        }
        if (lbKeys.Count == 0) return;
        var coverage = engine.AnalyzeSpawnSpriteCoverage(lbKeys);
        if (coverage.TotalSpawns == 0) return;
        int covered = coverage.ResolvedWithSprite;
        int falling = coverage.ResolvedNoSprite + coverage.UnresolvedWcid;
        double pct = 100.0 * covered / coverage.TotalSpawns;
        string severity = pct < 50.0 ? "warning" : "info";
        diagnostics.Add(new Diagnostic(severity, "spawnSpriteCoverage",
            $"{covered:N0} of {coverage.TotalSpawns:N0} surface spawns " +
            $"({pct:F1}%) have a sprite; {falling:N0} fall back to glyph " +
            $"({coverage.UnresolvedWcid:N0} unresolved wcid, " +
            $"{coverage.ResolvedNoSprite:N0} resolved-but-no-sprite)."));
        if (coverage.TopMissingWcids.Count > 0) {
            diagnostics.Add(new Diagnostic("info", "spawnSpriteCoverage:topMissing",
                "Top missing wcids: " +
                string.Join(", ", coverage.TopMissingWcids)));
        }
    }

    private static void WriteDiagnosticsOverlay(string projectDir, List<Diagnostic> diagnostics) {
        var overlaysDir = Path.Combine(projectDir, "overlays");
        Directory.CreateDirectory(overlaysDir);
        // Project the internal record into the wire shape app.js expects.
        var issues = diagnostics.Select(d => new {
            overlay = d.Source, severity = d.Severity, message = d.Message,
        }).ToArray();
        File.WriteAllText(Path.Combine(overlaysDir, "diagnostics.js"),
            BuildLoadOverlay("diagnostics",
                JsonSerializer.Serialize(new {
                    generated = DateTime.UtcNow.ToString("o"),
                    issues,
                }, JsonOpts)));
    }

    /// <summary>
    /// How to trim a gazetteer overlay to the project's emitted lbList.
    /// Without filtering, every per-LB emit shipped the full world's
    /// pois/creatures/npcs/housing payloads (~4MB initial-load overhead
    /// for a 9-LB region).
    /// </summary>
    private enum OverlayFilterMode {
        /// <summary>Pass through unchanged. For tiny world-wide overlays.</summary>
        None,
        /// <summary>JSON object keyed by "0xLLLL"; keep keys in lbList.</summary>
        LbDictKey,
        /// <summary>JSON array of records with a "landblock":"0xLLLL" field.</summary>
        LbFieldArr,
        /// <summary>JSON array of records with a "wcid":int field; keep wcids in spawns.</summary>
        WcidFieldArr,
    }

    private static bool CopyGazetteerAsOverlay(string srcDir, string overlaysDir,
            string srcName, string overlayName, OverlayFilterMode filterMode,
            IReadOnlyList<string> lbList, IReadOnlySet<int> wcidsInLbs,
            List<Diagnostic> diagnostics) {
        var src = Path.Combine(srcDir, srcName);
        if (!File.Exists(src)) return false;
        string raw;
        try { raw = File.ReadAllText(src); }
        catch (Exception ex) {
            diagnostics.Add(new Diagnostic("warning", "overlay:" + overlayName,
                $"read failed: {ex.GetType().Name}: {ex.Message}"));
            return false;
        }
        // Validate it's parseable JSON; if not, surface why.
        try { using var _ = JsonDocument.Parse(raw); }
        catch (JsonException ex) {
            diagnostics.Add(new Diagnostic("warning", "overlay:" + overlayName,
                $"{srcName} is not valid JSON: {ex.Message}"));
            return false;
        }

        string output = raw;
        if (filterMode != OverlayFilterMode.None && lbList.Count > 0) {
            try {
                output = FilterGazetteer(raw, filterMode, lbList, wcidsInLbs, out int kept, out int total);
                diagnostics.Add(new Diagnostic("info", "overlay:" + overlayName,
                    $"filtered to lbList: {kept:N0} of {total:N0} records kept"));
            } catch (Exception ex) {
                // Filter failure → fall back to unfiltered emit so nothing is
                // hidden silently. The diagnostic flags it for follow-up.
                diagnostics.Add(new Diagnostic("warning", "overlay:" + overlayName,
                    $"filter failed ({ex.GetType().Name}: {ex.Message}); emitting unfiltered."));
                output = raw;
            }
        }

        File.WriteAllText(Path.Combine(overlaysDir, $"{overlayName}.js"),
            BuildLoadOverlay(overlayName, output));
        return true;
    }

    private static string FilterGazetteer(string raw, OverlayFilterMode mode,
            IReadOnlyList<string> lbList, IReadOnlySet<int> wcidsInLbs,
            out int kept, out int total) {
        var keepLbs = new HashSet<string>(lbList, StringComparer.OrdinalIgnoreCase);
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        kept = 0; total = 0;

        switch (mode) {
            case OverlayFilterMode.LbDictKey: {
                if (root.ValueKind != JsonValueKind.Object) return raw;
                var filtered = new Dictionary<string, JsonElement>();
                foreach (var prop in root.EnumerateObject()) {
                    total++;
                    if (keepLbs.Contains(prop.Name)) {
                        filtered[prop.Name] = prop.Value.Clone();
                        kept++;
                    }
                }
                return JsonSerializer.Serialize(filtered, JsonOpts);
            }
            case OverlayFilterMode.LbFieldArr: {
                if (root.ValueKind != JsonValueKind.Array) return raw;
                var keptItems = new List<JsonElement>();
                foreach (var item in root.EnumerateArray()) {
                    total++;
                    if (item.TryGetProperty("landblock", out var lbEl)
                            && lbEl.ValueKind == JsonValueKind.String
                            && keepLbs.Contains(lbEl.GetString() ?? "")) {
                        keptItems.Add(item.Clone());
                        kept++;
                    }
                }
                return JsonSerializer.Serialize(keptItems, JsonOpts);
            }
            case OverlayFilterMode.WcidFieldArr: {
                if (root.ValueKind != JsonValueKind.Array) return raw;
                var keptItems = new List<JsonElement>();
                foreach (var item in root.EnumerateArray()) {
                    total++;
                    if (item.TryGetProperty("wcid", out var wEl)
                            && wEl.ValueKind == JsonValueKind.Number
                            && wcidsInLbs.Contains(wEl.GetInt32())) {
                        keptItems.Add(item.Clone());
                        kept++;
                    }
                }
                return JsonSerializer.Serialize(keptItems, JsonOpts);
            }
            default:
                return raw;
        }
    }

    // ────────────────────────────────────────────────────────────────────
    //  Sprite atlas copy
    // ────────────────────────────────────────────────────────────────────

    private static int CopyProjectSpritesIfPresent(string projectSrcDir, string projectDistDir,
            List<Diagnostic> diagnostics) {
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
            int lineNo = 0, badLines = 0;
            foreach (var line in File.ReadLines(manifestPath)) {
                lineNo++;
                if (string.IsNullOrWhiteSpace(line)) continue;
                // Per-line guard: a single malformed JSONL row used to abort
                // the whole emit. Surface the bad line via diagnostics and
                // keep going so the dist still ships with a partial atlas.
                try {
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
                } catch (Exception ex) when (ex is JsonException or KeyNotFoundException
                                                or InvalidOperationException) {
                    badLines++;
                    if (badLines <= 5) {
                        diagnostics.Add(new Diagnostic("warning", "spriteAtlas",
                            $"manifest.jsonl line {lineNo} skipped: {ex.GetType().Name}: {ex.Message}"));
                    }
                }
            }
            if (badLines > 5) {
                diagnostics.Add(new Diagnostic("warning", "spriteAtlas",
                    $"manifest.jsonl: {badLines - 5} additional malformed lines suppressed."));
            }
            // Same `var`-not-`const` reasoning as meta.js / manifest.js: a
            // top-level `const` in a classic <script> is script-scoped and
            // doesn't attach to `window`, so any consumer that does
            // `window.SPRITE_ATLAS` would see `undefined`.
            var atlasJs = "var SPRITE_ATLAS = " + JsonSerializer.Serialize(entries, JsonOpts) + ";\n";
            File.WriteAllText(Path.Combine(dstSprites, "atlas.js"), atlasJs);
            copied++;
        }
        return copied;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Frontend bundle copy
    // ────────────────────────────────────────────────────────────────────

    private static int CopyFrontendBundle(string outDir, List<Diagnostic> diagnostics) {
        var staticSiteRoot = ResolveStaticSiteRoot();
        if (staticSiteRoot == null) {
            // Without the bundle the dist is just data — the user opens
            // index.html and sees a blank page. The diagnostic file *is* in
            // the dist, so a future user who copies in their own index.html
            // (or a curl-able mirror) will at least see this on boot.
            diagnostics.Add(new Diagnostic("error", "frontendBundle",
                "StaticSite/ resources not found next to the binary or in the source tree; " +
                "the dist has no leaflet/app.js/app.css. Re-run from a build that copies " +
                "StaticSite/** into the output directory."));
            return 0;
        }
        int copied = 0;
        foreach (var src in Directory.EnumerateFiles(staticSiteRoot, "*", SearchOption.AllDirectories)) {
            // Filter editor/OS junk that creeps into the source tree.
            // .DS_Store, *.swp, *.tmp, .git/**: never belongs in a deliverable.
            var fileName = Path.GetFileName(src);
            if (fileName.StartsWith('.') ||
                fileName.EndsWith(".swp", StringComparison.Ordinal) ||
                fileName.EndsWith(".tmp", StringComparison.Ordinal) ||
                fileName.EndsWith("~", StringComparison.Ordinal)) {
                continue;
            }
            var rel = Path.GetRelativePath(staticSiteRoot, src);
            var dst = Path.Combine(outDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            File.Copy(src, dst, overwrite: true);
            copied++;
        }
        return copied;
    }

    private static string? ResolveStaticSiteRoot() {
        // Resolve order:
        //   1. Next to the running assembly (Content<CopyToOutputDirectory>
        //      drops StaticSite/ into bin/Debug/net8.0/).
        //   2. AppContext.BaseDirectory (populated even under single-file
        //      publish, where Assembly.Location is the empty string).
        //   3. Source-tree fallback so `dotnet run` works without a copy step.
        var candidates = new List<string?>();
        var asmLoc = Assembly.GetExecutingAssembly().Location;
        if (!string.IsNullOrEmpty(asmLoc)) {
            var asmDir = Path.GetDirectoryName(asmLoc);
            if (asmDir != null) {
                candidates.Add(Path.Combine(asmDir, "StaticSite"));
                // bin/Debug/net8.0 → ../../../StaticSite when CopyToOutputDirectory hasn't run
                candidates.Add(Path.GetFullPath(Path.Combine(asmDir, "..", "..", "..", "StaticSite")));
            }
        }
        var baseDir = AppContext.BaseDirectory;
        if (!string.IsNullOrEmpty(baseDir)) {
            candidates.Add(Path.Combine(baseDir, "StaticSite"));
            candidates.Add(Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "StaticSite")));
        }
        foreach (var c in candidates) {
            if (c != null && Directory.Exists(c)) return c;
        }
        return null;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Manifest + meta
    // ────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Write projects/&lt;slug&gt;/search_index.js as JSONP wrapping a flat
    /// item array. Frontend script-loads it and groups by item.kind for
    /// the npc/town/dungeon view modes. Items carry x/y so a row click
    /// can deep-link to the map at the right LB.
    /// </summary>
    private static void EmitSearchIndex(string projectDir, IReadOnlyList<string> lbList,
            List<string> dungeonLbs, CommandEngine engine) {
        var items = engine.BuildSearchIndex(lbList, dungeonLbs);
        var js = "LOAD_SEARCH_INDEX(" + JsonSerializer.Serialize(items, JsonOpts) + ");\n";
        File.WriteAllText(Path.Combine(projectDir, "search_index.js"), js);
    }

    /// <summary>
    /// Write projects/&lt;slug&gt;/dungeons.js — JSONP wrapping a
    /// {lbHex: {floorCount, cellsPerFloor}} dict. Mirrors the dungeons.json
    /// shape called out in the static-site-scene-quality plan, served as
    /// JSONP for parity with every other overlay/dataset on the dist.
    /// </summary>
    private static void EmitDungeonsManifest(string projectDir, List<string> dungeonLbs,
            CommandEngine engine) {
        var dict = new Dictionary<string, object>(dungeonLbs.Count);
        foreach (var hex in dungeonLbs) {
            if (!ushort.TryParse(hex.AsSpan(2), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var lbKey)) continue;
            try {
                int fc = engine.GetDungeonFloorCount(lbKey);
                if (fc == 0) continue;
                var cellsPerFloor = engine.GetDungeonFloorCellCounts(lbKey);
                dict[hex] = new {
                    floorCount = fc,
                    cellsPerFloor = cellsPerFloor.ToArray(),
                };
            } catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException) {
                // Same benign-on-concurrent-edit story as EmitMeta — skip
                // and let the frontend fall back to floorCounts in meta.js.
            }
        }
        var js = "LOAD_DUNGEONS(" + JsonSerializer.Serialize(dict, JsonOpts) + ");\n";
        File.WriteAllText(Path.Combine(projectDir, "dungeons.js"), js);
    }

    private static void EmitMeta(string projectDir, string slug,
            List<string> lbList, List<string> dungeonLbs, List<string> overlayNames,
            CommandEngine engine, string tileFormat = "png") {
        var floorCounts = new Dictionary<string, int>();
        foreach (var hex in dungeonLbs) {
            if (ushort.TryParse(hex.AsSpan(2), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var lbKey)) {
                try {
                    floorCounts[hex] = engine.GetDungeonFloorCount(lbKey);
                } catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException) {
                    // Dungeon doc was present at scan time but isn't now;
                    // benign during a concurrent edit. Leave the LB out of
                    // floorCounts — the frontend treats missing entries as 0.
                }
            }
        }
        var meta = new {
            slug,
            lbList = lbList.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            dungeonLbs = dungeonLbs.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            floorCounts,
            // Authoritative overlay name list. The frontend iterates this
            // (with a hardcoded-list fallback for older dists) instead of
            // baking in a duplicate of the emitter's overlay set, so adding
            // a new gazetteer in StaticSiteEmitter doesn't silently fail to
            // render until app.js is also updated.
            overlayList = overlayNames.ToArray(),
            generated = DateTime.UtcNow.ToString("o"),
            // Pixel-to-world contract. The frontend asserts each value against
            // its own constants on boot — a mismatch is a load-time error
            // banner instead of a silently-misplaced sprite. Bumping
            // projectionVersion forces older frontends to refuse to render
            // dists generated against a newer contract.
            coordSystem = new {
                worldExtentWu = 49152,
                tilePx = 256,
                lbWu = 192,
                pxPerWuAtZ0 = 256.0 / 49152.0,
                projectionVersion = 1,
            },
            // Tile-image extension (png|webp). The frontend reads this and
            // builds Leaflet URL templates with the matching extension.
            // Defaults to "png" — older dists without this field decode
            // as undefined → frontend falls back to png URLs.
            tileFormat = string.Equals(tileFormat, "webp", StringComparison.OrdinalIgnoreCase) ? "webp" : "png",
        };
        // Why: top-level `const` in a classic <script> is script-scoped — it
        // does NOT create a property on `window`, so `window['PROJECT_<slug>']`
        // returns undefined when the frontend tries to look it up. `var` does
        // attach to window, which is the JSONP convention.
        var js = $"var PROJECT_{SafeSlugForJs(slug)} = " + JsonSerializer.Serialize(meta, JsonOpts) + ";\n";
        File.WriteAllText(Path.Combine(projectDir, "meta.js"), js);
    }

    private static int WriteManifest(string outDir, string slug, string projectName,
            int maxZoom, int minZoom, List<Diagnostic> diagnostics) {
        var manifestPath = Path.Combine(outDir, "manifest.js");
        // Existing manifest? Parse out the projects array and the existing
        // defaultProject and merge. Why: re-running emit-static-site against
        // a second project must show both; nuking the manifest defeats
        // multi-project support, and silently overwriting defaultProject on
        // every emit makes the user's chosen landing project drift.
        var projects = new Dictionary<string, ManifestProject>(StringComparer.Ordinal);
        string? existingDefault = null;
        if (File.Exists(manifestPath)) {
            string raw = File.ReadAllText(manifestPath);
            try {
                var parsed = ParseManifest(raw);
                foreach (var (k, v) in parsed.Projects) projects[k] = v;
                existingDefault = parsed.DefaultProject;
            } catch (Exception ex) {
                // Don't silently start fresh — that would erase every
                // previously-emitted project's manifest entry. Save a
                // timestamped backup and surface the failure.
                var backup = manifestPath + ".corrupt." +
                    DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ") + ".bak";
                try {
                    File.Copy(manifestPath, backup, overwrite: false);
                    diagnostics.Add(new Diagnostic("error", "manifest",
                        $"existing manifest.js failed to parse ({ex.GetType().Name}); " +
                        $"backed up to {Path.GetFileName(backup)} before overwrite. " +
                        "Other projects' entries were lost — re-emit them to repopulate."));
                } catch (Exception copyEx) {
                    diagnostics.Add(new Diagnostic("error", "manifest",
                        $"existing manifest.js failed to parse ({ex.GetType().Name}) " +
                        $"and backup also failed ({copyEx.GetType().Name}: {copyEx.Message}). " +
                        "Previous manifest contents were lost."));
                }
            }
        }
        projects[slug] = new ManifestProject(slug, projectName, maxZoom, minZoom,
            DateTime.UtcNow.ToString("o"));

        var ordered = projects.Values.OrderBy(p => p.Slug, StringComparer.Ordinal).ToArray();
        // defaultProject preference order:
        //   1. Existing defaultProject if it still resolves to a known slug.
        //   2. The slug being emitted right now (so a fresh dist's default
        //      is whatever the user just produced).
        //   3. Alphabetical first, as a last resort.
        string defaultProject;
        if (existingDefault != null && projects.ContainsKey(existingDefault)) {
            defaultProject = existingDefault;
        } else {
            defaultProject = projects.ContainsKey(slug) ? slug : ordered[0].Slug;
        }
        var manifestObj = new {
            protocolVersion = 1,
            generated = DateTime.UtcNow.ToString("o"),
            defaultProject,
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

    private sealed record ParsedManifest(
        Dictionary<string, ManifestProject> Projects,
        string? DefaultProject);

    private static ParsedManifest ParseManifest(string manifestJs) {
        var projects = new Dictionary<string, ManifestProject>(StringComparer.Ordinal);
        // Strip the `var MANIFEST = ` prefix and trailing `;` to recover JSON.
        var trimmed = manifestJs.TrimStart();
        // Accept both `var` (current emitter) and `const` (legacy dists from
        // the initial Phase 4 emit) so the merge path doesn't break against
        // a manifest a previous version produced.
        const string varPrefix = "var MANIFEST = ";
        const string constPrefix = "const MANIFEST = ";
        string prefix;
        if (trimmed.StartsWith(varPrefix, StringComparison.Ordinal)) prefix = varPrefix;
        else if (trimmed.StartsWith(constPrefix, StringComparison.Ordinal)) prefix = constPrefix;
        else throw new InvalidDataException("manifest.js missing expected MANIFEST assignment prefix.");
        var json = trimmed.Substring(prefix.Length).TrimEnd().TrimEnd(';');
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.TryGetProperty("projects", out var arr)) {
            foreach (var p in arr.EnumerateArray()) {
                string slug = p.GetProperty("slug").GetString() ?? "";
                if (string.IsNullOrEmpty(slug)) continue;
                projects[slug] = new ManifestProject(
                    slug,
                    p.TryGetProperty("name", out var n) ? n.GetString() ?? slug : slug,
                    p.TryGetProperty("maxZoom", out var mxz) ? mxz.GetInt32() : 12,
                    p.TryGetProperty("minZoom", out var mnz) ? mnz.GetInt32() : 3,
                    p.TryGetProperty("generated", out var g) ? g.GetString() ?? "" : "");
            }
        }
        string? defaultProject = root.TryGetProperty("defaultProject", out var dp)
            ? dp.GetString()
            : null;
        return new ParsedManifest(projects, defaultProject);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────────────

    private static string BuildLoadCall(string fnName, string lbHex, string jsonPayload) =>
        $"{fnName}('{lbHex}', {jsonPayload});\n";

    private static string BuildLoadOverlay(string overlayName, string jsonPayload) =>
        $"LOAD_OVERLAY('{overlayName}', {jsonPayload});\n";

    private static string SafeSlugForJs(string slug) {
        // Sanitize to a valid JS identifier suffix: this string is appended
        // to "PROJECT_" by EmitMeta, so reserved-word collisions are not a
        // concern (the resulting identifier is "PROJECT_<x>", never "<x>"
        // alone). Must stay in sync with app.js's regex:
        //   slug.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
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

    // ────────────────────────────────────────────────────────────────────
    //  Zones overlay — Voronoi tessellation of region centroids
    // ────────────────────────────────────────────────────────────────────

    private const float WorldExtent = 49152f;

    /// <summary>
    /// Emit a GeoJSON FeatureCollection of named zones, one polygon per
    /// region, computed as the Voronoi cell of each region's centroid
    /// clipped to the world bounding rectangle. Returns false (no overlay
    /// written) when the engine has no region centroids.
    /// </summary>
    private static bool EmitZonesOverlay(CommandEngine engine, string overlaysDir,
            List<Diagnostic> diagnostics) {
        var centroids = engine.GetRegionCentroids();
        if (centroids.Count == 0) {
            diagnostics.Add(new Diagnostic("info", "overlay:zones",
                "no region centroids — region_gazetteer.json absent or empty"));
            return false;
        }
        // World bounding rectangle in CCW order. (0, 0) is the SW corner of
        // the AC overland; the Voronoi clipper preserves CCW orientation
        // through every half-plane clip.
        var worldRect = new List<(double X, double Y)> {
            (0, 0), (WorldExtent, 0), (WorldExtent, WorldExtent), (0, WorldExtent),
        };
        var features = new List<object>();
        for (int i = 0; i < centroids.Count; i++) {
            var (region, cx, cy) = centroids[i];
            // Clip a fresh world rectangle by the perpendicular bisector of
            // (centroid_i, centroid_j) for every j != i. The result is the
            // Voronoi cell of i, clipped to the world bounds. O(N^2) for
            // N = number of regions — fine at AC's ~13 regions.
            var poly = new List<(double X, double Y)>(worldRect);
            for (int j = 0; j < centroids.Count; j++) {
                if (i == j) continue;
                var (_, ox, oy) = centroids[j];
                poly = HalfPlaneClip(poly, cx, cy, ox, oy);
                if (poly.Count == 0) break; // degenerate — skip
            }
            if (poly.Count < 3) continue;
            // GeoJSON polygons are arrays-of-rings; we have the outer ring.
            // Coordinates are [lng, lat] = [worldX, worldY] to match the
            // app.js CRS convention (latLng = (worldY, worldX)).
            var ring = new List<double[]>(poly.Count + 1);
            foreach (var (px, py) in poly) ring.Add(new double[] { px, py });
            // Close the ring per the GeoJSON spec — first and last
            // coordinate pair must be identical.
            ring.Add(new double[] { poly[0].X, poly[0].Y });
            features.Add(new {
                type = "Feature",
                properties = new {
                    name = region,
                    centroid = new double[] { cx, cy },
                },
                geometry = new {
                    type = "Polygon",
                    coordinates = new[] { ring.ToArray() },
                },
            });
        }
        var geoJson = new {
            type = "FeatureCollection",
            features = features.ToArray(),
        };
        File.WriteAllText(Path.Combine(overlaysDir, "zones.js"),
            BuildLoadOverlay("zones", JsonSerializer.Serialize(geoJson, JsonOpts)));
        return true;
    }

    /// <summary>
    /// Sutherland-Hodgman polygon clip against the half-plane "closer to
    /// (ax, ay) than to (bx, by)". Returns a new polygon (CCW, possibly
    /// empty when the input lies wholly on the far side). The clip line
    /// is the perpendicular bisector of segment AB; "inside" is defined
    /// as the dot product of (P - midpoint) with (A - B) being &gt; 0,
    /// i.e. P is closer to A than to B.
    /// </summary>
    private static List<(double X, double Y)> HalfPlaneClip(
            List<(double X, double Y)> input, double ax, double ay, double bx, double by) {
        if (input.Count == 0) return input;
        // Plane equation: n · (P - M) >= 0 where n = (A - B), M = (A + B)/2.
        // Expand to: n.x * P.x + n.y * P.y >= n · M = (|A|² - |B|²) / 2.
        double nx = ax - bx;
        double ny = ay - by;
        double rhs = (ax * ax + ay * ay - bx * bx - by * by) * 0.5;

        var output = new List<(double X, double Y)>(input.Count + 1);
        for (int i = 0; i < input.Count; i++) {
            var p1 = input[i];
            var p2 = input[(i + 1) % input.Count];
            double s1 = nx * p1.X + ny * p1.Y - rhs;
            double s2 = nx * p2.X + ny * p2.Y - rhs;
            bool in1 = s1 >= 0;
            bool in2 = s2 >= 0;
            if (in1 && in2) {
                output.Add(p2);
            } else if (in1 && !in2) {
                output.Add(Intersect(p1, p2, s1, s2));
            } else if (!in1 && in2) {
                output.Add(Intersect(p1, p2, s1, s2));
                output.Add(p2);
            }
            // both out → emit nothing
        }
        return output;
    }

    private static (double X, double Y) Intersect((double X, double Y) p1, (double X, double Y) p2,
            double s1, double s2) {
        // Linear interpolation along the segment for the zero crossing.
        // s1, s2 are the signed distances from the half-plane boundary;
        // s1 - s2 cannot be zero here because in1 != in2.
        double t = s1 / (s1 - s2);
        return (p1.X + t * (p2.X - p1.X), p1.Y + t * (p2.Y - p1.Y));
    }
}
