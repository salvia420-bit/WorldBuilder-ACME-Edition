using System.IO.Compression;
using DatReaderWriter.Lib.IO;
using DatReaderWriter.Lib.IO.DatBTree;
using DatReaderWriter.Options;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;

namespace DatReaderWriter.Extensions;

/// <summary>
/// DatDatabase extensions
/// </summary>
public static class DatDatabaseExtensions {
    /// <summary>
    /// Defragments the dat database by rewriting it to a new file with sequential blocks.
    /// </summary>
    /// <param name="db">The source database</param>
    /// <param name="outputPath">The path to write the new defragmented dat file to</param>
    /// <param name="progress">Optional progress callback (0.0 to 1.0)</param>
    /// <returns>The number of bytes freed.</returns>
    public static int Defragment(this DatDatabase db, string outputPath, Action<float>? progress = null) {
        if (string.IsNullOrEmpty(outputPath)) {
            throw new ArgumentNullException(nameof(outputPath));
        }

        using var newDb = db.CloneEmpty(outputPath);
        newDb.CopyHeaderFrom(db);

        // Get all files from source
        // We order by ID to ensure the tree is built nicely and blocks are sequential by ID (mostly)
        var files = db.Tree.OrderBy(f => f.Id).ToList();
        var totalFiles = files.Count;
        var processed = 0;

        foreach (var file in files) {
            if (db.TryGetFileBytes(file.Id, out var bytes)) {
                // Write block to new DB using the allocator directly to get the new offset
                var newOffset = newDb.BlockAllocator.WriteBlock(bytes, bytes.Length);

                // Create new file entry
                var newEntry = new DatBTreeFile {
                    Id = file.Id,
                    Flags = file.Flags,
                    Offset = newOffset,
                    Size = (uint)bytes.Length,
                    Date = file.Date,
                    Iteration = file.Iteration
                };

                // Insert into new tree
                newDb.Tree.Insert(newEntry);
            }

            processed++;
            progress?.Invoke((float)processed / totalFiles);
        }

        return db.Header.FileSize - newDb.Header.FileSize;
    }

    /// <summary>
    /// Compresses all files in the dat database and writes them to a new file. Note that the client must be patched
    /// to support reading these.
    /// </summary>
    /// <param name="db">The source database</param>
    /// <param name="outputPath">The path to write the compressed dat file to</param>
    /// <param name="progress">Optional progress callback (0.0 to 1.0)</param>
    /// <returns>The number of bytes freed.</returns>
    public static int Compress(this DatDatabase db, string outputPath, Action<float>? progress = null) {
        if (string.IsNullOrEmpty(outputPath)) {
            throw new ArgumentNullException(nameof(outputPath));
        }

        using var newDb = db.CloneEmpty(outputPath);
        newDb.CopyHeaderFrom(db);

        // Get all files from source
        var files = db.Tree.OrderBy(f => f.Id).ToList();
        var totalFiles = files.Count;
        var processed = 0;

        foreach (var file in files) {
            if (db.TryGetFileBytes(file.Id, out var bytes)) {
                newDb.TryWriteCompressedBytes(file.Id, bytes, bytes.Length, file);
            }

            processed++;
            progress?.Invoke((float)processed / totalFiles);
        }

        return db.Header.FileSize - newDb.Header.FileSize;
    }

    /// <summary>
    /// Clone an empty db from an existing db. This will copy the header information over, but no file entries.
    /// </summary>
    /// <param name="db"></param>
    /// <param name="newDbPath"></param>
    /// <returns></returns>
    public static DatDatabase CloneEmpty(this DatDatabase db, string newDbPath) {
        var newDb = new DatDatabase(opt => {
            opt.FilePath = newDbPath;
            opt.AccessType = DatAccessType.ReadWrite;
            opt.FileCachingStrategy = FileCachingStrategy.Never;
            opt.IndexCachingStrategy = IndexCachingStrategy.Never;
        });

        // Initialize the new database with same parameters as source
        newDb.BlockAllocator.InitNew(
            db.Header.Type,
            db.Header.SubSet,
            db.Header.BlockSize,
            0 // Start with 0 free blocks to minimize file size
        );

        newDb.CopyHeaderFrom(db);
        
        return newDb;
    }

    /// <summary>
    /// Copies the header from a source database to the current database.
    /// </summary>
    /// <param name="destDb">The destination database to copy the header to</param>
    /// <param name="sourceDb">The source database to copy the header from</param>
    public static void CopyHeaderFrom(this DatDatabase destDb, DatDatabase sourceDb) {
        if (destDb == null) {
            throw new ArgumentNullException(nameof(destDb));
        }

        if (sourceDb == null) {
            throw new ArgumentNullException(nameof(sourceDb));
        }

        destDb.Header.MasterMapId = sourceDb.Header.MasterMapId;
        destDb.Header.OldLRU = sourceDb.Header.OldLRU;
        destDb.Header.NewLRU = sourceDb.Header.NewLRU;
        destDb.Header.UseLRU = sourceDb.Header.UseLRU;
        destDb.BlockAllocator.SetVersion(sourceDb.Header.Version ?? string.Empty, sourceDb.Header.EngineVersion,
            sourceDb.Header.GameVersion,
            sourceDb.Header.MajorVersion, sourceDb.Header.MinorVersion);
    }
}