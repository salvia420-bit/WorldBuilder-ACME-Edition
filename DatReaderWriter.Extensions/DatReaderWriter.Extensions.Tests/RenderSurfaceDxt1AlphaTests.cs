using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Extensions.DBObjs;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace DatReaderWriter.Extensions.Tests;

/// <summary>
/// DXT1 carries punch-through 1-bit alpha: when a block's c0 &lt;= c1 (compared
/// as u16) the block is in 3-colour mode and texel index 3 is TRANSPARENT.
/// D3D honours that unconditionally, so retail does too.
///
/// The decoder used to ask BCnEncoder for <c>CompressionFormat.Bc1</c> — the
/// OPAQUE variant — which turns those texels into RGBA(0,0,0,255). Every
/// clipped region exported as solid black; one fully-transparent surface
/// (0x0600396B) would have drawn as black chips across every quad using it.
/// </summary>
[TestClass]
public class RenderSurfaceDxt1AlphaTests {
    // RGB565: pure red is the numerically larger u16, pure blue the smaller.
    private const ushort Red565 = 0xF800;
    private const ushort Blue565 = 0x001F;

    /// <summary>One 8-byte DXT1 block: c0, c1, then the 2-bit index word.</summary>
    private static byte[] Dxt1Block(ushort c0, ushort c1, uint indices) => new[] {
        (byte)(c0 & 0xFF), (byte)(c0 >> 8),
        (byte)(c1 & 0xFF), (byte)(c1 >> 8),
        (byte)(indices & 0xFF), (byte)((indices >> 8) & 0xFF),
        (byte)((indices >> 16) & 0xFF), (byte)((indices >> 24) & 0xFF),
    };

    private static RenderSurface Dxt1Surface(byte[] block) => new() {
        Id = 0x06000001,
        Width = 4,
        Height = 4,
        Format = PixelFormat.PFID_DXT1,
        DefaultPaletteId = 0,
        SourceData = block,
    };

    /// <summary>
    /// c0 &lt;= c1 puts the block in 3-colour mode, so index 3 must decode to a
    /// fully transparent texel — not opaque black.
    /// </summary>
    [TestMethod]
    public void ToRgba8_Dxt1PunchThroughIndex3_IsTransparent() {
        // All 16 texels = index 3, c0 (blue) < c1 (red).
        var rgba = Dxt1Surface(Dxt1Block(Blue565, Red565, 0xFFFFFFFF)).ToRgba8(null!);

        Assert.AreEqual(4 * 4 * 4, rgba.Length);
        for (int texel = 0; texel < 16; texel++) {
            Assert.AreEqual(0, rgba[texel * 4 + 3],
                $"texel {texel} should be transparent (punch-through index 3)");
        }
    }

    /// <summary>
    /// The other half of the contract: c0 &gt; c1 is 4-colour mode, where index 3
    /// is an ordinary interpolated OPAQUE colour. A decoder that always applied
    /// punch-through would punch holes in opaque art, so pin this too.
    /// </summary>
    [TestMethod]
    public void ToRgba8_Dxt1FourColourIndex3_StaysOpaque() {
        // All 16 texels = index 3, c0 (red) > c1 (blue).
        var rgba = Dxt1Surface(Dxt1Block(Red565, Blue565, 0xFFFFFFFF)).ToRgba8(null!);

        for (int texel = 0; texel < 16; texel++) {
            Assert.AreEqual(255, rgba[texel * 4 + 3],
                $"texel {texel} should be opaque (4-colour index 3)");
        }

        // c3 = (c0 + 2*c1)/3, i.e. mostly blue — non-black, so this is really
        // decoding the interpolated colour rather than falling into the
        // punch-through path and clearing to zero.
        Assert.IsTrue(rgba[2] > 0, "index-3 texel should carry the interpolated blue");
    }

    /// <summary>
    /// Round-trip: importing a PNG with a cutout into a DXT1 record must keep
    /// the cutout. The encoder defaulted to the opaque Bc1 variant, which
    /// discarded alpha outright and silently produced a fully opaque texture.
    /// </summary>
    [TestMethod]
    public void ReplaceWith_Dxt1PngWithCutout_PreservesTransparency() {
        string path = Path.Combine(Path.GetTempPath(),
            $"dxt1-cutout-{Guid.NewGuid():N}.png");
        try {
            // Left half transparent, right half opaque red.
            using (var img = new Image<Rgba32>(16, 16)) {
                for (int y = 0; y < 16; y++)
                for (int x = 0; x < 16; x++) {
                    img[x, y] = x < 8
                        ? new Rgba32(0, 0, 0, 0)
                        : new Rgba32(255, 0, 0, 255);
                }

                img.SaveAsPng(path);
            }

            var surface = new RenderSurface {
                Id = 0x06000002,
                Width = 16,
                Height = 16,
                Format = PixelFormat.PFID_DXT1,
                DefaultPaletteId = 0,
                SourceData = Array.Empty<byte>(),
            };

            var replaced = surface.ReplaceWith(path);
            Assert.IsTrue(replaced.Success, $"ReplaceWith failed: {replaced.Error}");

            var rgba = surface.ToRgba8(null!);
            for (int y = 0; y < 16; y++)
            for (int x = 0; x < 16; x++) {
                int a = rgba[(y * 16 + x) * 4 + 3];
                if (x < 8) {
                    Assert.AreEqual(0, a, $"({x},{y}) should have survived as a cutout");
                }
                else {
                    Assert.AreEqual(255, a, $"({x},{y}) should have stayed opaque");
                }
            }
        }
        finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    /// <summary>
    /// A fully opaque import must keep encoding EXACTLY as before — the
    /// punch-through encoder is selected by content, because the two encoders
    /// do not agree byte-for-byte even on opaque input.
    /// </summary>
    [TestMethod]
    public void ReplaceWith_Dxt1OpaquePng_StaysFullyOpaque() {
        string path = Path.Combine(Path.GetTempPath(),
            $"dxt1-opaque-{Guid.NewGuid():N}.png");
        try {
            using (var img = new Image<Rgba32>(16, 16)) {
                for (int y = 0; y < 16; y++)
                for (int x = 0; x < 16; x++) {
                    img[x, y] = new Rgba32((byte)(x * 16), (byte)(y * 16), 64, 255);
                }

                img.SaveAsPng(path);
            }

            var surface = new RenderSurface {
                Id = 0x06000003,
                Width = 16,
                Height = 16,
                Format = PixelFormat.PFID_DXT1,
                DefaultPaletteId = 0,
                SourceData = Array.Empty<byte>(),
            };

            Assert.IsTrue(surface.ReplaceWith(path).Success);

            var rgba = surface.ToRgba8(null!);
            for (int texel = 0; texel < 16 * 16; texel++) {
                Assert.AreEqual(255, rgba[texel * 4 + 3],
                    $"texel {texel} must stay opaque — no stray punch-through");
            }
        }
        finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
