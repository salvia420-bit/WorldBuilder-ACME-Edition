# Motion-Parity Method (swing-pose classifier — Wave 3.C)

Companion to [`physics-parity-method.md`](physics-parity-method.md) (Wave 3.B),
[`wire-conformance-method.md`](wire-conformance-method.md) (Wave 1),
[`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C),
[`world-completeness-method.md`](world-completeness-method.md), and the other
completeness docs.

This doc covers the swing-pose classifier slice of Wave 3 motion parity
per the [diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md)
§6 Wave 3 row W3.C.

Status: **shipped 2026-05-19** (W3.C).

**Status update (2026-05-25):** W3.E (Rust port of the swing classifier
+ wasm export) DID ship 2026-05-19 — see memory
`project_w3e_done_2026-05-19`. The note above at line 53 ("is **not yet
implemented** as of 2026-05-19") was written EARLY in the day and the
W3.E ship happened later that same day; the doc was never refreshed.
Shipped artifacts: `parseMotionLinkForSwingBytes` free wasm export +
`SessionHandle::lookupMotionLinkForSwing` method (both in
`apps/holtburger-web/src/lib.rs`) + `classifyMotionCommandTyped`
non-breaking widening in `scene3d/entities.js` + `validate_motion_pose
.cjs --js-vs-cs` flag (52/52 of C# PASS rows match JS, target was
≥30/52). The wave-7 commit `7c0b4545` later added runtime
observability over the motion-link lookup path. Wave 7.1 (`54bbe206`)
wired `CombatManeuverTable` (DAT 0x30) into `picking.js` melee
dispatch, replacing the vibe-pose placeholder with a real motion-link
consult. The W3.C-era "oracle only" gap is fully closed.

## The contract

For any retail motion table `T` ∈ portal.dat, any stance `S`, any
attackHeight `H` ∈ {High=1, Medium=2, Low=3} (or Magic stance with any
height):

```
MotionClassifySwing(T.id, S, H) ≡
    spec("swing-classification-spec-2026-05-19.md").classify(T, S, H)
```

The "classify" function is the algorithm at spec §3:

1. Look up `T.Links[outerKey]` where `outerKey = (S & 0xFFFF) << 16 | 0x0003`
   (Ready substate per spec §1's "links[(stance, Ready) → AttackCmd]" model).
2. If absent → return `no-link-for-stance` (legitimate: stance has no
   swings in this table, e.g. monsters without a melee stance or missile
   stances like BowCombat).
3. Walk the candidate MotionCommand list for the given attackHeight
   (or magic candidates if `S == MotionStance.Magic`).
4. First candidate whose full 32-bit value is a key in
   `T.Links[outerKey].MotionData` wins; return its `AnimId/LowFrame/HighFrame/
   Framerate`.

The classifier is **stance-agnostic** per spec §8.2: monster tables put
swings in `NonCombat` stance, named-weapon tables put them in
`SwordCombat/HandCombat/etc`. The classifier MUST NOT branch on stance
name — it just consults the link map and returns what's there.

## Why this method exists

Per memory [[project_holtburger_motion_table_combat_path]] and
[[project_swing_classification_spec_2026-05-19]]: the JS-side
`classifyMotionCommand` at
`external/holtburger/apps/holtburger-web/scene3d/entities.js:304-318`
returns only a coarse string category ("attack"/"cast"/"walk"/"idle"/
"stop"/null) when given a motion command. It does NOT walk the
motion-table `Links` to resolve a specific swing animation. The wasm
export `lookup_motion_link_for_swing` proposed in spec §3.2 is **not yet
implemented** as of 2026-05-19.

That means swing-pose drift can land silently — a creature broadcasts
a `SlashHigh` motion event, the renderer dispatches to a default cycle
playback, and the user sees no visible swing. The cell-portal graph
audit + the motion-table audit + the spec all surfaced this; Wave 3.C
provides the C# oracle so a future port can be diffed against it.

## The three load-bearing invariants

Per the spec's §8.1 validation (5,455 link entries across 436 retail
motion tables, 0 violations):

1. **Swings live in `Links`, not `Cycles`.** Per
   `acclient.c:337641 CMotionTable::GetObjectSequence`, the link's
   `MotionData` carries the swing keyframes; the cycle is the
   return-to-Ready hold.
2. **`Ready = 0x0003` is the only `from_substate`.** Across 5,455
   entries, every from_substate is the LOW-16 of `Ready =
   0x41000003`. The classifier hardcodes this.
3. **Each swing link has exactly 1 anim.** No chained anims at the
   link level; framerate variance encodes weapon speed.

## The key encoding (the subtle bit)

`MotionTable.Links` is a `Dictionary<int, MotionCommandData>`:

- **Outer key**: `(stance & 0xFFFF) << 16 | (from_substate & 0xFFFF)`.
  E.g. `(SwordCombat 0x3E << 16) | 0x0003 = 0x003E0003`.
- `MotionCommandData.MotionData` is itself a
  `Dictionary<int, MotionData>` keyed by **the FULL 32-bit
  MotionCommand**, NOT a 16-bit substate. E.g. `SlashHigh =
  0x1000005B` is the key, not `0x005B`.

This was the load-bearing bug the implementor hit during smoke (see
the 0% → 100% pass-rate flip after fixing): the spec docs and Rust
probe at `motion_table_inspect.rs:337` both mask the inner key with
`& 0xFFFF` when classifying, but the underlying DRW C# library reads
the dictionary keys as the raw `int` from the wire. The classifier
must use the FULL 32-bit candidate, not just its LOW-16.

## What the validator proves

`validate_motion_pose.cjs` drives 30 deterministically-sampled motion
tables × 5 (stance × attackHeight) combos = 150 cases:

- 2 known-high-value tables: `0x09000001` (human/character),
  `0x09000202` (DRW EOR test fixture).
- 28 stride-sampled tables across the 436-table inventory.
- 5 combos: SwordCombat × (High/Med/Low), Magic × High, BowCombat × High.

Per-case status:

- **PASS**: classifier returned a resolved swing cmd, and we didn't
  expect this stance to be missing for this creature.
- **PASS (expected-missing)**: combo was a missile stance (BowCombat)
  for which spec §2.1 says "no swing links" — validator confirms the
  `no-link-for-stance` return.
- **SKIP (stance-not-supported)**: combo asked for SwordCombat / Magic
  swings on a creature whose motion table simply doesn't have that
  stance. Legitimate: drudges + monsters use NonCombat / HandCombat.
- **FAIL**: classifier returned `no-candidate-matched` despite the
  table having a link for the requested stance — actual drift.

Baseline run 2026-05-19 against `client_portal.dat`
(`dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4`):

- **150 cases**: 52 PASS, 0 FAIL, 98 SKIP.
- **100% pass+skip-with-reason rate** (target: ≥80%).
- Per-stance: SwordCombat 18 pass / 72 skip; Magic 4 pass / 26 skip;
  BowCombat 30 pass (all "expected-missing confirmed") / 0 skip.

Report path:
`/mnt/wbterminal1/holtburger-validator-reports/motion-pose/<ISO-ts>/report.json`.

## Scope honesty

What this method explicitly does NOT cover:

- **End-to-end JS/wasm cross-port comparison**: the wasm export
  `lookup_motion_link_for_swing` and the JS classifier widening to
  walk links don't exist yet. The validator therefore runs in
  **oracle-only mode**: it confirms the C# classifier matches the
  spec but cannot diff against a Rust mirror. Cross-port comparison
  deferred to Wave 3.E (Rust port of the classifier; ~50 LOC per spec
  §6's implementation-cost table).
- **`from_substate` other than Ready**: the spec validates that
  Ready=0x0003 is the only from_substate across 5,455 retail entries.
  If a future patch introduces a non-Ready from_substate (a "swing
  from WalkForward" link), this classifier returns `no-link-for-stance`
  and the validator surfaces it as a SKIP — which IS the desired
  behavior (flag, don't auto-adapt).
- **Motion-table animation hooks** (Sound, CreateParticle, etc.) — that's
  `motion-table-anim-hooks` (W3 plan row 11), a separate brick.
- **The `Modifiers` map** — overlay anims for turn-while-attacking,
  velocity composition. Out of scope; spec §1's "where the anim lives"
  table calls these out as not-where-the-swing-is.
- **Speed_mod modulation** — per spec §5.1, retail uses `speed_mod` to
  scale playback. We don't know yet if ACE forwards it; audit follow-on.

## The dispatch + entry points

```jsonc
// motion-inventory — list motion tables present in the DAT
{ "command": "motion-inventory" }
// → { "count": 436, "entries": [{ "id": "0x09000001", "linkCount": 318, ... }, ...] }

// motion-classify-swing — one classification
{
  "command": "motion-classify-swing",
  "motionTableId": "0x09000001",
  "stance": "0x8000003E",       // SwordCombat (also accepts 62)
  "attackHeight": 1              // High
}
// → {
//     "resolvedMotionCmd": "0x1000005B",   // SlashHigh
//     "linkClass": "Melee_High",
//     "animId": "0x03000441",
//     "lowFrame": 0, "highFrame": -1,
//     "framerate": 36,
//     "outerLinkCount": 318, "innerLinkCount": 33,
//     ...
//   }
```

Both commands run against `~/ac_base_dats/client_portal.dat` per
memory [[feedback_base_dats_only_for_bake]]. Path override via
`datPath` field. Run time: ~500ms cold (DAT open); ~50ms warm.

## Source references

- **Spec**:
  [`external/holtburger/docs/swing-classification-spec-2026-05-19.md`](../external/holtburger/docs/swing-classification-spec-2026-05-19.md)
  + the appended §8 validation against all 436 motion tables (5,455
  link entries, 0 violations).
- **Audit memory**: [[project_motion_table_audit_2026-05-19]] (436
  motion tables parsed cleanly, matches C# DRW EOR test) +
  [[project_swing_classification_spec_2026-05-19]] (monster-validated,
  classifier stance-agnostic).
- **Spec source 1 — retail**: `~/ac-headers/acclient.c:337641`
  (`CMotionTable::GetObjectSequence` — the canonical sequence
  assembly model).
- **Spec source 2 — DRW**:
  `external/DatReaderWriter/DatReaderWriter/dats.xml:3711-3748`
  (the MotionTable schema, esp. the `Links` Dictionary structure).
- **Probe sources**:
  `external/holtburger/crates/holtburger-dat/tests/motion_table_inspect.rs`
  (single-table deep dive) +
  `external/holtburger/crates/holtburger-dat/tests/motion_table_monsters.rs`
  (436-table sweep + violation assertions).
- **JS-side classifier (coarse, doesn't walk links yet)**:
  `external/holtburger/apps/holtburger-web/scene3d/entities.js:304-318`.
- **C# oracle (this brick)**:
  `WorldBuilder.Terminal/CommandEngine.MotionParity.cs::MotionClassifySwing`.
- **Validator**:
  [`external/holtburger/apps/holtburger-web/validate_motion_pose.cjs`](../external/holtburger/apps/holtburger-web/validate_motion_pose.cjs).

## Memory cross-references

- [[project_swing_classification_spec_2026-05-19]] — the spec this
  brick ports
- [[project_motion_table_audit_2026-05-19]] — 436-table validation
  the spec rests on
- [[project_holtburger_motion_table_combat_path]] — the "~70 LOC
  follow-on" memory entry this brick resolves the C# half of
- [[reference_ac_re_artifacts]] — retail decomp source
- [[feedback_three_source_cross_reference]] — oracle precedence rule
- [[feedback_dat_parser_mislabels]] — acclient.c wins on
  disagreement (load-bearing for the inner-key encoding bug fix)
- [[feedback_base_dats_only_for_bake]] — DAT path discipline
