using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Documents;
using DRW = DatReaderWriter;
using SceneObj = DatReaderWriter.DBObjs.Scene;
using RegionObj = DatReaderWriter.DBObjs.Region;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration Phase S — Scene 0x12 inspection &amp; diff.
/// See <c>docs/melt-integration-plan-2026-06-10.md</c> §3.
///
/// Commands in this file:
///
///   - <c>scene-export-json &lt;sceneId | all&gt; [out] [datPath]</c> — dump a
///     Scene's ObjectDesc list, fully fielded per the retail struct
///     (acclient.h:57271–57286: obj_id, base_loc Frame, freq,
///     displace_x/y, min/max_scale, max_rot, min/max_slope, align,
///     orient, weenie_obj). <c>all:true</c> sweeps every Scene in the
///     portal DAT to one JSON file.
///
///   - <c>scene-diff &lt;sceneId&gt; &lt;otherDat&gt;</c> — melt
///     SceneUtilities.CompareObjects equivalent: per-object field diff
///     vs a second DAT (dat-open alias or path).
///
///   - <c>scene-where-used &lt;sceneId&gt;</c> — reverse map through Region
///     0x13: which SceneDesc scene-type indices list this scene, and
///     which TerrainTypes reference those indices. Answers "why does
///     this scenery appear on this terrain".
///
///   - <c>scene-edit &lt;sceneId&gt; &lt;index&gt; [fields…] [apply]</c> — mutate one
///     ObjectDesc and stage the Scene into PortalDatDocument for export.
///
/// Behavioral reference: <c>external/melt/Source/misc/SceneUtilities.cs</c>
/// (reference only — reimplemented on DatReaderWriter types).
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  JSON document model
    // ─────────────────────────────────────────────────────────────────

    public sealed class SceneJsonDoc {
        public string Id { get; set; } = "0x00000000";
        public List<SceneObjectDescJson> Objects { get; set; } = new();
    }

    public sealed class SceneObjectDescJson {
        public string ObjectId { get; set; } = "0x00000000";
        public List<float> Origin { get; set; } = new() { 0, 0, 0 };
        public List<float> Orientation { get; set; } = new() { 1, 0, 0, 0 }; // w,x,y,z
        public float Frequency { get; set; }
        public float DisplaceX { get; set; }
        public float DisplaceY { get; set; }
        public float MinScale { get; set; }
        public float MaxScale { get; set; }
        public float MaxRotation { get; set; }
        public float MinSlope { get; set; }
        public float MaxSlope { get; set; }
        public int Align { get; set; }
        public int Orient { get; set; }
        public string WeenieObj { get; set; } = "0x00000000";
    }

    // ─────────────────────────────────────────────────────────────────
    //  Commands
    // ─────────────────────────────────────────────────────────────────

    public SceneExportJsonResult SceneExportJson(string? sceneIdHex, bool all, string? outPath, string? datPath) {
        if (!all && string.IsNullOrWhiteSpace(sceneIdHex))
            throw new ArgumentException("Provide sceneId (0x12......) or all:true.");
        if (all && string.IsNullOrWhiteSpace(outPath))
            throw new ArgumentException("all:true requires 'out' (the sweep is too large to inline).");

        if (all) {
            var ids = EnumerateSceneIds(datPath).OrderBy(i => i).ToList();
            var docs = new List<SceneJsonDoc>(ids.Count);
            foreach (var id in ids) {
                var (scene, _) = LoadScene(id, datPath);
                docs.Add(SceneToJsonDoc(scene, id));
            }
            var dir = Path.GetDirectoryName(Path.GetFullPath(outPath!));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(outPath!, JsonSerializer.Serialize(docs, RegionJsonOptions()));
            return new SceneExportJsonResult(
                SceneId: "all", Source: datPath ?? "project/base",
                OutPath: Path.GetFullPath(outPath!), SceneCount: docs.Count,
                ObjectCount: docs.Sum(d => d.Objects.Count), InlineJson: null);
        }

        var sceneId = ParseRegionHexU32(sceneIdHex!);
        var (one, source) = LoadScene(sceneId, datPath);
        var doc = SceneToJsonDoc(one, sceneId);
        var json = JsonSerializer.Serialize(doc, RegionJsonOptions());
        string? written = null;
        if (!string.IsNullOrWhiteSpace(outPath)) {
            var dir = Path.GetDirectoryName(Path.GetFullPath(outPath));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(outPath, json);
            written = Path.GetFullPath(outPath);
        }
        return new SceneExportJsonResult(
            SceneId: $"0x{sceneId:X8}", Source: source, OutPath: written,
            SceneCount: 1, ObjectCount: doc.Objects.Count,
            InlineJson: written == null ? json : null);
    }

    public SceneDiffResult SceneDiff(string sceneIdHex, string otherDat, int maxRows) {
        if (string.IsNullOrWhiteSpace(sceneIdHex))
            throw new ArgumentException("sceneId is required.");
        if (string.IsNullOrWhiteSpace(otherDat))
            throw new ArgumentException("otherDat (dat-open alias or DAT path) is required.");
        if (maxRows <= 0) maxRows = 500;

        var sceneId = ParseRegionHexU32(sceneIdHex);
        var (ours, oursSource) = LoadScene(sceneId, null);
        var (theirs, theirsSource) = LoadScene(sceneId, otherDat);

        var opts = RegionJsonOptions();
        var oursNode = JsonSerializer.SerializeToNode(SceneToJsonDoc(ours, sceneId), opts)!;
        var theirsNode = JsonSerializer.SerializeToNode(SceneToJsonDoc(theirs, sceneId), opts)!;
        var rows = new List<RegionDiffRow>();
        bool overflowed = false;
        DiffJsonNodes("", oursNode, theirsNode, rows, maxRows, ref overflowed);

        return new SceneDiffResult(
            SceneId: $"0x{sceneId:X8}",
            OursSource: oursSource, TheirsSource: theirsSource,
            DiffCount: rows.Count, Truncated: overflowed, Rows: rows);
    }

    public SceneWhereUsedResult SceneWhereUsed(string sceneIdHex) {
        if (string.IsNullOrWhiteSpace(sceneIdHex))
            throw new ArgumentException("sceneId is required.");
        var sceneId = ParseRegionHexU32(sceneIdHex);

        var (region, regionSource, _, _) = LoadRegionForCommands(null);
        var hits = new List<SceneWhereUsedHit>();
        if (region.SceneInfo != null) {
            for (int sceneTypeIndex = 0; sceneTypeIndex < region.SceneInfo.SceneTypes.Count; sceneTypeIndex++) {
                var st = region.SceneInfo.SceneTypes[sceneTypeIndex];
                int slot = -1;
                for (int i = 0; i < st.Scenes.Count; i++) {
                    if ((uint)st.Scenes[i] == sceneId) { slot = i; break; }
                }
                if (slot < 0) continue;

                var terrains = new List<string>();
                if (region.TerrainInfo != null) {
                    foreach (var tt in region.TerrainInfo.TerrainTypes) {
                        if (tt.SceneTypes.Contains((uint)sceneTypeIndex))
                            terrains.Add(tt.TerrainName?.ToString() ?? "");
                    }
                }
                hits.Add(new SceneWhereUsedHit(
                    SceneTypeIndex: sceneTypeIndex,
                    StbIndex: st.StbIndex,
                    SceneSlot: slot,
                    SceneCountInType: st.Scenes.Count,
                    TerrainTypes: terrains.Distinct().ToList()));
            }
        }

        return new SceneWhereUsedResult(
            SceneId: $"0x{sceneId:X8}", RegionSource: regionSource,
            HitCount: hits.Count, Hits: hits);
    }

    public SceneEditResult SceneEdit(string sceneIdHex, int index, JsonObject fields, bool apply) {
        if (string.IsNullOrWhiteSpace(sceneIdHex))
            throw new ArgumentException("sceneId is required.");
        if (fields == null || fields.Count == 0)
            throw new ArgumentException("fields object is required (any of: objectId, origin, orientation, frequency, displaceX, displaceY, minScale, maxScale, maxRotation, minSlope, maxSlope, align, orient, weenieObj).");

        var sceneId = ParseRegionHexU32(sceneIdHex);
        var (loaded, source) = LoadScene(sceneId, null);
        if (index < 0 || index >= loaded.Objects.Count)
            throw new ArgumentOutOfRangeException(nameof(index),
                $"index {index} out of range — scene 0x{sceneId:X8} has {loaded.Objects.Count} objects.");

        // Deep-copy before mutating. LoadScene can return the staged
        // PortalDatDocument's cached instance (TryGetEntry hands back the same
        // object), so mutating it directly — even on a dry-run (apply:false) — would
        // corrupt the live staged scene that the next save/export packs into the
        // DATs. Cloning also makes an unknown-field error mid-loop harmless: the
        // partially mutated copy is discarded.
        var scene = CloneScene(loaded);
        var obj = scene.Objects[index];
        var changed = new List<string>();
        foreach (var (key, valNode) in fields) {
            if (valNode == null) continue;
            switch (key) {
                case "objectId": obj.ObjectId = ParseRegionHexU32(valNode.GetValue<string>()); break;
                case "origin": {
                    var a = valNode.AsArray();
                    if (a.Count != 3) throw new ArgumentException("origin must be [x,y,z]");
                    obj.BaseLoc.Origin = new Vector3(a[0]!.GetValue<float>(), a[1]!.GetValue<float>(), a[2]!.GetValue<float>());
                    break;
                }
                case "orientation": {
                    var a = valNode.AsArray();
                    if (a.Count != 4) throw new ArgumentException("orientation must be [w,x,y,z]");
                    obj.BaseLoc.Orientation = new Quaternion(
                        a[1]!.GetValue<float>(), a[2]!.GetValue<float>(), a[3]!.GetValue<float>(), a[0]!.GetValue<float>());
                    break;
                }
                case "frequency": obj.Frequency = valNode.GetValue<float>(); break;
                case "displaceX": obj.DisplaceX = valNode.GetValue<float>(); break;
                case "displaceY": obj.DisplaceY = valNode.GetValue<float>(); break;
                case "minScale": obj.MinScale = valNode.GetValue<float>(); break;
                case "maxScale": obj.MaxScale = valNode.GetValue<float>(); break;
                case "maxRotation": obj.MaxRotation = valNode.GetValue<float>(); break;
                case "minSlope": obj.MinSlope = valNode.GetValue<float>(); break;
                case "maxSlope": obj.MaxSlope = valNode.GetValue<float>(); break;
                case "align": obj.Align = valNode.GetValue<int>(); break;
                case "orient": obj.Orient = valNode.GetValue<int>(); break;
                case "weenieObj": obj.WeenieObj = ParseRegionHexU32(valNode.GetValue<string>()); break;
                default:
                    throw new ArgumentException($"Unknown field '{key}'.");
            }
            changed.Add(key);
        }

        bool staged = false;
        if (apply) {
            RequireProject();
            var project = _projectManager.CurrentProject!;
            var portalDoc = project.DocumentManager
                .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
                .GetAwaiter().GetResult()
                ?? throw new InvalidOperationException("Could not load PortalDatDocument.");
            portalDoc.SetEntry(sceneId, scene);
            staged = true;
        }

        return new SceneEditResult(
            SceneId: $"0x{sceneId:X8}", Index: index, Source: source,
            ChangedFields: changed, Applied: apply, Staged: staged,
            ObjectAfter: SceneObjectToJson(scene.Objects[index]));
    }

    // ─────────────────────────────────────────────────────────────────
    //  Loading / mapping
    // ─────────────────────────────────────────────────────────────────

    /// <summary>Resolution order mirrors LoadRegionForCommands: explicit
    /// datPath/alias → staged PortalDatDocument → project DATs → base portal.</summary>
    private (SceneObj Scene, string Source) LoadScene(uint sceneId, string? datPath) {
        if (!string.IsNullOrWhiteSpace(datPath)) {
            if (_externalDats.TryGetValue(datPath.Trim(), out var handle)) {
                if (!handle.TryGet<SceneObj>(sceneId, out var fromHandle) || fromHandle == null)
                    throw new InvalidOperationException(
                        $"Scene 0x{sceneId:X8} not found in dat handle '{handle.Alias}' ({handle.Path}).");
                return (fromHandle, $"handle:{handle.Alias}");
            }
            var resolved = ResolveDatPathForType(datPath, typeof(SceneObj));
            using var dat = new DRW.DatDatabase(o => {
                o.FilePath = resolved;
                o.AccessType = DRW.Options.DatAccessType.Read;
                o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
            });
            if (!dat.TryGet<SceneObj>(sceneId, out var fromDat) || fromDat == null)
                throw new InvalidOperationException($"Scene 0x{sceneId:X8} not found in {resolved}.");
            return (fromDat, $"dat:{resolved}");
        }

        var project = _projectManager?.CurrentProject;
        if (project != null) {
            var portalDoc = project.DocumentManager
                .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
                .GetAwaiter().GetResult();
            if (portalDoc != null && portalDoc.HasEntry(sceneId)
                && portalDoc.TryGetEntry<SceneObj>(sceneId, out var staged) && staged != null) {
                return (staged, "staged:PortalDatDocument");
            }
            if (project.DocumentManager.Dats.TryGet<SceneObj>(sceneId, out var fromProject) && fromProject != null) {
                return (fromProject, "project");
            }
            throw new InvalidOperationException($"Scene 0x{sceneId:X8} not found in project DATs.");
        }

        var basePath = ResolveDatPathForType(null, typeof(SceneObj));
        using var baseDat = new DRW.DatDatabase(o => {
            o.FilePath = basePath;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });
        if (!baseDat.TryGet<SceneObj>(sceneId, out var fromBase) || fromBase == null)
            throw new InvalidOperationException($"Scene 0x{sceneId:X8} not found in {basePath}.");
        return (fromBase, $"dat:{basePath}");
    }

    /// <summary>Deep-copy a Scene by packing then unpacking it, so edits never mutate
    /// a shared/staged instance returned by LoadScene.</summary>
    private static SceneObj CloneScene(SceneObj source) {
        const int CloneBufferSize = 16 * 1024 * 1024;
        var buffer = new byte[CloneBufferSize];
        var writer = new DRW.Lib.IO.DatBinWriter(buffer.AsMemory());
        ((DRW.Lib.IO.IPackable)source).Pack(writer);
        var copy = new SceneObj();
        var reader = new DRW.Lib.IO.DatBinReader(buffer[..writer.Offset]);
        ((DRW.Lib.IO.IUnpackable)copy).Unpack(reader);
        return copy;
    }

    private List<uint> EnumerateSceneIds(string? datPath) {
        if (!string.IsNullOrWhiteSpace(datPath) && _externalDats.TryGetValue(datPath.Trim(), out var handle)) {
            if (handle.Collection != null) return handle.Collection.Portal.GetAllIdsOfType<SceneObj>().ToList();
            if (handle.Single != null) return handle.Single.GetAllIdsOfType<SceneObj>().ToList();
        }
        if (string.IsNullOrWhiteSpace(datPath)) {
            var project = _projectManager?.CurrentProject;
            if (project != null)
                return project.DocumentManager.Dats.Dats.Portal.GetAllIdsOfType<SceneObj>().ToList();
        }
        var resolved = ResolveDatPathForType(datPath, typeof(SceneObj));
        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });
        return dat.GetAllIdsOfType<SceneObj>().ToList();
    }

    internal static SceneJsonDoc SceneToJsonDoc(SceneObj scene, uint sceneId) => new() {
        Id = $"0x{sceneId:X8}",
        Objects = scene.Objects.Select(SceneObjectToJson).ToList(),
    };

    private static SceneObjectDescJson SceneObjectToJson(ObjectDesc o) => new() {
        ObjectId = $"0x{o.ObjectId:X8}",
        Origin = new List<float> { o.BaseLoc.Origin.X, o.BaseLoc.Origin.Y, o.BaseLoc.Origin.Z },
        Orientation = new List<float> {
            o.BaseLoc.Orientation.W, o.BaseLoc.Orientation.X,
            o.BaseLoc.Orientation.Y, o.BaseLoc.Orientation.Z },
        Frequency = o.Frequency,
        DisplaceX = o.DisplaceX,
        DisplaceY = o.DisplaceY,
        MinScale = o.MinScale,
        MaxScale = o.MaxScale,
        MaxRotation = o.MaxRotation,
        MinSlope = o.MinSlope,
        MaxSlope = o.MaxSlope,
        Align = o.Align,
        Orient = o.Orient,
        WeenieObj = $"0x{o.WeenieObj:X8}",
    };
}

// ── Melt-integration Phase S: scene results ──────────────────────────
public record SceneExportJsonResult(
    string SceneId,
    string Source,
    string? OutPath,
    int SceneCount,
    int ObjectCount,
    string? InlineJson);

public record SceneDiffResult(
    string SceneId,
    string OursSource,
    string TheirsSource,
    int DiffCount,
    bool Truncated,
    List<RegionDiffRow> Rows);

public record SceneWhereUsedHit(
    int SceneTypeIndex,
    uint StbIndex,
    int SceneSlot,
    int SceneCountInType,
    List<string> TerrainTypes);

public record SceneWhereUsedResult(
    string SceneId,
    string RegionSource,
    int HitCount,
    List<SceneWhereUsedHit> Hits);

public record SceneEditResult(
    string SceneId,
    int Index,
    string Source,
    List<string> ChangedFields,
    bool Applied,
    bool Staged,
    CommandEngine.SceneObjectDescJson ObjectAfter);
