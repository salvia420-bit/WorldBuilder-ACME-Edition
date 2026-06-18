All claims are now verified against the actual source. I have everything needed to produce the audit.

---

# Animation System Audit — holtburger browser client

**Scope:** per-animation-type parity matrix for melee-attack, missile-attack, cast, death, door-open, jump, locomotion, emote. All citations verified by reading the source. Web root: `external/holtburger/apps/holtburger-web`. Retail reference: `/home/wbterminal/ac-headers/acclient.c`.

**Bottom line:** The working hypothesis is confirmed. There is **no single motion authority**. holtburger has **three parallel motion sub-systems plus per-type procedural side-paths**, all layered on three.js `AnimationMixer` (a weight-blend/crossfade engine). Retail drives *every* animated object through **one** sequence interpreter (`CMotionInterp` → `CMotionTable::GetObjectSequence` → one `CSequence` per object). The mismatch — blend-engine vs. sequence-chaining — is the structural root of every symptom in the brief.

---

## What exists

The motion machinery in holtburger is split across **one router with three internal dispatch paths**, plus **four procedural fallback tweens**, plus a **flag layer**:

| Component | File:line | Role |
|---|---|---|
| `setMotion(guid, cmd, stance, speed)` | `scene3d/entities.js:6522` | The nominal "router". Async, fire-and-forget. |
| `classifyMotionCommand(cmd)` | `scene3d/entities.js:1745` | Maps a MotionCommand low-16 → one of `stop`/`walk`/`run`/`idle`/`attack`/`cast`/`null`. |
| `crossFadeTo(action, key, dur)` | `scene3d/entities.js:2139` | Weight/crossfade swap between two mixer actions (the unified locomotion swap). |
| `_tryPlayLink(...)` | `scene3d/entities.js:8145` | LoopOnce **overlay** of an action clip on top of the running cycle (attacks/casts/emotes/reactions/falldown). |
| `THREE.AnimationMixer` | per-entity, `scene3d/entities.js:2006`, `:3280` | The blend engine everything funnels into. |
| `setSwingPose(guid)` | `scene3d/entities.js:5603` | Procedural **single-arm** (RIGHT_UPPER_ARM, part 13) 300 ms tween — melee/missile fallback. |
| `setCastPose(guid)` | `scene3d/entities.js:5650` | Procedural **both-upper-arms** 600 ms tween — cast fallback. |
| `playCastSequence(guid, spellId)` | `scene3d/entities.js:~5735` | Client-side state machine that *sequences* multiple `setSwingMotion` gesture clips with `sleep()`s — bespoke cast windup. |
| `setAirborne` / `_applyHumanJumpPose` / `_tickJumpPoseTween` | `scene3d/entities.js:5427`, `:5470`, `:6231` | Procedural per-part SLERP jump pose; **bypasses the mixer entirely** (pauses it). |
| `_suppressBaseCycleForOverlay(...)` | `scene3d/entities.js:8338` | Workaround that ramps the base cycle's weight to 0 so a one-shot overlay isn't blended 50/50. |
| URL flags `FULL_BODY_ONE_SHOT`, `CAST_SPEED`, `CAST_STATE_MACHINE`, `SERVER_SWING`, `MT_CLASS_FALLBACK_ON`, … | `scene3d/entities.js:584`, `:608`, `:625`, etc. | Per-fix feature gates, "pending 1070 eye-test." |

**Two trigger sources** feed `setMotion`/`setSwingMotion`:
- **Server-authoritative**: `UpdateMotion` events (KIND_MOTION_ACTION) from `scene3d/loop.js` → `setMotion`.
- **Local optimistic**: `scene3d/picking.js` combat path calls `setSwingMotion`/`setSwingPose` directly *before* the server echo (`picking.js:1147-1153` missile, `:1255-1263` melee).

---

## How it works (file:line)

### The "unified" path (only locomotion truly rides it)
`setMotion` (`entities.js:6522`) normalizes the command (Stop/Invalid→Ready substitution `:6547`, Left→Right mirror `:6567`, stance-0 inheritance `:6574`), then `classifyMotionCommand` (`:6602`) routes into **three mutually-exclusive sub-paths**:

1. **Cycle path** (`cls === walk|run|idle`) — `entities.js:6659-6868`. Builds a stance-keyed cache key (`:6661`), fetches the clip from `AnimationCache`, installs a `LoopRepeat` action (`:6787`), and swaps via `crossFadeTo` (`:6868`). `crossFadeTo` (`:2139`) hard-cuts (weight→1, no `.reset()`, preserving cycle phase) for normal swaps, or 150 ms soft-fade for Ready stance-change. **This is the canonical path** — walk/run/turn/sidestep/idle and (by reuse) death + door all land here.

2. **Action-overlay path** (`cls === attack|cast`) — `entities.js:6638-6657`. Clears any procedural tween, then `_tryPlayLink` (`:8145`) fetches the link clip from `MotionTable.links[(stance,Ready)][cmd]` and installs a **`LoopOnce` overlay** that plays *on top of* the still-running cycle, **without** touching `currentActionKey`. Comment at `:6622-6627` confirms: "OVERLAY the swing on top of the active locomotion cycle (no crossFadeTo). The walk/run continues to animate the legs while the swing animates the arms."

3. **Stop/null** — `entities.js:6603` → `fadeOutCurrent`.

### Why "unified" is a misnomer
The overlay model (path 2) is **additive blending**, not sequence chaining. three.js normalizes the overlay action and the still-running cycle to ~50/50 weight, so a full-body swing clip renders at **half amplitude** and snaps back at clip end. This is documented verbatim at `entities.js:8330-8337`:

> "Without this, three.js normalizes the overlay + still-running base cycle to ~50/50, so swings play at half amplitude and pop to the base pose in one frame at clip end. Mirrors retail's remove_cyclic_anims-then-re-add."

The "fix" (`_suppressBaseCycleForOverlay`, `:8338`) is gated behind `FULL_BODY_ONE_SHOT` (`:8299`, `:6141`).

### Local optimistic combat (the procedural layer)
`picking.js` fires the swing visual locally. For both melee (`:1255`) and missile (`:1147`): **if** `setSwingMotion` exists and a `motionCmd` resolved → real clip; **else** `setSwingPose` (single-arm tween). `setSwingMotion` (`entities.js:6014`) itself falls back to `setSwingPose` whenever the typed link lookup fails (`canPlayReal` false → `:6046`), the fetch throws (`:6067`), or the clip is null (`:6073`). `setSwingPose` (`:5603-5626`) rotates **only `parts[13]` RIGHT_UPPER_ARM** — literally an upper-body-only motion.

---

## PARITY MATRIX

| Type | Driving code path (file:line) | Unified or bespoke | Known / observed bug | Retail gap (acclient) |
|---|---|---|---|---|
| **Locomotion** (idle/walk/run/turn/sidestep) | `setMotion`→`classifyMotionCommand`→cycle path→`crossFadeTo`→mixer (`entities.js:6522,1748-1760,6659-6868,2139`) | **Unified** (the reference path) | Mostly works. Fragility: hard-cut phase-preservation hack (`:6809-6822`) to avoid foot-pop on W-tap; LRU evict mid-pause; stance-0 inheritance guard (`:6574`). | Retail re-speeds the *running* cycle in place (`change_cycle_speed`, `acclient.c:337775`) — never restarts; no phase-preservation hack needed. |
| **Melee-attack** | local: `picking.js:1255`→`setSwingMotion`(`entities.js:6014`)→`_tryPlayLink` overlay OR `setSwingPose`; server echo: `setMotion`→attack branch→`_tryPlayLink`(`:6638,8145`) | **Bespoke overlay** (path 2), not the cycle path | "Only swings the upper body": (a) fallback `setSwingPose` animates **one arm only** (`:5608`); (b) even the real clip is a LoopOnce overlay blended ~50/50 over the running cycle → **half-amplitude**, legs keep walking (`:8330-8337`). Fix gated behind `FULL_BODY_ONE_SHOT`. | Retail appends the swing as a one-shot before `first_cyclic` in the **single** `CSequence`; it drives the **whole body** and returns to the stance cycle when done — no blend, no partial-body (`acclient.c:337842,340566`). |
| **Missile-attack** | `picking.js:1145` `missileAttack` (fires projectile) + `:1147-1153` `setSwingMotion(finalMotion=aimLevel)` else `setSwingPose` | **Bespoke** — same overlay/fallback as melee | "Fires with no animation": aim-level missile cmd frequently has **no MT link** → `canPlayReal` false → `setSwingPose` single-arm tween (or non-human no-op `:5607`); projectile launch is decoupled from any draw/release animation; no two-handed bow draw exists. | Retail: the launch is a normal `0x10000000` one-shot action on the firer's `CSequence`; the projectile is itself a `CPhysicsObj` whose flight is a cycle. Same interpreter, full-body draw+release. |
| **Cast** | `playCastSequence`(`entities.js:~5735`) chains per-gesture `setSwingMotion` with `sleep`; fallback `setCastPose`(`:5650`); server echo via `setMotion`→cast branch→`_tryPlayLink` | **Bespoke client sequencer** on top of overlays — most divergent | First-frame race / missing `spell-cast-sequence.json` → hardcoded **600 ms both-arms-up vibe tween** (`setCastPose`); **remote casters get no per-spell windup** (damageTaken carries no SpellId); client/server timing fights unless `CAST_SPEED` flag on. | Retail: cast windup/release is a one-shot action animation resolved via `GetObjectSequence` (`acclient.c:337842`), chained in-sequence by `CSequence` with frame hooks firing the effect — no JS state machine, no per-spell JSON, identical path for local & remote. |
| **Death** | `setMotion(0x0011)`→`classifyMotionCommand`→`STATIONARY_COMMANDS`→`"walk"`→**cycle path** (`entities.js:1170,1808,6659`) | **Unified-by-reuse** (held LoopRepeat cycle), but no one-shot lead-in | Treated as a held looping pose, not a play-once-then-hold death animation. If MT has no `cycles[(stance,0x0011)]` entry → `fadeOutCurrent` → bare rest pose, silently (`:6760-6764`). No corpse settle. | Retail death is a one-shot action that plays out then holds the prone default cycle via the `first_cyclic` fallback (`acclient.c:340566`) — one mechanism, no special death code. |
| **Door-open** | `setMotion(0x000B On / 0x000C Off)`→`CYCLE_HELD_COMMANDS`→`"walk"`→**cycle path** (`entities.js:1304,1809`) | **Unified-by-reuse** (object-state LoopRepeat cycle) | Independently fragile: On/Off are held cycles, **not** the one-shot open/close swing; MT-miss silently → rest pose (`:6760-6764`). No open↔close transition motion. | Retail: doors are `CPhysicsObj`s with their own small `CMotionTable`; open/close are state commands resolved by the **same** `GetObjectSequence` — zero door-specific code. |
| **Jump** | `setAirborne`(`entities.js:5427`)→`_applyHumanJumpPose`(`:5470`)→`_jumpPoseTween`→`_tickJumpPoseTween`(`:6231`); **pauses the mixer** (`:6315`) | **Fully bespoke** — bypasses `setMotion`/`classify`/`crossFadeTo`/mixer entirely | No MT clip exists (cmd `0x003B` absent from all 436 retail MTs, `:1060-1066`); hand-coded per-part SLERP arms-raise tween; only wired on **local** player; 8 s stuck-airborne timeout guard (`:6231-6258`) for dropped-landing packets. | Retail jump: launch via `CMotionInterp::jump` (`acclient.c:344224`) but the visible motion is still a sequence animation; landing returns to the loco cycle. Same `CSequence`. |
| **Emote** | `setMotion`→`EMOTE_COMMANDS`→`"attack"`→`_tryPlayLink` overlay (`entities.js:1803,6638,8145`); idle-fidget timer auto-plays via same path | **Bespoke overlay** (path 2) — same as melee/cast | Link inner-key had to be the **full 32-bit** command, not low-16 (the "C3 fix", `expandActionCommandLow16` `:1865`); idle-fidget stacking guards; missing MT link → silent no-op. Functionally the *best-behaved* bespoke case. | Retail emote is a `0x10000000` one-shot action **indistinguishable in the pipeline from a melee swing** (`acclient.c:337842`) — plays once, returns to stance cycle. |

**Pattern across the matrix:** holtburger has **5 distinct mechanisms** for 8 animation types — (1) cycle/LoopRepeat, (2) LoopOnce overlay blend, (3) single-arm procedural tween, (4) both-arms procedural tween + JS sequencer, (5) mixer-bypassing per-part SLERP. Retail has **one**.

---

## Fragility & workarounds

- **Comment-vs-code default mismatch (concrete bug).** `FULL_BODY_ONE_SHOT` (`entities.js:584-599`) and `CAST_SPEED` (`:601-616`) **comments say "Default OFF … needs a 1070 eye-test,"** but the code reads `…get("fullBodyOneShot")?.toLowerCase() !== "off"` (`:595`, `:611`) — which evaluates **true when the param is absent**, i.e. the flags default **ON**. Either the half-amplitude fix is silently active in production against its documented intent, or the comments are stale. Either way it is exactly the kind of drift a single authority would eliminate. *(Worth a maintainer confirmation; I'm reporting the literal code behavior.)*
- **Three fallback layers per swing.** `setSwingMotion` degrades to `setSwingPose` on link-miss / fetch-throw / null-clip (`:6046,6067,6073`), and `setSwingPose` itself no-ops on non-humans (`:5607`). A drudge with no NonCombat link entry plays *nothing*.
- **Tween-vs-clip race.** The attack/cast branch must explicitly null `_swingTween`/`_castTween` (`:6643,6647`) because the procedural tween applies *after* `mixer.update` and would otherwise overwrite the real clip's pose for ~300 ms.
- **Overlay double-restore hazard.** `_suppressBaseCycleForOverlay` must coordinate a `finished` listener with the `HOOK_DRAIN_ON` queue path or the base weight "double-restores" (`:8352-8360`). Hand-managed weight bookkeeping.
- **Silent MT-miss everywhere.** Cycle path (`fadeOutCurrent` → rest pose, `:6760-6764`) and link path (`console.warn` + return, `:8169-8191`) both fail soft — so a broken door/death/swing is *invisible*, not a crash, which is precisely why they "break independently and need weeks of rework" to even locate.
- **Death/door/jump each special-cased.** Death and door are forced into the *locomotion* classifier sets (`STATIONARY_COMMANDS` `:1168`, `CYCLE_HELD_COMMANDS` `:1303`); jump is a separate subsystem off `setAirborne`. A change to the cycle path can regress doors; a change to the overlay path can regress emotes — no shared contract.
- **Flag soup.** At least 6 URL flags gate motion behavior, several "pending eye-test" — the system has no settled default behavior.

---

## Retail (acclient) comparison

Retail funnels **every** animated object through one path (verified in `acclient.c`):

```
CMotionInterp::PerformMovement (acclient.c:344670)   // single dispatch
  → CPhysicsObj::DoInterpretedMotion (:317753)
    → MotionTableManager::PerformMovement (:330206)   // the one funnel
      → CMotionTable::DoObjectMotion (:339023)
        → CMotionTable::GetObjectSequence (:337641)   // command → anim nodes
          → one CSequence per object (CPartArray::sequence)
... every frame:
CPartArray::Update (:325140) → CSequence::update (:340951)
```

- **`CMotionTable::GetObjectSequence` (`acclient.c:337641`)** branches purely on the command's **high bits**: `0x80000000`=style/stance (`:337699`), `0x40000000`=cycle/locomotion (`:337763`), `0x20000000`=additive modifier (`:337870`), `0x10000000`=one-shot action — attack/cast/death/emote/missile (`:337842`). Door/jump/monster/player all use the *same* resolver against their own `CMotionTable` (`acclient.h:31654`: `cycles`, `modifiers`, `links`, `style_defaults`).
- **One-shot → cycle is sequence chaining, not blending** (`acclient.c:340563-340566`): a one-shot action is appended *before* `first_cyclic`; when it runs off its last frame, `advance_to_next_animation` wraps back to `first_cyclic` and the stance cycle loops. **No weights, no crossfade.** A swing therefore drives the whole body and cleanly returns to stance — the exact behavior holtburger fakes with weight-suppression.
- **Frame hooks** (`execute_hooks`, `acclient.c:339683`) fire sounds/attack-connect/effect callbacks at authored frames — the same mechanism for all types (this is what holtburger reimplements ad-hoc as `playCastSequence`'s `sleep`-timed VFX and the swing-duration meter).
- **The only layering retail has** is additive `0x20000000` modifiers via `combine_motion` (`:337870`) — frame-data combination keyed by the table, still not weight-crossfade.

The architectural gap is categorical: **holtburger models motion as concurrent weighted clips on a blend engine; retail models motion as a single ordered animation sequence with append + cyclic-wrap.**

---

## Consolidation recommendations

1. **Build one motion authority — a `CSequence`/`CMotionInterp` analog — and route all 8 types through it.** Port the retail model: per-entity an ordered list of `(animId, lowFrame, highFrame, framerate)` nodes (`AnimData`, `acclient.h:52536`) with a `first_cyclic` marker. Advance frames yourself (`CSequence::update`, `acclient.c:340659`) and *sample* clips into the rig — do **not** use `AnimationMixer`'s weight blending for sequence transitions. This single change makes melee/missile/cast/death/door/emote behave by construction.

2. **Replace the LoopOnce-overlay blend with append-then-cyclic-wrap.** Delete the `~50/50` problem at the source: a one-shot action becomes a node appended before the cycle node; the interpreter plays it to completion (full body) then wraps to the stance cycle. Removes `_suppressBaseCycleForOverlay`, `FULL_BODY_ONE_SHOT`, and the comment/code default mismatch entirely.

3. **Delete the four procedural tweens** (`setSwingPose`, `setCastPose`, jump SLERP, and the `playCastSequence` JS state machine). They exist only because the real clip "might not resolve." Fix the resolution path once (the typed MT link lookup) and make a missing clip a *loud diagnostic*, not a silent single-arm fallback. This removes the tween-vs-clip race (`:6643`) and the non-human no-op gap (`:5607`).

4. **Fold death, door, and jump into ordinary MotionCommands.** Retail proves they need *zero* special-casing: death is a one-shot→prone-cycle, door open/close are state cycles, jump-launch is `CMotionInterp::jump` but the visual is a sequence. Remove `STATIONARY_COMMANDS`/`CYCLE_HELD_COMMANDS`/`setAirborne` as separate concepts; they collapse into the high-bit command dispatch (`GetObjectSequence`, `acclient.c:337641`).

5. **Adopt retail's frame-hook system as the single effect/timing source.** One `execute_hooks`-equivalent (`acclient.c:339683`) drives attack-connect, cast-release VFX, sounds, and swing cadence — replacing the bespoke `sleep`-paced cast chain, the F10-3 swing-duration meter, and the missile launch/animation decoupling.

6. **Retire the flag layer once the unified path lands.** `FULL_BODY_ONE_SHOT`, `CAST_SPEED`, `CAST_STATE_MACHINE`, `SERVER_SWING`, `MT_CLASS_FALLBACK_ON` are all symptoms of the blend-engine model; under sequence chaining their behaviors are either intrinsic (full-body one-shots) or unnecessary.

**Sequencing for the rework:** land the interpreter + locomotion + one one-shot type (emote, already the cleanest) behind a single `?unifiedMotion` gate; verify the append/cyclic-wrap against retail's `first_cyclic` semantics; then migrate melee → missile → cast → death → door → jump onto it and delete each bespoke path as its type moves over. The matrix above is the migration checklist.
