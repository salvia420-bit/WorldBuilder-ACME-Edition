# OpenAC / decomp comparison — round 4 findings ledger (2026-10-08)

Round 4 ran with the owner's usage cap: one compare agent (read-only) per round, verified by the orchestrator re-reading the
decomp and code citations (no separate verifier agents), then implemented by the two helper agents with the Rust compiled by the
orchestrator only. Evidence per finding: `round4-findings.json`.

| id | sev | status | escape | title | note |
|---|---|---|---|---|---|
| training-1 | HIGH | shipped | trainUnusable | Untrained skills with min_level > 1 (all magic schools, Healing, Lockpick, Alchemy, Fletching, Cooking, Summoning, Mana Conversion, Recklessness, Sneak Attack, Dirty Fighting) can never be trained: the Unusable section is hard-coded 'Cannot be trained' |  |
| training-2 | LOW | shipped | — | Train confirmation uses invented wording; retail asks "Are you sure you want to spend %d credits to train %s?" |  |
| training-3 | LOW | shipped | realStatXp | Attribute and vital raise costs use reconstructed spent XP (table[ranks]) and, for vitals, ranks back-solved from the base max — retail uses the stat's real level_from_cp / cp_spent, which the world crate already has | stats snapshot carries attributeXp/vitalXp |
| login-1 | MED | partial | logOffOnUnload | No log-off: the client never sends CharacterLogOff (0xF653), so closing or 'leaving' keeps the character in the world until ACE times the session out, and there is no return to character select | CharacterLogOff sent on page close; no in-place return to character select |
| login-2 | LOW | shipped | retailCharErrors | CharacterError codes are shown as raw enum names ('[ACE] CharacterError: Delete (0x6)'); retail maps each code to its ID_CHAR_ERROR_* message, sends fatal ones back to the login screen and ignores 2 / 7 / 22 |  |
| login-3 | LOW | shipped | retailCharList | Pending-delete characters print '[pending delete @ 1970-01-01T00:00:01Z]' — ACE's per-character field is a greyed-out flag/seconds value, not an epoch; retail greys the row and sorts it to the bottom |  |
| housing-1 | HIGH | shipped | — | HouseUpdateRestrictions (0x0248) is misparsed: the leading timestamp is 1 byte (retail and ACE), holtburger reads a u32, so the object guid and the whole RestrictionDB are garbage | 0x0248 timestamp is one byte |
| housing-2 | MED | shipped | houseOwnerFromData | House ownership is read from HouseStatus code 0, which ACE never sends — owners get HouseData; HouseStatus only ever carries a failure (retail shows it as a failed-transaction notice) |  |
| housing-3 | MED | shipped | — | Per-house restriction data (PWD HouseRestrictions and later 0x0248 updates) is parsed but never stored on the house entity — the data path retail CObjCell::check_entry_restrictions / CanMoveInto needs (prerequisite for landdefs-terrain-2) | per-house RestrictionDB + IsAllowedIn port; not wired to collision |
| social-lists-1 | MED | shipped | retailSocialCmds | Retail client commands /friends, /squelch, /unsquelch, /filter, /unfilter, /messagetypes are not handled — they are forwarded to ACE as '@friends …', which vanilla ACE does not implement ('Unknown command') | new app/social_commands.js; clearFriends 0x0025 |
| social-lists-2 | LOW | shipped | — | FriendsUpdate type 3 (RemoveSilent) is ignored — retail removes the friend without a message |  |

## Area summaries

### training

The character pane (2026-10-05 rebuild) already ports retail gmStatManagementUI closely: exact +1/+10 cost math (GetCostToRaise / GetCostToRaise10), one XP-amount request per raise, the awaiting-raise gate (retail also clears it on any quality change, so the vital-regen clear is retail), the trained/specialized curves, retail grouping and credit gating. One real gap: every untrained skill whose SkillTable min_level > 1 (War/Life/Void Magic, Creature/Item Enchantment, Healing, Lockpick, Alchemy, Fletching, Cooking, Summoning, Mana Conversion, Recklessness, Sneak Attack, Dirty Fighting) lands in the 'Unusable' section and is hard-coded 'Cannot be trained', so it can never be trained from the UI; retail shows the Train footer for every SAC < 2 skill. Minor: the train confirmation wording, and attribute/vital raise costs computed from a reconstructed (not the real) spent XP / vital ranks. OpenAC has only the wire builders here (no training UI rules worth porting).

### login

Most of the login protocol is sound: the CharacterList parse, enter-world chaining (EnterWorldRequest → ServerReady → EnterWorld), Delete/Restore by slot/guid, the Restore-instead-of-Delete button swap (matches retail UpdateButtons) and the kick-and-retry for a character still in the world. Not sending DddInterrogationResponse is deliberate and documented, so it is not re-reported. Biggest gap: there is no log-off at all. The client never sends CharacterLogOff 0xF653, so the character lingers in ACE until the session times out, and there is no way back to character select. Smaller: CharacterError codes surface as raw enum names, and pending-delete rows print a bogus 1970 timestamp because ACE's 'seconds greyed out' is used as an epoch. OpenAC models all eight messages (CharacterLogOff build plus a confirmation parse); retail is the reference for the flow.

### housing

Two wire and state bugs make the house data unusable. (1) GameEvent 0x0248 HouseUpdateRestrictions starts with a 1-byte timestamp (retail CM_House::DispatchUI_Recv_UpdateRestrictions; ACE's default ByteSequence), but holtburger reads a u32, so the object guid, version, open flag, monarch and guest table are all misaligned. (2) Ownership is taken from HouseStatus code 0, which ACE never sends; owners get HouseData and HouseStatus only ever carries a failure. So an owner pressing Query House never sees their house (the commerce smoke test hides this by faking errorCode 0). (3) Answer to the round-3 question: retail CObjCell::check_entry_restrictions needs, per house object, the PublicWeenieDesc HouseOwner + RestrictionDB. ACE does send both in CreateObject for every House object (the root house's DB for villa/mansion/dungeon copies), plus per-object 0x0248 updates and a PublicUpdateInstanceID(HouseOwner); it also needs the mover's monarch and the Admin+ImmuneCellRestrictions bits. Holtburger hydrates only HouseOwner and keeps 0x0248 as a single global for the panel, so the per-object RestrictionDB store is the missing prerequisite for landdefs-terrain-2.

### social-lists

The friends and squelch lists are complete in the social panel: add/remove buttons, the squelch editor, the friends snapshot fold, the SetSquelchDB snapshot, and round 2's client-side squelch filter (chat-6). The typed retail commands are missing. /friends (add/remove/remove -all/online/old/list), /squelch, /unsquelch, /filter, /unfilter and /messagetypes are client commands in retail's ClientCommunicationSystem. Holtburger sends any unknown /verb to ACE as '@verb', and vanilla ACE has none of these, so every one fails with 'Unknown command'. Minor: FriendsUpdate type 3 (RemoveSilent) is ignored, so the friend stays listed. Not a finding: the code comments say 'ACE does not re-push SetSquelchDB after a modify', but the running ACE does (SquelchManager SendSquelchDB after every change); the speculative mirror just reconciles to it.

