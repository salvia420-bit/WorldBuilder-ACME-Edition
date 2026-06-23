# Audio-adjacent leads backlog (2026-06-23)

Follow-ups surfaced by the AC audio subsystem investigation (decomp pack `15_audio_media`)
after wiring `AmbientRuntime` to the baked per-LB events (`?ambientBaked`, commit `e6d65713`).
Six read-only Explore agents applied the audio findings' abstractions across adjacent
subsystems; the leads converged on a short, high-leverage backlog. The three tracked here
are the cheapest + highest-confidence + most synergistic with the ambient work.

## C1 — Handle `AdminEnvirons` (opcode `0xEA60`): fog zones + environment sounds  · effort M
The server **broadcasts** environment changes (ACE `GameMessageAdminEnvirons`,
`Player_Networking.cs:401`) and holtburger **drops them entirely**:
- opcode commented out at `crates/holtburger-protocol/src/opcodes.rs:304-305`
- no unpack arm; absent from the `plugins/world-state.js` handler table

Payload = `u32 EnvironChangeType`:
- **Fog** `0x00–0x06` (Clear / Red / Blue / White / Green / Black) — atmospheric zone transitions
- **Sound environs** `0x65–0x7B` (Roar, Bell, Chant, Thunder1-6, …) — dungeon ambience, spell auras

**Plan:** uncomment opcode → `EnvironChangeData { u32 change_type }` in `effects/types.rs` →
unpack arm in `game_message/unpack.rs` → emit a `ClientEvent` kind from `src/lib.rs` →
`index.html` handler applies fog color/distance + triggers environment sound, coordinating
with `AmbientRuntime` (stop region ambient → start environment ambient). Highest user-visible win.

## C2 — `baked_particle_source.js`: consume the un-used `physics_script_particle` feed  · effort S–M
The baked particle feed (`source:"physics_script_particle"`, ~63 rows across
`dist/events/*.events.jsonl`, from `holtburger-event-bake/src/particle.rs`) is generated but
**never read** — `scene3d/audio/baked_ambient_source.js:51` explicitly skips non-ambient rows.

**Plan:** mirror the `BakedAmbientSource` pattern (built this session) in
`scene3d/particles/baked_particle_source.js`: parse `physics_script_particle` rows, cache by LB,
expose `getTriggersForLb(lbX,lbY) -> {default_script_id, emitter_id, start_time_s, part_index, blocking}[]`.
Wire into `entities.js::_attachParticleChainForEntity` to consult the baked feed **before** the
live `fetchPhysicsScript` walk (`play_effect_vfx.js:1223-1450`), removing per-entity-spawn async
DAT round-trips. Direct analog of the ambient fix; loader template already exists.

## #3 — Wire `isCurrentCellSeenOutside` resolver (finish the ambient feature)  · effort S
`AmbientRuntime` already **accepts** an `isCurrentCellSeenOutside` option
(`scene3d/audio/ambient_runtime.js:129-137,186-189`) that relaxes the indoor gate so
portal/window cells keep outdoor ambient alive (retail `acclient.c:146721/146746`). But
`index.js`'s construction (~4068) supplies the sibling `isCurrentCellIndoor` resolver and
**never wires `isCurrentCellSeenOutside`** → it defaults to `() => false`, so window/balcony/
cave-mouth cells wrongly silence all region ambient.

**Plan:** read the `ENVCELL_FLAG_SEEN_OUTSIDE` (0x01) bit (`env_cell.rs:32`; already surfaced in
`cells.js` userData ~line 366) and pass an `isCurrentCellSeenOutside` resolver mirroring the
`isCurrentCellIndoor` closure (handle lookup + typeof guard + try/catch). Direct follow-up to the
`?ambientBaked` work.

---

## Also on the board (not yet tracked)
- **#4** EnvCell `environment_id` → per-dungeon fog color/distance + reverb (M)
- **#5** `IndoorAmbientRuntime` — dungeons silent except entity SFX; data source needs RE (L)
- **#6** Sky-particle (P2) consumer — `sky_dome.js:299` TODO (M)
- **#7** Material-hook (6-11,20,23-24) clone-on-write — shared-material cross-contamination (M)
- **#9** Season × SkyTimeOfDay — parsed but unused; **probe retail before acting** (M)
- **#10** `DatFileType` 0x0E sub-type collapse (M)

## Corrections confirmed by the sweep
- Anim-hook dispatch is **complete** (all 26 hook types handled in `entities.js`).
- Live `DatFileType` **has** `SoundTable = 0x20` (the dossier's "missing" note was from the stale
  `~/holtburger` checkout; edit the client under `external/holtburger`).
- Sky/weather is **live-derived and largely complete** (`SkyEvalState::evaluate`); only season
  qualification + sky particles are open.

Sequencing: **#3 → C2 → C1**, then group #4/#5/#6 as an "interior environment" workstream.
