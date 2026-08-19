# HANDOFF — 2026-08-19 EOD3 (FMCAP shipped + r8 HIFI SPLIT built & gated in one session)

Continues HANDOFF-2026-08-19-EOD2.md. Full detail:
reports/fmcap-1070-gate-2026-08-19.md (queue item 1) and
reports/r8-hifi-split-2026-08-19.md (queue item 2) — read the r8 report
before touching the split tooling or the r8 pair.

## HEADLINE 1 — force-mount + advertise-cap GATED and SHIPPED (EOD2 recap)
1070 native arm, r7.2 + WBT-DXT highres vs live vanilla ACE: highres
exclusively locked login→tour end, DDD exactly-3-dats/session held, world
entry + 7-stop tour clean, FAULTS=0. Pair flipped enabled=True;
`/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe` = md5 `34b68dea…`
(8 patches). Backups: *.pre-fmcap-20260819.bak.

## HEADLINE 2 — the r8 HIFI SPLIT (Phase 3.1 variant B) is BUILT and FULLY GATED
- **r8 portal: 556,033,024 B (530 MiB)** — `/mnt/wbterminal2/dat-patch-r8/
  split/work-portal.dat`, sha `c0073025…`. **r8 highres: 967,217,152 B** —
  `split/r8-client_highres.dat`, sha `e7c82c33…` (HiFi header verified).
  Combined = the same content as r7.2+highres, split; **portal-side runway
  now ~1.44 GiB** under the 2^31 ceiling.
- ours-list = direct byte-diff r7.2 vs retail base: **2,412 records**
  (626 MB stored), 0 adds/removes, 18,272 identical (ours_diff.py, in-repo).
- Gates ALL GREEN: split full byte-verify 0-mismatch; walk_check portal
  81,206 / highres 4,707 OK; pair dims-ledger PASS (0 downscales / 0 missing
  / 0 format; new `--candidate-highres` overlay mode); 1070 in-client mount
  arm + 7-stop tour PASS with frames indistinguishable from pre-split;
  loud-fail launcher refuses rc=1/no-launch on missing highres; bypass arm
  (no launcher, no highres) runs the world WITHOUT crashing (missing
  textures only).

## ⚠ LOAD-BEARING FINDING — DRW `Tree.TryDelete` CORRUPTS THE B-TREE AT SCALE
First split attempt: 2,412 requested deletes → only 169 landed, **3 innocent
records lost**, 1 phantom id, lookups broken after ~213. NO TOOL IN THE LANE
MAY CALL TryDelete. DatHifiSplit builds the trimmed portal by RECONSTRUCTION
(fresh InitNew + copy-all-but-ours, lands dense); DatCompact
--prune-seed-extra hard-refuses. Evidence:
/mnt/wbterminal2/dat-patch-r8/split/split-run-DELETE-CORRUPTION.log.

## HUMAN-RETURN NOTE (1070)
At 17:19:25 the bypass documentation tour aborted `ABORT-USER-ACTIVE
(idle ms=0)` = real input → treated as the owner returning; all box work
stopped at once (test client killed, highres restored, zero test processes
left). Only the bypass VIDEO was lost; its conclusions were already gated
headlessly. Idle-probe discipline had been observed before every arm.

## COMMITTED THIS SESSION (pushed to origin/integ/all-20260813)
- 9bcab640 FMCAP gate report + EOD2 handoff
- d4fe8f2d split tooling (DatHifiSplit, dims_ledger pair mode, ours_diff.py,
  kit/play.bat)
- 4bc9c31f TryDelete corruption finding + reconstruction rewrite
- b756a46d r8 split report + play.bat headless gate modes
- (this handoff + final report amendments in the wrap-up commit)

## EXTERNAL STATE (not in repo, by design)
- /mnt/wbterminal2/ac-eor-patch/ — SHIPPING exe now FMCAP (34b68dea…),
  registry pair <shipped>, PATCHES.md updated. OWNER Q still open: git-track
  this dir?
- /mnt/wbterminal2/dat-patch-r8/split/ — the r8 pair + all build logs.
- /mnt/wbterminal2/r8-gate-2026-08-19/ + fmcap-1070-2026-08-19/ — gate
  videos, frames, logs. Taildropped to the redmi: r8-mount-tour.mkv + 4 key
  frames.
- 1070 D:\ac-dat-test = r8 pair live (r7.2/WBT-DXT kept as backups), FMCAP
  exe as acclient.exe, play.bat + kit-manifest.txt staged.
- ACE untouched all session (still serves ace-r7-dats; r8 portal's iteration
  record carried verbatim → DDD "no update required" proven live).

## NEXT SESSION (in order)
1. **OWNER REVIEWS**: (a) r8 pair eye-review (taildropped video/frames + the
   full galleries); (b) DESIGN loud-fail mechanism A-vs-B — B is built,
   gated, and recommended; (c) whether to git-track ac-eor-patch/.
2. **r8 kit assembly + announce** after owner sign-off: kit = r8 portal +
   r8 highres + cell + FMCAP exe + play.bat + kit-manifest.txt (sizes
   already stamped); ship checklist in the r8 report. Consider renaming the
   real exe (acclient-bin.exe) per the DESIGN bypass note — decide at
   assembly.
3. **9-texture micro-lane** (needs the buildbox Remacri stack — SPOT was
   preempting 8–40 min today; check zone health or migrate per EOD1 note):
   ids in reports/eyetest-ab-review-2026-08-18.md. Rides into an r8 respin
   trivially (rebuild = ours_diff + DatHifiSplit rerun, ~1 h).
4. **Phase 4 fill** per PLAN (scenery aa+ab first — the freed 1.44 GiB's
   first customer), creature-subdiv spike, D5 terrain detail.
5. Optional: upstream the TryDelete corruption repro to DRW (a minimal
   fixture reproduces it: any few-hundred-delete sequence on a portal-scale
   tree).

## BOX STATE
- buildbox: untouched today, powered off, on SPOT (still flaky in
  us-east1-c — migrate if it persists).
- 1070: human present as of 17:19; box left clean per the human-return note.
