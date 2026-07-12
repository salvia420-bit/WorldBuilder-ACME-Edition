# WS09 — CasterEffect / TargetEffect / FizzleEffect VFX parity

**Investigator:** WS09 (deep pass) · **Date:** 2026-07-12 · **Confidence:** high
**Scope:** spell VFX correctness for war + void casts — the CasterEffect double-fire,
TargetEffect wire delivery, fizzle VFX + sound, and formulaScale semantics.
**Baseline:** `external/holtburger` (read-only). Every cite below opened live this session;
DAT facts pulled from the WB.Terminal oracle; formulaScale claim empirically re-verified with `node`.

> **Headline (read this first):** Three of the four charter symptoms are already
> handled correctly by the existing wire path or are non-issues for war/void; the
> real, fixable defects are narrow. Specifically:
> 1. **formulaScale is CORRECT** — it is a script-SELECTION mod and the resolver uses it
>    as one (27/27 decomp-parity proven). The charter's premise "our resolver passes it as
>    speed" is a **variable-naming artifact**, not a behavioral bug. No functional fix needed.
> 2. **The CasterEffect double-fire is REAL** but fires **only for the ~74 non-war/void
>    spells** (portals / lifestones / life-buffs). Every war (school 1) and void (school 5)
>    spell has `caster_effect = 0`, so the synthetic emit never runs for them.
> 3. **TargetEffect is ALREADY delivered by the wire** for both local and remote victims —
>    the `entities.js` "synthesize TargetEffect" TODO is unnecessary and should be closed.
> 4. **The one genuine VFX gap for fizzle (and all wire PlayScripts) is SOUND** — the
>    PlayEffect resolver spawns particle hooks only and silently drops the Fizzle script's
>    `SoundTable` hook, so fizzles (and cast/launch/impact cues) are silent.

---

## 0. Method / sources

- **Our code:** `scene3d/entities.js`, `scene3d/play_effect_vfx.js`, `index.html`,
  `src/lib.rs`, `crates/holtburger-world/src/handlers/system.rs`.
- **Decomp (retail ground truth):** `/home/wbterminal/ac-headers/acclient.c`.
- **ACE reference (server truth):** `external/ACE/Source/ACE.Server/WorldObjects/*`,
  `external/ACE/.../ACE.Entity/Enum/PlayScript.cs`.
- **DAT oracle:** WB.Terminal `chorizite-parse-dat-record` on `client_portal.dat`.
- **Spell data:** LSD `spells.json` (`table.spellBaseHash`, 6266 spells) + client
  `data/spell-cast-sequence.json` (generated, matches LSD).
- **Empirical:** `node` picker parity harness (see §4).

---

## 1. VERIFIED FINDINGS

### F1 — `formulaScale` is a script-SELECTION mod, NOT a playback speed (CONFIRMED; charter hypothesis disproven)

**Decomp — `PhysicsScriptTableData::GetScript` (acclient.c:336552):**
```c
v3 = this->script_array.m_num;
v5 = this->script_array.m_data;
while ( mod > (double)v5->mod ) {        // walk while requested mod exceeds this entry's threshold
    ++v4; ++v5;
    if ( v4 >= v3 ) goto LABEL_5;        // overflow → default id
}
result->id = v5->script_id.id;           // first entry whose mod >= requested mod
...
LABEL_5: result->id = stru_8444D0.id;    // stru_8444D0 = global default IDClass (id 0 = "no script")
```
`mod` walks an array of `ScriptAndModData {float mod; IDClass script_id}` and **returns a
script DID**. It is a threshold selector.

**Decomp — the DID is played with NO speed (acclient.c:320326 `CPhysicsObj::play_script`):**
```c
PhysicsScriptTable::GetScript(v5, (IDClass<...>*)&mod, script_type, mod);   // mod → selected DID (in place)
result = CPhysicsObj::play_script_internal(v3, LODWORD(mod));               // plays the DID; mod not forwarded
```
`play_script_internal` (acclient.c:318035) → `ScriptManager::AddScript(script_id)` — **the
selected script plays at its intrinsic emitter rate; `mod` never becomes a playback speed.**

**DAT — real mod ladders (oracle, `PhysicsScriptTable 0x34000004`):** entries per PScriptType
are `{mod:0, 0.25, 0.5, 0.75, 1}` or `{0, 0.5, 1}` (max mod = **1.0** across the whole table).

**Spell data — `formulaScale` values (LSD/`spell-cast-sequence.json`):** `{0.05, 0.2, 0.4,
0.5, 0.6, 1.0}` — one per spell **level** (I…VI). This is `spell.Formula.Scale`, the intensity
grade. A level-I buff (0.05) selects the subtle variant; level-VI (1.0) the dramatic one. If
0.05 were a playback speed the effect would run **20× too slow** — it is unambiguously a selector.

**Our code is already correct — `speed` is used ONLY for selection:**
- `play_effect_vfx.js:1280` `const picked = pickScriptEntry(entries, speed);` — the sole use.
- Traced the emitter spawn (`_tryResolveRealVfx` :1223–1600): `speed` is **not** applied to
  any emitter rate/timescale; StartTime scheduling comes from the hook's own `startTime`.
- The parameter is merely **named** `speed` (play_effect_vfx.js:1223, :1882; index.html:7389;
  entities.js:6896) — a misnomer that misled this charter's own framing.

**Empirical (this session):** `pickScriptEntry` matches a from-decomp reference over the
**entire reachable domain [0, 1.0]** against the real ladders: **27/27 match, 0 mismatch**;
the module's own picker self-tests **8/8 pass**. Only divergence: `scale=2.0` (client clamps
to last entry `104`; decomp returns `null`) — **unreachable** because both max mod and max
`formulaScale` are 1.0.

> **Conclusion:** `formulaScale` flows correctly. No functional fix. Optional cosmetic:
> rename `speed`→`scaleMod` and add a one-line "unreachable overflow divergence" note (§3-D).
> **This is a confirmed fact, not a hypothesis.**

---

### F2 — The wire delivers CasterEffect to the LOCAL caster → the synthetic emit double-fires (REAL; narrow scope)

**ACE broadcasts CasterEffect including to self (WorldObject_Magic.cs:356–359):**
```csharp
protected void DoSpellEffects(Spell spell, WorldObject caster, WorldObject target, bool projectileHit = false)
{
    if (spell.CasterEffect != 0 && (!spell.IsProjectile || !projectileHit))
        caster.EnqueueBroadcast(new GameMessageScript(caster.Guid, spell.CasterEffect, spell.Formula.Scale));
```
**`EnqueueBroadcast(params GameMessage[])` sends to self by default (WorldObject_Networking.cs:1428–1432):**
```csharp
if (sendSelf) {
    if (this is Player self)
        self.Session.Network.EnqueueSend(msgs);          // ← local caster receives its own CasterEffect
}
```
**The wire copy reaches the local rig with no self-filter:**
- protocol `0xF755 GameMessageScript` → `GameMessage::PlayEffect`.
- `holtburger-world/src/handlers/system.rs:25–37`: `WorldEvent::PlayEffect { target, script_id, speed }`
  — passes `data.target` through verbatim, **no self-filter**.
- `src/lib.rs` `CLIENT_EVENT_KIND_PLAY_EFFECT = 30` (:21073); `u32Payload=target guid`, `f32Payload=scale`.
- `index.html:7387–7395`: `emit("playEffect", { targetGuid, scriptId, speed })`.

**The client ALSO synthesizes the same effect at chain end (entities.js:6884–6908):**
```js
if (inst._castSequenceToken !== token) return;
if ((seq.casterEffect | 0) !== 0) {
    window.__pluginClient.events.emit("playEffect", {
        targetGuid: g >>> 0,
        scriptId: (seq.casterEffect | 0) >>> 0,
        speed: Number.isFinite(seq.formulaScale) ? +seq.formulaScale : 1.0,
    });
}
```
Both land on the same `targetGuid` (local caster) with the same `scriptId` → **two PlayEffect
dispatches → the CasterEffect glow flashes twice.** This is already documented + empirically
observed by the existing `?castVfxDedup` flag (play_effect_vfx.js:1646–1652, "the glow flashes
twice"), which is **still default-OFF** (not in url-flags.md's "Now default-ON" list, line 12).

**Scope (measured):** the synthetic is guarded by `if (seq.casterEffect !== 0)`. Only
**74 / 6266** spells have `caster_effect ≠ 0`, and **every one is a portal / lifestone /
recall / life-buff** (LSD: spell 47 Primary Portal Tie `caster_effect=16` = AttribUpPurple
0x10; 1635 Lifestone Recall `caster_effect=14` = AttribUpBlue). **War (school 1, 691 spells)
and Void (school 5, 76 spells) ALL have `caster_effect=0`** → the synthetic never fires for a
war or void cast. So the double-fire is a **non-issue for the charter's literal war/void
scope, but a real defect for portal/lifestone/buff casts** (WS09 owns overall VFX correctness).

**Timing (retail parity):** the synthetic fires at **local chain completion** (client-predicted,
no RTT); the wire fires when the server's `DoSpellEffects` broadcast arrives (**cast RELEASE +
RTT**). Retail played the effect at release — i.e. the **wire timing is the correct one**.
Additionally, **ACE does NOT broadcast CasterEffect on a fizzle** — `Player_Magic.cs:917`
sends `PlayScript.Fizzle` + `WeenieError.YourSpellFizzled` and `DoSpellEffects` runs only on
`CastingPreCheckStatus.Success` — so relying on the wire **auto-suppresses CasterEffect on
fizzle for free** (no client `_castSequenceToken` guard needed for that copy).

---

### F3 — TargetEffect is ALREADY delivered by the wire (local AND remote victim) — the synthesis TODO is unnecessary (CONFIRMED)

**ACE (WorldObject_Magic.cs:361–365):**
```csharp
if (spell.TargetEffect != 0 && (!spell.IsProjectile || projectileHit) && target != null) {
    var targetBroadcaster = target.Wielder ?? target;
    targetBroadcaster.EnqueueBroadcast(new GameMessageScript(target.Guid, spell.TargetEffect, spell.Formula.Scale));
}
```
- **Local victim** (self-buff / self-cast promoted to targeted per foundation §1.1, or another
  player casting on you): `targetBroadcaster == target == local player` → `sendSelf` delivers it.
- **Remote victim:** the local player is a known player near the target → receives the
  broadcast; `target.Guid` is a visible entity already in the local `entityMap` → the resolver
  anchors the effect to the remote rig.
- Same wire path as F2 (0xF755 → kind=30 → `playEffect`), same no-self-filter world handler,
  same `_onPlayEffect` dispatch (`play_effect_vfx.js:1875`) which has **no self/target filter**
  (only `targetGuid==0` skip, dedup, and queue-on-miss).

**entities.js:6865–6877** proposes threading `SpellId` through damage events to synthesize
TargetEffect on the victim. **This is unnecessary** — the wire already carries TargetEffect with
the correct `target.Guid` and `Formula.Scale`. The projectile-hit gating (`!IsProjectile ||
projectileHit`) is handled server-side; for a projectile war/void bolt the TargetEffect (when
non-zero) fires at impact and arrives on the wire then.

> **Conclusion:** close the TODO; update the stale comment. No client synthesis. The only
> action is a **laptop render-verification** (§4) that the wire-driven TargetEffect actually
> paints on both a remote victim and the local player (self-buff). Confirmed-by-code; render
> verification is the remaining unknown.

---

### F4 — Fizzle VFX renders from the wire (particle), but the fizzle SOUND is silently dropped (REAL GAP — the primary fixable defect)

- **No per-spell fizzle effect exists.** `fizzle_effect = 0` for **all 6266** spells (LSD).
  Fizzle VFX is the **generic** wire `PlayScript.Fizzle` (0x51) @ scale **0.5**
  (`Player_Magic.cs:879` and `:917`: `EnqueueBroadcast(new GameMessageScript(Guid, PlayScript.Fizzle, 0.5f))`).
- **The Fizzle script resolves** in the caster table — oracle: `PhysicsScriptTable 0x34000004`
  has `Fizzle → {mod:1, script 0x33000103}`; `pickScriptEntry([{mod:1}], 0.5)` picks it. ✓
- **DAT — the Fizzle PhysicsScript `0x33000103` has exactly two hooks:**
  `CreateParticle` (hookType 13) **+ `SoundTable` (hookType 2)**.
- **The resolver drops the sound.** `play_effect_vfx.js:1315–1323` only counts/spawns
  `hookType === 13 || hookType === 26`; the comment at :1306–1309 asserts sound hooks are
  "handled by the H2 entity chain walker, not the PlayEffect one-shot path" — but the H2 walker
  only runs for **entity-spawn** scripts, **not** for wire PlayEffect one-shots. So the fizzle
  `SoundTable` hook is **never played**.
- Hook-type numbering confirmed in `src/lib.rs:18605–18642`: `1=Sound, 2=SoundTable,
  13=CreateParticle, 21=SoundTweaked, 26=CreateBlockingParticle`.
- **This gap is general:** it silences **every** wire PlayScript's audio — fizzle, and (via the
  same resolver) cast/buff cues and projectile **Launch/Explode** sounds for war/void bolts.
- **Current client fizzle handling** (index.html:7832–7842, `?castFizzle` **default-ON** — the
  inline "Default-off" comment is stale vs the `!== "off"` code and foundation §1.2) only calls
  `cancelCastSequence(localGuid)`; it synthesizes no VFX and no sound.
- **The audio mechanism to reuse already exists:** entities.js caches `inst.soundTableDid`
  (:3851) and plays `SoundTable` hooks via `soundTableCache.resolveSound(inst.soundTableDid,
  soundEnum)` through the shared `_fireHook` executor (foundation §1.6; entities.js:2395–2432,
  10428–10530). The resolver can route its Sound/SoundTable/SoundTweaked hooks through the same
  path.

---

### F5 — Data reframing: war/void DAMAGE spells don't use CasterEffect/TargetEffect at all (context)

LSD ground truth (school 1 = War, school 5 = Void):

| Spell | school | caster_effect | target_effect | VFX source |
|---|---|---|---|---|
| 27 Flame Bolt I | 1 War | 0 | 0 | projectile Launch/Explode/collision |
| 64 Shock Wave I | 1 War | 0 | 0 | projectile |
| 5349 Nether Bolt I | 5 Void | 0 | 0 | projectile |
| 5345 Nether Streak V | 5 Void | 0 | 0 | projectile |
| 5339 Destructive Curse I | 5 Void | 0 | **167 (0xA7 HealthDownVoid)** | target debuff on victim |
| 5xxx RegenDown/SkillDown void curses | 5 Void | 0 | 168/169 (0xA8/0xA9) | target debuff |
| 47 Primary Portal Tie | 3 ItemEnch | 16 (0x10 AttribUpPurple) | 17 (0x11 AttribDownPurple) | caster+target glow |

- **War damage (691 spells): `caster_effect=0`; `target_effect=0` for 686 of 691.** The visible
  effect is entirely the **projectile** (`Launch 0x04`, `Explode 0x05`, `ProjectileCollision
  0x5A`) — WS10's data domain, but **rendered by WS09's `play_effect_vfx.js` resolver**.
- **Void (76 spells): `caster_effect=0`.** Direct-damage void bolts/streaks have
  `target_effect=0` (projectile VFX); void DoT curses carry `target_effect` = `HealthDownVoid
  0xA7` / `RegenDownVoid 0xA8` / `SkillDownVoid 0xA9`, all present in the target's
  PhysicsScriptTable (oracle: `HealthDownVoid → 3 mod-graded entries`). These render via the
  wire target path (F3).
- **Launch/Explode/ProjectileCollision are ABSENT** from the creature table `0x34000004` — they
  live on the **projectile entity's own** PhysicsScriptTable (WS10 nuance). When a projectile
  has no table, the resolver falls back to the shipped placeholder Launch/Explode bursts
  (VFX_COVERAGE, play_effect_vfx.js:2919–2935), so war/void bolts always show *something*.

---

## 2. ROOT CAUSES

| Symptom | Mechanism (proven) | Proof |
|---|---|---|
| CasterEffect glow flashes twice (portal/lifestone/buff casts) | Client mirrors the SERVER's `DoSpellEffects` broadcast on the CLIENT (synthetic emit) while the real server broadcast also arrives at the local caster (`EnqueueBroadcast sendSelf=true`, no world self-filter). Two emits → two bursts. | ACE :358 + Networking :1428 + system.rs :25 + entities.js :6893; F9-3 empirical |
| CasterEffect at wrong time | Synthetic fires at LOCAL chain end (predicted, ÷CAST_SPEED, no RTT); retail plays it at server RELEASE. | entities.js :6816/:6884 vs ACE :348/:358 |
| Fizzle (and cast/launch/impact) is SILENT | Resolver's hook filter spawns particle hooks (13/26) only; the Fizzle script's `SoundTable` (2) hook — and all Sound/SoundTweaked hooks on wire PlayScripts — are dropped. | play_effect_vfx.js :1315–1323; DAT 0x33000103 hooks |
| "TargetEffect never plays" (perceived) | Not a defect: the wire already delivers TargetEffect to local + remote victims; the `entities.js` synthesis TODO is stale. | ACE :361 + Networking :1428 + system.rs :32 |
| "formulaScale passed as speed" (perceived) | Not a defect: `speed` is the GetScript selection mod and is used as one; the name is misleading. | acclient.c :336552/:320340/:318059; 27/27 parity |

---

## 3. PATCH PLAN

Conventions per foundation §4 + `docs/url-flags.md`: default-behavior changes ride a URL flag
with an `=…` escape; risky/feel/audio changes ship **default-OFF** pending a batched eye/ear-test
(queued in §5, not run here). All diffs below are minimal and reversible. **Only `entities.js`,
`play_effect_vfx.js`, and `docs/url-flags.md` are touched** (plus optional index.html rename in D).

### Patch A — Kill the CasterEffect double-fire by making the wire the sole source (flag: `castSyntheticCasterVfx`, default OFF)

Rationale: the wire copy is retail-correct in timing (release) and fizzle-suppression; the
synthetic is the redundant, early, portal/buff-only copy. Gate it OFF by default; keep an
escape to restore it for offline / no-server prediction feel. (This is preferred over flipping
`castVfxDedup` on because dedup keeps two code paths and — being first-wins — would let the
*early* synthetic win, i.e. the wrong timing.)

**A1 — add the flag const next to the other cast flags (entities.js, after the `CAST_STATE_MACHINE` block ~:927):**
```js
// WS09 (2026-07-12) — `?castSyntheticCasterVfx=on` (default OFF). ACE broadcasts the
// CasterEffect GameMessageScript to the LOCAL caster too (EnqueueBroadcast sendSelf=true,
// WorldObject_Networking.cs:1428), so the wire already delivers it via 0xF755→kind=30→
// playEffect at cast RELEASE. The chain-end synthetic emit below therefore DOUBLE-FIRES
// (and too early). Default OFF = wire is the sole CasterEffect source (retail timing;
// auto-suppressed on fizzle since ACE sends PlayScript.Fizzle, not CasterEffect). `=on`
// restores the synthetic for offline / no-server prediction feel.
const CAST_SYNTHETIC_CASTER_VFX = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castSyntheticCasterVfx") === "on";
  } catch (_) { return false; }
})();
```

**A2 — gate the emit (entities.js:6885):**
```diff
     if (inst._castSequenceToken !== token) return;
-    if ((seq.casterEffect | 0) !== 0) {
+    // WS09: the wire GameMessageScript already delivers CasterEffect to the local
+    // caster at server RELEASE; the synthetic chain-end emit is a double-fire.
+    // Off by default (?castSyntheticCasterVfx=on to restore for offline testing).
+    if (CAST_SYNTHETIC_CASTER_VFX && (seq.casterEffect | 0) !== 0) {
       try {
         if (
           typeof window !== "undefined" &&
           window.__pluginClient &&
```
Byte-identical arm: with `?castSyntheticCasterVfx=on` the emit runs exactly as today.

> **Alternative (lower-churn fallback if integration prefers it):** flip `castVfxDedup`
> default-ON instead (one-word change: play_effect_vfx.js:1658 `=== "on"` → `!== "off"`, plus
> its url-flags row). Keeps both emits but dedups within 2 s (first-wins). Accepts the
> early-timing artifact. Patch A is the recommended primary.

### Patch B — Play wire PlayScript sounds (fizzle + cast + launch/explode) (flag: `playEffectSound`, default OFF) — coordinate WS08

Extend `_tryResolveRealVfx` so that, alongside the particle hooks, it fires the script's
`Sound (1)` / `SoundTable (2)` / `SoundTweaked (21)` hooks through the same audio path the
entity gesture walker uses. Concrete shape (implementation lands on laptop against the live
`soundTableCache` API):

**B1 — flag const (play_effect_vfx.js, near the other flag IIFEs ~:1655):**
```js
// WS09 (2026-07-12) — `?playEffectSound=on` (default OFF). The PlayEffect resolver spawns
// particle hooks (13/26) only, dropping the Sound(1)/SoundTable(2)/SoundTweaked(21) hooks
// carried by wire PlayScripts — so fizzle (0x51 has a SoundTable hook), cast cues, and
// projectile Launch/Explode all play SILENT. When on, those hooks fire through the entity's
// soundTableCache (same mechanism as the gesture/H2 walker). Default OFF pending an ear-test.
const PLAY_EFFECT_SOUND_ON = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("playEffectSound") === "on";
  } catch (_) { return false; }
})();
```

**B2 — in the hook loop (play_effect_vfx.js:1391, the `for (const e of entriesJs)` walk), add
a sound branch parallel to the particle branch:**
```js
// WS09: fire audio hooks (retail Fizzle 0x33000103 = CreateParticle + SoundTable).
if (PLAY_EFFECT_SOUND_ON && (e.hookType === 1 || e.hookType === 2 || e.hookType === 21)) {
  const delayMs = Math.max(0, (+e.startTime || 0) * 1000);
  setTimeout(() => {
    if (!em.entityMap?.has?.(targetGuid >>> 0)) return;
    // Reuse the entity walker's sound path: SoundTable(2) → soundTableCache.resolveSound(
    //   inst.soundTableDid, e.soundTableSoundEnum); Sound(1) → e.soundWaveDid; SoundTweaked(21)
    //   → e.soundWaveDid + gain/pitch. Route through the same _playWave/_fireHook sink the
    //   gesture hooks use (entities.js:10428+). Exact getter names per lib.rs:18641-18680.
    em._firePlayEffectSoundHook?.(targetGuid >>> 0, e);
  }, delayMs);
  continue;
}
```
This needs one tiny EntityManager helper (`_firePlayEffectSoundHook`) or direct reuse of the
existing sound sink — a laptop task; the mechanism is proven to exist (F4).

**WS08 coordination:** WS08 owns the fizzle *lifecycle* (cancel chain + toast on WeenieError
0x0402). WS09 owns the fizzle *VFX + sound from the wire Fizzle script*. **WS08 must NOT also
synthesize a separate fizzle sound** once `playEffectSound` is on, or the fizzle will double up.
Boundary: WS08 = kind=13 error → cancel + toast; WS09 = kind=30 Fizzle(0x51) → particle + sound.

### Patch C — Close the stale TargetEffect synthesis TODO (comment-only, no flag)

Replace entities.js:6865–6877 with a note that the wire path already delivers TargetEffect to
local + remote victims (F3), so no client synthesis is warranted:
```diff
-    // TargetEffect deferred: ACE fires TargetEffect on the TARGET via
-    // a separate `GameMessageScript(target.Guid, spell.TargetEffect,
-    // spell.Formula.Scale)` broadcast at `WorldObject_Magic.cs:361-365`,
-    // gated on `projectileHit` for projectile spells. Wiring this in
-    // the client requires attributing `damageDealt` events back to
-    // the SpellId that produced them; per the Wave 13/14 audit ACE's
-    // `damageDealt` payload does NOT carry SpellId. TODO follow-on:
-    // ...
+    // TargetEffect needs NO client synthesis (WS09 2026-07-12): ACE broadcasts
+    // GameMessageScript(target.Guid, spell.TargetEffect, Formula.Scale) at
+    // WorldObject_Magic.cs:361-365 with sendSelf=true, so the wire already
+    // delivers it to the LOCAL victim (self-buff / self-cast) AND — via the
+    // known-players broadcast — to observers of a REMOTE victim, on the victim's
+    // guid. It arrives as 0xF755 → kind=30 → playEffect and renders through the
+    // same resolver (system.rs applies no self-filter). Do not synthesize it here.
```
No behavior change (this arm is comment/TODO text). Rendering must still be verified live (§4).

### Patch D — (optional, low priority) formulaScale naming + overflow note

Pure clarity, no behavior change. Because a full `speed`→`scaleMod` rename touches
play_effect_vfx.js + index.html + entities.js (merge-conflict surface with WS08/WS10), prefer a
**minimal clarifying comment** at the two hot sites rather than a sweeping rename:
- play_effect_vfx.js:1278 and :1882 — note "`speed` is the GetScript selection **mod**
  (acclient.c:336552), not a playback rate."
- play_effect_vfx.js:924–950 (`pickScriptEntry` doc) — note the overflow clamp diverges from
  the decomp (decomp returns id 0; we clamp to the greatest-mod entry) but is **unreachable**
  for real casts (max spell `Formula.Scale` = 1.0 = max table mod). Leave the clamp as-is (a
  non-empty burst is a friendlier failure than silence for the unreachable case).

### url-flags.md rows (draft, matching the existing table format)

```
| `castSyntheticCasterVfx` | `off` | on (escape restores synthetic) | WS09: the wire GameMessageScript already delivers CasterEffect to the local caster at cast RELEASE (EnqueueBroadcast sendSelf=true); the chain-end synthetic emit double-fires the glow. Default OFF = wire is the sole source (retail timing; auto-suppressed on fizzle). `=on` restores the synthetic for offline / no-server prediction. Only affects the ~74 caster_effect≠0 spells (portals/lifestones/buffs); war+void are caster_effect=0. | scene3d/entities.js |
| `playEffectSound` | `off` | on | WS09: the PlayEffect resolver fires Sound/SoundTable/SoundTweaked hooks on wire PlayScripts (fizzle 0x51, cast cues, projectile Launch/Explode) through soundTableCache — previously particle-only, so all wire VFX played silent. Default OFF pending an ear-test; coordinate with WS08 (WS08 must not double the fizzle sound). | scene3d/play_effect_vfx.js |
```

---

## 4. TESTS

### T1 — `pickScriptEntry` decomp-parity (RUNS TODAY — verified green this session)

A standalone `node` test that asserts our picker matches a from-decomp `GetScript` reference
over the reachable formulaScale domain against the real mod ladders. Drop as
`external/holtburger/apps/holtburger-web/test_ws09_formula_scale_parity.mjs` (reuses the
existing three-stub loader `_three_stub_loader.mjs` that `test_play_effect_resolver.mjs`
generates). Body (already validated — output: `8/8 pass`, `27/27 match, 0 mismatch`):
```js
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./_three_stub_loader.mjs", pathToFileURL("./"));
globalThis.window = globalThis.window || {};
const { pickScriptEntry, __test } = await import("./scene3d/play_effect_vfx.js");
const self = __test.runPickerSelfTests();
if (self.failed) { console.error("picker self-tests failed", self); process.exit(1); }
// decomp reference — acclient.c:336552 (first entry where mod<=e.mod; overflow → null)
const decomp = (es, mod) => { for (const e of es) if (!(mod > e.mod)) return e; return null; };
const ladders = [
  [{mod:0,scriptDid:100},{mod:0.25,scriptDid:101},{mod:0.5,scriptDid:102},{mod:0.75,scriptDid:103},{mod:1,scriptDid:104}],
  [{mod:0,scriptDid:200},{mod:0.5,scriptDid:201},{mod:1,scriptDid:202}],
  [{mod:1,scriptDid:300}],
];
let mism = 0, total = 0;
for (const L of ladders) for (const s of [0,0.05,0.2,0.25,0.4,0.5,0.6,0.75,1.0]) {
  total++;
  const a = pickScriptEntry(L, s)?.scriptDid ?? null;
  const b = decomp(L, s)?.scriptDid ?? null;
  if (a !== b) { mism++; console.error(`MISMATCH mods=${L.map(e=>e.mod)} scale=${s} client=${a} decomp=${b}`); }
}
if (mism) process.exit(1);
console.log(`WS09 formulaScale parity: ${total}/${total} match, picker ${self.passed}/${self.total}`);
```

### T2 — dedup / synthetic-gate unit (new, small)

Add to `test_play_effect_resolver.mjs` (it already stubs `window` + `__pluginClient`):
1. With `castVfxDedup` on, emit two identical `playEffect{guid,scriptId}` within the window →
   assert exactly one `_dispatchResolvedPlayEffect` runs (spy on `__test.onPlayEffect` +
   `realVfxStats().attempts`).
2. Sanity: two *different* scriptIds on the same guid → two dispatches (dedup key includes scriptId).

### T3 — resolver sound-hook unit (new, guards Patch B)

Feed `_tryResolveRealVfx` a stubbed PhysicsScript whose `takeEntries()` returns
`[{hookType:13,...}, {hookType:2, startTime:0, ...}]` (mirrors Fizzle 0x33000103). Assert:
with `playEffectSound` off → the sound sink is **not** called (regression guard); with it on →
the sound sink **is** called once with the SoundTable enum. (The harness's stub gap at
play_effect_vfx.js:1530 — `_particleEmittersForGuid` undefined when `particleOwner` is off under
Node — should be fixed in the test stub while here; it is a pre-existing harness bug, not a
source bug, and blocks the existing end-to-end cases.)

### TODO-FOR-LAPTOP — headless / live validation recipe

**No live ACE and no browser on this box.** On the laptop:

```
# Serve + headless bot (foundation §5):
python3 external/holtburger/scripts/serve.py            # :8765
URL: http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&\
netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1
# poll window.__bootState==='in-world'
```

Console snippet — read the WS09 diag counters (the VFX diag surface is the play_effect_vfx
module singleton; re-import to reach it):
```js
const vfx = await import('/apps/holtburger-web/scene3d/play_effect_vfx.js');
const before = vfx.__test.realVfxStats();        // { attempts, resolved, missNo* ... }
```

Case 1 — **CasterEffect double-fire (portal/lifestone spell)**: arm & cast a caster_effect≠0
spell (e.g. **1635 Lifestone Recall** at a lifestone, or **157 Summon Primary Portal I**).
- **Default (fix, `castSyntheticCasterVfx` OFF):** expect **one** `realVfxStats.attempts`
  increment for the caster glow (from the wire), timed at release.
- **`?castSyntheticCasterVfx=on`:** expect **two** attempts (synthetic + wire) → the double-flash.
- Assert: `after.attempts - before.attempts === 1` (default) vs `=== 2` (escape on).

Case 2 — **TargetEffect renders on victim (F3)**: cast a target_effect≠0 debuff on a creature
(remote victim) e.g. **37 Blade Bane I** (target 61), and a self-buff on the local player
(local victim) e.g. a Missile Weapon Mastery Self spell (target 18). Assert a `playEffect`
dispatch on the victim's guid and a non-`missNoEntity` resolve; eye-confirm the glow on the
correct rig. Void: **5339 Destructive Curse I** (target 0xA7 HealthDownVoid) on a creature.

Case 3 — **Fizzle sound (Patch B)**: force a fizzle (low-skill spell or drained mana) →
WeenieError 0x0402.
- **Default (`playEffectSound` OFF):** fizzle particle "poof" plays, **no sound** (regression baseline).
- **`?playEffectSound=on`:** fizzle particle **and** the SoundTable "sizzle" both play. Ear-confirm.

Case 4 — **war/void bolt sound (Patch B, cross-check WS10)**: cast **27 Flame Bolt I** / **5349
Nether Bolt I**; with `?playEffectSound=on` confirm Launch (cast) + Explode (impact) sounds.

---

## 5. EYE-TEST QUEUE (batched — do NOT run a solo 1070 session)

| # | Flag combo | Spell | Expected visual/audio |
|---|---|---|---|
| E1 | *(default)* `castSyntheticCasterVfx=off` | 1635 Lifestone Recall / 157 Summon Portal | CasterEffect glow flashes **once**, at cast release (no double flash). |
| E2 | `?castSyntheticCasterVfx=on` | same | glow flashes **twice** (confirms the escape restores legacy). |
| E3 | `?playEffectSound=on` | any fizzle (force low-skill) | fizzle particle **+ sizzle sound**; flag off = silent poof. |
| E4 | `?playEffectSound=on` | 27 Flame Bolt I, 5349 Nether Bolt I | launch + impact **sounds** play with the projectile VFX. |
| E5 | *(default)* | 37 Blade Bane I (remote), Missile Mastery Self (local), 5339 Destructive Curse I | TargetEffect glow paints on the correct victim rig (remote + local + void 0xA7). |

Note: the 2026-07-11 USER 1070 sign-off (url-flags.md §7) cleared the pending eye-test queue for
default-ON surfaces; these are **new** default-OFF flags, so they still need the batched pass.

---

## 6. RISKS + cross-workstream interactions

**Files WS09 would touch (for integration ordering):**
- `scene3d/entities.js` — Patch A (flag const + emit gate), Patch C (comment), Patch D (opt comment).
  ⚠ **Heavily shared** — WS06/07/08/13/14 all touch entities.js cast paths. Patch A is a
  self-contained 2-hunk change near :896–927 and :6885; low conflict surface but sequence it.
- `scene3d/play_effect_vfx.js` — Patch B (flag + sound-hook branch), Patch D (opt comment).
  ⚠ Shared with WS10 (projectile VFX) and the particle-owner work. Patch B adds a branch in the
  existing hook loop; keep it additive.
- `docs/url-flags.md` — two new rows.
- `index.html` — **only** if Patch D does the full rename (not recommended); otherwise untouched.
- Tests: `test_ws09_formula_scale_parity.mjs` (new), `test_play_effect_resolver.mjs` (extend).

**Risks:**
1. **Patch A regression if the wire CasterEffect ever fails to render for the local caster.**
   Mitigated: the F9-3 note proves it renders (it flashes twice today), the resolver is
   identical for wire vs synthetic, and the escape flag restores the synthetic instantly.
2. **Patch B audio spam / double sound.** SoundTable resolution needs the correct sound sink and
   dedup; and WS08 must not also play a fizzle sound. Default-OFF + ear-test contains this.
3. **`castSyntheticCasterVfx` naming collision** with WS08/WS14 recast work — confirm no other
   workstream introduces a same-named flag; coordinate the url-flags.md row insertion.
4. **Projectile-table dependency (WS10).** War/void bolt Launch/Explode resolve against the
   *projectile's* PhysicsScriptTable (absent from creature tables). WS09's resolver is correct;
   if WS10 changes projectile-entity table wiring, re-verify E4.
5. **Test-harness stub gap** (play_effect_vfx.js:1530 under Node with `particleOwner` off) blocks
   the existing end-to-end resolver test's later cases — pre-existing, fix in the test stub
   when landing T2/T3.
6. **No live-wire capture from this box** — Cases 1–4 and E1–E5 are the required laptop
   confirmations before flipping any of these flags default-ON.

**Interactions (behavioral, not file):**
- **WS08 (fizzle/recast/sound):** shares the fizzle story — WS08 owns cancel+toast (kind=13),
  WS09 owns fizzle VFX+sound from the wire Fizzle script (kind=30). Split documented in Patch B.
- **WS10 (projectiles):** war/void damage VFX is projectile-driven and rendered by WS09's
  resolver; Patch B's sound also covers Launch/Explode.
- **WS06/07 (remote casters):** F3's remote-victim TargetEffect rendering depends on the remote
  rig being in `entityMap` (it is, for visible entities) — no new dependency.

---

```json
{"workstream":"WS09","title":"CasterEffect / TargetEffect / FizzleEffect VFX parity","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS09-vfx-effects.md","confidence":"high","keyFindings":["formulaScale is a script-SELECTION mod (acclient.c:336552), NOT a playback speed — the resolver already uses it correctly via pickScriptEntry (27/27 decomp-parity, 8/8 picker self-tests); the 'speed' name is a misnomer, no functional bug","CasterEffect double-fires because ACE broadcasts it to the local caster (EnqueueBroadcast sendSelf=true, no world self-filter) AND entities.js:6884 synthesizes it at chain end — but only for the 74 caster_effect!=0 spells (portals/lifestones/buffs); ALL war(school1) and void(school5) spells have caster_effect=0","TargetEffect is already delivered by the wire to local AND remote victims (ACE WorldObject_Magic.cs:361 + sendSelf/known-players broadcast) — the entities.js:6865 synthesis TODO is unnecessary and should be closed","Fizzle VFX renders from the generic wire PlayScript.Fizzle 0x51 (fizzle_effect=0 for all 6266 spells) but the fizzle SOUND is dropped: the resolver spawns only particle hooks (13/26) and skips the Fizzle script 0x33000103's SoundTable hook — same gap silences cast/launch/explode audio","war/void DAMAGE bolts use caster_effect=0/target_effect=0 (projectile Launch/Explode VFX); void DoT curses use target_effect 0xA7/0xA8/0xA9 HealthDownVoid/RegenDownVoid/SkillDownVoid"],"filesToChange":["scene3d/entities.js","scene3d/play_effect_vfx.js","docs/url-flags.md","test_ws09_formula_scale_parity.mjs (new)","test_play_effect_resolver.mjs"],"needsWasmRebuild":false,"newFlags":["castSyntheticCasterVfx","playEffectSound"],"risks":["Patch A relies on the wire CasterEffect rendering for the local caster (proven by the F9-3 double-flash; escape flag restores synthetic)","Patch B audio must not double the fizzle sound with WS08 — default-OFF + ear-test","play_effect_vfx.js is shared with WS10 (projectile VFX); entities.js shared with WS06/07/08/13/14 — sequence the additive hunks","projectile Launch/Explode resolve against the projectile's own PhysicsScriptTable (WS10) — re-verify E4 if WS10 rewires it","pre-existing test-harness stub gap (play_effect_vfx.js:1530 under Node) blocks the end-to-end resolver cases — fix in the stub when landing T2/T3"]}
```

---

## VERDICT (WS09-verify)

**Reviewer posture:** skeptical adversarial re-verification, buildbox, 2026-07-12. Every
load-bearing cite below was re-opened live; DAT facts re-pulled from the WB.Terminal oracle;
the picker parity harness re-run from a temp file (no repo pollution).

**Verdict: PARTIAL — findings CONFIRMED, three corrections required before landing.**
The investigative core (F1–F4 mechanisms) is unusually solid and, refreshingly, *narrows* the
charter rather than inflating it: it disproves two charter premises with proof. The corrections
are to one context-table cell, one patch's reach, and one flag-default judgment.

### What I independently re-verified (all CONFIRMED)

- **F1 (formulaScale = selection mod, not speed): CONFIRMED, and stronger than stated.**
  - Decomp `PhysicsScriptTableData::GetScript` @ acclient.c:336552 re-read in full — it is a
    `while (mod > v5->mod)` threshold walk returning a **script DID**, overflow → `stru_8444D0`
    (id 0). `CPhysicsObj::play_script` (addr 0x513260, body @ ~320331) calls `GetScript(&mod, …)`
    then `play_script_internal(LODWORD(mod))` → `ScriptManager::AddScript(script_id)`
    (@318059) — **`mod` is consumed as the DID selector and never forwarded as a rate.** Exactly
    as the packet claims.
  - Oracle `PhysicsScriptTable 0x34000004`: **all 139 PScriptType ladders have max mod = 1.0**
    (I checked every ladder, not just the global max). `Fizzle → {mod:1, 0x33000103}`. So the
    packet's "overflow divergence is unreachable" is confirmed *per-ladder*, not merely globally
    — even a ladder that topped out below 1.0 would be a hole, and none do.
  - Client: `pickScriptEntry` (play_effect_vfx.js:939) uses `speed` ONLY at :1280 for selection;
    re-ran the parity harness → **8/8 self-tests, 27/27 decomp-parity, 0 mismatch**; the sole
    divergence at scale=2.0 (client=last entry, decomp=null) is genuinely unreachable. lib.rs
    emit @38330 forwards `f32_payload = speed`; index.html:7387-7395 reads it as `speed`. The
    `speed` name is a misnomer, no functional bug. ✔

- **F2 (CasterEffect double-fire, narrow scope): CONFIRMED and REACHABLE.**
  - ACE `DoSpellEffects` (WorldObject_Magic.cs:356-365) broadcasts CasterEffect; the single-arg
    `EnqueueBroadcast(params GameMessage[])` (Networking.cs:1413-1415) → `EnqueueBroadcast(true,…)`
    → `sendSelf` block :1428-1431 `self.Session.Network.EnqueueSend(msgs)` **delivers to the local
    caster.** system.rs PlayEffect arm passes `data.target` verbatim, **no self-filter**.
  - The synthetic still fires: entities.js:6885 `if ((seq.casterEffect|0)!==0)` is live and
    **reachable** — I confirmed `data/spell-cast-sequence.json.sequences["47"] =
    {casterEffect:16, targetEffect:17, formulaScale:0.4}` and `["1635"].casterEffect=14`, so the
    two portal/lifestone examples DO carry a non-zero casterEffect and the emit runs.
  - `castVfxDedup` is **absent from the url-flags.md "Now default-ON" list (line 12)** and its
    IIFE (play_effect_vfx.js:1655-1663) is default-OFF — so nothing dedups the two emits today. ✔
  - Scope numbers re-computed from LSD: **caster_effect≠0 = exactly 74/6266**; by school =
    {3:37 (portals/lifestones/recalls), 2:37 (life-buffs)}; **war(691) and void(76) = 0 each.** ✔

- **F3 (TargetEffect already on the wire): CONFIRMED.** ACE :361-365 broadcasts
  `GameMessageScript(target.Guid, TargetEffect, Scale)` via `target.Wielder ?? target`, same
  sendSelf/known-players path, same no-self-filter world handler. The entities.js:6865-6877 TODO
  is genuinely unnecessary. (Live render on the victim rig remains a laptop confirmation, correctly
  deferred to §4 Case 2 / E5.) ✔

- **F4 (fizzle/wire sound dropped): CONFIRMED.** Oracle: PhysicsScript **0x33000103 has exactly
  two hooks — CreateParticle (13) + SoundTable (2)**. Resolver `_tryResolveRealVfx` counts/spawns
  ONLY hookType 13/26 (play_effect_vfx.js:1315-1323 count, :1391-1392 spawn); the sound hook is
  never fired on this path, and the H2 entity walker runs for entity-spawn scripts, not wire
  one-shots, so the :1306-1309 comment's "handled by H2" is wrong for wire PlayEffects. Hook
  numbering matches lib.rs:18605-18642 (1=Sound,2=SoundTable,13=CreateParticle,21=SoundTweaked).
  Player_Magic.cs:879/:917 send `PlayScript.Fizzle, 0.5f`; `DoSpellEffects` runs only on
  `CastingPreCheckStatus.Success` (:569/:893) → **no CasterEffect on fizzle**, confirming the
  free auto-suppression. `?castFizzle` really is default-ON (`!== "off"` @ index.html:7838) while
  its inline comment says "Default-off" — the packet's stale-comment catch is correct. ✔

- **F5 data table: mostly CONFIRMED.** 27/64 war (school1) ce=0/te=0; 5349/5345 void (school5)
  ce=0/te=0; 5339 Destructive Curse I te=**167 (0xA7 HealthDownVoid)**; war target_effect≠0 =
  exactly 5 → **686/691 have te=0** as claimed; fizzle_effect=0 for **all 6266**. ✔

### REQUIRED CORRECTIONS (mustFix)

1. **F5 table error — Primary Portal Tie school is 3, not 6.** The §1/F5 table row
   `| 47 Primary Portal Tie | 6 | …` is wrong: LSD says spell 47 is **school 3 (ItemEnchantment)**,
   and **no school 6 exists** (distribution is {1:691, 2:1501, 3:1079, 4:2919, 5:76}). Cosmetic
   (context table only, does not touch a finding) but must be corrected for accuracy per project
   law #2.

2. **Patch B has an early-return gap that undercuts its stated scope.** `_tryResolveRealVfx`
   **returns false at play_effect_vfx.js:1320-1323 when `particleHookCount === 0`**, i.e. *before*
   the :1391 spawn loop where Patch B's sound branch lives. So a **sound-only** wire PlayScript
   (no CreateParticle/CreateBlockingParticle hook) never reaches the sound branch and stays silent.
   Fizzle 0x33000103 happens to carry a CreateParticle hook, so **fizzle sound works** — but the
   packet also claims Patch B restores "cast cues and projectile Launch/Explode" audio, which is
   **not guaranteed** for any of those scripts that are sound-only. Fix: hoist the Sound/SoundTable/
   SoundTweaked handling **above the `particleHookCount===0` early-return** (or drop the early-return
   when `PLAY_EFFECT_SOUND_ON`), AND insert the branch **before** the existing
   `if (e.hookType !== 13 && e.hookType !== 26) continue;` at :1392 (otherwise the `continue`
   skips it). Alternatively, narrow Patch B's advertised scope to "scripts that already spawn a
   particle" and verify per-script (E4) which Launch/Explode DIDs actually carry sound hooks.

3. **Patch A ships a not-yet-eye-tested feel change ACTIVE-by-default; reconcile with foundation
   §4.3.** The flag `castSyntheticCasterVfx` defaults OFF, which means the fix (suppress the
   synthetic) is **live by default** while E1/E2 are still queued as *pending*. The failure mode is
   asymmetric: if the wire CasterEffect does NOT actually paint on the **local** caster (the one
   premise that is code-derived, not live-verified on any box — the F9-3 "flashes twice" note is
   itself a code-reasoned comment, not a capture), then default-active Patch A **removes the caster
   glow entirely** for all 74 portal/lifestone/buff spells — a worse regression than a double-flash.
   §4.3 says risky/feel changes ship **default-OFF pending the 1070 eye-test**. Recommendation:
   either (a) keep the synthetic by default (flag inverted so the *fix* is the opt-in until E1
   confirms the wire paints on the local rig), or (b) explicitly mark the E1 eye-test as a
   **merge gate** for flipping to default-active. The escape flag exists, so this complies with
   "no default change without an escape" — this is a default-value judgment, not a blocker, but
   it should be an explicit decision, not incidental.

### Nits (non-blocking)

- F2/§2 call the double-fire "empirically observed"; it is **code-derived** (and corroborated by
  the prior F9-3 code comment), not a live capture. The live proof is correctly deferred to E1 —
  just soften the wording so a future reader doesn't treat it as already-measured.
- Patch C's shown diff uses `// ...` to elide the middle of the 6865-6877 block; the implementer
  must match the exact live text (6871-6877: the `damageDealt`/`prj_spell_id` lines) for the edit
  to apply. Comment-only, zero behavior risk.

### Patch applicability

- Patch A1 anchor (after the `CAST_STATE_MACHINE` IIFE, entities.js:920-927): valid. ✔
- Patch A2 context (`if (inst._castSequenceToken !== token) return;` / `if ((seq.casterEffect|0)!==0){`
  @ 6884-6885): exact match, applies clean. ✔
- Patch B1 anchor (flag-IIFE cluster ~:1655): valid. ✔  Patch B2: see mustFix #2 (site correct,
  ordering + early-return not accounted for).
- Patch C (6865-6877 comment swap): applies (comment-only). ✔
- url-flags.md rows: correct table shape, both default-OFF, escapes documented. ✔
- No ACE/reference edits; no wasm rebuild needed; no regression to castMove/slideCast/cmdInterp
  (WS09 touches only the VFX emit/resolve, not the movement lanes). ✔
- T1 harness re-run green here (8/8, 27/27). T2/T3 are described but not yet written; the
  play_effect_vfx.js:1530 stub gap is real and pre-existing.

**Bottom line:** land F1 (close as no-op / optional Patch D comment), F3 (Patch C), and F4/Patch B
(**with mustFix #2**) — these are the genuine, well-proven improvements. Ship Patch A but resolve
mustFix #3's default-value decision first. Fix mustFix #1's table cell. All flag-off arms are
byte-identical; no ACE edits; all cross-checked against decomp + ACE + oracle + live source.

```json
{"workstream":"WS09","verdict":"PARTIAL","apply":true,"mustFix":["F5/§1 table: Primary Portal Tie is school 3 (ItemEnchantment), NOT 6 — no school 6 exists (schools {1:691,2:1501,3:1079,4:2919,5:76})","Patch B: _tryResolveRealVfx returns early at play_effect_vfx.js:1320 when particleHookCount===0, so sound-only wire PlayScripts never reach the :1391 sound branch — hoist Sound/SoundTable/SoundTweaked above the early-return (and insert before the 13/26 `continue` at :1392), or narrow Patch B's claimed cast/launch/explode scope","Patch A default-value: it ships the synthetic-suppression fix ACTIVE-by-default while E1/E2 are pending and the 'wire paints CasterEffect on the LOCAL caster' premise is code-derived only; per foundation §4.3 either default-OFF the fix or make E1 an explicit merge gate"],"notes":"F1-F4 mechanisms independently re-verified against decomp (acclient.c:336552/320331/318059), ACE (WorldObject_Magic.cs:356-365, Networking.cs:1413-1431, Player_Magic.cs:879/917), oracle (0x33000103=CreateParticle+SoundTable; all 139 ladders max mod=1.0; Fizzle→0x33000103), and live source; picker harness re-run 8/8+27/27. LSD counts exact (74/6266 caster_effect≠0, all war/void=0, fizzle_effect=0 for all, 686/691 war te=0). Real fixable defects = wire PlayScript sound drop (F4) + the narrow 74-spell CasterEffect double-fire (F2); formulaScale (F1) and TargetEffect-synthesis (F3) are correctly disproven as non-defects. Corrections are one context cell, Patch B's reach, and Patch A's default — none refute a finding."}
```
