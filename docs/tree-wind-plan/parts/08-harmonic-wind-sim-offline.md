I now have everything needed: the exact frame layout the player consumes, the AC `Frame`/`Quaternion` (wxyz) structs, the combine primitives (`Quaternion::multiply`, `rotate_vector`), the `Animation 0x03` packer invariants, and the rest-pose override semantics. Here is my section.

---

## Assignment (Task 08 — offline per-bone harmonic wind simulation engine)

Design the **offline per-bone harmonic wind sim** that generates the motion, cascaded through the task-07 skeleton, then **flattened to absolute root-relative per-part frames** (AC playback is flat — no runtime parent chain). Specify: the per-bone oscillator math (amplitude/frequency vs. depth, hashed phase, gust envelope, wind direction), how the parent→child cascade is composed, how it is flattened, and the dense-keyframe sampling (fps + loop length, Nyquist, seamless loop). This is the "keyframe at every frame" engine. **Read-only**; cites real `file:line`.

---

## Findings (file:line)

**The frame format my sim must emit (the contract).** `buildSceneryAnimationClip` (`scene3d/animated_scenery.js:125-157`) consumes a flat `Float32Array`, **frame-major then part-major, 7 floats per (frame,part)**: `[origin.x, origin.y, origin.z, quat.w, quat.x, quat.y, quat.z]` (documented `:110-113`; index math `base = (f*numParts + p)*7` at `:137`). It builds one `VectorKeyframeTrack part${p}.position` + one `QuaternionKeyframeTrack part${p}.quaternion` per part, keyed at `f/fps`, **reordering AC wxyz → THREE xyzw** (`:141-149`). Clip duration `= (numFrames-1)*dt` (`:155`), `LoopRepeat` (`:232`). Default fps = **30** (`:42` `DEFAULT_ANIM_FPS`). So my engine's deliverable, for the JS-player route, is literally this flat array + `numParts` + `numFrames`.

**The clip frames are ABSOLUTE part-local, not deltas.** `setup_rig.js:54-67` + `:85-91`: the rest hinge frame is applied to the part Group, then "the AnimationMixer **overrides** these values frame-by-frame with the model-space cycle keyframes." The rAF copy loop confirms it overwrites, not adds (`animated_scenery.js:420-423`: `inst.parts[j].position.copy(...)`, `.quaternion.copy(...)`). **⇒ Each baked frame must be the full model-space part transform, already containing any rest offset.** For trees, rest = identity-at-origin (all parts co-located at `(0,0,0)`, `parent_index = -1`), so the baked frame == the pure pivot-sway transform.

**The DAT-native target struct (Phase-2 bake).** `Animation` (`crates/holtburger-dat/src/file_type/animation.rs:15-23`): `num_parts`, `num_frames`, optional `pos_frames` (whole-object root motion, gated by `POS_FRAMES` flag `:10-13` — leave EMPTY for sway), and `part_frames: Vec<AnimationFrame>` (one per frame). `AnimationFrame` (`setup_model.rs:277-308`) = `frames: Vec<Frame>` (length must == `num_parts`) + `hooks` (empty for us). `Frame` (`graphics.rs:11-14`) = `origin: Vector3` + `orientation: Quaternion`. `Quaternion` (`common/src/math.rs:120-125`) stores **w,x,y,z**. Packer invariants enforced (`pack/animation.rs:43-94`): `part_frames.len()==num_frames`, every `pf.frames.len()==num_parts`, `pos_frames` empty unless `POS_FRAMES`. Round-trips byte-identically (`animation.rs:256-269`).

**The combine primitives already exist in-repo** (so the cascade and flatten reuse them, no new math lib):
- `Quaternion::multiply` (`math.rs:221-228`) = Hamilton `self*other`, **"apply `other`, then `self`"** — exactly parent⊗child.
- `Quaternion::rotate_vector` (`math.rs:190-211`) — rotate a `Vector3` by a quat.
- `Quaternion::normalize` (`math.rs:235-247`) — re-normalize after composing (float-drift guard, mirrors the existing motion accumulator).
- JS combine semantics documented at `setup_rig.js:13` and `:63`: `entity_world.combine(anim_frame[i])`, matching PhatSDK `CPartArray::UpdateParts` (acclient.c:326601).

**Frame::combine (the one operation the whole cascade is built from)** — from the established facts + the primitives above:
```
combine(parent, child):
  origin      = parent.orientation.rotate_vector(child.origin) + parent.origin
  orientation = (parent.orientation.multiply(child.orientation)).normalize()
```

**Caps / sampling envelope.** rAF clamps `dt` to `[0,0.1]s` (`:389`); per-DID single shared mixer (`:230-234`), 512-instance cap (`:43`), `?animSceneryFps` overridable (`:84-96`). My loop length × 30 fps sets `num_frames`; e.g. 8 s → 240 frames.

---

## Concrete coding steps

The same math has **two homes**: a pure-JS generator for Phase 1 (no rebuild — feeds `buildSceneryAnimationClip` directly), and a Rust port in the bake tool for Phase 2 (VAT + DAT). I give the math once; each step is tagged.

### Step 1 — Define the bone model the sim consumes (interface to task 07) — *offline-bake / data contract*

Sim input per tree DID = an array of bones (from task-07 skeleton or task-03 bbox rig):
```
Bone { index, parentIndex (-1 for root), pivot: Vec3 (model-space joint base),
       axisUp: Vec3 (bone's rest direction, ~+Z for trunk),
       depth: int (0 = root), restLen: float, partIndex: int (which SetupModel part this bone drives) }
```
For the **bbox rig (Phase 1b, task 03)**: one bone per part, `pivot = (centroidXY, vertexZmin)`, `depth` from Zmin ordering, `parent = -1` (flat — co-located parts, so each part is its own root hinge). For the **skeleton (Phase 2, task 07)**: a real depth chain. The sim is agnostic; it only needs `pivot`, `depth`, `parentIndex`, `partIndex`.

### Step 2 — Per-bone deterministic phase + parameters (hash, no `Math.random`) — *JS-only (Phase1) + Rust (Phase2)*

Derive phase from a hash of `(did, boneIndex)` so it is deterministic in any sandbox and identical between the JS and Rust ports (determinism rule):
```js
// integer hash → [0,1)  (xorshift-mul; stable across JS/Rust)
function hash01(a, b) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ b ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const phase = hash01(did, boneIndex) * 2 * Math.PI;   // per-branch random phase
```
Per-depth coefficients (tunable constants; defaults chosen for AC's stubby low-poly trees):
```
stiffnessFalloff = 0.55     // deeper joints are softer
ampGrowth   = 1/stiffnessFalloff ≈ 1.82   // local hinge angle GROWS with depth
freqGrowth  = 1.7           // deeper joints oscillate FASTER (leaf flutter)
theta0      = 0.045 rad     // root/trunk base angle (~2.6°) at unit wind
freq0       = 0.18 Hz       // trunk primary-bend frequency (slow lean)
ampDepth(d) = theta0 * ampGrowth^d
freqDepth(d)= freq0  * freqGrowth^d
```
> **Reconciling the brief's "amplitude DECAY by depth (trunk small, twig large)":** the *per-joint LOCAL hinge angle* GROWS with depth (`ampGrowth^d`) — trunk small, twig large — which is *stiffness* decaying by depth. This is the SpeedTree/Crytek two-band shape: the trunk contributes a slow large-lever **primary bend**, deep joints contribute fast small-segment **detail flutter**. State this explicitly in the module doc so the sign is unambiguous.

### Step 3 — Per-bone oscillator: the angle timeline θ_b(t) — *JS-only (Phase1) + Rust (Phase2)*

Two specified forms; **recommend (B)** for the physical "snap-back" gust feel, (A) as the trivially-seamless fallback.

**(A) Closed-form superposed sinusoid (exactly seamless by construction).** Pick loop length `L` (Step 5). Snap every frequency to an integer cycle count over `L` so `frame[N] == frame[0]`:
```
cyc_d   = max(1, round(freqDepth(d) * L))      // integer cycles per loop
w_d     = 2π * cyc_d / L                        // seamless angular freq
// two octaves: primary + a half-amplitude harmonic for naturalness
theta_b(t) = ampDepth(d) * ( sin(w_d*t + phase)
                           + 0.35*sin(2*w_d*t + phase*1.7) ) * gust(t) * windStrength
```

**(B) Damped torsional oscillator driven by a looping wind force (the brief's "damped-oscillator").** Each bone is an independent spring-damper hinge; the spatial coupling is handled by the cascade (Step 4), so the dynamics decouple per bone (SpeedTree approach):
```
k_d = kBase * stiffnessFalloff^(-d)   // restoring stiffness (deeper = softer → larger swing)
c_d = 2*zeta*sqrt(k_d)                 // damping, zeta≈0.18 (lightly damped → visible sway)
F_b(t) = windDir_torque * windStrength * gust(t) * turbulence_b(t)   // see below
// semi-implicit Euler, fixed h = 1/(fps*OVERSAMPLE):
theta' += h*(F_b(t) - c_d*theta' - k_d*theta);  theta += h*theta';
```
`turbulence_b(t)` = a small sum of sinusoids at the bone's frequency band, phase-offset by `phase` (Step 2), each snapped to integer cycles over `L`. **Seamlessness for (B):** integrate **≥3 loop periods** so the transient dies, then sample only the final period — since the forcing is exactly L-periodic and the system is stable, the steady-state response is L-periodic ⇒ seamless. (Settle-then-sample is cheap offline.)

`OVERSAMPLE = 4–8` for ODE stability; the stored clip is still decimated to `fps`.

### Step 4 — Cascade composition (parent rotation propagates to children) — *JS-only (Phase1) + Rust (Phase2)*

Convert each bone's scalar angle θ_b(t) into a **local pivot-rotation frame**, then fold down the chain with `Frame::combine`.

**Wind-direction → rotation axis.** Wind horizontal unit vector `w=(wx,wy,0)` (AC Z-up). A hinge that tips the bone's `+Z` toward `w` rotates about `axis = Z × w = (−wy, wx, 0)` (verified: `w=+X ⇒ axis=+Y`, rotating +Z toward +X). Optional small flutter for deep bones: a second tiny rotation about `w` itself (twist), amplitude `~0.3*ampDepth(d)` at `1.3×` frequency, hashed phase — gives leaf shimmer instead of pure planar swing.

**Local frame of bone b at time t** (rotation about its own pivot `P_b`):
```
q_local = quatFromAxisAngle(axis, theta_b(t)) [⊗ quatFromAxisAngle(w, flutter_b(t))]
// rotation about a pivot P, as an affine Frame (origin,orientation):
//   v' = q_local·v + t   must equal   q_local·(v−P) + P
//   ⇒ t = P − q_local·P
F_local_b = Frame{ orientation: q_local,
                   origin: P_b − q_local.rotate_vector(P_b) }
```

**Fold to absolute (root-relative) model-space frame.** Walk root→leaf; the absolute frame of bone b is the combine of all ancestor local frames (root applied last/outermost — matches `combine(parent, child)`):
```
F_abs[root] = F_local[root]
F_abs[b]    = combine( F_abs[parentIndex(b)], F_local[b] )
            = { origin: F_abs[par].q.rotate_vector(F_local[b].origin) + F_abs[par].origin,
                orientation: (F_abs[par].q.multiply(F_local[b].q)).normalize() }
```
This is the mathematically exact statement of "parent rotation propagates to children": a child's pivot is itself carried by every ancestor's rotation, while the child's own swing adds on top. Because `F_abs[b]` is already **absolute model-space**, dropping it straight into the flat per-part array satisfies AC's flat playback (no runtime cascade) — *this is the flatten step*.

For the **bbox rig (Phase 1b)** where every bone is its own root (`parent=-1`), the fold is trivial: `F_abs[b] = F_local[b]` — a pure hinge about each part's base. This is the immediate Phase-1b win; the residual stiffness (rigid segments, no inter-part bend) is what Phase-2 skeleton+segmentation fixes.

### Step 5 — Dense-keyframe sampling: fps + loop length (Nyquist + seamless) — *JS-only (Phase1) + Rust (Phase2)*

- **fps = 30** to match `DEFAULT_ANIM_FPS` (`:42`) and AC's 30 fps integer-snap playback (CSequence floor-lookup). Nyquist ceiling = 15 Hz; deepest leaf flutter ≈ 2–5 Hz ⇒ comfortably oversampled, no aliasing.
- **Loop length L = 8 s ⇒ `num_frames = L*fps = 240`.** Long enough that the period reads as natural wind, short enough that 240×numParts×7×4 B ≈ **40 KB** for a 6-part tree. (Use L=6 s / 180 frames for the smallest foliage to save memory.)
- **Seamless loop rule:** every contributing frequency must complete an integer number of cycles in L (Step 3's `round(freq*L)/L` snap). Then `frame[N] == frame[0]`. **Do NOT duplicate the first frame at the end** — sample `f = 0 … N-1` at `t = f*dt` where the true period is `N*dt = L`. THREE `LoopRepeat` (duration `(N-1)*dt`, `:155/:232`) then wraps `frame[N-1] → frame[0]` as one clean `dt` step; the DAT-native path loops by `num_frames` identically.
- **"Keyframe at every frame":** because AC's default-anim playback snaps to integer keyframes with NO interpolation, the DAT route needs the full 240 dense frames (the spline preserved as samples). The JS player route (which slerps) *can* decimate to ~8–10 fps to shrink the clip, but bake dense by default and let `?animSceneryFps` tune.

### Step 6 — Emit per-part frames (JS-player route, Phase 1) — *JS-only (no wasm rebuild)*

New module `scene3d/wind_clip.js`, pure + unit-testable (mirrors how `buildSceneryAnimationClip` is tested):
```js
// generateWindClip(bones, opts) -> { frames: Float32Array, numParts, numFrames, fps }
// opts: { did, fps=30, loopSeconds=8, windDir=[1,0,0], windStrength=1, gust=fn(t) }
export function generateWindClip(bones, opts) {
  const fps = opts.fps ?? 30, N = Math.round((opts.loopSeconds ?? 8) * fps);
  const numParts = Math.max(...bones.map(b => b.partIndex)) + 1;
  const frames = new Float32Array(N * numParts * 7);
  for (let f = 0; f < N; f++) {
    const t = f / fps;
    const Fabs = cascadeAbsoluteFrames(bones, t, opts);     // Steps 3-4
    for (const b of bones) {
      const base = (f * numParts + b.partIndex) * 7;
      const F = Fabs[b.index];
      frames[base+0]=F.ox; frames[base+1]=F.oy; frames[base+2]=F.oz;
      frames[base+3]=F.qw; frames[base+4]=F.qx; frames[base+5]=F.qy; frames[base+6]=F.qz; // AC wxyz
    }
  }
  return { frames, numParts, numFrames: N, fps };
}
```
This plugs directly into a Phase-1 `attachWindTrees` (task 01's synthetic-clip entry point): instead of `wasmExports.fetchAnimation(animId)` (`animated_scenery.js:209`), call `generateWindClip(bones, ...)` and hand `{frames,numParts,numFrames,fps}` to `buildSceneryAnimationClip` (`:219`). The shared-DID-group keying generalizes by using a synthetic key like `wind:0x<did>` instead of a real `animId`. **No wasm export needed** — bones for Phase 1b come from `fetchBuildingPlacement` per-part meshes (compute pivot=Zmin from the part vertices in JS).

### Step 7 — Port to Rust for the bake tool (VAT + DAT-native) — *offline-bake (buildbox, not laptop)*

In `apps/holtburger-tools` (task 10's `tree-wind-bake`), a `wind_sim.rs` module reusing `holtburger_common::{Vector3, Quaternion}`:
- `Quaternion::multiply` / `rotate_vector` / `normalize` (already exist) implement `combine` verbatim — no new math.
- Output A (VAT/forest): the **direction-agnostic per-bone scalar angle timelines** `θ_b[0..N]` + bone metadata (pivot, axis, parentIndex) — the shader (task 06) applies live wind direction. Recommended primary forest path.
- Output B (DAT-native/hero): build `Animation { id, flags: empty (NO POS_FRAMES), num_parts, num_frames: N, pos_frames: vec![], part_frames }` where each `AnimationFrame.frames[partIdx] = Frame{ origin, orientation }` from `F_abs` (Step 4). Pack via `Animation::pack` (`animation.rs:155`) / `DatPack` (`pack/animation.rs:26`). Invariants (`:43-94`) are satisfied by construction (every `part_frames[f].frames.len()==num_parts`, `pos_frames` empty). Wire `SetupModel.default_animation = Some(animId)` (`setup_model.rs:346`) so the existing default-anim path plays it (task 09).

> **Wind direction for the baked-clip routes (A/B):** a baked `Frame` rotation has a fixed axis, so the DAT/JS-clip route bakes for a **canonical or small set of compass directions** (e.g. 4–8 bins) and the wind-state module (task 12) selects the nearest; the **VAT/shader route gets direction for free** (axis from `uDir` uniform applied to the per-bone angle in the vertex shader). Emitting the low-level angle timelines (Output A) is therefore the more flexible deliverable; the flattened absolute frames (Output B) are the AC-native/fidelity artifact. This is the key reason the engine outputs at **both** levels.

### Step 8 — Gust envelope + storm coupling (consumed from task 12) — *JS-only + Rust*

`gust(t)` is supplied by the wind-state module (task 12) but the sim defines its required shape: a **looping** envelope (integer cycles over L) so seamlessness survives:
```
gust(t) = baseStrength + gustAmp * (0.5 + 0.5*sin(2π * gustCyc * t / L + gustPhase))
// storm: baseStrength↑ (1.0→1.6), gustAmp↑ (0.3→0.9), gustCyc↑ (faster gusts)
```
Pass `gust` as a callback into `generateWindClip` / the Rust sim so the same engine bakes calm and storm variants deterministically.

---

## Risks & open questions

1. **Co-located-origin pivot shear (the headline gotcha).** All tree parts sit at model `(0,0,0)`; rotating a high-canopy part about the origin swings it through a huge arc. **Mitigation:** the pivot-as-affine-frame `origin = P_b − q·P_b` (Step 4) makes every rotation happen about the part's true base `P_b` (vertex Zmin), regardless of where the model origin is. Unit-test: a 90° hinge of a part whose base is at Z=5 must keep the base vertex fixed (‖v_base' − v_base‖ < 1e-4).

2. **Joint cracking on rigid segments.** AC parts are rigid (zero vertex skinning); a large hinge angle opens a visible gap between a parent segment's top and a child segment's bottom. **Mitigation:** cap `ampDepth(d)` so inter-segment angular discontinuity stays sub-degree at the joint; overlap segment geometry at joints during task-07 segmentation; reserve large bends for the VAT/shader route (continuous vertex displacement, no cracks). **Rollback:** flag-off → frozen.

3. **Loop seam pop.** If a frequency isn't an integer cycle over L, `frame[N-1]→frame[0]` jumps. **Mitigation:** the `round(freq*L)/L` snap (Step 3/5) is mandatory; add a test asserting `‖frame[0] − frameAt(L)‖ < 1e-5` for the closed-form path, and for the ODE path assert the settled period's endpoints match within tolerance.

4. **JS↔Rust numeric drift.** Phase 1 sim runs in JS, Phase 2 in Rust; if coefficients/hash differ, the look changes between routes. **Mitigation:** identical integer hash (Step 2), identical constants in a shared JSON/const table, golden-vector test (same bones+wind ⇒ same first-frame frames in both languages within 1e-5).

5. **Determinism (no `Date`/`Random`).** Sandbox bans `Math.random`; bake rule bans `Date::now`. **Mitigation:** all phase/turbulence from the hash; `gustPhase` passed in, not randomized. Already enforced in Step 2.

6. **Open: amplitude calibration per DID.** `theta0`/`ampGrowth` that look right on a 22 m tree (`0x02000258`) over-swing a 1.25 m fern (`0x02001063`). **Resolution:** scale `theta0` by `1/sqrt(treeHeight)` (taller = stiffer base angle) and clamp absolute tip displacement to a fraction of `restLen`; expose `?treeWindStrength` (task 14). Needs a 1070 eye-test pass per tree class (batched).

7. **Open: how many directional bins for the clip route.** 1 (prevailing) is cheapest but trees lean wrong vs. live wind; 8 bins × 240 frames × parts inflates the bake. **Recommendation:** ship VAT (direction-live) as the forest path and bake only the **prevailing** direction for the AC-native hero clip; revisit bins only if the hero-clip direction mismatch is visible.

8. **ODE settle cost vs. closed-form.** Form (B) integrates 3×L×fps×OVERSAMPLE steps per bone — fine offline, but if Phase-1b runs the sim live in JS at attach time it could hitch. **Mitigation:** Phase 1 uses the **closed-form (A)** (cheap, exactly seamless) generated once per DID and cached in the shared DID group; reserve the damped ODE (B) for the offline Rust bake.
