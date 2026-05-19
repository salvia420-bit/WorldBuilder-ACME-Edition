# Swing-Pose Classification Spec — 2026-05-19

**Status:** Implementation-ready. Empirically grounded against retail motion table `0x09000001` (the canonical human character motion table) via the inspection probe at `crates/holtburger-dat/tests/motion_table_inspect.rs`.

**Owner:** open. **Predecessor:** [[chorizite-porting-plan-2026-05-19]] §8 row 8, [[motion-table-acclient-audit-2026-05-19]] §5, [[project_holtburger_motion_table_combat_path]] ("~70 LOC follow-on; `classifyMotionCommand` filter + `setSwingPoseFromMotion` are the missing wiring").

**Goal:** when ACE broadcasts a motion event with an attack-command (e.g. `SlashHigh`), the local renderer should select and play the right swing anim — instead of falling through to the default cycle-anim playback.

---

## 1. The crucial structural finding

Before this audit, our motion code treated `MotionTable.cycles` as the source of all animation lookups (`motion_data_for_cycle`). The probe revealed that **swings are NOT in cycles. They are in `links`** — the `(from_substate → to_substate)` transition table.

| Where the anim lives | Used for |
|---|---|
| `cycles[(stance, substate)]` | Looping base poses: Ready, WalkForward, RunForward, Aim*, MagicBlast (as a Magic cycle), state emotes. Stance-keyed. |
| `modifiers[(stance, substate)]` | A small set of velocity/omega overlays for turn-while-doing-something. **Only 8 entries in 0x09000001** — not where the swings live. |
| **`links[(stance, from_substate)][to_substate]`** | **All swing animations, all magic-cast animations.** Conceptually "the swing IS the transition from Ready to AttackHi". |

This matches retail `CMotionTable::GetObjectSequence` (`acclient.c:337641`) which assembles a `CSequence` from `(pre_link, motiona link, cycle anim)` — the link MotionData carries the swing keyframes, the cycle is just the post-swing return-to-Ready hold.

**Practical implication for the classifier:** to identify a swing for a given `(stance, command)` pair, look up `links[(stance, Ready=0x0003)][command]`. If hit → swing. If miss → not a swing in this stance.

---

## 2. Empirical inventory — 0x09000001 (human character)

Run `cargo test -p holtburger-dat --test motion_table_inspect -- --nocapture` to regenerate. The probe outputs 108 swing/magic link entries across these stances:

### 2.1 Melee swing stances

All swings are `Ready → AttackCmd` links. Frame range `0..-1` (full anim). Anim IDs in the `0x03xxxxxx` range (DAT type 0x03 = Animation).

| Stance | High count | Med count | Low count | Total | Notes |
|---|---|---|---|---|---|
| `HandCombat` (0x8000003C) | 3 | 3 | 3 | **9** | AttackHigh1/2/3, AttackMed1/2/3, AttackLow1/2/3. Three swing variants per height. |
| `SwordCombat` (0x8000003E) | 4 | 4 | 4 | **12** | Slash + Thrust + DoubleSlash + TripleSlash per height. |
| `SwordShieldCombat` (0x80000040) | 4 | 4 | 4 | **12** | Slash + Thrust + DoubleThrust + TripleThrust per height. (Note: no double/triple slash with a shield — those are double/triple thrust instead.) |
| `TwoHandedSwordCombat` (0x80000044) | 4 | 4 | 4 | **12** | Same as SwordCombat. |
| `DualWieldCombat` (0x80000046) | 16 | 16 | 16 | **48** | Main-hand + offhand variants of everything: Slash, Thrust, DoubleSlash, TripleSlash, DoubleThrust, TripleThrust, PunchFast, PunchSlow, all with Offhand* mirrors. |

Stances with **no swing links** (intentional — they use a different combat model):
- `BowCombat` (0x8000003F), `CrossbowCombat` (0x80000041), `ThrownWeaponCombat` (0x80000047), `AtlatlCombat` (0x8000013B), `ThrownShieldCombat` (0x8000013C) — missile stances. Attacks resolve through the `Aim*` cycles + Reload cycle (in `cycles`, not `links`).

### 2.2 Magic cast stance

`Magic` (0x80000049): **15 entries**, all `Ready → MagicGesture` links. Frame range `0..N` where N is the actual frame count (15–43 frames). Framerate 24 fps for most gestures, 30 fps for MagicPortal.

| Magic Command | Frames | FPS | Anim ID |
|---|---|---|---|
| MagicBlast (0x4000002B) | 0..16 | 24.0 | 0x0300059B |
| MagicSelfHead (0x4000002C) | 0..18 | 24.0 | 0x0300059A |
| MagicSelfHeart (0x4000002D) | 0..15 | 24.0 | 0x0300059F |
| MagicBonus (0x4000002E) | 0..24 | 24.0 | 0x030005A3 |
| MagicClap (0x4000002F) | 0..43 | 24.0 | 0x030005A1 |
| MagicHarm (0x40000030) | 0..21 | 24.0 | 0x0300059E |
| MagicHeal (0x40000031) | 0..26 | 24.0 | 0x030005A5 |
| MagicThrowMissile (0x40000032) | 0..21 | 24.0 | 0x0300059D |
| MagicRecoilMissile (0x40000033) | 0..25 | 24.0 | 0x0300059C |
| MagicPenalty (0x40000034) | 0..24 | 24.0 | 0x030005A4 |
| MagicTransfer (0x40000035) | 0..23 | 24.0 | 0x030005A2 |
| MagicVision (0x40000036) | 0..31 | 24.0 | 0x030005A7 |
| MagicEnchantItem (0x40000037) | 0..26 | 24.0 | 0x03000599 |
| MagicPortal (0x40000038) | 0..19 | **30.0** | 0x03000596 |
| MagicPray (0x40000039) | 0..16 | 24.0 | 0x03000597 |

### 2.3 Per-anim observations

- **Every link has exactly 1 anim** (n=1) — no chained anims at the link level. The framerate variance encodes weapon speed (faster weapons → higher fps).
- **Melee anims use `low_frame=0, high_frame=-1`** — `-1` means "play to the end of the anim asset" (the Animation DAT defines its own length). Magic anims use explicit `high_frame` values.
- **Same anim is sometimes reused across attack types** within a stance — e.g. TwoHandedSword's SlashHigh / DoubleSlashHigh / TripleSlashHigh all use `0x03000C2B` (the anim plays at different framerates 24/21/19.5 to compress/stretch). That's a real optimization in retail — we should respect it.

### 2.4 Sampled retail commands by ID range

For the JS classifier, the relevant ID ranges are:

| ID range | Commands | Class |
|---|---|---|
| 0x10000058..0x1000005D | Thrust/Slash {High,Med,Low} (4 each direction in different orderings) | AttackHi/Med/Low |
| 0x10000062..0x1000006A | AttackHigh/Med/Low {1,2,3} | AttackHi/Med/Low (HandCombat-only series) |
| 0x1000011F..0x1000012A | DoubleSlash + DoubleThrust + TripleSlash + TripleThrust {Low,Med,High} | AttackHi/Med/Low |
| 0x10000173..0x1000017E | OffhandSlash/Thrust + Offhand{Double,Triple}Slash | AttackHi/Med/Low |
| 0x1000017F..0x10000184 | OffhandDoubleThrust/TripleThrust | AttackHi/Med/Low |
| 0x10000186..0x1000018E | AttackHigh/Med/Low {4,5,6} | AttackHi/Med/Low |
| 0x1000018F..0x1000019A | PunchFast/Slow + OffhandPunchFast/Slow {High,Med,Low} | AttackHi/Med/Low |
| 0x4000002B..0x40000039 | Magic gestures (Blast..Pray) | MagicGesture |

---

## 3. Classifier interface spec

### 3.1 JS-side API (target: `apps/holtburger-web/scene3d/entities.js`)

```js
/**
 * Classify a motion-broadcast command. Resolves whether this is a swing
 * (and at what height) so the renderer can sample the anim at its strike
 * frame instead of looping the cycle.
 *
 * Inputs:
 *   - motionTableId: u32 (e.g. 0x09000001 for human)
 *   - stance: u32 full MotionCommand stance ID (e.g. 0x8000003E SwordCombat)
 *   - command: u32 full MotionCommand action ID (e.g. 0x1000005B SlashHigh)
 *
 * Output (one of):
 *   { kind: 'swing', height: 'Hi'|'Med'|'Lo', anim: {id, low, high, fps}, durationSec }
 *   { kind: 'cast',  anim: {id, low, high, fps}, durationSec }
 *   { kind: 'aim',   stage: 'High'|'Mid'|'Low', degrees: 15|30|45|60|75|90 }
 *   { kind: 'locomotion' }
 *   { kind: 'unknown' }
 */
function classifyMotionCommand(motionTableId, stance, command) { ... }
```

### 3.2 Wasm export to back it

Add to `apps/holtburger-web/src/lib.rs`:

```rust
#[wasm_bindgen]
pub fn lookup_motion_link_for_swing(
    motion_table_id: u32,
    stance: u32,
    command: u32,
) -> Option<MotionLinkAnimJs>;

#[wasm_bindgen]
pub struct MotionLinkAnimJs {
    pub anim_id: u32,
    pub low_frame: i32,
    pub high_frame: i32,
    pub framerate: f32,
}
```

Internally calls `MotionTable::motion_data_for_link(stance, Ready=0x41000003, command)` and returns the first anim (links always have exactly 1).

**Note on key encoding:** the probe found that `links` is keyed by the LOW 16 bits of stance + LOW 16 bits of from_substate (the wire format raw key is `(stance & 0xFFFF) << 16 | (substate & 0xFFFF)`). Our `motion_data_for_link(stance, from_cmd, to_cmd)` already encodes this correctly (per `motion_table.rs:58-67`); just pass the full MotionCommand stance value.

### 3.3 `setSwingPoseFromMotion` semantics

When a swing is detected:

```js
function setSwingPoseFromMotion(entityInstance, swing) {
  // Build a one-shot THREE.AnimationClip from the swing anim.
  // Play it once at the broadcast framerate (NOT the anim's recorded fps;
  // ACE may modulate via speed_mod).
  const clip = buildClipFromAnim(swing.anim);
  const action = entityInstance.mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce);
  action.clampWhenFinished = false;  // return to cycle when done
  action.reset();
  action.play();
  // Optional: when the broadcast carries speed_mod, scale timeScale
  // action.timeScale = speed_mod;
}
```

For the **charge-attack hold** case (per memory `project_holtburger_combat_phase_i_done_2026-05-17.md`): instead of `play()`, sample the anim at its peak frame and pause:

```js
function setHeldChargePoseFromMotion(entityInstance, swing) {
  const clip = buildClipFromAnim(swing.anim);
  const action = entityInstance.mixer.clipAction(clip);
  // Peak strike frame is typically high_frame - 1; for low/-1 anims,
  // sample at high_frame_resolved - 1 once we resolve the anim length.
  const peakFrame = swing.anim.high === -1
    ? resolveAnimLength(swing.anim.id) - 1
    : swing.anim.high - 1;
  action.time = peakFrame / swing.anim.fps;
  action.paused = true;
  action.play();
}
```

---

## 4. Implementation plan (the ~70 LOC follow-on)

### Step 1 — Symbol/classifier helpers (Rust + JS mirror)

- **Promote** the test-only `crates/holtburger-dat/tests/common/motion_command_names.rs` symbol table from test infra into runtime if it's small enough. Or: keep test-only, and add a much smaller `pub fn is_attack_command(cmd: u32) -> Option<AttackHeight>` to `holtburger-common/src/properties/motion.rs` that classifies just attack/magic commands without needing the full 409-name table. (Recommendation: the latter — runtime doesn't need the names, just the classification.)
- Add `pub enum AttackHeight { High, Medium, Low }` to `holtburger-common` (matches Chorizite.Common AttackHeight enum: High=1, Medium=2, Low=3).

### Step 2 — Wasm export

- Add `lookup_motion_link_for_swing` to `apps/holtburger-web/src/lib.rs` per §3.2.
- The export resolves the player's motion table (via `WorldState::resolve_player_motion_table_profile`), looks up the link, returns the anim spec.

### Step 3 — JS classifier

- Add `classifyMotionCommand(stance, command)` to `scene3d/entities.js`.
- Calls the wasm export.
- Returns the typed result per §3.1.

### Step 4 — JS hook

- In the existing motion-broadcast hook (where `EntityInstance.onMotionUpdate` is called), after the snapshot updates:
  ```js
  const cls = classifyMotionCommand(stance, command);
  switch (cls.kind) {
    case 'swing':  setSwingPoseFromMotion(entityInstance, cls); break;
    case 'cast':   setSpellCastPoseFromMotion(entityInstance, cls); break;
    case 'aim':    setAimPoseFromMotion(entityInstance, cls); break;
    default:       /* fall through to existing cycle playback */
  }
  ```

### Step 5 — Validation

- Use the local character (a SwordCombat-stanced player) and trigger an attack (Hi/Med/Lo).
- Confirm the swing anim plays once, then returns to the Ready cycle.
- Repeat for Magic stance + spell cast.
- Confirm missile stances (BowCombat) STILL fall through to existing aim/reload behavior (no regression).

---

## 5. Caveats + open questions

### 5.1 What we don't yet know

- **`Ready` is the assumed `from_substate` for all swings.** Verified by the probe (all 108 entries `from = 0x0003 (Ready)`). But this is a sample from one motion table (the human one). Monster motion tables may use different from-substates. Recommendation: query the table once at swing-classifier startup for the actual from_substate options, don't hardcode `Ready`.
- **What about swings from non-Ready states?** Can you swing while WalkForward? Per the data, **no** — there's no `WalkForward → AttackHigh` link. The retail client likely transitions you to Ready first (via a separate link), THEN to the swing. Our renderer can probably ignore this — if ACE broadcasts the swing, just play it.
- **`speed_mod`** — retail uses it to scale anim playback. We don't yet know if ACE forwards it. Audit follow-on.
- **Stance for missile stances** — confirmed no swings, but we should verify that what we DO see on the wire (the missile-fire motion) maps to one of the Aim cycles + Reload, not to some attack we missed.
- **Multi-stance same anim reuse** — e.g. SwordCombat SlashHigh (`0x10000441 @36fps`) vs TwoHandedSword SlashHigh (`0x03000C2B @24fps`). Different anim IDs. So the spec is correctly per-stance.
- **The `Magic / MagicGesture` count is 15, not 16.** Missing from the dump: the cycles section showed 16 MagicX entries in the Magic stance cycles. The links section has 15. Which one is missing? Cross-check before relying on the exact count.

### 5.2 Decisions deferred

- **Charge-pose vs full-play:** for melee, the swing is short (~1s at 30fps); for magic, longer (~1.5s for MagicClap). Default to `play once` for both; add `setHeldChargePoseFromMotion` only if combat-bar charge-attack visualization requests it.
- **Remote-player swing rendering:** per memory `project_holtburger_combat_phase_d_done_2026-05-17.md`, remote-player swings already fire via the `damageTaken` event's `findGuidByName` path. The motion-broadcast path should subsume that — but verify before deleting the old path.

---

## 6. Implementation cost recap

| Step | Where | Approx LOC |
|---|---|---|
| 1. `AttackHeight` enum + classifier in `holtburger-common` | `src/properties/motion.rs` | ~30 |
| 2. wasm export `lookup_motion_link_for_swing` | `apps/holtburger-web/src/lib.rs` | ~20 |
| 3. JS classifier `classifyMotionCommand` | `scene3d/entities.js` | ~30 |
| 4. JS hook in motion-broadcast pipeline | `scene3d/entities.js` | ~20 |
| 5. JS `setSwingPoseFromMotion`/`setSpellCastPoseFromMotion` | `scene3d/entities.js` | ~40 |
| **Total** | | **~140 LOC** |

Higher than the memory's "~70 LOC" estimate because that estimate assumed an existing classifier; we needed the symbol/lookup infrastructure too. Still small.

---

## 7. Coverage Honesty

- **Probe ran against exactly one motion table (0x09000001).** Monster motion tables likely follow the same pattern but were not inspected. The classifier should be data-driven (query the actual table at runtime), not hardcoded to assume 0x09000001's shape.
- **`Ready` (0x41000003) as `from_substate` is empirically the only one seen** in 108 swing/cast entries. Hard-coding it would work today, but a future motion table or patch could break that. Recommendation: query the link map directly with the destination command, ignore from_substate during classification (just check "is there ANY link where to_substate == command and the command classifies as Attack/Magic").
- **No actual wasm/JS code was written here** — this is the spec. Implementation is the next PR.
- **No retail acclient.c body was opened during this spec write** beyond what's already cited in the predecessor audit (§4-Alt of the motion-table audit). The classifier follows the model `cycles → loop, links → one-shot transition` derived from `CMotionTable::GetObjectSequence`. If implementing reveals the model is wrong, re-read `acclient.c:337641` carefully.
- **The `Magic` stance count discrepancy (15 links vs 16 cycles)** is unexplained — flagged in §5.1. Worth a 5-min dig before shipping.

---

## 8. Validation against all 436 motion tables (added 2026-05-19)

Per §7 ("probe ran on ONE motion table"), the next step was to validate the spec against monster motion tables. Two new tests added to `crates/holtburger-dat/tests/motion_table_monsters.rs`:

1. `validate_swing_pattern_against_all_motion_tables` — runs the swing-extraction logic across every motion table in `client_portal.dat` (0x09000000..=0x0900FFFF), reports aggregate stats + deep-dives a stratified sample.
2. `assert_spec_assumption_swings_only_in_links` — asserts that for every table, no melee-attack substate appears in `cycles` (the load-bearing claim of the spec).

**Both PASS across all 436 tables.**

### 8.1 Aggregate validation results

| Metric | Count |
|---|---|
| Total motion tables surveyed | 436 |
| Tables with ≥1 attack-link (melee swings) | 278 / 436 (63.8%) |
| Tables with ≥1 magic-link (cast gestures) | 48 / 436 (11.0%) |
| Tables with any swing/cast activity | 278 / 436 |
| **Attack-cycle collisions (SPEC VIOLATION if >0)** | **0 / 436 ✓** |
| Magic-cycle collisions (EXPECTED — cast-link + held-cycle pair) | 48 / 436 |
| Modifier collisions | 0 / 436 |
| Tables with multi-anim swing links | 0 / 436 ✓ |
| Total swing/cast link entries (across all tables) | **5,455** |
| Distinct `from_substate` values seen across all 5,455 entries | **1 (only `Ready = 0x0003`)** ✓ |
| Anim-count distribution on swing links | **anims=1 for all 5,455 entries** ✓ |

The spec's three load-bearing assumptions are all empirically universal:
- "Swings live in links, not cycles" — verified across 436 tables, 5,455 entries
- "`Ready` is the from_substate" — verified across all 5,455 entries
- "Swing links have exactly 1 anim" — verified across all 5,455 entries

### 8.2 Two new findings that revise the spec

**Finding A — Monster tables use the `NonCombat` stance for swings.**

The human motion table puts swings in dedicated combat stances (SwordCombat, BowCombat, etc.) — NonCombat is just the "weapon-stowed" pose. But sampled monster tables put attacks in NonCombat too:

| Sample table | Stances with attack-links |
|---|---|
| `0x09000001` (human) | HandCombat, SwordCombat, SwordShieldCombat, TwoHandedSwordCombat, DualWieldCombat. **NonCombat has zero attack-links.** |
| `0x090000F1` | HandCombat **+ NonCombat** + SwordCombat |
| `0x0900015B` | HandCombat **+ NonCombat** (no dedicated combat stance) |
| `0x090001D0` | **NonCombat ONLY** (NonCombat has 4 attack-links; no combat stance variants) |
| `0x090001DB` | NonCombat-only |

**Implication for the classifier:** must NOT assume swings only live in combat-named stances. The §3 spec was already correct on this — `lookup_motion_link_for_swing(motion_table_id, stance, command)` is called with the current stance regardless of name, and the link map either has an entry or it doesn't. Monsters in NonCombat-only motion tables work the same as humans in SwordCombat: the swing comes through if the link exists.

**Finding B — Magic-gesture substates appear in BOTH `cycles` AND `links`.**

The spec's §1 table claimed "magic gestures-as-state" appear in cycles, but didn't connect the dots to also appearing in links. Validation:

- 48 tables have ≥1 magic link.
- 48 tables also have a "magic-cycle collision" (same magic substate present in both maps).
- These are **the same 48 tables** — the duplication is structural, not coincidental.

The reason: a magic cast in retail plays the **gesture animation** (the LINK from Ready → MagicBlast), then **holds the end pose** (the CYCLE entry for MagicBlast as a sub-state of the Magic stance). The two MotionData entries have different anim data — the link's is the cast-startup keyframes, the cycle's is the static held pose.

**Implication for the classifier:** if the wire broadcast is `(Magic stance, MagicBlast command)`, the classifier should prefer the link (the visible cast animation). If it's missing or the classifier wants the held pose specifically (e.g. for a charge/hold), use the cycle. For our JS implementation, always start with the link.

### 8.3 Updated implementation status

The implementation plan in §4 stands. Two clarifying updates baked in:

- Step 3 (JS `classifyMotionCommand`): document that the classifier is intentionally stance-agnostic — passes `stance` through to the wasm export but doesn't switch behavior based on stance name.
- Step 5 (JS pose-applier): for magic gestures specifically, the link's anim is the cast-startup (typically 15-43 frames @ 24/30 fps). When that finishes, falling through to the cycle anim (the held end-pose) is the right behavior — the THREE.AnimationMixer crossfade handles this naturally.

### 8.4 What §8 changes about §7 (coverage honesty)

- §7's "Probe ran on ONE motion table" caveat is now resolved — 436 tables verified.
- §7's "Ready as from_substate is empirically the only one seen" — now verified across 5,455 entries.
- §7's "Magic stance has 15 links vs 16 cycles — 1-entry discrepancy unexplained" — was a miscount in the original spec write; the actual relationship is "15 link + 15 cycle pairs in the human's Magic stance, plus the other 20 cycles in Magic are non-gesture (Ready, WalkForward, etc.)". Mystery resolved.
- §7's "Multi-anim swing links" concern — confirmed never happens (5,455/5,455 are single-anim).
- New caveat added in §8.2: the classifier MUST be stance-agnostic for monster support.

### 8.5 Re-running the probe on a specific table

```bash
# Sweep + deep-dive sample
cargo test -p holtburger-dat --test motion_table_monsters \
  validate_swing_pattern_against_all_motion_tables -- --nocapture

# Pattern-violation assertion (passes silently)
cargo test -p holtburger-dat --test motion_table_monsters \
  assert_spec_assumption_swings_only_in_links

# Deep dive on a specific table (edit HUMAN_MOTION_TABLE_ID in motion_table_inspect.rs)
cargo test -p holtburger-dat --test motion_table_inspect -- --nocapture
```

---

*Spec ready, monster-validated. Cross-link: [[motion-table-audit-2026-05-19]] §5 + §8, [[chorizite-porting-plan-2026-05-19]] §8 row 8, [[project_holtburger_motion_table_combat_path]]. Probe sources: `crates/holtburger-dat/tests/motion_table_inspect.rs` (single-table deep dive) + `crates/holtburger-dat/tests/motion_table_monsters.rs` (436-table sweep). Symbol table: `crates/holtburger-dat/tests/common/motion_command_names.rs`. Test fixture: `/home/wbterminal/ac_base_dats/client_portal.dat`.*
