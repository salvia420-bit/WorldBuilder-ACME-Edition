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
- [ ] `combatMode()` — needs a decision: promote `motion_stance` vs track
  `ChangeCombatMode` acks (14 #3).
- [ ] `isPlayerReady()` (14 #4).
- [ ] Busy trio: `getBusyState` / `getUseDoneSeq` / `getCastBusyState` — design work,
  synthesize counters from UseDone (0x1C7)/cast-done wire events in the recv loop
  (14 #5, risk R1). Degrade-open per report 11 contract 0.1.
- [ ] `groundContainerId`, `objectWielderInfo`/`ownershipInfo` composites (14 #11/#15),
  appraisal-time stamps `hasAppraisalData`/`getLastIdTime` (14 #7).
- [ ] `moveToPosition(ns,ew,z,run)` SessionCommand — the nav keystone (report 09;
  `MoveToManager::move_to_position` exists at `holtburger-core/src/client/movement/move_to.rs:530`).

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
