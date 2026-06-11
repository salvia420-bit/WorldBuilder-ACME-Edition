using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using DatReaderWriter.DBObjs;
using DRW = DatReaderWriter;
using SceneObj = DatReaderWriter.DBObjs.Scene;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration Phase G — asset-reference graph &amp; reverse lookups.
/// See <c>docs/melt-integration-plan-2026-06-10.md</c> §5.
///
/// The retail asset chain is
///   Scene(0x12) → Setup(0x02) → GfxObj(0x01) → Surface(0x08) →
///   SurfaceTexture(0x05) → RenderSurface(0x06)   (+ Palette(0x04) off Surface)
///
/// Commands in this file:
///
///   - <c>asset-refs &lt;id&gt;</c> — forward edges, one level: what does this
///     DID reference next in the chain.
///   - <c>asset-used-by &lt;id&gt; [transitive]</c> — reverse edges: who
///     references this DID. First call per source builds a full portal-DAT
///     reverse index (cached for the session); subsequent calls are instant.
///     <c>transitive:true</c> walks the closure up to Setups/Scenes — the
///     "which models/scenery show this surface" debugging primitive.
///   - <c>surface-fingerprint &lt;id | match&gt;</c> — melt
///     <c>GfxObjTools.FindTranslation</c> generalized: fingerprint a Surface
///     (Type, OrigTextureId, OrigPaletteId, ColorValue, Translucency,
///     Luminosity, Diffuse) and find every surface matching it (or a
///     partial <c>match</c> spec) — locates "the same material under a
///     different ID".
///
/// Behavioral reference: <c>external/melt/Source/misc/GfxObjTools.cs</c>
/// FindUsedBy/FindTranslation (reference only — reimplemented on
/// DatReaderWriter types).
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Reverse index (built lazily, cached per source key)
    // ─────────────────────────────────────────────────────────────────

    internal sealed class AssetReverseIndex {
        public string SourceKey = "";
        public long BuildMs;
        public int GfxObjs, Setups, Scenes, Surfaces, SurfaceTextures;
        // child DID → parent DIDs
        public readonly Dictionary<uint, List<uint>> SurfaceToGfxObjs = new();
        public readonly Dictionary<uint, List<uint>> GfxObjToSetups = new();
        public readonly Dictionary<uint, List<uint>> ObjectToScenes = new(); // setup OR gfxobj → scene
        public readonly Dictionary<uint, List<uint>> SurfaceTextureToSurfaces = new();
        public readonly Dictionary<uint, List<uint>> PaletteToSurfaces = new();
        public readonly Dictionary<uint, List<uint>> RenderSurfaceToSurfaceTextures = new();
        public readonly Dictionary<uint, SurfaceFingerprintRow> SurfaceFingerprints = new();

        public static void Add(Dictionary<uint, List<uint>> map, uint child, uint parent) {
            if (!map.TryGetValue(child, out var list)) map[child] = list = new List<uint>();
            if (list.Count == 0 || list[^1] != parent) list.Add(parent);
        }
    }

    private readonly Dictionary<string, AssetReverseIndex> _assetIndexCache = new();

    /// <summary>Resolve a portal-DAT read source: dat-open alias → project →
    /// explicit/base path. Returns a DatDatabase to scan plus a stable cache
    /// key and an ownership flag (dispose when we opened it ourselves).</summary>
    private (DRW.DatDatabase Db, string Key, bool Owned) ResolvePortalSource(string? datPath) {
        if (!string.IsNullOrWhiteSpace(datPath) && _externalDats.TryGetValue(datPath.Trim(), out var handle)) {
            var db = handle.Collection != null ? (DRW.DatDatabase)handle.Collection.Portal
                : handle.Single ?? throw new InvalidOperationException($"handle '{handle.Alias}' has no database");
            return (db, $"handle:{handle.Alias}:{handle.Path}", false);
        }
        if (string.IsNullOrWhiteSpace(datPath)) {
            var project = _projectManager?.CurrentProject;
            if (project != null)
                return (project.DocumentManager.Dats.Dats.Portal, $"project:{project.Name}", false);
        }
        var resolved = ResolveDatPathForType(datPath, typeof(Surface));
        var opened = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });
        return (opened, $"dat:{resolved}", true);
    }

    private AssetReverseIndex GetAssetIndex(string? datPath) {
        var (db, key, owned) = ResolvePortalSource(datPath);
        try {
            if (_assetIndexCache.TryGetValue(key, out var cached)) return cached;

            var sw = Stopwatch.StartNew();
            var idx = new AssetReverseIndex { SourceKey = key };

            foreach (var id in db.GetAllIdsOfType<Surface>()) {
                if (!db.TryGet<Surface>(id, out var s) || s == null) continue;
                idx.Surfaces++;
                uint texId = s.OrigTextureId != null ? (uint)s.OrigTextureId : 0u;
                uint palId = s.OrigPaletteId != null ? (uint)s.OrigPaletteId : 0u;
                if (texId != 0) AssetReverseIndex.Add(idx.SurfaceTextureToSurfaces, texId, id);
                if (palId != 0) AssetReverseIndex.Add(idx.PaletteToSurfaces, palId, id);
                idx.SurfaceFingerprints[id] = new SurfaceFingerprintRow(
                    Id: $"0x{id:X8}",
                    Type: s.Type.ToString(),
                    TypeValue: (uint)s.Type,
                    OrigTextureId: $"0x{texId:X8}",
                    OrigPaletteId: $"0x{palId:X8}",
                    ColorValue: s.ColorValue != null ? ColorHex(s.ColorValue) : null,
                    Translucency: s.Translucency,
                    Luminosity: s.Luminosity,
                    Diffuse: s.Diffuse);
            }

            foreach (var id in db.GetAllIdsOfType<SurfaceTexture>()) {
                if (!db.TryGet<SurfaceTexture>(id, out var st) || st == null) continue;
                idx.SurfaceTextures++;
                foreach (var rs in st.Textures)
                    AssetReverseIndex.Add(idx.RenderSurfaceToSurfaceTextures, (uint)rs, id);
            }

            foreach (var id in db.GetAllIdsOfType<GfxObj>()) {
                if (!db.TryGet<GfxObj>(id, out var g) || g == null) continue;
                idx.GfxObjs++;
                foreach (var surf in g.Surfaces)
                    AssetReverseIndex.Add(idx.SurfaceToGfxObjs, (uint)surf, id);
            }

            foreach (var id in db.GetAllIdsOfType<Setup>()) {
                if (!db.TryGet<Setup>(id, out var setup) || setup == null) continue;
                idx.Setups++;
                foreach (var part in setup.Parts)
                    AssetReverseIndex.Add(idx.GfxObjToSetups, (uint)part, id);
            }

            foreach (var id in db.GetAllIdsOfType<SceneObj>()) {
                if (!db.TryGet<SceneObj>(id, out var scene) || scene == null) continue;
                idx.Scenes++;
                foreach (var obj in scene.Objects)
                    AssetReverseIndex.Add(idx.ObjectToScenes, obj.ObjectId, id);
            }

            sw.Stop();
            idx.BuildMs = sw.ElapsedMilliseconds;
            _assetIndexCache[key] = idx;
            return idx;
        }
        finally {
            if (owned) db.Dispose();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Commands
    // ─────────────────────────────────────────────────────────────────

    public AssetRefsResult AssetRefs(string idHex, string? datPath) {
        var id = ParseRegionHexU32(idHex);
        var (db, key, owned) = ResolvePortalSource(datPath);
        try {
            var edges = new List<AssetEdge>();
            string kind;
            switch (id >> 24) {
                case 0x12: {
                    kind = "Scene";
                    if (!db.TryGet<SceneObj>(id, out var scene) || scene == null)
                        throw new InvalidOperationException($"Scene 0x{id:X8} not found in {key}.");
                    foreach (var o in scene.Objects)
                        edges.Add(new AssetEdge(KindOf(o.ObjectId), $"0x{o.ObjectId:X8}", "places"));
                    break;
                }
                case 0x02: {
                    kind = "Setup";
                    if (!db.TryGet<Setup>(id, out var setup) || setup == null)
                        throw new InvalidOperationException($"Setup 0x{id:X8} not found in {key}.");
                    foreach (var p in setup.Parts)
                        edges.Add(new AssetEdge("GfxObj", $"0x{(uint)p:X8}", "part"));
                    break;
                }
                case 0x01: {
                    kind = "GfxObj";
                    if (!db.TryGet<GfxObj>(id, out var g) || g == null)
                        throw new InvalidOperationException($"GfxObj 0x{id:X8} not found in {key}.");
                    foreach (var s in g.Surfaces)
                        edges.Add(new AssetEdge("Surface", $"0x{(uint)s:X8}", "surface"));
                    break;
                }
                case 0x08: {
                    kind = "Surface";
                    if (!db.TryGet<Surface>(id, out var s) || s == null)
                        throw new InvalidOperationException($"Surface 0x{id:X8} not found in {key}.");
                    if (s.OrigTextureId != null && (uint)s.OrigTextureId != 0)
                        edges.Add(new AssetEdge("SurfaceTexture", $"0x{(uint)s.OrigTextureId:X8}", "origTexture"));
                    if (s.OrigPaletteId != null && (uint)s.OrigPaletteId != 0)
                        edges.Add(new AssetEdge("Palette", $"0x{(uint)s.OrigPaletteId:X8}", "origPalette"));
                    break;
                }
                case 0x05: {
                    kind = "SurfaceTexture";
                    if (!db.TryGet<SurfaceTexture>(id, out var st) || st == null)
                        throw new InvalidOperationException($"SurfaceTexture 0x{id:X8} not found in {key}.");
                    foreach (var rs in st.Textures)
                        edges.Add(new AssetEdge("RenderSurface", $"0x{(uint)rs:X8}", "texture"));
                    break;
                }
                default:
                    throw new ArgumentException(
                        $"Unsupported prefix 0x{id >> 24:X2} — asset-refs handles Scene(0x12), Setup(0x02), GfxObj(0x01), Surface(0x08), SurfaceTexture(0x05).");
            }
            return new AssetRefsResult($"0x{id:X8}", kind, key, edges.Count, edges);
        }
        finally {
            if (owned) db.Dispose();
        }
    }

    public AssetUsedByResult AssetUsedBy(string idHex, bool transitive, string? datPath) {
        var id = ParseRegionHexU32(idHex);
        var idx = GetAssetIndex(datPath);

        var direct = DirectParents(idx, id)
            .Select(p => new AssetEdge(KindOf(p), $"0x{p:X8}", "direct"))
            .ToList();

        List<AssetEdge>? closure = null;
        if (transitive) {
            closure = new List<AssetEdge>();
            var seen = new HashSet<uint> { id };
            var frontier = new Queue<uint>(DirectParents(idx, id));
            while (frontier.Count > 0) {
                var cur = frontier.Dequeue();
                if (!seen.Add(cur)) continue;
                closure.Add(new AssetEdge(KindOf(cur), $"0x{cur:X8}", "transitive"));
                foreach (var p in DirectParents(idx, cur)) frontier.Enqueue(p);
            }
        }

        return new AssetUsedByResult(
            Id: $"0x{id:X8}",
            Kind: KindOf(id),
            Source: idx.SourceKey,
            IndexBuildMs: idx.BuildMs,
            IndexCounts: new AssetIndexCounts(idx.GfxObjs, idx.Setups, idx.Scenes, idx.Surfaces, idx.SurfaceTextures),
            DirectCount: direct.Count,
            Direct: direct,
            TransitiveCount: closure?.Count,
            Transitive: closure);
    }

    public SurfaceFingerprintResult SurfaceFingerprint(
        string? idHex, Dictionary<string, string>? match, string? datPath) {
        if (string.IsNullOrWhiteSpace(idHex) && (match == null || match.Count == 0))
            throw new ArgumentException("Provide id (a Surface 0x08......) or a match spec.");
        if (!string.IsNullOrWhiteSpace(idHex) && match != null && match.Count > 0)
            throw new ArgumentException("Provide either id or match, not both.");

        var idx = GetAssetIndex(datPath);
        SurfaceFingerprintRow? probe = null;

        if (!string.IsNullOrWhiteSpace(idHex)) {
            var id = ParseRegionHexU32(idHex);
            if (!idx.SurfaceFingerprints.TryGetValue(id, out probe))
                throw new InvalidOperationException($"Surface 0x{id:X8} not found in {idx.SourceKey}.");
        }

        bool Match(SurfaceFingerprintRow row) {
            if (probe != null) {
                return row.TypeValue == probe.TypeValue
                    && row.OrigTextureId == probe.OrigTextureId
                    && row.OrigPaletteId == probe.OrigPaletteId
                    && row.ColorValue == probe.ColorValue
                    && row.Translucency.Equals(probe.Translucency)
                    && row.Luminosity.Equals(probe.Luminosity)
                    && row.Diffuse.Equals(probe.Diffuse);
            }
            foreach (var (k, v) in match!) {
                bool ok = k switch {
                    "type" => string.Equals(row.Type, v, StringComparison.OrdinalIgnoreCase)
                              || (TryParseTypeValue(v, out var tv) && row.TypeValue == tv),
                    "origTextureId" => row.OrigTextureId.Equals(NormalizeHex(v), StringComparison.OrdinalIgnoreCase),
                    "origPaletteId" => row.OrigPaletteId.Equals(NormalizeHex(v), StringComparison.OrdinalIgnoreCase),
                    "colorValue" => string.Equals(row.ColorValue, v, StringComparison.OrdinalIgnoreCase),
                    "translucency" => float.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var t) && row.Translucency.Equals(t),
                    "luminosity" => float.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var l) && row.Luminosity.Equals(l),
                    "diffuse" => float.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var df) && row.Diffuse.Equals(df),
                    _ => throw new ArgumentException($"Unknown match key '{k}'."),
                };
                if (!ok) return false;
            }
            return true;
        }

        var matches = idx.SurfaceFingerprints.Values
            .Where(Match)
            .OrderBy(r => r.Id, StringComparer.Ordinal)
            .ToList();

        return new SurfaceFingerprintResult(
            Probe: probe,
            Source: idx.SourceKey,
            MatchCount: matches.Count,
            Matches: matches);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────────

    private static bool TryParseTypeValue(string v, out uint value) {
        var s = v.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return uint.TryParse(s.Substring(2), System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out value);
        return uint.TryParse(s, System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out value);
    }

    private static IEnumerable<uint> DirectParents(AssetReverseIndex idx, uint id) {
        IEnumerable<uint> result = Enumerable.Empty<uint>();
        if (idx.SurfaceToGfxObjs.TryGetValue(id, out var a)) result = result.Concat(a);
        if (idx.GfxObjToSetups.TryGetValue(id, out var b)) result = result.Concat(b);
        if (idx.ObjectToScenes.TryGetValue(id, out var c)) result = result.Concat(c);
        if (idx.SurfaceTextureToSurfaces.TryGetValue(id, out var d)) result = result.Concat(d);
        if (idx.PaletteToSurfaces.TryGetValue(id, out var e)) result = result.Concat(e);
        if (idx.RenderSurfaceToSurfaceTextures.TryGetValue(id, out var f)) result = result.Concat(f);
        return result.Distinct();
    }

    private static string KindOf(uint id) => (id >> 24) switch {
        0x01 => "GfxObj",
        0x02 => "Setup",
        0x04 => "Palette",
        0x05 => "SurfaceTexture",
        0x06 => "RenderSurface",
        0x08 => "Surface",
        0x12 => "Scene",
        _ => $"0x{id >> 24:X2}",
    };

    private static string NormalizeHex(string v) => $"0x{ParseRegionHexU32(v):X8}";
}

// ── Melt-integration Phase G: asset graph results ────────────────────
public record AssetEdge(string Kind, string Id, string Relation);

public record AssetRefsResult(
    string Id,
    string Kind,
    string Source,
    int EdgeCount,
    List<AssetEdge> Edges);

public record AssetIndexCounts(int GfxObjs, int Setups, int Scenes, int Surfaces, int SurfaceTextures);

public record AssetUsedByResult(
    string Id,
    string Kind,
    string Source,
    long IndexBuildMs,
    AssetIndexCounts IndexCounts,
    int DirectCount,
    List<AssetEdge> Direct,
    int? TransitiveCount,
    List<AssetEdge>? Transitive);

public record SurfaceFingerprintRow(
    string Id,
    string Type,
    uint TypeValue,
    string OrigTextureId,
    string OrigPaletteId,
    string? ColorValue,
    float Translucency,
    float Luminosity,
    float Diffuse);

public record SurfaceFingerprintResult(
    SurfaceFingerprintRow? Probe,
    string Source,
    int MatchCount,
    List<SurfaceFingerprintRow> Matches);
