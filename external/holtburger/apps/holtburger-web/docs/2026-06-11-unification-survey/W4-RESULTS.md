# W4 wave — RESULTS

Date: 2026-06-12. **Local run** (laptop, capped-build, per-package tests) executing
the W4 remainder of the w3plus corpus (S2/S3/S4/S12, plus the two fresh specs
`SQ3-a15-q3-spec.md` and `SD3D-a3-d3-moveto-driver.md` that unblocked the
loop.js seam and S10). 9 commits landed on origin/master (10ca88db..2bdd3735),
plus this close-out (results doc + the two fresh specs into `w3plus-specs/`).

## Per-item results

| # | item (spec) | commit | gate/flag (all default-off) |
|---|------|--------|------------------------------|
| 1 | SQ3 A15-Q3 dispatch hoist + legacy drain retire | `10ca88db` | `?legacyDirectDrain` (rollback hatch; live 3D unaffected either way) + `?dispatchParity` (F6-2 swing-echo dedup port — the only Q3 port that changes default-mode live combat visuals). JS-only |
| 2 | harness repair (stale, post-A9-Stage2 `../ui` imports) | `130b476d` | — (test files only: `test_phase7_4b_entity_pipeline.mjs` + `test_phase7_batch9_entity_lifecycle.mjs`) |
| 3 | S4 A8-M3 kind-17 visibility re-home | `ebd5cdb1` | `?unifiedClientEvent` — **renamed from the spec's `?unifiedEntityDispatch` per the SQ3 §3 ruling** (gates ClientEvents, not EntityUpdates; `?unifiedDispatch` stays reserved for Q4). JS-only |
| 4 | S3 A15-Q4 renderer-neutral core | `3576914e` | `?unifiedDispatch` — streaming ownership inversion into NEW `scene3d/world_stream.js` + single kind table in NEW `scene3d/entity_dispatch.js` (2D backend quarantined to kinds 0-5 per RULINGS item 2). JS-only |
| 5 | S2 A1-O4 single frame driver | `daec6cca` | `?singleDriver` — 3D loop claims the frame, 2D rAF parks, whole net/input pump runs as never-budget-gated `tickPerFrame` phase #0; 2 s heartbeat watchdog self-heals. Inert unless `?renderer=3d`. JS-only |
| 6 | S12 A11-S3 particle/script clock | `ac384af7` | `?particleClock=off\|loop\|sim` — `=loop` retires the statics private rAF into a dedicated never-RP3-gated phase (retail pass order); `=sim` adds the loop-owned clamped-dt clock via `time_rng.js` (intended with `?scriptQueue=on`). JS-only |
| 7 | SD3D A3-D3 MoveToManager driver (unblocked S10; S6 had landed only the skeleton) | `189e164b` | `USE_MOVETO_DRIVER` (const, move_to.rs) — the per-frame node-walk driver over the D3 directive store; steering rides the existing autonomous-drive lane, zero new send sites, NEVER TurnToEvent 0xF649 (S15 NO-GO). No new exports, **manifest stays v4** |
| 8 | S10 A14-I2 pursuit/turn-to intents | `f6065782` | `?wasmPursuit` — picking.js synthetic movers re-homed onto wasm `PlayerDriveIntent`s + JS monitor; the charge-end WASD-stomp fix; F6-6 preserved verbatim. 5 additive exports ride v4. **Composes with `USE_MOVETO_DRIVER`** (driver-off build = bounded fast-fail 0x36, no spin) |
| 9 | S9-R2 A2-P3 remote sticky parity | `2bdd3735` | `?stickyRetail` — remote sticky (F3-4's scope) onto the retail StickyManager over the S8 remote bodies. **COMPOSITE**: effective only with the full S8 triple (`?remoteInterp=on` + `?unifiedTick=on` + `?wireStatePacks=stage1`) AND `USE_STICKY_MANAGER`; self-degrading to the F3-4 glue otherwise. `stickyFlags` getter rides v4 |

## Skips / deviations

- **S10 prior STOP resolved**: S10 had stopped in W3 because A3-D3 was a
  directive-store skeleton with no driver ("blocked on more A3-D3 surface" in
  W3-RESULTS). The SD3D follow-on spec landed the driver (`189e164b`) first,
  then S10 (`f6065782`) composed on top of it — both in this wave.
- **A4 staging limit (documented in f6065782 / move_to.rs)**: per-entity
  `num_anims>0` lattice nodes await the staged A4 per-entity AnimationDone
  feed, so a SECOND pursuit on the same manager stalls behind
  `motions_pending` (first charge per session steers fine; the monitor
  timeout bounds the rest). → W5.
- **Flag rename** (item 3 above): `?unifiedEntityDispatch` → `?unifiedClientEvent`
  per the SQ3 §3 ruling; no other spec deviations.
- **Environmental blocker (pre-existing infra, NOT this wave)**: live ACE login
  doesn't complete (guid=null) — reproduced even at clean HEAD, so wire-agent
  validation was impossible this wave. Needs investigation before the next
  wire-validated wave.

## TestGate (run per-item, laptop rules — no full-workspace battery)

Final state: `cargo test -p holtburger-core` **410** / `-p holtburger-world`
**453** / `-p holtburger-web` (native) **109**, all green; `cargo check -p
holtburger-web --target wasm32-unknown-unknown` clean after every item; `node
--check` clean on all touched JS. JS regression suite at close: q3 dispatch-parity
**24**, q4 renderer-neutral **46**, m3 kind-17 **19**, o4 single-driver **45**,
particleClock **45**, phase7-4b **28**, phase7-batch9 **36**, pursuit-monitor
**46**, remote-interp ownership **12**. `wasm-pack build` NOT run locally —
**all Rust gates (`USE_MOVETO_DRIVER`, `?wasmPursuit` exports, `?stickyRetail`)
are inert until the batched wasm rebuild** (pkg/ rebuild required before any
flag flip; manifest is **v4**, index.html EXPECTED stays 1). JS-only gates
(items 1-6) are live on reload. ALL eye-tests BATCHED (url-flags.md pending rows).

## What's next (W5 queue)

- **Batched wasm rebuild** flips the Rust gates testable; then the BATCHED 1070
  eye-test session covers ALL pending flags (per the url-flags.md pending rows).
- **A4 per-entity AnimationDone feed** (staged; fixes the repeat-pursuit stall
  documented in f6065782).
- **Sticky radius OPEN Q3**: radius fallback 0.0 → 0.3 m standoff is tighter
  than F3-4's fixed 1.3 m — large-mob clipping risk, needs the eye-test A/B.
- **S9-R2 / S10 1070 items** ride the batched eye-test session.
- **ACE login guid=null investigation** (blocker above) before the next
  wire-validated wave.
- Default flips ride the R5 campaign after eye-tests.
