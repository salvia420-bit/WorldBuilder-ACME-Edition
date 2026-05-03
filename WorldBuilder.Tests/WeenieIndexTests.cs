using System.Collections.Generic;
using System.IO;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the contract for WeenieIndex — the canonical wcid → identity map
/// introduced in the WeenieIndex migration (see weenie_index.md). Three
/// invariants matter for downstream consumers (the static-site renderer's
/// wcid → setup resolver, the roster projection wrappers, and the spawns
/// overlay emitter):
///
///   1. TryGetSetup is the fast path; it returns false for unknown wcids
///      AND for wcids whose Setup property is null in the ACE DB.
///   2. WhereType filters on canonical AceWeenieType values; the prior bug
///      that crept into the legacy roster query (Vendor=20=Chest) is
///      structurally impossible because WhereType doesn't translate.
///   3. JSONL save/load round-trip preserves every field bit-for-bit so
///      AutoRestore is identical to a fresh ingest.
/// </summary>
public class WeenieIndexTests {

    private static WeenieIndexEntry MakeEntry(int wcid, int weenieType,
            string className = "stub", uint? setup = 0x02000001u,
            bool isNpc = false, bool isServerManaged = false) =>
        new WeenieIndexEntry(
            Wcid: wcid,
            ClassName: className,
            WeenieType: weenieType,
            IsServerManaged: isServerManaged,
            IsNpc: isNpc,
            DisplayName: className,
            Title: null,
            SetupDid: setup,
            IconDid: null,
            PaletteBaseDid: null,
            CreatureType: null,
            Level: null,
            SourceMask: WeenieSource.AceDb);

    [Fact]
    public void Empty_HasZeroEntries_AndAllLookupsMiss() {
        var idx = WeenieIndex.Empty;
        Assert.Equal(0, idx.Count);
        Assert.Null(idx.Get(1125));
        Assert.False(idx.TryGetSetup(1125, out var s));
        Assert.Equal(0u, s);
    }

    [Fact]
    public void TryGetSetup_ReturnsTrueWhenSetupPresent() {
        // wcid 1125 (portalholtburgdungeon) → 0x020005F3 in retail ACE DB.
        // Pin the resolver path the static-site renderer uses for sprite-atlas
        // lookups; if this regresses the green-pedestal portal disappears.
        var idx = new WeenieIndex(new Dictionary<int, WeenieIndexEntry> {
            [1125] = MakeEntry(1125, weenieType: 7, className: "portalholtburgdungeon",
                               setup: 0x020005F3u),
        });
        Assert.True(idx.TryGetSetup(1125, out var setup));
        Assert.Equal(0x020005F3u, setup);
    }

    [Fact]
    public void TryGetSetup_ReturnsFalseWhenSetupNull() {
        // A weenie row exists but its Setup property is null. The resolver
        // must distinguish this from "wcid unknown" so the fallback path
        // (ontology) gets a chance.
        var idx = new WeenieIndex(new Dictionary<int, WeenieIndexEntry> {
            [42] = MakeEntry(42, weenieType: 1, setup: null),
        });
        Assert.False(idx.TryGetSetup(42, out var setup));
        Assert.Equal(0u, setup);
        Assert.NotNull(idx.Get(42));  // entry exists; only the setup is null
    }

    [Fact]
    public void WhereType_FiltersByCanonicalWeenieType() {
        // The legacy roster filter used Vendor=20 (actually Chest); this test
        // pins WhereType against canonical AceWeenieType values so a future
        // refactor can't silently revert.
        var idx = new WeenieIndex(new Dictionary<int, WeenieIndexEntry> {
            [10] = MakeEntry(10, weenieType: 10, className: "creature_a"),
            [11] = MakeEntry(11, weenieType: 10, className: "creature_b"),
            [12] = MakeEntry(12, weenieType: 12, className: "vendor_a"),
            [20] = MakeEntry(20, weenieType: 20, className: "chest_a"),
        });
        var creatures = idx.WhereType(10).ToList();
        Assert.Equal(2, creatures.Count);
        Assert.All(creatures, e => Assert.Equal(10, e.WeenieType));

        var vendors = idx.WhereType(12).ToList();
        Assert.Single(vendors);
        Assert.Equal("vendor_a", vendors[0].ClassName);
    }

    [Fact]
    public void WhereTypeIn_UnionsSetsCorrectly() {
        // The NPC roster projection uses WhereTypeIn(Vendor=12, Creature=10)
        // ∪ Where(IsTalker). Cover the union path here; the IsTalker filter
        // is a separate LINQ predicate the projection composes.
        var idx = new WeenieIndex(new Dictionary<int, WeenieIndexEntry> {
            [10] = MakeEntry(10, weenieType: 10),
            [12] = MakeEntry(12, weenieType: 12),
            [20] = MakeEntry(20, weenieType: 20),
        });
        var npcSubset = idx.WhereTypeIn(10, 12).Select(e => e.Wcid).OrderBy(w => w).ToList();
        Assert.Equal(new[] { 10, 12 }, npcSubset);
    }

    [Fact]
    public void SaveLoadJsonl_RoundTripsEveryField() {
        // AutoRestoreWeenieIndex deserializes via LoadJsonl; this test pins
        // that the on-disk shape matches the in-memory record exactly.
        var entry = new WeenieIndexEntry(
            Wcid: 37518,
            ClassName: "ace37518-royalguard",
            WeenieType: 10,
            IsServerManaged: true,
            IsNpc: true,
            DisplayName: "Royal Guard",
            Title: "Soldier",
            SetupDid: 0x02000441u,
            IconDid: 0x06000731u,
            PaletteBaseDid: 0x040000BEu,
            CreatureType: 31,
            Level: 40,
            SourceMask: WeenieSource.AceDb);
        var idx = new WeenieIndex(new Dictionary<int, WeenieIndexEntry> { [entry.Wcid] = entry });

        var path = Path.Combine(Path.GetTempPath(), $"weenie_index_test_{System.Guid.NewGuid():N}.jsonl");
        try {
            int saved = idx.SaveJsonl(path);
            Assert.Equal(1, saved);

            var loaded = WeenieIndex.LoadJsonl(path);
            var roundTrip = loaded.Get(entry.Wcid);
            Assert.NotNull(roundTrip);
            Assert.Equal(entry, roundTrip);
        } finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void LoadJsonl_TolerantToBlankLines() {
        // Mirror the OntologyService cache loader's blank-line tolerance.
        var path = Path.Combine(Path.GetTempPath(), $"weenie_blank_test_{System.Guid.NewGuid():N}.jsonl");
        try {
            File.WriteAllText(path, "\n\n   \n");
            var idx = WeenieIndex.LoadJsonl(path);
            Assert.Equal(0, idx.Count);
        } finally {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
