using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration Phase X.2 — cross-DAT transplant.
/// See <c>docs/melt-integration-plan-2026-06-10.md</c> §4.2.
///
/// Melt's killer workflow is composing a world from pieces of other DATs
/// (<c>replaceLandblock</c>/<c>addBuildingFrom</c> with a <c>fromDat</c>).
/// These commands reproduce that on WB's document model:
///
///   - <c>copy-landblock</c> — copy a landblock's terrain (heightmap and/or
///     textures), exterior objects, and buildings (with interior EnvCells)
///     from an external DAT into the project, optionally relocated.
///   - <c>copy-building</c> — transplant one building + its interior cells
///     to an arbitrary position.
///   - <c>remove-building</c> — drop a building (and orphan its cells, per
///     the existing exporter semantics).
///   - <c>bulk-paint-replace</c> — melt
///     <c>replaceLandblockSpecificTexture</c>/<c>landblockBucketFill</c>:
///     bulk terrain-type substitution across many landblocks.
///
/// Cell-ID remapping and cross-reference fixup (CellPortals.OtherCellId,
/// VisibleCells incl. LandCell deltas, building portal OtherCellId +
/// StabList, LandBlockInfo.NumCells — the contract from acclient.h
/// 31893–32308) are delegated to the battle-tested
/// <see cref="BuildingBlueprintCache"/> donor-blueprint pipeline that
/// remap-buildings-v2 and LandblockDocument.SaveToDats already use; this
/// file's job is to feed it donors from EXTERNAL DATs (Phase X.1 handles)
/// and stage the placements. Mutations are staged in documents — run
/// <c>validate-landblock</c> on touched LBs and then <c>export</c>.
///
/// Behavioral reference: <c>external/melt/Source/datFile/datFileManipulation.cs</c>
/// (reference only — reimplemented on WB's document + blueprint pipeline).
/// </summary>
public partial class CommandEngine {

    /// <summary>Read-only IDatReaderWriter view over an external DatCollection
    /// so BuildingBlueprintCache can extract donor blueprints from it.</summary>
    private sealed class ReadOnlyCollectionAdapter : IDatReaderWriter {
        private readonly DatCollection _dats;
        private readonly bool _owns;
        public ReadOnlyCollectionAdapter(DatCollection dats, bool owns) { _dats = dats; _owns = owns; }
        public DatCollection Dats => _dats;
        public bool TryGet<T>(uint id, out T file) where T : DRW.Lib.IO.IDBObj, new() =>
            _dats.TryGet(id, out file!);
        public bool TrySave<T>(T file, int? iteration = 0) where T : DRW.Lib.IO.IDBObj, new() =>
            throw new InvalidOperationException("This DAT source is read-only (transplant donor).");
        public void Dispose() { if (_owns) _dats.Dispose(); }
    }

    /// <summary>Resolve a transplant source: dat-open alias (must be a
    /// directory collection) or a DAT directory path.</summary>
    private (IDatReaderWriter Source, string Key, bool Owned) ResolveTransplantSource(string fromDat) {
        if (string.IsNullOrWhiteSpace(fromDat))
            throw new ArgumentException("fromDat (dat-open alias or DAT directory) is required.");
        if (_externalDats.TryGetValue(fromDat.Trim(), out var handle)) {
            if (handle.Collection == null)
                throw new ArgumentException(
                    $"dat handle '{handle.Alias}' is a single file — transplant needs a full DAT directory (cell+portal).");
            return (new ReadOnlyCollectionAdapter(handle.Collection, owns: false), $"handle:{handle.Alias}", false);
        }
        var full = Path.GetFullPath(fromDat.Trim());
        if (!Directory.Exists(full))
            throw new FileNotFoundException(
                $"fromDat '{fromDat}' is neither an open dat-open alias nor a DAT directory.");
        var collection = new DatCollection(full, DRW.Options.DatAccessType.Read);
        return (new ReadOnlyCollectionAdapter(collection, owns: true), $"dat:{full}", true);
    }

    private const float LbEdge = 192f;

    // ─────────────────────────────────────────────────────────────────
    //  copy-building
    // ─────────────────────────────────────────────────────────────────

    public CopyBuildingResult CopyBuilding(
        string fromDat, uint srcLbX, uint srcLbY, int buildingIndex,
        uint dstLbX, uint dstLbY, float x, float y, float z,
        Quaternion? orientation) {
        RequireProject();
        ValidateLbLocalCoord(dstLbX, dstLbY, x, y, "copy-building");

        var (source, sourceKey, owned) = ResolveTransplantSource(fromDat);
        try {
            ushort srcKey = LbKey(srcLbX, srcLbY);
            ushort dstKey = LbKey(dstLbX, dstLbY);

            if (!source.TryGet<LandBlockInfo>((uint)(srcKey << 16) | 0xFFFE, out var srcLbi) || srcLbi == null)
                throw new InvalidOperationException($"Source landblock 0x{srcKey:X4} has no LandBlockInfo in {sourceKey}.");
            if (buildingIndex < 0 || buildingIndex >= srcLbi.Buildings.Count)
                throw new ArgumentOutOfRangeException(nameof(buildingIndex),
                    $"buildingIndex {buildingIndex} out of range — source LB has {srcLbi.Buildings.Count} buildings.");

            var building = srcLbi.Buildings[buildingIndex];
            uint modelId = building.ModelId;

            // Extract the donor blueprint NOW from the external DAT. The
            // blueprint cache is session-static, so export-time instantiation
            // (LandblockDocument.SaveToDats → GetBlueprintForPlacement) finds it
            // via the donor hint without ever touching the external DAT again.
            var blueprint = BuildingBlueprintCache.GetBlueprintFromDonor(
                modelId, srcKey, buildingIndex, source)
                ?? throw new InvalidOperationException(
                    $"Could not extract blueprint for building 0x{modelId:X8} (LB 0x{srcKey:X4} index {buildingIndex}) from {sourceKey}.");

            var localOrigin = new Vector3(x - dstLbX * LbEdge, y - dstLbY * LbEdge, z);
            BuildingBlueprintCache.RegisterPlacementDonorHint(
                modelId, dstKey, localOrigin, srcKey, buildingIndex);

            var lbDoc = GetLandblockDocOrCreate(dstKey);
            int index = lbDoc.AddStaticObject(new StaticObject {
                Id = modelId,
                IsSetup = (modelId >> 24) == 0x02,
                Origin = new Vector3(x, y, z),
                Orientation = orientation ?? building.Frame.Orientation,
                Scale = Vector3.One,
            });

            var warnings = new List<string>();
            var projectDats = _projectManager.CurrentProject!.DocumentManager.Dats;
            if (!BuildingBlueprintCache.IsBuildingModelId(modelId, projectDats))
                warnings.Add($"model 0x{modelId:X8} is not a known building model in the PROJECT DATs — " +
                    "export will place it as a plain stab without interior cells.");

            return new CopyBuildingResult(
                SourceKey: sourceKey,
                SrcLb: $"0x{srcKey:X4}", BuildingIndex: buildingIndex,
                ModelId: $"0x{modelId:X8}",
                DstLb: $"0x{dstKey:X4}", StaticObjectIndex: index,
                InteriorCells: blueprint.Cells.Count,
                Warnings: warnings);
        }
        finally {
            if (owned) source.Dispose();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  copy-landblock
    // ─────────────────────────────────────────────────────────────────

    public CopyLandblockResult CopyLandblock(
        string fromDat, uint srcLbX, uint srcLbY, uint? dstLbXOpt, uint? dstLbYOpt,
        bool heightmap, bool textures, bool objects, bool buildings, bool clearExisting) {
        RequireProject();
        if (!heightmap && !textures && !objects && !buildings)
            throw new ArgumentException("Nothing to copy — enable at least one of heightmap/textures/objects/buildings.");
        if (clearExisting && (objects ^ buildings))
            throw new ArgumentException(
                "clearExisting wipes ALL staged static objects (shells included) — use it only with objects:true AND buildings:true.");

        var (source, sourceKey, owned) = ResolveTransplantSource(fromDat);
        try {
            ushort srcKey = LbKey(srcLbX, srcLbY);
            uint dstLbX = dstLbXOpt ?? srcLbX, dstLbY = dstLbYOpt ?? srcLbY;
            ushort dstKey = LbKey(dstLbX, dstLbY);
            var warnings = new List<string>();

            // ── Terrain (heightmap + texture/road/scenery bytes) ──
            int terrainVerts = 0;
            if (heightmap || textures) {
                if (!source.TryGet<LandBlock>((uint)(srcKey << 16) | 0xFFFF, out var srcLb) || srcLb == null)
                    throw new InvalidOperationException($"Source landblock 0x{srcKey:X4} not found in {sourceKey}.");
                var terrainDoc = GetTerrainDoc();
                var current = terrainDoc.GetLandblockInternal(dstKey)
                    ?? throw new InvalidOperationException($"Destination landblock 0x{dstKey:X4} has no terrain in the project.");
                var entries = new TerrainEntry[81];
                for (int i = 0; i < 81; i++) {
                    entries[i] = new TerrainEntry(
                        road: textures ? srcLb.Terrain[i].Road : current[i].Road,
                        scenery: textures ? srcLb.Terrain[i].Scenery : current[i].Scenery,
                        type: textures ? (byte)srcLb.Terrain[i].Type : current[i].Type,
                        height: heightmap ? srcLb.Height[i] : current[i].Height);
                }
                terrainDoc.UpdateLandblockInternal(dstKey, entries, out var modified);
                terrainVerts = 81;
            }

            // ── Objects + buildings (LandBlockInfo) ──
            int objectsCopied = 0, buildingsCopied = 0, cellsStaged = 0, cleared = 0;
            if (objects || buildings) {
                source.TryGet<LandBlockInfo>((uint)(srcKey << 16) | 0xFFFE, out var srcLbi);
                if (srcLbi == null) {
                    warnings.Add($"source LB 0x{srcKey:X4} has no LandBlockInfo — no objects/buildings to copy.");
                }
                else {
                    var lbDoc = GetLandblockDocOrCreate(dstKey);
                    if (clearExisting) cleared = lbDoc.ClearStaticObjects();

                    float baseX = dstLbX * LbEdge, baseY = dstLbY * LbEdge;

                    if (objects) {
                        foreach (var stab in srcLbi.Objects) {
                            lbDoc.AddStaticObject(new StaticObject {
                                Id = stab.Id,
                                IsSetup = (stab.Id >> 24) == 0x02,
                                Origin = new Vector3(
                                    baseX + stab.Frame.Origin.X,
                                    baseY + stab.Frame.Origin.Y,
                                    stab.Frame.Origin.Z),
                                Orientation = stab.Frame.Orientation,
                                Scale = Vector3.One,
                            });
                            objectsCopied++;
                        }
                    }

                    if (buildings) {
                        var projectDats = _projectManager.CurrentProject!.DocumentManager.Dats;
                        for (int i = 0; i < srcLbi.Buildings.Count; i++) {
                            var building = srcLbi.Buildings[i];
                            var blueprint = BuildingBlueprintCache.GetBlueprintFromDonor(
                                building.ModelId, srcKey, i, source);
                            if (blueprint == null) {
                                warnings.Add($"building[{i}] 0x{building.ModelId:X8}: blueprint extraction failed — skipped.");
                                continue;
                            }
                            BuildingBlueprintCache.RegisterPlacementDonorHint(
                                building.ModelId, dstKey, building.Frame.Origin, srcKey, i);
                            lbDoc.AddStaticObject(new StaticObject {
                                Id = building.ModelId,
                                IsSetup = (building.ModelId >> 24) == 0x02,
                                Origin = new Vector3(
                                    baseX + building.Frame.Origin.X,
                                    baseY + building.Frame.Origin.Y,
                                    building.Frame.Origin.Z),
                                Orientation = building.Frame.Orientation,
                                Scale = Vector3.One,
                            });
                            buildingsCopied++;
                            cellsStaged += blueprint.Cells.Count;
                            if (!BuildingBlueprintCache.IsBuildingModelId(building.ModelId, projectDats))
                                warnings.Add($"building[{i}] model 0x{building.ModelId:X8} unknown to PROJECT DATs — export will place it as a plain stab.");
                        }
                    }
                }
            }

            return new CopyLandblockResult(
                SourceKey: sourceKey,
                SrcLb: $"0x{srcKey:X4}", DstLb: $"0x{dstKey:X4}",
                TerrainVertices: terrainVerts,
                HeightmapCopied: heightmap, TexturesCopied: textures,
                ObjectsCopied: objectsCopied, BuildingsCopied: buildingsCopied,
                InteriorCellsStaged: cellsStaged, ClearedExisting: cleared,
                Warnings: warnings);
        }
        finally {
            if (owned) source.Dispose();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  remove-building
    // ─────────────────────────────────────────────────────────────────

    public RemoveBuildingResult RemoveBuilding(uint lbX, uint lbY, int buildingIndex) {
        RequireProject();
        ushort lbKey = LbKey(lbX, lbY);
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        if (!dats.TryGet<LandBlockInfo>((uint)(lbKey << 16) | 0xFFFE, out var lbi) || lbi == null)
            throw new InvalidOperationException($"Landblock 0x{lbKey:X4} has no LandBlockInfo.");
        if (buildingIndex < 0 || buildingIndex >= lbi.Buildings.Count)
            throw new ArgumentOutOfRangeException(nameof(buildingIndex),
                $"buildingIndex {buildingIndex} out of range — LB 0x{lbKey:X4} has {lbi.Buildings.Count} buildings.");

        var building = lbi.Buildings[buildingIndex];
        var worldPos = new Vector3(
            lbX * LbEdge + building.Frame.Origin.X,
            lbY * LbEdge + building.Frame.Origin.Y,
            building.Frame.Origin.Z);

        // The landblock document mirrors DAT statics (incl. building shells)
        // on first load; removing the matching shell makes SaveToDats drop the
        // building and decrement NumCells. Interior cells are orphaned in the
        // export DAT (existing exporter semantics — the client ignores them).
        var lbDoc = GetLandblockDocOrCreate(lbKey);
        var statics = lbDoc.GetStaticObjects().ToList();
        int bestIdx = -1;
        float bestDist = float.MaxValue;
        for (int i = 0; i < statics.Count; i++) {
            if (statics[i].Id != building.ModelId) continue;
            var d = Vector3.Distance(statics[i].Origin, worldPos);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        // Require the nearest same-model shell to be within tolerance of the building's
        // expected world position. Without this, a repeat remove of the same index (or a
        // shell that has moved away) silently deletes an UNRELATED same-model static.
        const float MatchToleranceMeters = 5.0f;
        if (bestIdx < 0 || bestDist > MatchToleranceMeters)
            throw new InvalidOperationException(
                $"No staged static object matches building 0x{building.ModelId:X8} within {MatchToleranceMeters:F1}m " +
                $"of its expected position (nearest same-model shell was {(bestIdx < 0 ? "not found" : $"{bestDist:F1}m away")}) — " +
                "was it already removed or moved?");

        lbDoc.RemoveStaticObject(bestIdx);

        return new RemoveBuildingResult(
            Lb: $"0x{lbKey:X4}", BuildingIndex: buildingIndex,
            ModelId: $"0x{building.ModelId:X8}",
            RemovedStaticIndex: bestIdx, MatchDistance: bestDist,
            Note: "Interior EnvCells become orphaned records in the export DAT (client ignores them); NumCells is decremented at export.");
    }

    // ─────────────────────────────────────────────────────────────────
    //  bulk-paint-replace
    // ─────────────────────────────────────────────────────────────────

    public BulkPaintReplaceResult BulkPaintReplace(
        List<(uint lbX, uint lbY)> lbs, int? fromType, int toType) {
        RequireProject();
        if (lbs.Count == 0)
            throw new ArgumentException("Provide lbList or a rect (minLbX/minLbY/maxLbX/maxLbY).");
        if (toType is < 0 or > 31)
            throw new ArgumentOutOfRangeException(nameof(toType), "toType must be a terrain type index 0..31.");
        if (fromType is < 0 or > 31)
            throw new ArgumentOutOfRangeException(nameof(fromType), "fromType must be a terrain type index 0..31.");

        var terrainDoc = GetTerrainDoc();
        int lbsChanged = 0, vertsChanged = 0, lbsMissing = 0;
        foreach (var (lbX, lbY) in lbs) {
            ushort key = LbKey(lbX, lbY);
            var current = terrainDoc.GetLandblockInternal(key);
            if (current == null) { lbsMissing++; continue; }
            var entries = new TerrainEntry[81];
            int changed = 0;
            for (int i = 0; i < 81; i++) {
                var e = current[i];
                if (fromType == null || e.Type == (byte)fromType.Value) {
                    if (e.Type != (byte)toType) changed++;
                    entries[i] = new TerrainEntry(e.Road, e.Scenery, (byte)toType, e.Height);
                }
                else {
                    entries[i] = e;
                }
            }
            if (changed > 0) {
                terrainDoc.UpdateLandblockInternal(key, entries, out _);
                lbsChanged++;
                vertsChanged += changed;
            }
        }

        return new BulkPaintReplaceResult(
            LandblocksRequested: lbs.Count, LandblocksChanged: lbsChanged,
            LandblocksMissing: lbsMissing, VerticesChanged: vertsChanged,
            FromType: fromType, ToType: toType);
    }
}

// ── Melt-integration Phase X.2: transplant results ───────────────────
public record CopyBuildingResult(
    string SourceKey,
    string SrcLb,
    int BuildingIndex,
    string ModelId,
    string DstLb,
    int StaticObjectIndex,
    int InteriorCells,
    List<string> Warnings);

public record CopyLandblockResult(
    string SourceKey,
    string SrcLb,
    string DstLb,
    int TerrainVertices,
    bool HeightmapCopied,
    bool TexturesCopied,
    int ObjectsCopied,
    int BuildingsCopied,
    int InteriorCellsStaged,
    int ClearedExisting,
    List<string> Warnings);

public record RemoveBuildingResult(
    string Lb,
    int BuildingIndex,
    string ModelId,
    int RemovedStaticIndex,
    float MatchDistance,
    string Note);

public record BulkPaintReplaceResult(
    int LandblocksRequested,
    int LandblocksChanged,
    int LandblocksMissing,
    int VerticesChanged,
    int? FromType,
    int ToType);
