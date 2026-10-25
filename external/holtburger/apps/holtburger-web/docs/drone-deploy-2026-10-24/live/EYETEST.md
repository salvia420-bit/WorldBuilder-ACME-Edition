# Drone Deploy — 1070 smoke and eye test (2026-10-24/25)

GTX 1070 (ANGLE D3D11), Chrome 156, on-screen and muted (owner-authorized), own profile `hbb-drone`, CDP :9333
through the tunnel; local ACE only (`server_host=127.0.0.1`); URL flags `?nosw=1&drone=on&droneDebug=on` plus the
owner's play flags (`quality=high&csm=off&renderScale=1&adaptiveRes=off`). Driver: `drone-live.mjs` (this folder).
Characters: `+Tester` (tailnet1, human male) and, on the spare account phase4demo, the eye-test characters created
for this run through the character-creation plugin's own builders: `+Drone Aluvia` (Aluvian female),
`+Drone Lugian`, `+Drone Empyrean`, `+Drone Tumerok`, `+Drone Olthoi`.

## Phase 2 smoke (PLAN §9.4 step 6)

Quick deploy → 3 s of sticks → recall → idle: every verdict PASS — state sequence deploying → flying → returning →
landing → stowing → idle; 0 console errors; outbound only the `0x01E9` pings (54/min in the cycle vs 52/min idle);
the input-funnel gate reopened; the camera released (no `liveScene3d.film` / `filmViewer`); no OSD or drone group
left. `smoke-2026-10-24T23-42-46-155Z.json`.

## Eye-test checklist (PLAN §10)

| # | Result | Evidence |
|---|---|---|
| E1 | **PASS** — the launcher sits in the toolbar's add-on column directly under RynthSuite ⚒ (same x, 45 px lower; CSS order 10 vs 0); tooltip `Drone · Shift+F11 · Deploy the camera drone (right-click: settings)`; Shift+F11 deploys and does not toggle fullscreen (window size unchanged). | `eye-*.json` E1; `shots/p2-00-hud-full.jpg` |
| E2 | **PASS** — male, female, Lugian, Empyrean and Tumerok: the pack reach hides the wielded sword, the kneel places the drone at the hand, the goggles sit over the eyes (also under the horned helmet and over a hood), the tablet sits in both hands at chest height facing the face; the Empyrean keeps its feet on the ground through the clips (no R9 drop). Olthoi (no hands): the drone appears beside it and lifts off. Phase-3 look fixes confirmed: translucent grey rotor discs, dark goggle lenses. One finding: on a slope the no-hands drop floated ≈ 0.75 m (F2, fixed below). | `shots/hbm-*`, `shots/alf-*`, `shots/lug-*`, `shots/emp-*`, `shots/tum-*`, `shots/olt-*` |
| E3 | **PASS** — largest per-frame camera step across consecutive FPV frames of the first deploy: 0.32 m / 3.5° (the cut itself goes through the 0.35 s boot wipe); the first FPV frame looks back at the pilot with goggles and tablet. | `eye-*.json` E3; `shots/smoke-fpv.jpg`, `shots/hbm-09-flying.jpg` |
| E4 | **PASS** — cine flight ≈ 96 fps (p50 8.4 ms); flying into a stone well and the houses below crash speed (crashes off) slides up and over them, no clipping; full stick down holds the eye at exactly 0.70 m above the terrain; range 30 m: held on the sphere, signal 0, full static, RANGE LIMIT banner; battery 1 min: LOW BATTERY at 47 s, return-to-home at 53 s (9.9 %), RETURNING banner, normal stow; pilot view shows the character in front with goggles and tablet and the banner below the feet; deploying from orbit camera mode switches to follow for the cycle and restores orbit (no Ready on the rig). Trees were not targeted specifically (same scenery collision layer as the well). | `shots/e4-*`, `shots/hbm-10-pilot-view.jpg` |
| E5 | **PASS in the open** (Holtburg: the goggles release 4.9 m above home, the drone lands on the drop spot, full stow, no prop left on the rig, W walks the character 20 m immediately with the normal MoveToState traffic). **FAILED under a roof** (F1): launched under a stone archway, the return climbed into the structure and settled on it 14 m above home; the sequence correctly chose the noDrone stow (fade, no snap to the hand). Fixed by refusing a covered launch (below). | `eye-*.json` E5; `shots/look-az*.jpg` |
| E6 | **PASS** — `debug.trigger('damage')` while flying: the camera is back on the pilot 1 frame (15 ms) later with the input lock released and the funnel gate open; the drone lands where it is and fades. (A real hit was not taken: the Viamontian Knights attacking +Tester only produced evades.) | in-page probe `e6` |
| E7 | **FPS PASS** — standing 90–108 fps, FPV hover 93, FPV flying 96, pilot view 108 (a clean recorder; an earlier per-frame `__drone.status()` recorder was not the cause: status() costs 0.004–0.01 ms). **First-deploy frames: not met** — one 127–151 ms frame right after the goggle cut on the first deploy at a place: three.js uploading compressed world textures that come into view for the first time when the camera turns back toward the pilot (`compressedTexSubImage2D` inside `uploadTexture`; client texture streaming, not drone code); the click that first loads the drone module evaluates it in 42–89 ms (load-on-first-use). The client itself shows 458–750 ms frames while standing with no drone. 0 console errors throughout. | `perf-*.json`, `cold-deploy.json` |
| E8 | **PASS (graph)** — the 1070 stays muted; an AnalyserNode on the effects bus reads RMS 0.072 while flying (AudioContext running, slider gain 1), so the hum is synthesised and routed through the effects bus. | `eye-*.json` E8 |
| E9 | **PASS** — two full cycles sent only `0x01E9` pings; with `broadcastPose` on, exactly one `0x01E1` (SoulEmote) and one `0xF61C` (MoveToState) at tablet-up. | `eye-*.json` E9; in-page probe `e9b` |

## Findings fixed during the eye test

- **F1 — covered launch.** New refusal `covered` → "Needs open sky above you": at deploy, film `los.segmentBlocked`
  columns above the pilot, the 0.72 m and 1.5 m drop spots and the lift-off end, from 0.5 m to 16.5 m above the
  drop height (body radius; building, statics, scenery and cell layers — not the `objects` layer, so players and
  NPCs standing nearby never count as a roof, and the column starts above the floor the pilot stands on). Checked
  before the input lock; a refused deploy leaves nothing behind.
- **F2 — slope drop.** When the pilot stands on the terrain, the drop follows the terrain at the drop spot whatever
  the slope; a pilot on a floor / platform keeps the foot-level rule.

## Default-on verification (after the flip, 2026-10-25)

Full JS gate 899 passed / 0 failed. On the 1070, a page booted with no `?drone` / `?droneDebug` flag: the launcher is
in the toolbar and visible (`DRONE_DEFAULT_ON` true). Clicking it loaded the module (0.37 s) and ran the full cycle:
deploying → flying (8.4 s) → recall → returning → landing → stowing → idle (35 s). Results: 0 page errors, input gate
open, no drone group left, no debug API (as expected without `?droneDebug`).

## Notes for the owner

- Recall from a few metres away takes 18–20 s to idle (climb to 15 m, cruise, descend, stow) — as PLAN §2.3 specifies.
- The drone on the ground is small (0.32 m) and is often hidden by the tall grass from the default follow camera.
- ACE only streams creatures, NPCs and doors within 112.5 m of the pilot, so past ~110 m of the 150 m default range the
  drone sees terrain and buildings without them. Measurements and the cross-Dereth options: `../ace-streaming/README.md`.
- `shots/` keeps 25 frames downscaled to 1280 px; all 178 full-resolution frames are in
  `/mnt/wbterminal2/drone-deploy-2026-10-24/shots/`.
