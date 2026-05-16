# Holtburger 1070 in-game fixes — 2026-05-16

Visual evidence for the four commits between `405b9bd..75d69a6`:

| Commit  | Fix |
|---------|---|
| `c656764` | scenery bake B.5 collision parity (Rust = ACE bit-for-bit on 16,700 placements) |
| `0372182` | takram atmosphere bake completes in-game (RIC microtask shim) |
| `5ca1dc7` | STATICS / BUILDINGS ring radius 2→6 (full 13×13 baked at boot) |
| `75d69a6` | NPC bodies render (animation-cache race) + cloud overlay is depth-aware |

All screenshots captured live in-game on the GTX 1070 box via CDP after a clean session
(SW + caches cleared, login → connect → wait 10s → connect → spawn).

## Audit snapshot at capture time

```
atmosReady:       true            ← takram Bruneton bake completed
atmosBakeMs:      973             ← post-RIC-shim (was infinite hang)
terrain:          169             ← full 13×13 LB ring
staticsChildren:  132
staticsInst:      684
buildings:        47              ← was 23 at radius=2; now full ring
entities:         74
meshfulEntities:  74              ← was ~30 % pre-animation-cache fix
meshlessEntities: 0               ← every NPC has a body
bakedLbs:         169
cloudDepthWired:  true            ← cloud overlay samples scene depth + discards
```

## Screenshots

1. **`01_spawn_default_view.png`** — Default spawn view. Player avatar (third-person, brown hair) + a blue creature NPC + Holtburg houses on the right. Bright atmosphere lighting from the takram Bruneton bake. The fact that the creature has a body at all is the post-`75d69a6` fix — before that, ~70% of NPCs would spawn as just a floating nameplate.
2. **`02_after_centre.png`** — Same scene after the home/centre button click. Confirms the cameraSwitcher's player-tracking is alive.
3. **`03_follow_on.png`** — Follow mode enabled. The avatar is properly framed third-person.
4. **`04_rotate_left.png`** — Camera rotated left. Player remains in frame with body intact across camera changes.
5. **`05_rotate_left_more.png`** — Further left rotation. The avatar's mesh is visible from a different angle — proves the per-part rig stays attached across multiple spawns sharing the same setupId.
6. **`06_walked_forward.png`** — After walking forward (W key). Sky visible at top edge with no cloud-over-building artifacts (the `cloudDepthWired=true` discard at work — cloud fragments behind world geometry are dropped by the shader).
7. **`07_rotated_right.png`** — Rotated right. Town houses + atmosphere lighting in frame.
8. **`08_explored_town.png`** — Deeper into the town. Multiple NPCs visible, every one of them with a body — confirms the AnimationCache `partGroups` fix landed: shared geometry across N THREE.Mesh instances for the same setupId, no more first-spawn-only rendering.
9. **`09_facing_clouds.png`** — Different facing showing the Life Stone (a player-class object) and a guard NPC ("Alcott") with a body. The Life Stone glows blue with proper alpha; clouds elsewhere in sky don't paint over the building it's next to — depth-correct overlay confirmed.
10. **`10_wide_town_view.png`** — Wider town view. All systems working in concert: terrain, buildings, NPC bodies, atmosphere-lit sky.

## How to reproduce

Per the project memories:

1. `wbterminal` machine: dev server on `0.0.0.0:8137` (the staged dist v2 mounts at `/dist/...`).
2. Reverse SSH tunnel: `ssh -fN -R 7080:127.0.0.1:8137 young@100.127.215.75`.
3. Chrome on the 1070 box auto-launches at logon via `C:\Temp\holtburger-chrome-debug.ps1`
   with `--remote-debugging-port=9222`. URL it opens: `http://localhost:7080/apps/holtburger-web/index.html?renderer=3d&clouds=on`.
4. Login: account `tailnet1`, password `tailnet1`, server `127.0.0.1:9000`, bridge `ws://127.0.0.1:8080/`.
5. Double-Connect dance (memory: `project_holtburger_login_double_connect`):
   first Connect kicks any prior session; wait 10 s; click Connect again to actually log in.
6. Click Spawn on the `+Tester` character.

The page boots through atmosphere bake (~1 s with the RIC shim), stages the 13×13
scenery ring, drains all spawn events through `__scene3dEntityHook`, and lands in-world
within ~30–45 s of the Spawn click.
