using DatReaderWriter.Enums;
using DatReaderWriter.Extensions.Tests.Helpers;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace DatReaderWriter.Extensions.Tests;

[TestClass]
public class DatEasyWriterRenderSurfaceTests {
    [TestMethod]
    public void CanAddRenderSurface() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        var imagePath = Path.Combine(tempDat.DirectoryPath, "test.png");
        CreateTestImage(imagePath, 32, 32);

        var id = 0x06001234u;
        var result = writer.AddRenderSurface(id, imagePath, PixelFormat.PFID_A8R8G8B8);

        Assert.IsTrue(result.Success, result.Error ?? "");

        var getResult = writer.GetRenderSurface(id);
        Assert.IsTrue(getResult.Success, getResult.Error ?? "");
        Assert.AreEqual(32, getResult.Value!.Width);
        Assert.AreEqual(32, getResult.Value!.Height);
        Assert.AreEqual(PixelFormat.PFID_A8R8G8B8, getResult.Value!.Format);
    }

    [TestMethod]
    public void CanUpdateRenderSurface() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        var imagePath1 = Path.Combine(tempDat.DirectoryPath, "test1.png");
        CreateTestImage(imagePath1, 32, 32, Color.Red);

        var id = 0x06001235u;
        writer.AddRenderSurface(id, imagePath1, PixelFormat.PFID_A8R8G8B8);

        var imagePath2 = Path.Combine(tempDat.DirectoryPath, "test2.png");
        CreateTestImage(imagePath2, 64, 64, Color.Blue);

        var updateResult = writer.UpdateRenderSurface(id, imagePath2);
        Assert.IsTrue(updateResult.Success, updateResult.Error ?? "");

        var getResult = writer.GetRenderSurface(id);
        Assert.AreEqual(64, getResult.Value!.Width);
        Assert.AreEqual(64, getResult.Value!.Height);
    }

    [TestMethod]
    public void CanSaveRenderSurfaceToImage() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        var imagePath = Path.Combine(tempDat.DirectoryPath, "test.png");
        CreateTestImage(imagePath, 32, 32);

        var id = 0x06001236u;
        writer.AddRenderSurface(id, imagePath, PixelFormat.PFID_A8R8G8B8);

        var outputPath = Path.Combine(tempDat.DirectoryPath, "output.png");
        var saveResult = writer.SaveRenderSurfaceToImage(id, outputPath);
        Assert.IsTrue(saveResult.Success, saveResult.Error ?? "");
        Assert.IsTrue(File.Exists(outputPath));
    }

    private void CreateTestImage(string path, int width, int height, Color? color = null) {
        using var image = new Image<Rgba32>(width, height);
        var c = color ?? Color.HotPink;
        var rgba = c.ToPixel<Rgba32>();
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                image[x, y] = rgba;
            }
        }

        image.Save(path);
    }
}
