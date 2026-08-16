// DatCompress — re-write a portal.dat's texture records (0x06 RenderSurface) as
// zlib-compressed (IsCompressed b-tree flag) to prove trevis's DAT-decompression
// client patch and reclaim ~40-50% of the texture bulk.
//
// TEXTURE-RECORDS-ONLY by default: ACE.DatLoader has no inflate path, but the
// headless server never reads 0x06 RenderSurface records, so it stays happy.
// Raw-bytes passthrough (DRW's TryWriteCompressedBytes) — no typed re-serialize.
//
// usage: DatCompress <portal.dat> [--verify] [--limit N] [--iter N]
//   Rewrites IN PLACE (copy first). --verify re-reads each record decompressed
//   and byte-compares against the pre-compression bytes. Incompressible records
//   (already-tight DXT) are left uncompressed by DRW — reported, not an error.
using System.IO.Compression;
using DatReaderWriter;
using DatReaderWriter.Enums;
using DatReaderWriter.Options;
using DatReaderWriter.Lib.IO.DatBTree;

// Full-read zlib inflate (DRW's built-in Decompress does a single
// ZLibStream.Read that under-fills large records — Stream.Read is not
// guaranteed to fill the buffer). This loops until EOF, so it reflects what
// the retail client's zlib `uncompress` produces from the on-disk bytes.
static byte[] ManualInflate(byte[] stored)
{
    uint usize = BitConverter.ToUInt32(stored, 0);
    var outp = new byte[usize];
    using var ms = new MemoryStream(stored, 4, stored.Length - 4);
    using var z = new ZLibStream(ms, CompressionMode.Decompress);
    int got = 0;
    while (got < outp.Length)
    {
        int r = z.Read(outp, got, outp.Length - got);
        if (r <= 0) break;
        got += r;
    }
    return outp;
}

if (args.Length < 1) { Console.Error.WriteLine("usage: DatCompress <portal.dat> [--verify] [--limit N] [--iter N]"); return 2; }
string path = args[0];
bool verify = args.Contains("--verify");
int limit = -1, iter = 1;
for (int i = 1; i < args.Length - 1; i++)
{
    if (args[i] == "--limit") int.TryParse(args[i + 1], out limit);
    if (args[i] == "--iter") int.TryParse(args[i + 1], out iter);
}

using var portal = new PortalDatabase(path, DatAccessType.ReadWrite);

// RenderSurface = DB type 0x06, id range 0x06000000..0x06FFFFFF
var ids = portal.Tree.GetFilesInRange(0x06000000u, 0x06FFFFFFu).Select(f => f.Id).ToList();
Console.WriteLine($"RenderSurface (0x06) records: {ids.Count}");

long rawTotal = 0, compTotal = 0;
int compressed = 0, incompressible = 0, skipped = 0, failed = 0, mismatch = 0, seen = 0, drwReaderBug = 0;

foreach (var id in ids)
{
    if (limit >= 0 && seen >= limit) break;
    seen++;
    if (!portal.Tree.TryGetFile(id, out var entry)) { skipped++; continue; }
    if (entry.Flags.HasFlag(DatBTreeFileFlags.IsCompressed)) { skipped++; continue; }
    if (!portal.TryGetFileBytes(id, out var before, autoDecompress: true)) { skipped++; continue; }

    uint onDiskBefore = entry.Size;
    var res = portal.TryWriteCompressedBytes(id, before, before.Length, iter);
    if (!res.Success) { Console.Error.WriteLine($"  0x{id:X8} write failed: {res.Error}"); failed++; continue; }

    portal.Tree.TryGetFile(id, out var entry2);
    bool didCompress = entry2.Flags.HasFlag(DatBTreeFileFlags.IsCompressed);
    if (didCompress) { compressed++; rawTotal += onDiskBefore; compTotal += entry2.Size; }
    else incompressible++;

    if (verify)
    {
        if (!portal.TryGetFileBytes(id, out var after, autoDecompress: true) || !before.AsSpan().SequenceEqual(after))
        {
            // Is the ON-DISK data actually good? Read raw (no auto-decompress)
            // and inflate with a full-read loop == what the retail client sees.
            bool diskGood = false;
            if (portal.TryGetFileBytes(id, out var rawStored, autoDecompress: false))
            {
                try { diskGood = before.AsSpan().SequenceEqual(ManualInflate(rawStored)); } catch { }
            }
            if (diskGood) drwReaderBug++;
            else
            {
                int firstDiff = -1, nDiff = 0;
                int n = Math.Min(before.Length, after?.Length ?? 0);
                for (int k = 0; k < n; k++) if (before[k] != after![k]) { if (firstDiff < 0) firstDiff = k; nDiff++; }
                Console.Error.WriteLine($"  0x{id:X8} REAL CORRUPTION len {before.Length}/{after?.Length} firstDiff@{firstDiff} nDiff={nDiff}");
                mismatch++;
            }
        }
    }
    if (seen % 500 == 0) Console.WriteLine($"  ... {seen}/{ids.Count}  (compressed {compressed})");
}

Console.WriteLine($"compressed={compressed} incompressible={incompressible} skipped={skipped} failed={failed} realCorruption={mismatch} drwReaderUnderReadButDiskOK={drwReaderBug}");
if (rawTotal > 0)
    Console.WriteLine($"compressed-record bytes: {rawTotal / 1048576.0:F1} MiB -> {compTotal / 1048576.0:F1} MiB ({100.0 * compTotal / rawTotal:F1}%)");
return (failed > 0 || mismatch > 0) ? 1 : 0;
