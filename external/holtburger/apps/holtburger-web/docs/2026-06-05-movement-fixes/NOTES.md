# Movement fixes — 2026-06-05 (from a human 1070 test + from-vm research)

Human test on the admin **+Tester** char (tailnet1) reported: (1) run animation
interrupts / won't loop, (2) the rig runs ahead and snaps back ~1-2 m. Both map
to documented, eye-test-gated findings in `from-vm/anim-deep-2026-06-04` and
`from-vm/completed/movement-protocol-deep-2026-06-04`. Neither is from DIM5-2
(no-op for the player rig). Both fixes below are **JS-only — live on a reload**.

## FIX 1 — run animation interrupt/loop (anim DIM10/A-2) — SHIPPED (default-on)
**Cause:** W3.1 (index.html:10207) client-predicts the local gait on keystate,
but the server `KIND_MOTION` echo was NOT skipped for the local guid (unlike
`KIND_POSITION` at loop.js:1211). `setMotion` only no-ops on an *unchanged* key
(entities.js:4663), and the server's echoed command differs from the prediction
(skill-derived WalkForward vs predicted RunForward, stance/link mismatch) → the
run clip keeps crossfading → never loops. The 2D path already skips kind=5 for
the local sprite (index.html:6305); the 3D path never got the guard.
**Fix:** `scene3d/loop.js` — both `KIND_MOTION` blocks now `if (!isLocalPlayerGuid(motionGuid))` before `em.setMotion(...)` (loop.js ~1244, ~1420). W3.1 is the sole local gait driver; remotes unchanged.
**Test:** reload, run around — the run cycle should loop cleanly.

## FIX 2 — snapback — **RETRACTED** (first diagnosis was wrong; real cause is the wasm integrator)
A first attempt put the fix in the JS position predictor (use `cycleBaseSpeed(RUN)`
instead of the run constant). A **clean headed measurement overturned it** — that
attempt was BOTH wrong-direction AND nearly inert. **Reverted** (index.html +
camera.js back to original). The run constant is NOT the problem.

### How the clean measurement was finally obtained
Headless chromium throttles rAF to <1 Hz here, and **headed wasn't enough either**
— xfwm4 drops window focus, and Chromium throttles rAF on an unfocused window. The
working recipe: **headed on `:0` + `xdotool windowactivate` + warp the pointer into
the window** to hold focus → real ~58 fps rAF. (`snapback-confirm.cjs`.) The earlier
**3.87 m/s reading was a 1 Hz-throttle artifact** — ignore it.

### Real numbers (headed, ~58 fps, 58 samples)
- `cycleBaseSpeed`: **run = 4.000, walk = 2.602** (exact — ACE's authored cycle velocity).
- `getLocalPlayerPose` (the **wasm integrator** pose; for the local player it's the
  integrator, not raw ACE, due to the academy-rubberband no-overwrite policy):
  **~7.7 m/s** (17.1 m / 2.2 s).
- `predictedPlayerPos` (the rendered rig X/Y): **~7.26 m/s** — it **tracks the
  integrator** via the reconcile lerp, so the camera `RUN_SPEED` constant (4.5) is
  **largely overridden** (predicted moved 17 m, far more than 4.5×2.2≈10 m).
- `playerRunRate` = 4.5, never hydrated — and **irrelevant** (the 3D predictor uses
  the FALLBACK constant, not playerRunRate). `getLastClientPrediction` is null in 3D
  because its only writer is the 2D-sprite block, which doesn't run under `?renderer=3d`.

### Corrected root cause (hypothesis, needs one more measurement)
The **wasm movement integrator runs the player at ~7.7 m/s ≈ 1.9× the authored run
cycle base (4.0)** — matching the from-vm research's "~1.8×". The rig tracks the
integrator (7.7), so it **runs ahead of ACE's authored run speed (~cycleBase 4.0)**;
ACE's authoritative pose then force-positions it back → the 1-2 m snap. "Amplified on
admin" = the integrator's skill-derived rate is higher on high-skill chars.

**This is a Rust/integrator issue (holtburger-core movement), NOT the JS predictor.**
The camera `RUN_SPEED` constant is a near-inert knob (reconcile dominates), which is
why the JS fix was both wrong and ineffective.

### Next step to confirm + fix
1. Measure ACE's **raw authoritative** run speed separately from the integrator (read
   the raw `PublicUpdatePosition`/`PrivateUpdatePosition` deltas before the no-overwrite
   policy, or instrument the recv arm). Confirm ACE ≈ 4.0 while the integrator ≈ 7.7.
2. If confirmed, fix the **integrator's run speed** (holtburger-core movement: it should
   integrate at the cycle base velocity / ACE's rate ~4.0, not ~7.7). Find where the
   integrator scales run speed (likely a run_rate× factor applied wrongly).
3. Re-measure with the headed+activated harness.

## Caveats
The clean capture is only possible **headed on `:0` with the window focus held** (mouse
warp). Headless and even unfocused-headed both throttle rAF to ~1 Hz, which corrupts
speed numbers (the bogus 3.87, and 165 m landblock-wrap artifacts). The run-loop fix
needs no rAF and is reload-testable; the snapback needs the headed harness + a raw-ACE
pose measurement before any code change.

## Still open
- DIM5-2 creature root-motion yaw (gate ON): runs live + no-op-correct for idle
  (verified via @create 7 / bake), but the actual yaw on a creature performing
  MT 0x090001D5 cmd 0x0011 is un-eye-tested.
- If FIX 2 accepts, consider applying the same cycle-base-speed source to the
  walk-modifier forward case (currently WALK_FORWARD_SPEED=1.0 vs walk base ~2.6
  → under-prediction/lag, not snapback) — separate, lower priority.
