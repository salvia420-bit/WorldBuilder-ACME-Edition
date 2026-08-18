# HANDOFF — 2026-08-17 EOD3 (night sprint: real highres dat IN HAND; deblock A/B verdict; terrain-2x D4)

Read with: TASKLIST-2026-08-17.md section I (this session's log) on top of HANDOFF-2026-08-17-EOD2.md.
All work below is uncommitted working tree + /mnt/wbterminal2 artifacts unless noted.

## Headline
1. **A genuine EoR client_highres.dat is on disk and verified** — the G6 "data event"
   happened tonight. `/mnt/wbterminal2/highres-acquisition/eor2013/client_highres.dat`,
   133,169,152 B exact, sha256 503e0828…, Iteration 497 (2013-09-06), all 2,283
   predicted ids + 11 extras, ZERO content-id overlap with portal (precedence blocker
   moot — and answered anyway: highres wins, CLCache::GetDiskController probes slot 3
   first; mounting requires the server DDD to set product bit 4, which vanilla ACE does
   not → owner decision). Source: ACCPP's public MEGA ACDataRepository; provenance file
   alongside; nothing executed. The highres LANE is also built and proven END-TO-END on
   the real file (synth_highres.py + highres_lane.py + CI fixture; no-regression-vs-r7
   invariant 1,342/1,342; INDEX16 stays palette; WBT round-trip). Remaining: Remacri
   PNGs for the 1,320 upscale records.
2. **Deblock-prebake (G5a/b): DECIDED — ADOPT corpus-wide for r7.1** (owner-delegated
   call, recorded in the report's DECISION block; eye-test stays as part of the
   standard r7.1 gate, severity-gated mix is the pre-approved fallback) — see
   reports/deblock-ab-2026-08-17.md. Corpus-wide (all 1,630) deblocked Remacri bakes
   already exist (/mnt/wbterminal2/deblock-ab/out-remacri-full/), so r7.1's rebake
   needs NO further GPU. Severe-tier quilting is visually eliminated (ab-visual.png);
   exc0 material 702→196, severe 272→57. tools/dat-patch/deblock.py is the permanent
   lane pre-stage (seed-gated filter, better than the research prototype).
3. **F1 fix + CI invariant landed** (fix_degrade_chains.py): --check on shipped r7
   finds exactly 0x05000ECE; --fix collapses it in place via WBT
   surface-texture-collapse (proof on sha-verified copy; no compact needed). Fold both
   into the take-5 driver.
4. **Terrain-2x (D): D1-D3 done, D4 smoke run tonight** — arm portal built ON the box
   from its r7 copy (37/37 imports @1024, Region baseTexSize 2048, walk_check OK,
   1.63 GB < guard). D4 VERDICT: see addendum at the bottom of this file.
5. **F3 4K-res patch registered (enabled=False)** in the external lane, with a real
   defect discovered in Pea's original bytes (stack re-base miss; one-byte fix
   identified). Owner review before enabling.

## New/changed files (working tree, uncommitted)
- tools/dat-patch/: deblock.py (new), fix_degrade_chains.py (new), highres_lane.py
  (new), synth_highres.py (new), patch_region_basetexsize.py (new),
  data/highres-eor2013-headers.json (new), matlib.py (DATPATCH_DEBLOCK_BASE hook),
  terrain_lane.py (--size 1024 + alpha subcommand; 512 default proven byte-identical),
  README.md (driver wiring for fix_degrade_chains).
- docs/dat-patch/reports/deblock-ab-2026-08-17.md (new), TASKLIST section I.
- External lane (NOT in repo): patch_client.py + PATCHES.md gained res-4k-unlock /
  res-4k-unlock-2 (enabled=False).

## DO-NOT-LOSE artifacts (keep until consumed by r7.1; deleting any of these
## re-costs GPU time, a fragile download, or an unrepeatable provenance chain)
1. **/mnt/wbterminal2/highres-acquisition/eor2013/** — the REAL client_highres.dat
   (sha256 503e0828…) + source 7z + PROVENANCE.txt. MEGA links rot; treat as
   irreplaceable. **Backed up this session → /mnt/wbterminal1/highres-acquisition-backup/
   (sha-verified identical).** megalib.py alongside = the pure-python MEGA fetcher
   (reusable for the 18 other dated highres versions in ACCPP's archive if ever needed).
2. **/mnt/wbterminal2/deblock-ab/out-remacri-full/** — all 1,630 deblocked-input
   Remacri bakes (the ADOPTED r7.1 texture source; ~1 T4-hour to regenerate) +
   in-deblocked{,-full}/ ledgers, ab-visual.png, ab-scores.jsonl, control-compare.json.
3. **/mnt/wbterminal2/terrain-2x/** — base-1024/ + alpha-2x/ (+nearest/ fallback) +
   scratch proofs; buildbox ~/terrain-arm/portal-arm.dat is the built smoke arm.
4. **tools/dat-patch/data/highres-eor2013-headers.json** (in-repo CI fixture spec —
   commit with the session's tree so the lane gates without the 127 MiB file).

## Key /mnt/wbterminal2 artifacts
- highres-acquisition/eor2013/ (the real dat + 7z + PROVENANCE.txt) — READ-ONLY source.
- deblock-ab/: in-deblocked{,-full}/ (+ledgers), out-remacri-full/ (1,630 A-arm bakes),
  out-raw-control/ (40-tex control), ab-scores.jsonl, control-compare.json,
  ab-visual.png (the decision strip).
- terrain-2x/: base-1024/, alpha-2x/ (+nearest/ fallback), scratch/ proofs.
- highres-synth-scratch/: lane end-to-end proofs.

## r7.1 queue after tonight (supersedes EOD2's list)
1. Take-5 driver additions: fix_degrade_chains --fix + --check (I3), deblock rebake
   re-encode+import from out-remacri-full (~50 min, after eye-test green), terrain-2x
   lane fold (if D4 green): 37-record import + Region patch + collapse the 8 blend STs
   (entry[0] = highres ids — MANDATORY before any real highres dat ships).
2. Highres lane: bake Remacri 2x PNGs for 1,320 records (T4, ~short), run
   highres_lane.py, gate. Decide the ACE product-bit-4 question (keep-ACE-vanilla
   collision — DDD Interrogation writes 1u, needs 5u to mount highres client-side).
3. Batched eye-test session (1070 or T4): deblock arm stops + terrain stops + highres.
4. G5c DXVK smoke — still queued, not run tonight.
5. Owner reviews: F3 enable/variant decision; deblock adoption; highres serve decision.

## Box / fleet notes
- SPOT preempt hit mid-session (~22:40): outputs were already pulled (nothing lost).
  TRAPS confirmed after every preempt-restart: (a) Xorg :1 must be relaunched
  (runbook); (b) NEW TRAP: a wineserver that started while X was down keeps poisoning
  new wine clients with nodrv_CreateWindow AFTER X returns — `WINEPREFIX=~/acwine
  wineserver -k` before relaunching, then verify `wine cmd /c echo` prints.
- NEW TRAP #2: `gcloud compute ssh` can silently RETRY the connection and re-execute
  the --command — a `setsid nohup driver.sh &` launch can come up TWICE (we got
  doubled drivers twice tonight). After any detached launch, `pgrep -af` COUNT the
  instances and `kill <pid>` the extras; and never combine a pkill-cleanup with a
  relaunch in one --command (the relaunch text makes the pkill self-match — bit us
  once more tonight despite the runbook warning).
- Box end-of-session state (CLEAN, verified before poweroff): ~/ac_client/
  client_portal.dat = r7 (sha 0d2df11f… re-verified), VeryHigh INI restored from
  .veryhigh-bak, keep-awake disarmed, box powered off. Parked for next session:
  ~/terrain-arm/ (arm portal + WBT-2.1.8 net8.0 kit + scripts), ~/terrain-smoke.sh,
  ~/deblock-ab/ + ~/raw-control/ (outputs already pulled+verified to laptop — box
  copies are dispensable), ~/upscale-batch2/venv + weights.
- Remacri machinery on box: ~/upscale-batch2/venv (torch 2.5.1+cu121) + weights;
  deblock A/B runner ~/up_deblock_ab.py; terrain arm ~/terrain-arm/ (WBT 2.1.8 kit in
  ~/terrain-arm/net8.0 — also useful for future on-box dat surgery).

## THE HIFI SPLIT (trevis's idea, relayed by owner 2026-08-17; numbers measured tonight)
**Our remacri/baked textures move into client_highres.dat, and the superseded
base-retail standard texture records are DELETED from client_portal.dat** — not
reverted, deleted: once highres precedence serves our copy, the retail copy in the
portal is dead weight (trevis's exact form of the idea). The client prefers highres
for any id it contains (decomp-proven tonight, GetDiskController slot-3-first).
Measured on the shipped r7 (datlib; portal has 20,684 0x06 records, ours = 2,412):

| variant | portal freed (compressed terms) | highres load | highres headroom left |
|---|---|---|---|
| **B — trevis: ours→highres, DELETE superseded retail copies from portal** | **647,348,493 (617 MiB)** — r7 1.52 GiB → ~0.9 GiB | 617 MiB | **1.40 GiB** |
| C — maximal: ALL 20,684 textures→highres, portal carries ZERO 0x06 | **818,079,429 (0.76 GiB)** | 0.76 GiB (ours 617 MiB + standard ~163 MiB compressed) | **1.24 GiB** |
| (A — conservative fallback-keeping form: revert ours to retail bytes in portal) | 501 MiB | 617 MiB | 1.40 GiB |

Reference figures: our payload = 1,049,506,720 B uncompressed / 647,348,493 B
compressed; all-retail texture content = 606,491,325 B uncompressed; retail highres
content dropped in every variant = 133,169,152 B (127 MiB).

Net effect (B or C): the portal ceiling stops binding ENTIRELY — texture growth moves
to a fresh 2^31 budget, and the portal returns 617-780 MiB of on-disk room for
non-texture lanes (terrain-2x, env variants, scenery). Variant B is the recommended
r8 architecture; C is the clean end-state if the mount question settles well.

COMBINED-BUDGET VIEW (the "near 4 GB" framing, owner 2026-08-17): the two files
together address 2 x 2,147,483,647 = 4,294,967,294 B (~4.29 GB). Under variant B:
portal after trim+compact ~= 872.9 MB, highres with our payload ~= 648 MB, so
combined used ~= 1.52 GB and TOTAL RUNWAY ~= 2.77 GB — split 1.40 GB texture-side
(highres) + 1.27 GB geometry/world-side (portal). The two growth axes stop competing.
(Geometry-in-highres is decomp-plausible — the mount is a general portal-type
controller — but retail only ever put RenderSurfaces there; treat as UNTESTED.)
THE TRADE vs A: in B/C the highres dat is LOAD-BEARING — a client that fails to mount
it has NO copy of those textures at all (missing-texture render, not a graceful
degrade). So B/C require the mount to be guaranteed (product bit 4 or the client-side
force-mount patch) and the installer/DDD story to be solid before shipping.
Also: deleting records frees b-tree blocks but the FILE never shrinks (high-water) —
the size win lands after a DatCompact rebuild, which we already run per take.
Preconditions / open items:
1. Mounting requires DDD product bit 4: vanilla ACE writes 1u
   (GameMessageDDDInterrogation.cs:10 → 5u) = keep-ACE-vanilla collision — OR a
   client-side patch forcing CLCache::LoadHighResDat (acclient.c:293792 guard),
   which keeps ACE vanilla; candidate for the patch registry (research, not yet built).
2. Absent-id fallback is retail-proven (every ACE install runs the stub path today);
   our F1 collapse already strips entry[0] highres ids from baked chains anyway.
3. Highres records compress fine (trevis measured 48.75% on retail highres); the
   dat-version-preserve patch already covers decompress.
4. OPEN: DDD iteration semantics for a custom highres when ACE serves dats (does the
   server need the file in DatFilesDirectory once bit 4 is set?) — verify before ship.
5. The 11 unnamed retail highres ids + 22 lane-passthrough records: keep-or-drop call
   is free either way (≤ a few MiB); default drop-with-the-rest, they're unreferenced.
6. Tooling is essentially ready: highres_lane.py already writes valid highres dats
   (b-tree bulk-loader), fix_degrade_chains handles the chain side, DatCompress the
   compression side.

## Ceiling research (bonus, decomp-verified — from the F1 agent's deep-dive)
Portal hard ceiling is EXACTLY 2^31−1: BTEntry offsets are signed (bit 31 = free-block
flag; allocated-chain sign check ABORTS the read) AND DiskDev::SyncRead uses
SetFilePointer with no high DWORD. Escapes ranked: highres dat (~2x budget, sanctioned,
needs product bit 4) > compression (~450MB, shipped) > raise driver guard 2.04e9→~2.14e9
(+100MB; if done, walk_check needs an explicit offset<0x80000000 assert on allocated
chains — it currently masks and would false-pass).

## D4 ADDENDUM (final, wind-down)
**VERDICT: HARD FAIL at VeryHigh + baseTexSize 2048 — OOM-class crash on the FIRST
outdoor terrain composite.** The arm itself is sound (sha-verified r7 source, 37/37
imports at 1024, Region patch PASS, walk_check OK, 1.63 GB < guard) and the client
ran fine INDOORS (spawn was the vfix2 cave; 60+s live render, 3 distinct frames).
The first outdoor load (@telepoi Yaraq, mid-portal-transit) died: write-AV at
ntdll 0x7BC26925 writing 0x007A00AC — the null+8MB-offset signature of an unchecked
failed allocation — right after VmSize jumped 1.63 GB → 2.42 GB building composites
(2048-base composites are 4x retail's per-combination footprint). Wine popped the
debugger dialog; the client froze (marks kept alive=1 with byte-identical VmSize and
frozen frames — pgrep liveness is NOT a health signal once winedbg attaches; check
frame deltas). Shots: /mnt/wbterminal2/terrain-2x/smoke-shots/ (02-yaraq-a = the
crash dialog; 01-holtburg-a = clean interior).
- The address-space wall was the brief's predicted resource-fail mode; it bound even
  faster than expected (first composite burst, not a slow creep).
- DIAGNOSTIC ARM (LandscapeTextureDetail=High on the same portal — halves composite
  size; survival would prove pure size-scaling vs a data bug): attempted twice,
  KILLED BOTH TIMES BY SPOT PREEMPTS before completing. Queued as the FIRST item of
  the next box session (~15 min; INI backup at ~/ac_client/UserPreferences.ini.veryhigh-bak,
  arm portal parked at ~/terrain-arm/portal-arm.dat, script ~/terrain-smoke.sh).
- r7.1 outlook for terrain-2x: at minimum needs a composite-memory strategy
  (fewer combos resident / earlier purge / half-step baseTexSize... note ImageShift
  only supports power-of-two shifts, so 2048@High == 1024@VeryHigh — a true half-step
  doesn't exist; the honest alternatives are (a) ship 1024 sources WITHOUT the Region
  patch for detail-texture-class wins only, (b) D5 detail-texture upscale, (c) accept
  High-detail-only support if the diagnostic passes). Terrain-2x does NOT block r7.1's
  deblock rebake or the highres lane.
- Box smoke-session traps burned tonight (all now in the runbook section above):
  post-preempt Xorg relaunch, stale-wineserver poisoning, gcloud-ssh double-exec of
  detached launches, pkill self-match, and winedbg-freeze masquerading as liveness.
