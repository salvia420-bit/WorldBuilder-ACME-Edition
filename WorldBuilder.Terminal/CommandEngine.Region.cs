using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using DatReaderWriter.Enums;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Documents;
using DRW = DatReaderWriter;
using RegionObj = DatReaderWriter.DBObjs.Region;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration Phase R — Region 0x13 JSON round-trip.
/// See <c>docs/melt-integration-plan-2026-06-10.md</c> §2.
///
/// Commands in this file:
///
///   - <c>region-export-json [out] [parts] [datPath]</c> — parse Region
///     <c>0x13000000</c> into a complete, stable-ordered JSON document
///     (every part the retail client serializes: LandDefs, GameTime,
///     SkyDesc/DayGroups, SoundDesc, SceneDesc, TerrainDesc/TexMerge,
///     RegionMisc). Prefers the staged <c>PortalDatDocument</c> entry
///     when one exists so post-import exports reflect edits.
///
///   - <c>region-import-json &lt;path&gt; [apply]</c> — validate a JSON
///     document of the same shape, rebuild the Region DBObj, verify
///     pack/unpack self-parity, and (with <c>apply:true</c>) stage it
///     into the project's <c>PortalDatDocument</c> so the standard
///     <c>export</c> pipeline writes it to the export DATs.
///
///   - <c>region-diff [otherDat] [otherJson] [maxRows]</c> — melt
///     RegionComparer equivalent: deep field-by-field diff of the
///     current region vs a second DAT or a previously exported JSON,
///     emitted as <c>{path, ours, theirs}</c> rows.
///
/// Behavioral reference: <c>external/melt/Source/misc/RegionConverter.cs</c>
/// + <c>RegionComparer.cs</c> (reference only — reimplemented on
/// DatReaderWriter types per the plan's licensing rule). Struct truth:
/// <c>acclient.h:52835–53253</c> (CRegionDesc chain). Wire shape:
/// Chorizite DatReaderWriter <c>dats.xml</c> Region type.
/// </summary>
public partial class CommandEngine {

    private const uint RegionFileId = 0x13000000;
    private const int RegionPackBufferSize = 16 * 1024 * 1024;

    // ─────────────────────────────────────────────────────────────────
    //  JSON document model — stable shape, declaration order = output
    //  order. DIDs are "0x........" strings, colors are "#AARRGGBB",
    //  enums are names. Mirrors dats.xml Region exactly.
    // ─────────────────────────────────────────────────────────────────

    public sealed class RegionJsonDoc {
        public string Id { get; set; } = "0x13000000";
        public uint RegionNumber { get; set; }
        public uint Version { get; set; }
        public string RegionName { get; set; } = "";
        public RegionLandDefsJson LandDefs { get; set; } = new();
        public RegionGameTimeJson GameTime { get; set; } = new();
        public uint PartsMask { get; set; }
        public RegionSkyDescJson? SkyInfo { get; set; }
        public RegionSoundDescJson? SoundInfo { get; set; }
        public RegionSceneDescJson? SceneInfo { get; set; }
        public RegionTerrainDescJson TerrainInfo { get; set; } = new();
        public RegionMiscJson? RegionMisc { get; set; }
        public bool? Partial { get; set; }
    }

    public sealed class RegionLandDefsJson {
        public int NumBlockLength { get; set; }
        public int NumBlockWidth { get; set; }
        public float SquareLength { get; set; }
        public int LBlockLength { get; set; }
        public int VertexPerCell { get; set; }
        public float MaxObjHeight { get; set; }
        public float SkyHeight { get; set; }
        public float RoadWidth { get; set; }
        public List<float> LandHeightTable { get; set; } = new();
    }

    public sealed class RegionGameTimeJson {
        public double ZeroTimeOfYear { get; set; }
        public uint ZeroYear { get; set; }
        public float DayLength { get; set; }
        public uint DaysPerYear { get; set; }
        public string YearSpec { get; set; } = "";
        public List<RegionTimeOfDayJson> TimesOfDay { get; set; } = new();
        public List<string> DaysOfWeek { get; set; } = new();
        public List<RegionSeasonJson> Seasons { get; set; } = new();
    }

    public sealed class RegionTimeOfDayJson {
        public float Start { get; set; }
        public bool IsNight { get; set; }
        public string Name { get; set; } = "";
    }

    public sealed class RegionSeasonJson {
        public uint Start { get; set; }
        public string Name { get; set; } = "";
    }

    public sealed class RegionSkyDescJson {
        public double TickSize { get; set; }
        public double LightTickSize { get; set; }
        public List<RegionDayGroupJson> DayGroups { get; set; } = new();
    }

    public sealed class RegionDayGroupJson {
        public float ChanceOfOccur { get; set; }
        public string DayName { get; set; } = "";
        public List<RegionSkyObjectJson> SkyObjects { get; set; } = new();
        public List<RegionSkyTimeOfDayJson> SkyTime { get; set; } = new();
    }

    public sealed class RegionSkyObjectJson {
        public float BeginTime { get; set; }
        public float EndTime { get; set; }
        public float BeginAngle { get; set; }
        public float EndAngle { get; set; }
        public float TexVelocityX { get; set; }
        public float TexVelocityY { get; set; }
        public string DefaultGfxObjectId { get; set; } = "0x00000000";
        public string DefaultPesObjectId { get; set; } = "0x00000000";
        public string Properties { get; set; } = "0x00000000";
    }

    public sealed class RegionSkyTimeOfDayJson {
        public float Begin { get; set; }
        public float DirBright { get; set; }
        public float DirHeading { get; set; }
        public float DirPitch { get; set; }
        public string DirColor { get; set; } = "#FF000000";
        public float AmbBright { get; set; }
        public string AmbColor { get; set; } = "#FF000000";
        public float MinWorldFog { get; set; }
        public float MaxWorldFog { get; set; }
        public string WorldFogColor { get; set; } = "#FF000000";
        public uint WorldFog { get; set; }
        public List<RegionSkyObjectReplaceJson> SkyObjReplace { get; set; } = new();
    }

    public sealed class RegionSkyObjectReplaceJson {
        public uint ObjectIndex { get; set; }
        public string GfxObjId { get; set; } = "0x00000000";
        public float Rotate { get; set; }
        public float Transparent { get; set; }
        public float Luminosity { get; set; }
        public float MaxBright { get; set; }
    }

    public sealed class RegionSoundDescJson {
        public List<RegionAmbientStbJson> StbDesc { get; set; } = new();
    }

    public sealed class RegionAmbientStbJson {
        public string StbId { get; set; } = "0x00000000";
        public List<RegionAmbientSoundJson> AmbientSounds { get; set; } = new();
    }

    public sealed class RegionAmbientSoundJson {
        public string SType { get; set; } = "";
        public float Volume { get; set; }
        public float BaseChance { get; set; }
        public float MinRate { get; set; }
        public float MaxRate { get; set; }
    }

    public sealed class RegionSceneDescJson {
        public List<RegionSceneTypeJson> SceneTypes { get; set; } = new();
    }

    public sealed class RegionSceneTypeJson {
        public uint StbIndex { get; set; }
        public List<string> Scenes { get; set; } = new();
    }

    public sealed class RegionTerrainDescJson {
        public List<RegionTerrainTypeJson> TerrainTypes { get; set; } = new();
        public RegionLandSurfJson LandSurfaces { get; set; } = new();
    }

    public sealed class RegionTerrainTypeJson {
        public string TerrainName { get; set; } = "";
        public string TerrainColor { get; set; } = "#FF000000";
        public List<uint> SceneTypes { get; set; } = new();
    }

    public sealed class RegionLandSurfJson {
        public uint Type { get; set; }
        public RegionTexMergeJson TexMerge { get; set; } = new();
    }

    public sealed class RegionTexMergeJson {
        public uint BaseTexSize { get; set; }
        public List<RegionTerrainAlphaMapJson> CornerTerrainMaps { get; set; } = new();
        public List<RegionTerrainAlphaMapJson> SideTerrainMaps { get; set; } = new();
        public List<RegionRoadAlphaMapJson> RoadMaps { get; set; } = new();
        public List<RegionTmTerrainDescJson> TerrainDesc { get; set; } = new();
    }

    public sealed class RegionTerrainAlphaMapJson {
        public uint TCode { get; set; }
        public string TextureId { get; set; } = "0x00000000";
    }

    public sealed class RegionRoadAlphaMapJson {
        public uint RCode { get; set; }
        public string TextureId { get; set; } = "0x00000000";
    }

    public sealed class RegionTmTerrainDescJson {
        public string TerrainType { get; set; } = "";
        public RegionTerrainTexJson TerrainTex { get; set; } = new();
    }

    public sealed class RegionTerrainTexJson {
        public string TextureId { get; set; } = "0x00000000";
        public uint TexTiling { get; set; }
        public uint MaxVertBright { get; set; }
        public uint MinVertBright { get; set; }
        public uint MaxVertSaturate { get; set; }
        public uint MinVertSaturate { get; set; }
        public uint MaxVertHue { get; set; }
        public uint MinVertHue { get; set; }
        public uint DetailTexTiling { get; set; }
        public string DetailTextureId { get; set; } = "0x00000000";
    }

    public sealed class RegionMiscJson {
        public uint Version { get; set; }
        public string GameMapID { get; set; } = "0x00000000";
        public string AutotestMapId { get; set; } = "0x00000000";
        public uint AutotestMapSize { get; set; }
        public string ClearCellId { get; set; } = "0x00000000";
        public string ClearMonsterId { get; set; } = "0x00000000";
    }

    // ─────────────────────────────────────────────────────────────────
    //  Commands
    // ─────────────────────────────────────────────────────────────────

    public RegionExportJsonResult RegionExportJson(string? outPath, string? parts, string? datPath) {
        var (region, source, resolvedPath, sha) = LoadRegionForCommands(datPath);
        var doc = RegionToJsonDoc(region);
        ApplyPartsFilter(doc, parts);

        var json = JsonSerializer.Serialize(doc, RegionJsonOptions());
        string? written = null;
        if (!string.IsNullOrWhiteSpace(outPath)) {
            var dir = Path.GetDirectoryName(Path.GetFullPath(outPath));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(outPath, json);
            written = Path.GetFullPath(outPath);
        }

        return new RegionExportJsonResult(
            Source: source,
            DatPath: resolvedPath,
            DatSha256: sha,
            OutPath: written,
            PartsMask: $"0x{doc.PartsMask:X8}",
            DayGroups: doc.SkyInfo?.DayGroups.Count ?? 0,
            SoundStbs: doc.SoundInfo?.StbDesc.Count ?? 0,
            SceneTypes: doc.SceneInfo?.SceneTypes.Count ?? 0,
            TerrainTypes: doc.TerrainInfo.TerrainTypes.Count,
            InlineJson: written == null ? json : null);
    }

    public RegionImportJsonResult RegionImportJson(string path, bool apply) {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("path is required.", nameof(path));
        if (!File.Exists(path))
            throw new FileNotFoundException($"JSON not found: {path}", path);

        var doc = JsonSerializer.Deserialize<RegionJsonDoc>(
            File.ReadAllText(path), RegionJsonOptions())
            ?? throw new InvalidOperationException("Failed to parse region JSON document.");

        var problems = ValidateRegionJsonDoc(doc);
        if (problems.Count > 0) {
            return new RegionImportJsonResult(
                Applied: false, Staged: false, Path: Path.GetFullPath(path),
                Problems: problems, PackedBytes: 0, PackParity: false, PackSha256: null);
        }

        var region = JsonDocToRegion(doc);

        // Pack/unpack self-parity: the rebuilt DBObj must survive its own
        // wire round-trip byte-identically before we let it near a DAT.
        var bytesA = PackRegion(region);
        var reparsed = new RegionObj();
        ((DRW.Lib.IO.IUnpackable)reparsed).Unpack(new DatBinReader(bytesA));
        var bytesB = PackRegion(reparsed);
        bool parity = bytesA.AsSpan().SequenceEqual(bytesB);
        if (!parity) {
            problems.Add("pack/unpack self-parity FAILED — rebuilt Region does not survive its own wire round-trip; refusing to stage.");
            return new RegionImportJsonResult(
                Applied: false, Staged: false, Path: Path.GetFullPath(path),
                Problems: problems, PackedBytes: bytesA.Length, PackParity: false, PackSha256: null);
        }

        var sha = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(bytesA)).ToLowerInvariant();

        bool staged = false;
        if (apply) {
            RequireProject();
            var project = _projectManager.CurrentProject!;
            var portalDoc = project.DocumentManager
                .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
                .GetAwaiter().GetResult()
                ?? throw new InvalidOperationException("Could not load PortalDatDocument.");
            portalDoc.SetEntry(RegionFileId, region);
            staged = true;
        }

        return new RegionImportJsonResult(
            Applied: apply, Staged: staged, Path: Path.GetFullPath(path),
            Problems: problems, PackedBytes: bytesA.Length, PackParity: true, PackSha256: sha);
    }

    public RegionDiffResult RegionDiff(string? otherDat, string? otherJson, int maxRows) {
        if (string.IsNullOrWhiteSpace(otherDat) && string.IsNullOrWhiteSpace(otherJson))
            throw new ArgumentException("Provide otherDat (a DAT path/alias) or otherJson (a region-export-json file).");
        if (!string.IsNullOrWhiteSpace(otherDat) && !string.IsNullOrWhiteSpace(otherJson))
            throw new ArgumentException("Provide otherDat OR otherJson, not both");
        if (maxRows <= 0) maxRows = 500;

        var (ours, oursSource, _, _) = LoadRegionForCommands(null);
        var oursDoc = RegionToJsonDoc(ours);

        RegionJsonDoc theirsDoc;
        string theirsSource;
        if (!string.IsNullOrWhiteSpace(otherJson)) {
            if (!File.Exists(otherJson))
                throw new FileNotFoundException($"otherJson not found: {otherJson}", otherJson);
            theirsDoc = JsonSerializer.Deserialize<RegionJsonDoc>(
                File.ReadAllText(otherJson), RegionJsonOptions())
                ?? throw new InvalidOperationException("Failed to parse otherJson region document.");
            theirsSource = $"json:{Path.GetFullPath(otherJson)}";
        }
        else {
            var (theirs, theirsSrc, theirPath, _) = LoadRegionFromDatPath(otherDat!);
            theirsDoc = RegionToJsonDoc(theirs);
            theirsSource = theirsSrc == "dat" ? $"dat:{theirPath}" : $"{theirsSrc} ({theirPath})";
        }

        var opts = RegionJsonOptions();
        var oursNode = JsonSerializer.SerializeToNode(oursDoc, opts)!;
        var theirsNode = JsonSerializer.SerializeToNode(theirsDoc, opts)!;

        var rows = new List<RegionDiffRow>();
        bool overflowed = false;
        DiffJsonNodes("", oursNode, theirsNode, rows, maxRows, ref overflowed);

        return new RegionDiffResult(
            OursSource: oursSource,
            TheirsSource: theirsSource,
            DiffCount: rows.Count,
            Truncated: overflowed,
            Rows: rows);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Region loading
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Resolution order: explicit datPath → staged PortalDatDocument entry
    /// (so edits staged by region-import-json are what export/diff see) →
    /// project DATs → base portal DAT fallback.
    /// </summary>
    private (RegionObj Region, string Source, string? DatPath, string? Sha256) LoadRegionForCommands(string? datPath) {
        if (!string.IsNullOrWhiteSpace(datPath)) {
            return LoadRegionFromDatPath(datPath);
        }

        var project = _projectManager?.CurrentProject;
        if (project != null) {
            var portalDoc = project.DocumentManager
                .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
                .GetAwaiter().GetResult();
            if (portalDoc != null && portalDoc.HasEntry(RegionFileId)
                && portalDoc.TryGetEntry<RegionObj>(RegionFileId, out var staged) && staged != null) {
                return (staged, "staged:PortalDatDocument", null, null);
            }
            if (project.DocumentManager.Dats.TryGet<RegionObj>(RegionFileId, out var fromProject) && fromProject != null) {
                return (fromProject, "project", null, null);
            }
        }

        return LoadRegionFromDatPath("portal");
    }

    private (RegionObj Region, string Source, string? DatPath, string? Sha256) LoadRegionFromDatPath(string datPath) {
        // Phase X.1 integration: an open dat-open alias wins over path resolution.
        if (_externalDats.TryGetValue(datPath.Trim(), out var handle)) {
            if (!handle.TryGet<RegionObj>(RegionFileId, out var fromHandle) || fromHandle == null)
                throw new InvalidOperationException(
                    $"TryGet<Region>(0x{RegionFileId:X8}) failed on dat handle '{handle.Alias}' ({handle.Path}).");
            return (fromHandle, $"handle:{handle.Alias}", handle.Path, null);
        }

        var resolved = ResolveDatPathForType(datPath, typeof(RegionObj));
        var sha = ComputeDatSha256(resolved);
        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });
        if (!dat.TryGet<RegionObj>(RegionFileId, out var region) || region == null) {
            throw new InvalidOperationException(
                $"TryGet<Region>(0x{RegionFileId:X8}) failed on {resolved}.");
        }
        return (region, "dat", resolved, sha);
    }

    internal static byte[] PackRegion(RegionObj region) {
        var buffer = new byte[RegionPackBufferSize];
        var writer = new DatBinWriter(buffer.AsMemory());
        ((DRW.Lib.IO.IPackable)region).Pack(writer);
        return buffer[..writer.Offset];
    }

    internal static JsonSerializerOptions RegionJsonOptions() => new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    // ─────────────────────────────────────────────────────────────────
    //  DBObj → JSON doc
    // ─────────────────────────────────────────────────────────────────

    internal static RegionJsonDoc RegionToJsonDoc(RegionObj r) {
        var doc = new RegionJsonDoc {
            Id = $"0x{RegionFileId:X8}",
            RegionNumber = r.RegionNumber,
            Version = r.Version,
            RegionName = r.RegionName?.ToString() ?? "",
            PartsMask = (uint)r.PartsMask,
            LandDefs = new RegionLandDefsJson {
                NumBlockLength = r.LandDefs.NumBlockLength,
                NumBlockWidth = r.LandDefs.NumBlockWidth,
                SquareLength = r.LandDefs.SquareLength,
                LBlockLength = r.LandDefs.LBlockLength,
                VertexPerCell = r.LandDefs.VertexPerCell,
                MaxObjHeight = r.LandDefs.MaxObjHeight,
                SkyHeight = r.LandDefs.SkyHeight,
                RoadWidth = r.LandDefs.RoadWidth,
                LandHeightTable = r.LandDefs.LandHeightTable.ToList(),
            },
            GameTime = new RegionGameTimeJson {
                ZeroTimeOfYear = r.GameTime.ZeroTimeOfYear,
                ZeroYear = r.GameTime.ZeroYear,
                DayLength = r.GameTime.DayLength,
                DaysPerYear = r.GameTime.DaysPerYear,
                YearSpec = r.GameTime.YearSpec?.ToString() ?? "",
                TimesOfDay = r.GameTime.TimesOfDay.Select(t => new RegionTimeOfDayJson {
                    Start = t.Start, IsNight = t.IsNight, Name = t.Name?.ToString() ?? "",
                }).ToList(),
                DaysOfWeek = r.GameTime.DaysOfWeek.Select(d => d?.ToString() ?? "").ToList(),
                Seasons = r.GameTime.Seasons.Select(s => new RegionSeasonJson {
                    Start = s.Start, Name = s.Name?.ToString() ?? "",
                }).ToList(),
            },
            TerrainInfo = new RegionTerrainDescJson {
                TerrainTypes = r.TerrainInfo.TerrainTypes.Select(t => new RegionTerrainTypeJson {
                    TerrainName = t.TerrainName?.ToString() ?? "",
                    TerrainColor = ColorHex(t.TerrainColor),
                    SceneTypes = t.SceneTypes.ToList(),
                }).ToList(),
                LandSurfaces = new RegionLandSurfJson {
                    Type = r.TerrainInfo.LandSurfaces.Type,
                    TexMerge = new RegionTexMergeJson {
                        BaseTexSize = r.TerrainInfo.LandSurfaces.TexMerge.BaseTexSize,
                        CornerTerrainMaps = r.TerrainInfo.LandSurfaces.TexMerge.CornerTerrainMaps
                            .Select(m => new RegionTerrainAlphaMapJson { TCode = m.TCode, TextureId = Hex8(m.TextureId) }).ToList(),
                        SideTerrainMaps = r.TerrainInfo.LandSurfaces.TexMerge.SideTerrainMaps
                            .Select(m => new RegionTerrainAlphaMapJson { TCode = m.TCode, TextureId = Hex8(m.TextureId) }).ToList(),
                        RoadMaps = r.TerrainInfo.LandSurfaces.TexMerge.RoadMaps
                            .Select(m => new RegionRoadAlphaMapJson { RCode = m.RCode, TextureId = Hex8(m.TextureId) }).ToList(),
                        TerrainDesc = r.TerrainInfo.LandSurfaces.TexMerge.TerrainDesc
                            .Select(d => new RegionTmTerrainDescJson {
                                TerrainType = d.TerrainType.ToString(),
                                TerrainTex = new RegionTerrainTexJson {
                                    TextureId = Hex8(d.TerrainTex.TextureId),
                                    TexTiling = d.TerrainTex.TexTiling,
                                    MaxVertBright = d.TerrainTex.MaxVertBright,
                                    MinVertBright = d.TerrainTex.MinVertBright,
                                    MaxVertSaturate = d.TerrainTex.MaxVertSaturate,
                                    MinVertSaturate = d.TerrainTex.MinVertSaturate,
                                    MaxVertHue = d.TerrainTex.MaxVertHue,
                                    MinVertHue = d.TerrainTex.MinVertHue,
                                    DetailTexTiling = d.TerrainTex.DetailTexTiling,
                                    DetailTextureId = Hex8(d.TerrainTex.DetailTextureId),
                                },
                            }).ToList(),
                    },
                },
            },
        };

        if (r.SkyInfo != null) {
            doc.SkyInfo = new RegionSkyDescJson {
                TickSize = r.SkyInfo.TickSize,
                LightTickSize = r.SkyInfo.LightTickSize,
                DayGroups = r.SkyInfo.DayGroups.Select(g => new RegionDayGroupJson {
                    ChanceOfOccur = g.ChanceOfOccur,
                    DayName = g.DayName?.ToString() ?? "",
                    SkyObjects = g.SkyObjects.Select(o => new RegionSkyObjectJson {
                        BeginTime = o.BeginTime, EndTime = o.EndTime,
                        BeginAngle = o.BeginAngle, EndAngle = o.EndAngle,
                        TexVelocityX = o.TexVelocityX, TexVelocityY = o.TexVelocityY,
                        DefaultGfxObjectId = Hex8(o.DefaultGfxObjectId),
                        DefaultPesObjectId = Hex8(o.DefaultPesObjectId),
                        Properties = Hex8(o.Properties),
                    }).ToList(),
                    SkyTime = g.SkyTime.Select(t => new RegionSkyTimeOfDayJson {
                        Begin = t.Begin,
                        DirBright = t.DirBright, DirHeading = t.DirHeading, DirPitch = t.DirPitch,
                        DirColor = ColorHex(t.DirColor),
                        AmbBright = t.AmbBright, AmbColor = ColorHex(t.AmbColor),
                        MinWorldFog = t.MinWorldFog, MaxWorldFog = t.MaxWorldFog,
                        WorldFogColor = ColorHex(t.WorldFogColor),
                        WorldFog = t.WorldFog,
                        SkyObjReplace = t.SkyObjReplace.Select(sr => new RegionSkyObjectReplaceJson {
                            ObjectIndex = sr.ObjectIndex,
                            GfxObjId = Hex8(sr.GfxObjId),
                            Rotate = sr.Rotate, Transparent = sr.Transparent,
                            Luminosity = sr.Luminosity, MaxBright = sr.MaxBright,
                        }).ToList(),
                    }).ToList(),
                }).ToList(),
            };
        }

        if (r.SoundInfo != null) {
            doc.SoundInfo = new RegionSoundDescJson {
                StbDesc = r.SoundInfo.STBDesc.Select(s => new RegionAmbientStbJson {
                    StbId = Hex8(s.STBId),
                    AmbientSounds = s.AmbientSounds.Select(a => new RegionAmbientSoundJson {
                        SType = a.SType.ToString(),
                        Volume = a.Volume, BaseChance = a.BaseChance,
                        MinRate = a.MinRate, MaxRate = a.MaxRate,
                    }).ToList(),
                }).ToList(),
            };
        }

        if (r.SceneInfo != null) {
            doc.SceneInfo = new RegionSceneDescJson {
                SceneTypes = r.SceneInfo.SceneTypes.Select(s => new RegionSceneTypeJson {
                    StbIndex = s.StbIndex,
                    Scenes = s.Scenes.Select(id => Hex8(id)).ToList(),
                }).ToList(),
            };
        }

        if (r.RegionMisc != null) {
            doc.RegionMisc = new RegionMiscJson {
                Version = r.RegionMisc.Version,
                GameMapID = Hex8(r.RegionMisc.GameMapID),
                AutotestMapId = Hex8(r.RegionMisc.AutotestMapId),
                AutotestMapSize = r.RegionMisc.AutotestMapSize,
                ClearCellId = Hex8(r.RegionMisc.ClearCellId),
                ClearMonsterId = Hex8(r.RegionMisc.ClearMonsterId),
            };
        }

        return doc;
    }

    // ─────────────────────────────────────────────────────────────────
    //  JSON doc → DBObj
    // ─────────────────────────────────────────────────────────────────

    internal static RegionObj JsonDocToRegion(RegionJsonDoc doc) {
        var r = new RegionObj {
            Id = RegionFileId,
            RegionNumber = doc.RegionNumber,
            Version = doc.Version,
            RegionName = doc.RegionName,
            PartsMask = (PartsMask)doc.PartsMask,
        };

        r.LandDefs = new LandDefs {
            NumBlockLength = doc.LandDefs.NumBlockLength,
            NumBlockWidth = doc.LandDefs.NumBlockWidth,
            SquareLength = doc.LandDefs.SquareLength,
            LBlockLength = doc.LandDefs.LBlockLength,
            VertexPerCell = doc.LandDefs.VertexPerCell,
            MaxObjHeight = doc.LandDefs.MaxObjHeight,
            SkyHeight = doc.LandDefs.SkyHeight,
            RoadWidth = doc.LandDefs.RoadWidth,
            LandHeightTable = doc.LandDefs.LandHeightTable.ToArray(),
        };

        r.GameTime = new GameTime {
            ZeroTimeOfYear = doc.GameTime.ZeroTimeOfYear,
            ZeroYear = doc.GameTime.ZeroYear,
            DayLength = doc.GameTime.DayLength,
            DaysPerYear = doc.GameTime.DaysPerYear,
            YearSpec = doc.GameTime.YearSpec,
        };
        r.GameTime.TimesOfDay.AddRange(doc.GameTime.TimesOfDay.Select(t => new TimeOfDay {
            Start = t.Start, IsNight = t.IsNight, Name = t.Name,
        }));
        r.GameTime.DaysOfWeek.AddRange(
            doc.GameTime.DaysOfWeek.Select(d => (AC1LegacyPStringBase<byte>)d));
        r.GameTime.Seasons.AddRange(doc.GameTime.Seasons.Select(s => new Season {
            Start = s.Start, Name = s.Name,
        }));

        if (doc.SkyInfo != null) {
            r.SkyInfo = new SkyDesc {
                TickSize = doc.SkyInfo.TickSize,
                LightTickSize = doc.SkyInfo.LightTickSize,
            };
            r.SkyInfo.DayGroups.AddRange(doc.SkyInfo.DayGroups.Select(g => {
                var dg = new DayGroup {
                    ChanceOfOccur = g.ChanceOfOccur,
                    DayName = g.DayName,
                };
                dg.SkyObjects.AddRange(g.SkyObjects.Select(o => new SkyObject {
                    BeginTime = o.BeginTime, EndTime = o.EndTime,
                    BeginAngle = o.BeginAngle, EndAngle = o.EndAngle,
                    TexVelocityX = o.TexVelocityX, TexVelocityY = o.TexVelocityY,
                    DefaultGfxObjectId = ParseRegionHexU32(o.DefaultGfxObjectId),
                    DefaultPesObjectId = ParseRegionHexU32(o.DefaultPesObjectId),
                    Properties = ParseRegionHexU32(o.Properties),
                }));
                dg.SkyTime.AddRange(g.SkyTime.Select(t => {
                    var st = new SkyTimeOfDay {
                        Begin = t.Begin,
                        DirBright = t.DirBright, DirHeading = t.DirHeading, DirPitch = t.DirPitch,
                        DirColor = ColorFromHex(t.DirColor),
                        AmbBright = t.AmbBright, AmbColor = ColorFromHex(t.AmbColor),
                        MinWorldFog = t.MinWorldFog, MaxWorldFog = t.MaxWorldFog,
                        WorldFogColor = ColorFromHex(t.WorldFogColor),
                        WorldFog = t.WorldFog,
                    };
                    st.SkyObjReplace.AddRange(t.SkyObjReplace.Select(sr => new SkyObjectReplace {
                        ObjectIndex = sr.ObjectIndex,
                        GfxObjId = ParseRegionHexU32(sr.GfxObjId),
                        Rotate = sr.Rotate, Transparent = sr.Transparent,
                        Luminosity = sr.Luminosity, MaxBright = sr.MaxBright,
                    }));
                    return st;
                }));
                return dg;
            }));
        }

        if (doc.SoundInfo != null) {
            r.SoundInfo = new SoundDesc();
            r.SoundInfo.STBDesc.AddRange(doc.SoundInfo.StbDesc.Select(s => {
                var stb = new AmbientSTBDesc { STBId = ParseRegionHexU32(s.StbId) };
                stb.AmbientSounds.AddRange(s.AmbientSounds.Select(a => new AmbientSoundDesc {
                    SType = Enum.Parse<Sound>(a.SType, ignoreCase: true),
                    Volume = a.Volume, BaseChance = a.BaseChance,
                    MinRate = a.MinRate, MaxRate = a.MaxRate,
                }));
                return stb;
            }));
        }

        if (doc.SceneInfo != null) {
            r.SceneInfo = new SceneDesc();
            r.SceneInfo.SceneTypes.AddRange(doc.SceneInfo.SceneTypes.Select(s => {
                var st = new SceneType { StbIndex = s.StbIndex };
                st.Scenes.AddRange(s.Scenes.Select(id =>
                    (QualifiedDataId<DRW.DBObjs.Scene>)ParseRegionHexU32(id)));
                return st;
            }));
        }

        r.TerrainInfo = new TerrainDesc();
        r.TerrainInfo.TerrainTypes.AddRange(doc.TerrainInfo.TerrainTypes.Select(t => {
            var tt = new TerrainType {
                TerrainName = t.TerrainName,
                TerrainColor = ColorFromHex(t.TerrainColor),
            };
            tt.SceneTypes.AddRange(t.SceneTypes);
            return tt;
        }));
        r.TerrainInfo.LandSurfaces = new LandSurf {
            Type = doc.TerrainInfo.LandSurfaces.Type,
            TexMerge = new TexMerge {
                BaseTexSize = doc.TerrainInfo.LandSurfaces.TexMerge.BaseTexSize,
            },
        };
        var tm = r.TerrainInfo.LandSurfaces.TexMerge;
        tm.CornerTerrainMaps.AddRange(doc.TerrainInfo.LandSurfaces.TexMerge.CornerTerrainMaps
            .Select(m => new TerrainAlphaMap { TCode = m.TCode, TextureId = ParseRegionHexU32(m.TextureId) }));
        tm.SideTerrainMaps.AddRange(doc.TerrainInfo.LandSurfaces.TexMerge.SideTerrainMaps
            .Select(m => new TerrainAlphaMap { TCode = m.TCode, TextureId = ParseRegionHexU32(m.TextureId) }));
        tm.RoadMaps.AddRange(doc.TerrainInfo.LandSurfaces.TexMerge.RoadMaps
            .Select(m => new RoadAlphaMap { RCode = m.RCode, TextureId = ParseRegionHexU32(m.TextureId) }));
        tm.TerrainDesc.AddRange(doc.TerrainInfo.LandSurfaces.TexMerge.TerrainDesc
            .Select(d => new TMTerrainDesc {
                TerrainType = Enum.Parse<TerrainTextureType>(d.TerrainType, ignoreCase: true),
                TerrainTex = new TerrainTex {
                    TextureId = ParseRegionHexU32(d.TerrainTex.TextureId),
                    TexTiling = d.TerrainTex.TexTiling,
                    MaxVertBright = d.TerrainTex.MaxVertBright,
                    MinVertBright = d.TerrainTex.MinVertBright,
                    MaxVertSaturate = d.TerrainTex.MaxVertSaturate,
                    MinVertSaturate = d.TerrainTex.MinVertSaturate,
                    MaxVertHue = d.TerrainTex.MaxVertHue,
                    MinVertHue = d.TerrainTex.MinVertHue,
                    DetailTexTiling = d.TerrainTex.DetailTexTiling,
                    DetailTextureId = ParseRegionHexU32(d.TerrainTex.DetailTextureId),
                },
            }));

        if (doc.RegionMisc != null) {
            r.RegionMisc = new RegionMisc {
                Version = doc.RegionMisc.Version,
                GameMapID = ParseRegionHexU32(doc.RegionMisc.GameMapID),
                AutotestMapId = ParseRegionHexU32(doc.RegionMisc.AutotestMapId),
                AutotestMapSize = doc.RegionMisc.AutotestMapSize,
                ClearCellId = ParseRegionHexU32(doc.RegionMisc.ClearCellId),
                ClearMonsterId = ParseRegionHexU32(doc.RegionMisc.ClearMonsterId),
            };
        }

        return r;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Validation / filtering / diff helpers
    // ─────────────────────────────────────────────────────────────────

    internal static List<string> ValidateRegionJsonDoc(RegionJsonDoc doc) {
        var problems = new List<string>();

        uint id;
        try { id = ParseRegionHexU32(doc.Id); }
        catch { id = 0xFFFFFFFF; problems.Add($"id: failed to parse '{doc.Id}' as a hex u32."); }
        if (id != RegionFileId)
            problems.Add($"id must be 0x{RegionFileId:X8} (got {doc.Id}).");

        if (doc.LandDefs.LandHeightTable.Count != 256)
            problems.Add($"landDefs.landHeightTable must have exactly 256 entries (got {doc.LandDefs.LandHeightTable.Count}).");

        // PartsMask consistency — bit values per dats.xml PartsMask enum
        // (HasSkyInfo=0x10, HasSoundInfo=0x01, HasSceneInfo=0x02, HasRegionMisc=0x200).
        CheckPart(problems, doc.PartsMask, (uint)PartsMask.HasSkyInfo, doc.SkyInfo != null, "skyInfo");
        CheckPart(problems, doc.PartsMask, (uint)PartsMask.HasSoundInfo, doc.SoundInfo != null, "soundInfo");
        CheckPart(problems, doc.PartsMask, (uint)PartsMask.HasSceneInfo, doc.SceneInfo != null, "sceneInfo");
        CheckPart(problems, doc.PartsMask, (uint)PartsMask.HasRegionMisc, doc.RegionMisc != null, "regionMisc");

        if (doc.SkyInfo != null && doc.SkyInfo.DayGroups.Count == 0)
            problems.Add("skyInfo.dayGroups must not be empty when skyInfo is present.");
        foreach (var (g, i) in (doc.SkyInfo?.DayGroups ?? new()).Select((g, i) => (g, i))) {
            if (g.SkyTime.Count == 0)
                problems.Add($"skyInfo.dayGroups[{i}].skyTime must not be empty.");
            foreach (var (t, j) in g.SkyTime.Select((t, j) => (t, j))) {
                if (t.Begin is < 0f or > 1f)
                    problems.Add($"skyInfo.dayGroups[{i}].skyTime[{j}].begin must be in [0,1] (got {t.Begin}).");
            }
        }

        if (doc.Partial != true && doc.TerrainInfo.TerrainTypes.Count == 0)
            problems.Add("terrainInfo.terrainTypes must not be empty.");

        // Hex fields must parse; surface every failure with its JSON path.
        JsonDocToRegionHexProbe(doc, problems);

        return problems;
    }

    /// <summary>Pre-parse every hex/enum field, appending one problem per
    /// failure (with its JSON path) so validation reports them all instead of
    /// import throwing on the first.</summary>
    private static void JsonDocToRegionHexProbe(RegionJsonDoc doc, List<string> problems) {
        void Try(string jsonPath, Action probe) {
            try { probe(); }
            catch (Exception ex) { problems.Add($"{jsonPath}: {ex.Message}"); }
        }

        var skyGroups = doc.SkyInfo?.DayGroups ?? new();
        for (int gi = 0; gi < skyGroups.Count; gi++) {
            var g = skyGroups[gi];
            for (int oi = 0; oi < g.SkyObjects.Count; oi++) {
                var o = g.SkyObjects[oi];
                string p = $"skyInfo.dayGroups[{gi}].skyObjects[{oi}]";
                Try($"{p}.defaultGfxObjectId", () => ParseRegionHexU32(o.DefaultGfxObjectId));
                Try($"{p}.defaultPesObjectId", () => ParseRegionHexU32(o.DefaultPesObjectId));
                Try($"{p}.properties", () => ParseRegionHexU32(o.Properties));
            }
            for (int ti = 0; ti < g.SkyTime.Count; ti++) {
                var t = g.SkyTime[ti];
                string p = $"skyInfo.dayGroups[{gi}].skyTime[{ti}]";
                Try($"{p}.dirColor", () => ColorFromHex(t.DirColor));
                Try($"{p}.ambColor", () => ColorFromHex(t.AmbColor));
                Try($"{p}.worldFogColor", () => ColorFromHex(t.WorldFogColor));
                for (int si = 0; si < t.SkyObjReplace.Count; si++) {
                    var sr = t.SkyObjReplace[si];
                    Try($"{p}.skyObjReplace[{si}].gfxObjId", () => ParseRegionHexU32(sr.GfxObjId));
                }
            }
        }
        var stbs = doc.SoundInfo?.StbDesc ?? new();
        for (int si = 0; si < stbs.Count; si++) {
            var s = stbs[si];
            Try($"soundInfo.stbDesc[{si}].stbId", () => ParseRegionHexU32(s.StbId));
            for (int ai = 0; ai < s.AmbientSounds.Count; ai++) {
                var a = s.AmbientSounds[ai];
                Try($"soundInfo.stbDesc[{si}].ambientSounds[{ai}].sType", () => Enum.Parse<Sound>(a.SType, true));
            }
        }
        var scenes = doc.SceneInfo?.SceneTypes ?? new();
        for (int si = 0; si < scenes.Count; si++) {
            var s = scenes[si];
            for (int ii = 0; ii < s.Scenes.Count; ii++) {
                var id = s.Scenes[ii];
                Try($"sceneInfo.sceneTypes[{si}].scenes[{ii}]", () => ParseRegionHexU32(id));
            }
        }
        for (int ti = 0; ti < doc.TerrainInfo.TerrainTypes.Count; ti++) {
            var t = doc.TerrainInfo.TerrainTypes[ti];
            Try($"terrainInfo.terrainTypes[{ti}].terrainColor", () => ColorFromHex(t.TerrainColor));
        }
        var descs = doc.TerrainInfo.LandSurfaces.TexMerge.TerrainDesc;
        for (int di = 0; di < descs.Count; di++) {
            var d = descs[di];
            string p = $"terrainInfo.landSurfaces.texMerge.terrainDesc[{di}]";
            Try($"{p}.terrainType", () => Enum.Parse<TerrainTextureType>(d.TerrainType, true));
            Try($"{p}.terrainTex.textureId", () => ParseRegionHexU32(d.TerrainTex.TextureId));
            Try($"{p}.terrainTex.detailTextureId", () => ParseRegionHexU32(d.TerrainTex.DetailTextureId));
        }
    }

    private static void CheckPart(List<string> problems, uint mask, uint bit, bool present, string name) {
        bool flagged = (mask & bit) != 0;
        if (flagged && !present)
            problems.Add($"partsMask has 0x{bit:X} set but {name} is missing.");
        if (!flagged && present)
            problems.Add($"{name} is present but partsMask bit 0x{bit:X} is not set.");
    }

    private static void ApplyPartsFilter(RegionJsonDoc doc, string? parts) {
        if (string.IsNullOrWhiteSpace(parts)) return;
        var keep = parts.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(p => p.ToLowerInvariant()).ToHashSet();
        var known = new HashSet<string> { "sky", "sound", "scene", "terrain", "misc" };
        var unknown = keep.Where(k => !known.Contains(k)).ToList();
        if (unknown.Count > 0)
            throw new ArgumentException($"Unknown parts filter value(s): {string.Join(", ", unknown)}. Valid: sky, sound, scene, terrain, misc.");
        bool filtered = false;
        if (!keep.Contains("sky")) { doc.SkyInfo = null; doc.PartsMask &= ~(uint)PartsMask.HasSkyInfo; filtered = true; }
        if (!keep.Contains("sound")) { doc.SoundInfo = null; doc.PartsMask &= ~(uint)PartsMask.HasSoundInfo; filtered = true; }
        if (!keep.Contains("scene")) { doc.SceneInfo = null; doc.PartsMask &= ~(uint)PartsMask.HasSceneInfo; filtered = true; }
        if (!keep.Contains("terrain")) { doc.TerrainInfo = new RegionTerrainDescJson(); filtered = true; }
        if (!keep.Contains("misc")) { doc.RegionMisc = null; doc.PartsMask &= ~(uint)PartsMask.HasRegionMisc; filtered = true; }
        if (filtered) doc.Partial = true;
    }

    /// <summary>Recursive JSON-tree diff. Paths are dotted with [i] array
    /// indices, e.g. <c>skyInfo.dayGroups[3].skyTime[0].dirColor</c>.</summary>
    private static void DiffJsonNodes(string path, JsonNode? ours, JsonNode? theirs, List<RegionDiffRow> rows, int maxRows) {
        bool overflowed = false;
        DiffJsonNodes(path, ours, theirs, rows, maxRows, ref overflowed);
    }

    private static void AddDiffRow(List<RegionDiffRow> rows, int maxRows, ref bool overflowed, RegionDiffRow row) {
        if (rows.Count >= maxRows) { overflowed = true; return; }
        rows.Add(row);
    }

    private static void DiffJsonNodes(string path, JsonNode? ours, JsonNode? theirs, List<RegionDiffRow> rows, int maxRows, ref bool overflowed) {
        if (ours is JsonObject oursObj && theirs is JsonObject theirsObj) {
            var keys = oursObj.Select(kv => kv.Key).Union(theirsObj.Select(kv => kv.Key));
            foreach (var key in keys) {
                oursObj.TryGetPropertyValue(key, out var a);
                theirsObj.TryGetPropertyValue(key, out var b);
                DiffJsonNodes(path.Length == 0 ? key : $"{path}.{key}", a, b, rows, maxRows, ref overflowed);
            }
            return;
        }

        if (ours is JsonArray oursArr && theirs is JsonArray theirsArr) {
            if (oursArr.Count != theirsArr.Count) {
                AddDiffRow(rows, maxRows, ref overflowed,
                    new RegionDiffRow($"{path}.length", oursArr.Count.ToString(), theirsArr.Count.ToString()));
            }
            int n = Math.Min(oursArr.Count, theirsArr.Count);
            for (int i = 0; i < n; i++) {
                DiffJsonNodes($"{path}[{i}]", oursArr[i], theirsArr[i], rows, maxRows, ref overflowed);
            }
            return;
        }

        var oursJson = ours?.ToJsonString();
        var theirsJson = theirs?.ToJsonString();
        if (oursJson != theirsJson) {
            AddDiffRow(rows, maxRows, ref overflowed,
                new RegionDiffRow(path, oursJson ?? "(absent)", theirsJson ?? "(absent)"));
        }
    }

    private static string Hex8(uint v) => $"0x{v:X8}";

    private static uint ParseRegionHexU32(string s) {
        if (string.IsNullOrWhiteSpace(s))
            throw new ArgumentException("Empty id field — expected 0x-prefixed hex or decimal uint.");
        var t = s.Trim();
        if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return Convert.ToUInt32(t[2..], 16);
        return uint.Parse(t);
    }

    private static string ColorHex(ColorARGB c) =>
        $"#{c.Alpha:X2}{c.Red:X2}{c.Green:X2}{c.Blue:X2}";

    private static ColorARGB ColorFromHex(string s) {
        if (string.IsNullOrWhiteSpace(s) || !s.StartsWith('#') || s.Length != 9)
            throw new ArgumentException($"Color '{s}' must be #AARRGGBB.");
        return new ColorARGB {
            Alpha = Convert.ToByte(s.Substring(1, 2), 16),
            Red = Convert.ToByte(s.Substring(3, 2), 16),
            Green = Convert.ToByte(s.Substring(5, 2), 16),
            Blue = Convert.ToByte(s.Substring(7, 2), 16),
        };
    }
}

// ── Melt-integration Phase R: region round-trip results ──────────────
public record RegionExportJsonResult(
    string Source,
    string? DatPath,
    string? DatSha256,
    string? OutPath,
    string PartsMask,
    int DayGroups,
    int SoundStbs,
    int SceneTypes,
    int TerrainTypes,
    string? InlineJson);

public record RegionImportJsonResult(
    bool Applied,
    bool Staged,
    string Path,
    List<string> Problems,
    int PackedBytes,
    bool PackParity,
    string? PackSha256);

public record RegionDiffRow(string Path, string Ours, string Theirs);

public record RegionDiffResult(
    string OursSource,
    string TheirsSource,
    int DiffCount,
    bool Truncated,
    List<RegionDiffRow> Rows);
