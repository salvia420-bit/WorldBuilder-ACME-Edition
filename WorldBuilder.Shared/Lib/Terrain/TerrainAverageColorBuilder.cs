using System;
using System.Collections.Generic;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;

namespace WorldBuilder.Shared.Lib.Terrain {
    /// <summary>
    /// Pure-logic computation of the average RGB color of each terrain texture.
    /// The same dictionary is consumed by both the GUI heightmap importer and
    /// the headless `import-heightmap` command, so the two surfaces produce
    /// identical FindClosestTerrainType matches against the same project DAT.
    /// </summary>
    public static class TerrainAverageColorBuilder {
        private const uint REGION_ID = 0x13000000;

        public static Dictionary<TerrainTextureType, (byte R, byte G, byte B)> Build(IDatReaderWriter dats) {
            var result = new Dictionary<TerrainTextureType, (byte, byte, byte)>();
            if (!dats.TryGet<Region>(REGION_ID, out var region)) return result;

            var terrainDesc = region.TerrainInfo?.LandSurfaces?.TexMerge?.TerrainDesc;
            if (terrainDesc == null) return result;

            var buffer = new byte[512 * 512 * 4];
            const int pixelCount = 512 * 512;

            foreach (var td in terrainDesc) {
                if (td.TerrainType == TerrainTextureType.RoadType) continue;

                try {
                    if (!dats.TryGet<SurfaceTexture>(td.TerrainTex.TextureId, out var st)) continue;
                    if (st.Textures == null || st.Textures.Count == 0) continue;
                    if (!dats.TryGet<RenderSurface>(st.Textures[^1], out var rs)) continue;
                    if (rs.Width != 512 || rs.Height != 512) continue;
                    if (rs.SourceData == null || rs.SourceData.Length < pixelCount * 4) continue;

                    GetReversedRGBA(rs.SourceData.AsSpan(), buffer.AsSpan());

                    long totalR = 0, totalG = 0, totalB = 0;
                    for (int i = 0; i < pixelCount; i++) {
                        totalR += buffer[i * 4];
                        totalG += buffer[i * 4 + 1];
                        totalB += buffer[i * 4 + 2];
                    }

                    result[td.TerrainType] = (
                        (byte)(totalR / pixelCount),
                        (byte)(totalG / pixelCount),
                        (byte)(totalB / pixelCount));
                }
                catch {
                    // Skip textures that fail to load; matches GUI behavior.
                }
            }

            return result;
        }

        private static void GetReversedRGBA(Span<byte> sourceData, Span<byte> data) {
            for (int i = 0; i < sourceData.Length / 4; i++) {
                data[i * 4] = sourceData[i * 4 + 2];
                data[i * 4 + 1] = sourceData[i * 4 + 1];
                data[i * 4 + 2] = sourceData[i * 4 + 0];
                data[i * 4 + 3] = sourceData[i * 4 + 3];
            }
        }
    }
}
