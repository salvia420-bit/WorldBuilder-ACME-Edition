# A15 dual-renderer-seam — unification survey

Date: 2026-06-11 · Agent: A15 · Scope: `index.html` 2D PIXI path vs `scene3d/` 3D path
(holtburger-internal; per §5 the retail-cite rule is waived — "dual-citation" here means citing
BOTH renderer paths). All paths repo-relative to
`apps/holtburger-web/` unless prefixed.

## 1. Retail map (waived — seam topology instead)

Retail has one renderer; this seam is holtburger-internal. The topology that replaces the retail
map:

- **`index.html` is the host page for BOTH renderers.** `?renderer=3d` switches
  (`docs/url-flags.md:65` — default is **2D PIXI**; `index.html:6845-6847` is the gate;
  `index.html:6863` dynamic-imports `scene3d/index.js`).
- **The wire drains live in `index.html` in both modes.** `drainEvents()` (`index.html:8974`)
  polls `handle.poll_events()` (game events, `evt.kind` 0–55, `index.html:8990-10516`) and
  `handle.pollEntityUpdates()` (entity updates, `upd.kind`, `index.html:10525`). The 2D loop owns
  the wasm-bindgen `.free()` lifetime (`index.html:10599`).
- **3D consumes entity updates second-hand** via `window.__scene3dEntityHook?.(entityUpdates)`
  (`index.html:10535`), whose live implementation is `dispatchOne` installed by
  `installSharedDrainHook` (`scene3d/loop.js:1997-2206`, hook assignment `loop.js:2234-2249`,
  `scene3d.useSharedDrain = true` at `loop.js:1985`).
- **3D consumes game events** via `window.__pluginClient.events.emit(...)` bridges inside the
  index.html arms (e.g. PlayEffect kind=30 → `index.html:9418-9424` →
  `scene3d/play_effect_vfx.js`).
- **World streaming for the 3D path is driven by a 2D handler**: `handlePositionUpdate`
  (`index.html:5984`) calls `window.liveScene3d.loadEnvCellsForLandblock /
  loadTerrainForLandblock / loadBuildingsForLandblock / loadStaticsForLandblock /
  loadSpawnsForLandblock` (`index.html:6064-6113`) plus the wasm physics bakes
  (`index.html:6042-6063`).

## 2. Ours map

| concern | 2D path (index.html) | 3D path (scene3d/) |
|---|---|---|
| game-event drain (evt.kind 0–55) | `drainEvents` for-loop `index.html:8990-10516` (single owner) | consumed via plugin-bus bridges only (e.g. `index.html:9418-9424`) |
| entity-update dispatch (upd.kind) | for-loop `index.html:10536-10599`, kinds 0–5 only → `handlePositionUpdate` :5984, `handleEntitySpawn` :5494, `handleEntityRemove` :6252, `handleEntityMetaRefresh` :6335, `handleEntityVelocity` :6480, `handleEntityMotion` :6514 | TWO arms: live `dispatchOne` `loop.js:1997-2206` (kinds 0–9); dead-in-live-mode direct arm `drainEntityEvents3D` `loop.js:1701-1984` (early-returns under `useSharedDrain`, `loop.js:1714`; still used by the standalone capture path, `loop.js:1690-1699`) |
| EntityUpdate field-schema copies | `metaFromSpawn` (`index.html:3383`, per `loop.js:1615` cross-ref), `cloneEntitySpawn` `index.html:4550`, `__scene3dCloneEntityUpdate` `index.html:4464-4506` | `toMeta` `loop.js:1620-1677`; canonical source = wasm `EntityUpdate` getters (`crates/holtburger-session/src/lib.rs` per `loop.js:69-71`) |
| pre-renderer buffering | `deferredSpawns` `index.html:4549`, push `:10548`, drain gated on `liveScene` `:10605-10608` | `window.__scene3dEntityBacklog` `index.html:4463`, buffering stub `index.html:4520-4531`, drained+replaced by `installSharedDrainHook` `loop.js:2251-2260` |
| local-player prediction | rAF integrator writing `sprite.x/.y` `index.html:10669-10679` (mirrors `crates/holtburger-core/src/client/movement/common.rs:203-262` per its own comment) | `cameraSwitcher.predictedPlayerPos` (Workstream B, `loop.js:431-436`) + wasm integrator pose `applyLocalPlayerPoseFromIntegrator` `loop.js:1561` |
| local-player server-snap skip | inside `handlePositionUpdate` (loop.js:396-398 cites it as "index.html:4191-4214" — that citation has rotted, see §6) | `isLocalPlayerGuid` helper `loop.js:407-418` used by both 3D arms (`loop.js:1771`, `:2051`) |
| world streaming | `handlePositionUpdate` local-player block `index.html:6027-6113` — serves BOTH renderers | none of its own; depends on the 2D handler above |

## 3. Divergences

Dual-citation = both renderer paths cited. `tracked?` is best-effort: the §3.3 `~/out` backlog
docs are on the laptop and absent on this buildbox (see §6), so tracking status is inferred from
in-code backlog markers (F4-3, B9, SG-B, SG-D, F3-3, G-5 annotations in loop.js).

| # | behavior | 2D cite | 3D cite | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | Entity-update kind dispatch implemented 3× (2D arm; dead 3D direct arm; live 3D dispatchOne), hand-mirrored by comment discipline ("mirror the direct-drain arm", loop.js:2099) | index.html:10536-10599 | loop.js:1701-1984 (dead) + loop.js:1997-2206 (live) | SPLIT-BRAIN (3 sites) | Proven regression class: KIND_APPEARANCE existed ONLY in the dead arm, so wire-driven re-skins were dropped for every entity until SG-D ported it (loop.js:2158-2167) | SG-D fixed the instance; the structural 3-site split is untracked |
| 2 | EntityUpdate field schema hand-copied ~5× (wasm getters → toMeta, metaFromSpawn, cloneEntitySpawn, __scene3dCloneEntityUpdate) | index.html:4464-4506, :4550, :3383 | loop.js:1620-1677 | SPLIT-BRAIN (5 sites) | Backlog clone already misses fields the live dispatcher reads: no `isAutonomous` (read at loop.js:2098 → replayed motions misclassify as server-FORCED) and no `physicsTranslucency` (read at loop.js:1642 → translucency lost on backlog-replayed spawns) | untracked |
| 3 | 3D mode: 2D `deferredSpawns` grows unbounded — every KIND_SPAWN is cloned+pushed when `liveScene` is null, and under `?renderer=3d` liveScene is PERMANENTLY null | index.html:10545-10548 (push), :10605 (drain gate), :5660-5662 ("liveScene is PERMANENTLY null" under 3d) | loop.js:2001-2002 (3D handles the same spawn via em.spawn) | EXTRA (2D does work 3D already did) | Slow memory growth per spawn churn in 3D sessions; clones never drained | untracked |
| 4 | 2D mode: `__scene3dEntityBacklog` grows unbounded — the buffering stub is installed unconditionally at module scope and is only ever replaced by `installSharedDrainHook`, which runs solely on the 3D init path; the index.html:10532-10534 comment "the hook is undefined when ?renderer=3d isn't present" is stale | index.html:4463, :4520-4531 (unconditional stub; no cap, no renderer gate — verified no `if (renderer…)` in :4455-4535) | loop.js:2251-2260 (the only drain/replace, 3D-only) | EXTRA / leak | In pure-2D sessions every entity update ("100s/sec in a populated zone", index.html:10520) is deep-cloned (incl. Uint32Array copies) into an array that is never drained | untracked |
| 5 | Kinds 6–9 (APPEARANCE / ATTACH / MOTION_ACTION / TURN) are 3D-only; the 2D arm has no else-branch and silently frees them | index.html:10536-10599 (arms end at kind===5; :10599 free) | loop.js:2158 (6), :2186 (7), :2138 (8), :2151 (9) | MISSING (in 2D) | In 2D mode: no mid-game re-skins, no wielded-item attach, no one-shot action motions, no TurnTo — divergence grows with every new wasm kind | by-design drift, undocumented |
| 6 | Two independent local-player prediction implementations (plus the Rust integrator) | index.html:10669-10679 (rAF integrator, mirrors common.rs:203-262) | loop.js:431-436 + :1561 (Workstream-B predictedPlayerPos + wasm integrator pose) | SPLIT-BRAIN (3 sites incl. Rust) | A movement fix in one path does not propagate (e.g. B9 local-gait skip semantics re-implemented per arm: index.html ~10207 per loop.js:2090-2092 vs loop.js:2089-2108) | partially — B9/SG-B markers in loop.js; cross-path structure untracked |
| 7 | 3D world streaming is owned by a 2D-named handler: `handlePositionUpdate` drives liveScene3d.load* + wasm physics bakes for both renderers | index.html:6027-6113 | scene3d has no streaming trigger of its own (loadTerrainForLandblock etc. are exports on `window.liveScene3d`, called only from index.html:6078-6113) | SPLIT-BRAIN (ownership inversion) | "Quarantine the 2D path" cannot mean delete it: removing the 2D handler kills 3D terrain/buildings/statics/spawns/envcell streaming | untracked |
| 8 | Game-event drain (evt.kind 0–55) has a single owner | index.html:8990-10516 | bridges only (e.g. :9418-9424 playEffect → scene3d/play_effect_vfx.js) | PARITY | none — this half of the seam is already unified; keep it that way | n/a |

## 4. Staged unification plan

Recommendation between the two §5 options: **quarantine the 2D path + extract a small shared
dispatch core** is cheaper than full backend unification. The genuinely duplicated surface is
only kinds 0–5 (row 5 shows 2D already stopped tracking new kinds); a sprite-backend port of
kinds 6–9 would be new work with no strategic payoff. The expensive, load-bearing parts of
index.html (wire drain, plugin bus, world streaming, row 7) are renderer-NEUTRAL and should be
relabeled as such, not duplicated into scene3d.

- **Stage Q1 — bound the two leaks** (rows 3, 4). Scope: cap `deferredSpawns` and
  `__scene3dEntityBacklog` (ring buffer, keep-latest-N≈512 with one-time console.warn on
  overflow); gate `deferredSpawns.push` on `!useRenderer3d`; fix the stale :10532 comment.
  Files: `index.html` only. Flag: none needed for the caps (pure bound, behavior-preserving);
  the `!useRenderer3d` spawn-defer gate behind `?spawnDefer2dOnly=on` (default-off) per
  url-flags.md style. JS-live. Tests: headless-now (node test driving the stub with >cap synthetic
  updates; assert length bound). Rollback: flag off / revert caps.
- **Stage Q2 — one clone schema** (row 2). Scope: extract `entity_update_clone.js` exporting a
  single `cloneEntityUpdate(upd)` (superset of toMeta + __scene3dCloneEntityUpdate fields, incl.
  `isAutonomous`, `physicsTranslucency`, `motionSpeed`); `toMeta`, the backlog stub, and
  `cloneEntitySpawn` all consume it. New module shape: pure function, no DOM/wasm imports.
  Flag: `?unifiedClone=on` (default-off; off = old per-site clones). JS-live. Tests:
  headless-now (field-parity unit test diffing old clones vs new over a synthetic EntityUpdate
  with every field set). Rollback: flag off.
- **Stage Q3 — retire the dead 3D direct-drain arm** (row 1). Scope: make the standalone
  capture/`pollEntityUpdates`-direct path (`loop.js:1701-1984`) call `dispatchOne` per update
  instead of carrying a hand-mirrored copy; keep `drainEntityEvents3D` as a thin
  poll-loop wrapper. Files: `scene3d/loop.js`. Flag: `?legacyDirectDrain=on` keeps the old arm
  reachable (default-off = unified). JS-live. Tests: headless-now (`test_phase7_4b_entity_pipeline.mjs`,
  `test_phase7_batch9_entity_lifecycle.mjs` exercise the capture path); 1070-gated: one in-world
  spot-check that re-skins/attach still land (the SG-D regression class). Rollback: flag on.
- **Stage Q4 — relabel + extract the renderer-neutral core** (row 7). Scope: move the
  local-player streaming block (`index.html:6027-6113`) and the entity-update for-loop
  (`:10536-10599`) into a `world_stream.js` + `entity_dispatch.js` pair with explicit backends:
  `dispatch2D` (kinds 0–5, present sprite handlers) and `dispatch3D` (= dispatchOne). The 2D
  backend is then formally QUARANTINED: documented frozen, new kinds 3D-only by policy, guarded
  by the existing tests only. Files: `index.html`, `scene3d/loop.js`, new `entity_dispatch.js`,
  `world_stream.js`, `docs/url-flags.md` entry. Flag: `?unifiedDispatch=on` (default-off).
  JS-live. Tests: headless-now (existing entity-pipeline mjs suite both flag states);
  1070-gated: eye-test 3D unchanged, brief 2D smoke (default URL still renders sprites).
  Rollback: flag off.

Ordering: Q1 → Q2 → Q3 → Q4. Q1/Q2 are independent of all other agents' plans; Q3/Q4 touch
`scene3d/loop.js` and must serialize with any A1/A4/A5 plan that restructures the frame loop
(flag for A16's conflict matrix).

## 5. Scores

- Leverage: subsumes the SG-D regression class (row 1) and two untracked leaks (rows 3–4);
  prevents recurrence of dropped-kind bugs every time a new EntityUpdate kind ships. Backlog IDs
  subsumed: none verifiable from this host (laptop-only docs, §6); SG-D cited as the shipped
  instance of the class.
- Regression-risk reduction: **H** for the entity-update seam (3-site dispatch + 5-site schema is
  the top split-brain found); **L** for game events (already unified, row 8).
- Implementation risk: **L–M** — JS-only, all JS-live, every stage flag- or revert-rollbackable;
  Q4 is the only structural move.
- 1070-dependency: **N** for Q1/Q2 and all headless tests; **Y** only for the Q3/Q4 in-world
  spot-checks (tagged 1070-gated above).
- Depends-on: nothing in movement Stage 1 (this seam is upstream of it); A16 must serialize Q3/Q4
  with other `loop.js`-touching plans. The A2/A14 prediction-funnel work would later absorb
  row 6 — flagged as their seam, not planned here.

## 6. SPECULATIVE / UNRESOLVED

- **Dedupe gap**: `~/out/bughunt86-…`, `~/out/grind-loop-2026-06-11.md`,
  `~/out/holtburger-motion-dispatch-coverage-2026-06-09.md` do not exist on this buildbox
  (`ugrep: No such file or directory`); tracked? column relies on in-code markers only. Rows 3,
  4, 7 may already appear under F/B/G IDs I could not read.
- **Stale cross-path line citation** (single-cited, evidence of seam rot): `loop.js:396-398`
  cites the 2D rubberband skip as "index.html:4191-4214", but that range now holds PIXI
  buildings-bundle code (verified by direct read of index.html:4185-4230). I did not relocate the
  current skip site inside `handlePositionUpdate` (search tried: `sed -n '4185,4230p'`, grep
  `rubberband`, function-body read of :5984-6113 covers only the streaming half).
- **Row 4 severity unmeasured**: the 2D-mode backlog leak rate is inferred from the
  index.html:10520 "100s/sec" comment, not measured (no browsers allowed, §2.8).
- **`motionSpeed` in the clone schema**: dispatchOne's KIND_MOTION_ACTION arm (loop.js:2138)
  likely reads a `motionSpeed` field absent from `__scene3dCloneEntityUpdate`
  (index.html:4464-4506 has no such key); I cited only the two confirmed misses
  (`isAutonomous`, `physicsTranslucency`) in row 2 and leave this one here pending a read of the
  :2138-2150 arm body.
- **Whether 2D is still exercised by users**: url-flags.md:65 says 2D is the default URL, but
  every capture/test harness in the repo passes `?renderer=3d`; if 2D has zero real traffic the
  Q4 quarantine could be tightened to a hard deprecation. Needs a human call, not a code cite.
