# task-ORACLE — retail-vs-holtburger movement/combat parity oracle

**Tier reached: T3 (the mission bar).** A retail Asheron's Call client runs
headless under Wine on the buildbox, logs into our vanilla ACE server on the
laptop through a datagram-safe relay, plays a scripted scenario, and the
resulting capture is diffed against holtburger telemetry from the same
scenario into a ranked parity report with real numbers.

T4 (Chorizite injected under Wine) was **not** reached and is not claimed. The
plugin builds; injection was not attempted.

---

## 1. Tiers

| tier | status | evidence |
|---|---|---|
| **T1** — all code builds, unit/harness tests green | **MET** | see §2 |
| **T2** — Wine client logs into laptop ACE through the relay | **MET** | `ACE_Log.txt`: `client agentp08 connected with verified password` + DDD interrogation response; client renders character-select against world `ACEmulator-local`, then the live world (avatar, chat channels, radar coords) |
| **T3** — one real scenario captured on BOTH sides, differ emits a parity report with numbers | **MET** | `docs/reengineering/oracle/first-parity-report.md` |
| **T4** — Chorizite injected under Wine, per-frame curves | **NOT MET** | plugin builds (`bin/Release/MoveOracle.dll`); injection not attempted — budget went to T2/T3 |

## 2. Test counts (all measured, not asserted)

| suite | command | result |
|---|---|---|
| pcap decoder | `cargo test -p holtburger-tools --lib oracle_pcap --release` | **7/7 pass** |
| differ | `node harness/oracle-diff.mjs --selftest` | **16/16 pass** |
| telemetry surface | `node test_move_telemetry.mjs` | **20/20 pass** (registered in Tier-1) |
| scenario driver | `node harness/oracle-run.mjs --selftest` | **7/7 pass** |
| relay boundaries | `python3 scripts/oracle/test_udp_tcp_relay.py` | **PASS** (200/200 datagrams both ways) |
| flag polarity | `node scripts/audit-flag-defaults.mjs` | **exit 0**, 632 flags, 0 polarity + 0 comment mismatches (was 631/0/0) |
| flag lint | `node scripts/lint-url-flags.mjs --strict` | same **3 pre-existing** PRESENCE-GUARD findings, 0 undocumented — no new active finding |
| Tier-1 JS suite | `node harness/run-js-headless.mjs` | 243 passed / 11 failed / 1 missing — the 11 failures are pre-existing and unrelated; `moveTelemetry` **PASS** |
| builds | `cargo check -p holtburger-core`, `-p holtburger-web --target wasm32`, `dotnet build -c Release` (MoveOracle) | all clean |

## 3. Commits

| commit | contents |
|---|---|
| `dd72c489` | D1 — `pcap2jsonl` decoder + datagram-safe relay + `box-rig.sh` |
| `f591411e` | D3/D4/D5 — `?moveTelemetry=1`, `scenarios.json`, `oracle-diff.mjs`, rig fixes that reached in-world |
| `48649635` | `WINE-RIG.md`, `oracle-run.mjs`, two real-data differ fixes |
| `16b92341` | D2 — MoveOracle Chorizite plugin (builds), driver accessor fix |

## 4. THE FIRST PARITY NUMBERS

Scenario `run-hold`, retail (pcap) vs holtburger (`?moveTelemetry=1`):

| metric | retail | holtburger | delta | verdict |
|---|---:|---:|---:|---|
| **steady_speed** | **7.400 m/s** | **7.787 m/s** | **+0.387 (+5.2%)** | FAIL (tol 0.05) |
| accel_t90 | 1460 ms | 0 ms | -1460 | FAIL — **artifact, see below** |
| release.steady_speed | 2.658 m/s | 7.787 m/s | +5.129 | FAIL — **artifact, see below** |

**Only the steady_speed row is a real measurement, and even it is
provisional.** Being explicit about that is the point of the oracle:

1. **The two sides were in different gaits.** holtburger's telemetry reports
   `gait: "walk"` (`hold_run=false`) for the whole hold, while the retail run
   was a run. `scenarios.json` warns about exactly this ("a driver that gets
   this backwards will produce a clean-looking report full of gait-swapped
   garbage"), and the oracle surfaced it on the first run — the `gait` row is
   in the report precisely so this cannot be missed. Until both sides are
   confirmed in the same gait, 7.400 vs 7.787 is not apples-to-apples.
2. **`accel_t90` and `release.steady_speed` are sampling artifacts, not
   defects.** The holtburger drain produced only **13 records over ~14 s**.
   The first non-zero sample is already at full speed, so "time to 90%"
   computes as 0; the release window falls in a gap, so its median is the
   held speed. Both are undersampling, not behaviour.

### Retail pins produced

`docs/reengineering/oracle/retail-pins.json` — machine-readable retail truth
for future `retail_behavior_tests`. Current content is the `run-hold` entry
(`steady_speed 7.400 m/s`, tolerance 0.05, plus `accel_t90` / `decel_t10`
which should NOT be pinned until the sampling issues below are fixed).

## 5. Rig facts learned (the expensive ones)

Full runbook: `docs/reengineering/oracle/WINE-RIG.md`.

- **The End-of-Retail archive is a PATCH OVERLAY, not a client.** Four files
  (acclient.exe + 3 dats). Its `acclient.exe` cannot run from a bare directory
  — it needs the base install's `Keystone.dll`, `MSVCP71.dll`,
  `chatclient.dll`, etc. Install the base first, then replace.
- **The installer payload cannot be extracted statically.** `ac1install.exe`
  is an InstallShield Setup Player 2K2 PE; `7z` cannot open it, and
  `unshield` recovers only 15 of 231 files — the client and dats stream from
  cab volumes inside the exe. The wizard must actually run.
- **No window manager means no keyboard focus.** `xdotool windowactivate` /
  `key --window` do nothing on a bare Xvfb. Absolute-coordinate mouse clicks
  work, and the same PointerRoot behaviour is what makes in-game keystrokes
  land (park the pointer over the viewport).
- **`UserPreferences.ini` with `FullScreen=False` is the entire DirectX
  story.** AC's fullscreen path walks the adapter mode list
  (`RenderDeviceD3D::CheckDisplayModes`); Xvfb exposes exactly one mode, the
  match fails, and `SelectBufferFormats` raises the "fatal DirectX issue"
  modal (`acclient.c:459429/459445`) with the client alive and transmitting
  nothing. Measured A/B with the ini as the only variable: **20 packets vs 0**.
  The client reads `<cwd>\UserPreferences.ini` FIRST (`acclient.c:62177`), so
  the client-dir copy is authoritative. (Owner-supplied diagnosis; confirmed
  against the decomp and by measurement.) The client is **d3d9**, not d3d8 —
  `+d3d8` traces are empty, which is why early debugging found nothing.
- **wine's gstreamer kills the client AFTER a successful login.** With no
  sound card: `Assertion failed: ret, quartz_parser.c:1152`. ACE's log shows a
  healthy session and the client is simply gone — easy to misdiagnose as a
  network fault. Disable the audio driver and `winegstreamer`.
- **wine 8.0 + Mesa llvmpipe is sufficient.** No WineHQ upgrade, no
  Xorg/NVIDIA, no winetricks. The box's T4 is unused; the oracle measures
  curves, not pixels.
- **`socat` is the wrong tool for the UDP-over-TCP hop.** TCP has no message
  boundaries, so back-to-back AC packets coalesce and the far socat re-emits
  them as one datagram. Measured: a 200-datagram burst arrived as **46**.
  `udp_tcp_relay.py` length-prefixes each datagram; its test asserts 200/200
  both ways.
- **Both ACE ports or a mystery timeout.** 9000 login, 9001 world, switched
  mid-session.
- **Backgrounded processes die with a non-interactive ssh session** even under
  `nohup`. Wrap each long-lived process in its own script and `setsid` that.
- Retail's key map differs from holtburger's: retail `A`/`D` **turn** and
  `Q`/`E` **strafe**; holtburger is the reverse, with `shift` as a walk
  modifier.

## 6. Real-data defects the oracle caught in its own tooling

Worth recording because no synthetic fixture would have found them:

1. **Mixed-source differentiation.** The server echoes the player's own
   position back (s2c `UpdatePosition`, same coordinates, tens of ms later).
   Differentiating across the interleaved c2s/s2c stream yields real-speed,
   0.000, real-speed, 0.000… whose median is ~0. Fixed: the player curve is
   built from the c2s stream only.
2. **Unfiltered s2c positions.** Every entity in view emits `UpdatePosition`;
   without a guid filter an NPC across the square joined the player's curve
   and produced a **185 m/s** sample. Fixed: s2c admitted only with an
   explicit player guid.
3. **A `?? 0` that disguised "absent" as "zero".** `oracle-run.mjs` read
   `window.__hbWasmNs`, which is not a window global (it is the module-scope
   wasm namespace used to *build* `window.__hbWasm`). Every call returned
   `undefined` and `?? 0` dressed it up as a real zero, which I initially
   misread as "the ring is empty". In a measurement tool, a default that can
   make a missing reading look like a valid one is a bug in itself.

## 7. The precise remainder

Ordered by what blocks the most.

1. **holtburger telemetry is undersampling badly — 13 records over ~14 s.**
   Expected ~1 record per tick. Until this is fixed, only steady-state
   metrics are trustworthy on the holtburger side and `accel_t90` /
   `decel_t10` / jump metrics cannot be compared at all. Investigate whether
   the `TickMovement` arm's `Ok(())` branch runs every tick under
   `?targetFps=20`, or whether the unified-tick spine takes a different path.
   **This is the single highest-value next step.**
2. **Confirm both sides are in the same gait before trusting any speed.**
   holtburger reported `hold_run=false` (walk) for a hold the driver intended
   as a run; the retail run was a run. Either the driver must assert the gait
   it requested against the telemetry before computing metrics (the scenario
   spec calls for this and the driver does not yet do it), or the run-by-
   default/shift-walk mapping differs from what the driver assumes.
3. **Most `MovementTelemetry` fields came back null** (`run_rate`,
   `current_style`, `forward_command`, `raw_*`). The local guid's
   `motion_interp` was not resolvable in `movement_managers` at dump time.
   Worth checking against `cast_arbitration_diag`, which reaches the same
   registry the same way.
4. **Retail pcap sampling is ~1 Hz** (min 145 / median 1058 / max 1874 ms),
   so accel ramps and jump arcs are unmeasurable from capture alone —
   `jump_apex` reads 0.00 because every reported z is ground level. This is
   what **D2/MoveOracle** exists to fix; it needs injection (T4).
5. **MoveOracle injection under Wine** was not attempted. The plugin builds
   against the vendored Chorizite tree. Note the version skew found while
   building: the vendored source is newer than the published NuGet 0.0.13
   (the package's `IRenderInterface` has no `OnRender3D`; the vendored
   `IRenderer` does), so `Chorizite.Core` is a `ProjectReference` and the
   transitive package versions are pinned up to match.
6. **Only `run-hold` has been run on both sides.** The other nine scenarios —
   including the MOVE-F2 walk-edge and MOVE-F6 diagonal regression cases —
   are specified and driver-ready but unexecuted. `cast` and `stance` steps
   have no driver hook yet (the driver logs and skips them).
7. **`scenarios.json` `expect` slots remain null by design.** They should be
   filled from `retail-pins.json` only once (1) and (2) above are fixed;
   pinning now would enshrine undersampled numbers.

## 8. Where things live

```
scripts/oracle/                     udp_tcp_relay.py + test, box-rig.sh,
                                    relay-box.sh, tunnel-up.sh
apps/holtburger-tools/src/oracle_pcap.rs        the decoder
apps/holtburger-tools/src/bin/pcap2jsonl.rs     its CLI
apps/holtburger-web/harness/oracle-run.mjs      holtburger driver
apps/holtburger-web/harness/oracle-diff.mjs     the differ
apps/holtburger-web/harness/fixtures/oracle/    real capture + both JSONL sides
apps/holtburger-web/docs/reengineering/oracle/  scenarios.json, WINE-RIG.md,
                                                first-parity-report.md,
                                                retail-pins.json
plugins/MoveOracle/                             the Chorizite plugin
```

Rig state on the buildbox: wine prefix `~/acwine`, client installed at
`~/acwine/drive_c/Turbine/Asheron's Call/` with the EoR overlay and
`UserPreferences.ini` in place; client and Xvfb stopped; captures in
`~/oracle-caps/`, logs in `~/oracle-logs/`. The laptop-side tunnel and relays
are still up (`scripts/oracle/tunnel-up.sh down` to stop them).

Accounts: `agentp08` retail, `agentp09` holtburger. Nothing was pushed.

---

# task-ORACLE session 2 (2026-08-11) — from "first number" to pinned numbers

Session 1 reached T3 with one provisional figure (holtburger +5.2% fast,
believed gait-mismatched). Session 2 fixed the four measurement defects that
figure was made of, ran the whole scenario suite on both sides from ONE fixed
capture site, and produced a second parity report whose remaining FAIL rows
are behaviour, not instrumentation.

**The headline changed sign and shrank by 4x.** holtburger is not 5.2% fast;
it is **1.0% SLOW**, and the cause is identified to the exact number.

## S2.1 What the session-1 number was made of

Four independent defects, all in the oracle rather than in the client:

| # | defect | evidence | fix |
|---|---|---|---|
| 1 | **The `gait` field was inverted.** `?moveTelemetry=1` serialized the raw `hold_run` latch as if it were the gait. `hold_run` is the SHIFT key; under holtburger's run-by-default option `hold_run == false` IS run (`hold_run XOR UITogglesRun`, acclient.c:716991). | Every session-1 record read `gait: "walk"` for a hold that was a run. The report's own "the two sides were in different gaits" caveat was itself wrong. | `MovementSystem::gait_from_hold_run` is now the ONE derivation both the drive dispatch and the telemetry go through; telemetry gained `effective_gait`. Unit test `movement_telemetry_reports_derived_gait_and_local_drive`. |
| 2 | **Two different estimators.** Retail speed was differentiated from c2s positions; holtburger speed was the integrator's `current_planar_velocity` — an INTENT vector. | Measured: an avatar pinned against a dungeon wall reported 7.787 m/s while travelling ~1.5 m/s. | The differ now differentiates positions on BOTH sides (central difference, global metres) and keeps the reported vector as its own `intent_speed` row. |
| 3 | **The capture site was wherever the character last logged out.** Session 1's holtburger run was inside a dungeon; the retail run was in Yaraq. | `pos.lb` in the session-1 captures. | `scenarios.json.capture_site` — both sides `@teleloc` to Samsur with an explicit heading quaternion. Chosen by an 8-site survey (below), not by eye. |
| 4 | **Undersampling: 13 records over 14 s.** The wasm `TickMovement` arm emits one record per tick and JS enqueues one tick per rAF frame, so the sample rate IS the frame rate — and SwiftShader on this laptop renders ~1.9 fps even under `?targetFps=20`. | Measured A/B, same scenario, same box: `?targetFps=20` → 2.0 records/s, dt median 290 ms. `?renderOnDemand=1&netDrainHz=30` → **28.0 records/s, dt median 33 ms**. | The driver's URL. No code change — the tick enqueue moves onto the net-drain interval (`scene3d/index.js::syncTickHop`) and rendering stops entirely. |

## S2.2 The capture site, chosen by measurement

An 8-site survey (4.5 s run-hold at each, one browser session) scored
realized/intent and the z range over the run:

| site | realized | intent | ratio | z range |
|---|---:|---:|---:|---:|
| **Samsur** | **7.787** | 7.787 | **1.000** | **0.00 m** |
| Freehold | 7.783 | 7.787 | 1.000 | 0.00 m |
| Yaraq (session 1's ground) | 7.785 | 7.787 | 1.000 | 0.99 m |
| Holtburg / Shoushi / Zaikhal | 7.775-7.782 | 7.787 | 0.999 | 0.00 m |
| Plateau | 7.788 | 7.787 | 1.000 | 7.16 m |
| Beach Fort | **0.000** | 0.000 | — | 0.00 m |

Beach Fort is the point of the survey: it is unrunnable (the avatar is against
something and only the heading moves) and would have produced a confident,
completely wrong number.

## S2.3 THE PARITY NUMBERS

Full report: `docs/reengineering/oracle/second-parity-report.md`.
Machine-readable retail truth: `docs/reengineering/oracle/retail-pins.json`.

### Trustworthy

| scenario / metric | retail | holtburger | delta | verdict |
|---|---:|---:|---:|---|
| **run-hold-long / steady_speed** | **7.885 m/s** | **7.806 m/s** | **-0.079 (-1.0%)** | FAIL (tol 0.05) |
| strafe-diagonal / steady_speed | 7.768 | 7.976 | +0.208 (+2.7%) | FAIL |
| walk-edge (F2) / second_hold gait | run | run | — | **PASS** |
| jump-running / jump_apex (holt) | — | 0.350 m | — | matches retail's own launch vector exactly (below) |

`run-hold-long` exists because of retail's sampling floor: its ~1 Hz c2s
heartbeat gives the 4 s `run-hold` two or three usable samples, whose median
carries no weight. Ten seconds gives nine, and they are tight: 8.136, 7.874,
7.847, 7.829, 7.921, 7.972, 7.896, 7.879, 7.865 m/s.

### Rows that are NOT defects, and are now labelled so

The differ classifies a row `retail-unresolvable` when the metric is finer
than retail's wire sampling can see — every ms-tolerance metric (`accel_t90`,
`decel_t10`) and the ~500 ms jump arc. Those rows are excluded from the ranked
defect list and from the pins. Session 1's report ranked exactly such rows at
the top; the honest statement is that they need T4 (in-process sampling), not
that holtburger is 96% wrong.

## S2.4 ROOT CAUSE of the -1.0%: holtburger's run rate is 1.5% low

Ground speed is `4.0 x run_rate`, so a steady-speed delta is a run-rate delta.
Both values were read directly, from two independent places:

* **Retail: `run_rate = 1.975806474685669`.** Read off the wire — the client's
  own autonomous movement broadcast carries it as `interpreted.forward_speed`
  (s2c `UpdateMotion`, `retail-run-hold-long.jsonl` t=3.70). It is also
  confirmed by retail's own `Jump` GameAction, which reports a planar launch
  velocity of **7.903226 m/s** = `4.0 x 1.9758065` exactly — a noise-free
  reading that owes nothing to position differentiation.
* **holtburger: `run_rate = 1.9467213153839111`.** Read from
  `playerRunRate()`, now recorded in every capture's `.meta.json`.

Feed both through ACE `MovementSystem.GetRunRate(burden, runSkill, 1.0)`:

```
(loadMod * (S/(S+200) * 11) + 4) / 4
S = 110, loadMod 1.0 -> 1.9758065   <- retail / the server
S = 105, loadMod 1.0 -> 1.9467213   <- holtburger
```

Both land on an exact integer Run skill. The two clients disagree about the
Run skill by exactly 5 points — and the two characters are stat-identical
(`ace_shard`: both level 1, Run 0/0/Untrained, Quickness 100), so this is not
a character difference.

**The mechanism is a known, deliberate deviation.** Retail does not compute a
run rate at all: `unpack_movement` case 6 stores the server's rate into
`my_run_rate` (acclient.c:339571) and the client uses it. holtburger keeps
that path for REMOTE entities but recomputes the LOCAL player's rate
client-side from the wire Run skill and burden
(`holtburger-world::context::player_run_rate`, movement/motion_interp.rs:400
"remote objects get `my_run_rate` from the wire, NEVER the local player").
That recomputation is where the 5 points are lost — either the skill value it
reads is Base-like rather than ACE's `Current`, or the burden term is not 1.0.

**Defect card MOVE-RUNRATE-105 (not fixed here, deliberately).** The fix is a
one-line direction change (consume the wire rate for the local player too),
but it reverses a documented STAGE-1 decision made for snapback reasons, and
the oracle's job this session was to establish the number, not to relitigate
that. What it now has is: the exact delta (0.0290852 rate, 0.116 m/s, 1.47%),
both endpoint values, an exact-integer decomposition, and a repeatable
measurement.

## S2.5 Findings beyond the run rate

* **MOVE-F2 (walk-edge) is confirmed against retail.** Retail's second hold
  after a walk-hold release comes back at 7.814 / 7.985 / 7.678 m/s — a RUN —
  and holtburger's does too (7.787, `effective_gait: "run"`). The regression
  pin is real and both sides agree on it.
* **MOVE-F6 (diagonal) disagrees, direction unknown.** holtburger's W+D
  diagonal runs at 8.361 m/s (intent) / 7.976 (realized) against 7.787
  forward — the uncapped sum a2's DEVIATION D1 predicts. Retail measured
  7.768, i.e. NOT faster than forward. **But the retail arm did not actually
  strafe**: its capture contains no `SIDESTEP_COMMAND` in any raw motion
  state, so the `e` keystroke did not register as a strafe. The retail key map
  in WINE-RIG.md §6 (`Q`/`E` strafe) is therefore UNVERIFIED, and this row
  must not be read as a defect until a retail capture shows a sidestep command
  on the wire.
* **Jump vertical physics match exactly.** Retail's `Jump` reports
  `vel.z = 2.6191602`; under g = 9.8 that is apex `v^2/2g = 0.3500 m` and
  airtime `2v/g = 534.5 ms`. holtburger measured **apex 0.350 m, airtime
  522.8 ms**. The `jump_distance` difference (4.07 vs 4.22 m) is entirely the
  run-speed delta of S2.4 acting over the same airtime.
* **turn rate is close but the SIGN may differ.** Retail turns at ~134 deg/s;
  holtburger reported -128.9 deg/s for the same intent. The magnitudes are
  within 4%, but the two sources' heading conventions have not been shown to
  agree, so the sign is not yet a claim.

## S2.6 Rig facts learned this session

* **The sample rate is the frame rate.** See S2.1 #4. Any future in-browser
  measurement of a timed behaviour must move the tick off rAF first.
* **One ~6.5 s main-thread stall lands inside almost every capture** on this
  laptop (8 GB, 4.8 GB swap in use). It is not once-per-session and retries do
  not dodge it: 10 of 11 captures in the final suite carry one. Consequences,
  all now instrumented rather than silent:
  - the driver records `sample_dt_ms.max` and warns above 500 ms;
  - the driver compares the capture's span against the plan's total and warns
    when it falls short — the check that would have caught the run that
    produced 54 samples at a perfect 33 ms median with the entire keyed hold
    inside the stall;
  - the differ marks samples whose difference window spans a stall as `null`
    rather than differencing across it. Before that guard, MOVE-F2's second
    hold reported **0.030 m/s** from a capture that plainly showed 7.787,
    because the pose froze while the avatar kept moving.
  `walk-hold` and one F2 run were lost to this and are reported as no-data.
* **A cadence gate beats a sleep.** The driver drains the ring, waits a
  second, drains again, and refuses to start until it sees 3 consecutive
  seconds at >=80% of the target rate. A fixed settle cannot work: the stall
  length depends on what has to bake.
* **`@teleloc` works from both clients** (both accounts are accessLevel 4), so
  the capture site is enforceable on the retail side too — typed into the AC
  chat bar by `box-rig.sh scenario`.
* **The retail key remap is executable now.** `oracle-run.mjs --emit-retail-plan`
  generates the box's plan file and performs the a<->q / d<->e swap in one
  unit-tested function, instead of a human retyping WINE-RIG.md §6 prose.

## S2.7 Test counts (all measured)

| suite | command | before | after |
|---|---|---|---|
| differ | `node harness/oracle-diff.mjs --selftest` | 16/16 | **27/27** |
| scenario driver | `node harness/oracle-run.mjs --selftest` | 7/7 | **23/23** |
| movement core | `cargo test -p holtburger-core --lib` | — | **633 passed / 0 failed / 1 ignored**, including the new `movement_telemetry_reports_derived_gait_and_local_drive` |
| flag lint | `node scripts/lint-url-flags.mjs --strict` | exit 0 | **exit 0**, same 3 pre-existing PRESENCE-GUARD findings, 0 undocumented (no new flags) |
| flag polarity | `node scripts/audit-flag-defaults.mjs` | exit 0 | **exit 0** |
| retail captures | `box-rig.sh scenario` | 1 ad-hoc | **7 scripted** |
| holtburger captures | — | 1 | **11 (whole suite)** |

## S2.8 What changed

| file | change |
|---|---|
| `crates/holtburger-core/.../movement/system.rs` | `gait_from_hold_run` as the ONE gait derivation; `MovementTelemetry` gains `effective_gait` + the `drive_*` mirror of the local composed drive (the `movement_managers` motion-interp fields are wire-fed and are `None` for the local player by construction — that is why session 1 saw them all null). |
| `apps/holtburger-web/src/lib.rs` | the `?moveTelemetry=1` record emits `effective_gait`, not the raw latch. |
| `harness/oracle-run.mjs` | net-drain tick URL; `@teleloc` capture site; warm lap; cadence gate; gait assertion; capture-quality + run-rate sidecar `.meta.json`; `--all`; `--emit-retail-plan` with the retail key remap. |
| `harness/oracle-diff.mjs` | one estimator both sides; landblock-global positions (reusing `harness/lib/movement_gate.mjs::poseToGlobalXY`); stall-aware differencing; empty-window guard; `intent_speed`; `retailResolves` + the `retail-unresolvable` verdict; `--dir` suite mode; pins filtered to resolvable metrics. |
| `scripts/oracle/box-rig.sh` | `scenario` subcommand: teleport, capture, replay a generated plan on a ms clock, release every key. |
| `docs/.../scenarios.json` | v2: `capture_site`, `cast_spell`, and the `run-hold-long` scenario. |
| `docs/.../WINE-RIG.md` | §6a — playing a scenario, and the "the client starts wherever it logged out" trap. |

## S2.9 The remainder (re-ranked)

1. **MOVE-RUNRATE-105 (S2.4)** — decide the direction: consume the server's
   `my_run_rate` for the local player as retail does, or find why the
   client-side derivation reads Run skill 105 where ACE reads 110. This is the
   only confirmed behavioural divergence in the suite.
2. **The laptop's 6.5 s stall (S2.6)** — until it is removed or dodged, one
   scenario per suite run is lost and `accel`/`decel` windows are fragile.
   Worth profiling: it is regular enough to look like GC or swap, not bake.
3. **Verify the retail strafe key** before reading anything into MOVE-F6. One
   capture showing `SIDESTEP_COMMAND` on the wire settles it.
4. **T4 / MoveOracle injection** is now the binding constraint on half the
   metric table, not a nice-to-have: every ms-tolerance metric is
   `retail-unresolvable` from pcap alone, and the report says so per row.
5. **`cast` and `stance` now have real driver hooks** (`castTargetedSpell` +
   `@addspell`, `toggleCombatMode` — the same surfaces `probe_cast_matrix.cjs`
   drives) and holtburger-side captures exist, but there is no retail-side
   driver for either, so those four scenarios have no retail column.
6. **Heading-convention parity** between the two telemetry sources, so
   `turn_rate` sign can be compared (S2.5).
7. **`walk-hold` on the holtburger side** was lost to the stall in every
   attempt; retail's walk steady speed is pinned at 1.849 m/s and holtburger's
   walk figure from the F2 first hold is 3.126 m/s. That gap is large enough
   to be worth a clean re-measurement — note holtburger's walk appears to be
   `1.6 x run_rate` (1.6 x 1.94672 = 3.1148, matching 3.120 to 3 decimals),
   while retail's `apply_run_to_command` is documented to scale only the RUN
   arm. If that holds it is a second run-rate-shaped defect.

---

# task-ORACLE session 3 (2026-08-11) — the run rate, closed

Session 2 established the number and named its cause. Session 3 implements the
owner's directive, finds that the cause was one layer deeper than the card
said, and — while measuring the result — finds two defects in the differ that
had been quietly fabricating values on both sides of every stall.

**`run-hold-long / steady_speed` goes from a −1.0% FAIL to a −0.1% PASS**, and
the residual 0.1% is not a client difference at all: it is a Vitae
enchantment on one of the two test characters.

## S3.1 The directive, and what the decomp says about it

> **Owner directive, 2026-08-11:** adopt the server-provided run rate for the
> local player — retail-faithful.

Implemented, default-on, `?serverRunRate=off` to restore the stage-1 order.
The reversal is recorded as a DEVIATION block in the stage-1 decision doc
(`docs/2026-06-11-unified-movement-pipeline/DESIGN.md` §2 defect 1).

The directive's premise deserves a correction on the record, because the
decomp does not support the "retail-faithful" half of it:

| | |
|---|---|
| Retail DOES stamp the wire rate | `CMotionInterp::apply_interpreted_movement` — `if (interpreted_state.forward_command == 0x44000007) my_run_rate = interpreted_state.forward_speed` (acclient.c:344161-344162) |
| …but only inside `unpack_movement` | and `CPhysics::SetObjectMovement` gates that on `autonomous == 0 \|\| !player_controlled` (:311186-311190) |
| and every frame carrying the rate is autonomous | measured across all seven retail pcaps: `forward_command 7 → forward_speed 1.975806474685669`, `server_control 0`, `autonomous true`. Walk frames carry no `forward_speed` at all. |
| so retail's LOCAL player never latches one | it re-derives per command through the weenie `InqRunRate` vfptr → `CACQualities::InqRunRate` (:443696-443770) — a LOCAL composition |

Honouring retail's gate would have made the latch dead code. The directive is
therefore implemented as a deliberate, documented departure, and the gate
itself is encoded as an executable pin
(`retail_behavior_tests::runrate_105::t_retail_skips_the_autonomous_self_echo`)
so the deviation cannot rot into folklore.

## S3.2 The root cause was one layer under the card

The card said holtburger's recomputation "loses 5 points — either the skill
value it reads is Base-like rather than ACE's `Current`, or the burden term is
not 1.0." Neither. `ace_shard` says both characters carry
**`AugmentationJackOfAllTrades = 1`**, and *both* retail and ACE add 5 for it:

```
retail  CACQualities::InqRunRate :443741   if (InqInt(0x146) > 0) runskill += 5
ACE     CreatureSkill.GetAugBonus_Current  total += AugmentationJackOfAllTrades * 5
us      derive_skill_value                 (nothing)
```

The stage-1 spec's own wording — "wire Run skill `Current` exactly as ACE
composes it (formula base + init + ranks)" — is short by three terms
(`LumAugAllSkills`, `AugmentationJackOfAllTrades`, `LumAugSkilledSpec`).
`run_skill_augmentation_bonus` adds all three. Note that holtburger's OTHER
skill implementation, `holtburger-core::client::skill_info::SkillInfo::current`
(the retail `SkillInfo.cs` port that feeds the character sheet), has had them
since it was written: the character panel showed 110 while the movement lane
ran on 105.

## S3.3 THE NUMBERS

Both sides re-captured this session at the same Samsur site.
Report: `docs/reengineering/oracle/third-parity-report.md`.
Pins: `retail-pins.json` (run-hold-long + strafe-diagonal re-pinned).

| scenario / metric | retail | holtburger | delta | verdict |
|---|---:|---:|---:|---|
| **run-hold-long / steady_speed** | **7.895 m/s** | **7.884 m/s** | **−0.011 (−0.1%)** | **PASS** (was −1.0% FAIL) |
| strafe-diagonal / steady_speed | 8.468 | 8.362 | −0.106 (−1.3%) | FAIL — but now a REAL comparison, see S3.5 |

The per-tick provenance block (S3.4) reports the same four values on all 233
ticks of the measured run:

```
composed 1.9467213   server 1.9700646   latched 1.9700646   rate 1.9700646
```

Read that carefully, because it says three things at once:

1. **Fix A is what is doing the work.** The latch fires, and the integrator
   consumes the server's rate.
2. **Fix B is not reaching the movement lane.** `composed` is still the
   Run-105 rate at run time, even though the login-time stats snapshot
   reports `run_skill_aug_bonus: 5` and `run_skill_used: 110`. The
   augmentation property is visible to the stats publisher and not to the
   movement lane's property read — an open defect (S3.7).
3. **The server said 109, not 110.** `agentp09` carries a Vitae enchantment
   (spell 666, ×0.99) and `agentp08` does not. ACE's `CreatureSkill.Current`
   scales by vitae BEFORE adding the JackOfAllTrades +5: `105 × 0.99 + 5 =
   108.95 → 109` → rate 1.9700646 → ground speed 7.880258, against the
   measured intent of **7.880238**. The −0.1% residual in the table above IS
   that vitae penalty. It is a character difference, not a client one.

Which is the case for the directive, stated as a number: to match the server
by composition the client would have to model vitae, three augmentation
terms, and every enchantment multiplier and additive. The server's value is
right by construction.

## S3.4 Two more ways the differ was fabricating numbers

Both found by disbelieving a result, and both would have produced a confident
wrong answer for this session's headline.

**(a) The stall guard did not guard.** Session 2 nulled a stalled sample's
speed so `resample` could not USE it. But a nulled sample is simply absent
from `resample`'s point list, so the grid loop drew a straight line from the
last sample before the stall to the first one after it. On the first
acceptance capture — whose release landed inside a 6.4 s stall — that ramp
dragged the steady window down and the report read **7.573 m/s** for a run
whose observed samples were a flat 7.883. With bridging refused: **7.884**.

**(b) `resample` also extended past the end of the data.** A re-take whose
stall landed in the PRE-ROLL pushed the whole hold to the end of the capture;
60% of the steady window then sat past the last sample, filled by repeating
the post-keyup at-rest value, and the report read a confident **0 m/s** — a
−100% FAIL — for a run the same capture's quality block put at 7.88. With the
end clamp: **7.873**.

A `MIN_WINDOW_COVERAGE` floor (0.25) now rejects windows a stall almost
entirely ate. The floor is low on purpose and the number is measured: a
perfectly usable capture on this laptop keeps only ~47% of its steady window.
A 0.5 floor threw that capture away.

*Consequence for the record:* session 2's `-1.0%` and `7.806` were computed by
the bridging differ, so they are not directly comparable to the numbers above.
The bridge-independent statement of the same defect is the rate itself —
**1.9467213 (Run 105) against the server's 1.9700646** — which is what the
`?serverRunRate=off` arm still reports at run time today, and what the
per-tick `composed` field shows.

## S3.5 MOVE-F6 settled: retail's key map, from the client's own help file

Session 2's retail strafe arm produced no `SIDESTEP_COMMAND` and the row was
unreadable. The map is not a matter of opinion — the shipped client documents
it in `helpcontent/MOVING WITH THE KEYBOARD.ksml`, one `cat` away on the rig:
**W forward, X back, A/D TURN, Z/C SIDESTEP, Q auto-run, SPACE jump.**

The old map (`a↔q`, `d↔e`) was right for the TURN axis by luck — which is why
`turn-while-run` turned at 134 deg/s and the map looked verified — and sent
the strafe axis into retail's **E, which is bound to nothing**. Worse, it sent
holtburger's `a` to retail's **Q, which toggles AUTO-RUN**: a left-strafe
scenario would have latched a run that outlived every subsequent keyup in the
session. A selftest now asserts no scenario key can ever map onto Q.

With `C`, the retail capture carries what it should:

```
s2c UpdateMotion 0x50000178  sidestep_command 15 (SIDESTEP_RIGHT)
                             sidestep_speed 2.4658  forward_command 7  forward_speed 1.9758065
```

So MOVE-F6 has its first real comparison: **retail 8.468, holtburger 8.362**.
Note the SIGN — a2's DEVIATION D1 predicted holtburger would be FASTER on the
diagonal (an uncapped axis sum); it is slower, by more than the vitae
difference accounts for (−1.3% measured, −0.29% explained). D1 is not
confirmed and the row is now a live, measurable question rather than a
stalemate.

## S3.6 Test counts (all measured)

| suite | command | before | after |
|---|---|---|---|
| movement core | `cargo test -p holtburger-core --lib` | 633 | **643 passed / 0 failed / 1 ignored** (+10 `runrate_105` pins) |
| world | `cargo test -p holtburger-world --lib` | — | **687 passed / 0 failed** |
| differ | `node harness/oracle-diff.mjs --selftest` | 27 | **33 passed / 0 failed** |
| scenario driver | `node harness/oracle-run.mjs --selftest` | 23 | **32 passed / 0 failed** |
| flag lint | `node scripts/lint-url-flags.mjs --strict` | 3 PRESENCE-GUARD | **unchanged, 0 undocumented** (the 3 are pre-existing; verified by stashing this session's edits) |
| flag polarity | `node scripts/audit-flag-defaults.mjs` | exit 0 | **exit 0, 0 mismatches** |

`cargo test -p holtburger-web --lib` has ONE pre-existing failure
(`tests_substitution::resolve_static_placement_frame_orders`), confirmed
pre-existing by stashing this session's `lib.rs` edit.

## S3.7 The remainder (re-ranked)

1. **The augmentation property does not reach the movement lane.** Fix B is
   correct and unit-pinned, but at run time `player_composed_run_rate()` still
   reads Run 105 while the stats publisher reads 110 — same world, same
   helper. Likeliest suspect is the player ENTITY's property bag being rebuilt
   (the `player_description_properties` re-seed path exists for exactly this
   class) around the `@teleloc`. Today this is masked by fix A; it stops being
   masked in the boot window before the first RunForward echo.
2. **The client composition does not model vitae.** ACE scales
   `CreatureSkill.Current` by it; we do not. Second-order while fix A is on,
   and a second argument for keeping it on.
3. **The ~6.5 s stall is per-scenario, not per-session.** Session 2 recorded
   it as one-shot; measured this session it hit **all three attempts** of every
   capture, always after the `@teleloc`, and always within a few seconds of
   the run crossing into the next landblock (`0x977B000C → 0x977B000D`). That
   shape — teleport-then-cross — points at landblock streaming/bake rather
   than GC or swap. Worth a card of its own: on this hardware it is a capture
   nuisance, but a 6.4 s main-thread park on a landblock crossing is a client
   defect in its own right. First check should be whether the bake web worker
   fell back to the main thread.
4. **MOVE-F6's −1.3%, now that both sides really strafe** (S3.5).
5. **Clear agentp09's vitae** before reading anything finer than ~0.3% out of
   any pin.
6. **T4 / MoveOracle injection** — unchanged: every ms-tolerance metric is
   still `retail-unresolvable` from pcap alone.
7. **No retail driver for `cast` / `stance`** — unchanged; four scenarios
   still have no retail column.
