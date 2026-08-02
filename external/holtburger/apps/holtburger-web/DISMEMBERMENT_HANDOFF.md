# Combat-visuals handoff — directional splatter, limb damage, dismemberment
2026-08-02. Phases 1–3 of the "physical combat" plan landed flagged-off. All
three flags are STRICT `=== "on"` opt-ins (never `!== "off"`); bare-default
arms are byte-identical to the pre-phase client and were verified by node
suites only, per the no-agent-eyetests policy. Nothing here has been seen by
human eyes yet — the checklists below are the queued 1070 session.

## What landed

| Phase | Flag | Files | Verified by |
|---|---|---|---|
| 1 — directional + crit splatter | `?combatFx=on` | scene3d/splatter_decode.js (new), scene3d/play_effect_vfx.js | 18/18 decode, 22/22 integration, 10-spelling off-parity (scratchpad suites) |
| 2 — limb registry + limping | `?limbDamage=on` | scene3d/limbs.js (new), scene3d/entities.js, scene3d/diag.js | 82/82 incl. Noble(2-leg)/Primordial(4-leg) fixtures, 600-frame anti-drift |
| 3 — slicing dismemberment | `?dismember=on` | scene3d/dismember.js (new), scene3d/index.js (lazy gate), vendor/dgreenheck/three-pinata.js (MIT, 2.0.1) | 10/10 weld→audit→pinata-slice on real Olthoi DAT geometry in client de-indexed bucket format |
| 4 — death ragdoll | `?ragdoll=on` | scene3d/ragdoll.js (new), scene3d/entities.js (death arm + tick + handoff transfer), scene3d/diag.js | 18/18 pure-sim suite (topple/settle/constraint-hold/quat math/degenerates), 82/82 limbs regression |
| infra | — | src/lib.rs `fetchSetupParentIndex` (pkg rebuilt **release**, 5.48 MB), index.html importmap + regenerated modulepreload | export present in pkg/*.d.ts |

Combined smoke URL for the eye session:
`?combatFx=on&limbDamage=on&dismember=on&ragdoll=on&nosw=1`

### Phase 4 design — the corpse/loot problem and its answer
The lootable corpse is a separate server object that spawns holding the
authored end-of-death pose, so a naive ragdoll would pop back to the prone
pose the instant the corpse reveals. Solution shipped: the existing
`_tryCorpseDeathHandoff` (which already hides the corpse while the creature
finishes dying) now, at reveal time, calls `transferRagdollPose(creature,
corpse)` — the settled sprawl is copied onto the corpse's OWN part Groups as
a frozen post-mixer overwrite. The corpse object is otherwise untouched:
server position, selection, nameplate and picking meshes are exactly as
before, so click-to-loot works identically; only the pose differs. Part-count
mismatch (ObjDesc variants) falls back to the authored prone pose. Creatures
that die with NO corpse correlation (despawn kills, out-of-radius) simply
ragdoll until removal — same lifetime as today.

## Console driving (no server changes needed)

```js
// find a target
const em = liveScene3d.entityManager;
const inst = [...em.entityMap.values()].find(i => i.meta?.name === "Olthoi Noble");

// limb registry + limp
__diag.limbs.registry(inst.guid)                  // → legs with L/R×F/B tags
__diag.limbs.damage(inst.guid, 22, 1.0)           // leaf part → full limp
__diag.limbs.clear(inst.guid)

// dismemberment — NOTE: the chained form needs BOTH ?dismember=on AND
// ?limbDamage=on (registry() is null without the latter → TypeError before
// slice ever runs — the 2026-08-02 field-debug lesson). Flag-independent form:
__diag.dismember.auditAll(inst.guid)              // manifold report per part
await __diag.dismember.slice(inst.guid, 15, { critical: true, chainParts: [16,17,18] })
__diag.dismember.restore(inst.guid)               // regrow

// splatter health after a fight
__test.combatFxStats()                            // {latched, consumed, latchMissName, ...}
```

## Queued eye tests (owner 1070 session — do not run from agents)

### Phase 1 — combatFx
1. Bare default (no flags): identical old behavior, `__test.combatFxStats()` all zeros.
2. Hit a Drudge from behind-left, aim low → splatter at ITS lower rear-left; circle to front-right → flips. Side tracks the Drudge's facing, not the camera.
3. Height bands: over ~30 hits, three distinct bands (knee/waist/head) on tall (Olthoi) and short (Mosswart) mobs; "Up" band at the head, never ~2.7 m above a short mob (nameplate leak check).
4. Spray travels outward + sags; never into/through the torso.
5. Crit (watch chat): bigger/longer/pinker once, next normal hit back to small (consumed-on-read). Crit taken: big splatter on YOUR rig.
6. AoE 4–6 mobs: `__test.activeBurstCount()` ≲ 64, no fps cliff, clean console.
7. `consumed ≪ latched` in stats = the kind30/kind19 ordering race is real → latch should be made bidirectional.

### Phase 2 — limbDamage
1. Bare default: rigs identical, zero `[entities/limbs]` console lines.
2. Registry on a biped (Olthoi Noble): 2 legs L/R, `end:null`; on a quadruped (Primordial): 4 legs LF/RF/LB/RB. **Confirm tags match the on-screen legs** — this validates the +Y-forward/+X-right model-space assumption that also drives the limp hinge axis.
3. Damage one leg on an idler: dip+swing ~0.9 s, other limbs still; 30 s soak → no cumulative fold-up.
4. On a walker: limp reads over the gait, no popping, no skating change. Two legs damaged → staggered, not synchronized.
5. Damage → die (prone clamp) → no integration on the frozen rig. Damage → equip/unequip (appearance hot-swap) → no stuck bend.
6. Severity sweep 0.25/0.5/1.0 — retune `LIMP_MAX_ANGLE`/`LIMP_MAX_DIP`/`LIMP_PERIOD_S` (exported consts) if 12°/6 cm reads wrong.

### Phase 3 — dismember
1. `auditAll` on a few creature families (Olthoi, Drudge, Tusker, human NPC): expect boundaryEdges ≈ 0 on most parts (DAT audit predicts ~83% perfect, defects of 2–3 edges elsewhere).
2. `slice` a leg mid-part: stump caps with dark flesh material, no holes at the cut on watertight parts; severed piece + chain segments tumble outward, one damped bounce, rest, vanish at 12 s.
3. Sliced entity keeps animating (stump follows the leg's anim); `restore` regrows cleanly.
4. Slice + `?limbDamage=on` damage on the same leg → limp of a stumped leg reads correctly.
5. Crit slice (`{critical:true}`) visibly more violent (faster ejection, more spin).
6. Perf: a slice mid-fight should not hitch (>1 frame) — spike measured 1–8 ms/part on the weak laptop, expect better on the 1070.

### Phase 4 — ragdoll
1. Bare default: deaths identical to today (authored collapse + corpse), zero console lines.
2. `?ragdoll=on`, kill a mid-size creature (Drudge): it topples and crumples physically instead of playing the collapse; settles within ~1–2 s; no jitter after settling.
3. **Loot check (the reason this phase was tricky)**: after the corpse reveals, it lies in the SAME sprawled pose (no pop back to the authored prone pose), at the server's spot, and is clickable/lootable exactly as before. Loot a dozen ragdolled corpses.
4. Kill a quadruped (Primordial-class) and a large creature (Tusker): limbs fold plausibly along their chains, no limb stretches (constraint hold), nothing clips far under the terrain.
5. Crit kill: visibly more violent launch than a normal kill.
6. Kill mid-charge: ragdoll starts from the run pose and carries the topple in a believable direction; corpse lands at the authoritative server spot (dead-reckon freeze unchanged).
7. Local player death: still the authored collapse (ragdoll deliberately excluded).
8. `__diag.ragdoll.kill(guid)` on a living creature: sandbox test of the sim without a real death; `state(guid)` shows `settled/done` progressing.
9. Composition: `?ragdoll=on&dismember=on` — slice a leg via diag, then kill: stump rides the ragdoll; debris pieces unaffected.
10. Retune knobs if needed: `RAGDOLL_IMPULSE(_CRIT)`, `RAGDOLL_DAMPING`, `RAGDOLL_FLOOR_FRICTION`, `RAGDOLL_SETTLE_*` — all exported consts in ragdoll.js.

## Follow-up work (in rough order)

1. ~~**Death automation**~~ **SHIPPED 2026-08-02 as Phase 5 (`?carnage=on`,
   scene3d/carnage.js)** — splatter→limb attribution (Low=leg, Mid=50%,
   Up=never; quadrant picks the leg), 2 hits = limp, 4 = mid-fight lower-leg
   sever, death = hip sever of the most-damaged leg (+ second leg on a ≤4s
   crit) before the ragdoll arms. Verified: 12/12 attribution tests. Combined
   smoke URL now: `?combatFx=on&limbDamage=on&dismember=on&ragdoll=on&carnage=on&nosw=1`.
   Remaining polish: crit correlation rides defenderName (same ordering race
   as combatFx), thresholds are first-guess constants, Mid-band coin flip is
   unseeded.
2. **Crit latch ordering**: if the eye session confirms `consumed ≪ latched`,
   make the latch bidirectional (late notification upgrades a just-spawned
   splatter).
3. **Primordial-class gap margin**: leg split decided by a 0.45 vs 0.44 gap —
   if a third quadruped misclassifies, switch `splitLegChains` to a relative
   gap metric (`MIN_LEG_GAP` is the knob, limbs.js).
4. **Ragdoll refinements** (Phase 4 core SHIPPED 2026-08-02, see above):
   (a) feed the topple direction from the killing blow (splatter quadrant /
   crit latch) instead of a random yaw — `startRagdoll` already accepts
   `{dir, critical}`; (b) uneven-terrain floor: the sim uses a flat plane at
   the root's ground level — steep-slope deaths could sample
   `terrainHeightAt` per node; (c) self-collision / floor for non-flat
   dungeons is intentionally out of scope.

## 2026-08-02 (late) — pinata expansion, corpse-handoff repair, blood decals

**Pinata feature expansion** (dismember.js 1157 lines, carnage.js 561): new
primitives `fracturePart` (impact-biased voronoi gib), `chipPart` (crater a
part, bulk stays attached), `dislocatePart` (persistent joint offset via
child-mesh matrices — no tick-order dependency), `refractureDebrisNear`
(progressive destruction, generations 0→2). Carnage escalation policy
(pure/seeded, 1100ms cooldown, per-fight caps): crits→dislocation 45%,
body hits→chips ramping to 24%, stump-neighbour fracture, resting-chunk
re-fracture; death adds limb gib (≥9 hits or crit+5) and torso gib
(crit+12). Measured over 400 seeded kills: ~2.3 mid-fight events + ~5
total per fight, no sequence >20% repetition. Debris cap 24→40; large
resting pieces register with ragdoll_env (corpse draping) and blood pools.

**Corpse-handoff repair** (trace agent found the handoff had NEVER worked):
(1) hide/reveal now via `_setEntityStateVisible` — the raw `root.visible`
write was recomposed to visible by the next frustum-cull pass, every kill;
(2) loop.js removal timer re-checks `_corpseHandoffGuid` at FIRE time — it
used to destroy the ragdolling creature before finishReveal could read it,
every kill; (3) correlation window keyed to ragdoll liveness + 4s grace
(async time-sliced corpse spawns landed late in busy dungeons); (4) death
hold floored at 400ms (link-less creatures collapsed the window to ~33ms).
Chain now logs at console.info: `[handoff] corpse↔creature`, reveal state,
transfer outcome, ragdoll arm-failure reasons.

**Blood decals** (`?blood=on`, scene3d/blood_decals.js): see url-flags.md
row — surface-stamped liquid stains (walls/floors/ceilings/terrain/trees),
one InstancedMesh cap 1024, shader-side aging, pools under settled bodies.

**Dismemberment carry-over — SHIPPED (same session)**: `transferDismemberment`
(dismember.js) moves the creature's stump/cratered meshes onto the corpse
rig and mirrors hidden chain parts at finishReveal time (window hook
`__dismemberTransfer`, registered under `?dismember=on`; entities.js never
imports the module). Meshes are MOVED, not cloned — evacuating them before
the creature's disposal walk is what keeps the corpse's stump geometry
alive. Corpse originals stash undisposed; `restoreParts(corpse)` undoes
everything; rig mismatch logs and safely keeps full geometry. 16/16 node
checks (test_corpse_carry.mjs) + full regression battery green.

**Corpse RE-SPAWN persistence — SHIPPED (same session)**: corpses are
removed/re-materialized constantly (vis churn, dungeon cell transitions,
walk away+back) and the sprawl/stumps died with the instance — re-spawned
corpses reverted to the authored prone pose with regrown limbs ("the old
corpses come back"). Fixed with bounded per-guid archives (pose in
ragdoll.js `_corpsePoses` 48×10min; stumps/hidden in dismember.js
`_corpseDism` 32×10min — stump geometry ownership moves to the archive by
untagging `__disposable`, eviction disposes). The corpse spawn hook in
entities.js restores from the archives FIRST and only runs the death
handoff for unknown guids. Console: `[ragdoll]/[dismember] corpse 0x…:
archived … restored on re-spawn`. 14/14 round-trip checks incl. simulated
disposal walks, triple re-spawn, TTL expiry (test_corpse_respawn.mjs).

**Still open**: `_corpseHandoffGuid` never clears if the corpse despawns
between claim and reveal (narrow); dislocation offsets don't carry to the
corpse (child-mesh matrices are replaced by the carry-over — minor); blood
decals don't rotate with moving platforms (none exist);
thresholds/probabilities are first-guess pending the 1070 session.

## 2026-08-02 field-debug postmortem (dual Opus review, both bugs fixed)

- **ROOT CAUSE of "canned death / no limp / registry null": `fetchSetupParentIndex`
  was never added to index.html's hand-curated `wasmExports` bag** (the
  plumb-through trap the file warns about repeatedly). Fixed with a
  namespace-rider entry next to `pollMotionActions`; limbs.js now warns once
  when the fetch fn is missing so this class of failure can't be silent again.
- **`?v=` stamp never reached the .wasm binary** — the glue derives the wasm
  URL from `import.meta.url`, which drops the query. All four argless
  `init()` sites (index.html main, bake_worker, net_worker, net_worker_client)
  now pass the stamped URL explicitly. serve.py's `no-cache` on `.wasm`
  masked this locally; any other host would have been bitten.
- **three-pinata returns per-half CONNECTED-COMPONENT islands, not 2 pieces**
  — multi-shell parts could lose geometry or mis-assign the stump. slicePart
  now partitions every piece by plane-side centroid: joint-side pieces all
  become stump meshes, far-side pieces all become debris; degenerate slices
  log a console.debug instead of failing silently.
- Remaining known limitations (reviewer-flagged, deliberate): stump uses the
  part's first surface material only; welded seams collapse hard-edge normals;
  a creature that dies while LOD-degraded to a raw `0x01` GfxObj permanently
  caches a null registry for that setupId this session; `__diag.dismember`
  parses string guids as decimal while `__diag.limbs` parses hex — pass
  NUMBERS to both.

## 2026-08-02 (later) — fly-away fix, kill-driven falls, finisher variety

Three owner-reported problems with the cced079c carnage suite, fixed in one
pass. No flag semantics changed: all six flags stay DEFAULT ON with `?flag=off`
escapes and `!== "off"` readers. No wasm change (`fetchSetupParentIndex` was
already in `pkg/`).

### 1. Ragdolls could gain energy and LAUNCH — fixed at the source + governed

Three defects fed the fly-away, all in `stepSim`:
- **(a) the launcher.** The floor projection inside the relaxation loop moved
  `pos` without moving `prev`. Verlet reads velocity as `pos − prev`, so a deep
  penetration (the rigid braces yanking nodes through the ground while the body
  spun) became an *upward impulse* proportional to the penetration depth.
- **(b) restitution was skipped exactly when it was needed.** The contact pass
  computed `vz = pos − prev` *after* the projection, so a deeply penetrating
  node read as "already rising", missed the `vz < 0` bounce branch, and kept
  the whole invented velocity.
- **(c) nothing bounded the over-constrained solve.** Bone + bend + up to three
  braces per node, relaxed 5×/step, resolve conflicts by displacement — and
  every displacement is a velocity.

Fixes (all in `scene3d/ragdoll.js`):
- `sim.push[]` accumulates the projection depth per node per step; the contact
  pass subtracts it out before applying restitution, and now also runs for
  nodes a later constraint lifted clear of the contact band.
- Per-node speed ceiling `RAGDOLL_MAX_SPEED = 8 m/s` and a tighter **upward**
  ceiling `RAGDOLL_MAX_UP_SPEED = 3 m/s` (v²/2g ⇒ ≤ 0.46 m of ballistic rise,
  whatever the constraint state).
- A ratcheting **mechanical-energy governor**: `E = Σ(½v² + g·z)` is measured
  every step (both terms at the midpoint `t − dt/2`, so verlet's backward-
  difference velocity is not paired with an endpoint height) and may never
  exceed the previous step's value; the ceiling ratchets DOWN as damping and
  friction bleed the sim. Energy after arming is therefore monotonically
  non-increasing. Telemetry: `__diag.ragdoll.state(guid).{energy, eCap, trims,
  maxRise}`.

Measured, old module vs new, 300 seeded deaths × a 33-node "big creature" rig
(`stress.mjs`, scratchpad), body armed 0.6 m inside the floor:

| | E/E₀ | worst node rise | worst centroid rise | worst node speed |
|---|---|---|---|---|
| cced079c | **16.61×** | 5.65 m | **4.13 m** | **28.6 m/s** |
| fixed | 2.66× * | 1.53 m | 0.54 m | 8.0 m/s |

\* the residual 2.66 is the *first* step legitimately lifting a body that was
armed underground (potential energy, zero velocity); the cap is taken after
step 1 so an interpenetrating arm pose can still resolve.

### 2. Falls were canned — now driven by the actual kill

**Root cause.** `entities.js` armed with `startRagdoll(inst)` — no opts — so
`startRagdoll` fell through to `dx = 1, dy = 0` and seeded `impulse =
[RAGDOLL_IMPULSE, 0, …]`. `initSim`'s "no direction ⇒ random yaw" branch was
therefore **unreachable** (the impulse XY was never zero) and every creature in
the world toppled toward MODEL +X — its own right. Measured on the pre-fix
module: 200 deaths landed in **2 of 8** azimuth bins (`101,0,0,0,0,0,0,99`).

**New module `scene3d/kill_impulse.js`** (dependency-free, bare-node testable)
resolves the direction, best source first:

1. **Projectile impact.** ACE streams no in-flight motion for a
   `PhysicsState::Missile`; the launch velocity arrives once on ObjectCreate
   (entities.js already seeds `inst.lastVel` + `_ballistic`) and the only
   VectorUpdate a projectile ever receives is the impact stop. `setVelocity`
   now captures the pre-impact velocity and calls `noteProjectileImpact(x, y,
   dx, dy)` — the exact flight direction of the bolt/arrow. Correlated to a
   victim at death by proximity (≤3 m, ≤2.5 s) because the impact carries no
   defender guid.
2. **Attacker position.** `damageDealt` → `defenderName` → guid via
   `EntityManager.findGuidByName`; the attacker is the local player, whose
   world position we have. `damageTaken` is the mirror.
3. **Splatter quadrant.** Every hit on every creature broadcasts one of the 12
   Splatter PlayScripts, which decode to a TARGET-RELATIVE quadrant — where the
   wound is, hence where the blow came from. Push = −quadrant. This is the only
   source that works for fights we are merely watching, and it always fires:
   noted from `play_effect_vfx.js` *outside* the `combatFx` gate (gated on
   `?ragdoll` alone).
4. **Nothing.** A seeded azimuth over the full circle.

Sources are blended with recency (1.5 s half-life) and per-source confidence
weights; opposing hits cancel to low confidence, which widens the seeded fan
instead of picking a bogus direction. The victim's own momentum (`inst.lastVel`)
leans the fall, so a mob dying mid-charge carries forward.

On top of that, a per-death **fall style** is drawn from the seed —
`topple / spinout / crumple / faceplant / sidefall / sidefall2 / backflop` —
each scaling the topple rate, the vertical twist and the direction fan
(`initSim` gained `toppleScale`, `twistScale`, `dirJitter`). `startRagdoll`'s
no-direction path now passes a ZERO impulse XY, so the random-azimuth branch is
finally reachable as a second line of defence.

Diag: `__diag.killImpulse.{stats, last, hits, probe, clear}`;
`__diag.ragdoll.state(guid).{style, source, critical}`.

### 3. More pinata — seeded death finishers

`carnage.js` keeps its shipped spine (`deathPlan`: hip sever ×1/×2 on crit,
limb gib at ≥9 hits or crit+5, torso gib at crit+12 — all unchanged and
regression-pinned) and adds a seeded draw on top:

- `overkillTier(ctx)` 0-3 from hits + crit + limbs already lost.
- `FINISHER_MOVES` catalogue: `decapitate`, `shear`, `chipShower` (tier 1),
  `quarter`, `torsoSplit`, `limbGib`, `burst` (tier 2), `torsoGib` (tier 3).
- `finisherBudget(tier)` spends 0 / 1 / 1-2 / 2-3 extra moves, drawn WEIGHTED
  and WITHOUT REPLACEMENT, filtered by what the rig can do (`hasLegs`,
  `hasChains`, `hasRoot` — a legless serpent silently skips leg moves).
- `planeRecipe(style)` randomizes every cut plane's azimuth, tilt and offset,
  so no two severs land on the same line. `torsoSplit` uses oblique/sagittal
  planes — the torso now genuinely comes apart, not just the limbs.

Measured over 400 seeded kills with a realistic mix of fight shapes: **185
distinct finisher scripts**, commonest 8.5%, every catalogued move fires, ~1.3
extra moves per kill. Trivial kills stay clean (tier 0 spends nothing).

Entity lifetime, corpse timing and the ragdoll→corpse part-count guard are
untouched: nothing here adds or removes `inst.parts` entries — it only swaps
meshes *inside* part Groups, exactly as the mid-fight sever already did.

### Node suites (kept, in `tests/`)

| Suite | Checks | What it pins |
|---|---|---|
| `tests/ragdoll_energy.test.mjs` | 32 | energy never rises after arming (200 seeded deaths × 2 rigs + a 60-death pure-twist set), centroid never leaves the ground, floor penetration de-energised, rising env floor lifts without throwing, degenerate rigs, seeded determinism, and a "still tumbles" guard so the governor is not silently over-damping (40/40 topple, 40/40 travel) |
| `tests/kill_impulse.test.mjs` | 115 | all 12 splatter quadrants push away from the wound, yaw/world/model frame math, blending + recency + source weights, **400-death fallback azimuth spread** (every 45° sector used; the top two sectors hold 26% vs the pre-fix 100%), 200 varied attacker bearings steer the fall, determinism, momentum bias, ring caps/TTL |
| `tests/carnage_finisher.test.mjs` | 248 | tier thresholds + monotonicity, budgets, no duplicate moves in a draw, tier gating, rig-capability filtering, 400-kill variety, escalation, cut-plane randomization, and a full regression of the shipped `deathPlan` / `pickEscalation` / `pickLegForHit` policy |

`_three_stub.mjs` gained `MeshStandardMaterial`, `Box3`, `Matrix3`, `Matrix4`,
`BufferGeometry`, `Float32BufferAttribute` (additive only) so `carnage.js` →
`dismember.js` can be imported under bare node.

### Live headless verification (zero-GPU bot, owner-authorized `phase4demo`)

`serve.py --port 8771` + headless chromium,
`?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&agent=1`.
Boot history `form-shown → connecting → char-list-ready → spawning → in-world →
ready`; **0 console errors**; all six diag surfaces present
(`ragdoll`, `killImpulse`, `carnage`, `dismember`, `limbs`, `blood`).

Six real creatures (Brutish/Wily/Crude Monouga 17 parts, Olthoi Nymph 23,
Sufut Zefir 9, Tusker Crimsonback 25, Banderling Breeder 17) sandbox-armed via
`__diag.ragdoll.kill(guid, {critical:true})` — which now runs the production
resolver — and sampled at 60 ms for 6 s:

- **6/6 armed** with a real limb registry, 21-63 braces, `env: true` (the
  terrain/raycast floor bridge is live).
- **worst centroid rise 0.035 m, worst node rise 0.473 m** — nothing left the
  ground; every sim reported `done: true` with `settled: 24` inside 2.6-4.3 s.
- **`energy` tracked `eCap` in every case** (`trims` 1-26 — the governor firing
  a handful of times per death, which is it doing its job, not fighting).
- **6 of 6 distinct fall directions**, and five different styles observed
  across the runs (`topple`, `spinout`, `faceplant`, `crumple`, `sidefall`,
  `sidefall2`). Entities with a non-zero yaw showed `dir ≠ worldDir`, proving
  the world→model conversion is live.
- `__diag.carnage.simulateFinisher(200)` in-page: 41 distinct move lists at
  tier 2 with every tier-≤2 move firing.

Not covered headlessly: an actual server-driven death (the bot does not fight),
so the `carnageOnDeath` → `startRagdoll(inst, killOptsFor(inst))` sequencing and
the corpse handoff are still eye-check items below.

### Queued 1070 eye checks (owner session — not run from agents)

URL: `?nosw=1` (everything is default-ON; add `&agent=1` if driving headless).

1. **Fly-away regression.** Kill 20+ creatures of mixed size, including on
   stairs, slopes and on top of existing corpses. Nothing should leave the
   ground; `__diag.ragdoll.state(guid).maxRise` should stay under ~0.5 m for
   the body as a whole. `trims > 0` is normal (the governor doing its job);
   `trims` in the thousands on a settled corpse would mean it is fighting the
   solve and wants a look.
2. **Direction.** Kill the same creature type from N, S, E and W — it should
   topple away from you each time, not toward its own right. Then kill with a
   war bolt from range and confirm it goes over along the bolt's flight line.
   `__diag.killImpulse.last()` reports `{source, style, confidence}` for the
   last resolve; `source` should read `projectile` / `attacker` / `splatter`
   in that order of preference, and `seeded` only when nothing landed.
3. **Variety.** Twenty kills in a row should not look alike: watch for the
   `crumple` (drops near-straight down), `spinout` (visible spin about the
   vertical), `faceplant` (a charging mob carries forward) and `sidefall`
   (goes over sideways) styles. `__diag.ragdoll.state(guid).style` names it.
4. **Finishers.** Long fights and crit finishes should show decapitations,
   oblique torso splits, quarterings and chip showers, not just a hip sever.
   `__diag.carnage.state(guid).finisher` gives `{seed, tier, moves}`;
   `__diag.carnage.simulateFinisher(200)` dry-runs the distribution.
5. **Torso split sanity.** After a `torsoSplit` the creature should still read
   as a body (the joint-side half stays on the rig). If a split ever leaves the
   creature effectively invisible, drop `torsoSplit`'s weight or bias the plane
   offset toward the extremity.
6. **Loot, still.** Loot a dozen finished corpses — the part-count guard and
   the sprawl transfer were not touched, but this is the one thing worth
   re-confirming after any carnage change.
7. **Perf.** A 4-6 mob AoE kill should not hitch: `__diag.dismember.stats()`
   `activeDebris` must stay under its cap of 40 and drain.

## Known issues / pre-existing bugs found during recon (not fixed here)

- **holtburger-protocol reads `AttackConditions` as u64; wire is u32** — 4-byte
  overrun per damage notification (crates/holtburger-protocol/src/messages/
  combat/events.rs:57-59, :98-112). Hand-authored fixtures can't catch it.
- **Attack height hardcoded to Medium** in swing resolution and picking
  (index.html:9841, scene3d/picking.js:14) — real heights never reach the
  CombatManeuverTable lookup.
- **`damageLocation` stringified before JS** (src/lib.rs `damage_location_label`)
  — surface the numeric enum if the first-person wound overlay ever wants it.
- Pre-existing node-suite failures unrelated to this work:
  test_play_effect_resolver.mjs (stub em lacks `_particleEmittersForGuid`),
  test_a11_s5/s0 (flag-parse assertion + particle_env import),
  lint-harness-params.mjs `kickDance` DEAD-PARAM.
- `pkg-release/` build dir left next to `pkg/` (session sandbox couldn't
  delete it) — safe to remove.

## Data facts worth keeping

- Setup `parent_index` is authored hierarchy data but was vestigial in retail
  (decomp: only serialization touches it) — our limb chains are a novel,
  safe reading. Primordial real array: parent[15]=12 (chains
  6→13→1, 9→10→16, 11→14→17, 12→15→18 are the four legs).
- Weenie `body_part_table` key sets do NOT distinguish body plans (Noble and
  Primordial both carry generic Torso/Head/Arm/Leg/Claw/Breath) — limb
  identity must come from the Setup skeleton, which is what limbs.js does.
- AC part meshes are watertight at the DAT level (Olthoi audit: 20/24 perfect;
  defects are 2–3 boundary edges). The client de-indexes but duplicated
  positions are bit-identical f32s → exact-equality weld reconstructs the
  topology with no epsilon (dismember.js `weldPartGeometry`).
