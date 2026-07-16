// vendored from /mnt/wbterminal1/ac-refs/rynthsuite/Shared/RynthCore.TerrainData/LandblockData.cs @ bf1fb52 on 2026-07-16; upstream is read-only reference
using System;
using System.IO;

namespace RynthCore.Plugin.RynthAi.Raycasting
{
    /// <summary>
    /// Parsed CellLandblock (0xXXYYFFFF) — terrain heightmap and terrain-type words for one 192×192 m landblock.
    ///
    /// File layout (cell.dat 0xXXYYFFFF):
    ///   uint   Id              (0xXXYYFFFF)
    ///   uint   HasObjects      (nonzero if matching 0xXXYYFFFE LandblockInfo exists)
    ///   ushort Terrain[81]     9×9 grid, (terrainType &lt;&lt; 2 | roadMask) | (sceneType &lt;&lt; 11)
    ///   byte   Height[81]      9×9 grid, indices into RegionDesc.LandHeightTable
    ///
    /// Vertex indexing: idx = ix * 9 + iy, where ix = 0..8 (west→east) and iy = 0..8 (south→north).
    /// </summary>
    public class LandblockData
    {
        public const int VertexDim = 9;
        public const int BlockSide = 8;
        public const float CellLength = 24.0f;
        public const float BlockLength = 192.0f;

        public uint LandblockKey { get; private set; }
        public bool HasObjects { get; private set; }

        /// <summary>81 terrain words, row-major (ix, iy) via idx = ix*9 + iy.</summary>
        public ushort[] TerrainWords { get; private set; }

        /// <summary>81 raw height indices (into LandHeightTable).</summary>
        public byte[] HeightIndices { get; private set; }

        /// <summary>Decoded world-space Z for every vertex. Indexed as HeightsZ[ix, iy].</summary>
        public float[,] HeightsZ { get; private set; }

        /// <summary>World-space X of vertex (0, 0) — the SW corner of the landblock.</summary>
        public float WorldOriginX { get; private set; }

        /// <summary>World-space Y of vertex (0, 0) — the SW corner of the landblock.</summary>
        public float WorldOriginY { get; private set; }

        /// <summary>
        /// Loads and parses the 0xXXYYFFFF CellLandblock for the given landblock key.
        /// Returns null if the file is missing, too short, or the height table hasn't been loaded yet.
        /// </summary>
        public static LandblockData Load(DatDatabase cellDat, uint landblockKey, float[] landHeightTable)
        {
            if (cellDat == null || landHeightTable == null) return null;

            uint cellId = (landblockKey << 16) | 0xFFFF;
            byte[] data = cellDat.GetFileData(cellId);
            // 4 (Id) + 4 (HasObjects) + 81*2 (terrain) + 81 (heights) = 251
            if (data == null || data.Length < 251) return null;

            var terrain = new ushort[81];
            var heights = new byte[81];
            bool hasObjects;

            try
            {
                using (var ms = new MemoryStream(data))
                using (var reader = new BinaryReader(ms))
                {
                    reader.ReadUInt32();                          // Id
                    hasObjects = reader.ReadUInt32() != 0;        // HasObjects
                    for (int i = 0; i < 81; i++)
                        terrain[i] = reader.ReadUInt16();
                    for (int i = 0; i < 81; i++)
                        heights[i] = reader.ReadByte();
                }
            }
            catch
            {
                return null;
            }

            var heightsZ = new float[VertexDim, VertexDim];
            for (int ix = 0; ix < VertexDim; ix++)
            {
                for (int iy = 0; iy < VertexDim; iy++)
                {
                    byte h = heights[ix * VertexDim + iy];
                    heightsZ[ix, iy] = h < landHeightTable.Length ? landHeightTable[h] : 0f;
                }
            }

            float originX = ((landblockKey >> 8) & 0xFF) * BlockLength;
            float originY = (landblockKey & 0xFF) * BlockLength;

            return new LandblockData
            {
                LandblockKey = landblockKey,
                HasObjects = hasObjects,
                TerrainWords = terrain,
                HeightIndices = heights,
                HeightsZ = heightsZ,
                WorldOriginX = originX,
                WorldOriginY = originY,
            };
        }

        /// <summary>
        /// Z of the nearest grid vertex for a local position in [0, 192) on each axis.
        /// Coords outside the landblock are clamped to the edge.
        /// </summary>
        public float GetNearestVertexHeightLocal(float lx, float ly)
        {
            int ix = (int)Math.Round(lx / CellLength);
            int iy = (int)Math.Round(ly / CellLength);
            if (ix < 0) ix = 0; else if (ix > BlockSide) ix = BlockSide;
            if (iy < 0) iy = 0; else if (iy > BlockSide) iy = BlockSide;
            return HeightsZ[ix, iy];
        }

        /// <summary>
        /// Z of the nearest grid vertex at a world-space (X, Y). Returns NaN if (X, Y) is not inside this landblock.
        /// </summary>
        public float GetNearestVertexHeightWorld(float worldX, float worldY)
        {
            float lx = worldX - WorldOriginX;
            float ly = worldY - WorldOriginY;
            if (lx < 0f || ly < 0f || lx >= BlockLength || ly >= BlockLength)
                return float.NaN;
            return GetNearestVertexHeightLocal(lx, ly);
        }

        /// <summary>Min and max decoded vertex Z across the whole landblock.</summary>
        public void GetHeightRange(out float min, out float max)
        {
            min = float.PositiveInfinity;
            max = float.NegativeInfinity;
            for (int ix = 0; ix < VertexDim; ix++)
            {
                for (int iy = 0; iy < VertexDim; iy++)
                {
                    float z = HeightsZ[ix, iy];
                    if (z < min) min = z;
                    if (z > max) max = z;
                }
            }
        }

        /// <summary>Convenience: vertex Z at integer grid coords (0..8, 0..8).</summary>
        public float GetVertexZ(int ix, int iy)
        {
            if ((uint)ix > BlockSide || (uint)iy > BlockSide) return 0f;
            return HeightsZ[ix, iy];
        }

        // ===================================================================
        // Triangle-exact terrain Z
        //
        // Each 24 m cell is split by the SW→NE diagonal into two triangles
        // (matching the fixed split ScatterSystem uses for passability checks):
        //   SE triangle (below diagonal, fy ≤ fx): SW, SE, NE
        //   NW triangle (above diagonal, fy > fx): SW, NE, NW
        // AC's client uses a per-cell PRNG to pick between SE/NW and NE/SW diagonals;
        // we don't hash yet, so expect a few cm of divergence from the client's exact Z
        // in cells where the PRNG would have picked NE/SW.
        // ===================================================================

        /// <summary>
        /// Plane-interpolated Z at a landblock-local (lx, ly) ∈ [0, 192]². Clamps to the interior.
        /// </summary>
        public float GetTerrainZLocal(float lx, float ly)
        {
            if (lx < 0f) lx = 0f; else if (lx > BlockLength) lx = BlockLength;
            if (ly < 0f) ly = 0f; else if (ly > BlockLength) ly = BlockLength;

            int cx = (int)(lx / CellLength);
            int cy = (int)(ly / CellLength);
            if (cx >= BlockSide) cx = BlockSide - 1;
            if (cy >= BlockSide) cy = BlockSide - 1;

            float fx = lx - cx * CellLength;
            float fy = ly - cy * CellLength;
            float u = fx / CellLength;
            float v = fy / CellLength;

            float hSW = HeightsZ[cx,     cy];
            float hSE = HeightsZ[cx + 1, cy];
            float hNW = HeightsZ[cx,     cy + 1];
            float hNE = HeightsZ[cx + 1, cy + 1];

            if (fy <= fx)
                return hSW + u * (hSE - hSW) + v * (hNE - hSE);
            return hSW + v * (hNW - hSW) - u * (hNW - hNE);
        }

        /// <summary>
        /// Plane-interpolated Z at a world (X, Y). NaN if (X, Y) is not in this landblock.
        /// </summary>
        public float GetTerrainZWorld(float worldX, float worldY)
        {
            float lx = worldX - WorldOriginX;
            float ly = worldY - WorldOriginY;
            if (lx < 0f || ly < 0f || lx >= BlockLength || ly >= BlockLength)
                return float.NaN;
            return GetTerrainZLocal(lx, ly);
        }

        // ===================================================================
        // Landscape raycast (per landblock)
        // ===================================================================

        /// <summary>
        /// Ray vs. terrain-mesh test inside this landblock. <paramref name="localOrigin"/> is in
        /// landblock-local XY (world – <see cref="WorldOriginX"/>/<see cref="WorldOriginY"/>; Z unchanged).
        /// Walks the 8×8 cell grid via 2D DDA, tests both triangles per cell with Möller-Trumbore.
        /// Returns the nearest hit within <paramref name="maxDist"/>; <paramref name="hitNormal"/>
        /// is the unit upward-facing normal of the triangle hit.
        /// </summary>
        public bool RaycastTerrainLocal(Vector3 localOrigin, Vector3 dir, float maxDist,
            out float hitDist, out Vector3 hitNormal)
        {
            hitDist = 0f;
            hitNormal = Vector3.Zero;

            float px = localOrigin.X;
            float py = localOrigin.Y;
            float vx = dir.X;
            float vy = dir.Y;

            int cx = (int)Math.Floor(px / CellLength);
            int cy = (int)Math.Floor(py / CellLength);
            if (cx < 0) cx = 0; else if (cx > BlockSide - 1) cx = BlockSide - 1;
            if (cy < 0) cy = 0; else if (cy > BlockSide - 1) cy = BlockSide - 1;

            int stepX = vx > 0 ? 1 : (vx < 0 ? -1 : 0);
            int stepY = vy > 0 ? 1 : (vy < 0 ? -1 : 0);

            float tMaxX = float.PositiveInfinity, tDeltaX = float.PositiveInfinity;
            float tMaxY = float.PositiveInfinity, tDeltaY = float.PositiveInfinity;
            if (stepX != 0)
            {
                float nextX = (stepX > 0 ? (cx + 1) : cx) * CellLength;
                tMaxX = (nextX - px) / vx;
                tDeltaX = CellLength / Math.Abs(vx);
            }
            if (stepY != 0)
            {
                float nextY = (stepY > 0 ? (cy + 1) : cy) * CellLength;
                tMaxY = (nextY - py) / vy;
                tDeltaY = CellLength / Math.Abs(vy);
            }

            float bestT = maxDist;
            Vector3 bestNormal = Vector3.Zero;
            bool found = false;

            // Enough steps to traverse the block diagonally plus a small safety margin.
            int iterLimit = BlockSide * 2 + 4;

            while (iterLimit-- > 0)
            {
                if (cx < 0 || cy < 0 || cx >= BlockSide || cy >= BlockSide)
                    break;

                float x0 = cx * CellLength, x1 = x0 + CellLength;
                float y0 = cy * CellLength, y1 = y0 + CellLength;
                Vector3 vSW = new Vector3(x0, y0, HeightsZ[cx,     cy]);
                Vector3 vSE = new Vector3(x1, y0, HeightsZ[cx + 1, cy]);
                Vector3 vNE = new Vector3(x1, y1, HeightsZ[cx + 1, cy + 1]);
                Vector3 vNW = new Vector3(x0, y1, HeightsZ[cx,     cy + 1]);

                if (RayTriangle(localOrigin, dir, vSW, vSE, vNE, out float tSE) && tSE < bestT)
                {
                    bestT = tSE;
                    bestNormal = TriangleUpNormal(vSW, vSE, vNE);
                    found = true;
                }
                if (RayTriangle(localOrigin, dir, vSW, vNE, vNW, out float tNW) && tNW < bestT)
                {
                    bestT = tNW;
                    bestNormal = TriangleUpNormal(vSW, vNE, vNW);
                    found = true;
                }

                float tNext = Math.Min(tMaxX, tMaxY);
                // If we already have a closer hit than the nearest cell boundary, we're done.
                if (found && tNext >= bestT) break;
                if (tNext > maxDist) break;
                if (stepX == 0 && stepY == 0) break; // vertical ray: single-cell only

                if (tMaxX < tMaxY)
                {
                    tMaxX += tDeltaX;
                    cx += stepX;
                }
                else
                {
                    tMaxY += tDeltaY;
                    cy += stepY;
                }
            }

            if (found)
            {
                hitDist = bestT;
                hitNormal = bestNormal;
                return true;
            }
            return false;
        }

        // Möller-Trumbore. Local copy to keep LandblockData self-contained
        // (BoundingVolume has the same routine privately).
        private static bool RayTriangle(Vector3 origin, Vector3 dir,
            Vector3 v0, Vector3 v1, Vector3 v2, out float t)
        {
            t = 0f;
            const float EPSILON = 1e-7f;
            Vector3 edge1 = v1 - v0;
            Vector3 edge2 = v2 - v0;
            Vector3 h = Vector3.Cross(dir, edge2);
            float a = Vector3.Dot(edge1, h);
            if (a > -EPSILON && a < EPSILON) return false;
            float f = 1f / a;
            Vector3 s = origin - v0;
            float u = f * Vector3.Dot(s, h);
            if (u < 0f || u > 1f) return false;
            Vector3 q = Vector3.Cross(s, edge1);
            float v = f * Vector3.Dot(dir, q);
            if (v < 0f || u + v > 1f) return false;
            t = f * Vector3.Dot(edge2, q);
            return t >= 0f;
        }

        private static Vector3 TriangleUpNormal(Vector3 a, Vector3 b, Vector3 c)
        {
            // Winding is chosen so this points up (+Z) — see LandblockData docs.
            Vector3 n = Vector3.Cross(b - a, c - a);
            return n.Normalize();
        }
    }
}
