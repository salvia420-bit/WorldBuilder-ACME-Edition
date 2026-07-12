# WS08 — Fizzle / UseDone / busy-window cast lifecycle

Investigator packet. Baseline: `external/holtburger` (as read 2026-07-12).
Charter: own the client cast-state-machine **truthfulness** — derive the exact
event order vanilla ACE emits for the five cast outcomes, audit our F8-2/F8-4/F8-5
machine against it, and fix the two wedges (dropped-UseDone freeze, eaten
server-accepted recast) without inventing behavior. Improvement pass, not a revamp.

Path shorthand: `ACE = external/ACE/Source/ACE.Server/WorldObjects`,
`HOLT = external/holtburger/apps/holtburger-web`, `DECOMP = /home/wbterminal/ac-headers`.
Every cite below was opened live this session.

---

## 0. TL;DR (the one thing that matters)

**Retail's UseDone handler decrements the cast-busy count UNCONDITIONALLY —
`etype` (the WeenieError) only adds a toast on top:**

```c
// DECOMP acclient.c:401924  ClientUISystem::Handle_Item__UseDone(etype)
v3 = ClientUISystem::s_pUISystem->m_cBusy-- == 1;   // ALWAYS decrement
if ( v3 ) ClientUISystem::UpdateCursorState(v2);
if ( etype ) {                                       // error != 0 -> also
  v4 = ClientCommunicationSystem::GetCommunicationSystem();
  if ( v4 ) ClientCommunicationSystem::HandleFailureEvent(v4, etype, ...);  // toast
}
```

Our wasm **splits** the single retail UseDone into two client events:
`UseDone(None) -> kind=14` and `UseDone(error) -> kind=13`
(`HOLT/src/lib.rs:42377-42394`). Only **kind=14** clears the local cast-busy
window (`HOLT/index.html:7854-7860 clearCastBusy`). **kind=13 clears nothing**
except the fizzle sub-case. So **every server cast-reject that carries an error
code — out-of-range, too-busy, mana, components, in-air, indoor/outdoor,
target-lost, bad-cast — leaves the F8-4 busy window set and the optimistic local
prediction running to completion.** That is the root cause of both wedges in the
charter. The fix restores retail's "any UseDone frees the cast" semantics behind
a flag.

Confidence: **high** (proven by decomp + ACE source + live client code + DAT
oracle; the only laptop-only gap is a wire-order pcap, recipe in §7).

---

## 1. VERIFIED FINDINGS

### 1.1 The exact event order ACE emits (per outcome)

Traced through `ACE/Player_Magic.cs` (FastTick / retail-mode path is the live
default) and `ACE/WorldObject_Magic.cs`. "→caster" = session-only game event;
"⇒bcast" = EnqueueBroadcast to caster+observers.

**Wire messages involved & their opcodes (confirmed):**
- UseDone `GameEventUseDone(Session, error)` = **0x01C7** — `HOLT/src/lib.rs:602`;
  producer `ACE/Player_Use.cs:247-250`.
- WeenieError `GameEventWeenieError(Session, error)` = **0x028A** —
  `HOLT/src/lib.rs:600`; producer `ACE/Player_Networking.cs:423-426 SendWeenieError`.
- PlayScript `GameMessageScript(guid, PScriptType, scale)` = **0xF755**;
  `PlayScript.Fizzle = 0x51` (`ACE/…/Enum/PlayScript.cs:86`).
- Spell words `GameMessageHearSpeech` ⇒bcast; UpdateMotion 0xF74C per gesture.

**(A) Successful targeted WAR cast** (e.g. Flame Bolt, spell 27):
```
1. →/⇒ HearSpeech (spell words)        ACE Player_Magic.cs:592-601 DoSpellWords
2. ⇒ UpdateMotion  windup gesture(s)   DoWindupGestures :605-646  (bolt I: leadOnly=0 windups)
3. ⇒ UpdateMotion  cast gesture        DoCastGesture   :648-689   (MagicBlast 0x40000033)
   -- cast gesture completes server-side -> HandleMotionDone_Magic :1249 -> DoCastSpell
4. (Success) projectile spawn:         DoCastSpell_Inner :891-896 -> CreatePlayerSpell(effect)
   ⇒ ObjectCreate(projectile) + GameMessageScript(projectile.Guid, PlayScript.Launch)
                                        WorldObject_Magic.cs:1833
   (war bolt CasterEffect=Invalid, so NO caster GameMessageScript — DoSpellEffects
    :358 is gated `spell.CasterEffect != 0`; confirmed Invalid via DAT, §1.5)
5. ⇒ UpdateMotion  Ready (recoil)      FinishCast :959-960 EnqueueMotion(Ready)
6. →  UseDone(None)                     FinishCast :964 SendUseDoneEvent()  [AFTER recoil anim]
   (later, on projectile impact: VectorUpdate + GameMessageScript(target, TargetEffect=Explode)
    + damage; DoSpellEffects projectileHit=true WorldObject_Magic.cs:2120)
```
The projectile/effect fire **before** FinishCast; **UseDone is always last**
(`Player_Magic.cs:931 if (finishCast) FinishCast();`).

**(B) Fizzle** (skill roll fail, or cross-school "Nether energies" swap):
The fizzle is **pre-rolled at cast start** (`GetCastingPreCheckStatus :528-563`)
but only **revealed at the end of the cast gesture** — the full windup+cast
animates first:
```
1-3. identical to (A): HearSpeech, windups, cast gesture (FULL animation plays)
4. (CastFailed) ⇒ GameMessageScript(Guid, PlayScript.Fizzle=0x51, 0.5)   Player_Magic.cs:917
5. →  WeenieError(YourSpellFizzled 0x0402)  [via SendWeenieError, 0x028A, NOT UseDone]  :918
6. ⇒ UpdateMotion  Ready (recoil)                                        FinishCast
7. →  UseDone(None 0x01C7)                                               FinishCast :964
```
So a fizzle delivers **0x028A WeenieError(0x0402) THEN 0x01C7 UseDone(None)** — two
separate events. There is **NO separate Sound message**; the fizzle "poof" sound
is a hook baked into the Fizzle PhysicsScript that 0x51 resolves to.

**(C) Out-of-range reject** (and mana / components / in-air / indoor-outdoor):
The reject is emitted as a **UseDone(error)**, EARLY, before/at windup, with no
projectile and no PlayScript:
```
1. →/⇒ HearSpeech (only if reached DoSpellWords — range fails at CreatePlayerSpell:1022
       which is BEFORE DoSpellWords:1033, so range reject usually has NO spell words)
2. →  UseDone(MissileOutOfRange 0x0550)   VerifySpellRange :504 SendUseDoneEvent(...)
```
Mana `:583`, components `ValidateSpell :406`, in-air `:107/298`, indoor/outdoor
`:513/521`, target-lost `:139/201`, invalid-type `:131` — all the same shape:
one `SendUseDoneEvent(<error>)`, **no** windup/cast, **no** recoil, **no** second
UseDone. (Range is also re-checked AFTER windup at `DoCastSpell :785`; that late
reject additionally runs `FinishCast` → recoil + UseDone(None).)

**(D) Recast spam while a cast is in flight** (vanilla, `spellcast_recoil_queue`
default False → `MagicState.CanQueue` false):
```
1. →  UseDone(YoureTooBusy 0x001D)    VerifyBusy :376-383 (IsBusy) SendUseDoneEvent(YoureTooBusy)
```
The **in-flight** cast is untouched and finishes normally with its own UseDone(None)
later. Note the ordering: `VerifyBusy` (`:124`) runs **before** VerifySpell/range,
so a busy player NEVER gets a range/mana reject — YoureTooBusy short-circuits. This
is why 0x001D means "the *other* cast is fine", not "this cast failed".
(If `spellcast_recoil_queue`=True, `:117-121` **queues** the recast with **no**
UseDone and replays it via `HandleCastQueue :1366` after FinishCast — our server is
vanilla so this path is dormant.)

**(E) Self-cast** (buff; our client promotes ACE-untargeted self-spells to
**targeted at own guid** — foundation §1.1):
```
1. GetTargetCategory -> Self (targetGuid == Guid.Full)      Player_Magic.cs:235
2. Self != WorldObject/Wielded -> CreatePlayerSpell DIRECT, NO TurnTo   :151-157
3-… HearSpeech, windup(s), cast gesture, then DoCastSpell_Inner(Success):
   ⇒ Magic.UpdateEnchantment (buff applied)  +  DoSpellEffects
      (self-buff HAS CasterEffect/TargetEffect -> GameMessageScript on self)
   -> FinishCast -> Ready recoil -> UseDone(None)
```
**Self-casts DO send UseDone** (via FinishCast, same as targeted). VerifySpellRange
returns true immediately for self (`:483 target.Guid == Guid`), so self-casts are
never range-rejected. Answer to the charter's direct question: **yes — ACE sends
UseDone for self casts, and yes — for failed validations** (every early reject is a
`SendUseDoneEvent(<error>)`; the only exceptions are the `CanQueue` queue path
`:117-121` which emits nothing, and the combat-mode-mismatch-with-no-magic path
`:92/283` which emits UseDone(**None**)).

### 1.2 How our wasm maps those wire events → client `kind`

`HOLT/src/lib.rs:42368-42421` (UseDone) and `:42457-42509` (WeenieError):

- `UseDone(None)` → **kind=14** USE_DONE (`:42377-42384`).
- `UseDone(error != None)` → **kind=13** USE_FAILED + a chat toast
  (`:42385-42419`). **Never kind=14.**
- `WeenieError(0x028A)` whose code is in `spellcast_error_text` (0x0400/0x0401/
  **0x0402**/0x0407/0x0408/0x0498/0x04EB/0x0550) → **kind=13** + transient toast
  (`:42486-42500`); any other WeenieError → kind=2 chat only.

`spellcast_error_text` (`:20783-20804`) — the map lists 8 codes; the code comment
`:20775-20781` states the design intent ("`UseDone(error)` upgrades its system line…
and `WeenieError` additionally pushes a kind=13 … ACE delivers the fizzle on 0x028A,
not on UseDone"). **Notably ABSENT from the map: 0x001D YoureTooBusy, 0x03FC
MagicInvalidSpellType, 0x042C TargetNotAcquired, 0x000F BadCast** — these still
reach kind=13 via the UseDone(error) arm but render the generic `[Use failed] {Debug}`
line.

### 1.3 What our client state machine actually does with those kinds

`HOLT/index.html`:
- **kind=13** (`:7808-7842`): re-emits on the plugin bus, then — **only if
  `errCode === 0x0402`** and `?castFizzle != off` — calls
  `em.cancelCastSequence(localGuid)` (`:7832-7842`). **No other code clears busy or
  cancels the chain.**
- **kind=14** (`:7843-7860`): logs, then `em.clearCastBusy(localGuid)` (`:7854-7860`).
  **This is the ONLY wire path that frees the busy window.**

`HOLT/scene3d/entities.js`:
- F8-4 busy window set on every local cast: `_castBusyUntilMs = now +
  min(12000, estMs / CAST_SPEED)` (`:6764-6772`) — a repeat cast for the same caster
  inside the window is `return`-ed (`:6766-6768`), suppressing the local prediction
  (NOT the wire send).
- F8-2 glow guard: `if (inst._castSequenceToken !== token) return;` before the
  casterEffect emit (`:6884`) — a token bump (via `cancelCastSequence`) suppresses the
  success glow.
- Chain-end self-clear: `inst._castBusyUntilMs = 0` (`:6909-6911`) — a **completed**
  local chain frees the window without waiting for UseDone.
- `clearCastBusy` (`:6917-6920`) zeroes the window; `cancelCastSequence` (`:6927-6939`)
  bumps the token, zeroes the window, and recoils to stance-Ready 0x0003.

**Cast entry ordering** (`HOLT/scene3d/picking.js:673-701`): `doCast()` fires
`sessionHandle.castTargetedSpell(guid, spellId)` (**wire send, unconditional**) THEN
`em.playCastSequence(localGuid, spellId)` (local prediction). The busy window gates
**only the animation**, never the wire — so a recast during the window still reaches
the server.

### 1.4 recovery_interval: retail does NOT block on it — animate only

`CSpellBase._recovery_interval` / `_recovery_amount` exist in the struct
(`DECOMP acclient.h:39434-39459`) but every read in the client is **serialization,
not gameplay**:
- `acclient.c:198603 CSpellBase::CSpellBase` → inits to 0.
- `acclient.c:448723 CSpellBase::Pack` → writes it to the buffer.
- `acclient.c:449087 CSpellBase::UnPack` → reads it back.

There is **no cast-gating read** of `_recovery_interval` anywhere in `acclient.c`
(exhaustive `rg -a` = those 3 sites). ACE likewise never references RecoveryInterval
in any `*Magic*.cs`. Retail recoil = the **Ready recoil animation** length; re-cast is
gated purely by the busy count (freed on UseDone). DAT oracle confirms
`recoveryInterval=0, recoveryAmount=0` for war bolts (§1.5). **Verdict for our
client: recovery is "just animate" — do not add any hard recovery block.** Our F8-4
window (sized to windup+cast, cleared at chain-end) already matches that intent; do
not extend it to cover the server's ~1 s recoil (that would eat legitimate recasts).

### 1.5 DAT ground truth (WB.Terminal oracle, client_portal.dat spell table 0x0E00000E)

Flame Bolt I (27), Lightning Bolt I (75), Force Bolt I (86), all identical shape:
```
casterEffect=Invalid  targetEffect=Invalid  fizzleEffect=Invalid
recoveryInterval=0    recoveryAmount=0      power=1  baseMana=5  school=WarMagic
```
Our generated `data/spell-cast-sequence.json` for 27/75/86 and void bolts
5349/5357: `casterEffect=0, targetEffect=0` (matches DAT Invalid). War/void **bolts
have no caster glow** — their only visible cast VFX is the server-spawned projectile
(and the target explosion on impact). **Consequence: the F8-2 "false success glow"
concern is a non-issue for war/void bolts** (casterEffect=0 → the `:6885` emit is
skipped). It matters only for spells with a non-zero CasterEffect (self-buffs / some
enchantments) — those still animate-through-and-glow on a non-fizzle reject today.

War-bolt tier windup counts / busy-window sizes (`spell-cast-sequence.json` +
CAST_SPEED=2.0): Flame Bolt I = 0 windups, ~2.0 s cast → ~1.0 s window; II–VI =
1 windup, 3.1–6.5 s → **1.5–3.2 s window**. So the busy-window wedge (§2.1) eats
recasts for **1–3 s**, easily long enough to swallow a corrected re-click.

### 1.6 Fizzle feedback is already wired (server → client), no synthesis needed

ACE broadcasts the fizzle VFX as `GameMessageScript(Guid, PlayScript.Fizzle=0x51, 0.5)`
(`Player_Magic.cs:917` CastFailed; `:879` PK moved-too-far). Our client renders 0x51:
`HOLT/scene3d/play_effect_vfx.js:2177-2185` handles `PLAY_SCRIPT.Fizzle` (gray puff),
and the wasm resolves the **local** player's PhysicsScriptTable for self 0xF755 VFX
(`HOLT/src/lib.rs:39781-39790` "local player's self-cast/buff PhysicsScript VFX …
resolve against the right table"). So the fizzle puff should appear on the caster
without any client synthesis — **we do NOT drop it** (laptop visual confirm in §7).
The only fizzle output ACE sends is that one PlayScript; **there is no standalone
fizzle Sound message** (the sound is a hook inside the resolved Fizzle script).

### 1.7 Flag-default doc drift (minor, worth a one-line correction)

`entities.js` inline comments say CAST_SPEED and CAST_STATE_MACHINE are "default
OFF" (`:902`, `:917`), but the code is `!== "off"` = **default-ON** (`:906`, `:923`),
matching `docs/url-flags.md:12,251,253` (both listed default-ON) and foundation §1.2.
The comments are stale; the behavior is default-ON. (No code change needed — just the
comment; folded into the patch below as an optional hunk.)

---

## 2. ROOT CAUSES

### 2.1 WEDGE #1 — a server cast-reject freezes the busy window (eaten recast)

**Mechanism (proven):** local `playCastSequence` optimistically sets `_castBusyUntilMs`
for the full chain (`entities.js:6764-6772`). If the server rejects the cast, it sends
`UseDone(<error>)` (Player_Magic reject sites, §1.1C/D) which the wasm maps to
**kind=13, never kind=14** (`lib.rs:42385-42394`). The kind=13 handler clears the busy
window for **no** code (`index.html:7808-7842`); only kind=14 does. Therefore the
window persists until it self-expires — for war bolts **1–3 s** (§1.5). A corrected
recast issued inside that window (step into range, re-click) has its **local
prediction eaten** by the F8-4 gate (`entities.js:6766-6768`); the player sees a dead
cast (at most a partial arm-raise from the wire echo path, no glow). This is exactly
the charter's "server-accepted rapid recast must not be eaten" and overlaps WS01.

Retail did not have this problem: `Handle_Item__UseDone` (`acclient.c:401931`)
decrements busy on **every** UseDone, error or not. Our split into kind=13/14 dropped
that invariant for the error case.

**Note the wedge is bounded, not permanent:** the 12 s cap (`entities.js:6772`) and
the chain-end self-clear (`:6911`) both exist, so a dropped/missing UseDone can wedge
casting for **at most the local chain duration (≤ ~3 s for war, hard cap 12 s), never
forever.** Charter's "12 s cap exists — verify" = **VERIFIED** (`Math.min(12000, …)`).

### 2.2 WEDGE #2 — a rejected cast finishes its animation (and glow, for buffs)

Same mechanism: on a non-fizzle reject the local chain is never cancelled, so
`playCastSequence` runs to completion — the character finishes the full windup+cast
of a cast the server already rejected, and (for spells with CasterEffect≠0, i.e.
self-buffs) fires the success glow at `entities.js:6885`. Retail never animated a
rejected cast (its gestures were server-driven and simply never sent on reject).
For war/void bolts this is animation-only (no glow, §1.5); for self-buffs it is a
false success glow. Fizzle (0x0402) is the ONE reject we cancel today (`:7832`).

### 2.3 Why YoureTooBusy must be treated differently

0x001D (`VerifyBusy` short-circuits **before** any per-cast validation, §1.1D) means
"the *previous* cast is still running; this new one bounced." In retail's counter
model the YoureTooBusy UseDone decrements the **spam's own** busy increment, leaving
the live cast's increment intact. Our single-window model has no per-cast counter, so
**clearing/cancelling on 0x001D would kill the legitimate in-flight cast.** 0x001D must
therefore be excluded from the reject-cancel set (leave the window as-is).

---

## 3. PATCH PLAN

All changes flag-gated per foundation §4. **HUD/behavior guard:** new flag
`?castRejectClears` default-ON (validated retail-truthful by decomp) with `=off`
escape. No wasm rebuild required (JS-only). The wasm already surfaces the codes we
need (kind=13 + `u32Payload` code).

### Patch A — new pure helper (testable): `HOLT/ui/cast_reject_policy.js` (NEW FILE)

```js
// WS08 (2026-07-12) — classify a spell-cast WeenieError code for the client
// cast-state machine. Import-free so it unit-tests under node without three.js.
//
// Retail truth: ClientUISystem::Handle_Item__UseDone (acclient.c:401931) does
// `m_cBusy--` UNCONDITIONALLY on every UseDone — a non-zero error only adds a
// failure toast. Our wasm splits UseDone(error) to ClientEvent kind=13
// (lib.rs:42385), so the JS layer must re-apply "any cast reject frees the cast".
//
// Codes: ACE.Entity/Enum/WeenieError.cs (verified 2026-07-12).
const CAST_TERMINAL_REJECTS = new Set([
  0x000F, // BadCast                    (DoCastSpell null-state, Player_Magic.cs:709)
  0x03FC, // MagicInvalidSpellType      (VerifySpell,            :131)
  0x0400, // YouDontHaveAllTheComponents(ValidateSpell,         :406)
  0x0401, // YouDontHaveEnoughManaToCast(CalculateManaUsage,    :583)
  0x0407, // YourSpellCannotBeCastOutside(VerifySpellRange,     :521)
  0x0408, // YourSpellCannotBeCastInside (VerifySpellRange,     :513)
  0x042C, // TargetNotAcquired          (GetTargetCategory null,:139/201)
  0x0498, // YouHaveMovedTooFar         (PK windup cap — VerifyCastRadius)
  0x04EB, // YouCantDoThatWhileInTheAir (IsJumping,             :107/298)
  0x0550, // MissileOutOfRange (spell range, VerifySpellRange,  :504)
]);

// Deliberately EXCLUDED:
//   0x0402 YourSpellFizzled — handled by the ?castFizzle block (cancel at cast-
//          gesture end; the fizzle's trailing UseDone(None)->kind=14 clears busy).
//   0x001D YoureTooBusy — the PREVIOUS cast is still in flight (VerifyBusy short-
//          circuits before per-cast checks); cancelling would kill the live cast.
export function isTerminalCastReject(code) {
  return CAST_TERMINAL_REJECTS.has(code >>> 0);
}
```

### Patch B — `HOLT/index.html`, extend the kind=13 handler (~:7842)

Context (current code, `index.html:7828-7842`):
```js
                // F8-2: a fizzle (YourSpellFizzled = 0x0402) cancels the
                // local cast-gesture chain so the character doesn't finish
                // the windup and flash the spell's success glow. Default-off
                // (?castFizzle=on), pending a 1070 eye-test.
                if (errCode === 0x0402) {
                  try {
                    if (new URLSearchParams(window.location.search).get("castFizzle") !== "off") {
                      const em = window.liveScene3d?.entityManager;
                      const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
                      if (em && lg && typeof em.cancelCastSequence === "function") {
                        em.cancelCastSequence(lg);
                      }
                    }
                  } catch (_) {}
                }
```

Add immediately after the fizzle block (before the `}` that closes `kind === 13`):
```js
                // F8-6 (WS08 2026-07-12): a server cast-REJECT (UseDone(error) ->
                // kind=13) ends the cast. Retail's UseDone handler decrements the
                // busy count for ANY error (acclient.c:401931 m_cBusy--), so a
                // rejected cast must (a) stop finishing its optimistic windup /
                // self-buff glow and (b) free the F8-4 busy window so a CORRECTED
                // recast isn't eaten. Excludes 0x0402 (fizzle, handled above) and
                // 0x001D YoureTooBusy (the PREVIOUS cast is still live). Only acts
                // when a local cast prediction is actually in flight (_castBusyUntilMs
                // active) so a door/melee reuse of e.g. MissileOutOfRange can't cut a
                // non-existent cast. Default-ON (?castRejectClears=off).
                else if (isTerminalCastReject(errCode)) {
                  try {
                    if (new URLSearchParams(window.location.search).get("castRejectClears") !== "off") {
                      const em = window.liveScene3d?.entityManager;
                      const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
                      const inst = em?.entityMap?.get?.(lg);
                      if (em && lg && inst && inst._castBusyUntilMs &&
                          performance.now() < inst._castBusyUntilMs &&
                          typeof em.cancelCastSequence === "function") {
                        em.cancelCastSequence(lg);
                      }
                    }
                  } catch (_) {}
                }
```
And add the import to the module's import block (top of the `<script type="module">`,
alongside the other `./ui/…` imports near `index.html:1370`):
```js
      import { isTerminalCastReject } from "./ui/cast_reject_policy.js";
```

`cancelCastSequence` already does everything needed (`entities.js:6927-6939`): bumps
the token (suppresses the `:6884` glow guard), zeroes `_castBusyUntilMs`, and recoils
to Ready. No entities.js change required.

### Patch C (OPTIONAL, doc-only) — fix the stale default-OFF comments

`entities.js:902` and `:913-919`: change "Default OFF" → "Default ON (`?flag=off`
escape)" to match the code and `url-flags.md`. Pure comment; no behavior change.

### url-flags.md row (drafted, to add near line 254 after `castFizzle`)

```
| `castRejectClears` | `on` | off | F8-6 (WS08): a server cast-reject delivered as UseDone(error)→kind=13 (out-of-range 0x0550, mana 0x0401, components 0x0400, in-air 0x04EB, indoor/outdoor 0x0408/0x0407, target-lost 0x042C, invalid-type 0x03FC, bad-cast 0x000F, PK moved-too-far 0x0498) cancels the optimistic local cast-prediction and frees the F8-4 busy window, matching retail's unconditional `m_cBusy--` on UseDone (acclient.c:401931). Excludes 0x0402 (fizzle → `?castFizzle`) and 0x001D YoureTooBusy (prev cast still live). No-op unless a local cast is in flight (`_castBusyUntilMs`), so non-cast reuse of MissileOutOfRange can't cut a phantom cast. Subordinate to `?castStateMachine` (needs the busy window). Pending 1070 eye-test. | ui/cast_reject_policy.js + index.html |
```

### Explicitly NOT changing (guardrails honored)

- No client-side range gate before the send — retail is server-authoritative
  (foundation §2.4, §2.1). We only react to the server's reject.
- No hard recovery/movement root — `_recovery_interval` is unused (§1.4);
  slidecast/fastcast stay as WS-castMove/slideCast own them.
- No touch to `play_effect_vfx.js` (fizzle VFX already handled, §1.6).
- No wasm change: the kind=13 + code payload is sufficient. (A *nicer* future
  option — have the wasm emit BOTH kind=13 AND kind=14 on UseDone(error) to mirror
  retail's single-event semantics exactly — is noted as a cross-workstream idea in §6,
  not taken here to keep the change JS-only and minimal.)

---

## 4. TESTS

### 4.1 New node unit test: `HOLT/test_cast_reject_policy.mjs` (proposed, VALIDATED)

Mirrors the `test_ac_*.mjs` pattern (import helper via `file://`, exit non-zero on
fail). I authored it against Patch A's helper and ran it in a scratch dir — **22/22
pass**. Full source (drop into `HOLT/` on the laptop next to the helper):

```js
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const { isTerminalCastReject } =
  await import("file://" + resolvePath(__dirname, "ui/cast_reject_policy.js"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  [FAIL]", m); } };

// terminal cast rejects -> true
for (const [code, name] of [[0x000F,"BadCast"],[0x03FC,"InvalidType"],
  [0x0400,"Components"],[0x0401,"Mana"],[0x0407,"Outside"],[0x0408,"Inside"],
  [0x042C,"TargetLost"],[0x0498,"MovedTooFar"],[0x04EB,"InAir"],[0x0550,"OutOfRange"]])
  ok(isTerminalCastReject(code) === true, `terminal ${name}`);
// excluded -> false
ok(isTerminalCastReject(0x0402) === false, "fizzle 0x0402 excluded (castFizzle owns it)");
ok(isTerminalCastReject(0x001D) === false, "YoureTooBusy 0x001D excluded (prev cast live)");
// unrelated -> false
for (const c of [0x0000, 0x001C, 0x0226, 0xFFFF])
  ok(isTerminalCastReject(c) === false, `unrelated 0x${c.toString(16)} excluded`);

// handler-gate model: cancel ONLY when a cast is in flight; flag-off escapes
function handle(inst, errCode, nowMs, flagOff = false) {
  const out = [];
  if (errCode === 0x0402) { out.push("fizzle-cancel"); return out; }
  if (flagOff) return out;
  if (isTerminalCastReject(errCode) && inst && inst._castBusyUntilMs &&
      nowMs < inst._castBusyUntilMs) out.push("cancelCastSequence");
  return out;
}
ok(JSON.stringify(handle({_castBusyUntilMs:1000},0x0550,500))==='["cancelCastSequence"]',"in-flight range reject cancels");
ok(JSON.stringify(handle({_castBusyUntilMs:0},0x0550,500))==='[]',"no-cast reject is no-op (door/melee reuse)");
ok(JSON.stringify(handle({_castBusyUntilMs:400},0x0550,500))==='[]',"expired-window reject is no-op");
ok(JSON.stringify(handle({_castBusyUntilMs:1000},0x001D,500))==='[]',"YoureTooBusy leaves in-flight cast");
ok(JSON.stringify(handle({_castBusyUntilMs:0},0x0402,500))==='["fizzle-cancel"]',"fizzle handled regardless of window");
ok(JSON.stringify(handle({_castBusyUntilMs:1000},0x0550,500,true))==='[]',"castRejectClears=off escape");

console.log(`Cases: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

Regression guard for the existing harness: `node test_ac_spell_cast_sequence.mjs`
already green (ran this session, 39/39) — unaffected by these changes.

### 4.2 TODO-FOR-LAPTOP — headless wire-order + wedge repro

Serve + headless bot per foundation §5. Preconditions: a war-trained test char with
Flame Bolt II (1-windup, ~1.5 s window) learned and low-mana; a spawnable target.

```
URL: http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1
Poll: window.__bootState === 'in-world'
```

Console instrumentation (paste before driving casts):
```js
window.__ws08 = { events: [] };
window.__pluginClient.events.on("kind:13", e =>
  window.__ws08.events.push({ t: performance.now(), kind: 13, code: e.u32Payload >>> 0 }));
// tap the entity's busy window each frame you care about:
window.__ws08.busy = () => {
  const em = window.liveScene3d.entityManager;
  const lg = window.getLocalPlayerGuid();
  return em.entityMap.get(lg)?._castBusyUntilMs || 0;
};
```

Repro 1 — busy-window freeze on out-of-range reject (expect FAIL pre-patch):
```
1. Stand > 60 units from target (out of Flame Bolt range).
2. window.__sessionHandle.castTargetedSpell(TARGET_GUID, 81 /*Flame Bolt II*/)
3. Observe __ws08.events -> a kind=13 code=0x0550 arrives.
4. Immediately (< 1 s) call __ws08.busy() -> PRE-PATCH: still > performance.now()
   (window frozen); POST-PATCH: 0 (cleared by cancelCastSequence).
5. Re-cast at once -> PRE-PATCH: playCastSequence early-returns (eaten);
   POST-PATCH: full local prediction plays.
```

Repro 2 — dropped-UseDone cannot permanently freeze (expect PASS both):
```
1. Cast a valid Flame Bolt II; note the window is set.
2. Do nothing. Confirm __ws08.busy() < performance.now() within ~1.6 s
   (chain-end self-clear entities.js:6911) even if you filter out kind=14.
   Never exceeds now()+12000 (cap entities.js:6772).
```

Repro 3 — recast spam does NOT kill the live cast (guards against 0x001D regression):
```
1. Cast Flame Bolt II at a valid target.
2. Within the windup, spam castTargetedSpell 3x more.
3. Expect kind=13 code=0x001D each; the FIRST cast's projectile still launches;
   the character does NOT snap to Ready mid-windup (0x001D excluded from cancel).
```

Wire-order capture (fills the one gap this box can't): run vanilla ACE with
`RecordCast.Enabled` (or a pcap) and confirm the §1.1 orders A/B/C/D/E on the wire —
especially that fizzle = 0x028A(0x0402) THEN 0x01C7(None), and that out-of-range =
a single 0x01C7(0x0550) with no windup/recoil.

---

## 5. EYE-TEST QUEUE (batched — do NOT run a solo 1070 session)

| # | Flag combo | Setup | Expected visual |
|---|-----------|-------|-----------------|
| E1 | `?castRejectClears=on` (default) vs `=off` | Stand out of range, cast Flame Bolt II at a target; step into range and re-cast within ~1 s | ON: the out-of-range cast **cuts cleanly to Ready** (no full windup), and the corrected recast **plays its full windup** immediately. OFF: the rejected cast finishes its windup and the quick recast is visibly dead/eaten. |
| E2 | `?castRejectClears=on` + a self-buff with CasterEffect≠0, forced mana-fail | Drain mana, cast a self-buff | ON: no false success glow (cast cuts to Ready on the mana reject). OFF: character completes the buff animation + glow despite no buff applied. |
| E3 | `?castFizzle=on` (regression) | Low-skill spell that fizzles | Full windup+cast, then the gray Fizzle puff (PlayScript 0x51) on the caster + recoil, **no** success glow. Confirms §1.6 fizzle VFX renders end-to-end. |
| E4 | `?castRejectClears=on`, recast spam | Cast Flame Bolt II, spam 3 more clicks mid-windup | The first cast's projectile launches normally; the character does **not** twitch to Ready on the YoureTooBusy rejects. |

All are feel/visual A/Bs; none need a wasm rebuild.

---

## 6. RISKS + cross-workstream interactions

**Files this workstream would touch (for integration ordering):**
- `HOLT/ui/cast_reject_policy.js` — NEW (Patch A). No collision risk.
- `HOLT/index.html` — kind=13 handler (~:7842) + one import line (~:1372). **Shared
  file** — coordinate with any WS editing the kind=13/14 handlers or the module import
  block (WS on rejection_feedback / toasts, WS01).
- `HOLT/docs/url-flags.md` — one new row (append-only; low collision).
- `HOLT/test_cast_reject_policy.mjs` — NEW test. No collision.
- (optional) `HOLT/scene3d/entities.js` — comment-only Patch C; skip if any WS is
  editing `playCastSequence` to avoid a needless merge.

**Interactions / risks:**
- **WS01 (busy-window recast bug) — DIRECT OVERLAP, confirmed COMPLEMENTARY.**
  Read WS01's packet: its fix is `?castBusyScope` (default-OFF) which scopes the F8-4
  drop to the SAME spellId in `entities.js:6764-6772` (its diff keeps `_castBusyUntilMs`,
  just gates the early-return on `sameSpell`) so a *different-spell* weave still
  animates. My Patch B is orthogonal — it reacts to kind=13 *rejects* in `index.html`
  and clears the window via `cancelCastSequence`. Different triggers, different files;
  they compose. **Because WS01 PRESERVES `_castBusyUntilMs`, Patch B's in-flight gate
  keeps working with no rebase.** Only caveat: both edit behavior around the same field,
  so land in either order but re-run both flag matrices together. (If a later WS ever
  replaces the window with a boolean "cast active" flag, Patch B should key on that flag
  instead — trivial swap.)
- **YoureTooBusy exclusion is load-bearing** (§2.3): if a future change makes 0x001D
  reach the cancel path, it will kill live casts. The unit test pins this.
- **Non-cast reuse of shared codes** (MissileOutOfRange 0x0550 for far doors/melee,
  YouCantDoThatWhileInTheAir for jump-use): mitigated by the `_castBusyUntilMs`
  in-flight gate — Patch B is a no-op unless a local cast prediction is live. Pinned by
  the "no-cast reject is no-op" test.
- **castStateMachine subordination:** Patch B keys on `_castBusyUntilMs`, which is only
  set when `?castStateMachine != off` (`entities.js:6764`). With castStateMachine=off
  there is no window to wedge, so Patch B correctly no-ops. Documented in the flag row.
- **Fizzle VFX (WS on play_effect_vfx / VFX):** §1.6 says the Fizzle puff renders via
  the existing 0xF755 path, but the current handler (`play_effect_vfx.js:2181`) is a
  gray-puff placeholder — whether it resolves the *real* Fizzle PhysicsScript (with its
  sound hook) is that WS's call. My packet only depends on the placeholder being
  present. Flag them to confirm the real fizzle script + sound resolve for the local
  caster (E3).
- **Cross-workstream idea (not taken):** a cleaner long-term fix is to have the wasm
  emit UseDone(error) as **both** kind=13 (toast/cancel) **and** kind=14 (busy-clear),
  exactly mirroring retail's single `m_cBusy--`. That is a `lib.rs:42385` change +
  wasm rebuild; deferred to keep WS08 JS-only and to avoid double-clearing races with
  the kind=13 path. Noted for whoever owns the wasm event surface.

**Confidence:** high on the mechanism and the fix (decomp + ACE + client code +
DAT all agree); the only unverified-on-this-box item is the live wire-order pcap
(recipe in §7/§4.2) and the E3 fizzle-VFX visual.

---

## 7. TODO-FOR-LAPTOP quick index
- Create Patch A/B/C, url-flags row, and `test_cast_reject_policy.mjs`; run
  `node test_cast_reject_policy.mjs` (expect 22/22) and `node test_ac_spell_cast_sequence.mjs`
  (expect 39/39).
- Headless repros 1–3 (§4.2) with Flame Bolt II.
- Wire-order pcap / RecordCast confirm of the five §1.1 orders (esp. fizzle two-event
  order and out-of-range single-event).
- Eye-tests E1–E4 (§5), batched.
- Confirm E3: server PlayScript.Fizzle 0x51 renders the caster puff (and, if the real
  script resolves, its sound) — coordinate with the VFX workstream.

```json
{"workstream":"WS08","title":"Fizzle / UseDone / busy-window cast lifecycle","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS08-cast-lifecycle.md","confidence":"high","keyFindings":["Retail Handle_Item__UseDone (acclient.c:401931) decrements m_cBusy on EVERY UseDone; error only adds a toast — our wasm splits UseDone(error)->kind=13 (lib.rs:42385) and only kind=14 clears the F8-4 busy window, so any server cast-reject (range/mana/comps/air/indoor-outdoor/target/badcast) freezes the window and lets the optimistic cast animate to completion","12s busy-window cap (entities.js:6772) + chain-end self-clear (:6911) VERIFIED: a dropped UseDone can wedge casting for at most the local chain duration (~1-3s war, hard cap 12s), never permanently","ACE sends UseDone for self-casts (via FinishCast) and for failed validations (every early reject = SendUseDoneEvent(error)); fizzle uniquely arrives as WeenieError 0x028A(0x0402) THEN UseDone(None), not as a UseDone(error)","YoureTooBusy 0x001D must be EXCLUDED from reject-cancel: VerifyBusy short-circuits before per-cast checks so it means the PREVIOUS cast is live; cancelling it would kill the in-flight cast","CSpellBase._recovery_interval is serialization-only in retail (acclient.c ctor/Pack/UnPack, no gameplay read) and =0 for war bolts (DAT) -> recoil is animate-only, add no hard block; fizzle VFX (PlayScript.Fizzle 0x51) is already server-sent and client-rendered (play_effect_vfx.js:2181), no synthesis needed"],"filesToChange":["apps/holtburger-web/ui/cast_reject_policy.js (new)","apps/holtburger-web/index.html","apps/holtburger-web/docs/url-flags.md","apps/holtburger-web/test_cast_reject_policy.mjs (new)","apps/holtburger-web/scene3d/entities.js (optional comment-only)"],"needsWasmRebuild":false,"newFlags":["castRejectClears"],"risks":["Direct overlap with WS01 (busy-window recast bug): mine clears on reject, WS01 owns accepted-recast eaten; coordinate on a shared 'cast in flight' predicate and land WS01's window-model change first","index.html kind=13/14 handler + module import block is a shared file — sequence with rejection_feedback/toast WS and WS01","YoureTooBusy(0x001D) exclusion is load-bearing; a regression that lets it reach the cancel path would kill live casts (pinned by unit test)","Shared WeenieError codes (0x0550 MissileOutOfRange for doors/melee) are safe only via the _castBusyUntilMs in-flight gate; if WS01 restructures that field, rebase the gate","Fizzle real-script+sound resolution is play_effect_vfx WS's domain — E3 confirms the placeholder puff suffices for WS08"]}
```

---

## VERDICT (WS08-verify)

**Verdict: PARTIAL (analysis + mechanism CONFIRMED; one required flag-default
correction + minor prose overstatements). apply: TRUE after the mustFix below.**

Adversarial re-verification 2026-07-12 on the buildbox. I re-opened every
load-bearing file, re-ran the DAT oracle, ran the proposed unit test, and
dispatched independent decomp + ACE-source verifications. The packet's root-cause
mechanism and patch are sound; the deductions hold up under attempted
counter-examples. Corrections are limited to a flag-default convention violation
and two descriptive overstatements in §1.1 that do NOT affect the patch logic.

### Independently RE-VERIFIED (opened live, not inherited)

- **Client state machine (index.html):** kind=13 handler `:7808-7842` — re-emits on
  the plugin bus, and the ONLY cancel is the fizzle branch `if (errCode === 0x0402)`
  `:7832-7842`; kind=14 handler `:7843-7860` — `em.clearCastBusy(lg)` at `:7857-7859`
  is the ONLY wire path that frees the busy window. CONFIRMED verbatim, including the
  Patch-B context block (byte-exact match to the current tree — Patch B applies).
- **entities.js:** busy-window set `:6764-6772` (12 s cap `Math.min(12000, …)`
  `:6772` CONFIRMED; early-return recast eat `:6766-6768` CONFIRMED), F8-2 glow guard
  `:6884`, chain-end self-clear `_castBusyUntilMs = 0` `:6909-6911`, `clearCastBusy`
  `:6917-6920`, `cancelCastSequence` (token bump + zero busy + recoil to 0x0003)
  `:6927-6939`. All CONFIRMED. `cancelCastSequence` already does everything Patch B
  needs — no entities.js change required, as claimed.
- **wasm (lib.rs):** `UseDone(None)→kind=14` `:42377-42384`, `UseDone(error)→kind=13
  + toast` `:42385-42419` (kind=13 fires for ANY non-None error, INDEPENDENT of
  `spellcast_error_text` — so 0x000F/0x03FC/0x042C DO reach kind=13 via the UseDone
  arm, as the patch relies on). `WeenieError` arm `:42457-42509`. `spellcast_error_text`
  `:20783-20804` lists exactly the 8 codes claimed (0x0400/0401/0402/0407/0408/0498/
  04EB/0550); 0x001D/0x03FC/0x042C/0x000F absent — CONFIRMED. Opcodes `WeenieError=0x028A`
  `:600`, `UseDone=0x01C7` `:602` CONFIRMED.
- **picking.js:** doCast `:673-701` fires `castTargetedSpell` (wire, `:674`)
  UNCONDITIONALLY, THEN `playCastSequence` (prediction, `:694`) — busy window gates
  only the animation, never the wire. CONFIRMED.
- **DAT oracle (client_portal.dat 0x0E00000E):** spells 27/75/86 (war) + 5349/5357
  (void) → `casterEffect=Invalid, targetEffect=Invalid, fizzleEffect=Invalid,
  recoveryInterval=0, recoveryAmount=0`. CONFIRMED exactly (§1.5 accurate).
- **Generated `data/spell-cast-sequence.json` (`sequences` map):** 27/75/86/5349/5357
  → `windupGestures=0, casterEffect=0, targetEffect=0`. CONFIRMED (§1.5 accurate; the
  "false success glow is a non-issue for war/void bolts" deduction holds — the
  `:6885` emit is gated on `casterEffect|0 !== 0`).
- **url-flags.md:** `castSpeed`/`castStateMachine`/`castFizzle` all listed default-ON
  (line 12 "Now default-ON", rows `:251/:253/:254`). CONFIRMED — so the F8-4 busy
  window IS set under bare defaults and **the wedge is real by default** (not only
  under an opt-in flag). No existing `castRejectClears` row → no collision.
- **DECOMP (independent agent, `rg -a`):** `ClientUISystem::Handle_Item__UseDone`
  `acclient.c:401924` — `m_cBusy--` at `:401931` is UNCONDITIONAL, error toast gated
  `if (etype)` at `:401934`. CONFIRMED line-for-line. `_recovery_interval`/`_amount`:
  exhaustive `rg -a` = ONLY ctor(:198603)/Pack(:448723)/UnPack(:449087) + struct
  decls; NO gameplay read → §1.4 "recovery is animate-only" CONFIRMED. Busy = inc/dec
  counter (`IncrementBusyCount :401885`, `FreeHandsAndCastSpell :403775` increments on
  cast). CONFIRMED.
- **ACE (independent agent, trimmed checkout):** CRUX CONFIRMED — every named
  pre-cast reject uses `SendUseDoneEvent(<error>)` → `GameEventUseDone(Session,error)`
  (`Player_Use.cs:247-250`): out-of-range `:504`, mana `:583`, components `:406`,
  in-air `:107/298`, indoor `:513`/outdoor `:521`, pre-windup target-lost `:139/177/201`,
  bad-cast `:709`, invalid-type `:131/400`, YoureTooBusy `:380`. Fizzle (skill-fail)
  uniquely via `SendWeenieError(YourSpellFizzled)` `:918` THEN `FinishCast→UseDone(None)`.
  `VerifyBusy` runs before per-cast checks (`:124/315` → short-circuit). Self-cast →
  `FinishCast→UseDone(None)`, `VerifySpellRange` returns true for self `:481-484`. **All
  12 WeenieError enum name→hex mappings match EXACTLY** (WeenieError.cs; BadCast 0x000F,
  YoureTooBusy 0x001D, MagicInvalidSpellType 0x03FC, Components 0x0400, Mana 0x0401,
  Fizzled 0x0402, Outside 0x0407, Inside 0x0408, TargetNotAcquired 0x042C, MovedTooFar
  0x0498, InAir 0x04EB, MissileOutOfRange 0x0550).
- **Unit test:** reproduced Patch A helper + §4.1 test in /tmp and ran under node —
  **22/22 pass** (exactly as claimed). Handler-gate model (in-flight gate, flag-off
  escape, 0x0402/0x001D exclusions) is correct. The test is real and runnable.

### Patch correctness (attempted counter-examples — all safe)

- The new branch is `else if (isTerminalCastReject(errCode))` chained after the
  fizzle `if (errCode === 0x0402)` — 0x0402 is excluded from the set, so no overlap.
  Insertion point (after the fizzle `}`, before the kind===14 `}`) is syntactically
  clean. Import site (`index.html:1370-1372`, other `./ui/…` imports) is valid.
- **Idempotent under double-fire:** kind=13(reject)→cancelCastSequence zeroes busy;
  a following kind=14(None)→clearCastBusy is a no-op; a duplicate kind=13 hits the
  in-flight gate (`_castBusyUntilMs` already 0) → no-op. Safe.
- **0x001D exclusion is correct and load-bearing** (VerifyBusy short-circuits before
  per-cast checks → 0x001D means the PREVIOUS cast is live; cancelling would kill it).
  Pinned by the unit test.
- **Non-cast reuse of shared codes** (0x0550 etc.) can't cut a phantom cast — the
  `_castBusyUntilMs` in-flight gate no-ops when no local prediction is live.
- **No regression to castMove/slideCast/cmdInterp:** `cancelCastSequence`'s recoil
  (`setMotion(guid, 0x0003, stance)`) is the EXACT path the already-default-ON fizzle
  branch uses — this only extends an existing live behavior to more reject codes.

### REQUIRED CORRECTION (mustFix)

1. **Flag default should be OFF, not ON, pending the queued eye-test.** The packet
   ships `castRejectClears` **default-ON** (`get("castRejectClears") !== "off"`) while
   simultaneously queuing a 1070 eye-test (§5 E1–E4) and labeling the flag "Pending
   1070 eye-test." That is self-contradictory under foundation §4.3: *"risky/feel
   changes ship default-OFF pending a 1070 eye-test."* Cancelling an in-flight local
   cast-prediction and snapping the rig to Ready-recoil IS a feel change — retail never
   "cancelled" a predicted cast because retail gestures were server-driven, so the
   VISUAL cleanliness (recoil vs. locomotion overlay interaction) is exactly what the
   eye-test must confirm; the decomp validates the *intent*, not the client visual. The
   sibling cast-cancel flags (`castFizzle`, `castStateMachine`, `castSpeed`) were ALL
   introduced default-OFF and only flipped to default-ON after validation (url-flags.md
   line 12 "was default-off"). **Fix:** flip Patch B's guard to opt-in
   (`get("castRejectClears") === "on"`), set the url-flags.md row default column to
   `off`, and drop "Default-ON" from the Patch-B comment — then flip to default-ON in a
   follow-up once E1–E4 pass, matching the established pattern. (Everything else in the
   patch is unchanged.)

### SHOULD-FIX (accuracy, non-blocking)

2. **§1.1 overstates "fizzle NEVER via UseDone."** `FailCast` (`Player_Magic.cs:1321`,
   the windup-radius-disruption path) sends `SendUseDoneEvent(YourSpellFizzled)` — i.e.
   a fizzle delivered AS `UseDone(0x0402)` → our kind=13 code=0x0402. This is harmless
   to the patch (the existing fizzle branch catches 0x0402; the new set excludes it),
   but the prose should acknowledge the two fizzle-delivery shapes.
3. **0x0498 YouHaveMovedTooFar is effectively a DEAD entry in this ACE.** The only
   `YouHaveMovedTooFar` reference (`Player_Magic.cs:876`) is COMMENTED OUT; the actual
   moved-too-far path uses `FailCast`→`UseDone(YourSpellFizzled 0x0402)` (see #2). So
   the server never sends 0x0498 to the client here. Keeping 0x0498 in the set is
   harmless (forward-compat / other server builds), but §1.1C/the helper comment
   overstate that ACE delivers it. Note it; no code change needed.
4. **Post-windup target-lost path** (`Player_Magic.cs:755`) uses
   `SendWeenieError(TargetNotAcquired 0x042C)` (→ kind=2, since 0x042C is NOT in
   `spellcast_error_text`) THEN `FinishCast→UseDone(None)` (→ kind=14 clears busy).
   So the pre-windup 0x042C reaches the patch via UseDone→kind=13 (handled), and the
   post-windup variant is harmlessly cleared via kind=14. Patch behaves correctly
   either way; the §1.1 claim that target-lost is uniformly UseDone(error) is imprecise.
5. **Patch C line ref:** the stale CAST_STATE_MACHINE "default OFF" comment is at
   `entities.js:913`, not `:917`. Also `index.html:7830` carries a SECOND stale
   "Default-off (?castFizzle=on)" comment (castFizzle is actually default-ON) that
   Patch C doesn't cover — fold it in if doing the doc-only pass.

### Could-not-verify-on-this-box (not refutations)

- Wire opcodes 0x01C7/0x028A: confirmed in OUR `lib.rs:600/602`; the ACE
  `GameEventUseDone`/`GameEventWeenieError` class files are absent from the trimmed
  checkout (the WeenieError.cs header comment corroborates 0x028A). The §7/§4.2 pcap
  recipe correctly fills this gap.
- `spellcast_recoil_queue` default=False: `PropertyManager.cs` absent, but the
  DEPENDENT behavior (busy→YoureTooBusy UseDone when queue off) is code-confirmed, and
  foundation §4b (Discord lore) + our vanilla server corroborate the default.

**Bottom line:** the mechanism, root cause, all cited file:lines, the DAT/JSON ground
truth, the exact-match patch context, and the runnable 22/22 unit test are all
independently CONFIRMED. Apply the patch **with the flag flipped to default-OFF**
(mustFix #1) and it is retail-truthful, minimal, reversible, and regression-safe.

```json
{"workstream":"WS08","verdict":"PARTIAL","apply":true,"mustFix":["Flip castRejectClears to default-OFF (opt-in `=== \"on\"`) pending the queued E1-E4 1070 eye-test — shipping default-ON while queuing an eye-test violates foundation §4.3 and the castFizzle/castStateMachine introduction precedent; flip to ON in a follow-up once the eye-test passes"],"notes":"Core mechanism + root cause CONFIRMED against decomp (Handle_Item__UseDone m_cBusy-- unconditional at acclient.c:401931), ACE source (all pre-cast rejects = SendUseDoneEvent(error); 12/12 WeenieError codes exact), DAT oracle (war/void bolts casterEffect=Invalid, recoveryInterval=0), generated JSON, and the live client (kind=13/14 handlers, busy window, cancelCastSequence). Patch B context is byte-exact; unit test ran 22/22. Non-blocking accuracy fixes: §1.1 overstates fizzle-never-via-UseDone (FailCast sends UseDone(0x0402), harmlessly caught by the existing fizzle branch) and that ACE sends 0x0498 (commented-out in this ACE — dead entry, harmless). Could not verify opcodes/recoil_queue-default in the trimmed ACE checkout (both corroborated elsewhere). apply:true once default flipped to OFF."}
```
