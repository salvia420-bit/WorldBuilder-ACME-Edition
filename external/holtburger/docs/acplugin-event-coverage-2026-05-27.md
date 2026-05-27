# ACPlugin event coverage — 2026-05-27

**ACPlugin PR-1 deliverable** (per
[`chorizite-reading-guide-summary-2026-05-27.md`](chorizite-reading-guide-summary-2026-05-27.md)
row §1 #1 + `external/chorizite/ACPlugin/READING_GUIDE.md` §9 last
bullet). Catalogues every `_net.S2C.On*` handler in
`external/chorizite/ACPlugin/API/World.cs` ctor (lines 88-133) and
`external/chorizite/ACPlugin/API/WorldObjects/Character.cs` ctor (lines
182-222) and matches each against our existing wasm `poll_events()` /
`plugins/api.js` bus surface.

**Status legend:**

| | Meaning |
|---|---|
| `Y` | Surfaced as a distinct kind (or bus event) with equivalent payload |
| `Partial` | We surface something adjacent (coalesced kind, missing fields, or different shape) |
| `N` | Not surfaced anywhere; PR-2 / Wave E gap |

**Source:** the 40 World handlers + 40 Character handlers + 2
`Game.cs` state machine handlers + 7 `PatchProgress.cs` connectivity
handlers (= **89 dispatch surfaces** total, larger than the "40+"
estimate). For symmetry with the original audit in `plugins/api.js`
header, this doc treats the 18 user-facing event SURFACES (the
`event EventHandler<TArgs>` declarations) as the primary axis and
breaks the underlying handler dispatch down per-event.

This IS the input list for PR 2 (`World.cs` S2C dispatch port) and
Wave E (wire-format gaps); each `N` row is a candidate.

---

## A. World.cs S2C handlers (40 entries — `World.cs:88-133`)

Each row is one `_net.S2C.OnXxx += OnXxx` line in the `World()` ctor.

| # | Handler (S2C event) | Opcode (est.) | Our kind / bus | Status | Notes |
|---|---|---|---|---|---|
| 1 | `OnItem_CreateObject` | 0x00F745 (GameEvent inner Item_CreateObject) | `kind=1` EntityUpdate (SPAWN) + `kind=11` InventoryUpdated | Partial | Spawn channel covers visible entities; appearance is captured separately. No `objectCreated` bus event yet (TODO `api.js:86`). PR-2 wires it. |
| 2 | `OnItem_DeleteObject` | 0x00F747 | `kind=2` REMOVE | Partial | No bus event `objectReleased` (TODO `api.js:87`). |
| 3 | `OnItem_ObjDescEvent` | 0x00F74C | `kind=8` `playerStatsUpdated` (coalesced) | Partial | Wired only for self via stats path; remote ObjDesc swaps don't refresh remote-player meshes. Renderer impact: high (clothing/jewelry/armor visual swaps invisible). |
| 4 | `OnItem_ParentEvent` | 0x00F751 | `kind=8` (coalesced via re-snapshot) | Partial | Sets `PropertyInstanceId.Wielder` for child→parent. `updatePhysicsDesc` now mirrors this when 0x20 parent flag set. PR-2 should add a dedicated kind for equip/wield events. |
| 5 | `OnItem_ServerSaysContainId` | 0x00F75A | `kind=11` InventoryUpdated | Partial | Wired; coalesced. No per-item move event (TODO Wave E row 6, deferred per `chorizite-reading-guide-summary-2026-05-27.md` Wave D.1). |
| 6 | `OnItem_ServerSaysMoveItem` | 0x00F75B | `kind=11` (coalesced) | Partial | See row 5. |
| 7 | `OnItem_ServerSaysRemove` | 0x00F73C | `kind=2` REMOVE | Y | Same path as DeleteObject. |
| 8 | `OnInventory_PickupEvent` | 0x00F74A | `kind=11` (coalesced via InventoryUpdated) | Partial | Currently only logged via `_log.LogError` in upstream Chorizite (`World.cs:303`). Could surface as `itemPickedUp` if useful. |
| 9 | `OnItem_OnViewContents` | 0x00F750 (assumed; opcode confirm-pending) | `kind=12` vendorOpened + `kind=21` containerOpened | Y | Wired with the load-bearing CHILDREN-WAIT gate (per handoff §3 first quote). Existing audit at `api.js:88-90` confirms `kind=21` covers chests/corpses, `kind=12` vendor. NOTE: our wasm path may NOT yet implement the wait-for-children semantics — verify before PR-2. |
| 10 | `OnItem_StopViewingObjectContents` | 0x00F752 | — | N | `containerClosed` bus event missing (TODO `api.js:90`). PR-2 priority — required to symmetrize the open/close lifecycle. |
| 11 | `OnLogin_PlayerDescription` | 0x00F745 (Login_PlayerDescription inner) | `kind=8` playerStatsUpdated + `kind=11` InventoryUpdated | Partial | First-arrival inventory profile decoded; the World handler in ACPlugin also seeds `Character.Containers` for child packs — our handler should mirror. PR-4 / Character.cs port. |
| 12 | `OnItem_SetAppraiseInfo` | 0x00C9 | — | N | **HIGH renderer impact.** `objectAppraised` event missing (Wave E §5.4 priority row "0x00C9"). Required to drive /assess UI, target tooltips, vendor item details. |
| 13 | `OnItem_SetState` | 0x00F76A | `kind=15` DoorStateChanged + `kind=17` EntityVisibilityChanged | Partial | Wired for doors + PhysicsState draw-gate. Generic `itemStateChanged` for non-door objects would cover container locks. |
| 14 | `OnItem_UpdateObject` | 0x00F748 | `kind=1` EntityUpdate (re-spawn) | Partial | Treated as a full re-spawn (mesh + position re-snapshotted). ACPlugin treats as in-place property refresh — slightly more efficient. Low priority. |
| 15 | `OnItem_UpdateStackSize` | 0x00F74B | `kind=11` InventoryUpdated | Partial | Coalesced — no per-stack toast. Inventory grid badge re-renders correctly. |
| 16 | `OnItem_WearItem` | 0x00F73E | `kind=8` + `kind=11` (coalesced) | Partial | Wielding mechanically works (server says equipped). Visual swap on local + remote players covered via ObjDesc (row 3). |
| 17 | `OnItem_QueryItemManaResponse` | 0x00C8 | — | N | Item mana query response not surfaced. Low priority (used by item-info HUD only). |
| 18 | `OnQualities_RemoveBoolEvent` | 0x01D1 | — | N | Quality-removal events not surfaced (Wave E §5.1: "Qualities_*Remove*Event family 0x01D1–0x01DE + 0x02B8/0x02B9 — biggest batch"). Low impact unless server explicitly clears flags. |
| 19 | `OnQualities_RemoveDataIdEvent` | 0x01D2 | — | N | Same batch as 18. |
| 20 | `OnQualities_RemoveFloatEvent` | 0x01D3 | — | N | Same batch as 18. |
| 21 | `OnQualities_RemoveInstanceIdEvent` | 0x01D4 | — | N | Same batch as 18. |
| 22 | `OnQualities_RemoveInt64Event` | 0x01D5 | — | N | Same batch as 18. |
| 23 | `OnQualities_RemoveIntEvent` | 0x01D6 | — | N | Same batch as 18. |
| 24 | `OnQualities_RemovePositionEvent` | 0x01D7 | — | N | Same batch as 18. |
| 25 | `OnQualities_RemoveStringEvent` | 0x01D8 | — | N | Same batch as 18. |
| 26 | `OnQualities_UpdateAttribute2ndLevel` | 0x01EC | `kind=8` playerStatsUpdated | Partial | Coalesced; no per-vital delta (`api.js:94-95` TODO). PR-4 should split. |
| 27 | `OnQualities_UpdateAttribute2nd` | 0x01EB | `kind=8` (coalesced) | Partial | Same as 26. |
| 28 | `OnQualities_UpdateAttributeLevel` | 0x01EA | `kind=8` (coalesced) | Partial | |
| 29 | `OnQualities_UpdateAttribute` | 0x01E9 | `kind=8` (coalesced) | Partial | |
| 30 | `OnQualities_UpdateBool` | 0x01D9 | `kind=8` (coalesced) | Partial | |
| 31 | `OnQualities_UpdateDataId` | 0x01DC | `kind=8` (coalesced) | Partial | |
| 32 | `OnQualities_UpdateFloat` | 0x01DA | `kind=8` (coalesced) | Partial | |
| 33 | `OnQualities_UpdateInstanceId` | 0x01DE | `kind=8` (coalesced) | Partial | |
| 34 | `OnQualities_UpdateInt64` | 0x01DD | `kind=8` (coalesced) | Partial | |
| 35 | `OnQualities_UpdateInt` | 0x01DB | `kind=8` (coalesced) | Partial | |
| 36 | `OnQualities_UpdatePosition` | 0x01E0 | `kind=8` (coalesced) | Partial | |
| 37 | `OnQualities_UpdateSkillAC` | 0x01EE | `kind=8` (coalesced) | Partial | |
| 38 | `OnQualities_UpdateSkillLevel` | 0x01ED | `kind=8` (coalesced) | Partial | |
| 39 | `OnQualities_UpdateSkill` | 0x01EF | `kind=8` (coalesced) | Partial | |
| 40 | `OnQualities_UpdateString` | 0x01DF | `kind=8` (coalesced) | Partial | |

**World.cs subtotal:** 1 Y / 29 Partial / 10 N / 0 N (out of 40).

The big partial cluster is the 14 `Update*` quality-updates (rows
26-40, except 36 which uses position). All collapse into `kind=8
playerStatsUpdated` — Wave C.2 already added 13 wasm exports that
let JS callers re-read derived attributes/vitals/skills on demand,
so the "missing per-vital delta" gap is reducible to "coalesced
notification + on-demand recompute" rather than "data missing."

---

## B. Character.cs S2C+C2S handlers (40 entries — `Character.cs:182-222`)

| # | Handler (S2C/C2S event) | Opcode (est.) | Our kind / bus | Status | Notes |
|---|---|---|---|---|---|
| 1 | `OnLogin_SendEnterWorld` (C2S echo for `Id`) | 0xF657 | `kind=4` GameStarted / `kind=5` CharacterSelect | Y | Character.id captured from session handle. |
| 2 | `OnLogin_PlayerDescription` | 0x00F745 (Login inner) | `kind=8` + `kind=11` | Partial | World.cs entry covered the inventory side; Character.cs entry covers the full Base+Qualities flag-cascade (attributes/vitals/skills/enchantments/cooldowns). Wave C.2 wasm exports cover the math. PR-4 wires the dispatch. |
| 3 | `OnLogin_LogOffCharacter` | 0xF7CB | `kind=6` LoggingOut | Y | |
| 4 | `OnEffects_PlayerTeleport` | 0xF748 (Effects_PlayerTeleport assumed) | — | N | `portalSpaceEntered` bus event missing (TODO `api.js:98`). Required for loading-screen overlay symmetry. |
| 5 | `OnItem_SetState` (Character variant — checks PhysicsState.Hidden for self only) | 0x00F76A | `kind=7` ENTERED_WORLD (partial) | Partial | Self-deactivate-Hidden = `portalSpaceExited`; world entry covers post-portal arrival (`api.js:99` TODO). |
| 6 | `OnCombat_HandlePlayerDeathEvent` | 0xF6C8 | `kind=29` death | Y | Q1a (2026-05-26) shipped. Self-death + remote-death both surface; combat-hud overlays self. |
| 7-20 | `OnQualities_PrivateRemove/Update {Bool,Int,Int64,Float,String,InstanceId,DataId} (14 handlers)` | 0x0259-0x0269 (Private quality family — `Character.cs:191-204`) | — | N | **PRIVATE = only sent to self.** Currently NOT surfaced anywhere — wasm needs a parallel poll_events kind family. Per handoff §3 second quote ("PrivateUpdate* vs Update* — don't merge"), the dispatch target MUST be the Character, not the World. PR-4 territory. Low immediate impact (the World public variants already drive most HUD state for self), but blocks plugins that want strict server-side-only updates (skill train confirmation, fellowship invites). |
| 21-28 | `OnQualities_PrivateUpdateAttribute*/SkillAC/SkillLevel/Skill (8 handlers)` | 0x0270-0x0278 (Private quality family — `Character.cs:205-211`) | — | N | Same as 7-20 — character-only updates. The Wave C.2 wasm exports + retail attribute/vital/skill formulas cover the math when bound; this gap is purely about delivering the trigger. |
| 29-30 | `OnQualities_PrivateRemovePositionEvent / PrivateUpdatePosition (2 handlers)` | 0x0258 / 0x0257 | — | N | Same as 7-20 — character private position updates (motion-step quality slots). |
| 31 | `OnMagic_DispelEnchantment` | 0x02C5 | — | N | Single-enchant dispel. Wave E §5.4 priority row 0x02C2-C8. |
| 32 | `OnMagic_DispelMultipleEnchantments` | 0x02C6 | — | N | Batch dispel. Wave E priority. |
| 33 | `OnMagic_PurgeBadEnchantments` | 0x0312 | — | N | Wipe-all-debuffs. Wave E priority. |
| 34 | `OnMagic_PurgeEnchantments` | 0x02C8 | — | N | Wipe-all. Wave E priority. |
| 35 | `OnMagic_RemoveEnchantment` | 0x02C4 | — | N | Wave E §5.4 priority row 0x01A8 (note: ACPlugin handler routes the inner 0x02C4 + the C2S echo for 0x01A8 ends up looking equivalent — verify before wiring). |
| 36 | `OnMagic_RemoveMultipleEnchantments` | 0x02C7 | — | N | Wave E priority. |
| 37 | `OnMagic_UpdateEnchantment` | 0x02C2 | — | N | **#1 renderer impact** — every cast/refresh fires this. Wave E §5.4 priority row 0x02C2. Enchantment-tracking HUD blocked on this. |
| 38 | `OnMagic_UpdateMultipleEnchantments` | 0x02C3 | — | N | Batch update — login profile refresh path. Wave E priority. |

**Character.cs subtotal:** 3 Y / 2 Partial / 35 N (out of 40).

**The 35 N's split:**
- 24 Private quality updates (rows 7-30) — character-only delivery; not blocked by data, blocked by wasm-dispatch.
- 8 Magic enchantment updates (rows 31-38) — Wave E priority cluster; renderer-visible (buffs/debuffs HUD).
- 1 Effects_PlayerTeleport — portal-space gate.
- 2 partials = LoginPlayerDescription, Item_SetState; both covered for self via adjacent kinds.

---

## C. Game.cs state machine handlers (2 entries)

| # | Handler | Opcode | Our kind / bus | Status | Notes |
|---|---|---|---|---|---|
| 1 | `OnStateChanged` (synthesized from 4 wire events) | — | `kind={1,4,5,6,7}` split | Partial | We surface state TRANSITIONS as 5 different kinds but no single unified "stateChanged {old, new}" bus event (`api.js:92` TODO). PR-2 should add a unified channel + the `GameStateChanged` factory (already shipped in PR-1). |
| 2 | `OnCharactersChanged` (re-fire roster) | — | `kind=0` CharacterListRecv | Y | Wired; renderCharacterList drains every fire. |

---

## D. PatchProgress.cs handlers (3 entries — out of scope)

`PatchProgress.OnProgressChanged / OnConnectProgress / OnPatchProgress`
(`PatchProgress.cs:12-132`) — N/A for browser. We ship pre-built DATs;
no patcher/connect-handshake events. Listed for completeness only.

---

## E. Aggregate scoring (excluding PatchProgress N/A)

| Source | Total | Y | Partial | N |
|---|---|---|---|---|
| World.cs S2C | 40 | 1 | 29 | 10 |
| Character.cs (S2C+C2S) | 40 | 3 | 2 | 35 |
| Game.cs | 2 | 1 | 1 | 0 |
| **Total** | **82** | **5** | **32** | **45** |

The 5 Y's: ItemServerSaysRemove, Item_OnViewContents, Login_SendEnterWorld, Login_LogOffCharacter, Combat_HandlePlayerDeathEvent, CharactersChanged.

The 32 Partials are dominated by the quality-update family (40 entries
collapsed into `kind=8` playerStatsUpdated), and 10 World.cs "we
surface adjacent data but not this exact event" rows.

---

## F. Top 5 N's by renderer impact

Ordered for PR-2 / Wave E execution priority. The first 3 directly
unblock Wave E's renderer requirements.

| Rank | Handler | Opcode | Renderer / UI impact | Wave / PR target |
|---|---|---|---|---|
| 1 | `OnMagic_UpdateEnchantment` + `OnMagic_UpdateMultipleEnchantments` | 0x02C2 / 0x02C3 | Buffs/debuffs HUD blocked entirely. Every cast/refresh + login profile fires these. | Wave E batch 1 (per handoff §5.1 §6.2 priority list) |
| 2 | `OnItem_SetAppraiseInfo` | 0x00C9 | Unblocks /assess UI, target tooltips, vendor item-details popovers. Currently rows 12 / Character ID 4 sit completely dark. | Wave E batch 1 priority row "0x00C9" |
| 3 | `OnItem_StopViewingObjectContents` | 0x00F752 | `containerClosed` missing — open/close lifecycle asymmetric. Vendor + chest UIs can't reliably trigger "panel-close" animations or save-state-on-exit. | PR-2 (same dispatch level as the `OnItem_OnViewContents` partner) |
| 4 | `OnEffects_PlayerTeleport` | 0xF748 | `portalSpaceEntered` not wired — loading-screen overlay edge missing. Currently we only react to exit; entry blink is invisible. | PR-2 (Character.cs port) |
| 5 | 5 `OnMagic_Dispel/Purge/Remove*` handlers | 0x02C4-C8 | Buffs/debuffs HUD wipe / removal not surfaced — UI must poll. Pairs with #1 for the enchantment cluster. | Wave E batch 1 (priority cluster) |

The remaining N's (24 Private quality updates + 10 quality-remove
events + 1 PickupEvent + 1 QueryItemManaResponse) are all
plugin-author convenience rather than user-facing renderer blockers.
They land in Wave E batch 2.

---

## G. Out-of-band ClientEvent kinds (browser-only)

These have no Chorizite analogue and exist solely to drive browser-side
plumbing (no PR-2 / Wave E action needed). For completeness, mirrors
the comment at `api.js:38-47`:

- `kind=2` ChatReceived
- `kind=11` InventoryUpdated (coalesced)
- `kind=13` UseFailed (WeenieError; would be a Character.OnUseFailed event)
- `kind=14` UseDone (server-ack success)
- `kind=15` DoorStateChanged
- `kind=16` SoundTriggered
- `kind=17` EntityVisibilityChanged
- `kind=18` EntityAirborneChanged
- `kind=19` CombatEvent (5 sub-events: damageDealt / damageTaken / evadedTarget / evadedAttacker / attackDone)
- `kind=29` Death

---

## H. Method note

The opcode estimates in columns 3 are from cross-referencing
`Chorizite.ACProtocol/protocol.xml` against the C# handler names
(format: `<event name="OnXxx">` ⇒ handler `OnXxx`). They are NOT
re-confirmed against our wasm dispatcher; PR-2 + Wave E execution
should grep `external/holtburger/crates/holtburger-protocol/src/messages/`
to confirm exact opcode mapping before adding new ClientEvent kinds.

The Y / Partial / N tagging is BEST-EFFORT from reading
`plugins/api.js` (canonical post-Wave-D.1 surface) + our existing
`coverage table 18-row audit` at `api.js:18-65`. The original audit
covered 18 user-facing EventArgs; this expanded view covers all 82
S2C/C2S handler subscriptions for symmetry with PR-2 dispatch
scope. Numbers diverge from the original (3 Y / 6 Partial / 6 N / 3 N/A)
because:

1. **Granularity differs.** Original counted 18 user-facing events
   (1 per `event EventHandler<TArgs>` declaration in C#). This doc
   counts 82 underlying `_net.S2C.OnXxx += handler` subscriptions.
   Same wire — different axis.
2. **PartialCounts as overflow.** Where the 18-row audit said
   "PARTIAL" once for the whole enchantment family, this doc counts
   8 N's (one per `OnMagic_*` handler).
3. **Quality-update family.** Original audit didn't split the 14
   quality-update handlers; this doc lists each.

Cross-validate against the original `plugins/api.js:18-65` audit
before pulling into PR-2 commit messages.
