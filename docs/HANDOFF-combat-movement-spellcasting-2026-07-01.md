# Holtburger-web — movement/combat/spellcasting work handoff (2026-07-01)

**Purpose:** onboard an agent to the REMAINING work from the 2026-07-01 combat/movement
session: (1) movement/animation polish, (2) melee stance verification, (3) spellcasting
end-to-end. Missile combat is DONE (commit `d41d66f1`); the building/door catapult has
its own handoff (`docs/HANDOFF-door-transit-catapult-2026-07-01.md` — read it, it blocks
building-adjacent testing). Read `docs/HANDOFF-holtburger-bugfix-general-2026-06-29.md`
for build discipline; MEMORY.md for the rapidgrep index. Decomp WINS; ACE = server
reference only (we build a CLIENT); ship default-ON with `?flag=off` escapes; HUD fixes
apply direct.

All file:line anchors below were read-verified on 2026-07-01 but WILL drift — re-anchor
by symbol, not line.

---

## 0. Session state / infrastructure (as of 2026-07-01 EOD)

- **Shipped commits (master, local — NOT pushed):** `d41d66f1` (missile fix set),
  `0287828f` (fell-through failsafe + `/cmd`→`@cmd` chat routing).
- **wasm pkg/ = RELEASE build of `0287828f`** (4.5 MB — dev is ~18 MB; ALWAYS rebuild
  `--release` before shipping/measuring).
- **A Warn-level console logger now exists in the wasm** (`ConsoleWarnLogger`,
  lib.rs `start()`): `log::warn!` anywhere in the crates → `[rust-WARN] …` in the
  browser console. Use it for instrumentation; before it, log::warn was a silent no-op.
- Live stack: serve.py :8765 (`--allow-missing` — beware silent partial world),
  wsbridge :8080, vanilla ACE on this laptop (UDP 9000/9001). 1070 vistest: desktop
  shortcut "Holtburg (Chrome)", CDP :9333, serve via reverse tunnel :18765, bridge via
  tailnet `ws://<server-ip>:8080/`, account `<account>` (now **Developer**).
  `<test-account>` is also **Developer** now (was Player; elevated via ACE console FIFO
  `set-accountaccess <test-account> 4`; FIFO path in `docs/HANDOFF-door-…`/ace-live memory).
- Test char `+Tester` (`<account>`) has: Longbow+100 Arrows, Light Crossbow+100 Quarrels,
  Atlatl+100 Darts, Short Sword, 2× Long Sword, Buckler, Spadone, Quarter Staff, Wand
  (wcids 306/300/312/305/12463/12464/352/351/44/29975/338/2472; drudge target wcid 7).
- Headless harness patterns live in the session scratchpad
  (`/tmp/claude-1000/-home-wbterminal/3dcb35b7-*/scratchpad/`): `session-hold.mjs` +
  `poke.mjs` (CDP-held session), `watch-fall.mjs` (pose timeline watcher),
  `grant-gear.mjs`, `summon-tester.mjs` (GM `@teletome` rescue — the ONLY rescue that
  works on an airborne-wedged player). playwright-core at
  `~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`; chromium at
  `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`. Single-login per
  account: ~40-50 s cooldown or "Account In Use" boots BOTH.
- **Known infra traps hit today:** `getLocalPlayerPose()` can freeze/not adopt server
  teleports (see door handoff §0.3); ACE `@teleloc` z-arg works but client may not
  adopt; bootState 'error' at 90 s scene-ready timeout is survivable if
  `__sessionHandle` exists; `grep -c`-style checks — the wasm-identifier redaction
  (`ln`) hits Bash STDOUT on some sources, use Read tool for those files.
- **Pre-existing test failures (NOT ours):** 10 failures in
  `holtburger-core client::movement::system::tests` on clean master (list in the git
  log of `d41d66f1`). holtburger-world lib is green (507).

---

## TASK A — movement/animation polish (task #1, audit DONE, fixes pending)

Full audit findings (2026-07-01 explorer, read-verified). The system is mostly correct:
- Input: W/S fwd, A/D strafe, Q/E turn, Shift=walk (run default), keydown/keyup at
  index.html:6003/6143 (+blur clear :6219). Axes computed at index.html:8393/8530;
  diagonals send BOTH axes (wasm `motion_state_for_input` lib.rs:32043+).
- Wire: input edges → `SetMovementInput` arm (lib.rs:42946) → `PlayerDriveIntent`;
  `TickMovement` (lib.rs:42987) pumps `MovementSystemHandle::tick` → MoveToState on
  motion edges + AutonomousPosition heartbeats. Outgoing stance =
  `world.player.last_server_motion_style` (PreserveServer,
  movement/common.rs:83-104) — updated by `apply_self_update_motion`
  (player/mutations.rs:293+; autonomous echoes bypass the seq gate).
- Anim rates: `cycleTimeScale` (animation.js:355) clamps [0.25,4.0]; speed from wasm
  `stateGroundSpeed` (run_rate baked in — JS must NOT re-multiply); per-entity run
  rates (remote rigs use their own `_runRate`). CORRECT per audit.
- Jump: retail-matched charge (1000 ms full hold, index.html:5810),
  `compute_jump_velocity_z` (types.rs:1725) = burden/skill formula, g=−9.8 2nd-order
  integration (system.rs:3783+ — now also hosts the fell-through failsafe). Jump clip
  0x2500003B is ABSENT from all 436 retail MTs → arms-up pose overlay + mixer pause IS
  retail-correct (user ruling on record: do NOT "fix"). Facing can turn mid-air
  (Q/E exempt from contact gate), trajectory locked — retail-correct.

**Open fix items (small, ordered):**
1. **E/Q turn-sign mismatch (VERIFY FIRST on 1070):** JS 2D predictor treats E → heading
   increase (index.html:8422-8428) while wasm `motion_state_for_input` maps turn>0 (E) →
   `turn_left()` (lib.rs:32088-32091 "Q/E sign fix" comment). Eye-test whether E turns
   the same way in 2D-fallback vs 3D/wasm; fix whichever side disagrees with retail
   (retail: E = turn RIGHT/clockwise).
2. **Stale JS fallback constant:** `FALLBACK_RUN_RATE_SCALAR = 4.5` in index.html:5202
   vs wasm 1.0 (lib.rs:31850, deliberate — 4.5 caused over-run sawtooth). Align JS to
   1.0 (it's only a fallback but documented as a divergence source at
   index.html:8434-8442).
3. **Diagonal local-prediction mismatch:** JS 2D predictor is single-axis (forward
   priority, index.html:8430) while the wire sends both axes → diagonals mispredict
   until reconciliation. Fix = compose both axes in the predictor (normalize to retail
   diagonal speed — retail does NOT speed-boost diagonals).
4. **Flag promotions pending 1070 eye-test:** `?jumpParity`, `?longJump`,
   `?retailRunKeys`, `?inputFunnel` all default-OFF (index.html:5838, input.js:20-24).
   Eye-test then flip default-on per the promotion rule.
5. Dead code rip-out: `build_raw_motion_state_for_input` (lib.rs:32098,
   `#[allow(dead_code)]`, obsolete single-axis shape).

---

## TASK B — melee stance verification (task #2, likely mostly WORKS)

Audit conclusion: the client carries the FULL retail MotionStance table
(index.html:2645-2663 — matches ACE MotionStance.cs exactly incl. Atlatl 0x13b,
ThrownShield 0x13c, *NoAmmo 0xe8/0xe9) and is fully server-authoritative: ACE derives
stance from equipment (`GetCombatStance`, Creature_Combat.cs:265 — caster > weapon >
dual-wield override > shield add) and broadcasts UpdateMotion kind=5 →
`applyConfirmedStance` (index.html:2724, local-player branch :3924) + rig pose via
`setLocalStance` (:3933). Combat toggle = backtick (index.html:6084) → wasm arm
lib.rs:~40420 (`get_suggested_combat_mode` context.rs:719 + NEW ammo guard).

**What was NOT verified yet (needs the 1070 eye-test — checklist given to the user):**
per-stance combat-idle POSE correctness for: sword / sword+shield / dual wield /
two-handed (Spadone) / staff (should be TwoHandedSword stance 0x44 per ACE's
"TwoHandedStaffCombat doesn't appear to do anything" note) / unarmed; swing anims per
stance×height×type via CombatManeuverTable (`ui/ac_combat_maneuver.js`; ranged stances
have ZERO CMT rows in retail — aim-level path instead, that's correct).
Weapon-type inference: `ui/ac_attack_type_for_weapon.js` (Unarmed→Punch/Kick at high
power per Player_Melee.cs:462, melee→Slash — widening to Thrust/Backhand per weapon
`W_ATTACK_TYPE` bits is a known TODO). Dual-wield detection: entities.js:5353
(`isDualWield`, mirrors ACE GetDualWieldWeapon — offhand in SHIELD slot).
**Also to verify:** the NEW auto-unequip (d41d66f1) across armor slots (it fires on
same-slot intersection for clothing too — make sure equipping a coat over a smock
behaves; conflict rules in lib.rs WieldFromPack arm).

**Missile leftovers (task #3 shipped, two loose ends):**
- In-flight arrow/bolt visual: wire-side projectile ObjectCreates arrive and despawn
  correctly, but they were never observed as render entities headless — confirm on the
  1070 whether the arrow renders; if not, the spawn path drops short-lived MISSILE
  physics-state entities (`isProjectile` entities.js:5447, `_ballistic` :3703).
- Thrown weapons (atlatl kit granted) + `UseFastMissiles` wire option (client mirror
  exists, wire send is a Wave 11+ TODO, picking.js ~:1090 comment).
- Alchemy throwing phials: NO implementation anywhere (grep alchem|phial = nothing).
  Retail: phials are ThrownWeapon-skill items; ACE supports them as thrown weapons.
  Needs: weenie coverage test once thrown weapons verified.

---

## TASK C — spellcasting end-to-end (task #4, the BIG one — mostly wiring, not greenfield)

2026-07-01 explorer conclusion (read-verified): the stack is ~80% built. What EXISTS:
- **C2S casts:** `SessionHandle.castTargetedSpell(guid, spellId)` /
  `castUntargetedSpell(spellId)` (lib.rs:29386/29408 → recv arms :40503-40556 →
  `GameAction::CastTargetedSpell` 0x004A / `CastUntargetedSpell` 0x0048; codecs
  protocol/messages/magic/actions.rs with ACE fixture parity tests). Wire format
  matches Chorizite `LayeredSpellId` (u16 id + u16 layer; our plain u32 is
  byte-identical for layer==0 — fine for player casts).
- **S2C:** MagicUpdateSpell 0x02C1 (spellbook append, lib.rs:38933),
  enchantment update/remove/purge/dispel (0x02C2-0x02C8), WeenieError 0x028A(+String
  0x028B) incl. fizzle codes; PlayScript 0xF755 → `scene3d/play_effect_vfx.js`
  (Launch/Explode/Fizzle marked critical; ~122 script IDs still TODO-log).
- **Spellbook data:** PlayerDescription carries `spells: BTreeMap<u32,f32>` +
  `hotbar_spells: Vec<Vec<u32>>` (8 hotbars) + filters
  (protocol/messages/player/events.rs:95-576); merged snapshot via
  `playerKnownSpells()` (lib.rs:27538/32560).
- **Spell catalog:** `getSpellRecord(id)` (lib.rs:26870) → name/school/casterEffect/
  targetEffect/fizzleEffect/isFastCast…; DAT parser
  holtburger-dat/src/file_type/spell_table.rs (SpellBase incl. encrypted components +
  `decrypt_components()`; school enum 1=War 2=Life 3=Item 4=Creature 5=Void);
  SpellComponentsTable parser exists.
- **HUD:** `plugins/spellbook.js` (F5) already has the **7-tab × 8-slot** spell bar
  scaffold (`SPELL_BAR_TABS`/`SPELL_BAR_SLOTS`, :15/:54/:108/:412-451/:913-919,
  localStorage persistence :310-382; `?retailParity=1` strips the non-retail tab
  chrome). `plugins/combat-bar.js` holds `armedSpellId`/`spellBarSlots` (:78-120) and
  casts via `castSpellViaHandle` (`ui/ac_cast_spell.js` — falls back to untargeted when
  no target). `plugins/spell-research-panel.js` = known-spells browser.
  `scene3d/picking.js:712-784` = click-to-cast targeted path (magic stance only).
  `plugins/stance-toggle.js` merged into combat-bar; magic stance low16 = 0x0049.
- **Cast gestures:** `scene3d/entities.js:6125-6289` (`playCastSequence`/`playGesture`)
  driven by `ui/ac_spell_cast_sequence.js` + `data/spell-cast-sequence.json`
  (windup gestures + cast gesture per spell formula).

**ACE server gates (Player_Magic.cs — what the client must satisfy):**
CombatMode==Magic FIRST (:86/:277 → else `YoureTooBusy` + server self-corrects stance);
not in air (:107); target acquired (:135); components `YouDontHaveAllTheComponents`
(:404, burned via TryBurnComponents :866); range `MissileOutOfRange`/`YouHaveMovedTooFar`
(:504/:876 — this is the "casting circle": move too far mid-windup → fizzle);
indoor/outdoor spell restrictions (:513/:521); mana `YouDontHaveEnoughManaToCast`
(:583); fizzle → `PlayScript.Fizzle` broadcast + `YourSpellFizzled` (:879/:917).
CastSpeed 2.0 (:603); windup gestures from `spell.Formula.WindupGestures` in Magic
stance (:623-645). Magic mode needs an equipped caster (`GetEquippedWand`,
HandleSwitchToMagicCombatMode returns 0 if none — same silent-bounce SHAPE as the
missile ammo bug: **add the same local pre-check**, `is_wielding_caster()` already
exists in context.rs:735). Casters can't be held with a shield (CheckWeaponCollision —
our NEW auto-unequip already pulls the shield when wielding a caster).

**Ordered work plan:**
1. **Live baseline (headless):** equip Wand (`+Tester` has one; `<test-account>` can
   `@ci 2472`), toggle → verify Magic stance 0x49 confirms; learn a spell
   (`@addspell <id>`? check ACE handler — or grant scroll; spell 1 = Strength Other I
   per spells.json; Developer has `@learnspells`?); `castUntargetedSpell` on a
   self-buff; watch: windup motions (kind=5 Magic stance gestures), UpdateMana,
   enchantment event, PlayScript effects, chat spell words. THEN castTargetedSpell at
   a drudge (War bolt — needs Void/War spell known + components or
   `spell_components_required=false` server property — CHECK
   `ace-server PropertyManager` defaults; if components enforced, grant scarabs/herbs
   or set the server bool via console FIFO `modifybool spell_components_required false`
   — it's a live-server toggle, not an ACE source edit).
2. **Local pre-checks + feedback (Rust):** caster-equipped guard on Magic toggle
   (mirror missile ammo guard, same toast pattern); surface the cast WeenieErrors
   (fizzle/mana/components/range) via the kind:13 + transient-toast path (verify
   `weenie_error_messages.js` covers codes: YourSpellFizzled 0x04D2? — check
   `$ENUM/WeenieError.cs`).
3. **HUD completion (JS):** keyboard cycling for the 7 tabs (user asked explicitly —
   retail used F5-F12-ish bindings? verify in decomp/acpedia; wire into
   `plugins/spellbook.js` tab state + combat-bar sync); drag spells from spellbook →
   bar slots already scaffolded — verify e2e; show mana cost + mana-conversion skill
   effect on the tooltip (ManaConversion halves effective cost — ACE
   `GetManaCost`, Creature_Magic.cs — display only, server computes).
4. **Casting movement/animation:** retail: casting roots the player during windup
   (MoveToState suppressed? verify — ACE `YouHaveMovedTooFar` implies you CAN move and
   it fizzles); strafe/walk in Magic stance uses the Magic stance locomotion cycles
   (MotionTable stance 0x49 rows) — verify `classifyMotionCommandTyped` resolves them;
   remote casters play windup gestures (entities.js:6193-6238 fallback retired —
   verify non-local rigs animate).
5. **VFX:** confirm spell-specific caster/target/fizzle PlayScript DIDs route into
   play_effect_vfx (only ~critical IDs guaranteed today; the TODO-log list at
   play_effect_vfx.js:55 names what's missing).
6. **1070 eye-test batch at the end:** stance pose, windup gestures, bolt flight
   (SpellProjectile = same MISSILE physics-state path as arrows), fizzle burst,
   self-buff glow.

**Spell/school data for tests:** LSD spells.json (`spell-by-id` recipe in MEMORY §3);
schools: War/Life/Creature/Item/Void (+ ManaConversion affects cost & comp burn).
Wands/orbs/staffs all ItemType Caster (`DefaultCombatStyle == Magic`); "magic casting
staff" ≠ melee Quarter Staff (different weenies).

---

## Suggested order of attack

1. Task C step 1-2 (spellcasting live baseline + guards) — biggest user-visible win,
   and the missile-fix patterns (guard + toast + verify) map 1:1.
2. Task A items 1-3 (small movement fixes) while spellcasting eye-test batches queue.
3. Task B + remaining eye-tests as ONE 1070 batch (stances + arrows + spell VFX),
   per the batched-eye-test rule.
4. The door-transit root cause (separate handoff) whenever a deep-focus block is
   available — it blocks indoor content testing.
