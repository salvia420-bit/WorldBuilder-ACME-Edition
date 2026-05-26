# Wave 9 — Player Emote System (2026-05-26)

**Scope:** new wave outside the original 7-wave plan
(`docs/movement-animation-overhaul-plan-2026-05-26.md`). Wires the
slash-command emote path so `/bow`, `/wave`, `/cheer`, `/me <action>`,
… are dispatched end-to-end: chat input → wire packet → ACE
rebroadcast (chat text) + local-prediction motion (visible immediately
on the local player).

Runs in parallel with Wave 8 (classifier coverage in `scene3d/
entities.js`). Phase 9.3's local-prediction calls `em.setMotion` /
`em.setSwingMotion`, which now resolve cleanly because Wave 8 added
EMOTE_COMMANDS / STATIONARY_COMMANDS to `classifyMotionCommand`.

---

## Phase 9.1 — Wire-path investigation (read first)

There are **two ACE C2S opcodes**, neither of which broadcasts a
motion:

| Opcode | Name | ACE handler | Wire payload | What it does |
|---|---|---|---|---|
| 0x01DF | `GameAction::Emote` | `GameActionEmote.cs:7-13` → `HandleActionEmote` | `String16L message` | Rebroadcasts as `GameMessageEmoteText` (0x01E0). No motion. |
| 0x01E1 | `GameAction::SoulEmote` | `GameActionSoulEmote.cs:7-13` → `HandleActionSoulEmote` | `String16L message` | Rebroadcasts as `GameMessageSoulEmote` (0x01E2). No motion. |

**The motion itself does NOT travel on the emote opcodes.** Per retail
(`~/ac-headers/acclient.c:425567`), the retail client:

1. Parses the typed `*bow*` token via `ChatPoseTable::InqChatPoseCommand`
   → returns `cmdstring` ("BowDeepState"), `myEmote` ("bow deeply."),
   `otherEmote` ("bows deeply.").
2. Invokes `string2command(cmdstring)` → `MotionCommand.BowDeepState`
   (0x430000EC).
3. Locally dispatches the motion via `cmdinterp` — same path walk /
   run / jump take. This eventually emits a `Movement_MoveToState`
   (0xF61C) with the emote MotionCommand in `Commands[]`. ACE accepts
   it via `RawMotionState.cs:84-94` and rebroadcasts to nearby clients
   via UpdateMotion.
4. Sends `Communication_SoulEmote` (0x01E1) with `otherEmote` so the
   chat line appears.

In Wave 9 we ship the **chat-side wire path + local-prediction motion**
(local player sees the animation immediately). The MoveToState
motion-broadcast hook for remote players is a follow-on (deferred —
ACE's `RawMotionState` accepts the command shape today, but our
`MotionState` / `MotionStateBuilder` doesn't carry an arbitrary
emote-command slot yet; that's a Wave 9.5+ enhancement).

**Citations:**

- `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Enums/GameActionType.generated.cs:178-181`
  — emote sub-opcodes (`Communication_Emote = 0x01DF`,
  `Communication_SoulEmote = 0x01E1`).
- `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/C2S/Actions/Communication_Emote.generated.cs`
  + `Communication_SoulEmote.generated.cs` — wire shape: just
  `String16L message`.
- `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionEmote.cs:7-13`
  + `GameActionSoulEmote.cs:7-13` — server handlers (chat-only
  rebroadcast).
- `~/ace-server/Source/ACE.Server/WorldObjects/Player.cs:822-845` —
  `HandleActionEmote` / `HandleActionSoulEmote` (broadcast only,
  no motion).
- `~/ace-server/Source/ACE.Server/Entity/SoulEmote.cs:8-84` — full
  pose → MotionCommand allowlist for the motion path (303 token
  aliases comment-documented).
- `~/ace-server/Source/ACE.Server/Network/Motion/RawMotionState.cs:84-94`
  — server accepts SoulEmote MotionCommands in `Commands[]` and
  rebroadcasts to nearby clients.
- `~/ac-headers/acclient.c:425550-425645` — retail client emote flow
  (ChatPoseTable lookup + cmdinterp local motion + SoulEmote send).

## Phase 9.2 — Wasm send-path

Added two `SessionHandle` exports + matching `SessionCommand` variants
+ recv-loop arms in `apps/holtburger-web/src/lib.rs`:

| Wasm method | Wire | Use case |
|---|---|---|
| `sendEmote(message)` | `GameAction::Emote (0x01DF)` | `/me <action>` |
| `sendSoulEmote(message)` | `GameAction::SoulEmote (0x01E1)` | `/bow`, `/wave`, `/cheer`, … |

Both methods are thin wrappers around the existing protocol crate
(`crates/holtburger-protocol/src/messages/chat/actions.rs:44-78` —
`EmoteActionData` + `SoulEmoteActionData`). Empty messages are
rejected client-side.

A third export, `resolveSoulEmote(token)`, returns a structured
`SoulEmoteResolution` for a slash-command token (`"bow"`, `"wave"`,
…). Resolution chain:

1. `world_bootstrap_cache::try_get_cached()` returns the cached
   `WorldBootstrap` (loaded at session start from
   `repo.read_soul_emote_catalog`).
2. `bootstrap.soul_emote_catalog.resolve(token)` returns the pose
   name + my/other emote text (e.g. `("Wave", "wave.", "waves.")`).
3. `motion_command_for_soul_emote_pose(pose)` (in
   `crates/holtburger-core/src/soul_emote_motion.rs`) returns the
   low-16 MotionCommand.
4. The full 32-bit MotionCommand is reconstructed by OR-ing the
   class prefix (`0x13000000` for one-shots, `0x43000000` for held
   `*State` poses). Citations: `~/ac-headers/acclient.c:41743+`
   motion class table; `MotionCommand.cs:8-80` enum.

Returns `None` if the bootstrap isn't loaded yet OR the token is
unknown (typo, non-emote slash command). The JS slash router then
falls through to `sendChat`.

## Phase 9.3 — Slash-command parsing in chat

`index.html:7567-7677` (region was `routeSlashCommand`'s `/me` stub)
now handles:

- `/me <action>` → `handle.sendEmote(action)` + local echo.
- `/<token>` (e.g. `/bow`, `/wave`, …) where `<token>` is in the
  DAT's ChatPoseTable:
  1. `handle.resolveSoulEmote(cmd)` → `SoulEmoteResolution`.
  2. `handle.sendSoulEmote(resolution.otherEmote)` — wire packet.
  3. Local prediction:
     - **Held pose** (`resolution.held == true`): `em.setMotion(
       localGuid, motionFull, stance)` — Wave 8 STATIONARY_COMMANDS
       routes via cycle path (LoopRepeat).
     - **One-shot** (`resolution.held == false`): `em.setSwingMotion(
       localGuid, motionFull)` — Wave 8 EMOTE_COMMANDS routes via
       link path (LoopOnce).
  4. Echoes `"You wave."` (1st person rendered text) into the
     local chat log.
- Unknown slash → fall through to `sendChat` so the user sees ACE's
  "Unknown command" reply.

The 303-token retail catalog is too large to hard-code in JS; the
wasm `resolveSoulEmote` keeps the lookup DAT-driven. New retail
aliases / custom server pose tables are picked up automatically.

**Local-prediction parity with retail:** the retail client also plays
the motion locally (acclient.c:425567 → `cmdinterp` invocation)
because ACE's GameActionSoulEmote handler does NOT echo a motion back
to the sender — the sender's own client must drive its visual. Our
local prediction mirrors this exactly.

## Phase 9.4 — Emote menu plugin

Skipped per the brief recommendation. Slash commands cover the input
need today; the popup menu can land in a future polish wave (pattern
will follow `plugins/spellbook.js` or `plugins/inventory.js`).

## Phase 9.5 — Remote-player motion broadcast (SHIPPED 2026-05-26)

**Goal:** close the 3rd-person observer gap. Pre-9.5 `/bow` only
showed chat text to remote players (the wire layer was already
correct — Wave 9.2 fired the `0x01E1 GameAction::SoulEmote` packet —
but the motion itself never left the local client, so observers saw
the line `<Player> bows.` without any animation).

**Implementation choice (B): new `SessionCommand` variant +
companion JS dispatch.** The CLI already had this exact path — see
`crates/holtburger-core/src/client/commands.rs:376-385`, where
`SessionState::handle_soul_emote_command` calls
`self.movement.enqueue_transient_motion(command, MotionStyle::
Explicit(stance))` right after dispatching the text packet. Wave
9.5 pipes that same call through the wasm bundle's recv loop. No
MotionState / MotionStateBuilder extension was required — the prior
Wave 9 estimate was wrong, because `enqueue_transient_motion`
bypasses MotionState entirely and packs the emote MotionCommand
directly into `RawMotionState.commands[]` as a single `MotionItem`
via `execute_transient_motion_at` (`crates/holtburger-core/src/
client/movement/system.rs:1190-1212`).

**Wire path (additions in bold):**

| Stage | Layer | Source |
|---|---|---|
| 1. JS reads slash token | index.html `routeSlashCommand` | `apps/holtburger-web/index.html:7617-7693` |
| 2. JS calls `handle.sendSoulEmote(otherText)` | text packet | already shipped Wave 9.2 |
| **2.5. JS calls `handle.broadcastEmoteMotion(motionFull)`** | wasm export | **`apps/holtburger-web/src/lib.rs:18432-18458`** |
| **3. Recv loop queues transient motion** | `SessionCommand::BroadcastEmoteMotion` arm | **`apps/holtburger-web/src/lib.rs:25311-25372`** |
| 4. `MovementSystemHandle::enqueue_transient_motion` | core | shipped pre-9.5 — `handle.rs:57-63` |
| 5. Next `TickMovement` calls `execute_transient_motion_at` | core | shipped pre-9.5 — `system.rs:1190-1212` |
| 6. `send_transient_motion_pulse` → `MoveToState 0xF61C` | wire | shipped pre-9.5 — `system.rs:1419-1437` |
| 7. ACE `RawMotionState.cs::ApplyMotion` Action branch | server | `RawMotionState.cs:92-95` |
| 8. ACE `Player_Networking.cs::BroadcastMovement` → `EnqueueBroadcast(GameMessageUpdateMotion)` | server | `Player_Networking.cs:309-365` |
| 9. Remote clients receive `UpdateMotion (0xF74E)` | wire | (pre-existing recv) |

**Wasm shape.** `broadcastEmoteMotion(motion_full: u32)` accepts the
canonical 32-bit MotionCommand (`0x430000EC` for `BowDeepState`,
`0x13000087` for `Wave`). The recv arm extracts the low-16
substate for `InterpretedMotionCommand`; the class high-bits are
re-applied by `MotionItem::pack` (`crates/holtburger-protocol/src/
messages/movement/types.rs:431-441`) when the wire packet is
serialized.

**MotionStyle.** Set to `PreserveServer` so the player's stance
isn't toggled by the emote broadcast. Bowing while in sword combat
stance keeps the player in sword combat after the bow plays.

**Coexistence with locomotion (edge case).** A user can walk and
bow simultaneously in retail. The transient motion pulse builds a
fresh `RawMotionState` containing ONLY the emote in `commands[]`
(plus the preserved current_style); the held WASD `MotionState`
continues to drive `send_motion_state_pulse` on its own edges via
the active_drive path. ACE's `RawMotionState.cs::ApplyMotion`
treats the action bit (`CommandMask.Action = 0x10000000`) as an
addition to the state, not a replacement (`AddAction` at line 94 vs.
the SubState/Style branches that overwrite `ForwardCommand` /
`CurrentStyle`). So:

- Bow while standing still → MoveToState carries `commands=[Bow]`
  only; ACE broadcasts as UpdateMotion with the action.
- Bow while walking → two MoveToState packets fire in quick
  succession: one for the held locomotion (already firing on the
  W key edge), then a separate transient pulse with `commands=[Bow]`.
  ACE applies both; the observer sees the player walking AND playing
  the bow animation overlay. This matches retail's `cmdinterp`
  behaviour at `~/ac-headers/acclient.c:425567`, where the local
  motion path coexists with the held forward-key drive.

No special-casing in our 9.5 code — the multi-packet behaviour
falls out of the design. The "queue transient then keep ticking
locomotion" pattern is identical to how `enqueue_transient_motion`
is used for combat stance hotkeys (per the
`MovementSystemHandle::enqueue_transient_motion` rustdoc).

**Skipped follow-ons:**

**Emote popup menu.** `plugins/emotes.js` skeleton matching
`plugins/spellbook.js`'s pattern: bar button → popup grid → click
fires the same `routeSlashCommand` path. Categorize by
`SoulEmoteCatalog::poses` (or sub-bucket via the held/one-shot
discriminator we already derive).

**`/cancel` to clear held poses.** Held `*State` poses loop until the
player hits another motion (walks, attacks, …). Adding `/cancel` to
explicitly send `MotionCommand.Ready` would match retail's
`*woah*`/`*stop*` aliases. Note: `WoahState` is in the catalog as a
held pose, but a discrete `/cancel` slash is more intuitive UX.

**Emote popup menu.** `plugins/emotes.js` skeleton matching
`plugins/spellbook.js`'s pattern: bar button → popup grid → click
fires the same `routeSlashCommand` path. Categorize by
`SoulEmoteCatalog::poses` (or sub-bucket via the held/one-shot
discriminator we already derive).

**`/cancel` to clear held poses.** Held `*State` poses loop until the
player hits another motion (walks, attacks, …). Adding `/cancel` to
explicitly send `MotionCommand.Ready` would match retail's
`*woah*`/`*stop*` aliases. Note: `WoahState` is in the catalog as a
held pose, but a discrete `/cancel` slash is more intuitive UX.

## Validation

- `cargo check -p holtburger-web --target wasm32-unknown-unknown`:
  clean (18 pre-existing warnings, no new errors).
- `wasm-pack build --target web --out-dir pkg --dev`: clean. New
  exports present in `pkg/holtburger_web.d.ts:3296+`,
  `:3380+`, `:3395+`, `:3968+`.
- `node --check` on each parseable `<script>` block in index.html:
  all blocks under my edits pass.

End-to-end live-test (browser, ACE) deferred until both this wave
and Wave 8's classifier-coverage land — user reviews the combined
diff.

## Files touched

- `apps/holtburger-web/src/lib.rs` — 4 edits (Wave 9.2-9.3) + 3 edits
  (Wave 9.5):
  - `SessionCommand::SendEmote` + `SendSoulEmote` variants
    (line ~12725 region)
  - Wave 9.5: `SessionCommand::BroadcastEmoteMotion` variant
    (line ~12784 region)
  - `SessionHandle::send_emote` + `send_soul_emote` exports
    (line ~18195 region)
  - Wave 9.5: `SessionHandle::broadcast_emote_motion` export
    (line ~18432 region)
  - `SoulEmoteResolution` struct + getters (line ~14050 region)
  - `SessionHandle::resolve_soul_emote` export + recv-loop arms
    (lines ~17230 and ~25030)
  - Wave 9.5: `SessionCommand::BroadcastEmoteMotion` recv-loop arm
    (line ~25311 region)
- `apps/holtburger-web/src/world_bootstrap_cache.rs` — added
  `try_get_cached()` accessor.
- `apps/holtburger-web/index.html` — replaced `/me` stub at
  ~7567-7573 with full `/me` + soul-emote routing; Wave 9.5 added
  the `broadcastEmoteMotion(motionFull)` call between
  `sendSoulEmote` and local prediction (~7639-7665 region).

## End-to-end user-visible behaviour

User types `/bow` in chat → (1) local player plays the
BowDeepState animation (held pose) immediately via local
prediction AND (2) nearby players see `"<PlayerName> bows
deeply."` in their chat log AND (Wave 9.5) (3) nearby players see
the actual bow animation on the player's model. Two wire packets
fire: `Communication_SoulEmote (0x01E1)` for the chat text plus
`Movement_MoveToState (0xF61C)` with the BowDeepState
MotionCommand in `Commands[]` for the animation broadcast. ACE
rebroadcasts both via `Player_Networking.cs::BroadcastMovement`
and the existing chat-rebroadcast path.

## Validation (Wave 9.5)

- `cargo check -p holtburger-web --target wasm32-unknown-unknown`:
  clean (18 pre-existing warnings, no new errors).
- `cargo test -p holtburger-protocol --lib`: 286 / 286 PASS.
- `wasm-pack build --target web --out-dir pkg --dev`: clean. New
  export `broadcastEmoteMotion(motion_full: number): void;` visible
  in `pkg/holtburger_web.d.ts:2303`.
- `node --check` on the routeSlashCommand inline script block: PASS.
- Browser live-test: deferred (user runs the two-player PVS test
  described in the brief).
