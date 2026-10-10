using WorldBuilder.Shared.Lib.TexturePicker;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>Machine-local test data: the retail DATs and mounted data volumes.</summary>
internal static class TestData {
    public static string BaseDatPath(string fileName = "client_portal.dat") => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ac_base_dats", fileName);

    public static string TexturePickerRecommendationsPath => Path.Combine(
        TexturePickerSession.DefaultPickerDirectory, TexturePickerSession.RecommendationsFileName);
}

// Tests that need data which is not on every machine use these instead of [Fact], so a missing
// file is reported as SKIPPED rather than letting the test pass without checking anything.
// (xUnit 2.x has no in-test skip; the Skip property is read when tests are discovered.)

/// <summary>A [Fact] that is skipped when the retail DAT it reads is not in ~/ac_base_dats.</summary>
public sealed class BaseDatFactAttribute : FactAttribute {
    public BaseDatFactAttribute(string fileName = "client_portal.dat") {
        if (!File.Exists(TestData.BaseDatPath(fileName)))
            Skip = $"needs ~/ac_base_dats/{fileName}, which is not on this machine";
    }
}

/// <summary>A [Fact] that is skipped when the texture-picker data volume is not mounted.</summary>
public sealed class TexturePickerDataFactAttribute : FactAttribute {
    public TexturePickerDataFactAttribute() {
        if (!File.Exists(TestData.TexturePickerRecommendationsPath))
            Skip = $"needs {TestData.TexturePickerRecommendationsPath} (texture-picker data volume), which is not mounted";
    }
}
