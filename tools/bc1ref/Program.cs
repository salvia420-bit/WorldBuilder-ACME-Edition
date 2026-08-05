// bc1ref — an INDEPENDENT BC1/DXT1 reference encoder, decoder and image
// comparer for the render-surface-import round-trip checks.
//
// WHY IT EXISTS
// DXT1 is lossy, so "the DAT bytes equal the source PNG" is the wrong
// assertion. The right one is: the blocks `render-surface-import` stored must
// equal what an INDEPENDENT encode of the same PNG produces with the same
// settings, and the two must decode to identical pixels. That only means
// anything if this tool shares no code with the path it checks — hence a
// standalone project against the BCnEncoder.Net public API, with no reference
// to WorldBuilder or DatReaderWriter.Extensions. A cross-check that calls the
// implementation it is checking is a tautology.
//
// WHY IT IS IN THE REPO
// It was a session scratchpad console app
// (/tmp/claude-1000/.../549f737d-.../scratchpad/bc1ref). That directory was
// reaped, taking the sources with it, and both consumers —
// pbr-terrain/bake/full/decode_compare_full.py and
// pbr-terrain/bake/agentL/decode_compare.py — had been broken ever since,
// silently, because nothing runs them on a schedule. Reconstructed 2026-08-05
// from the two call sites (which fix the CLI and JSON contract exactly) and the
// encoder settings in RenderSurfaceExtensions.cs. Committed this time.
//
// ENCODER SETTINGS — must track RenderSurfaceExtensions.cs `case PFID_DXT1`:
//   GenerateMipMaps = false
//   Quality         = CompressionQuality.Balanced
//   Format          = Bc1WithAlpha when the image has ANY pixel with A != 255,
//                     else Bc1  (the two do NOT agree byte-for-byte even on
//                     opaque input, so the choice is load-bearing)
//   FileFormat      = Dds, then strip the 128-byte header (4 magic + 124
//                     DDS_HEADER; no DXT10 header for BC1/2/3)
// The alpha test is reimplemented here rather than imported, for the same
// independence reason.
//
// CLI (fixed by the callers — JSON on the LAST stdout line, exit non-zero on
// failure):
//   bc1ref encode  <in.png> <out.bin>
//   bc1ref decode  <in.bin> <w> <h> <out.png>
//   bc1ref compare <a.png> <b.png>      -> {equal, diffPixels, maxAbsDelta}
//
// Build: dotnet build -c Release tools/bc1ref  (see build.sh)

using System.Globalization;
using System.Text.Json;
using BCnEncoder.Decoder;
using BCnEncoder.Encoder;
using BCnEncoder.ImageSharp;
using BCnEncoder.Shared;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Bc1Ref;

internal static class Program {
    /// DDS magic (4) + DDS_HEADER (124). BC1/BC2/BC3 carry no DXT10 header.
    private const int DdsHeaderSize = 128;

    private static int Main(string[] args) {
        try {
            if (args.Length == 0) return Usage();
            switch (args[0]) {
                case "encode":
                    if (args.Length != 3) return Usage();
                    return Encode(args[1], args[2]);
                case "decode":
                    if (args.Length != 5) return Usage();
                    return Decode(args[1], args[2], args[3], args[4]);
                case "compare":
                    if (args.Length != 3) return Usage();
                    return Compare(args[1], args[2]);
                default:
                    return Usage();
            }
        } catch (Exception e) {
            Console.Error.WriteLine($"bc1ref: {e.GetType().Name}: {e.Message}");
            return 1;
        }
    }

    private static int Usage() {
        Console.Error.WriteLine(
            "usage:\n" +
            "  bc1ref encode  <in.png> <out.bin>\n" +
            "  bc1ref decode  <in.bin> <w> <h> <out.png>\n" +
            "  bc1ref compare <a.png> <b.png>");
        return 2;
    }

    private static void Emit(object o) =>
        Console.WriteLine(JsonSerializer.Serialize(o));

    /// <summary>
    /// ANY pixel with A != 255. Deliberately the same rule as
    /// RenderSurfaceExtensions.HasTransparency, reimplemented rather than
    /// referenced — if that rule ever changes, this tool SHOULD start
    /// disagreeing, because a silent encoder-selection change is exactly the
    /// class of bug the round-trip check exists to catch.
    /// </summary>
    private static bool HasTransparency(Image<Rgba32> img) {
        for (int y = 0; y < img.Height; y++)
        for (int x = 0; x < img.Width; x++) {
            if (img[x, y].A != 255) return true;
        }
        return false;
    }

    private static int Encode(string inPng, string outBin) {
        using var img = Image.Load<Rgba32>(inPng);
        bool alpha = HasTransparency(img);
        var format = alpha ? CompressionFormat.Bc1WithAlpha : CompressionFormat.Bc1;

        var encoder = new BcEncoder();
        encoder.OutputOptions.GenerateMipMaps = false;
        encoder.OutputOptions.Quality = CompressionQuality.Balanced;
        encoder.OutputOptions.Format = format;
        encoder.OutputOptions.FileFormat = OutputFileFormat.Dds;

        using var ms = new MemoryStream();
        encoder.EncodeToStream(img, ms);
        if (ms.Length <= DdsHeaderSize) {
            throw new InvalidOperationException(
                $"encoder produced {ms.Length} bytes, <= the {DdsHeaderSize}-byte DDS header");
        }

        var blocks = new byte[ms.Length - DdsHeaderSize];
        ms.Position = DdsHeaderSize;
        ms.ReadExactly(blocks, 0, blocks.Length);
        File.WriteAllBytes(outBin, blocks);

        // Blocks-per-axis is ceil(dim/4); BC1 is 8 bytes per 4x4 block.
        long expect = (long)((img.Width + 3) / 4) * ((img.Height + 3) / 4) * 8;
        Emit(new {
            op = "encode",
            width = img.Width,
            height = img.Height,
            hasTransparency = alpha,
            format = format.ToString(),
            quality = "Balanced",
            bytes = blocks.Length,
            expectedBytes = expect,
            bytesMatchExpected = blocks.Length == expect,
            output = outBin,
        });
        return 0;
    }

    private static int Decode(string inBin, string wArg, string hArg, string outPng) {
        int w = int.Parse(wArg, CultureInfo.InvariantCulture);
        int h = int.Parse(hArg, CultureInfo.InvariantCulture);
        if (w <= 0 || h <= 0) throw new ArgumentException($"bad dims {w}x{h}");

        var blocks = File.ReadAllBytes(inBin);
        long expect = (long)((w + 3) / 4) * ((h + 3) / 4) * 8;
        if (blocks.Length != expect) {
            throw new InvalidOperationException(
                $"{inBin} is {blocks.Length} B; {w}x{h} BC1 needs exactly {expect} B");
        }

        // Decode as Bc1WithAlpha: on blocks written by the plain Bc1 encoder
        // every block is opaque-mode, so the alpha-aware decoder returns the
        // same pixels — one decode path serves both encoder choices, which is
        // what lets `compare` be an apples-to-apples pixel test.
        var decoder = new BcDecoder();
        using var img = decoder.DecodeRawToImageRgba32(
            blocks, w, h, CompressionFormat.Bc1WithAlpha);
        img.SaveAsPng(outPng);

        Emit(new {
            op = "decode",
            width = w,
            height = h,
            bytes = blocks.Length,
            output = outPng,
        });
        return 0;
    }

    private static int Compare(string aPath, string bPath) {
        using var a = Image.Load<Rgba32>(aPath);
        using var b = Image.Load<Rgba32>(bPath);
        if (a.Width != b.Width || a.Height != b.Height) {
            // A dimension mismatch is a real result, not a crash: report it and
            // let the caller's `equal` assertion fail on it.
            Emit(new {
                op = "compare",
                equal = false,
                reason = "dimension mismatch",
                aWidth = a.Width, aHeight = a.Height,
                bWidth = b.Width, bHeight = b.Height,
                diffPixels = -1, maxAbsDelta = -1,
            });
            return 0;
        }

        long diffPixels = 0;
        int maxAbsDelta = 0;
        for (int y = 0; y < a.Height; y++)
        for (int x = 0; x < a.Width; x++) {
            Rgba32 pa = a[x, y], pb = b[x, y];
            // RGB only — the callers compare decoded colour. (BC1 alpha is
            // 1-bit and already decided the encoder choice upstream.)
            int dr = Math.Abs(pa.R - pb.R), dg = Math.Abs(pa.G - pb.G), db = Math.Abs(pa.B - pb.B);
            int d = Math.Max(dr, Math.Max(dg, db));
            if (d != 0) diffPixels++;
            if (d > maxAbsDelta) maxAbsDelta = d;
        }

        Emit(new {
            op = "compare",
            equal = diffPixels == 0,
            width = a.Width,
            height = a.Height,
            diffPixels,
            maxAbsDelta,
        });
        return 0;
    }
}
