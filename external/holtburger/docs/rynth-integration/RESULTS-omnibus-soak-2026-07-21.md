# RESULTS — Omnibus deploy-gate soak (2026-07-21 20:03–20:34, cold academy)

Post-apply of the 16-package omnibus (`4118bf9d`). Rig relaunched clean (caches
purged, journal+scratchpad wiped, key+atlas kept, one expected error-boot),
release wasm 4.84MB, all local gates matched the box (node 50/0/2, world 579/0,
core 606/0/1-ignored). ffmpeg push live throughout (NEW YouTube watch URL —
check YT Studio).

## Gate verdict: 4 of 5 PASS — coverage criterion FAILS, single root cause

| Criterion | Result |
|---|---|
| No in-academy death | PASS — zero deaths over 30 min |
| Leaves the start cell | PASS — 860201b0 → b2 → b1 movement throughout |
| `coverage().tiles` strictly increases | **FAIL** — 2→3 in the first 7 min, then flat 22+ min |
| No terminal wedge | PASS — movement live, director escalating, MoveTo functional |
| ACE log: no `failed transition … [.. 0]` z-embed lines | PASS — zero (WP-1 oracle green) |

Pressure-ladder behavior matched the plan: straight-line hops GONE (frontier
hop issued "via 9-leg route"), dead-portal blacklist + portal ledger in use
(Samuel marked ineffective → Jonathan tried), honest "dungeon apartment with
no ground-level exits" diagnosis + use_object escalation.

## Root cause of the coverage stall: nav_guard false-positive park (WP-9)

- Client pose in the academy reads z=0.000 — a CORRECTLY SOLVED pose: the
  academy EnvCell floor plane is z=0; ACE's stored/spawn z of 0.005 (shard DB,
  cell 860201AD) is only the anti-z-fighting offset above the floor, not the
  walkable plane (operator-confirmed). Server accepted every transition all
  soak; `arrivalPlacementDiag` = engaged 1 / failed 0.
- `nav_guard.js` `isSubFloorZ` parks any indoor pose with z ≤ FLOOR_EPSILON
  (0.0002). Its "z=0 parks, z=0.005 proceeds" epsilon assumed the client pose
  mirrors the server's +0.005 offset; the client floor-solve legitimately
  settles at exactly 0.000 on a z=0 floor → the guard holds forever
  ("NAV: pose un-solved (z=0), holding", one hold episode, 22+ min).
## Second finding: academy exit is a GIVE flow, and NPC≠portal (design)

The "ineffective portal" attempts were NOT the guard and NOT a mover bug — the
bot stood 0.7m from Samuel ("no-walk" = already adjacent, per world.js). The
real facts (ace_world emote tables, wcid 29324 `academyguardexitholtburg`):

- Samuel (29322 `academyguard2`) is a plain guard, not an exit NPC. The
  escalation rung journaled him as a "portal" and use_object'd him repeatedly.
- Jonathan IS the exit, but Use only stamps `AcademeyExitTokenGiven` + hands
  over an Exit Token (QuestFailure branch); re-Use says "already gave you one"
  (QuestSuccess). The teleport + SetSanctuaryPosition (the lifestone re-bind)
  fire ONLY on TestSuccess — GIVING the Exit Token back to Jonathan.
- So use_object can never exit the academy. The heard plumbing works (tells
  reach observations), but the phi-4 director never chained
  use → token → give-to-Jonathan; the observation's inventory section also
  read "n/a", so the model may never see it holds the token.
- Operator direction: do NOT widen the portal-escalation ladder to treat NPCs
  as portals — that conflation is the bug, not the base. NPC interactions
  belong to the director's dialog/give machinery (heard tells + hand/give
  tools), with the portal ladder reserved for actual portals.

## Recommended fixes (pending operator decision)

1. nav_guard park (coverage stall): make the sub-floor rule strictly
   below-plane — park only when `z < floorPlaneZ − ε`, not at the plane.
   Un-solved gaps remain covered by the existing `objCellId===0` sentinel and
   placement-diag failure count. JS-only (`nav_guard.js` + test), no wasm
   rebuild, no cross-LB guard change.
2. Escalation taxonomy: stop classifying NPCs as portals in the pressure
   ladder's escalation rung (portal-only), and surface inventory (or at least
   quest-relevant items like the Exit Token) in observations so the director
   can complete give flows on its own.

## Session ops notes

- The handoff's `pkill -f` self-kill trap fired once here too (exit 144 via
  `pgrep -f rust-analyzer` matching its own command line) — bracket-trick
  (`[r]ust-analyzer`) is mandatory.
- launch.sh was already synced to phi-4/kernel-on/explorePressure=1 — the
  2026-07-20 drift warning in STREAM-RIG-OPS.md is resolved.
- Wave D/E wiring remains deferred per the plan; survival criteria all passed,
  so the DEFERRED-list order can proceed once the guard fix restores coverage
  growth.
