using System.Buffers.Binary;
using System.IO;
using WorldBuilder.Shared.Lib;
using Xunit;

namespace WorldBuilder.Tests;

public class DatExportFixerTests {
    private const int HeaderOffset = 320;
    private const int OffMagic = HeaderOffset + 0;
    private const int OffBlockSize = HeaderOffset + 4;
    private const int OffFileSize = HeaderOffset + 8;
    private const int OffFreeHead = HeaderOffset + 20;
    private const int OffFreeTail = HeaderOffset + 24;
    private const int OffFreeCount = HeaderOffset + 28;
    private const int OffRootBlock = HeaderOffset + 32;

    private const int ExpectedMagic = 0x00005442;

    private static string MakeMinimalDat(int blockSize, int rootBlock, int fileSize,
        int freeHead, int freeTail, int freeCount) {
        var path = Path.Combine(Path.GetTempPath(),
            $"datfixer_{System.Guid.NewGuid():N}.dat");

        var buf = new byte[System.Math.Max(fileSize, HeaderOffset + 80)];

        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffMagic, 4), ExpectedMagic);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffBlockSize, 4), blockSize);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffFileSize, 4), fileSize);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffFreeHead, 4), freeHead);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffFreeTail, 4), freeTail);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffFreeCount, 4), freeCount);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffRootBlock, 4), rootBlock);

        File.WriteAllBytes(path, buf);
        return path;
    }

    private static (int head, int tail, int count) ReadFreeChain(string path) {
        var buf = File.ReadAllBytes(path);
        return (
            BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(OffFreeHead, 4)),
            BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(OffFreeTail, 4)),
            BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(OffFreeCount, 4))
        );
    }

    [Fact]
    public void PatchFreeBlocksBeforeExport_ZeroesFreeCount_AndPointsHeadTailAtFileEnd() {
        const int fileSize = 0x10000;
        var path = MakeMinimalDat(blockSize: 1024, rootBlock: 0,
            fileSize: fileSize, freeHead: 0x500, freeTail: 0x900, freeCount: 7);

        try {
            DatExportFixer.PatchFreeBlocksBeforeExport(path);
            var (head, tail, count) = ReadFreeChain(path);

            Assert.Equal(fileSize, head);
            Assert.Equal(fileSize, tail);
            Assert.Equal(0, count);
        }
        finally {
            File.Delete(path);
        }
    }

    [Fact]
    public void PatchFreeBlocksBeforeExport_NoOpOnInvalidMagic() {
        var path = MakeMinimalDat(blockSize: 1024, rootBlock: 0,
            fileSize: 0x4000, freeHead: 0x500, freeTail: 0x900, freeCount: 7);

        var buf = File.ReadAllBytes(path);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffMagic, 4), unchecked((int)0xDEADBEEF));
        File.WriteAllBytes(path, buf);

        try {
            DatExportFixer.PatchFreeBlocksBeforeExport(path);
            var (head, tail, count) = ReadFreeChain(path);

            Assert.Equal(0x500, head);
            Assert.Equal(0x900, tail);
            Assert.Equal(7, count);
        }
        finally {
            File.Delete(path);
        }
    }

    [Fact]
    public void PatchFreeBlocksBeforeExport_NoOpOnMissingFile() {
        var path = Path.Combine(Path.GetTempPath(),
            $"datfixer_missing_{System.Guid.NewGuid():N}.dat");

        var ex = Record.Exception(() => DatExportFixer.PatchFreeBlocksBeforeExport(path));
        Assert.Null(ex);
    }

    [Fact]
    public void FixLeafBranchSentinels_NoOpWhenRootBlockIsZero() {
        var path = MakeMinimalDat(blockSize: 1024, rootBlock: 0,
            fileSize: 0x4000, freeHead: 0, freeTail: 0, freeCount: 0);

        try {
            var before = File.ReadAllBytes(path);
            DatExportFixer.FixLeafBranchSentinels(path);
            var after = File.ReadAllBytes(path);
            Assert.Equal(before, after);
        }
        finally {
            File.Delete(path);
        }
    }

    [Fact]
    public void FixLeafBranchSentinels_NoOpOnInvalidMagic() {
        var path = MakeMinimalDat(blockSize: 1024, rootBlock: 0x1000,
            fileSize: 0x4000, freeHead: 0, freeTail: 0, freeCount: 0);

        var buf = File.ReadAllBytes(path);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(OffMagic, 4), unchecked((int)0xDEADBEEF));
        File.WriteAllBytes(path, buf);

        try {
            var before = File.ReadAllBytes(path);
            DatExportFixer.FixLeafBranchSentinels(path);
            var after = File.ReadAllBytes(path);
            Assert.Equal(before, after);
        }
        finally {
            File.Delete(path);
        }
    }
}
