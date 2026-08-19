# F3 res-4k gate + force-mount arm-D world tour + r8 DXT routing — 2026-08-19

Executes HANDOFF-2026-08-19 queue items 1 (batched box session) and the r8
precondition "route DXT through WBT render-surface-import". Box = buildbox
(us-east1-c, T4, wine). ACE = the live laptop vanilla server.

## RESULT SUMMARY (updated as arms complete)

### 1. r8 DXT-routing precondition — DONE, proven byte-surgical
- All 938 UPSCALE DXT records of the r7.1 highres prototype re-encoded through
  `WorldBuilder.Terminal render-surface-import` (batch `imports` form, BCnEncoder
  2.2.1 — the in-tree client-grade encoder), replacing highres_lane.py's
  scaffolding range-fit encoder output. 938/938 written, 0 failed.
- Output: `/mnt/wbterminal2/dat-patch-r8/highres-wbtdxt/client_highres.dat`
  (337,193,984 B — same size). Full-record diff vs the prototype: **exactly the
  938 targeted records differ, all other 1,357 byte-identical, 0 length drift**
  (palette route, raw, passthrough, iteration record untouched).
- `highres_lane.py verify` VERDICT OK (2,294 records parsed, 0 unparseable).
- WBT opens the HiFi dat (dataSet=1 subSet=0x69466948) natively; format-preserve
  confirmed (DXT1→DXT1, the one DXT5 stays DXT5); the 4 DXT passthroughs
  (retail-byte carries) correctly excluded.
- Bug fixed en route: yesterday's datlib.py flags/compressed-get addition broke
  `synth_highres.open_dat` (bypasses `Dat.__init__`, never inited `d.flags`) —
  one-line fix in synth_highres.py.

### 2. Force-mount arm D with OUR custom highres — MOUNT + DDD SURVIVAL PROVEN, world tour pending round 2
- Arm D exe built from the box shipping exe + force-mount (0xFA409 7405→9090) +
  advertise-cap (0xFA4B1 8b86…→b803…90), byte-asserted pre-patch.
- With the **r7.2 portal** and **our 337 MB client_highres.dat**: client held
  `client_highres.dat` open (`hr_fd=1`) from char-select through the whole arm,
  ACE never dropped the session — the mount-gate arm-D result extends from the
  retail eor2013 file to OUR custom highres on the release-candidate portal.
- **Open item for r8**: the box FMCAP exe mounts the highres (hr_fd=1, DDD
  survives) but its BOX build does not render the world on entry here (VmSize
  stays ~1.58 GB across the tour; round-1 and two round-5 reruns), whereas the
  EOR SAFEPAL build enters cleanly with identical clicks. The mount/DDD proof
  stands; the world-tour-with-our-highres VISUAL is deferred. Correct next step:
  build force-mount + advertise-cap onto the **EOR SAFEPAL** shipping exe (EOR
  offsets 0xFAFA9 / 0xFB051, NOT the box 0xFA409 / 0xFA4B1) and tour that — the
  box exe was only ever a mount-mechanism vehicle.

### 3. ⚠ RELEASE BLOCKER FOUND + ISOLATED: the palette-leak NOPs corrupt the
### client at world entry with the r7 portal — res-4k exonerated
The full isolation matrix (rounds 1-3, all with the r7 portal, world entry
verified by the VmSize climb):

| exe set | res | world entry | verdict |
|---|---|---|---|
| ship (palette-leak+vp+res4k) | 2560 windowed | CRASH ×3 (probe, w, w2) | |
| ship | 2560 fullscreen | CRASH (f2) | |
| ship | **1920x1080** | **CRASH (armA)** | resolution exonerated |
| pre-res4k control (palette-leak+vp) | 2560 windowed | CRASH (ctrl-w2) | res-4k exonerated |
| **VPONLY (vp only)** | 2560 windowed | **CLEAN 3-min soak (armB)** | palette-leak convicted |
| **VPONLY** | 1920x1080 | **CLEAN 3-min soak (armC)** | (matches 08-17 gate) |

- Crash signature: wild jumps/reads with EIPs clustering at **0x3F80000x =
  1.0f** (also c000001d illegal-instruction at 0x3f800006, and the round-1
  0x670061 read-at--1) — float data written over code pointers; the site
  shifts with timing (under winedbg the client survived into the world for
  minutes). Classic use-after-free/overrun.
- Visible companion defect: on every palette-leak arm the **player avatar
  never renders — pink per-joint particle placeholders** persist on a live
  client (bt arm, minutes in-world, chat active). On VPONLY arms the clothed
  avatar renders perfectly. The player model is the heaviest
  CImagePaletteData user (clothing recolor).
- Mechanism (consistent, not yet byte-proven): `palette-leak`/`palette-leak-2`
  NOP two CImagePaletteData refcount INCREMENTS ("notan's EOR palette-leak
  fix"). If any code path releases those references, the undercount frees
  palette data still in use → UAF → float scribbles over reused heap. r7's
  385 rebaked palette-route records plausibly shifted allocation patterns to
  make the latent UAF fire deterministically at world entry (the fix's prior
  in-world mileage was with retail/r6-era dats).
- **Release consequence: the r7/r7.2 announce kit's player exe
  (acclient.eor.patched lineage, palette-leak included) is BROKEN against the
  r7-family portals — caught BEFORE distribution.** Repair candidate
  `acclient.eor.NOPAL.exe` (dat-version-preserve + res-4k, NO palette-leak)
  gating in round 4; palette-leak reverts to enabled=False (accepting the
  original palette memory leak until a correct fix is derived) unless the
  owner prefers otherwise.

### 3c. FIX FOUND, BUILT, AND IN-CLIENT CONFIRMED — Mag-nus `palette-double-free` (site 3 of 3)
- Root cause is a KNOWN, documented defect: the eriknihlen 2-site palette-leak
  fix is UNSAFE alone. Mag-nus/acclient-ai-re (2015-10 11.6096 memory-leak
  report; exe sha256 bca95bbe… == ours) proves the safe fix is **15 bytes across
  3 sites**: the two increment-NOPs PLUS a third — NOP the *second* deleting-
  destructor call in `releasePalette` (`0x0013ED75`, VA 0x0053ED75,
  `8b166a018bceff5218`→9 NOPs). `makeModifiedPalette` over-references every
  palette by 1; removing the increments (2-site fix) exposes a latent DOUBLE
  FREE in releasePalette that retail never reached (the leak kept refcounts >0).
  It fires on appearance-reset / character-generation = world entry / player
  model. Exactly our crash.
- Added to the registry as `palette-double-free` (sig verified unique in our
  EOR exe, bytes match the report). Registry note makes palette-leak/-2 and
  palette-double-free a mandatory trio.
- **SAFEPAL exe** (full ship set + the 3rd patch, `patch_client.py apply`,
  md5 0554acd7…, 181 code bytes) **GATED IN-CLIENT 2026-08-19 — PASS**: the
  identical ship set that crashed 4/4 ran **clean at 2560x1600 windowed**
  through world entry + border-drag matrix + 60 s soak (faults=0, illegal=0,
  VmSize climbed to 2.15 GB and held), and the **player avatar renders fully
  clothed** — the pink-particle placeholder is gone (safepal-06-soak.png).
- **PROMOTED**: acclient.eor.patched.exe is now SAFEPAL (0554acd7…); prior
  2-site exe backed up as acclient.eor.patched.pre-safepal-20260819.bak and
  marked KNOWN-BROKEN. res-4k stays enabled=True (exonerated by armA crash at
  1920 + control crash without res-4k + NOPAL/armB/armC clean with res-4k).
- The res-4k feature gate itself now PASSES on the repaired exe: NOPAL (res-4k,
  no palette) and SAFEPAL (res-4k + fixed palette) both render at 2560x1600
  with the 3D viewport FULL-BLEED, UI laid out and readable, border-drag matrix
  + soak clean. No collapse-below-minimum, no drag crash.

### 3d. Mag-nus patch library imported (registry candidates, enabled=False)
From github.com/Mag-nus/Mag-ACClientPatcher (build 6096 == our EOR), all sites
byte- and uniqueness-verified against the pristine exe:
- `allow-multiclient` + `allow-multiclient-2` — run >1 acclient without Decal
  (fleet multi-account gate arms on one box). Box gate: two simultaneous
  logins on distinct accounts.
- `render-normal-bypass` (je→jmp) and `usetime-disable-frame-draw` (NOP
  StartFrame+Draw) — headless-bot arm tools (near-zero GPU after connect, UI +
  net still run). NOT for player kits.
These graduate per-need; none ship in the player exe.

### 3b. F3 res-4k gate — patch bytes exonerated; feature gate rides on the repaired exe
- `acclient.eor.patched.exe` (shipping set: palette-leak ×2 + dat-version-preserve
  + res-4k ×2) at 2560x1600 windowed, r7 portal: **crash at world entry, both
  attempts** (probe + arm f3ship-w): `page fault read 0xFFFFFFFF at EIP
  0x00670061`, ~60 s after char-select, consistently at the avatar/portal-storm
  moment (frozen frame shows per-joint portal-storm particles, world already
  full-bleed rendered at 2560x1600).
- EIP maps (yonneh map) to `SmartArray<int,1>::SetNElements+0x21` — but that
  symbol is COMDAT-folded across every 4-byte-T SmartArray instantiation, so the
  EIP alone does not name the subsystem. winedbg backtrace arm in round 2.
- NOT the known Frame::combine box flake (different EIP class, deterministic
  2/2 vs ~2/6).
- Positive finding inside the crash frames: at 2560x1600 the 3D viewport renders
  **full-bleed** (Yonneh's "3d area won't resize" does not reproduce on wine/T4),
  UI laid out correctly, chat/vitals/minimap/hotbar all present and readable.
- Control comparisons were INVALID in round 1 (below); round 2 re-runs the full
  matrix: ship/control × windowed/fullscreen with enforced world entry.
- Base-lineage caveat surfaced by the registry history: dat-version-preserve was
  in-world-validated on the EOR build ALONE (2026-08-17, default res); the
  shipping SET (with palette-leak ×2) + high-res in-world was never gated before
  today. The crash may implicate res-4k, the set, or 2560 itself — round 2
  isolates.

### 4. Harness findings (cost round 1 most of its arms — now hard rules)
- **Wine fullscreen mode-switch shrinks the shared X screen** (2560x1600 →
  800x600 at char-select) and NOTHING restores it: every later arm ran on a
  800x600 screen — `ffmpeg -video_size 2560x1600` grabs failed silently (no
  shots), xdotool clicks clamped (logins missed). Fix: `xrandr -d :1 -s
  2560x1600` in every arm teardown + ffmpeg native-size grabs.
- **The VmSize ledger is what caught it**: "clean" arms sat at char-select
  VmSize (~1.57 GB) for their whole "tour" while a real world entry climbs to
  ~1.9-2.2 GB. Any tour/gate driver MUST assert the climb before trusting later
  marks (round-2 login() refuses to proceed below 1.8 GB).
- The 800x600 char-select window is NOT fixed at (880,510): it repositions
  between launches on the bare-Xorg (no WM) display. Clicks must be derived from
  `xdotool getwindowgeometry` (char-select layout is anchored to the 800x600
  window: char row +95,+221; Enter +342,+393).
- DDD gate note: ACE rejects the RETAIL portal ("DAT files are incomplete" boot
  dialog) — F3 arms must run the r7 portal; ship/control exes read it fine
  (dat-version-preserve), but the Pea-verbatim demo exe (pristine base) cannot —
  that optional defect-demo arm was dropped.

### 5. VmSize startup transient (crash-investigation telemetry, from the
  recovered eyetest-r72 per-5s curves)
- Every arm's FIRST sample is **3.00-3.16 GB VmSize** (seconds after launch),
  dropping to ~1.58 GB, then climbing to ~2.21 GB by soak. The 32-bit LAA
  ceiling is 4 GB and the Frame::combine wild reads landed at 3.3-3.6 GB —
  just above the observed startup watermark. Supports the VA-pressure flake
  hypothesis; worth sampling at 1 s resolution around world entry next time.
- Curves: /mnt/wbterminal2/eyetest-r72-2026-08-19/vmsize/*.log (87 samples each,
  full arm coverage).

## Artifacts
- Round-1 capture: /mnt/wbterminal2/f3-armd-2026-08-19/ (ship-w crash shots
  2560x1600, all timelines, wine logs, recovered r72 vmsize curves).
- Round-2 capture: (pending) f3-round2.tgz — bt arm (winedbg scripted), ship/ctrl
  × windowed/fullscreen with world-entry assertion, armD2 world tour.
- Arm-D exe: scratchpad box-batch/acclient.box-FMCAP-armD.exe (sha256 49bdd5da…),
  also on box ~/acclient.box-FMCAP-armD.exe.
- WBT-DXT highres: /mnt/wbterminal2/dat-patch-r8/highres-wbtdxt/ (dat +
  dxt-imports.json + import-result.json).

## Gate consequences so far
- F3 (res-4k) does NOT pass: check 2 (enters world) fails on the ship set at
  2560x1600 windowed. Per the PATCHES.md gate spec, if round 2 pins it on
  res-4k → revert res-4k-unlock* to enabled=False and restore the pre-res4k
  shipping exe. If it pins on the base set → bigger problem (r7's announced
  player exe), triage before any announce.
- highres-force-mount + highres-advertise-cap: arm-D char-select evidence now
  covers OUR file; the flip to enabled=True still waits on the armD2 WORLD tour
  (and F3 resolution, since they graduate into the same shipping exe).
