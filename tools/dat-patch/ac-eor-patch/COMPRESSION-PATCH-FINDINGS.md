# trevis DAT-compression client patch — findings toward derivation (2026-08-16)

Goal: enable the EOR client to read zlib-compressed DAT records (~40-50%
portal.dat saving) — the headroom the phase-2 "4x textures + full dungeon
relief" plan assumes. From a Discord-archive search + local RE.

## Mechanism (community, HIGH confidence — trevis + Yonneh, utilitybelt Nov 2024 / general Feb 2026)
- Per-record compressed flag = **bit 0 of the BTEntry first byte**
  (`FLAG_COMPRESSED = 0x01`). The EOR client ALREADY has the full zlib path.
- `DiskController::LoadDataEx` checks the flag and calls
  `DiskController::Decompress` -> zlib `uncompress` (stock `zlib1.dll`; no
  specific version required per Yonneh).
- **THE BUG:** `DiskController::Decompress` sets `Cache_Pack_t.m_iVersion = 0`
  on success instead of copying the version word from the BTEntry. Later
  `AsyncCache::SerializeFromCachePack` tests `m_iVersion != 0` and fails.
- **THE FIX = one byte:** either (a) in `SerializeFromCachePack`, flip/neuter
  the `m_iVersion != 0` guard (conditional jump), or (b) in `Decompress`,
  change the store-0 to preserve the BTEntry version word. trevis calls it a
  "one byte client patch."
- **CAVEAT (paradox):** compression is a late-engine feature (ac2/ddo/lotro)
  never used in ac1; the `m_iVersion = 0` line "may be a hack to stop some
  other bug relating to compression." => the 1070 load-test is NOT a
  formality; it must verify real records decompress correctly across a full
  portal, not merely that the client boots.

## Symbol addresses (Yonneh EOR map `yonneh-acclient.map`, seg1=.text VA base 0x401000)
- `AsyncCache::SerializeFromCachePack(DBObj*, Cache_Pack_t&)` = 0001:00016810 -> VA 0x417810
- `Cache_Pack_t` ctors/accessors cluster 0x00016350-0x000165F0
- `DiskController::Decompress` (Discord-derived) VA ~0x00670A80
- zlib in-exe thunks: uncompress 0x0079360C, compress2 0x00793610

## BUILD-MATCH STATUS (the trap)
- Our exe `/mnt/wbterminal2/ac-eor-patch/acclient.exe` == Yonneh's 20241005
  EOR exe (same 4,841,472 B; 43 in-place byte diffs — a minor variant).
- Yonneh's MAP is dated 20250309 and matches his 20250309 exe (4,837,376 B —
  DIFFERENT size), so map addresses DO NOT land exactly in our exe:
  VA 0x417810 in ours = `c2 0c 00` (ret 0xc) + NOP pad; the function body is
  at 0x417820 and is a small vtable wrapper (`call [eax+0x98]; test eax,eax;
  je; call [edx+0x10]`) — NOT the m_iVersion guard. So the guard is in a
  callee or offset. **Must locate by byte-signature / decomp-pattern match,
  NOT by the quoted address** (the map/exe/decomp are three different builds).
- PE facts for our exe: image base 0x400000, .text VA 0x401000 = file 0x1000
  (file_offset = VA - 0x400000). `objdump -d -M intel acclient.exe` reads it
  natively (pei-i386). No capstone; objdump present.

## What remains to finish the derivation
1. In the decomp (acclient.c `AsyncCache::SerializeFromCachePack`), read the
   exact `m_iVersion` guard: which compare, jz vs jnz, and what one-byte flip
   makes it always-pass. (decomp Explore agent in flight on this.)
2. Match that C to the disassembly in OUR acclient.exe by a unique
   byte-signature around the guard; extract the literal byte + file offset.
3. Add it to `patch_client.py` as a registry entry `dat-decompress` (candidate).
4. Build a compressed TEST portal (compress ONLY texture 0x06 records via DRW
   -> ACE's non-inflating loader never reads them) and load it on the 1070
   with the patched exe: verify entry + patched-wall render + no missing-tex
   magenta + soak (the paradox caveat).

## Attribution
trevis (discovery + diagnosis + savings), Yonneh (RE: LoadDataEx decompile,
map, zlib hooks), paradox (late-engine context + the "may mask another bug"
caveat), Ripley (zlib/pcap confirmation).

## UPDATE 2026-08-16 PM — patch DERIVED+VERIFIED, compressor built, DRW reader bug found

- **Patch located + verified** (see patch_client.py `dat-decompress`): NOP the
  `je` at file 0x017B28 (`74 71`->`90 90`) in AsyncCache::SerializeFromCachePack.
  Unique signature `83c4043bf774713bc7746d56c7442410`, disasm-confirmed in our
  exe. Test exe `acclient.eor.compress-TEST.exe` = leak-fix + mip16 + decompress.
- **DatCompress tool built** (tools/dat-patch/DatCompress/, DRW nuget 2.1.2):
  compresses 0x06 RenderSurface records only (ACE never reads them). Measured
  **~43% on texture records** (matches trevis 40-50%). Raw-bytes passthrough
  via DRW TryWriteCompressedBytes; incompressible DXT left alone.
- **On-disk data PROVEN correct**: a full-read zlib inflate of the stored bytes
  (== what the client's zlib `uncompress` does) byte-matches the originals;
  realCorruption=0.
- **DRW C# READER BUG (found, not ours):** DatDatabase.Decompress does a single
  `ZLibStream.Read(dest)` which under-fills large records (Stream.Read isn't
  guaranteed to fill the span) -> our tooling can't re-read compressed records
  via DRW until it loops. Does NOT affect the retail client (zlib uncompress
  fills fully) or ACE (never reads 0x06). Fix upstream: loop the Read in
  DatDatabase.Decompress (both Span and byte[] overloads). Filed as a follow-up.
- **Headroom realized as free blocks:** compression frees interior blocks; the
  file doesn't auto-shrink but phase-2 additions reuse the freed space (or add a
  compaction pass to shrink the file). Ceiling is a file-SIZE (31-bit offset)
  limit, so track max-used-block, not record-sum.
- **Still gated:** 1070 load of a compressed portal with the patched exe +
  round-trip render check (paradox caveat: version-0 unpack uses default schema).

## 1070 IN-CLIENT TEST 2026-08-16 16:12 — COMPRESSION PATCH VALIDATED (rendering)
Patched box client (leak+mip16+decompress on the box's own 4,837,376 build,
dat-decompress @ file 0x17878 by signature) + the FULLY COMPRESSED r6 portal
(45% saving) vs ACE on uncompressed r6:
- Client LOADED the compressed portal (no crash at dat load), authed, ENTERED
  WORLD, and RENDERED decompressed textures correctly at 1920x1080
  (gate-shot13.png: stone walls + ground textured). => the dat-decompress
  patch works end-to-end at the render level. PHASE-2 HEADROOM IS REAL.
- Resolution patch (1920x1080) + VeryHigh detail also confirmed live.
The one-byte NOP of the m_iVersion!=0 reject is correct and sufficient.
