using System.Collections.Generic;
using System.IO;
using System.Text.Json.Nodes;
using WorldBuilder.Shared.Lib;
using Xunit;

namespace WorldBuilder.Tests;

// P4.0c (vfx bake-migration) — the build-side round-trip gate for the descriptor
// catalog: SaveJsonl must emit WITHOUT a UTF-8 BOM (the pre-P4.0c BOM tripped the
// JS parser / will trip the P4 bake oracle), and a save→load cycle must preserve
// the descriptor (incl. per-component nested config) bit-for-bit at the model level.
public class VisualDescriptorRoundTripTests {
    private static VisualDescriptorIndex MakeIndex() {
        var idx = new VisualDescriptorIndex(new Dictionary<uint, VisualDescriptor>());
        idx.Upsert(new VisualDescriptor {
            Did = 0x02000724,
            Archetype = "tip-flex",
            Confidence = 0.95,
            Source = "classifier",
            Mech = "B",
            Components = new() {
                new VisualComponentRef {
                    Name = "deformation.tipFlex",
                    Channel = "transform",
                    Config = new JsonObject { ["shaftLen"] = 1.526, ["gripBase"] = -0.118 },
                },
            },
        });
        return idx;
    }

    [Fact]
    public void SaveJsonl_writes_no_BOM() {
        var path = Path.GetTempFileName();
        try {
            MakeIndex().SaveJsonl(path);
            var b = File.ReadAllBytes(path);
            Assert.False(b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF,
                "visual_descriptors.jsonl must be emitted WITHOUT a UTF-8 BOM (P4.0c)");
        } finally { File.Delete(path); }
    }

    [Fact]
    public void SaveJsonl_LoadJsonl_round_trips() {
        var path = Path.GetTempFileName();
        try {
            MakeIndex().SaveJsonl(path);
            var loaded = VisualDescriptorIndex.LoadJsonl(path);
            Assert.Equal(1, loaded.Count);
            var d = loaded.Get(0x02000724);
            Assert.NotNull(d);
            Assert.Equal("tip-flex", d!.Archetype);
            Assert.Equal("B", d.Mech);
            Assert.Single(d.Components);
            Assert.Equal("deformation.tipFlex", d.Components[0].Name);
            Assert.NotNull(d.Components[0].Config);
            Assert.Equal(1.526, d.Components[0].Config!["shaftLen"]!.GetValue<double>());
        } finally { File.Delete(path); }
    }
}
