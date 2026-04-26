using Microsoft.Extensions.Logging.Abstractions;
using System.Collections.Concurrent;
using System.Numerics;
using System.Reflection;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Lib.Pairings;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Tests;

public class ValidationEngineTests {
    [Fact]
    public void ValidateTerrain_DefaultThreshold_FlagsSmallHeightDelta() {
        var terrainDoc = CreateTerrainDocument(CreateTerrainEntries((x, y) => x == 1 && y == 0 ? (byte)20 : (byte)0));

        var report = ValidationEngine.ValidateTerrain(terrainDoc, 0x0101, CreateHeightTable());

        Assert.Contains(report.Diagnostics, d => d.Code == "TRN002");
    }

    [Fact]
    public void ValidateTerrain_ExplicitThreshold_AllowsSameDeltaWhenRequested() {
        var terrainDoc = CreateTerrainDocument(CreateTerrainEntries((x, y) => x == 1 && y == 0 ? (byte)20 : (byte)0));

        var report = ValidationEngine.ValidateTerrain(terrainDoc, 0x0101, CreateHeightTable(), cliffThreshold: 25f);

        Assert.DoesNotContain(report.Diagnostics, d => d.Code == "TRN002");
    }

    // ─────────────────────────── Footprint extraction ───────────────────────────

    [Fact]
    public void FootprintExtractor_AxisAlignedBox_ClassifiedAsRectangle() {
        var verts = BoxVertices(width: 6f, depth: 4f, height: 5f, basementDepth: 0f);
        var fp = FootprintExtractor.FromVertices(verts);
        Assert.Equal(FootprintShape.Rectangle, fp.Shape);
        Assert.Equal(4, fp.Corners.Length);
        Assert.Equal(0f, fp.FoundationZ);
    }

    [Fact]
    public void FootprintExtractor_RegularHexagon_ClassifiedAsHexagon() {
        var verts = RegularPrismVertices(sides: 6, radius: 5f, height: 12f);
        var fp = FootprintExtractor.FromVertices(verts);
        Assert.Equal(FootprintShape.Hexagon, fp.Shape);
        Assert.Equal(6, fp.Corners.Length);
    }

    [Fact]
    public void FootprintExtractor_RegularOctagon_ClassifiedAsOctagon() {
        var verts = RegularPrismVertices(sides: 8, radius: 5f, height: 10f);
        var fp = FootprintExtractor.FromVertices(verts);
        Assert.Equal(FootprintShape.Octagon, fp.Shape);
        Assert.Equal(8, fp.Corners.Length);
    }

    [Fact]
    public void FootprintExtractor_ManySidedDisc_ClassifiedAsRound() {
        var verts = RegularPrismVertices(sides: 24, radius: 4f, height: 8f);
        var fp = FootprintExtractor.FromVertices(verts);
        Assert.Equal(FootprintShape.Round, fp.Shape);
    }

    [Fact]
    public void FootprintExtractor_BasementBelowOrigin_RecordsNegativeFoundationZ() {
        // Box modelled with its bottom 1 m below origin (cellar protrudes).
        var verts = BoxVertices(width: 6f, depth: 4f, height: 5f, basementDepth: 1f);
        var fp = FootprintExtractor.FromVertices(verts);
        Assert.Equal(FootprintShape.Rectangle, fp.Shape);
        Assert.Equal(-1f, fp.FoundationZ, precision: 3);
    }

    // ─────────────────────────── LBK010 corner-flush check ───────────────────────────

    [Fact]
    public void ValidateLandblock_FlushBuilding_OnLevelTerrain_NoLBK010() {
        // A 6×4 m rectangular structure sitting flush on perfectly flat terrain.
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02000001,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);
        var ontology = MakeOntologyWithRectangle(0x02000001, w: 6f, d: 4f, basement: 0f);

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: (_, _) => 100f,
            dats: null,
            ontologyLookup: ontology);

        Assert.DoesNotContain(report.Diagnostics, d => d.Code == "LBK010");
    }

    [Fact]
    public void ValidateLandblock_BuildingSinks_FlagsLBK010() {
        // Terrain rises to 101 m under the building origin (terrain Z = 101,
        // foundation Z = 100). Worst-corner gap is 1 m.
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02000001,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);
        var ontology = MakeOntologyWithRectangle(0x02000001, w: 6f, d: 4f, basement: 0f);

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: (_, _) => 101f,
            dats: null,
            ontologyLookup: ontology);

        Assert.Contains(report.Diagnostics,
            d => d.Code == "LBK010" && d.Message.Contains("sinks"));
    }

    [Fact]
    public void ValidateLandblock_BuildingSticksUp_FlagsLBK010() {
        // Foundation Z = 100, terrain Z = 99 — corner sticks up 1 m above ground.
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02000001,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);
        var ontology = MakeOntologyWithRectangle(0x02000001, w: 6f, d: 4f, basement: 0f);

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: (_, _) => 99f,
            dats: null,
            ontologyLookup: ontology);

        Assert.Contains(report.Diagnostics,
            d => d.Code == "LBK010" && d.Message.Contains("sticks"));
    }

    [Fact]
    public void ValidateLandblock_NonStructure_DoesNotEmitLBK010() {
        // A scenery rock with a footprint should not be subjected to flush
        // checks — those are only meaningful for buildable Structures.
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02009999,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);
        var entry = new OntologyEntry {
            ObjectId = 0x02009999,
            Category = "Scenery",
            FootprintShape = FootprintShape.Rectangle,
            FootprintCorners = RectCorners(6f, 4f),
            FoundationZ = 0f,
            BasementDepth = 0f,
        };
        Func<uint, OntologyEntry?> lookup = id => id == 0x02009999 ? entry : null;

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: (_, _) => 105f, // would have flagged for a Structure
            dats: null,
            ontologyLookup: lookup);

        Assert.DoesNotContain(report.Diagnostics, d => d.Code == "LBK010");
    }

    [Fact]
    public void ValidateLandblock_NoOntologyLookup_BehavesAsBeforeAndSkipsLBK010() {
        // Backwards-compat: callers who don't pass an ontologyLookup get the
        // pre-existing behaviour (no LBK010, no regression of LBK003/LBK004).
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02000001,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: (_, _) => 105f,
            dats: null,
            ontologyLookup: null);

        Assert.DoesNotContain(report.Diagnostics, d => d.Code == "LBK010");
    }

    [Fact]
    public void ValidateLandblock_BasementHaloDip_EmitsInfoLBK010() {
        // A building with a 1 m basement (BasementDepth=1) sits on level
        // ground at Z=100, but terrain in its 2 m halo drops to Z=98 — that's
        // 2 m below the foundation, exceeding basement+0.5 m slack.
        var lbDoc = MakeLandblockWithObject(
            modelId: 0x02000001,
            origin: new Vector3(96f, 96f, 100f),
            orientation: Quaternion.Identity);
        var ontology = MakeOntologyWithRectangle(0x02000001, w: 6f, d: 4f, basement: 1f);

        // heightLookup: under the footprint terrain matches foundation
        // (Z=99, since BasementDepth=1 means foundationZ = origin.Z - 1 = 99);
        // outside the footprint terrain drops to Z=96 (3 m below foundation).
        Func<float, float, float> heightLookup = (x, y) => {
            float dx = x - 96f, dy = y - 96f;
            float r = MathF.Sqrt(dx * dx + dy * dy);
            return r <= 3f ? 99f : 96f;
        };

        var report = ValidationEngine.ValidateLandblock(
            lbDoc, lbKey: 0x0000,
            heightLookup: heightLookup,
            dats: null,
            ontologyLookup: ontology);

        Assert.Contains(report.Diagnostics,
            d => d.Code == "LBK010" && d.Message.Contains("foundation is exposed"));
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private static LandblockDocument MakeLandblockWithObject(
        uint modelId, Vector3 origin, Quaternion orientation) {
        var doc = new LandblockDocument(NullLogger.Instance) {
            Id = "landblock_0000"
        };
        // Bypass the InitInternal DAT path by using LoadFromProjection.
        var data = new LandblockData();
        data.StaticObjects.Add(new StaticObject {
            Id = modelId,
            IsSetup = (modelId & 0x02000000u) != 0,
            Origin = origin,
            Orientation = orientation,
            Scale = Vector3.One,
        });
        var bytes = MemoryPack.MemoryPackSerializer.Serialize(data);
        var loadMethod = typeof(LandblockDocument).GetMethod(
            "LoadFromProjectionInternal", BindingFlags.Instance | BindingFlags.NonPublic)!;
        loadMethod.Invoke(doc, new object[] { bytes });
        return doc;
    }

    private static Func<uint, OntologyEntry?> MakeOntologyWithRectangle(
        uint id, float w, float d, float basement) {
        var entry = new OntologyEntry {
            ObjectId = id,
            Category = "Structure",
            FootprintShape = FootprintShape.Rectangle,
            FootprintCorners = RectCorners(w, d),
            FoundationZ = -basement,
            BasementDepth = basement,
        };
        return objId => objId == id ? entry : null;
    }

    private static Vector2[] RectCorners(float w, float d) {
        float hx = w / 2f, hy = d / 2f;
        return new[] {
            new Vector2(-hx, -hy),
            new Vector2( hx, -hy),
            new Vector2( hx,  hy),
            new Vector2(-hx,  hy),
        };
    }

    private static List<Vector3> BoxVertices(float width, float depth, float height, float basementDepth) {
        float hx = width / 2f, hy = depth / 2f;
        float zBottom = -basementDepth;
        float zTop = height - basementDepth;
        var verts = new List<Vector3>();
        // Bottom and top rings, 4 corners each.
        foreach (var z in new[] { zBottom, zTop }) {
            verts.Add(new Vector3(-hx, -hy, z));
            verts.Add(new Vector3( hx, -hy, z));
            verts.Add(new Vector3( hx,  hy, z));
            verts.Add(new Vector3(-hx,  hy, z));
        }
        return verts;
    }

    private static List<Vector3> RegularPrismVertices(int sides, float radius, float height) {
        var verts = new List<Vector3>();
        for (int i = 0; i < sides; i++) {
            float a = 2f * MathF.PI * i / sides;
            float x = MathF.Cos(a) * radius;
            float y = MathF.Sin(a) * radius;
            verts.Add(new Vector3(x, y, 0f));
            verts.Add(new Vector3(x, y, height));
        }
        return verts;
    }

    private static TerrainDocument CreateTerrainDocument(TerrainEntry[] entries) {
        var doc = new TerrainDocument(NullLogger.Instance) {
            TerrainData = new TerrainData {
                Landblocks = new Dictionary<ushort, uint[]> {
                    [0x0101] = entries.Select(e => e.ToUInt()).ToArray()
                }
            }
        };

        typeof(TerrainDocument)
            .GetField("_baseTerrainCache", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(doc, new ConcurrentDictionary<ushort, uint[]>());

        return doc;
    }

    private static TerrainEntry[] CreateTerrainEntries(Func<int, int, byte> heightAt) {
        var entries = new TerrainEntry[81];
        for (int x = 0; x < 9; x++) {
            for (int y = 0; y < 9; y++) {
                entries[x * 9 + y] = new TerrainEntry(road: 0, scenery: 0, type: (byte)((x + y) % 2), height: heightAt(x, y));
            }
        }

        return entries;
    }

    private static float[] CreateHeightTable() {
        var heights = new float[256];
        for (int i = 0; i < heights.Length; i++) {
            heights[i] = i;
        }

        return heights;
    }
}

public class FootprintGeometryTests {
    [Fact]
    public void PointInPolygon_InsideAxisAlignedRect_ReturnsTrue() {
        var rect = new[] {
            new Vector2(0, 0), new Vector2(10, 0),
            new Vector2(10, 5), new Vector2(0, 5),
        };
        Assert.True(FootprintGeometry.PointInPolygon(new Vector2(5, 2), rect));
    }

    [Fact]
    public void PointInPolygon_OutsideAxisAlignedRect_ReturnsFalse() {
        var rect = new[] {
            new Vector2(0, 0), new Vector2(10, 0),
            new Vector2(10, 5), new Vector2(0, 5),
        };
        Assert.False(FootprintGeometry.PointInPolygon(new Vector2(11, 2), rect));
    }

    [Fact]
    public void PointInPolygon_HexagonInteriorVsExterior() {
        var hex = new Vector2[6];
        for (int i = 0; i < 6; i++) {
            float a = 2f * MathF.PI * i / 6f;
            hex[i] = new Vector2(MathF.Cos(a) * 5f, MathF.Sin(a) * 5f);
        }
        Assert.True(FootprintGeometry.PointInPolygon(Vector2.Zero, hex));
        Assert.True(FootprintGeometry.PointInPolygon(new Vector2(2, 0), hex));
        Assert.False(FootprintGeometry.PointInPolygon(new Vector2(6, 0), hex));
    }

    [Fact]
    public void WorldFootprint_RotatedRectangle_PlacesCornersCorrectly() {
        var localCorners = new[] {
            new Vector2(-2, -1), new Vector2(2, -1),
            new Vector2(2, 1), new Vector2(-2, 1),
        };
        var rot90 = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, MathF.PI / 2f);
        var world = FootprintGeometry.WorldFootprint(localCorners, rot90, 100f, 200f);

        Assert.Equal(4, world.Length);
        AssertVecApprox(new Vector2(101, 198), world[0]);
        AssertVecApprox(new Vector2(101, 202), world[1]);
        AssertVecApprox(new Vector2( 99, 202), world[2]);
        AssertVecApprox(new Vector2( 99, 198), world[3]);
    }

    private static void AssertVecApprox(Vector2 expected, Vector2 actual, float tol = 1e-3f) {
        Assert.InRange(actual.X, expected.X - tol, expected.X + tol);
        Assert.InRange(actual.Y, expected.Y - tol, expected.Y + tol);
    }
}

public class BuildingPairingsTests {
    [Fact]
    public void AddPair_TwoModels_AreInSameGroup() {
        var p = new BuildingPairings();
        p.AddPair(0x02000001u, 0x02000002u);
        Assert.True(p.AreInSameGroup(0x02000001u, 0x02000002u));
        Assert.False(p.AreInSameGroup(0x02000001u, 0x02000003u));
    }

    [Fact]
    public void AddPair_TransitiveClosure_ReachableViaUnionFind() {
        // A↔B and B↔C, so {A,B,C} share a group even without A↔C.
        var p = new BuildingPairings();
        p.AddPair(0xA, 0xB);
        p.AddPair(0xB, 0xC);

        Assert.True(p.AreInSameGroup(0xA, 0xC));
        Assert.Equal(p.GroupKey(0xA), p.GroupKey(0xC));
    }

    [Fact]
    public void GroupKey_UnregisteredModel_ReturnsItself() {
        var p = new BuildingPairings();
        // Singletons fall through as their own group of one — placement
        // treats them as un-paired.
        Assert.Equal(0x99u, p.GroupKey(0x99u));
        Assert.False(p.HasPairs(0x99u));
    }

    [Fact]
    public void AddPair_SelfPair_IsIgnored() {
        var p = new BuildingPairings();
        p.AddPair(0xA, 0xA);
        Assert.Equal(0, p.EdgeCount);
        Assert.False(p.HasPairs(0xA));
    }

    [Fact]
    public void GroupCount_ThreeIslandsAndASingleton_ReportsTwo() {
        var p = new BuildingPairings();
        p.AddPair(0xA, 0xB);   // group 1
        p.AddPair(0xC, 0xD);   // group 2
        p.AddPair(0xD, 0xE);   // joins group 2: {C,D,E}
        // 0xZ is never added → not counted.
        Assert.Equal(2, p.GroupCount);
        Assert.True(p.AreInSameGroup(0xC, 0xE));
        Assert.False(p.AreInSameGroup(0xA, 0xC));
    }

    [Fact]
    public void SaveAndLoadJson_RoundTrips() {
        var p = new BuildingPairings();
        p.AddPair(0x02000010u, 0x02000020u);
        p.AddPair(0x02000020u, 0x02000030u);
        var path = Path.Combine(Path.GetTempPath(), $"bp-{Guid.NewGuid():N}.json");
        try {
            p.SaveToJsonFile(path, minCount5: 3);
            var loaded = BuildingPairings.LoadFromJsonFile(path);
            Assert.True(loaded.AreInSameGroup(0x02000010u, 0x02000030u));
            Assert.Equal(2, loaded.EdgeCount);
        } finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void LoadFromMissingFile_ReturnsEmptyRegistry() {
        var loaded = BuildingPairings.LoadFromJsonFile("/no/such/file/here.json");
        Assert.Equal(0, loaded.EdgeCount);
        Assert.Equal(0, loaded.GroupCount);
    }
}
