using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldBuilder.Terminal;

/// <summary>
/// Disk-backed tile cache with LRU eviction and dirty-LB tracking.
///
/// Storage layout:
///   atlas_tiles/
///     manifest.json     — single source of truth for what's cached
///     lb/&lt;hex&gt;.jpg  — per-LB tiles (e.g. lb/A9B4.jpg)
///     region/&lt;name&gt;.jpg
///     world.jpg
///
/// The transact-journal hook calls MarkLbDirty for each touched landblock; the
/// next get-tile request for that LB regenerates rather than serving stale.
/// LRU eviction kicks in when total bytes exceed Budget; tiles are deleted
/// oldest-accessed-first until under budget.
///
/// All operations are local-disk and synchronous. Lock-free design assumes
/// single-process access (the Terminal's stdin loop is single-threaded).
/// </summary>
public class TileCache {
    public const int LbTilePixels = 512;
    public const int JpegQuality = 85;

    private readonly string _root;
    private readonly string _manifestPath;
    private readonly long _budgetBytes;
    private TileManifest _manifest;

    public TileCache(string projectDirectory, double budgetGB = 2.0) {
        _root = Path.Combine(projectDirectory, "atlas_tiles");
        Directory.CreateDirectory(_root);
        Directory.CreateDirectory(Path.Combine(_root, "lb"));
        Directory.CreateDirectory(Path.Combine(_root, "region"));
        _manifestPath = Path.Combine(_root, "manifest.json");
        _budgetBytes = (long)(budgetGB * 1024 * 1024 * 1024);
        _manifest = LoadManifest();
    }

    public string Root => _root;
    public long BudgetBytes => _budgetBytes;
    public long CurrentBytes => _manifest.Tiles.Values.Sum(t => t.SizeBytes);
    public int TileCount => _manifest.Tiles.Count;
    public int DirtyLbCount => _manifest.DirtyLbs.Count;
    public IReadOnlySet<string> DirtyLbs => _manifest.DirtyLbs;

    // ── Lookup ─────────────────────────────────────────────────

    /// <summary>
    /// Returns the cached tile entry if present and not dirty, null otherwise.
    /// Does NOT touch the disk; caller checks IsDirtyForLb separately.
    /// </summary>
    public TileEntry? Lookup(string key) {
        if (!_manifest.Tiles.TryGetValue(key, out var entry)) return null;
        if (entry.Dirty) return null;
        if (!File.Exists(Path.Combine(_root, entry.Path))) {
            // Manifest disagrees with disk; remove the orphan
            _manifest.Tiles.Remove(key);
            return null;
        }
        return entry;
    }

    /// <summary>Updates last-access timestamp; called on every cache hit.</summary>
    public void Touch(string key) {
        if (_manifest.Tiles.TryGetValue(key, out var e)) {
            e.LastAccessedAt = DateTime.UtcNow;
        }
    }

    /// <summary>Returns the absolute path on disk for a tile key.</summary>
    public string AbsolutePath(string relativePath) => Path.Combine(_root, relativePath);

    // ── Insert / update ────────────────────────────────────────

    public void Store(string key, string relativePath, byte[] bytes) {
        var fullPath = Path.Combine(_root, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllBytes(fullPath, bytes);
        _manifest.Tiles[key] = new TileEntry {
            Key = key,
            Path = relativePath,
            SizeBytes = bytes.Length,
            GeneratedAt = DateTime.UtcNow,
            LastAccessedAt = DateTime.UtcNow,
            Dirty = false,
        };
        // After every store, check budget and evict if needed.
        EnforceBudget();
    }

    // ── Dirty tracking ─────────────────────────────────────────

    /// <summary>
    /// Mark a landblock dirty. Any cached tile whose generation depends on this
    /// LB (the LB tile itself, plus any region/world composite that includes it)
    /// is flagged dirty so the next get-tile regenerates.
    /// </summary>
    public void MarkLbDirty(ushort lbKey) {
        var hex = lbKey.ToString("X4");
        _manifest.DirtyLbs.Add(hex);
        // Mark the LB tile dirty so next lookup forces regen
        var lbKeyStr = $"lb/{hex}";
        if (_manifest.Tiles.TryGetValue(lbKeyStr, out var lbTile)) lbTile.Dirty = true;
        // Mark world tile dirty unconditionally — it depends on every LB.
        if (_manifest.Tiles.TryGetValue("world", out var worldTile)) worldTile.Dirty = true;
        // Region tiles are marked dirty by the caller after consulting the
        // gazetteer (caller knows which region this LB belongs to).
    }

    public void MarkRegionDirty(string regionName) {
        var key = $"region/{SafeName(regionName)}";
        if (_manifest.Tiles.TryGetValue(key, out var tile)) tile.Dirty = true;
    }

    public bool IsDirtyForLb(ushort lbKey) {
        var hex = lbKey.ToString("X4");
        return _manifest.DirtyLbs.Contains(hex);
    }

    /// <summary>
    /// Mark every cached LB tile dirty. Called when a terrain-document edit
    /// invalidates rendering globally.
    /// </summary>
    public void MarkAllLbTilesDirty() {
        foreach (var entry in _manifest.Tiles.Values) {
            if (entry.Path.StartsWith("lb/")) entry.Dirty = true;
        }
        // Also mark world + region tiles dirty
        foreach (var entry in _manifest.Tiles.Values) {
            if (entry.Path.StartsWith("region/") || entry.Path == "world.jpg") entry.Dirty = true;
        }
    }

    public void ClearDirty() {
        _manifest.DirtyLbs.Clear();
    }

    /// <summary>
    /// Returns dirty LBs as a list of (lbKey, hex) pairs.
    /// </summary>
    public List<(ushort lbKey, string hex)> ListDirty() {
        var list = new List<(ushort, string)>();
        foreach (var hex in _manifest.DirtyLbs) {
            if (ushort.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var lb)) {
                list.Add((lb, hex));
            }
        }
        return list;
    }

    // ── LRU eviction ───────────────────────────────────────────

    /// <summary>
    /// If total bytes exceed budget, evict least-recently-accessed tiles.
    /// Region and world tiles are pinned (never evicted) since they're cheap
    /// and break the worldview if missing.
    /// </summary>
    private void EnforceBudget() {
        long current = CurrentBytes;
        if (current <= _budgetBytes) return;
        var evictable = _manifest.Tiles.Values
            .Where(t => t.Path.StartsWith("lb/"))   // only evict LB tiles
            .OrderBy(t => t.LastAccessedAt)
            .ToList();
        foreach (var tile in evictable) {
            if (current <= _budgetBytes) break;
            try {
                var fullPath = Path.Combine(_root, tile.Path);
                if (File.Exists(fullPath)) File.Delete(fullPath);
            } catch { /* best-effort; manifest still removes the entry */ }
            _manifest.Tiles.Remove(tile.Key);
            current -= tile.SizeBytes;
        }
    }

    /// <summary>Manual prune: keep only the N most-recently-accessed LB tiles.</summary>
    public PruneResult Prune(int? keepNewest = null, DateTime? olderThan = null) {
        var lbTiles = _manifest.Tiles.Values
            .Where(t => t.Path.StartsWith("lb/"))
            .OrderByDescending(t => t.LastAccessedAt)
            .ToList();
        var toEvict = new List<TileEntry>();
        if (keepNewest.HasValue) {
            toEvict.AddRange(lbTiles.Skip(keepNewest.Value));
        }
        if (olderThan.HasValue) {
            toEvict.AddRange(lbTiles.Where(t => t.LastAccessedAt < olderThan.Value));
        }
        toEvict = toEvict.DistinctBy(t => t.Key).ToList();
        long bytesFreed = 0;
        foreach (var t in toEvict) {
            try {
                var fp = Path.Combine(_root, t.Path);
                if (File.Exists(fp)) File.Delete(fp);
            } catch { }
            _manifest.Tiles.Remove(t.Key);
            bytesFreed += t.SizeBytes;
        }
        SaveManifest();
        return new PruneResult(toEvict.Count, bytesFreed, _manifest.Tiles.Count, CurrentBytes);
    }

    // ── Persistence ────────────────────────────────────────────

    public void SaveManifest() {
        var opts = new JsonSerializerOptions { WriteIndented = false };
        File.WriteAllText(_manifestPath, JsonSerializer.Serialize(_manifest, opts));
    }

    private TileManifest LoadManifest() {
        if (!File.Exists(_manifestPath)) return new TileManifest();
        try {
            var json = File.ReadAllText(_manifestPath);
            return JsonSerializer.Deserialize<TileManifest>(json) ?? new TileManifest();
        } catch (Exception ex) {
            Console.Error.WriteLine($"[TileCache] Manifest load failed, starting fresh: {ex.Message}");
            return new TileManifest();
        }
    }

    public TileStats Stats() {
        var lbCount = _manifest.Tiles.Count(t => t.Value.Path.StartsWith("lb/"));
        var regionCount = _manifest.Tiles.Count(t => t.Value.Path.StartsWith("region/"));
        var worldCount = _manifest.Tiles.Count(t => t.Value.Path.StartsWith("world"));
        var dirty = _manifest.Tiles.Count(t => t.Value.Dirty);
        return new TileStats(
            TotalCount: _manifest.Tiles.Count,
            LbCount: lbCount,
            RegionCount: regionCount,
            WorldCount: worldCount,
            DirtyTileCount: dirty,
            DirtyLbCount: _manifest.DirtyLbs.Count,
            BytesUsed: CurrentBytes,
            BytesBudget: _budgetBytes);
    }

    private static string SafeName(string s) {
        // Region names like "Northern Gharu'ndim" need filename sanitisation.
        var clean = new System.Text.StringBuilder(s.Length);
        foreach (var c in s) clean.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
        return clean.ToString();
    }
}

public class TileEntry {
    public string Key { get; set; } = "";
    public string Path { get; set; } = "";
    public long SizeBytes { get; set; }
    public DateTime GeneratedAt { get; set; }
    public DateTime LastAccessedAt { get; set; }
    public bool Dirty { get; set; }
}

public class TileManifest {
    public int Version { get; set; } = 1;
    public Dictionary<string, TileEntry> Tiles { get; set; } = new();
    public HashSet<string> DirtyLbs { get; set; } = new();
}

public record TileStats(
    int TotalCount, int LbCount, int RegionCount, int WorldCount,
    int DirtyTileCount, int DirtyLbCount,
    long BytesUsed, long BytesBudget);

public record PruneResult(int Evicted, long BytesFreed, int RemainingCount, long RemainingBytes);
