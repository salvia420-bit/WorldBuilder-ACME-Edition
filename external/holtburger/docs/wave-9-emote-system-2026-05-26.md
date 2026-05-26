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

## Phase 9.5 — Future enhancements

**Remote-player motion broadcast.** Today, only the local player
sees the emote animation (via local prediction). For nearby players
to see it, the client must additionally send a `Movement_MoveToState`
(0xF61C) carrying the emote MotionCommand in `Commands[]`. Wire side
is ready — ACE's `RawMotionState.cs:84-94` already accepts SoulEmote
MotionCommands in `Commands[]` — but the `MotionStateBuilder` /
`MotionState` types in `holtburger-core` need an extension to carry
arbitrary action commands beyond locomotion. Estimated ~50-80 LOC in
`crates/holtburger-core/src/client/movement_types.rs` +
`movement/common.rs:build_motion_state_raw_motion_state`. Closes the
3rd-person observer gap.

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

- `apps/holtburger-web/src/lib.rs` — 4 edits:
  - `SessionCommand::SendEmote` + `SendSoulEmote` variants
    (line ~12725 region)
  - `SessionHandle::send_emote` + `send_soul_emote` exports
    (line ~18195 region)
  - `SoulEmoteResolution` struct + getters (line ~14050 region)
  - `SessionHandle::resolve_soul_emote` export + recv-loop arms
    (lines ~17230 and ~25030)
- `apps/holtburger-web/src/world_bootstrap_cache.rs` — added
  `try_get_cached()` accessor.
- `apps/holtburger-web/index.html` — replaced `/me` stub at
  ~7567-7573 with full `/me` + soul-emote routing.

## End-to-end user-visible behaviour

User types `/bow` in chat → local player plays the BowDeepState
animation (held pose) immediately AND nearby players see
"<PlayerName> bows deeply." in their chat log. Remote-player motion
broadcast (nearby players seeing the bow animation, not just the
text) is the Wave 9.5 follow-on described above.
