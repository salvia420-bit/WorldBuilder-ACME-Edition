# A11 particles-physics-scripts — unification survey

Date: 2026-06-11 · Agent: A11 · Scope: ParticleManager / ScriptManager / ParticleEmitter (0x32)
lifecycle, PhysicsScript (0x33) execution, PhysicsScriptTable (0x34) dispatch.
All paths repo-relative to `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger`.
Retail = `~/ac-headers/acclient.c` (`.h` for layouts).

## 1. Retail map

Ownership is strictly **per-CPhysicsObj**, both managers lazily created:

- `CPhysicsObj.script_manager` / `CPhysicsObj.particle_manager` fields (acclient.h:30698,
  acclient.h:30730).
- **ParticleManager** (acclient.h:31040-31045): `next_emitter_id` (seeded `-65536`,
  acclient.c:329307) + `LongNIHash<ParticleEmitter> particle_table`. One instance per object,
  created on first `CPhysicsObj::create_particle_emitter` (acclient.c:316330-316353; blocking
  variant 316357-316380). Wrappers: `destroy_particle_emitter` (316382-316393),
  `stop_particle_emitter` (316395-316407), `get_num_emitters` (316409-316420),
  `destroy_particle_manager` (318082-318095, called from the CPhysicsObj destructor path
  320959-320966).
- **ParticleManager API** (bodies):
  - `CreateParticleEmitter` (acclient.c:329375-329411): if a caller-supplied `emitter_id` is
    already live, the OLD emitter is **removed AND destructed** (`~ParticleEmitter` + `delete`,
    329383-329393) before `makeParticleEmitter → SetInfo → SetParenting → InitEnd`; id 0 ⇒
    allocate from `next_emitter_id++`.
  - `CreateBlockingParticleEmitter` (acclient.c:329528-329565): if `emitter_id` is already live
    it returns **0 and does NOT replace** — the opposite of the non-blocking replace semantics.
  - `DestroyParticleEmitter` (329413-329440): remove + destruct. `StopParticleEmitter`
    (329442-329480): sets the emitter's `stopped` flag only (`*((_DWORD*)v3+35)=1`, 329460).
  - `UpdateParticles` (329482-329526): walks the table; an emitter whose
    `ParticleEmitter::UpdateParticles` returns 0 is removed + destructed inline
    (329516-329521) — emitters self-expire, the manager reaps.
- **ParticleEmitter** lifecycle: ctor (acclient.c:330554-330591), `SetParenting`
  (330252-330271) makes the emitter's physobj a **child physics object** of the parent via
  `CPhysicsObj::set_parent(part_index, frame)`; `StopEmitter` (330295-330309) flips `stopped`
  when `total_seconds` elapsed or `total_emitted >= total_particles`; `ShouldEmitParticle`
  (330613-330651) feeds num/total/delta-offset/last-emit-time into
  `ParticleEmitterInfo::ShouldEmitParticle`; `KillParticle` (330274-330293) removes the part
  from shadow cells and decrements `num_particles`. **Degrade ladder**: `InitEnd`
  (331265+) sets `degrade_distance = CPhysicsPart::GetMaxDegradeDistance(part_storage[0])`
  (sed offset 330958 region); `UpdateParticles` (331097-331139) checks
  `CPhysicsObj::ShouldDrawParticles(degrade_distance)` and on failure does
  `SetNoDraw(1)` + `degraded_out=1` + freezes (timestamps only); clears NoDraw on re-entry
  (331189 region, `degraded_out = 0`).
- **ScriptManager** (acclient.h:30815-30822): `physobj, curr_data, last_data, hook_index,
  next_hook_time` — a **time-ordered queue of PhysicsScripts** executed on the physics clock.
  - `AddScript` (acclient.c:329124-329140): `DBObj::Get(0x2B)` then `AddScriptInternal`.
  - `AddScriptInternal` (329069-329121): new `ScriptData.start_time` = **previous script's
    `start_time + length`** if a script is queued (329093-329096), else `Timer::cur_time` —
    i.e. multiple scripts on one object play back-to-back, never overlapped.
  - `NextHook` (329142-329187): advances `hook_index` within the current script's sorted
    hook array, maintaining `next_hook_time` = next entry's `start_time + script start`.
  - `UpdateScripts` (329189-329246): `while (cur_time >= next_hook_time)` execute
    `hook->vfptr->Execute(hook, physobj)`; on script exhaustion pops `curr_data`, releases the
    DBObj, advances to `next_data`.
- **Hook → manager dispatch** (the CAnimHook vtable is shared by anim hooks and PhysicsScript
  hooks): `CreateParticleHook::Execute` → `create_particle_emitter` (acclient.c:342513-342517);
  `CreateBlockingParticleHook::Execute` (342525-342534); `DestroyParticleHook::Execute` →
  `destroy_particle_emitter` (342536-342540); `StopParticleHook::Execute` →
  `stop_particle_emitter` (342542-342546); `CallPESHook::Execute` → `CPhysicsObj::CallPES(pes,
  pause)` (342468-342471).
- **CallPES** (acclient.c:318973-319005): if `pause >= 0.0002`, schedule an `FPHook` at
  `RollDice(0, pause)` on `PhysicsTimer::curr_time`; else immediately
  `play_script_internal`. `play_script_internal` (318035-318067) lazily creates the
  ScriptManager and queues. `play_script` (318070-318080) **no-ops unless `this->cell`** (object
  must be in-world). PES-typed entry `play_script(PScriptType, mod)` (320326-320349) resolves
  the concrete 0x33 id via `PhysicsScriptTable::GetScript` (336931+); `play_default_script`
  (320351-320376, per-part variant 320378+) is the spawn-time DefaultScript path.
- **Per-frame call order** (the part A1 cares about): both managers update **inside the
  object's own update**, after part/child updates and before `process_hooks`:
  - `CPhysicsObj::UpdateObjectInternal`: parts/children → `UpdateParticles` (322889) →
    `UpdateScripts` (322892) → `process_hooks`.
  - `animate_static_object` (321150+): `CPartArray::Update` → grotate → parts/children →
    `UpdateScripts` gated on `state & 0x80000` (321186-321190) → `UpdateParticles` (321191-321193,
    ungated) → `process_hooks`.
  - `update_position` (321658+): `UpdateParticles` (321688) → `UpdateScripts` (321691).
  - `UpdateChild` (320039-320058): after `set_frame` on the child, the **child's** managers
    update immediately — children are never a frame late relative to their parent.

## 2. Ours map

| Concern | Rust | JS (scene3d) |
|---|---|---|
| 0x32 / 0x33 / 0x34 parsing | `crates/holtburger-dat/src/file_type/particle_emitter.rs`, `physics_script.rs`, `physics_script_table.rs` | — |
| wasm bridge | `apps/holtburger-web/src/lib.rs` — `fetchParticleEmitter` (≈:14541), `fetchPhysicsScript` chain (≈:18257, :18499-18500), script-table resolvers `resolve_physics_script_table_did` (:22046+, :22106+, gate comment :22219-22221 mirrors retail `play_script` null-table no-op) | — |
| PlayEffect wire (0xF755) | `crates/holtburger-world/src/handlers/system.rs:25-33` → `WorldEvent::PlayEffect` (`events.rs:221-236`) | `play_effect_vfx.js` subscriber |
| Particle runtime (ACE C# port) | — | `scene3d/particles/`: `particle_manager.js` (632 L), `particle_emitter.js` (402 L), `particle_emitter_info.js`, `particle.js`, `time_rng.js` (deterministic test hooks) |
| ParticleManager **instances** | — | TWO global managers: `entities.js:7577` (`_worldParticleManager`, lazy) and `statics.js:2694` (`_staticParticleManager`) |
| Manager tick clocks | — | world: end of `entityManager.tick` (`entities.js:9182-9189`, called from `loop.js:1544`); statics: **own private rAF loop** (`statics.js:2911-2921`) |
| PhysicsScript "execution" (ScriptManager role) | — | THREE independent walkers: (1) entity chain walker `_attachParticleChainForEntity` (`entities.js:7689+`; hook arms: sound 1/21 :7745, 2/12/19 :7829-7862, CallPES setTimeout :7908-7927, destroy/stop 14/15 :7941-7958, create 13/26 :7959+); (2) PlayEffect one-shot walker (`play_effect_vfx.js:1189+` `_tryResolveRealVfx`, group registry :1089-1233, reaper `ONE_SHOT_LIFETIME_MS` :1511); (3) statics walker `_runStaticParticleChain` (`statics.js:2733+`, 13/26 only) |
| Hook timing | — | wall-clock `setTimeout` per hook (`entities.js:7754`, :7846, :7860, :7908); cancellation via per-guid timeout buckets (`entities.js:6908-6918`) |
| Emitter kill-on-object-destroy | — | `entities.js:6899-6907` (`_particleEmittersForGuid` → `destroyParticleEmitter`); statics: `disposeStaticParticles` (`statics.js:2887-2903`); PlayEffect: group registry + FIFO cap 24 + timer (`play_effect_vfx.js:1096-1233`) |
| PES table picker (GetScript) | — | `play_effect_vfx.js` Phase 51 resolver chain (speed-as-mod per its :1206 docblock); spawn-time DefaultScript auto-play is the known G14 gap |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|----------|-------------|-------------|-------|---------|----------|
| 1 | Per-object time-ordered PhysicsScript queue (scripts chain back-to-back: new script starts at prev `start_time+length`; hooks fire on physics clock; pop+release on exhaustion) | acclient.c:329069-329121, :329189-329246 | no equivalent — each walker fires every hook via independent wall-clock `setTimeout` at walk time (entities.js:7754, :7846, :7908) | MISSING | overlapping scripts that retail serializes (e.g. CallPES sub-script while parent script still playing); hook drift vs render/physics time; no pause semantics | NO |
| 2 | ONE script executor per object | acclient.c:318035-318067 (single `script_manager` funnel) | 3 walkers: entities.js:7689, play_effect_vfx.js:1189, statics.js:2733 — each with its own teardown registry | SPLIT-BRAIN (3 sites) | fixes land per-walker (DIM6-2 fixed 14/15 in the entity walker only; statics walker still 13/26-only per statics.js:2733+); hook-coverage drift already documented for visual hooks | partially G14 (visual-hook routing) |
| 3 | ONE ParticleManager per CPhysicsObj, emitter ids object-scoped | acclient.c:316330-316353; acclient.h:31040-31045 | 2 global managers (entities.js:7577, statics.js:2694) + PlayEffect group registry layered on the world manager (play_effect_vfx.js:1080-1102) | SPLIT-BRAIN (2 managers + 1 registry) | global emitter-id namespace (script-carried explicit emitter ids from two objects can collide in one table); two divergent disposal/teardown paths | NO |
| 4 | Manager update runs inside each object's update, children immediately after `set_frame` | acclient.c:322889-322892, :320052-320058, :321186-321193 | world manager ticks once globally at end of entity tick (entities.js:9182-9189); statics manager on a separate self-owned rAF (statics.js:2911-2921) | DIFF-ALGO | part-attached emitters read part frames one global pass later; static emitters advance on a different clock than the scene (jitter when main loop hitches) | NO (seam → A1) |
| 5 | Explicit-id re-create destroys the old emitter (parts removed, memory freed) before replacing | acclient.c:329383-329393 | `addEmitter` does a bare `particleTable.delete(emitterId)` — no scene-removal, no material disposal (particle_manager.js:342-344; contrast destroyParticleEmitter :602-631) | DIFF-ALGO | re-fired script with fixed emitter id orphans the old emitter's slot meshes in the scene + leaks per-slot cloned materials | NO |
| 6 | Blocking create returns 0 if emitter id already live (never replaces) | acclient.c:329528-329565 | hookType 26 routed identically to 13 into replace-semantics `addEmitter` (entities.js:7959; statics.js:2733+) | DIFF-ALGO | CreateBlockingParticle restarts an emitter retail would leave running (visible re-pop of persistent effects) | NO |
| 7 | Distance degrade ladder: `degrade_distance` from `GetMaxDegradeDistance`, `ShouldDrawParticles` → `SetNoDraw` + freeze, auto-recover | acclient.c:331097-331139, :331265+ | fields ported but dead (`degradeDistance = Infinity`, particle_emitter.js:101-102); replaced by RP6 frustum/hard-distance cull (particle_manager.js:476-560) | DIFF-ALGO | different cull predicate (frustum+cap vs per-emitter authored degrade distance); RP6 is a deliberate perf superset but ignores authored per-GfxObj degrade radii | NO (RP6 shipped 2026-06-08) |
| 8 | No retail equivalent: RP6 cull, FIFO 24-group PlayEffect eviction cap, `ONE_SHOT_LIFETIME_MS` hard reaper | — (absent from ParticleManager::UpdateParticles acclient.c:329482-329526) | particle_manager.js:500-560; play_effect_vfx.js:1093-1233, :1511 | EXTRA | intentional perf/safety nets; the reaper can kill a long-tail emitter retail would let finish (`2500ms + maxStartTime` vs authored `total_seconds`) | NO |
| 9 | Spawn-time `play_default_script` (PhysicsDesc DefaultScript via 0x34 GetScript) | acclient.c:320351-320376, :336931+ | only wire-PlayEffect triggers the GetScript chain; spawn-time auto-play missing (lib.rs:31206-31209 filters to raw 0x33 dids) | MISSING | entities with PScriptType default scripts show no ambient effect at spawn | **G14** |
| 10 | PhysicsScript visual hooks (NoDraw 16 / DefaultScript 17-18 / Transparent 20 / TexVel 23-24 / Light 25) executed from the script queue | acclient.c:329220 (`Execute` is hook-generic) | entity walker dispatches only 1/21/2/12/19/14/15/13/26 (entities.js:7745-7959); `_fireHook` implements the visuals but is anim-timeline-driven only | MISSING (routing) | 0x33-sourced visual hooks dropped | **G14** |
| 11 | Software `gfxObjId` fallback when `hwGfxObjId==0` | (emitter info dual ids; SetInfo path acclient.c:330909+) | `particle_emitter.js:119` discards emitter when hw id is 0 | MISSING | rare legacy emitters invisible | **G13** |

PARITY worth recording (no work): CallPES randomized pause incl. the `0.0002` threshold
(acclient.c:318984-318987 vs entities.js:7886-7895); Destroy(14)/Stop(15) script-hook teardown
by handle (acclient.c:342536-342546 vs entities.js:7941-7958, DIM6-2/W1.3); stop = flag-only
(acclient.c:329460 vs particle_manager.js:593-600); emitter self-expiry + manager reap
(acclient.c:329516-329521, :330295-330309 vs particle_manager.js:563-590 + particle_emitter.js:207+);
kill-emitters-on-entity-destroy (acclient.c:318082-318095 vs entities.js:6899-6907); per-particle
math is a line-mapped ACE port with deterministic test seams (particles/index.js:1-13).

## 4. Staged unification plan

The parser/runtime split (Rust parses 0x32/0x33/0x34, JS runs emitters) is fine and stays.
The unification target is **one script executor + one emitter-lifecycle owner**, all JS-live
(no wasm rebuild needed for any stage).

- **Stage S0 — point fixes inside the current shape** (can ship before/with S1):
  (a) replacement leak: make `addEmitter`'s explicit-id path call `destroyParticleEmitter`
  instead of bare `delete` (particle_manager.js:342-344 → reuse :602-631);
  (b) blocking semantics: `addEmitter({blocking:true})` returns 0 if id live; route hook 26
  with `blocking:true` in all 3 walkers.
  Files: `particles/particle_manager.js`, `entities.js`, `statics.js`, `play_effect_vfx.js`.
  Flag: none needed for (a) (pure leak fix); (b) behind `?blockingParticleParity=on`
  (default-off, url-flags.md style). JS-live. Tests: headless-now (particles runtime already has
  `setCurrentTime`/`setRng` unit seams). Rollback: flag off / revert one function.
- **Stage S1 — `scene3d/script_manager.js`** (the ScriptManager port, divergences 1+2):
  per-owner script queue with retail fields (`currData/lastData/hookIndex/nextHookTime`),
  `addScript(scriptDid)` chaining starts back-to-back per acclient.c:329093-329096,
  `update(now)` executing hooks via ONE shared hook-executor table (today's three walkers
  become thin `addScript` callers; the entity walker's hook arms move into the executor,
  closing the G14 visual-hook routing gap for free). CallPES becomes `addScript` after
  rand-pause — queue-serialized like retail instead of a concurrent recursive walk.
  Flag: `?scriptQueue=on` (default-off; old walkers remain the off-path). JS-live.
  Tests: headless-now — unit-test chaining/exhaustion with fake time; diag counter parity
  (hooks fired per script) between old/new paths on a recorded session. Rollback: flag off.
- **Stage S2 — emitter lifecycle owner** (divergence 3): one `ParticleManager` facade keyed by
  owner (`entityGuid | staticAnchor | playEffectGroup`), object-scoped emitter-id maps,
  single teardown API (`destroyAllForOwner`) replacing `_particleEmittersForGuid`,
  `disposeStaticParticles`, and the PlayEffect group registry. PlayEffect one-shots keep the
  FIFO cap/reaper as owner-policy, not a parallel registry.
  Flag: `?particleOwner=on`. JS-live. Tests: headless-now (leak assertion: table size returns
  to baseline after spawn/despawn churn). Rollback: flag off.
- **Stage S3 — clock + ordering** (divergence 4): tick the statics manager from the main loop
  (kill the private rAF, statics.js:2911-2921) and move both manager updates to the retail
  point in the frame (with A1's frame-orchestration plan; do not ship ahead of A1's sequencing
  decision). Flag: `?particleClock=loop`. JS-live. Tests: 1070-gated eye test (jitter on
  static emitters during hitches), headless diag (tick-count == frame-count).
- **Stage S4 — degrade parity** (divergence 7): wire `GetMaxDegradeDistance`-derived
  `degradeDistance` (needs the value exported from the GfxObj fetch — small lib.rs addition,
  wasm-rebuild batch) into the RP6 predicate as an OR-term; keep RP6 frustum cull as the
  superset. Flag: `?particleDegrade=retail`. Tests: 1070-gated (visual pop distance).
- **Stage S5** — G14 spawn-time DefaultScript auto-resolve lands ON TOP of S1
  (`scriptManager.addScript(GetScript(default_script, intensity))` at spawn) — this is the
  natural owner the backlog item was waiting for. 1070-gated eye test.

Order: S0 → S1 → S2 (S1/S2 independent of each other but both before S5); S3 serializes with
A1; S4 anytime after S0 (only stage needing a wasm rebuild).

## 5. Scores

- Leverage: subsumes/unblocks **G14** (DefaultScript PES auto-resolve, DefaultScriptIntensity,
  visual-hook routing 16/20/23/24/25) and **G13** (software-gfx fallback slot lands naturally in
  the unified emitter factory); plus 2 untracked leak/semantics bugs (rows 5, 6) fixed in S0.
- Regression-risk reduction: **M-H** — three hand-synced script walkers are exactly the
  "fix lands in one copy" failure mode the survey targets (already happened once: DIM6-2).
- Implementation risk: **M** for S1/S2 (pure JS, flag-gated, deterministic test seams exist);
  **L** for S0; **M** for S3 (ordering, must follow A1).
- 1070-dependency: **N** for S0-S2 correctness (headless unit + diag-counter tests);
  **Y** for S3/S4/S5 eye-tests.
- Depends-on: A1 (frame-ordering, S3 only); A5 seam (the shared hook-executor table is also the
  AnimationHook dispatch — coordinate so S1 reuses `_fireHook` rather than forking a 4th copy);
  no Stage-1-movement dependency.

## 6. SPECULATIVE / UNRESOLVED

- **Weather rain/snow** (`scene3d/weather/rain.js`, `snow.js`) are bespoke instanced systems,
  not ParticleManager clients. I could not locate retail's rain implementation to compare
  (greps tried in acclient.c: `RainEmitter`, `WeatherParticle`, `Precip` — only generic weather
  state hits). Single-cited; likely out of scope (retail weather may not use ParticleManager
  either). Left out of the divergence table.
- **Emitter-id collision in the global table**: row 3 notes script-authored explicit emitter
  ids from different objects can collide in the shared `particleTable`. I verified the table is
  global (particle_manager.js:342,452) and that scripts carry fixed ids
  (entities.js:7960), but did not construct a concrete colliding DAT pair — severity unproven.
- **`animate_static_object` script gate `state & 0x80000`**: ours has no equivalent gating for
  statics (statics walker runs unconditionally per anchor). Retail side cited
  (acclient.c:321186-321190) but I did not determine what sets 0x80000 (grep
  `0x80000` near set_state was inconclusive in 15 min), so I can't say whether our behavior
  differs observably.
- **PlayEffect reaper vs authored lifetime** (row 8 symptom): the claim that
  `ONE_SHOT_LIFETIME_MS` can truncate a long emitter retail would let finish is arithmetic from
  play_effect_vfx.js:1511 vs acclient.c:330295-330309; no in-world repro observed (1070 down).
