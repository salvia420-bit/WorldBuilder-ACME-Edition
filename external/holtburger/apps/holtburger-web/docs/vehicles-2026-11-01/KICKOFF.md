# Vehicles — kickoff for the implementing session (written 2026-11-01)

Implement the vehicles design for holtburger-web + our ACE fork, starting with a working Hellcat-type fighter demo.

## Read first (in this order)

1. `~/CLAUDE.md` — laptop rules (8 GB): ONE heavy job at a time (wasm-pack / cargo, the full JS gate, any headless
   Chrome, dotnet builds), check `free -m` (≥ 2.5 GB available), wrap heavy jobs in `capped-build`, never
   `cargo --workspace`.
2. The design — the spec you are implementing:
   `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/DESIGN.md`
3. The evidence behind it — the drone-carries-the-player experiment:
   `.../apps/holtburger-web/docs/drone-deploy-2026-10-24/carry-experiment/README.md`
   (its scripts — `carry-runner.mjs`, `carry-flight.eval.js`, `carry-census.eval.js`, plans, `table.py` — are your
   headless test rig). Older context: `../ace-streaming/README.md` and `hb-drag.patch` (the 2026-10-25 drag hook).
4. Memory: `~/.claude/projects/-home-wbterminal/memory/ace-live.md` (ACE restart recipe, console FIFO).
   `MEMORY.md` is read-only — no edits unless the owner asks.

## Owner decisions (settled)

- Server-authoritative vehicles: clients send inputs, the server simulates, the pilot predicts + reconciles,
  observers interpolate.
- Vehicles fight monsters (PvE). Bail-out → on foot with a parachute (after fly + shoot).
- Scale: a couple of vehicles for demos.
- holtburger-web only for the vehicle experience; retail clients must keep connecting and playing and see a stand-in
  (the representation ladder, DESIGN §5.1) — keep one wire spec, the capability bits (observe / pilot / patch), the
  `HBV1` tag, and the vehicle's looks as data built from retail assets.
- 750 km/h is informational only. Demo cap 250 km/h, then 400 km/h in M3.

## What to build

Milestones M0 → M5 in DESIGN §8, in order; M1 (fly) and M2 (shoot) are the demo. Each has a "done when" — prove it
before moving on.

- **ACE** work happens in `~/ace-server` (the LIVE server on this laptop): make a branch, put every feature behind a
  server property that defaults off, build only the project, keep the previous `bin/Release/net10.0` for rollback,
  and restart with the `ace-live.md` recipe only when no human is logged in (check `ACE_Log.txt` for `[LOGIN]` without
  a later `[LOGOUT]`). Tell the owner when you restart.
- **Client** work happens in the main tree (`external/holtburger`), behind URL flags that default off, following the
  project's flag conventions (`docs/url-flags.md`).
  - The wasm crate is `apps/holtburger-web` (`src/lib.rs` + `src/session/**`) — NOT `crates/holtburger-web`.
  - Protocol code: `crates/holtburger-protocol` (`opcodes.rs`, `src/messages/`).
  - Reuse `scene3d/drone/` (controls, camera owner, OSD).
  - Release wasm:
    `env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build --target web --out-dir pkg --release`
- **Verified ACE hook points** (cited in DESIGN):
  - `WorldManager.UpdateGameWorld` → `VehicleManager.Tick` goes before `LandblockManager.Tick`.
  - `InboundMessageManager.HandleGameAction` only warns on unknown opcodes.
  - `LandblockManager.RelocateObjectForPhysics` is where the wake-on-entry fix goes.
  - `Landblock.TickPhysics` returns early for a dormant landblock.
  - `Player_Tick.UpdatePlayerPosition` holds the 50 m / one-landblock reject.
  - `ObjectMaint.InitialClamp_Dist` is a static 112.5.
  - `Monster_Combat.TakeDamage(source, damageType, amount, crit)` is the damage entry point.
  - `MotionCommand.Sitting = 0x41000013`.
  - Opcodes 0x0900–0x09FF are unused in ACE, Chorizite and holtburger.

## Testing

- **Targeted tests are cheap:** C# for flight-model parity and the protocol, `node tests/x.test.mjs`, and single-crate
  Rust tests under `capped-build`. A golden-trajectory parity test between the C# server model and the JS predictor is
  required.
- **Headless bench:** `carry-runner.mjs`, adapted to vehicles. Lessons from the last session:
  - Use `?nullRender=1&hud=none` at 960×540 with `--disable-gpu-compositing`; otherwise SwiftShader throttles rAF to
    ~5 fps.
  - Use bot account `agentp10` (Developer, password = account name). Never `tailnet1`: that is the owner's.
  - Stop a session when MemAvailable < 900 MB; earlyoom killed the tab once.
  - SwiftShader's slow boot latches `__bootState='error'` on a healthy world; reset it in the harness.
  - Kill a stuck runner by its node PID with SIGKILL (Playwright swallows SIGTERM).
  - The oom-guard hook blocks commands mentioning node/chromium unless they are wrapped in `capped-wireagent` /
    `capped-build`.
- **The 1070 is offline.** Anything about look or feel goes into a queued eye-test checklist in the vehicles docs folder.

## Working rules

- The design is a strong draft, not scripture. When the code disagrees, read the code (agent citations are
  hypotheses until read). Decide sensibly and record each deviation in a "Decisions log" section in DESIGN.md, or ask
  the owner if it changes the experience.
- Open questions you may settle with sensible defaults (record them): the retail stand-in Setup, unlimited ammo for
  the demo, the pilot can't be damaged while seated, short vertical takeoff.
- **Agents:** send Haiku 5.5 agents whenever you need the community Discord archive
  (`/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db`; FTS recipe in MEMORY.md §4). Otherwise avoid agents. If one
  is genuinely needed, use Opus 5.5 and paste the CLAUDE.md parallel-agent rule into its prompt verbatim.
- Keep a running `HANDOFF.md` in the vehicles docs folder: what's done, how it was verified, what's next.
- Commit or push only when the owner asks. The docs folders from the last session (carry-experiment,
  vehicles-2026-11-01) are uncommitted.

## Start

Check the current state first: `git status`, ACE alive (`ss -ulpn | grep :900`), serve.py on :8765, free memory.
Then begin M0.
