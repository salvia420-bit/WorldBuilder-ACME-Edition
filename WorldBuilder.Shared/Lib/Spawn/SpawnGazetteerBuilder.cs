using System.Globalization;
using System.Text.Json;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Shared.Lib.Spawn;

/// <summary>
/// Builds the per-landblock spawn index that the static-site pipeline
/// shares between rendering, per-LB descriptions, and the diagnostics
/// overlay. Two source modes:
/// <list type="bullet">
///   <item>LSD-Partial JSON dumps (one summary file with all LBs); see <see cref="BuildFromLsdJson"/>.</item>
///   <item>ACE world DB <c>landblock_instance</c> rows joined to <c>weenie</c>; see <see cref="BuildFromAceLandblockInstances"/>.</item>
/// </list>
/// Both modes produce the same <see cref="SpawnRecord"/> shape, so the
/// downstream renderer / describer can't tell which source built the index.
/// </summary>
public static class SpawnGazetteerBuilder {

    /// <summary>
    /// Read an LSD spawnmap_summary.jsonl-style JSON file (object keyed by
    /// hex landblock ID, values are arrays of spawn entries). Filters out
    /// server-managed weenies (doors / chests / generators) and unidentified
    /// entries (wcid=0 or name="?") so downstream consumers always get
    /// player-visible records.
    /// </summary>
    public static Dictionary<ushort, List<SpawnRecord>> BuildFromLsdJson(string path) {
        var raw = File.ReadAllText(path);
        return BuildFromLsdJsonString(raw);
    }

    public static Dictionary<ushort, List<SpawnRecord>> BuildFromLsdJsonString(string json) {
        var result = new Dictionary<ushort, List<SpawnRecord>>();
        using var doc = JsonDocument.Parse(json);
        foreach (var entry in doc.RootElement.EnumerateObject()) {
            var keyStr = entry.Name.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? entry.Name.Substring(2) : entry.Name;
            if (!ushort.TryParse(keyStr, NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture, out var lbKey)) continue;
            var spawns = new List<SpawnRecord>();
            foreach (var item in entry.Value.EnumerateArray()) {
                bool serverManaged = item.TryGetProperty("is_server_managed", out var sEl)
                    && sEl.ValueKind == JsonValueKind.True;
                if (serverManaged) continue;
                int wcid = item.TryGetProperty("wcid", out var wEl)
                    && wEl.ValueKind == JsonValueKind.Number ? wEl.GetInt32() : 0;
                if (wcid == 0) continue;
                string name = item.TryGetProperty("name", out var nEl)
                    && nEl.ValueKind == JsonValueKind.String ? nEl.GetString()! : "?";
                if (string.IsNullOrEmpty(name) || name.Trim() == "?") continue;
                string? placement = item.TryGetProperty("placement", out var pEl)
                    && pEl.ValueKind == JsonValueKind.String ? pEl.GetString() : null;
                int? wt = item.TryGetProperty("weenie_type", out var wtEl)
                    && wtEl.ValueKind == JsonValueKind.Number ? wtEl.GetInt32() : (int?)null;
                string? acTitle = item.TryGetProperty("acpedia_title", out var atEl)
                    && atEl.ValueKind == JsonValueKind.String ? atEl.GetString() : null;
                string[]? acCats = item.TryGetProperty("acpedia_cats", out var acEl)
                    && acEl.ValueKind == JsonValueKind.Array
                        ? acEl.EnumerateArray().Select(e => e.GetString() ?? "")
                            .Where(s => !string.IsNullOrEmpty(s)).ToArray()
                        : null;
                string? acTier = item.TryGetProperty("acpedia_tier", out var tEl)
                    && tEl.ValueKind == JsonValueKind.String ? tEl.GetString() : null;
                float x = item.TryGetProperty("x", out var xEl) ? xEl.GetSingle() : 0;
                float y = item.TryGetProperty("y", out var yEl) ? yEl.GetSingle() : 0;
                float z = item.TryGetProperty("z", out var zEl) ? zEl.GetSingle() : 0;
                int cell = item.TryGetProperty("cell", out var cEl)
                    && cEl.ValueKind == JsonValueKind.Number ? cEl.GetInt32() : 0;

                spawns.Add(new SpawnRecord(
                    Wcid: wcid,
                    Name: name,
                    Category: ResolveCategory(acCats, wt),
                    Generator: ResolveGenerator(placement),
                    LandblockId: lbKey,
                    Cell: cell,
                    X: x, Y: y, Z: z,
                    WeenieType: wt,
                    AcpediaTitle: acTitle,
                    AcpediaTier: acTier,
                    IsSynthetic: false));
            }
            if (spawns.Count > 0) result[lbKey] = spawns;
        }
        return result;
    }

    /// <summary>
    /// Build a SpawnRecord index from raw ACE <c>landblock_instance</c> rows
    /// (joined to <c>weenie</c> for name + type). The <paramref name="weenieIndex"/>
    /// supplies name + WeenieType per wcid; rows without a join entry get
    /// <see cref="SpawnRecord.IsSynthetic"/>=true and a placeholder name.
    /// </summary>
    public static Dictionary<ushort, List<SpawnRecord>> BuildFromAceLandblockInstances(
            IEnumerable<LandblockInstanceRecord> rows,
            IReadOnlyDictionary<int, AceWeenieDescriptor>? weenieIndex = null) {
        var result = new Dictionary<ushort, List<SpawnRecord>>();
        foreach (var row in rows) {
            // ObjCellId is a 32-bit landcell ID: high 16 bits = landblock,
            // low 16 bits = cell number within the LB.
            ushort lbId = (ushort)((row.ObjCellId >> 16) & 0xFFFF);
            int cell = (int)(row.ObjCellId & 0xFFFF);
            int wcid = (int)row.WeenieClassId;

            string name;
            int? weenieType;
            string category;
            bool synthetic;
            if (weenieIndex != null && weenieIndex.TryGetValue(wcid, out var wn)) {
                name = wn.Name;
                weenieType = wn.WeenieType;
                category = ResolveCategory(null, weenieType);
                synthetic = false;
            } else {
                name = $"Weenie {wcid}";
                weenieType = null;
                category = "Object";
                synthetic = true;
            }

            if (!result.TryGetValue(lbId, out var list)) {
                list = new List<SpawnRecord>();
                result[lbId] = list;
            }
            list.Add(new SpawnRecord(
                Wcid: wcid,
                Name: name,
                Category: category,
                Generator: "Static",
                LandblockId: lbId,
                Cell: cell,
                X: row.OriginX, Y: row.OriginY, Z: row.OriginZ,
                WeenieType: weenieType,
                AcpediaTitle: null,
                AcpediaTier: null,
                IsSynthetic: synthetic));
        }
        return result;
    }

    /// <summary>
    /// Resolve a render-time category from an Acpedia category list and/or
    /// ACE WeenieType. Returns one of: "Creature" | "Npc" | "Object" |
    /// "Surface". Order matters — Acpedia categories are more accurate
    /// than weenie type when both are available.
    /// </summary>
    public static string ResolveCategory(string[]? acpediaCategories, int? weenieType) {
        if (acpediaCategories is { Length: > 0 }) {
            foreach (var c in acpediaCategories) {
                if (c == null) continue;
                var lc = c.ToLowerInvariant();
                if (lc.Contains("creature") || lc.Contains("monster")) return "Creature";
                if (lc.Contains("npc") || lc.Contains("vendor") || lc.Contains("merchant") ||
                    lc.Contains("mage") || lc.Contains("blacksmith")) return "Npc";
                if (lc.Contains("door") || lc.Contains("portal") ||
                    lc.Contains("interactive") || lc.Contains("sign")) return "Object";
                if (lc.Contains("surface") || lc.Contains("scenery")) return "Surface";
            }
        }
        // ACE WeenieType enum (small stable subset used here).
        return weenieType switch {
            10 => "Creature",   // Creature
            45 => "Npc",        // Vendor
            20 => "Npc",        // Some NPC types
             4 => "Npc",        // Creature with talk-interaction
             7 => "Object",     // Portal
            19 => "Object",     // Door
             1 => "Object",     // Generic / Item
             _ => "Object",
        };
    }

    /// <summary>
    /// Map the LSD "placement" hint to one of: "Static" | "Linkable" |
    /// "Respawn" | "Unknown".
    /// </summary>
    public static string ResolveGenerator(string? placementHint) {
        if (string.IsNullOrEmpty(placementHint)) return "Unknown";
        var lc = placementHint.ToLowerInvariant();
        if (lc.Contains("respawn")) return "Respawn";
        if (lc.Contains("link")) return "Linkable";
        if (lc.Contains("static") || lc.Contains("indoor") || lc.Contains("overworld"))
            return "Static";
        return "Unknown";
    }
}

/// <summary>
/// Minimal weenie descriptor used by <see cref="SpawnGazetteerBuilder.BuildFromAceLandblockInstances"/>.
/// Decoupled from <see cref="AceWeenieSnapshot"/> so the builder can be fed
/// from any source (DB, JSONL cache, in-memory test fixture).
/// </summary>
public readonly record struct AceWeenieDescriptor(int Wcid, string Name, int? WeenieType);
