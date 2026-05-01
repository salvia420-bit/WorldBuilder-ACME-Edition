using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Numerics;
using System.Text;

namespace WorldBuilder.Shared.Lib.WorldGen {
    /// <summary>
    /// Pure CSV emit + ACE @teleloc string builder for the WorldGenerator's output.
    /// Promoted from <c>LandscapeEditorViewModel.ExportTownsCsv</c> so the GUI button
    /// and the headless <c>export-towns-csv</c> command share one implementation.
    /// </summary>
    public static class TownsExporter {
        /// <summary>
        /// Centroid of buildings tagged with this town name; falls back to <c>town.WorldCenter</c>
        /// when the town has no recorded building anchors.
        /// </summary>
        public static Vector3 GetTownTelelocAnchor(TownSite town,
            IReadOnlyDictionary<ushort, List<PlannedBuilding>> placements) {
            var pts = new List<Vector3>();
            foreach (var list in placements.Values) {
                foreach (var pb in list) {
                    if (!string.Equals(pb.TownName, town.Name, StringComparison.Ordinal))
                        continue;
                    pts.Add(pb.WorldPosition);
                }
            }

            if (pts.Count == 0) return town.WorldCenter;

            float sx = 0f, sy = 0f, sz = 0f;
            foreach (var p in pts) { sx += p.X; sy += p.Y; sz += p.Z; }
            float n = pts.Count;
            return new Vector3(sx / n, sy / n, sz / n);
        }

        /// <summary>
        /// ACE / @teleloc outdoor format: full id = (landblockKey * 65536) | outdoorCellId,
        /// landblockKey = (lbX * 256) | lbY. Bracket coords are landblock-local X/Y and world Z.
        /// Outdoor cells use indices 1..64; clamped to inner cells 1..6 like the placement tool.
        /// </summary>
        public static (ushort landblockKey, ushort outdoorCell, string telelocLine) BuildAceTeleLoc(
            float worldX, float worldY, float worldZ) {
            int lbX = Math.Clamp((int)Math.Floor(worldX / 192f), 0, 254);
            int lbY = Math.Clamp((int)Math.Floor(worldY / 192f), 0, 254);
            float localX = worldX - lbX * 192f;
            float localY = worldY - lbY * 192f;

            int cellX = Math.Clamp((int)(localX / 24f), 1, 6);
            int cellY = Math.Clamp((int)(localY / 24f), 1, 6);
            ushort outdoorCell = (ushort)(cellX * 8 + cellY + 1);
            ushort lbKey = (ushort)((lbX << 8) | lbY);
            uint fullId = ((uint)lbKey << 16) | outdoorCell;

            string teleloc = string.Format(CultureInfo.InvariantCulture,
                "0x{0:X8} [{1:F6} {2:F6} {3:F6}] 1.000000 0.000000 0.000000 0.000000",
                fullId, localX, localY, worldZ);
            return (lbKey, outdoorCell, teleloc);
        }

        /// <summary>
        /// Renders the towns CSV to <paramref name="outPath"/>. Returns the line count
        /// (excluding the header). The byte-for-byte output matches the GUI's
        /// "Export Towns CSV" button.
        /// </summary>
        public static int Write(WorldGeneratorResult result, string outPath) {
            using var stream = File.Create(outPath);
            using var writer = new StreamWriter(stream, Encoding.UTF8);
            writer.WriteLine("Name,Size,Buildings,LandblockHex,OutdoorCellHex,TeleLoc");

            int rows = 0;
            foreach (var t in result.Towns) {
                var anchor = GetTownTelelocAnchor(t, result.BuildingPlacements);
                var (lbKey, cellHex, teleloc) = BuildAceTeleLoc(anchor.X, anchor.Y, anchor.Z);
                string escName = t.Name.Replace("\"", "\"\"", StringComparison.Ordinal);
                writer.WriteLine(
                    $"\"{escName}\",{t.SizeLabel},{t.BuildingCount},0x{lbKey:X4},0x{cellHex:X4},\"{teleloc}\"");
                rows++;
            }
            return rows;
        }
    }
}
