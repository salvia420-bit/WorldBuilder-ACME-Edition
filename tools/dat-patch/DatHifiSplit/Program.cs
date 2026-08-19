// DatHifiSplit — the r8 HIFI split (PLAN Phase 3, variant B, trevis's form).
// Moves OUR baked 0x06 payload out of the portal into client_highres.dat: once
// highres precedence serves our record (CLCache::GetDiskController probes
// slot 3 first), the portal copy is dead weight.
//
// ⚠ NO b-tree DELETES anywhere. DRW's Tree.TryDelete corrupted the tree at
// scale on 2026-08-19 (169/213 requested ids actually removed, 3 INNOCENT
// records lost, 1 phantom id, lookups broken after ~213 deletes). The trimmed
// portal is therefore built by RECONSTRUCTION: a fresh InitNew dat (header
// fields mirrored from the source) into which every source record EXCEPT the
// moved ids is copied. This also lands dense, so the portal needs no separate
// DatCompact pass.
//
// usage: DatHifiSplit <src-portal> <src-highres> <ours-ids.txt> <out-portal> <out-highres> [--verify]
//   ours-ids.txt: one 0x-prefixed hex id per line (from ours_diff.py — the ids
//   whose release-portal bytes differ from the retail base).
//   Outputs must not exist. --verify re-reads EVERY record of both outputs:
//   moved ids absent from the portal and byte-identical in the highres,
//   everything else byte-identical where it started.
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

static PortalDatabase Open(string path, DatAccessType access) => new PortalDatabase(
    o => { o.FilePath = path; o.AccessType = access; },
    new StreamBlockAllocator(new DatDatabaseOptions { FilePath = path, AccessType = access }));

using var srcPortal = Open(srcPortalPath, DatAccessType.Read);

// ---- sanity on the ours list --------------------------------------------
int missingInPortal = oursIds.Count(id => !srcPortal.Tree.TryGetFile(id, out _));
if (missingInPortal > 0) { Console.Error.WriteLine($"{missingInPortal} ours ids missing from the source portal — wrong list"); return 3; }

// ---- 1) highres: copy + insert ours (insert-only, no deletes) -----------
Console.WriteLine($"copying {srcHighresPath} -> {outHighresPath}");
File.Copy(srcHighresPath, outHighresPath);
int moved = 0, kept = 0, failed = 0;
{
    using var outHighres = Open(outHighresPath, DatAccessType.ReadWrite);
    var highresPre = outHighres.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
    // Ours ids ALREADY in the highres would be r7.1 highres-lane records (same
    // target dims, built from the 2x highres source, mip-QA'd): keep those.
    Console.WriteLine($"highres pre-existing records: {highresPre.Count}; ours ids already present there: {oursIds.Count(highresPre.Contains)} (KEPT)");
    foreach (var id in oursIds) {
        if (highresPre.Contains(id)) { kept++; continue; }
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
        if (moved % 500 == 0) Console.WriteLine($"  ... moved {moved}/{oursIds.Count}");
    }
    Console.WriteLine($"highres: moved={moved} kept-highres-lane={kept} failed={failed}");
    if (failed > 0) return 1;
}

// ---- 2) portal: RECONSTRUCT fresh, skipping ours ------------------------
Console.WriteLine($"reconstructing portal -> {outPortalPath} (fresh InitNew, no deletes)");
{
    using var outPortal = Open(outPortalPath, DatAccessType.ReadWrite);
    var sh = srcPortal.Header;
    outPortal.BlockAllocator.InitNew(sh.Type, sh.SubSet, sh.BlockSize, 0);
    outPortal.Header.MasterMapId = sh.MasterMapId;   // persisted by SetVersion's WriteHeader
    outPortal.BlockAllocator.SetVersion(sh.Version ?? "", sh.EngineVersion, sh.GameVersion, sh.MajorVersion, sh.MinorVersion);

    int copied = 0, skipped = 0; failed = 0;
    foreach (var entry in srcPortal.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu)) {
        if (oursSet.Contains(entry.Id)) { skipped++; continue; }
        if (!srcPortal.TryGetFileBytes(entry.Id, out var plain, autoDecompress: true)) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} source read failed"); failed++; continue;
        }
        bool wasCompressed = entry.Flags.HasFlag(DatBTreeFileFlags.IsCompressed);
        var res = wasCompressed
            ? outPortal.TryWriteCompressedBytes(entry.Id, plain, plain.Length, entry)
            : outPortal.TryWriteFileBytes(entry.Id, plain, plain.Length, entry);
        if (!res.Success) { Console.Error.WriteLine($"  0x{entry.Id:X8} write failed: {res.Error}"); failed++; continue; }
        copied++;
        if (copied % 5000 == 0) Console.WriteLine($"  ... copied {copied}");
    }
    Console.WriteLine($"portal: copied={copied} skipped(ours)={skipped} failed={failed}");
    if (failed > 0) return 1;
}

// ---- 3) verify ----------------------------------------------------------
int mismatch = 0;
if (verify) {
    using var outPortalR = Open(outPortalPath, DatAccessType.Read);
    using var outHighresR = Open(outHighresPath, DatAccessType.Read);
    using var srcHighres = Open(srcHighresPath, DatAccessType.Read);

    Console.WriteLine("verify: portal sweep");
    var srcEntries = srcPortal.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).ToList();
    var srcIdSet = srcEntries.Select(e => e.Id).ToHashSet();
    var outIds = outPortalR.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
    int verified = 0;
    foreach (var entry in srcEntries) {
        if (oursSet.Contains(entry.Id)) {
            if (outIds.Contains(entry.Id)) { Console.Error.WriteLine($"  0x{entry.Id:X8} STILL IN PORTAL"); mismatch++; }
            continue;
        }
        if (!outIds.Contains(entry.Id)) { Console.Error.WriteLine($"  0x{entry.Id:X8} LOST FROM PORTAL"); mismatch++; continue; }
        if (!srcPortal.TryGetFileBytes(entry.Id, out var a, autoDecompress: true) ||
            !outPortalR.TryGetFileBytes(entry.Id, out var b, autoDecompress: true) ||
            !a.AsSpan().SequenceEqual(b)) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} PORTAL CONTENT MISMATCH"); mismatch++; continue;
        }
        outPortalR.Tree.TryGetFile(entry.Id, out var de);
        if (de.Version != entry.Version || de.Iteration != entry.Iteration) {
            Console.Error.WriteLine($"  0x{entry.Id:X8} META MISMATCH v{entry.Version}/{de.Version} it{entry.Iteration}/{de.Iteration}");
            mismatch++; continue;
        }
        verified++;
        if (verified % 10000 == 0) Console.WriteLine($"  ... portal verified {verified}");
    }
    int extraInPortal = outIds.Count(id => !srcIdSet.Contains(id));
    if (extraInPortal > 0) { Console.Error.WriteLine($"  {extraInPortal} ids in out portal NOT in source"); mismatch += extraInPortal; }
    Console.WriteLine($"portal survivors verified={verified} extra={extraInPortal} mismatch={mismatch}");

    Console.WriteLine("verify: highres sweep");
    var srcHighresIds = srcHighres.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu).Select(f => f.Id).ToHashSet();
    int hrVerified = 0;
    foreach (var f in outHighresR.Tree.GetFilesInRange(0x00000000u, 0xFFFFFFFFu)) {
        byte[]? want = null;
        if (srcHighresIds.Contains(f.Id)) {
            srcHighres.TryGetFileBytes(f.Id, out want, autoDecompress: true);
        } else if (oursSet.Contains(f.Id)) {
            srcPortal.TryGetFileBytes(f.Id, out want, autoDecompress: true);
        } else {
            Console.Error.WriteLine($"  0x{f.Id:X8} UNEXPECTED in out highres"); mismatch++; continue;
        }
        if (want is null || !outHighresR.TryGetFileBytes(f.Id, out var got, autoDecompress: true) ||
            !want.AsSpan().SequenceEqual(got)) {
            Console.Error.WriteLine($"  0x{f.Id:X8} HIGHRES CONTENT MISMATCH"); mismatch++; continue;
        }
        hrVerified++;
        if (hrVerified % 2000 == 0) Console.WriteLine($"  ... highres verified {hrVerified}");
    }
    // moved ids must all be present
    int hrMissing = oursIds.Count(id => !outHighresR.Tree.TryGetFile(id, out _));
    if (hrMissing > 0) { Console.Error.WriteLine($"  {hrMissing} ours ids MISSING from out highres"); mismatch += hrMissing; }
    Console.WriteLine($"highres verified={hrVerified} missingOurs={hrMissing} mismatch(total)={mismatch}");
}

Console.WriteLine($"out portal:  {new FileInfo(outPortalPath).Length:N0} bytes (dense — reconstructed)");
Console.WriteLine($"out highres: {new FileInfo(outHighresPath).Length:N0} bytes (compact separately)");
return mismatch > 0 ? 1 : 0;
