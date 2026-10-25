# ACE streaming for a drone flight across Dereth (2026-10-25)

Question: can vanilla ACE stream the live world (creatures, NPCs, doors, portals) around the drone, so a drone video
can cross Dereth with the world alive? Measured on the GTX 1070 against the local vanilla ACE, character `+Tester`.

## Answer

ACE has no camera or spectator concept. It streams world objects only around the **player's server position**: first
sight within 112.5 m (2D) of the player, drawn from the 3×3 landblocks around them; the client prunes objects after
~25 s (ACE sends no DeleteObject when you leave). Terrain, buildings and scenery come from the client bake and are
always there; only server objects (creatures, NPCs, doors, portals, lifestones, items) depend on where ACE thinks the
player is. So the drone keeps the world alive only by moving the player's server position with it. Two ways work
against vanilla ACE today:

| Method | How | Measured | Cost |
|---|---|---|---|
| Teleport dolly | `@teleloc` hops under the drone with `?portalSpace=off` | arrival ≈ 0.3 s, destination objects ≈ 1.4 s (portal space 5.6 s without the flag); every hop resends the area | admin rights; each hop is a jump for ACE (fine between cuts — film mode's cloaked streaming dolly already does this) |
| **Position drag** | the client sends the ground point under the drone as the player's `AutonomousPosition`, ≤ 1 landblock per update | 2 × 768 m at 18.4 and 55.7 m/s: objects streamed continuously, first seen 62–112 m ahead (median ≈ 100 m, same as walking), 0 ACE log lines, `@myloc` = the drag end | a client hook (`hb-drag.patch`, 64 lines, NOT in the main tree) and a drone "dolly mode" (below) |
| Second session | a second, cloaked character's session feeding the scene | not tested | two logins, merging two object streams |

## Why position drag works (vanilla ACE code)

- `GameActionAutonomousPosition`: reads the position, ignores the four sequence stamps, `SetRequestedLocation` unless
  the player is teleporting.
- `Player.UpdatePlayerPosition` (Player_Tick.cs): rejects a step only when it crosses more than one landblock
  (Chebyshev) **and** is longer than `MaxSpeed` = 50 m (the `MOVEMENT SPEED` warning). Within one landblock per
  update there is no speed limit.
- `PhysicsObj.update_object_server_new`: the transition to the requested position only collects collisions, then
  `set_current_pos(RequestPos)` — walls and trees do not stop it (the player passes through them, see the shots).
- `ValidateMovement`: refuses indoor-to-indoor and dungeon-to-dungeon steps across landblocks → outdoors only.
- More than `HugeQuantum` = 2 s without an update drops that one update; keep updates more frequent.
- `CheckMonsters()` runs on every accepted step: monsters near the new position wake. A Mosswart Feeder attacked
  `+Tester` at the end of run N60 — cloak the pilot (`@cloak on`) when filming.

## Runs

Experiment build only: `debugDragPose(cell, x, y, z)` hard-snaps the local player (like a forced server blip) and sends
that pose as one `AutonomousPosition`; `drag-probe.js` steps it every 250 ms along the terrain (`terrainHeightAt`).

| Run | Path | Steps | Achieved | New objects | First seen min / median / max | Ahead | ACE log |
|---|---|---|---|---|---|---|---|
| W20 | 0xA9B40019 → 0xA5B40019, 768 m west | 154 × 5 m | 18.4 m/s | 47 | 78.6 / 99.8 / 112.4 m | 46 of 47 | nothing |
| N60 | 0xA5B40019 → 0xA5B80019, 768 m north | 52 × 15 m | 55.7 m/s | 36 | 62.2 / 100.5 / 111.8 m | 33 of 36 | nothing |

- Baseline: walking into Holtburg, objects first appear at 76–110.5 m.
- The rendered player matched every drag step (0 m error); no portal space; ACE's `@myloc` after N60:
  `Location: 0xA5B80019 [84 7.1 99]`, physics the same.
- ACE's log stayed silent from login to the return teleport (it kept logging its routine saves before and after).
- Streamed in: Royal Guard, Healer, Peddler, drudges, mosswarts, banderlings, a Scavenger Ursuin, an Auroch Yearling,
  wasps, rabbits, chickens, doors, the Cave of Alabree and Asuger Temple portals, the West Holtburg Outpost.
- Raw results: `drag-w20.json`, `drag-n60.json`; frames: `../live/shots/drag-n60-*.jpg`.

## Caveats

- Local ACE only. On a public server the drag is a movement hack (other players see the character slide through trees
  at 20–60 m/s), and teleport hops need admin rights.
- The drone's default range (150 m) is larger than ACE's 112.5 m bubble: past ~110 m from the pilot there are no
  creatures, NPCs or doors (terrain and buildings stay). A default near 110 m, or a signal fade that ends there, would
  match it — not changed.
- From altitude the camera sees past the bubble: the landscape is complete, the life ends ~110 m around the pilot's
  ground point.

## What a cross-Dereth drone flight needs (not built)

1. The hook (`hb-drag.patch`), ideally behind a flag.
2. A drone "dolly mode": while flying, every 250 ms send the pilot to the ground point under the drone; skip the
   `pilotMoved` hard abort (`pilotMovedAbortM: 2` in `scene3d/drone/sequence.js`); measure range and return-home from
   the pilot's current position.
3. `@cloak on` for the pilot while filming.

## Reproduce

- The experiment copy is `/mnt/wbterminal2/hb-drag/holtburger` (repo copy + this patch + a release `pkg/`). From the
  copy: `HOLTBURGER_DIST=/mnt/wbterminal2/hb-drag/dist-overlay python3 scripts/serve.py --port 8766 --bind 127.0.0.1`
  (the overlay keeps its `_health.json` away from the shared dist).
- Tunnel `ssh -fN -R 8766:127.0.0.1:8766 young@100.127.215.75`, then
  `DL_APP=http://127.0.0.1:8766/apps/holtburger-web/index.html capped-wireagent node ../live/drone-live.mjs boot --flags "nosw=1&portalSpace=off"`.
- Run the probe with `__RUN__` replaced, e.g. `{ heading: 270, speed: 20, metres: 768, stepMs: 250 }`:
  `capped-wireagent node ../live/drone-live.mjs eval <probe.js> --shots drag --every 3000 --count 4`.
- Return: `@teleloc 0xa9b40019 84 7.1 94`.
