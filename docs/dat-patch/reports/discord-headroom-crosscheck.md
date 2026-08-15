# Discord community cross-check of the client-headroom dossier (2026-08-15)

Explore-agent sweep of the archived dev-community Discord (`ac.db`, 477,753 msgs, 79
channels) against `client-headroom-dossier.md`. Verdicts per claim; channel · author ·
date cited. RESOLUTION of the one hard contradiction appended at the end (§8) after
direct verification on this machine.

## 1. trevis's DAT-compression fix — CONFIRMED in detail by its author

- trevis (utilitybelt, 2024-11-05) posted the exact mechanism the dossier found:
  "DiskController::Decompress sets the m_iVersion to 0 on successful decompression,
  which breaks a check for m_iVersion being not 0 in AsyncCache::SerializeFromCachePack"
  — and RAN it in the client: "if i manually set it after DiskController::LoadDataEx,
  the client loads the compressed version fine"; "a one byte client patch would enable
  reading compressed dats".
- Measured (general, 2026-02-02, zlib level 9, patched client, confirmed working):
  portal **49.97%** saved (463,170,560 B), highres 48.75%, **cell_1 only 10.82%**,
  local_English 75.49% — whole set 1,409,286,144 → 842,742,784 = **40.2%**, not 50%.
  Treat cell data as already-dense.
- On-disk flag: "if the lowest bit on a BTreeEntry is 1, the data is zlib compressed"
  (FLAG_COMPRESSED = 0x01). Client ships **zlib 1.2.2** (Yonneh posted the source +
  shipped zlib1.dll/pdb, general 2024-11-02) — match the version.
- ⚠ paradox (retail-era AC dev; general 2026-02-02): "setting it to zero may have been
  a hack to stop some other bug relating to compression" — the zeroing may be a
  deliberate workaround; re-enabling could resurface whatever it hid. Highest-authority
  caution in the archive.
- trevis himself declined to ship it for the retail client — for DISTRIBUTION/trust
  reasons, not technical ("having to include a client patch to enable it makes me not
  want to use it at all") — shipped it in DatReaderWriter only (2026-02-03). **No patch
  bytes/offsets were ever posted; nobody else has applied or tested it.** We would
  derive the bytes ourselves by byte-signature.

## 2. LAA / memory ceiling — dossier CONTRADICTED for retail; resolved in §8

- paradox (chorizite, 2024-10-21): "you can edit the large memory aware bits in the
  exe to enable it. **we didn't during retail** b/c the launcher hashed the client";
  "can't memory patch that though, has to be in the image before execution"; retail
  staff internally kept a patched copy ("a pain to maintain w/updates").
- Hells (multiple, 2024): "acclient can only consume 2gb ... will crash closer to
  1.6-1.8" — the crash band of a NON-LAA process. trevis repeatedly wished for a "4gb
  acclient patch" and linked ntcore.com/4gb-patch — the community treats LAA as a thing
  to be patched IN.
- The real OOM driver is the **icon-generation leak** (Hells/OptimShi: "The more you
  loot ... the faster it crashes"; "Don't create icons, don't get terrible leak"), plus
  notan's now-FIXED Palette::makeModifiedPalette refcount leak (May 2026, ~99% for that
  class, patch bytes public — the ac-eor-patch NOPs) and a **suspected unfixed D3DXMesh
  leak**. paradox/trevis: LAA alone only delays the leak-driven crash. But trevis's
  stated want is exactly our use case: "i need a 4gb capable acclient ... can use the
  extra 2gb **for dats**".
- Allocator prints SIGNED sizes ("Failed to allocate -235929600 bytes") — int32 size
  math in the allocation path.

## 3. Texture detail — CONFIRMED empirically; symbol names EXTENDED

- `EnvironmentTextureDetail` / `SetOverallGraphicsQuality`: zero archive hits (decomp-
  only knowledge; dossier stands unchallenged).
- gmriggs (worldbuilder, 2026-02-20) independently hit the two-entry half-res
  SurfaceTexture with real IDs: 0x05000A70 → [0] highres 0x06003CAE 256×64 /
  [1] portal 0x06003CAF 128×32.
- Crimson/Zan (vitaeum-client, 2026-05-15) name the retail gate:
  **ImgTex::GetSurfaceDID chooses source level via Render::ShouldDropHighDetail()**,
  and **ImgTex::CreateD3DTexture caps mip levels at 4** then D3DXFilterTexture — the
  4-mip cap is new information for the big-texture plan (2048² → coarsest mip 256²).

## 4. Degrade/LOD — structure CONFIRMED; our trap is NOVEL territory

- Band structure/fields confirmed (Crimson/Zan 2026-05-15; OptimShi 2026-03-24:
  "320 polys vs 127 (middle option is 227)").
- **Nobody in the archive has ever hit the invisible-replaced-GfxObj trap** — every
  modder invisibility report traces to render-vs-physics geometry instead (z-z,
  2026-06-08). The dossier's decomp finding stands but is untraveled ground: we would
  be the first to replace degrade-carrying GfxObjs. DRW only gained GfxObjDegradeInfo
  parsing 2025-04.
- Adaptive-degrade OFF ≠ degrade off (paradox); degrade doubles fps for trevis —
  swapping models isn't free (GPU buffer swaps / instance batches).

## 5. DAT 2 GiB ceiling — CONFIRMED by paradox, with an open EOR question

- paradox (alt-clients, 2026-03-27): "decent storage medium as long as the content
  doesn't balloon over 2g ... though it may support 4g files in eor. i don't remember
  if it still set the high bit for deleted blocks." Decomp (dossier) says EOR DOES
  retain bit-31 + signed seeks. Nobody has ever grown a dat past 2 GB (trevis's
  proposed 3 GB test, 2024-05, was never reported).
- Defrag is not a lever: measured twice at ~1–2 MB.

## 6. Client binary patching — rich prior art, full byte tables in-archive

- Shipped catalog: Mag-ACClientPatcher (patch source ACClientExePatches.cs), Pea's 4K
  unlock (Yonneh posted full needle/replace byte arrays at file offsets 0x0006128D and
  0x00063D94), Yonneh's AFK anti-logout (0x003CEB70, 1200 s → 10 y), notan's
  palette-leak NOPs ((0x0013effe, ff 40 24→90 90 90), (0x0013f19c, ff 46 24→90 90 90)).
- Method: IDA (preferred over Ghidra for AC); trevis's ACSigGen signature builder;
  ⚠ paradox: "patching import tables is way more reliable than pattern matching".
- **Yonneh's Nov-2024 attachments include release_client.exe.map (4.0 MB) + .h** — a
  symbol map for locating offsets, likely better than re-deriving signatures.
- The community's consistent blocker is distribution TRUST, not technique.

## 7. HD texture injection — essentially unexplored; expert opinion says it works

- Advan (worldbuilder, 2026-02-26): community believes higher-res is supported but
  has never done it; Shin-era tooling FORCED resolution parity, which is why nobody
  found out. Vanquish420 announced an AI-upscale injection test — no follow-up exists.
- trevis's ceiling opinion: "the dats should be totally cool with it, and client code,
  but dx9 is generally 4096x4096, or 2048x2048 for max compatibility ... maybe power
  of 2 as well."
- Known blocker class: palettized/indexed formats (OptimShi 2023-04-22; the DRW
  0x06004CB3 replacement failure 2026-03/04). Our DXT re-encode lane avoids this;
  keep INDEX16 textures out of scope or handle palettes explicitly.

## 8. RESOLUTION of the LAA contradiction (verified on this machine, this session)

Direct PE read of /home/wbterminal/ac_base_dats/acclient.exe: link date 2015-06-12,
COFF Characteristics **0x012E → LAA bit IS set**, CheckSum 0x004A60C3,
sha256 bca95bbebed4b9ed1ff09d0da83144e2fc4208f63ad7ada5cb47c3ca207ccba9.
Given paradox's authoritative "we didn't during retail": **our reference copy is
almost certainly an already-4GB-patched exe** (ntcore-style patch flips exactly this
bit and recomputes the checksum, which is why checksum validation doesn't detect it).
Corrected claims: retail did NOT ship LAA; the 4GB patch is real, trivial, community-
standard, and ALREADY APPLIED to our base copy; community crash reports at 1.6–1.8 GB
describe unpatched clients. Bank the patch, but measure actual headroom (leaks, not
address space, drive the OOM band).

## Bonus findings

- acclient.exe has ~20 undocumented CLI switches (Yonneh/OptimShi, 2024-10-11/12):
  -debug:<bitfield> gates a built-in debug console + profiling UI ("the location debug
  ui works") — free instrumentation channel for memory/LOD investigation.
- WorldBuilder's --disable-bindless fixed intermittently-disappearing
  compressed-texture objects (2026-03-02) — relevant if our renderer work touches
  bindless + compressed textures.
