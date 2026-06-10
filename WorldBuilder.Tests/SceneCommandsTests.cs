using DatReaderWriter;
using DatReaderWriter.Options;
using WorldBuilder.Terminal;
using SceneObj = DatReaderWriter.DBObjs.Scene;

namespace WorldBuilder.Tests {
    /// <summary>
    /// Melt-integration Phase S — Scene 0x12 mapping fidelity.
    /// See docs/melt-integration-plan-2026-06-10.md §3.
    /// Real retail portal DAT per [[feedback_test_fixtures_real_data]];
    /// skips when ~/ac_base_dats is absent.
    /// </summary>
    public class SceneCommandsTests {
        private static string? BaseDatPath() {
            var p = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "ac_base_dats", "client_portal.dat");
            return File.Exists(p) ? p : null;
        }

        [Fact]
        public void SceneToJsonDoc_PreservesEveryObjectDescField() {
            var datPath = BaseDatPath();
            if (datPath == null) return; // skip: real base DAT not present on this box

            using var dat = new DatDatabase(o => {
                o.FilePath = datPath;
                o.AccessType = DatAccessType.Read;
                o.IndexCachingStrategy = IndexCachingStrategy.Never;
            });

            int checkedScenes = 0, checkedObjects = 0;
            foreach (var id in dat.GetAllIdsOfType<SceneObj>()) {
                Assert.True(dat.TryGet<SceneObj>(id, out var scene) && scene != null);
                var doc = CommandEngine.SceneToJsonDoc(scene!, id);
                Assert.Equal(scene!.Objects.Count, doc.Objects.Count);
                for (int i = 0; i < scene.Objects.Count; i++) {
                    var o = scene.Objects[i];
                    var j = doc.Objects[i];
                    Assert.Equal($"0x{o.ObjectId:X8}", j.ObjectId);
                    Assert.Equal(o.BaseLoc.Origin.X, j.Origin[0]);
                    Assert.Equal(o.BaseLoc.Origin.Y, j.Origin[1]);
                    Assert.Equal(o.BaseLoc.Origin.Z, j.Origin[2]);
                    Assert.Equal(o.BaseLoc.Orientation.W, j.Orientation[0]);
                    Assert.Equal(o.BaseLoc.Orientation.X, j.Orientation[1]);
                    Assert.Equal(o.BaseLoc.Orientation.Y, j.Orientation[2]);
                    Assert.Equal(o.BaseLoc.Orientation.Z, j.Orientation[3]);
                    Assert.Equal(o.Frequency, j.Frequency);
                    Assert.Equal(o.DisplaceX, j.DisplaceX);
                    Assert.Equal(o.DisplaceY, j.DisplaceY);
                    Assert.Equal(o.MinScale, j.MinScale);
                    Assert.Equal(o.MaxScale, j.MaxScale);
                    Assert.Equal(o.MaxRotation, j.MaxRotation);
                    Assert.Equal(o.MinSlope, j.MinSlope);
                    Assert.Equal(o.MaxSlope, j.MaxSlope);
                    Assert.Equal(o.Align, j.Align);
                    Assert.Equal(o.Orient, j.Orient);
                    Assert.Equal($"0x{o.WeenieObj:X8}", j.WeenieObj);
                    checkedObjects++;
                }
                checkedScenes++;
            }

            Assert.True(checkedScenes > 100, $"only {checkedScenes} scenes in retail portal — enumeration broken?");
            Assert.True(checkedObjects > 1000, $"only {checkedObjects} objects mapped");
        }
    }
}
