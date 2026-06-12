# W2 / Batch R2 wave — RESULTS

Date: 2026-06-12. **Hybrid run**: the buildbox ultracode dispatch (wf_63cc3650-c37,
W2-PROMPT.md) hit the 5-hour session limit after landing item 1 only; the remaining
7 items were recovered and executed LOCALLY (laptop, capped-build, per-package tests)
the next day. All 8 items landed on origin/master. The concurrent W3+ spec sweep
(wf_1c90ec7e-a3e) also died at the limit: 12/16 specs recovered to
`~/from-vm/w3plus-specs-2026-06-11/` (missing S1/A1-O3, S9/A2-P3, S10/A14-I2,
S15/A13-W4 — re-spec when W3 dispatches).

## Per-item results

| # | item | commit | gate/flag (all default-off) | tests | 1070-parked |
|---|------|--------|------------------------------|-------|-------------|
| 1 | A4-Q1 MotionTableManager queue core | `3172c03e` (buildbox) | `USE_MOTION_TABLE_QUEUE` | 17 queue-order lanes; core 174 | A4-Q2/Q3 spam-truncation, portal-cancel |
| 2 | A3-D2 MotionDone/exhaustion consumer | `0c078aa9` | rides `USE_MOTION_TABLE_QUEUE`; `USE_EXHAUSTION_RUN_RATE` | 9 FIFO/exhaustion lanes; core 344 + world 402 | one-shot→sticky-release+jump; stamina-0 no-snapback |
| 3 | A2-P1 PositionManager node queue | `e871fca8` | `USE_POSITION_MANAGER_QUEUE` (facade flag-off = legacy single-node, asserted byte-identical) | 9 queue/UseTime/recovery lanes; world 411 | P2 remote feel (`?remoteInterp=` is P2) |
| 4 | A7-R1 per-setup step heights | `c4ccb4d1` | `USE_SETUP_STEP_HEIGHTS` | 3 lanes incl. player byte-identity (0.6/1.5) | — (headless-verifiable) |
| 5 | A7-R2 walkable step-down | `90afe652` | `USE_WALKABLE_STEP_DOWN` | 2 lanes (steep-face Fall, degradations) | downhill cliff-face feel |
| 6 | A7-R3 landing allowance | `bc223fb5` | `USE_LANDING_WALKABLE` | 1 lane (LANDING_Z boundary matrix) | cliff-face jump |
| 7 | A7-R6 ethereal-expiry re-check | `a1ac8c53` | `USE_ETHEREAL_RECHECK` | overlapped-close-stays-passable lane | — (headless-verifiable) |
| 8 | A9-Stage1 wire placement-id plumb | `20a027d6` | `?placementId=on`; **manifest v3** | `resolve_static_placement_frame_orders`; web 94 | chest/corpse rest-pose eye-check |

## Skips / deviations

- **None skipped.** Every item's gap was re-verified live before editing (W0/W1 drift
  rule); all gaps still existed.
- A2-P1: retail's SetPositionSimple retry-on-error branch not modeled (our scene's
  pose assignment cannot fail) — documented in `position_manager.rs`.
- A7-R2: `check_walkable`'s re-insert probe (survey row 3's other half) deferred to
  the A6 `transitional_insert` seam, per the report.
- A7-R6: ObjectCreate initial state applies verbatim (retail's check lives in the
  set_ethereal transition, not construction).
- A9-Stage1: the batch keyframes export stays placement-0 (cold-load prefetch path);
  the ParentEvent child-spawn keeps the B5 grip-placement channel.

## TestGate (run per-item, laptop rules — no full-workspace battery)

Final state: `cargo test -p holtburger-core` 344 / `-p holtburger-world` 418 /
`-p holtburger-web` (native) 94, all green; `cargo check -p holtburger-web --target
wasm32-unknown-unknown` clean after every item; `node --check` clean on all touched
JS. `wasm-pack build --release` NOT run locally (buildbox/batch item — pkg/ rebuild
required before any flag flip; manifest is v3, index.html EXPECTED stays 1).

## What's next (per ROADMAP)

- W3 dispatch wants the 4 missing W3+ specs re-run (S1, S9, S10, S15).
- All 8 gates await the wasm rebuild batch + their 1070 eye-tests (Lane B) before
  any default flips (R5 campaign).
