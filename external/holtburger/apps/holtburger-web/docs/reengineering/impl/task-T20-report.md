# T20 — ST7: slot grid as residency authority (`?slotGrid`): implementation report

Agent: T20 recovery agent (stage 4 of 4; predecessor killed by the 2026-08-09 reboot).
Date: 2026-08-09. Scope: `scene3d/residency_grid.js` (new), `scene3d/index.js` wiring,
`scene3d/landblock_lru.js` (assert-only + header), `scene3d/cells.js` (ring seam),
`scene3d/net_worker*.js` (census relay), `crates/holtburger-resource-http/src/pack.rs`,
`apps/holtburger-web/src/{lib.rs,pack_source_glue.rs}`, `harness/**`, `docs/url-flags.md`,
S7.3 doc rows. Recorded out-of-scope edits: `index.html` (init3D opts bag),
`scene3d/pack_fetch_controller.js` (keep-set) — both unavoidable, minimal, below.

## Shipped

| commit | what |
|---|---|
| `432e8791` (inherited, verified) | `scene3d/residency_grid.js` — SlotGrid (W_T=6, 36 slots, ring-min anchor, shift-in-place, teleport predicate), S2 six-state machine with legal-transition refusal, GridResidencyAdapter (SPEC §1.4 table), 4-rung PressureLadder (floors never 0). + `harness/test_residency_grid.mjs` (374). |
| `4a07e021` (inherited, verified) | Rust half — `pack.rs` ResidentPack pins/`last_unpin_ms`, `pin_pack`/`unpin_pack`/`set_budgets`/`set_floor_ms` (clamped ≥ 5 s)/`enforce_budget` (LRU by last-unpin, run-over-and-record); `pack_source_glue.rs` exports; `hb_mem_census` packBytes/packSections rows; `hb_evict_lb_world_caches`. |
| `b98d315c` (inherited, verified) | `?slotGrid` arming (EXACT-MATCH, requires `?packSource`, dynamic imports), P1-site tick as W6 client, pin/session-pin wiring, ladder rungs → wasm/FrameWork EMERGENCY, context-loss trigger, summed 3-instance census (net-worker relay), assert-only LRU (`gridLruDivergence`), `_slotGridDrivesRing`, `__diag.residency()` current, url-flags rows, 25-check assert suite. |
| `5575c55f` (this session) | S7.3 doc duties: `PLAN-fixed-slot-grid-residency-2026-07-11` STATUS banner; `landblock_lru.js` ST7 header note (assert-only under the arm; NOT deleted — ST10). |
| `107baf22` (this session) | **Live-arm fixes** (three defects found on the first real arm, invisible to the mocked battery): (1) init3D curated-opts bag never carried the `pack_source_*`/`hb_evict_lb_world_caches` exports — every pin/enforce/ladder lever silently no-oped behind `?.`; (2) STAGED feed re-fire, 250 ms nearest-first — the stream-bake guard is a skip-cap semaphore, one-shot event feeds starve (35/36 slots STAGED); (3) in-window EMPTY re-admit (1 Hz) + the controller keep-set root cause — a resident ring tile stopped keeping its REGIONALS, so queued shared regionals were backpressure-REJECTED, stranding 24/36 slots EMPTY under sustained hops. +20 battery checks (394), 2 evidence-line refreshes. |

wasm rebuilt from HEAD via capped-build (I5): dev 17.76 MB / **release 6.34 MB (shipped
in pkg/)**; all six T20 exports verified in `pkg/holtburger_web.d.ts`; pre-T20 release
wasm backed up to session scratchpad for one session.

## Spec conformance

SPEC §3 T20: *"`residency_grid.js` (W_T = 6, events, state machine, integrity detectors
carried over), PackStore + pin wiring, park scheduler, pressure ladder (governor +
floor-zeroing deleted), census deltas + net-worker relay (flag-conditional), the
grid→legacy-producer adapter per §1.4's table, legacy LRU in assert-only mode. Deps:
T12. Acceptance: GATE-GRID — E5 CLEAN (Batch C, or B if ready); gridLruDivergence = 0
over the battery; pinLeaks/shiftMismatches/slotDesyncs = 0; M1/M2 vs legacy arm;
BENCH-ZIGZAG (reAdoptCancels absorbing) + BENCH-TELEPORT; TAIL-ULTRA governor bucket.
Kill: K2."*

- **residency_grid.js core (W_T=6, events, state machine, detectors)** — **MET.**
  Node battery 394/394 (cover proof both parities, shift/teleport semantics, S2
  legality, audit corruption detection, zig-zag 0 parks, floors never 0, rung order,
  drains, 40-crossing battery all counters 0). Live: shifts fire exactly once per
  2 LBs (8 hops → 4 shifts), teleport predicate + 36-tile amortized drain observed.
- **PackStore + pin wiring** — **MET** (after the 107baf22 export-bag fix — the
  landed stage-3 wiring called exports that were unreachable). Live: pinnedPacks 71 /
  pinnedBytes 16.8 MB, session pins stuck, `enforce` running at 1 Hz, evictions 0 /
  deferrals 0 / overBudget false at this scale; `cargo test -p
  holtburger-resource-http` (23, incl. pin/floor gates) inherited green, wasm rebuilt
  from the same tree.
- **Park scheduler + pressure ladder (governor + floor-zeroing deleted)** — **MET.**
  Live: parks flow through the 2 s hysteresis (96 parks issued, 40 true releases,
  amortized), park floor lowered to 5000 ms by R4 and NEVER 0 (Rust clamps too);
  geometry-count governor not consulted on the arm. R4 engaged once at boot — see
  Deviations/observations D4.
- **Census deltas + net-worker relay** — **MET.** `__diag.residency()` sums THREE
  instances live (main 412 MB + bake worker 145 MB + net worker 9.4 MB = 567 MB);
  packBytes/packSections budget rows present; worker packBytes 0 by construction.
- **Grid→legacy-producer adapter per §1.4's table** — **MET** (with the two
  event-driven retry actors 107baf22 added — see Deviations D1/D2). Live: admit →
  CompositeSource-fed per-LB builds (window solid at 36 LIVE through 14 crossings +
  teleport), vacate → hysteresis park (zigzag absorbed by 36 pointer re-adopts),
  QUARANTINED never fed (battery-pinned; 0 live quarantines), teleport drain replaces
  the LRU purges.
- **Legacy LRU assert-only, `gridLruDivergence = 0` over the battery** — **MET.**
  Assert suite 25/25; live arm ended **gridLruDivergence = 0** after boot + 8
  westward hops + 6-hop zigzag + teleport.
- **`pinLeaks`/`shiftMismatches`/`slotDesyncs` = 0** — **MET.** All three 0 over the
  full live arm (audited at 1 Hz) and over the node battery.
- **Live integration arm (0 console errors)** — **MET.** Zero error-level console
  messages across the entire ON-arm session; 11 warnings, all pre-existing classes
  (sync-tick pairing, geom-audit zero-tri, unknown-weenie appraise, phase7.4b `_t0`,
  motion-link benign). Controller lanes healthy: 126 done / 0 failed, verify 126 ok /
  0 mismatch (subtle engine), 0 quarantines, wireWaitEvents 1 (teleport arrival —
  C5 is a walk gate). OFF arm: bare-default boot in-world, legacy ring fills
  (9→55 LBs/20 s), no grid/controller constructed, 0 errors.
- **GATE-GRID E5 CLEAN** — **DEFERRED-TO-BATCH** (Batch C queue item exists —
  T32's prereq "T20 stage-4 report green" is this report).
- **M1/M2 vs legacy arm** — **DEFERRED-TO-BATCH** (comparative arms need fresh
  Chrome per arm + the 1070; PC rules forbid cross-boot single shots).
- **BENCH-ZIGZAG / BENCH-TELEPORT** — node-side equivalents in the battery
  (`reAdoptCancels` absorbing pinned there; live zigzag absorbed by re-adopts at
  3 s spacing — both absorbers exercised); scored bench runs **DEFERRED-TO-BATCH**.
- **TAIL-ULTRA governor bucket** — **DEFERRED-TO-BATCH** (1070).

## Deviations

- **D1 — DEVIATION: SPEC §1.4 adapter table ("admit(tile) → per-LB build kickoff …
  now event-driven") because** (read-verified + live-proven) the legacy producers sit
  behind `stream_bake_guard.js`, a skip-cap SEMAPHORE (`maxInFlight` 6, fires beyond
  it DROPPED and counted, no queue — stream_bake_guard.js:216). The legacy
  `tickPvsLoadExpansion` sweep re-fired every position packet, so skips self-healed;
  a one-shot event fire starves: 35/36 slots stuck STAGED live. Minimal sound thing:
  `refireStagedFeeds()` — re-fire STAGED tiles' feeds at 250 ms, nearest-first,
  through the SAME guard (idempotent by the baked fast-path + per-key dedup).
  Event-driven remains the trigger; the re-fire is the retry actor the design left
  implicit. Battery-pinned (skip-cap strand + convergence + ordering).
- **D2 — DEVIATION: same table's transient-failure row ("a later admit retries")
  because** no later admit exists for a tile that STAYS in-window (admits are edge
  events): 24/36 slots stranded EMPTY under sustained hops. Minimal sound thing:
  `readmitEmptyTiles()` in the 1 Hz slice — EMPTY in-window ⇒ transient by
  construction (loud failures sit QUARANTINED and are never touched; controller
  quarantine bookkeeping stays authoritative). Battery-pinned.
- **D3 — out-of-scope edits, recorded (I2):** (a) `index.html` init3D opts bag +7
  namespace entries — the stage-3 wiring was calling exports the curated bag never
  carried (the bag's own documented plumb-through trap); without it every PackStore
  call is a silent no-op, so the edit is unavoidable for this task's acceptance.
  (b) `scene3d/pack_fetch_controller.js` (T12's file, T12 is DONE) keep-set
  construction: `if (resident) continue` stopped resident ring tiles from keeping
  their interiors/REGIONALS, so a still-queued shared regional fell out of `keep`
  and `dropQueuedOutside` rejected it — failing every grid tile latched on it (the
  root cause behind D2's live strand). Fix accrues keep for every ring tile;
  enqueues skip resident/quarantined. T12's suites re-run green with byte-identical
  recorded wire figures (46 req / 6.33 MiB region battery).
- **D4 — observation, not a gate claim:** the ladder engaged R1→R4 once at boot and
  stayed at R4: summed 3-instance wasm (531→567 MB [M, this box]) exceeds the
  0.94×M3 trigger because the MIGRATION-era stores are live (legacy shard cache
  unbounded by design until ST10; main instance alone 412 MB). The ladder did its
  job (park floor 5 s, budgets halved, EMERGENCY set, all now actually applied);
  `r4Engagements > 0 = FAIL` binds on a DEFAULT run at GATE-GRID scoring, not on
  this migration-era bot arm. Flagging for the orchestrator: M3 scoring before ST10
  retirement will need either the retirement budgets or an explicit migration-era
  allowance.
- **D5 — sub-spec note:** worker pack LEASES (`leaseForJob`, D-06.8) are NOT armed
  at T20 — the bake worker stays legacy-lane (T12 D5 carried forward; `leaseBytesPeak`
  reads 0). Lands with the bundle-assembly consumer (T13/T22).

## Tests run

Rust/wasm via capped-build only (I5), rust-analyzer killed, node direct, ONE
chromium total (MCP-owned; free ≥ 1700 MB + swap verified first; two stale
prior-session tabs closed). No @scale-tagged perf figures claimed — counter values
are correctness reads, not measurements; comparative/tail benches deferred.

```
capped-build wasm-pack build --target web --out-dir pkg-t20 --dev        exit 0 (1m28s); 17,756,757 B (dev-class)
capped-build wasm-pack build --target web --out-dir pkg-t20 --release    exit 0; 6,344,497 B (release-class);
  rsync -a --delete pkg-t20/ pkg/; pack_source_pin/unpin/enforce/set_budgets/set_floor_ms/stats +
  hb_evict_lb_world_caches verified in pkg/holtburger_web.d.ts
node harness/test_residency_grid.mjs        394 passed, 0 failed  (374 inherited + 20 new)  RESIDENCY-GRID ✅
node harness/test_slotgrid_lru_assert.mjs    25 passed, 0 failed  SLOTGRID-LRU-ASSERT ✅
node harness/test_pack_fetch_controller.mjs  92 passed, 0 failed  ✅
node harness/test_pack_fetch_region.mjs      22 passed, 0 failed  ✅  (46 req / 6.33 MiB — byte-identical to T12's record)
node harness/test_diag_schema.mjs            65 passed, 0 failed  ✅  (2 evidence lines refreshed)
node harness/test_frame_work.mjs            144 passed, 0 failed  ✅
11 landblock_lru/walkin suites              all green (21/36/26/5/12/12/7/7 + …)
test_xu7_budget 49 · texture_worker 69 · stall_probe OK
node scripts/lint-url-flags.mjs --strict     exit 1 PRE-EXISTING (fogRingCap, stableDepthShare only; T20 adds 0)
node scripts/audit-flag-defaults.mjs         exit 0

LIVE ARM (serve.py :8765 → canonical xu7t2 dist, 17,682 packs, world_index verified;
local ACE restarted post-reboot; ?nullRender=1&nosw=1&packSource=on&slotGrid=on&
autoLogin&agent=1&netDrainHz=30; @teleloc battery per §ace-admin-cmds):
  boot → 36/36 LIVE, 144 LBs baked, 46 pins
  8 westward LB hops → 4 shifts, window solid 36 LIVE, 20 parked behind
  6-hop zigzag → +6 shifts, 36 pointer re-adopts, 0 parks issued for re-entries
  @telepoi Holtburg → teleports=1, 36-tile amortized drain, arrival refilled 36 LIVE
  FINAL: gridLruDivergence=0 · pinLeaks=0 · shiftMismatches=0 · slotDesyncs=0
         verify 126 ok / 0 mismatch · 0 quarantines · lanes 126 done / 0 failed
         0 console errors (11 pre-existing-class warnings)
OFF ARM: bare-default boot in-world, legacy ring 9→55 LBs/20 s, 0 errors.
```

## Handoffs & risks

- **Batch C (T32) is unblocked**: this is the "T20 stage-4 report green" prereq. E5
  eye + M1/M2 comparative arms + BENCH-ZIGZAG/BENCH-TELEPORT scored + TAIL-ULTRA on
  the 1070; browser floor under real render. Same deferral shape as T11/T12.
- **M3 vs migration-era stores (D4)**: R4 sits engaged on this 8 GB box because the
  summed instances exceed 0.94×M3 while the legacy shard cache is unbounded by
  design. Orchestrator call needed before GATE-GRID scores `r4Engagements`.
- **Keep-set fix wants a synthetic controller check**: the region suite pins the fix
  behaviorally (green, wire-identical) and the grid battery pins the readmit
  recovery, but a dedicated "queued regional survives a crossing whose ring tiles
  are resident" check in `test_pack_fetch_controller.mjs` would pin the controller
  edit in isolation. Small; left for the next controller-touching task.
- **T22 consumes**: grid events for W4/W5 relocation (tick currently a W6 coalesced
  run at the P1 site), `purgeByTile` on teleport drains, worker leases (D5).
- **Environment notes**: ACE was down post-reboot — restarted per the runbook
  (orphaned, FIFO stdin at `~/ace_stdin.fifo`); serve.py left running on :8765; the
  git-TRACKED `apps/holtburger-web/dist` symlink still points at the stale `…-xu7`
  root (the SERVING link `external/holtburger/dist` is correct and auto-repaired —
  T21 flagged the same skew; orchestrator to reconcile the tracked link).
- **pkg/ backup**: pre-T20 release wasm at the session scratchpad `pkg-backup/` for
  one session.
