using System.Numerics;
using SkiaSharp;

namespace WorldBuilder.Terminal;

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
    private readonly Dictionary<uint, SpriteRect> _byModel;

    public int Count => _byModel.Count;

    private SpriteAtlasLoader(SKBitmap atlas, Dictionary<uint, SpriteRect> byModel) {
        Atlas = atlas;
        _byModel = byModel;
    }

    public bool TryLookup(uint modelId, out SpriteRect rect) =>
        _byModel.TryGetValue(modelId, out rect!);

    public static SpriteAtlasLoader? TryLoad(string spritesDir) {
        var atlasPath = Path.Combine(spritesDir, "atlas.png");
        var manifestPath = Path.Combine(spritesDir, "manifest.jsonl");
        if (!File.Exists(atlasPath) || !File.Exists(manifestPath)) return null;
        var atlas = SKBitmap.Decode(atlasPath);
        if (atlas == null) return null;

        var byModel = new Dictionary<uint, SpriteRect>();
        foreach (var line in File.ReadLines(manifestPath)) {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using var doc = System.Text.Json.JsonDocument.Parse(line);
            var root = doc.RootElement;
            var modelStr = root.GetProperty("modelId").GetString() ?? "";
            if (!TryParseModelId(modelStr, out var modelId)) continue;
            int x = root.GetProperty("x").GetInt32();
            int y = root.GetProperty("y").GetInt32();
            int w = root.GetProperty("w").GetInt32();
            int h = root.GetProperty("h").GetInt32();
            var wb = root.GetProperty("worldBounds");
            float ww = wb[0].GetSingle();
            float wh = wb[1].GetSingle();
            byModel[modelId] = new SpriteRect(x, y, w, h, ww, wh);
        }
        return new SpriteAtlasLoader(atlas, byModel);
    }

    private static bool TryParseModelId(string s, out uint id) {
        id = 0;
        if (string.IsNullOrEmpty(s)) return false;
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        return uint.TryParse(s, System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out id);
    }

    public void Dispose() => Atlas.Dispose();
}
