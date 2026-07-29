using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using SixLabors.ImageSharp;
using DatReaderWriter.Extensions.DBObjs;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// DAT-bake write suite — the two headless commands the full-scale hires
/// texture bake needs that <c>ui-image-replace</c> could not provide
/// (Part B prototype report, /mnt/wbterminal2/pbr-terrain/bake/
/// BAKE-PROTOTYPE-REPORT.md §5 and §6.1/§6.2):
///
///   - <c>render-surface-import</c> — PNG → RenderSurface written into a
///     portal-DAT COPY with the record's own <see cref="DRW.Enums.PixelFormat"/>
///     PRESERVED by default (DXT1 stays DXT1), or an explicit target format.
///     <c>ui-image-replace</c> only ever emits A8R8G8B8/R8G8B8, and
///     <c>import-render-surface</c> refuses non-A8R8G8B8 originals outright;
///     both are fatal for the campaign, because <c>DatHeader.FileSize</c> is an
///     int32 → a 2.147 GB hard cap on the DAT and only the DXT1 re-encode
///     (~1.55 GB projected) fits. Encoding is delegated to the in-tree BC
///     encoder — <c>RenderSurfaceExtensions.ReplaceWith</c> →
///     <c>ConvertImageToFormat</c> (BCnEncoder.Net 2.2.1, DDS header stripped).
///
///   - <c>surface-texture-collapse</c> — rewrite a 2-entry SurfaceTexture
///     (0x05) to a single-entry list. Retail <c>ImgTex::GetSurfaceDID</c>
///     returns index 0 when high detail is on and index 1 otherwise, so a
///     2-entry list is a detail-level PAIR, not a mip pyramid; index 0 lives in
///     the optional <c>client_highres.dat</c> and is absent from
///     <c>client_portal.dat</c>. Replacing only the index-1 (base) RenderSurface
///     therefore shows up for holtburger and for a base-dats retail install, but
///     NOT for a retail client that has client_highres.dat with high detail on.
///     Collapsing to one entry takes the <c>m_num == 1</c> branch
///     unconditionally, and holtburger's <c>SurfaceTexture::highest_res()</c>
///     (= <c>textures.last()</c>) yields the same DID — both clients agree.
///
/// BOTH commands refuse any <c>datPath</c> under <c>~/ac_base_dats</c>
/// (<see cref="GuardWritableDatCopy"/>, shared with the ui-* write commands).
///
/// ⚠ ALLOCATOR PREREQUISITE. DatReaderWriter 2.1.2's
/// <c>BaseBlockAllocator.ReserveBlockCore</c> walks the free list as if it were
/// a CONTIGUOUS run (<c>Header.FirstFreeBlock += Header.BlockSize</c>), which a
/// retail DAT's scattered free chain is not. Writing into an unprepped retail
/// DAT hands out live retail blocks and then reads past the end of the mapped
/// view (AccessViolationException) — silently corrupting the copy first. Until
/// that is fixed upstream, prep the target copy with
/// <c>bake/scripts/prep_dat.py</c>, which appends a ZEROED free arena and
/// repoints the header's free list at it so the contiguous assumption is true by
/// construction. The arena blocks must have NULL next-pointers: WriteBlock only
/// calls ReserveBlockCore when the current block's leading int32 is &lt;= 0, so a
/// pre-linked chain is walked without reserving and records overlap.
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    public sealed record RenderSurfaceImportResult(
        string DatPath, bool DryRun, int BlockSize, int RequestedCount,
        int WrittenCount, int FailCount,
        IReadOnlyList<Dictionary<string, object?>> Records);

    public sealed record SurfaceTextureCollapseResult(
        string DatPath, bool DryRun, int RequestedCount, int CollapsedCount,
        int UnchangedCount, int FailCount,
        IReadOnlyList<Dictionary<string, object?>> Records);

    // ─────────────────────────────────────────────────────────────────
    //  render-surface-import
    // ─────────────────────────────────────────────────────────────────

    /// <param name="Did">RenderSurface id (0x06……).</param>
    /// <param name="PngPath">Source image (png/bmp/gif — ImageSharp decodes it).</param>
    /// <param name="Format">null/empty/"preserve" → keep the record's current
    /// format; otherwise a PixelFormat name with or without the PFID_ prefix.</param>
    /// <param name="AllowResize">null → inherit the command-level default (true =
    /// take the new dimensions from the image). false forces the image back to
    /// the record's retail dimensions.</param>
    public sealed record RenderSurfaceImportSpec(
        uint Did, string PngPath, string? Format, bool? AllowResize);

    /// <summary>Format-preserving RenderSurface import. See the type doc for the
    /// allocator prerequisite.</summary>
    public RenderSurfaceImportResult RenderSurfaceImport(
        string datPath, IReadOnlyList<RenderSurfaceImportSpec> specs,
        string? defaultFormat, bool defaultAllowResize, bool dryRun, bool allowCreate) {
        if (specs == null || specs.Count == 0) {
            throw new ArgumentException(
                "No imports resolved — pass idHex+pngPath, an 'imports' array, or a 'fromDir' of 0x06XXXXXX.png files.");
        }
        var resolved = GuardWritableDatCopy(datPath);

        var records = new List<Dictionary<string, object?>>();
        int written = 0, failed = 0;

        using var portal = new DRW.PortalDatabase(resolved,
            dryRun ? DRW.Options.DatAccessType.Read : DRW.Options.DatAccessType.ReadWrite);
        int blockSize = portal.Header.BlockSize;
        // A DAT block spends its leading int32 on the next-block pointer.
        int payloadPerBlock = blockSize - 4;

        foreach (var spec in specs) {
            var rec = new Dictionary<string, object?> {
                ["didHex"] = $"0x{spec.Did:X8}",
                ["pngPath"] = spec.PngPath,
            };
            try {
                if ((spec.Did >> 24) != 0x06) {
                    throw new ArgumentException(
                        $"0x{spec.Did:X8} is not a RenderSurface id (expected the 0x06 prefix).");
                }
                if (!File.Exists(spec.PngPath)) {
                    throw new FileNotFoundException($"image not found: {spec.PngPath}");
                }
                portal.TryGet<DRW.DBObjs.RenderSurface>(spec.Did, out var existing);
                if (existing == null && !allowCreate) {
                    throw new InvalidOperationException(
                        $"RenderSurface 0x{spec.Did:X8} not present in {Path.GetFileName(resolved)} " +
                        "(pass allowCreate=true to add a new record).");
                }

                bool allowResize = spec.AllowResize ?? defaultAllowResize;
                var target = ResolveImportFormat(spec.Format ?? defaultFormat, existing?.Format, spec.Did);

                // Dimensions: from the image unless allowResize=false pins them
                // to the retail record. Read them up front so the BC block
                // alignment can be rejected before any encode work.
                var info = Image.Identify(spec.PngPath);
                int newW = allowResize ? info.Width : (existing?.Width ?? 0);
                int newH = allowResize ? info.Height : (existing?.Height ?? 0);
                if (newW <= 0 || newH <= 0) {
                    throw new InvalidOperationException(
                        $"allowResize=false needs an existing record with non-zero dimensions (0x{spec.Did:X8}).");
                }
                if (IsBlockCompressed(target) && (newW % 4 != 0 || newH % 4 != 0)) {
                    throw new InvalidOperationException(
                        $"{target} is block-compressed: {newW}x{newH} is not a multiple of 4 in both axes " +
                        "(re-crop the source or import as A8R8G8B8).");
                }

                // Build a fresh record rather than mutating the one handed back
                // by the dat's file cache — a failed encode must not leave a
                // half-edited object behind for a later read.
                var surface = new DRW.DBObjs.RenderSurface {
                    Id = spec.Did,
                    DataCategory = existing?.DataCategory ?? 0,
                    Width = existing?.Width ?? newW,
                    Height = existing?.Height ?? newH,
                    Format = target,
                    DefaultPaletteId = existing?.DefaultPaletteId ?? 0,
                    SourceData = Array.Empty<byte>(),
                };
                // ReplaceWith(shouldResize:true) squeezes the image into the
                // record's existing W/H; shouldResize:false takes W/H from the
                // image. Either way it encodes to surface.Format — this is the
                // in-tree BC encoder path (BCnEncoder.Net 2.2.1).
                var enc = surface.ReplaceWith(spec.PngPath, shouldResize: !allowResize);
                if (!enc.Success) {
                    throw new InvalidOperationException($"encode failed: {enc.Error}");
                }

                int recordBytes = RenderSurfaceRecordBytes(surface);
                int blocks = (recordBytes + payloadPerBlock - 1) / payloadPerBlock;

                rec["srcFormat"] = existing?.Format.ToString() ?? "(new)";
                rec["dstFormat"] = surface.Format.ToString();
                rec["formatPreserved"] = existing != null && existing.Format == surface.Format;
                rec["srcWidth"] = existing?.Width;
                rec["srcHeight"] = existing?.Height;
                rec["width"] = surface.Width;
                rec["height"] = surface.Height;
                rec["imageWidth"] = info.Width;
                rec["imageHeight"] = info.Height;
                rec["allowResize"] = allowResize;
                rec["sourceBytes"] = surface.SourceData.Length;
                rec["recordBytes"] = recordBytes;
                rec["blocks"] = blocks;
                rec["onDiskBytes"] = blocks * blockSize;

                if (!dryRun) {
                    var result = portal.TryWriteFile(surface);
                    if (!result.Success) {
                        throw new InvalidOperationException($"TryWriteFile failed: {result.Error}");
                    }
                    // Read the record straight back out of the b-tree so the
                    // reported byte count is measured, not modelled.
                    if (portal.TryGetFileBytes(spec.Did, out var raw)) {
                        rec["writtenBytes"] = raw.Length;
                        if (raw.Length != recordBytes) {
                            rec["blocks"] = (raw.Length + payloadPerBlock - 1) / payloadPerBlock;
                            rec["onDiskBytes"] = (int)rec["blocks"]! * blockSize;
                            rec["recordBytesModelDelta"] = raw.Length - recordBytes;
                        }
                    }
                }
                rec["status"] = dryRun ? "DRY-RUN" : "WRITTEN";
                written++;
            } catch (Exception ex) {
                rec["status"] = "FAIL";
                rec["error"] = ex.Message;
                failed++;
            }
            records.Add(rec);
        }

        return new RenderSurfaceImportResult(
            DatPath: resolved, DryRun: dryRun, BlockSize: blockSize,
            RequestedCount: specs.Count,
            WrittenCount: dryRun ? 0 : written,
            FailCount: failed,
            Records: records);
    }

    /// <summary>Serialized size of a RenderSurface record: the DBObj header
    /// (Id + DataCategory, both flagged on for 0x06) plus Width/Height/Format/
    /// length prefix, plus the payload. DefaultPaletteId is only written for the
    /// paletted formats. Verified against the prototype's measurement — a 512²
    /// A8R8G8B8 record occupies 1,029 blocks of 1,020 payload bytes, i.e.
    /// 1,048,576 + 24.</summary>
    internal static int RenderSurfaceRecordBytes(DRW.DBObjs.RenderSurface s) {
        int n = 4 + 4          // Id, DataCategory
              + 4 + 4 + 4      // Width, Height, Format
              + 4              // _sourceDataLength
              + s.SourceData.Length;
        if (s.Format == DRW.Enums.PixelFormat.PFID_INDEX16
            || s.Format == DRW.Enums.PixelFormat.PFID_P8) {
            n += 4;            // DefaultPaletteId
        }
        return n;
    }

    internal static bool IsBlockCompressed(DRW.Enums.PixelFormat f) =>
        f == DRW.Enums.PixelFormat.PFID_DXT1
        || f == DRW.Enums.PixelFormat.PFID_DXT2
        || f == DRW.Enums.PixelFormat.PFID_DXT3
        || f == DRW.Enums.PixelFormat.PFID_DXT4
        || f == DRW.Enums.PixelFormat.PFID_DXT5;

    /// <summary>Resolve the requested format name against the record's current
    /// one. null/empty/"preserve"/"keep" → the existing format.</summary>
    internal static DRW.Enums.PixelFormat ResolveImportFormat(
        string? requested, DRW.Enums.PixelFormat? existing, uint did) {
        var want = requested?.Trim();
        if (string.IsNullOrEmpty(want)
            || want.Equals("preserve", StringComparison.OrdinalIgnoreCase)
            || want.Equals("keep", StringComparison.OrdinalIgnoreCase)) {
            if (existing == null) {
                throw new InvalidOperationException(
                    $"0x{did:X8} has no existing record to preserve a format from — pass an explicit 'format'.");
            }
            RejectUnencodableFormat(existing.Value, preserved: true);
            return existing.Value;
        }
        var name = want.StartsWith("PFID_", StringComparison.OrdinalIgnoreCase)
            ? want : "PFID_" + want;
        if (!Enum.TryParse<DRW.Enums.PixelFormat>(name, ignoreCase: true, out var parsed)
            || !Enum.IsDefined(typeof(DRW.Enums.PixelFormat), parsed)) {
            throw new ArgumentException(
                $"Unknown format '{requested}'. Encodable: " + string.Join(", ", EncodableFormatNames));
        }
        RejectUnencodableFormat(parsed, preserved: false);
        return parsed;
    }

    /// <summary>The formats <c>ConvertImageToFormat</c> can actually produce.
    /// P8/INDEX16 need palette quantization it does not do; everything else
    /// throws NotImplementedException there — better to say so up front.</summary>
    internal static readonly string[] EncodableFormatNames = {
        "DXT1", "DXT3", "DXT5", "A8R8G8B8", "R8G8B8", "CUSTOM_LSCAPE_R8G8B8",
        "A8", "CUSTOM_LSCAPE_ALPHA", "R5G6B5", "A4R4G4B4", "CUSTOM_RAW_JPEG",
    };

    private static void RejectUnencodableFormat(DRW.Enums.PixelFormat f, bool preserved) {
        bool ok = f switch {
            DRW.Enums.PixelFormat.PFID_DXT1 => true,
            DRW.Enums.PixelFormat.PFID_DXT3 => true,
            DRW.Enums.PixelFormat.PFID_DXT5 => true,
            DRW.Enums.PixelFormat.PFID_A8R8G8B8 => true,
            DRW.Enums.PixelFormat.PFID_R8G8B8 => true,
            DRW.Enums.PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8 => true,
            DRW.Enums.PixelFormat.PFID_A8 => true,
            DRW.Enums.PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA => true,
            DRW.Enums.PixelFormat.PFID_R5G6B5 => true,
            DRW.Enums.PixelFormat.PFID_A4R4G4B4 => true,
            DRW.Enums.PixelFormat.PFID_CUSTOM_RAW_JPEG => true,
            _ => false,
        };
        if (ok) return;
        bool paletted = f == DRW.Enums.PixelFormat.PFID_INDEX16
                        || f == DRW.Enums.PixelFormat.PFID_P8;
        throw new InvalidOperationException(
            (preserved
                ? $"The record's format {f} cannot be encoded to"
                : $"Format {f} cannot be encoded to")
            + (paletted
                ? " — it is palette-indexed and needs a quantization step this path does not have."
                : " — unsupported by ConvertImageToFormat.")
            + " Pass an explicit format instead (one of: "
            + string.Join(", ", EncodableFormatNames) + ").");
    }

    // ─────────────────────────────────────────────────────────────────
    //  surface-texture-collapse
    // ─────────────────────────────────────────────────────────────────

    /// <param name="Did">SurfaceTexture id (0x05……).</param>
    /// <param name="KeepDid">null → the LAST entry, i.e. the base-detail level
    /// that is the one actually present in client_portal.dat.</param>
    public sealed record SurfaceTextureCollapseSpec(uint Did, uint? KeepDid);

    /// <summary>Rewrite SurfaceTextures to a single-entry texture list. See the
    /// type doc for why the LAST entry is the default keeper.</summary>
    public SurfaceTextureCollapseResult SurfaceTextureCollapse(
        string datPath, IReadOnlyList<SurfaceTextureCollapseSpec> specs, bool dryRun) {
        if (specs == null || specs.Count == 0) {
            throw new ArgumentException(
                "No collapses resolved — pass idHex or a 'collapses' array of {id, keepDid?}.");
        }
        var resolved = GuardWritableDatCopy(datPath);

        var records = new List<Dictionary<string, object?>>();
        int collapsed = 0, unchanged = 0, failed = 0;

        using var portal = new DRW.PortalDatabase(resolved,
            dryRun ? DRW.Options.DatAccessType.Read : DRW.Options.DatAccessType.ReadWrite);

        foreach (var spec in specs) {
            var rec = new Dictionary<string, object?> {
                ["idHex"] = $"0x{spec.Did:X8}",
            };
            try {
                if ((spec.Did >> 24) != 0x05) {
                    throw new ArgumentException(
                        $"0x{spec.Did:X8} is not a SurfaceTexture id (expected the 0x05 prefix).");
                }
                if (!portal.TryGet<DRW.DBObjs.SurfaceTexture>(spec.Did, out var st) || st == null) {
                    throw new InvalidOperationException(
                        $"SurfaceTexture 0x{spec.Did:X8} not found in {Path.GetFileName(resolved)}.");
                }
                var oldList = st.Textures.Select(t => (uint)t).ToList();
                if (oldList.Count == 0) {
                    throw new InvalidOperationException(
                        $"SurfaceTexture 0x{spec.Did:X8} has an empty texture list — nothing to collapse.");
                }
                // Default keeper = the LAST entry. For a 2-entry list that is
                // the base-detail level (index 0 is the client_highres.dat
                // high-detail level, absent from client_portal.dat), and it is
                // also what holtburger's highest_res() already resolves to.
                uint keep = spec.KeepDid ?? oldList[^1];
                if (!oldList.Contains(keep)) {
                    throw new ArgumentException(
                        $"keepDid 0x{keep:X8} is not in 0x{spec.Did:X8}'s texture list " +
                        $"[{string.Join(", ", oldList.Select(d => $"0x{d:X8}"))}] — refusing to " +
                        "retarget a SurfaceTexture at an unrelated RenderSurface.");
                }

                rec["textureType"] = st.Type.ToString();
                rec["oldCount"] = oldList.Count;
                rec["oldList"] = oldList.Select(d => $"0x{d:X8}").ToList();
                rec["keepDid"] = $"0x{keep:X8}";
                rec["keepIndex"] = oldList.IndexOf(keep);
                rec["newCount"] = 1;
                rec["newList"] = new List<string> { $"0x{keep:X8}" };
                rec["keepDidDefaulted"] = !spec.KeepDid.HasValue;

                if (oldList.Count == 1 && oldList[0] == keep) {
                    rec["status"] = "ALREADY-SINGLE";
                    unchanged++;
                    records.Add(rec);
                    continue;
                }

                var updated = new DRW.DBObjs.SurfaceTexture {
                    Id = spec.Did,
                    DataCategory = st.DataCategory,
                    Type = st.Type,
                    Textures = [keep],
                };
                if (!dryRun) {
                    var result = portal.TryWriteFile(updated);
                    if (!result.Success) {
                        throw new InvalidOperationException($"TryWriteFile failed: {result.Error}");
                    }
                }
                rec["status"] = dryRun ? "DRY-RUN" : "COLLAPSED";
                collapsed++;
            } catch (Exception ex) {
                rec["status"] = "FAIL";
                rec["error"] = ex.Message;
                failed++;
            }
            records.Add(rec);
        }

        return new SurfaceTextureCollapseResult(
            DatPath: resolved, DryRun: dryRun,
            RequestedCount: specs.Count,
            CollapsedCount: dryRun ? 0 : collapsed,
            UnchangedCount: unchanged,
            FailCount: failed,
            Records: records);
    }
}
