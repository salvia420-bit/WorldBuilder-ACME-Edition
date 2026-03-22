using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Extensions.DBObjs;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace DatReaderWriter.Extensions.Tests;

[TestClass]
public class RenderSurfaceTests {
    [TestMethod]
    public void ToRgba8_ShouldHandleDimensionMismatch() {
        // Arrange
        var renderSurface = new RenderSurface {
            Id = 0x1234,
            Width = 0,
            Height = 0,
            Format = PixelFormat.PFID_CUSTOM_RAW_JPEG,
            DefaultPaletteId = 0
        };

        // Create a fake JPEG that is LARGER than the RenderSurface
        using var stream = new MemoryStream();
        using (var img = new Image<Rgba32>(20, 20)) {
            img.SaveAsJpeg(stream);
        }

        renderSurface.SourceData = stream.ToArray();

        // Act
        // This should not throw IndexOutOfRangeException
        // We pass null for DatEasyWriter as it's not needed for PFID_CUSTOM_RAW_JPEG
        var result = renderSurface.ToRgba8(null!);

        // Assert
        Assert.IsNotNull(result);
        Assert.AreEqual(20 * 20 * 4, result.Length);
    }
}
