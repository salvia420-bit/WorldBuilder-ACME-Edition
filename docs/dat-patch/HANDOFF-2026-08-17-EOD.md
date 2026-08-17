# HANDOFF — 2026-08-17 EOD (r7 built+verified; wine gate box live; one r7-specific crash open)

Read with: docs/dat-patch/TASKLIST-2026-08-17.md (the working tracker, all statuses current)
and reports/: F1-F4-engineering-research-2026-08-17.md, block-artifact-graphical-research-2026-08-17.md.

## What is DONE and trustworthy
1. **r7 TRUE-4x package**: /mnt/wbterminal2/dat-patch-r7/acme-dats-r7-true4x.tgz (+sha).
   Portal 1.52 GB, compressed+compacted, every step verified (walk_check.py client-semantics
   tripwire + DatCompact full byte-verify + datlib strict walk 83,618). ACE serves it
   (ace-r7-dats; revert = Config.js.pre-r7-bak + FIFO restart per memory/ace-live.md).
2. **Root cause of take-3's tear**: Chorizite.DatReaderWriter 2.1.2 NuGet write path
   corrupts on record-grow. ALL dat-writing tools now ProjectReference the vendored
   external/DatReaderWriter (WBT, Shared, Extensions, DatCompress, DatCompact). Upstream
   issue still to file (PR #70 channel).
3. **New tools**: tools/dat-patch/DatCompact (dense rebuild, reclaimed 314 MB),
   walk_check.py (b-tree/free-chain tripwire), audit_carve_orientation.py,
   audit_degrade_chain.py. r7_driver4.sh = the proven driver pattern.
4. **Wine gate box** (buildbox, us-central1-b, n1-standard-2+T4 SPOT, idle-stop armed):
   headless Xorg on T4 + wine 8.0 + wine32 + DXVK staged + NVIDIA compat32 + Vulkan.
   **Gate-viable, PROVEN**: retail client ran in-world 10+ min, zero faults, clean render.
   THE unlock: HKCU\Software\Wine\Direct3D VideoMemorySize=2048 (client's texture purge
   trigger acclient.c:457974 never fires on modern VRAM; uncapped → 4MiB memset overrun).
   Recipes + gotchas in memory/fleet-runbooks.md and TASKLIST G4-final. Helper scripts on
   box: ~/gate-{a,b,c,d}.sh (d: EXE= selectable). 130s inter-launch guard MANDATORY.

## THE open blocker (one, precisely pinned)
r7 dats + acclient.eor.patched.exe under Wine: enters world, renders, heap-corruption
crash ~30-45s in (stomped fn-pointers carry record-payload bytes; magenta particles +
broken lifestone BEFORE death). Killed hypotheses (don't redo): VA exhaustion, d3d9
format/pitch mismatch (0/2466), detail level, -rodat, win32 prefix, esync, audio,
DXVK-vs-WineD3D, oversized inflates (census: max 8.5MB = retail's own record).
LEAD SUSPECT: async overlapped-read semantics under Wine feeding the dat-decompress
patch (only r7 has compressed records; retail = stable). Ranked probes:
(1) decomp arg table for a sync-IO switch; (2) WINEDEBUG=+file trace of a compressed
read burst; (3) wine-ge-8-26 arm (community-pinned build, implements
WINE_LARGE_ADDRESS_AWARE); (4) **1070 cross-check when available — single decisive run**:
stable = wine-async confirmed (gate on Windows); crash = the EoR decompress patch itself
is bad in-world (it was only Windows-proven via the different NOMIP box exe on r6).

## r7.1 queue (sized, not started)
- **Highres lane (F1)**: client_highres.dat tops the texture LOD stack for 1,245/2,226
  lane surfaces on stock installs — our 4x partially invisible there. Need the real
  highres dat (not the 1MB stub ACE uses), bake highres ids (512² sources — less
  hallucination), ~1 lane + a day of plumbing.
- **Deblock-prebake**: 43% of bake corpus has block-grid artifacts (the "squarish seams");
  wrap-aware 4-tap deblock kills the grid (+92%→+2.7%) keeping 103% detail; Remacri A/B
  = ~14 T4-min for the 702-surface set. Wire into matlib, A/B, re-score, corpus rebake.
- Also queued: terrain 2x lane (D1-D5, Region baseTexSize is DATA), env detail-texture
  upscale (engine has 4 native detail channels — community doesn't know), orientation
  veto re-cut (28% of variant shell area is up-facing floor carving = the feet-sink),
  4K-res byte patch (needles verified vs our exe).

## Standing state to know
- ACE (laptop) serves r7; box kit = r7 + patched exe + VeryHigh INI... note
  UserPreferences.ini on box may still be LOW from debugging — redeploy before gating.
- Owner decisions pending: ship-r7 vs fold r7.1 first; variant re-cut timing; monster
  palette wall (unchanged).
- Discord answer about dungeon prefabs was verified + delivered (772 Environments, not
  the handoff's old 769).
