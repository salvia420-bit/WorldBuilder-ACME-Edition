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
