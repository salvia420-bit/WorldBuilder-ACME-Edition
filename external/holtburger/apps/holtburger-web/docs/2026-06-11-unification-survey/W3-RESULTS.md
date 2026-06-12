# W3 / w3plus wave — RESULTS

Date: 2026-06-12. **Local run** (laptop, capped-build, per-package tests) executing
the w3plus spec corpus (`w3plus-specs/`, 16 specs + INDEX; authored by the
2026-06-11 buildbox spec sweep wf_1c90ec7e-a3e, the 4 missing specs S1/S9/S10/S15
re-specced before dispatch). 9 commits landed on origin/master
(9568fc0a..08ad6563), plus this close-out (S15 ruling + S16 decision record).

## Per-item results

| # | item (spec) | commit | gate/flag (all default-off) |
|---|------|--------|------------------------------|
| 1 | S6 A3-D3 unpack_movement Stage-3 | `9568fc0a` | `USE_UNPACK_MOVEMENT_SEMANTICS` + `USE_LEAVE_GROUND_VELOCITY` (separate consts, movement/system.rs) |
| 2 | S7 A6-T1/T2 transition pipeline | `31e635ab` | `USE_UNIFIED_TRANSITION` (const) + `?unifiedTransition=on` (wasm URL flag) |
| 3 | S5 A4-Q2/A5-P1 AnimationDone boundary | `8e0ed7eb` | `?hookDrain=on` (JS-only) + `?mtQueue=on` (+ `notifyAnimationDone` export); **manifest 3→4** |
| 4 | S13 A5-P3 root-motion metadata | `9bbd4dac` | `?rootMotionObject=1` (JS); `rootMotionNet` export rides v4, no bump |
| 5 | S14 A10-M3 surface parity details | `4f8f0106` | `surfaceParityV2` (requires `?surfaceUnified=on` to have any effect); `hasPalette` getter rides v4 |
| 6 | S8 A2-P2 remote-pose driver | `a1ef181e` | `?remoteInterp=on` — **COMPOSITE**: effective only with `?unifiedTick=on` + `?wireStatePacks=stage1` (forced off otherwise); `pollRemotePoses` rides v4 |
| 7 | S1 A1-O3 sync physics tick | `db0b436e` | `?syncPhysicsTick` + `?syncTickDiag=1` — ALL-JS, live on reload, no wasm change; **wire-agent validated** (77/77 enqueue/hop, poseChangedSameFrame 75/77, watchdog fallback green) |
| 8 | S11 A14-I4 charge clock + send boundary | `0fae5806` | `?jumpParity=on` (4-export typeof guard); exports ride v4 (spec's 2→3 bump superseded by the rides rule) |
| 9 | S9 A2-P3 sticky manager incl. local player | `08ad6563` | `USE_STICKY_MANAGER` (gate-at-entry); **Stage R2 (remote sticky) DEFERRED** — S8's triple-flag composite surface postdates the spec; F3-4 JS glue keeps covering remotes |

## Skips / deviations

- **S9 R2 deferred** (above) — needs its own pass against the S8 remote lane.
- **S11 manifest deviation**: spec said bump 2→3 (written pre-W2); current rule =
  additive exports ride v4. Manifest bumped exactly once this wave (S5, 3→4).
- **S6 D3-2**: MoveToManager is a directive-store SKELETON, no driver; the
  A13-W4 TurnToEvent emit is a comment-only hook, NO send — per the S15 NO-GO
  ruling (RULINGS.md item 5: ACE has no 0xF649 handler, structural proof).
- **S16 executed as docs-only close-out** (this commit): `DECISIONS-A1-O5-constants.md`
  + comment-pointer consolidation (simulation.rs / common.rs / collision.rs /
  scene3d/index.js / unified-movement DESIGN.md — comment lines only, zero
  behavior delta, no manifest change).

## TestGate (run per-item, laptop rules — no full-workspace battery)

Final state: `cargo test -p holtburger-core` **389** / `-p holtburger-world`
**448** / `-p holtburger-web` (native) **108**, all green; `cargo check -p
holtburger-web --target wasm32-unknown-unknown` clean after every item; `node
--check` clean on all touched JS. `wasm-pack build` NOT run locally — **all Rust
gates are inert until the batched wasm rebuild** (pkg/ rebuild required before
any flag flip; manifest is **v4**, index.html EXPECTED stays 1). JS-only gates
(S1, S5 `?hookDrain`, S13 JS half, S14 M3b) are live on reload.

## What's next (per ROADMAP)

- **Batched wasm rebuild** flips the Rust gates testable; then the BATCHED 1070
  eye-test session covers ALL pending flags (per the url-flags.md pending rows).
- **W4 remainder**: S4 → S3 → S2 loop.js seam — **needs the A15-Q3 spec first**
  (flag-name collision `?unifiedDispatch` vs `?unifiedEntityDispatch` needs a
  ruling); S12 (particle/script clock); S10 (blocked on more A3-D3 surface);
  S9-R2 (remote sticky on the S8 lane).
- Default flips ride the R5 campaign after eye-tests.
