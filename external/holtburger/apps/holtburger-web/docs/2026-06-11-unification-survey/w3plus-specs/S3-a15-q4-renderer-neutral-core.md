# S3 — A15-Q4: renderer-neutral core extraction (world streaming + entity dispatch)

Execution-grade spec, W3+ deep-spec sweep, 2026-06-11.
Item: A15-Q4 (ROADMAP §2 "2D-path seam", §3 conflict matrix `scene3d/loop.js` + `index.html`
rows, §9 "Needs Fable-class judgment": A15-Q4 + A8-M3).
Source survey: `apps/holtburger-web/docs/2026-06-11-unification-survey/agents/A15-dual-renderer-seam.md`
(§3 row 7, §4 Stage Q4). Human ruling: RULINGS.md item 2 — **2D stays supported; deletion is
permanently off the table; quarantine-plus-shared-core is confirmed.**

All `index.html` / `loop.js` paths are `apps/holtburger-web/`-relative inside
`external/holtburger/`. Retail truth: `/home/wbterminal/ac-headers/acclient.c` (+`.h`).

---

## 1. Read-HEAD + W2 assumptions

- **Read HEAD: `61bea82f`** ("holtburger: W2/Batch-R2 buildbox dispatch manifest"). All our-side
  line numbers below were verified at this commit; a W2 wave is committing concurrently, so an
  implementer MUST re-grep the anchor symbols (they are all named functions/consts) rather than
  trusting raw line numbers.
- **W2 in-flight items (A4-Q1, A3-D2, A2-P1, A7-R1/R2/R3/R6, A9-Stage1) are assumed to land in
  `crates/` + `apps/holtburger-web/src/lib.rs` only.** None of them touch the two files this spec
  rewrites (`index.html` drain/streaming blocks, `scene3d/loop.js` dispatch layer). Verified at
  read-HEAD: the W2 batch-R2 manifest commit (61bea82f) and prior W2 landings touch no
  `index.html`/`loop.js` dispatch code. If that assumption breaks, only line drift results — the
  staged plan is keyed to symbols.
- **Already landed and load-bearing for this spec:** A15-Q1 (`ENTITY_BUFFER_CAP` ring caps +
  `?spawnDefer2dOnly`, commit 2f50b269), A15-Q2 (`scene3d/entity_update_clone.js` +
  `?unifiedClone`, commit 1396967c), A9-Stage2 (`scene3d/setup_rig.js`, a468c931), W0/W1 gates
  `?worldLifecycle` / `?unifiedTick` / `?wireStatePacks` / `?maintPrune` (174fa1b4, 656c8ef1,
  ac3f9891, b4e87213) and the canonical spine `crates/holtburger-core/src/client/tick_spine.rs`
  (exists at read-HEAD).
- **NOT yet landed at read-HEAD:** A15-Q3 (retire the dead 3D direct-drain arm — W3) and A8-M3
  (kind-17 lifecycle dispatcher move — W5 partner). Conflict-matrix order for `scene3d/loop.js`
  is **A15-Q3 → A8-M3 → A15-Q4 → A1-O4 → A11-S3** (ROADMAP §3). This spec is written against a
  post-Q3 `loop.js` (direct-drain arm = thin wrapper over `dispatchOne`) and carries a §3.6
  contingency for executing before Q3/M3.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail shape (the target topology)

Retail has ONE renderer and a renderer-NEUTRAL simulation layer that owns both world streaming
and message dispatch; drawing is a separate pass:

- `SmartBox::UseTime` (acclient.c:146256) is the per-frame neutral tick. Inside it, **world
  streaming is driven off the player's position**:
  `CellManager::ChangePosition(this->cell_manager, a2, &player->m_position, 0)`
  (acclient.c:146278). Maintenance and physics follow in the same neutral tick:
  `CObjectMaint::UseTime` (acclient.c:146284, decl acclient.c:6163) then `CPhysics::UseTime`
  (acclient.c:146285) then `LScape::UseTime` (acclient.c:146289).
- `CellManager::ChangePosition` (body acclient.c:146646) prefetches cells on a load-point change
  (`CellManager::PreFetchCells`, acclient.c:146679) and updates the outdoor landscape load point
  (`LScape::update_loadpoint`, acclient.c:146695) — i.e. retail's "streaming" = cell prefetch +
  landscape loadpoint, both triggered by player position inside the neutral tick, NOT by a
  renderer.
- Queued network events drain through a SINGLE dispatch funnel at the bottom of the same tick:
  `IsReadyToDispatchEvent` → `DispatchSmartBoxEvent` (acclient.c:146313-146318).
- Rendering is a separate entry point: `SmartBox::Draw` (acclient.c:146329) /
  `SmartBox::DrawNoBlit` (acclient.c:145853).

### 2.2 Our shape (the divergence, A15 §3 row 7 + row 1)

- **Both renderers are hosted by `index.html`;** the wire drain `drainEvents()` is a rAF loop
  (index.html:9074, self-scheduled at :11110-11112) that polls `handle.poll_events()` (game
  events) and `handle.pollEntityUpdates()` (index.html:10625) and owns the wasm-bindgen `.free()`
  lifetime (index.html:10725).
- **World streaming for BOTH renderers lives inside a 2D-named handler:** the local-player block
  of `handlePositionUpdate` (index.html:6071, streaming block :6114-6215) calls, in order:
  `landblockChanged` plugin emit (:6122-6128), `ensureTerrainAroundLandblock` (:6132, defined
  :5993), `ensureBuildingAabbsAroundLandblock` (:6140, defined :5817),
  `ensureCellContainersForLandblock` (:6149, defined :5716),
  `window.liveScene3d.loadEnvCellsForLandblock` (:6151-6153), `loadTerrainForLandblock` over a
  clamped 3×3 ring (:6165-6178), `loadBuildingsForLandblock` (:6179-6183),
  `loadStaticsForLandblock` (:6184-6188), `loadSpawnsForLandblock` (:6197-6201), and
  `ensureLandblockObjectsForLandblock` (:6212-6214, defined :5893, 2D-only and internally
  `liveScene`-gated). This is the load-bearing block: removing the 2D handler kills 3D
  terrain/buildings/statics/spawns/envcell streaming AND the wasm physics bakes that gate the
  integrator (the indoor pre-bake freeze documented at index.html:6084-6090). Retail contrast:
  acclient.c:146278 + :146679/:146695 put exactly this work in the renderer-neutral tick.
- Idempotency state for the streaming helpers is four module-scope Sets shared between the
  helpers and the call sites: `terrainPrefetchedLbs` (:5665), `buildingAabbsPopulatedLbs`
  (:5686), `objectsRenderAddedLbs` (:5695), `cellContainersPopulatedLbs` (:5709), plus
  `let lastLocalPlayerLb = 0` (:4443) for the `landblockChanged` edge.
- **Entity-update kind dispatch exists at 3 sites** (vs retail's single funnel
  acclient.c:146313-146318):
  1. 2D arm: the `for (const upd of entityUpdates)` if-chain, kinds 0–5 only
     (index.html:10642-10726; kind-1 arm carries inline `deferredSpawns` deferral
     :10651-10675 and the renderer-neutral Chorizite `worldObjectManager.onObjectCreated`
     :10684-10693; kind-2 carries `worldObjectManager.onObjectDeleted` :10697-10699; the loop
     ends with the unconditional `upd.free()` :10725). Kinds 6–9 silently fall through (the
     documented supported-mode gap per RULINGS.md item 2).
  2. 3D live arm: `dispatchOne` inside `installSharedDrainHook` (loop.js:2011, dispatchOne
     :2025-2234), kinds 0,1,2,4,5,6,7,8,9 — **no kind-3 META_REFRESH arm** (see OPEN
     QUESTIONS). Fed by `window.__scene3dEntityHook` (:2262), which the 2D drain calls with the
     pre-`.free()` array (index.html:10641). Includes the backlog replay (:2309-2353) over
     plain-JS clones, and `_prewarmFromBatch` (:2245).
  3. 3D dead direct arm: `drainEntityEvents3D` (loop.js:1729, early-return under
     `useSharedDrain` :1742) — A15-Q3's target; assumed reduced to a thin wrapper before Q4.
- Kind constants are loop.js-local: `KIND_POSITION..KIND_TURN` = 0..9 (loop.js:76-100).
- Flag/module precedent to copy: `?unifiedClone` is read independently in index.html (:4488-4491)
  and loop.js (:206-214); the shared module lives at `scene3d/entity_update_clone.js` and is
  imported by the index.html module script (:1306) — proving index.html can import scene3d/
  modules directly.
- Buffers (post-Q1, both ring-capped at `ENTITY_BUFFER_CAP = 512`, :4465): `deferredSpawns`
  (:4628, 2D pre-`liveScene` spawn replay :10731-10735) and `window.__scene3dEntityBacklog`
  (:4517, buffering stub `bufferingHook` :4601, drained by `installSharedDrainHook`).
- Game-event drain (evt.kind 0–55) is already single-owner (index.html, A15 §3 row 8 PARITY) —
  Q4 does NOT touch it except where noted for A8-M3 coordination (the kind-17 handler at
  index.html:10090 is M3's, not ours).

### 2.3 What "renderer-neutral" means here (classification, dual-cited)

| concern | retail owner | our current owner | Q4 classification |
|---|---|---|---|
| world streaming off player pos | acclient.c:146278 (neutral tick) | index.html:6114-6215 (2D handler) | NEUTRAL — extract to `world_stream.js` |
| entity-update kind routing | acclient.c:146313-146318 (one funnel) | 3 sites (§2.2) | NEUTRAL routing + per-renderer backends — extract to `entity_dispatch.js` |
| Chorizite worldObjectManager feed | (plugin layer, no retail analog; renderer-independent by construction) | index.html:10684-10699, runs in BOTH modes today | NEUTRAL hook |
| 2D sprite work in handlePositionUpdate | n/a (renderer) | index.html:6220-6337 | 2D backend, stays put |
| 3D rig work in dispatchOne | n/a (renderer) | loop.js:2029-2229 | 3D backend, stays put |
| `.free()` lifetime | n/a | index.html:10725 | stays at the drain — dispatch NEVER frees |

---

## 3. Staged implementation plan

All stages are **JS-live** (no wasm rebuild, no export-manifest bump — zero new wasm exports;
the F18-2 export-manifest is untouched). The service worker uses runtime caching only
(`CONTENT_CACHE`, service-worker.js:16, fetch-through :67) — new module files need **no**
precache registration. Single flag for the whole item: **`?unifiedDispatch=on` (default-off)**,
read independently in index.html and loop.js using the exact `?unifiedClone` pattern
(index.html:4488-4491; loop.js:206-214). Flag-off = legacy paths byte-identical.

Commit order Q4.1 → Q4.2 → Q4.3 (separately revertable); land after A15-Q3 and A8-M3 per the
ROADMAP §3 `scene3d/loop.js` serialization (contingency in §3.6).

### Q4.1 — `scene3d/world_stream.js` (the load-bearing streaming extraction)

**New file `apps/holtburger-web/scene3d/world_stream.js`** (placed in scene3d/ per the
entity_update_clone.js precedent; the "renderer-neutral" relabel is the module header, not a new
directory). Pure factory module: no `window`, no DOM, no wasm imports — every environment touch
is an injected dep. Shape:

```js
// scene3d/world_stream.js — A15-Q4 renderer-NEUTRAL world-streaming core.
// Retail analog: CellManager::ChangePosition off player pos inside
// SmartBox::UseTime (acclient.c:146256/:146278), cell prefetch + LScape
// loadpoint (acclient.c:146679/:146695). Serves BOTH renderers.
export function createWorldStreamer(deps) {
  const {
    getLocalPlayerGuid,            // () => number|null  (index.html closure localPlayerGuid)
    emitLandblockChanged,          // (prevLb, lbId) => void  (wraps window.__pluginClient emit, index.html:6125-6127)
    ensureTerrainAroundLandblock,        // index.html:5993 (wasm heightmap bake; PIXI half self-gates on liveScene)
    ensureBuildingAabbsAroundLandblock,  // index.html:5817 (pure wasm bake)
    ensureCellContainersForLandblock,    // index.html:5716 (wasm cell_physics_index; PIXI half self-gates)
    ensureLandblockObjectsForLandblock,  // index.html:5893 (2D-only; self-gates on liveScene.outdoorContainer)
    getLiveScene3d,                // () => window.liveScene3d | null
    // shared idempotency Sets, passed BY REFERENCE (owned by index.html
    // because the ensure* helpers mutate them internally: :5737/:5803,
    // :5852, :5905, :5985):
    terrainPrefetchedLbs, buildingAabbsPopulatedLbs,
    cellContainersPopulatedLbs, objectsRenderAddedLbs,
  } = deps;
  let lastLb = 0;   // streamer-private replacement for index.html:4443 lastLocalPlayerLb
  return {
    // Verbatim move of index.html:6114-6215 (the local-player streaming
    // block), with `window.liveScene3d` → `getLiveScene3d()` and the
    // plugin emit → `emitLandblockChanged`. Gates internally on
    // local-guid + lbId!==0 exactly as the source block does
    // (:6114-6117, :6118, :6122, :6129, :6139, :6148, :6151, :6165,
    // :6179, :6184, :6197, :6212).
    onPositionUpdate(upd) { /* ... */ },
    _debugState() { return { lastLb }; },   // headless-test introspection
  };
}
```

**Behavioral invariants the move MUST preserve (each is a live bug if broken):**
1. Call ORDER and gating exactly as :6114-6215 — terrain ring is 3×3 with 0x00/0xff edge clamp
   (:6168-6177); buildings/statics/spawns/envcells are single-LB; all fire-and-forget (no await).
2. The four wasm bakes run regardless of `liveScene` (the Workstream-G hoist rationale,
   index.html:6077-6113) — that is what keeps the 3D integrator from freezing on the spawn cell
   (indoor pre-bake gate, :6087-6090).
3. `landblockChanged` emits on first known LB and every transition, never on same-LB heartbeats
   (:6122-6128).
4. Call-site Set fast-path checks (`!terrainPrefetchedLbs.has(lbId)` :6129, etc.) are kept —
   the Sets are shared by reference so helper-internal `.add()`s remain visible.

**index.html changes:**
- Add `__UNIFIED_DISPATCH` flag const next to `__UNIFIED_CLONE` (:4488).
- Add `import { createWorldStreamer } from "./scene3d/world_stream.js";` next to :1306.
- Instantiate `const worldStreamer = createWorldStreamer({...})` AFTER the last ensure* helper
  definition (:5993 block) and BEFORE `handlePositionUpdate` (:6071).
- In `handlePositionUpdate`, wrap the streaming block:
  `if (__UNIFIED_DISPATCH) { worldStreamer.onPositionUpdate(upd); } else { /* legacy :6114-6215 verbatim */ }`
  — the legacy block is RETAINED verbatim under flag-off (Q1/Q2 rollback precedent). Mark both
  copies with paired `// A15-Q4-SYNC` markers; the headless test (§4) enforces call-sequence
  parity between the two copies until graduation deletes the legacy one.
- The 2D sprite half (:6220-6337) is untouched.

### Q4.2 — `scene3d/entity_dispatch.js` (one kind table, per-renderer backends)

**New file `apps/holtburger-web/scene3d/entity_dispatch.js`:**

```js
// A15-Q4 renderer-NEUTRAL EntityUpdate dispatch core. Retail analog:
// the single DispatchSmartBoxEvent funnel (acclient.c:146313-146318).
// QUARANTINE POLICY (RULINGS.md 2026-06-11 item 2): the 2D backend is
// FROZEN at kinds 0-5; kinds 6-9 (APPEARANCE/ATTACH/MOTION_ACTION/TURN)
// are a documented feature gap of the supported 2D mode; NEW kinds are
// 3D-only by policy and MUST be registered in this KIND map first.
export const KIND = Object.freeze({
  POSITION: 0, SPAWN: 1, REMOVE: 2, META_REFRESH: 3, VELOCITY: 4,
  MOTION: 5, APPEARANCE: 6, ATTACH: 7, MOTION_ACTION: 8, TURN: 9,
});
export function createEntityDispatcher({ neutral = {}, backend = {}, label = "?" }) {
  const warnedKinds = new Set();
  return {
    dispatch(upd) {
      if (!upd) return false;
      const kind = upd.kind | 0;
      try { neutral[kind]?.(upd); } catch (e) { console.warn(`[A15-Q4 ${label}] neutral kind=${kind}:`, e); }
      const h = backend[kind];
      if (h) { try { h(upd); } catch (e) { console.warn(`[A15-Q4 ${label}] backend kind=${kind}:`, e); } return true; }
      if (!warnedKinds.has(kind)) {          // one-time per-kind accounting —
        warnedKinds.add(kind);               // replaces today's SILENT drop
        console.info(`[A15-Q4 ${label}] no backend handler for EntityUpdate kind=${kind} (quarantine policy)`);
      }
      return false;
    },
    // NEVER calls upd.free() — the drain owns the wasm-bindgen lifetime
    // (index.html:10725).
  };
}
```

**loop.js changes:**
- Replace the local `const KIND_* = n` block (loop.js:76-100) with
  `import { KIND } from "./entity_dispatch.js";` + `const KIND_POSITION = KIND.POSITION;` etc.
  (alias consts keep the rest of the file diff-free). Flag-independent, pure relocation.
- Inside `installSharedDrainHook` (loop.js:2011): split `dispatchOne`'s arm bodies
  (loop.js:2029-2229) into named closure functions — `_armSpawn`, `_armRemove`, `_armPosition`,
  `_armVelocity`, `_armMotion`, `_armMotionAction`, `_armTurn`, `_armAppearance`, `_armAttach` —
  each capturing exactly what the current arm captures (`em`, `scene3d`, `_velScratch`,
  `_actionStamps`, `isLocalPlayerGuid`, `getTerrainVisualZ`, `FORCE_MOTION_LOCAL_ON`,
  `_sliceFromScratch`, `toMeta`, window maps). **Both routes call the same functions** —
  behavior identical by construction, no second copy:
  - flag-off: `dispatchOne` keeps its if-chain, arms replaced by `_arm*` calls;
  - flag-on: `dispatchOne` delegates to a
    `createEntityDispatcher({ backend: { [KIND.SPAWN]: _armSpawn, ... }, label: "3d" })`
    instance built once per `installSharedDrainHook` call. **Its `neutral` table is EMPTY** —
    neutral concerns run exactly once, at the index.html drain (invariant: the 3D hook receives
    the same array the 2D for-loop iterates, index.html:10641 vs :10642).
- `_prewarmFromBatch` (:2245), the array/single hook shape (:2262-2277) and the backlog replay
  + local-player partition (:2309-2353) are untouched (they sit above dispatch).
- Post-Q3 `drainEntityEvents3D` (thin wrapper) automatically inherits the same arms via
  `dispatchOne`.

**index.html changes:**
- Extract the kind-1 inline blob into named functions so both routes share them:
  `dispatch2dSpawn(upd)` = the `liveScene ? handleEntitySpawn : (spawnDefer gate / deferredSpawns
  ring-push)` logic (:10651-10675) and `neutralSpawn(upd)` = the `worldObjectManager
  .onObjectCreated` call (:10684-10693); `neutralRemove(upd)` = `.onObjectDeleted` (:10697-10699).
- Build once, after the handlers are defined:
  ```js
  const __dispatch2d = createEntityDispatcher({
    label: "2d-drain",
    neutral: {
      [KIND.POSITION]: (upd) => worldStreamer.onPositionUpdate(upd), // Q4.1 — streaming now owned by the NEUTRAL layer
      [KIND.SPAWN]: neutralSpawn,
      [KIND.REMOVE]: neutralRemove,
    },
    backend: {  // the QUARANTINED 2D sprite backend, kinds 0-5 only
      [KIND.POSITION]: handlePositionUpdate,   // streaming-skipping under flag-on (Q4.1)
      [KIND.SPAWN]: dispatch2dSpawn,
      [KIND.REMOVE]: handleEntityRemove,
      [KIND.META_REFRESH]: handleEntityMetaRefresh,
      [KIND.VELOCITY]: handleEntityVelocity,
      [KIND.MOTION]: handleEntityMotion,
    },
  });
  ```
- Drain loop (:10642-10726): flag-on body becomes `__dispatch2d.dispatch(upd); upd.free();`;
  flag-off keeps the legacy if-chain (now calling the same named pieces:
  `handlePositionUpdate` runs its internal legacy streaming block under flag-off per Q4.1, and
  the kind-1/2 arms call `dispatch2dSpawn`+`neutralSpawn` / `handleEntityRemove`+`neutralRemove`
  in the same inline order as today). `upd.free()` stays unconditional at the loop tail in both
  states. The `window.__scene3dEntityHook?.(entityUpdates)` forward (:10641) and the
  `deferredSpawns` replay (:10731-10735) are unchanged in both states.

### Q4.3 — quarantine policy docs + stale-comment fixes

- `docs/url-flags.md`: add the `?unifiedDispatch` row next to the Q1/Q2 rows (:193-194), text:
  flag scope (streaming ownership inversion + single kind table), default-off, JS-live, headless
  test name, the quarantine-policy sentence, and the explicit note "no manifest bump (no wasm
  change)".
- Fix stale cross-references this work touches (seam-rot per A15 §6): index.html:10632
  ("calls upd.free() at line ~6062" → :10725 region), loop.js:2016 ("index.html:6021" → the
  :10641 forward).
- Record in the entity_dispatch.js header that A1-O4 (`?singleDriver`) is the intended next
  consumer: under O4 the scene3d rAF will call the SAME drain core; `world_stream.js` and
  `entity_dispatch.js` deliberately have no `window`/renderer imports so O4 can re-host them
  without edits (A1 §4 Stage O4: net-apply → physics → … matching SmartBox::UseTime's shape).

### Q4.4 — graduation (out of scope here, listed for ordering)

After the 1070-gated spot-checks pass (§4): default-flip `unifiedDispatch`, delete the legacy
streaming block + legacy if-chain + the `A15-Q4-SYNC` markers, fold `lastLocalPlayerLb` removal.
W6 item; separate commit; not part of this spec's deliverable.

### 3.5 Flag/rebuild classification summary

| stage | files | flag | class | manifest |
|---|---|---|---|---|
| Q4.1 | scene3d/world_stream.js (new), index.html | `?unifiedDispatch=on` | JS-live | none |
| Q4.2 | scene3d/entity_dispatch.js (new), scene3d/loop.js, index.html | same flag | JS-live | none |
| Q4.3 | docs/url-flags.md, comment fixes | n/a | docs | none |

### 3.6 Contingency: executing before A15-Q3 / A8-M3

- **Q3 unlanded** (true at read-HEAD): Q4.2's `_arm*` extraction makes Q3 nearly free — spec
  permits landing Q4.2 first ONLY if the dead arm `drainEntityEvents3D` (loop.js:1756-1984) is
  ALSO re-pointed at the same `_arm*` functions in the same commit (otherwise the 3-site
  split-brain A15 §3 row 1 gains a 4th copy). Preferred order remains Q3 → Q4.
- **A8-M3 unlanded:** no semantic overlap — M3 moves the `evt.kind === 17` GAME-event handler
  (index.html:10090, poll_events channel) into the scene3d layer; Q4 owns the
  `pollEntityUpdates` channel + streaming block. The matrix ordering is merge-mechanical
  (same files). If M3 goes first, its `?unifiedEntityDispatch` flag must be reconciled with
  `?unifiedDispatch` (OPEN QUESTION 1).

---

## 4. Test plan

### Headless-now (buildbox, node, no browser, no build)

- **New `apps/holtburger-web/test_a15_q4_renderer_neutral_core.mjs`** (pattern: the
  existing two-part style of `test_a15_q1_entity_buffer_caps.mjs` — behavioral + static).
  - PART 1a (`world_stream.js`, imported directly as ESM): fake deps (recording stubs + real
    Sets). Drive synthetic kind-0 updates: (i) non-local guid → zero dep calls; (ii) local guid,
    lbId=0 → zero calls; (iii) local guid first LB → `emitLandblockChanged(0→lb)` once, all four
    ensure* called, `loadTerrainForLandblock` called exactly 9× (3×3), buildings/statics/spawns
    1× each; (iv) same-LB heartbeat → NO `emitLandblockChanged`, Set-gated ensure* not re-called;
    (v) LB transition → second `emitLandblockChanged(prev→new)`; (vi) corner LB 0x0000xxxx /
    0xFFFFxxxx → terrain ring clamped (4 calls at a corner); (vii) `getLiveScene3d()` returning
    null → no throw, wasm-bake deps still called (invariant 2, §3 Q4.1).
  - PART 1b (`entity_dispatch.js`): table routes all 10 KIND values to the right backend fn;
    neutral runs before backend for the same kind; missing backend kind → returns false +
    exactly ONE console.info per kind; a throwing backend doesn't break subsequent dispatches;
    dispatcher never calls `.free` (assert no such property access via Proxy upd).
  - PART 2 (static, read `index.html` + `loop.js` + modules as text): `__UNIFIED_DISPATCH` flag
    const present; `createWorldStreamer` import + instantiation present; **drift guard** —
    regex-extract the ordered streaming call-name sequence (`ensureTerrainAroundLandblock …
    ensureLandblockObjectsForLandblock`, the 10 names of §2.2) from BOTH the legacy
    `A15-Q4-SYNC` block and `world_stream.js`, assert identical sequences; loop.js KIND import
    present and old `const KIND_POSITION = 0` literals gone; `upd.free()` still unconditional
    in the drain loop.
- **Existing suites, BOTH flag states** (run with no URL → flag-off; the loop.js/index.html flag
  reads are URLSearchParams-based, so the node tests that import loop.js helpers see flag-off by
  default; the 3D pipeline tests that drive `dispatchOne` are re-run with a window/location
  shim setting `?unifiedDispatch=on`): `test_phase7_4b_entity_pipeline.mjs`,
  `test_phase7_batch9_entity_lifecycle.mjs`, `test_a15_q1_entity_buffer_caps.mjs`,
  `test_a15_q2_entity_update_clone.mjs` — all must pass unchanged.

### 1070-gated (parked until the box returns; ROADMAP Lane B "A15-Q3/Q4 spot-checks")

- 3D streaming walk (`?renderer=3d&unifiedDispatch=on`): login Holtburg → walk across ≥2
  outdoor landblock boundaries (no void tiles, statics/buildings/spawns populate, no console
  errors) → enter a building interior (envcells appear, no spawn-cell freeze — the :6087
  indoor pre-bake gate regression class) → `@teleloc` ring Academy↔Holtburg.
- 2D smoke (default URL `&unifiedDispatch=on`): sprites render, WASD moves, nameplates track,
  re-skin/attach still absent in 2D (the documented kinds-6-9 gap — now visible as the one-time
  console.info instead of silence).
- A/B byte-identity sanity: flag-off session shows zero behavior delta vs pre-Q4 build.
- SG-D regression class spot-check (3D, flag-on): equip/dye an item → re-skin lands; wield →
  attach lands (KIND_APPEARANCE/KIND_ATTACH route through the new table).

---

## 5. Risks + rollback

| risk | severity | mitigation |
|---|---|---|
| Streaming regression (void tiles, frozen player on spawn cell via missed wasm bakes — the :6084-6113 hoist rationale) | HIGH — this is the load-bearing constraint of the item | verbatim block move; dep injection preserves call order; invariant list §3 Q4.1; drift-guard test; flag default-off; legacy block retained |
| Neutral hooks double-run (worldStream/worldObjectManager firing in both the 2D drain AND the 3D hook) | MED | invariant: loop.js dispatcher gets EMPTY neutral table (§3 Q4.2); PART 1b asserts dispatcher runs only what it's given |
| `upd.free()` lifetime breakage (dispatch freeing or retaining wasm handles) | MED | dispatch never frees (Proxy test); `.free()` stays at drain tail both flag states |
| Split of handlePositionUpdate disturbs 2D local-snap/lerp (sprite half :6220-6337) | LOW | sprite half untouched; split seam is the existing comment boundary :6216-6219 |
| Backlog-replay clones (plain JS, not wasm handles) hitting the new arms | LOW | arm bodies moved verbatim keep their `?? 0` tolerance; Q2's unified clone already superset-covers fields (entity_update_clone.js header) |
| Same-file collision with in-flight A8-M3 / A1-O4 / A11-S3 | MED (process) | serialize per ROADMAP §3 loop.js row; §3.6 contingency |
| Service-worker stale-cache serving old index.html with new modules (or vice versa) | LOW | runtime cache is fetch-through (service-worker.js:67); same exposure as every prior JS-live wave (Q1/Q2 shipped identically) |

**Rollback:** per-stage `git revert` (modules are additive; index.html/loop.js diffs are
flag-scoped), or instant runtime rollback by dropping `?unifiedDispatch=on` (default-off).
No wasm artifact, no manifest state, no migration.

---

## 6. OPEN QUESTIONS

1. **Flag-name seam with A8-M3:** A15 §4 prescribes `?unifiedDispatch` for Q4; A8 §4 Stage M3
   prescribes `?unifiedEntityDispatch` for the kind-17 move. Recommend M3 rides
   `?unifiedDispatch` (one seam, one flag) — needs the A16/orchestrator ruling since M3's spec
   is another agent's deliverable.
2. **3D has no KIND_META_REFRESH (kind 3) arm** — `dispatchOne` (loop.js:2025-2234) handles
   kinds 0,1,2,4,5,6,7,8,9 only, while the 2D arm routes kind 3 to `handleEntityMetaRefresh`
   (index.html:10708). Whether the 3D backend SHOULD consume kind 3 (portal-destination meta →
   3D affordances) is a single-cited gap (no retail-vs-ours dual cite established for the 3D
   miss being wrong); Q4 keeps the table slot empty for the 3D backend and surfaces it via the
   one-time accounting info. Follow-up item, not in scope.
3. **Stale 2D rubberband-skip citation** (A15 §6): loop.js:396-398 cites "index.html:4191-4214"
   which has rotted; the live skip is inside `handlePositionUpdate`'s sprite half
   (index.html:6254-6298 at read-HEAD). Q4 does not move that code, but the comment fix could
   ride Q4.3 — needs nothing more than the corrected range above; flagging because I did not
   re-verify loop.js:396 still carries the rotten cite at read-HEAD (line drift).
4. **Module placement:** scene3d/ chosen per the Q2 precedent (entity_update_clone.js — a
   renderer-neutral module already living there). If the orchestrator prefers an honest
   `shared/` directory, it is a pure `git mv` + two import-path edits, but breaks the
   one-directory convention every existing test/static-server assumption uses. Decision made
   (scene3d/), recorded here in case A16 wants the relabel.
5. **`?netDrainHz` / `?renderOnDemand` interaction** (A1 §6): under A1-O4 the drain core must be
   drivable off the netDrainHz interval with rendering paused. Q4's modules are window-free and
   accept that re-hosting, but the O4-side contract ("full contract minus render") is O4's
   not-yet-designed surface — explicitly NOT solved here.
6. **Laptop-only backlog docs** (A15 §6 dedupe gap): rows 1/7 tracking status against
   `~/out/bughunt86-*` / `grind-loop-2026-06-11.md` remains unverifiable from this buildbox;
   if those docs already track the streaming-ownership inversion under an F/B/G ID, the commit
   message should cite it — human re-grep still pending (ROADMAP §6 caveat).
