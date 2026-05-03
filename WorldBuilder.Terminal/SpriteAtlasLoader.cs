using System.Numerics;
using SkiaSharp;

namespace WorldBuilder.Terminal;

/// <summary>
/// A variant-aware atlas key. Bare-setup keys (ClothingBase==0 and
/// PaletteTemplate==0) match the prior uint-keyed convention. Variant keys
/// distinguish ClothingTable substitutions for the same Setup — different
/// NPCs share a setup but render with different parts/textures/palettes.
/// </summary>
internal readonly record struct SpriteKey(uint Setup, uint ClothingBase, int PaletteTemplate) {
    public static SpriteKey Bare(uint setup) => new(setup, 0, 0);
    public bool HasVariant => ClothingBase != 0 || PaletteTemplate != 0;

    /// <summary>Stable manifest id. Bare keys serialize as the existing
    /// "0x{setup:X8}" string so old atlases keep loading; variants append
    /// ":c0x{cb:X8}:p{pt}" so new atlases round-trip.</summary>
    public string ToManifestId() => HasVariant
        ? $"0x{Setup:X8}:c0x{ClothingBase:X8}:p{PaletteTemplate}"
        : $"0x{Setup:X8}";

    public static bool TryParseManifestId(string s, out SpriteKey key) {
        key = default;
        if (string.IsNullOrEmpty(s)) return false;
        // Variant: 0x{setup}:c0x{cb}:p{pt}. Bare: 0x{setup}.
        var parts = s.Split(':');
        if (!TryParseHex(parts[0], out uint setup)) return false;
        uint cb = 0; int pt = 0;
        for (int i = 1; i < parts.Length; i++) {
            var p = parts[i];
            if (p.Length < 2) continue;
            if (p[0] == 'c' && !TryParseHex(p[1..], out cb)) return false;
            else if (p[0] == 'p' && !int.TryParse(p[1..], out pt)) return false;
        }
        key = new SpriteKey(setup, cb, pt);
        return true;
    }

    private static bool TryParseHex(string s, out uint v) {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s[2..];
        return uint.TryParse(s, System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out v);
    }
}

/// <summary>
/// Loads a sprite atlas PNG + manifest jsonl produced by
/// <see cref="ObjectSpriteGenerator"/> and answers per-model-id lookups
/// describing where the model's sprite lives in the atlas and what its
/// true world bounds are. Disposable: callers own the lifecycle.
///
/// Used by <see cref="DungeonRenderer"/> and the sprite-mode branch of
/// <see cref="RenderPreviewRenderer"/> so both share one bitmap copy
/// rather than re-decoding the atlas per render call.
/// </summary>
internal sealed class SpriteAtlasLoader : IDisposable {

    public sealed record SpriteRect(int X, int Y, int W, int H, float WorldWidth, float WorldHeight);

    public SKBitmap Atlas { get; }
    private readonly Dictionary<SpriteKey, SpriteRect> _byKey;

    public int Count => _byKey.Count;

    private SpriteAtlasLoader(SKBitmap atlas, Dictionary<SpriteKey, SpriteRect> byKey) {
        Atlas = atlas;
        _byKey = byKey;
    }

    /// <summary>Bare-setup lookup — backward-compatible shim for callers
    /// that don't yet know about clothing/palette variants.</summary>
    public bool TryLookup(uint modelId, out SpriteRect rect) =>
        TryLookup(SpriteKey.Bare(modelId), out rect);

    public bool TryLookup(SpriteKey key, out SpriteRect rect) {
        if (_byKey.TryGetValue(key, out rect!)) return true;
        // Variant fallback: when the requested variant isn't packed but the
        // bare setup is, render the bare sprite. This lets new variant-aware
        // call sites work against an atlas built without variant ingest.
        if (key.HasVariant && _byKey.TryGetValue(SpriteKey.Bare(key.Setup), out rect!)) return true;
        rect = null!;
        return false;
    }

    /// <summary>
    /// Load the (atlas, manifest) pair for the requested LOD + mode.
    /// Suffix convention: "" (LOD-0 day), "_lodN" (LOD-N day), "_night"
    /// (LOD-0 night), "_lodN_night" (LOD-N night). Returns null when
    /// either file is missing — caller falls back to a different
    /// (LOD, mode) pair or to glyph rendering.
    /// </summary>
    public static SpriteAtlasLoader? TryLoad(string spritesDir, int lodLevel = 0,
            bool nightMode = false) {
        string suffix = (lodLevel > 0 ? $"_lod{lodLevel}" : "")
                      + (nightMode ? "_night" : "");
        var atlasPath = Path.Combine(spritesDir, $"atlas{suffix}.png");
        var manifestPath = Path.Combine(spritesDir, $"manifest{suffix}.jsonl");
        if (!File.Exists(atlasPath) || !File.Exists(manifestPath)) return null;
        var atlas = SKBitmap.Decode(atlasPath);
        if (atlas == null) return null;

        var byKey = new Dictionary<SpriteKey, SpriteRect>();
        foreach (var line in File.ReadLines(manifestPath)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using var doc = System.Text.Json.JsonDocument.Parse(line);
            var root = doc.RootElement;
            var modelStr = root.GetProperty("modelId").GetString() ?? "";
            if (!SpriteKey.TryParseManifestId(modelStr, out var key)) continue;
            int x = root.GetProperty("x").GetInt32();
            int y = root.GetProperty("y").GetInt32();
            int w = root.GetProperty("w").GetInt32();
            int h = root.GetProperty("h").GetInt32();
            var wb = root.GetProperty("worldBounds");
            float ww = wb[0].GetSingle();
            float wh = wb[1].GetSingle();
            byKey[key] = new SpriteRect(x, y, w, h, ww, wh);
        }
        return new SpriteAtlasLoader(atlas, byKey);
    }

    public void Dispose() => Atlas.Dispose();
}
