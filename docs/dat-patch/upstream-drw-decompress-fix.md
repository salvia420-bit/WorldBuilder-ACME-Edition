# Upstream DRW bug: `DatDatabase.Decompress` truncates large compressed records

Status: **patch staged, not yet posted.** Local commit `7436a17` in
`external/DatReaderWriter` (vendored sparse checkout, origin =
github.com/Chorizite/DatReaderWriter — DO NOT PUSH from the vendored copy;
open a proper fork/PR). Found 2026-08-16 while building the phase-2
`DatCompress` lane (see `COMPRESSION-PATCH-FINDINGS.md` in
/mnt/wbterminal2/ac-eor-patch/).

Until this ships in a nuget release, **no DRW-nuget consumer (WB.Terminal,
DatCompress, ACE-with-DRW) can reliably READ compressed records** — our
verification lanes use a manual full-read inflate instead.

## Ready-to-post issue/PR body

Title: `Decompress: single ZLibStream.Read under-fills large records`

On .NET 8+, `DatDatabase.Decompress(ReadOnlySpan<byte>, Span<byte>)` does a
single

```csharp
return zlibStream.Read(destination);
```

`Stream.Read` is not guaranteed to fill the destination — it may return any
positive number of bytes — and `ZLibStream` routinely returns short reads for
records larger than its internal buffer. Result: any compressed record over
that size comes back **silently truncated** through `TryGetFileBytes` /
`TryGetFileBytesAsync` / `TryGetRawFileBytes` (the `byte[]` overload delegates
to the span overload, so both are affected). The retail client is unaffected
(zlib `uncompress` fills fully); this is a DRW-reader-only bug, but it makes
DRW unable to round-trip dats containing compressed records that DRW's own
`TryWriteCompressedBytes` produced.

Repro: write any record whose uncompressed size is a few hundred KiB (e.g. a
2048² DXT5 RenderSurface, ~5.3 MiB) with `TryWriteCompressedBytes`, re-open the
dat, `TryGetFileBytes` → returned buffer is correct length (allocated from the
BTEntry size) but only the head is inflated; the tail is zeros.

Fix — loop until the stream drains or the destination is full:

```csharp
using var outputStream = new System.IO.MemoryStream(data.Slice(4).ToArray());
using var zlibStream = new ZLibStream(outputStream, CompressionMode.Decompress);
var totalRead = 0;
int read;
while (totalRead < destination.Length &&
       (read = zlibStream.Read(destination.Slice(totalRead))) > 0) {
    totalRead += read;
}
return totalRead;
```

(The pre-net8 `ZLibDotNet.Uncompress` branch fills fully and is fine.)
