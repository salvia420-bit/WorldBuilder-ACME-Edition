# WS13 — spell-cast-sequence.json + generator audit vs DAT truth

**Scope:** gesture-identity data truth for `data/spell-cast-sequence.json` (6,266 spells) and
its generator `scripts/gen-spell-cast-sequence.cjs`, diffed against retail DAT ground truth
(spell table `0x0E00000E`, component table `0x0E00000F`) via the WB.Terminal chorizite oracle,
cross-checked against the live ACE reference (`~/ace-server` SpellFormula.cs / Player_Magic.cs)
and the retail decomp (`acclient.c`). Focus: **all 691 War + 76 Void spells**; spot-checked all
five schools (6,266 total).

**Headline:** The generator's algorithm is **retail/ACE-correct**, and **every War and Void
spell in the shipped JSON is byte-correct against the DAT** (windup gestures, cast gesture,
fastCast, leadOnly, casterEffect/targetEffect, formulaScale). Total defects across the ENTIRE
6,266-spell table = **3 spells** with wrong data (all CreatureEnchantment / Life — **zero
war/void**), all traceable to **corrupt LSD source rows**, plus one ACE-fidelity gap
(cast-gesture-on-no-talisman) affecting 10 AoE spells (4 War, 6 Life). The fix is to make the
generator **DAT-authoritative** (source of truth = the on-box `client_portal.dat`, not LSD).

**Confidence: HIGH** — every claim below is grounded in a live DAT dump, the live ACE source,
and/or the decomp, and the regeneration diff is fully bounded (proven ≤13 spells change).

---

## 0. Method & artifacts (reproducible on this box)

DAT dumps (authoritative — this is the DAT the client actually loads):
```bash
# Component table 0x0E00000F  → /tmp/comp_table.json
echo '{"command":"chorizite-parse-dat-record","datPath":"/home/wbterminal/ac_base_dats/client_portal.dat","idHex":"0x0E00000F","typeName":"SpellComponentTable"}' \
  | DOTNET_ROLL_FORWARD=LatestMajor dotnet /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
# Spell table 0x0E00000E       → /tmp/spell_table.json  (4.5 MB, all 6266 spells, formula DECRYPTED)
echo '{"command":"chorizite-parse-dat-record","datPath":"/home/wbterminal/ac_base_dats/client_portal.dat","idHex":"0x0E00000E","typeName":"SpellTable"}' | … --stdin
```
Cross-refs read live this session:
- ACE (reference, read-only): `~/ace-server/Source/ACE.Server/Entity/SpellFormula.cs`,
  `…/ACE.DatLoader/FileTypes/SpellTable.cs`, `…/ACE.Server/WorldObjects/Player_Magic.cs`.
  (The `external/ACE/Source` checkout is partial — no DatLoader/Entity — so I cited `~/ace-server`,
  which is byte-identical on the lines the generator already cites, e.g. `HasWindupGestures` at
  `SpellFormula.cs:265`. Reference only, never edited.)
- Decomp: `/home/wbterminal/ac-headers/acclient.c` (formula encrypt/decrypt + component flow).
- Enums: `external/ACE/Source/ACE.Entity/Enum/SpellFlags.cs`, `SpellBitfield.cs`, `PlayScript.cs`.

---

## 1. VERIFIED FINDINGS

### 1.1 The scarab → windup-gesture map is DAT-faithful (confirmed fact)

The DAT component table `0x0E00000F` assigns each **scarab** a `_gesture` (MotionCommand). The
"colored powerup" is **scarab-driven, not school-driven** — the same purple gesture appears in
both high-tier War and Void spells:

| Scarab id | Name | DAT `_gesture` | MotionCommand | `_time` |
|---|---|---|---|---|
| 1 | Lead | `0x80000000` | Invalid (no-op) | 0 |
| 2 | Iron | `0x10000070` | MagicPowerUp02 | 1.0795 |
| 3 | Copper | `0x10000072` | MagicPowerUp04 | 2.0192 |
| 4 | Silver | `0x10000074` | MagicPowerUp06 | 2.875 |
| 5 | Gold | `0x10000076` | MagicPowerUp08 | 3.6765 |
| 6 | Pyreal | `0x10000078` | MagicPowerUp10 | 4.4408 |
| 110 | Diamond | `0x10000072` | MagicPowerUp04 | 2.0192 |
| 112 | Platinum | `0x10000132` | **MagicPowerUp08Purple** | 3.6765 |
| 192 | Dark | `0x10000132` | **MagicPowerUp08Purple** | 4.4408 |
| 193 | Mana | `0x10000132` | **MagicPowerUp08Purple** | 3.6765 |

**Evidence (DAT):** oracle dump of `0x0E00000F`, e.g. `"112":{…"type":"Scarab","gesture":268435762…}`
(`0x10000132`). **Our `data/spell-components.json` reproduces every scarab gesture verbatim**
(`spell-components.json:6-11,80,82,162-163`, e.g. line 82:
`"112":{…"gesture":"0x10000132","gestureName":"MagicPowerUp08Purple"…}`). ✅ School-by-school
verified: War uses scarabs {1,2,3,4,5,6,110,112,**192**,193} (Dark 192 appears in **4 War** spells,
0 Void); Void uses {1,2,3,4,5,6,110,**112**,**193**} → purple via Platinum/Mana. Example void
spell **5355 Nether Bolt VII**: scarab 112 → windup `0x10000132/MagicPowerUp08Purple`, cast
`MagicRecoilMissile` — emitted correctly in the shipped JSON.

### 1.2 The windup algorithm (one gesture PER scarab, in formula order) is ACE-correct

ACE `SpellFormula.WindupGestures` (`~/ace-server/…/Entity/SpellFormula.cs:245-263`):
```csharp
public List<MotionCommand> WindupGestures {
  get {
    var windupGestures = new List<MotionCommand>();
    foreach (var scarab in Scarabs) {                       // Scarabs = every scarab in Components, in order
      SpellComponentsTable.SpellComponents.TryGetValue((uint)scarab, out var component);
      …
      windupGestures.Add((MotionCommand)component.Gesture); // one gesture per scarab
    }
    return windupGestures;
  }
}
```
`Scarabs` (`:159-171`) iterates `Components` (the DAT **decoded** formula) keeping ids in the
`Scarab` enum {1,2,3,4,5,6,110,112,192,193}. So **multi-scarab formulas legitimately produce
multi-windup chains**, in formula order. Confirmed against DAT for War/Void:
- **Searing Disc (1783)** scarabs `[110,110]` → `[MagicPowerUp04, MagicPowerUp04]` ✅
- **Exploding Ice (2038)** scarabs `[3,2,3]` → `[MagicPowerUp04, MagicPowerUp02, MagicPowerUp04]` ✅
- **Wedding Bliss (1708)** scarabs `[1,5,6,6]` → `[MagicPowerUp08, MagicPowerUp10, MagicPowerUp10]`
  (Lead's Invalid dropped) — matches the foundation's live-validated "3-windup self chain" (§5). ✅

The generator's per-scarab loop (`gen-spell-cast-sequence.cjs:305-313`) reproduces this. It
additionally **pre-skips Lead's Invalid gesture** (`:306 if (s.comp.gesture === MOTION_INVALID) continue;`);
ACE instead enqueues the Invalid motion, which the client discards as a no-op
(`Player_Magic.DoWindupGestures` `foreach … EnqueueMotionMagic(windupGesture)` — no Invalid filter,
`Player_Magic.cs:605-647`). **Behaviorally equivalent** (both yield the same visible gesture set).

Stats (War/Void): War 691 spells → 90 multi-scarab; Void 76 → 3 multi-scarab. All verified correct.

### 1.3 `leadOnly` short-circuit is correct (confirmed fact)

Generator: `leadOnly = scarabs.length>0 && scarabs.every(s => s.id===1)` (`:295-296`), and
`fastCast || leadOnly ⇒ windupGestures=[]` (`:304`). This mirrors ACE
`HasWindupGestures => Scarabs.Any(i => i != Scarab.Lead)` (`SpellFormula.cs:265`). Because Lead's
DAT gesture is `0x80000000` (Invalid), a lead-only windup is a no-op regardless — the flag is
purely an informational branch for the consumer (fastCast vs leadOnly). ✅ War 117 / Void 10
lead-only spells, all consistent with the DAT.

### 1.4 fastCast bit = `0x4000` (confirmed fact, 3-source agreement)

`SPELL_FLAGS_FAST_CAST = 0x4000` (`gen…cjs:116`) matches ACE `SpellFlags.FastCast = 0x4000` /
`SpellBitfield.FastCast = 0x4000` (`ACE.Entity/Enum/SpellFlags.cs`, `SpellBitfield.cs`). ACE
`Player_Magic.DoWindupGestures:607` `if (spell.Flags.HasFlag(SpellFlags.FastCast) … ) return;`
and `SpellFormula.GetCastTime:334` (`FastCast … return castTime;`) both confirm FastCast ⇒ no
windup. **DAT vs LSD vs JSON all agree on fast-cast for all 6,266 spells** — DAT bitfield
`&0x4000` count = 686 == JSON `_fast_cast_count: 686`. War 65 / Void 9 fast-cast, all correct
(e.g. Nether Streak V/VII 5345/5347 → `fastCast:true, windup:[]`). ✅

### 1.5 casterEffect / targetEffect PScriptType — DAT-vs-LSD-vs-JSON near-perfect

The generator copies LSD `caster_effect`/`target_effect` verbatim (PlayScript enum values,
`gen…cjs:200-201,250-251`). Full diff DAT (`0x0E00000E` `casterEffect`/`targetEffect`/`fizzleEffect`,
resolved through `PlayScript.cs`) vs LSD across all 6,266 spells:
- **casterEffect: 0 discrepancies.** **fizzleEffect: 0 discrepancies** (not currently emitted;
  server-driven per foundation §2.3 — leave out of scope).
- **targetEffect: 1 discrepancy** — spell **5174 (Mhoire's Blessing of Power, Life)**: DAT = `31`
  (`HealthUpRed`), LSD/JSON = `35` (`HealthUpYellow`). See §2.3. **No war/void spell affected.**

Sanity spot-checks confirm the values are real PScriptType ids: e.g. 2331 Health-to-Mana →
`targetEffect 74 = SwapHealth_Red_To_Blue`; 1 Strength Other → `6 = AttribUpRed`. Note: targetEffect
is **not yet consumed** by the runtime (attribution TODO, foundation §1.2), so this is latent.

### 1.6 formulaScale is ACE-exact (confirmed fact)

Generator `SCARAB_SCALE` (`:138-149`) is byte-identical to ACE
`SpellFormula.ScarabScale` (`SpellFormula.cs:293-305`): Lead .05 / Iron .2 / Copper .4 / Silver .5 /
Gold .6 / Pyreal…Mana 1.0. First-scarab selection (`gen…cjs:258-272`) mirrors
`FirstScarab => Scarabs.First()` (`:307`), using the decoded formula order. Verified: only 1 spell
(4024) had a wrong scale, and only because its LSD formula was corrupt (§2.1).

### 1.7 **FORMULA DECODING — the generator uses the DECODED formula (charter question RESOLVED)**

The DAT `_formula` is **encrypted per-spell** with a key derived from the spell's own `_name` +
`_desc` (nibble-swapped then hashed), NOT account-keyed:
- Decomp `CSpellBase::InqSpellFormula` (`acclient.c:448870-448932`): nibble-swap each char of
  `_name`/`_desc` (`*v4 = 16 * *v4 | (*v4 >> 4)`), hash both, then
  `SpellFormula::Decrypt(&ret, hashN % 0x12107680 + hashD % 0xBEADCF45)` over `_formula._comps`.
- ACE.DatLoader applies the same decrypt when loading `SpellBase.Formula`.

The **account-name** hashing (`GetAppropriateSpellFormula`/`InqCustomizedSpellFormula`
`acclient.c:404513-404619,448947-448960` → `SpellFormula::RandomizeForName`; ACE
`SpellTable.GetSpellFormula` → `RandomizeVersion1/2/3`, `SpellTable.cs:58-172`) is a **separate,
later** step that only rewrites the **taper** slots `comps[1]/comps[3]/comps[6]`
(`SpellTable.cs:113-120,137-138,168-169`). **It never touches `comps[0]` (scarab) or the last
component (talisman).** Therefore:
- Windups (from `Components`, decoded, unscrambled) and formulaScale (FirstScarab) are
  account-independent — the generator's source is correct.
- ACE `CastGesture => PlayerFormula.Last()` (`SpellFormula.cs:271-287`) equals the decoded
  formula's last component (the taper scramble preserves talisman-last), so the generator's
  "last talisman" == ACE's `.Last()` for all normal formulas.

**Proof the generator uses the DECODED formula:** the oracle's decrypted spell-table `components`
are **byte-identical** to LSD `formula` and to the catalog `components` for 6,264/6,266 spells.
E.g. spell 75 Lightning Bolt I: DAT `components=[1,15,34,40,55]` == LSD `formula=[1,15,34,40,55]`
== catalog `["Comp_1","Comp_15","Comp_34","Comp_40","Comp_55"]`. ✅ **Confirmed: the generator
consumes the DECODED formula, not the raw-encrypted or account-scrambled form.** (The 2 exceptions
are LSD decode *bugs*, not a decode-selection error — §2.1/§2.2.)

### 1.8 Durations note — WS11 boundary (do NOT rewrite here)

The JSON's `windupGestures[].durationS` and `castGesture.durationS` come from the DAT component
`_time` field (`gen…cjs:310,322`). ACE instead computes cast time from the **player MotionTable**:
`SpellFormula.GetCastTime` and `Player_Magic.DoWindupGestures/DoCastGesture` use
`MotionTable.GetAnimationLength(MotionStance.Magic, motion, CastSpeed)` with `CastSpeed=2.0`
(`SpellFormula.cs:319-338`; `Player_Magic.cs:603` `CastSpeed=2.0f`, `:626-629` windup anim length). The two can differ. **This is WS11
territory** — I am flagging the discrepancy for coordination and leaving all `durationS`/`totalDurationS`
fields untouched. (If a Ready cast-gesture is added per §2.4, its `durationS` must be sourced by
WS11 from the Magic-stance Ready anim length, not hardcoded.)

---

## 2. ROOT CAUSES (the 3 real data defects + 1 fidelity gap)

The generator's `_missing_component_lookups: 10` header value = **exactly** spell 4024's 8
out-of-range components + spell 4904's 2 invalid components — a precise fingerprint of the two
corrupt rows below.

### 2.1 Spell 4024 "Asheron's Lesser Benediction" (CreatureEnch) — LSD high-word leak

- **LSD/catalog formula:** `[196609, 196610, 196616, 196681, 196634, 196719, 196674, 196658]`.
  Each value = `0x00030000 | correct_id` (low-16 = `[1,2,8,73,26,111,66,50]`). LSD's decode leaked
  the `formula_version`/high word into every component id.
- **DAT truth (oracle):** `components = [1, 2, 8, 73, 26, 111, 66, 50]`.
- **Mechanism:** `parseComponentIdRef("Comp_196609")` → `196609` → `compById[196609]` undefined
  (`gen…cjs:277-284`) → every component unresolved → **no scarab, no talisman** → JSON emits
  `windupGestures:[]`, `castGesture:null`, `formulaScale:1` (default). All wrong.
- **Correct output (Iron scarab 2 → MagicPowerUp02; Blackthorn talisman 50 → MagicPenalty
  0x40000034; first scarab Lead → scale 0.05):** `windup=[MagicPowerUp02]`, `cast=MagicPenalty`,
  `formulaScale=0.05`.

### 2.2 Spell 4904 "Society Master's Blessing" (CreatureEnch) — LSD wrong components

- **LSD/catalog formula:** `[1, 2, 10, 76, 28, 51, 77, 155]` — references **components 76 & 77
  which do not exist** (the table jumps 74→110), and ends in 155 (Quicksilver *Pea*).
- **DAT truth (oracle):** `components = [1, 2, 8, 73, 26, 111, 66, 190]` (ends in **Banyan
  Talisman 190** → MagicSelfHead 0x4000002C).
- **Mechanism:** LSD's row is genuinely mis-decoded (not a mask-fixable high-word leak). The
  generator resolved the *wrong* talisman (Yew 51 → **MagicHeal** 0x40000031) and wrong windup.
- **Correct output:** windup from Iron scarab 2 → MagicPowerUp02 (already correct); **cast should
  be MagicSelfHead (0x4000002C), not MagicHeal.**

Both 4024 & 4904 stem from **LSD source corruption**, not a generator-logic error. The generator
faithfully processed bad input. A `&0xFFFF` mask fixes 4024; only a DAT-authoritative source fixes
4904.

### 2.3 Spell 5174 "Mhoire's Blessing of Power" (Life) — LSD wrong targetEffect

Formula matches the DAT exactly; only `target_effect` differs: **LSD/JSON = 35 (HealthUpYellow),
DAT = 31 (HealthUpRed)**. `target_effect` is a plain (non-encrypted) u32 in the DAT, so this is a
straight LSD data error (or an LSD-vs-on-box DAT version skew). Latent today (targetEffect not yet
consumed) but should track the DAT the client loads.

### 2.4 ACE fidelity gap — cast gesture when the formula has NO talisman (10 spells; 4 War)

ACE `DoCastGesture` (`Player_Magic.cs:648-680`): `MagicState.CastGesture = spell.Formula.CastGesture;`
(`:650`) then **`if (MagicState.CastGesture == MotionCommand.Invalid) MagicState.CastGesture = MotionCommand.Ready;`** (`:678-679`)
`CastGesture` returns Invalid when `PlayerFormula.Last()` isn't a talisman (`SpellFormula.cs:279-284`).
**10 spells' formulas end in a Potion/Taper (no talisman at all)** → ACE plays `Ready` (0x40000003)
as the cast beat, but our generator emits `castGesture:null` (`gen…cjs:317-324` finds no type-5
component). Affected (verified against DAT):

| Spell | School | Formula tail | Windup (correct) | JSON cast | ACE cast |
|---|---|---|---|---|---|
| 1781 Exploding Magma | War | …46 (Turpeth) | `[]` (lead-only) | null | Ready |
| 2034 Exploding Fury | War | …46 | `[PowerUp04,PowerUp04]` | null | Ready |
| 2038 Exploding Ice | War | …46 | `[PowerUp04,PowerUp02,PowerUp04]` | null | Ready |
| 2976 Acid Spray | War | …46 | `[]` (lead-only) | null | Ready |
| 3874/3911/3940/3999/4113 (Ring/Souls) | Life | …74 (Grey Taper) | `[PowerUp04,PowerUp04]` | null | Ready |
| 4239 Ring of Death | Life | …26 (Powder) | `[PowerUp08,PowerUp10,PowerUp04,PowerUp04]` | null | Ready |

Severity: **LOW.** `MotionCommand.Ready` is the neutral Magic-stance pose; our runtime already
recoils to Ready on chain completion (foundation §1.2), so end-state matches. The only diff is a
short explicit Ready "cast" beat (and its timing). **Caveat:** in our overlay model, `setSwingMotion`
only plays commands the classifier tags `swing`/`cast` (foundation §1.3); `0x40000003` (Ready,
class 0x40 substate) may classify as a **no-op**, so emitting it might render as nothing anyway.
→ Treat as optional / eye-test-gated (§5), NOT a default correctness fix. Note 1781 & 2976 are
War spells that **currently produce ZERO cast animation** (empty windup + null cast) — mildly
relevant to symptom S1 "arms not rising," though authentic-minimal even in ACE.

---

## 3. PATCH PLAN

Guiding principle (charter + foundation §4.6): **retail truth lives in the DATs.** The generator's
one structural weakness is trusting LSD for the formula/bitfield/effects. LSD is 6,264/6,266 correct
but silently corrupt on 2 rows (+1 effect). The fix makes the generator **DAT-authoritative**, using
the same `client_portal.dat` the client loads. All hunks below are against
`scripts/gen-spell-cast-sequence.cjs` unless noted. **No runtime/JS/wasm change; no URL flag** — this
is a pure data-source correction (the "old behavior" was a bug, so there is no feel-behavior to gate).
Implementation + regeneration on the laptop.

### Patch A (PRIMARY, recommended) — DAT-authoritative source

**A1. New build step → `data/spell-table-attrs.json`** (mirrors how `spell-components.json` is
built from the DAT). Add `scripts/build-spell-table-attrs.cjs` that shells the WB.Terminal oracle
for `0x0E00000E` and emits per-spell `{formula[], bitfield, casterEffect, targetEffect,
formulaVersion, school}` (formula = DAT decrypted `components`, effects resolved to PlayScript
ints, bitfield resolved to int). Recipe (validated this session — produces the exact
`/tmp/spell_dat_attrs.json` used for the diff proof):
```
echo '{"command":"chorizite-parse-dat-record","datPath":".../client_portal.dat","idHex":"0x0E00000E","typeName":"SpellTable"}' \
  | dotnet WorldBuilder.Terminal.dll --stdin | tail -1 > spell_table.raw.json
# then map: components→formula (drop trailing 0s), bitfield/casterEffect/targetEffect enum-name→int
```

**A2. Generator: load DAT attrs, source formula/effects from it (with defensive mask + validation).**
```diff
@@ scripts/gen-spell-cast-sequence.cjs (const block, ~line 105)
 const SHAPES_PATH = path.join(ROOT, "data", "spell-shapes.json");
+const DAT_ATTRS_PATH = path.join(ROOT, "data", "spell-table-attrs.json");
 const OUT_PATH = path.join(ROOT, "data", "spell-cast-sequence.json");
@@ main(), after loading shapes (~line 211)
   const shapes = loadJson(SHAPES_PATH);
-  const lsdSpellExtras = loadLsdSpellExtras();
+  const datAttrs = loadJson(DAT_ATTRS_PATH).attrs;   // DAT 0x0E00000E, decrypted — authoritative
+  const dataWarnings = [];
@@ per-spell loop (~line 241): replace catalog-sourced componentIds
-    const componentIds = (sp.components || [])
-      .map(parseComponentIdRef)
-      .filter((n) => n !== null);
-
-    const lsdExtras = lsdSpellExtras.get(sid) || null;
-    const bitfield = lsdExtras ? lsdExtras.bitfield : 0;
+    const attrs = datAttrs[sidStr] || null;
+    // DAT decrypted formula is the source of truth. Mask to low-16 defensively
+    // (guards against any high-word/formula_version leak like LSD spell 4024).
+    const componentIds = attrs
+      ? attrs.formula.map((n) => (n & 0xffff)).filter((n) => n > 0)
+      : [];
+    const bitfield = attrs ? (attrs.bitfield | 0) : 0;
     const fastCast = (bitfield & SPELL_FLAGS_FAST_CAST) !== 0;
-    const casterEffect = lsdExtras ? (lsdExtras.casterEffect >>> 0) : 0;
-    const targetEffect = lsdExtras ? (lsdExtras.targetEffect >>> 0) : 0;
+    const casterEffect = attrs ? (attrs.casterEffect >>> 0) : 0;
+    const targetEffect = attrs ? (attrs.targetEffect >>> 0) : 0;
@@ formulaScale walk (~line 259): iterate componentIds (already DAT) instead of lsdExtras.formula
-    if (lsdExtras && Array.isArray(lsdExtras.formula)) {
-      for (const compId of lsdExtras.formula) {
+    {
+      for (const compId of componentIds) {
         if ((compId | 0) === 0) continue;
         const c = compById[compId | 0];
         if (c && c.type === TYPE_SCARAB) {
```
(Also delete `loadLsdSpellExtras`/`LSD_PATH` and update the `_comment`/`_source_files` header.)

**A3. Validation warnings (never ship silent corruption again).** After scarab/talisman detection,
record any spell whose non-empty formula produced an unresolved id or (non-fastCast, non-lead-only)
no-talisman-terminal, into `dataWarnings`, and emit `_data_warnings: dataWarnings` in the output
doc. This would have surfaced 4024/4904 at generation time.

**Regeneration result (PROVEN this session by re-running the algorithm DAT-authoritatively vs the
shipped JSON — byte-identical for 6,263 spells):** exactly **3 spells change**, none war/void:
```
4024 [CreatureEnch]: windup []→[0x10000070]; cast null→0x40000034; formulaScale 1→0.05
4904 [CreatureEnch]: cast 0x40000031→0x4000002C
5174 [LifeMagic]:    targetEffect 35→31
```

### Patch B (OPTIONAL, eye-test-gated) — ACE-faithful Ready cast gesture

For the 10 no-talisman spells (§2.4), match ACE by emitting Ready when the last component isn't a
talisman. Gate behind a generator constant so it can be regenerated off by default until the
eye-test (§5) confirms it renders as intended (see the classifier caveat in §2.4):
```diff
@@ castGesture block (~line 317)
-    let castGesture = null;
-    if (talisman) {
+    const EMIT_READY_FALLBACK = false;   // ACE Invalid→Ready; keep OFF until eye-test (§5)
+    let castGesture = null;
+    const lastCompId = componentIds.length ? componentIds[componentIds.length - 1] : 0;
+    const lastComp = compById[lastCompId];
+    const lastIsTalisman = lastComp && lastComp.type === TYPE_TALISMAN;
+    if (talisman && lastIsTalisman) {
       castGesture = { motion: talisman.comp.gesture, name: talisman.comp.gestureName || null,
                       durationS: talisman.comp.time || 0 };
+    } else if (EMIT_READY_FALLBACK && componentIds.length && !fastCast) {
+      // ACE Player_Magic.DoCastGesture: CastGesture==Invalid → MotionCommand.Ready (0x40000003)
+      castGesture = { motion: "0x40000003", name: "Ready", durationS: 0 };  // durationS → WS11
     }
```
With B on, +10 spells change (4 War, 6 Life → `cast null→0x40000003`); 6,253 byte-identical.

### Patch C (fallback if a DAT build step is rejected) — minimal LSD hardening

If adding a DAT dump step is deemed too heavy, keep LSD but (a) add the `&0xFFFF` mask (fixes 4024),
(b) ship a tiny hand-curated `data/spell-formula-overrides.json` for 4904 (`formula`) and 5174
(`targetEffect`) sourced from the DAT, applied after the LSD read, and (c) add the §A3 warnings.
Strictly inferior to Patch A (leaves LSD as the fragile primary) — present only as a fallback.

**url-flags.md row:** none required for Patch A (data correctness, no default *feel* change). If
Patch B is ever flipped on, add:
> | `castReadyFallback` | data-gen (regenerate) | off | Emit MotionCommand.Ready as the cast
> gesture for the 10 no-talisman AoE spells (Exploding/Ring series), matching ACE
> Player_Magic.DoCastGesture Invalid→Ready. **Test:** cast Exploding Ice (2038) / Ring of Death
> (4239); expect a brief neutral cast beat after the powerups. **Eye-test owed** (classifier may
> treat 0x40000003 as a no-op). |

---

## 4. TESTS

### 4.1 New node test — `tests/test_spell_cast_sequence_vs_dat.cjs`

A pure-JS regression test that loads `data/spell-cast-sequence.json` + `data/spell-components.json`
+ `data/spell-table-attrs.json` (or a checked-in DAT fixture) and asserts, for **every** spell:
- windupGestures == (fastCast||leadOnly ? [] : [scarab.gesture for scarab in formula, skip Invalid]);
- castGesture.motion == component[formula.last()].gesture iff last is a Talisman (else null, or
  Ready if Patch B);
- fastCast == !!(bitfield & 0x4000); leadOnly == every-scarab-is-Lead;
- casterEffect/targetEffect/formulaScale == DAT attrs;
- **hard-assert 0 unresolved component ids** (would have caught 4024/4904).

I have the working reference implementation from this session (the Python audit + regen at
`/tmp/ws13_audit.py`, `/tmp/regen_diff.py`); porting to `.cjs` is mechanical. Expected result after
Patch A: **0 mismatches** across all 6,266 spells.

### 4.2 Focused fixtures (assert exact values)

| Spell | Assert |
|---|---|
| 5355 Nether Bolt VII (Void) | windup `[0x10000132]`, cast `0x40000033` (MagicRecoilMissile), scale 1.0 |
| 5347 Nether Streak VII (Void) | fastCast true, windup `[]`, cast `0x40000033` |
| 1708 Wedding Bliss | windup `[0x10000076,0x10000078,0x10000078]` (leadOnly=false, Lead Invalid dropped) |
| 2038 Exploding Ice (War) | windup `[0x10000072,0x10000070,0x10000072]`, cast null (or Ready w/ Patch B) |
| 4024 (post-fix) | windup `[0x10000070]`, cast `0x40000034`, scale 0.05 |
| 4904 (post-fix) | cast `0x4000002C` (MagicSelfHead) |
| 5174 (post-fix) | targetEffect 31 |

### 4.3 TODO-FOR-LAPTOP — headless validation recipe (no live wire needed for data; render check optional)

Data correctness needs no live server. To *visually* confirm the fixed spells animate (laptop, GPU
box for eye-test):
```
python3 external/holtburger/scripts/serve.py    # :8765
# headless bot (foundation §5):
http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1
# poll window.__bootState==='in-world', then in console:
window.__em = /* EntityManager */;  // drive local prediction directly (no server dependency):
window.__sessionHandle.castTargetedSpell(window.__localGuid, 4904);  // Society Master's Blessing → expect MagicSelfHead cast after MagicPowerUp02
window.__sessionHandle.castTargetedSpell(window.__localGuid, 2038);  // Exploding Ice → expect 3 powerups (04,02,04)
# Compare JSON: fetch('data/spell-cast-sequence.json').then(r=>r.json()).then(d=>console.log(d.sequences['4904'], d.sequences['2038']))
# Expected observations: 4904 plays MagicPowerUp02 then a self-cast arm gesture (was MagicHeal); 2038 plays 3 windup powerups.
```
Acceptance (foundation §5): bare-default URL loads, spawns, casts, 0 console errors; the regenerated
JSON's war/void entries are byte-identical to today's (only 4024/4904/5174 differ).

---

## 5. EYE-TEST QUEUE (batched — do NOT run a 1070 session yourself)

Only Patch B needs a GPU eye-test; Patch A is data-correctness (no feel change on war/void).

1. **`?castReadyFallback` proof (Patch B):** with Patch B regenerated ON, arm & self-cast
   **Exploding Ice (2038)** and **Ring of Death (4239)**. **Expected visual:** the multi-powerup
   windup chain, then a brief neutral "Ready" cast beat before the effect. **Key question to
   resolve:** does `0x40000003` actually render (arms settle) or is it a classifier no-op? If no-op,
   drop Patch B. Compare side-by-side vs Patch-B-off (cast beat absent).
2. **Purple-gesture sanity (no code change, confirms existing correctness):** self-cast a
   Platinum/Mana void spell — **Nether Bolt VII (5355)** — and a Dark-scarab **War** spell (one of
   the 4 with scarab 192). **Expected:** `MagicPowerUp08Purple` windup on both (confirms the
   colored-powerup path already works for war+void). Low priority.

---

## 6. RISKS + cross-workstream interactions

**Files I would touch (implementation on laptop):**
- `apps/holtburger-web/scripts/gen-spell-cast-sequence.cjs` (generator — Patches A/B/C).
- `apps/holtburger-web/scripts/build-spell-table-attrs.cjs` (NEW build step, Patch A1).
- `apps/holtburger-web/data/spell-table-attrs.json` (NEW DAT-sourced input, Patch A1).
- `apps/holtburger-web/data/spell-cast-sequence.json` (REGENERATED output — 3 spells change, or 13
  with Patch B).
- `apps/holtburger-web/tests/test_spell_cast_sequence_vs_dat.cjs` (NEW test, §4).
- `apps/holtburger-web/docs/url-flags.md` (only if Patch B flipped on).
- NOT touched: any `.rs`, `.js` runtime, `spell-components.json` (already DAT-faithful), or any
  `durationS`/`totalDurationS` field (WS11).

**needsWasmRebuild: NO.** Pure data + data-gen script. Runtime consumes the JSON unchanged
(`entities.js:6728-6912` already handles populated windup/cast and null-cast gracefully).

**Risks:**
- **Low.** War/Void data is already correct → the regenerated JSON is byte-identical for all
  767 war/void spells and 6,253 total. Only 4024/4904/5174 (non-war/void) change under Patch A.
- Patch A adds a `.NET`-oracle build dependency to the data-gen pipeline (already precedented:
  `spell-components.json` is built from the DAT). Keep the generated `spell-table-attrs.json`
  checked in so the pipeline isn't required at every build.
- Patch B changes default cast behavior for 10 AoE spells → correctly deferred to eye-test/flag.

**Interactions with other workstreams:**
- **WS11 (durations):** OWNS `durationS`/`totalDurationS`. I deliberately left those fields
  untouched. **Coordination point:** ACE computes windup/cast time from
  `MotionTable.GetAnimationLength(Magic, motion, CastSpeed=2.0)`, not the component `_time` this
  JSON uses (§1.8). If WS11 re-times these fields, it should regenerate over the SAME schema; and
  if Patch B lands, WS11 must fill the Ready gesture's `durationS`. We must not both rewrite
  windup/cast fields in the same pass — sequence: WS13 gesture-identity fix first, then WS11
  re-times.
- **WS01 (windup-link reliability):** consumes `windupGestures[].motion`. The colored-powerup band
  (0x10000132) and the multi-windup chains this packet validates are exactly what WS01's
  `lookupMotionLinkForSwing` must resolve in the player MT `links[(0x49,Ready)]`. My finding that
  war/void windup *identities* are correct means any "arms not rising" for those spells is a
  link-resolution problem (WS01), not a data problem — hand off cleanly.
- **WS08 (cast lifecycle) / WS14 (UI feedback):** consume `fastCast`/`leadOnly`/`casterEffect`.
  Those fields are verified correct; no change to their contract.
- **No file overlap** with any other workstream except the shared `data/spell-cast-sequence.json`
  regeneration (WS11) and `url-flags.md` (append-only, only if Patch B).

---

```json
{"workstream":"WS13","title":"spell-cast-sequence.json + generator audit vs DAT truth","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS13-data-correctness.md","confidence":"high","keyFindings":["All 691 War + 76 Void spells are byte-correct vs the DAT (windup/cast gestures, fastCast=0x4000, leadOnly, caster/target effects, formulaScale) — the generator algorithm is ACE-faithful","Generator PROVENLY uses the DECODED formula: DAT decrypted components == LSD == catalog for 6264/6266 spells; formula decrypt is per-spell name+desc-keyed (acclient.c:448870-448932), account scramble only rewrites taper slots (SpellTable.cs:113-120) never scarab/talisman","Colored (purple 0x10000132) powerup is SCARAB-driven (Platinum/Dark/Mana), not school-driven — correctly emitted for war+void; Dark scarab appears in 4 WAR spells, 0 void","Only 3 defective spells in the entire 6266-table, all from corrupt LSD rows, NONE war/void: 4024 (high-word leak → empty gestures), 4904 (invalid comps 76/77 → wrong talisman MagicHeal vs DAT MagicSelfHead), 5174 (targetEffect 35 vs DAT 31)","ACE fidelity gap: 10 no-talisman AoE spells (4 War Exploding/Acid, 6 Life Ring) get MotionCommand.Ready as cast gesture in ACE (Player_Magic.cs:672) but JSON has null — low severity, eye-test-gated","Fix = make generator DAT-authoritative (new data/spell-table-attrs.json from oracle) + &0xFFFF mask + validation warnings; regeneration changes exactly 3 spells (proven), byte-identical for war/void"],"filesToChange":["apps/holtburger-web/scripts/gen-spell-cast-sequence.cjs","apps/holtburger-web/scripts/build-spell-table-attrs.cjs","apps/holtburger-web/data/spell-table-attrs.json","apps/holtburger-web/data/spell-cast-sequence.json","apps/holtburger-web/tests/test_spell_cast_sequence_vs_dat.cjs","apps/holtburger-web/docs/url-flags.md"],"needsWasmRebuild":false,"newFlags":["castReadyFallback (optional, Patch B only, default-off)"],"risks":["Low — war/void data already correct; regen touches only 3 non-war/void spells (4024/4904/5174) under the correctness patch","Adds a .NET-oracle build step for spell-table-attrs.json (precedented by spell-components.json); keep output checked in","Patch B (Ready cast gesture) changes default cast behavior for 10 AoE spells — deferred to eye-test + flag; 0x40000003 may be a classifier no-op in the overlay model","WS11 owns durationS/totalDurationS — do not co-rewrite; sequence WS13 gesture-identity fix before WS11 re-timing"]}
```

---

## VERDICT (WS13-verify)

**Verdict: CONFIRMED. apply=true (Patch A recommended).**

Adversarial reviewer, GCE buildbox, 2026-07-12. Posture: skeptical. Result: this is the most
thoroughly-grounded packet I have reviewed for this campaign. I re-ran every load-bearing DAT
dump, re-derived the central regeneration diff from scratch with my own independent code, and
re-opened every ACE / decomp / generator line cite against the live tree. **Nothing was
overturned.** All numbers reproduce to the digit.

### Independent re-verification (what I actually re-ran, not what I took on faith)

- **Scarab→gesture table (§1.1):** re-dumped component table `0x0E00000F` via the oracle. All
  10 scarab gestures + `_time` values match the packet's table **exactly** (Lead 0x80000000,
  Iron 0x10000070/1.0795, … Platinum/Dark/Mana → 0x10000132). ✅
- **The Scarab-set equivalence (the hidden load-bearing assumption):** the DAT `type=="Scarab"`
  set is **exactly** `{1,2,3,4,5,6,110,112,192,193}` == ACE's `Scarab` enum. So the generator's
  `type===TYPE_SCARAB` gate is provably equivalent to ACE's `IsScarab` filter. Talisman-set
  likewise verified; **components 76 & 77 genuinely do not exist** (table jumps 74→110),
  confirming the 4904 diagnosis. ✅
- **Central proof — full 6266-spell DAT-vs-shipped audit (my own Python, not the packet's):**
  - Gesture-identity (windup order, cast, fastCast, leadOnly, formulaScale): **exactly 2
    mismatches — 4024 and 4904 — 0 in War/Void.** War=691, Void=76 (matches). The per-field
    diffs match the packet's regeneration result verbatim (4024 windup []→[0x10000070], cast
    null→0x40000034, scale 1→0.05; 4904 cast 0x40000031→0x4000002C). ✅
  - Effects (casterEffect/targetEffect, PlayScript-resolved): **casterEffect 0 discrepancies,
    targetEffect exactly 1 — spell 5174 DAT HealthUpRed(31) vs shipped 35.** ✅
  - → **exactly 3 spells change (4024/4904/5174), none War/Void** — the packet's headline,
    independently reproduced.
- **Formula decode (§1.7, the charter's resolved question):** DAT-decrypted `components` ==
  LSD formula for **exactly 6264/6266** spells (only 4024, 4904 differ). Decomp
  `InqSpellFormula` @ acclient.c:448869-448942 verified line-by-line: name/desc nibble-swap
  (`16 * *v4 | (*v4 >> 4)` @ :448899/:448912), `Decrypt(&ret, hashN % 0x12107680 + hashD %
  0xBEADCF45)` @ :448932 — **magic constants match verbatim**; account scramble is a separate
  later step (`InqCustomizedSpellFormula`→`RandomizeForName` @ :448954-448955). ✅
- **Taper-scramble claim (§1.7):** SpellTable.cs `RandomizeVersion1/2/3` modify **only**
  comps[1]/[3]/[6]; never comps[0] (scarab) or the last (talisman). Cites 113-120 / 137-138 /
  168-169 all correct. ✅
- **§2.4 fidelity gap:** exactly **10 no-talisman spells** (4 War 1781/2034/2038/2976, 6 Life),
  all ending in Turpeth(46)/Grey Taper(74)/Powder(26), all with null shipped-cast. ACE's
  Invalid→Ready confirmed at `Player_Magic.cs:678-679` (identical line in BOTH external/ACE and
  ~/ace-server). **Bonus adversarial probe:** I checked whether the generator's "last-talisman"
  logic could ever diverge from ACE's `PlayerFormula.Last()` (mid-formula talisman + non-talisman
  last slot) → **divergence set = 0**, so no hidden gesture bug beyond the disclosed 10. ✅
- **Fingerprint (§2):** `_missing_component_lookups: 10` decomposes to **8 (4024, all leaked) +
  2 (4904, comps 76/77)** — verified against the live catalog. ✅
- **Stats:** DAT fastCast count = **686** (== JSON); multi-scarab War **90** / Void **3**; Dark
  scarab in **4 War (4264/4265/4282/4283), 0 Void** — all reproduce. ✅
- **Every generator line cite** (116, 138-149, 258-272, 277-284, 295-296, 304, 305-313, 306,
  317-324) and **every ACE SpellFormula.cs cite** (159-171, 245-263, 265, 271-287, 293-305, 307,
  313) opened and matched. ✅

### Patch review

- **Patch A hunk context matches the current tree** (6fcff2f0) exactly at the cited anchor lines
  (104-105, 211-212, 241-246, 250-251, 259-260). It is a *plan* (implementation deferred to the
  laptop per the packet); nothing is applied on this read-only box. Logic is sound, minimal,
  reversible, and DAT-authoritative per foundation §4.6.
- **No regression risk to castMove/slideCast/cmdInterp or any runtime path:** Patch A is
  pure data-gen + data (`needsWasmRebuild:false` confirmed — no `.rs`/`.js` runtime touched).
  Only cross-workstream surface is the shared `spell-cast-sequence.json` (WS11 durations, correctly
  sequenced) and `url-flags.md` (append-only, Patch B only). ✅
- **`&0xFFFF` mask + `>0` filter are safe** (all real component ids < 256; DAT source is already
  clean, so the mask is pure belt-and-suspenders). Scarab ORDER is preserved by the source switch
  (my order-sensitive audit confirms 0 reordering). ✅

### Required corrections (all MINOR — none change the verdict or block apply)

1. **`build-spell-table-attrs.cjs` (Patch A1) must handle int-form bitfields.** The oracle emits
   `bitfield` as a comma-string for 6255 spells but as a raw **int** for 11 spells (e.g. 6155–6187,
   values ~0x2xxxx with unresolved high bits). A naive `bitfield.includes("FastCast")` build step
   would crash/misparse those. Emit the raw int bitfield (the packet says "resolved to int" —
   just make sure it handles both oracle forms). I verified none of the 11 carry the 0x4000 bit,
   so fastCast is unaffected either way, but the build step must not assume the string form.
2. **Regeneration diff is spell-count-correct but field-incomplete:** 4024 and 4904 also change
   `totalDurationS` (derived from the now-populated windup/cast `_time`s). Still **exactly 3
   spells** — just note the field list for the test's expected-diff isn't only windup/cast/scale/
   targetEffect.
3. **The proposed `tests/test_spell_cast_sequence_vs_dat.cjs` + the two new Patch-A files do not
   exist yet** (correctly — this is a plan). The §4 test assertions and §4.2 fixtures are all
   independently validated by my audit (same logic, 3-spell diff / 0 war-void); the `.cjs` port
   remains to be written on the laptop. The packet's referenced `/tmp/ws13_audit.py` scratch files
   are from the author's session and are not on this box — not a defect, just don't treat them as
   checked-in artifacts.
4. **Sourcing note (transparency, not a fault):** the packet reads `~/ace-server` for
   `SpellFormula.cs`/`SpellTable.cs` because the `external/ACE/Source` checkout lacks
   DatLoader/Entity. This is read-only and disclosed; I verified those lines against `~/ace-server`
   and confirmed the `Player_Magic.cs` cites also hold against the canonical `external/ACE` at
   **identical** line numbers (603/607/678-679).

### Bottom line

The packet's most valuable output is the **negative result**: War/Void gesture-identity data is
already perfect, so the reported "arms not always rising" for war/void is **not** a data problem —
it hands off cleanly to WS01 (link resolution in `player MT links[(0x49,Ready)]`). That conclusion
is airtight. The 3 non-war/void data fixes (Patch A) are correct, low-risk, and worth doing;
Patch B (Ready cast beat) is correctly deferred behind an eye-test. **Ship Patch A; queue Patch B's
flag for the batched 1070 eye-test; fold in correction #1 when writing the build step.**

```json
{"workstream":"WS13","verdict":"CONFIRMED","apply":true,"mustFix":["build-spell-table-attrs.cjs (Patch A1) must emit the raw INT bitfield — the oracle returns bitfield as a comma-flag STRING for 6255 spells but as a raw int for 11 (none carry 0x4000, so fastCast is unaffected, but a string-only parser breaks on them)","Note in the test's expected-diff that 4024/4904 also change totalDurationS (still exactly 3 spells total); write the proposed tests/test_spell_cast_sequence_vs_dat.cjs (not yet present) + the two new Patch-A files before regen"],"notes":"Independently reproduced the entire central proof: full 6266-spell DAT-vs-shipped audit yields EXACTLY 3 changed spells (4024/4904/5174), 0 in War/Void; War=691 Void=76 byte-correct on windup/cast/fastCast(686)/leadOnly/effects/formulaScale. DAT==LSD formula for 6264/6266. All ACE (SpellFormula/Player_Magic/SpellTable) + decomp (InqSpellFormula 0x12107680/0xBEADCF45 verbatim) + generator line cites re-opened and matched. Scarab-set==ACE enum, comps 76/77 absent, §2.4 gap = 10 no-talisman spells with divergence-set 0. Patch A is data-only (needsWasmRebuild:false), context matches tree @6fcff2f0, no runtime/castMove/slideCast/cmdInterp regression. mustFixes are minor build-step hygiene; verdict unaffected. Real value = negative result: war/void arms-not-rising is WS01 link-resolution, not data."}
```
