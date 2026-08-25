# Spellcasting end-to-end — SHIPPED (2026-07-01 late session)

**Scope:** Task C of `HANDOFF-combat-movement-spellcasting-2026-07-01.md` — spellcasting
end-to-end, sole focus. All items below were **live-verified headless** against the
laptop ACE stack (serve.py :8765 + wsbridge :8080 + vanilla ACE UDP 9000/9001,
account `<test-account>`, wand wcid 2472, drudge wcid 7). Anchors read-verified today;
re-anchor by symbol.

## What was broken → fixed (all live-verified)

1. **Cast-gesture chain was dead in the browser** — `ui/ac_spell_cast_sequence.js`
   `_loadSequenceAsync` cached the RAW generator JSON, but entries live under
   `.sequences` → every `getCastSequence()` lookup missed → `playCastSequence`
   silently no-oped (its vibe-pose fallback was retired 2026-06-18, so casts showed
   NOTHING locally). Fix: unwrap `table.sequences ?? table` in both loaders.
   Verified: local rig plays `MagicPowerUp04` (0x10000072) windup then
   `MagicRecoilMissile` (0x40000033) at CastSpeed-2.0 pacing for Lightning Bolt III;
   `MagicSelfHeart` for Heal Self I.

2. **Fizzle never surfaced (and F8-2 cancel could never fire)** — ACE reports the
   fizzle via `SendWeenieError(YourSpellFizzled)` (0x028A), NOT via UseDone. Our
   0x028A arm only made a kind=2 SYSTEM chat line with the raw Debug label
   (`YourSpellFizzled`), so index.html's F8-2 hook (kind:13 + errCode 0x0402 →
   `cancelCastSequence`) was unreachable. Fix (src/lib.rs): new
   `spellcast_error_text(code)` map (retail strings verified verbatim in the decomp);
   the WeenieError arm now ALSO pushes kind:13 + a TRANSIENT retail-text chat line
   for the spell-cast subset; the UseDone(error) arm upgrades its `[Use failed] X`
   system line to the same retail text/TRANSIENT for those codes. Codes covered:
   0x0400 components / 0x0401 mana / 0x0402 fizzled / 0x0407-0x0408 outside-inside /
   0x0498 moved-too-far / 0x0550 out-of-range / 0x04EB in-air. Same texts added to
   `plugins/weenie_error_messages.js` (keep the two maps in sync).
   Verified: forced fizzle (Void→War cross-school lockout inside the 3-5 s window,
   two drudges) → kind:13 `YourSpellFizzled code=1026` + chat "Your spell fizzled."
   + Fizzle PlayScript 0x51 resolving on the caster (PES 0x33000103, speed 0.5).

3. **Magic combat-mode silent bounce** — ACE `HandleSwitchToMagicCombatMode` returns
   0 with no stance motion / no client update when `GetEquippedWand()` is null (the
   CombatMode property half-flips server-side). Fix: caster pre-check in the
   `SetCombatMode` arm (src/lib.rs, mirrors the missile ammo guard):
   `mode == Magic && !is_wielding_caster()` → refuse locally + transient toast
   "You must wield a wand, orb, or staff to enter magic combat mode!". The
   ToggleCombatMode arm needs no guard (get_suggested_combat_mode only proposes
   Magic when a caster is wielded). Verified: unwield → setCombatMode(8) → blocked
   + message; wield → toggle → server-confirmed stance 0x49.

4. **Self-buff TargetEffect glow never played (ACE quirk)** — the UNTARGETED opcode
   (0x0048) threads `target = null` from `CreatePlayerSpell(uint)` →
   `SetCastParams(..., null, ...)` → `DoSpellEffects`'s `target != null` gate in
   `WorldObject_Magic.cs:361`, so the enchantment lands (HandleCastSpell retargets
   IsSelfTargeted to `this`) but the 0xF755 TargetEffect script is never broadcast.
   Retail cast self-spells TARGETED at the player's own object (ACE
   `TargetCategory.Self`). Fix: `selfTargetGuidFor(spellId)` in
   `ui/ac_cast_spell.js` (reads `getSpellRecord` flags — note: serde-wasm-bindgen
   returns a **Map**, not a plain object) + promotion in `plugins/api.js castSpell`
   and the `castSpellViaHandle` fallback: SelfTargeted spells with a null target go
   out as `castTargetedSpell(ownGuid, id)`; genuinely untargeted spells keep 0x0048.
   Verified: buff glow `scriptId=0x6` resolves on the player
   (table 0x34000004, PES 0x33000046, speed = formulaScale 0.05).

## New feature: spell-bar keyboard cycling (user-requested)

`plugins/combat-bar.js` `installSpellBarHotkeys()` (module-load, like the
auto-disarm hooks). Retail model verified in the decomp —
`ClientCombatSystem::HandleMagicAction` (acclient.c ~407451) dispatches input
actions 0x10000063/64 (Prev/NextSpellTab), 0x10000104 (FirstSpellTab), plus spell
selection cycling + CastCurrentSpell; retail shipped them user-bindable. Our
defaults, scoped to magic stance (0x49) exactly like retail, ignored while typing:
- `[` / `]` — prev / next spell tab (wraps across the 7 tabs)
- `{` / `}` (Shift) — first / last tab
- `1`..`8` — fire the Nth slot of the active tab: untargeted → cast, targeted →
  arm/disarm. Panel open → dispatches the real row click (identical behavior);
  panel closed → storage-level cast/arm via `holtburger_combat_bar_v1`.
All verified headless (synthesized KeyboardEvents), including the NonCombat gating.

## Tooltips

- combat-bar spell rows now show `— N mana` (DAT baseMana via the catalog) plus
  `(Mana Conversion may reduce)` when the skill is Trained+ and the spell doesn't
  carry `IgnoresManaConversion` (ACE rolls the reduction per cast —
  `Creature_Magic.cs GetManaCost` — so no fake exact number). skills[] layout =
  `[id, current, base, trained_state, xp] × N`, ManaConversion id 16, Trained ≥ 2.
- spellbook detail popover gets the same note.
Verified: "Strength Self I (Self) — 15 mana" on the live row.

## Verified-working (baseline, no changes needed)

- C2S casts (0x004A/0x0048), Magic stance via toggle, `@addspell` learning,
  spellbook append → `playerKnownSpells`.
- Spell words in chat via HearSpeech/Spellcasting → CHAT_CATEGORY_MAGIC
  ("Malar Cazael", "Zojak Quasith").
- Targeted bolts (war + void, tiers 1/3/6): SpellProjectile entity spawn,
  Launch (0x4) + Explode (0x5) through the real PhysicsScriptTable path
  (incl. queued-before-spawn), kill messages, UseDone.
- Components gate (`require_spell_comps`, re-enabled/disabled via ACE console FIFO
  `modifybool`): UseDone(0x0400) → kind:13 + now-retail text.
- Enchantment registry + buffs HUD (Strength Self I landed, 1800 s, category 1).
- Magic-stance locomotion: walked in stance 0x49 with zero cycle misses; the
  `test_ac_cast_over_locomotion.mjs` suite (5 green with cargo on PATH) confirms
  the MT data shape (Magic WalkForward 0x0300076F + 15 distinct cast modifiers).
- Drag-and-drop spellbook → bar slot with a real DataTransfer
  (`application/x-hb-spell-id`) → slot persisted.
- Cross-school lockout chat ("The Nether energies permeating your blood…").

## ⚠ Live-server state changed (deliberate, easily reverted)

`require_spell_comps` is currently **false** on the live ACE (set via the console
FIFO per the work-plan; retail default is true). This lets anyone cast known
spells with just the wand — right for demo/testing. To restore retail behavior:
`echo 'modifybool require_spell_comps true' > <ace_stdin.fifo>` (FIFO path:
`readlink /proc/$(pgrep -f ACE.Server.dll)/fd/0`). The components ERROR path was
verified with it re-enabled ("You don't have all the components for this spell.").
`<test-account>` also gained: Wand (wielded), spells 1/2/6/75/77/80/5349 in the
spellbook.

## Known caveats / notes for the next session

- **Buffing monsters on a non-PK server**: user flagged (correctly) that ACE may
  refuse/limit beneficial casts on monsters for anti-griefing. My
  Strength-Other-at-drudge cast was ONLY the isolation probe for the 0xF755
  broadcast difference (2 kind-30 events arrived); whether the enchantment actually
  registers on a monster was NOT verified and doesn't matter for the shipped fixes.
- `getSpellRecord` returns a serde-wasm-bindgen **Map** — `spellbook.js
  spellRecordFromWasm` reads `raw.name` etc. as if it were a plain object, so the
  Wave F.1 wasm-preferred hybrid catalog silently falls back to the LSD JSON
  everywhere it "works". Nothing user-visible today (JSON has the same fields), but
  wasm-only fields (flags, casterEffect…) DON'T flow through the hybrid. My
  `selfTargetGuidFor` handles the Map shape directly. Worth a small F.1 follow-up.
- ACE `FastTick == IsPKType` → NPK players use the non-FastTick windup path, and the
  moved-too-far windup cap only applies to PKs (`PlayerKillerStatus != NPK`), so
  casting-while-moving does NOT fizzle for our NPK test chars — server-authoritative,
  nothing to do client-side.
- First cast after a page load can skip the local gesture chain (the sequence JSON
  fetch is kicked by that first call — pre-existing lazy-load race, benign).
- Pre-existing: 10 failures in `holtburger-core client::movement::system::tests`
  on clean master (unrelated); `test_ac_cast_over_locomotion.mjs` needs
  `~/.cargo/bin` on PATH (shells out to a cargo example).

## 1070 eye-test batch (queued — all default-ON, no flags needed)

One session, per the batched-eye-test rule. In magic stance with the wand:
1. Windup + cast gestures on the LOCAL rig (Lightning Bolt III = one PowerUp04
   windup then recoil; Heal Self I = SelfHeart) — pacing should match the ~2×
   server cast (CastSpeed).
2. Self-buff glow on cast completion (Strength Self I — scriptId 6 burst on self).
3. Bolt flight visual + Explode burst on the target (SpellProjectile rides the
   missile physics-state path — same open question as arrows: confirm the
   projectile RENDERS in flight).
4. Fizzle burst (gray puff) + "Your spell fizzled." transient — easiest repro:
   Void cast then War cast within ~3 s (two live targets).
5. Spell-bar keys: `[`/`]`/`{`/`}` tab cycling with the combat panel open (tab
   highlight follows), digits 1-8 cast/arm.
6. Remote-caster windups: second account casting in view — remote rig should play
   the same PowerUp/cast clips via the wire motion path (code-verified via
   creature motions; needs the visual).
7. Tooltip spot-check: hover a bar row → "— N mana".
