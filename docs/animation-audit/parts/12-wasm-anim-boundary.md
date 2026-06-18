I now have complete evidence. Here is my audit.

---

## What exists

The wasm→JS animation boundary is a **single, well-defined data contract** carried by one wasm-bindgen struct, `EntityAnimationData` (`src/lib.rs:15510-15567`), produced by `fetchEntityAnimationKeyframes` and consumed by exactly three JS modules:

- **`scene3d/animation.js`** — `buildAnimationClip()` + `AnimationCache`: turns the flat keyframe buffer into a `THREE.AnimationClip` of named per-part tracks.
- **`scene3d/adapter.js`** — `meshToGeometryGroups()` (mesh→`BufferGeometry`) and `acQuatToThree()` (the canonical quat-order converter).
- **`scene3d/setup_rig.js`** — `applyRestPoseFrame()` / `buildPartSurfaceMeshes()` / `createPartFramesProxy()`: the single owner of part-array → `Object3D` construction.

The struct ships **eight parallel arrays** keyed by part index, all in DAT-native units and ordering:

| Field | Layout | Source |
|---|---|---|
| `partFrames` | `[(x,y,z, qw,qx,qy,qz) per part] per frame`, flat f32 | `lib.rs:15516-15519`, getter `:15621` |
| `frameTimes` | per-frame absolute clip time (s), honours per-AnimData rate + reverse | `:15520-15523`, `:15631` |
| `posFrames` | per-frame cumulative root translation (x,y,z) | `:15524-15533`, `:15644` |
| `rootMotionNet` | net rigid clip displacement `[tx,ty,tz, qw,qx,qy,qz]` | `:15534-15538`, `:15658` |
| `restOrigins` / `restOrientations` | per-part rest pose (xyz / w-first quat) | `:15553-15566`, `:15673`/`:15681` |
| `hooks` | sorted-by-time `AnimationHookJs` (sound/particle/material) | `:15541-15552`, `takeHooks` `:15701` |
| `partMeshes` | rest-pose per-part `ModelMesh`, one per `setup.parts[i]` | `takePartMeshes` `:15608` |

**Verdict up front: the data IS faithful, and the gap IS purely JS-runtime.** Details below.

---

## How it works (file:line)

**Stage 1 — wasm extraction (DAT bytes → flat buffer, verbatim).**
`build_entity_animation_data_inner_v2` (`lib.rs:15846`) resolves the cycle (`try_resolve_cycle_frames`) or one-shot link (`try_resolve_link_frames`, `:15935`), then flattens the resolved `AnimationFrame`s frame-major:

```
lib.rs:15997-16021
  for (frame_idx, af) in frames { for pi in 0..part_count {
      part_frames.push(f.origin.x/y/z);                       // 3 floats
      part_frames.push(f.orientation.w/x/y/z);                // 4 floats, W-FIRST
  } ... per-frame hooks tagged with frame_time }
```

The struct doc is explicit that this is a **zero-transform passthrough**: *"No reordering at the wasm boundary: ship DAT bytes verbatim so the contract is trivial to inspect / cross-reference against the parsed `setup_model::AnimationFrame`"* (`lib.rs:14913-14918`). The only derived scalar is the back-compat `framerate = num_frames/duration` (`:16031`), and JS prefers the exact per-frame `frameTimes` over it anyway.

**Stage 2 — JS clip build (the one place data is reshaped).** `buildAnimationClip` (`animation.js:63-225`):
- Reorders the quaternion w-first→xyzw during the copy: `quatValues = [qx,qy,qz,qw]` from `flat[base+3..6]` (`animation.js:162-171`) — lossless, the documented AC↔three.js convention also centralized in `acQuatToThree` (`adapter.js:1035-1037`) and `applyRestPoseFrame` (`setup_rig.js:85-90`).
- Adds the per-frame root-motion offset to **every** part's position track (`animation.js:156-161`) — a deliberate composition, matching ACE `Sequence.cs`.
- Emits two tracks per part named **`part_${p}.position`** and **`part_${p}.quaternion`** (`animation.js:195-210`), both `InterpolateDiscrete` to mirror retail's `(long)floor(frame_number)` key-snap (`animation.js:174-194`).
- `partNames` are generated positionally as `part_0..part_{N-1}` (`animation.js:544-547`) — i.e. the binding is by **part index**, not semantic bone name.

**Stage 3 — rig build + bind.** Spawn loop (`entities.js:3139-3203`) creates one `THREE.Group` per part named `partGroup.name = `part_${p}`` (`:3141`), applies the rest pose via `applyRestPoseFrame` (`setup_rig.js:78-91`), builds per-surface meshes via `buildPartSurfaceMeshes` (`setup_rig.js:118-146`), then `root.add(partGroup)` — a **flat, root-parented rig** (no bone hierarchy). `new THREE.AnimationMixer(root)` (`entities.js:3280`) binds each clip track to the `part_${p}` child by name and plays via `clipAction` (`:3299`). Mesh geometry itself is copied position/uv/normal-verbatim from the triangle soup (`adapter.js:788-798`).

So the index chain is end-to-end positional and unbroken: `setup.parts[i]` → `partMeshes[i]` → `partGroup "part_i"` → clip track `part_i.*` → `partFrames[(f*partCount+i)*7 ..]`.

---

## Fragility & workarounds

The **boundary itself is robust**; the fragility lives in the *invariant it depends on* and in the runtime that consumes it:

1. **The positional part-index invariant is unenforced across two paths.** `AnimationFrame.frames[i] ↔ SetupModel.parts[i] ↔ rig "part_i"` is load-bearing but only *structurally* guaranteed at spawn. Two paths can break it:
   - **ObjDesc/ClothingTable `AnimPartChange`** part-swaps. The hot-swap path guards it defensively: `if (newPartGroups.length !== inst.parts.length) return false` → forces despawn+respawn (`entities.js:7413`). That's a workaround, not alignment-preservation — a swap that keeps the same *count* but reorders parts would silently mis-bind.
   - **Dynamic LOD / `GfxObjDegradeInfo`** rig substitution — flagged untested against this invariant (`animation-deep-dive-2026-06-02.md:1230`).

2. **Padding-vs-clamp micro-divergence.** When an `AnimationFrame` has fewer parts than the setup, wasm pads the missing part to identity `[0,0,0,1,0,0,0]` (`lib.rs:16007-16009`), collapsing it to model origin; retail instead *clamps the loop* and leaves the part at its prior frame (see retail comparison). Rarely hit (animframes normally cover all parts), but it's a real behavioral difference at the boundary.

3. **The "no cycle resolved" sentinel is overloaded.** Empty `partFrames` + `numFrames==0` + `framerate==0` means *both* "raw GfxObj 0x01, no skeleton" and "MotionTable missing this (stance,command)" (`lib.rs:14928-14932`, `:15953-15967`). JS treats both as "render rest pose only" (`animation.js:83-86`) — correct, but it means a *missing* attack/missile clip and a *legitimately-static* prop are indistinguishable downstream, so a missing-clip defect surfaces only as "nothing animates," not an error.

4. **The runtime overlay model is the actual defect surface** (not the data). Attacks/casts/missiles/deaths all route through `_tryPlayLink` as a **LoopOnce overlay layered on the still-running locomotion cycle** via concurrent `AnimationMixer` actions (`entities.js:1105,1143,1188,1229`; classifier `setMotion`). The mixer weight-blends the two clips. "Attacks only swing the upper body" is the textbook outcome: the locomotion action keeps driving the legs while the swing action visibly moves only the parts whose keyframes diverge — a **blend artifact, not missing data** (the full-body swing keyframes are present and faithful per Stage 1). "Missiles fire with no animation" is the missing-link sentinel (#3) silently no-op'ing. "Monster-death / door break independently" is each one-shot being its own ad-hoc overlay with no shared sequence authority.

---

## Retail (acclient) comparison

Retail's per-part update is **structurally identical to holtburger's flat-rig model**, which is exactly why the data port is faithful:

```c
// acclient.c:326601  CPartArray::UpdateParts(this, Frame *frame)
v3 = CSequence::get_curr_animframe(&this->sequence);          // :326611
v4 = min(this->num_parts, v3->num_parts);                      // :326616-326617  (CLAMP)
for (i = 0; i < v4; i++)
    Frame::combine(&parts[i]->pos.frame, frame, &v3->frame[i], &scale);  // :326624
```

Key correspondences:

- **Per-part = `object_frame ⊗ animframe.frame[i] ⊗ scale`** (`:326624`). `animframe.frame[i]` is **absolute model-space, indexed by part** — not a parent-relative bone transform. Holtburger reproduces this 1:1: flat rig + per-part `part_i.*` tracks + rest-pose compose against `root`. The deep-dive confirms building a bone tree from `parent_index` would *double-apply* and is wrong (`animation-deep-dive-2026-06-02.md:1206`). **The flat rig is retail-correct, not a shortcut.**
- **Clamp vs pad** (`:326616-326617`) — retail loops `min(num_parts, animframe.num_parts)` and never touches surplus parts; holtburger pads surplus parts to identity (Fragility #2).
- **`CSequence::get_curr_animframe` is the single motion authority** (`acclient.c:6937`). Retail funnels *every* animated object through one `CSequence`/`CMotionInterp` pair (`acclient.h:7086-7111`: `DoInterpretedMotion`, `apply_run_to_command`, `get_state_velocity`, `add_to_queue`, the MotionState machine). Holtburger ships **none** of this state machine — no `MotionState`, no modifier-LIFO/action-FIFO queues, no `re_modify`, no link-chain composition (`animation-deep-dive-2026-06-02.md:1186`). It substitutes the three.js mixer's concurrent-action weighting.
- **Hard cut, not blend.** Retail's `advance_to_next_animation` is an unconditional pointer swap with no blend state; holtburger encodes this as `CROSSFADE_S = 0` (`entities.js:1326-1337`) — so cycle-to-cycle is correctly a hard cut, **but one-shot overlays still play concurrently**, which is where the blend artifact re-enters.

**DAT/wire parity is independently validated** (`animation-deep-dive-2026-06-02.md:284-289, 1205`; `validate_motion_pose.cjs` 52/52 swing parity, 906/906 DAT). The prior finding states it plainly: *"The DAT/wire-format layer is at full retail parity across the board; every remaining gap is in the JS render runtime or in plumbing data that already exists in wasm but is dropped before it reaches three.js"* (`:1045`).

---

## Consolidation recommendations

**Confirmation for the parent audit: the boundary is not the problem.** The wasm side already ships a faithful, single-contract superset of what retail's `CSequence` consumes — per-part absolute model-space keyframes, per-segment timing, cumulative root motion, net root displacement, and the hook timeline. There is **no data-faithfulness gap to close at the boundary** and **no second copy of the boundary to unify** (`setup_rig.js` already collapsed the formerly ~5 split construction sites into one owner). Do not spend effort re-deriving keyframes, adding a bone hierarchy, or "fixing" the flat rig.

Concrete, scoped actions:

1. **Build the missing motion authority in JS, fed by this boundary — don't touch the boundary.** The single highest-value consolidation is a per-entity `MotionState`/sequence interpreter (mirror of `CSequence`/`CMotionInterp`) that decides *which* clip plays and *replaces* rather than *blends*. This directly ends "upper-body-only attacks," "missiles with no animation," and the independently-breaking death/door overlays, because all of them become one sequence dispatch instead of N ad-hoc `_tryPlayLink` overlays. The data they need is already in `EntityAnimationData`. Scope-gate per the deep-dive's T9 (`:1184-1196`): a **minimal** modifier-LIFO + `re_modify` + replace-semantics subset captures most of the value short of the full port.

2. **Promote the part-index invariant from "structural" to "asserted."** Add an explicit check at clip-bind time that `clip` track count / `partFrames` stride / `inst.parts.length` / `partCount` all agree, and harden the LOD and `AnimPartChange` paths the same way the hot-swap already guards count (`entities.js:7413`). This is the one genuine boundary fragility — cheap insurance against silent mis-binding under part-swap/LOD.

3. **Disambiguate the empty-buffer sentinel.** Split "no skeleton (raw 0x01)" from "MotionTable miss" at the boundary (an enum/flag on `EntityAnimationData`) so a *missing* attack/missile clip becomes a diagnosable signal instead of a silent rest-pose render (Fragility #3) — this is what makes "missiles fire with no animation" debuggable rather than invisible.

4. **Align padding with retail's clamp** (`lib.rs:16007-16009` vs `acclient.c:326616`) — a 2-line change to leave surplus parts at rest rather than collapse them to origin. Low priority (rarely hit) but it's a literal parity defect at the boundary you asked me to audit.

Items 2–4 are small and boundary-local; item 1 is the large, deferred, runtime-side consolidation the broader audit is converging on. None of them require re-plumbing the wasm→JS data contract, which is sound.
