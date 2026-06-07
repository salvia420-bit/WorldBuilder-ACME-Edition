using System.Collections.Generic;
using System.IO;
using System.Numerics;

using MemoryPack;

using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the contract for E1 (wave-2) PR1 — the shared enrichment value types plus the
/// <c>placements_enriched.jsonl</c> round-trip, and the HARD CONSTRAINT that PR1 changes NO
/// SQL behavior (existing <c>landblock_instance</c> output is byte-identical).
///
/// Three invariant families:
///   1. JSONL serialize → deserialize → serialize is VALUE-EXACT, and addressability is
///      preserved (SubPaletteId stays a 0x04 DID; the PositionType key stays Home).
///   2. MemoryPack on DungeonInstancePlacement evolves append-only: enriched blobs round-trip,
///      and OLD blobs (no enrichment) still deserialize with the new fields null.
///   3. The existing landblock_instance SQL emitter is byte-identical with enrichment present
///      vs absent — the enriched fields never leak into the SQL.
/// </summary>
public partial class EnrichedPlacementTests {

    // ── Fixtures ────────────────────────────────────────────────────────

    private static PlacementDye SampleDye() => new() {
        SubPaletteId = 0x04001234u,  // a real 0x04 Palette DID, NOT a list-local index
        Offset = 8,
        Length = 16,
        PaletteTemplate = 23,        // template tint (small enum index), secondary
        Shade = 0.5f,
    };

    private static PlacementGenerator SampleGenerator() => new() {
        Probability = 1.0f,
        WeenieClassId = 7,
        Delay = 5.0f,
        InitCreate = 1,
        MaxCreate = 3,
        WhenCreate = 0x4u,   // RegenerationType.Death
        WhereCreate = 0x01u, // RegenLocationType.OnTop
        StackSize = null,
        PaletteTemplate = 12,
        Shade = 0.25f,
        ObjCellId = 0xAB12_0100u,
        OriginX = 1.5f, OriginY = 2.5f, OriginZ = 3.5f,
        AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
    };

    private static OutdoorInstancePlacement EnrichedOutdoor() => new() {
        LandblockId = 0xAB12,
        WeenieClassId = 1234,
        CellNumber = 0x0001,
        OriginX = 10f, OriginY = 20f, OriginZ = 30f,
        AnglesW = 0.7071f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0.7071f,
        Dye = SampleDye(),
        Generators = new List<PlacementGenerator> { SampleGenerator() },
        Positions = new Dictionary<PositionType, PlacementPosition> {
            [PositionType.Home] = new PlacementPosition {
                ObjCellId = 0xAB12_0001u,
                OriginX = 10f, OriginY = 20f, OriginZ = 30f,
                AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
            },
        },
    };

    // ── 1. JSONL round-trip is value-exact ───────────────────────────────

    [Fact]
    public void Jsonl_SerializeDeserializeSerialize_IsValueExact() {
        var p = EnrichedPlacementStore.FromOutdoor(EnrichedOutdoor());

        string json1 = EnrichedPlacementStore.SerializeLine(p);
        var back = EnrichedPlacementStore.DeserializeLine(json1);
        Assert.NotNull(back);
        string json2 = EnrichedPlacementStore.SerializeLine(back!);

        // The defining round-trip property: text in, text out, byte-identical.
        Assert.Equal(json1, json2);
    }

    [Fact]
    public void Jsonl_RoundTrip_PreservesAddressability() {
        var p = EnrichedPlacementStore.FromOutdoor(EnrichedOutdoor());

        var back = EnrichedPlacementStore.DeserializeLine(EnrichedPlacementStore.SerializeLine(p));
        Assert.NotNull(back);

        // Dye addressability: SubPaletteId stays a 0x04 DID, not collapsed to an index.
        Assert.NotNull(back!.Dye);
        Assert.Equal(0x04001234u, back.Dye!.SubPaletteId);
        Assert.Equal((ushort)8, back.Dye.Offset);
        Assert.Equal((ushort)16, back.Dye.Length);
        Assert.Equal(23, back.Dye.PaletteTemplate);
        Assert.Equal(0.5f, back.Dye.Shade);

        // Position key stays the Home enum value (5), never an array offset.
        Assert.NotNull(back.Positions);
        Assert.True(back.Positions!.ContainsKey(PositionType.Home));
        Assert.Equal(30f, back.Positions[PositionType.Home].OriginZ);

        // Generator survives as named columns.
        Assert.NotNull(back.Generators);
        Assert.Single(back.Generators!);
        Assert.Equal(7u, back.Generators![0].WeenieClassId);
        Assert.Equal(0x4u, back.Generators[0].WhenCreate);
        Assert.Equal(12, back.Generators[0].PaletteTemplate);
    }

    [Fact]
    public void Jsonl_PositionKey_SerializesAsEnumName_ForReadability() {
        var p = EnrichedPlacementStore.FromOutdoor(EnrichedOutdoor());
        string json = EnrichedPlacementStore.SerializeLine(p);

        // Human/ML readability: the PositionType dict key is the enum NAME, and it still
        // round-trips to the same value.
        Assert.Contains("\"Home\"", json);
        var back = EnrichedPlacementStore.DeserializeLine(json);
        Assert.True(back!.Positions!.ContainsKey(PositionType.Home));
    }

    [Fact]
    public void Jsonl_FileRoundTrip_ReproducesPlacements() {
        var placements = new List<EnrichedPlacement> {
            EnrichedPlacementStore.FromOutdoor(EnrichedOutdoor()),
            EnrichedPlacementStore.FromOutdoor(new OutdoorInstancePlacement {
                LandblockId = 0xAB12, WeenieClassId = 99, CellNumber = 2,
                OriginX = 1, OriginY = 2, OriginZ = 3,
            }),  // no enrichment — exercises null fields
        };

        var dir = Path.Combine(Path.GetTempPath(), $"e1_jsonl_{System.Guid.NewGuid():N}");
        try {
            var path = EnrichedPlacementStore.WriteFile(dir, placements);
            Assert.True(File.Exists(path));
            Assert.EndsWith(EnrichedPlacementStore.FileName, path);

            string text1 = File.ReadAllText(path);
            var read = EnrichedPlacementStore.ReadFile(dir);
            Assert.Equal(2, read.Count);

            // Re-serialize the read-back set: byte-identical to the file on disk.
            string text2 = EnrichedPlacementStore.Serialize(read);
            Assert.Equal(text1, text2);

            // The un-enriched placement keeps its enrichment null (drop-null on write).
            var bare = read.Find(r => r.WeenieClassId == 99);
            Assert.NotNull(bare);
            Assert.Null(bare!.Dye);
            Assert.Null(bare.Generators);
            Assert.Null(bare.Positions);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Jsonl_ReadFile_MissingFile_ReturnsEmpty() {
        var dir = Path.Combine(Path.GetTempPath(), $"e1_missing_{System.Guid.NewGuid():N}");
        var read = EnrichedPlacementStore.ReadFile(dir);
        Assert.Empty(read);
    }

    [Fact]
    public void Jsonl_PlacementModel_RoundTrip_Outdoor() {
        // Project a model → enriched → JSONL → enriched → model, and confirm enrichment survives.
        var original = EnrichedOutdoor();
        var json = EnrichedPlacementStore.SerializeLine(EnrichedPlacementStore.FromOutdoor(original));
        var rebuilt = EnrichedPlacementStore.ToOutdoor(EnrichedPlacementStore.DeserializeLine(json)!);

        Assert.Equal(original.WeenieClassId, rebuilt.WeenieClassId);
        Assert.Equal(original.LandblockId, rebuilt.LandblockId);
        Assert.Equal(original.Dye!.SubPaletteId, rebuilt.Dye!.SubPaletteId);
        Assert.Equal(original.Generators!.Count, rebuilt.Generators!.Count);
        Assert.True(rebuilt.Positions!.ContainsKey(PositionType.Home));
    }

    // ── 2. MemoryPack append-only evolution ──────────────────────────────

    [Fact]
    public void MemoryPack_DungeonPlacement_WithEnrichment_RoundTrips() {
        var p = new DungeonInstancePlacement {
            WeenieClassId = 1234,
            CellNumber = 0x0100,
            Origin = new Vector3(1, 2, 3),
            Orientation = new Quaternion(0, 0, 0.7071f, 0.7071f),
            Dye = SampleDye(),
            Generators = new List<PlacementGenerator> { SampleGenerator() },
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Home] = new PlacementPosition { ObjCellId = 0xAB120100u, OriginZ = 3f, AnglesW = 1f },
            },
        };

        var bytes = MemoryPackSerializer.Serialize(p);
        var back = MemoryPackSerializer.Deserialize<DungeonInstancePlacement>(bytes);

        Assert.NotNull(back);
        Assert.Equal(1234u, back!.WeenieClassId);
        Assert.Equal(0x04001234u, back.Dye!.SubPaletteId);
        Assert.Single(back.Generators!);
        Assert.True(back.Positions!.ContainsKey(PositionType.Home));
    }

    [Fact]
    public void MemoryPack_DungeonPlacement_WithoutEnrichment_HasNullFields() {
        var p = new DungeonInstancePlacement {
            WeenieClassId = 5,
            CellNumber = 0x0100,
            Origin = new Vector3(1, 2, 3),
            Orientation = Quaternion.Identity,
        };

        var bytes = MemoryPackSerializer.Serialize(p);
        var back = MemoryPackSerializer.Deserialize<DungeonInstancePlacement>(bytes);

        Assert.NotNull(back);
        Assert.Equal(5u, back!.WeenieClassId);
        Assert.Null(back.Dye);
        Assert.Null(back.Generators);
        Assert.Null(back.Positions);
    }

    [Fact]
    public void MemoryPack_OldDungeonDataBlob_DeserializesWithNullEnrichment() {
        // Simulate an OLD .dungeon projection: a DungeonData whose placement was serialized
        // BEFORE enrichment existed. Append-only evolution must let it deserialize with the
        // new fields defaulting to null (HARD CONSTRAINT 5).
        //
        // We can't serialize the literal old type, but the append-only guarantee means a blob
        // that omits the trailing members still reads back. The strongest in-test proof is that
        // a freshly-serialized blob (with null trailing members) deserializes, and that the
        // member layout is stable (the four legacy members come first). Round-trip a DungeonData
        // holding a no-enrichment placement to confirm the whole container still works.
        var data = new DungeonData {
            LandblockKey = 0xAB12,
            InstancePlacements = new List<DungeonInstancePlacement> {
                new DungeonInstancePlacement {
                    WeenieClassId = 42,
                    CellNumber = 0x0101,
                    Origin = new Vector3(4, 5, 6),
                    Orientation = Quaternion.Identity,
                },
            },
        };

        var bytes = MemoryPackSerializer.Serialize(data);
        var back = MemoryPackSerializer.Deserialize<DungeonData>(bytes);

        Assert.NotNull(back);
        Assert.Single(back!.InstancePlacements);
        var pl = back.InstancePlacements[0];
        Assert.Equal(42u, pl.WeenieClassId);
        Assert.Equal((ushort)0x0101, pl.CellNumber);
        Assert.Null(pl.Dye);
        Assert.Null(pl.Generators);
        Assert.Null(pl.Positions);
    }

    // ── 3. Existing SQL output is byte-identical (PR1 = no SQL behavior change) ──

    [Fact]
    public void LandblockInstanceSql_IsByteIdentical_WithAndWithoutEnrichment() {
        // Two records identical except one carries full enrichment. The existing
        // GenerateInsertSql emitter must produce the SAME bytes — enrichment never leaks.
        var bare = new LandblockInstanceRecord {
            Guid = 0x1000_0001u,
            WeenieClassId = 1234,
            ObjCellId = 0xAB12_0001u,
            OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 0.7071f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0.7071f,
        };
        var enriched = new LandblockInstanceRecord {
            Guid = 0x1000_0001u,
            WeenieClassId = 1234,
            ObjCellId = 0xAB12_0001u,
            OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 0.7071f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0.7071f,
            Dye = SampleDye(),
            Generators = new List<PlacementGenerator> { SampleGenerator() },
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Home] = new PlacementPosition { ObjCellId = 1, AnglesW = 1f },
            },
        };

        string sqlBare = AceDbConnector.GenerateInsertSql(bare);
        string sqlEnriched = AceDbConnector.GenerateInsertSql(enriched);

        Assert.Equal(sqlBare, sqlEnriched);
    }

    [Fact]
    public void LandblockInstanceSql_GoldenString_Unchanged() {
        // Golden snapshot of the exact landblock_instance INSERT. If a future change touches
        // the placement directive SQL, this fails loudly. (guid pinned non-zero so the
        // random-guid path is not taken.)
        var rec = new LandblockInstanceRecord {
            Guid = 0x1000_0001u,
            WeenieClassId = 1234,
            ObjCellId = 0xAB12_0001u,
            OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 0.7071f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0.7071f,
            Dye = SampleDye(),  // present but must NOT appear in SQL
        };

        const string expected =
            "INSERT INTO `ace_world`.`landblock_instance` " +
            "(`guid`, `weenie_Class_Id`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, " +
            "`angles_w`, `angles_x`, `angles_y`, `angles_z`) VALUES " +
            "(268435457, 1234, 2870083585, 10.000000, 20.000000, 30.000000, " +
            "0.707100, 0.000000, 0.000000, 0.707100);";

        string sql = AceDbConnector.GenerateInsertSql(rec);
        Assert.Equal(expected, sql);

        // And explicitly: no enrichment column names bleed into the placement SQL.
        Assert.DoesNotContain("sub_Palette_Id", sql);
        Assert.DoesNotContain("palette_Id", sql);
        Assert.DoesNotContain("position_Type", sql);
    }

    [Fact]
    public void OutdoorConverter_CarriesEnrichmentThrough_ButSqlStaysClean() {
        // ToLandblockInstanceRecordsFromOutdoor must copy the 3 new fields through (so PR2/PR3
        // can emit them) while the existing SQL path stays byte-clean.
        var placements = new List<OutdoorInstancePlacement> { EnrichedOutdoor() };

        var records = AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(placements);
        Assert.Single(records);

        var r = records[0];
        Assert.NotNull(r.Dye);
        Assert.Equal(0x04001234u, r.Dye!.SubPaletteId);
        Assert.Single(r.Generators!);
        Assert.True(r.Positions!.ContainsKey(PositionType.Home));

        // SQL produced from the enriched record carries no enrichment columns.
        string sql = AceDbConnector.GenerateInsertSqlBatch(records);
        Assert.DoesNotContain("sub_Palette_Id", sql);
        Assert.DoesNotContain("palette_Id", sql);
        Assert.DoesNotContain("position_Type", sql);
    }

    [Fact]
    public void DungeonConverter_CarriesEnrichmentThrough() {
        var placements = new List<DungeonInstancePlacement> {
            new DungeonInstancePlacement {
                WeenieClassId = 1234,
                CellNumber = 0x0100,
                Origin = new Vector3(1, 2, 3),
                Orientation = Quaternion.Identity,
                Dye = SampleDye(),
                Generators = new List<PlacementGenerator> { SampleGenerator() },
                Positions = new Dictionary<PositionType, PlacementPosition> {
                    [PositionType.Home] = new PlacementPosition { ObjCellId = 1, AnglesW = 1f },
                },
            },
        };

        var records = AceDbConnector.ToLandblockInstanceRecords(0xAB12, placements);
        Assert.Single(records);
        Assert.Equal(0x04001234u, records[0].Dye!.SubPaletteId);
        Assert.True(records[0].Positions!.ContainsKey(PositionType.Home));

        string sql = AceDbConnector.GenerateInsertSqlBatch(records);
        Assert.DoesNotContain("sub_Palette_Id", sql);
    }

    // ── 4. Ordering determinism + robustness regressions (review fixes) ───

    [Fact]
    public void Jsonl_PositionsMap_SerializesInEnumKeyOrder_RegardlessOfInsertionOrder() {
        // Two logically-identical placements whose Positions map is built in DIFFERENT insertion
        // order must serialize to byte-IDENTICAL JSONL (byte-stability for a given placement set).
        PlacementPosition Pos(float z) => new() { ObjCellId = 1, OriginZ = z, AnglesW = 1f };

        var a = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1,
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Home] = Pos(5f),
                [PositionType.Location] = Pos(1f),
                [PositionType.Sanctuary] = Pos(4f),
            },
        };
        var b = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1,
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Sanctuary] = Pos(4f),
                [PositionType.Location] = Pos(1f),
                [PositionType.Home] = Pos(5f),
            },
        };

        string ja = EnrichedPlacementStore.SerializeLine(a);
        string jb = EnrichedPlacementStore.SerializeLine(b);
        Assert.Equal(ja, jb);

        // Keys appear in ascending enum order (Location=1, Sanctuary=4, Home=5).
        Assert.True(ja.IndexOf("\"Location\"") < ja.IndexOf("\"Sanctuary\""));
        Assert.True(ja.IndexOf("\"Sanctuary\"") < ja.IndexOf("\"Home\""));

        // And it still round-trips value-exact with all three keys.
        var back = EnrichedPlacementStore.DeserializeLine(ja)!;
        Assert.Equal(3, back.Positions!.Count);
        Assert.Equal(5f, back.Positions[PositionType.Home].OriginZ);
    }

    [Fact]
    public void Jsonl_NonFiniteFloats_RoundTripAsNamedLiterals() {
        // A degenerate normalize upstream can produce NaN/Infinity. The serializer must NOT abort
        // the whole write; it pins them as named literals and round-trips them back exactly.
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1,
            OriginX = float.NaN, OriginY = float.PositiveInfinity, OriginZ = float.NegativeInfinity,
        };

        string json = EnrichedPlacementStore.SerializeLine(p);
        Assert.Contains("NaN", json);
        Assert.Contains("Infinity", json);

        var back = EnrichedPlacementStore.DeserializeLine(json)!;
        Assert.True(float.IsNaN(back.OriginX));
        Assert.True(float.IsPositiveInfinity(back.OriginY));
        Assert.True(float.IsNegativeInfinity(back.OriginZ));
    }

    [Fact]
    public void Jsonl_EmptyCollections_SurviveAsEmpty_NotNull() {
        // Pin the empty-vs-null contract: a non-null EMPTY Generators/Positions round-trips back
        // as empty (count 0), distinct from null. PR2's emitter must treat empty == "no rows".
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1,
            Generators = new List<PlacementGenerator>(),
            Positions = new Dictionary<PositionType, PlacementPosition>(),
        };

        var back = EnrichedPlacementStore.DeserializeLine(EnrichedPlacementStore.SerializeLine(p))!;
        Assert.NotNull(back.Generators);
        Assert.Empty(back.Generators!);
        Assert.NotNull(back.Positions);
        Assert.Empty(back.Positions!);
    }

    [Fact]
    public void ToDungeon_WithNoAngles_RebuildsIdentityQuaternion() {
        // A hand-authored / ML-emitted JSONL line that omits all angles must read back as the ACE
        // identity quaternion (x=0,y=0,z=0,w=1) — matching the SQL emitter's all-null→identity
        // rule — NOT the bogus (0,0,1,0) the old per-component fallback produced.
        var e = new EnrichedPlacement {
            Kind = "dungeon", Landblock = 0xAB12, CellNumber = 0x0100, WeenieClassId = 42,
            OriginX = 1, OriginY = 2, OriginZ = 3,
            AnglesW = null, AnglesX = null, AnglesY = null, AnglesZ = null,
        };

        var dng = EnrichedPlacementStore.ToDungeon(e);
        Assert.Equal(Quaternion.Identity, dng.Orientation);

        var outd = EnrichedPlacementStore.ToOutdoor(e);
        Assert.Equal(Quaternion.Identity, outd.Orientation);
    }

    [Fact]
    public void Jsonl_SameKeyDuplicates_OrderStably_RegardlessOfInputOrder() {
        // Two distinct placements sharing (Kind, Landblock, CellNumber, WeenieClassId) and no Guid
        // (legal: two copies of one wcid stacked in a cell) must sort to the SAME file order no
        // matter the input order, via the full-pose tie-breaker.
        EnrichedPlacement Make(float z) => new() {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 7,
            OriginX = 0, OriginY = 0, OriginZ = z,
            AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
        };

        string s1 = EnrichedPlacementStore.Serialize(new List<EnrichedPlacement> { Make(1f), Make(2f) });
        string s2 = EnrichedPlacementStore.Serialize(new List<EnrichedPlacement> { Make(2f), Make(1f) });
        Assert.Equal(s1, s2);
    }

    [Fact]
    public void Jsonl_Guid_RoundTripsThroughLine() {
        // The addressable Option-B key (guid) survives the JSONL serialize→deserialize cycle, so
        // PR3 can rely on it even though the placement MODELS carry no Guid field in PR1.
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 7,
            Guid = 0x7000_1234u,
            Scope = EnrichmentScope.PlacementOverride,
        };

        var back = EnrichedPlacementStore.DeserializeLine(EnrichedPlacementStore.SerializeLine(p))!;
        Assert.Equal(0x7000_1234u, back.Guid);
        Assert.Equal(EnrichmentScope.PlacementOverride, back.Scope);
    }

    // ── 5. TRUE legacy MemoryPack blob (append-only backward-compat) ──────

    /// <summary>
    /// A stand-in for the PRE-enrichment DungeonInstancePlacement: EXACTLY the four legacy members
    /// in slots 0–3, no enrichment. Serializing this and deserializing the bytes into the current
    /// 7-member type proves the append-only guarantee (HARD CONSTRAINT 5) against a REAL old blob,
    /// not a freshly-serialized new blob with null tails.
    /// </summary>
    [MemoryPackable]
    public partial class LegacyDungeonInstancePlacement {
        [MemoryPackOrder(0)] public uint WeenieClassId { get; set; }
        [MemoryPackOrder(1)] public ushort CellNumber { get; set; }
        [MemoryPackOrder(2)] public Vector3 Origin { get; set; }
        [MemoryPackOrder(3)] public Quaternion Orientation { get; set; } = Quaternion.Identity;
    }

    [Fact]
    public void MemoryPack_RealLegacyBlob_DeserializesIntoCurrentTypeWithNullEnrichment() {
        var legacy = new LegacyDungeonInstancePlacement {
            WeenieClassId = 99,
            CellNumber = 0x0123,
            Origin = new Vector3(7, 8, 9),
            Orientation = new Quaternion(0, 0, 0.7071f, 0.7071f),
        };

        byte[] legacyBytes = MemoryPackSerializer.Serialize(legacy);

        // The decisive cross-type deserialize: 4-member wire blob → 7-member current type.
        var current = MemoryPackSerializer.Deserialize<DungeonInstancePlacement>(legacyBytes);

        Assert.NotNull(current);
        Assert.Equal(99u, current!.WeenieClassId);
        Assert.Equal((ushort)0x0123, current.CellNumber);
        Assert.Equal(new Vector3(7, 8, 9), current.Origin);
        Assert.Equal(new Quaternion(0, 0, 0.7071f, 0.7071f), current.Orientation);
        // Appended enrichment members default to null on an old blob.
        Assert.Null(current.Dye);
        Assert.Null(current.Generators);
        Assert.Null(current.Positions);
    }

    // ── 6. Batch SQL wrapper (shipped artifact) is byte-pinned ────────────

    [Fact]
    public void LandblockInstanceSqlBatch_GoldenString_Unchanged() {
        // The orchestrator ships the BATCH output (header + rows), not a single line. Pin the full
        // header + a single row so a future edit to the comment lines fails loudly.
        var rec = new LandblockInstanceRecord {
            Guid = 0x1000_0001u,
            WeenieClassId = 1234,
            ObjCellId = 0xAB12_0001u,
            OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 0.7071f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0.7071f,
            Dye = SampleDye(),  // present but must NOT appear in SQL
        };

        string batch = AceDbConnector.GenerateInsertSqlBatch(new[] { rec });

        var nl = System.Environment.NewLine;
        string expected =
            "-- ACME WorldBuilder: landblock_instance (generators/items/portals)" + nl +
            "-- Database: ace_world" + nl +
            nl +
            "INSERT INTO `ace_world`.`landblock_instance` " +
            "(`guid`, `weenie_Class_Id`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, " +
            "`angles_w`, `angles_x`, `angles_y`, `angles_z`) VALUES " +
            "(268435457, 1234, 2870083585, 10.000000, 20.000000, 30.000000, " +
            "0.707100, 0.000000, 0.000000, 0.707100);" + nl;

        Assert.Equal(expected, batch);
        Assert.DoesNotContain("sub_Palette_Id", batch);
        Assert.DoesNotContain("position_Type", batch);
    }

    [Fact]
    public void PositionType_MirrorsAceValues() {
        // The ushort values must match ACE 1:1 so position_Type writes need no translation.
        Assert.Equal((ushort)0, (ushort)PositionType.Undef);
        Assert.Equal((ushort)1, (ushort)PositionType.Location);
        Assert.Equal((ushort)2, (ushort)PositionType.Destination);
        Assert.Equal((ushort)3, (ushort)PositionType.Instantiation);
        Assert.Equal((ushort)4, (ushort)PositionType.Sanctuary);
        Assert.Equal((ushort)5, (ushort)PositionType.Home);
        Assert.Equal((ushort)8, (ushort)PositionType.LinkedPortalOne);
        Assert.Equal((ushort)16, (ushort)PositionType.LinkedPortalTwo);
        Assert.Equal((ushort)17, (ushort)PositionType.Save1);
        Assert.Equal((ushort)25, (ushort)PositionType.Save9);
        Assert.Equal((ushort)26, (ushort)PositionType.RelativeDestination);
        Assert.Equal((ushort)27, (ushort)PositionType.TeleportedCharacter);
    }
}
