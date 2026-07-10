# S2C coverage table — W2 remainder (net-fixwave, 2026-07-10)

Closes the coverage half deferred in parts/W2-protocol-s2c.md §4. Worklist =
`lint-wire-codec.mjs`'s INFO counts (was 11 top-level + 63 action + 10 event
chorizite values un-enumerated; now 10 + 63 + 9 after the two fixes below).
Every row was adjudicated against **ACE at the running commit** (the wire
truth for this deployment): does ACE ever put the value on the wire, and if
so from where?

## 0. Fallthrough safety (the precondition for "INFO, not CRIT")

Verified in source: an un-enumerated **top-level** opcode takes
`unpack.rs:28-37` — warn + consume the whole remaining buffer +
`GameMessage::Unknown`; an un-enumerated **GameEvent** takes
`game_event.rs:498-508` — same shape (`GameEvent::Unknown`). Neither can
mis-frame a following message (the buffer is consumed to its end), so a
coverage gap degrades to a logged skip, never to parse desync. GameActions
are C2S — a gap there means *we cannot send* the action, never a parse risk.

## 1. Top-level GameOpcode — 11 chorizite values (2 fixed, 9 remain INFO)

| value | chorizite name | dir | ACE verdict | disposition |
|---|---|---|---|---|
| 0xF7C1 | Login_AccountBanned | S2C | **SENT** — `AuthenticationHandler.cs:220` terminates a banned-account login with `GameMessageAccountBanned` (u32 unban-seconds + optional String16L reason) | **ENUMERATED this wave** — unpack logs the ban and wraps the tail as `Unknown` (session is being terminated) |
| 0x00A0 | Character_ServerSaysAttemptFailed | S2C | ABSENT from `GameMessageOpcode.cs` — never sent (the 0x00A0 that IS live is the GameEvent `InventoryServerSaveFailed`, already enumerated in `GameEventOpcode`) | INFO, leave |
| 0x02EA | Qualities_UpdateAttribute2ndLevel | S2C | ABSENT — ACE stops at 0x02E9; already documented as a chorizite-XML ghost in `opcodes.rs` (commented `PublicUpdateVitalCurrentGhost`) | INFO, leave |
| 0xF630 | Character_SetPlayerVisualDesc | S2C | ABSENT | INFO, leave |
| 0xF651 | Login_AwaitingSubscriptionExpiration | S2C | ABSENT | INFO, leave |
| 0xF754 | Effects_PlayScriptId | S2C | in ACE's enum but **zero senders** (ACE's `GameMessageScript` sends PlayEffect 0xF755) | INFO, leave |
| 0xF7CA | Admin_ReceiveAccountData | S2C | ABSENT | INFO, leave |
| 0xF7CB | Admin_ReceivePlayerData | S2C | ABSENT | INFO, leave |
| 0xF7CC | Admin_SendAdminGetServerVersion | C2S | ACE has a handler (`GetServerVersionHandler`) | feature gap (could query server version); not a parse risk |
| 0xF7CD | Social_SendFriendsCommand | C2S | ACE has a handler (`FriendsOldHandler`) | feature gap (friends list); not a parse risk |
| 0xF7EB | DDD_EndDDDMessage | C2S | **chorizite-only value.** ACE's `DDD_EndDDD = 0xF7EA` — which we already enumerate as `DddEndDdd` and which ACE both sends and handles. Chorizite carries BOTH 0xF7EA (`DDD_OnEndDDD`) and 0xF7EB; only 0xF7EA exists on the ACE wire | INFO, leave (documented here) |

## 2. GameEventOpcode (0xF7B0 family) — 10 values (1 fixed, 9 remain INFO)

The 0xF7B0 family was the CRIT-candidate zone (ordered events). Result: ONE
live gap, fixed.

| value | name | ACE verdict | disposition |
|---|---|---|---|
| 0x01C8 | Allegiance_AllegianceUpdateDone | **SENT on every allegiance join/update push** — `AllegianceManager.cs:398`, `Player_Allegiance.cs:134/260`, `Allegiance.cs:361`. Payload u32 WeenieError | **ENUMERATED this wave** as `GameEvent::AllegianceUpdateDone { error_raw }` (was hitting the Unknown-GameEvent warn for any allegiance player) |
| 0x0003 | Allegiance_AllegianceUpdateAborted | in enum, zero senders | INFO, leave |
| 0x01CB | Item_AppraiseDone | in enum, zero senders (appraisal completes via IdentifyObjectResponse 0x00C9) | INFO, leave |
| 0x0201 | Trade_RemoveFromTrade | in enum, zero senders | INFO, leave |
| 0x0227 | House_UpdateRentTime | event class exists, **never constructed** | INFO, leave |
| 0x0228 | House_UpdateRentPayment | event class exists, never constructed | INFO, leave |
| 0x0259 | House_HouseTransaction | event class exists, never constructed | INFO, leave |
| 0x02AE | Admin_QueryPluginList | in enum, zero senders | INFO, leave |
| 0x02B1 | Admin_QueryPlugin | in enum, zero senders | INFO, leave |
| 0x02B3 | Admin_QueryPluginResponse2 | in enum, zero senders | INFO, leave |

## 3. GameActionOpcode — 63 C2S values (feature-gap census, no parse risk)

C2S: a gap means the client cannot SEND the action. 56 of 63 have live ACE
handlers (`Network/GameAction/Actions/`), so they'd work the moment a client
feature needs them; 6 have no ACE handler (dead even if sent); 1 is a
chorizite value error.

**ACE-handled (56) — by family:**
- **Allegiance (16):** 0x001F UpdateRequest · 0x0030 QueryName · 0x0031
  ClearName · 0x003C SetOfficerTitle · 0x003D ListOfficerTitles · 0x003E
  ClearOfficerTitles · 0x0040 SetApprovedVassal · 0x0042 DoAllegianceHouseAction
  · 0x0254 SetMotd · 0x0255 QueryMotd · 0x0256 ClearMotd · 0x02A0 ChatBoot ·
  0x02A3 ListBans · 0x02A5 RemoveOfficer · 0x02A6 ListOfficers · 0x02A7
  ClearOfficers · (banlist add/remove are already enumerated) — pairs with the
  0x01C8 S2C fix above.
- **House (13):** 0x0246 RemovePermanentGuest · 0x0247 SetOpenHouseStatus ·
  0x0249 ChangeStoragePermission · 0x024C RemoveAllStoragePermission · 0x024D
  RequestFullGuestList · 0x0258 QueryLord · 0x025C AddAllStoragePermission ·
  0x025F BootEveryone · 0x0262 TeleToHouse · 0x0266 SetHooksVisibility ·
  0x0267 ModifyAllegianceGuestPermission · 0x0268
  ModifyAllegianceStoragePermission · 0x0270 ListAvailableHouses
- **Chat/comms (7):** 0x000F SetAfkMode · 0x0010 SetAfkMessage · 0x0032
  TalkDirect (direct /tell by guid) · 0x0145 AddChannel · 0x0146 RemoveChannel
  · 0x0148 ListChannels · 0x0149 IndexChannels
- **Character (12):** 0x0025 RemoveAllFriends · 0x01A1 SetCharacterOptions ·
  0x01C2 QueryAge · 0x01C4 QueryBirth · 0x01E3/0x01E4 Add/RemoveSpellFavorite
  · 0x0216/0x0217/0x0218 consent list · 0x0224 SetDesiredComponentLevel ·
  0x0286 SpellbookFilter · 0x0311 FinishBarber
- **Chess (5):** 0x0269 Join · 0x026A Quit · 0x026B Move · 0x026D MovePass ·
  0x026E Stalemate
- **Misc (2):** 0x0027 TeleToPkArena · 0x00D6 AdvocateTeleport
- **Fellowship (1):** 0x0291 ChangeOpenness

**No ACE handler (6):** 0x0140 AbuseLogRequest · 0x02AF QueryPluginListResponse
· 0x02B2 QueryPluginResponse · 0xF61E DoMovementCommand · 0xF661
StopMovementCommand · 0xF7C9 JumpNonAutonomous (ACE movement rides
MoveToState/AutonomousPosition instead — which we already speak).

**Chorizite value error (1):** 0x0220 "Character_RemovePlayerPermission" —
ACE (and we) put RemovePlayerPermission at **0x021A** (`GameActionType.cs:100`;
ours is the lint-waived extension). 0x0220 exists nowhere in ACE.

## 4. ACE transport edges (the second deferred half)

- **A02-F8 ack-retain — VERIFIED, ACE-parity, kept.** ACE stamps outgoing
  `AckSequence` with `lastReceivedPacketSequence` (inclusive received,
  `NetworkSession.cs:929`), so strictly-greater retention would suffice; but
  ACE's own retransmit-cache prune keeps `>= sequence` too
  (`NetworkSession.cs:669`). Our `retain(>= sequence)` mirrors the reference
  implementation at a cost of ≤1 already-acked packet. Comment added at
  `session/reliability.rs:acknowledge_sequence`.
- **128 KB recv scratch — FIXED (A02 Opt-1).** Both recv-path
  `[0u8; 1024*128]` stack buffers (`receive.rs:280/336`) shrunk to a shared
  `RECV_SCRATCH_BYTES = 4096`: ACE caps packets at 1024 B
  (`ClientPacket.MaxPacketSize`) and the wsbridge kills any WS frame over
  4096 B, so nothing larger can arrive. Cuts ~124 KB of zeroing per inbound
  packet off the main-thread hot path (tens of MB of memset per teleport
  burst). Session crate tests 30/30.
- **Dup/reorder** (the remaining A02 §2 items) were already VERIFIED in the
  A02 read (buffered-early + rate-limited retransmit request + duplicate
  drop, `receive.rs`); ACE tolerates duplicate pure-ACKs explicitly
  (`NetworkSession.cs:341-343`). No change needed.

## 5. Validation

- `cargo check -p holtburger-protocol` + `-p holtburger-session` +
  `-p holtburger-core` + `-p holtburger-web --target wasm32-unknown-unknown`
  all clean.
- `cargo test -p holtburger-protocol` 385/385; `-p holtburger-session` 30/30.
- `node scripts/net-review/lint-wire-codec.mjs` exit 0 — now 95/94/93
  enumerated, INFO counts 10/63/9 (all adjudicated above; the remaining
  values are never-on-ACE-wire or C2S feature gaps by design).
