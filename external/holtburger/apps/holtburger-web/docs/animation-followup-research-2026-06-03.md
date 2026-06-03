# Animation Follow-up Research — Findings (2026-06-03)

Investigated the 10 candidate gaps/claims the deep-dive completeness critic surfaced. Each was verified against real code (holtburger + retail/ACE) and adversarially skeptic-checked. **Result: 5 debunked, 2 confirmed defects, 3 partial defects.** (The synthesis workflow died at the final step; this report was reconstructed from the agent transcripts.)

> Reliability note: of the 5 items that paired with an explicit skeptic record, all 5 verdicts were UPHELD at high confidence. The verification earned its keep — half the candidates were non-issues or already-correct.

## Verdict table
| Item | Verdict | Sev | Effort | Headless-fixable |
|---|---|---|---|---|
| SoundTable (0x07) selection | **confirmed-defect** | low | small | ✅ |
| Backward (-1) hooks on reverse segments | **confirmed-defect** | low | medium | ❌ (eye-test) |
| Rig part-index under **LOD** | **partial-defect** | **medium** | small | ✅ |
| MovementParameters MoveTo walk/run gate | partial-defect | low | medium | ✅ |
| PhysicsScript wire-entity DefaultScript | partial-defect | low | medium | ✅ |
| ChatPoseTable emotes | not-a-defect | — | — | — |
| CombatManeuverTable (0x30) | not-a-defect | — | — | — |
| PlayScript/EffectId VFX | not-a-defect | — | — | — |
| Crossfade=0 ("retail never crossfaded") | not-a-defect | — | — | — |
| T11 velocity→kinematics chain | not-a-defect (+ operational note) | — | — | — |

---

## Confirmed / partial defects (ranked by value-per-effort)

### 1. LOD multi-part mis-rig — **medium severity, small effort, headless** (do first)
The clothing/ObjDesc half is NOT a defect (per-index substitution preserves count+order, `lib.rs:4317-4326`). **The LOD half IS:** entity LOD substitution replaces the *whole* setup with a single degrade GfxObj (`entities.js:1660`) resolved from only `setup.parts.first()`'s degrade (`lib.rs:5495-5511`), and the spawn-time LOD block ships **unguarded** (no `DYN_LOD_ON` gate, `entities.js:1620-1666`). Retail degrades **per-part** (each `CPhysicsPart` swaps its own `CGfxObj`, stays at its index). So a multi-part rig at LOD distance collapses to one mesh → broken animation.
**Fix:** constrain LOD substitution to single-part setups (no-op for multi-part) in `_spawnImpl` ~1620-1666; per-part degrade is the larger correct fix. Validatable headless.

### 2. SoundTable (0x07) entry selection — **confirmed, small, headless** (skeptic upheld, high conf)
The CSoundTable resolution (DID, Sound enum, Wave-DID) is correct, but **entry selection diverges**: holtburger uses a probability-weighted prefix-sum (`sound_table_cache.js:219-247`); retail `GetSound` (`acclient.c:383446-383450`) uses a **uniform index** `(n-1)*RollDice(0,1)` and ignores `probability_` for selection (it's carried for a separate gate). Plus a playback-gating divergence (Bug B).
**Fix:** replace the prefix-sum with the uniform-index pick; unit-validatable.

### 3. MovementParameters MoveTo walk/run gate — partial, medium, headless
holtburger parses the 18-flag bitfield off every MoveTo packet but the animation-gate consumer (`lib.rs:29593-29596`) **discards it and hardcodes MoveTo→RunForward**. Retail `MovementParameters::get_command` (`acclient.c:346175`) picks Run vs Walk from `can_charge`/`walk_run_threshold`/`move_towards`. So server-nav'd creatures always *run* to their target instead of sometimes walking.
**Fix:** bind the `MoveToObject/MoveToPosition` data in the `lib.rs:29584-29598` match and port `get_command`.

### 4. PhysicsScript wire-entity DefaultScript — partial, medium, headless (skeptic upheld, high conf)
Headline ("intensity-tier bypassed everywhere") is **wrong** — the spell/PlayEffect path correctly ports `GetScript` (`play_effect_vfx.js:769`). **One real defect:** the wire-entity `PhysicsDesc.default_script` (`lib.rs:29175`) is treated as a 0x33 DID, but it's a **`PScriptType` enum** (`acclient.h:33153`) that must route through the `GetScript(type, intensity)` resolver like the PlayEffect path does.
**Fix:** route wire-entity DefaultScript through the same resolver chain.

### 5. Backward-direction (-1) hooks — **confirmed, medium effort, NOT headless** (skeptic upheld, high conf)
The bake reverses only frame *iteration order* for reverse segments (`lib.rs:4968-4997`) but the hook-direction gate assumes "always Forward" — so for every negative-framerate segment the behavior is **exactly inverted** vs retail (`execute_hooks` fires iff `!dir || playbackDir==dir`, forward=+1/reverse=-1, `acclient.c:339695/340726`). Backward-gated sound/particle/material hooks fire when they shouldn't and vice-versa.
**Fix:** in `build_concatenated_motion_frames` remap each reverse segment's hook direction to the segment's true playback direction. Needs an eye-test to confirm the visual.

---

## Debunked (do NOT re-litigate)
- **CombatManeuverTable (0x30):** `ui/ac_combat_maneuver.js:161-206` is a line-faithful port of ACE `Player_Melee.cs:440-475` (stance→height→type tree, 0.33/0.66 subdivision, power pick). Correct. Doc-coverage gap only.
- **ChatPoseTable emotes:** fully wired + correct end-to-end (`chat_pose_table.rs` → `SoulEmoteCatalog` → ~70 pose→MotionCommand mappings, `lib.rs:22110-22154`). Matches ACE byte-for-byte. Doc gap only.
- **PlayScript/EffectId VFX:** fully implemented (174 ids 0x00-0xAD, `PlayScript.cs:178`), exceeds the claim. One *optional* minor selection-overflow tweak in `pickScriptEntry:779`.
- **Crossfade=0:** hard-cut is **retail-correct** — `CSequence::get_curr_animframe` reads one discrete part-frame, no weighted blend ever exists (`acclient.c:339745`). Keep it. (Comment cites banned PhatSDK — re-cite only.)
- **T11 velocity→kinematics chain:** correct and complete. **Empirically confirmed:** player MT `0x09000001` has 366 cycles, **0 with velocity** — so step-1 `|velocity|` IS inert for the player (T11 premise real), and step-2 MotionKinematics RunForward is what resolves it. Step-3 GetAnimDist is NOT needed.

## ⚠ Operational finding (blocks the T1 fix going live)
The served `boot.hba` bundle was **baked 2026-06-01, before the step-2 kinematics wiring (2026-06-03)**. The velScale base-speed chain won't resolve live until you **rebake (`dat2hba`, `apps/holtburger-tools`) and redeploy `boot.hba` to `/mnt/wbterminal2/holtburger-dist`**. Without the rebake, `cycleBaseSpeed` still returns 0 for the player and velScale no-ops even with `?velScale=on`.

## Recommended order (code-only batch)
1. **LOD multi-part guard** (#1) — medium severity, small, headless.
2. **SoundTable uniform-index selection** (#2) — confirmed, small, headless.
3. **MovementParameters get_command** (#3) + **PhysicsScript wire DefaultScript** (#4) — both partial, medium, headless.
4. **Backward hooks** (#5) — confirmed, medium, but gate on an eye-test.
5. **Rebake + redeploy boot.hba** so the T11/velScale chain is actually live.
