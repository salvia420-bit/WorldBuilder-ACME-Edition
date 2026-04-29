using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Types;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the contract for the OntologyService classifier rewrite. The 30+
/// downstream call sites that read entry.Category as a string (CommandEngine,
/// RenderPreviewRenderer, LandblockDescriber, TransactDiffEngine, validators)
/// rely on these invariants being stable.
/// </summary>
public class OntologyServiceTests {

    // ── 1. BoundsFailed when setup has no vertices ────────────────────────

    [Fact]
    public void BoundsFailed_WhenSetupHasNoVertices_ReturnsUnknown() {
        var dats = new StubDats();
        var emptyGfxId = 0x01000001u;
        dats.GfxObjs[emptyGfxId] = MakeGfxObjWithoutVertices();

        var setup = MakeSetupWithParts(new[] { emptyGfxId });
        var svc = new OntologyService();

        var entry = svc.ClassifySetup(
            id: 0x02000001u, setup, dats,
            buildingIds: new HashSet<uint>(),
            sceneryIds: new HashSet<uint>());

        Assert.Equal("Unknown", entry.Category);
        Assert.Equal("BoundsFailed", entry.ClassificationSource);
        Assert.Equal(0f, entry.Confidence);
        Assert.Equal("Unknown", entry.Scale);
        Assert.NotNull(entry.ClassificationReason);
    }

    // ── 2. Symmetric Setup ↔ GfxObj for the same id ───────────────────────

    [Fact]
    public void Symmetric_SetupAndGfxObj_SameId_SameCategory() {
        // Same id appears as a Setup part and as a standalone GfxObj. With the
        // id in sceneryIds, both classification paths must yield Scenery.
        const uint sharedId = 0x02000ABCu;
        var sceneryIds = new HashSet<uint> { sharedId };
        var buildingIds = new HashSet<uint>();

        var dats = new StubDats();
        var partGfxId = 0x010000ABu;
        dats.GfxObjs[partGfxId] = MakeGfxObjAtPositions(new[] { Vector3.Zero, new Vector3(2, 2, 2) });

        var setup = MakeSetupWithParts(new[] { partGfxId });
        var gfx   = MakeGfxObjAtPositions(new[] { Vector3.Zero, new Vector3(2, 2, 2) });

        var svc = new OntologyService();
        var setupEntry = svc.ClassifySetup(sharedId, setup, dats, buildingIds, sceneryIds);
        var gfxEntry   = svc.ClassifyGfxObj(sharedId, gfx, buildingIds, sceneryIds);

        Assert.Equal("Scenery", setupEntry.Category);
        Assert.Equal("Scenery", gfxEntry.Category);
        Assert.Equal("Scene", setupEntry.ClassificationSource);
        Assert.Equal("Scene", gfxEntry.ClassificationSource);
        Assert.Equal(setupEntry.Category, gfxEntry.Category);
    }

    // ── 3. Deterministic placement-frame selection ────────────────────────

    [Fact]
    public void Deterministic_PlacementFrameSelection_ChoosesLowestKeyEveryRun() {
        // The placement frame at the lowest key must be picked every run. We
        // use Default(0), Quiver(5), LeftWeapon(7) — three distinct keys whose
        // origins are distinguishable. The lowest key is Default(0); its
        // origin is what should drive the bounds.
        var dats = new StubDats();
        var partId = 0x01000123u;
        dats.GfxObjs[partId] = MakeGfxObjAtPositions(new[] { Vector3.Zero });

        var setup = new Setup {
            Parts = new List<QualifiedDataId<GfxObj>> { partId },
            PlacementFrames = new Dictionary<Placement, AnimationFrame> {
                [Placement.Quiver]     = MakeFrameWithSingleOrigin(new Vector3(50, 50, 50)),
                [Placement.Default]    = MakeFrameWithSingleOrigin(new Vector3(7, 7, 7)),
                [Placement.LeftWeapon] = MakeFrameWithSingleOrigin(new Vector3(99, 99, 99)),
            }
        };

        Vector3? expectedMin = null;
        Vector3? expectedMax = null;

        for (int run = 0; run < 100; run++) {
            OntologyService.ComputeSetupBounds(setup, dats, out var min, out var max, out _, out var valid);
            Assert.True(valid);

            if (expectedMin == null) {
                expectedMin = min;
                expectedMax = max;
            } else {
                Assert.Equal(expectedMin.Value, min);
                Assert.Equal(expectedMax.Value, max);
            }
        }

        // Picking Default(0) means partOffset = (7,7,7) added to the part's
        // single vertex at origin — so min == max == (7,7,7).
        Assert.Equal(new Vector3(7, 7, 7), expectedMin!.Value);
        Assert.Equal(new Vector3(7, 7, 7), expectedMax!.Value);
    }

    // ── 4. Heuristic boundary confidence for Structure-vs-Scenery ─────────

    [Fact]
    public void Heuristic_BoundaryConfidence_StructureVsScenery() {
        // maxDim = 9.97m, partCount = 4 → fires Rule 1 (large-multi-part →
        // Structure) inside the boundary band [9, 11]. Confidence should be
        // 0.5 + 0.5 * (9.97 - 9) / 2 ≈ 0.7425.
        var (cat, conf, reason) = OntologyService.ClassifyCategoryByHeuristic(
            maxDim: 9.97f, aspectRatio: 1.0f, partCount: 4, polyCount: 200);

        Assert.Equal("Structure", cat);
        Assert.True(conf > 0.5f && conf < 1.0f, $"Boundary confidence should be reduced; got {conf}");
        Assert.InRange(conf, 0.74f, 0.75f);
        Assert.StartsWith("boundary:struct-vs-scenery", reason);

        // Far above the band — full confidence.
        var (cat2, conf2, _) = OntologyService.ClassifyCategoryByHeuristic(
            maxDim: 20f, aspectRatio: 1.0f, partCount: 4, polyCount: 200);
        Assert.Equal("Structure", cat2);
        Assert.Equal(1.0f, conf2);
    }

    // ── 5. Cache round-trip preserves new fields ──────────────────────────

    [Fact]
    public void Cache_RoundTrip_PreservesNewFields() {
        var svc = new OntologyService();
        // Seed an entry with non-default Confidence + ClassificationReason
        // via the cache loader (the simplest deterministic path).
        var path = Path.Combine(Path.GetTempPath(), $"ontology_roundtrip_{Guid.NewGuid():N}.jsonl");
        try {
            File.WriteAllLines(path, new[] {
                """
                {"id":42,"type":"Setup","scale":"Medium","category":"Structure","classSource":"Heuristic","confidence":0.74,"classificationReason":"boundary:struct-vs-scenery@9.97m","tags":["structure","medium"]}
                """
            });
            svc.LoadFromCache(path);
            var loaded = svc.GetEntry(42u);
            Assert.NotNull(loaded);
            Assert.Equal(0.74f, loaded!.Confidence);
            Assert.Equal("boundary:struct-vs-scenery@9.97m", loaded.ClassificationReason);

            // Now write it back out and read it again — fields must survive.
            var path2 = Path.Combine(Path.GetTempPath(), $"ontology_roundtrip_{Guid.NewGuid():N}.jsonl");
            try {
                svc.CacheToFile(path2);
                var svc2 = new OntologyService();
                svc2.LoadFromCache(path2);
                var reloaded = svc2.GetEntry(42u);
                Assert.NotNull(reloaded);
                Assert.Equal(0.74f, reloaded!.Confidence);
                Assert.Equal("boundary:struct-vs-scenery@9.97m", reloaded.ClassificationReason);
            } finally {
                if (File.Exists(path2)) File.Delete(path2);
            }
        } finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    // ── 6. Legacy cache loads with Confidence=1.0 ─────────────────────────

    [Fact]
    public void Cache_LegacyFile_LoadsAsConfidenceOne() {
        // Hand-crafted legacy JSONL line — no `confidence`, no
        // `classificationReason`, no `cacheVersion`. Loader must accept it.
        var path = Path.Combine(Path.GetTempPath(), $"ontology_legacy_{Guid.NewGuid():N}.jsonl");
        try {
            File.WriteAllLines(path, new[] {
                """{"id":1,"type":"Setup","scale":"Large","category":"Structure","classSource":"Building","tags":["structure","large"]}""",
                """{"id":2,"type":"GfxObj","scale":"Small","category":"Prop","classSource":"Heuristic","tags":["prop","small"]}""",
            });
            var svc = new OntologyService();
            int loaded = svc.LoadFromCache(path);
            Assert.Equal(2, loaded);

            var e1 = svc.GetEntry(1u);
            var e2 = svc.GetEntry(2u);
            Assert.NotNull(e1);
            Assert.NotNull(e2);
            Assert.Equal(1.0f, e1!.Confidence);
            Assert.Equal(1.0f, e2!.Confidence);
            Assert.Null(e1.ClassificationReason);
            Assert.Null(e2.ClassificationReason);
        } finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    // ── 7. Brute-force fallback parity with enumerated path ───────────────

    [Fact]
    public void BruteForceFallback_SameSet_AsEnumeratedPath() {
        // Two synthetic LBIs at canonical landblock infos, each contributing
        // distinct ModelIds. We exercise CollectBuildingIds twice:
        //   1. Enumerated: pass the LBI ids in `enumerated` array.
        //   2. Brute-force: pass empty `enumerated` so the 256² loop probes
        //      via tryGetLbi(infoId) — the lookup function returns the same
        //      LBIs at the same canonical infoIds.
        // Both must produce the identical building-id set.
        uint LbiId(uint x, uint y) => (uint)(((x << 8) | y) << 16 | 0xFFFE);

        var lbi1 = MakeLbiWithBuildingModelIds(new uint[] { 0x02000010, 0x02000011 });
        var lbi2 = MakeLbiWithBuildingModelIds(new uint[] { 0x02000020 });

        uint id1 = LbiId(0, 1);
        uint id2 = LbiId(2, 3);

        LandBlockInfo? lookup(uint id) {
            if (id == id1) return lbi1;
            if (id == id2) return lbi2;
            return null;
        }

        var ignoredWarn = new Action<string>(_ => { });

        var enumerated = OntologyService.CollectBuildingIds(
            new[] { id1, id2 }, lookup, ignoredWarn);

        var bruteForce = OntologyService.CollectBuildingIds(
            Array.Empty<uint>(), lookup, ignoredWarn);

        var expected = new HashSet<uint> { 0x02000010u, 0x02000011u, 0x02000020u };
        Assert.True(expected.SetEquals(enumerated));
        Assert.True(expected.SetEquals(bruteForce));
        Assert.True(enumerated.SetEquals(bruteForce));
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private static Setup MakeSetupWithParts(uint[] partIds) {
        // Default placement frame at origin so the bounds are not shifted.
        var af = new AnimationFrame((uint)partIds.Length) {
            Frames = Enumerable.Range(0, partIds.Length)
                .Select(_ => new Frame { Origin = Vector3.Zero, Orientation = Quaternion.Identity })
                .ToList()
        };
        return new Setup {
            Parts = partIds.Select(p => (QualifiedDataId<GfxObj>)p).ToList(),
            PlacementFrames = new Dictionary<Placement, AnimationFrame> {
                [Placement.Default] = af,
            }
        };
    }

    private static AnimationFrame MakeFrameWithSingleOrigin(Vector3 origin) {
        return new AnimationFrame(1u) {
            Frames = new List<Frame> {
                new() { Origin = origin, Orientation = Quaternion.Identity },
            }
        };
    }

    private static GfxObj MakeGfxObjWithoutVertices() {
        // No VertexArray at all — this is the degenerate case the rewrite
        // is supposed to catch instead of silently classifying as "Tiny".
        return new GfxObj { VertexArray = null };
    }

    private static GfxObj MakeGfxObjAtPositions(IEnumerable<Vector3> positions) {
        var vertices = new Dictionary<ushort, SWVertex>();
        ushort i = 0;
        foreach (var p in positions) {
            vertices[i++] = new SWVertex {
                Origin = p,
                Normal = Vector3.UnitZ,
                UVs = new List<Vec2Duv> { new() { U = 0f, V = 0f } },
            };
        }
        return new GfxObj {
            VertexArray = new VertexArray {
                VertexType = VertexType.CSWVertexType,
                Vertices = vertices,
            },
            Polygons = new Dictionary<ushort, Polygon>(),
        };
    }

    private static LandBlockInfo MakeLbiWithBuildingModelIds(uint[] modelIds) {
        var lbi = new LandBlockInfo();
        foreach (var m in modelIds) {
            lbi.Buildings.Add(new BuildingInfo {
                ModelId = m,
                Frame = new Frame { Origin = Vector3.Zero, Orientation = Quaternion.Identity },
            });
        }
        return lbi;
    }

    /// <summary>
    /// Minimal IDatReaderWriter for the classifier under test. Only
    /// TryGet&lt;GfxObj&gt; and TryGet&lt;LandBlockInfo&gt; are exercised by these
    /// tests; the Dats property is unused (these tests bypass Scan).
    /// </summary>
    private sealed class StubDats : IDatReaderWriter {
        public Dictionary<uint, GfxObj> GfxObjs { get; } = new();
        public Dictionary<uint, LandBlockInfo> Lbis { get; } = new();

        public DatCollection Dats =>
            throw new InvalidOperationException("StubDats.Dats is not used by these tests.");

        public bool TryGet<T>(uint id, out T file) where T : IDBObj, new() {
            if (typeof(T) == typeof(GfxObj) && GfxObjs.TryGetValue(id, out var g)) {
                file = (T)(object)g;
                return true;
            }
            if (typeof(T) == typeof(LandBlockInfo) && Lbis.TryGetValue(id, out var l)) {
                file = (T)(object)l;
                return true;
            }
            file = default!;
            return false;
        }

        public bool TrySave<T>(T file, int? iteration = 0) where T : IDBObj, new() =>
            throw new NotImplementedException();

        public void Dispose() { }
    }
}
