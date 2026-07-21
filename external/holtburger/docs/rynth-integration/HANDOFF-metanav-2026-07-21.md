# HANDOFF — metanav ranked-gaps sweep: sentinel cleanup, jump slice, freeze verdict, door-state (2026-07-21, session 4)

Follow-on to `HANDOFF-metanav-2026-07-20.md` (session 3). This session ran its four top
ranked gaps as parallel agent workstreams; all four landed. Everything below is committed
in this commit. Suites at handoff: node rynth **37/0/2** (goto_compose 108→133),
cargo holtburger-world **575/0** held exactly, new door-state example-test target 7/0.

Session-3 loose end resolved first: the run-5 matron-hive report was never written — the
run died with its orchestrating session. ACE logs show run 5 ALSO ended in a Network
Timeout drop, consistent with the freeze class below (and with its launch recipe lacking
the hardening flags).

## 1. Importer sentinel cleanup (gap 4) — DONE, 28→40/49 base routes validated

Root causes (verified against raw corpus bytes, not the summary):
- REAL parser bug: `.af` pau records hardcoded `ew:0,ns:0,z:0` + misread duration
  (`nav_file.js`), silently collapsing genuine pause coords into the `(24468,24468)` sentinel.
- Genuine upstream VTank sentinel: `cht`/`pau` "no position" records legitimately carry
  `EW=0,NS=0` → world `(24468,24468)` exactly.
- Map-edge wraparound: `navPointToLeg`'s `Math.floor(wx/192) & 0xff` wrapped
  just-negative coords to LB 255 (opposite map edge, 49152 m legs) — now clamped.
Changes: `rynth/nav_file.js` (parser fix + clamp), `rynth/nav_import.js`
(`fixupSentinelLegs` — reposition zero-sentinel pau/cht legs to nearest real neighbor),
`rynth/nav_batch_import.cjs` (`splitAtHops` — split at genuine internal ≥500 m hops into
independently-validated segments). 43/49 routes byte-identical output (zero behavior
change for clean routes). Tests: navfile 19, navimport 16, navbatchimport 7 (new file).
Oracle re-run (parallel dir `/mnt/wbterminal2/met-corpus/routes-json-postcleanup/`,
original `routes-json/` untouched as baseline): 12 of the 16 targeted artifact failures
now VALIDATED; the other 4 now fail for real, distinct, already-documented reasons
(jump/outdoor/door) — the cleanup revealed gaps instead of masking them.
Report: `met-corpus/validation-reports/sentinel-cleanup-2026-07-21.md`.

## 2. Jump primitive (gap 1) — REFRAMED + first slice LIVE-PROVEN

**The session-3 framing was wrong: the gap was integration, not physics.** holtburger
already had a complete, parity-tested jump pipeline — wasm ballistic physics
(`compute_jump_velocity_z`, port of ACE `MovementSystem.GetJumpHeight`), byte-parity wire
packet (opcode `0xF61B` `Movement_Jump`/JumpPack), and `SessionHandle.jump(power)`
(pkg d.ts:4402) — built for manual keyboard play, with zero autonomous callers.
Corrections to prior lore: `_powera` in the retail formula is the **Jump skill** (charge
is a separate extent input); `0xF74E` is a **takeoff** velocity broadcast, not a landing
signal; ACE trusts client-reported jump velocity outright (`Player.cs:902` TODO);
`?jumpParity` does NOT gate `session.jump()` and is default-on anyway.

Phase 1 slice landed (`DESIGN-jump-primitive-2026-07-21.md` + its "Phase 1 results"):
- `rynth/goto_compose.js`: `attemptJumpLeg` (turn → `CanJumpNow()` gate → forward-hold →
  `Jump(power)` → settle/re-ground poll), `findUpcomingJumpLeg` (scan FAILED walk leg for
  nearby jmp-meta leg, window 12), `routeHasJumps`; wired into `replayRoute` FAILED dispatch.
- `rynth/webhost.js`: `Jump`/`SetMovementInput`/`CanJumpNow` capability wrappers.
- `rynth/bot.js`: `doFollowRoute` uses `replayRoute` when `hasPortals || hasJumps`
  (jump-only routes previously skipped all recovery logic).
- 19 new tests incl. a regression lock from the real vr-bridge-jump.nav leg shape.
LIVE-FIRE vs running ACE on the vr-bridge-jump fixture: `0xF61B` fired at its real call
site; power 1.0 + run produced a genuine ballistic arc landing ~26 m out. The fixture is
14 chained hops, not one 82 m jump (prior misread).
**Open Phase-2 item: actual movement bearing diverged ~90° from commanded heading**
(turn-convergence vs VTank heading-convention vs residual walk momentum — unresolved).
Then: oracle jump-arc simulation (Phase 2), router jump-edges per the UB template (Phase 3).

## 3. Headless client freeze (gap 2) — null repro, environmental verdict, recipe hardened

- Prime suspect **ruled out architecturally**: the wasm-threads/SAB work never landed
  (scoping doc only) — no COOP/COEP in serve.py, no `Atomics`/`SharedArrayBuffer` in
  first-party code; SAB isn't even constructible in the page.
- The frozen-CDP + futex_wait + 0 %-CPU signature requires a genuinely blocked OS thread —
  an unresolved JS promise leaves CDP answering. Best remaining fit: **environmental** —
  run 4's chromium launched WITHOUT anti-backgrounding flags; page-lifecycle freeze or a
  wedged SwiftShader GPU-process sync IPC fits.
- Two hardened repro attempts (~30 min live; instrumented with console-stderr heartbeats
  independent of CDP, pre-armed onerror/rejection hooks) did NOT reproduce — attempt 2
  cleared report-3's exact wedge coordinate and ran far past the ~52 s freeze window
  (452 heartbeats, zero errors).
- **Rule going forward: all long soak/bot chromium launches carry
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling`** (launch.sh already does for the rig).
- Latent-but-unrelated no-timeout awaits found, worth separate fixes:
  `crates/holtburger-resource-http/src/http.rs:44-124` (unbounded fetch),
  `apps/holtburger-web/scene3d/bake_worker_client.js:204-245` (no per-request timeout).
Report: `met-corpus/freeze-repro-report-2026-07-21.md`.

## 4. Door-state in navigation (gap 3) — DONE, and the frozen-tomb premise corrected

- LIVE half: `repathIndoor` recovery walks now do what the main path
  (`rynth/ai/tools/world.js` walkRoute) already did — `nearestClosedDoor`/`attemptDoorOpen`
  (`ODF_DOOR`=0x1000 / `PHYS_ETHEREAL`=0x4) before edge-exclusion, retrying the SAME path
  after opening (a closed door is not a topology dead-end). +6 tests (goto_compose →133).
- ORACLE half: `route_validate.rs` gained `DoorPolicy::AssumeOpen` — bounded retry on
  Wall/Timeout applied to all three placement shapes, mirroring the client's own
  `stage_bsp_02` multi-part-skip precedent; adopted only when no worse than the blind
  pass. Also: `_summary.json` globber quirk fixed; new `RV_DEBUG_STALL=1` diagnostic;
  7 new tests via `cargo test -p holtburger-world --example route_validate`.
- Corpus (postcleanup set, 77 real routes): **66→67 VALIDATED, zero regressions**
  (new: stone-of-rezarel seg12 — a real door bypassed).
- **Premise correction: frozen-tomb's blocker is NOT a DAT door.** Its blocking cell
  `0x77E701E1` has ZERO static objects (proven via WB.Terminal DAT parse + the AssumeOpen
  retry still failing leg 47) — likely server-authored geometry (the Deewain-lore caveat)
  or structural wall BSP. The session-3 "closed door" framing was an unverified assumption.
Report: `met-corpus/validation-reports/door-state-2026-07-21.md`.

## Stream rig actions this session (post-commit)

- `launch.sh` synced to the operator-directed live config that session 2 left as drift
  (`botModel=microsoft/phi-4`, `botInterval=0.5`, `botKernel=off` removed → kernel ON) so
  a relaunch no longer reverts it (`STREAM-RIG-OPS.md` §flags ⚠ note now satisfied).
- Rig relaunched per STREAM-RIG-OPS: single game session only (one page on CDP :9223),
  slate below game, go_live.sh → YouTube. Check YT Studio for the current watch URL
  (URL rolls on push restarts).

## Ranked next steps

1. Jump Phase 2: resolve the ~90° heading divergence (live), then oracle jump-arc
   simulation; Phase 3 router jump-edges (UB edge-walk template).
2. The two latent no-timeout awaits (http.rs / bake_worker_client.js).
3. Frozen-tomb blocker identification (server-side object dump vs structural BSP —
   needs ACE-side inspection, not DAT work).
4. bobo-outside outdoor coverage gap (still deprioritized), dungeon-graph pre-seeding
   (atlas-of-dungeons), oracle building-collision parity + 0x7200035F raw-tri dump.
