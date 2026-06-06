# Survey — multi-action motion queue (before buildout, 2026-06-06)

Trace of the ≥2-action `UpdateMotion` path end-to-end, to scope the buildout and answer the
reachability question the research left open.

## Data path (traced)

**Wire / protocol** (`crates/holtburger-protocol/.../movement/types.rs`):
- `MotionItem` (`:387`) = `{ command: u16, packed_sequence: u16, speed: f32 }`, 8 bytes. `packed_sequence`
  bit 15 = autonomous, bits 0-14 = the **stamp** for dedup (`.sequence()`, `.is_autonomous()`).
- S2C `InterpretedMotionState` (`:226`) carries `commands: Vec<MotionItem>` + `num_commands`. The count
  rides flags bits 11-15 (`(flags >> 11) & 0x1F`). We **already parse the full Vec correctly.**

**Wasm emit — where it's dropped** (`apps/holtburger-web/src/lib.rs:30594` `GameMessage::UpdateMotion`):
- Builds ONE `motion_command_u16` from `inv.state.forward_command` (or movement-type hint) and emits a
  single `EntityUpdate{ kind: ENTITY_UPDATE_KIND_MOTION, motion_command, motion_stance, motion_speed }`
  (`:30687`). **`inv.state.commands` (the Vec) is never read** — dropped here. (`inv` =
  `MovementTypeData::Invalid` envelope; Move/Turn variants carry no commands Vec.)

**JS consume** (`scene3d/loop.js:1232` KIND_MOTION arm): reads `upd.motionCommand` and calls
`em.setMotion(guid, motionCommand, motionStance, …)` — one clip. No queue.

**Retail reference** (`acclient.c:344388-344418`): loops `new_state->actions`; for each whose stamp is
**newer** than `server_action_stamp` (half-range `is_newer`: `|Δ|<=0x3FFF` direct, else wrapped),
advances the stamp and calls `DoInterpretedMotion(command, params)`. That's the FIFO + stamp-dedup we'd
mirror. ACE matches: `MotionInterp.cs:803` `foreach (var action in state.Actions)`.

## Reachability — the gating question (answered: RARE, likely dead in normal play)

ACE `InterpretedMotionState.ApplyMotion` (`InterpretedMotionState.cs:28-58`) applies ONE motion per
call: forward/sidestep/turn/style go to their fields; only an **Action**-masked command
(`CommandMask.Action`) is `AddAction`'d to the list. So `Actions.Count ≥ 2` requires **multiple
action-commands applied in the same server tick before a single broadcast** — uncommon. Most emotes /
cast flourishes broadcast one action at a time (the single-action path we already handle). `Actions`
is per-broadcast transient (`copy_movement_from` does NOT copy it). **Conclusion: the wire format and
ACE both *support* ≥2, but vanilla ACE rarely *emits* it. The feature is probably dead code in normal
Holtburg play.**

## Buildout shape (if GO) + effort

Two Rust approaches:
- **A. Struct field (research's suggestion):** add `motion_commands: Vec<u32>` to `EntityUpdate` +
  getter (mirror `motionCommand` `:17084`). Cost: `EntityUpdate {…}` is spelled out at **14 emit
  sites** (28552 META_REFRESH; 29668/29803/29853/35227 POSITION; 30138 SPAWN; 30383/30461 APPEARANCE;
  30517 ATTACH; 30556 REMOVE; 30687/35422/35489 MOTION; 30788 VELOCITY — the bare `grep -c` of 16 also
  counts the struct def @16749 + impl @16940) — every one needs the new field (`Vec::new()`), or a
  `#[derive(Default)]` + `..default` refactor. Only the 3 MOTION sites populate it. Tedious +
  error-prone. Needs a wasm rebuild.
- **B. Side-channel (lighter, recommended):** a `thread_local` per-guid action queue populated only in
  the UpdateMotion arm when `commands.len() > 1`, drained by a new free getter
  `pollMotionActionQueues()`. **Zero touches to the 16 `EntityUpdate` sites.** Still a wasm rebuild.

JS (both approaches): in the KIND_MOTION arm, after the primary `setMotion`, FIFO-drain the extra
actions — per-entity `_serverActionStamp`, play each newer action as a LoopOnce overlay (mirror
`setMotion`'s `_tryPlayLink` path), advancing the stamp (port `acclient.c:344400-344414`). The
stamp-dedup is **pure + unit-testable** (the `is_newer` half-range compare).

Effort: **moderate** — approach B keeps the Rust small; the JS overlay-FIFO + dedup is the real work.
Risk to the common path: low if flag-gated default-OFF (single-action path untouched when off).

## Recommendation

**Do NOT build speculatively.** Gate the buildout on a **2-line reachability probe first**: in the
UpdateMotion arm (`lib.rs:30634`, behind `DIAG_VERBOSE`), log `inv.state.commands.len()` when `> 1`;
rebuild once; exercise emotes / cast flourishes / combat / NPC behaviors and watch the console. If ≥2
**never** appears, it's dead code — record-only, don't build. If it DOES appear, build approach B +
the JS FIFO (flag default-OFF) with the stamp-dedup unit-tested. The probe is ~2 lines + one rebuild;
the full buildout is a moderate change for a case that may never fire — so measure before building.
