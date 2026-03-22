using DatReaderWriter.DBObjs;
using DatReaderWriter.Extensions.Tests.Helpers;

namespace DatReaderWriter.Extensions.Tests;

[TestClass]
public class DatEasyWriterTitlesTests {
    [TestMethod]
    public void CanAddTitle() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        // First, we need to set up the required files for title management
        // This includes EnumMapper and StringTable
        SetupTitlePrerequisites(writer);

        var result = writer.AddTitle("Test Title");

        Assert.IsTrue(result.Success, result.Error ?? "");
        Assert.IsTrue(result.Value > 0);
    }

    [TestMethod]
    public void CanAddAndUpdateTitle() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        SetupTitlePrerequisites(writer);

        var addResult = writer.AddTitle("Original Title");
        Assert.IsTrue(addResult.Success, addResult.Error ?? "");

        var updateResult = writer.UpdateTitle("Original Title", "Updated Title");
        Assert.IsTrue(updateResult.Success, updateResult.Error ?? "");
    }

    [TestMethod]
    public void CanAddAndRemoveTitle() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        SetupTitlePrerequisites(writer);

        var addResult = writer.AddTitle("Title To Remove");
        Assert.IsTrue(addResult.Success, addResult.Error ?? "");

        var removeResult = writer.RemoveTitle("Title To Remove");
        Assert.IsTrue(removeResult.Success, removeResult.Error ?? "");
    }

    [TestMethod]
    public void CanCheckTitleExists() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        SetupTitlePrerequisites(writer);

        var titleName = "Existing Title";
        var addResult = writer.AddTitle(titleName);
        Assert.IsTrue(addResult.Success, addResult.Error ?? "");
        var titleId = addResult.Value;

        // Check if existing title exists by name
        var existsByName = writer.TitleExists(titleName);
        Assert.IsTrue(existsByName.Success, existsByName.Error ?? "");
        Assert.IsTrue(existsByName.Value);

        // Check if existing title exists by id
        var existsById = writer.TitleExists(titleId);
        Assert.IsTrue(existsById.Success, existsById.Error ?? "");
        Assert.IsTrue(existsById.Value);

        // Check if non-existing title exists by name
        var notExistsByName = writer.TitleExists("Non-existing Title");
        Assert.IsTrue(notExistsByName.Success, notExistsByName.Error ?? "");
        Assert.IsFalse(notExistsByName.Value);

        // Check if non-existing title exists by id
        var notExistsById = writer.TitleExists(titleId + 1);
        Assert.IsTrue(notExistsById.Success, notExistsById.Error ?? "");
        Assert.IsFalse(notExistsById.Value);
    }

    [TestMethod]
    public void CanGetTitle() {
        using var tempDat = new TempDatDirectory();
        using var writer = new DatEasyWriter(tempDat.DirectoryPath);

        SetupTitlePrerequisites(writer);

        var titleName = "Lookup Title";
        var addResult = writer.AddTitle(titleName);
        Assert.IsTrue(addResult.Success, addResult.Error ?? "");
        var titleId = addResult.Value;

        // Get title name by ID
        var getNameResult = writer.GetTitle(titleId);
        Assert.IsTrue(getNameResult.Success, getNameResult.Error ?? "");
        Assert.AreEqual(titleName, getNameResult.Value);

        // Get title ID by name
        var getIdResult = writer.GetTitle(titleName);
        Assert.IsTrue(getIdResult.Success, getIdResult.Error ?? "");
        Assert.AreEqual(titleId, getIdResult.Value);

        // Get non-existing title by ID
        var getNonExistingName = writer.GetTitle(titleId + 1);
        Assert.IsFalse(getNonExistingName.Success);

        // Get non-existing title by name
        var getNonExistingId = writer.GetTitle("Non-existing Title");
        Assert.IsFalse(getNonExistingId.Success);
    }

    /// <summary>
    /// Sets up the prerequisite files for title operations.
    /// Title operations require EnumMapper and StringTable files.
    /// </summary>
    private void SetupTitlePrerequisites(DatEasyWriter writer) {
        // Create the CharacterTitle EnumMapper (0x22000041)
        var enumMapper = new EnumMapper { Id = 0x22000041, BaseEnumMap = 0, IdToStringMap = [] };
        writer.Dats.TryWriteFile(enumMapper);

        // Create the StringTable for titles (0x2300000E)
        var stringTable = new StringTable { Id = 0x2300000E, Language = 1, Strings = [] };
        writer.Dats.TryWriteFile(stringTable);
    }
}
