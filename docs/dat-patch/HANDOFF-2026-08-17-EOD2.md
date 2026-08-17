# HANDOFF — 2026-08-17 EOD2 (G4 GATE PASSED; crash = EOR-exe-specific; r7 fully exonerated)

Read with: docs/dat-patch/TASKLIST-2026-08-17.md (sections A-H all current) and the
prior HANDOFF-2026-08-17-EOD.md (superseded where it conflicts with this file).

## Headline
1. **G4/B3 ship gate PASSED** on the wine/T4 buildbox: `acclient.box-decompress-TEST.exe`
   (4,837,376 build, dat-decompress only) + r7 TRUE-4x dats, VeryHigh 1920x1080 —
   clean 6-stop chat-driven tour (Holtburg, Yaraq, Cave of Alabree, Underground
   Passage, Braid Mansion Ruin, Muggy Guruk Caverns) + soak, alive=1 faults=0
   throughout; ALSO survived an accidental doubled tour (two drivers interleaving
   teleports into one client) fault-free. Muggy frame matches the r6 Windows armC
   reference in render character; the squarish interior crunch remains (r7.1 deblock).
   Tour driver: box `~/gate-tour.sh` (xdotool chat @telepoi/@teledungeon; dest cells
   resolved from ace_world portal weenies).
2. **Yesterday's "one open blocker" is closed as an exe-build issue, not r7.** The
   wine-async lead theory is dead: the client has NO overlapped I/O (DiskDev =
   synchronous SetFilePointer+ReadFile behind CThreadsafeDiskController's critical
   section; arg table has no IO switch). Crash forensics (frozen process, /proc/mem):
   hook-list deserializer (`CAnimHook::UnPackHook` → `SoundTweakedHook::UnPack`)
   running with an UNDERFLOWED remaining-size (0xFC59BCE8) under a live
   SerializeFromCachePack frame — the cursor walks the heap to an unmapped page.
   Yesterday's "AnimData::UnPack wild read" is the same mechanism, different victim.
3. **Isolation matrix** (all wine/T4, same prefix/INI/VideoMemorySize=2048):
   - EOR exe (4,841,472) decompress-only + r7 → CRASH (world entry / ~30s)
   - box exe (4,837,376) decompress-only + r7 → STABLE (soak + 3 tours)
   - EOR exe decompress-only + compressed-UNcompacted retail → STABLE
   - EOR exe decompress-only + compressed+COMPACTED retail (arm 4) → STABLE.
   ⇒ Compression mechanics AND DatCompact layout are both exonerated as the r7-side
   factor: the EOR build fails only with the TRUE-4x content (sustained multi-MB
   texture inflates). H8 hunt narrowed to size-scaled paths (buffer growth/pool
   thresholds, version-0 pack handling at large sizes).
   Also exonerated en route: palette-leak NOPs (arm 1 crashed without them), r7
   on-disk data (0x33/0x03/0x32/0x34/0x02 byte-identical to retail; BTEntry
   flags/versions preserved by DatCompact — only 0x06 gained bit 0), Decompress
   (zlib bounded, Cache_Pack_t.m_iVersion@+4 alloc math right), SmartBuffer refcounts.
   SerializeFromCachePack + both version-context callees are instruction-identical
   across builds — the EOR divergence is deeper (H8, open, non-blocking).

## Ship stance — H8 RESOLVED, EOR embargo LIFTED
- r7 package unchanged (dats are exe-agnostic).
- **EOR build ships with the `dat-version-preserve` patch INSTEAD OF the guard-NOP.**
  Proven this session: EOR + version-preserve-only + r7 boots the compressed UI AND
  runs in-world crash-free (240s soak, cave interior, 4x textures — vm-vfix2-t240.png).
  The guard-NOP (`dat-decompress`) is NO LONGER NEEDED and its version-0-schema caveat
  (paradox) is gone — the m_iVersion guard now passes legitimately because the real
  BTEntry version is restored after Decompress zeroes it.
- Patch APPLIED (owner-accepted 2026-08-17): `dat-version-preserve` added to
  patch_client.py enabled=True, `dat-decompress` set enabled=False. Shipped
  acclient.eor.patched.exe REGENERATED = palette-leak ×2 + dat-version-preserve
  (md5 69e37ad3ee60fba06f902faac0fde7de, PE csum 0x004A3044). EOR file 0x271C78,
  unique context sig `e81853d9ff8d4c2424e80f53d9ff5f5e5d` (needle_at=5), needle
  `8d4c2424e80f53d9ff` → `0fb745028946049090` (movzx eax,[ebp+2]; mov [esi+4],eax;
  nop; nop). Box-build equivalent site 0x270CD8 (distinct call rel32; not in the
  EOR-targeted registry). NOTE: patch_client.py + PATCHES.md live in
  /mnt/wbterminal2/ac-eor-patch/ (NOT in the git repo — external lane). version-preserve
  was gate-validated IN ISOLATION (vfix2); the shipped exe adds the orthogonal,
  independently-proven palette-leak NOPs (memory-safety, don't touch the decompress
  path) — combination not separately re-gated, low risk.
- Box-build exe remains a valid gate config (H5), but the EOR build is the community
  artifact and now works — prefer it for release.
- WHY the box build tolerated the guard-NOP but EOR didn't (the residual mystery): NOT
  in any code on the crash/inflate path (all instruction-identical; H8-RE). Under the
  guard-NOP a version-0 Cache_Pack reaches the parser; some data-table/CRT divergence
  between the two compiles makes version-0 parsing underflow (Archive::GetSizeLeft,
  unsigned, unclamped) only in the EOR build. Now MOOT for shipping (version is never 0
  with version-preserve), but documented in reports/eor-exe-divergence-2026-08-17.md if
  anyone wants the full root cause.

## Box state (buildbox, us-central1-b, SPOT n1-standard-2 + T4)
- `~/ac_client/`: client_portal.dat.r7 (parked; sha integrity vs shipped
  0d2df11f… checked this session — result in TASKLIST H), client_portal.dat.retail,
  compressed-retail portal in play for arm 4, box+EOR exe variants,
  UserPreferences.ini.veryhigh (redeploy before each launch).
- ⚠ gate-d.sh launches WITHOUT `-rodat` (runbook's manual line has it) — without it
  the client can restamp b-tree entries in the dats. Add `-rodat` to gate scripts OR
  keep sha-checking after runs. All arms 1-4 ran without it (comparable), box exe
  stable regardless.
- Helper scripts: gate-{a,b,c,d}.sh (d: EXE= selectable), gate-tour.sh. 130s
  inter-launch guard MANDATORY; pkill bracket form "[a]cclient" (self-match kills ssh
  — this bit us TWICE more today via `pgrep -f` in wait-loops; always bracket).
- Tools on box: ~/net8.0/{DatCompress,DatCompact}.dll (vendored-DRW builds; run with
  DOTNET_ROLL_FORWARD=LatestMajor). ~/portal-retail-compressed.dat consumed into
  ~/ac_client/client_portal.dat for arm 3/4; ~/portal-retail-comp-compact.dat = arm 4.
- END-OF-SESSION: restore client_portal.dat.r7 → client_portal.dat, rm ~/.keep-awake
  (re-arm idle-stop). (Done at wind-down if this session closes cleanly — verify.)

## Parallel-agent deliverables (this session; slot-filling SUSPENDED by owner)
- **F1 degrade-chain audit: DONE, premise inverted.** No LOW/HIGH pair exists inside
  portal.dat (lows live in client_highres.dat; kits ship a stub). Pipeline already
  collapses baked chains 2→1. ONE stray record 0x05000ECE needs the collapse + add a
  CI invariant (any 0x05 chain containing a baked 0x06 must be length 1). Bake-both
  only matters with a real highres dat (1,342 records). Report:
  reports/degrade-chain-audit-2026-08-17.md + /mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json.
- **C2 orientation veto: IMPLEMENTED + measured** (working tree, uncommitted):
  relief3d.py UP_NZ=0.7/UP_MODE=veto/UP_CLAMP_M=6mm, gate applied AFTER amplitude
  welding (a 9.5cm leak otherwise), env overrides DATPATCH_UP_*. Up-facing displaced
  area → 0.00 m² on all 4 test variants; gate-off rebuild == shipped bytes (baseline
  proven). 274 floor-only variants stop being minted (−3.8% variant bytes as-built);
  an r8 area-budget lane saves ~27%. C3 owner calls: (a) re-cut shipped variants now
  vs r8; (b) building lane roofs — veto (default, kills roof relief) vs clamp 6mm.
  Report in the C2 agent transcript summary + TASKLIST H; scratch
  /mnt/wbterminal2/carve-veto-scratch/ (3.5 GB, deletable).
- **DRW record-grow repro: DONE — and both bugs are ALREADY FIXED UPSTREAM.** Repro'd
  deterministically (/mnt/wbterminal2/drw-repro/: self-contained, both mmap+stream
  flavors, real-dat lane, C# client-semantics Inspect cross-checked vs walk_check.py).
  Two defects in ≤2.1.6: leaf branch[0]=0xCDCDCDCD on EVERY written dat (retail
  BTree::Search follows it; invisible to DRW's own reader) + free-list treated as a
  bump allocator (hands out live blocks on fragmented chains → the take-3 tear).
  Fixed in 2.1.7 (trevis, #69); decompress under-read (2,031,745-byte threshold)
  fixed in 2.1.8 — released 2026-08-17, merging OUR PR #70. 2.1.8 verified clean on
  the same real-portal grow workload that tears 2.1.2. **REPIN APPLIED (owner-approved
  this session): WBT, WorldBuilder.Shared, DatReaderWriter.Extensions, DatCompress,
  DatCompact now PackageReference Chorizite.DatReaderWriter 2.1.8** (vendored
  ProjectReferences removed; Extensions.Tests untouched — pre-existing stale HintPath).
  All 4 builds clean; WBT smoke (chorizite-parse-dat-record on real portal) passes;
  assets confirm 2.1.8 resolved. Buildbox ~/net8.0/ kits refreshed to the 2.1.8
  builds (both usage-smoked on box). Working tree is uncommitted. Issue drafts
  (advisory + Validate() + regression tests, marked DRAFT) ready for review;
  nothing filed.
- **G6 highres hunt/inventory**: agent in flight → reports/highres-dat-inventory-2026-08-17.md.
- Owner side-question answered: community repo AC-Vulkan-Reshade-NoCrash-Fix = clean
  (all 3 binaries byte-identical to official NTCore/DXVK 3.0.2/ReShade 6.8.0), nothing
  useful to us; quarantined /mnt/wbterminal2/quarantine/ (author's other repo is a
  Decal plugin — untriaged, do not run).

## r7.1 queue (updated by today's findings)
- Deblock-prebake (unchanged, T4 session), terrain 2x D-lane, env detail-texture
  upscale, 4K-res byte patch — as per prior handoff.
- Highres lane (G6 DONE, report: reports/highres-dat-inventory-2026-08-17.md): NO real
  client_highres.dat exists on this machine (all 37 = our own empty stubs;
  EnsureHighResDatExists InitNew). But the file is PINNED without having it: 127.0 MiB
  (133,169,152 B), RenderSurface-only, 2,283 ids — 3 independent routes agree (trevis's
  compression log; ConstructTexture mip-chain doubling; trevis's btree survey). Lane =
  1,342 records (supersedes "1,245"), ~67.5 MiB source, DXT1 939 + INDEX16 385 (palette
  path, not DXT re-encode); F1's "512² = less hallucination" is directionally right but
  median source is 256², true invariant = 4x→2x linear on 1,322/1,342 (+20 where retail
  highres already exceeds our r7 → ship retail bytes free). REC: build highres reader +
  2x profile + INDEX16 path against SYNTHESIZED inputs (dat arrival = data event).
  Open blocker: portal-vs-highres precedence for duplicate ids (LookFile/DBCache).
  Acquisition leads (none fetched): 1070's own AC install (offline today), archive.org
  ac-updates, ACCPP mega, Brycter dat drop — verify any bundle by the fingerprint
  (dataset=1, subset=0x69466948, ~133,169,152 B, 2,283/2,283 ids).
- Degrade-chain: closed (accept; fix 0x05000ECE in the next take).
- Feet-sink: C2 code ready; C3 decisions above.
- NEW: H8 EOR-exe root cause (release-blocking for EOR-exe users only).
- Fold into next take's driver: 0x05000ECE collapse; consider -rodat in gates.
