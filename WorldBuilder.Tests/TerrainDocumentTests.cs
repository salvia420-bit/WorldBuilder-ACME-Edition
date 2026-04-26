using System;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Tests;

public class TerrainDocumentTests {
    private static TerrainDocument CreateDocument() => new(NullLogger.Instance);

    [Fact]
    public void TryGetLandblockInternal_LiveData_FillsDestinationAndReturnsTrue() {
        var doc = CreateDocument();
        var raw = new uint[81];
        // Pack distinct values so we can verify each byte field round-trips through TerrainEntry.
        for (int i = 0; i < raw.Length; i++) {
            byte road = (byte)(i & 0x0F);
            byte scenery = (byte)(i & 0x07);
            byte type = (byte)(i % 16);
            byte height = (byte)(255 - i);
            raw[i] = (uint)(road | (scenery << 8) | (type << 16) | (height << 24));
        }
        doc.TerrainData.Landblocks[0x1234] = raw;

        Span<TerrainEntry> dest = stackalloc TerrainEntry[81];
        bool ok = doc.TryGetLandblockInternal(0x1234, dest);

        Assert.True(ok);
        for (int i = 0; i < 81; i++) {
            Assert.Equal(new TerrainEntry(raw[i]), dest[i]);
        }
    }

    [Fact]
    public void TryGetLandblockInternal_MissingKey_ReturnsFalseAndLeavesDestinationUntouched() {
        var doc = CreateDocument();

        Span<TerrainEntry> dest = stackalloc TerrainEntry[81];
        var sentinel = new TerrainEntry(0xDEADBEEF);
        for (int i = 0; i < dest.Length; i++) dest[i] = sentinel;

        bool ok = doc.TryGetLandblockInternal(0xBEEF, dest);

        Assert.False(ok);
        // The contract: false means "not found" — destination should not be partially overwritten.
        for (int i = 0; i < dest.Length; i++) {
            Assert.Equal(sentinel, dest[i]);
        }
    }

    [Fact]
    public void TryGetLandblockInternal_DestinationTooSmall_Throws() {
        var doc = CreateDocument();
        doc.TerrainData.Landblocks[0x1111] = new uint[81];

        // Cannot use stackalloc inside an Assert.Throws lambda (ref struct capture), so
        // wrap the call in a static local that takes the doc and runs the call with a small span.
        static void Run(TerrainDocument d) {
            Span<TerrainEntry> tooSmall = stackalloc TerrainEntry[10];
            d.TryGetLandblockInternal(0x1111, tooSmall);
        }

        Assert.Throws<ArgumentException>(() => Run(doc));
    }

    [Fact]
    public void TryGetLandblockInternal_AcceptsLargerDestination() {
        var doc = CreateDocument();
        var raw = new uint[81];
        for (int i = 0; i < raw.Length; i++) raw[i] = (uint)(i + 1);
        doc.TerrainData.Landblocks[0x2222] = raw;

        Span<TerrainEntry> oversized = stackalloc TerrainEntry[100];
        bool ok = doc.TryGetLandblockInternal(0x2222, oversized);

        Assert.True(ok);
        for (int i = 0; i < 81; i++) {
            Assert.Equal((uint)(i + 1), oversized[i].ToUInt());
        }
    }
}
