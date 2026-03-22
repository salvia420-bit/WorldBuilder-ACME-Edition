using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Extensions.Tests.Helpers;
using DatReaderWriter.Options;
using DatReaderWriter.Types;

namespace DatReaderWriter.Extensions.Tests;

[TestClass]
public class DatEasyWriterTests {
    [TestMethod]
    public void CanCreateFromDirectory() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        Assert.IsNotNull(writer.Dats);
        Assert.IsNotNull(writer.Dats.Portal);
        Assert.IsNotNull(writer.Dats.Cell);
        Assert.IsNotNull(writer.Dats.Local);
        Assert.IsNotNull(writer.Dats.HighRes);
    }

    [TestMethod]
    public void CanCreateFromDatCollection() {
        using var tempDat = new TempDatDirectory();
        using var dats = tempDat.CreateDatCollection(DatAccessType.ReadWrite);
        using var writer = new DatEasyWriter(dats);

        Assert.IsNotNull(writer.Dats);
        Assert.AreSame(dats, writer.Dats);
    }

    [TestMethod]
    public void ThrowsWhenDatCollectionNotReadWrite() {
        using var tempDat = new TempDatDirectory();
        using var dats = tempDat.CreateDatCollection(DatAccessType.Read);

        Assert.ThrowsException<ArgumentException>(() => {
            using var writer = new DatEasyWriter(dats);
        });
    }
}
