# r8 HIFI split build — Phase 3.1 variant B (trevis's form) — 2026-08-19

Executes HANDOFF-2026-08-19-EOD queue item 2. Preconditions at start: 2.1
mount mechanism SHIPPED (FMCAP gate PASS, reports/fmcap-1070-gate-2026-08-19.md);
2.2 DDD semantics verified live (advertise-cap, exactly-3-dats interrogation);
2.3 loud-fail = mechanism B launcher built (tools/dat-patch/kit/play.bat) — the
owner A-vs-B decision from the DESIGN doc remains open, B is the recommended
default and forecloses nothing; DXT routing through WBT render-surface-import
done 2026-08-19 AM.

## Inputs
- Portal: r7.2 announce portal (1,499,357,184 B, sha256 `19984c2f…`).
- Highres: the WBT-DXT r8 highres (337,193,984 B, sha256 `a5fa8b9e…`) —
  the r7.1 lane's 2,294 records with the 938 UPSCALE DXT re-encoded through
  BCnEncoder.
- Retail base portal `~/ac_base_dats/client_portal.dat` (926,941,184 B) as the
  diff baseline and the portal compact seed.
- Retail eor2013 highres (133,169,152 B) as the highres compact seed.

## The ours-list (ours_diff.py, direct byte-diff r7.2 vs retail base)
- 20,684 0x06 records in both files; **2,412 differ = OURS**; 18,272
  byte-identical to retail; 0 added, 0 removed.
- Ours stored (compressed) bytes in the portal: **626,137,995** (~597 MiB) —
  consistent with the 2026-08-17 variant-B math (647 MB measured vs r7; the
  711-id re-bake moved sizes). Uncompressed payload 1,049,506,720 B.
- List: /mnt/wbterminal2/dat-patch-r8/split/ours-ids.txt (+ ours-summary.json).

## ⚠ FINDING EN ROUTE: DRW `Tree.TryDelete` CORRUPTS THE B-TREE AT SCALE
The first split attempt used Tree.TryDelete for the portal trim. Of 2,412
requested deletes only 169 landed on disk (the tool counted 213 "successes"),
**3 innocent non-ours records vanished**, 1 phantom id appeared, and tree
lookups broke after ~213 deletes (delete-side node merge/rebalance bugs).
Caught by an independent datlib walk of the work file BEFORE any downstream
step; evidence split-run-DELETE-CORRUPTION.log. Consequence: **no tool in
this lane may ever call TryDelete** — DatCompact's short-lived
--prune-seed-extra is hard-disabled, and the split was rebuilt as pure
RECONSTRUCTION.

## The split (DatHifiSplit — reconstruction form, ZERO deletes)
- Highres side: copy the WBT-DXT highres, INSERT the 2,412 ours records
  (compression flag preserved, entry metadata as template, per-record
  readback). The ours id set is fully disjoint from the 2,294 highres-lane
  ids (kept=0 — the overlap-keep guard exists but had nothing to do).
- Portal side: fresh `InitNew` dat mirroring the source header (magic,
  blocksize 1024, dataset 1, subset 0, engine/game/major/minor versions,
  MasterMapId), then copy every r7.2 record EXCEPT ours — 81,206 copied,
  2,412 skipped, 0 failed. Lands DENSE; no separate compact needed.
- Full pair verify: portal survivors 81,206/81,206 byte-identical (content
  AND version/iteration metadata), 0 extra, 0 lost; highres 4,707/4,707
  byte-identical to their sources (moved ids vs the r7.2 portal, lane ids vs
  the WBT-DXT file), 0 missing. RC=0.

## Landed sizes (better than the plan targets)
- **Portal: 556,033,024 B (530 MiB)** vs plan ~873 MB — the plan's number
  carried the retail seed's slack and the uncompacted r7.2 file arithmetic;
  fresh reconstruction + per-record recompression lands far denser. sha256
  `c0073025…`.
- **Highres: 967,217,152 B (922 MiB)** vs plan ~648 MB — the plan predated
  the r7.1 highres-lane content (337 MB) now also aboard. sha256 `e7c82c33…`.
  DatCompact (retail eor2013 seed) round-tripped it 4,707/4,707 verified,
  0 drift; header carries dataSet=1 subSet=0x69466948 (the HiFi pair the
  force-mount requires).
- Combined 1.52 GB (unchanged content, split); **portal-side runway is now
  ~1.44 GiB** under the 2^31 ceiling — nearly half the file free for Phase 4.

## Gates
- walk_check: portal entries=81,206 free=46 OK; highres entries=4,707
  free=20 OK.
- dims_ledger PAIR mode (new `--candidate-highres` overlay, client
  precedence) vs r7.2: **PASS** — 22,978 textures vs 20,684 | 0 downscales |
  0 missing | 0 format changes | 2,294 added (the highres-lane records now
  visible through the overlay).
- **In-client 1070 gate (SAFEPAL-FMCAP exe, live vanilla ACE) — ALL ARMS PASS:**
  - *Mount arm*: r8 pair live in D:\ac-dat-test (hash-verified). Client boots
    on the 556 MB portal, DDD identical to r7.2 (3 dats, portal iteration
    2073, "no update required" — the iteration record survived reconstruction
    verbatim), highres locked login→tour end, world entry (ACE [LOGIN]
    17:01:53), full 7-stop tour9 clean, client alive after (vm 1.10 GB —
    matches the FMCAP arm), FAULTS=0. NOTE the memory profile: idle-in-world
    trims to ~690 MB vm and climbs to ~1.1 GB while actively touring — probe
    DURING streaming, an idle probe under-reads (not a false-pass signal by
    itself; ACE world entry + tour is the assertion).
  - *Frame review* (68 frames from the OBS mkv): Holtburg/Yaraq/Shoushi
    towns, Alabree/Underground/Muggy dungeons all fully textured,
    INDISTINGUISHABLE from the pre-split FMCAP arm at the same stops — the
    2,412 moved records serve correctly from the highres. Avatar clothed.
  - *Loud-fail arm (mechanism B, headless)*: play.bat + kit-manifest.txt on
    the box. Pass path: KIT-OK, rc=0. Fail path (highres renamed away):
    "LOUD-FAIL: client_highres.dat missing", errorlevel 1, **no client
    launched**. (New ACME_KIT_CHECK_SILENT / ACME_KIT_CHECK_ONLY env modes
    keep the gate off the user's screen; the MessageBox path is the same
    refusal logic.)
  - *Bypass arm (direct acclient.exe, no highres)*: client boots, force-mount
    absent-file path graceful (the hidden file stays unlocked), DDD passes,
    world entry OK, NO CRASH, FAULTS=0 through a full documentation tour —
    a launcher-bypassing player gets a running world with the 2,412 moved
    textures missing, not a crash. The documentation VIDEO of this arm was
    NOT captured: its tour aborted `ABORT-USER-ACTIVE (idle ms=0)` at
    17:19:25 — a real input event, treated as the human returning to the
    1070; all box work stopped immediately (test client killed, highres
    restored, no test processes left). The bypass conclusions above were
    already established headlessly before the abort.
  - One harness re-learn: killing the previous arm's client process does NOT
    free the ACE session — the next login inside ~110 s trips Account-In-Use
    and boots BOTH (client exits code=0 at login). Respect the ≥130 s gap
    from the wine runbook on the 1070 too.

## Decisions taken in-build
- The 33 never-referenced retail highres records (11 unnamed + 22
  passthrough carries) are KEPT, deviating from the plan's default
  drop-with-the-rest: they cost ≲ a few MiB post-compact and keep the file
  byte-shaped like retail. Reversible at any future compact.
- The 9-texture micro-lane does NOT ride along tonight: it needs the Remacri
  stack parked on the buildbox, which is SPOT-preempting every 8–40 min. It
  slots into any r8 respin unchanged (9 small ids, list in
  reports/eyetest-ab-review-2026-08-18.md).

## Artifacts
- /mnt/wbterminal2/dat-patch-r8/split/ — work-portal.dat (THE r8 portal,
  sha `c0073025…`) + r8-client_highres.dat (THE r8 highres, sha `e7c82c33…`)
  + ours-ids.txt + ours-summary.json + split-run2.log +
  split-run-DELETE-CORRUPTION.log + highres-compact.log + r8-pair.sha256.
- /mnt/wbterminal2/r8-gate-2026-08-19/ — r8-mount-tour.mkv, frames/ (68),
  dims-ledger-r8.json, ace-session-extract.log, split/compact logs.
- Taildropped to the redmi: r8-mount-tour.mkv + 4 key frames
  (Holtburg/Alabree/Shoushi/Muggy).
- 1070 left state: D:\ac-dat-test holds the r8 pair live (r7.2 + WBT-DXT
  kept as .r72-bak/.wbtdxt-bak), SAFEPAL-FMCAP exe as acclient.exe, play.bat
  + kit-manifest.txt staged, sha256 stamp files current. r8-arm acdt logs
  remain in C:\Temp\acdt\. No test processes left running.
