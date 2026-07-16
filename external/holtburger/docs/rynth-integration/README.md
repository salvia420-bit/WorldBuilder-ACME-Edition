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
- [x] **2026-07-16 — loot-loop reads landed** (14 #7/#15): `hasAppraisalData(guid)` +
  `getLastIdTime(guid)` (identify-apply stamps, epoch-ms `Date.now()` domain, SUCCESS
  site only — refused identifies don't count) and `groundContainerId()` (last
  ViewContents container; vendors excluded; pair with `get_container_contents`).
  Ownership/wielder composites (14 #11) are deliberately NOT dedicated getters —
  compose from `objectInstanceIdProperty(g, 2=Container / 3=Wielder)` +
  `objectIntProperty(g, 10=CurrentWieldedLocation)` in the WebHost shim.
  **The report-14 S-effort read backlog is now fully landed.**
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

### The seam artifact — RynthWebHost (landed 2026-07-16, live-verified)
`apps/holtburger-web/rynth/webhost.js` — the RynthCoreHost contract reimplemented
in-page: frozen per-tick snapshot (one await-free block appended per worker-heartbeat
tick — reports 04/05's design), `has()` capability plane probed from the live
SessionHandle (stale pkg degrades instead of throwing), per-decision object reads
passing through, actions fire-and-forget. ~45 RynthCoreHost-named members resolved.
Live smoke (`rynth_webhost_smoke.cjs`): 10 Hz snapshot ticking, all reads correct,
MoveToPosition driven purely through the seam → walked 7.97 m, pursuit latch 2. PASS.
Added `objectPosition(guid)` wasm getter (combat range math) en route.
Known gaps: `RequestId` capability unresolved (no assess/identify method probed yet);
no event queues yet (poll-only).
2026-07-16 later: `nearby` gap CLOSED — `nearbyEntityGuids(maxRange)` wasm enumerator
over `world.entities` (spawn-gate independent, `WorldPosition::distance_to` range
filter), wired into the snapshot with entityMap fallback.

### Combat walking skeleton — PASS (2026-07-16, later): **first seam-driven kill**
`rynth_combat_smoke.cjs`, repeatable 2/2: boot headless → `@create 7` (Drudge
Skulker) → acquire via `nearbyEntityGuids` through the seam → suggested-mode
toggle → Magic(8) completes → Flame Bolt I (spell 27, picked from
`playerKnownSpells`) → **"Drudge Skulker is reduced to cinders!"** hf 1→0, kill
confirmed via QueryHealth-fed `objectHealthFraction`. Load-bearing findings:
- **Release wasm cured the boot flake completely** (dev-wasm memory tax was the
  cause; boots now first-try). ALWAYS release-build before headless campaigns.
- **ACE silently reverts Melee mode if a bow/wand is wielded**
  (`Player_Combat.cs` `_Inner` Melee case: `missileWeapon != null || caster !=
  null` → `SetCombatMode(NonCombat); return;` — no error to the client, and
  `LastCombatMode` still reads Melee in the logs). Bots MUST use the
  equipment-derived suggested-mode toggle (`toggleCombatMode`) or unequip
  first. This is report 11's stance-rules contract, live-confirmed.
- `objectHealthFraction` is fed by `QueryHealth` responses — poll it (RynthCore
  `QueryHealth` semantics); never-queried targets read −1.
- StickToObject held 0.93 m melee range headless the whole fight; the drudge's
  own attacks ("You evaded" ×15) prove full bidirectional combat.
- Melee-mode kill path still untested (needs an unwielded char) — queued.

### (resolved) Combat walking skeleton — BLOCKED on headless boot flake (2026-07-16)
`rynth_combat_smoke.cjs` (spawn Drudge Skulker wcid 7 via `@create 7`, acquire via
seam, StickToObject + MeleeAttack cadence, `@smite all` cleanup) is written but boot
became unstable after ~6 rapid login cycles: mixed `Target crashed` (renderer) and
`__sessionHandle` attach >30–90 s. VERIFIED server-side: ACE login succeeds
(char enters world); it's the page that stalls/crashes. NOT /dev/shm (1%), NOT
system OOM (3.6 G free), NOT load (1.0), NO stray chromium after cleanup. Prime
suspects for next session: (a) the 18 MB dev wasm ×2 instances (main + bake worker)
per boot with nosw = full refetch — build `--release` (4.5 MB) before headless runs;
(b) rapid relogin churn interacting with the ACE reap window — pace boots ≥90 s
apart; (c) run one browser, one boot, keep the session alive across test phases
instead of boot-per-smoke. Boot helper hardened en route: fresh page per attempt,
attempt counts as booted only when `__sessionHandle` attaches (90 s), browser-scoped.

### Phase 0 — spikes (synthesis §3)
- [ ] S0.1 walking skeleton: in-page snapshot composer + toy host, headless
  `?nullRender=1&netDrainHz=20` login → attack → react.
- [ ] S0.2 torn-read coherence check across the recv-loop drain.
- [ ] S0.3 .NET-wasm compile spike of an island-excised brain slice (D1 fork resolver).
- [ ] S0.4 Web-Worker heartbeat tick under a backgrounded tab.

### Phase 2 — combat loop: FIRST AUTONOMOUS BRAIN RUNNING (2026-07-16)
`rynth/combat_loop.js` — report 11's contract subset on the WebHost tick, constants
lifted verbatim: T9 lock+stickiness(25), T10 scan-grace(1500ms), T2 filter order
(player → recently-killed(30s TTL) → ItemType Creature → **ObjectIsAttackable** →
dead → distance), P2/P5/E4 cast serializer (mark-on-issue vs UseDoneSeq + 2500ms
self-clear), equipment-derived mode, mode-adaptive attacks (war bolt / melee /
missile). Live smoke (`rynth_loop_smoke.cjs`): spawn 2 drudges → **2 autonomous
kills in <10s**, lock→kill→re-acquire→kill, zero external driving. PASS.
- New wasm getter `objectDescFlags(guid)` (ObjectDescriptionFlag bits) backs the
  seam's `ObjectIsAttackable`/`ObjectIsPlayer` — added after the loop live-locked
  onto **Alcott the vendor** (NPCs are ItemType Creature; report 11 T2's
  `!ObjectIsAttackable` class is load-bearing, now proven).
- **T8 + P12 landed 2026-07-16** (`rynth_p12_smoke.cjs`): T8 monster priorities —
  name-substring rules bias scoring by `(priority-1)*5` (Olthoi@20→95, Rat@5→20,
  unlisted→0, all exact). P12 kill-anticipation — the combat loop subscribes to
  the push-event plane and learns per-hit damage from BOTH sources (melee/missile
  `damageDealt` severity=damage/MaxHP directly; magic damage parsed from the
  combat-chat "for N points with SPELL" line, with MaxHP learned from the polled
  health-fraction delta — web relaxes report 11's "no unselected-mob HP"
  constraint via QueryHealth). Predicts a kill when learned remHP ≤ avgDmg×0.80
  after ≥3 samples. Verified: MaxHP=100 learned from 3 severity-0.1/dmg-10 hits,
  prediction fires at hf=0.05. Live run confirmed real kind-19 combat events flow
  through the tap (33 in one fight).
- Remaining Phase-2 items: P3 face-settle for magic at range, vital/mana policy
  (B15/B16), missile ammo handling, melee-mode kill path (needs unwielded char).

### Phase 3 — buff loop: PASS (2026-07-16)
`rynth/buff_loop.js` — report 11 B-rules subset, constants verbatim: B1 login
stabilization (registry count stable on two 1 s reads / 20 s cap), B2 family-keyed
expiry truth, B3 rebuff threshold 300 s, B6 permanent sentinel, B8 registry-re-read
confirmation (600 ms / 2500 ms give-up), B9 silent-no-show valve (2 → 30 min park),
B13 30 s periodic re-sync, B14 400 ms pacing + cast/busy gates. Omitted (documented):
B4/B5 tier ladders, B7 item enchants, B10-B12 batch semantics, B15/B16 vital policy.
Live smoke (`rynth_buff_smoke.cjs`): Strength Self I + Armor Self I cast, confirmed,
then recognized-active across a fresh login (maintain path). Two traps fixed en route:
- **Casting requires Magic combat mode for UNTARGETED casts too** (ACE
  `Player_Magic.cs:279` mismatch gate) — the loop equipment-derived-toggles before
  casting (B14's `BotAction="Buffing"` stance pin is this rule's native shadow).
- **Enchantment start_time/duration are Derethian-epoch seconds** — remaining time
  must use the buffs-hud "bug A1" formula (ACE `Enchantment.cs:100-104`:
  `receivedAt + duration − startTime` with self-stamped wall-clock receipt). Naive
  serverTime diffs mark every buff expired.

### Phase 3 — loot loop: PASS (2026-07-16)
`rynth/loot_loop.js` — report 03 Tier-4 flow: find corpse (wcid 21) →
MoveToPosition into reach → UseObject → groundContainerId/getContainerContents →
Value(19) rule → moveItem(item, player, 0) (MoveItemExternal parity, 0x0019) →
confirm via playerInventory. Live smoke (`rynth_loot_smoke.cjs`): combat loop
killed a drudge, loot loop opened the corpse (3 items) and confirmed a pickup,
inventory 16→17. Full kill-to-loot pipeline autonomous. Trap: wasm Vec<u32>
arrives as Uint32Array — Array.from before mutating (typed-array .map has no
.shift).

### THE GRIND BOT — BotKernel PASS (2026-07-16)
`rynth/kernel.js` — report 12's BotKernel concept, JS edition: one kernel tick
runs ONE loop's tick (gates never contended — B14's BotAction pin,
kernel-shaped), priority ladder Combat > Loot > Buff > Idle with
mid-transaction ownership pinning and combat preemption. Live smoke
(`rynth_kernel_smoke.cjs`): spawn 2 drudges → 2 autonomous kills →
Combat→Loot transition → both corpses worked (one approach timeout parked
correctly, recovered on the second) → **3 items looted** → Idle with buffs
2/2 active. ~25 s, fully unattended. This is the synthesis Phase-2/3 core
delivered: an autonomous grind bot on holtburger-web through the
RynthCoreHost seam.
- ~~Known rough edge: corpse APPROACH timeout after stick-release~~ FIXED
  2026-07-16: progress watchdog in the loot APPROACH state re-issues
  MoveToPosition when distance stops closing (3 s), instead of waiting out
  the full timeout.
- **Fellowship DTO landed + live-verified** (report 07 complete): the 272-line
  memory-reading FellowshipTracker is a ~30-line `TryGetFellowship()` adapter
  over `playerFellowship()` — create→snapshot(name/leader/members with live
  per-member vitals)→quit proven in the kernel smoke. Fellowship ACTIONS
  (create/quit/recruit) also probed into the capability plane.

### Next arcs — nav router, contract completions, the D1 fork
1. RynthNav router sidecar (09) for long-range routing over moveToPosition legs.
2. Contract completions: T8 priorities, P3/P12, B4/B5/B7/B10-12, B15/B16 vital
   policy, event queues (push plane), melee-mode kill path, fellowship DTO (07).
3. ~~D1 fork spike~~ **RESOLVED 2026-07-16 (netwasm-spike/): .NET-wasm
   compiles AND executes** a RynthAi-shaped scoring slice via [JSExport],
   ~4.1MB runtime, exact contract values in Node. Path A′ (C# brain in-page)
   is viable — see netwasm-spike/README.md. Recommendation: JS brain ships
   now (working today); pursue A′ incrementally for the ~13k pure-tier C#
   lines behind the same RynthWebHost seam, largest-value-first.
4. ~~Multi-account harness (06)~~ **LANDED 2026-07-16** — `rynth/supervisor.cjs`:
   one Chrome page per account, each running the RynthWebHost+BotKernel grind
   bot; the supervisor owns login-retry (Account-In-Use kick dance),
   health monitoring (snapshot-freshness + session liveness), and auto-relogin.
   Live smoke (`rynth_supervisor_smoke.cjs`): boot → forced stall → detected
   (snapAge>8s) → rebuilt → recovered into Buffing. serve.py needs zero
   changes. N accounts is `runFleet([...configs])`; verified with 1 (only
   tailnet1 has a spell-capable char provisioned).

### Milestone (2026-07-16): the synthesis is substantially delivered
An autonomous multi-account grind-bot fleet runs on holtburger-web entirely
through the reimplemented RynthCoreHost seam. Phases 1–3 of the roadmap are
green (login → world model → combat → buff → loot → parity-subset), the D1
language fork is resolved (both JS-now and .NET-wasm-A′ proven), and the
supervisor gives the fleet its lifecycle. Remaining work is depth, not
feasibility: contract completions (T8/P12/B4-B12/B15-B16), the RynthNav
router sidecar for long-range routing, the push-event plane, and the
incremental .NET-wasm lift of the pure-tier C#.

## Traps (from the reports, verified)
- Gate bot boot on `__bootState` reaching `in-world` (`__bootStateHistory` in
  index.html) — `ready` is a render gate that may never fire headless (06/13).
- `?nullRender=1` does NOT escape background-tab rAF throttling — tick must ride a
  Web-Worker heartbeat (04 §5.4, 06).
- `url-flags.md` bot-flag line refs are stale and three defaults are wrong — generate
  harness params from code (06).
- Pose for the brain must come from wasm world state (AC Z-up, landblock-local);
  never feed three.js Y-up render coords into the seam (10).
