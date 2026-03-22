using BCnEncoder.Decoder;
using BCnEncoder.Encoder;
using BCnEncoder.ImageSharp;
using BCnEncoder.Shared;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Lib;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using SixLabors.ImageSharp.Processing.Processors.Transforms;
using PixelFormat = DatReaderWriter.Enums.PixelFormat;

namespace DatReaderWriter.Extensions.DBObjs {
    /// <summary>
    /// <see cref="RenderSurface"/> extensions.
    /// </summary>
    public static class RenderSurfaceExtensions {
        /// <summary>
        /// Replace this <see cref="RenderSurface"/> with image data from a file. The file should be bmp/png/gif.
        /// Optionally resize it to match the original. This will keep the same <see cref="RenderSurface.Format"/> as
        /// the original. You are responsible for writing this back to the dats, this just replaces the internal data.
        /// </summary>
        /// <param name="renderSurface"></param>
        /// <param name="imageFilePath">The absolute path to an image file to replace this render surface with.</param>
        /// <param name="shouldResize">Weather to resize the image to the same size as the existing texture. Defaults to false</param>
        /// <returns>A Result based on success. If failed, the string will be the errors.</returns>
        public static Result<bool, string> ReplaceWith(this RenderSurface renderSurface, string imageFilePath,
            bool shouldResize = false) {
            try {
                using var img = Image.Load(imageFilePath);
                using var rgbaImg = img.CloneAs<Rgba32>();
                if (shouldResize) {
                    rgbaImg.Mutate([
                        new ResizeProcessor(new(), new Size(renderSurface.Width, renderSurface.Height))
                    ]);
                }
                else {
                    renderSurface.Width = rgbaImg.Width;
                    renderSurface.Height = rgbaImg.Height;
                }

                renderSurface.SourceData = ConvertImageToFormat(rgbaImg, renderSurface.Format);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }

            return true;
        }

        /// <summary>
        /// Save a RenderSurface to the specified image path file. The extension dictates the format (png/bmp/gif).
        /// </summary>
        /// <param name="renderSurface"></param>
        /// <param name="imageOutputPath"></param>
        /// <param name="writer"></param>
        /// <returns></returns>
        public static Result<bool, string> SaveToImageFile(this RenderSurface renderSurface, string imageOutputPath,
            DatEasyWriter writer) {
            Image<Argb32> image;
            if (renderSurface.Format == PixelFormat.PFID_CUSTOM_RAW_JPEG) {
                using var ms = new MemoryStream(renderSurface.SourceData);
                image = Image.Load<Argb32>(ms);
            }
            else {
                image = new Image<Argb32>(renderSurface.Width, renderSurface.Height);

                var pixelData = renderSurface.ToRgba8(writer);

                image.ProcessPixelRows(accessor => {
                    int byteIndex = 0;
                    for (int y = 0; y < accessor.Height; y++) {
                        var rowSpan = accessor.GetRowSpan(y);
                        for (int x = 0; x < rowSpan.Length; x++) {
                            rowSpan[x] = new Argb32(
                                r: pixelData[byteIndex + 0],
                                g: pixelData[byteIndex + 1],
                                b: pixelData[byteIndex + 2],
                                a: pixelData[byteIndex + 3]
                            );
                            byteIndex += 4;
                        }
                    }
                });
            }

            image.Save(imageOutputPath);
            image.Dispose();
            return true;
        }

        /// <summary>
        /// Convert a <see cref="RenderSurface"/> to raw RGBA byte data. Each pixel is 4 bytes (R, G, B, A).
        /// </summary>
        /// <param name="renderSurface">The render surface to convert.</param>
        /// <param name="datEasyWriter">Used to resolve palettes for indexed formats.</param>
        /// <returns>A byte array of width * height * 4 bytes in RGBA order, or an empty array on failure.</returns>
        public static byte[] ToRgba8(this RenderSurface renderSurface, DatEasyWriter datEasyWriter) {
            int width = renderSurface.Width;
            int height = renderSurface.Height;
            byte[] sourceData = renderSurface.SourceData;
            byte[] output = new byte[width * height * 4];

            switch (renderSurface.Format) {
                case PixelFormat.PFID_CUSTOM_RAW_JPEG: {
                    using var stream = new MemoryStream(sourceData);
                    using var img = Image.Load<Rgba32>(stream);
                    width = img.Width;
                    height = img.Height;
                    output = new byte[width * height * 4];

                    for (int i = 0; i < img.Height; i++)
                    for (int j = 0; j < img.Width; j++) {
                        int idx = (i * width + j) * 4;
                        var pixel = img[j, i];
                        output[idx + 0] = pixel.R;
                        output[idx + 1] = pixel.G;
                        output[idx + 2] = pixel.B;
                        output[idx + 3] = pixel.A;
                    }

                    break;
                }

                case PixelFormat.PFID_R8G8B8:
                    // On-disk order: B, G, R (no alpha)
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 3;
                        int dstIdx = (i * width + j) * 4;
                        output[dstIdx + 0] = sourceData[srcIdx + 2]; // R
                        output[dstIdx + 1] = sourceData[srcIdx + 1]; // G
                        output[dstIdx + 2] = sourceData[srcIdx + 0]; // B
                        output[dstIdx + 3] = 255; // A
                    }

                    break;

                case PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8:
                    // On-disk order: R, G, B (no alpha)
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 3;
                        int dstIdx = (i * width + j) * 4;
                        output[dstIdx + 0] = sourceData[srcIdx + 0]; // R
                        output[dstIdx + 1] = sourceData[srcIdx + 1]; // G
                        output[dstIdx + 2] = sourceData[srcIdx + 2]; // B
                        output[dstIdx + 3] = 255; // A
                    }

                    break;

                case PixelFormat.PFID_A8R8G8B8:
                    // ReadInt32 on little-endian reads bytes as B, G, R, A
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 4;
                        int dstIdx = srcIdx;
                        output[dstIdx + 0] = sourceData[srcIdx + 2]; // R
                        output[dstIdx + 1] = sourceData[srcIdx + 1]; // G
                        output[dstIdx + 2] = sourceData[srcIdx + 0]; // B
                        output[dstIdx + 3] = sourceData[srcIdx + 3]; // A
                    }

                    break;

                case PixelFormat.PFID_A8:
                case PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA:
                    // Single byte greyscale; replicate to R, G, B; full alpha
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = i * width + j;
                        int dstIdx = srcIdx * 4;
                        byte grey = sourceData[srcIdx];
                        output[dstIdx + 0] = grey;
                        output[dstIdx + 1] = grey;
                        output[dstIdx + 2] = grey;
                        output[dstIdx + 3] = 255;
                    }

                    break;

                case PixelFormat.PFID_P8: {
                    // 8-bit palette index — resolve via palette
                    var palette = datEasyWriter.Get<Palette>(renderSurface.DefaultPaletteId).Value
                                  ?? throw new ArgumentException(
                                      $"Unable to load DefaultPaletteId 0x{renderSurface.DefaultPaletteId} for RenderSurface 0x{renderSurface.Id}");

                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = i * width + j;
                        int dstIdx = srcIdx * 4;
                        var color = palette.Colors[sourceData[srcIdx]];
                        output[dstIdx + 0] = color.Red;
                        output[dstIdx + 1] = color.Green;
                        output[dstIdx + 2] = color.Blue;
                        output[dstIdx + 3] = color.Alpha;
                    }

                    break;
                }

                case PixelFormat.PFID_INDEX16: {
                    // 16-bit palette index — resolve via palette
                    var palette = datEasyWriter.Get<Palette>(renderSurface.DefaultPaletteId).Value
                                  ?? throw new ArgumentException(
                                      $"Unable to load DefaultPalette 0x{renderSurface.DefaultPaletteId:X8} from RenderSurface 0x{renderSurface.Id}");

                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 2;
                        int dstIdx = (i * width + j) * 4;
                        int palIndex = BitConverter.ToInt16(sourceData, srcIdx);
                        var color = palette.Colors[palIndex];
                        output[dstIdx + 0] = color.Red;
                        output[dstIdx + 1] = color.Green;
                        output[dstIdx + 2] = color.Blue;
                        output[dstIdx + 3] = color.Alpha;
                    }

                    break;
                }

                case PixelFormat.PFID_R5G6B5:
                    // 16-bit packed: RRRRR GGGGGG BBBBB
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 2;
                        int dstIdx = (i * width + j) * 4;
                        ushort val = BitConverter.ToUInt16(sourceData, srcIdx);
                        output[dstIdx + 0] = (byte)(((val >> 11) & 0x1F) << 3); // R: 5 bits → 8 bits
                        output[dstIdx + 1] = (byte)(((val >> 5) & 0x3F) << 2); // G: 6 bits → 8 bits
                        output[dstIdx + 2] = (byte)((val & 0x1F) << 3); // B: 5 bits → 8 bits
                        output[dstIdx + 3] = 255;
                    }

                    break;

                case PixelFormat.PFID_A4R4G4B4:
                    // 16-bit packed: AAAA RRRR GGGG BBBB
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int srcIdx = (i * width + j) * 2;
                        int dstIdx = (i * width + j) * 4;
                        ushort val = BitConverter.ToUInt16(sourceData, srcIdx);
                        output[dstIdx + 0] = (byte)(((val >> 8) & 0xF) * 17); // R: 4 bits → 8 bits
                        output[dstIdx + 1] = (byte)(((val >> 4) & 0xF) * 17); // G: 4 bits → 8 bits
                        output[dstIdx + 2] = (byte)((val & 0xF) * 17); // B: 4 bits → 8 bits
                        output[dstIdx + 3] = (byte)(((val >> 12) & 0xF) * 17); // A: 4 bits → 8 bits
                    }

                    break;

                case PixelFormat.PFID_DXT1:
                case PixelFormat.PFID_DXT3:
                case PixelFormat.PFID_DXT5: {
                    var compressionFormat = renderSurface.Format switch {
                        PixelFormat.PFID_DXT1 => CompressionFormat.Bc1,
                        PixelFormat.PFID_DXT3 => CompressionFormat.Bc2,
                        PixelFormat.PFID_DXT5 => CompressionFormat.Bc3,
                        _ => throw new InvalidOperationException("unreachable")
                    };

                    var decoder = new BcDecoder();
                    using var decoded = decoder.DecodeRawToImageRgba32(sourceData, width, height, compressionFormat);

                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int dstIdx = (i * width + j) * 4;
                        var pixel = decoded[j, i];
                        output[dstIdx + 0] = pixel.R;
                        output[dstIdx + 1] = pixel.G;
                        output[dstIdx + 2] = pixel.B;
                        output[dstIdx + 3] = pixel.A;
                    }

                    break;
                }

                default:
                    throw new NotImplementedException($"Unsupported render surface format: {renderSurface.Format}");
            }

            return output;
        }

        /// <summary>
        /// Convert a <see cref="Image&lt;Rgba32&gt;"/> to the specified <see cref="PixelFormat"/>.
        /// </summary>
        /// <param name="rgbaImg">The image to convert</param>
        /// <param name="format">The format to convert to</param>
        /// <returns>Converted bytes</returns>
        /// <exception cref="NotImplementedException"></exception>
        private static byte[] ConvertImageToFormat(Image<Rgba32> rgbaImg, PixelFormat format) {
            int width = rgbaImg.Width;
            int height = rgbaImg.Height;
            byte[] imageBytes;

            switch (format) {
                case PixelFormat.PFID_R8G8B8:
                    // On-disk order: B, G, R
                    imageBytes = new byte[width * height * 3];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int idx = (i * width + j) * 3;
                        imageBytes[idx + 0] = rgbaImg[j, i].B;
                        imageBytes[idx + 1] = rgbaImg[j, i].G;
                        imageBytes[idx + 2] = rgbaImg[j, i].R;
                    }

                    break;

                case PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8:
                    // On-disk order: R, G, B
                    imageBytes = new byte[width * height * 3];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int idx = (i * width + j) * 3;
                        imageBytes[idx + 0] = rgbaImg[j, i].R;
                        imageBytes[idx + 1] = rgbaImg[j, i].G;
                        imageBytes[idx + 2] = rgbaImg[j, i].B;
                    }

                    break;

                case PixelFormat.PFID_A8R8G8B8:
                    // ReadInt32 little-endian means on-disk byte order is B, G, R, A
                    imageBytes = new byte[width * height * 4];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        int idx = (i * width + j) * 4;
                        imageBytes[idx + 0] = rgbaImg[j, i].B;
                        imageBytes[idx + 1] = rgbaImg[j, i].G;
                        imageBytes[idx + 2] = rgbaImg[j, i].R;
                        imageBytes[idx + 3] = rgbaImg[j, i].A;
                    }

                    break;

                case PixelFormat.PFID_A8:
                case PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA:
                    // Single byte greyscale: average R, G, B to a luminance value
                    imageBytes = new byte[width * height];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        var pixel = rgbaImg[j, i];
                        imageBytes[i * width + j] = (byte)((pixel.R + pixel.G + pixel.B) / 3);
                    }

                    break;

                case PixelFormat.PFID_R5G6B5:
                    // Pack into 16-bit: RRRRR GGGGGG BBBBB
                    imageBytes = new byte[width * height * 2];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        var pixel = rgbaImg[j, i];
                        ushort r = (ushort)((pixel.R >> 3) & 0x1F);
                        ushort g = (ushort)((pixel.G >> 2) & 0x3F);
                        ushort b = (ushort)((pixel.B >> 3) & 0x1F);
                        ushort val = (ushort)((r << 11) | (g << 5) | b);
                        int idx = (i * width + j) * 2;
                        BitConverter.GetBytes(val).CopyTo(imageBytes, idx);
                    }

                    break;

                case PixelFormat.PFID_A4R4G4B4:
                    // Pack into 16-bit: AAAA RRRR GGGG BBBB
                    imageBytes = new byte[width * height * 2];
                    for (int i = 0; i < height; i++)
                    for (int j = 0; j < width; j++) {
                        var pixel = rgbaImg[j, i];
                        ushort a = (ushort)((pixel.A >> 4) & 0xF);
                        ushort r = (ushort)((pixel.R >> 4) & 0xF);
                        ushort g = (ushort)((pixel.G >> 4) & 0xF);
                        ushort b = (ushort)((pixel.B >> 4) & 0xF);
                        ushort val = (ushort)((a << 12) | (r << 8) | (g << 4) | b);
                        int idx = (i * width + j) * 2;
                        BitConverter.GetBytes(val).CopyTo(imageBytes, idx);
                    }

                    break;

                case PixelFormat.PFID_CUSTOM_RAW_JPEG:
                    using (var ms = new MemoryStream()) {
                        rgbaImg.SaveAsJpeg(ms);
                        imageBytes = ms.ToArray();
                    }

                    break;

                case PixelFormat.PFID_DXT1:
                case PixelFormat.PFID_DXT3:
                case PixelFormat.PFID_DXT5: {
                    var compressionFormat = format switch {
                        PixelFormat.PFID_DXT1 => CompressionFormat.Bc1,
                        PixelFormat.PFID_DXT3 => CompressionFormat.Bc2,
                        PixelFormat.PFID_DXT5 => CompressionFormat.Bc3,
                        _ => throw new InvalidOperationException("unreachable")
                    };

                    var encoder = new BcEncoder();
                    encoder.OutputOptions.GenerateMipMaps = false;
                    encoder.OutputOptions.Quality = CompressionQuality.Balanced;
                    encoder.OutputOptions.Format = compressionFormat;
                    encoder.OutputOptions.FileFormat = OutputFileFormat.Dds;

                    using var ms = new MemoryStream();
                    encoder.EncodeToStream(rgbaImg, ms);

                    // Strip the DDS container header to extract the raw compressed block data.
                    // DDS layout: 4 bytes magic + 124 bytes DDS_HEADER = 128 bytes total.
                    // (No DDS_HEADER_DXT10 is present for BC1/BC2/BC3.)
                    const int DdsHeaderSize = 128;
                    imageBytes = new byte[ms.Length - DdsHeaderSize];
                    ms.Position = DdsHeaderSize;
                    ms.Read(imageBytes, 0, imageBytes.Length);
                    break;
                }

                // Palette-based formats require an external palette and quantization step
                // that can't be performed with image data alone.
                case PixelFormat.PFID_P8:
                case PixelFormat.PFID_INDEX16:
                    throw new NotImplementedException(
                        $"{format} requires palette quantization, which is not supported here.");

                default:
                    throw new NotImplementedException($"PixelFormat {format} is currently unsupported.");
            }

            return imageBytes;
        }
    }
}