# HANDOFF — cast-flag / fastcasting / targeting campaign residuals (2026-07-13)

Session span: 2026-07-12 → 2026-07-13. Four commits, all pushed to `origin/master`:

| commit | what |
|---|---|
| `d577a059` | 16-workstream spellcasting integration (buildbox fan-out, 36-agent local integration; packets + verdicts committed under `docs/spellcasting-packets-2026-07-12/`) |
| `120aef41` | flips r2/r3: castReliability, castGestureLen, castCancelStops, castBusyScope → default-ON; castRangeRing anchor fix (necessary, not sufficient) |
| `0c466f3f` | facing dead-zone `?castFacing20`, camera `?castCamBias`, retail target cycling (+`__selectNextTarget` hooks), rangeWarn wire-truth-position fix, rangeRing depthTest fix, wire-send ground truth, busy-clock accessor |
| `483167cd` | flips r4d: castRejectClears (late-reject chain-active fix) + castRangeRing (projectile-family gate) → default-ON; `__selectClosestTarget` hook; selectNext hardening + regression tests |

## 1. Flag state after this session

**Default-ON, eye-test validated** (all keep `?flag=off` escapes):
`castReliability` `castGestureLen` `castCancelStops` (r2, GTX-1070) · `castBusyScope` (r3, GTX) · `targetCycle` (r4a, GTX) · `castRejectClears` `castRangeRing` (r4d, local HD520) · `castReface` (r4c behavior-pass, flipped 2026-07-13 on the manual 1070 casting eye-test that substitutes for the harness's turn-metric isolation) · plus `castGestureParity` `projectileImpactStop` `projectileGroundClampSkip` (d577a059).

**Still default-OFF — exact blocker per flag:**
- `castRangeWarn` — REAL DEFECT REMAINS: r4d far-leg had clean preconditions (via==click, Magic stance, far dist) and the "Out of Range!" toast still did not fire. In-range half (no toast) is proven. Mechanism notes in the r4d judge journal (see §5 paths).
- `castFacing20` — behavior unmeasured, not disproven. The turn metric is contaminated: the local rig `root.quaternion` follows the SERVER pose, and ACE rotates the caster server-side unconditionally on every targeted cast (`Player_Magic.cs` Rotate at cast start; only re-rotates pre-gesture outside the 20° `spellcast_max_angle`). `camAzimuthDelta` (`cameraSwitcher.followYaw`) and `clientTurnInputs` read flat 0. NEXT: instrument `turnToFaceThenAct`'s turn-decision branch in-page (count "turn issued" directly) — do not diff poses.
- `castReface` — FLIPPED default-ON 2026-07-13 (see the default-ON list above); the r4c behavior pass + manual 1070 casting eye-test cleared the metric-isolation block. Kept `?castReface=off` escape.
- `castCamBias` — scenario blocked: CDP `page.mouse.click` at the projected entity origin deterministically misses the small drudge mesh at ~25 m (correct 20–28 m geometry was achieved in r4d). Harness aiming problem (project a BODY point / use pickEntityAt screen sweep), possibly also a real player-facing pick-difficulty datum.
- `castHoldReclaim` — same click-aiming blocker (close range, ndcx ~1.26 off-frame at click).

## 2. Fastcasting / slide-cast thread

- Feasibility: PARTIAL. Full report `holtburger-scratch/slidecast/SLIDECAST-REPORT-2026-07-12.md` (+ `video-timing-model.md`, `client-input-map.md`, `emulation-comparison.md`, `observer-verdict.md`, traces/, driver `drive-slidecast.cjs`).
- **Speed anomaly (informational, user-confirmed interest):** base-slide tap phases move at 13–16 m/s vs ~4.9 m/s plain run — likely ~3× retail (input superposition sums strafe+turn+forward velocities instead of clamping to run rate). Per ~3 s cast cycle: ~44 m net ≈ 49 character-widths ≈ 60 % of the 75 m casting circle. Animation-break straight window ~2.7 m @ ~4.5 m/s (plausible retail). Human calibration heuristic: crossing the full casting circle in ~2 casts = jacked; ~6 = retail-ish.
- Animation break works with an input adaptation (drop the turn key during the windup window); retail's strafe+turn+back zero-net-heading superposition is NOT expressible (held turn keeps rotating ~108°/s — cast General-stomp only kills the forward slot).
- Wire-send "Gap 1" RESOLVED as NOT a web-client desync: web UI transmits every cast (picking.js → castTargetedSpell → send_action); the `arm_busy_operation` drop is native-ClientRuntime-only. `castWireDropped` diag counter + `busyRemainMs()` accessor landed in `scene3d/diag/cast.js`.
- splitReality (two-client): observer streams caster pose (rubberband analyzable, 38–41 pose writes on plain slides) but `observerCastLinks=0` both scenarios — judged PASS-PROVISIONAL; deeper adjudication of what ACE broadcasts for windups is in the r4c/r4d journals.

## 3. Targeting / facing dossiers (decomp + ACE ground truth)

`holtburger-scratch/targeting-facing-2026-07-12/decomp-vs-client.md` + `ace-interaction.md`. Load-bearing facts:
- Retail client does NOT turn on cast; facing is server-driven. The wide already-facing band is ACE's `spellcast_max_angle` = 20°.
- Our `turnToFaceThenAct` (picking.js) had a 0.05 rad (~2.9°) dead-zone → spurious turns in the 3–20° band; `?castFacing20` widens to 0.349 rad (shared gate also covers reface + missile-face callers — note for flip decision).
- Follow-camera looks at the player root (`camera.js` ~:1119), so close targets fall off-frustum with zero turn — that is `?castCamBias`'s job.
- ACE sends NO cast-linked position rubberband (z-hack snap is the only true one). Selection is client-side; only the cast target GUID crosses the wire — target cycling needed zero ACE changes.
- Retail cycle semantics (unit-pinned in `tests/target_cycle.test.cjs`): NextMonster from the nearest mob WRAPS to the farthest. Use `window.__selectClosestTarget(type)` for "nearest" (no keydown needed); `__selectNextTarget(type, mode)` forwards mode; `selectNext` returns the guid actually committed (0 if refused). @create'd entities join `entityMap` only after their async mesh bake — selection correctly refuses un-baked guids; poll until the mesh commits.

## 4. Infrastructure discoveries (candidate MEMORY.md updates — user-directed only)

- **The laptop is NOT SwiftShader-only**: `--headless=new --use-angle=vulkan --ignore-gpu-blocklist` reaches the Intel HD 520 via Mesa ANV (`/dev/dri/renderD128` ACL). Benchmark (`holtburger-scratch/localperf-20260713/results.json`): SwiftShader bare 0.57 fps (starves streaming); HD520 vulkan full render 6.7 fps; +wireframe 21.9 fps; `--use-angle=gl` falls back to SwiftShader. Chromium binary: `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`.
- **playwright `browser.close()` on a `connectOverCDP` session CLOSES THE REAL BROWSER** (verified in playwright-core 1.59.1) — this killed the 1070's Chrome repeatedly mid-battery. The eye-test driver now uses `disconnectCdpNoClose()`. Never reintroduce `browser.close()` there.
- 1070 runbook deltas: launch .bat MUST carry `--mute-audio` (verify before schtasks run); the client hardcodes `ws://127.0.0.1:8080` for the ACE ws-bridge → a reverse tunnel `-R 8080:127.0.0.1:8080` is LOAD-BEARING for any remote box; ≥45 s single-login gaps + one retry on `0x1 Logon`.
- User-activity policy (user-directed 2026-07-13): if someone is using/closing the 1070, stand down 2 h. Activity check: their-chrome CPU delta over 6 s + LogonUI + last-input; a fresh boot with many chrome procs = human present, leave it alone.
- Workflow-subagent turn-limit trap: an agent that launches a long process as its child loses it when force-finalized, and cannot idle-wait on monitors. Long batteries: orchestrator launches `setsid` detached + monitors run.log; agents get short foreground until-loops only. Also: never `pgrep -f` a pattern contained in your own command line — bracket a char (`drive-cast[-]eyetest`).
- Accounts: test-harness convention password == accountName (`phase4demo`, `smoketest1` char Smokebee); `tailnet1` = Developer (@create 24888 Pyreal Target Drudge, @delete despawns — AdminCommands.cs:90).

## 5. Artifact map

- Eye-test battery: `holtburger-scratch/cast-eyetest-2026-07-12/` — driver `drive-cast-eyetest.cjs` (+ `matrix.json`, chains `run-chain-r4b.sh`/`run-chain-r4c.sh`, shots/, traces/, per-arm diags, `VERDICTS-*.txt`). Local chrome profile: `local-chrome-profile/` (CDP :9333).
- Judge/fix journals (full per-agent evidence): `~/.claude/projects/-home-wbterminal/4c50a6f2-*/subagents/workflows/wf_68abc3df-e11/journal.jsonl` (r4c judges) and `wf_7a284d28-79f/journal.jsonl` (r4d fixes+judges).
- Buildbox spellcast fan-out provenance: `~/from-vm/` pattern + packets committed in-repo; VM TERMINATED, disk kept.
- Redmi deliveries (taildropped): r2 zip, r3 zip, `VERDICTS-R4-FINAL-2026-07-13.txt` + `r4-final-2026-07-13.zip`.

## 6. Next-step queue (in rough value order)

0. **Cast-stability ring (LANDED 2026-07-13)** — new Graphics-settings option "Cast-stability ring" (default unticked, `holtburger_graphics_v1.extras.castStabilityRing`). Draws a 6 m amber ground circle (ACE `Windup_MaxMove`) frozen at the local caster's feet on cast start, auto-expiring at the cast's estimated duration (or `spellCastResolved`/`Rejected`). Hooks the centralised `spellCastInitiated` event in `scene3d/spell_shape_preview.js` (gated to the local `attackerGuid`); `window.__castStabilityDiag` surfaces optOn/anchored/drawn. NOTE: the fizzle it visualises only bites PK/PKL chars (ACE `PlayerKillerStatus != NPK`); the ring itself draws for any local caster once ticked. NEXT: 1070 eye-test for size/legibility; consider a PK-status draw-gate.
1. castRangeWarn far-leg defect — root-cause with the clean r4d diag (toast plumbing beyond the position fallback).
2. In-page turn-decision instrumentation → unblock castFacing20 + castReface flips.
3. Harness click aiming (body-point projection) → unblock castCamBias + castHoldReclaim.
4. Slide speed clamp investigation (retail movement-rate clamp vs our summed input lanes) — biggest fastcasting parity gap; decomp refs in `client-input-map.md`.
5. Human 1070 pass: ring/windup aesthetics + slide-distance calibration (user has the numbers on the redmi).
6. Optional: fold §4 infra facts into MEMORY.md (user-directed edit).
