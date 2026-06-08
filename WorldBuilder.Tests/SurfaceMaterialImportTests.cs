using System;
using System.IO;

using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Options;

using WorldBuilder.Terminal;

namespace WorldBuilder.Tests;

/// <summary>
/// E9b — pins the C# round-trip half of E9. E9a (Rust scenery-bake, SHIPPED) emits a per-LB
/// <c>&lt;lbHex&gt;.scenery.materials.json</c> sidecar (a JSON array of faithful per-surface
/// material records, each copied off a DAT Surface 0x08, keyed by surface_did). E9b reads that
/// sidecar and writes EXPLICIT synthetic Surface(0x08) DAT records, then re-reads each Surface and
/// asserts byte-faithful round-trip.
///
/// Invariants pinned here:
///   1. A 1-solid + 1-textured sidecar imports to a TEMP DAT (never a retail base DAT) and every
///      record is Written + RoundTripOk.
///   2. The re-read Surface(0x08) — read straight from the persisted DAT bytes — has fields EQUAL to
///      the sidecar values: surface_type → Type, the three scalars, color_value → ColorValue (solid)
///      or orig_texture_id/orig_palette_id → OrigTextureId/OrigPaletteId (textured).
///   3. Records are keyed by the addressable surface_did (0x08 DID), never a list index.
/// </summary>
public class SurfaceMaterialImportTests {
    // Field names are snake_case and match scenery-bake.rs format_material_record EXACTLY:
    // surface_did ("0x%08X"), surface_type (u32), translucency/luminosity/diffuse ({:.6} numbers),
    // color_value (decimal u32, solid) OR orig_texture_id/orig_palette_id ("0x%08X", textured),
    // luminous_flag (bool).
    private const string SidecarJson = """
    [
      {"surface_did":"0x08000010","surface_type":1,"translucency":0.100000,"luminosity":0.000000,"diffuse":0.500000,"color_value":4287560770,"luminous_flag":false},
      {"surface_did":"0x08000040","surface_type":2,"translucency":0.250000,"luminosity":0.000000,"diffuse":0.750000,"orig_texture_id":"0x05001000","orig_palette_id":"0x04002000","luminous_flag":false}
    ]
    """;

    private static CommandEngine NewEngine() =>
        // The E9b import path is a pure sidecar→DAT operation and never touches project services.
        new CommandEngine(null!, null!, null!, null!, null!, null!);

    [Fact]
    public void SurfaceMaterialImport_RoundTripsSolidAndTextured() {
        string root = Path.Combine(Path.GetTempPath(), "SurfaceMaterialRT_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sidecarPath = Path.Combine(root, "00010001.scenery.materials.json");
            File.WriteAllText(sidecarPath, SidecarJson);
            string datDir = Path.Combine(root, "synthetic"); // TEMP DAT, never a retail base DAT

            var engine = NewEngine();
            var result = engine.SurfaceMaterialImport(sidecarPath, datDir);

            Assert.Null(result.Error);
            Assert.True(result.Success);
            Assert.Equal(1, result.SourceFileCount);
            Assert.Equal(2, result.RecordCount);
            Assert.Equal(2, result.WrittenCount);
            Assert.Equal(2, result.RoundTripOkCount);
            Assert.All(result.Records, r => Assert.True(r.Written && r.RoundTripOk, r.Error));

            // The synthetic dat dir was created/populated (additive override, never retail).
            Assert.True(File.Exists(Path.Combine(datDir, "client_portal.dat")));

            // Independently re-read the persisted Surface(0x08) bytes and assert sidecar fidelity.
            using var dats = new DatCollection(datDir, DatAccessType.Read);

            Assert.True(dats.TryGet<Surface>(0x08000010u, out var solid));
            Assert.NotNull(solid);
            Assert.Equal(0x01u, (uint)solid!.Type);
            Assert.Equal(0.1f, solid.Translucency);
            Assert.Equal(0.0f, solid.Luminosity);
            Assert.Equal(0.5f, solid.Diffuse);
            // color_value 4287560770 == 0xFF8EFC42 (ARGB, MSB = alpha).
            uint argb = ((uint)solid.ColorValue.Alpha << 24) | ((uint)solid.ColorValue.Red << 16)
                | ((uint)solid.ColorValue.Green << 8) | solid.ColorValue.Blue;
            Assert.Equal(0xFF8EFC42u, argb);

            Assert.True(dats.TryGet<Surface>(0x08000040u, out var textured));
            Assert.NotNull(textured);
            Assert.Equal(0x02u, (uint)textured!.Type);
            Assert.Equal(0.25f, textured.Translucency);
            Assert.Equal(0.0f, textured.Luminosity);
            Assert.Equal(0.75f, textured.Diffuse);
            Assert.Equal(0x05001000u, textured.OrigTextureId.DataId);
            Assert.Equal(0x04002000u, textured.OrigPaletteId.DataId);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    [Fact]
    public void SurfaceMaterialImport_KeyedBySurfaceDid_NotListIndex() {
        // Two records whose surface_dids are NOT their array positions — a faithful import must key
        // each written Surface by its 0x08 DID, never by list order.
        string root = Path.Combine(Path.GetTempPath(), "SurfaceMaterialKey_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sidecarPath = Path.Combine(root, "lb.scenery.materials.json");
            File.WriteAllText(sidecarPath, """
            [
              {"surface_did":"0x080000AB","surface_type":1,"translucency":0.000000,"luminosity":0.000000,"diffuse":1.000000,"color_value":16711680,"luminous_flag":false},
              {"surface_did":"0x08000CDE","surface_type":2,"translucency":0.000000,"luminosity":0.000000,"diffuse":1.000000,"orig_texture_id":"0x05000123","orig_palette_id":"0x04000456","luminous_flag":false}
            ]
            """);
            string datDir = Path.Combine(root, "synthetic");

            var result = NewEngine().SurfaceMaterialImport(sidecarPath, datDir);
            Assert.True(result.Success);

            using var dats = new DatCollection(datDir, DatAccessType.Read);
            // The DIDs are the addressable keys — reading by them returns the right surfaces.
            Assert.True(dats.TryGet<Surface>(0x080000ABu, out var a));
            Assert.Equal(0x01u, (uint)a!.Type);
            Assert.True(dats.TryGet<Surface>(0x08000CDEu, out var b));
            Assert.Equal(0x05000123u, b!.OrigTextureId.DataId);
            // The list-index DIDs (0x08000000, 0x08000001) must NOT exist — keyed by DID, not order.
            Assert.False(dats.TryGet<Surface>(0x08000000u, out _));
            Assert.False(dats.TryGet<Surface>(0x08000001u, out _));
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    [Fact]
    public void SurfaceMaterialImport_MalformedSidecar_ReturnsGracefulError() {
        // A corrupt/truncated sidecar must NOT throw out of the importer — programmatic callers
        // (without the REPL try/catch) must get a Success=false + Error result instead of a crash.
        string root = Path.Combine(Path.GetTempPath(), "SurfaceMaterialBad_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sidecarPath = Path.Combine(root, "bad.scenery.materials.json");
            File.WriteAllText(sidecarPath, "{ this is not valid json ");
            string datDir = Path.Combine(root, "synthetic");

            var result = NewEngine().SurfaceMaterialImport(sidecarPath, datDir);

            Assert.False(result.Success);
            Assert.NotNull(result.Error);
            Assert.Contains("Failed to parse sidecar", result.Error);
            Assert.Equal(0, result.RecordCount);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    [Fact]
    public void SurfaceMaterialImport_EmptySidecar_IsSuccessfulNoOp() {
        // E9a emits `[]` for empty landblocks (materials_sidecar_empty_for_no_placements). A cleanly
        // parsed empty sidecar must be a SUCCESSFUL no-op, not a "had failures" result.
        string root = Path.Combine(Path.GetTempPath(), "SurfaceMaterialEmpty_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sidecarPath = Path.Combine(root, "empty.scenery.materials.json");
            File.WriteAllText(sidecarPath, "[]");
            string datDir = Path.Combine(root, "synthetic");

            var result = NewEngine().SurfaceMaterialImport(sidecarPath, datDir);

            Assert.True(result.Success, result.Error);
            Assert.Null(result.Error);
            Assert.Equal(0, result.RecordCount);
            Assert.Equal(0, result.WrittenCount);
            Assert.Empty(result.Records);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    [Fact]
    public void SurfaceMaterialImport_TexturedBranch_DerivedFromSurfaceTypeMask() {
        // Wire-canonical branch: a textured surface_type (mask 0x06 set, here Base1ClipMap 0x4) must
        // round-trip via the (orig_texture_id, orig_palette_id) branch even though E9a always pairs
        // the mask with the fields. This pins the mask-based selection rather than field presence.
        string root = Path.Combine(Path.GetTempPath(), "SurfaceMaterialMask_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sidecarPath = Path.Combine(root, "mask.scenery.materials.json");
            File.WriteAllText(sidecarPath, """
            [
              {"surface_did":"0x08000099","surface_type":4,"translucency":0.000000,"luminosity":0.000000,"diffuse":1.000000,"orig_texture_id":"0x06001234","orig_palette_id":"0x04005678","luminous_flag":false}
            ]
            """);
            string datDir = Path.Combine(root, "synthetic");

            var result = NewEngine().SurfaceMaterialImport(sidecarPath, datDir);
            Assert.True(result.Success, result.Error);
            Assert.All(result.Records, r => Assert.True(r.Textured)); // mask 0x4 → textured branch

            using var dats = new DatCollection(datDir, DatAccessType.Read);
            Assert.True(dats.TryGet<Surface>(0x08000099u, out var s));
            Assert.Equal(0x04u, (uint)s!.Type);
            Assert.Equal(0x06001234u, s.OrigTextureId.DataId);
            Assert.Equal(0x04005678u, s.OrigPaletteId.DataId);
        }
        finally {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }
}
