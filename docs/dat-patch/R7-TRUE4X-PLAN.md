# r7 TRUE-4x rebake — plan + live status (green-lit by owner 2026-08-16 evening)

Phase-2 step 2 executed: every texture-lane RenderSurface re-baked at TRUE 4x
from the **wrap-padded corpus** (upscale-corpus/rewrap-out, 92.8% tileability
improvement), imported into a compressed r6-based portal, texture-only
zlib-compressed. NO mip patch (mip-min pair parked — shimmer theoretical at
current scales). Working root: `/mnt/wbterminal2/dat-patch-r7/`.

## The numbers that shaped the plan
- 2,287 unique RenderSurfaces across the six bake lanes (statics 726, doors
  59, props 434, dungeons 473, creatures 195, scenery 340 — surface-id lists
  filtered to corpus coverage; 95 without corpus keep their r6 bakes; the 2
  protected terrain RS the dungeon lane once clobbered are auto-excluded).
- Size arithmetic: those records are 849 MB in r6; at 4x + DXT + mips + zlib
  (measured 54.9%) they estimate to 661 MB — **net −188 MB**. Compression
  more than pays for 4x.
- **Ordering constraint (hard)**: DatCompress FIRST. Importing 4x uncompressed
  into the uncompressed portal would peak ~2.04 GB — at the 31-bit ceiling.
  Compress-first frees ~580 MB of interior blocks; estimated peak ~1.84 GB,
  final ~1.3 GB used → ~850 MB headroom left for the area-relief lane (r8).

## Flow (r7_driver.sh in the working root, detached)
1. r6 export copied → r7/export; **DatCompress pass 1** (done 22:03:
   compressed=20662, realCorruption=0, 1290.7→708.6 MiB).
2. Six `texture_lane run` lanes sequentially with `--remacri` +
   `DATPATCH_REMACRI=<rewrap corpus>` + `DATPATCH_WRAPPED_CORPUS=1` (retires
   the edge cross-fade stopgap — it would soften the now-correct edges) +
   `DATPATCH_BAKE_MAX_SIDE=4096` (true 4x, no cap) +
   `DATPATCH_TEX_BASE=<retail export>` (luminance anchor stays retail).
3. fixup → **DatCompress pass 2** (new records; already-compressed skipped by
   flag) + `--verify` inflate-compare = the record-content check.
4. Validation battery for a COMPRESSED portal: python strict b-tree walk +
   DatCompress verify. (The ACE.DatLoader full walk is NOT usable here — ACE
   has no inflate path. ACE the *server* is unaffected: it never reads 0x06.)
5. Package `acme-dats-r7-true4x.tgz` + sha256, sentinel `R7_BAKE_DONE`.

Smoke-validated before launch: 3 scenery textures baked 2048² (r6 shipped
1024²), imported into the compressed container, round-tripped clean.

## Still owed after the bake
- **1070 in-client gate at VeryHigh — MANDATORY** (full 5-stop tour; the
  client needs the dat-decompress patch: use NOMIP box exe or the shipped
  patched EoR exe).
- ACE serve switch + DDD iteration check (`no update required` expected —
  DatCompress preserves iteration).
- Then the r8 area-based dungeon-relief lane into the remaining headroom.

## Traps encoded here so they don't recur
- Lane id lists are SURFACE (0x08) ids except scenery's wave1_ids.txt which is
  RS ids — the r7 setup uses `wave1_sids.txt` for scenery.
- `DATPATCH_TEX_BASE` must point at the retail re-export dir or run_lane
  KeyErrors at the first bake.
- DatCompress skips records whose IsCompressed flag is already set — safe to
  re-run on a mixed portal.
