using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

/// <summary>
/// Picks a curated set of landblocks to feature in the visual atlas
/// gallery (<c>emit-atlas-gallery</c>). Composes four pickers — towns,
/// creature zones, dungeons, region anchors — over the in-engine
/// gazetteer state the spin wave (2026-05-01) brought online so the
/// gallery is reproducible from data the engine already loads, not from
/// hand-typed lbX/lbY pairs.
///
/// Pure read-only over <see cref="CommandEngine"/>. Outputs an ordered
/// list of <see cref="AtlasPick"/> entries; the gallery emitter passes
/// them straight to <c>RenderPreview</c> + <c>DescribeLandblock</c>.
/// </summary>
public static class AtlasCurator {

    /// <summary>One curated pick. Title + Note are human-facing; the
    /// gallery emitter slugs the title for filenames and renders the
    /// note as the card subtitle.</summary>
    public sealed record AtlasPick(
        ushort LbKey,
        string Title,
        string Category,
        string Note,
        int? SpawnCount,
        int? CellCount);

    public static List<AtlasPick> Curate(
            CommandEngine engine,
            int towns = 5,
            int creatureZones = 5,
            int dungeons = 5,
            int regionAnchors = 5) {
        var picks = new List<AtlasPick>();
        var seen = new HashSet<ushort>();

        foreach (var p in PickTowns(engine, towns)) {
            if (seen.Add(p.LbKey)) picks.Add(p);
        }
        foreach (var p in PickCreatureZones(engine, creatureZones, seen)) {
            if (seen.Add(p.LbKey)) picks.Add(p);
        }
        foreach (var p in PickDungeons(engine, dungeons, seen)) {
            if (seen.Add(p.LbKey)) picks.Add(p);
        }
        foreach (var p in PickRegionAnchors(engine, regionAnchors, seen)) {
            if (seen.Add(p.LbKey)) picks.Add(p);
        }
        return picks;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Towns: settlements from the project's town_gazetteer.json
    // ────────────────────────────────────────────────────────────────────

    // Famous Asheron's Call settlements — preferred when present in the
    // gazetteer. Order matters: we walk the list and pick the first N
    // that resolve to known LBs. Falls back to gazetteer iteration order
    // if fewer than N famous towns are loaded.
    private static readonly string[] FamousTowns = new[] {
        "Holtburg", "Yaraq", "Shoushi", "Cragstone", "Arwic", "Sanamar",
        "Eastham", "Lytelthorpe", "Rithwic", "Yanshi", "Tufa", "Hebian-To",
        "Nanto", "Mayoi", "Zaikhal", "Khayyaban", "Samsur", "Uziz",
    };

    private static IEnumerable<AtlasPick> PickTowns(CommandEngine engine, int n) {
        if (n <= 0) yield break;
        var gazetteer = engine.GetTownGazetteerSnapshot();
        if (gazetteer.Count == 0) yield break;

        // Preferred order: the famous list, then any remaining gazetteer
        // entries in iteration order. Build a name→lbKey index once so the
        // famous walk is O(1) per name.
        var byName = new Dictionary<string, (ushort Lb, LandblockDescriber.TownContext Ctx)>(
            StringComparer.OrdinalIgnoreCase);
        foreach (var (lb, ctx) in gazetteer) {
            if (!byName.ContainsKey(ctx.Name)) byName[ctx.Name] = (lb, ctx);
        }

        int yielded = 0;
        var emittedKeys = new HashSet<ushort>();
        foreach (var name in FamousTowns) {
            if (yielded >= n) break;
            if (!byName.TryGetValue(name, out var hit)) continue;
            if (!emittedKeys.Add(hit.Lb)) continue;
            yielded++;
            yield return MakeTownPick(hit.Lb, hit.Ctx);
        }
        if (yielded >= n) yield break;
        foreach (var (lb, ctx) in gazetteer) {
            if (yielded >= n) yield break;
            if (!emittedKeys.Add(lb)) continue;
            yielded++;
            yield return MakeTownPick(lb, ctx);
        }
    }

    private static AtlasPick MakeTownPick(ushort lb, LandblockDescriber.TownContext ctx) {
        var noteParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(ctx.Culture)) noteParts.Add(ctx.Culture!);
        noteParts.Add($"LB 0x{lb:X4}");
        if (!string.IsNullOrWhiteSpace(ctx.Notes)) noteParts.Add(ctx.Notes!);
        return new AtlasPick(lb, ctx.Name, "town",
            string.Join(" — ", noteParts), null, null);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Creature zones: top-N outdoor LBs by Creature spawn count
    // ────────────────────────────────────────────────────────────────────

    private static IEnumerable<AtlasPick> PickCreatureZones(
            CommandEngine engine, int n, HashSet<ushort> alreadyPicked) {
        if (n <= 0) yield break;
        var gazetteer = engine.GetSpawnGazetteerSnapshot();
        if (gazetteer.Count == 0) yield break;

        // Score each LB by outdoor creature density: cell ≤ 0x40 (outdoor),
        // category == Creature. Track the top weenie name for the title,
        // and the distinct wcid count for the note. Indoor cells are
        // excluded because the showcase is the surface map; dungeon
        // creatures show via the dungeon picker.
        var scored = new List<(ushort Lb, int Count, int DistinctWcids, string TopName)>();
        foreach (var (lb, spawns) in gazetteer) {
            int total = 0;
            var wcidNames = new Dictionary<int, (string Name, int Count)>();
            foreach (var sp in spawns) {
                if (sp.Cell > 0x40) continue;          // indoor / dungeon
                if (sp.Category != "Creature") continue;
                total++;
                if (wcidNames.TryGetValue(sp.Wcid, out var prev)) {
                    wcidNames[sp.Wcid] = (prev.Name, prev.Count + 1);
                } else {
                    wcidNames[sp.Wcid] = (sp.Name, 1);
                }
            }
            if (total == 0) continue;
            string topName = "Creatures";
            int topCount = -1;
            foreach (var kv in wcidNames) {
                if (kv.Value.Count > topCount) {
                    topCount = kv.Value.Count;
                    topName = string.IsNullOrWhiteSpace(kv.Value.Name)
                        ? $"Wcid {kv.Key}" : kv.Value.Name;
                }
            }
            scored.Add((lb, total, wcidNames.Count, topName));
        }
        scored.Sort((a, b) => b.Count.CompareTo(a.Count));

        // Chebyshev-dedupe: prefer the densest, then skip neighbours within
        // 4 LB steps so we don't pick five adjacent tiles of the same camp.
        // Distance is on the lbX/lbY grid (LB key high/low byte).
        const int minSeparation = 4;
        var pickedCenters = new List<(int X, int Y)>();
        int yielded = 0;
        foreach (var s in scored) {
            if (yielded >= n) break;
            if (alreadyPicked.Contains(s.Lb)) continue;
            int x = (s.Lb >> 8) & 0xFF;
            int y = s.Lb & 0xFF;
            bool tooClose = false;
            foreach (var (px, py) in pickedCenters) {
                int dx = Math.Abs(x - px), dy = Math.Abs(y - py);
                if (Math.Max(dx, dy) < minSeparation) { tooClose = true; break; }
            }
            if (tooClose) continue;
            pickedCenters.Add((x, y));
            yielded++;
            string title = $"{s.TopName} Camp";
            string note = $"{s.Count} spawns, {s.DistinctWcids} distinct wcids — LB 0x{s.Lb:X4}";
            yield return new AtlasPick(s.Lb, title, "creature zone", note, s.Count, null);
        }
    }

    // ────────────────────────────────────────────────────────────────────
    //  Dungeons: top-N by cell count × floor count
    // ────────────────────────────────────────────────────────────────────

    private static IEnumerable<AtlasPick> PickDungeons(
            CommandEngine engine, int n, HashSet<ushort> alreadyPicked) {
        if (n <= 0) yield break;
        var dungeonLbs = engine.ListDungeonLandblockKeys();
        if (dungeonLbs.Count == 0) yield break;

        var scored = new List<(ushort Lb, int CellCount, int FloorCount, int Score)>();
        foreach (var lb in dungeonLbs) {
            try {
                int cells = engine.GetDungeonCellCount(lb);
                if (cells < 4) continue;
                int floors = engine.GetDungeonFloorCount(lb);
                int score = cells * Math.Max(1, floors);
                scored.Add((lb, cells, floors, score));
            } catch { /* skip malformed dungeons */ }
        }
        scored.Sort((a, b) => b.Score.CompareTo(a.Score));

        int yielded = 0;
        foreach (var s in scored) {
            if (yielded >= n) break;
            if (alreadyPicked.Contains(s.Lb)) continue;
            yielded++;
            string title = $"Dungeon 0x{s.Lb:X4}";
            string note = $"{s.CellCount} cells, {s.FloorCount} floors";
            yield return new AtlasPick(s.Lb, title, "dungeon", note, null, s.CellCount);
        }
    }

    // ────────────────────────────────────────────────────────────────────
    //  Region anchors: one LB per region by region-name diversity
    // ────────────────────────────────────────────────────────────────────

    private static IEnumerable<AtlasPick> PickRegionAnchors(
            CommandEngine engine, int n, HashSet<ushort> alreadyPicked) {
        if (n <= 0) yield break;
        var anchors = engine.GetRegionAnchorsSnapshot();
        if (anchors.Count == 0) yield break;

        var seenRegions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int yielded = 0;
        foreach (var (lb, region) in anchors) {
            if (yielded >= n) break;
            if (alreadyPicked.Contains(lb)) continue;
            if (!seenRegions.Add(region)) continue;
            yielded++;
            yield return new AtlasPick(lb, $"{region} anchor", "region",
                $"Region anchor — LB 0x{lb:X4}", null, null);
        }
    }
}
