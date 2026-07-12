# WS05 — Cast range + target feedback (S3b: "cast wherever you want")

Investigator packet, 2026-07-12. Charter: port retail `SpellExamineUI::DetermineSpellRange`
into the client for FEEDBACK (pre-cast out-of-range warning toast + optional armed-spell
range ring), and verify the server reject path renders end-to-end (0x550 out-of-range,
0x498 moved-too-far, 0x407/0x408 outside/inside, plus target-loss mid-cast). **Keep sends
authoritative — do NOT gate the cast client-side by default** (foundation §2.1/§2.4).

Every cite below was opened live on the buildbox this session. Where a claim rests on a
sub-agent sweep rather than my own read, it is flagged `[agent-sourced — re-verify]`.

---

## 0. TL;DR — what I found, decided, and two corrections to the foundation

- **Two corrections to the charter/foundation, both confirmed against decomp + ACE enum:**
  1. `DetermineSpellRange`'s skill-selection is **NOT an "Arcane Lore clamp"**. The
     `0x2B` skill queried in the else-branch is **VoidMagic (skill 43)**, not Arcane Lore
     (which is `0x0E`/14). And the op is a **`max` over the 5 magic skills**
     {CreatureEnch 31, ItemEnch 32, Life 33, War 34, Void 43}, not a clamp.
  2. **Target-loss mid-cast is `0x042C TargetNotAcquired`, not `0x0403`.** `0x0403`
     (`YourSpellTargetIsMissing`) is the *retail* spell string, but our live ACE server
     sends `0x042C` (`TargetNotAcquired`) for target loss (Player_Magic.cs). Neither code
     is in the wasm `spellcast_error_text` table today → target-loss renders as an ugly
     `[Use failed] TargetNotAcquired` system line.
- **The skill fed to the range formula is raw `init_level + points_raised`** (decomp
  `InqSkillLevel` returns exactly `_init_level + _level_from_pp`; ACE's own comment agrees).
  It is NOT the buffed/"current" nor the attribute-formula "base" skill — so
  `playerStats().skills` (`current`/`base`) are both **wrong** for this; they include the
  Focus+Self formula and enchantments.
- **Range fields are already exposed** (`getSpellRecord` → `baseRangeConstant`,
  `baseRangeMod`, `school`). The only missing datum is per-skill `init+ranks`.
- **`0x0498 "You have moved too far!"` is unreachable end-to-end on vanilla ACE** — the
  send is commented out (Player_Magic.cs:876); ACE sends a plain system-chat
  `"Your movement disrupted spell casting!"` instead, and only for PK players.
- **Decision:** ship (A) a wasm fix adding `0x0403`+`0x042C` to `spellcast_error_text`
  (fidelity + fixes target-loss); (B) a JS-only pre-cast out-of-range **warning** toast
  (does NOT block the cast) via a new pure `scene3d/spell_range.js` formula module + the
  existing toast surface; (C) an optional default-OFF armed-spell range ring in
  `spell_shape_preview.js`. A wasm rebuild is required for (A) regardless, so I also
  recommend a small `playerMagicSkillRaw` accessor to feed (B) exactly (a JS
  reconstruction fallback needs no rebuild — see §3.3).

---

## 1. VERIFIED FINDINGS

### 1.1 The retail range formula (`SpellExamineUI::DetermineSpellRange`) — CONFIRMED

`acclient.c:228504-228581` (read in full):

```c
// 228574-228577
v12 = v4->_base_range_mod * (double)skillLevel + v4->_base_range_constant;
*(float *)&_spellBase = v12;
if ( v12 > 75.0 )
  *(float *)&_spellBase = RADAR_OUTDOOR_RADIUS;     // 75.0
```

`RADAR_OUTDOOR_RADIUS = 75.0` — `acclient.c:40037` (`const float RADAR_OUTDOOR_RADIUS = 75.0; // idb`).

**Skill selection** (`228538-228573`):
- If `CSpellBase::InqSkillForSpell(spell) != 0` → `skillLevel = InqSkillLevel(thatSkill)`.
- Else (skill-less spell, school 0) → `skillLevel = max(creatureEnch, itemEnch, life, war, void)`
  where the five are `InqSkillLevel(0x1F/0x20/0x21/0x22/0x2B)`.

  Decompiled max chain (228558-228573): `v7 = max(war, life, itemEnch, creatureEnch)`, then
  `skillLevel = (void >= v7) ? void : v7` = `max(v7, void)`. **This is a max of all 5, not a
  clamp.** The decompiler even names the 0x2B var `_void`.

### 1.2 `InqSkillForSpell` school→skill map — CONFIRMED

`acclient.c:448600-448626` (read):

```c
switch ( this->_school ) {
  case 5u: result = 43; break;   // Void  -> VoidMagic (0x2B)
  case 1u: result = 34; break;   // War   -> WarMagic  (0x22)
  case 2u: result = 33; break;   // Life  -> LifeMagic (0x21)
  case 3u: result = 32; break;   // ItemEnch -> ItemEnchantment (0x20)
  case 4u: result = 31; break;   // CreatureEnch -> CreatureEnchantment (0x1F)
  default: result = 0;  break;   // -> the max-of-5 branch above
}
```

This matches `getSpellRecord`'s school numbering (`lib.rs:29597-29605`: 1=War, 2=Life,
3=Item Enchantment, 4=Creature Enchantment, 5=Void Magic). Clean 1:1.

**Correction proof — 0x2B is VoidMagic, ArcaneLore is 0x0E:** ACE `Skill.cs` (unnumbered
enum, order is load-bearing; counted from `None=0`): `ArcaneLore` = index 14 (`0x0E`),
`CreatureEnchantment`=31, `ItemEnchantment`=32, `LifeMagic`=33, `WarMagic`=34,
`Gearcraft`(retired)=42, `VoidMagic`=43 (`0x2B`). File
`external/ACE/Source/ACE.Entity/Enum/Skill.cs:13-56`.

### 1.3 `InqSkillLevel` returns raw `init + ranks` — CONFIRMED (this is the crux)

`acclient.c:443054-443071` (read):

```c
int __thiscall CACQualities::InqSkillLevel(CACQualities *this, unsigned int stype, int *retval) {
  ...
  if ( v3 && (v4 = ...lookup(v3, &stype)) != 0 ) {
    *retval = v4->_init_level + v4->_level_from_pp;   // <-- raw: init + ranks-from-PP
    result = 1;
  } else result = 0;   // absent skill -> retval untouched (stays 0 in caller)
}
```

**No attribute formula, no augs, no buffs.** ACE independently confirms this is the retail
behavior — `Player_Magic.cs:494-497` (read):

```csharp
// use init + ranks, same as acclient DetermineSpellRange -> InqSkillLevel
// this is much lower than base, and omits things like attribute formula + base augs + enlightenment
var playerSkill = GetCreatureSkill(spell.School);
magicSkill = playerSkill.InitLevel + playerSkill.Ranks;
```

Our client stores exactly these two wire fields: `stats::Skill { init, ranks }`
(`crates/holtburger-world/src/player/types.rs:1078-1082` `SkillBase{ranks, init}`;
populated `mutations.rs:88-89, 102-103`). So `skill.init + skill.ranks` == ACE's
`InitLevel + Ranks` == decomp `InqSkillLevel`. **Byte-for-byte correct source.**

⚠ **`playerStats().skills` cannot supply this.** Snapshot is stride-6
`[type, current, base, ranks, training, next_cost]` (`lib.rs:23375-23383`,
built `lib.rs:35490-35509`). `base` = `derive_skill_value(..., use_current=false)` =
`round((Focus_base + Self_base)/div) + ranks + init` (`stats_calc.rs:181-190`; div=4 for
all 5 magic skills, `:140-152`), and `current` additionally applies enchant mult+add
(`:184-187`). Neither equals `init+ranks`; and `init` is **not** pushed into the snapshot
(only `ranks` is). (A JS reconstruction is possible — §3.3.)

### 1.4 Spell range fields already exposed to JS — CONFIRMED

`lib.rs:29699-29700`:
```rust
"baseRangeConstant": spell.base_range_constant,
"baseRangeMod": spell.base_range_mod,
```
plus `"school": spell.school` (`:29668`). `getSpellRecord(spellId)` returns a **JS `Map`**
(serde_wasm_bindgen default; confirmed by `plugins/spellbook.js:185` comment
"`getSpellRecord(6) instanceof Map`"). JS reads `rec.get("baseRangeMod")` etc. The handle
is the SessionHandle (`window.__hbWasm`, and the same `sessionHandle` passed into
picking.js), which also exposes `playerStats()`, `getLocalPlayerPose()`, `castTargetedSpell`.

**DAT ground truth via the WB.Terminal oracle** (`typeName:"SpellTable"`, `0x0E00000E`):
- `Flame Bolt I` (WarMagic): `baseRangeConstant:30, baseRangeMod:0.7` → `range = 0.7·War + 30`, cap 75.
- `Flame Bolt II`: `30 / 0.6`.
- `Strength Other I` (CreatureEnch, targeted): `5 / 1` → `range = 1·CreatureEnch + 5`.
- `Strength Self I` (SelfTargeted): `0 / 0` → range 0 (self spells need no range).

### 1.5 Server reject codes — what ACE ACTUALLY sends (our live server) — CONFIRMED

WeenieError enum values (`crates/holtburger-protocol/src/errors.rs`, read):
| code | name | line |
|---|---|---|
| `0x0403` | `YourSpellTargetIsMissing` | 120 |
| `0x0407` | `YourSpellCannotBeCastOutside` | 124 |
| `0x0408` | `YourSpellCannotBeCastInside` | 125 |
| `0x042C` | `TargetNotAcquired` | 161 |
| `0x0498` | `YouHaveMovedTooFar` | 241 |
| `0x0550` | `MissileOutOfRange` | 420 |

ACE `Player_Magic.cs` (read) send sites:
- **Out of range** → `VerifySpellRange` `SendUseDoneEvent(MissileOutOfRange)` (`:504`).
  Called pre-windup (`:785`) and post-windup recheck (`:1022`). Distance test
  `if (distanceTo > maxRange)` with `distanceTo = Location.Distance2D(targetLoc.Location)`
  (`:490, :502`) — **2D horizontal distance**.
- **Inside/outside** → `SendUseDoneEvent(YourSpellCannotBeCastInside/Outside)`
  (`:513, :521`), gated on `SpellFlags.NotIndoor/NotOutdoor`.
- **Target loss (before/during windup)** → `SendUseDoneEvent(TargetNotAcquired)`
  (`:139, :177, :201`) and `SendWeenieError(TargetNotAcquired)` (`:755`). **0x042C**, not 0x403.
- **Moved too far (0x0498)** → **COMMENTED OUT** (`:876`):
  ```csharp
  // check windup move distance cap
  var dist = StartPos.Distance(PhysicsObj.Position);
  if (dist > Windup_MaxMove && PlayerKillerStatus != PlayerKillerStatus.NPK) {
      //player.Session.Network.EnqueueSend(new GameEventWeenieError(..., WeenieError.YouHaveMovedTooFar));
      Session.Network.EnqueueSend(new GameMessageSystemChat("Your movement disrupted spell casting!", ChatMessageType.Magic));
      EnqueueBroadcast(new GameMessageScript(Guid, PlayScript.Fizzle, 0.5f));
      ...
  }
  ```
  So on vanilla ACE, **0x0498 is never sent**; the disruption is (a) PK-only, and (b) a
  plain magic chat line + a Fizzle VFX (NOT a `YourSpellFizzled` WeenieError — so the JS
  `castFizzle` hook does not fire for it either). NPK test chars never trip it at all.

**Mislabel-risk check for 0x042C:** `rg TargetNotAcquired` over all of
`external/ACE/Source/**.cs` returns **only** `Player_Magic.cs` (4 sites) + the enum def.
So against our live ACE server, `0x042C` **unambiguously** means spell target-loss — safe
to map to a spell string in `spellcast_error_text`.

### 1.6 The wasm error→toast path — CONFIRMED (and where 0x403/0x42C fall through)

`spellcast_error_text(code)` (`lib.rs:20783-20804`, read) maps 0x400/0x401/0x402/0x407/
0x408/0x498/0x550/0x4EB. **It has NO 0x0403 and NO 0x042C.** Consumed by two arms:
- **UseDone arm** (`lib.rs:42368-42420`): on `error != None` it ALWAYS pushes a kind=13
  `CLIENT_EVENT_KIND_USE_FAILED` (label + code), then a kind=2 chat line —
  `spellcast_error_text` hit → `CHAT_CATEGORY_TRANSIENT` (9); miss → `"[Use failed] {label}"`
  as `CHAT_CATEGORY_SYSTEM` (0).
- **WeenieError arm** (`lib.rs:42457-42510`): only pushes kind=13 + transient text **if
  `spellcast_error_text` matches**; else a plain kind=2 system line.

So today target-loss (0x042C via UseDone) shows `[Use failed] TargetNotAcquired` (grey
system line), and (0x042C via SendWeenieError → WeenieError arm) shows `TargetNotAcquired`
(system line), never the retail toast, and never the kind=13 the JS cast-cancel hook keys on.

**Kind consts** `[agent-sourced — re-verify exact lines]`: `CHAT_RECEIVED=2` (20704),
`USE_FAILED=13` (20756), `USE_DONE=14` (20763), `CHAT_CATEGORY_SYSTEM=0` (20434),
`CHAT_CATEGORY_TRANSIENT=9` (20452). (The two error arms above use these symbols, so they
resolve; only the precise def lines are agent-reported.)

**JS render:** kind=2 transient → `plugins/rejection_feedback.js::_onChatReceived`
(`:305-310`, filters category==9) → `_renderToast(msg)` (`:216`, fixed toast top-center,
red border, auto-remove 2400ms). kind=13 → `index.html:7808-7842` (cast-fizzle hook on
0x0402; re-emits `kind:13` on the bus). So **any code we add to `spellcast_error_text`
automatically renders as a transient toast via BOTH arms.**

### 1.7 Retail toast strings (for fidelity) — CONFIRMED

`acclient.c` error-string switch (read):
- `0x403` → `"Your spell's target is missing!"` (`:416007`)
- `0x550` → `"Out of Range!"` (`:414017`) — capital R
- `0x498` → `"You have moved too far!"` (`:415039`)
- `0x407` → `"Your spell cannot be cast outside"` (`:416024`) — no period
- `0x408` → `"Your spell cannot be cast inside"` (`:415814`) — no period

⚠ Minor fidelity drift in current wasm strings (`lib.rs:20792-20799`): `"Out of range!"`
(should be `"Out of Range!"`), `"...cast outside."` / `"...cast inside."` (retail has no
trailing period). The header comment claims "verified verbatim" — it is off on casing/period.
Optional to fix (§3.1, low priority).

### 1.8 JS cast entry point + distance/toast helpers — CONFIRMED (all already present)

`scene3d/picking.js` (read):
- Magic cast branch `:602-702`. After `spellId` resolves (`:606-610`) and before
  `turnToFaceThenAct(guid, doCast, ...)` (`:701`), we have `guid` (target) and `spellId`.
- `emitActionRejected(message)` (`:182-186`) → `clientActionRejected` bus event →
  `rejection_feedback.js::_onClientActionRejected` (`:273-276`) → `_renderToast`. **This is
  the exact warning surface used for the existing "Enter magic mode to cast that spell."
  toast (`:718`).**
- Distance helpers, already in-file and already used for melee charge-range:
  `playerWorldPose(sessionHandle)` (`:160-173`, lb-local→world `x + lbX*192`),
  `entityAcPosition(em, guid)` (`:126-131`, reads `inst.root.position` = world frame),
  `horizontalDistance(a,b)` (`:133-137`, 2D `x/y`). Both poses are in the SAME AC-world
  frame (documented `:146-159`), so `horizontalDistance` == ACE `Distance2D`. Range is in
  meters. Directly comparable.

### 1.9 `spell_shape_preview.js` (for the ring) — `[agent-sourced — re-verify on laptop]`

Self-registering three.js module with its OWN `requestAnimationFrame` loop
(`_tickAllPreviews`), torus/line/sphere shape builders (already builds `TorusGeometry`
ground rings for the `ring`/`self` shapes), resolves placements from
`entityManager.entityMap.get(guid).root.position`. Listens for the `spellCastInitiated`
bus event (emitted at `picking.js:654-661`, which I read directly). Has a `?projectileArc`
flag (`url-flags.md:284`). **No persistent world-radius ring around the player exists** —
that's net-new. Armed-spell id is `window.__combatBarState.armedSpellId`
(set `combat-bar.js:128/737/934/1940`, read `picking.js:607`).

---

## 2. ROOT CAUSES (charter symptoms → mechanism)

**S3b "cast wherever you want" — no pre-cast range/target feedback.** Mechanism: retail
never gated range client-side (foundation §2.1 confirmed — the only range math is the UI
*display* function `DetermineSpellRange`). Our client faithfully doesn't gate either, but
it ALSO never ports the display formula, so the player has **zero** pre-cast signal about
reach. When the server rejects out-of-range it sends `UseDone(0x0550)`, which DOES already
render `"Out of range!"` as a transient toast (§1.6) — that path works today. The gap is
purely **proactive feedback** (know before you click) + **fidelity** of the reactive strings.

**Target-loss mid-cast is mis-rendered.** Mechanism (proven §1.5/§1.6): ACE sends `0x042C`
(not the retail `0x0403`); `spellcast_error_text` knows neither, so the toast path is
skipped and the player sees a grey `[Use failed] TargetNotAcquired` system line instead of
`"Your spell's target is missing!"`. Two-line fix.

**"Moved too far" cannot be validated on our server.** Mechanism (proven §1.5): the 0x0498
send is commented out in ACE; it's PK-only and uses a system-chat string. The wasm 0x0498
entry is effectively dead against vanilla ACE. Not a bug — a reachability fact to document.

Not in scope but noted: the *actual* "run as far as you want while the cast keeps going"
locomotion leak is the FU-A-dormant / use_time-reclaim issue owned by the movement
workstreams (foundation §1.4/§3-S3a). WS05 is feedback only; we do **not** add a hard root.

---

## 3. PATCH PLAN (minimal, reversible; foundation §4 conventions)

Three independent pieces. (A) needs a wasm rebuild; (B)/(C) are JS-only. Since (A) forces a
rebuild anyway, I fold in the small skill accessor that lets (B) be exact.

### 3.1 (A) wasm — target-loss + range/fidelity strings in `spellcast_error_text`

No flag (this is a pure message-correctness fix to an existing render path, like the
existing entries). File: `apps/holtburger-web/src/lib.rs`.

```diff
--- a/src/lib.rs
+++ b/src/lib.rs   (fn spellcast_error_text, ~20794-20802)
         // WeenieError::YouHaveMovedTooFar (PK windup move cap)
         0x0498 => "You have moved too far!",
         // WeenieError::MissileOutOfRange — ACE reuses this for spell
         // range (VerifySpellRange). Retail's generic range string.
-        0x0550 => "Out of range!",
+        0x0550 => "Out of Range!",
+        // WeenieError::YourSpellTargetIsMissing (retail spell-target-loss
+        // string, acclient.c:416007). ACE routes target loss as
+        // TargetNotAcquired (0x042C) instead — see below — but keep 0x0403
+        // too for any server that sends the retail code.
+        0x0403 => "Your spell's target is missing!",
+        // WeenieError::TargetNotAcquired — what our live ACE actually sends
+        // when the target dies/teleports before or during windup
+        // (Player_Magic.cs:139/177/201/755). 0x042C is used ONLY by
+        // Player_Magic in ACE (rg-verified), so mapping it to the retail
+        // spell-target string is unambiguous against our server.
+        0x042C => "Your spell's target is missing!",
         // WeenieError::YouCantDoThatWhileInTheAir (cast while jumping)
         0x04EB => "You can't do that while in the air!",
```

Optional fidelity nit (same hunk region, `:20792-20794`) — retail has no trailing period:
`"Your spell cannot be cast outside"` / `"...inside"`. Left out of the primary diff to keep
the change tight; call it if the reviewer wants byte-exact retail strings.

Effect: target-loss now renders the retail toast via BOTH arms, and (via the UseDone arm)
also emits kind=13 with code 0x042C — which lets the JS cast-cancel hook be extended to
recoil the local cast chain on target loss (optional follow-on, §3.4).

### 3.2 (A′) wasm — exact raw-skill accessor to feed the range preview (recommended)

Adds `init+ranks` per magic skill to the cached stats snapshot + a getter. Non-breaking
(does NOT touch the stride-6 skills array). File: `apps/holtburger-web/src/lib.rs` +
the `LatestStats` struct + `publish_player_stats_snapshot`.

```diff
 // in `struct LatestStats { ... }`
+    /// Raw `init_level + points_raised` (retail InqSkillLevel) for the 5
+    /// magic skills, keyed by SkillType u32 (31/32/33/34/43). Fed to the
+    /// WS05 spell-range preview (SpellExamineUI::DetermineSpellRange uses
+    /// this raw value, NOT the attribute-formula base nor buffed current).
+    magic_skill_raw: std::collections::HashMap<u32, u32>,
```

```diff
 // in publish_player_stats_snapshot, after the skills loop (lib.rs ~35510)
+    let mut magic_skill_raw = std::collections::HashMap::new();
+    for skill in world.player.skill_snapshot() {
+        let id = skill.skill_type as u32;
+        if matches!(id, 31 | 32 | 33 | 34 | 43) {
+            magic_skill_raw.insert(id, skill.init + skill.ranks);
+        }
+    }
 // ...store `magic_skill_raw` into the LatestStats written by this fn.
```

```diff
 // new SessionHandle export near player_stats (lib.rs ~29288)
+    /// Retail `CACQualities::InqSkillLevel` (acclient.c:443063) = raw
+    /// `init_level + points_raised` for a skill (0 if absent). This is the
+    /// value SpellExamineUI::DetermineSpellRange feeds the range formula —
+    /// NOT the buffed/attribute-formula skill. JS: spell-range preview.
+    #[wasm_bindgen(js_name = playerMagicSkillRaw)]
+    pub fn player_magic_skill_raw(&self, skill_type: u32) -> u32 {
+        self.latest_stats.borrow().as_ref()
+            .and_then(|s| s.magic_skill_raw.get(&skill_type).copied())
+            .unwrap_or(0)
+    }
```

### 3.3 (B) JS — pre-cast out-of-range WARNING (does NOT block the cast)

New pure formula module + a hook in picking.js. Flag `castRangeWarn` default-ON with
`=off` escape (it adds a toast on every out-of-range cast click — a UI behavior change, so
it gets an escape hatch per foundation §4.3).

New file `apps/holtburger-web/scene3d/spell_range.js` (import-free, node-testable, mirrors
DetermineSpellRange exactly):

```js
// SpellExamineUI::DetermineSpellRange port (acclient.c:228504-228581).
// School->skill: acclient.c:448600 InqSkillForSpell. Range = mod*skill + const, cap 75.
export const RADAR_OUTDOOR_RADIUS = 75.0;
const MAGIC_SKILLS = [31, 32, 33, 34, 43]; // CreatureEnch, ItemEnch, Life, War, Void

export function inqSkillForSchool(school) {
  switch (school >>> 0) {
    case 1: return 34; case 2: return 33; case 3: return 32;
    case 4: return 31; case 5: return 43; default: return 0;
  }
}
// getRaw(skillId) -> init+ranks (0 if absent). Mirrors InqSkillLevel semantics.
export function pickSkillLevel(school, getRaw) {
  const id = inqSkillForSchool(school);
  if (id !== 0) return getRaw(id) >>> 0;
  return MAGIC_SKILLS.reduce((m, s) => Math.max(m, getRaw(s) >>> 0), 0); // max-of-5
}
export function determineSpellRange(baseRangeMod, baseRangeConstant, skillLevel) {
  const r = baseRangeMod * skillLevel + baseRangeConstant;
  return r > RADAR_OUTDOOR_RADIUS ? RADAR_OUTDOOR_RADIUS : r;
}
```

Hook in `scene3d/picking.js` — a helper + one call inside the existing magic branch. It
warns but always falls through to the real cast (send stays authoritative):

```diff
 // near emitActionRejected (picking.js ~186)
+// WS05 — pre-cast out-of-range WARNING (feedback only; NEVER blocks the
+// cast — retail didn't gate range client-side, server rejects + toasts).
+// Mirrors SpellExamineUI::DetermineSpellRange (spell_range.js) and ACE
+// VerifySpellRange's 2D distance test. Default-ON, `?castRangeWarn=off`.
+function maybeWarnOutOfRange(sessionHandle, liveScene3d, guid, spellId, localGuid) {
+  if (RANGE_WARN_OFF) return;
+  try {
+    if ((guid >>> 0) === (localGuid >>> 0)) return;          // self: always in range
+    const rec = sessionHandle.getSpellRecord?.(spellId >>> 0);
+    if (!rec) return;
+    if (rec.get("isSelfTargeted") || rec.get("isUntargeted")) return;
+    const mod = +rec.get("baseRangeMod"), konst = +rec.get("baseRangeConstant");
+    const school = +rec.get("school");
+    const getRaw = (s) => sessionHandle.playerMagicSkillRaw?.(s) ?? 0; // §3.3-fallback below
+    const skill = pickSkillLevel(school, getRaw);
+    const range = determineSpellRange(mod, konst, skill);
+    if (range <= 0) return;
+    const pose = playerWorldPose(sessionHandle);
+    const tpos = entityAcPosition(liveScene3d.entityManager, guid);
+    if (!pose || !tpos) return;
+    if (horizontalDistance(pose, tpos) > range) emitActionRejected("Out of Range!");
+  } catch (_) { /* never block the cast on feedback faults */ }
+}
```
```diff
 // inside the magic branch, right after the spellCastInitiated try/catch (picking.js ~668)
+          const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
+          maybeWarnOutOfRange(sessionHandle, liveScene3d, guid, spellId, localGuid);
           // F8-5 — turn to face the target before casting ...
           const doCast = () => { ... };
```
(`RANGE_WARN_OFF` parsed from the URL alongside the other picking flags; `pickSkillLevel`/
`determineSpellRange` imported from `./spell_range.js`.)

**No-rebuild fallback for `getRaw`** (if integration wants (B) without touching wasm):
reconstruct `init+ranks` from the existing snapshot —
`init+ranks = base − round((Focus_base + Self_base)/4)` (exact; div=4 for all 5 magic
skills, `stats_calc.rs:140-152`; positive attrs → `Math.round` matches Rust `.round()`):
```js
// stats = sessionHandle.playerStats(); skills stride-6, attrs stride-4 (Focus=5,Self=6)
function rawFromSnapshot(stats, skillId) {
  const sk = stats.skills, at = stats.attributes;
  let base = 0; for (let i=0;i+2<sk.length;i+=6) if (sk[i]===skillId){ base=sk[i+2]; break; }
  const attr = (t)=>{ for (let i=0;i+2<at.length;i+=4) if(at[i]===t) return at[i+2]; return 0; };
  return Math.max(0, base - Math.round((attr(5)+attr(6))/4));
}
```
Recommendation: prefer the (A′) `playerMagicSkillRaw` accessor (obvious + robust); keep the
reconstruction only as the zero-rebuild path.

`url-flags.md` row (draft, matches the castFizzle/castFaceTarget row shape):

> \| `castRangeWarn` \| `on` \| off \| WS05: pre-cast out-of-range WARNING toast. Mirrors
> retail `SpellExamineUI::DetermineSpellRange` (acclient.c:228504; `range = baseRangeMod ·
> (init+ranks skill) + baseRangeConstant`, cap 75) and ACE `VerifySpellRange`'s 2D distance
> test. Fires `emitActionRejected("Out of Range!")` when the armed spell's target is beyond
> range — **feedback only, the cast still sends** (retail never gated range client-side;
> the server rejects with `UseDone(0x0550)` which already toasts). Self/untargeted spells
> skipped. `=off` = no pre-cast toast (server reject unchanged). JS-only formula
> (`scene3d/spell_range.js`); skill via `playerMagicSkillRaw` (or snapshot reconstruction).
> \| Arm a war bolt, click a target just out of reach vs in reach; `=off` should show
> nothing pre-cast. \| scene3d/picking.js + scene3d/spell_range.js \|

### 3.4 (C) JS — optional armed-spell range RING (default-OFF, eye-test gated)

File: `apps/holtburger-web/scene3d/spell_shape_preview.js`. Flag `castRangeRing` default-OFF
(a persistent world-space visual → foundation §4.3 "risky/feel changes ship default-OFF
pending a 1070 eye-test"). Design (net-new persistent ring; the module already owns a rAF
loop + `TorusGeometry` builders):

- On each rAF tick (or a lightweight ~10Hz poll), read `window.__combatBarState?.armedSpellId`.
- On arm (and flag ON): compute `range = determineSpellRange(...)` for the armed spell (self
  skill via `playerMagicSkillRaw`); build a flat ground `TorusGeometry(range, ~0.08, ...)`
  colored by school (`colorForSchool`), add under `worldRoot`.
- Each frame: set the ring's position to the LOCAL player's feet
  (`entityManager.entityMap.get(localGuid).root.position`); rebuild only when `range` or
  `armedSpellId` changes.
- On disarm / stance leave / flag OFF: dispose + remove (reuse the module's dispose path).
- Skip entirely for self/untargeted spells (range 0).

`url-flags.md` row (draft):

> \| `castRangeRing` \| `off` to enable \| **off** \| WS05: while a targeted spell is armed
> in Magic stance, draw a flat ground ring at the caster's feet at the spell's cast range
> (`DetermineSpellRange`, cap 75m), school-colored. Purely visual reach hint; no gating.
> Default-OFF pending 1070 eye-test (large 75m torus legibility / z-fighting on terrain).
> `=on` to enable. \| Arm a war bolt (short range) then a self-buff (no ring); watch ring
> track the player while running. \| scene3d/spell_shape_preview.js \|

### 3.5 (D) verify 0x0550 / 0x0407 / 0x0408 render end-to-end

No code change — these already flow (UseDone arm → `spellcast_error_text` → transient
toast). This is a **validation** item (§4 TODO-for-laptop): confirm the toast actually
appears when the live server rejects. 0x0498 is documented unreachable (§1.5) — no action.

---

## 4. TESTS

### 4.1 node unit test — the pure range formula (DAT-grounded)

New `apps/holtburger-web/test_ws05_spell_range.mjs` (runs `node test_ws05_spell_range.mjs`):

```js
import { inqSkillForSchool, pickSkillLevel, determineSpellRange, RADAR_OUTDOOR_RADIUS }
  from "./scene3d/spell_range.js";
import assert from "node:assert";

// school->skill (acclient.c:448600)
assert.equal(inqSkillForSchool(1), 34); // War
assert.equal(inqSkillForSchool(5), 43); // Void  (NOT ArcaneLore 0x0E)
assert.equal(inqSkillForSchool(4), 31); // CreatureEnch
assert.equal(inqSkillForSchool(0), 0);  // -> max-of-5 branch

// Flame Bolt I (DAT: mod 0.7, const 30), War skill = init+ranks
assert.equal(determineSpellRange(0.7, 30, 50), 65);      // 0.7*50+30
assert.equal(determineSpellRange(0.7, 30, 20), 44);
assert.equal(determineSpellRange(0.7, 30, 100), 75);     // capped (would be 100)
assert.equal(determineSpellRange(0.7, 30, 65), 75);      // 75.5 -> cap
assert.equal(determineSpellRange(0.7, 30, 64), 74.8);    // just under cap

// Strength Other I (DAT: mod 1, const 5)
assert.equal(determineSpellRange(1, 5, 40), 45);
// Strength Self I (DAT: mod 0, const 0) -> 0 (self, skipped by caller)
assert.equal(determineSpellRange(0, 0, 300), 0);

// skill selection: skill-bearing spell uses its ONE skill; school 0 = max-of-5
const raw = { 31: 10, 32: 20, 33: 30, 34: 40, 43: 250 };
assert.equal(pickSkillLevel(1, (s) => raw[s] || 0), 40);   // War -> War only
assert.equal(pickSkillLevel(0, (s) => raw[s] || 0), 250);  // none -> max (Void 250)
assert.equal(RADAR_OUTDOOR_RADIUS, 75.0);
console.log("WS05 spell_range OK");
```

### 4.2 node test — the no-rebuild snapshot reconstruction (if used)

Assert `rawFromSnapshot` recovers `init+ranks` from a synthetic stride-6 skills array +
stride-4 attrs (e.g. War base 55 with Focus_base 100, Self_base 100 → 55 − round(200/4)=5).
Guards the div=4 / rounding assumption.

### 4.3 Rust unit test — `playerMagicSkillRaw` / snapshot field (if (A′) taken)

`capped-build cargo test -p holtburger-core` (single crate, quick): after `update_skill`
for War with `init=2, ranks=48`, assert the snapshot's `magic_skill_raw[34] == 50` and
absent skills read 0. (Add near the existing skill-update tests.)

### 4.4 TODO-FOR-LAPTOP — headless live validation (no ACE reachable from buildbox)

Prereqs: `python3 external/holtburger/scripts/serve.py` → :8765; wasm rebuilt if (A)/(A′)
landed (`env PATH=... capped-build wasm-pack build --target web --out-dir pkg --dev` from
`apps/holtburger-web/`, after `kill $(pgrep -f rust-analyzer)`). Live vanilla ACE on laptop.

Bot URL: `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
plus `&castRangeWarn=on` (default) / `&castRangeRing=on` for (C). Poll
`window.__bootState==='in-world'`. Use a **war-trained** char with a war bolt known
(`playerKnownSpells()`); Flame Bolt I is ideal (low mana, range 0.7·War+30).

1. **Out-of-range warning (B):** compute your reach = `sessionHandle.determineSpellRange`
   isn't exported — instead read `sessionHandle.getSpellRecord(fbSpellId)` + your War skill;
   e.g. War 50 → 65m. `@teleloc` / walk so a target monster is ~70m away (beyond 65). Arm
   the bolt (combat bar) and click it. **Expect:** a red top-center toast `"Out of Range!"`
   AND the cast still sends (windup plays; server then also toasts `"Out of Range!"` via
   0x0550 — you'll briefly see two, expected). Walk to <65m, click again → **no** pre-cast
   toast; cast proceeds. Re-run with `&castRangeWarn=off` → **no** pre-cast toast either
   time (server reject still toasts when actually out of range).
2. **Server out-of-range (D):** with `castRangeWarn=off`, cast at a target beyond reach →
   confirm `"Out of Range!"` transient toast appears (UseDone 0x0550 path). Console:
   `[step 5] UseFailed ... code=1360` (0x550) should NOT appear (0x550 goes via UseDone, not
   the WeenieError kind=13 arm) — you'll see the kind=2 transient instead. Verify via
   `__diag.wire.summary()` that a `UseDone` with a non-None error arrived.
3. **Target-loss (A):** arm + click a low-HP monster and kill/despawn it (or have it
   teleport) during your windup — or cast at a corpse that decays mid-windup. **Expect**
   with the fix: transient toast `"Your spell's target is missing!"` (was
   `[Use failed] TargetNotAcquired`). Confirm the code on the wire is **0x042C** (1068), not
   0x0403, via console/`__diag`. Without the fix (flag-off pkg), confirm the ugly system line.
4. **Inside/outside (D):** find a `NotOutdoor`/`NotIndoor` spell (check `getSpellRecord`
   flags `notIndoor`/`notOutdoor`); cast in the wrong environment → confirm
   `"Your spell cannot be cast outside/inside"` transient toast (0x0407/0x0408 via UseDone).
5. **Moved-too-far (documented dead):** confirm on an NPK char you can move freely during a
   cast with **no** 0x0498 toast (expected — send is commented out; NPK never trips it).
   Optional: a PK char moving >6m during windup should get the magic chat line
   `"Your movement disrupted spell casting!"` (NOT the 0x0498 toast).
6. **Range ring (C):** `&castRangeRing=on`, arm a war bolt → a ground ring at your feet
   sized to reach; run around → ring tracks you; arm a self-buff → no ring; disarm → ring
   gone. Screenshot for the eye-test queue.

Acceptance (foundation §5): bare-default URL loads/spawns/casts, 0 console errors;
`castRangeWarn=off` arm byte-identical to today; the four repro scripts show the toasts.

---

## 5. EYE-TEST QUEUE (1070 GPU box — queue, do not run here)

| Flag combo | Spell/setup | Expected visual |
|---|---|---|
| `?castRangeRing=on` | Arm Flame Bolt I (War ~50 → ~65m ring) | Flat school-blue ground torus at caster's feet, radius = reach; tracks the player while running; no z-fight shimmer on terrain; legible at 75m for a high-skill spell. |
| `?castRangeRing=on` | Arm a self-buff (Strength Self I) | **No** ring (range 0 / self). |
| `?castRangeRing=on` | Arm Void bolt on a void char | Ring present, **purple** (`colorForSchool` Void `0x8a4ad9`). |
| `?castRangeWarn=on` (default) | Click target just out of reach | Red top-center `"Out of Range!"` toast at click; cast still fires. (Toast legibility / double-toast-with-server timing is the thing to eyeball.) |

Batch with the other cast-visual eye-tests; no new rig/camera behavior, so low risk.

---

## 6. RISKS + cross-workstream interactions

**Files I would touch (for integration ordering):**
- `apps/holtburger-web/src/lib.rs` — (A) `spellcast_error_text` (+3 codes), (A′) `LatestStats`
  field + `publish_player_stats_snapshot` + new `playerMagicSkillRaw` export. **Shared with
  every wasm-touching workstream** — the integration phase owns the single rebuild
  (foundation §4.4). My changes are additive/non-breaking (no existing export signature or
  the stride-6 skills array changes).
- `apps/holtburger-web/scene3d/picking.js` — (B) warning hook. **Hot file** — WS on cast
  entry / turn-to-face / sneak-predict / charge all edit this. My hunk is a self-contained
  helper + one call inside the existing `if (spellId !== 0)` block; order after the
  `spellCastInitiated` emit, before `turnToFaceThenAct`. No behavior change to the cast send.
- `apps/holtburger-web/scene3d/spell_range.js` — **new**, import-free, no collisions.
- `apps/holtburger-web/scene3d/spell_shape_preview.js` — (C) ring. Same file WS on
  projectile previews / VFX may touch; my addition is a new persistent-ring lane behind a
  default-OFF flag, isolated from the cast-initiated preview builders.
- `apps/holtburger-web/docs/url-flags.md` — two new rows (`castRangeWarn`, `castRangeRing`).
- Tests: `test_ws05_spell_range.mjs` (new); optional `holtburger-core` skill test (A′).

**Risks:**
- *Double toast* on a genuinely-out-of-range cast: the client warning + the server 0x0550
  both fire (~windup apart). Acceptable (both say "Out of Range!"); if disliked, suppress the
  client toast when a server reject is expected — but that reintroduces client authority, so
  I keep them independent (client = proactive, server = authoritative). Documented, not gated.
- *`playerStats` snapshot freshness*: `playerMagicSkillRaw` (and the reconstruction) read the
  cached `latest_stats`, refreshed on `PlayerStatsUpdated`. A just-buffed skill won't change
  the raw init+ranks anyway (formula is raw, §1.3), so staleness is a non-issue for range.
- *0x042C mapping breadth*: safe against **our** ACE (0x042C is Player_Magic-only, §1.5). If
  a future/non-ACE server sends 0x042C from a combat path, it would show the spell string.
  Low risk; noted. `0x0403` is unambiguous.
- *Ring perf/legibility*: a 75m torus every frame — cheap geometry, but eye-test gated
  (default-OFF) for z-fighting and scale legibility. Rebuild only on range/spell change.
- *Reconstruction fallback fragility* (only if (A′) skipped): depends on div=4 + the derive
  formula; guarded by a node test (§4.2) and preferred-away by shipping `playerMagicSkillRaw`.

**Interactions:**
- **WS04/cast-entry & WS on picking.js**: coordinate the picking.js hunk placement (shared
  file). Purely additive; no send-path change.
- **Movement workstreams (S3a, castMove/cmdInterp)**: WS05 deliberately does **not** add a
  movement root — feedback only. The "run far while casting" *locomotion* fix is theirs; my
  warning is orthogonal and composes with any castMove setting.
- **VFX/projectile-preview WS (spell_shape_preview.js)**: the range ring shares the file; keep
  it a separate lane behind `castRangeRing`.
- **Any WS adding wasm exports / `LatestStats` fields**: my `magic_skill_raw` field + export
  land in the same rebuild; additive, no coordination beyond the shared rebuild.

---

## 7. Confidence

**High** on findings (formula, skill source, error codes, ACE send behavior — each
triple-sourced across decomp + ACE reference + DAT oracle) and on (A)/(B) patches. **Medium**
on (C) the range ring (some `spell_shape_preview.js` internals are agent-sourced and the
persistent-follow ring is net-new — re-verify the module's rAF/entityMap API on the laptop
before implementing). No repo files were edited except this packet.

```json
{"workstream":"WS05","title":"Cast range + target feedback (S3b)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS05-range-target-feedback.md","confidence":"high","keyFindings":["DetermineSpellRange skill-select is max-of-5 magic skills (0x2B=VoidMagic, NOT Arcane Lore/0x0E); it is a max not a clamp","Range skill = raw init_level+points_raised (decomp InqSkillLevel acclient.c:443063; ACE Player_Magic.cs:494-497 agrees) — NOT buffed/attribute-formula base, so playerStats current/base are both wrong","Target-loss mid-cast is 0x042C TargetNotAcquired (ACE Player_Magic-only, safe to map), NOT retail 0x0403; neither is in wasm spellcast_error_text so it renders as an ugly system line today","0x0498 moved-too-far is unreachable on vanilla ACE (send commented out Player_Magic.cs:876; PK-only, uses a system-chat string)","Range fields already exposed (getSpellRecord baseRangeConstant/baseRangeMod/school); 0x0550/0x0407/0x0408 already render as transient toasts via the UseDone arm","DAT-grounded: Flame Bolt I = mod 0.7/const 30, Strength Self I = 0/0; toast+distance helpers (emitActionRejected, playerWorldPose, entityAcPosition, horizontalDistance) already exist in picking.js"],"filesToChange":["apps/holtburger-web/src/lib.rs","apps/holtburger-web/scene3d/picking.js","apps/holtburger-web/scene3d/spell_range.js (new)","apps/holtburger-web/scene3d/spell_shape_preview.js","apps/holtburger-web/docs/url-flags.md","apps/holtburger-web/test_ws05_spell_range.mjs (new)"],"needsWasmRebuild":true,"newFlags":["castRangeWarn","castRangeRing"],"risks":["Double toast (client warning + server 0x0550) on a truly out-of-range cast — both say Out of Range!, kept independent to preserve server authority","0x042C mapped to a spell string is safe only because ACE uses it Player_Magic-only; a non-ACE server could mislabel a combat 0x042C","Range ring is net-new persistent visual — default-OFF, eye-test gated for z-fighting/legibility; spell_shape_preview internals partly agent-sourced","No-rebuild skill reconstruction fallback depends on div=4/rounding — guarded by a node test, preferred-away by shipping playerMagicSkillRaw","picking.js is a hot multi-workstream file — additive hunk, no cast-send change, needs integration ordering"]}
```

---

## VERDICT (WS05-verify)

**Verdict: CONFIRMED** (apply: true). Adversarial re-verification on the buildbox, 2026-07-12.
Every load-bearing claim was re-derived from the live sources; **not a single citation
failed**, and both of the packet's corrections to the foundation are themselves correct.
Two minor required adjustments before landing (below) — none touch correctness of the
analysis, only flag-convention and patch-completeness. Verifier edited ONLY this packet file.

### A. Load-bearing claims re-verified (all CONFIRMED, opened live this session)

**Decomp (`/home/wbterminal/ac-headers/acclient.c`), read whole functions:**
- `SpellExamineUI::DetermineSpellRange` **228504-228581** — exact. `v12 = _base_range_mod *
  skillLevel + _base_range_constant; if (v12 > 75.0) → RADAR_OUTDOOR_RADIUS` (228574-577). ✓
- **Max-of-5 skill select re-traced instruction-by-instruction (228548-228573):** `v7 =
  max(war,life,itemEnch,creatureEnch)` via the pointer-chase, then `!(SF^OF)` on `_void - v7`
  ⇒ `skillLevel = max(v7, _void)` = max of all five. It queries `0x1F/0x20/0x21/0x22/0x2B`.
  **Correction #1 CONFIRMED** — it is a *max over 5*, not an "Arcane Lore clamp"; `0x2B` is the
  var the decompiler literally names `_void`. ✓
- `CSpellBase::InqSkillForSpell` **448600-448626** — school switch 5→43 / 1→34 / 2→33 / 3→32 /
  4→31 / default→0. Exact. ✓
- `CACQualities::InqSkillLevel` **443054-443071** — `*retval = _init_level + _level_from_pp`;
  absent skill ⇒ result 0, retval untouched. Raw init+ranks, no formula/aug/buff. ✓
- `RADAR_OUTDOOR_RADIUS = 75.0` **40037**. ✓
- Retail toast strings: `0x403`→"Your spell's target is missing!" (416007), `0x550`→"Out of
  **R**ange!" (414017), `0x498`→"You have moved too far!" (415039), `0x407`→"...cast outside"
  (no period, 416024), `0x408`→"...cast inside" (no period, 415814). **The §1.7 fidelity drift
  is REAL** — current wasm has "Out of range!" (lowercase) + trailing periods. ✓

**ACE reference (`external/ACE/Source`, read — never edited):**
- `Player_Magic.cs` **VerifySpellRange 481-525**: `maxRange = Math.Min(BaseRangeConstant +
  magicSkill*BaseRangeMod, MaxRadarRange_Outdoors)`, `distanceTo = Location.Distance2D` (2D),
  `if (distanceTo > maxRange) → SendUseDoneEvent(MissileOutOfRange)`. Inside/Outside 513/521. ✓
- **Stronger than the packet stated:** at **492-497** `VerifySpellRange` *overrides* the passed
  `magicSkill` with `GetCreatureSkill(spell.School).InitLevel + Ranks` whenever `casterItem ==
  null` (player self-cast), with the comment "use init + ranks, same as acclient
  DetermineSpellRange -> InqSkillLevel". So the **server range boundary provably uses init+ranks**
  regardless of the `.Current` value at the call site (line 1017 `.Current` feeds power/hit, not
  range) — the client warning boundary in §3.3 will therefore *match* the server reject boundary.
  **Correction #2 (init+ranks, playerStats current/base both wrong) CONFIRMED and reinforced.** ✓
- TargetNotAcquired sends at **139/177/201** (SendUseDoneEvent) + **755** (SendWeenieError). ✓
- Moved-too-far **874-877**: `if (dist > Windup_MaxMove && PlayerKillerStatus != NPK)` →
  WeenieError send **commented out (876)** + `GameMessageSystemChat("Your movement disrupted
  spell casting!")` (877) + Fizzle script. **0x0498 unreachable on vanilla ACE for NPK. CONFIRMED.** ✓
- `Skill.cs`: enum order `ArcaneLore` (index 14 = 0x0E), … `CreatureEnchantment`=31,
  `ItemEnchantment`=32, `LifeMagic`=33, `WarMagic`=34, `Gearcraft`(retired)=42, `VoidMagic`=43
  (0x2B). Confirms 0x2B≠ArcaneLore. ✓  `Player.cs MaxRadarRange_Outdoors = 75.0f`. ✓
- `errors.rs` codes exact: 0x0403 (L120), 0x0407 (124), 0x0408 (125), 0x042C (161), 0x0498
  (241), 0x0550 (420). ✓

**Our code (`apps/holtburger-web`):**
- `spellcast_error_text` **lib.rs:20783** maps 0x400/401/402/407/408/498/550/4EB — **no 0x0403,
  no 0x042C** (target-loss falls through). ✓  §3.1 diff context lines match the live file exactly
  — the hunk applies cleanly.
- **UseDone arm 42385-42420**: always pushes kind=13 (label+code), then kind=2 — TRANSIENT(9) on
  `spellcast_error_text` hit else `[Use failed] {label}` SYSTEM(0). **WeenieError arm 42484-42509**:
  kind=13 + TRANSIENT text *only* on match, else plain SYSTEM line. Behavior exactly as §1.6. ✓
  (Cite drift only: arms are ~42385/~42484, packet said 42368/42457 — the GameEvent match-variant
  starts; behavior identical. Non-blocking.)
- `getSpellRecord` (lib.rs:29585) returns `serde_wasm_bindgen::to_value(&json!{…})` = a JS **Map**
  (default serializer; live-verified in `spellbook.js:184-190` comment `getSpellRecord(6) instanceof
  Map`). Keys `school`(29668), `baseRangeConstant`(29699), `baseRangeMod`(29700),
  `isSelfTargeted`(29694), `isUntargeted`(29695) all present ⇒ §3.3 `rec.get(...)` reads are correct. ✓
- School numbering (lib.rs:29597+) 1=War…5=Void matches InqSkillForSpell inverse. ✓
- Skills snapshot stride-6 `[type,current,base,ranks,training,next_cost]` (lib.rs:35490-35509). ✓
- **(A′) feasibility CHECKED:** `world.player.skill_snapshot()` (types.rs:1970) returns
  `Vec<stats::Skill>`; `stats::Skill` (holtburger-world/src/stats.rs) **has `init: u32` and `ranks:
  u32`** ⇒ the packet's `skill.init + skill.ranks` and `skill.skill_type as u32` **compile**. ✓
- `stats_calc.rs:127-187`: magic skills divisor **4** (default branch), `total_base = round(bonus)
  + ranks + init`; current applies `mult/add` ⇒ the no-rebuild reconstruction `init+ranks = base −
  round((Focus_base+Self_base)/4)` is algebraically valid (its one assumption: the snapshot exposes
  *base* attrs, guarded by the §4.2 test). ✓
- picking.js helpers all present at cited lines: `entityAcPosition`(126), `horizontalDistance`(133),
  `playerWorldPose`(160), `emitActionRejected`(182), armed read(607), `spellCastInitiated` emit(654),
  `turnToFaceThenAct(guid,doCast,CAST_FACE_TARGET)`(701), "Enter magic mode…"(718), `castFaceTarget`
  default-ON via `!== "off"`(54). ✓
- **(B) insertion point APPLICABLE:** inside `if (spellId !== 0)` (610-702), all args
  (`sessionHandle`, `liveScene3d`, `guid`, `spellId`, `getLocalPlayerGuid`) are in scope; the new
  block-level `const localGuid` at ~669 does **not** collide with the try-scoped (622/651) or
  doCast-scoped (690) ones. ✓
- `rejection_feedback.js`: `_onChatReceived`(305) filters `u32Payload2 === 9` → `_renderToast`;
  `_onClientActionRejected`(273) → `_renderToast`; listeners for `clientActionRejected`(317) +
  `kind:2`(319). ⇒ any code added to `spellcast_error_text` auto-renders as a transient toast. ✓
- `spell_shape_preview.js` (agent-sourced §1.9) EXISTS (704 lines): `_tickAllPreviews` rAF loop
  (112/132-140), `TorusGeometry` builders (434/520), `em.entityMap.get` (204-208), `spellCastInitiated`
  handler (554), `colorForSchool` (95), `?projectileArc` (65). armedSpellId set combat-bar.js
  128/737/934, read `window.__combatBarState?.armedSpellId`(913). ✓
- **No cast-cancel regression from (A):** the JS kind=13 consumer (index.html:7808-7842) gates the
  `cancelCastSequence` strictly on `errCode === 0x0402`; a new kind=13/0x042C only produces a benign
  debug log + `kind:13` bus re-emit (which the UseDone arm already emitted for target-loss today).
  Nothing cancels the chain on 0x042C. ✓

**DAT oracle ground truth (WB.Terminal, SpellTable 0x0E00000E):** Flame Bolt I = const 30/mod 0.7,
Flame Bolt II = 30/0.6, Strength Other I = 5/1, Strength Self I = 0/0. Field names
`baseRangeConstant`/`baseRangeMod`/`school` match the wasm exports. **CONFIRMED.** ✓

**Node test §4.1 is runnable + arithmetic correct:** re-ran all seven `determineSpellRange` cases
including the float-sensitive `0.7*64+30` — JS resolves it to exactly `74.8` (strict-equal true),
so `assert.equal` passes. No floating-point defect. ✓

### B. Root-cause / mechanism check (tried to break it, could not)

- The reframe is correct: WS05 is **feedback only**. Retail never gated range client-side
  (DetermineSpellRange is the *examine/tooltip* display fn); the real "run far while the cast keeps
  going" *locomotion* leak is the FU-A / use_time-reclaim issue owned by the movement WS (foundation
  §1.4/§3-S3a). WS05 correctly adds **no movement root**. No counter-example found.
- Because ACE's VerifySpellRange provably uses the same init+ranks + 2D-distance + 75-cap math the
  §3.3 client warning uses, the client preview and server reject agree on the boundary (the only
  divergence is position drift between click-time and windup-check-time — inherent, documented as
  the "double toast" risk). Sound.

### C. REQUIRED corrections before landing (do not block the analysis; do gate the merge)

1. **`castRangeWarn` (B) should ship default-OFF, not default-ON.** It is *net-new* client UX that
   retail did **not** have (retail's DetermineSpellRange fed the examine tooltip, never a pre-cast
   toast), it has a documented double-toast feel issue, AND the packet itself queues it for the 1070
   eye-test (§5). Foundation §4 point 3: "risky/feel changes ship default-OFF pending a 1070 eye-test."
   Flip `castRangeWarn` to **default-OFF (`=on` to enable)** until the eye-test passes, or explicitly
   justify the default-ON exception in the url-flags row. Patch (A) correctly needs no flag; (C)
   `castRangeRing` is correctly default-OFF.
2. **Frame (B) as an ENHANCEMENT, not "retail parity."** The *formula* is retail; the *pre-cast-toast
   application* is new. §2/§3.3's "mirrors retail" reads as parity — state plainly it is proactive
   feedback retail lacked so it's evaluated as an enhancement (this is also why #1 applies).
3. **(A′) diff is a design sketch, not turnkey.** To compile it the implementer must also (a) add the
   `magic_skill_raw` field to the `LatestStats { … }` construction at **lib.rs:35659**, and (b) add
   the field to the `struct LatestStats` def (lib.rs:29033). `stats::Skill.init`/`.ranks` exist so the
   body compiles once wired. Call this out so integration doesn't ship a half-wired struct.

### D. Non-blocking notes

- Consider taking the §3.1 "optional fidelity nit" (drop trailing periods on 0x0407/0x0408, capital-R
  "Out of Range!") in the same hunk — it's byte-exact-retail and free while the file is open.
- Unrelated pre-existing drift spotted (NOT WS05's to fix): index.html:7830 comment says castFizzle is
  "Default-off" but the code (`!== "off"`, :7834) and foundation §1.2 say default-**ON**. Flag for the
  owning WS.

**Bottom line:** the investigation is correct end-to-end (both foundation corrections verified),
the DAT/decomp/ACE triangulation is solid, patch (A) is unambiguously good and safe, (B)/(C) are
sound pending the flag-default fix (#1) and (A′) completion (#3). Apply.

```json
{"workstream":"WS05","verdict":"CONFIRMED","apply":true,"mustFix":["Ship castRangeWarn (B) default-OFF pending the 1070 eye-test (foundation §4 pt3: net-new feel change + documented double-toast + already queued for eye-test), or explicitly justify the default-ON exception in the url-flags row","Complete the (A′) sketch: add magic_skill_raw to the LatestStats{} construction at lib.rs:35659 AND to the struct LatestStats def (lib.rs:29033) — body compiles since stats::Skill has init+ranks","Frame (B) in the packet/url-flags as an ENHANCEMENT (retail formula, new pre-cast toast application) rather than 'retail parity'"],"notes":"All load-bearing cites re-verified live on buildbox — zero failed. Both foundation corrections CONFIRMED: max-of-5 (0x2B=VoidMagic not ArcaneLore/0x0E, a max not a clamp) via instruction-trace of acclient.c:228548-573; target-loss=0x042C not 0x0403. ACE VerifySpellRange (Player_Magic.cs:492-497) OVERRIDES magicSkill to init+ranks for player casts, proving the init+ranks claim and that client warning == server reject boundary. spellcast_error_text (lib.rs:20783) lacks both codes; both toast arms behave as §1.6; getSpellRecord returns a JS Map with all needed keys; stats::Skill has init+ranks so (A′) compiles; picking.js (B) insertion applicable with no const collision; index.html:7832 gates cast-cancel on 0x0402 only so (A) is regression-free. DAT oracle confirms Flame Bolt I 30/0.7, Strength Self I 0/0. Node §4.1 test runs green incl float-equality. Only issues are flag-convention (B default) + (A′) completeness + framing — not correctness."}
```
