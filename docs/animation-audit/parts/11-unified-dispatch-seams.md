I now have a complete, grounded picture. Here is my audit.

---

## What exists

The "unified dispatch" effort is a **factory-module extraction** that gives both renderer hosts (2D PIXI in `index.html`, 3D three.js in `scene3d/`) a *shared kind table and dispatcher factory*, but stops short of one runtime path. Five pieces:

| Artifact | File | Role |
|---|---|---|
| `KIND` table + `createEntityDispatcher` factory | `scene3d/entity_dispatch.js:36`, `:67` | Single source of the 10 EntityUpdate kind constants + a per-host dispatcher builder (`neutral` table runs before `backend` table). |
| `createWorldStreamer` | `scene3d/world_stream.js:57` | Renderer-neutral world-streaming core (the `KIND.POSITION` neutral hook). |
| `dispatchEntityUpdate` + `_arm*` functions | `scene3d/loop.js:2291`, `:2014`–`:2289` | The canonical per-kind 3D backend arms, hoisted out of the old closure. |
| `installSharedDrainHook` | `scene3d/loop.js:2671` | Builds the 3D backend table (`_dispatcher3d`, `:2707`) and installs `window.__scene3dEntityHook`. |
| `singleDriver` claim | `scene3d/index.js:430`–`:438`, `:4011`; pump in `index.html:9745`/`:11961` | Lets the 3D `tickPerFrame` own the net/input pump (retail's single `SmartBox::UseTime` shape). |

The **2D host** instantiates the factory as `__dispatch2d` (`index.html:7016`) and the streamer as `worldStreamer` (`index.html:6330`); the **3D host** instantiates the factory as `_dispatcher3d` (`scene3d/loop.js:2707`). Both draw from the same `KIND` table and the same `_arm*`/`handle*` bodies — so behavior converges *by construction*, but the routing is still built twice.

## How it works (file:line)

**Wire → drain → dispatch, live 3D session:**
1. `pumpNetFrame` (the old `drainEvents` body) calls `handle.pollEntityUpdates()` (`index.html:11437`), forwards the **still-alive** array to `window.__scene3dEntityHook?.(entityUpdates)` (`index.html:11454`), then runs its own per-kind loop and frees each `upd` at the tail (`index.html:11507`).
2. The hook (`scene3d/loop.js:2758`) iterates the array and calls `dispatchOne(upd)` — which under the flag delegates to `_dispatcher3d.dispatch(upd)` (`:2728`) routing to `_armSpawn/_armPosition/...` (`:2712`–`:2720`), **never freeing** (drain owns the wasm-bindgen lifetime — `entity_dispatch.js:26`, `:100`).
3. The 2D loop's own routing (`index.html:11466`) runs `__dispatch2d.dispatch(upd)` when `?unifiedDispatch` is on, else the legacy `else if (upd.kind===N)` chain (`:11469`–`:11506`).

**Neutral/backend split:** `createEntityDispatcher.dispatch` runs `neutral[kind]` then `backend[kind]` (`entity_dispatch.js:74`,`:79`). World streaming is registered as the 2D host's `KIND.POSITION` *neutral* hook (`index.html:7020` → `worldStreamer.onPositionUpdate`), and the 3D host's neutral table is **empty by invariant** (`scene3d/loop.js:2710`, `entity_dispatch.js:56`) — because neutral concerns must fire exactly once, at the 2D drain.

**singleDriver:** when claimed (`scene3d/index.js:4011`), `tickPerFrame`'s CRITICAL phase #0 calls `window.__netFramePump()` (`scene3d/loop.js:1492`), the 2D `drainEvents` rAF parks itself (`index.html:11946`), and a `setTimeout` watchdog can un-park it if the heartbeat goes stale (`index.html:11923`,`:11929`).

## Fragility & workarounds

- **Twin maintained copies of the streaming sequence.** `world_stream.js:86`–`:167` and `index.html:6406`–`:6500+` are the same ~100-line block, kept aligned by hand via paired `A15-Q4-SYNC` markers (`index.html:6407`/`:6166`, `world_stream.js:91`/`:166`) and a headless **drift-guard test** (`test_a15_q4_renderer_neutral_core.mjs`, cited `world_stream.js:81`). The guard exists *because* the two will silently diverge otherwise.
- **Flag default disagreement between hosts (live bug-shaped).** `loop.js:291` reads `unifiedDispatch !== "off"` ⇒ **default ON**, while its own header (`:277`) says "default-off"; `index.html:4657` reads `=== "on"||"true"||"1"||"yes"` ⇒ **default OFF**. On a bare URL the **3D hook uses the unified dispatcher but the 2D drain uses the legacy if-chain.** Same stale-comment/asymmetry pattern on `DISPATCH_PARITY_ON` (`loop.js:270` default-ON vs header `:257` "default-off"). The arms are shared so output still converges, but the *defaults were graduated in `loop.js` and not in `index.html`*.
- **Four copies of the arm logic.** Canonical `_arm*` (`loop.js:2014`); the 2D legacy if-chain calling named `handle*`/`dispatch2dSpawn`/`neutral*` (`index.html:11469`); the 3D legacy if-chain `dispatchEntityUpdate` (`loop.js:2298`); and a *verbatim* fourth copy `_legacyDirectDrainArm` (`loop.js:2399`) behind `?legacyDirectDrain`.
- **Quarantine gaps surfaced as `console.info`, not handled.** 2D backend is frozen at kinds 0–5 (`index.html:7024`–`:7031`); kinds 6–9 (APPEARANCE/ATTACH/MOTION_ACTION/TURN) hit the dispatcher's one-time "no backend handler" accounting (`entity_dispatch.js:94`). `KIND.META_REFRESH` (3) is deliberately absent from the 3D backend too and `_armMetaRefresh` is an explicit no-op (`loop.js:2285`).
- **Structural co-dependence, not independence.** The 3D path *requires* the 2D `pumpNetFrame` to run for its neutral (streaming) concerns; singleDriver doesn't remove that — it **nests the entire 2D pump inside the 3D tick** as phase #0 (`loop.js:1468`–`1495`). "Single driver" = "2D pump relocated," reversible at runtime by a watchdog.

## Retail (acclient) comparison

Retail has **one tick and one funnel**. `SmartBox::UseTime` (`acclient.c:146255`) does, in a single pass: cell streaming off the player position (`CellManager::ChangePosition`, `:146277`; `UpdateLoadPoint`/`CheckPrefetchStatus`, `:146270`–`:146272`) → `CObjectMaint::UseTime` → **`CPhysics::UseTime` (`:146286`) advances motion for *every* physics object** → then the `in_queue` loop dispatches every net blob through the **single** `DispatchSmartBoxEvent` vtable call (`:146313`). Motion itself is one sequence interpreter for all objects: `CMotionInterp::add_to_queue` (`acclient.c:7092`) → `CMotionTable::GetObjectSequence`/`DoObjectMotion` (`:6893`,`:6899`) build a `CSequence` of frames that `CPhysics::UseTime` advances. Player, monster, door, and missile all flow through the **same** `CMotionInterp`/`CMotionTable` — no per-renderer backend, no per-feature side-channel, no local-vs-remote fork at dispatch (prediction lives uniformly in the motion/physics layer).

Holtburger's unification reproduces the *shape* of the funnel (`createEntityDispatcher` ≈ `DispatchSmartBoxEvent`, `pumpNetFrame`-as-phase-#0 ≈ `UseTime`), but **not the single motion authority** — see the remaining forks.

## Consolidation recommendations

**Remaining forks (exactly what still forks per-feature):**

1. **Two host backend tables.** `__dispatch2d` (kinds 0–5, `index.html:7024`) vs `_dispatcher3d` (kinds 0,1,2,4,5,6,7,8,9, `loop.js:2711`). Motion still forks 2D-sprite vs 3D-rig at the backend layer.
2. **Legacy routing kept alongside the unified table** in *both* hosts (`index.html:11469`, `loop.js:2298`), selected by the (mismatched-default) flag → 4 live routing paths for the same kinds.
3. **World streaming duplicated** (`world_stream.js` vs `index.html:6406`), hand-synced via markers + drift test.
4. **Capture/standalone path forks again**: `drainEntityEvents3D` (`loop.js:2353`) + its `_legacyDirectDrainArm` verbatim copy (`:2399`).
5. **Five separate motion drains per 3D frame**, each its own wasm side-channel + flag (`loop.js:1776`–`1797`): `drainEntityEvents3D`, `drainMotionActions` (`?multiAction`, `:333`), `drainMotionAxes` (`?castAxes`, `:376`), `drainRemotePoses` (`?remoteInterp`, `:428`), `applyLocalPlayerPoseFromIntegrator` (local pose, `:660`). This is the core "no single motion authority" gap — 5 parallel sources feed `em.setMotion/setPose`.
6. **Local-vs-remote fork *inside* the arms**: `_armMotion` (`:2150`), `_armPosition` (`:2087`), `_armTurn` (`:2234`), `_armMotionAction` (`:2197`) all branch on `isLocalPlayerGuid`, with sub-forks `FORCE_MOTION_LOCAL`, `?serverSwing`, `?dispatchParity`.
7. **Frame-driver fork**: 2D rAF `drainEvents` vs 3D `tickPerFrame` phase #0 vs `?netDrainHz` interval, with a runtime watchdog flip-back (`index.html:11923`).
8. **kind 3 (META_REFRESH) and kinds 6–9 fork by host** (3D-only / 2D-gap, by quarantine policy).

**Path to one motion/dispatch path:**

- **Graduate `?unifiedDispatch` to always-on and delete** the two legacy if-chains + the duplicate streaming block; the drift-guard test (`test_a15_q4_renderer_neutral_core.mjs`) exists to make this safe. First reconcile the `loop.js`/`index.html` default mismatch (fork #2) so graduation is behavior-neutral.
- **Fold the 5 side-channel drains into the KIND table** (fork #5): the quarantine policy already says new kinds must be registered in `entity_dispatch.js` first — make multiAction/castAxes/remoteInterp into KINDs rather than parallel polls, so all motion enters through one funnel like `DispatchSmartBoxEvent`.
- **Build one `CMotionInterp`/`CMotionTable` equivalent** (`(motionCommand, stance, speed) → sequence`) that *both* the local integrator and remote echoes feed, replacing `applyLocalPlayerPoseFromIntegrator`-as-separate-authority and collapsing the local-vs-remote branches in the arms (fork #6). This is the single-motion-authority retail uses (`acclient.c:6893`/`:7092`).
- **Retire `_legacyDirectDrainArm` + the capture fork** (fork #4) post-eye-test, and converge to the single `singleDriver` frame pump (fork #7), retiring the 2D rAF + netDrainHz drivers once the watchdog is no longer needed.

Net: the effort delivered a **shared kind table, a shared factory, and shared arm bodies** (real progress — routing is no longer copy-pasted), but the *runtime* is still two backends, two legacy chains, two streaming copies, five motion drains, and a per-guid local/remote split — gated by ~10 URL flags with at least one host-default mismatch. It is a successful *interface* unification awaiting *path* unification.
