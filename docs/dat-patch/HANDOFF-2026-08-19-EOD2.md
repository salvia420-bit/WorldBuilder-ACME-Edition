# HANDOFF — 2026-08-19 EOD2 (FMCAP gate PASS on the 1070 → highres pair SHIPPED)

Continues HANDOFF-2026-08-19-EOD.md. Full session detail in
reports/fmcap-1070-gate-2026-08-19.md.

## HEADLINE — queue item 1 is DONE: force-mount + advertise-cap GATED and SHIPPED
The last open gate item (force-mount arm on the EOR SAFEPAL exe, full world
tour) PASSED — run on the **1070, native Windows acclient** (buildbox was
SPOT-preempting every 8–40 min; human-check per fleet rules: idle probe ×2
climbed 1:1, >45 min — nobody there; muted + off-screen acdt harness).
- Arm: pristine EOR + SAFEPAL set + `highres-force-mount @0xFAFA9` +
  `highres-advertise-cap @0xFB051`, **r7.2 portal** + **the r8 WBT-DXT
  highres** (not the r7.1 prototype — doubling as its first in-client QA),
  vs the live laptop vanilla ACE (untouched).
- Evidence: highres EXCLUSIVELY LOCKED login→tour end (Windows stand-in for
  wine hr_fd=1); ACE DDD log shows EXACTLY 3 dats / "no update required" /
  session held; world entry (ACE [LOGIN] line; vm 476 MB→1.67 GB climb — not
  a charsel-flat false pass); 7-stop tour clean; client alive after;
  **FAULTS=0** in the Windows event log; frames show towns/dungeons fully
  textured, avatar clothed, **no white-DXT regressions** from the WBT
  re-encode. The box-exe "doesn't render the world" anomaly was a BOX-BUILD
  artifact — the EOR build has no such problem.
- **SHIPPED**: both patches enabled=True (mandatory pair) in the registry;
  `/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe` REBUILT = md5
  `34b68deaf43a422ad4f80c5578aada63`, cksum `0x004A1974`, byte-identical to
  the gated arm exe. Backups: patch_client.py.pre-fmcap-20260819.bak,
  acclient.eor.patched.pre-fmcap-20260819.bak (= the 0554acd7 SAFEPAL exe).
  PATCHES.md updated. ⚠ Kits distributed with the SAFEPAL-only exe still work
  but never mount highres — the r8 HIFI split REQUIRES the new exe.

## COMMITTED THIS SESSION
- docs/dat-patch/reports/fmcap-1070-gate-2026-08-19.md
- docs/dat-patch/HANDOFF-2026-08-19-EOD2.md (this)

## NOT IN THE REPO (external, by design)
- /mnt/wbterminal2/ac-eor-patch/: patch_client.py (pair flipped to shipped),
  PATCHES.md, the rebuilt shipping exe + both backups. OWNER Q from EOD1
  still open: track this dir in git?
- /mnt/wbterminal2/fmcap-1070-2026-08-19/: tour video (248 MB), 68 frames,
  all logs, driver.

## NEXT SESSION (in order) — carried from EOD1 minus item 1
1. **r8 HIFI split (PLAN Phase 3, variant B)**: ours→highres (the WBT-DXT dat
   at /mnt/wbterminal2/dat-patch-r8/highres-wbtdxt/), DELETE superseded retail
   portal copies, DatCompact both → portal ~0.9 GiB + highres ~648 MB.
   Preconditions: fresh-install loud-fail gate (DESIGN doc, mechanism B = kit
   launcher check), the 9-texture micro-lane rides along. Note the shipping
   exe now force-mounts — the split's client side is DONE and gated.
2. **Mag candidates** as needed: two-login box gate for allow-multiclient;
   render-bypass/usetime for headless protocol bots.
3. Phase 4 fill per plan (scenery aa+ab, creature-subdiv, D5 terrain detail).

## 1070 STATE — clean, human-safe throughout
- D:\ac-dat-test\ = r7.2 portal + WBT-DXT highres live (sha stamps updated),
  FMCAP exe as acclient.exe; backups per the report. No test processes left;
  foreground restored; OBS closed. Old r4/r5/r6 portal baks still there
  (D: has 93 GB free — prune only if the owner wants).
- Buildbox NOT used this session (still powered off, on SPOT).
