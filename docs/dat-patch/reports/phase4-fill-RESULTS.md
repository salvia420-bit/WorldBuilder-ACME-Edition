# Phase-4 fill — RESULTS (2026-08-20, recovery + completion session)

The detached finisher died at the 2^31 hard ceiling mid-palette-insert (root
causes and fixes in TASKLIST-2026-08-20-phase4-fill.md §Session 2). This session
recovered the landing, then — on the owner's "fill the free space in the two
dats" directive — completed the remaining fill tiers and audited every open
portal-side plan item against what had actually shipped.

## The r9 dats, final and gated

| | r8 | r9 | delta |
|---|---|---|---|
| client_portal.dat | 556,033,024 | **556,084,224** | +51,200 (statics-tranche straggler 0x010040E9, 228->912 tris, validate.py green) |
| client_highres.dat | 967,217,152 (4,706 recs) | **1,617,610,752 (22,876 recs)** | +18,169 texture records, DatCompact-dense |
| client_cell_1.dat | 347,298,304 | 347,298,304 | byte-identical |

**Retail 0x06 coverage: 2,412 -> 20,581 of 20,684 = 99.5 %.** The 103 uncovered
are the 13 terrain-protected refusals (MergeTexture-locked, by design) plus a
small tail never in fill scope. Every world surface, icon, and UI texture that
may be re-encoded now ships upgraded.

Gates on the final artifacts, all PASS:
- walk_check: highres entries=22,876 free=43 OK; portal entries=81,206 free=16 OK.
- dims ledger vs r8: added 18,169 | downscales 0 | format changes 0 | missing 0.
- DatCompact --verify: 22,876/22,876 byte-identical after the final compact
  (1,782,781,952 -> 1,617,610,752; ~165 MB of compress-orphaned blocks reclaimed).
- Palette-route inserts readback-verified byte-identical (3,122 fill + 350 icon).
- Colour ledger (baked-sample): lumRatio median 1.1540, castDrift p99 0.058, PASS.
- Tranche validate.py on the portal: 1/1 models OK, physDrift 0.0, drawing carried.
- Patcher-table gate (check_ps1_table.py): PASS at kit assembly.

## What landed this session

1. **Recovery of the crashed landing** — DatCompact rebuild (2.00 GiB stuck file
   -> 1.33 GiB dense), remaining 2,110 palette records inserted compressed
   (new `DatRecordInsert --compress`), the 5 failed 4096-side DXT records
   root-caused (DRW's fixed 5 MB pack buffer) and re-shipped at 2048 per the
   `--max-side` lane policy; WBT hardened to write >4.5 MB records through a
   right-sized buffer (proven with a real 4096^2 import).
2. **Tier C+D icons/tiny (13,301 records)** — 12,951 DXT + 350 palette, 0
   failures; the 117 upscales missing from the box corpus were Remacri'd on the
   T4 in one pass. Icons compressed to 25.9 % of raw.
3. **Statics-tranche completion** — fresh full-world enumerate reproduced the
   dossier (1,921 -> 881 -> 438 displace); 437/438 were already shipped in r8;
   the one straggler was built and landed portal-side.
4. **4.P2 band-object lane: clean negative** — all 5 degrade-deferred carriers'
   band-0 objects are gate-refused (no carving surface). Deferral closed.
5. **4.P1 scenery aa+ab: verified already shipped** in r7.1 (stale plan entry).

## Phase-4 items remaining (parked, each with a session-sized reason)

- **4.P3 env-variant re-cut** (orientation veto + wider WALL_CLASSES): veto code
  is wired since r7, but variant_release.sh requires the PRE-envgeo portal —
  re-cutting on the shipped r8 portal would double-shell. Needs a staged
  portal-lineage session.
- **4.P4 creature/animated-GfxObj subdiv spike** (timeboxed research).
- **4.H2 terrain detail textures / 4.H3 terrain-2x (diagnostic-gated) /
  4.H4 texel-starvation survey** — the measured highres spends for the ~430 MB
  of remaining texture-side runway.
- **1070 in-client arm on the r9 kit — the one mandatory gate before announcing.**

## Kit

Assembled from the gated artifacts above (portal + highres + cell + patcher +
loud-fail gate), packaged as both .tgz and .zip (patcher-table gate PASS):

```
/mnt/wbterminal2/dat-patch-r9/kit/
acme-r9.tgz  1,985,054,373  bb95469d3fb6bbcd1fa33e4231aaad37020e5a5122e3ab2173c032b073b5e069
acme-r9.zip  1,985,078,237  091e8a311e868a6b946d7baab932a639bf326889f1291f417db0a9c1619493f2
client_portal.dat   03569ce401eb414ee2c8fd6f75dfca08c4543ad94d69817454d7e565df6404bb
client_highres.dat  fcf31a121e35455958458d528f07e697672cf6c8925a5f248be9643c9ae98742
client_cell_1.dat   2eaf2a84f4f8b4e54b9304a41631647b234cd2303b38084151b3fff826c8dda6
```

The earlier same-day A+B-only kit was superseded before any distribution and is
parked at /mnt/wbterminal2/dat-patch-r9/kit-superseded-ab-only/.
