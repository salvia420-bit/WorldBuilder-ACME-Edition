# HANDOFF — OpenAC / retail-decomp comparison: rounds 1–4 and follow-ups shipped (2026-10-08)

A code-only session. Parallel agents each took a piece of OpenAC (`external/OpenAC`, C#), compared it with the
matching holtburger-web code and with the retail decomp (`~/ac-headers/acclient.c`, the authority), and
proposed changes. A second agent then tried to refute every finding before anything was implemented.
Code commits: `0680b84b` (round 1), `ac5a0e94` (round 2) and `2552cc25` (follow-ups + rounds 3–4).
**There was no visual testing.** Every change that is visible in-game ships default-on with an `?flag=off`
escape and is listed in §4 for a later 1070 eye-test.

- Round 1: 14 areas, 74 findings, 54 shipped. Ledger `docs/openac-comparison-2026-10-08/FINDINGS-round1.md`;
  evidence `round1-findings.json`.
- Round 2: 10 areas, 53 findings, 42 shipped + 2 partial. Ledger `FINDINGS-round2.md`; evidence `round2-findings.json` (§6).
- Follow-ups + rounds 3–4 (§6b), done under the owner's usage cap (two helper agents, no workflows):
  - 9 deferred findings handled: 7 shipped, 1 partial, 1 skipped because the decomp contradicts it.
  - Rounds 3–4: 8 areas, 26 findings, 19 shipped + 3 partial. Ledgers `FINDINGS-round3.md` / `FINDINGS-round4.md`.
  - The CLI build, broken since 2026-07-27, is fixed.
- Status ledger: `docs/PARITY-STATUS.json` waves 4, 5 and 6.
- Each evidence file holds the decomp / OpenAC / holtburger citations, the proposed change, and the verifier's corrections and
  implementation notes.

---

## 1. The owner's prompt (verbatim)

The session goal, set with `/goal`:

> we are working on holtburger-web, which is visually superior to openac, but there are likely many areas where holtburger-web can be improved by contrasting holtburger-web's code with the decomp. each agent should find a piece of openac code and compare it with corresponding code in holtburger-web and see if the holtburger-web can be improved by the observations. i will be observing closely and will tell you when the goal is complete. don't harm the visuals of holtburger-web. this is a code only session with no visual testing. each agent needs to be aware of the limitations of the laptop you are on and must not cause it to go out of memory.

Later in the session:

> yes wrap up whenever you are done round 1 then commit and push to origin/master. make a handoff before pushing that contains my initial prompt to you and your suggested prompt to resume the remaining work

> dont stop the currenr work tho

> how much to do after the verifiers? might as well keep going i suppose

> once the general purpose agents are done can we not spawn more and just let the holtburger-js-implement r2 finish as i must manage usage

> lets do the follow ups and continue with future work, you can have a 5.5 agent to help

> we can add another agent to the team. 5.5 we can have two going at any time

> no more agents after this. we wrap up and update the handoff commit and push when they are done

---

## 2. How it was run

1. **Compare → verify (read-only workflow).** There were 14 behaviour areas, avoiding the 2026-10-04 round's collision, doors,
   combat, remote-motion and perf docs. For each area, one agent compared OpenAC, holtburger and acclient.c and returned at most 6
   findings, each with citations. One adversarial verifier per area re-read every citation, tried to refute the finding, checked
   git log and PARITY-STATUS for duplicates, and classified the visual impact (`none` / `behaviour` / `render`).
   Result: 74 findings; 67 confirmed, 7 partially confirmed, 56 judged safe to implement without an eye-test.
2. **Implement in file-disjoint lanes.**
   - JS: a workflow with two sequential lanes (entities.js owners vs the rest), using targeted `node` tests only.
   - Rust: background agents that edit but never compile (the CLAUDE.md agent rule). The orchestrator compiled and tested each
     cluster under `capped-build`, one heavy job at a time.
3. **Gate once at the end**, then one release wasm build (§3).

Not implemented: `render`-impact findings and large or unsafe ones (§5).

---

## 3. What shipped, and the gate

| Theme | Findings | Escape flags (all default ON) | Pinned by |
|---|---|---|---|
| Animation hooks fire when a frame is LEFT, never the last frame, every loop; no burst on phase carry; reverse hooks | csequence-1, anim-hooks-1/2/3/4 | `hookFrameExit` (`scriptQueue` for CallPES) | `tests/unified_hook_drain.test.mjs`, `test_hook_windows.mjs`, `tests/anim_hook_callpes.test.mjs` |
| Cycle restarts at frame 0 after a one-shot, with leftover time | csequence-4 | `cycleRestartAfterAction` | `tests/unified_handback.test.mjs` |
| Draw/sheathe links at speed 1.0 | cmotiontable-1 | `styleLinkSpeed` | `tests/motion_link_fidelity.test.mjs` L4b |
| Link-only bake (no whole-rig geometry per link fetch; a miss no longer bakes a cycle) | cmotiontable-3 | `linkOnlyBake` | `tests/motion_link_fidelity.test.mjs` L1/L1b, Rust `link_only_bake_matches_full_bake_descriptor` |
| Retail default_style cycle fallback (71/436 retail tables use it) | cmotiontable-4 | `cycleDefaultStyle` (wasm) | holtburger-dat `cycle_for_*` |
| Jump: launch capped at 4×run_rate, refused at ≥200% load, wire burden, jump-skill augs | motioninterp-1/2/4/5 | `jumpLaunchCap`, `jumpLoadGate` | holtburger-core movement tests |
| AutonomousPosition: none airborne, window restarts on MoveToState, ack after force-position; raw TurnLeft on the wire; RawMotionState header from fields | outbound-1/2/3/4/5 | `apRetailGate`; consts `USE_RAW_TURN_LEFT_WIRE`, `USE_AP_CONTACT_PLANE_RESEND`=false | holtburger-core system tests |
| Remote MoveTo: sticky on arrival (no lunge), turn nodes complete, walk along facing with 20° aux deadband, wire speed, sticky max speed | moveto-1/2/3/5/6 | const `USE_REMOTE_MOVETO_FACING` | core/world tests, `tests/remote_moveto_sticky_arrival.test.mjs` |
| Ballistic projectiles: exact arc; stop at building/cell/static/door geometry | physupd-1/2 | `projectileEnvSweep`, `projectileExactArc` | `tests/projectile_ballistic_arc.test.mjs`, `tests/projectile_visual_fidelity.test.mjs` |
| Stat math: key-0 all-stat and attack/defense-family enchantments; InqSkill (vitae, augs, untrained min_level); vitals (vitae, GearMaxHealth); duel tiebreak; creature appraisal (Self, tints, failed view) | enchstats-1..5 | — | holtburger-world player/magic tests, `test_examine_format.mjs` |
| Transport: 140 s dead-session + stall guard; cleartext NAK never satisfies a sequence; 4096 ISAAC/reorder window; NAK hints + 0.6 s re-request; broken echo reply removed | net-1..5 | — | holtburger-session tests (43), `session_liveness` |
| Particle lifecycle: one-shots drain, cull freeze, owner handle retirement, no t=0 burst, static hook start times | plifecycle-1..5 | `oneShotDrain`, `particleCullFreeze`, `particleOwnerRetire`, `initialParticlesRetail`, `staticScriptHookTime` | `tests/particle_cull_freeze.test.mjs`, `tests/static_script_hooktime.test.mjs`, particle suites |
| Selection: retail Next/Previous Monster, radar-range + visibility filters, auto-target, range-exit drop, sphere pick, attack the wielder | selection-1..6 | `retailSelectNext`, `cycleRadarFilter`, `autoTarget`, `selectionRangeExit`, `pickSphereFallback`, `attackWielder` | `tests/auto_target.test.mjs`, `tests/pick_math.test.mjs`, `tests/target_cycle.test.cjs` |
| Items: vendor sells exactly what is staged (+ shift-drop split-then-sell); PlaceInBackpack pickups; hotbar/Use-button activation; shortcut retarget; per-item cooldowns; wear/ammo rules | items-1..6 | `retailPickup`, `hotbarActivate`, `shortcutRetarget`, `slotCooldown`, `retailAutoWear` | `tests/item_*.test.mjs`, `tests/vendor_sell_split.test.mjs`, `tests/hotbar_merge_retarget.test.mjs`, `tests/toolbar_use_activate.test.mjs` |
| Spells: hotbar armed-spell bridge fixed; formula-untargeted rings/walls/sprays; outstanding-request busy gate; retail target pre-check + messages | spellcast-1..4 | `formulaUntargeted`, `castBusyCount`, `spellTargetPrecheck`, `castUseDoneCancels` | `tests/spell_target_type.test.mjs`, `tests/cast_busy_count.test.mjs`, `tests/spell_target_compat.test.mjs` |

**Gate (2026-10-08):**
- JS: `capped-build node harness/run-js-headless.mjs --quiet` → **460/460**.
- Lints: `lint-url-flags`, `audit-flag-defaults`, `gen-client-event-kinds --check` and `gen-modulepreload --check` (355 modules) are all clean.
- Rust (`--lib`): holtburger-common 72, holtburger-protocol 393, holtburger-core 680, holtburger-world 817, holtburger-session 43,
  holtburger-dat `motion_table` 23, holtburger-wsbridge 24.
- holtburger-web `--lib`: 271 pass, plus 1 pre-existing failure (see below).
- `cargo check --target wasm32-unknown-unknown -p holtburger-web` is clean.
- Release wasm built 13:15 (6.9 MB). The previous pkg is in `pkg-prev-20261008/`.

**Pre-existing failures, not caused by this session (verified against HEAD):**
- `tests_substitution::resolve_static_placement_frame_orders` (holtburger-web `--lib`) expects 0x65 for an unknown wire placement,
  but the FU-2 split chain returns 0. The test is stale.
- `test_ac_jump_clip_plays.mjs` (NEEDS-TOOLCHAIN) is a DAT finding: no motion table has a Jump clip.
- `test_ac_locomotion_dispatch.mjs` (NEEDS-TOOLCHAIN): 4 mapped Rust test names did not exist at HEAD. The fifth was renamed by
  outbound-4 and re-pointed this session.

**Ops notes:**
- `apps/holtburger-wsbridge` changed (net-3 asks for a 2 MiB UDP receive buffer). The bridge must be rebuilt and restarted to pick
  this up. It is capped by `net.core.rmem_max` unless the host raises it.
- `data/spells-catalog.json` was regenerated (`untargeted` on 274 ids). It is fetched with `force-cache`, so use `?nosw=1` plus a
  hard reload when testing.
- `pkg/` is gitignored. Every checkout needs a release wasm build, or the wasm-side changes silently fall back. The JS guards every
  new export with `typeof`.

---

## 4. Eye-test queue (1070, off-screen; nothing here was seen this session)

Each item has an escape, so A/B it with `=off`.

1. **Hooks** (`hookFrameExit`).
   - Sounds, particles and strike events fire one frame later.
   - Footsteps fire once per loop; walk↔run swaps don't stack them.
   - Backstep, strafe-left and turn-left now make footfalls.
   - A hook authored on a segment's last frame no longer fires. That is retail, but no DAT census was done — watch for a lost effect.
2. **Cycle restart** (`cycleRestartAfterAction`): after a swing, cast or emote, the walk/run cycle restarts at frame 0, not mid-stride.
3. **Style links** (`styleLinkSpeed`): draw/sheathe while running plays at normal speed.
4. **Default-style cycles** (`cycleDefaultStyle`): creatures whose stance lacks a cycle (e.g. 78 Dead, 83 RunForward cases) now play
   the default style's cycle instead of keeping the old one.
5. **Particles.**
   - LevelUp/AttribUp fade fully past 2.5 s (`oneShotDrain`).
   - Chimney smoke and fountains are full when you look back (`particleCullFreeze`).
   - DAT emitters with initial=0 no longer drop a 6-particle clump at t=0 (`initialParticlesRetail`).
   - Static scripts with start times build up staggered (`staticScriptHookTime`).
6. **Projectiles.**
   - Bolts and arrows stop at walls, doors and dungeon geometry, and the Explode plays there (`projectileEnvSweep`).
   - Check for false stops on open ground and casting from doorways.
   - **Perf watch:** up to 5 wasm sweeps per missile substep.
   - Arcs run 0.08–0.49 m higher (`projectileExactArc`).
7. **Remote monsters.**
   - No lunge or rubber-band at chase start.
   - They walk along their facing with ≤20° error.
   - Turn-in-place completes.
   - A player's melee charge runs at 1.5×.
8. **Selection.**
   - Tab with nothing selected picks the **farthest** monster in radar range (retail `SelectNext(0,0)`, checked in the decomp); Tab
     again steps outward and wraps to the nearest.
   - Creatures with no RadarBehavior are no longer Tab-able (`cycleRadarFilter`).
   - Auto-target after a kill or when attacked (`autoTarget`).
   - A far, off-screen target is dropped.
   - Small objects are easier to click (`pickSphereFallback`).
9. **Jumps.**
   - A running diagonal jump is about 7% shorter (`jumpLaunchCap`).
   - Overloaded (≥200%) characters can't jump (`jumpLoadGate`).
   - No AutonomousPosition while airborne (`apRetailGate`); watch for server rubber-banding.
10. **HUD numbers change.**
    - JackOfAllTrades +5 on every skill.
    - Vitae lowers skills and vitals.
    - "Cloaked in Skill" and Society blessings count.
    - Untrained train-only skills drop to init+ranks.
    - Max HP gains GearMaxHealth.
    - The vitals-orb vitae band can light up.
11. **Items.**
    - Pickups merge into existing stacks and overflow to side packs.
    - Hotbar weapons and armour equip.
    - Cooldown sweeps are per item.
    - An overlapping wear is refused instead of stripping you.
    - Ammo merges.
    - Shift-drop on a vendor splits, then sells.
12. **Spells.**
    - Rings and walls cast with no selection.
    - A second spell mid-cast doesn't start a phantom windup.
    - Incompatible targets are refused with retail text (non-attackable NPCs, stacks, pets, self for creature-only "other" spells).

---

## 5. Deferred round-1 findings (verified, not implemented)

The evidence and implementation notes for each are in `round1-findings.json`.

- **Render impact (needs an eye-test):**
  - createobj-2: a re-equipped item draws without its ObjDesc.
  - createobj-3: UpdateObject is a full re-create (house hooks).
  - createobj-4: an ObjDesc that arrives while the rig is queued is dropped.
- **Large or design-first:**
  - createobj-1: in-place same-instance re-create.
  - cmotiontable-2: signed/reversed links + style-default double hop.
  - cmotiontable-5: style chain from the parsed table.
  - cmotiontable-6: local MotionTable refusal, error 67.
  - csequence-3: Rust signed node rate.
  - csequence-5: needs a census of multi-AnimData cycles.
  - plifecycle-6: wire PlayScript through the owner ScriptManager.
  - spellcast-5: personalized spell formulas; needs golden vectors from ACE.
- **Partially confirmed / needs live data:**
  - motioninterp-3: exhaustion lane.
  - motioninterp-6: SetHoldKey Run arm.
  - moveto-4: Rust→JS MoveTo phase events.
  - physupd-3: 96 m activity gate.
  - createobj-5: remaining stamp gates.
  - outbound-6: JumpPack Position block.
- **Partial:**
  - outbound-5: canonicalizing retail defaults.
  - selection-2: Escape-deselect not wired; kill-path auto-target fires at rig removal.
- **Leads, not findings:** scenery default-animation hooks other than SetOmega are never run (needs a DAT census).

---

## 6. Round 2: shipped (same pipeline, same day)

Ten more areas: camera, audio, calendar/time, chat, held-item attachment, fellowship/trade/allegiance, world-object use,
character options, death/corpses, radar. That gave 53 findings: 43 confirmed, 10 partially confirmed, 44 safe. 42 are shipped
and 2 partial. Ledger: `FINDINGS-round2.md`.

| Theme | Findings | Escape flags (default ON) |
|---|---|---|
| **Chat.**<br>• Turbine rooms use retail ids; `/a` goes to the Allegiance room.<br>• Emotes carry the actor's name.<br>• No doubled own lines; retail sentences.<br>• `@` / `:` / `;` prefixes, aliases and inline `*pose*`.<br>• `/r` only from player tells.<br>• Client-side squelch.<br>• No duplicate death broadcast for victim/killer.<br>• Retail use-failure text. | chat-1..6, death-6, use-3 (partial) | — |
| **Social.**<br>• AllegianceUpdateRequest sent; patron = monarch handled.<br>• Fellowship Open/Close (0x0291).<br>• Retail trade Decline/Clear/Failure.<br>• Fellowship Ignore/AutoAccept exclusion.<br>• Retail option defaults before PlayerDescription. | allegiance-1/2, fellowship-1, trade-1/2, charopt-1/6 | — |
| **Death.**<br>• A dead player can't move.<br>• The rig stands at the lifestone.<br>• Selection is released at the server delete.<br>• The corpse handoff never claims the player.<br>• Unopened-corpse binds. | death-1..5 | `deadInputGate`, `localDeathRevive`, `deathSelectRelease` |
| **Sky time.**<br>• The sky's time of day and DayGroup come from the server clock; the sky's look is unchanged.<br>• Calendar ported to wasm. | daytime-1/3 | `skyServerClock` |
| **Held items.**<br>• The wield ledger can't re-mount into an old hand.<br>• Pickup un-parents instead of destroying the rig.<br>• Per-child attach generation.<br>• No feet-mount fallback. | held-2/4/5/6 | `wieldLedgerAuthority`, `pickupLeaveWorld`, `attachGen`, `heldMountStrict` |
| **Camera.**<br>• Smooth, then collide.<br>• Retail 0.3 m standoff and 1.5 m pivot.<br>• Auto-follow follows in-place turns.<br>• ViewCombatTarget option.<br>• Scenery sweep export (camera-3 partial). | camera-2/4/5, charopt-2, camera-3 | `camViewerStep`, `camRetailSphere`, `autoFollowTurns`, `combatTargetView`, `camScenery` |
| **World use and items.**<br>• Stuck levers are Used, not picked up.<br>• ItemUseable=No refused locally.<br>• 0.2 s use throttle.<br>• MainPackPreferred.<br>• Drag-to-player opens a secure trade.<br>• Trade closes when the partner vanishes.<br>• No double optimistic item sounds. | use-1/2/4, charopt-3/4, trade-2, audio-1/5 | `retailUseResult`, `retailUseReject`, `retailUseThrottle`, `retailItemSounds` |
| **Radar.**<br>• RadarBehavior defaults.<br>• IsCreature from ItemType.<br>• Live PK colours.<br>• BlackFog2 blackout.<br>• No per-tick debug rebuild.<br>• Wielded-item sounds at world position. | radar-1..5, audio-2 | `radarRetailShowable`, `radarLiveFlags`, `radarBlank`, `attachedSoundPos` |

**Round-2 gate:**
- JS: 473/473; lints, event-kinds and modulepreload (360) all clean.
- Rust `--lib`: common 72, protocol 398 (+ opcode_parity 2), core 685, world 832, session 43; holtburger-web new tests 24/24.
- wasm32 check clean; release wasm built 16:14 (6.9 MB).

**Round-2 eye-test additions:**
- Sky: the sun sits about 780 s earlier than before, and the day's weather group now matches other clients (`skyServerClock`).
- Camera:
  - pulled-in camera feel near walls (`camViewerStep`, `camRetailSphere`);
  - auto-follow during turn-to-face (`autoFollowTurns`).
- Chat: own lines now come only from the server echo, and channel colours changed.
- World: levers and buttons activate on double-click.
- Held items: an archer's quiver after a pickup.
- Death: standing up at the lifestone.
- Radar: blips missing for creature-typed props with no RadarBehavior.

**Round-2 deferred:**
- Render impact:
  - held-1: child scale inheritance.
  - daytime-2: weather profile table.
  - charopt-5: vivid targeting brackets.
  - audio-4: wire PlayScripts on the owner ScriptManager, the same work as plifecycle-6.
- Needs design or a live check:
  - camera-1: in-head view vs heading.
  - camera-6: slope alignment.
  - held-3: ParentEvent/PickupEvent queue/defer.
  - audio-3: pre-create queue unification.
  - fellowship-2: retail strings with the leader's name.
- Partial:
  - camera-3: one retail viewer transit.
  - use-3: clear the ground object on move failure.
- (Retracted.) A round-2 agent reported a `character_option_mask` bit-mapping bug. I checked every CharacterOption id and every
  CharacterOptions1/2 bit against ACE's enums, and all of them match, so it was a misread.

## 6b. Follow-ups and rounds 3–4 (usage-capped: two helper agents, orchestrator verifies)

**Ops follow-ups:**
- The wsbridge was rebuilt (release) and restarted through its supervisor (pid swap at 16:30), so net-3's 2 MiB UDP receive buffer
  is live.
- `net.core.rmem_max` is 4 MiB, so no host change was needed.

**Deferred findings handled.** Escapes are `?flag=off`.

| Finding | Status | Escape | Change |
|---|---|---|---|
| createobj-5 | shipped | `lifecycleStampGates` | DeleteObject / Pickup / Parent / ObjDesc / instance stamp gates |
| outbound-5 | shipped | `rawDefaultOmission` | Retail default omission in MoveToState. Style and turn speed stay explicit; changing them needs a live soak. |
| fellowship-2 | shipped | — | Retail fellowship strings with the leader name |
| use-3 | shipped | `moveFailCloseGround` | Loot window closes on a move-failure UseDone |
| cmotiontable-5 | shipped (JS parts) | `styleChainRetail` | Hop 2 plays without hop 1; a cycle-less style change is refused. The wasm style-chain planner is still deferred with cmotiontable-2. |
| moveto-4 | shipped | `remoteMoveToPhase` | Remote animation phase from the Rust MoveToManager node, new ClientEvent kind 67 |
| held-3 | shipped | `objectBlobQueue` | Retail QueueBlobForObject for Parent/Pickup events about unknown or newer objects |
| motioninterp-6 | skipped | — | The decomp shows the SetHoldKey Run arm can't fire |

The CLI build was broken by a `Cell<u64>`-not-`Sync` error since 3d466147 (2026-07-27). The counters are now an atomic newtype, and
`cargo test -p holtburger-cli` passes.

**Round 3** (streaming/teleport, LandDefs/terrain, books/journal, crafting) and **round 4** (training, login, housing,
social lists) are in `FINDINGS-round3.md` / `FINDINGS-round4.md`. Escapes are `?flag=off`.

| Area | Shipped / partial | Escape(s) | What changed |
|---|---|---|---|
| Server confirmations | shipped | `serverConfirmUi` | Craft-chance, fellowship invite, swear, aug/skill/attribute and yes/no dialogs now exist (`plugins/server-confirm.js`). Before, only the bot could answer them. |
| Teleport hook | shipped | `teleportHook` | Autorun stops and MoveTo is cancelled when the destination pose lands |
| Water | shipped | `openSeaWall`, `fallbackWaterRetail` | Open-sea wall on all-water landblocks only; fallback water model fixed |
| Books | shipped / partial | `bookRetailPages`, `examineInscribe`, `bookRangeClose` | Editability from author / ignore-author; flush on close and page turn; inscriptions from the examine panel; range close |
| Salvage | shipped | `salvageSuitable`, `salvageResultChat` | Retail suitability gate; retail result line in chat |
| Training | shipped | `trainUnusable`, `realStatXp` | Untrained magic, Healing, Lockpick etc. can be trained; retail confirm text; raise costs from the real XP |
| Housing | shipped | `houseOwnerFromData` | 0x0248 parse fixed (1-byte timestamp); ownership from HouseData; per-house RestrictionDB + IsAllowedIn, **not wired to collision yet** |
| Social commands | shipped | `retailSocialCmds` | Retail `/friends`, `/squelch`, `/unsquelch`, `/filter`, `/unfilter`, `/messagetypes`; clear-friends 0x0025; silent friend removal |
| Login | shipped | `retailCharErrors`, `retailCharList` | Retail CharacterError text; pending-delete rows greyed and listed last; delete needs DELETE typed |
| Log-off | partial | `logOffOnUnload` | CharacterLogOff sent on page close; no in-place return to character select |
| Portal busy | partial | `portalBusy` | Combat toggle refused in portal space; uses and casts dropped |

**Deferred from rounds 3–4:**
- streaming-teleport-1: LoginComplete at the end of the tunnel fade-in. It touches the high-risk position pipeline and
  `DEFER_LOGIN_COMPLETE_AFTER_TELEPORT` stays false; needs a 1070 teleport eye-test.
- streaming-teleport-3/4 (render): reveal gate and interior streaming window.
- landdefs-terrain-2: housing barriers. The data path now exists; the collision wiring remains.
- Partials:
  - login-1: in-place return to character select.
  - books-journal-2: page-text fetch.
  - streaming-teleport-5: inventory drags in the tunnel.

**Gate for this commit:**
- JS 483 suites: 482 pass in the gate; `test_frame_split_probe.mjs` failed once under gate load and passes 5/5 standalone.
  Neither it nor `frame_split.js` changed today.
- Lints, event kinds (58) and modulepreload (364) are clean.
- Rust `--lib`: protocol 404 + opcode_parity 2, world 865, core 694, holtburger-web 301 (+1 pre-existing), CLI 359 + 16.
  Four CLI chat tests failed in one run and passed in two reruns, so they're flaky and probably share log state.
- holtburger-dat: 702 pass, plus `terrain_subdiv::…triangle_corner_ring_matches_height_sampler`, which fails before
  today too (the file is unchanged since 2026-08-03).
- wasm32 check is clean; release wasm built at 18:46 (6.94 MB).
- `cargo fmt --check` was not run: rustfmt on `src/lib.rs` needs about 4.2 GB. Run it on a bigger machine if CI enforces formatting.

**Eye-test additions:**
- Tinker with the craft-chance option on, and accept a fellowship invite.
- Portal while autorunning.
- Walk off the coast south of Holtburg, and wade a lake right after a teleport.
- Edit a library book and a book you wrote; inscribe a weapon from the examine panel.
- Train War Magic from Unusable.
- As a house owner, press Query House.
- `/squelch`, `/friends remove -all`.
- Reload while in-world, then log straight back in.
- A monster aggroed from behind: it should turn in place, then run, then go to Ready.

---

## 7. Laptop safety: what happened and the rules that follow

- **`rustfmt --check apps/holtburger-web/src/lib.rs` reached 4.2 GB RSS** (lib.rs is about 47k lines). At 12:27 earlyoom
  SIGTERMed it plus a batch of node tests; nothing froze. Treat rustfmt on lib.rs as a heavy job, and forbid it in agent prompts.
- **`pkill -f typescript-language-server` killed the orchestrator's own shell (exit 144).** The pattern matched the bash command line,
  which is the same trap as the rust-analyzer one in CLAUDE.md. Select by `comm` plus args instead:
  `ps -o pid=,comm=,args= --ppid <claude pid> | awk '$2=="node" && /typescript-language-server/'`.
- **Claude Code's TypeScript LSP (tsserver, about 0.9 GB) respawns while agents edit JS.** Stop it before each cargo or wasm-pack run
  so that ≥2.5 GB stays available.
- **On this 4-CPU box a workflow runs at most 2 agents concurrently.** Plus 1–2 background Rust edit agents, that peaked fine;
  `available` never dropped below about 1.8 GB.
- **Durations:** release wasm-pack about 6 min; full JS gate about 3.5 min; holtburger-web `--lib` native about 2–3 min warm.
- **Round 2 ran 5 agents at once** (a 2-lane JS workflow plus 3 Rust edit agents). `available` stayed at 4.3–4.8 GB, because
  agents are in-process and none ran heavy jobs.
- **One near-miss:** I relaunched a persisted workflow script by its path with placeholder args, which re-ran round 1. I stopped it
  within seconds. The compare script now takes its areas from `args`.

---

## 8. Suggested prompt to resume the remaining work

```
Resume the OpenAC / retail-decomp comparison for holtburger-web. Read
external/holtburger/apps/holtburger-web/docs/HANDOFF-openac-comparison-2026-10-08.md first (it has my
original goal verbatim in §1 — the same rules apply: code only, no visual testing, don't harm holtburger-web's
visuals, every agent must respect the 8 GB laptop limits in ~/CLAUDE.md and the §7 lessons: no rustfmt on
src/lib.rs, stop the TS language server before builds, agents never run cargo/wasm-pack/the full gate/browsers).

Rounds 1–4 and the first follow-up batches are shipped (§3, §6, §6b). Remaining work, in order:
1. Wire housing barriers (landdefs-terrain-2): the per-house RestrictionDB + IsAllowedIn now exist in
   crates/holtburger-world/src/house.rs (round-4 housing-3); connect them to the faithful outdoor/indoor
   SceneObjCell::restriction_obj + CObjCell::check_entry_restrictions (acclient.c:347102) behind an =off escape,
   with tests that a non-owner bounces and owners/guests/open houses pass.
2. Partials: login-1 (in-place return to character select + retail 3 s / 23 s PK log-off timer),
   books-journal-2 (page-text fetch), streaming-teleport-5 (inventory drags in the tunnel), camera-3 (one retail
   viewer transit), outbound-5 (omit style / 1.0 turn speed after a live soak).
3. Large design items when the owner wants them: cmotiontable-2 + the cmotiontable-5 wasm style-chain planner
   (signed/reversed links, style-default double hop), createobj-1 (in-place re-create), plifecycle-6 / audio-4
   (owner ScriptManager for wire scripts), spellcast-5 (personalized formulas; capture golden vectors from ACE),
   csequence-3 / csequence-5.
4. Another comparison round on areas not yet covered (vitals/regen display, UI layout behaviour, chargen,
   vendor buy side, containers/chests, PK/PKLite rules), compare → verify → implement.
5. End with the full gate (capped JS gate, lints, core/common/protocol/world/session/dat --lib, CLI, wasm32
   check), one release wasm build, an updated handoff + PARITY-STATUS wave, then commit and push to origin/master.
Items needing the owner's 1070 eye-test before code changes: streaming-teleport-1 (LoginComplete timing),
streaming-teleport-3/4, camera-1/6, held-1, daytime-2, charopt-5, and all createobj render items.
Keep the §4/§6/§6b eye-test queues growing. Usage: the owner caps agents — ask how many helpers are allowed
(today ended at two concurrent general-purpose helpers, no workflows) and say how many a step will use first.
```
