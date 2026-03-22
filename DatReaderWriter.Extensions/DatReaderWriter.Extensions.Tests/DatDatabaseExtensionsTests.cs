using DatReaderWriter.Extensions.Tests.Helpers;
using DatReaderWriter.Options;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Lib.IO.DatBTree;


namespace DatReaderWriter.Extensions.Tests;

[TestClass]
public class DatDatabaseExtensionsTests {
    [TestMethod]
    public void Defragment_ReducesFileSize_WhenFragmentationExists() {
        // Arrange
        using var tempDir = new TempDatDirectory();

        // Setup options to allow writing
        var options = new DatDatabaseOptions {
            FilePath = tempDir.PortalDatPath,
            AccessType = DatAccessType.ReadWrite,
            FileCachingStrategy = FileCachingStrategy.Never,
            IndexCachingStrategy = IndexCachingStrategy.Never
        };

        // Open existing dat and add some data to create a baseline
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.ReadWrite;
               })) {
            // Write some dummy files
            for (uint i = 0x5000000; i < 0x5000010; i++) {
                var file = new RenderSurface() { Id = i, Width = 1024, Height = 1024, SourceData = new byte[1024 * 5] };
                new Random().NextBytes(file.SourceData);
                db.TryWriteFile(file);
            }
        }

        // Now reopen and delete some intermittent files to create holes/fragmentation
        int itemsDeleted = 0;
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.ReadWrite;
               })) {
            for (uint i = 0x5000000; i < 0x5000010; i += 2) {
                // Delete evens
                db.Tree.TryDelete(i, out _);
                itemsDeleted++;
            }
        }

        // At this point, the file size hasn't shrunk, but we have gaps.
        // We need to reload to get accurate file size if we were keeping it open, 
        // but we closed it.

        int originalSize;
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            originalSize = db.Header.FileSize;
        }

        var defragPath = Path.Combine(tempDir.DirectoryPath, "defrag.dat");

        // Act
        int bytesFreed;
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            bytesFreed = db.Defragment(defragPath);
        }

        // Assert
        Assert.IsTrue(File.Exists(defragPath));
        var newSize = new FileInfo(defragPath).Length;
        Assert.IsTrue(newSize < originalSize, $"New size {newSize} should be smaller than original {originalSize}");
        Assert.AreEqual(originalSize - newSize, bytesFreed);

        // Read new dat to verify content
        using (var newDb = new DatDatabase(o => {
                   o.FilePath = defragPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            // Verify we kept the odd files
            for (uint i = 0x5000001; i < 0x5000010; i += 2) {
                Assert.IsTrue(newDb.Tree.HasFile(i), $"Should have file {i:X8}");
            }

            // Verify we don't have the even files
            for (uint i = 0x5000000; i < 0x5000010; i += 2) {
                Assert.IsFalse(newDb.Tree.HasFile(i), $"Should NOT have file {i:X8}");
            }
        }
    }

    [TestMethod]
    public void Compress_ReducesFileSize_WhenCompressible() {
        // Arrange
        using var tempDir = new TempDatDirectory();

        // Open existing dat and add some highly compressible data
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.ReadWrite;
               })) {
            // Write a highly compressible file
            var file = new RenderSurface() {
                Id = 0x05000001u, Width = 1024, Height = 1024, SourceData = new byte[1024 * 10]
            };
            Array.Fill(file.SourceData, (byte)0xCC);
            db.TryWriteFile(file);
        }

        int originalSize;
        int initialPackedSize;
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            originalSize = db.Header.FileSize;
            db.Tree.TryGetFile(0x05000001u, out var entry);
            initialPackedSize = (int)entry.Size;
        }

        var compressPath = Path.Combine(tempDir.DirectoryPath, "compress.dat");

        // Act
        int bytesFreed;
        using (var db = new DatDatabase(o => {
                   o.FilePath = tempDir.PortalDatPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            bytesFreed = db.Compress(compressPath);
        }

        // Assert
        Assert.IsTrue(File.Exists(compressPath));
        var newSize = new FileInfo(compressPath).Length;
        Assert.IsTrue(newSize < originalSize, $"New size {newSize} should be smaller than original {originalSize}");
        Assert.AreEqual(originalSize - (int)newSize, bytesFreed);

        // Read new dat to verify content
        using (var newDb = new DatDatabase(o => {
                   o.FilePath = compressPath;
                   o.AccessType = DatAccessType.Read;
               })) {
            Assert.IsTrue(newDb.Tree.TryGetFile(0x05000001u, out var fileEntry), "Should have compressed file");
            Assert.AreEqual(DatBTreeFileFlags.IsCompressed, fileEntry.Flags & DatBTreeFileFlags.IsCompressed, "Compression flag should be set");

        }
    }
}