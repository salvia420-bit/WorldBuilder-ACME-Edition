# Force-mount + advertise-cap DDD gate — PASS (2026-08-18)

The HIFI-split mount mechanism (owner decisions 1 + P1-B, DECISIONS-2026-08-18.md)
gated on the buildbox (us-east1-c, wine + T4) against the live laptop ACE
(vanilla, EnableDATPatching=false), using the REAL eor2013 client_highres.dat
(sha 503e0828…, iteration 497) staged at ~/highres-verify/. All four arms use
the box shipping exe (acclient.box-decompress-TEST.exe) as the base; force-mount
= NOP at box offset 0xFA409 (74 05→90 90), advertise-cap = box offset 0xFA4B1
(8b86e8010000→b8030000 90), both byte-offsets verified pre-patch.

Objective observables only: the ACE-server DDD interrogation result line
(correlated by timestamp; laptop is NDT = UTC−2:30) and the client's open file
descriptor on client_highres.dat (`/proc/<pid>/fd`, sampled at char-select).

| arm | exe | highres file | ACE DDD result | highres fd | interpretation |
|---|---|---|---|---|---|
| A | shipping | present | `client_portal.dat: 2073 … no update required` | 0 | Bit 4 unset → highres NOT mounted (retail behaviour). Baseline. |
| B | +force-mount | present | `client_portal.dat: **497** … update required, DAT patching disabled` → **session dropped: "Client has older DATs than server and patching is disabled"** | **1** | Force-mount mounts AND advertises the highres as the portal set → ACE boots the player. The DDD hazard, reproduced live. Shipping force-mount ALONE = every login bricked. |
| C | +force-mount | absent | `client_portal.dat: 2073 … no update required` | 0 | Absent-file path is a graceful no-op (matches the byte-level absent-safety proof). |
| D | +force-mount +cap | present | `client_portal.dat: 2073 … no update required` — **session survives** | **1** | **Ship candidate.** Highres is mounted and open (fd=1) yet the client says nothing about it to the server (log byte-identical to control A). The cap suppresses the advertisement, NOT the mount. |

## Verdict
- Option B (force-mount + advertise-cap, shipped as a matched pair) is PROVEN on
  vanilla ACE with the real highres dat: the client gains the highres textures
  (fd held) while the server sees an unchanged, in-sync portal set and does not
  terminate the session.
- Resolves the agent's flagged unknown ("could the cap suppress the mount itself
  rather than just the advertisement?") — arm D fd=1 answers NO.
- Confirms why the pair is mandatory: arm B is the live proof that force-mount
  without the cap boots every player.

## Remaining before enabling the registry entries
- Arm D reaching and staying in the WORLD (this gate stopped at char-select,
  which is where the DDD interrogation fires and thus where the hazard lives).
  Fold into the batched visual eye-test session (PLAN §1.5 / Phase-3 gate):
  full 6-stop tour on arm D + the highres-only-texture render confirmation +
  VmSize ledger.
- Then flip highres-force-mount + highres-advertise-cap to enabled=True TOGETHER.

## Harness note (cost the first run 2 arms)
ACE holds the single-login session ~110 s after the client dies; a 30 s
inter-arm gap let arms B/D collide with the ghost session ("Account In Use")
and never interrogate — the FIRST run's B/D were inconclusive for this reason,
NOT a patch fault (A/C passed clean). The re-run used a 150 s release gap and
both interrogated cleanly. For any future multi-arm login gate on one account:
≥130 s between arms, or gate on the ACE "session dropped" line.
