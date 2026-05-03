using System.Numerics;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Resolves Region.SceneInfo + per-terrain-type Scene tables and answers
/// per-cell deterministic decoration placements. One placement per cell at
/// most — the renderer overlays a small sprite blit using the placement's
/// ObjectId at the cell's centre offset by the picked ObjectDesc.BaseLoc.
///
/// The placement rule is deterministic on (cellId, sceneIndex): re-running
/// the renderer on the same project+region produces an identical decoration
/// layer, so tile pyramids generate stably across rebuilds and re-runs.
///
/// AC's runtime spawns multiple objects per cell with frequency-weighted
/// scatter; the static atlas mirror trades that fidelity for predictability
/// and lets the existing sprite pipeline cover scene meshes without a new
/// renderer codepath.
/// </summary>
public sealed class SceneDecorationLoader {

    public sealed record Decoration(uint ObjectId, Vector3 Offset, float Scale, float YawRadians);

    /// <summary>
    /// Per-terrain-type list of resolved Scene records. Each entry is one
    /// Scene's ObjectDescs already laid out with a cumulative-frequency
    /// table for O(log N) frequency-weighted picks.
    /// </summary>
    private sealed record SceneRecord(
        uint SceneDid,
        IReadOnlyList<ObjectDesc> Objects,
        float[] CumulativeFreq);

    private readonly Dictionary<byte, List<SceneRecord>> _byTerrainType = new();

    public bool HasAnyScenes => _byTerrainType.Values.Any(list => list.Count > 0);

    /// <summary>
    /// Every distinct ObjectDesc.ObjectId across every loaded Scene. The
    /// sprite-atlas builder seeds this set into its model collection so
    /// the renderer's scene pass has atlas entries to look up.
    /// </summary>
    public HashSet<uint> CollectAllSceneObjectIds() {
        var ids = new HashSet<uint>();
        foreach (var list in _byTerrainType.Values) {
            foreach (var rec in list) {
                foreach (var obj in rec.Objects) {
                    if (obj.ObjectId != 0) ids.Add(obj.ObjectId);
                }
            }
        }
        return ids;
    }

    /// <summary>
    /// Pick a deterministic decoration for a cell. Returns null when the
    /// cell's terrain type carries no resolved Scenes, when the picked
    /// Scene is empty, or when the cumulative frequency table is degenerate.
    /// <paramref name="cellHash"/> is any 32-bit value derived from the
    /// cell's identity (typically Wang-hashed cellId) — the caller owns
    /// the hash so the same cellId hashes the same way across renders.
    /// </summary>
    public Decoration? PickForCell(byte terrainType, uint cellHash) {
        if (!_byTerrainType.TryGetValue(terrainType, out var scenes)) return null;
        if (scenes.Count == 0) return null;
        var scene = scenes[(int)(cellHash % (uint)scenes.Count)];
        if (scene.Objects.Count == 0) return null;
        // Frequency-weighted pick. Total = last cumulative entry. Pick a
        // float in [0, total) deterministically from the high bits of
        // cellHash so the scene-index pick (low bits) and frequency pick
        // (high bits) decorrelate — two adjacent cells in the same scene
        // shouldn't keep landing on the same ObjectDesc.
        float total = scene.CumulativeFreq[^1];
        if (total <= 0f) return null;
        // Mix to avoid the high 16 bits being all zero on small hashes.
        uint mixed = cellHash * 2654435761u;
        float pick = (mixed >> 8) / (float)(1u << 24) * total;
        int idx = LowerBound(scene.CumulativeFreq, pick);
        if (idx >= scene.Objects.Count) idx = scene.Objects.Count - 1;
        var obj = scene.Objects[idx];
        if (obj.ObjectId == 0) return null;
        // Random scale within [MinScale, MaxScale] — interpolate by a
        // separate hash slice so it's independent of the ObjectDesc pick.
        float scaleFrac = ((cellHash >> 16) & 0xFFFF) / (float)0xFFFF;
        float minScale = obj.MinScale > 0f ? obj.MinScale : 1f;
        float maxScale = obj.MaxScale > minScale ? obj.MaxScale : minScale;
        float scale = minScale + scaleFrac * (maxScale - minScale);
        // Random rotation within [-MaxRotation, MaxRotation] (radians).
        float rotFrac = ((cellHash >> 24) & 0xFF) / (float)0xFF * 2f - 1f;
        float yaw = obj.MaxRotation * rotFrac;
        // Scatter inside the cell from DisplaceX/Y. AC seeds these per cell;
        // we sample a deterministic pair from the hash so the placement
        // doesn't always pin to the cell centre.
        float dispX = (((cellHash >> 4) & 0xFF) / 255f - 0.5f) * obj.DisplaceX * 2f;
        float dispY = (((cellHash >> 12) & 0xFF) / 255f - 0.5f) * obj.DisplaceY * 2f;
        var offset = new Vector3(
            obj.BaseLoc.Origin.X + dispX,
            obj.BaseLoc.Origin.Y + dispY,
            obj.BaseLoc.Origin.Z);
        return new Decoration(obj.ObjectId, offset, scale, yaw);
    }

    /// <summary>
    /// Wang-hash a 32-bit packed cellId. Stable, decorrelates the cell-id
    /// bit pattern (which often has small variance across adjacent cells)
    /// into something usable as an RNG seed without import-side complexity.
    /// Pick rules above only inspect 8-bit windows of the result, so this
    /// just needs to spread bits, not be cryptographic.
    /// </summary>
    public static uint HashCellId(uint cellId) {
        unchecked {
            cellId = (cellId ^ 61) ^ (cellId >> 16);
            cellId = cellId + (cellId << 3);
            cellId = cellId ^ (cellId >> 4);
            cellId = cellId * 0x27d4eb2d;
            cellId = cellId ^ (cellId >> 15);
            return cellId;
        }
    }

    public static SceneDecorationLoader Load(IDatReaderWriter dats) {
        var result = new SceneDecorationLoader();
        if (!SafeTryGet<Region>(dats, 0x13000000, out var region)) {
            Console.Error.WriteLine("[SceneDeco] Region 0x13000000 missing — no decorations.");
            return result;
        }
        var sceneInfo = region.SceneInfo;
        var terrainTypes = region.TerrainInfo?.TerrainTypes;
        if (sceneInfo == null || sceneInfo.SceneTypes == null
                || terrainTypes == null || terrainTypes.Count == 0) {
            Console.Error.WriteLine("[SceneDeco] Region.SceneInfo or TerrainTypes empty — no decorations.");
            return result;
        }

        // Pre-resolve every Scene we might need so per-cell picks don't
        // re-read the dat. Walk each TerrainType (index = terrain byte)
        // and chase its SceneTypes list.
        int totalScenes = 0;
        for (int t = 0; t < terrainTypes.Count; t++) {
            var tt = terrainTypes[t];
            if (tt.SceneTypes == null || tt.SceneTypes.Count == 0) continue;
            var collected = new List<SceneRecord>();
            foreach (var sceneTypeIdx in tt.SceneTypes) {
                if (sceneTypeIdx >= sceneInfo.SceneTypes.Count) continue;
                var st = sceneInfo.SceneTypes[(int)sceneTypeIdx];
                if (st.Scenes == null) continue;
                foreach (var sceneRef in st.Scenes) {
                    uint sceneDid = sceneRef.DataId;
                    if (sceneDid == 0 || (sceneDid >> 24) != 0x12) continue;
                    if (!SafeTryGet<Scene>(dats, sceneDid, out var scene)) continue;
                    if (scene.Objects == null || scene.Objects.Count == 0) continue;
                    var cum = new float[scene.Objects.Count];
                    float run = 0f;
                    for (int i = 0; i < scene.Objects.Count; i++) {
                        // Frequency 0 is allowed in the dat (means "do not
                        // place"); using max(0, freq) keeps the cumulative
                        // monotone so the binary search still works.
                        run += MathF.Max(0f, scene.Objects[i].Frequency);
                        cum[i] = run;
                    }
                    collected.Add(new SceneRecord(sceneDid, scene.Objects, cum));
                    totalScenes++;
                }
            }
            if (collected.Count > 0) result._byTerrainType[(byte)t] = collected;
        }
        Console.Error.WriteLine($"[SceneDeco] Loaded {totalScenes} scenes across " +
            $"{result._byTerrainType.Count} terrain types.");
        return result;
    }

    private static int LowerBound(float[] sortedAsc, float v) {
        int lo = 0, hi = sortedAsc.Length;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (sortedAsc[mid] < v) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    private static bool SafeTryGet<T>(IDatReaderWriter dats, uint id, out T value)
            where T : class, DatReaderWriter.Lib.IO.IDBObj, new() {
        try { return dats.TryGet<T>(id, out value!); }
        catch { value = null!; return false; }
    }
}
