# HANDOFF — 2026-08-22 (late): AcmeRagdoll live-motion layer (Tier 0 + Tier 1) BUILT

Continues `HANDOFF-2026-08-22-ragdoll-individualization.md` (693 death profiles, shipped) and
the tier plan in `/mnt/wbterminal2/ragdoll-individualize/research-custom-anims.md`. Owner
calls honored: gait IN as a flagged prototype (first-to-cut), hit layer DEFAULT-ON in cfg
(bar = loads/spawns/0 errors), idle micro-motion KEPT. Everything below is working-tree only
(NOT committed), builds 0 warnings, and is offline-harness-verified; the single open gate is
the 1070 eye-test (procedure at the end + in AcmeRagdoll/README.md).

## Tier 0 — semantic part roles, all 693 bodies (SHIPPED in ragdoll_profiles.json)

Per body: archetype (biped 198 / prop 227 / floater 154 / blob 40 / quadruped 27 / arthropod
23 / avian 16 / serpent 7 / mixed 1) + per-part {role, looseness w, ground} folded into the
plugin's `ragdoll_profiles.json` ("parts" array; loader = Lib/RagdollProfiles.cs). Produced
by: mechanical feature extraction (rest bind pose, per-part walk/attack/idle energy from all
1,531 retail anims, symmetry, ground band → `/mnt/wbterminal2/livemotion/livemotion.db`),
rig-dedup (693 bodies = 143 identical rigs; representatives tagged by Opus agents, structure
propagated), a 337-entry cross-class review pass (24 surgical overrides incl. 8 walking
humanoids wrongly inheriting a rift's floater tags), validators mechanical throughout.
Notable rig truths recorded in roles_merged.json notes: DAT parent quirks (head parented to a
hand on several humanoid rigs — why role weights, not parent depth, drive stiffness),
tripedal Reedshark/Mattekar, hollow rigs with invisible placeholder parts (0x0100002C,
0x010001EC — never ground-pinned), the 69-body shared elemental armature.

## Tier 1 — the live-motion layer in AcmeRagdoll (stages C0–C5)

- **Signals (C0/C1)**: managed route via `Chorizite.Core.Net.NetworkParser` — H1
  `Effects_PlayScriptType` 0xF755 (target GUID + splatter type 0x5B–0x66 encoding attack
  height + attacker quadrant → impulse direction) correlated ±300 ms, order-agnostic, with H2
  `Combat_HandleAttackerNotificationEvent` (damage %, crit — carries NO GUID, name only;
  retail-verified, hence the correlation). Splatter alone still fires at a default magnitude.
  ACE fact: other players' MELEE hits never reach your client (spells + monster-vs-monster
  do) — swarm reactions are naturally rate-limited. Player exclusion: BF_PLAYER bitfield
  (weenie_obj→pwd._bitfield bit 3), fail-closed tri-state + GUID prefilter; never arms on
  players. `LiveMotionRegistry` is separate from the death registry; both hang off the one
  UpdateParts post-detour with OR-vote arming; disabled ⇒ one null check.
- **Physics (C2)**: per-part PD springs (k=320, ζ≈0.25) around the freshly-animated pose,
  translation only; energy pool with hard cap + 1.5 s half-life (over-cap hits refresh, never
  grow — the anti-seizure design); crit = 2.5× impulse behind a 1 s refractory gating only
  the extra; per-part looseness from Tier-0 weights (fallback: parent-depth heuristic);
  amplitude clamped to 5% of measured body radius; 30% attenuation while the body's own
  motion is attack-class; writes + Frame::cache() only for parts above 0.8 mm; retirement is
  visibility-based (the harness caught the pool-epsilon bug that would have idled entries
  armed ~11 s). Offline harness reflects into the SHIPPED dll: no-impulse ⇒ zero writes;
  settle inside envelope; saturation cap holds under a 60-hit swarm; attack table exact-match
  vs the run's classifier.
- **Live cfg (C3)**: `C:\Temp\acdt\ragdoll.cfg`, 1/s mtime-gated reload from existing paths
  (UpdateParts tail + both net handlers — no new thread), immutable snapshot swapped by
  reference, every physics knob live-tunable; `livemotion=1` default ON. Sample cfg:
  `/mnt/wbterminal2/livemotion/out/ragdoll.cfg.sample`; full knob table in README.
  Known nuance: re-enabling from cfg while totally idle waits for the next hit signal.
- **Idle micro-motion (C4)**: archetype-driven (bipeds/quads breathe, floaters bob + sway
  cloaks/tentacles, blobs pulse, props hard-skip), phase-decorrelated per object id, summed
  with the springs inside the same clamp/epsilon. Scope is POST-COMBAT LINGER
  (`idlelingersec=30` floor after the last hit), NOT world-wide ambient — ambient would keep
  the hot hook armed for every idle creature; that is a 1070-measured decision for later.
  Harness: 1,158 writes bit-identical with idlemotion=0; all 693 bodies through the parser.
- **Gait prototype (C5, `gait=0` default)**: tripod-gait overlay on ONE hexapod
  (0x02000F95 Olthoi Piercer), lift+sweep half-wave on the six baked leg chains, tripod
  opposition structural, cadence from EMA'd real ground speed (cell-handoff safe) with knob
  fallback; rides C4's linger, never raises layer cost. Harness: 6,167 writes bit-identical
  with gait=0; non-leg parts exactly zero; clamps hold.

## Files (AcmeRagdoll/, all uncommitted)
New: `Services/LiveMotionRegistry.cs`, `Lib/LiveMotionConfig.cs`, `Lib/RagdollProfiles.cs`,
`Sim/RagdollParams.cs`, `Sim/IdleMotion.cs`, `Sim/GaitMotion.cs`, `ragdoll_profiles.json`
(693 bodies: death params + archetype + parts weights). Modified: plugin/init + warmup,
NativeHooks (dispatch + votes + OnMotion feed), RagdollRegistry (params + sweep hardening),
RagdollSim (parameterized, bit-identical defaults), csproj (ACProtocol ref, JSON ships),
README (the tuning reference). Run artifacts + pipeline:
`/mnt/wbterminal2/livemotion/` (RUNBOOK, livemotion.db, roles_merged.json, role_overrides,
fold_roles.py, validators, briefs, c0-hook-report.md).

## 1070 eye-test script (the open gate)
Deploy dll+manifest+ragdoll_profiles.json; expect logs: `ragdoll: 693 profiles loaded`,
`livemotion THREADS … same=True`, hooks installed. Then, per README's procedure:
1. Hit-spam: 6 drudges on you / you on one — flinches read, telegraphs stay readable, no
   seizure (saturation, not queueing).
2. Crit: visible stronger rock-back; spam crits → refractory holds.
3. Boss-swarm analog: sustained fire on one target — bounded shudder at the cap.
4. Player exclusion: your own character and other players never flinch.
5. Idle linger: stop fighting; the survivor breathes/sways ~30 s then goes quiet (verify the
   hook disarms — log `LiveCount` 0).
6. `gait=1`, find an Olthoi Piercer, watch it walk (texture over the retail anim, feet
   planted in stance).
7. Tune via `ragdoll.cfg` edits only (1/s reload) — no redeploys; knob table in README.
8. Cost check while ~10 bodies linger (the README's flagged risk): frame time steady.
