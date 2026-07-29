using System;
using System.Collections.Generic;
using System.IO;

using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;

using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

using WorldBuilder.Terminal;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the two dat-bake write commands (X-track #18): <c>render-surface-import</c>
/// and <c>surface-texture-collapse</c>.
///
/// The invariants that matter for the hires campaign, in order of consequence:
///   1. FORMAT PRESERVATION. <c>DatHeader.FileSize</c> is an int32 (2.147 GB cap)
///      and only the DXT1 re-encode fits, so an import against a DXT1 record must
///      come back out DXT1 — never silently promoted to A8R8G8B8 the way
///      <c>ui-image-replace</c> does, and never refused the way
///      <c>import-render-surface</c> does.
///   2. The record grows to the image's dimensions (allowResize default true).
///   3. Block-compressed formats reject non-multiple-of-4 dimensions rather than
///      writing something the client may misread.
///   4. Byte accounting: a RenderSurface record is 24 bytes of header/fields plus
///      the payload, and a DAT block carries BlockSize-4 payload bytes. This is
///      the arithmetic the whole size projection rests on.
///   5. A collapsed SurfaceTexture keeps exactly the LAST entry (the base-detail
///      level that ships in client_portal.dat), and a foreign keepDid is refused.
/// </summary>
public class DatBakeCommandsTests {

    private static CommandEngine NewEngine() =>
        // Both commands are pure datPath→DAT operations; no project services.
        new CommandEngine(null!, null!, null!, null!, null!, null!);

    private static string NewPortalDat(string root) {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "client_portal.dat");
        using var db = new PortalDatabase(o => {
            o.AccessType = DatAccessType.ReadWrite;
            o.FilePath = path;
        });
        // A freshly created DAT's free list IS contiguous, so the DatReaderWriter
        // ReserveBlockCore bug that forces bake/scripts/prep_dat.py on a RETAIL
        // copy does not apply here.
        db.BlockAllocator.InitNew(DatFileType.Portal, 0);
        return path;
    }

    private static string WritePng(string path, int w, int h) {
        using var img = new Image<Rgba32>(w, h);
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            img[x, y] = new Rgba32((byte)(x * 255 / Math.Max(1, w - 1)),
                                   (byte)(y * 255 / Math.Max(1, h - 1)),
                                   (byte)((x ^ y) & 0xFF), 255);
        }
        img.SaveAsPng(path);
        return path;
    }

    // ── format resolution ────────────────────────────────────────────

    [Theory]
    [InlineData("DXT1", PixelFormat.PFID_DXT1)]
    [InlineData("dxt1", PixelFormat.PFID_DXT1)]
    [InlineData("PFID_DXT1", PixelFormat.PFID_DXT1)]
    [InlineData("A8R8G8B8", PixelFormat.PFID_A8R8G8B8)]
    [InlineData("pfid_a8r8g8b8", PixelFormat.PFID_A8R8G8B8)]
    public void ResolveImportFormat_AcceptsNamesWithAndWithoutPrefix(string arg, PixelFormat want) {
        Assert.Equal(want, CommandEngine.ResolveImportFormat(arg, PixelFormat.PFID_R8G8B8, 0x06000001));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("preserve")]
    [InlineData("KEEP")]
    public void ResolveImportFormat_DefaultsToTheRecordsOwnFormat(string? arg) {
        // THE point of the command: a DXT1 record stays DXT1.
        Assert.Equal(PixelFormat.PFID_DXT1,
            CommandEngine.ResolveImportFormat(arg, PixelFormat.PFID_DXT1, 0x06000001));
    }

    [Fact]
    public void ResolveImportFormat_PreserveWithNoExistingRecord_Throws() {
        var ex = Assert.Throws<InvalidOperationException>(
            () => CommandEngine.ResolveImportFormat(null, null, 0x06000001));
        Assert.Contains("explicit 'format'", ex.Message);
    }

    [Fact]
    public void ResolveImportFormat_UnknownName_Throws() {
        var ex = Assert.Throws<ArgumentException>(
            () => CommandEngine.ResolveImportFormat("BOGUS42", PixelFormat.PFID_DXT1, 0x06000001));
        Assert.Contains("DXT1", ex.Message);           // lists what IS encodable
    }

    [Theory]
    [InlineData(PixelFormat.PFID_INDEX16)]
    [InlineData(PixelFormat.PFID_P8)]
    public void ResolveImportFormat_PalettedFormats_AreRefused(PixelFormat f) {
        // ConvertImageToFormat cannot quantize; say so up front rather than
        // failing deep in the encoder.
        Assert.Throws<InvalidOperationException>(
            () => CommandEngine.ResolveImportFormat(null, f, 0x06000001));
        Assert.Throws<InvalidOperationException>(
            () => CommandEngine.ResolveImportFormat(f.ToString(), PixelFormat.PFID_DXT1, 0x06000001));
    }

    [Fact]
    public void IsBlockCompressed_CoversTheDxtFamilyOnly() {
        Assert.True(CommandEngine.IsBlockCompressed(PixelFormat.PFID_DXT1));
        Assert.True(CommandEngine.IsBlockCompressed(PixelFormat.PFID_DXT3));
        Assert.True(CommandEngine.IsBlockCompressed(PixelFormat.PFID_DXT5));
        Assert.False(CommandEngine.IsBlockCompressed(PixelFormat.PFID_A8R8G8B8));
        Assert.False(CommandEngine.IsBlockCompressed(PixelFormat.PFID_INDEX16));
    }

    // ── byte accounting ──────────────────────────────────────────────

    [Fact]
    public void RenderSurfaceRecordBytes_Is24PlusPayload_AndMatchesThePrototypeMeasurement() {
        var dxt1 = new RenderSurface {
            Width = 512, Height = 512, Format = PixelFormat.PFID_DXT1,
            SourceData = new byte[512 * 512 / 2],
        };
        Assert.Equal(131072 + 24, CommandEngine.RenderSurfaceRecordBytes(dxt1));

        var argb = new RenderSurface {
            Width = 512, Height = 512, Format = PixelFormat.PFID_A8R8G8B8,
            SourceData = new byte[512 * 512 * 4],
        };
        // The prototype measured a 512² A8R8G8B8 record at 1,029 blocks of 1,020
        // payload bytes — that is exactly 1,048,576 + 24.
        Assert.Equal(1048576 + 24, CommandEngine.RenderSurfaceRecordBytes(argb));
        Assert.Equal(1029, (CommandEngine.RenderSurfaceRecordBytes(argb) + 1019) / 1020);

        var paletted = new RenderSurface {
            Width = 128, Height = 128, Format = PixelFormat.PFID_INDEX16,
            SourceData = new byte[128 * 128 * 2],
        };
        // + DefaultPaletteId, which is only serialized for INDEX16/P8.
        Assert.Equal(32768 + 24 + 4, CommandEngine.RenderSurfaceRecordBytes(paletted));
    }

    // ── render-surface-import, end to end on a synthetic DAT ─────────

    [Fact]
    public void RenderSurfaceImport_PreservesDxt1AndGrowsToTheImageDimensions() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeImport_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            var png = WritePng(Path.Combine(root, "src.png"), 64, 64);

            // Seed a small DXT1 record, exactly the shape of a retail target.
            using (var db = new PortalDatabase(datPath, DatAccessType.ReadWrite)) {
                Assert.True(db.TryWriteFile(new RenderSurface {
                    Id = 0x06000001, DataCategory = 8,
                    Width = 16, Height = 16, Format = PixelFormat.PFID_DXT1,
                    SourceData = new byte[16 * 16 / 2],
                }).Success);
            }

            var r = NewEngine().RenderSurfaceImport(
                datPath,
                new List<CommandEngine.RenderSurfaceImportSpec> {
                    new(0x06000001, png, null, null),
                },
                defaultFormat: null, defaultAllowResize: true, dryRun: false, allowCreate: false);

            Assert.Equal(0, r.FailCount);
            Assert.Equal(1, r.WrittenCount);
            var rec = r.Records[0];
            Assert.Equal("WRITTEN", rec["status"]);
            Assert.Equal("PFID_DXT1", rec["srcFormat"]);
            Assert.Equal("PFID_DXT1", rec["dstFormat"]);      // NOT promoted to A8R8G8B8
            Assert.Equal(true, rec["formatPreserved"]);
            Assert.Equal(64, rec["width"]);
            Assert.Equal(64, rec["height"]);
            Assert.Equal(64 * 64 / 2, rec["sourceBytes"]);
            Assert.Equal(64 * 64 / 2 + 24, rec["recordBytes"]);
            Assert.Equal(64 * 64 / 2 + 24, rec["writtenBytes"]);   // measured off the b-tree

            using (var db = new PortalDatabase(datPath, DatAccessType.Read)) {
                Assert.True(db.TryGet<RenderSurface>(0x06000001, out var got));
                Assert.Equal(PixelFormat.PFID_DXT1, got!.Format);
                Assert.Equal(64, got.Width);
                Assert.Equal(64, got.Height);
                Assert.Equal(64 * 64 / 2, got.SourceData.Length);
                Assert.Equal(8u, got.DataCategory);          // preserved, not zeroed
            }
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    [Fact]
    public void RenderSurfaceImport_ExplicitFormatOverridesAndAllowResizePinsRetailDims() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeImport2_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            var png = WritePng(Path.Combine(root, "src.png"), 64, 64);
            using (var db = new PortalDatabase(datPath, DatAccessType.ReadWrite)) {
                db.TryWriteFile(new RenderSurface {
                    Id = 0x06000002, Width = 16, Height = 16,
                    Format = PixelFormat.PFID_DXT1, SourceData = new byte[16 * 16 / 2],
                });
            }

            var r = NewEngine().RenderSurfaceImport(
                datPath,
                new List<CommandEngine.RenderSurfaceImportSpec> {
                    new(0x06000002, png, "A8R8G8B8", false),
                },
                defaultFormat: null, defaultAllowResize: true, dryRun: false, allowCreate: false);

            Assert.Equal(0, r.FailCount);
            var rec = r.Records[0];
            Assert.Equal("PFID_A8R8G8B8", rec["dstFormat"]);
            Assert.Equal(false, rec["formatPreserved"]);
            Assert.Equal(16, rec["width"]);                 // allowResize=false pins retail dims
            Assert.Equal(16, rec["height"]);
            Assert.Equal(16 * 16 * 4, rec["sourceBytes"]);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    [Fact]
    public void RenderSurfaceImport_RejectsNonBlockAlignedDimsForDxt() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeImport3_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            var png = WritePng(Path.Combine(root, "odd.png"), 30, 30);
            using (var db = new PortalDatabase(datPath, DatAccessType.ReadWrite)) {
                db.TryWriteFile(new RenderSurface {
                    Id = 0x06000003, Width = 16, Height = 16,
                    Format = PixelFormat.PFID_DXT1, SourceData = new byte[16 * 16 / 2],
                });
            }

            var r = NewEngine().RenderSurfaceImport(
                datPath,
                new List<CommandEngine.RenderSurfaceImportSpec> { new(0x06000003, png, null, null) },
                defaultFormat: null, defaultAllowResize: true, dryRun: true, allowCreate: false);

            Assert.Equal(1, r.FailCount);
            Assert.Equal("FAIL", r.Records[0]["status"]);
            Assert.Contains("multiple of 4", (string)r.Records[0]["error"]!);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    [Fact]
    public void RenderSurfaceImport_RefusesNonRenderSurfaceIds() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeImport4_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            var png = WritePng(Path.Combine(root, "src.png"), 16, 16);
            var r = NewEngine().RenderSurfaceImport(
                datPath,
                new List<CommandEngine.RenderSurfaceImportSpec> { new(0x05000001, png, "DXT1", null) },
                defaultFormat: null, defaultAllowResize: true, dryRun: true, allowCreate: true);
            Assert.Equal(1, r.FailCount);
            Assert.Contains("0x06 prefix", (string)r.Records[0]["error"]!);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    // ── surface-texture-collapse ─────────────────────────────────────

    [Fact]
    public void SurfaceTextureCollapse_KeepsTheLastEntryByDefault_AndIsIdempotent() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeCollapse_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            using (var db = new PortalDatabase(datPath, DatAccessType.ReadWrite)) {
                db.TryWriteFile(new SurfaceTexture {
                    Id = 0x05000001, Type = TextureType.Texture2D,
                    // index 0 = the client_highres.dat high-detail level,
                    // index 1 = the base level that actually ships in portal.
                    Textures = [0x06000010, 0x06000011],
                });
            }

            var engine = NewEngine();
            var r = engine.SurfaceTextureCollapse(datPath,
                new List<CommandEngine.SurfaceTextureCollapseSpec> { new(0x05000001, null) }, dryRun: false);

            Assert.Equal(0, r.FailCount);
            Assert.Equal(1, r.CollapsedCount);
            var rec = r.Records[0];
            Assert.Equal("COLLAPSED", rec["status"]);
            Assert.Equal(2, rec["oldCount"]);
            Assert.Equal("0x06000011", rec["keepDid"]);
            Assert.Equal(1, rec["keepIndex"]);
            Assert.Equal(true, rec["keepDidDefaulted"]);

            using (var db = new PortalDatabase(datPath, DatAccessType.Read)) {
                Assert.True(db.TryGet<SurfaceTexture>(0x05000001, out var st));
                Assert.Single(st!.Textures);
                Assert.Equal(0x06000011u, st.Textures[0].DataId);
                Assert.Equal(TextureType.Texture2D, st.Type);
            }

            // Re-running must be a no-op, not a second write.
            var again = engine.SurfaceTextureCollapse(datPath,
                new List<CommandEngine.SurfaceTextureCollapseSpec> { new(0x05000001, null) }, dryRun: false);
            Assert.Equal(0, again.CollapsedCount);
            Assert.Equal(1, again.UnchangedCount);
            Assert.Equal("ALREADY-SINGLE", again.Records[0]["status"]);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    [Fact]
    public void SurfaceTextureCollapse_ForeignKeepDid_IsRefused() {
        string root = Path.Combine(Path.GetTempPath(), "DatBakeCollapse2_" + Guid.NewGuid().ToString("N"));
        try {
            var datPath = NewPortalDat(root);
            using (var db = new PortalDatabase(datPath, DatAccessType.ReadWrite)) {
                db.TryWriteFile(new SurfaceTexture {
                    Id = 0x05000002, Type = TextureType.Texture2D,
                    Textures = [0x06000010, 0x06000011],
                });
            }

            var r = NewEngine().SurfaceTextureCollapse(datPath,
                new List<CommandEngine.SurfaceTextureCollapseSpec> { new(0x05000002, 0x06009999) },
                dryRun: true);
            Assert.Equal(1, r.FailCount);
            Assert.Contains("not in", (string)r.Records[0]["error"]!);

            // An explicit in-list keepDid IS honoured (index 0, the high-detail slot).
            var ok = NewEngine().SurfaceTextureCollapse(datPath,
                new List<CommandEngine.SurfaceTextureCollapseSpec> { new(0x05000002, 0x06000010) },
                dryRun: false);
            Assert.Equal(0, ok.FailCount);
            Assert.Equal("0x06000010", ok.Records[0]["keepDid"]);
            Assert.Equal(0, ok.Records[0]["keepIndex"]);
            Assert.Equal(false, ok.Records[0]["keepDidDefaulted"]);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    // ── the shared ~/ac_base_dats guard ──────────────────────────────

    [Fact]
    public void BothCommands_RefuseBaseDatsPaths() {
        var basePath = Path.Combine(
            System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile),
            "ac_base_dats", "client_portal.dat");
        if (!File.Exists(basePath)) return;      // guard is path-shaped; skip if absent

        var engine = NewEngine();
        Assert.Throws<InvalidOperationException>(() => engine.RenderSurfaceImport(
            basePath,
            new List<CommandEngine.RenderSurfaceImportSpec> { new(0x06000001, basePath, "DXT1", null) },
            null, true, dryRun: false, allowCreate: false));
        Assert.Throws<InvalidOperationException>(() => engine.SurfaceTextureCollapse(
            basePath,
            new List<CommandEngine.SurfaceTextureCollapseSpec> { new(0x05000001, null) }, dryRun: false));
    }
}
