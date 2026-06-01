// scenery-cross-check
//
// Phase B.4 ground-truth probe. References ACE.DatLoader (the part of
// the ACE repo that has no live-DB dependency) and runs the EXACT
// algorithm from ~/ace-server/Source/ACE.Server/Entity/Scenery.cs
// against the canonical retail base DATs, emitting one JSONL per LB
// for direct comparison with the Rust `scenery-bake --mode ace-compat`
// output.
//
// The brief allows ports of ACE source where the live ACE.Server
// surface is too heavy to instantiate — `Scenery.Load` itself touches
// `ACE.Server.Physics.Common.LandblockMesh`, `ModelMesh`, `BoundingBox`,
// etc. None of those are needed for the *algorithm* — they're only
// needed for `Collision()`, which we deliberately SKIP here so the
// comparison isolates the PRNG + scene selection + displace/scale/rotate
// + Z-snap chain. Rust collision behaviour is the same in both modes,
// so any Rust-vs-ACE delta after this filter is necessarily algorithmic.
//
// Build/run:
//
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/tools/scenery-cross-check
//   ~/.dotnet/dotnet run -c Release -- \
//     --dat-dir /home/wbterminal/projects/RetailSmoke/dats/base \
//     --landblocks 0xA3AE..0xAFBA \
//     --out /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/ace-csharp-bake
//
// Output: one `0xXXXX.scenery.jsonl` per landblock in `--out`.
// JSONL is field-for-field identical layout to Rust scenery-bake,
// but **without the collision-reject filter** — so it's an
// "upper bound" on what the algorithm would emit. The diff script
// (`diff.sh` in this dir) computes ACE-only / Rust-only / matched
// at multiple float tolerances.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text;
using ACE.DatLoader;
using ACE.DatLoader.Entity;
using ACE.DatLoader.FileTypes;

namespace SceneryCrossCheck
{
    internal class Program
    {
        // Algorithm constants — verbatim from
        // ACE.Server.Entity.LandblockMesh.
        private const int CellDim = 8;
        private const int VertexDim = CellDim + 1;
        private const int LandblockSize = 192;
        private const int CellSize = LandblockSize / CellDim;

        // Phase-1 parity-hardening diagnostic: when --bits is set, emit each
        // f32 field as its raw IEEE-754 bits (decimal uint, -0 normalised to
        // +0) instead of F6, for exact bit-identity comparison against the
        // Rust `scenery-bake --bits` output.
        private static bool EmitBits = false;

        public static int Main(string[] args)
        {
            // ACE.DatLoader's BinaryReaderExtensions reads
            // ReadObfuscatedString via codepage 1252 (Latin-1 ish).
            // .NET Core / .NET 10 doesn't ship codepage 1252 unless
            // we register the CodePages encoding provider explicitly.
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

            string datDir = null;
            string lbSpec = null;
            string outDir = null;
            bool withCollision = false;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--dat-dir": datDir = args[++i]; break;
                    case "--landblocks": lbSpec = args[++i]; break;
                    case "--out": outDir = args[++i]; break;
                    case "--with-collision": withCollision = true; break;
                    case "--bits": EmitBits = true; break;
                    default:
                        Console.Error.WriteLine($"unknown arg `{args[i]}`");
                        return 2;
                }
            }
            if (datDir == null || lbSpec == null || outDir == null)
            {
                Console.Error.WriteLine(
                    "usage: scenery-cross-check --dat-dir <PATH> --landblocks <SPEC> --out <DIR> [--with-collision]");
                return 2;
            }

            // ACE DatManager.Initialize logs noisily through log4net.
            // Suppress by configuring log4net to NoOp before calling
            // Initialize (the DatManager static lookup of `log` runs
            // before Initialize so we can't actually silence it — but
            // it goes to log4net's null appender unless config is set,
            // which is fine for our use case).
            DatManager.Initialize(datDir, keepOpen: true, loadCell: true);
            if (DatManager.PortalDat == null)
            {
                Console.Error.WriteLine("PortalDat failed to load");
                return 3;
            }
            if (DatManager.CellDat == null)
            {
                Console.Error.WriteLine("CellDat failed to load");
                return 3;
            }
            var region = DatManager.PortalDat.ReadFromDat<RegionDesc>(0x13000000);

            var landblocks = ParseLandblockSpec(lbSpec);
            Console.Error.WriteLine(
                $"scenery-cross-check: {landblocks.Count} LBs, region=0x13000000, with-collision={withCollision}, out={outDir}");
            Directory.CreateDirectory(outDir);

            var meshCache = new MeshVertexCache();
            int total = 0;
            int skipped = 0;
            foreach (var lbKey in landblocks)
            {
                var cellId = ((uint)lbKey << 16) | 0xFFFF;
                CellLandblock cellLb;
                try
                {
                    cellLb = DatManager.CellDat.ReadFromDat<CellLandblock>(cellId);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  LB 0x{lbKey:X4}: skip (no CellLandblock): {ex.Message}");
                    skipped++;
                    continue;
                }
                var landblockId = (uint)lbKey << 16;

                // ACE's collision filter (Scenery.cs:83) tests scenery
                // candidates against `Entity.Landblock.Buildings`, which
                // `Entity.Landblock.LoadBuildings` populates exclusively
                // from `LandblockInfo.Buildings` (NOT `Objects`). So we
                // load the LBI here, walk Buildings only, and feed those
                // AABBs into the bake.
                var buildingBoxes = new List<BoundingBox2D>();
                if (withCollision)
                {
                    var infoId = ((uint)lbKey << 16) | 0xFFFE;
                    try
                    {
                        var info = DatManager.CellDat.ReadFromDat<LandblockInfo>(infoId);
                        foreach (var b in info.Buildings)
                        {
                            var bb = BuildBoxForPlacement(meshCache, b.ModelId, b.Frame,
                                cellX: 0, cellY: 0, scale: 1.0f);
                            if (bb.HasValue) buildingBoxes.Add(bb.Value);
                        }
                    }
                    catch
                    {
                        // No LBI for this LB → no buildings → no
                        // building-side collision rejections.
                    }
                }

                var placements = BakeLandblock(region, cellLb, landblockId,
                    withCollision, buildingBoxes, meshCache);
                WriteJsonl(Path.Combine(outDir, $"0x{lbKey:X4}.scenery.jsonl"), placements);
                total += placements.Count;
            }
            Console.Error.WriteLine($"scenery-cross-check: done, {total} placements emitted across {landblocks.Count - skipped} LBs ({skipped} skipped)");
            return 0;
        }

        private static List<ushort> ParseLandblockSpec(string spec)
        {
            spec = spec.Trim();
            if (spec.StartsWith('@'))
            {
                var path = spec.Substring(1);
                var lines = File.ReadAllLines(path);
                var v = new List<ushort>();
                foreach (var ln in lines)
                {
                    var t = ln.Trim();
                    if (string.IsNullOrEmpty(t) || t.StartsWith('#')) continue;
                    v.Add(ParseHexUshort(t));
                }
                return v;
            }
            if (spec.Contains(".."))
            {
                var parts = spec.Split("..", 2);
                var lo = ParseHexUshort(parts[0]);
                var hi = ParseHexUshort(parts[1]);
                var xlo = (lo >> 8) & 0xFF;
                var ylo = lo & 0xFF;
                var xhi = (hi >> 8) & 0xFF;
                var yhi = hi & 0xFF;
                if (xhi < xlo || yhi < ylo)
                    throw new ArgumentException("inverted rectangle");
                var v = new List<ushort>();
                for (int x = xlo; x <= xhi; x++)
                    for (int y = ylo; y <= yhi; y++)
                        v.Add((ushort)((x << 8) | y));
                return v;
            }
            return new List<ushort> { ParseHexUshort(spec) };
        }

        private static ushort ParseHexUshort(string s)
        {
            var t = s.Trim();
            if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                t = t.Substring(2);
            return ushort.Parse(t, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Verbatim port of ACE.Server.Entity.Scenery.Load.
        /// When <paramref name="withCollision"/> is true, also runs the
        /// Collision() rejection step against
        /// <paramref name="buildingBoxes"/> (the LB's Info.Buildings,
        /// transformed) and against previously-emitted scenery this LB.
        /// When false, this is the historical upper-bound mode.
        /// Returns one Placement per emitted scenery object.
        /// </summary>
        private static List<Placement> BakeLandblock(
            RegionDesc region,
            CellLandblock landblock,
            uint landblockId,
            bool withCollision,
            List<BoundingBox2D> buildingBoxes,
            MeshVertexCache meshCache)
        {
            var sceneryBoxes = withCollision ? new List<BoundingBox2D>() : null;
            var output = new List<Placement>();

            // Pre-resolve the 9x9 vertex height grid the same way
            // LandblockMesh.GetVertexHeights does.
            var heights = new float[VertexDim, VertexDim];
            for (int x = 0; x < VertexDim; x++)
                for (int y = 0; y < VertexDim; y++)
                    heights[x, y] = region.LandDefs.LandHeightTable[landblock.Height[x * VertexDim + y]];

            // Scenery.cs:21-22.
            uint blockX = (landblockId >> 24) * 8;
            uint blockY = ((landblockId >> 16) & 0xFF) * 8;

            for (int i = 0; i < landblock.Terrain.Count; i++)
            {
                int terrain = landblock.Terrain[i];
                int terrainType = (terrain >> 2) & 0x1F;
                int sceneType = terrain >> 11;

                if (terrainType < 0 || terrainType >= region.TerrainInfo.TerrainTypes.Count) continue;
                var tt = region.TerrainInfo.TerrainTypes[terrainType];
                if (sceneType < 0 || sceneType >= tt.SceneTypes.Count) continue;
                int sceneInfo = (int)tt.SceneTypes[sceneType];
                if (sceneInfo < 0 || sceneInfo >= region.SceneInfo.SceneTypes.Count) continue;
                var scenes = region.SceneInfo.SceneTypes[sceneInfo].Scenes;
                if (scenes.Count == 0) continue;

                int cellX = i / VertexDim;
                int cellY = i % VertexDim;

                uint globalCellX = (uint)(cellX + blockX);
                uint globalCellY = (uint)(cellY + blockY);

                // Scenery.cs:43-46.
                uint cellMat = globalCellY * (712977289 * globalCellX + 1813693831)
                               - 1109124029 * globalCellX
                               + 2139937281;
                double offset = cellMat * 2.3283064e-10;
                int sceneIdx = (int)(scenes.Count * offset);
                if (sceneIdx >= scenes.Count) sceneIdx = 0;

                uint sceneId = scenes[sceneIdx];
                Scene scene;
                try { scene = DatManager.PortalDat.ReadFromDat<Scene>(sceneId); }
                catch { continue; }

                // Scenery.cs:52-54.
                uint cellXMat = unchecked((uint)(-1109124029 * (long)globalCellX));
                uint cellYMat = 1813693831 * globalCellY;
                cellMat = 1360117743 * globalCellX * globalCellY + 1888038839;

                for (uint j = 0; j < scene.Objects.Count; j++)
                {
                    var obj = scene.Objects[(int)j];
                    double noise = unchecked((uint)(cellXMat + cellYMat - cellMat * 23399)) * 2.3283064e-10;

                    if (noise < obj.Freq && obj.WeenieObj == 0)
                    {
                        var disp = Displace(obj, globalCellX, globalCellY, j);
                        float lx = cellX * CellSize + disp.X;
                        float ly = cellY * CellSize + disp.Y;

                        // Scenery.cs:69 has `TODO: ensure walkable slope`
                        // — ACE has it as a TODO so we DON'T enforce.

                        if (lx < 0 || ly < 0 || lx > LandblockSize || ly > LandblockSize)
                            continue;
                        if (OnRoad(landblock, lx, ly)) continue;

                        // GetZ — LandblockMesh.GetZ triangle-plane path.
                        float z = GetZ(heights, (ushort)(landblockId >> 16), lx, ly);
                        float rot = RotateObj(obj, globalCellX, globalCellY, j);
                        float scale = ScaleObj(obj, globalCellX, globalCellY, j);
                        // Use the ACTUAL ACE rotation builder (Scenery.cs:77),
                        // not a hand-rolled f64 Math.Cos/Sin. .NET's
                        // CreateFromYawPitchRoll uses MathF (f32) sin/cos, so a
                        // double hand-roll diverges from real ACE by ~1 ULP on
                        // ~10% of placements. This makes the oracle faithful.
                        var rotQuat = Quaternion.CreateFromYawPitchRoll(0f, 0f, rot);
                        float qw = rotQuat.W;
                        float qz = rotQuat.Z;

                        // Collision: ACE Scenery.cs:80-84 builds a
                        // ModelMesh, computes BoundingBox.BuildBox (over
                        // transformed mesh vertices, XY axis-aligned),
                        // then rejects if it Intersect2D's any building
                        // or any previously-emitted scenery this LB.
                        // Skip the candidate when withCollision and a hit.
                        if (withCollision)
                        {
                            var rotQ = new Quaternion(0f, 0f, qz, qw);
                            // ACE's Scenery.Load uses Position=(disp.X, disp.Y, z)
                            // and Cell=(cellX, cellY); the transform stack in
                            // BoundingBox.GetTransform combines them as
                            // cellTranslate*(cellX*24, cellY*24, 0) +
                            // cellTranslateInner*(Position.X, Position.Y, Position.Z).
                            // So we pass the displaced (disp.X, disp.Y) as
                            // inner translation alongside cellX/cellY.
                            var candBox = BuildBoxForScenery(
                                meshCache, obj.ObjId,
                                innerX: disp.X, innerY: disp.Y, innerZ: z,
                                cellX: cellX, cellY: cellY,
                                rotation: rotQ, scale: scale);
                            if (!candBox.HasValue) continue;
                            if (Intersect2DAny(candBox.Value, buildingBoxes)) continue;
                            if (Intersect2DAny(candBox.Value, sceneryBoxes)) continue;
                            sceneryBoxes.Add(candBox.Value);
                        }

                        output.Add(new Placement
                        {
                            ObjId = obj.ObjId,
                            X = lx, Y = ly, Z = z,
                            Qw = qw, Qx = 0f, Qy = 0f, Qz = qz,
                            Scale = scale,
                            SourceCellX = (uint)cellX,
                            SourceCellY = (uint)cellY,
                            SourceObjIdx = j,
                        });
                    }
                }
            }
            return output;
        }

        // Verbatim ACE Scenery.cs:101-127 Displace.
        private static Vector2 Displace(ObjectDesc obj, uint ix, uint iy, uint iq)
        {
            float x, y;
            var loc = obj.BaseLoc.Origin;

            if (obj.DisplaceX <= 0) x = loc.X;
            else x = (float)((1813693831 * iy - (iq + 45773) * (1360117743 * iy * ix + 1888038839) - 1109124029 * ix)
                * 2.3283064e-10 * obj.DisplaceX + loc.X);

            if (obj.DisplaceY <= 0) y = loc.Y;
            else y = (float)((1813693831 * iy - (iq + 72719) * (1360117743 * iy * ix + 1888038839) - 1109124029 * ix)
                * 2.3283064e-10 * obj.DisplaceY + loc.Y);

            double quadrant = (1813693831 * iy - ix * (1870387557 * iy + 1109124029) - 402451965) * 2.3283064e-10;

            if (quadrant >= 0.75) return new Vector2(y, -x);
            if (quadrant >= 0.50) return new Vector2(-x, -y);
            if (quadrant >= 0.25) return new Vector2(-y, x);
            return new Vector2(x, y);
        }

        // Verbatim ACE Scenery.cs:136-150 ScaleObj.
        private static float ScaleObj(ObjectDesc obj, uint x, uint y, uint k)
        {
            float minScale = obj.MinScale;
            float maxScale = obj.MaxScale;
            if (minScale == maxScale) return maxScale;
            return (float)(Math.Pow(maxScale / minScale,
                (1813693831 * y - (k + 32593) * (1360117743 * y * x + 1888038839) - 1109124029 * x) * 2.3283064e-10)
                * minScale);
        }

        // Verbatim ACE Scenery.cs:155-161 RotateObj.
        private static float RotateObj(ObjectDesc obj, uint x, uint y, uint k)
        {
            if (obj.MaxRotation <= 0.0f) return 0.0f;
            return (float)((1813693831 * y - (k + 63127) * (1360117743 * y * x + 1888038839) - 1109124029 * x)
                * 2.3283064e-10 * obj.MaxRotation * 0.0174533f);
        }

        // Verbatim ACE Scenery.cs:166-172 OnRoad (with documented
        // off-by-one mirror: uses `cellX * CellDim + cellY`).
        private static bool OnRoad(CellLandblock landblock, float x, float y)
        {
            int cellX = (int)Math.Floor(x / CellSize);
            int cellY = (int)Math.Floor(y / CellSize);
            if (cellX < 0 || cellY < 0) return false;
            int idx = cellX * CellDim + cellY;
            if (idx < 0 || idx >= landblock.Terrain.Count) return false;
            return (landblock.Terrain[idx] & 0x3) != 0;
        }

        // Verbatim port of LandblockMesh.GetZ — triangle-plane Z at
        // (x, y) given the 9x9 vertex heights + LB id (for GetSplitDir).
        private static float GetZ(float[,] heights, ushort landblockIdTop16, float lx, float ly)
        {
            int cellX = (int)Math.Floor(lx / CellSize);
            int cellY = (int)Math.Floor(ly / CellSize);
            if (cellX < 0) cellX = 0;
            if (cellY < 0) cellY = 0;
            if (cellX >= CellDim) cellX = CellDim - 1;
            if (cellY >= CellDim) cellY = CellDim - 1;

            var ll = new Vector3(cellX * CellSize,     cellY * CellSize,     heights[cellX,     cellY    ]);
            var lr = new Vector3((cellX + 1) * CellSize, cellY * CellSize,   heights[cellX + 1, cellY    ]);
            var tl = new Vector3(cellX * CellSize,     (cellY + 1) * CellSize, heights[cellX,     cellY + 1]);
            var tr = new Vector3((cellX + 1) * CellSize, (cellY + 1) * CellSize, heights[cellX + 1, cellY + 1]);

            // BuildTriangles per cell.
            Vector3 t0a, t0b, t0c, t1a, t1b, t1c;
            if (GetSplitDir(landblockIdTop16, cellX, cellY))
            {
                t0a = tl; t0b = lr; t0c = ll;
                t1a = tl; t1b = tr; t1c = lr;
            }
            else
            {
                t0a = tr; t0b = lr; t0c = ll;
                t1a = tr; t1b = ll; t1c = tl;
            }

            if (TriangleContains(t0a, t0b, t0c, lx, ly))
                return PlaneZ(t0a, t0b, t0c, lx, ly);
            return PlaneZ(t1a, t1b, t1c, lx, ly);
        }

        private static bool GetSplitDir(ushort landblockIdTop16, int cellX, int cellY)
        {
            int lbX = (landblockIdTop16 >> 8) & 0xFF;
            int lbY = landblockIdTop16 & 0xFF;
            int x = lbX * 8 + cellX;
            int y = lbY * 8 + cellY;
            int dw = x * y * 0x0CCAC033 - x * 0x421BE3BD + y * 0x6C1AC587 - 0x519B8F25;
            return (dw & unchecked((int)0x80000000)) == 0;
        }

        private static bool TriangleContains(Vector3 p1, Vector3 p2, Vector3 p3, float px, float py)
        {
            float area = 0.5f * (-p2.Y * p3.X + p1.Y * (-p2.X + p3.X) + p1.X * (p2.Y - p3.Y) + p2.X * p3.Y);
            if (area == 0) return false;
            float s = 1.0f / (2 * area) * (p1.Y * p3.X - p1.X * p3.Y + (p3.Y - p1.Y) * px + (p1.X - p3.X) * py);
            if (s < 0) return false;
            float t = 1.0f / (2 * area) * (p1.X * p2.Y - p1.Y * p2.X + (p1.Y - p2.Y) * px + (p2.X - p1.X) * py);
            if (t < 0 || 1 - s - t < 0) return false;
            return true;
        }

        private static float PlaneZ(Vector3 p1, Vector3 p2, Vector3 p3, float px, float py)
        {
            Vector3 v1 = new Vector3(p1.X - p3.X, p1.Y - p3.Y, p1.Z - p3.Z);
            Vector3 v2 = new Vector3(p2.X - p3.X, p2.Y - p3.Y, p2.Z - p3.Z);
            Vector3 abc = new Vector3(
                v1.Y * v2.Z - v1.Z * v2.Y,
                v1.Z * v2.X - v1.X * v2.Z,
                v1.X * v2.Y - v1.Y * v2.X);
            float d = abc.X * p3.X + abc.Y * p3.Y + abc.Z * p3.Z;
            return (d - abc.X * px - abc.Y * py) / abc.Z;
        }

        private static void WriteJsonl(string path, List<Placement> placements)
        {
            using var sw = new StreamWriter(path);
            foreach (var p in placements)
            {
                sw.WriteLine(p.ToJsonLine());
            }
        }

        private struct Placement
        {
            public uint ObjId;
            public float X, Y, Z;
            public float Qw, Qx, Qy, Qz;
            public float Scale;
            public uint SourceCellX, SourceCellY, SourceObjIdx;

            public string ToJsonLine()
            {
                // Field-for-field match to Rust scenery-bake's
                // write_placement_line. Format: `{:.6}` everywhere.
                // Normalise -0 to 0 to match Rust's format_f32_six_sig.
                static string F(float v)
                {
                    float n = (v == 0.0f ? 0.0f : v);
                    // Phase-1 diagnostic: raw IEEE-754 bits (decimal uint) for
                    // exact bit-identity vs Rust `scenery-bake --bits`.
                    return Program.EmitBits
                        ? System.BitConverter.SingleToUInt32Bits(n).ToString(CultureInfo.InvariantCulture)
                        : n.ToString("F6", CultureInfo.InvariantCulture);
                }
                return string.Format(CultureInfo.InvariantCulture,
                    "{{\"obj_id\":\"0x{0:X8}\",\"x\":{1},\"y\":{2},\"z\":{3},\"qw\":{4},\"qx\":{5},\"qy\":{6},\"qz\":{7},\"scale\":{8},\"source_cell_x\":{9},\"source_cell_y\":{10},\"source_obj_idx\":{11}}}",
                    ObjId, F(X), F(Y), F(Z), F(Qw), F(Qx), F(Qy), F(Qz), F(Scale),
                    SourceCellX, SourceCellY, SourceObjIdx);
            }
        }

        // =====================================================================
        // Collision-mode plumbing — ACE BoundingBox.BuildBox + Intersect2D port
        // =====================================================================
        //
        // Why we port instead of referencing ACE.Server: ACE.Server drags in
        // MySqlConnector, log4net, Lifestoned, etc. The 80 lines of geometry
        // we actually need (BuildBox, Intersect2D, the transform stack) are
        // self-contained — porting them is a smaller blast radius than
        // pulling the whole server crate.
        //
        // Fidelity: the bake gets vertices straight from ACE.DatLoader
        // (`GfxObj.VertexArray.Vertices.Values.Origin`) so vertex data is
        // canonical. The transform stack matches
        // `ACE.Server.Physics.BoundingBox.GetTransform`
        // (scale * rotate * cellTranslate * cellTranslateInner) verbatim.
        // `Intersect2D` is the same `Min.X<=B.Max.X && Max.X>=B.Min.X && ...`
        // axis-aligned overlap test.
        //
        // Known caveat — multi-part Setup placement frames: ACE's BuildBox
        // walks each GfxObj part as if rooted at the model origin, without
        // applying `SetupModel.PlacementFrames[default].AnimFrame.Frames[i]`.
        // We mirror that behavior so the AABB matches ACE bit-for-bit, even
        // though it's a "Setup-bug-faithfulness" (multi-part scenery models
        // typically have one big part and many small attached parts; for
        // collision purposes the rooted union is close enough to the union
        // of properly-placed parts that real-world deltas are rare).

        private readonly struct BoundingBox2D
        {
            public readonly float MinX, MinY, MaxX, MaxY;
            public BoundingBox2D(float minX, float minY, float maxX, float maxY)
            { MinX = minX; MinY = minY; MaxX = maxX; MaxY = maxY; }
        }

        private static bool Intersect2D(BoundingBox2D a, BoundingBox2D b)
        {
            return a.MinX <= b.MaxX && a.MaxX >= b.MinX
                && a.MinY <= b.MaxY && a.MaxY >= b.MinY;
        }

        private static bool Intersect2DAny(BoundingBox2D cand, List<BoundingBox2D> others)
        {
            if (others == null) return false;
            for (int i = 0; i < others.Count; i++)
            {
                if (Intersect2D(cand, others[i])) return true;
            }
            return false;
        }

        /// <summary>
        /// Vertex-list cache: modelId → flat list of mesh-local vertex Vector3s.
        /// SetupModel (0x02) walks Parts (each is a GfxObj id) and concatenates;
        /// GfxObj (0x01) is loaded directly. Returns null + caches null on any
        /// failure so retry attempts don't re-throw.
        /// </summary>
        private sealed class MeshVertexCache
        {
            private readonly Dictionary<uint, List<Vector3>> _cache = new();

            public List<Vector3> Get(uint modelId)
            {
                if (_cache.TryGetValue(modelId, out var cached)) return cached;
                List<Vector3> vs = null;
                try
                {
                    uint kind = modelId >> 24;
                    vs = new List<Vector3>();
                    if (kind == 0x01)
                    {
                        var gfx = DatManager.PortalDat.ReadFromDat<GfxObj>(modelId);
                        foreach (var v in gfx.VertexArray.Vertices.Values)
                            vs.Add(v.Origin);
                    }
                    else if (kind == 0x02)
                    {
                        var setup = DatManager.PortalDat.ReadFromDat<SetupModel>(modelId);
                        foreach (var part in setup.Parts)
                        {
                            var gfx = DatManager.PortalDat.ReadFromDat<GfxObj>(part);
                            foreach (var v in gfx.VertexArray.Vertices.Values)
                                vs.Add(v.Origin);
                        }
                    }
                    else
                    {
                        vs = null;
                    }
                }
                catch
                {
                    vs = null;
                }
                _cache[modelId] = vs;
                return vs;
            }
        }

        /// <summary>
        /// Build the XY AABB of a placement's transformed mesh vertices.
        /// Mirrors ACE BoundingBox.BuildBox + GetTransform exactly:
        ///   transform = scale * rotate * cellTranslate * cellTranslateInner
        /// where cellTranslate = (cellX * 24, cellY * 24, 0) and
        /// cellTranslateInner = (innerX, innerY, innerZ).
        /// Returns null if the mesh can't be loaded (caller skips).
        /// </summary>
        private static BoundingBox2D? BuildBoxForScenery(
            MeshVertexCache cache, uint modelId,
            float innerX, float innerY, float innerZ,
            int cellX, int cellY,
            Quaternion rotation, float scale)
        {
            var vs = cache.Get(modelId);
            if (vs == null || vs.Count == 0) return null;
            var mScale = Matrix4x4.CreateScale(scale);
            var mRot = Matrix4x4.CreateFromQuaternion(rotation);
            var mCell = Matrix4x4.CreateTranslation(cellX * (float)CellSize, cellY * (float)CellSize, 0);
            var mInner = Matrix4x4.CreateTranslation(innerX, innerY, innerZ);
            var t = mScale * mRot * mCell * mInner;
            float minX = float.MaxValue, minY = float.MaxValue;
            float maxX = float.MinValue, maxY = float.MinValue;
            foreach (var v in vs)
            {
                var w = Vector3.Transform(v, t);
                if (w.X < minX) minX = w.X;
                if (w.Y < minY) minY = w.Y;
                if (w.X > maxX) maxX = w.X;
                if (w.Y > maxY) maxY = w.Y;
            }
            return new BoundingBox2D(minX, minY, maxX, maxY);
        }

        /// <summary>
        /// Build a placement AABB for a BuildInfo or generic Frame. For
        /// buildings the cell offset is zero and the frame's origin acts
        /// as the inner translation (ACE creates these via `new ModelMesh(modelId,
        /// frame)` so Position = Frame.Origin, Cell = Vector2.Zero, Scale = 1).
        /// </summary>
        private static BoundingBox2D? BuildBoxForPlacement(
            MeshVertexCache cache, uint modelId, Frame frame,
            int cellX, int cellY, float scale)
        {
            return BuildBoxForScenery(cache, modelId,
                innerX: frame.Origin.X, innerY: frame.Origin.Y, innerZ: frame.Origin.Z,
                cellX: cellX, cellY: cellY,
                rotation: frame.Orientation, scale: scale);
        }
    }
}
