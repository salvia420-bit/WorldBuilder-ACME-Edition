using System.Collections.Generic;
using System.Numerics;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Types;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Tests;

/// <summary>
/// Regression guard for F57: deleting a building must NOT shrink LandBlockInfo.NumCells when the
/// deleted building's EnvCells are not the topmost slots of the contiguous 0x0100..0x0100+NumCells-1
/// range, and InstantiateBlueprint must allocate new cell IDs strictly above every existing cell
/// (never overwriting a live EnvCell record) and refuse to cross the 0xFFFD ceiling.
/// </summary>
public class BuildingDeleteCellRangeTests {
    private const uint LbId = 0xA9B4;

    public BuildingDeleteCellRangeTests() {
        // BuildingBlueprintCache holds static state (blueprint cache, building-id scan, donor
        // hints). Reset it so these tests are hermetic regardless of execution order.
        BuildingBlueprintCache.ClearCache();
    }

    /// <summary>Minimal in-memory IDatReaderWriter recording every saved DBObj by id.</summary>
    private sealed class FakeDats : IDatReaderWriter {
        public readonly Dictionary<uint, IDBObj> Store = new();

        public DatCollection Dats =>
            throw new System.InvalidOperationException("FakeDats.Dats is not used by these tests.");

        public bool TryGet<T>(uint id, out T file) where T : IDBObj, new() {
            if (Store.TryGetValue(id, out var obj) && obj is T typed) {
                file = typed;
                return true;
            }
            file = default!;
            return false;
        }

        public bool TrySave<T>(T file, int? iteration = 0) where T : IDBObj, new() {
            Store[file.Id] = file;
            return true;
        }

        public void Dispose() { }
    }

    private static EnvCell MakeCell(ushort suffix, ushort[] portalTargets) {
        var cell = new EnvCell { Id = (LbId << 16) | suffix };
        foreach (var t in portalTargets)
            cell.CellPortals.Add(new CellPortal { OtherCellId = t });
        return cell;
    }

    private static BuildingInfo MakeBuilding(uint modelId, Vector3 localOrigin, ushort[] cellSuffixes) {
        var b = new BuildingInfo {
            ModelId = modelId,
            Frame = new Frame { Origin = localOrigin, Orientation = Quaternion.Identity }
        };
        var stabList = new List<ushort>();
        for (int i = 1; i < cellSuffixes.Length; i++) stabList.Add(cellSuffixes[i]);
        var portal = new BuildingPortal { OtherCellId = cellSuffixes[0], StabList = stabList };
        b.Portals.Add(portal);
        return b;
    }

    private static Vector3 WorldOf(Vector3 local) {
        var blockX = (LbId >> 8) & 0xFF;
        var blockY = LbId & 0xFF;
        return new Vector3(blockX * 192f + local.X, blockY * 192f + local.Y, local.Z);
    }

    private static StaticObject StaticFor(BuildingInfo b) => new() {
        Id = b.ModelId,
        IsSetup = (b.ModelId & 0x02000000) != 0,
        Origin = WorldOf(b.Frame.Origin),
        Orientation = b.Frame.Orientation,
        Scale = Vector3.One
    };

    /// <summary>
    /// Sets up an LBI with two buildings A (cells 0x0100,0x0101) and B (cells 0x0102,0x0103),
    /// NumCells=4. The caller picks which building survives by passing its StaticObject.
    /// </summary>
    private static (FakeDats dats, LandblockDocument doc, BuildingInfo a, BuildingInfo b) SetupTwoBuildings(
        params StaticObject[] survivingStatics) {
        var dats = new FakeDats();

        var a = MakeBuilding(0x02000100u, new Vector3(20, 20, 0), new ushort[] { 0x0100, 0x0101 });
        var b = MakeBuilding(0x02000200u, new Vector3(60, 60, 0), new ushort[] { 0x0102, 0x0103 });

        void Add(EnvCell c) => dats.Store[c.Id] = c;
        Add(MakeCell(0x0100, new ushort[] { 0x0101 }));
        Add(MakeCell(0x0101, new ushort[] { 0x0100 }));
        Add(MakeCell(0x0102, new ushort[] { 0x0103 }));
        Add(MakeCell(0x0103, new ushort[] { 0x0102 }));

        var lbi = new LandBlockInfo { Id = (LbId << 16) | 0xFFFE, NumCells = 4 };
        lbi.Buildings.Add(a);
        lbi.Buildings.Add(b);
        dats.Store[lbi.Id] = lbi;

        var doc = new LandblockDocument(NullLogger.Instance) { Id = $"landblock_{LbId:X4}" };
        foreach (var s in survivingStatics) doc.AddStaticObject(s);

        return (dats, doc, a, b);
    }

    [Fact]
    public void DeletingNonTopmostBuilding_RefusesToShrinkNumCells() {
        // Survive B (0x0102,0x0103), delete A (0x0100,0x0101). A is NOT topmost.
        var (dats, doc, _, b) = SetupTwoBuildings();
        doc.AddStaticObject(StaticFor(b));

        Assert.True(doc.SaveToDats(dats).GetAwaiter().GetResult());

        var savedLbi = (LandBlockInfo)dats.Store[(LbId << 16) | 0xFFFE];
        // NumCells must NOT shrink — B's cells 0x0102/0x0103 would otherwise fall outside the range.
        Assert.Equal(4u, savedLbi.NumCells);

        // B's surviving cells must still be inside 0x0100..0x0100+NumCells-1.
        ushort ceiling = (ushort)(0x0100 + savedLbi.NumCells - 1);
        Assert.True(dats.Store.ContainsKey((LbId << 16) | 0x0102));
        Assert.True(dats.Store.ContainsKey((LbId << 16) | 0x0103));
        Assert.True(0x0102 <= ceiling && 0x0103 <= ceiling);
    }

    [Fact]
    public void DeletingTopmostBuilding_ShrinksNumCells() {
        // Survive A (0x0100,0x0101), delete B (0x0102,0x0103). B IS topmost → safe to shrink.
        var (dats, doc, a, _) = SetupTwoBuildings();
        doc.AddStaticObject(StaticFor(a));

        Assert.True(doc.SaveToDats(dats).GetAwaiter().GetResult());

        var savedLbi = (LandBlockInfo)dats.Store[(LbId << 16) | 0xFFFE];
        Assert.Equal(2u, savedLbi.NumCells);
    }

    [Fact]
    public void InstantiateBlueprint_AllocatesAboveExistingCells_NeverOverwritingLiveRecords() {
        // Pre-existing live cells occupy 0x0100..0x0103 (NumCells UNDERSTATED as 2 to model the
        // post-refused-delete / stale case). The new building must NOT reuse 0x0102/0x0103.
        var dats = new FakeDats();
        var preExisting = new Dictionary<uint, ushort>();
        for (ushort s = 0x0100; s <= 0x0103; s++) {
            var c = new EnvCell { Id = (LbId << 16) | s, EnvironmentId = (ushort)(0xAA00 + s) };
            dats.Store[c.Id] = c;
            preExisting[c.Id] = c.EnvironmentId;
        }

        var blueprint = new BuildingBlueprint {
            ModelId = 0x02000300u,
            DonorOrigin = new Vector3(0, 0, 0),
            DonorOrientation = Quaternion.Identity,
        };
        blueprint.Cells.Add(new EnvCellSnapshot { OriginalCellId = 0x0100, RelativeOrigin = Vector3.Zero, Orientation = Quaternion.Identity });
        blueprint.Cells.Add(new EnvCellSnapshot { OriginalCellId = 0x0101, RelativeOrigin = Vector3.Zero, Orientation = Quaternion.Identity });

        // currentNumCells=2 understates the true top (0x0103). Naive 0x0100+2 = 0x0102 would
        // overwrite a live record; the fix must skip occupied IDs and land on 0x0104+.
        var result = BuildingBlueprintCache.InstantiateBlueprint(
            blueprint, new Vector3(10, 10, 0), Quaternion.Identity,
            LbId, currentNumCells: 2, dats, iteration: 0, logger: NullLogger.Instance);

        Assert.True(result.HasValue);
        Assert.Equal(2, result.Value.cellCount);

        // No pre-existing cell record was changed.
        foreach (var (id, env) in preExisting) {
            Assert.True(dats.Store.TryGetValue(id, out var obj));
            Assert.Equal(env, ((EnvCell)obj).EnvironmentId);
        }

        // The two NEW cells were written at suffixes strictly above the highest pre-existing
        // suffix (0x0103) — i.e. 0x0104 and 0x0105 — never reusing 0x0102/0x0103.
        Assert.True(dats.Store.ContainsKey((LbId << 16) | 0x0104));
        Assert.True(dats.Store.ContainsKey((LbId << 16) | 0x0105));
        Assert.Equal((LbId << 16) | 0x0104u, ((EnvCell)dats.Store[(LbId << 16) | 0x0104]).Id);
    }

    [Fact]
    public void InstantiateBlueprint_ThrowsWhenExceedingCeiling() {
        var dats = new FakeDats();
        var blueprint = new BuildingBlueprint {
            ModelId = 0x02000400u,
            DonorOrigin = Vector3.Zero,
            DonorOrientation = Quaternion.Identity,
        };
        // Two cells starting at 0x0100 + currentNumCells where currentNumCells pushes the first ID
        // to 0xFFFD: cell #1 -> 0xFFFD (ok), cell #2 -> 0xFFFE (> 0xFFFD ceiling) -> throw.
        blueprint.Cells.Add(new EnvCellSnapshot { OriginalCellId = 0x0100, RelativeOrigin = Vector3.Zero, Orientation = Quaternion.Identity });
        blueprint.Cells.Add(new EnvCellSnapshot { OriginalCellId = 0x0101, RelativeOrigin = Vector3.Zero, Orientation = Quaternion.Identity });

        uint currentNumCells = 0xFFFD - 0x0100; // first new id = 0xFFFD

        Assert.Throws<System.InvalidOperationException>(() =>
            BuildingBlueprintCache.InstantiateBlueprint(
                blueprint, new Vector3(10, 10, 0), Quaternion.Identity,
                LbId, currentNumCells, dats, iteration: 0, logger: NullLogger.Instance));
    }
}
