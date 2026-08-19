// DatHifiSplit — the r8 HIFI split (PLAN Phase 3, variant B, trevis's form).
// Moves OUR baked 0x06 payload out of the portal into client_highres.dat and
// deletes the portal copies: once highres precedence serves our record
// (CLCache::GetDiskController probes slot 3 first), the portal copy is dead
// weight. Deletion frees interior blocks only — run DatCompact on both outputs
// afterwards to land the file-size win.
//
// usage: DatHifiSplit <src-portal> <src-highres> <ours-ids.txt> <out-portal> <out-highres> [--verify]
//   ours-ids.txt: one 0x-prefixed hex id per line (from ours_diff.py — the ids
//   whose r7.2 portal bytes differ from the retail base).
//   Outputs are fresh copies of the sources; refuses to overwrite. --verify
//   re-reads EVERY record of both outputs against the sources (moved ids must
//   be gone from the portal and byte-identical in the highres; everything else
//   byte-identical where it started).
using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;
using DatReaderWriter.Lib.IO.DatBTree;
using DatReaderWriter.Lib.IO.BlockAllocators;

if (args.Length < 5) {
    Console.Error.WriteLine("usage: DatHifiSplit <src-portal> <src-highres> <ours-ids.txt> <out-portal> <out-highres> [--verify]");
    return 2;
}
string srcPortalPath = args[0], srcHighresPath = args[1], idsPath = args[2],
       outPortalPath = args[3], outHighresPath = args[4];
bool verify = args.Contains("--verify");

string baseDats = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ac_base_dats");
foreach (var p in new[] { outPortalPath, outHighresPath }) {
    if (Path.GetFullPath(p).StartsWith(Path.GetFullPath(baseDats))) {
        Console.Error.WriteLine($"refusing to write under {baseDats}"); return 2;
    }
    if (File.Exists(p)) { Console.Error.WriteLine($"out exists: {p} — remove it first"); return 2; }
}

var oursIds = File.ReadAllLines(idsPath)
    .Select(l => l.Trim()).Where(l => l.Length > 0)
    .Select(l => Convert.ToUInt32(l, 16)).ToList();
var oursSet = oursIds.ToHashSet();
Console.WriteLine($"ours ids: {oursIds.Count}");

Console.WriteLine($"copying {srcPortalPath} -> {outPortalPath}");
File.Copy(srcPortalPath, outPortalPath);
Console.WriteLine($"copying {srcHighresPath} -> {outHighresPath}");
File.Copy(srcHighresPath, outHighresPath);

static PortalDatabase Open(string path, DatAccessType access) => new PortalDatabase(
    o => { o.FilePath = path; o.AccessType = access; },
    new StreamBlockAllocator(new DatDatabaseOptions { FilePath = path, AccessType = access }));

using var srcPortal = Open(srcPortalPath, DatAccessType.Read);
using var outPortal = Open(outPortalPath, DatAccessType.ReadWrite);
using var outHighres = Open(outHighresPath, DatAccessType.ReadWrite);

// sanity: every ours id must exist in the source portal; none may pre-exist in the highres
var highresPre = outHighres.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
int missingInPortal = 0, preexisting = 0;
foreach (var id in oursIds) {
    if (!srcPortal.Tree.TryGetFile(id, out _)) { Console.Error.WriteLine($"  0x{id:X8} NOT in src portal"); missingInPortal++; }
    if (highresPre.Contains(id)) preexisting++;
}
if (missingInPortal > 0) { Console.Error.WriteLine($"{missingInPortal} ours ids missing from the source portal — wrong list"); return 3; }
// Ours ids ALREADY in the highres are the r7.1 highres-lane records: same target
// dims as the portal bake but built from the 2x highres source (half the
// hallucination budget) and mip-QA'd. KEEP those; only delete the portal copy.
Console.WriteLine($"highres pre-existing records: {highresPre.Count}; ours ids already present there: {preexisting} (KEPT — portal copy deleted only)");

int moved = 0, kept = 0, deleted = 0, failed = 0;
foreach (var id in oursIds) {
    if (highresPre.Contains(id)) {
        kept++;
    } else {
        srcPortal.Tree.TryGetFile(id, out var entry);
        if (!srcPortal.TryGetFileBytes(id, out var plain, autoDecompress: true)) {
            Console.Error.WriteLine($"  0x{id:X8} source read failed"); failed++; continue;
        }
        bool wasCompressed = entry.Flags.HasFlag(DatBTreeFileFlags.IsCompressed);
        var res = wasCompressed
            ? outHighres.TryWriteCompressedBytes(id, plain, plain.Length, entry)
            : outHighres.TryWriteFileBytes(id, plain, plain.Length, entry);
        if (!res.Success) { Console.Error.WriteLine($"  0x{id:X8} highres write failed: {res.Error}"); failed++; continue; }
        if (!outHighres.TryGetFileBytes(id, out var rb, autoDecompress: true) || !plain.AsSpan().SequenceEqual(rb)) {
            Console.Error.WriteLine($"  0x{id:X8} highres READBACK MISMATCH"); failed++; continue;
        }
        moved++;
    }
    if (!outPortal.Tree.TryDelete(id, out _)) {
        Console.Error.WriteLine($"  0x{id:X8} portal delete failed"); failed++; continue;
    }
    deleted++;
    if (deleted % 2000 == 0) Console.WriteLine($"  ... processed {deleted}/{oursIds.Count}");
}
Console.WriteLine($"moved={moved} kept-highres-lane={kept} deleted={deleted} failed={failed}");
if (failed > 0) return 1;

int mismatch = 0;
if (verify) {
    Console.WriteLine("verify: portal sweep");
    var srcEntries = srcPortal.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).ToList();
    var outIds = outPortal.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
    int verified = 0;
    foreach (var entry in srcEntries) {
        if (oursSet.Contains(entry.Id)) {
            if (outIds.Contains(entry.Id)) { Console.Error.WriteLine($"  0x{entry.Id:X8} STILL IN PORTAL"); mismatch++; }
            continue;
        }
        if (!outIds.Contains(entry.Id)) { Console.Error.WriteLine($"  0x{entry.Id:X8} LOST FROM PORTAL"); mismatch++; continue; }
        if (!srcPortal.TryGetFileBytes(entry.Id, out var a, autoDecompress: true) ||
            !outPortal.TryGetFileBytes(entry.Id, out var b, autoDecompress: true) ||
            !a.AsSpan().SequenceEqual(b)) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} PORTAL CONTENT MISMATCH"); mismatch++; continue;
        }
        verified++;
        if (verified % 10000 == 0) Console.WriteLine($"  ... portal verified {verified}");
    }
    var srcIdSet = srcEntries.Select(e => e.Id).ToHashSet();
    int extraInPortal = outIds.Count(id => !srcIdSet.Contains(id));
    if (extraInPortal > 0) { Console.Error.WriteLine($"  {extraInPortal} ids in out portal NOT in source"); mismatch += extraInPortal; }
    Console.WriteLine($"portal survivors verified={verified} extra={extraInPortal} mismatch={mismatch}");

    Console.WriteLine("verify: highres sweep");
    using var srcHighres = Open(srcHighresPath, DatAccessType.Read);
    int hrVerified = 0;
    foreach (var f in outHighres.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu)) {
        byte[]? want = null;
        if (oursSet.Contains(f.Id) && !highresPre.Contains(f.Id)) {
            srcPortal.TryGetFileBytes(f.Id, out want, autoDecompress: true);
        } else if (srcHighres.Tree.TryGetFile(f.Id, out _)) {
            srcHighres.TryGetFileBytes(f.Id, out want, autoDecompress: true);
        } else {
            Console.Error.WriteLine($"  0x{f.Id:X8} UNEXPECTED in out highres"); mismatch++; continue;
        }
        if (want is null || !outHighres.TryGetFileBytes(f.Id, out var got, autoDecompress: true) ||
            !want.AsSpan().SequenceEqual(got)) {
            Console.Error.WriteLine($"  0x{f.Id:X8} HIGHRES CONTENT MISMATCH"); mismatch++; continue;
        }
        hrVerified++;
        if (hrVerified % 5000 == 0) Console.WriteLine($"  ... highres verified {hrVerified}");
    }
    Console.WriteLine($"highres verified={hrVerified} mismatch(total)={mismatch}");
}

Console.WriteLine($"out portal:  {new FileInfo(outPortalPath).Length:N0} bytes (compact to land the win)");
Console.WriteLine($"out highres: {new FileInfo(outHighresPath).Length:N0} bytes");
return mismatch > 0 ? 1 : 0;
