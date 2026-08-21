// DatRecordInsert -- insert raw record bytes into an existing dat, insert-only.
//
// The Phase-4 coverage fill writes DXT records through WorldBuilder.Terminal
// (BCnEncoder), but the PALETTE route produces INDEX16/P8 records that no PNG
// importer can express: index data against the record's own palette. This tool
// lands those bytes.
//
// ⚠ NO DELETES. DRW's Tree.TryDelete corrupts the b-tree at scale
// (docs/dat-patch/upstream-drw-btree-delete-fix.md) — this tool only ever
// writes, and refuses if a target id already exists unless --overwrite.
//
// usage: DatRecordInsert <dat> <manifest.json> [--overwrite] [--dry-run] [--compress]
//   --compress: store each record zlib-compressed (IsCompressed b-tree flag)
//   at insert time. Landing compressed matters on a large fill: an uncompressed
//   insert followed by DatCompress leaks the freed tail blocks (DRW's WriteBlock
//   never returns them to the free chain), so the file only ever grows.
//   ⚠ --compress is CLIENT-ONLY: vanilla ACE has no record decompression
//   (ACE.DatLoader parses the raw zlib bytes as the record and dies), so it is
//   refused for any type the server reads. Only the texture family (0x05/0x06)
//   is server-safe compressed; --force-compress overrides for a client-only dat
//   that ACE will never serve. Found 2026-08-21 (1,209 compressed 0x01s killed
//   ACE at boot).
//   manifest.json: {"inserts":[{"id":"0x06001234","path":"/…/0x06001234.bin"}, …]}
using System.Text.Json;
using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;
using DatReaderWriter.Lib.IO.BlockAllocators;

if (args.Length < 2) {
    Console.Error.WriteLine("usage: DatRecordInsert <dat> <manifest.json> [--overwrite] [--dry-run]");
    return 2;
}
string datPath = args[0], manifestPath = args[1];
bool overwrite = args.Contains("--overwrite"), dry = args.Contains("--dry-run");
bool compress = args.Contains("--compress") || args.Contains("--force-compress");
bool forceCompress = args.Contains("--force-compress");

string baseDats = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ac_base_dats");
if (Path.GetFullPath(datPath).StartsWith(Path.GetFullPath(baseDats))) {
    Console.Error.WriteLine($"refusing to write under {baseDats}");
    return 2;
}

using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
var inserts = doc.RootElement.GetProperty("inserts");
Console.WriteLine($"manifest: {inserts.GetArrayLength()} records -> {datPath}");

// vanilla ACE cannot decompress records; a compressed record of any type the
// server reads (GfxObj, Setup, Environment, ...) kills it at load. Only the
// texture family is known server-safe compressed.
if (compress && !forceCompress) {
    var unsafeIds = inserts.EnumerateArray()
        .Select(e => Convert.ToUInt32(e.GetProperty("id").GetString()!.Replace("0x", ""), 16))
        .Where(id => (id >> 24) != 0x05 && (id >> 24) != 0x06)
        .ToList();
    if (unsafeIds.Count > 0) {
        Console.Error.WriteLine($"refusing --compress: {unsafeIds.Count} record(s) outside the server-safe 0x05/0x06 texture family (first: 0x{unsafeIds[0]:X8}).");
        Console.Error.WriteLine("vanilla ACE has no record decompression and dies serving these; use --force-compress only for a client-only dat ACE never serves.");
        return 2;
    }
}

static PortalDatabase Open(string path, DatAccessType access) => new PortalDatabase(
    o => { o.FilePath = path; o.AccessType = access; },
    new StreamBlockAllocator(new DatDatabaseOptions { FilePath = path, AccessType = access }));

int written = 0, skippedExisting = 0, failed = 0;
long bytes = 0;
{
    using var dat = Open(datPath, dry ? DatAccessType.Read : DatAccessType.ReadWrite);
    foreach (var e in inserts.EnumerateArray()) {
        uint id = Convert.ToUInt32(e.GetProperty("id").GetString()!.Replace("0x", ""), 16);
        string path = e.GetProperty("path").GetString()!;
        if (dat.Tree.TryGetFile(id, out _) && !overwrite) { skippedExisting++; continue; }
        var raw = File.ReadAllBytes(path);
        if (dry) { written++; bytes += raw.Length; continue; }
        var res = compress
            ? dat.TryWriteCompressedBytes(id, raw, raw.Length, 1)  // iteration 1: a fresh record
            : dat.TryWriteFileBytes(id, raw, raw.Length, 1);
        if (!res.Success) { Console.Error.WriteLine($"  0x{id:X8} write failed: {res.Error}"); failed++; continue; }
        written++; bytes += raw.Length;
        if (written % 500 == 0) Console.WriteLine($"  ... {written} written");
    }
}
Console.WriteLine($"written={written} skipped-existing={skippedExisting} failed={failed} bytes={bytes:N0}");

// readback: every inserted record must come back byte-identical
if (!dry && written > 0) {
    using var back = Open(datPath, DatAccessType.Read);
    int verified = 0, mismatch = 0;
    foreach (var e in inserts.EnumerateArray()) {
        uint id = Convert.ToUInt32(e.GetProperty("id").GetString()!.Replace("0x", ""), 16);
        string path = e.GetProperty("path").GetString()!;
        if (!back.TryGetFileBytes(id, out var got, autoDecompress: true)) { mismatch++; continue; }
        var want = File.ReadAllBytes(path);
        if (got.Length != want.Length || !got.AsSpan().SequenceEqual(want)) { mismatch++; continue; }
        verified++;
    }
    Console.WriteLine($"readback verified={verified} mismatch={mismatch}");
    if (mismatch > 0) return 1;
}
return failed > 0 ? 1 : 0;
