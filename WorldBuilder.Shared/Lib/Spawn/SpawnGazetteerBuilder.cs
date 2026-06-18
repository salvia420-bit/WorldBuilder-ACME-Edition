using System.Globalization;
using System.Numerics;
using System.Text.Json;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

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
    /// hex landblock ID, values are arrays of spawn entries). Drops only
    /// unidentified entries (wcid=0 or name="?"). Server-managed weenies
    /// (doors / chests / generators / statues) are kept and tagged via
    /// <see cref="SpawnRecord.IsServerManaged"/> so the renderer can stack
    /// them on top of their DAT-side pedestals; consumers that want the
    /// old "player-visible only" view can filter on the flag.
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
                int wcid = item.TryGetProperty("wcid", out var wEl)
                    && wEl.ValueKind == JsonValueKind.Number ? wEl.GetInt32() : 0;
                if (wcid == 0) continue;
                string name = item.TryGetProperty("name", out var nEl)
                    && nEl.ValueKind == JsonValueKind.String ? nEl.GetString()! : "?";
                if (string.IsNullOrEmpty(name) || name.Trim() == "?") {
                    // Server-managed rows often arrive nameless (a door
                    // weenie's wcid is the identifier). Keep them with a
                    // synthesised name; reject only when the wcid itself
                    // is missing.
                    name = $"Weenie {wcid}";
                }
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
                Quaternion orientation = ReadOrientation(item);

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
                    IsSynthetic: false,
                    IsServerManaged: serverManaged,
                    Orientation: orientation));
            }
            if (spawns.Count > 0) result[lbKey] = spawns;
        }
        return result;
    }

    /// <summary>
    /// Parse an LSD JSON entry's optional orientation. Recognises both the
    /// flat <c>angles_w/x/y/z</c> shape (matches ACE column casing) and a
    /// nested <c>orientation: {w,x,y,z}</c> object. Defaults to identity
    /// when neither is present, so dumps without orientation just render
    /// upright.
    /// </summary>
    private static Quaternion ReadOrientation(JsonElement item) {
        if (item.TryGetProperty("angles_w", out var aw) && aw.ValueKind == JsonValueKind.Number
                && item.TryGetProperty("angles_x", out var ax) && ax.ValueKind == JsonValueKind.Number
                && item.TryGetProperty("angles_y", out var ay) && ay.ValueKind == JsonValueKind.Number
                && item.TryGetProperty("angles_z", out var az) && az.ValueKind == JsonValueKind.Number) {
            return new Quaternion(ax.GetSingle(), ay.GetSingle(), az.GetSingle(), aw.GetSingle());
        }
        if (item.TryGetProperty("orientation", out var oEl) && oEl.ValueKind == JsonValueKind.Object
                && oEl.TryGetProperty("w", out var ow) && ow.ValueKind == JsonValueKind.Number
                && oEl.TryGetProperty("x", out var ox) && ox.ValueKind == JsonValueKind.Number
                && oEl.TryGetProperty("y", out var oy) && oy.ValueKind == JsonValueKind.Number
                && oEl.TryGetProperty("z", out var oz) && oz.ValueKind == JsonValueKind.Number) {
            return new Quaternion(ox.GetSingle(), oy.GetSingle(), oz.GetSingle(), ow.GetSingle());
        }
        return Quaternion.Identity;
    }

    /// <summary>
    /// Build a SpawnRecord index from raw ACE <c>landblock_instance</c> rows
    /// (joined to <c>weenie</c> for name + type). The <paramref name="weenieIndex"/>
    /// supplies name + WeenieType per wcid; rows without a join entry get
    /// <see cref="SpawnRecord.IsSynthetic"/>=true and a placeholder name.
    /// </summary>
    public static Dictionary<ushort, List<SpawnRecord>> BuildFromAceLandblockInstances(
            IEnumerable<LandblockInstanceRecord> rows,
            IReadOnlyDictionary<int, AceWeenieDescriptor>? weenieIndex = null,
            IReadOnlyDictionary<uint, List<PlacementGenerator>>? generatorProfiles = null,
            IReadOnlyDictionary<uint, float>? generatorRadii = null,
            IReadOnlyDictionary<uint, int>? generatorMaxObjects = null,
            IReadOnlyDictionary<int, int>? childWeenieTypes = null) {
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

            // Orientation is optional on LandblockInstanceRecord (the row
            // reader only fills it when angles columns were SELECTed). When
            // absent, default to identity — the renderer's
            // OrientationOrIdentity accessor folds (0,0,0,0) into a valid
            // upright sprite.
            Quaternion orientation = Quaternion.Identity;
            if (row.AnglesW.HasValue && row.AnglesX.HasValue
                    && row.AnglesY.HasValue && row.AnglesZ.HasValue) {
                orientation = new Quaternion(
                    row.AnglesX.Value, row.AnglesY.Value, row.AnglesZ.Value, row.AnglesW.Value);
            }

            // Every landblock_instance row is a server-managed weenie by
            // definition — that's literally what the table is for. The
            // renderer uses this flag the same way it uses the LSD flag:
            // to optionally hide noise (chests, generators) without
            // dropping them from the underlying gazetteer.
            //
            // ~4.9% of rows own a weenie_properties_generator profile set.
            // Tag those anchors "Respawn" (they re-emit children over time)
            // and expand the selected children below; the other 95.1% stay
            // byte-identical to the prior 1:1 "Static" behaviour (DROP-2).
            bool isGenerator = generatorProfiles != null
                && generatorProfiles.ContainsKey((uint)wcid);
            list.Add(new SpawnRecord(
                Wcid: wcid,
                Name: name,
                Category: category,
                Generator: isGenerator ? "Respawn" : "Static",
                LandblockId: lbId,
                Cell: cell,
                X: row.OriginX, Y: row.OriginY, Z: row.OriginZ,
                WeenieType: weenieType,
                AcpediaTitle: null,
                AcpediaTier: null,
                IsSynthetic: synthetic,
                IsServerManaged: true,
                Orientation: orientation));

            if (isGenerator) {
                foreach (var child in ExpandGeneratorChildren(
                        wcid, lbId, cell, row.OriginX, row.OriginY, row.OriginZ,
                        generatorProfiles!, generatorRadii, generatorMaxObjects,
                        weenieIndex, childWeenieTypes, "Respawn")) {
                    list.Add(child);
                }
            }
        }
        return result;
    }

    /// <summary>
    /// Build a SpawnRecord index from raw ACE <c>encounter</c> rows. The
    /// encounter table is the server-side pre-resolved equivalent of the
    /// client terrain-byte spawn lookup: UNIQUE(landblock,cell_X,cell_Y) ⇒
    /// exactly one wcid per occupied cell, no per-cell count RNG, no jitter.
    ///
    /// Placement mirrors the GDL active path (<c>WorldLandBlock.cpp:150-151</c>):
    /// <c>localX/Y = Clamp(cell * 24, 0.5, 191.5)</c>, outdoor <c>cell = 1</c>,
    /// surface Z from the terrain service. Coordinates are stored <b>LB-local</b>
    /// (the renderer re-adds <c>lbX*192</c>) — do NOT add the world origin here.
    ///
    /// Per F7, the encounter wcid is emitted as a visible Creature, then handed
    /// to <see cref="ExpandGeneratorChildren"/> (the encounter wcid is itself a
    /// generator on the wilderness path) so the rendered fauna is the resolved
    /// child, not the invisible spawner.
    /// </summary>
    /// <param name="surfaceZ">
    /// Float-faithful terrain surface lookup, called <c>surfaceZ(lbId, localX,
    /// localY)</c> with the <b>un-truncated</b> floats so Z is byte-identical to
    /// the canonical <c>GetHeightAtWorldPosition</c> path.
    /// </param>
    public static Dictionary<ushort, List<SpawnRecord>> BuildFromAceEncounters(
            IEnumerable<EncounterRecord> encounters,
            Func<ushort, float, float, float> surfaceZ,
            IReadOnlyDictionary<int, AceWeenieDescriptor>? weenieIndex = null,
            IReadOnlyDictionary<uint, List<PlacementGenerator>>? generatorProfiles = null,
            IReadOnlyDictionary<uint, float>? generatorRadii = null,
            IReadOnlyDictionary<uint, int>? generatorMaxObjects = null,
            IReadOnlyDictionary<int, int>? childWeenieTypes = null) {
        var result = new Dictionary<ushort, List<SpawnRecord>>();
        foreach (var enc in encounters) {
            ushort lbId = enc.Landblock;
            int wcid = (int)enc.WeenieClassId;

            // GDL WorldLandBlock.cpp:150-151 active path: 24*cell, NO +12 jitter
            // (the jitter block 105-117 is commented-out dead code, F2). cell 8
            // → 192 clamps to 191.5 (11 real rows; the clamp ceiling is
            // load-bearing, NOT malformed data).
            float localX = Math.Clamp(enc.CellX * 24.0f, 0.5f, 191.5f);
            float localY = Math.Clamp(enc.CellY * 24.0f, 0.5f, 191.5f);
            float z = surfaceZ(lbId, localX, localY);
            const int cell = 1; // GDL:154 objcell_id = (lb<<16)|1 (outdoor cell 1)

            string name;
            int? weenieType;
            bool synthetic;
            if (weenieIndex != null && weenieIndex.TryGetValue(wcid, out var wn)) {
                name = wn.Name;
                weenieType = wn.WeenieType;
                synthetic = false;
            } else {
                name = $"Weenie {wcid}";
                weenieType = null;
                synthetic = true;
            }

            if (!result.TryGetValue(lbId, out var list)) {
                list = new List<SpawnRecord>();
                result[lbId] = list;
            }

            // F7: emit the encounter wcid itself as a visible Creature (it
            // spawns at the cell and then runs its own generator). On a
            // weenie-index miss it is wilderness fauna, not "Object".
            list.Add(new SpawnRecord(
                Wcid: wcid,
                Name: name,
                Category: "Creature",
                Generator: "Encounter",
                LandblockId: lbId,
                Cell: cell,
                X: localX, Y: localY, Z: z,
                WeenieType: weenieType,
                AcpediaTitle: null,
                AcpediaTier: null,
                IsSynthetic: synthetic,
                IsServerManaged: true,
                Orientation: Quaternion.Identity));

            // Resolve the generator's selected child(ren) so the rendered
            // entity is the child, not the invisible spawner.
            if (generatorProfiles != null && generatorProfiles.ContainsKey(enc.WeenieClassId)) {
                foreach (var child in ExpandGeneratorChildren(
                        wcid, lbId, cell, localX, localY, z,
                        generatorProfiles, generatorRadii, generatorMaxObjects,
                        weenieIndex, childWeenieTypes, "Encounter")) {
                    list.Add(child);
                }
            }
        }
        return result;
    }

    // ── Generator child expansion (F3 weighted-random pick-ONE, F4 FNV scatter) ──

    private const uint FnvOffset = 0x811C9DC5;
    private const uint FnvPrime  = 0x01000193;

    /// <summary>
    /// Self-contained FNV-1a/32 over a sequence of u32 words (each hashed as
    /// four little-endian bytes). Pins the deterministic generator seed; no
    /// JS↔C# byte-parity is required (expansion is C#-only).
    /// </summary>
    private static uint Fnv1a32(params uint[] words) {
        uint h = FnvOffset;
        foreach (var w in words) {
            for (int b = 0; b < 4; b++) {
                h ^= (w >> (b * 8)) & 0xFF;
                h *= FnvPrime;
            }
        }
        return h;
    }

    /// <summary>
    /// Mirror of ACE <c>WorldObject_Generators.GetTotalProbability</c> (184-214):
    /// the cumulative-diff probability ladder, returning 1.0 immediately if any
    /// unconditional (<c>Probability == -1</c>) profile exists.
    /// </summary>
    private static float GetTotalProbability(List<PlacementGenerator> profiles) {
        float total = 0.0f, last = 0.0f;
        foreach (var p in profiles) {
            float prob = p.Probability;
            if (prob == -1) return 1.0f;
            if (last > prob) last = 0.0f;
            total += prob - last;
            last = prob;
        }
        return total;
    }

    /// <summary>
    /// Mirror of ACE <c>GetAdjustedProbability(index)</c> (238-276): the cumulative
    /// threshold for the laddered profile at <paramref name="index"/> (−1 passed
    /// through for unconditional profiles).
    /// </summary>
    private static float GetAdjustedProbability(List<PlacementGenerator> profiles, int index) {
        if (profiles[index].Probability == -1) return -1f;
        float total = 0.0f, last = 0.0f;
        for (int i = 0; i <= index; i++) {
            float prob = profiles[i].Probability;
            if (prob == -1) continue;
            if (last > prob) last = 0.0f;
            total += prob - last;
            last = prob;
        }
        return total;
    }

    /// <summary>
    /// Resolve the deterministic set of child SpawnRecords a generator owner
    /// (<paramref name="ownerWcid"/>) spawns at its anchor. Returns CHILDREN
    /// ONLY — the caller emits the anchor. Faithful to ACE
    /// <c>SelectAProfile</c> (108-178): always emit every <c>Probability == -1</c>
    /// profile, plus exactly ONE FNV-seeded weighted pick among the laddered
    /// profiles; cap the per-owner grand total at MaxGeneratedObjects.
    /// </summary>
    public static IEnumerable<SpawnRecord> ExpandGeneratorChildren(
            int ownerWcid, ushort lbId, int cell,
            float anchorX, float anchorY, float anchorZ,
            IReadOnlyDictionary<uint, List<PlacementGenerator>> generatorProfiles,
            IReadOnlyDictionary<uint, float>? generatorRadii,
            IReadOnlyDictionary<uint, int>? generatorMaxObjects,
            IReadOnlyDictionary<int, AceWeenieDescriptor>? weenieIndex,
            IReadOnlyDictionary<int, int>? childWeenieTypes,
            string tag) {
        uint owner = (uint)ownerWcid;
        if (!generatorProfiles.TryGetValue(owner, out var profiles) || profiles.Count == 0)
            yield break;

        uint objCellId = ((uint)lbId << 16) | (uint)cell;
        float radius = (generatorRadii != null && generatorRadii.TryGetValue(owner, out var r)) ? r : 0f;

        // Per-owner cap (F3c): PropertyInt 81, else summed init_Create.
        int maxGen;
        if (generatorMaxObjects != null && generatorMaxObjects.TryGetValue(owner, out var mg)) {
            maxGen = mg;
        } else {
            maxGen = 0;
            foreach (var p in profiles) maxGen += p.InitCreate == -1 ? 1 : p.InitCreate;
        }
        if (maxGen < 1) maxGen = 1;

        // F3: one deterministic weighted roll across the laddered profiles.
        float totalProb = GetTotalProbability(profiles);
        float roll = totalProb > 0f
            ? (float)((Fnv1a32(objCellId, owner, 0u) / 4294967296.0) * totalProb)
            : 0f;

        int emitted = 0;
        bool rngPicked = false;
        for (int i = 0; i < profiles.Count && emitted < maxGen; i++) {
            var p = profiles[i];
            float adj = GetAdjustedProbability(profiles, i);
            bool unconditional = adj == -1f;

            // unconditional (-1) always emit; otherwise the FIRST profile the
            // roll falls under wins, then no further rng profile is taken.
            bool selected = unconditional || (!rngPicked && roll < adj);
            if (!selected) continue;

            int profileSlot = i;
            int childWcid = (int)p.WeenieClassId;
            uint where = p.WhereCreate;

            // D2: Treasure-bit FIRST → loot marker only, no deterministic child.
            if ((where & 0x40) != 0) {
                if (!unconditional) rngPicked = true;
                continue;
            }
            // Full where_Create (NO &0x0F mask): inventory placements never
            // reach the world floor.
            if ((where & 0x08) != 0 || (where & 0x10) != 0 || (where & 0x20) != 0) {
                if (!unconditional) rngPicked = true;
                continue; // Contain / Wield / Shop
            }

            // GDL skip-wcids W_HUMAN=1 / W_ADMIN=4 / W_SENTINEL=3648.
            if (childWcid == 1 || childWcid == 4 || childWcid == 3648) {
                if (!unconditional) rngPicked = true;
                continue;
            }

            // D5: numChildren = (InitCreate==-1 || MaxCreate==-1) ? 1 : InitCreate.
            int nChildren = (p.InitCreate == -1 || p.MaxCreate == -1) ? 1 : p.InitCreate;
            if (nChildren < 1) nChildren = 1;

            string childName;
            bool childSynthetic;
            if (weenieIndex != null && weenieIndex.TryGetValue(childWcid, out var wn)) {
                childName = wn.Name; childSynthetic = false;
            } else {
                childName = $"Weenie {childWcid}"; childSynthetic = true;
            }
            // D3: category via TryGetValue (never the [] indexer).
            int? childType = (childWeenieTypes != null && childWeenieTypes.TryGetValue(childWcid, out var ct))
                ? ct : (int?)null;
            string childCategory = childType.HasValue
                ? ResolveCategory(null, childType) : "Object";

            for (int c = 0; c < nChildren && emitted < maxGen; c++) {
                float cx = anchorX, cy = anchorY, cz = anchorZ;
                if ((where & 0x04) != 0) {
                    // Specific: anchor + profile origin offset (GDL 2720-2727).
                    cx = anchorX + (p.OriginX ?? 0f);
                    cy = anchorY + (p.OriginY ?? 0f);
                    cz = anchorZ + (p.OriginZ ?? 0f);
                } else if ((where & 0x02) != 0) {
                    // Scatter: anchor + FNV offset (F4), clamp x,y ≥ 0.5, Z=anchor.
                    // Seed over (owner, profileSlot, childIndex, objCellId) —
                    // objCellId folds in landblock + cell, so the snapshot is a
                    // pure function of the inputs (byte-stable re-stage).
                    uint seed = Fnv1a32(owner, (uint)profileSlot, (uint)c, objCellId);
                    float u1 = (seed >> 8) / 16777216.0f;
                    float u2 = (Fnv1a32(seed) >> 8) / 16777216.0f;
                    cx = Math.Max(0.5f, anchorX + (u1 * 2f - 1f) * radius);
                    cy = Math.Max(0.5f, anchorY + (u2 * 2f - 1f) * radius);
                    cz = anchorZ;
                }
                // OnTop(0x01) / Undef(0) / default: child at anchor pose.

                yield return new SpawnRecord(
                    Wcid: childWcid,
                    Name: childName,
                    Category: childCategory,
                    Generator: tag,
                    LandblockId: lbId,
                    Cell: cell,
                    X: cx, Y: cy, Z: cz,
                    WeenieType: childType,
                    AcpediaTitle: null,
                    AcpediaTier: null,
                    IsSynthetic: childSynthetic,
                    IsServerManaged: true,
                    Orientation: Quaternion.Identity);
                emitted++;
            }

            if (!unconditional) rngPicked = true;
        }
    }

    /// <summary>
    /// Resolve a render-time category from an ACE WeenieType (canonical) and
    /// an Acpedia category list (community-curated, used only to refine
    /// ambiguous types). Returns one of: "Creature" | "Npc" | "Object" |
    /// "Surface".
    ///
    /// Type-first ordering replaces the prior Acpedia-first behaviour. The
    /// previous switch also used wrong WeenieType constants (Vendor=45 was
    /// LScoreKeeper, "Talker=4" was Missile, "20=Npc" was Chest); those are
    /// pinned to canonical values here. See AceWeenieType in
    /// WorldBuilder.Shared.Lib.AceDb.AceWeenieTypes for the full enum.
    /// </summary>
    public static string ResolveCategory(string[]? acpediaCategories, int? weenieType) {
        // Canonical AceWeenieType → category. Unambiguous for every type
        // listed; the spawn gazetteer doesn't differentiate talker NPCs from
        // monsters within Type=10 (the WeenieIndex's IsTalker flag does that).
        switch (weenieType) {
            case 10: return "Creature";     // Creature (monsters and talkers)
            case 12: return "Npc";          // Vendor
            case  7: return "Object";       // Portal
            case 19: return "Object";       // Door
            case 20: return "Object";       // Chest
            case 21: return "Object";       // Container
            case 25: return "Object";       // LifeStone
            case 26: return "Object";       // Switch
            case 29: return "Object";       // LightSource
            case 36: return "Object";       // Channel (signs, shrines)
            case 60: return "Object";       // HousePortal
        }

        // Type=1 (Generic), Type=18 (Food), and unmapped types are ambiguous
        // — fall back to Acpedia as a refinement hint.
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
        return "Object";
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
