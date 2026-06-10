using System.Text.Json;
using DatReaderWriter;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Options;
using WorldBuilder.Terminal;
using RegionObj = DatReaderWriter.DBObjs.Region;

namespace WorldBuilder.Tests {
    /// <summary>
    /// Melt-integration Phase R — Region 0x13 JSON round-trip fidelity.
    /// See docs/melt-integration-plan-2026-06-10.md §2 acceptance criteria.
    ///
    /// Uses the real retail portal DAT per [[feedback_test_fixtures_real_data]];
    /// tests skip (not fail) when ~/ac_base_dats is absent (CI boxes without
    /// game data).
    /// </summary>
    public class RegionRoundTripTests {
        private const uint RegionFileId = 0x13000000;

        private static string? BaseDatPath() {
            var p = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "ac_base_dats", "client_portal.dat");
            return File.Exists(p) ? p : null;
        }

        private static RegionObj LoadRetailRegion(string datPath) {
            using var dat = new DatDatabase(o => {
                o.FilePath = datPath;
                o.AccessType = DatAccessType.Read;
                o.IndexCachingStrategy = IndexCachingStrategy.Never;
            });
            Assert.True(dat.TryGet<RegionObj>(RegionFileId, out var region));
            Assert.NotNull(region);
            return region!;
        }

        [Fact]
        public void JsonRoundTrip_PacksByteIdentical_ToDirectLoad() {
            var datPath = BaseDatPath();
            if (datPath == null) return; // skip: real base DAT not present on this box

            var region = LoadRetailRegion(datPath!);
            var bytesDirect = CommandEngine.PackRegion(region);

            // Region → JSON doc → serialized JSON → deserialized doc → Region
            var doc = CommandEngine.RegionToJsonDoc(region);
            var json = JsonSerializer.Serialize(doc, CommandEngine.RegionJsonOptions());
            var doc2 = JsonSerializer.Deserialize<CommandEngine.RegionJsonDoc>(
                json, CommandEngine.RegionJsonOptions());
            Assert.NotNull(doc2);
            Assert.Empty(CommandEngine.ValidateRegionJsonDoc(doc2!));

            var rebuilt = CommandEngine.JsonDocToRegion(doc2!);
            var bytesRebuilt = CommandEngine.PackRegion(rebuilt);

            Assert.Equal(bytesDirect.Length, bytesRebuilt.Length);
            Assert.True(bytesDirect.AsSpan().SequenceEqual(bytesRebuilt),
                "JSON round-trip changed the packed Region bytes — mapper is lossy.");
        }

        [Fact]
        public void PackedBytes_MatchRawDatRecord_AfterUnpackRepack() {
            var datPath = BaseDatPath();
            if (datPath == null) return; // skip: real base DAT not present on this box

            // DRW wire parity sanity: unpack → pack must be self-consistent.
            var region = LoadRetailRegion(datPath!);
            var bytesA = CommandEngine.PackRegion(region);

            var reparsed = new RegionObj();
            ((IUnpackable)reparsed).Unpack(new DatBinReader(bytesA));
            var bytesB = CommandEngine.PackRegion(reparsed);

            Assert.True(bytesA.AsSpan().SequenceEqual(bytesB));
        }

        [Fact]
        public void ExportedDoc_CoversAllRetailParts() {
            var datPath = BaseDatPath();
            if (datPath == null) return; // skip: real base DAT not present on this box

            var doc = CommandEngine.RegionToJsonDoc(LoadRetailRegion(datPath!));

            // Retail Dereth region carries every optional part (PartsMask 0x21F).
            Assert.Equal("Dereth", doc.RegionName);
            Assert.Equal(256, doc.LandDefs.LandHeightTable.Count);
            Assert.NotNull(doc.SkyInfo);
            Assert.True(doc.SkyInfo!.DayGroups.Count > 0, "no DayGroups");
            Assert.All(doc.SkyInfo.DayGroups, g => Assert.True(g.SkyTime.Count > 0));
            Assert.NotNull(doc.SoundInfo);
            Assert.True(doc.SoundInfo!.StbDesc.Count > 0, "no ambient STBs");
            Assert.NotNull(doc.SceneInfo);
            Assert.True(doc.SceneInfo!.SceneTypes.Count > 0, "no scene types");
            Assert.True(doc.TerrainInfo.TerrainTypes.Count > 0, "no terrain types");
            Assert.True(doc.TerrainInfo.LandSurfaces.TexMerge.TerrainDesc.Count > 0, "no TexMerge terrain descs");
            Assert.True(doc.TerrainInfo.LandSurfaces.TexMerge.CornerTerrainMaps.Count > 0, "no corner alpha maps");
            Assert.True(doc.TerrainInfo.LandSurfaces.TexMerge.RoadMaps.Count > 0, "no road alpha maps");
            Assert.NotNull(doc.RegionMisc);
        }

        [Fact]
        public void Validation_CatchesPartsMaskInconsistency() {
            var datPath = BaseDatPath();
            if (datPath == null) return; // skip: real base DAT not present on this box

            var doc = CommandEngine.RegionToJsonDoc(LoadRetailRegion(datPath!));
            doc.SkyInfo = null; // mask still claims HasSkyInfo
            var problems = CommandEngine.ValidateRegionJsonDoc(doc);
            Assert.Contains(problems, p => p.Contains("skyInfo"));
        }
    }
}
