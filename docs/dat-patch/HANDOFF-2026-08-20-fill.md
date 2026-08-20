# HANDOFF — 2026-08-20 (Phase-4 coverage fill; DETACHED run in flight at session end)

Continues HANDOFF-2026-08-19-EOD4.md. Owner directive: fill the r8 runway this
session, intelligently, per PLAN-2026-08-18. Measured plan +

execution log: TASKLIST-2026-08-20-phase4-fill.md. Method + decisions:
reports/phase4-coverage-fill-2026-08-20.md.

## ⚠ FIRST THING NEXT SESSION — a detached job is finishing the release
`tools/dat-patch/finish_fill.sh` was launched with `setsid nohup` at 05:32 NDT and
survives the session. It:
1. waits for the WBT DXT import stage to end, then kills the parent build script
   (whose stage order was wrong — see below);
2. compresses the freshly imported DXT records, inserts the 3,122 palette
   records, compresses again — in that order, so the file never crosses the
   2 GiB HARD ceiling;
3. walk_check + dims ledger vs r8 + a coverage count;
4. assembles the **r9 kit with BOTH a .tgz and a .zip** (owner request);
5. writes `docs/dat-patch/reports/phase4-fill-RESULTS.md`, commits **exactly that
   file plus the method report** (never `git add -A`) and pushes.

Check on return:
```
tail -40 /mnt/wbterminal2/fill-2026-08-20/logs/finish.log
ls -la /mnt/wbterminal2/fill-2026-08-20/FINISH_DONE          # sentinel
cat docs/dat-patch/reports/phase4-fill-RESULTS.md
ls -la /mnt/wbterminal2/dat-patch-r9/kit/
```
If it died mid-way, every stage is idempotent EXCEPT the palette inserts
(`DatRecordInsert` skips ids already present, so a re-run is safe too). The work
dat is `/mnt/wbterminal2/fill-2026-08-20/r9/client_highres.dat`; the r8 kit it was
copied from is untouched at `/mnt/wbterminal2/dat-patch-r8/kit/acme-r8/`.

## WHAT THE FILL IS
- **4,868 records baked** (1,746 DXT + 3,122 palette), 13 terrain-protected
  refusals, 0 failures. Coverage 2,412 -> ~7,280 of 20,684 retail 0x06 records;
  **world surfaces ≥64 px go from 4,892 uncovered to ~0.**
- **Additive to `client_highres.dat` only.** The r8 portal ships byte-identical,
  nothing is deleted, `Tree.TryDelete` is never called. The r8 portal keeps its
  1.48 GiB of runway for the geometry lanes.
- **INDEX16/P8 stay palettized at 2x** (indices re-solved inside the record's own
  used subset — verified: zero new palette indices, so ClothingTable recolours
  and clipmap transparency are untouched). Everything else is DXT1/DXT5 at 4x
  through WBT's BCnEncoder.
- **32 px icons/UI (12,933 records, ~41 MB) deliberately not shipped**: 71 % of
  the remaining record count for 4 % of the bytes, and the least world-visible
  class. Their upscales are already baked and parked on the buildbox
  (`~/fill/out`, 16,922 PNGs) for a later pass.
- Exposure is anchored to retail exactly like the shipped lane (rgb+sat, 1.15x):
  colour ledger on the baked output **PASS** — lumRatio median 1.1540, castDrift
  median 0.0019 / p99 0.058, 0 % out of band.

## STILL OPEN (in order)
1. **Read the finisher's RESULTS.md**, then the r9 kit gates:
   `tools/dat-patch/kit/check_ps1_table.py` runs as an assemble precondition, and
   `kit-gate.ps1` should be re-run on the 1070 against the r9 kit.
2. **The 1070 in-client arm has NOT run for r9** — this is the one mandatory gate
   left before announcing. Mount the r9 pair in `D:\ac-dat-test`, tour, and eyeball
   the newly covered surfaces (creature/monster skins are the visible headline:
   2,496 INDEX16 records in tier A).
3. **ANNOUNCE-r8-DRAFT.md** needs re-pointing at r9 once the kit lands (sizes and
   hashes change; the .zip line is already in the draft's open questions).
4. **Icons pass** (tier C) if wanted: PNGs already exist on the box; the routing
   and the import path are unchanged.
5. **The portal side is still empty of new work** — 1.48 GiB of runway, and the
   geometry lanes (4.P1-4.P4) are untouched. They are CPU-hours, not GPU, and did
   not fit in this session.

## THINGS THAT BIT (all fixed, all in the report)
- SPOT preempted the buildbox mid-session; the upscale driver's skip-existing
  design lost nothing, but the 2.7 GB download had to become sha-verified 200 MB
  chunks with per-part retries.
- The palette solve was the bottleneck (~40 s per 1024² record); replaced with a
  k-d tree solve that resolves ties back to the lowest palette index and is
  **verified bit-identical** to the reference.
- Three bake workers at ~1 GB RSS drove the laptop into swap; added resume so
  workers can be killed and restarted.
- **WBT writes imported records uncompressed** — ~1 GB of raw DXT on a fill this
  size, which would cross the 2 GiB ceiling before the final compress. The
  landing driver now compresses BETWEEN the two write stages. `build_r9_highres.sh`
  is fixed; the in-flight run is being finished by `finish_fill.sh` instead.
- 3 of the first 800 DXT imports failed (WBT `failCount`); the ids are recoverable
  by diffing the manifest against the dat. Worth a look next session — 3 of 1,746.

## BOX STATE
- buildbox: **powered off**, keep-awake disarmed, disk 95 % (16,922 upscales kept
  in `~/fill/out`). It was preempted once tonight; SPOT in us-east1-c is still flaky.
- 1070: untouched this session (the fill was laptop + buildbox work).
- ACE: untouched.
