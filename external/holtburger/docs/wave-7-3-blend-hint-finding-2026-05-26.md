# Wave 7 Phase 7.3 — MotionData blend-duration hint investigation

**Date:** 2026-05-26
**Outcome:** **(b) — MotionData has no blend hints. No code change.**

## Question

Does retail's `MotionData` (wire-format from `MotionTable`) carry a
per-link / per-cycle blend-duration hint that we could plumb into
`EntityInstance.crossFadeTo` to replace the hardcoded
`CROSSFADE_S = 0` constant in `scene3d/entities.js`?

## Sources cross-referenced

1. **DRW schema** —
   `external/DatReaderWriter/DatReaderWriter/dats.xml:2749-2763`
   declares `MotionData = { _numAnims, Bitfield, Flags, Anims[],
   Velocity?, Omega? }`. No blend / fade / duration field.

2. **Our Rust port** —
   `external/holtburger/crates/holtburger-dat/src/file_type/motion_table.rs:132-169`
   carries `MotionData { bitfield: u8, flags: MotionDataFlags,
   anims: Vec<AnimData>, velocity, omega }`. Matches DRW.

3. **ACE Flags enum** —
   `external/ACE/Source/ACE.Entity/Enum/MotionDataFlags.cs:6-10`
   defines only `HasVelocity = 0x1, HasOmega = 0x2`. ACE has no
   physics-side MotionData class with blend bits either (server uses
   the same wire format for cycle / modifier / link entries).

4. **Retail acclient.c** —
   - `MotionData::UnPack` at line `341814-341920` reads `id,
     num_anims, bitfield, flags-byte, align-pad, anims*, velocity?,
     omega?`. Identical layout to DRW + Rust + ACE.
   - `bitfield`'s only known semantic bit (`& 0x01`) drives
     `MotionState::clear_modifiers` in
     `CMotionTable::GetObjectSequence:337724` — a state-machine
     reset, not a blend hint.
   - `CSequence::advance_to_next_animation:340473` (the function that
     transitions between anim-sequence nodes) is an unconditional
     pointer swap with no blend state — exactly what the existing
     comment block at `scene3d/entities.js:3242-3244` already
     documents (citing 2026-05-12 Cohere-B research).
   - `MD_Data_Fade::GetDuration:694302` is **not** an animation
     blend duration — it's an Alpha-fade PFileNode editor tooling
     struct (returns `framerate`, used by RenderDeviceD3D's color
     SetBlendFunction path). Unrelated to MotionData.

5. **Chorizite C# (acclient class bindings)** —
   `external/chorizite/ACBindings/Generated/Net/Types/MotionData.cs:24-30`
   shows the in-memory C++ class as `num_anims, anims*, velocity,
   omega, bitfield`. Same five fields. The C# class is generated
   from acclient.exe symbol tables — definitive on the retail
   client's in-memory shape.

6. **Sweep validation** —
   `external/holtburger/docs/motion-table-acclient-audit-2026-05-19.md`
   §1.2 ran our Rust parser against all 436 retail motion tables
   (18,451 cycle anims, 5,455 link entries) — 100% parse success
   with the current `bitfield/flags/anims/velocity/omega` shape.
   The only "what we don't decode" gap flagged by the audit is the
   `bitfield & 0x01` `clear_modifiers` bit. Five other bits in
   `bitfield` are unused in retail data (sweep showed they were
   zero across the dataset).

## Conclusion

Retail's animation transitions had **no per-data blend duration**.
The visible look of motion swaps was a function of:

- `CSequence::advance_to_next_animation` — instant pointer swap.
- `MotionState::clear_modifiers` (driven by `bitfield & 0x01`) — a
  state-machine reset that drops accumulated modifier anims.
- The skeletal modifier stack — successive `add_motion(sequence,
  link, speed_mod)` calls layered without crossfade.

Our renderer's `CROSSFADE_S = 0` constant at
`scene3d/entities.js:263` correctly mirrors retail behaviour. The
one existing exception — the 150 ms crossfade on stance-change
Ready swaps at line `3296-3305` — is a deliberate
modifier-stacking-feel approximation per Wave 3 / Phase 3.3 (the
Combat Phase G stance-toggle work from 2026-05-17), not a data-
driven hint.

## What stays in code

- No new fields on Rust `MotionData`. No wasm export changes. No
  JS animation cache shape changes.
- `CROSSFADE_S = 0` constant remains the default.
- The Ready-stance-change 150 ms special-case at
  `scene3d/entities.js:3296-3305` remains.
- Wave 7 Phase 7.1's walk-cycle phase preservation (shipped this
  pass) provides the seamless rapid-tap feel via mid-clip resume,
  not via blend duration — a complementary mechanism.

## Action item moved to follow-on (not Wave 7)

The audit's `MotionData::clears_modifiers()` recommendation
(§1.2) is unrelated to blend hints but is the one outstanding
`bitfield` decode owed by the parser. Stay in motion-table follow-
ons; orthogonal to the movement-animation overhaul.
