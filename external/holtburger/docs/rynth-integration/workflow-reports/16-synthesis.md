# 16 — INTEGRATION_ROADMAP: RynthSuite (RynthAi) → holtburger-web

*Synthesis of reports 01–15. All 15 present and non-empty; none truncated. Where reports disagree, the contradiction is flagged inline — this document does not paper over them.*

---

## 1. Executive verdict

**Reimplement the one `RynthCoreHost` contract as an in-page "WebHost" that answers every synchronous `TryGet*` from a single per-tick *frozen snapshot*, run the brain in-page on a tick adapter piggybacked on holtburger's net pump, and drive actions fire-and-forget through `SessionHandle`. This dissolves the poll-vs-async inversion — the workflow's designated deepest risk — by construction.** The web target is fixed by user decision; this is not relitigated. Native/deno (Option D of report 15) is off the table and mentioned only to price the decision.

The strategy rests on three convergent findings the fleet verified independently:

- **The seam is small and the brain already tolerates a partial host.** The entire client-access surface is ~91 in-scope `RynthCoreHost` members (01: 113 rows − 16 render/UI DROP − ~6 low-value; 02 agrees: 91 in-scope). RynthAi guards that surface with **344–367 `Has*` call sites** that fail *closed* (03 measured 367 real guards; 15 measured ~355; 01 counts 103–104 caps defined) plus host actions that **self-no-op when their fn pointer is null** (03: `RynthCoreHost.cs:197,207–223`). A host that implements a subset "compiles-and-runs" — the brain degrades, it does not crash.

- **The poll-vs-async inversion has a clean resolution, and two reports independently arrived at the same mechanism.** 05 ("snapshot-cache on the C# side, push from the page") and 04 ("one await-free synchronous `HostSnapshot` block appended to the net pump") describe the *same* idea from different ends: compose **one batched snapshot per tick**, freeze it, and answer all ~16 hot per-tick polls plus the per-decision reads from that frozen object — the polls **never touch the wire or a live `RefCell`**. Because JS is non-preemptive, an await-free block is atomic by construction, reproducing RynthCore's "fresh-for-the-whole-tick" guarantee (04 §2.3, §4.2; 05 §4.2).

- **The "unportable islands" are far smaller than the established ~508 lines.** 08 revises the genuinely-blocking count to **~305 lines (~111 irreducible)**; 07 shows `FellowshipTracker`'s 272 lines collapse to a **~1-day adapter** because holtburger already reimplemented the entire fellowship stack from protocol truth; 09 shows RynthNav's ~430-line steering servo is **dropped**, not ported (the web `MoveToManager` supersedes it); 13 shows holtburger **closes essentially the entire Chorizite hook/asset gap list** by construction (it *is* the client, so hook-fragility evaporates); 10 shows the raycasting LOS engine is already host-independent. The migration is overwhelmingly *wiring onto existing holtburger surfaces*, not rebuilding them.

### The one load-bearing caveat: the brain-language fork is unresolved, and the fleet split on it.

This is the single genuine contradiction in the workflow, and the maintainer must resolve it in Phase 0:

| Report | Position |
|---|---|
| **05** | Designed the transport for an **external C# brain** — keep all ~41k debugged C# lines, reimplement `RynthCoreHost` over a WS snapshot-cache side-channel (= 15's *Option A*). |
| **15** (scorecard specialist) | Recommends **rewrite in-page in JS/TS** lifting the tuned constants as spec (*Option B* now), migrate hot loops to Rust-in-wasm (*Option C*) later; treats A as **throwaway spike**, not a destination. Scores are near-tied: A 18 / B 19 / C 18. |
| **04** | Its tick adapter is **brain-agnostic** — explicitly serves "whether the brain runs as .NET-wasm in-page or as an external driver." |

**My decisive resolution — a fourth path the fan-out under-weighted.** 15 scored "A = *external* C#" but never scored **".NET-wasm, in-page"** — compile the island-excised brain to wasm and run it inside the tab, reimplementing `RynthCoreHost` against 04's in-page frozen snapshot. This path *dominates* A (no CDP/WS side-channel, no cross-process latency, runs on the same event loop as the snapshot) and dominates B on preserved investment (keeps ~41k lines that report 11 shows encode dozens of specific, individually-debugged in-game failures). It is cheap to attempt because 08 proves excision is ~111 irreducible lines and 07/09/13 show the islands mostly evaporate. **Recommendation: Phase 0 spikes the `.NET-to-wasm` compile of a trivial island-excised slice. If it holds → preserve the C# brain in-page (the RynthCoreHost mapping of 01/02/03/05/14 becomes the literal build target). If threads/NativeAOT/`unsafe` block it → fall to 15's B-now/C-later.** Either way the *first* work is option-independent (below), so the fork does not stall the project.

**Option-independent first move (do this before the fork resolves):** build the two assets that every option needs — (1) the **WebHost contract** as a written spec of the ~91 members and their snapshot sources (01/02/03), and (2) the **SessionHandle backlog** (14's ranked getters), because whether the brain is C# or JS it reads the *same* missing state. The tuned-constant/behavioral spec (11) transfers verbatim regardless of language.

---

## 2. The architecture — one diagram + one page

```
┌───────────────────────────── BROWSER TAB (one per bot; ?nullRender=1&netDrainHz=N) ─────────────────────────────┐
│                                                                                                                 │
│   ┌──────────────────────────┐        reimplemented RynthCoreHost seam  (01 / 02 / 03)                          │
│   │   RynthAi BRAIN           │        ┌──────────────────────────────────────────────┐                        │
│   │   ~41k C#→.NET-wasm  OR    │◄──────┤  WebHost:  ~91 TryGet* / action shims           │                       │
│   │   JS/TS rewrite (15 B)     │       │   • TryGet*  →  read FROZEN snapshot   (0-wire)  │                      │
│   │   Combat/Buff/Nav/Loot     │──────►│   • actions  →  SessionHandle cmd (fire-&-forget)│                     │
│   │   OnTick / OnCreateObject  │       │   • Has*     ←  capability set (degrade-OPEN)     │                    │
│   └───────────┬──────────────┘        └────────────▲───────────────────┬───────────────┘                       │
│    synth OnBusyCount / OnUseDone /                  │ compose 1 snapshot │  drain queues (create/update/delete,  │
│    OnEnchantment* / OnUpdateHealth …               │  per tick, FROZEN  │  causal order, drop-oldest) 04§4.3    │
│   ┌───────────▼───────────────────── TICK ADAPTER (04) — where the tick LIVES ─────────┴───────────┐            │
│   │  appended as the tail phase of pumpNetFrame  ·  ONE await-free synchronous block                │  ◄── Web- │
│   │  order:  poll_events → pollEntityUpdates → tickMovement → [FREEZE snapshot + drain into          │    Worker │
│   │          RynthCore-shaped per-type queues] → brain.OnTick()                                      │   heart-  │
│   │  reentrancy-guarded (mirror _pluginPumpInFrame); try/catch (never orphan the net pump)           │    beat   │
│   └───────────┬───────────────────────────────────────────┬────────────────────────────────────────┘ (04§5.4) │
│    getters:   │ pose/vitals/combatMode/enchants/inventory  │ poll_events / poll_entity_updates (std::mem::take) │
│   ┌───────────▼───────────────────────────────────────────▼─────────────────────────────────────────┐         │
│   │  wasm SessionHandle (~210 methods) + 14's NEW getters:                                            │         │
│   │    server_time · player_guid · combat_mode · is_player_ready · busy/use_done/cast_busy (the trio) │         │
│   │    typed object_{int,bool,quad,...}_property · target_vitals(cached) · moveToPosition (keystone)  │         │
│   │  recv_loop (spawn_local): decode → mutate Rc<RefCell> → push queued_events / entity_updates       │         │
│   └───────────────────────────────────────┬──────────────────────────────────────────────────────────┘        │
│   JS read-plane:  window.entityMap · __diag · __sessionHandle · __bootState  (gate actions on 'in-world', 06/13)│
└──────────────────────────────────────────┼────────────────────────────────────────────────────────────────────┘
                                            │ WebSocket (browsers cannot UDP — every web session rides this)
                            ┌───────────────▼──────────────┐          ┌──────────── OFFLINE (build box) ──────────┐
                            │  holtburger-wsbridge          │          │  RynthNav.Baker → .tile                    │
                            │  WS↔UDP, opaque AC packets    │          │  RynthNav.PortalGraph → portals.tsv (817)  │
                            │  per-conn UdpSocket (scales   │◄────────►│      ↓                                     │
                            │  per connection, bridge.rs)   │  route() │  ROUTER SIDECAR (09): Detour query +       │
                            └───────────────┬──────────────┘  legs[]   │  PortalRoute Dijkstra  (reuse C# verbatim) │
                                            │ UDP (AC protocol)         └────────────────────────────────────────────┘
                            ┌───────────────▼──────────────┐
                            │   ACE server (game world)     │
                            └───────────────────────────────┘
```

**Reading the diagram (the seven pieces the task asked for):**

- **Bot brain** — RynthAi's ~41k portable lines (13.5k pure-algorithm + ~27.5k host-coupled, per 15). Runs in-page as either compiled `.NET-wasm` (preferred if the Phase-0 compile spike holds) or a JS/TS rewrite (15's B). Its combat/buff behavior is the fully-specified contract in report 11.
- **The seam** — a reimplemented `RynthCoreHost`: ~91 in-scope members (01), of which only 34 are clean 1:1, 43 need adapter glue, 16 are MISSING and require new wasm state (02). The `Has*` capability set is derived from what the WebHost can actually serve, so unimplemented members fail closed.
- **Transport** — for an **in-page** brain there is **no wire between brain and seam**; both live in the tab and the snapshot is a frozen JS/wasm object. For the **external-C# spike (Option A)** the seam moves to a C# process and the snapshot is *pushed* over a dedicated WS side-channel (05); actions ride back as WS messages. Either way the game traffic itself always rides `holtburger-wsbridge` (WS↔UDP; browsers can't do UDP).
- **In-page shim** — the tick adapter + WebHost + snapshot composer (04 §4). It appends to `pumpNetFrame` so it runs in the same callstack as `poll_events`/`pollEntityUpdates`/`tickMovement`, inheriting all three existing pump drivers and the net-drain watchdog for free.
- **wasm SessionHandle** — holtburger's ~210-method poll/command API (02), extended with 14's backlog. Reads are `RefCell` snapshots; actions are `cmd_tx.unbounded_send` — already fire-and-forget, a **convergence** with RynthCoreHost's contract, not a mismatch (04 §2.3).
- **wsbridge** — stateless opaque AC-packet pipe; the *wrong* layer to broker bot state (it sits server-side of the wasm decode, sees only encrypted UDP — 05 §3 rejects piggybacking it). Scales cleanly per-connection.
- **ACE server** — unchanged.
- **Where the tick adapter lives (the crux answer):** **in-page, as the tail phase of the existing net pump, driven foreground by rAF/`netDrainHz` and background by a dedicated Web-Worker heartbeat.** Not a standalone timer (races the recv-loop), not an external CDP poll (too coarse — 04/05 both reject k1-style CDP as 2–3 orders too slow). A separate router **sidecar** beside wsbridge hosts the Detour navmesh query (09), because DotRecast has no wasm target today.

---

## 3. Phased plan with milestones

Legend for host functions: names are `RynthCoreHost` members (01/02); SessionHandle additions are numbered from 14's backlog.

### Phase 0 — Spike (what proves/kills the approach fastest)

**Goal:** falsify the three load-bearing unknowns before committing to a build: (a) does the frozen-snapshot poll model read coherent state across the async net drain, (b) can the seam be served end-to-end with a *real* brain, (c) **does the island-excised C# brain compile to and run in wasm** (the fork-resolver).

| Spike | Method | Source |
|---|---|---|
| **S0.1 Transport + snapshot cache** | 05's 3-day walking skeleton: WS bridge or in-page shim; compose `SNAP{seq, player:getLocalPlayerPose()}` each tick; a 30-line toy C# host reads `TryGetPlayerPose`/`GetBusyState` from the frozen snapshot and fires `MeleeAttack` on a hostile in `nearby[]`; drudge takes damage; toy brain reacts to `kind=54 EntityHealth`. Run headless under `?nullRender=1&netDrainHz=20`. | 05 §7 |
| **S0.2 Poll-vs-async coherence** | Instrument a fixed-Hz tick reading pose/entities/vitals; check for **torn reads** across the recv-loop drain; confirm the await-free block is atomic. Go/no-go on the poll model; if torn, define the barrier. | 04 §2.3/§5.1, 15 M3 |
| **S0.3 `.NET-wasm` compile spike (fork resolver)** | `dotnet publish` a trivial island-excised brain slice (one scoring fn) to wasm; measure threads/NativeAOT/`unsafe` viability and rebuild time. | 15, 08, 04 |
| **S0.4 Tab-throttle survival** | Drive the tick from a cloned `keepalive_worker.js` heartbeat; confirm a **backgrounded** tab keeps draining (nullRender does **not** escape rAF throttling — 04 §5.4, 06 risk 3). | 04 §5.4, 06 |

**Exit criteria:** a toy brain, headless, drives the web client through login→attack→react-to-death; snapshot `snapAgeMs < 100` at ≥20 Hz; no torn reads (or a defined barrier); a documented go/no-go on `.NET-wasm`. **This gate resolves the brain-language fork and sets the concurrent-bot ceiling.**

### Phase 1 — Stub host + walking skeleton (login + snapshot + one attack)

The 4-item spine + melee tier (03 Tier 0 + Tier 1). Every loop lights up on top of this.

**Host functions to implement** (03 §c ordering):
- Events (no `Has*` — must be pushed): `OnTick`, `OnCreateObject`, `OnDeleteObject`, `OnLoginComplete`.
- Poll reads: `GetPlayerId`, `TryGetObjectPosition`, `TryGetObjectName`, `TryGetObjectWcid`.
- Actions/events for the swing: `MeleeAttack` (never `Has`-guarded — do NOT skip, 03), `ChangeCombatMode(Melee)`, `ObjectIsAttackable` (safety veto), `OnUpdateHealth`, `GetBusyState`, `OnKillNotification`.

**SessionHandle additions to holtburger-web** (14, all S-effort getters over existing fields):
- #2 `player_guid()`, #3 `combat_mode()` (or promote `motion_stance()`), #4 `is_player_ready()`, #10 `object_name(guid)`/`object_wcid(guid)`, #8 `object_physics_state(guid)`, #9 `target_vitals(guid)` (return cached `health_fraction`).
- Map events: `pollEntityUpdates` kind 1/2 → `OnCreateObject`/`OnDeleteObject`; `poll_events` kind 1/4 → `OnLoginComplete`/logout (04 §4.3).

**Exit criteria:** headless bot logs in via `?autoLogin=1&autoSpawn=first&nullRender=1` (06 boot recipe), builds a world model that matches `entityMap` (parity provable), `@telepoi`-teleports onto a mob, swings, mob dies, target is dropped. Gate all reads on `__bootStateHistory` containing `in-world` (06/13 — not `ready`, which is a render gate that can fire early or never headless).

### Phase 2 — Combat loop (the full debugged behavior)

Implement report 11's combat contract verbatim, lifting every tuned constant. This is where the poll-vs-async inversion is truly paid down: the **three pacing gates**.

**Host functions:**
- The three gates (11 §0, 14 #5): `GetCastBusyState`/`CanCastNow` (local cast-gesture gate), `GetUseDoneSeq` (server action-done seq, v63+), and event-fed `BusyCount` via **synthesized** `OnBusyCountIncremented/Decremented` (04 §5.3 — increment a shadow counter when a busy-bearing action is sent, decrement on the matching confirmation event/timeout; provide a `ForceResetBusyCount` shim).
- Attack surface: `MissileAttack`, `CastSpell` (explicit-target), `CancelAttack`, `QueryHealth`, `TryGetTargetVitals`, `GetCurrentCombatMode`, `SetSelectedObjectId`.

**SessionHandle additions** (14):
- #5 `get_busy_state()` + `get_use_done_seq()` + `get_cast_busy_state()` — **the one M-effort cluster that is design work, not a getter** (synthesize counters from `UseDone (0x1C7)`/cast-done wire events; `_castBusyUntilMs` at `entities.js:7230` is only a JS heuristic, not authoritative). Degrade-**open** when unwired (11 Contract 0.1).
- #9 synchronous `target_vitals(guid)` promoted from the async `query_health` path.

**Behavior (all from 11, lift constants exactly):** target selection T1–T16 (utility-AI score, `TARGET_SWITCH_STICKINESS=25`, `TARGET_SCAN_GRACE_MS=1500`, `(Priority−1)×5` term, recently-killed dual TTLs); attack pacing P1–P13 (magic settle-before-cast `FACE_SETTLE_MS=140`, cadence guard on `UseDoneSeq`/2500ms, kill-shot prediction `KILL_CONFIDENCE=0.80`/`KILL_MIN_SAMPLES=3`); stance S1–S7 (live mode read, `WeaponSwapGate` 3000ms serializer, stance-flip exponential backoff — prevents the "256 ChangeCombatMode → client death" class); watchdogs E1–E8. **Adopt the selection-free explicit-target shape from day one and drop native attack entirely** (11 X1/P11, 03 §c: web has no client auto-face and no shared-selection constraint).

**Exit criteria:** a full combat loop — acquire → score → face-and-settle → cast/swing → predict-kill swap → clean disengage — running headless with the three gates preventing "too busy" spam and mid-windup cast orphaning.

### Phase 3 — Buff / loot / nav

Three independent loops, each a small addition on the Phase-1 spine.

**Buff** (03 Tier 2 + 11 §3): `CastSpell(self)`, `UseObject` (wand), `OnEnchantmentAdded/Removed`, `ReadPlayerEnchantments`, `GetServerTime`. SessionHandle: **#1 `server_time()`** (S-effort — `WorldState.server_time` + `current_server_time()` exist, just needs a getter; **highest-value single getter** because all timer math references it). Behavior: login-stabilization gate B1, expiry-from-registry B2, tier-cap flap guards B4/B5, item-enchant chat-confirmation B7, batch-rebuff B11–B12, vital thresholds B15–B16.

**Loot** (03 Tier 4): `GetGroundContainerId` (hard-return without it), `GetObjectOwnershipInfo`/`GetContainerContents`, `SelectItem`, `MoveItemExternal` (or `UseObject` fallback), `RequestId`+`HasAppraisalData`, `TryGetItemType`, `TryGetObjectIntProperty`. SessionHandle: **#6 typed `object_{int,bool,quad,double,string,dataid}_property(guid,stype)`** (M — the object-property crisis; today only a JSON appraisal blob), **#7 `has_appraisal_data` + `get_last_id_time`** (M — no ID timestamp tracked anywhere; stamp on identify apply), #15 `ground_container_id`, #11 `object_wielder_info/ownership_info`.

**Nav** (09 + 03 Tier 3): **`moveToPosition(ns,ew,z,run)` keystone export** (S–M — `MoveToManager::move_to_position` already exists and is unit-tested at `move_to.rs:530`; just needs a `SessionCommand`/`PlayerDriveIntent::MoveToPosition` arm). Reuse existing `pursuitStatus`/`getLocalPlayerPose`/`getCurrentCellId`. Router runs as a **sidecar** beside wsbridge (reuse C# Detour + `PortalRoute.cs` Dijkstra verbatim); JS orchestration loop walks legs, detects portals via landblock change. RynthNav's ~430-line servo is dropped. Also `SetAutoRun`, `TurnToHeading`, `GetPlayerHeading`, `StopCompletely`, #13 `is_portaling()`.

**Fellowship** (07): add `TryGetFellowship` DTO to the host over the already-complete `player_fellowship()` — **~1 day, adapter only, zero new Rust**.

**Exit criteria:** self-buff maintenance survives login/death/dispel; corpse loot with name/class rules (appraisal optional); point-to-point navigation with portal traversal; follow-a-fellow works (leader id now from protocol, not memory).

### Phase 4 — Parity

Everything beyond the four loops. Bring up as user need dictates.

- **ExpressionEngine / MetaManager** (VTank-style meta scripting, 101 of 367 guard sites, 3,738-line ExpressionEngine) — the user-scripting layer; deferred deliberately by 03 as out-of-scope for the four loops. Gate on whether VTank meta routes are actually required.
- **Game-clock shim** (08 #5): replace `Marshal.ReadInt64(0x008379A8)` with `GetServerTime` — 6 lines; the 9 `getgame*` calendar verbs stay portable.
- **Raycasting LOS** (10): keep the C# module as-is *if* the brain stays C# and has DAT access; else port the ~654-LOC ray engine to Rust or run without arc-LOS initially.
- **God-class decomposition** (12): extract `BotKernel` (config/blackboard + `BuildSession` + `Tick` + `Dispatch` + lifecycle) from the 8,312-line `RynthAiPlugin`; promote `CorpseOpenController`/`DoorInteractionController` from partials to standalone classes; lift `LegacyUiSettings` out of the ImGui renderer (the single highest-leverage cut — unblocks all 13 unmodified subsystem lifts).
- **Multi-account harness** (06): supervisor owns one Chrome page per account; `serve.py` needs zero changes (stateless); ceiling is browser-side (tab throttling) and ACE's per-account session model, not the HTTP server.

**Exit criteria:** feature parity with native RynthAi minus the deleted ImGui/retail-HUD tier; meta routes run; multi-bot fleet holds net drain while backgrounded.

---

## 4. Risk register (top 10 by expected damage)

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| **1** | **Poll-vs-async inversion — the three gates (`BusyCount`/`CastBusy`/`UseDoneSeq`) have no web analog.** RynthAi paces every cast/use/move on synchronous counters a host-pumped tick reads; holtburger surfaces these only as events on an async drain. Get it wrong → "too busy" spam, orphaned casts (0 damage forever), or a frozen bot. | 04 §5.3, 05 §4, **11 §0**, 14 #5 | **Frozen per-tick snapshot** (04/05) + **synthesized shadow counters** from `UseDone (0x1C7)`/cast-done wire events, incremented on send, decremented on confirmation/timeout. **Degrade-open** (11 Contract 0.1) — absent capability ⇒ fall back to interval/timeout, never block. Ship first with the gate `Has*=false`. |
| **2** | **Brain-language fork unresolved → wasted work.** 05 built the transport for external C#; 15 recommends against A as a destination and for in-page rewrite. Picking wrong burns weeks. | 05 vs **15**; 04 (agnostic) | Phase-0 **`.NET-wasm` compile spike (S0.3)** resolves it. Build **option-independent assets first**: the WebHost contract spec (01/02/03) + 14's SessionHandle backlog + 11's constant spec all transfer regardless of language. |
| **3** | **Tab throttling stalls background bots — and `?nullRender=1` does NOT escape it.** Its tick branch still re-arms via rAF, which Chrome clamps/pauses when hidden; `netDrainHz`/watchdog `setInterval` clamp to ~1s in background. | **04 §5.4**, 06 risk 3, 15 | Drive the adapter tick primarily from a **Web-Worker heartbeat** (worker `postMessage` is an event-loop task, not a throttled timer — the trick holtburger already uses for keepalive). Add `?netWorker=1` so the socket+`Session` survive a saturated main thread. |
| **4** | **Object-property crisis — no generic `stype→value` getter; target vitals are async.** `EntityUpdate` carries no health; only ~13 typed accessors + an opaque `getObjectAppraisal` JSON blob exist. Blocks most object introspection and every heal/kill decision. 02 rates this category **4% clean**. | **02** (Object-queries category), 14 #6/#9 | Add **typed per-object property getters** (14 #6, M) + **cached synchronous `target_vitals`** (14 #9, S). Until then RynthAi's `Has*` sites no-op these — the brain runs "blind to introspection" but does not crash. |
| **5** | **`.NET-wasm` may not compile** (background pump **thread**, NativeAOT win-x86, `unsafe`/`Marshal`, `Environment.TickCount64`). If it fails, the "preserve 41k lines in-page" path dies. | 15 (csproj targets `net10.0-windows`/`win-x86`), 04 §1.1 (dedicated thread) | Spike **early and cheap** (S0.3). Excision is only ~111 irreducible lines (08). If blocked → fall to 15's B (JS rewrite) — the constant/behavior spec (11) makes the rewrite far cheaper than the raw line count. |
| **6** | **DAT/geometry access for LOS and nav is unsolved in-page.** 10's raycasting "keep it C#, reads DATs off disk" assumes an external process with local DATs — false for a pure in-page brain (browser sandbox). DotRecast has no wasm target. | 10 R2, **09** (sidecar rationale) | Router runs as a **sidecar** (09 Option A) reusing C# Detour verbatim. For LOS: keep C# raycasting only if the brain is external/has DATs; else use holtburger's DAT provider (`terrainHeightAt` already exported, Z-up) or defer arc-LOS to Phase 4. |
| **7** | **60 Hz `netDrainHz` cap may be too coarse for combat timing.** Max ~16.6 ms observation granularity; unmeasured whether the brain's pacing needs tighter. | 06 risk 2 | Measure in Phase-0 S0.2. **Likely fine** because the gates are server-event-driven (UseDone messages), not frame-driven — the snapshot latches them, cadence stretches only non-safety-critical count-based throttles (04 §5.5). |
| **8** | **Selection model mismatch — no select-by-guid, no previous-selection.** Web selection is a HUD/frustum concept (`cycleTarget`); host expects an explicit guid-addressable register with memory. | 02 (5 hardest #4), 14 #14 | Adopt the **explicit-target attack/cast shape** (drop native attack, 11 X1) — sidesteps the register entirely for combat. Synthesize a headless selection register in wasm for the few loot paths that need it (14 #14, S). |
| **9** | **Documentation/citation drift.** Every bot-flag line ref in `url-flags.md` is stale; **three defaults are wrong** (`connectTimeoutMs`, `spawnTimeoutMs`, `maxRetries`); k1's own header comment about the 2D renderer is stale. A harness generated *from the docs* emits wrong timeouts. | **06** (flag-verification table) | Regenerate harness params **from code, not docs**; there is already an `L3` lint (`lint-harness-params.mjs`). Trust 06's verified line refs over `url-flags.md`. |
| **10** | **Coordinate-frame corruption.** Brain expects pose as **AC Z-up, landblock-local (0–192 m)**; feeding it three.js `acToThree` Y-up world coords corrupts every ray and distance. | 10 R5, 09 §3b | Read pose from **wasm world state** (natively Z-up — 10 confirms both collision stacks agree on Z-up; Y-up exists only in the render layer). Never route render-frame coords into the seam. `getLocalPlayerPose` is already landblock-local Z-up. |

*Honorable mentions (rank 11–13):* Account-in-Use relogin dance — first Connect *kicks* an in-world char, 5–10 s to clear, respect the 65 s ACE reap gap (06); event-queue overflow post-stall death-spiral — reuse the existing `?entDrainBudget` ≤256/frame (04 §5.6); two independent DAT readers drift (10 R1, mitigated by frozen retail data).

---

## 5. Open decisions for the human (with recommendations)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Brain language/runtime** (the load-bearing fork) | (A) external C# + WS bridge · (A′) **`.NET-wasm` in-page** · (B) JS/TS rewrite in-page · (C) Rust-in-wasm | **Spike A′ in Phase 0.** If the compile holds → **A′** (preserves ~41k debugged lines, runs in-page, no CDP brittleness — dominates both A and B). If it fails → **15's B-now/C-later**. Use A only as throwaway spike scaffolding. The near-tied 15 scores (18/19/18) mean *durability for the committed target* is the tiebreaker, and A′ maximizes it. |
| **D2** | **Where the nav router runs** | Sidecar (reuse C# Detour) vs Rust/wasm Detour port | **Sidecar first** (09 Option A) — low effort, reuses the C# query verbatim, sidesteps the poll-vs-async inversion (request/response), honors RynthSuite's "out-of-process tooling preferred" constraint. Rust/wasm Detour is an XL endgame; defer until the sidecar proves the seam. |
| **D3** | **LOS engine** | Keep C# raycasting · port to Rust · ship without arc-LOS | **Keep C# if the brain is C# (A/A′) and has DAT access; else defer arc-LOS to Phase 4.** 10 shows it's host-independent (3 read-only pose calls) but needs local DATs — a constraint only satisfied outside a pure in-page JS brain. |
| **D4** | **Multi-bot transport** | WS snapshot-cache side-channel (needed only for external brain) vs pure in-page (no side-channel) | **Follows D1.** In-page brain (A′/B/C) needs no side-channel — one page per bot, `?nullRender=1`. External C# (A) needs 05's WS snapshot-cache. `serve.py` needs zero changes either way (06). |
| **D5** | **Parity scope — do we need ExpressionEngine/MetaManager?** | Four loops only vs full VTank meta scripting | **Defer to Phase 4; gate on demonstrated user need.** It is 101 of 367 guard sites and a 3,738-line engine that the four target loops never touch (03). Shipping the four loops does not require it. |
| **D6** | **Trust the downward-revised island count?** | Established ~508 vs 08's ~305 (~111 irreducible) vs 07's fellowship→~0 | **Trust the revisions.** 08 excludes `DungeonMapTexture` (236, DIES-WITH-UI, not blocking); 07 proves the fellowship stack already exists on web. Budget the excision as ~1–2 weeks, not the ~508-line scare number. |

---

## 6. Appendix — per-report digest + quality/confidence note

Confidence reflects citation realism (spot-checkable file:line density) and internal consistency with the fleet. All 15 reports cite real files with line numbers throughout; none showed fabricated-looking citations.

| # | One-paragraph digest | Confidence / contradictions |
|---|---|---|
| **01** | Canonical seam inventory. `RynthCoreHost` = ABI v66, **112 native ABI fields → 108 fn-pointers + 4 handles**, wrapped **1:1** by 108 host methods + 5 props + 103–104 `Has*` probes (217 members, 113 method/prop rows). 16 rows are render/UI **DROP**; net headless target **~91 members**. Version-gate table included. No unwrapped native pointers. | **High.** Most rigorous host-surface count; explicitly mechanical (ripgrep, not estimated). Its 91-headless figure **agrees with 02**. Minor naming traps documented (`HasHasAppraisalData`). |
| **02** | Seam→web mapping matrix. Of **91 in-scope** members: **37% clean COVERED, 85% reachable** with glue, 16 MISSING. **Object/entity queries is the crisis (4% clean).** Ranks the SessionHandle additions web must make (generic property bag #1, entity vitals #2, sync busy/cast getters #3). Names the 5 hardest mappings. | **High.** Directly cross-checks 01 (same 91 denominator). Its "add these to SessionHandle" list **overlaps and agrees with 14's backlog**. SessionHandle counted at 210 methods (task said ~188) + 68 free fns (task said ~147 — attributes the gap to test/diag helpers). |
| **03** | Minimal viable host + build order. Measures **367 real guard sites** (calls the brief's 344 an undercount), 104 caps, 22 never-guarded (the trap: `MeleeAttack`/`SetAutoRun` are unguarded — don't skip). **Two planes: guarded poll + un-guarded event feeds** — must implement both or the loop idles. Gives irreducible host subset per loop + 29-surface tiered build order. | **High.** The "two planes" and "unguarded actions" findings are load-bearing and unique. Its 367 vs task-344 vs 15's 355 is the **guard-count discrepancy** (see below) — a counting-method difference, not an error. Combat needs **complement 11**, not contradict (03 = minimal swing, 11 = full behavior). |
| **04** | Tick/event model audit + adapter design. Corrects the brief's file paths (EntryPoint/EngineFrameController are in **rynthcore**, not rynthsuite — verified). Native tick = dedicated **thread**, 16/33 ms, ~20 per-type FIFO queues, causal drain order. Recommends **in-page adapter appended to the net pump, await-free frozen snapshot, Web-Worker heartbeat**. Handles 8 failure modes incl. the busy-count synthesis. | **Very high.** Deepest technical report; caught a brief error and verified the correction. Its snapshot mechanism **converges with 05** from the other end. Explicitly brain-agnostic (serves wasm or external) — the neutral ground in the 05-vs-15 fork. |
| **05** | Bridge architecture. Rejects CDP (latency×150) and wsbridge (wrong layer — server-side of the wasm decode, proven from `ARCHITECTURE.md`). Recommends **dedicated WS side-channel + in-page shim, one batched snapshot/tick answered from a C# cache**. Message schema, capability negotiation mirroring `Has*`/ABI, 3-day walking skeleton. | **High.** The snapshot-cache idea **is the same as 04's** and is the workflow's key transport insight. **Frames the whole design around an external C# brain (Option A)** — this is the architecture 15 recommends against as a *destination*. The mechanism survives regardless; the *external-process* framing is the contested part. |
| **06** | Bot-harness runtime spec. **Every `url-flags.md` line ref is stale; 3 defaults wrong** (verified against readers). `ready` is a render gate — **gate bots on `in-world`/`__bootStateHistory`, not `ready`**. Boot recipe, readiness gates, Account-In-Use semantics, nullRender resource budget (still bakes atmosphere unless `+?wireframe=1`). | **Very high.** Meticulous doc-vs-code verification with a drift table. Its "gate on in-world" **agrees with 13's `__bootState`=UseNewMode** finding. The most operationally actionable report for bring-up. |
| **07** | FellowshipTracker rewrite. The whole memory-walking subsystem is **already reimplemented end-to-end on web** from protocol truth (`playerFellowship()`), exposing *strictly more* (per-member vitals, departed members, locks). **The 272-line island collapses to a ~1-day C# adapter, zero new Rust.** Cheapest island. | **High.** Every field traced protocol→state→wasm→JS with line cites. **Refines 08/15's ~508** downward for this file specifically. No contradictions; strengthens the "islands are small" thesis. |
| **08** | Win32/interop excision audit. **1 DllImport, 2 GetModuleHandle, 2 registry reads, 3 real memory addresses, 1 D3D9 island.** Revises blocking lines **508 → ~305 (~111 irreducible)** by excluding `DungeonMapTexture` (236, DIES-WITH-UI). Clean disposition taxonomy (DIES-WITH-UI / NEEDS-SHIM / NEEDS-REWRITE / PORTABLE-ANYWAY). | **Very high.** Exhaustive regex sweep with false-positive triage. Its downward revision is a **key correction to the established ~508 fact**. Consistent with 07 (fellowship) and 09 (nav servo dropped). |
| **09** | RynthNav → web movement. RynthNav = **global router** (offline bakes + Detour query + portal Dijkstra); web `MoveToManager` = **local steering executor**. The ~430-line servo is **dropped**. Keystone: one new `moveToPosition` export (downstream already exists, unit-tested). Router as **sidecar** (reuse C# Detour). Portal detect via landblock change. | **High.** Deep, well-cited; verified `move_to_position` exists and is tested. Sidecar recommendation **honors the poll-vs-async avoidance** (request/response). MISSING section honestly flags un-read `move_to_position` body + DAT-format compat as top bake risk. |
| **10** | Raycasting audit. The 9-file/5,830-line ray-LOS engine is **host-independent** (only 3 read-only pose calls, in 1 file); reads DATs off disk itself. **Recommends keeping it C#** (not porting to wasm) — sidesteps poll-vs-async, avoids duplicating holtburger's sphere-collision stack. Corrects the "D3D Y-up" premise: both collision stacks are **AC Z-up**; Y-up is render-only. | **High.** Careful classification; the Z-up correction is important for R10 (coord corruption). **Mild tension with a pure in-page brain**: "keep it C#, reads DATs off disk" assumes an external/DAT-equipped process — flagged in D3/R6. |
| **11** | Combat/buff behavioral contract. The **portable spec** — every contract traced to a specific debugged in-game failure. The **three orthogonal pacing gates** (`CanCastNow`/`BusyCount`/`UseDoneSeq`), target selection T1–T16, attack pacing P1–P13, buff B1–B16, stance S1–S7, watchdogs E1–E8, selection-free X1, full magic-constants reference. | **Very high.** The richest behavioral extraction; dozens of exact constants + line cites + the *why*. **Complements 03** (03 = which host fns; 11 = how to use them). Both agree: drop native attack, explicit-target shape. This is the spec the rewrite (or port) is built against. |
| **12** | God-class decomposition. `RynthAiPlugin` = one logical class across **6 partials, 8,312 lines**. The single highest-leverage cut: **lift `LegacyUiSettings` out of the ImGui renderer** (13 subsystems construct from `_dashboard.Settings`). Extract `BotKernel` (5 duties). 13 subsystems + 2 FSM partials lift unmodified once the config is freed. | **High.** Precise per-file/per-method verdicts with line cites. Confirms the ImGui tier deletes cleanly (15's ~10.4k). Feeds Phase 4. No contradictions. |
| **13** | Chorizite prior-art synthesis. Two separate "retarget?" studies reached the same conclusion. **holtburger closes essentially the entire Chorizite hook/asset gap** (5/6 hooks CLOSED, 3 assets MOOT-by-architecture) because it *is* the client — hook-fragility evaporates. **`__bootState` = the `UseNewMode` readiness authority** the docs earned through crash-debugging. Legal: web port is the *safest* option under the clean-room policy. | **High.** Strong methodological framing ("hooks don't port, behaviors do") + legal analysis. The **`__bootState`-as-readiness-gate finding agrees with 06**. Reinforces the whole web-target thesis. |
| **14** | Web-client state coverage vs bot read surface. **Two disjoint read planes** (JS `entityMap` per-object vs wasm snapshot per-player). Of ~56 host reads: ~24 EXPOSED, ~11 TRACKED-NOT-EXPOSED (cheap getters), ~8 real build work. **Ranked backlog** of 17 SessionHandle additions; the busy/use-done/cast-busy trio (#5) is the one design-work cluster. | **Very high.** The definitive "what to add to holtburger-web" answer, effort-rated. **Cross-checks 02** (same crisis: object properties, target vitals, busy trio). Its two-planes finding is architecturally load-bearing for the seam. |
| **15** | Architecture scorecard. Scores **A 18 / B 19 / C 18** — near-tied. Recommends **B now (JS rewrite lifting constants), C later (Rust hot loops), A as throwaway spike**; D (native deno) off by decision. Two-week de-risking spike plan. Key insight: **preserved *lines* ≠ preserved *value*** — web deletes the hardest acclient-memory debugging. | **High, but the pivotal contested report.** Its recommendation **directly opposes 05's external-C# framing** and never scored the `.NET-wasm-in-page` (A′) path this synthesis surfaces as dominant. Its counts (355 guards, 760 js_name exports, 51,511 lines) are consistent with the fleet. The near-tie is itself the honest signal that the fork is genuinely open. |

### Cross-report discrepancies flagged (not errors — counting-method or scope differences)

- **`Has*` guard-site count: 344 (task) vs 355 (15) vs 367 (03).** 03 is most rigorous — it separates 112 *internal* computed booleans (`HasTargets`, `HasMore`…) from 367 *real host-capability* guards. Caps-defined converge at ~94–104. A reimplementer should use **03's 367** for guard-site work and **~104 caps** for the capability set. Non-strategic.
- **`RynthCoreHost` surface: 217 members (01) / 107 callable (02) / 219 public (05,15) / ~56 reads (14).** All consistent once sliced: 01 counts methods+props+`Has*`; 02 excludes `Has*`+props; 14 counts only reads. **Denominator for "must implement" ≈ 91** (01 and 02 agree exactly).
- **SessionHandle size: ~188 methods+~147 free fns (task) / 210 methods+68 free fns (02) / 760 js_name (15).** Reconciled: 210 methods on impl blocks, 68 col-0 free `pub fn`, 760 total `js_name` (includes getters on helper structs). Task's "~147 free functions" was high (test/diag helpers).
- **The architecture fork (05 external-C# vs 15 in-page-rewrite vs 04 agnostic)** is the one *substantive* contradiction — resolved in §1/§5-D1 by surfacing the under-evaluated `.NET-wasm-in-page` path and gating on the Phase-0 compile spike.
- **10 (keep raycasting C#) vs a pure-in-page brain** — a mild tension: 10's DAT-off-disk assumption only holds outside a sandboxed in-page JS brain. Surfaced in D3/R6.

---

*End of roadmap. The durable first move — independent of the D1 fork — is: (1) write the WebHost contract spec from 01/02/03, (2) land 14's S-effort getter backlog into holtburger-web, (3) run the Phase-0 spike to resolve the brain-language fork. Everything else sequences off those.*
