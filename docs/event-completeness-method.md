# Event-Completeness Method (sounds + particles)

Companion to [`world-completeness-method.md`](world-completeness-method.md). That doc covered **placements** (the geometric things rendered at fixed positions). This one covers **events** — sounds and particles, triggered by state (terrain code, animation clock, server messages) rather than positioned in space.

Status: **brief, pending execution.** When the user signs off this is the contract; phases F.A through F.E follow the same shape as placement-completeness's A through E.

## The contract

For any landblock `lb` over any observation window `[t0, t1]`:

```
fired_sound_events(lb, [t0, t1]) ≡ {
    ∀ e ∈ ambient_events(lb, terrain_at_player, [t0, t1])
  ∪ ∀ e ∈ animation_hook_events(active_entities(lb), motion_clocks, [t0, t1])
  ∪ ∀ e ∈ server_sound_messages(landblock_instance(lb), [t0, t1])
}
```

```
fired_particle_events(lb, [t0, t1]) ≡ {
    ∀ e ∈ physics_script_hooks(active_entities(lb), [t0, t1])
  ∪ ∀ e ∈ sky_physics_chain(visible_sky_objects, [t0, t1])
  ∪ ∀ e ∈ server_particle_messages([t0, t1])
}
```

Both contracts have the same shape as the placement contract — three sources, all explicit, no procedural generation that isn't deterministic from DAT inputs.

## Why this is harder than placements

Placements are *positions* — a tree at `(x, y, z)` either is or isn't there. Easy to enumerate, easy to diff.

Events are *triggers over time* — an ambient sound plays *while* the player stands on terrain code 21. The validator has to:
- Probe a **window** of runtime behaviour (not a snapshot).
- Time-correlate observed events with expected triggers.
- Tolerate some skew (animation clock fps vs wall clock, network jitter for server-pushed events).

The contract is still strict equivalence, just over a time-axis instead of a position-axis. Float tolerance becomes "did this event fire within ±N animation frames of when it should have?"

## The three sound channels

### S1 — Ambient (terrain-driven)

ACE source: `~/ace-server/Source/ACE.DatLoader/Entity/AmbientSTBDesc.cs` + `AmbientSoundDesc.cs`. Walks the per-vertex terrain code at the player's current cell, indexes `Region.sound_info.sound_types[terrain_code]` → STB DID, loads the SoundTable, picks an ambient slot, fires through AudioManager.

Existing runtime: `scene3d/audio/ambient_runtime.js`. Per-tick walks `terrainGroup.children`, samples player position, fires events.

Deterministic given (terrain code at player position, Region 0x13 DAT, SoundTable contents, animation clock). No procedural component.

### S2 — Animation hook (motion-driven)

ACE source: `~/ace-server/Source/ACE.DatLoader/Entity/AnimationHook.cs` (Sound hook type 0x00...). Each entity rig's motion table contains animation clips; each clip contains a list of `(frame_time, AnimationHook)` entries. When a `Sound` hook fires (frame number reached), it indexes the entity's bound SoundTable by the hook's `sound_id` and fires through AudioManager.

Existing runtime: `scene3d/animation.js` + `audio_manager.js`. Already shipped via Phase H (per memory: "AnimationHook execution (sound_table_did spawn-meta)").

Deterministic given (entity csetup_id → motion table → current motion → frame time). Animation clock is per-frame, wall-clock-anchored on rAF.

### S3 — Server-pushed (`GameMessageSound` 0xF750)

ACE wire frame: `GameMessageSound` packet → ClientEvent `kind=16` with `f32_payload` (volume). Existing renderer dispatches via the recv loop into AudioManager.play(wave_did, position, volume).

Deterministic given (the server's spawn-of-sound event). The server is the authority; the client mirrors.

## The three particle channels

### P1 — Entity-anchored PhysicsScript hooks

ACE source: `PhysicsScript.cs` + `AnimationHook.cs` (CreateParticle hook type 0x01...). Each entity's `default_script_id` references a PhysicsScript; the script's hook list contains `(start_time, CreateParticleHook → emitter_id)` entries.

Existing runtime: H2 chain walker at `scene3d/entities.js::spawn → fetchPhysicsScript → fetchParticleEmitter → addEmitter w/ parent=entity.rig`. Already shipped.

Deterministic given (entity, time since spawn). Particles themselves are stochastic on the noise PRNG seeded per emission (matches the placement-bake's pattern — deterministic given inputs).

### P2 — Sky particle chain

The sky-chain walker (Sky-J P1-P5) processes Region SkyObject → SetupModel → PhysicsScript → ParticleEmitter. Already shipped.

Deterministic given (Region 0x13, time of day).

### P3 — Server-pushed particles

Less common. ACE wire frames can spawn one-off particle effects via spell-cast messages or similar. Not currently exercised by any specific recv-loop arm; would be wired the same way as `GameMessageSound`.

## Phase plan (mirrors Phase A-E for placements)

| Phase | What | Estimated effort |
|---|---|---|
| **F.A** Investigate | Find canonical ACE algorithms; inventory Region 0x13 sound_info; sample entity Sound + CreateParticle hooks across the 13×13 ring; understand GameMessageSound wire format | hours, read-only |
| **F.B** Bake | Rust port of the ambient + animation-hook + physics-script enumerators. Output per-LB JSONL of `expected_events[]`: ambient triggers (terrain-code-keyed), animation Sound hooks per entity (csetup-keyed), CreateParticle hooks per entity. Schema includes trigger condition + expected event payload | 2-3 days |
| **F.C** Probe | Add a runtime event-log to `audio_manager.js` + the particle manager. Every wave-play, every particle-emit call gets logged with `(wave_did/emitter_did, world_pos, t_wall_ms, source_attribution)`. Renderer-side, gated by `?eventLog=on` | 0.5-1 day |
| **F.D** Validate | `validate_event_completeness.cjs` — Playwright capture that drives the renderer through a probe scenario (player walks a fixed path, entities spawn, animation cycles fire, fixed server-event injection), captures the event log, time-correlates against the per-LB manifest. Reports missing events + spurious events | 1-2 days |
| **F.E** Stage + verify | Stage `expected-events.{bake}` alongside scenery/spawns under `holtburger-dist-v2/events/`; emit `event-bake-source.sha256`; run the validator as a CI gate | 1 day |

## Determinism contract for events

Two clients running the same DAT against the same probe scenario must produce **identical event logs** at the wave/particle level, modulo:
- ±2 animation frames (~33ms at 60fps) for animation-hook fires — the rAF clock isn't network-deterministic
- ±50ms wall-clock for ambient roll-ins — the per-tick sampler is at 250ms cadence

The validator's tolerance is published in the report; "matched" means within tolerance, "drifted" means outside.

## Base DATs only — same rule as placements

Events depend on DAT contents:
- Ambient: Region.sound_info + SoundTable + Wave files
- Animation: Motion table + Animation + AnimationHook + SoundTable + Wave
- PhysicsScript: PhysicsScript + ParticleEmitter + GfxObj/Surface chains

Modder-edited DATs would produce different events. Same pre-flight check from the placement bake applies: refuse to bake events against any DAT directory containing `0x__FFxxxx` IDs or sibling `custom_textures/` / `iter-*/` / `*.wbproj` markers.

The `event-bake-source.sha256` sidecar lets consumers verify their DAT matches before honouring the event manifest.

## The probe scenario

A fixed deterministic sequence the validator runs to exercise all three channels:

1. **Spawn at Holtburg centre**, wait 5 s. Ambient should fire (LB 0xA9B4 terrain ~50% LushGrass; STB plays the grass-quiet ambient).
2. **Walk to South Holtburg Outpost** (`0xA9B0`) along a deterministic path. Ambient transitions to the forest ambient. ~30 s.
3. **Inject synthetic Hudriffa spawn**. Greet animation fires; Sound hook in the greet cycle should fire.
4. **Inject synthetic Scrawed Grievver spawn**. Idle animation has periodic Sound hooks (creature breathing); should fire on a known cadence.
5. **Inject a GameMessageSound 0xF750 event** with a known wave_did at a known position. Validate AudioManager.play() lands the wave.
6. **Walk into a building EnvCell** (if available in the ring). Interior ambient changes.

Each step has an expected event-log slice. Validator captures the actual log, compares.

## Validator's view of the event log

```js
// What the runtime records (after Phase F.C)
liveScene3d.eventLog = [
  { type: "ambient", wave_did: 0x0A000266, pos: [32540, 33850, 86], t_ms: 1234, source: "AmbientRuntime", terrain_code: 21 },
  { type: "anim_sound", wave_did: 0x0A000123, pos: [32555, 33855, 86], t_ms: 5678, source: "AnimationHook", entity_guid: 0x..., motion: "greet", frame: 12 },
  { type: "server_sound", wave_did: 0x0A0001AB, pos: [32540, 33850, 86], t_ms: 9012, source: "GameMessageSound", from_packet: 12345 },
  // particle equivalents
];
```

The validator subtracts the manifest's expected events from the actual log and reports both sides.

## Scope limits — what's out

- **Audio quality** (mixing, HRTF panning, compression artifacts) — separate from event triggering.
- **Music tracks** — region music isn't enumerated here. Out of scope.
- **Spell effects** (visual + sound) — server-pushed, would land via S3/P3 once the wire arm is wired. Not blocking.
- **UI sounds** (button clicks, menu opens) — client-only, not part of the world simulation.

## Provenance + dependencies on shipped work

This method's groundwork already lives in:

- `Region.sound_info` parser — `crates/holtburger-dat/src/file_type/region.rs:329, :702`
- `AnimationHook` parser — `crates/holtburger-dat/src/file_type/setup_model.rs:38-81`
- `PhysicsScript` parser — `crates/holtburger-dat/src/file_type/physics_script.rs:30-79`
- `SoundTable` (0x20) parser — `crates/holtburger-dat/src/file_type/sound_table.rs`
- `Wave` (0x0A) parser — `crates/holtburger-dat/src/file_type/wave.rs`
- AmbientRuntime — `apps/holtburger-web/scene3d/audio/ambient_runtime.js`
- AudioManager — `apps/holtburger-web/scene3d/audio/audio_manager.js`
- ParticleManager + entity chain — `apps/holtburger-web/scene3d/particles/` + `entities.js` H2 walker
- Sky chain — `apps/holtburger-web/scene3d/sky_dome.js` (Sky-J P1-P5)
- GameMessageSound recv arm — referenced in `apps/holtburger-web/src/lib.rs` (search `kind=16` / `f32_payload`)

So F.B's bake leverages the existing parsers; F.C adds a thin event log on top of existing runtime; F.D writes a new validator capture; F.E stages + gates.

## Sign-off line

If this method accurately captures the architecture and the phase plan looks right, mark it verified; I'll start F.A. If anything looks wrong — especially the contract shape, the determinism tolerance, or the probe scenario — flag it before code starts.
