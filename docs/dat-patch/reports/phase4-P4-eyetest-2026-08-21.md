# 4.P4 creature-subdiv in-client eye-test — PASS (2026-08-21, buildbox T4 wine rig)

The mandatory visual confirmation from phase4-P4-creature-subdiv-POC.md §3 is
done: the subdivided Banderling body renders and animates correctly in the
retail client at close range. The lane is clear to scale out.

## Verdict against the POC criteria

- **Denser body tracks the skeleton identically to retail** — PASS. 13 frames
  over ~90 s (idle sway, threat gestures, attack lean at melee range): every
  part stays attached, no lag between torso and limbs, no inversion.
- **Concave-region poke-through** (the one open §2 risk) — none visible at
  melee range: neck/shoulder joins and armpits are clean. (Additive-shell
  model; the replaceDrawing follow-up in the POC still applies for byte cost,
  not correctness.)
- Spawn confirmed as the right target: `@create 6` → "Banderling Scout
  (0x8000083B)", wcid 6, Setup 0x02000E08, whose body part is the subdivided
  `0x01002C00` (18,077 B vs retail 5,944 B).

Captures: taildropped to the owner's phone (eyetest-shots.zip, 13 frames);
working copies in the session scratchpad.

## The rig (reusable — this is now the fleet's visual-gate recipe)

1070 was offline (asleep/off mid-session), so this ran on **buildbox + T4 via
wine** — and proved MORE of the stack than the 1070 run would have: the full
shipped-kit combination (8/8-patched exe sha 6c3232ea…, force-mounted world2
highres c68fb079…, r8 cell) logged in, DDD-passed, entered the world, and
rendered the highres world textures under wine/T4. That is a second
GPU/OS/driver stack validating the r9 kit end-to-end.

- Client dats: **eyetest portal = r9 portal + DatRecordInsert of the subdiv
  record** (`/mnt/wbterminal2/dat-patch-creature-subdiv/eyetest_portal.dat`,
  walk_check 81,206 entries OK; readback-verified insert). ACE served the
  identical file.
- Driving: xdotool on the owned :1 display — click ENTER at char select, then
  `key Return` / `type "@telepoi Holtburg"` / `type "@create 6"` straight into
  retail chat. `<account>` is Developer, so the retail client admin-drives
  itself; no second client needed. ffmpeg x11grab for frames.
- The 1070-side equivalent (unused tonight, deployed and ready):
  `C:\Temp\acdt-chat.ps1` + schtask `acdtchat` types one line from
  `C:\Temp\acdt\chat.txt` into the test client via PostMessage.

## Traps hit (so the next run doesn't)

- **The POC's "scratch portal" is NOT full**: WBT export wrote a portal that
  DDD-passes and boots the client, but vanilla ACE serving it CRASHED at
  player login — the shard DB's characters reference custom 0x0D PaletteSets
  that exist only in our r7/r9 portals (e.g. 0x0D00064A; not in retail
  either). ACE-served portals for this shard must be r9-lineage. (Client-side
  the record counts actually matched retail 79,694 — the crash was the
  server's, not a missing-record client issue.)
- **r9 portal needs its highres**: the HIFI split moved our upgraded 0x06
  records out of the portal, so a client on the r9 portal without
  client_highres.dat + force-mount exe dangles texture lookups. Ship the trio
  together, always.
- **Single-login**: killing/relaunching the client without a ~30 s gap boots
  both sessions ("Account was logged in, booting…"). Wait out the old session.
- **SPOT preempt** hit mid-first-launch (02:43 PDT); disk survived, Xorg +
  client relaunch was all it took. Budget for one preempt per session.
- `pkill -f acclient` from an ssh command self-kills the ssh session (pattern
  matches its own cmdline). `pkill wine; pkill wineserver` instead.

## State after the test

- ACE: back on the shipped r9 portal + world2 highres + r8 cell (restarted,
  ports up). The eyetest portal is parked at
  ace-r9-dats/client_portal.dat.eyetest-hold.
- buildbox: client killed, powered off after the run; ~/ac_client holds the
  eyetest portal + world2 highres + kit exe (acclient.kit.exe) ready for the
  next visual gate.
- 1070 (when it returns): delete the stray `D:\ac-dat-test\client_portal.dat.scratch`
  (927 MB, the bad WBT-export portal); everything else there is the clean
  shipped-kit state with the new acme-r9.zip (98be2e60…).

## Next for the lane (unchanged from the POC §4)

Scale-out via creature_enum/creature_tranche over the 2,155 candidates,
top-down by spawn exposure; land the `replaceDrawing` change first to cut the
~5× additive byte cost to ~4×.
