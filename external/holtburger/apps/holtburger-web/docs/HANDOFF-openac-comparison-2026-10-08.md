# HANDOFF — OpenAC / retail-decomp comparison, round 1 shipped (2026-10-08)

A code-only session. Parallel agents each took a piece of OpenAC (`external/OpenAC`, C#), compared it with the
matching holtburger-web code and with the retail decomp (`~/ac-headers/acclient.c`, the authority), and
proposed changes. A second agent then tried to refute every finding before anything was implemented.
Code commit: `0680b84b`. **There was no visual testing.** Every change that is visible in-game ships default-on with an `?flag=off`
escape and is listed in §4 for a later 1070 eye-test.

- Findings ledger (74 findings: status, escape flag, note): `docs/openac-comparison-2026-10-08/FINDINGS-round1.md`.
- Full evidence per finding (decomp / OpenAC / holtburger citations, proposed change, verifier corrections and
  implementation notes): `docs/openac-comparison-2026-10-08/round1-findings.json`.
- Round 2 (10 more areas) was still running at commit time: `docs/openac-comparison-2026-10-08/round2-unverified-snapshot.json` (§6).
- Status ledger: `docs/PARITY-STATUS.json` wave 4.

---

## 1. The owner's prompt (verbatim)

The session goal, set with `/goal`:

> we are working on holtburger-web, which is visually superior to openac, but there are likely many areas where holtburger-web can be improved by contrasting holtburger-web's code with the decomp. each agent should find a piece of openac code and compare it with corresponding code in holtburger-web and see if the holtburger-web can be improved by the observations. i will be observing closely and will tell you when the goal is complete. don't harm the visuals of holtburger-web. this is a code only session with no visual testing. each agent needs to be aware of the limitations of the laptop you are on and must not cause it to go out of memory.

Later in the session:

> yes wrap up whenever you are done round 1 then commit and push to origin/master. make a handoff before pushing that contains my initial prompt to you and your suggested prompt to resume the remaining work

> dont stop the currenr work tho

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

## 6. Round 2 (in flight at commit time)

Ten more areas: camera, audio, calendar/time, chat, held-item attachment, fellowship/trade/allegiance, world-object use,
character options, death/corpses, radar. At commit time 9 of 10 compare agents had returned 47 findings. These are **UNVERIFIED**:
the adversarial verify pass had not run. Snapshot: `round2-unverified-snapshot.json`.

Notable claims to verify first:
- chat-1: Turbine channel commands send to the wrong room (off-by-one).
- chat-3: your own chat appears twice.
- use-1: double-clicking a Stuck lever tries a pickup.
- trade-1: Decline / ClearTradeAcceptance / TradeFailure handled alike.
- allegiance-1: AllegianceUpdateRequest never sent.
- held-1: held items inherit the wielder's scale.
- camera-1: first person is decoupled from the character.
- daytime-1: sky time runs on a private 1999 wall clock.

If this session continues, round 2 is verified and implemented the same way and a follow-up commit updates this file.

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

---

## 8. Suggested prompt to resume the remaining work

```
Resume the OpenAC / retail-decomp comparison for holtburger-web. Read
external/holtburger/apps/holtburger-web/docs/HANDOFF-openac-comparison-2026-10-08.md first (it has my
original goal verbatim in §1 — the same rules apply: code only, no visual testing, don't harm holtburger-web's
visuals, every agent must respect the 8 GB laptop limits in ~/CLAUDE.md and the §7 lessons: no rustfmt on
src/lib.rs, stop the TS language server before builds, agents never run cargo/wasm-pack/the full gate/browsers).

Remaining work, in order:
1. Round 2: adversarially verify the 47 unverified findings in
   docs/openac-comparison-2026-10-08/round2-unverified-snapshot.json (plus run the missing area if one is absent),
   re-reading every decomp/OpenAC/holtburger citation; then implement the confirmed ones whose visual impact is
   none/behaviour, in file-disjoint lanes with targeted tests, default-on with =off escapes per the owner flag
   policy. Rust: agents edit only; the orchestrator compiles/tests each cluster under capped-build, one heavy job
   at a time. Write FINDINGS-round2.md like FINDINGS-round1.md.
2. Pick up the deferred round-1 findings from §5 that are safe without an eye-test (createobj-5, motioninterp-6,
   moveto-4, cmotiontable-5, outbound-5 canonicalization), verifying each against acclient.c first.
3. Run one more comparison round on areas not yet covered (e.g. streaming/residency correctness vs OpenAC
   App/Streaming, portal space/teleport, LandDefs/terrain sampling, books/contracts/quests, vitals/regen, UI
   layout behaviour), same compare → verify → implement pipeline.
4. End with the full gate (capped JS gate, lints, core/common/protocol/world/session --lib, wasm32 check), one
   release wasm build, an updated handoff + PARITY-STATUS wave, then commit and push to origin/master.
Keep the §4 eye-test queue growing for the owner's next 1070 session.
```
