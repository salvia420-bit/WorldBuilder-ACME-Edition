# HANDOFF — 2026-08-19 EOD (F3 gate + palette double-free FIX + r8 DXT routing)

Continues HANDOFF-2026-08-19.md. Full session detail lives in
reports/f3-armd-gates-2026-08-19.md — READ IT before touching the shipping exe,
the palette patches, or the force-mount arm.

## HEADLINE — a RELEASE BLOCKER in the r7/r7.2 announce exe was found and FIXED
The shipped player exe (`acclient.eor.patched`, 2-site eriknihlen palette-leak
fix) **corrupts the heap at world entry on r7-family portals** — UAF, wild float
writes over code (EIPs at 0x3F80000x = 1.0f), player avatar stuck as pink
per-joint particles. Caught in the F3 gate, isolated across 6 in-client arms.
- Root cause = Mag-nus/acclient-ai-re's documented double-free in
  `releasePalette` (the leak masked it; removing the increments exposes it on the
  appearance/char-gen path = world entry). Safe fix = 15 bytes / 3 sites.
- FIXED: added `palette-double-free` (site 3, `0x0013ED75`) to the registry;
  built **SAFEPAL** = full ship set + site 3; **in-client GATE PASS** at
  2560x1600 (world entry + drag matrix + soak clean, avatar renders clothed).
- **PROMOTED**: `/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe` is now
  SAFEPAL (md5 0554acd7…, PE cksum 0x004AB7DD). Prior 2-site exe backed up as
  `acclient.eor.patched.pre-safepal-20260819.bak` and marked KNOWN-BROKEN.
- ⚠ The r7 AND r7.2 dats already announced/toured were rendered with the BROKEN
  exe. The dats themselves are fine (r7.2 owner-approved); only the exe was
  broken. Any kit already distributed with the pre-safepal exe needs the new exe.

## COMMITTED THIS SESSION (repo, pushed to origin/integ/all-20260813 @ c9ef9cf1)
- tools/dat-patch/synth_highres.py — init d.flags (fixes lane-verifier crash).
- docs/dat-patch/reports/f3-armd-gates-2026-08-19.md (full write-up).
- docs/dat-patch/DESIGN-fresh-install-loud-fail-2026-08-19.md (r8 precond 2.3).
- docs/dat-patch/HANDOFF-2026-08-19-EOD.md (this).

## NOT IN THE REPO (external, /mnt/wbterminal2/ac-eor-patch/ — by design)
The patch registry + exes are external. Backed up in place; NOT git-tracked.
- patch_client.py — added `palette-double-free` (shipped) + `allow-multiclient`,
  `allow-multiclient-2`, `render-normal-bypass`, `usetime-disable-frame-draw`
  (all enabled=False candidates from Mag-ACClientPatcher, build 6096 == EOR,
  bytes+uniqueness verified). Backup: patch_client.py.pre-safepal-20260819.bak.
- PATCHES.md — shipped-exe row updated for SAFEPAL.
- acclient.eor.patched.exe = SAFEPAL (the new ship exe).
- OWNER Q for next session: do you want /mnt/wbterminal2/ac-eor-patch tracked in
  git? It currently isn't; only the reports reference it.

## r8 PRECONDITION DONE — DXT routing through WBT
All 938 UPSCALE DXT highres records re-encoded through WBT
`render-surface-import` (BCnEncoder, the client-grade path) replacing the
scaffolding encoder. Byte-surgical: exactly the 938 differ, other 1,357
identical, verify VERDICT OK. Output:
`/mnt/wbterminal2/dat-patch-r8/highres-wbtdxt/client_highres.dat` (+ dxt-imports
.json, import-result.json). This is the highres DXT source for the r8 HIFI split.

## F3 res-4k — PASSES on the repaired exe (feature exonerated)
NOPAL (res-4k, no palette) clean at 2560; crash reproduces at 1920 and without
res-4k → res-4k innocent from both directions. res-4k stays enabled=True. At
2560x1600 the 3D viewport is FULL-BLEED (Yonneh's "won't resize" does NOT repro
on wine/T4), UI laid out/readable, drag matrix + soak clean.

## NEXT SESSION (in order)
1. **Force-mount arm on the EOR SAFEPAL exe** (the one still-open gate item).
   The box FMCAP exe proved the MOUNT + DDD-survival with our highres (hr_fd=1,
   session not dropped) but its BOX build doesn't render the world on entry
   (VmSize flat ~1.58 GB; EOR SAFEPAL enters fine with identical clicks). So:
   `patch_client.py apply --only …,highres-force-mount,highres-advertise-cap`
   onto SAFEPAL (EOR offsets 0xFAFA9 force-mount / 0xFB051 cap — flip both
   enabled=True TOGETHER), r7.2 portal + our 337 MB highres, full world tour +
   VmSize climb assertion. Only after PASS: ship the pair enabled.
   ⚠ HARNESS RULES (learned hard this session, in the report):
   - wine fullscreen mode-switch SHRINKS the shared X screen → `xrandr -d :1 -s
     2560x1600` in every arm teardown + ffmpeg NATIVE-size grabs (no
     -video_size).
   - assert world entry by the VmSize CLIMB (charsel ~1.57 GB → world ~2.1 GB);
     "clean" flat-at-charsel arms are FALSE PASSES.
   - char-select is an 800x600 window that REPOSITIONS between launches (no WM);
     derive clicks from `xdotool getwindowgeometry` (char row +95,+221; Enter
     +342,+393 from the window origin).
   - ≥130 s single-login gap between arms on one account (ACE holds ~110 s).
2. **r8 HIFI split (PLAN Phase 3, variant B)**: ours→highres (now the WBT-DXT
   dat above), DELETE superseded retail portal copies, DatCompact both → portal
   ~0.9 GiB + highres ~648 MB. Preconditions: fresh-install loud-fail gate
   (DESIGN doc, mechanism B recommended = kit launcher check), the 9-texture
   micro-lane rides along.
3. **Mag candidates** as needed: two-login box gate for allow-multiclient;
   render-bypass/usetime for headless protocol bots.
4. Phase 4 fill per plan (scenery aa+ab, creature-subdiv, D5 terrain detail).

## BOX STATE — clean, powered off, ON SPOT
- ⚠ buildbox is back on **SPOT** (provisioning-model=SPOT): on-demand T4 was
  UNAVAILABLE in us-east1-c today (7+ preempts, several during boot; delete+
  recreate on STANDARD returned "try again later" ×3). It preempts every
  ~8-40 min right now — resumable drivers + per-arm sentinels are mandatory,
  and long unattended chains will likely get interrupted. If it stays this bad,
  migrate the disk to another T4 zone (snapshot → disk in new zone → recreate).
- ~/ac_client restored to r7 default (client_portal.dat 1,520,297,984 verified),
  VeryHigh INI, keep-awake disarmed, powered off.
- Staged on box: ~/acclient.eor.SAFEPAL.exe, ~/acclient.eor.NOPAL.exe,
  ~/acclient.eor.VPONLY.exe, ~/acclient.box-FMCAP-armD.exe, ~/r7.2-portal.dat,
  ~/our-client_highres.dat (337 MB), ~/eyetest-r72/r7-portal-backup.dat (the
  restore source). Session drivers: ~/f3-round{2,3,4,5}.sh.
- Local captures: /mnt/wbterminal2/f3-armd-2026-08-19/ (all round timelines +
  SAFEPAL shots + crash shots), session-scripts-2026-08-19/ (rescued prior
  scratchpad), dat-patch-r8/highres-wbtdxt/ (the WBT-DXT highres).
