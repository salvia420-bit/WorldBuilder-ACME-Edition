using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Extensions;
using DatReaderWriter.Options;
using DatReaderWriter.Types;

namespace WorldBuilder.Terminal;

/// <summary>
/// E9b — the C# half of E9. E9a (SHIPPED, Rust scenery-bake) emits, per landblock, a
/// <c>&lt;lbHex&gt;.scenery.materials.json</c> sidecar: a JSON array (sorted by surface_did) of
/// faithful per-surface material records, each copied straight off a DAT Surface (0x08). This
/// partial READS that sidecar and WRITES the records back into EXPLICIT synthetic Surface(0x08)
/// DAT records — the round-trip target — via <see cref="DatEasyWriter"/>.
///
/// GUARDRAILS (GAUGE — this WRITES DAT records):
///   • Keyed by the addressable surface_did (a 0x08 Surface DID), NEVER a list index.
///   • Fields are faithful to the sidecar (E9a is faithful to the original DAT): surface_type →
///     <see cref="Surface.Type"/>, the three scalars → Translucency/Luminosity/Diffuse, and EITHER
///     color_value → <see cref="Surface.ColorValue"/> (solid) OR orig_texture_id/orig_palette_id →
///     OrigTextureId/OrigPaletteId (textured).
///   • Output is an EXPLICIT Surface(0x08) record (the round-trip target), not a render-only override.
///   • Writes ONLY to a TARGET (synthetic/project/custom) DAT — NEVER the retail base DATs. The
///     target dir is initialized with empty dats if absent (additive override).
/// </summary>
public partial class CommandEngine {
    // ── E9a sidecar schema (snake_case, matching scenery-bake.rs
    //    format_material_record / format_materials_sidecar EXACTLY). DIDs are
    //    "0x%08X" hex strings; the three scalars are {:.6} JSON numbers; exactly one of
    //    color_value (solid) or orig_texture_id+orig_palette_id (textured) is present;
    //    luminous_flag is a derived bool (luminosity > 0). ────────────────────────────
    private sealed class SceneryMaterialRecord {
        [JsonPropertyName("surface_did")] public string SurfaceDid { get; set; } = "";
        [JsonPropertyName("surface_type")] public uint SurfaceType { get; set; }
        [JsonPropertyName("translucency")] public float Translucency { get; set; }
        [JsonPropertyName("luminosity")] public float Luminosity { get; set; }
        [JsonPropertyName("diffuse")] public float Diffuse { get; set; }
        // Solid surfaces only — the ARGB color_value (decimal u32 in the sidecar).
        [JsonPropertyName("color_value")] public uint? ColorValue { get; set; }
        // Textured surfaces only — "0x%08X" hex strings.
        [JsonPropertyName("orig_texture_id")] public string? OrigTextureId { get; set; }
        [JsonPropertyName("orig_palette_id")] public string? OrigPaletteId { get; set; }
        [JsonPropertyName("luminous_flag")] public bool LuminousFlag { get; set; }
    }

    private static readonly JsonSerializerOptions SurfaceMaterialJsonOptions = new() {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    // Texture-mask bits in surface_type (Base1Image 0x2 | Base1ClipMap 0x4). This is the
    // WIRE-CANONICAL discriminator: both the DatReaderWriter Surface (de)serializer AND the E9a
    // emitter (holtburger-dat surface.rs SURFACE_TYPE_TEXTURE_MASK = 0x06) select the
    // (orig_texture_id, orig_palette_id) vs solid color_value branch off `surface_type & 0x06`.
    // We MUST mirror it rather than infer the branch from JSON field presence: scenery-bake.rs
    // documents a legitimate (None, None) record where neither field is emitted, and a
    // self-inconsistent record (mask clear yet texture ids present, or vice-versa) would otherwise
    // populate the wrong in-memory branch (NRE on Pack, or a silently dropped color).
    private const uint SurfaceTypeTextureMask = 0x06u;

    /// <summary>
    /// E9b entry point. Reads one or more E9a <c>*.scenery.materials.json</c> sidecars
    /// (<paramref name="sidecarPathOrDir"/> is a single file or a directory scanned for
    /// <c>*.scenery.materials.json</c>) and writes a synthetic Surface(0x08) DAT record per
    /// sidecar record into the TARGET dat collection at <paramref name="datDir"/>, then re-reads
    /// each written Surface and asserts round-trip equality against the sidecar.
    /// The target dir is created/initialized (empty dats) if it does not already hold dats — it is
    /// NEVER a retail base DAT (the caller passes a project/custom/temp dir).
    /// </summary>
    public SurfaceMaterialImportResult SurfaceMaterialImport(string sidecarPathOrDir, string datDir) {
        if (string.IsNullOrWhiteSpace(sidecarPathOrDir))
            throw new ArgumentException("Sidecar path or directory is required.", nameof(sidecarPathOrDir));
        if (string.IsNullOrWhiteSpace(datDir))
            throw new ArgumentException("Target DAT directory is required.", nameof(datDir));

        // Resolve the sidecar file set (single file or a directory of *.scenery.materials.json).
        var sidecarFiles = ResolveSurfaceMaterialSidecars(sidecarPathOrDir);
        if (sidecarFiles.Count == 0)
            return new SurfaceMaterialImportResult(
                false, datDir, 0, 0, 0, 0, Array.Empty<SurfaceMaterialImportRecord>(),
                Error: $"No *.scenery.materials.json sidecar found at '{sidecarPathOrDir}'.");

        // Parse every record up front, keyed by surface_did. The sidecar is sorted by surface_did;
        // we de-dupe defensively (last writer wins) but never index by position.
        var records = new Dictionary<uint, SceneryMaterialRecord>();
        foreach (var file in sidecarFiles) {
            List<SceneryMaterialRecord> parsed;
            try {
                var json = File.ReadAllText(file);
                parsed = JsonSerializer.Deserialize<List<SceneryMaterialRecord>>(json, SurfaceMaterialJsonOptions)
                    ?? new List<SceneryMaterialRecord>();
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException) {
                // A corrupt/truncated/unreadable sidecar must not crash the importer — surface it as
                // a graceful Error result so programmatic callers (not just the REPL try/catch) cope.
                return new SurfaceMaterialImportResult(
                    false, datDir, sidecarFiles.Count, 0, 0, 0, Array.Empty<SurfaceMaterialImportRecord>(),
                    Error: $"Failed to parse sidecar '{file}': {ex.Message}");
            }
            foreach (var rec in parsed) {
                uint did = ParseDid(rec.SurfaceDid);
                records[did] = rec; // keyed by the addressable 0x08 DID, never a list index
            }
        }

        // GUARDRAIL (code-level, not just the safe default): this command WRITES Surface(0x08)
        // records, and the headline rule is "NEVER the retail base DATs". Refuse a target that is
        // (or sits under) the current project's read-only base dat dir, or any dir already holding a
        // retail dat collection this tool did not create. The default --out is dats/synthetic, but
        // an explicit --out could otherwise point at dats/base or a real retail dir.
        RejectRetailDatTarget(datDir);

        // Initialize the target DAT directory with empty dats if it isn't already a dat collection.
        // GUARDRAIL: this is a synthetic/project/temp dir, never the retail base DATs.
        EnsureSyntheticDatDir(datDir);

        var outRecords = new List<SurfaceMaterialImportRecord>(records.Count);

        // WRITE phase: build + Save each Surface(0x08) into the target dat.
        using (var dats = new DatCollection(datDir, DatAccessType.ReadWrite))
        using (var writer = new DatEasyWriter(dats)) {
            foreach (var (did, rec) in records.OrderBy(kv => kv.Key)) {
                // Wire-canonical branch: the persisted Surface format keys off surface_type & 0x06,
                // never JSON field presence. See SurfaceTypeTextureMask.
                bool textured = (rec.SurfaceType & SurfaceTypeTextureMask) != 0;
                try {
                    var surface = BuildSurface(did, rec, textured);
                    var saved = writer.Save(surface);
                    if (!saved.Success) {
                        outRecords.Add(new SurfaceMaterialImportRecord(
                            did, rec.SurfaceType, textured, Written: false, RoundTripOk: false,
                            Error: saved.Error ?? "DatEasyWriter.Save failed."));
                        continue;
                    }
                    outRecords.Add(new SurfaceMaterialImportRecord(
                        did, rec.SurfaceType, textured, Written: true, RoundTripOk: false));
                }
                catch (Exception ex) {
                    outRecords.Add(new SurfaceMaterialImportRecord(
                        did, rec.SurfaceType, textured, Written: false, RoundTripOk: false,
                        Error: ex.Message));
                }
            }
        }

        // ROUND-TRIP phase: re-read each written Surface(0x08) from the target dat and assert its
        // fields equal the sidecar values. Re-open Read-only so we exercise the persisted bytes.
        using (var dats = new DatCollection(datDir, DatAccessType.Read)) {
            for (int i = 0; i < outRecords.Count; i++) {
                var entry = outRecords[i];
                if (!entry.Written) continue;
                var rec = records[entry.SurfaceDid];
                if (!dats.TryGet<Surface>(entry.SurfaceDid, out var readBack) || readBack == null) {
                    outRecords[i] = entry with { Error = "Round-trip read returned no Surface." };
                    continue;
                }
                var (ok, reason) = SurfaceMatchesSidecar(readBack, rec, entry.Textured);
                outRecords[i] = entry with { RoundTripOk = ok, Error = ok ? entry.Error : reason };
            }
        }

        int written = outRecords.Count(r => r.Written);
        int roundTripOk = outRecords.Count(r => r.RoundTripOk);
        // A cleanly-parsed sidecar with zero records is a SUCCESSFUL no-op: E9a emits `[]` by design
        // for empty landblocks (materials_sidecar_empty_for_no_placements), so requiring count > 0
        // would mislabel a valid empty LB as a failure.
        bool success = written == records.Count && roundTripOk == records.Count;

        return new SurfaceMaterialImportResult(
            success, datDir, sidecarFiles.Count, records.Count, written, roundTripOk, outRecords);
    }

    /// <summary>Resolve a single sidecar file or a directory of <c>*.scenery.materials.json</c>.</summary>
    private static List<string> ResolveSurfaceMaterialSidecars(string sidecarPathOrDir) {
        if (File.Exists(sidecarPathOrDir))
            return new List<string> { sidecarPathOrDir };
        if (Directory.Exists(sidecarPathOrDir))
            return Directory
                .EnumerateFiles(sidecarPathOrDir, "*.scenery.materials.json", SearchOption.TopDirectoryOnly)
                .OrderBy(p => p, StringComparer.Ordinal)
                .ToList();
        return new List<string>();
    }

    /// <summary>
    /// Build a synthetic Surface(0x08) DBObj from one sidecar record. surface_type → Type, the
    /// three scalars verbatim, and EITHER color_value (solid) OR orig_texture_id/orig_palette_id
    /// (textured). <paramref name="textured"/> is the wire-canonical discriminator
    /// (<c>surface_type &amp; 0x06</c>) — the exact branch the DatReaderWriter Surface serializer
    /// (and the E9a emitter) use — so the in-memory branch we populate always matches what Pack will
    /// persist.
    /// </summary>
    private static Surface BuildSurface(uint did, SceneryMaterialRecord rec, bool textured) {
        var surface = new Surface {
            Id = did,
            Type = (SurfaceType)rec.SurfaceType,
            Translucency = rec.Translucency,
            Luminosity = rec.Luminosity,
            Diffuse = rec.Diffuse,
        };
        if (textured) {
            surface.OrigTextureId = ParseDid(rec.OrigTextureId ?? "0x00000000");
            surface.OrigPaletteId = ParseDid(rec.OrigPaletteId ?? "0x00000000");
        }
        else {
            // Solid surface — color_value is a packed ARGB u32 (MSB = alpha), unpacked into the
            // ColorARGB byte channels.
            surface.ColorValue = ArgbToColor(rec.ColorValue ?? 0u);
        }
        return surface;
    }

    /// <summary>Assert a re-read Surface(0x08) equals the sidecar record (round-trip fidelity check).</summary>
    private static (bool Ok, string? Reason) SurfaceMatchesSidecar(
        Surface surface, SceneryMaterialRecord rec, bool textured) {
        if ((uint)surface.Type != rec.SurfaceType)
            return (false, $"surface_type 0x{(uint)surface.Type:X} != 0x{rec.SurfaceType:X}");
        if (surface.Translucency != rec.Translucency)
            return (false, $"translucency {surface.Translucency} != {rec.Translucency}");
        if (surface.Luminosity != rec.Luminosity)
            return (false, $"luminosity {surface.Luminosity} != {rec.Luminosity}");
        if (surface.Diffuse != rec.Diffuse)
            return (false, $"diffuse {surface.Diffuse} != {rec.Diffuse}");
        if (textured) {
            uint tex = ParseDid(rec.OrigTextureId ?? "0x00000000");
            uint pal = ParseDid(rec.OrigPaletteId ?? "0x00000000");
            if (surface.OrigTextureId.DataId != tex)
                return (false, $"orig_texture_id 0x{surface.OrigTextureId.DataId:X8} != 0x{tex:X8}");
            if (surface.OrigPaletteId.DataId != pal)
                return (false, $"orig_palette_id 0x{surface.OrigPaletteId.DataId:X8} != 0x{pal:X8}");
        }
        else {
            uint expected = rec.ColorValue ?? 0u;
            uint actual = ColorToArgb(surface.ColorValue);
            if (actual != expected)
                return (false, $"color_value 0x{actual:X8} != 0x{expected:X8}");
        }
        return (true, null);
    }

    /// <summary>Pack a ColorARGB (Alpha/Red/Green/Blue bytes) back into the sidecar ARGB u32.</summary>
    private static uint ColorToArgb(ColorARGB c) =>
        ((uint)c.Alpha << 24) | ((uint)c.Red << 16) | ((uint)c.Green << 8) | c.Blue;

    /// <summary>Unpack a sidecar ARGB u32 (MSB = alpha) into a ColorARGB.</summary>
    private static ColorARGB ArgbToColor(uint argb) => new() {
        Alpha = (byte)((argb >> 24) & 0xFF),
        Red = (byte)((argb >> 16) & 0xFF),
        Green = (byte)((argb >> 8) & 0xFF),
        Blue = (byte)(argb & 0xFF),
    };

    /// <summary>Parse a DID, accepting "0x%08X" hex strings (E9a convention) or bare decimal.</summary>
    private static uint ParseDid(string s) {
        s = s.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || s.StartsWith("0X", StringComparison.Ordinal))
            return uint.Parse(s.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return uint.Parse(s, NumberStyles.Integer, CultureInfo.InvariantCulture);
    }

    // Marker file this tool drops into any synthetic dat dir it owns. Its presence proves the dir is
    // a tool-managed override target (not a retail/base dat dir we must never write into).
    private const string SyntheticDatMarker = ".wb-synthetic-dats";

    // The four dat files DatReaderWriter expects. A dir that already holds ALL of these but lacks the
    // synthetic marker is treated as a real (retail) dat collection and is refused as a write target.
    private static readonly string[] RetailDatFileNames = {
        "client_cell_1.dat", "client_portal.dat", "client_highres.dat", "client_local_English.dat",
    };

    /// <summary>
    /// CODE-LEVEL GUARDRAIL: refuse to write Surface(0x08) records into a retail/base DAT. The
    /// headline E9b rule is "writes ONLY to a synthetic/project/temp DAT, NEVER the retail base DATs",
    /// and this enforces it rather than relying on the safe default and comments. Rejects when the
    /// resolved target is (or sits under) the current project's read-only base dat dir, or when it is
    /// a pre-existing populated dat collection this tool did not create (no synthetic marker).
    /// </summary>
    private void RejectRetailDatTarget(string datDir) {
        string full = Path.GetFullPath(datDir);

        // (a) Never the current project's read-only base dat dir (or anything under it).
        var project = _projectManager?.CurrentProject;
        if (project != null && !string.IsNullOrEmpty(project.BaseDatDirectory)) {
            string baseFull = Path.GetFullPath(project.BaseDatDirectory);
            if (IsSameOrUnder(full, baseFull))
                throw new InvalidOperationException(
                    $"Refusing to write Surface(0x08) records into the project's read-only base DAT dir '{baseFull}'. " +
                    "Use a synthetic/project override dir (the default --out is dats/synthetic).");
        }

        // (b) Never a pre-existing populated dat collection that this tool did not create. If all four
        // dats already exist but our synthetic marker is absent, EnsureDat would skip bootstrap and
        // DatEasyWriter would mutate the existing (potentially retail) collection in place.
        if (Directory.Exists(full)) {
            bool allDatsPresent = RetailDatFileNames.All(n => File.Exists(Path.Combine(full, n)));
            bool ours = File.Exists(Path.Combine(full, SyntheticDatMarker));
            if (allDatsPresent && !ours)
                throw new InvalidOperationException(
                    $"Refusing to write into '{full}': it already holds a complete DAT collection not created by this tool " +
                    "(no synthetic marker). Target an empty or tool-managed synthetic dat dir instead.");
        }
    }

    /// <summary>True if <paramref name="path"/> equals or is nested under <paramref name="ancestor"/>.</summary>
    private static bool IsSameOrUnder(string path, string ancestor) {
        string a = ancestor.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), a,
                StringComparison.OrdinalIgnoreCase))
            return true;
        return path.StartsWith(a + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Ensure the TARGET dat directory holds the four dat files DatReaderWriter requires, creating
    /// empty ones (subset values mirroring the test fixture) if absent. This is a synthetic/project
    /// override dir — NEVER a retail base DAT.
    /// </summary>
    private static void EnsureSyntheticDatDir(string datDir) {
        Directory.CreateDirectory(datDir);
        // Stamp the dir as tool-owned so RejectRetailDatTarget recognizes it on re-runs.
        string marker = Path.Combine(datDir, SyntheticDatMarker);
        if (!File.Exists(marker))
            File.WriteAllText(marker, "WorldBuilder E9b synthetic Surface(0x08) DAT override.\n");

        EnsureDat(Path.Combine(datDir, "client_cell_1.dat"),
            () => new CellDatabase(o => { o.AccessType = DatAccessType.ReadWrite; o.FilePath = Path.Combine(datDir, "client_cell_1.dat"); }),
            DatFileType.Cell, 1u);
        EnsureDat(Path.Combine(datDir, "client_portal.dat"),
            () => new PortalDatabase(o => { o.AccessType = DatAccessType.ReadWrite; o.FilePath = Path.Combine(datDir, "client_portal.dat"); }),
            DatFileType.Portal, 0u);
        EnsureDat(Path.Combine(datDir, "client_highres.dat"),
            () => new PortalDatabase(o => { o.AccessType = DatAccessType.ReadWrite; o.FilePath = Path.Combine(datDir, "client_highres.dat"); }),
            DatFileType.Portal, 1766222152u);
        EnsureDat(Path.Combine(datDir, "client_local_English.dat"),
            () => new LocalDatabase(o => { o.AccessType = DatAccessType.ReadWrite; o.FilePath = Path.Combine(datDir, "client_local_English.dat"); }),
            DatFileType.Local, 1u);
    }

    private static void EnsureDat(string path, Func<DatDatabase> factory, DatFileType type, uint subset) {
        if (File.Exists(path)) return;
        using var db = factory();
        db.BlockAllocator.InitNew(type, subset);
    }
}
