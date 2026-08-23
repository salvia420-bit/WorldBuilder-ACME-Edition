# HANDOFF — 1070 human test session (2026-08-23): AcmeLights P3+P4 + AcmeRagdoll single-writer

You (the owner) are at the 1070. Everything is ALREADY DEPLOYED — just launch and play.
This doc is the test list, the knobs, and the escape hatches.

## What's deployed on the 1070 (staged 2026-08-23, backups beside each file as *.bak-0823)

- `C:\Games\Chorizite\plugins\AcmeLights\AcmeLights.dll` (89,088 bytes) — adds **P4**
  importance-ranked light selection and **P3** glow dynamic lights; **bloom and torch-on now
  DEFAULT ON** with your proven night knobs as code defaults.
- `C:\Games\Chorizite\plugins\AcmeRagdoll\AcmeRagdoll.dll` (105,472 bytes) — the
  **single-writer death fix**: only the death-hit ragdoll animates a dying body (frozen
  composition basis kills the canned-anim root drag; the flinch layer yields on death;
  the mid-fall eviction race is scoped + logged).
- `C:\Temp\acdt\lights.cfg` — reset to a minimal known-good set (everything else is
  code-default now). `ragdoll.cfg` untouched.

All of this is live-validated headless on the buildbox under wine/DXVK (logs + captures on
your phone), but **your GPU + your eyes are the real gate** — DXVK ran at 20-500 fps
depending on scene; the 60 fps floor can only be judged here.

## Escape hatches (all hot-reload within ~1 s via C:\Temp\acdt\lights.cfg, no relog)

`bloom=0` · `torchlights=0` · `glowlights=0` · `selection=0` (NOTE: selection 1→0 works
live; 0-at-boot means the detour never installs, so *enabling* needs a restart).
Ragdoll: `C:\Temp\acdt\ragdoll.cfg` — `livemotion=0`, `deathvariety=0` as before.

## THE TEST LIST (roughly in order of value)

### A. Fps floor (the #1 gate — you were at ~65 before)
Busiest lit indoor scene you know + a Holtburg pan. If fps dips below 60: try
`selection=0` (isolates P4), then `glowlights=0` (isolates P3), then `bloom=0`.
Report which one buys it back.

### B. Ragdoll: one death, one animation
Kill drudges (single + `@smite all` group). Watch for: ONE continuous fall from the hit,
no flinch-jitter riding the corpse, no root slide/drop from the canned anim underneath,
no mid-fall snap, corpse continues the same fall seamlessly. This is the fix for the
"two animations fighting" complaint — judge it in motion.

### C. Glow lights (P3) — the new headline
- Holtburg drop point: the **lifestone** should cast blue light (5 m away), and portals
  glow-light their surroundings (best at night). Expected tracked set at the drop point
  (regression fixture, P3-GLOWLIGHTS doc §7.1): lifestone 0x7A9B404F wcid 509 @5.4m,
  lifestone wcid 27547 @70m, Portal to Town Network wcid 43065 @86.3m.
- **Red Spire portal** (Holtburg, wcid 11960): previously would have stayed dark (no
  authored light, no luminous surfaces) — now self-evident by class. Confirm it lights.
- `@create 1535` (Ethereal Wisp): pale blue-white light that MOVES with it.
- War spells: projectile in flight should carry a school-colored light; impact = brief
  decaying flash (`glowimpactms`). **Flame Bolt reads white** (shares the generic missile
  setup) — known cosmetic gap, judge if it bothers you.
- **THE THROUGH-WALL TEST (owed, needs a human)**: in a dungeon, leave a wisp in one room,
  walk 2+ rooms away so its room is genuinely out of sight. Expect ZERO light from it.
  Then set `glowcontain=0` and walk back to the shared wall — the holtburger-style bleed
  should appear (that's the A/B proving containment does something). Set back to 1.
- Also owed: wisp OUTSIDE a house while you stand INSIDE — no interior wash expected.
- Optional: `glowstatics=1` — lampposts light up (unvalidated; expect crowding in town).

### D. Selection (P4) — indoor only by design (retail runs it only when !useSunlight)
- Torch-rich dungeon room with MORE than 8 lights around: lighting should look
  noticeably more "correct" (nearest/strongest win) vs `selection=0` (first-8-overlap).
  A/B is one cfg edit, live.
- **The bench test (your ask)**: put a pillar/bench between you and a torch, strafe —
  the lit set must NOT flicker or pop. Camera spins must change nothing.
- Static wall torches now FLICKER (P2's debt, cleared by P4 owning the slots) — worth a look.

### E. Bloom by day
Defaults are your proven night values (0.55 / 2.0 / 3). Daytime outdoors was never tuned —
if it's hot, tune `bloomthreshold` up / `bloomintensity` down live and note what reads.

## Diagnostics if something looks wrong
- `C:\Games\Chorizite\data\logs\log.txt` — `glowlights scan ... N objs -> classed,
  lum/frac-reject, range-reject, candidates, tracking (inject/frame)` + per-emitter lines +
  per-reason REJECT lines (`glowlog=1` is on). P4 heartbeat: `sel=1 seldraws=... selcand=...
  selpick=.../8 selbail=0` (selbail>0 = it fell back to retail; report it).
- Ragdoll: `ragdoll ARM ... class=` / `ragdoll RELEASE` (eviction now logs) /
  `livemotion YIELD` (flinch yielding to a death) / `ragdoll BASIS` (landblock rebase).

## Repo state
`integ/all-20260813` pushed through `b73146e9`. AcmeLights commits: c2035d0a (defaults),
a0d346bd (P4), f1aff127+2c294006+a999ebd7 (P3 + fixups). AcmeRagdoll: 3bc4c843.
Design docs: `P4-SELECTION-2026-08-23.md`, `P3-GLOWLIGHTS-2026-08-23.md` (both in this dir);
ship notes + owed tests: bottom of `HANDOFF-2026-08-22-lighting-bloom-next.md`.
Buildbox is POWERED OFF.
