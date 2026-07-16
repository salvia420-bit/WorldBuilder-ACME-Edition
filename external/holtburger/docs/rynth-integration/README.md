# RynthSuite → holtburger-web integration

Working tracker for porting RynthSuite's bot brain (RynthAi, ~51.5k C# lines) to drive
holtburger-web. The strategy, evidence, and phase plan come from a 16-agent research
workflow (2026-07-16); the reports are vendored under `workflow-reports/` —
**start with `16-synthesis.md`** (the roadmap), then 04 (tick adapter), 11 (combat
behavioral contract), 14 (SessionHandle backlog), 02 (seam mapping matrix).

Reference checkouts (laptop): `/mnt/wbterminal1/ac-refs/{rynthsuite,rynthcore}` @ v0.25.
The seam to reimplement: `rynthcore/src/RynthCore.PluginSdk/RynthCoreHost.cs` (~91
in-scope members after dropping UI-overlay).

## Architecture (synthesis §2)

In-page **WebHost** answers RynthAi's synchronous `TryGet*` polls from a **frozen
per-tick snapshot** composed as the tail phase of the net pump (one await-free block =
atomic by construction); actions go fire-and-forget through `SessionHandle`; the `Has*`
capability set is derived from what the WebHost actually serves. Brain language is the
open D1 fork (external C# / .NET-wasm in-page / JS rewrite) — resolved by the Phase-0
compile spike; everything below is fork-independent.

## Progress

### Phase 1 — SessionHandle read backlog (report 14) + stub host spine
- [x] **2026-07-16 — typed-property getter batch** (`apps/holtburger-web/src/lib.rs`,
  “rynth-integration Phase 1” section): `serverTime`, `playerGuid`, `objectWcid`,
  `objectName`, `objectPhysicsState`, `objectHealthFraction`, and the seven typed
  property reads `objectIntProperty` / `objectInt64Property` / `objectBoolProperty` /
  `objectFloatProperty` / `objectStringProperty` / `objectDataIdProperty` /
  `objectInstanceIdProperty` (raw stype → `from_repr`, parity with the native
  scripting host ops). This clears report 14 backlog items #1, #2, #6-partial, #8,
  #9-cached, #10 and unblocks the object-property crisis (report 02’s 4%-covered
  category).
- [x] **2026-07-16 — `combatMode()`** (retail 1/2/4/8 values): decision resolved better
  than 14 #3 anticipated — `WorldState::player_combat_mode()` already tracks
  `PropertyInt::CombatMode` pushes (holtburger-world `state/types.rs:209`, F11-6
  absent-at-login = NonCombat rule); the getter is a straight promotion.
- [x] **2026-07-16 — `isPlayerReady()`** (14 #4): WorldState exists + player GUID landed.
- [x] **2026-07-16 — Busy trio landed + live-verified** (14 #5, risk R1):
  `getUseDoneSeq()` (recv loop counts every `GameEvent::UseDone` 0x1C7, completed OR
  refused), `getBusyState()` (shadow counter: +1 on useObject/cast* send, −1 on
  UseDone, floor 0, 15 s self-heal = degrade-open per report 11 contract 0.1),
  `forceResetBusyCount()`, `getCastBusyState()` (poll-shaped shadow of the JS cast
  chain's `noteLocalCastWindow` signal, 12 s auto-expiry). Live smoke
  (`rynth_trio_smoke.cjs`): cast gate 0→1→0 PASS; refused-cast round-trip
  (castUntargetedSpell(1) → ACE ValidateSpell → SendUseDoneEvent) busy 0→1→0 with
  seq 0→1 PASS.
- **Harness lesson (report 06 confirmed live):** `?autoLogin=1` is single-shot — the
  Account-In-Use kick dance (first connect kicks the stale char ~7 s, second succeeds)
  defeats it. `rynth_boot_helper.cjs` wraps boot in reload-retry; all rynth smokes use
  it. Also: teleporting to dense Holtburg under dev-wasm + headless crashed the tab —
  keep smoke tests at spawn or use release wasm for town-scale tests.
- [ ] `groundContainerId`, `objectWielderInfo`/`ownershipInfo` composites (14 #11/#15),
  appraisal-time stamps `hasAppraisalData`/`getLastIdTime` (14 #7).
- [x] **2026-07-16 — `moveToPosition(landblockId, x, y, z, run)`** — the nav keystone
  (report 09) landed. Even cheaper than scouted: `MovementStruct::MoveToPosition`
  (retail type 7) and its `perform_movement` dispatch already existed
  (`movement_manager.rs:74/273`); the missing piece was pure intent plumbing —
  `PlayerDriveIntent::MoveToPosition` → `QueuedDriveCommand` → `PendingPursuitCommand`
  → drain arm building the type-7 struct, plus the `SessionCommand` variant, recv arm
  (PursueObject-style guards + pursuit-status latch), and the wasm export. Completion
  polls via `pursuitStatus()` (2=arrived, 3=failed). NOT yet live-smoke-tested.
  NOTE kept: `PlayerDriveIntent::ArriveAtPose` is a pose-SNAP (portal arrival), NOT
  steering — do not use it for walk-to.
- [x] **2026-07-16 — Live smoke test PASS** (`apps/holtburger-web/rynth_phase1_smoke.cjs`,
  run with `NODE_PATH=<playwright dir> node rynth_phase1_smoke.cjs` against local
  ACE + serve.py + wsbridge): headless `?nullRender=1&autoLogin=1` boot as tailnet1
  → every getter returned live truth (playerGuid 0x5000021E, serverTime ticking,
  combatMode 1, objectName(self)="+Tester2", physicsState nonzero) → `moveToPosition`
  (+12 m north, run) physically moved the character 11.95 m, pursuitStatus latched
  arrived(2). GETTERS: PASS · MOVETO: PASS.

### Movement-family coverage discovered 2026-07-16 (better than the reports implied)
Already shipped in the web runtime — RynthCoreHost members these cover:
- `PursueObject` cmd (retail MoveToObject 0x6 w/ cylinder stop) — approach loops.
- `StickToObject`/`StopStick` (retail StickyManager) — the whole of client melee
  approach+hold; report 11's combat loop should prefer this over manual pursuit.
- `PursuitTurnToObject` / `PursuitTurnToHeading` (rate-limited retail turns) —
  `TurnToHeading` parity. `CancelPursuit` — `StopCompletely` building block.
- `setAutoRun` — RynthCoreHost `SetAutoRun` parity, already a wasm export.
- `pursuitStatus()` poll — the MoveTo completion signal the tick snapshot needs.

### Phase 0 — spikes (synthesis §3)
- [ ] S0.1 walking skeleton: in-page snapshot composer + toy host, headless
  `?nullRender=1&netDrainHz=20` login → attack → react.
- [ ] S0.2 torn-read coherence check across the recv-loop drain.
- [ ] S0.3 .NET-wasm compile spike of an island-excised brain slice (D1 fork resolver).
- [ ] S0.4 Web-Worker heartbeat tick under a backgrounded tab.

### Phase 2+ — combat loop, buff/loot/nav, parity
See synthesis §3. The combat behavioral contract (report 11) is the spec; lift the
tuned constants verbatim.

## Traps (from the reports, verified)
- Gate bot boot on `__bootState` reaching `in-world` (`__bootStateHistory` in
  index.html) — `ready` is a render gate that may never fire headless (06/13).
- `?nullRender=1` does NOT escape background-tab rAF throttling — tick must ride a
  Web-Worker heartbeat (04 §5.4, 06).
- `url-flags.md` bot-flag line refs are stale and three defaults are wrong — generate
  harness params from code (06).
- Pose for the brain must come from wasm world state (AC Z-up, landblock-local);
  never feed three.js Y-up render coords into the seam (10).
