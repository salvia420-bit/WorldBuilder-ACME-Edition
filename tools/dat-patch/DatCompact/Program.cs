// DatCompact — rebuild a portal.dat into a dense file to reclaim freed interior
// blocks. DatCompress rewrites records smaller but the FILE never shrinks (block
// high-water); after enough lane churn the file trips the 2^31 ceiling while its
// live content is hundreds of MB smaller. This copies every record from a source
// portal into a fresh copy of a dense seed (normally the retail base, which has
// minimal slack), reusing the seed's freed blocks as it goes.
//
// Records are copied by CONTENT: plain bytes read (auto-decompress) from the
// source, re-written with the source entry as metadata template. Records the
// source stored compressed are re-compressed on write (raw stored-byte copy is
// not possible through DRW — TryWriteFileBytes clears IsCompressed). --verify
// re-reads every record from the output and byte-compares against the source.
//
// usage: DatCompact <source.dat> <seed.dat> <out.dat> [--verify]
//   Refuses to overwrite an existing out file. Refuses out paths under
//   ~/ac_base_dats (house rule). Exits 3 if the seed contains records the
//   source lacks (nothing in our lanes deletes records; that would mean the
//   wrong seed).
using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;
using DatReaderWriter.Lib.IO.DatBTree;
using DatReaderWriter.Lib.IO.BlockAllocators;

// --exclude <ids.txt>: skip these source ids entirely (one 0x-hex id per line).
// Safe by construction: the seed-only check below rejects a seed that carries an
// excluded id (it would otherwise survive via the seed copy), and --verify's
// "extra" check rejects an excluded id that reaches the output.
string? excludePath = null;
var positional = new List<string>();
for (int ai = 0; ai < args.Length; ai++) {
    if (args[ai] == "--exclude") {
        if (ai + 1 >= args.Length) { Console.Error.WriteLine("--exclude needs a file"); return 2; }
        excludePath = args[++ai];
    } else if (!args[ai].StartsWith("--")) positional.Add(args[ai]);
}
if (positional.Count < 3) { Console.Error.WriteLine("usage: DatCompact <source.dat> <seed.dat> <out.dat> [--verify] [--exclude ids.txt]"); return 2; }
string srcPath = positional[0], seedPath = positional[1], outPath = positional[2];
bool verify = args.Contains("--verify");
var excludeSet = new HashSet<uint>();
if (excludePath != null) {
    foreach (var l in File.ReadAllLines(excludePath)) {
        var t = l.Trim();
        if (t.Length > 0) excludeSet.Add(Convert.ToUInt32(t, 16));
    }
    Console.WriteLine($"exclude ids: {excludeSet.Count}");
}
// --prune-seed-extra is DEAD: it rode on Tree.TryDelete, which corrupted the
// b-tree at scale on 2026-08-19 (169/213 requested deletes landed, 3 innocent
// records lost, 1 phantom id). A split-trimmed portal is built by
// RECONSTRUCTION in DatHifiSplit instead (fresh InitNew + copy-all-but).
if (args.Contains("--prune-seed-extra")) {
    Console.Error.WriteLine("--prune-seed-extra is disabled: DRW Tree.TryDelete corrupts at scale (2026-08-19). Use DatHifiSplit reconstruction.");
    return 2;
}

string baseDats = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ac_base_dats");
if (Path.GetFullPath(outPath).StartsWith(Path.GetFullPath(baseDats))) {
    Console.Error.WriteLine($"refusing to write under {baseDats}"); return 2;
}
if (File.Exists(outPath)) { Console.Error.WriteLine($"out exists: {outPath} — remove it first"); return 2; }

Console.WriteLine($"seeding {outPath} from {seedPath} ({new FileInfo(seedPath).Length:N0} bytes)");
File.Copy(seedPath, outPath);

// StreamBlockAllocator (not the x64-default MemoryMappedBlockAllocator): plain
// stream I/O keeps RSS flat on the 8 GB laptop and avoids the mmap Expand/view
// hazard observed as an AV when a write triggers file growth (2026-08-17).
using var src = new PortalDatabase(
    o => { o.FilePath = srcPath; o.AccessType = DatAccessType.Read; },
    new StreamBlockAllocator(new DatDatabaseOptions { FilePath = srcPath, AccessType = DatAccessType.Read }));
using var dst = new PortalDatabase(
    o => { o.FilePath = outPath; o.AccessType = DatAccessType.ReadWrite; },
    new StreamBlockAllocator(new DatDatabaseOptions { FilePath = outPath, AccessType = DatAccessType.ReadWrite }));

var srcEntries = src.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).ToList();
if (excludeSet.Count > 0) {
    int found = srcEntries.Count(e => excludeSet.Contains(e.Id));
    if (found != excludeSet.Count) {
        Console.Error.WriteLine($"exclude list: only {found}/{excludeSet.Count} ids present in source — wrong list");
        return 3;
    }
    srcEntries = srcEntries.Where(e => !excludeSet.Contains(e.Id)).ToList();
    Console.WriteLine($"excluded {found} records; {srcEntries.Count} remain");
}
var srcIds = srcEntries.Select(e => e.Id).ToHashSet();
var seedOnly = dst.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu)
                  .Select(f => f.Id).Where(id => !srcIds.Contains(id)).ToList();
Console.WriteLine($"source records: {srcEntries.Count}; seed-only records: {seedOnly.Count}");
if (seedOnly.Count > 0) {
    foreach (var id in seedOnly.Take(10)) Console.Error.WriteLine($"  seed-only: 0x{id:X8}");
    Console.Error.WriteLine("seed has records the source lacks — wrong seed for this source");
    return 3;
}

int copied = 0, unchanged = 0, failed = 0, flagDrift = 0;
foreach (var entry in srcEntries) {
    if (!src.TryGetFileBytes(entry.Id, out var plain, autoDecompress: true)) {
        Console.Error.WriteLine($"  0x{entry.Id:X8} source read failed"); failed++; continue;
    }
    bool wasCompressed = entry.Flags.HasFlag(DatBTreeFileFlags.IsCompressed);
    bool ok;
    string? err = null;
    try {
        var res = wasCompressed
            ? dst.TryWriteCompressedBytes(entry.Id, plain, plain.Length, entry)
            : dst.TryWriteFileBytes(entry.Id, plain, plain.Length, entry);
        ok = res.Success;
        if (!ok) err = res.Error;
    }
    catch (Exception ex) {
        Console.Error.WriteLine($"  0x{entry.Id:X8} write THREW after {copied} copies: {ex.Message}");
        Console.Error.WriteLine($"  dst Header.FileSize={dst.Header.FileSize:N0} actual={new FileInfo(outPath).Length:N0} plainLen={plain.Length:N0}");
        throw;
    }
    long actualLen = new FileInfo(outPath).Length;
    if (actualLen != dst.Header.FileSize) {
        Console.Error.WriteLine($"  DRIFT after 0x{entry.Id:X8} (copy #{copied}): Header.FileSize={dst.Header.FileSize:N0} actual={actualLen:N0} plainLen={plain.Length:N0} srcCompressed={wasCompressed}");
        return 4;
    }
    if (dst.Header.FreeBlockCount > 0 &&
        (dst.Header.FirstFreeBlock % dst.Header.BlockSize != 0 || dst.Header.FirstFreeBlock >= dst.Header.FileSize)) {
        Console.Error.WriteLine($"  FREECHAIN WEIRD after 0x{entry.Id:X8} (copy #{copied}): first=0x{dst.Header.FirstFreeBlock:X} count={dst.Header.FreeBlockCount} fileSize={dst.Header.FileSize:N0}");
        return 5;
    }
    if (!dst.TryGetFileBytes(entry.Id, out var rb, autoDecompress: true) || !plain.AsSpan().SequenceEqual(rb)) {
        Console.Error.WriteLine($"  READBACK MISMATCH at 0x{entry.Id:X8} (copy #{copied}) plainLen={plain.Length:N0}");
        return 6;
    }
    if (!ok) { Console.Error.WriteLine($"  0x{entry.Id:X8} write failed: {err}"); failed++; continue; }
    copied++;
    if (wasCompressed) {
        dst.Tree.TryGetFile(entry.Id, out var after);
        if (!after.Flags.HasFlag(DatBTreeFileFlags.IsCompressed)) flagDrift++;
    }
    if (copied % 5000 == 0) Console.WriteLine($"  ... {copied}/{srcEntries.Count}");
}
Console.WriteLine($"copied={copied} failed={failed} compressedFlagDrift={flagDrift}");

int mismatch = 0, verified = 0;
if (verify) {
    var dstIds = dst.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
    int missing = srcIds.Count(id => !dstIds.Contains(id));
    int extra = dstIds.Count(id => !srcIds.Contains(id));
    Console.WriteLine($"verify sets: missing={missing} extra={extra}");
    if (missing > 0 || extra > 0) mismatch += missing + extra;
    foreach (var entry in srcEntries) {
        if (!src.TryGetFileBytes(entry.Id, out var a, autoDecompress: true) ||
            !dst.TryGetFileBytes(entry.Id, out var b, autoDecompress: true) ||
            !a.AsSpan().SequenceEqual(b)) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} CONTENT MISMATCH");
            mismatch++; continue;
        }
        dst.Tree.TryGetFile(entry.Id, out var de);
        if (de.Version != entry.Version || de.Iteration != entry.Iteration) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} META MISMATCH v{entry.Version}/{de.Version} it{entry.Iteration}/{de.Iteration}");
            mismatch++; continue;
        }
        verified++;
        if (verified % 10000 == 0) Console.WriteLine($"  ... verified {verified}/{srcEntries.Count}");
    }
    Console.WriteLine($"verified={verified} mismatch={mismatch}");
}

Console.WriteLine($"source file: {new FileInfo(srcPath).Length:N0} bytes");
Console.WriteLine($"output file: {new FileInfo(outPath).Length:N0} bytes");
return (failed > 0 || mismatch > 0) ? 1 : 0;
