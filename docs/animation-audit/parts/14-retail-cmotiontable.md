## What exists

**Retail has exactly one motion subsystem, loaded from a `.dat` file and shared by every animated object.** Five things make it up, all defined in `acclient.h`:

| Type | Decl | Role |
|---|---|---|
| `CMotionTable` | `acclient.h:31654` | The data-driven table (a `DBObj`/`PackObj` loaded via `CLOCache` allocator, `acclient.c:294889`). Holds 4 hashes + a default style. |
| `MotionState` | `acclient.h:31081` | The *one* authoritative current state per object: `style`, `substate`, `substate_mod` (speed), `modifier_head` (linked list), `action_head/tail`. |
| `CSequence` | `acclient.h:30747` | The playback *queue*: a `DLList<AnimSequenceNode> anim_list`, `first_cyclic`, a single `curr_anim` playhead, `frame_number`, plus `velocity`/`omega`. |
| `MotionData` | `acclient.h:57162` | One logical motion = `num_anims` + `AnimData* anims` + `velocity` + `omega` + `bitfield`. So a motion is a *list* of anims plus a rigid-body contribution. |
| `AnimData` | `acclient.h:52536` | `anim_id`, `low_frame`, `high_frame`, `framerate` — a frame-range reference with a play rate. |

`CMotionTable` (`acclient.h:31656-31660`) contains exactly four lookups and a default:
- `style_defaults` — `style → default substate` (the resting cycle for a stance)
- `cycles` — `(style<<16 | motion) → MotionData` (looping anims: idle/walk/run)
- `modifiers` — `(style<<16 | motion) → MotionData` (additive overlays)
- `links` — `(style<<16 | motionA) → {motionB → MotionData}` (the *transition* anim connecting A→B)
- `default_style`

The per-object owner is `MotionTableManager` (`acclient.h:31097`): one `CMotionTable* table`, one `MotionState state`, one `pending_animations` list.

## How it works (file:line)

**One dispatcher for everything.** `MotionTableManager::PerformMovement` (`acclient.c:330206`) is the single entry: it switches on `ms->type` and calls exactly one of three table methods — `DoObjectMotion` (`:330225`), `StopObjectMotion` (`:330235`), `StopObjectCompletely` (`:330244`). Locomotion, attacks, missiles, monster death, doors — every animated object flows through this one path mutating one `MotionState` + one `CSequence`.

**`DoObjectMotion` is a thin wrapper** over the real engine: it just calls `GetObjectSequence(..., stop_modifiers=0)` (`acclient.c:339023-339025`).

**`GetObjectSequence` (`acclient.c:337641`) is the heart — and it is a sequencer, not a blender.** The high bits of the motion id select a category:
- `0x80000000` stance/style change → `:337699`
- `0x40000000` cycle (looping locomotion) → `:337763`
- `0x10000000` command/action that resolves to a sub-state via a link → `:337842`
- `0x20000000` modifier (additive, not replacing) → `:337696`, `:337814`, `:337870`

Every category runs the *same* four-step shape (clearest at `:337736-337745`):
1. Resolve the connecting transition via `get_link(style, substate, …, motion, speed)` (`acclient.c:337585`) — the animation that bridges the current substate to the requested motion.
2. `CSequence::clear_physics(sequence)` (`:337736` → `acclient.c:340086`).
3. `CSequence::remove_cyclic_anims(sequence)` (`:337737` → `acclient.c:340154`) — drop only the *trailing looping* anims.
4. `add_motion(…, pre_link)`, `add_motion(…, link)`, `add_motion(…, cycle)` — **append, in order**, the transition frames then the new looping frames (`:337738-337741`; cycle path `:337798-337810`; action path `:337898-337901`).
Then it updates `MotionState` (`:337742-337744`) and `re_modify`s held modifiers (`:337745` → `acclient.c:337286`).

**`add_motion` (`acclient.c:337431`)** expands one `MotionData` into the queue: it sets the sequence's rigid-body `velocity`/`omega` scaled by `speed_mod` (`CSequence::set_velocity` `:337451`, `set_omega` `:337458`) — **root motion is driven by the animation data** — then for each anim builds a scaled `AnimData` (`operator*` `acclient.c:341051`) and `CSequence::append_animation` (`:337466` → `acclient.c:340590`). `append_animation` inserts the node *after the tail* (`:340618`) and only sets the playhead if none exists (`:340625-340631`). Animations are strictly enqueued.

**`remove_cyclic_anims` (`acclient.c:340154`)** walks from `first_cyclic` and unlinks the looping tail; if the playhead sat on a removed node it backs up to the previous node's *ending* frame (`AnimSequenceNode::get_ending_frame`, `:340178`). This is how retail swaps the loop *without disturbing an in-progress transition* — the one-shot link anims before `first_cyclic` survive. Siblings: `remove_link_animations(n)` (`:339954`), `remove_all_link_animations` (`:340020`), full reset `clear_animations` (`:340102`).

**Playback proves "sequenced, single playhead": `CSequence::update_internal` (`acclient.c:340659`).** Each tick it advances `frame_number += framerate*quantum` (`:340690-340696`); when it passes the current node's `high_frame` (`:340700`) it sets `advance_anim` and steps `curr_anim` to the *next node*, carrying `time_left` into it (`:340702-340709`). One playhead walks the linked list of frame-ranges back-to-back; at `first_cyclic` it loops. No weights anywhere.

**The only "layer" is the modifier channel, and it is bookkept.** `0x20000000` motions use `combine_motion` (`acclient.c:337477` → `CSequence::combine_physics` `:337501`) / `subtract_motion` (`:337506`), which *add/subtract velocity/omega* onto the sequence without clearing it, and record the motion in `MotionState::modifier_head`. After every cycle swap `re_modify` (`:337286`) re-applies them; `StopSequenceMotion` (`:337912`) removes them; `StopObjectCompletely` (`:339029`) drains the whole `modifier_head` list then stops the substate (`:339039-339050`). Even the overlay is owned by a single authority.

**Net retail model:** ONE table (data from the `.dat`) → ONE `MotionState` → ONE `CSequence` queue with ONE playhead → ONE dispatcher. Adding a motion is *data* (a link/cycle/modifier id), not code.

## Fragility & workarounds

The web client (`scene3d/entities.js`) layers ad-hoc logic on `THREE.AnimationMixer` (one per entity, `entities.js:376,1984,1992`), tracking loose `currentAction`/`currentActionKey` pointers (`:2215-2216`) and a `Map` of actions. The fragilities map directly onto missing retail primitives:

1. **No single playhead → parallel overlays → upper-body-only swings.** Attacks/missiles/emotes play as a *LoopOnce overlay* via `_tryPlayLink` (`entities.js:8145`, `setLoop(LoopOnce)` `:8200`) on top of the still-running locomotion cycle. The mixer "sums weighted poses across all enabled+play()'ed actions" (`:7110-7111`), so a swing clip that only keys upper-body bones blends additively over the leg-driving walk clip. Retail would `remove_cyclic_anims` + enqueue the swing *link* — a full-body sequenced transition — not a second simultaneous action.

2. **Blend-weight transitions vs sequenced links.** `crossFadeTo` (`entities.js:2139`, the live path at `:2196`) keeps both actions scheduled and interpolates weights. The team discovered this is wrong and hard-codes `CROSSFADE_S = 0` (`:1337`) to force a hard-cut branch (`:2155-2182`) "because retail had no blend between motions" (`:2156-2157`).

3. **Hand-reimplemented playhead.** Comments at `:2162-2174` describe manually preserving `.time` so the rig stops "rewinding to walk-cycle frame 0" — a poor reimplementation of `CSequence::curr_anim`/`frame_number` (`acclient.c:340659`). `fadeOutCurrent` (`:2223`) cites the retail equivalent by name: "the PhatSDK equivalent is to call `advance_to_next_animation()`" (`:2239-2241`).

4. **Weight-averaged "diagonal walk".** `setEffectiveWeight(0.5)` blends two cycles into a sidestep (`entities.js:7109-7114`) — a pose average with no retail analogue (retail selects a distinct sidestep *cycle* by motion id).

5. **No anim→root-motion coupling.** Retail's `add_motion` drives `velocity`/`omega` from the `MotionData` (`acclient.c:337451/337458`); three.js actions don't move the entity, so speed comes from a separate wasm integrator that "overshoots ... 25 m/s vs 4.5 m/s" and oscillates Walk→Stop→Walk (`entities.js:2165-2171`) — the very stutter the `.time`-preservation hack tries to mask.

6. **Per-clip teardown, duplicated per object class.** STOP handling is ad-hoc (`setTimeout` to disable, `entities.js:7023-7027`) instead of one `StopObjectCompletely` (`acclient.c:339029`). Monster-death and door anims each carry their own LoopOnce/clamp/stop path, so they "break independently."

## Retail (acclient) comparison

| Concern | Retail (`acclient.c`) | holtburger (`entities.js`) |
|---|---|---|
| Authority | one `MotionTableManager` → `MotionState` + `CSequence` | scattered `currentAction` pointers + per-entity `AnimationMixer` |
| Transition primitive | **sequenced link anim** appended to queue (`GetObjectSequence` `:337641`, `add_motion` `:337431`) | **weight crossfade** (`crossFadeTo` `:2139`), forced to hard-cut (`CROSSFADE_S=0` `:1337`) |
| Concurrency | single playhead `curr_anim` (`update_internal` `:340659`) | N parallel `play()`'d actions, mixer sums weights (`:7110`) |
| Layering | exactly one tracked modifier channel, additive *physics* (`combine_motion` `:337477`, `re_modify` `:337286`) | unbounded LoopOnce overlays (`_tryPlayLink` `:8145`) → upper-body-only swings |
| Root motion | anim-driven `velocity`/`omega` (`:337451/337458`) | decoupled wasm integrator (overshoots, `:2165`) |
| Add a motion | data: an id in `cycles`/`links`/`modifiers` | code: a new JS branch + clipAction path |
| Stop | one `StopObjectCompletely` drains all (`:339029`) | per-clip `fadeOut`/`setTimeout` (`:7023`) |

## Consolidation recommendations

1. **Port the `CMotionTable` sequence interpreter** (it exists open-source as PhatSDK — the code already references `advance_to_next_animation`/PhatSDK at `entities.js:2239`). One interpreter per entity holding the loaded table (style_defaults/cycles/modifiers/links), a `MotionState`, and a `CSequence` queue with a single playhead.
2. **Make motion changes data-driven** via the `0x80/0x40/0x10/0x20` id taxonomy through one `GetObjectSequence`-equivalent (`acclient.c:337641`), replacing the per-command JS branches.
3. **Replace `crossFadeTo` weight-blends with sequenced frame-range playback**: sample clip frame-ranges from one playhead (mirror `update_internal` `:340659`), appending the transition link then the new cycle (mirror `add_motion`+`remove_cyclic_anims`). This *alone* fixes upper-body-only swings — attacks become sequenced links, not overlays.
4. **Allow at most one explicitly-tracked additive channel** (the modifier/`combine_physics` analogue, `:337477`), bookkept in state and re-applied on every cycle swap — never a free-for-all of `enabled` actions.
5. **Couple root velocity/omega to the active `MotionData`** (`:337451/337458`) so locomotion speed comes from the animation, eliminating the integrator-overshoot workarounds.
6. **One `StopObjectCompletely`-style teardown** (`:339029`) for death/despawn/door, so those animations stop being independent, separately-breaking code paths.
