# WS15 — War + Void End-to-End Gameplay Matrix (DoTs, streaks, school feel)

Packet author: WS15 deep investigator, buildbox, 2026-07-12.
Baseline: `external/holtburger` (foundation doc @ `6fcff2f0`). Every cite below was
opened live this session; DAT claims are grounded in the WB.Terminal oracle; ACE claims
in `external/ACE/Source` (partial checkout — see caveat in §1.4). Ground-truth sources
cross-checked three ways (LSD dump ↔ DAT oracle ↔ ACE ↔ our JS/Rust) wherever possible.

**Scope reminder (foundation §preamble):** this is an *improvement* pass on a hard-won
working system. The single most load-bearing finding in this packet is a **guardrail, not a
bug** (tier-I bolts authentically have no arm-raise — §2.A). Do not "fix" authentic feel away.

---

## 0. TL;DR — the ranked punch list

| # | Sev | Symptom / gap | Root cause (proven) | Owner | Fix |
|---|-----|---------------|---------------------|-------|-----|
| P1 | med | Void DoT debuff renders as **"+19 id 330"** in buffs-HUD (illegible; "+" misreads as a buff) | `formatStatMod` has no name for PropertyInt 330/318; DoT value is a positive per-tick number (`buffs-hud.js:213-236`, empirically `"+19 id 330"`) | **WS15 (self, UNOWNED)** | Full patch §3-A (UI-only) |
| P2 | low | Void/Life DoT **misclassified as a buff** in the spell-record-less fallback (pre-login) | positive DoT tick value trips the additive-sign heuristic → `"buff"` (`buffs-hud.js:196-203`, empirically `classify→"buff"`) | **WS15 (self, UNOWNED)** | Full patch §3-A (UI-only) |
| P3 | low | kind=46 `count` field is always 0 (dead value) | JS reads `evt.u32Payload_2` (underscore); wasm getter is `u32Payload2` (`index.html:7633`) | **WS15 (self, UNOWNED)** | Full patch §3-B (1 char) |
| P4 | med | **War/void damage numbers never reach the combat feed or last-hit HUD** — chat-log only | ACE sends magic damage as `GameMessageSystemChat`→kind=2, NOT `AttackerNotification`→kind=19; combat-bar feed & combat-hud listen only to kind=19 (and combat-hud hard-gates melee/missile) | **WS14 ui-feedback** | Proposal + flag §3-C |
| P5 | info | Caster gets **no per-tick DoT feedback** if `show_dot_messages`=false on the live server | ACE gates the caster's DoT chat on `PropertyManager.GetBool("show_dot_messages")` (`Monster_Combat.cs:333`) | **config / laptop** | Verify §4 recipe |
| P6 | info | "arms not always rising" for cheap test bolts is **AUTHENTIC** (tier-I = Lead scarab = Invalid gesture) | `gen-spell-cast-sequence.cjs:294-313` leadOnly ⇒ empty windups; DAT confirms Lead scarab gesture=Invalid | **guardrail — WS01 windup-link** | Do NOT change |
| P7 | med | S1 "arms not rising" for spells that *should* windup is a **runtime** miss, not data | player MT `0x09000001` HAS every magic gesture incl. colored band `0x1000012B-0x10000134` (0x128/0x129/0x12A absent under this link) under `links[0x490003]` (DAT-verified) → any miss is stance/lookup at `entities.js:2277` | **WS01 windup-link-reliability** | Out-of-charter; evidence handed off §2.A |
| P8 | low | Void DoT projectile (wcid 43344) vs direct Nether Bolt (43230) differ only by Setup DID (…129 vs …128) + their own PhysicsScriptTable | projectile visual comes from the weenie's own Setup+PScriptTable via ObjectCreate+PlayScript(Launch/Explode), not caster PScripts (all Invalid) | **WS10 projectiles / WS09 vfx-effects** | Eye-test §5 |

---

## 1. THE WAR + VOID SPELL MATRIX (data catalog)

### 1.1 School + SpellType ground truth (LSD `spells.json` ↔ DAT oracle `0x0E00000E`)

- **War = school 1** (691 spells), **Void = school 5** (76 spells). DAT oracle confirms
  `"school":"WarMagic"` / `"VoidMagic"` for the ids below.
- `meta_spell.sp_type` (ACE `SpellType`): **2 = Projectile** (direct damage, no
  enchantment), **15 = EnchantmentProjectile** (projectile that also lands a duration
  enchantment = the DoT), **1 = Enchantment** (pure debuff curse, no projectile).

### 1.2 War archetype table (school 1, sp_type 2)

`etype` (DamageType bitfield): 1 Slash · 2 Pierce · 4 Bludgeon · 8 Cold · 16 Fire · 32 Acid · 64 Electric.
`caster_effect`/`target_effect`/`fizzle_effect` are **0/Invalid for every war+void projectile**
(DAT-verified for 27/115/1796/2739/3806/3654/5349/5357/5361 — see §2.B). The projectile
visual is the weenie's own Setup+PhysicsScriptTable (Launch/Explode), NOT a caster PScript.

| Archetype | Shape | rep id | rep name | mana | proj wcid | nPj | spread° | cast gesture (client seq) |
|-----------|-------|--------|----------|------|-----------|-----|---------|---------------------------|
| Bolt | single homing | **27** | Flame Bolt I | 5 | 1499 | 1 | 0 | MagicRecoilMissile `0x40000033` |
| Stream | fast bolt | 58 | Acid Stream I | 5 | 1633 | 1 | 0 | MagicRecoilMissile |
| Wave | bludgeon bolt | 64 | Shock Wave I | 5 | 1634 | 1 | 0 | MagicRecoilMissile |
| Whirling Blade | slash bolt | 92 | Whirling Blade I | 5 | 1636 | 1 | 0 | MagicRecoilMissile |
| Arc | tracking wide | **2739** | Flame Arc I | 5 | 20974 | 1 | 0 | MagicRecoilMissile |
| Streak | very fast (fastCast) | **1796** | Flame Streak I | 10 | 7263 | 1 | 0 | MagicRecoilMissile |
| Volley | 3 projectiles | **3654** | Acid Volley I | 5 | 1633 | 3 | 0 | MagicRecoilMissile |
| Blast | cone | **115** | Flame Blast III | 15 | — | ~9 | ~90 | MagicBlast `0x4000002B` |
| Ring | 9 proj, 360° PBAoE | **3806** | Flame Ring | 80 | 7270 | 9 | 360 | MagicVision `0x40000036` (+2× MagicPowerUp04 windups) |

All 7 elements exist for Arc/Streak/Blast/Volley; Bolt covers Fire/Cold/Electric/Force,
with Acid=Stream, Bludgeon=Wave, Slash=Whirling Blade. Tiers I–VI (VII for Arc).

### 1.3 Void matrix (school 5)

Void damage projectiles all use **etype 1024 (Nether)** + one of five projectile weenies:
**43230** Nether Bolt/Blast · **43231** Nether Streak · **43232** Nether Arc · **43233**
Clouded Soul (ring) · **43344** Corrosion/Corruption DoT.

**Direct-damage void (sp_type 2)** — behaves like war at the wire (DamageTarget, no enchant):

| Family | shape | rep id | name | mana | wcid |
|--------|-------|--------|------|------|------|
| Nether Bolt | single | **5349** | Nether Bolt I | 5 | 43230 |
| Nether Streak | fast | **5357** | Nether Streak I | 10 | 43231 |
| Nether Arc | tracking | 5362 | Nether Arc I | 5 | 43232 |
| Nether Blast | **cone** | 5544 | Nether Blast IV | 20 | 43230 |
| **Clouded Soul** | **ring 360°** | **5361** | Clouded Soul | 80 | 43233 |

> **There is NO spell literally named "Nether Ring."** The only 360° void ring is
> **Clouded Soul (5361)** (9 proj @ 360°, wcid 43233). "Nether Blast" is the *cone*
> (90–135°). Use Clouded Soul as the "Nether ring" stand-in in the live matrix.

**Void DoT (sp_type 15 = EnchantmentProjectile)** — projectile wcid 43344, lands a Nether DoT:

| Spell | ids (I→VII) | shape | mana | duration | smod.key | tick val I→VII |
|-------|-------------|-------|------|----------|----------|----------------|
| **Corrosion** | 5387–5393 | single | 5–35 | 15s | **330 NetherOverTime** | 19,29,38,48,51,72,90 |
| **Corruption** | 5395–5401 | 3–5 cone | 10–70 | 30s | **330 NetherOverTime** | 8,12,18,22,29,33,42 |

**Void curses (sp_type 1, pure debuff, no projectile):**

| Family | rep id | mana | dur | target_effect (PScript) | smod.key |
|--------|--------|------|-----|-------------------------|----------|
| **Destructive Curse** | **5339** | 10 | 30s | **HealthDownVoid (0xA7)** | 330 NetherOverTime |
| Festering Curse | 5371 | 10 | 30s | 168 | 317 (heal-resist) |
| Weakening Curse | 5379 | 10 | 15s | 169 | 316 (dmg-reduction) |

> **CONFIRMED (DAT + LSD):** void DoTs tick as **NetherOverTime (PropertyInt 330)**,
> never regular DamageOverTime (318). The LSD `smod.type=36868 (0x9004 =
> INT|SINGLE_STAT|ADDITIVE)` is the *enchantment-type flag* (constant across all
> enchantments); the actual modified PropertyInt is **`smod.key=330`**. This is the hook
> the HUD can use to identify a void DoT (patch §3-A).

### 1.4 The DoT wire trace (ACE → client) — CONFIRMED

> **ACE checkout caveat:** the provided `external/ACE/Source` is partial (WorldObjects /
> Physics / Entity only). GameMessage/GameEvent class bodies and the opcode enums are
> absent; cites below are *construction/enqueue sites*, which is enough to prove the flow.

**A DoT does NOT send a per-tick network message.** It lands once, then the ~5s server
heartbeat applies HP deltas:

1. **Landing (projectile hit):** `SpellProjectile.OnCollideObject` branches on
   `MetaSpellType == EnchantmentProjectile` → `CreateEnchantment(...)`
   (`SpellProjectile.cs:311-321`). For a **player** target this sends
   **`GameEventMagicUpdateEnchantment`** (`WorldObject_Magic.cs:451`,
   `new Enchantment(playerTarget, addResult.Enchantment)`) carrying spell id, layer,
   duration, StatMod (key=330). WAR projectiles take the `else DamageTarget(...)` branch —
   **no enchantment message**. This is the one wire difference between war and void.
2. **Each heartbeat:** `WorldObject_Tick.cs:98-101` → `EnchantmentManager.HeartBeat`
   (`EnchantmentManager.cs:1218-1228`) → `HeartBeat_DamageOverTime` sorts by
   `StatModKey==NetherOverTime` into `netherDots` → `ApplyDamageTick(netherDots,
   DamageType.Nether)` (`EnchantmentManager.cs:1234-1263`). Per tick:
   - Victim **player**: `Player_Combat.cs:411-462` → `UpdateVitalDelta(Health,…)` which
     (via `Player_Vitals.cs:130-139`) enqueues **`GameMessagePrivateUpdateAttribute2ndLevel`**
     (health bar) + **`GameMessageSystemChat`** "You receive N points of periodic nether
     damage." (`:437-440`, `ChatMessageType.Magic`) + broadcast
     **`GameMessageScript(PlayScript.HealthDownVoid=0xA7)`** splatter (`:445`).
   - Victim **monster**: `Monster_Combat.cs:307-326` → silent vital delta + broadcast
     `GameMessageScript(HealthDownVoid)` splatter. The *caster's* view of that monster's
     health comes from **`GameEventUpdateHealth`** on the caster's own heartbeat while the
     monster is selected (`Player_Vitals.cs:164-173`) — decoupled from the tick.
   - Caster notification: `Monster_Combat.cs:331-368` — **only a `GameMessageSystemChat`**
     "You corrode X for N points of periodic nether damage!", **gated on
     `PropertyManager.GetBool("show_dot_messages")`** (`:333-334`). *[P5 — default unknown
     from this checkout; verify on live server, §4.]*
3. **Expiry:** `EnchantmentManager.Remove` sends **`GameEventMagicRemoveEnchantment`**
   (`:328`, spell id + layer) + a `SpellExpire` sound.

**War projectile damage** (`SpellProjectile.DamageTarget`, `SpellProjectile.cs:687-863`):
damage number to caster via **`GameMessageSystemChat`** (`:824`) and to victim via
`GameMessageSystemChat` (`:840`) — **NOT** `GameEventAttackerNotification`/`DefenderNotification`
(those are the physical-combat path only, `Player_Combat.cs:163/542`). Health via
`GameMessagePrivateUpdateAttribute2ndLevel` (victim) / `GameEventUpdateHealth` (caster).

**Full targeted cast wire order (caster):** HearSpeech (words) → N× UpdateMotion `0xF74C`
(windups, `EnqueueMotionMagic` `WorldObject_Networking.cs:1078`) → UpdateMotion `0xF74C`
(cast gesture) → **CasterEffect PlayScript `0xF755`** *only if* `spell.CasterEffect !=
Invalid* (`WorldObject_Magic.cs:358-359` — **skipped for war/void projectiles, all Invalid**)
→ projectile ObjectCreate → PlayScript `0xF755` **Launch (0x04)** (`WorldObject_Magic.cs:1833`)
→ on impact: PlayScript **Explode (0x05)** (`SpellProjectile.cs:230`) + VectorUpdate + (war)
DamageTarget / (void) CreateEnchantment + **TargetEffect PlayScript** *if != Invalid* → damage
`GameMessageSystemChat` + health. Fizzle: PlayScript **Fizzle (0x51)** (`Player_Magic.cs:879`).
Cast close: `SendUseDoneEvent` (`Player_Magic.cs:964`). Opcodes 0xF74C/0xF755 confirmed via
`PacketOpCodeNames.cs:529/536`; PlayScript ids via `PlayScript.cs:9/10/86/172`.

### 1.5 The client message → HUD trace (what we DO with each) — CONFIRMED

Protocol layer parses **all 8** enchantment ops (`opcodes.rs:751-767`:
MagicUpdateEnchantment `0x02C2`, RemoveEnchantment `0x02C3`, UpdateMultiple `0x02C4`,
RemoveMultiple `0x02C5`, Purge `0x02C6`, PurgeBad `0x0312`, Dispel `0x02C7`,
DispelMultiple `0x02C8`) into a full `Enchantment` struct incl. `stat_mod_key`
(`magic/types.rs:6-38`). **Nothing is dropped.** Two re-emit paths:

- **Self** target → world crate applies → `WorldEvent::PlayerEnchantmentsUpdated` → lib.rs
  fires **kind=8 PLAYER_STATS_UPDATED** (`lib.rs:38557`) + **kind=58 SHARED_COOLDOWNS**;
  JS reads `handle.playerEnchantments()` (`lib.rs:30150`, exposes `stat_mod_key/type/value,
  duration, start_time, degrade_*`).
- **Remote** target → lib.rs pre-route hook maintains `entity_enchantments_index` →
  **kind=46 ENTITY_ENCHANTMENTS_UPDATED** (`lib.rs:38610`, `u32_payload=guid`,
  `u32_payload_2=count`); JS reads `handle.entityEnchantments(guid)` (`lib.rs:30197`).

| wire | lib.rs kind | JS handler | HUD result |
|------|-------------|-----------|------------|
| enchantment (self) | 8 | `index.html:7194` `renderVitalsPanel`+bus | buffs-hud self debuff icon (red) — DoT shows here **but labeled "+19 id 330"** (P1) |
| enchantment (remote) | 46 | `index.html:7610` bus `entityEnchantmentsUpdated` | buffs-hud per-target + nameplate `-N` count chip (`nameplate_sprite.js:860`) |
| UpdateHealth `0x01C0` (creature) | 54 | `index.html:7780` bus `entityHealthUpdated` | **target-bar** health bar — drops per DoT tick **only if that creature is the selected target** (`target-bar.js:728-749`) |
| self vital `0x02E7-9` | 42/43/44 | `index.html:7535` bus `vitalChanged*` | vitals-hud bar; **flashes red per tick** when own HP drains (`vitals-hud.js:266-271`) |
| magic damage text | 2 (CHAT) | `index.html:6969` `appendChatLine(text, cat)` | chat-panel color-coded (combat `#ff6a4a`, magic `#c060ff`) — **the only place war/void damage numbers appear** |
| AttackerNotification `0x01B1` (physical only) | 19 COMBAT_EVENT | `index.html:8514` bus `damageDealt` | combat-bar feed + combat-hud last-hit — **magic never reaches here** (P4) |
| PlayScript `0xF755` | 30 PLAY_EFFECT | `index.html:7371` bus `playEffect` | play_effect_vfx.js: Launch→blue burst, Explode→orange, Fizzle→gray, **HealthDownVoid(0xA7)→dim-red burst** (`play_effect_vfx.js:2125-2133`) |

---

## 2. VERIFIED FINDINGS & ROOT CAUSES

### 2.A — "Arms not always rising" (S1): DATA IS COMPLETE; tier-I is authentic

**FINDING (confirmed, DAT oracle):** player MotionTable `0x09000001` contains **every**
magic gesture used by the war+void matrix under the single link
`links[0x490003]` = (Magic stance low16 `0x0049`, Ready `0x0003`) — matching foundation
§1.3 exactly. Verified present: MagicPowerUp02/04/06/08/10, the **colored band
`0x1000012B`–`0x10000134`** (incl. `0x10000132` MagicPowerUp08Purple; `0x10000128`/`0x129`/
`0x12A` are NOT under this link — DAT-oracle-verified 2026-07-12), and cast substates
MagicRecoilMissile `0x40000033`, MagicBlast `0x4000002B`, MagicVision `0x40000036`,
MagicHarm `0x40000030`, MagicPray, MagicBonus. **So "arms not rising" is never a
missing-MotionTable-link problem.**

**ROOT CAUSE of the *authentic* case (P6 — guardrail):** the client cast-sequence data
(`data/spell-cast-sequence.json`) has **empty `windupGestures` for tier-I bolts**
(Flame Bolt I 27, Nether Bolt I 5349, Corrosion I 5387, Nether Streak I 1796): `leadOnly:true`,
cast=MagicRecoilMissile, scale 0.05. This is **correct** — `gen-spell-cast-sequence.cjs:294-296`
sets `leadOnly` when the only scarab is Lead (id 1), and the Lead scarab's component gesture
is **Invalid** (`:306` skips it), mirroring ACE `SpellFormula`. In retail, tier-I spells
(Lead scarab only) genuinely showed **no** power-up arm-raise — just the quick release.
⇒ **A war/void mage spamming cheap tier-I test bolts SHOULD see almost no arm motion.**
This is the prime false-positive for S1: do not add windups to tier-I spells.

**ROOT CAUSE of the *real* case (P7):** spells with a real scarab (tier III+, e.g. Flame
Blast III 115 → MagicPowerUp04 windup; Flame Ring 3806 → 2× MagicPowerUp04; higher void
tiers → colored `0x10000132`) DO carry windups. If *those* fail to animate, it is a
**runtime** miss in the local prediction lookup — the `setSwingMotion` silent-no-op lattice
(`entities.js:2277` requires truthy stance; `source==="wasm-link"` + `resolvedCommand!=0`).
Since the DAT link exists, the suspects are: (a) `inst.currentStance` falsy at cast time,
(b) `lookupMotionLinkForSwing` not resolving the full 32-bit colored command, (c) cold
`animationCache` fetch outliving a short windup sleep. **Out of WS15 charter** (animation
WS owns the fix) — handed off with the narrowing that *data is not the problem*.

### 2.B — War/void projectiles carry NO caster/target PScript (school feel via projectile weenie)

**FINDING (confirmed, DAT oracle `0x0E00000E`):** for 27/115/1796/2739/3806/3654/5349/5357/5361,
`casterEffect=Invalid, targetEffect=Invalid, fizzleEffect=Invalid`. The DAT projectile
weenies (`weenieType 33`) carry the visual instead: Nether Bolt 43230 Setup DID
`33561128`; Corrosion/Corruption DoT 43344 Setup DID `33561129` (different model), each
with its own PhysicsScriptTable (DID key 22 = `0x34…`) supplying Launch/Explode. ⇒ **war/void
"school feel" at cast/impact rides entirely on (1) the UpdateMotion cast gesture and (2) the
projectile weenie's own Setup + Launch/Explode PlayScripts** — there is no caster-body glow
PScript to render. (Contrast: the pure void *curse* Destructive Curse 5339 DOES set
`targetEffect=HealthDownVoid`.) Confirms our kind=30 PlayScript path (`play_effect_vfx.js`)
is the correct and only channel for projectile-spell VFX.

### 2.C — DoT legibility (P1/P2): PROVEN with a live import

Empirically ran the real `formatStatMod`/`classifyEnchantment` exports (node, buffs-hud.js)
against a synthetic Corrosion-I wire enchantment `{statModType:0x9004, statModKey:330,
statModValue:19}`:

```
Corrosion I  formatStatMod -> "+19 id 330"      ← illegible; "+" misreads as a buff
Surge(DoT)   formatStatMod -> "+12 id 318"
STR buff     formatStatMod -> "+10 STR"          ← control, correct
Corrosion classify -> "buff"                     ← WRONG in the record-less fallback
```

- **P1 root cause:** `formatStatMod` (`buffs-hud.js:213-236`) resolves the stat name only
  for ATTRIBUTE/SECOND_ATT/SKILL type bits; PropertyInt 330/318 hit none → `name = "id 330"`.
  The DoT `statModValue` is a positive per-tick amount, so ADDITIVE formatting prepends "+".
- **P2 root cause:** `classifyEnchantment` (`buffs-hud.js:182-206`) — with the wasm spell
  record present (live client) Corrosion classifies correctly as **debuff** via
  `isBeneficial=false`; but the **fallback** (pre-login catalog, or any spell whose record
  lookup misses) reaches the additive-sign heuristic (`:198-200`) and returns **"buff"**
  because the DoT value is `+19`. DoT PropertyInts (318/330) are unconditionally debuffs.

### 2.D — kind=46 count dead value (P3): PROVEN

`index.html:7633` reads `evt.u32Payload_2` (underscore). The wasm-bindgen getter is
`u32Payload2` (`pkg-web/holtburger_web.d.ts:641 readonly u32Payload2`), fed by
`lib.rs:38610` `u32_payload_2: Some(count)`. `evt.u32Payload_2` is `undefined` ⇒ `count`
always `0`. Only actual-code occurrence (grep across index.html/plugins/scene3d/ui — 7717/7730
are prose comments). **Benign today** (sole consumer `buffs-hud.js:913` re-pulls the full
snapshot and only needs `guid`), but it is dead code that silently breaks the documented
kind=46 payload contract for any future consumer.

### 2.E — War/void damage numbers are chat-only (P4): CONFIRMED cross-source

ACE emits magic damage as `GameMessageSystemChat` (`SpellProjectile.cs:824/840`), which
lib.rs surfaces as **kind=2 CHAT** (magic/combat category), rendered in the chat-panel.
The structured **kind=19 COMBAT_EVENT** is only emitted from `AttackerNotification 0x01B1` /
`DefenderNotification 0x01B2` (`lib.rs:41834-41946`) — the **physical** combat path. The
combat-bar feed subscribes only to kind=19-derived `damageDealt`/`damageTaken`
(`combat-bar.js:2352-2355`), and combat-hud's last-hit additionally hard-gates
`stanceIsMeleeOrMissile()` (`combat-hud.js:633`, with an explicit comment at `:620-624`
that magic "flows through a different ACE event family"). ⇒ **A war/void mage gets zero
damage feedback in the combat feed or last-hit HUD — only chat lines + the target health
bar (selected target) + splatter VFX.** There are also no floating damage numbers anywhere.
This is *authentic* to retail (magic damage was chat-text) but is an asymmetric school-feel
gap vs melee/missile, which get the richer HUD.

---

## 3. PATCH PLAN

Per foundation §4 rule 3, **HUD/UI-only fixes skip flags**. Patches A & B are pure UI/HUD
(no movement/render/physics), so no URL flag. Patch C changes a HUD feed and involves
fragile string parsing, so it ships **default-OFF behind a flag** with a url-flags row.
**None require a wasm rebuild** (all JS). Flag-off / unpatched arm is byte-identical.

### 3-A — Void DoT legibility + fallback misclassification (P1 + P2) — `plugins/buffs-hud.js`

DoT PropertyInts: `NetherOverTime = 330`, `DamageOverTime = 318`.

**Hunk 1 — `classifyEnchantment` (guard the sign-heuristic fallback).** Insert after the
spell-record check (current lines 187-191), before the BENEFICIAL fallback (current 193-194):

```diff
   // Authoritative signal: the spell record's own IsBeneficial bit.
   const record = ench?.spellId != null ? spellRecord(ench.spellId) : null;
   if (record && typeof record.isBeneficial === "boolean") {
     return record.isBeneficial ? "buff" : "debuff";
   }
 
+  // WS15 (2026-07-12): DoT PropertyInts (NetherOverTime 330 / DamageOverTime
+  // 318) are always debuffs. Their positive per-tick "value" would otherwise
+  // trip the additive-sign heuristic below into a false "buff" whenever the
+  // spell record is unavailable (pre-login catalog / record-lookup miss).
+  const dotKey = (ench?.statKey ?? ench?.statModKey ?? 0) | 0;
+  if (dotKey === 330 || dotKey === 318) return "debuff";
+
   // Fallback: enchantment wire flag (unreliable on some older spells).
   if ((type & ETF.BENEFICIAL) !== 0) return "buff";
```

**Hunk 2 — `formatStatMod` (label the DoT instead of "+19 id 330").** Insert after the
`(type, key, val)` extraction (current lines 215-217), before the stat-name lookup (218-224):

```diff
 export function formatStatMod(ench) {
   if (!ench) return "";
   const type = (ench.type ?? ench.statModType ?? 0) | 0;
   const key = (ench.statKey ?? ench.statModKey ?? 0) | 0;
   const val = Number(ench.statValue ?? ench.statModValue ?? 0);
 
+  // WS15 (2026-07-12): void/life damage-over-time enchantments modify the
+  // NetherOverTime (330) / DamageOverTime (318) PropertyInts. The stat
+  // "value" is damage-per-tick, not a stat delta — render a DoT label
+  // instead of the misleading "+N id 330" (the "+" reads as a buff).
+  const DOT_KEY_NAME = { 318: "DoT", 330: "Nether DoT" };
+  if (DOT_KEY_NAME[key]) {
+    const perTick = Math.abs(Math.round(val));
+    return perTick > 0 ? `${perTick}/tick ${DOT_KEY_NAME[key]}` : DOT_KEY_NAME[key];
+  }
+
   // Stat-name lookup keyed by the type flags.
   let name = null;
   if ((type & ETF.ATTRIBUTE) !== 0) name = ATTRIBUTE_NAME[key];
```

Result: Corrosion I renders **"19/tick Nether DoT"** as a red debuff cell (was "+19 id 330";
was a green buff in the record-less fallback).

### 3-B — kind=46 count dead value (P3) — `index.html:7633`

```diff
                 if (window.__pluginClient?.events) {
                   const guid = (evt.u32Payload ?? 0) >>> 0;
-                  const count = (evt.u32Payload_2 ?? 0) >>> 0;
+                  const count = (evt.u32Payload2 ?? 0) >>> 0;
                   if (guid !== 0) {
                     window.__pluginClient.events.emit("entityEnchantmentsUpdated", {
                       guid,
                       count,
                     });
```

### 3-C — Route magic damage into the combat feed (P4) — PROPOSAL, flag `?magicCombatFeed` (default OFF)

**Not a drop-in patch** — magic damage has no structured kind=19 source; it arrives as a
localized chat string ("You blast X for N points with Flame Bolt I"). Two implementation
options, both for the HUD/combat WS:

- **(preferred, robust)** lib.rs: when re-emitting the magic-category `GameMessageSystemChat`
  (the caster/defender damage lines), *additionally* emit a lightweight synthetic
  kind=19-style `COMBAT_EVENT {type:"damageDealt"|"damageTaken", damageType:"magic",
  spellName, damage}` parsed from the structured `SpellProjectile.DamageTarget` fields that
  ACE already formats. Requires locating where lib.rs stringifies these — safer than JS
  regex. Needs wasm rebuild.
- **(cheap, fragile)** JS: a `?magicCombatFeed=on` subscriber that regex-parses the
  magic-category chat line into a `damageDealt`/`damageTaken` bus event so the existing
  combat-bar feed renders it. Locale-dependent; default OFF.

**url-flags.md row (draft):**

```
| magicCombatFeed | off | Surface war/void spell damage numbers in the combat-bar feed
  (parsed from magic-category damage chat). Default OFF — retail showed magic damage in
  chat only; combat-feed is melee/missile-authentic. Test: cast Flame Bolt I at a mob with
  ?magicCombatFeed=on → feed shows "→ <mob> N Fire"; with =off → feed unchanged (chat only).
  Owner: HUD/combat WS. |
```

Recommend WS15 *not* implement C unilaterally (touches lib.rs + combat-bar, owned elsewhere);
filed here as the actionable design with evidence.

---

## 4. TESTS

### 4.1 New node unit test (add: `apps/holtburger-web/test_dot_enchantment_label.mjs`)

Validates patch 3-A. Modeled on `test_remote_buffs.mjs`'s import pattern (verified to run on
this box: node v20.20.2). Pure JS, no wasm/3D.

```js
// WS15 (2026-07-12) — void/life DoT enchantment labeling + classification.
// Run: cd apps/holtburger-web/ && node test_dot_enchantment_label.mjs
// Guards patch 3-A (buffs-hud.js formatStatMod + classifyEnchantment DoT keys).
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal DOM stub so buffs-hud.js imports headless.
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {},
    addEventListener() {}, remove() {}, children: [], classList: { add() {}, remove() {} } }),
  addEventListener() {}, body: { appendChild() {} },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const buffs = resolve(__dirname, "plugins/buffs-hud.js");
const { formatStatMod, classifyEnchantment } = await import(pathToFileURL(buffs).href);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// Corrosion I: NetherOverTime(330), +19/tick, enchant-type flag 0x9004.
const corrosion = { spellId: 5387, statModType: 0x9004, statModKey: 330, statModValue: 19 };
// Life DoT (Surge of Affliction): DamageOverTime(318).
const surge = { spellId: 0, statModType: 0x9004, statModKey: 318, statModValue: 12 };
// Control: a real STR buff must be untouched.
const strBuff = { spellId: 1, statModType: 0x2009001, statModKey: 1, statModValue: 10 };

console.log("[1] formatStatMod labels DoTs");
eq("Corrosion → 19/tick Nether DoT", formatStatMod(corrosion), "19/tick Nether DoT");
eq("Surge → 12/tick DoT",            formatStatMod(surge),     "12/tick DoT");
eq("STR buff unchanged",             formatStatMod(strBuff),   "+10 STR");

console.log("[2] classifyEnchantment: DoT is a debuff even without a spell record");
eq("Corrosion (330) → debuff", classifyEnchantment(corrosion), "debuff");
eq("Surge (318) → debuff",     classifyEnchantment(surge),     "debuff");

console.log(`\n=== DoT label — ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
```

Pre-patch, this test FAILS (`formatStatMod`→"+19 id 330", `classify`→"buff") — proving it
guards the fix. Post-patch it passes.

### 4.2 TODO-FOR-LAPTOP — headless validation recipe (no live server on this box)

Serve + headless bot per foundation §5. After spawn + provision (§4.3 script), drive from the
JS console / agent and assert:

- **DoT label:** cast Corrosion I (5387) at a mob, then
  `handle.entityEnchantments(<mobGuid>).find(e=>e.statModKey===330)` is present; render the
  buffs-hud and assert the debuff cell text contains `"Nether DoT"` (not `"id 330"`), and the
  nameplate chip shows `-1`.
- **kind=46 count:** subscribe `entityEnchantmentsUpdated` and assert the payload `count`
  equals `handle.entityEnchantments(guid).length` (was always 0 pre-patch 3-B).
- **DoT tick visibility:** watch `__diag` / bus for kind=54 (`entityHealthUpdated`) ticks on
  the selected mob every ~5s while the DoT is active, and (self-DoT via Destructive Curse on
  self if PK) kind=42 red flashes on the vitals-hud health bar.

### 4.3 TODO-FOR-LAPTOP — the definitive war+void live matrix script

> Commands assume vanilla ACE admin verbs; **verify against `ACE.Server.Command`
> handlers on the laptop** (the buildbox ACE checkout omits the Commands dir). In-client
> injection: `window.__sessionHandle.sendChat("<cmd>")`.

```js
// live_war_void_matrix.mjs — run in the in-world JS console (or agent bot).
// Provisions a war+void test char, casts the full archetype matrix, asserts per-cast.
const H = window.__sessionHandle, D = window.__diag;
const say = (c) => H.sendChat(c);

// --- 1. Provision (admin) ---
say("/god");                 // max attributes/skills/vitals (verify verb: AdminCommands)
say("/addallspells");        // learn every spell incl. war+void (verify: /learnallspells)
// If void isn't trained by /god: ensure VoidMagic skill trained, else void casts fizzle.
say("/create 10");           // spawn a Mite Scamp (wcid 10) as a soft DoT target
// Alternatively teleport to a training-dummy POI: say("@telepoi list"); say("@teleloc <loc>");

// --- 2. The matrix: [spellId, name, expectEnchant?] ---
const MATRIX = [
  [27,   "Flame Bolt I (war bolt)",        false],
  [75,   "Lightning Bolt I (war bolt)",    false],
  [86,   "Force Bolt I (war bolt)",        false],
  [2739, "Flame Arc I (war arc)",          false],
  [1796, "Flame Streak I (war streak)",    false],
  [3654, "Acid Volley I (war volley)",     false],
  [115,  "Flame Blast III (war cone)",     false],
  [3806, "Flame Ring (war ring 360°)",     false],
  [5349, "Nether Bolt I (void bolt)",      false],
  [5357, "Nether Streak I (void streak)",  false],
  [5361, "Clouded Soul (void ring 360°)",  false],
  [5387, "Corrosion I (void DoT 15s)",     true],   // NetherOverTime 330
  [5395, "Corruption I (void DoT 30s)",    true],   // NetherOverTime 330, cone
  [5339, "Destructive Curse I (void curse)", true], // pure debuff, targetEffect HealthDownVoid
];

// --- 3. Per-cast assertions ---
async function runCast([id, name, expectEnchant]) {
  const target = D.combat?.selectedGuid ?? /* the spawned mob guid */ 0;
  const rec = H.getSpellRecord(id);
  console.assert(rec, `${name}: getSpellRecord(${id}) present`);
  const before = H.entityEnchantments(target).length;
  H.castTargetedSpell(target, id);
  await new Promise(r => setTimeout(r, 4000)); // windup+cast+travel
  // (a) cast gesture fired: expect a kind=8/KIND_MOTION_ACTion cast on local rig (see __diag.motion)
  // (b) projectile: expect a PlayEffect Launch(0x04) then Explode(0x05) (kind=30) — watch bus
  // (c) damage: expect a magic-category chat line "you ... for N points with <name>"
  // (d) void DoT: enchantment count rose + persists
  if (expectEnchant) {
    const after = H.entityEnchantments(target);
    console.assert(after.length > before, `${name}: DoT/curse enchantment landed`);
    const dot = after.find(e => e.statModKey === 330);
    if (id !== 5339) console.assert(dot, `${name}: NetherOverTime(330) layer present`);
    // (e) tick: selected-target health bar drops every ~5s → watch kind=54 for 15-30s
  }
  console.log(`[cast] ${name} — check __diag.wire.summary() for 0xF74C motion + 0xF755 scripts`);
}

(async () => { for (const row of MATRIX) { await runCast(row); } })();
```

**Manual eye checks to log per cast:** (1) arms rise for Blast/Ring (windup) but NOT for
tier-I bolts (authentic — §2.A); (2) projectile model matches school (nether = dark, war =
elemental color); (3) Explode burst on impact; (4) void DoT: dim-red HealthDownVoid splatter
recurs each tick; (5) buffs-hud shows the void DoT as a red "N/tick Nether DoT" debuff (post
patch 3-A). Also on the live server: confirm `show_dot_messages` (P5) —
`SELECT * FROM ace_shard_config` or admin `/config show_dot_messages` — determines whether
the caster sees per-tick DoT chat at all.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do not run here)

| # | Flag combo | Spell | Expected visual |
|---|-----------|-------|-----------------|
| E1 | bare default | Flame Bolt I (27) at mob | brief cast recoil (NO arm-raise — authentic tier-I), orange projectile, orange Explode burst; damage in chat only |
| E2 | bare default | Flame Ring (3806) self-center | 2× MagicPowerUp04 arm-raise windup, then 9 projectiles fan 360° |
| E3 | bare default | Corrosion I (5387) at mob | dark nether projectile (Setup 33561129), impact enchant, then dim-red HealthDownVoid splatter recurring ~5s for 15s; target health bar ticks down (selected) |
| E4 | bare default | Destructive Curse I (5339) at mob | no projectile; HealthDownVoid target effect on land; red "Nether DoT" debuff on nameplate `-1` |
| E5 | after patch 3-A | Corrosion I self-buff panel | buffs-hud debuff cell reads "19/tick Nether DoT" (red), not "+19 id 330" |
| E6 | `?magicCombatFeed=on` (if C landed) | Flame Bolt I | combat-bar feed line "→ <mob> N Fire"; =off → feed empty, chat only |
| E7 | higher-tier void (Corrosion VII 5393 / a colored-powerup spell) | verify colored `0x10000132` windup arm-raise actually plays (S1/P7 runtime check) |

---

## 6. RISKS + WORKSTREAM INTERACTIONS

**Files WS15 would touch (for integration ordering):**
- `plugins/buffs-hud.js` — patch 3-A (`formatStatMod`, `classifyEnchantment`). Shared with
  any WS touching buff/debuff HUD. Additive only; low conflict risk.
- `index.html` — patch 3-B (line 7633, 1 char). `index.html` is a hot integration file
  (movement/anim WSs edit the ClientEvent drain nearby ~7194-8177). **Order 3-B late** to
  avoid churn; it is an isolated 1-line change with no semantic overlap.
- **NEW** `test_dot_enchantment_label.mjs` — no conflict.
- **NOT touched by WS15:** `lib.rs`/`combat-bar.js` (patch 3-C is a *proposal* for the
  HUD/combat WS, not applied here).

**Interactions / dependencies (sibling packets confirm the WS map):**
- **WS01 windup-link-reliability (S1/P6/P7):** WS15 hands off proven evidence that the
  player MotionTable data is complete (colored band present) and that tier-I windup-absence
  is authentic (Lead scarab = Invalid gesture — a guardrail against over-correction). Their
  runtime stance/lookup fix is independent of WS15's HUD patches — no ordering constraint.
- **WS10 projectiles / WS09 vfx-effects (P8):** own verifying the void DoT projectile
  (43344, Setup 33561129) resolves its PhysicsScriptTable Explode and that the nether-DoT
  model loads distinctly from the direct Nether Bolt (43230, Setup 33561128). WS15 reads /
  asserts only; no code overlap.
- **WS14 ui-feedback (P4/3-C, and coordinate on 3-A):** owns the magic-combat-feed decision
  + any lib.rs damage synthesis behind `?magicCombatFeed`. **Coordinate:** WS15's patch 3-A
  also edits `plugins/buffs-hud.js` (a UI-feedback surface) — the two edits are in different
  functions (`formatStatMod`/`classifyEnchantment` vs feed/last-hit), so they compose, but
  integration should land them together and run both packets' node tests. If WS14 prefers to
  absorb 3-A into its lane, WS15's diffs + test drop in unchanged.
- **WS08 cast-lifecycle / server config (P5):** `show_dot_messages` and
  `spellcast_recoil_queue` (foundation §4b) are live-server config; WS15 flags P5 for
  laptop verification only — no code.

**Risks:**
- Patch 3-A changes debuff *label text* and *fallback classification* — a plugin/test that
  string-matched the old "id 330" label or expected DoTs as "buff" in the fallback would
  break. Grep found no such consumer (`formatStatMod` output is display-only; classify
  fallback only reached pre-login). Low risk; new test guards it.
- Patch 3-B could in theory expose a real non-zero `count` to a future consumer that assumed
  0 — but the only current consumer ignores `count`. No behavior change today.
- No wasm rebuild; no default movement/render/physics change; flag-off/unpatched arm
  byte-identical (3-C is the only flagged item and ships default-OFF).

**Confidence:** high on the static matrix, wire trace, and P1/P2/P3/P6 (proven by DAT +
live import + code cites). Medium on P4/P5 live behavior (server not reachable from this box;
recipes provided). P7 runtime is out-of-charter (evidence handed off, not fixed).

---

## VERDICT (WS15-verify)

**Verifier:** adversarial reviewer, buildbox, 2026-07-12. Posture: skeptical. Every
load-bearing cite below was opened live; DAT claims re-run through the WB.Terminal oracle;
the applied patches were executed against the current tree (`6fcff2f0`, clean).

### Verdict: **CONFIRMED — apply the two implemented patches (3-A, 3-B).**

The two changes WS15 actually applies (3-A buffs-hud + 3-B index.html:7633) are correct,
minimal, reversible, and now empirically validated end-to-end. One DAT-grounded evidence
claim (§2.A band range) is overstated and should be corrected in-text, but it does not
change any conclusion or block the patches.

### What I re-verified (independently, this session)

**Tree state.** `git rev-parse HEAD` = `6fcff2f0…` — matches foundation baseline; working
tree clean (only the untracked docs/AGENT scratch files). Both patch hunks match the live
file context character-for-character.

**P1 / P2 (patch 3-A) — PROVEN by live execution, not just by reading.**
- ETF math from the *real* `ui/enchantment_constants.js`: `ADDITIVE=0x8000`,
  `SINGLE_STAT=0x1000`, `INT=0x4`, `BENEFICIAL=0x2000000`. LSD `smod.type=0x9004` =
  `INT|SINGLE_STAT|ADDITIVE`, **BENEFICIAL unset** — so `classifyEnchantment`'s
  record-less fallback reaches the ADDITIVE sign-heuristic with `val=+19 ≥ 0` ⇒ `"buff"`,
  and `formatStatMod` finds no ATTRIBUTE/SECOND_ATT/SKILL name ⇒ `"id 330"` ⇒ `"+19 id 330"`.
- Ran the packet's own inputs against the **current unpatched** `buffs-hud.js`:
  `formatStatMod(corrosion) → "+19 id 330"`, `formatStatMod(surge) → "+12 id 318"`,
  `formatStatMod(strBuff) → "+10 STR"`, `classify(corrosion) → "buff"`,
  `classify(surge) → "buff"`. **Exactly the packet's §2.C empirical table.**
- Applied the §3-A diff verbatim to a standalone module bound to the *real* ETF constants;
  re-ran the packet's five assertions: **5/5 PASS** (`"19/tick Nether DoT"`, `"12/tick DoT"`,
  `"+10 STR"` untouched, both DoTs → `"debuff"`). The control STR buff is untouched.
  Patch is additive-only, inserted at the exact declared insertion points (after the
  spell-record check / after the type-key-val extraction). Live-client path (record present)
  is unaffected — the DoT guard only rescues the fallback; the DoT label improves both.

**P3 (patch 3-B) — PROVEN.** `pkg-*/holtburger_web.d.ts` exposes `readonly u32Payload2`
(no underscore). **Every** sibling handler in the ClientEvent drain reads `evt.u32Payload2`
(7239, 7261, 7356, 7368, 7388, 7498, 7513, 7562, …); **only** :7633 reads `evt.u32Payload_2`,
which is therefore `undefined ⇒ 0`. The single consumer of the emitted event
(`buffs-hud.js:909-918 onEntityEnch`) reads only `payload.guid` and re-pulls the full wasm
snapshot — it never touches `count`. So the 1-char fix is correct and has **zero behavior
change today** (dead-value cleanup + correct future contract). Confirmed the two other
`u32Payload_2` occurrences (7717/7730) are prose comments, not code.

**P6 (guardrail) — CONFIRMED.** `gen-spell-cast-sequence.cjs:294-296` sets `leadOnly` when
every scarab is Lead(id 1); windups are emitted empty for `fastCast||leadOnly` and Invalid
gestures are skipped. Tier-I bolts genuinely having no arm-raise is authentic. Good
guardrail — do not "fix."

**P7 / §2.A (data-complete) — CONFIRMED via oracle, with a range correction.** Re-ran the
player MT `0x09000001` dump. `links[0x490003]` (Magic stance `0x49` → Ready `0x0003`, 54
inner commands) contains **MagicPowerUp08Purple `0x10000132`**, MagicBlast `0x4000002B`,
MagicRecoilMissile `0x40000033`, MagicVision `0x40000036`, MagicHarm `0x40000030`, and
PowerUp01/02/10. The core claim (the void colored windup + every war/void cast substate is
present ⇒ S1 misses are runtime, not data) **holds**.

**P4 (proposal, not applied) — client mechanism CONFIRMED.** index.html kind=19 handler
emits the structured `damageDealt` bus event; magic damage arrives on the kind=2
ChatReceived handler. combat-bar subscribes only to `damageDealt`/`damageTaken`
(:2352-2353); combat-hud gates `if (!stanceIsMeleeOrMissile()) return;` at **:633 (exact)**
with the "different ACE event family" comment. So magic damage never reaches the feed/last-hit
HUD. 3-C is correctly filed as a default-OFF proposal owned elsewhere — nothing to apply.

**Environment/tests.** node v20.20.2; `formatStatMod`/`classifyEnchantment` are exported;
`test_remote_buffs.mjs` (the packet's model) exists. The new `test_dot_enchantment_label.mjs`
as written resolves correctly from its declared home `apps/holtburger-web/` (`__dirname` →
`plugins/buffs-hud.js`) and is runnable on this box.

### REQUIRED corrections (in-text only — do NOT change the patches)

1. **§2.A / P7 / TL;DR keyFinding overstate the colored band.** The text says the "full
   colored band `0x10000128`–`0x10000134`" is present under `links[0x490003]`. DAT oracle
   shows **`0x10000128`, `0x10000129`, `0x1000012A` are NOT under that link** — the band
   present is **`0x1000012B`–`0x10000134`** (`0x10000132` included). Correct the range to
   `0x1000012B–0x10000134 (incl. 0x10000132 MagicPowerUp08Purple)`. Conclusion unchanged
   (the gesture the void matrix actually uses is present), but a DAT-grounded claim must be
   accurate — this is exactly the kind of stale/rounded cite the charter warns about.

### Non-blocking notes

- 3-A ships correctly without a URL flag (foundation §4 rule 3: HUD/UI-only). 3-B likewise.
  Only 3-C carries a flag and is not applied. Consistent with project law.
- No wasm rebuild; no movement/render/physics change; the applied edits are nowhere near the
  validated castMove/slideCast/cmdInterp code (index.html:7633 is inside the kind=46 handler,
  isolated from the ~8085-9194 input lanes and the Rust movement crates). No regression risk
  to other workstreams' files.
- Suggest the new node test additionally assert `formatStatMod` on a *record-present* DoT
  still yields the DoT label (guards the "improves both paths" property), though the current
  five assertions are sufficient to guard the fix.

### Bottom line

Apply 3-A and 3-B as written. Apply the §2.A band-range text correction. 3-C remains a
proposal for the HUD/combat WS (not applied). The static matrix, wire trace, and P1/P2/P3/P6
findings are sound and independently reproduced.

```json
{"workstream":"WS15","verdict":"CONFIRMED","apply":true,"mustFix":["Correct §2.A/P7/TL;DR: the colored band under links[0x490003] is 0x1000012B-0x10000134 (0x128/0x129/0x12A absent), not the stated full 0x10000128-0x10000134 — DAT-oracle-verified; conclusion (0x10000132 present, S1 miss is runtime) unchanged"],"notes":"Applied patches 3-A (buffs-hud formatStatMod/classifyEnchantment) + 3-B (index.html:7633 u32Payload_2->u32Payload2) independently PROVEN: pre-patch reproduced '+19 id 330'/classify->buff live against the clean tree; post-patch logic yields '19/tick Nether DoT'/'debuff' (5/5). ETF 0x9004=INT|SINGLE_STAT|ADDITIVE, BENEFICIAL unset (verified vs real constants). u32Payload2 getter confirmed in .d.ts; every sibling handler uses it, only :7633 used the underscore; sole consumer ignores count => zero behavior change today. P6 leadOnly + P7 links[0x490003] magic gestures confirmed via oracle. P4 kind=2-vs-19 client mechanism confirmed (3-C is an un-applied proposal). combat-hud:633 exact. Pure JS, no wasm rebuild, no flags for HUD-only, no touch to castMove/slideCast/cmdInterp. Only defect: a minor DAT band-range overstatement to correct in-text."}
```

---

```json
{"workstream":"WS15","title":"War + void end-to-end gameplay matrix (DoTs, streaks, school feel)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS15-war-void-endtoend.md","confidence":"high","keyFindings":["Void DoTs tick as NetherOverTime PropertyInt 330 (DAT+LSD confirmed); DoTs land once as MagicUpdateEnchantment then per-heartbeat HP deltas — no per-tick wire message","buffs-hud renders void DoT as illegible '+19 id 330' and misclassifies it as a buff in the spell-record-less fallback (proven via live formatStatMod/classifyEnchantment import)","Tier-I war/void bolts authentically have NO windup arm-raise (Lead scarab gesture=Invalid) — S1 'arms not rising' for cheap test bolts is CORRECT, a guardrail not a bug","Player MotionTable 0x09000001 contains every magic gesture incl. the colored powerup band 0x1000012B-0x10000134 (0x128/0x129/0x12A absent under this link) under links[0x490003] — S1 misses for higher-tier spells are runtime lookup, not missing data","War/void damage numbers reach the client only as kind=2 chat (GameMessageSystemChat), never kind=19 — so they never appear in the combat-bar feed or last-hit HUD (melee/missile only)","kind=46 count is a dead value: JS reads evt.u32Payload_2 but the wasm getter is u32Payload2 (index.html:7633)","War/void projectiles carry casterEffect/targetEffect=Invalid; school-feel VFX rides the projectile weenie's own Setup+PhysicsScriptTable (Launch/Explode) — Nether DoT proj 43344 uses a distinct Setup 33561129"],"filesToChange":["apps/holtburger-web/plugins/buffs-hud.js","apps/holtburger-web/index.html","apps/holtburger-web/test_dot_enchantment_label.mjs (new)"],"needsWasmRebuild":false,"newFlags":["magicCombatFeed"],"risks":["buffs-hud label/classification change could break a consumer that string-matched 'id 330' or expected DoT=buff in fallback (none found)","index.html is a hot integration file — order the 1-line 7633 patch late","magicCombatFeed (P4/3-C) is a proposal owned by HUD/combat WS, not applied by WS15; involves lib.rs or fragile chat-string parsing","P4/P5 live behavior unverified from this box (no live ACE) — laptop recipes provided","P7 runtime arms-rising fix is out of WS15 charter — evidence handed to animation WS"]}
```
