# A8 cell-visibility-maint — unification survey

Scope: retail `CObjectMaint` (known-object tables, destruction timers, lost cells, visible-object
list), `CellManager` (cell prefetch), `DetectionManager`, vs our entity lifecycle + visibility
gating across holtburger-world (Rust), the wasm bridge, and scene3d (JS).

## 1. Retail map

Retail separates three axes, each with ONE owner:

| axis | owner | mechanism |
|---|---|---|
| KNOWN | `CObjectMaint` object/weenie tables | `AddObject`/`DeleteObject`, decl block `acclient.c:6135-6173`; `DeleteObject(CPhysicsObj*)` body `acclient.c:309918-309936` = `exit_world` + `leave_world` + remove from object/null/destruction tables + `unset_parent` + `unparent_children` |
| VISIBLE (radar/1Hz) | `CObjectMaint::visible_object_table` | `UseTime` rebuilds it once per second: `acclient.c:310239-310243` (`Timer::cur_time - last_radar_update > 1.0` → `UpdateVisibleObjectList`); `UpdateVisibleObjectList` body `acclient.c:309849-309903` iterates `object_table` and adds objects with a live cell pointer and a state bit clear (`:309880-309883`) |
| DRAWN | cell membership + render pipeline | objects live in `CObjCell`s; cell transit decides what is drawable (A6's scope); draw-state bits (HIDDEN/NO_DRAW/CLOAKED) gate per object |

Per-frame / per-event call order:

1. **`CObjectMaint::UseTime`** (`acclient.c:310206-310380`), fired from the CPhysics spine (A1):
   a. 1Hz visible-list rebuild (`:310239-310243`);
   b. drain `object_destruction_queue` (a PQueue of `(destruction_time, object_id)`): every
      expired entry is removed from `destruction_object_table` and destroyed via vtable call
      (`:310246-310278`);
   c. null-object + null-weenie tables: any placeholder older than 20s re-pings the server with
      `Proto_UI::SendForceObjdesc(id)` and re-stamps (`:310302-310308`, `:310353-310359`).
2. **Destruction timers**: `AddObjectToBeDestroyed` sets `destruction_time = cur_time + 25.0`
   (`acclient.c:310651-310672`, the 25.0 at `:310666`) and inserts into both the hash table and
   the PQueue. `RemoveObjectToBeDestroyed` (`acclient.c:309906-309915`) cancels.
3. **Who schedules destruction**: the SmartBox object-create/position path — an object that ends
   up with **no cell** (left the loaded area, or pos-less) is put on the 25s timer; an object
   that regains a cell is taken off it (`acclient.c:146087-146101`: `object->cell ?
   RemoveObjectToBeDestroyed : AddObjectToBeDestroyed`).
4. **Null objects (message-before-create buffering)**: `GetNullObject(id, create=1)` makes a
   placeholder CPhysicsObj, files it in `null_object_table`, and puts it on the 25s destruction
   timer (`acclient.c:310675-310716`, timer at `:310712`); `QueueBlobForObject` parks netblobs on
   the placeholder (`acclient.c:310848-310860`). Same pattern for weenies
   (`:310720-310762`, `:310863-310885`). Combined with UseTime's 20s SendForceObjdesc ping, this
   is retail's complete out-of-order-message recovery: buffer + nag + expire.
5. **Lost cells**: an unparented object whose target cell isn't loaded goes into a per-cell
   `CLostCell` bucket (`GotoLostCell`, `acclient.c:309733-309756`); when the cell loads,
   `InitObjCell` pops the bucket and calls `CPhysicsObj::reenter_visibility` on every parked
   object (`acclient.c:309759-309784`).
6. **CellManager** (client-side cell streaming): `ChangePosition` re-prefetches when the load
   point moves (`acclient.c:146646-146683`), `PreFetchCells` (`:146528`) with a blocking option,
   `CheckPrefetchStatus`/`UpdateLoadPoint` polled per frame (`acclient.c:146270-146278`).
7. **DetectionManager**: wire-driven detection cylspheres — `ReceiveDetectionUpdate`
   (`acclient.c:327243`), `CheckDetection` (`:327021`), global detection report path
   (`:327395`). Niche (admin/quest detection volumes).

## 2. Ours map

| responsibility | Rust | JS (scene3d) |
|---|---|---|
| canonical lifecycle (KNOWN + retention + eviction) | `crates/holtburger-world/src/state/liveness.rs` — retention snapshot `:251-281`, `should_evict_entity` `:294-308`, `sweep_eviction_queue` `:332-337`, `tick()` `:379-386` (sweep + prune deadlines); 25s prune constant `:11` (`ACE_DESTRUCTION_TIMEOUT_SECS = 25.0`); `upsert_entity_from_create` `:388-419`; canonical wire entry `crates/holtburger-world/src/handlers/inventory.rs:35` (create), `:53` (delete) | — |
| who actually runs `tick()` | **cli only**: `crates/holtburger-core/src/client/runtime.rs:185` (`self.world.tick()` on the physics tick) | — |
| wasm lifecycle (parallel copy) | `apps/holtburger-web/src/lib.rs:21913-22019` `should_route_message_to_world` deliberately EXCLUDES ObjectCreate/ObjectDelete/ParentEvent/PickupEvent (spatial `unreachable` panic, per its doc comment); replicated subset: `apply_inventory_object_create` / `apply_inventory_object_delete` invoked at `lib.rs:31096-31111`; rig events emitted by separate arms: KIND_SPAWN `lib.rs:32530`, ObjectDelete→KIND_REMOVE `lib.rs:33247-33291`, PickupEvent→KIND_REMOVE `lib.rs:33291+` | rig removal `scene3d/entities.js:6823-6900` (`remove()`: spawn-gen bump, target clear F16-4, child detach, pending-map purges, dispose); dispatched from `scene3d/loop.js:2003-2009` (`dispatchOne` KIND_REMOVE) **and** the older direct-drain arm `loop.js:1750-1757` |
| VISIBLE (radar-list analog) | `liveness.rs:116-135` `current_visible_world_guids` (landblock adjacency via `spatial/scene.rs:2340 get_nearby_entities` + 384 m fallback, `liveness.rs:12,152`); explicit non-parity TODO `liveness.rs:137-144` | — |
| DRAWN — server draw gate | `crates/holtburger-world/src/entity.rs:959-963` `should_draw()` (HIDDEN\|NO_DRAW\|CLOAKED); kind=17 emits: canonical `liveness.rs:412-419` (spawn-hidden) + wasm mirror `lib.rs:30144-30165` & `:32748-32760` | `index.html:9990-10014` kind=17 handler → `entityManager.setVisibility` → `entities.js:3641-3664` → `_setEntityStateVisible` `entities.js:1149-1153` |
| DRAWN — render cull | — | composite single-writer `_applyEntityVisible` `entities.js:1140-1146` (`stateVisible && !renderCullHidden`); frustum/distance cull `entities.js:1231+` `tickEntityRenderVisibility`, called from `loop.js:63` registry |
| DRAWN — cell visibility (PVS) | wasm exports `getRenderSet` / `getRenderSetWithFrustum` / `getRenderSetWithPView` (consumed below) | `scene3d/cells.js:792-983` `tickCellVisibility3D` (frustum∪PView render set → per-cell `container.visible` diff), called at `loop.js:1301`; PVS load expander `cells.js:984+` |
| CellManager analog (streaming) | — | `cells.js:984+` `tickPvsLoadExpansion` (lazy ring loads); `scene3d/landblock_lru.js:21-24` LRU eviction of LB containers + disposables |
| lost cells | none (`grep lost_cell\|LostCell` over crates/ + scene3d/ → 0 hits) | partial ad-hoc analogs: `_pendingAttach` (`entities.js:3014` area), `_pendingVisibility` (`entities.js:3647-3651`) — per-event-kind queues keyed by guid, not a cell-keyed park-and-reenter |
| DetectionManager | none (`grep -rn Detection crates/holtburger-protocol crates/holtburger-world` → only an unrelated collision-book citation, `spatial/physics.rs:1331`) | none |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | one lifecycle owner vs three parallel copies: world-crate canonical handlers (cli), wasm replicated subset, wasm rig-event arms — wasm path never runs `upsert_entity_from_create`/`sweep` | `CObjectMaint` decl `acclient.c:6135-6173`; single `DeleteObject` funnel `:309918-309936` | `lib.rs:21913-22019` (routing exclusion + rationale); `lib.rs:31096-31111` vs `inventory.rs:35,53`; rig arms `lib.rs:33247,33291` | SPLIT-BRAIN (3 Rust sites + 2 JS dispatch arms `loop.js:1750`/`:2003`) | lifecycle fixes land in one copy and regress in another (the KIND_APPEARANCE drop documented at `loop.js:2158-2167` was exactly this) | partially: F16-1/F16-2 touched it (movement-combat bughunt raw 2026-06-09); routing exclusion itself untracked |
| 2 | out-of-visibility destruction: retail puts cell-less objects on a 25 s timer and cancels on cell re-entry; our web path removes rigs ONLY on explicit ObjectDelete/PickupEvent — `EntityDespawned` is consumed as an inventory-refresh hint, never a KIND_REMOVE; `world.tick()` (which would expire the 25 s prune) never runs on wasm | `acclient.c:146087-146101`; `acclient.c:310651-310672` (+25.0 at `:310666`) | `lib.rs:30681-30691` (EntityDespawned → `inventory_changed` only); `runtime.rs:185` (tick is cli-only); 25 s parity constant exists but is dead on wasm: `liveness.rs:11,186` | MISSING (web) | rigs for creatures/players that walked far out of range persist for the whole session (memory + draw cost + stale radar/nameplates) | untracked |
| 3 | message-before-create buffering: retail null-objects park netblobs for unknown guids, nag server every 20 s (SendForceObjdesc), expire at 25 s; ours has per-kind ad-hoc pending maps (attach, visibility) and drops everything else | `acclient.c:310675-310716`, `:310848-310860`, 20 s ping `:310302-310308` | `entities.js:3647-3651` (`_pendingVisibility`), `entities.js:3014` area (`_pendingAttach`); no generic buffer (no other `_pending*` consumers of unknown-guid updates in `dispatchOne` `loop.js:1997-2206`) | DIFF-ALGO | out-of-order wire bursts (spawn races) silently drop updates that aren't one of the two specially-handled kinds; each new race is fixed with another bespoke map | pattern instances shipped as F16-5 (spawn-hidden queue); generic mechanism untracked |
| 4 | lost-cell park-and-reenter (`GotoLostCell` → `InitObjCell` → `reenter_visibility`) | `acclient.c:309733-309784` | no equivalent: grep `lost_cell|LostCell|lost cell` over `crates/` + `scene3d/` → 0 hits; rigs spawn at world coords regardless of LB/cell load state (`entities.js:2269 spawn`) | MISSING | entities in not-yet-loaded cells render floating over unloaded ground instead of being parked until the cell exists | untracked |
| 5 | VISIBLE list algorithm: retail = "has live cell pointer" per object, 1 Hz; ours = landblock-adjacency ∪ 384 m radius, self-described conservative approximation | `acclient.c:309849-309903` (gate `:309880-309883`), 1 Hz at `:310239-310243` | `liveness.rs:116-154` + TODO `:137-144`; constant `:12` | DIFF-ALGO | over-retention (never under): prune deadlines set later than retail would; radar-style consumers see too many entities | tracked by the in-code TODO `liveness.rs:137` |
| 6 | draw-gate event routing: kinds 0–9 dispatch via scene3d `dispatchOne`, but the visibility event (ClientEvent kind=17) routes through the index.html 2D drain into the 3D manager | retail: one owner — state bits live on the object, no cross-renderer hop (HIDDEN gate fed from `SmartBox::DoSetState` `acclient.c:146067`) | `loop.js:1997-2206` (no kind-17 arm) vs `index.html:9990-10014` | SPLIT-BRAIN (2 dispatch layers) | 3D-only sessions depend on the 2D page's drain loop for correctness of hide/show; A15's quarantine plan would break it | untracked; seam with A15 |
| 7 | CLOAKED → hard hide vs retail translucent shimmer | (retail renders cloaked semi-transparent — see tracked audit item; retail draw-state enum `acclient.h` PhysicsState) | `entity.rs:959-963` folds CLOAKED into the hide gate | DIFF-ALGO (low) | admin/rare content invisible instead of shimmering | tracked: unsurfaced-render-audit 2026-06-09 item 3 (`~/out/holtburger-unsurfaced-render-audit-2026-06-09.md:186`) |
| 8 | outdoor building-portal stab-list PVS (BuildInfo.portals) parsed but unconsumed | retail cell/stab reveal ordering (cell transit, A6 scope) | tracked audit item: `~/out/holtburger-unsurfaced-render-audit-2026-06-09.md:188` (`landblock.rs:23-48` parsed, never consumed) | MISSING (low) | doorway view-clipping absent; masked by frustum+PView | tracked: audit item 4 |
| 9 | DetectionManager (wire detection cylspheres) | `acclient.c:327243` `ReceiveDetectionUpdate`, `:327021` `CheckDetection` | no handler: grep `Detection` over `crates/holtburger-protocol/src`, `crates/holtburger-world/src` → 0 relevant hits | MISSING (low) | unknown-opcode drop if ACE ever sends it (ACE rarely does) | untracked |
| 10 | LB LRU eviction of cell containers (retail releases cells on transit, no LRU memory cap) | `CellManager::Reset`/transit release (`acclient.c:146609`, `:144271-144301`) | `landblock_lru.js:21-24` | EXTRA | deliberate web-memory adaptation; re-entry re-bakes; no PVS-contraction for buildings (`buildings.js:1152-1162`) | building leak tracked in `buildings.js:1152` comment (C5 criterion) |

**Parity confirmations (no work):** 25 s destruction constant matches retail
(`liveness.rs:11` ↔ `acclient.c:310666`). Spawn-hidden draw gate matches retail's
state-driven hide (`liveness.rs:412-419` + `lib.rs:32748-32760` ↔ `SmartBox::DoSetState`
`acclient.c:146067`; shipped F16-5, eye-tested 2026-06-10 per `lib.rs:30163`). The
state-visible × render-cull composition having a SINGLE writer (`entities.js:1140-1146`)
answers the roster's conflation question for the JS side: **we do NOT conflate visible/drawn
in JS** — the two axes are explicit and composed at one site. The conflation problem is
upstream: KNOWN-ness has no single owner (row 1).

## 4. Staged unification plan

Target shape: `holtburger-world` `liveness.rs` becomes the one CObjectMaint-equivalent for both
cli and wasm; JS keeps exactly one lifecycle dispatcher.

- **Stage M1 — route lifecycle messages to the world crate on wasm.**
  Scope: root-cause and fix the wasm spatial `unreachable` (documented `lib.rs:21917-21920`),
  then add `ObjectCreate`/`ObjectDelete`/`PickupEvent`/`ParentEvent`/`InventoryRemoveObject` to
  `should_route_message_to_world` and emit KIND_SPAWN/KIND_REMOVE from the resulting
  `WorldEvent::EntitySpawned/EntityDespawned` instead of the bespoke arms at `lib.rs:32530/33247/33291`.
  Files: `apps/holtburger-web/src/lib.rs`, `crates/holtburger-world/src/spatial/*`,
  `crates/holtburger-world/src/handlers/inventory.rs`.
  Flag: `?worldLifecycle=on` (default-off; off = current bespoke arms). wasm-rebuild.
  Tests: headless-now — existing `state/tests.rs` lifecycle tests (e.g. `:2912`) plus a wasm-side
  parity assertion that bespoke-arm and routed-path event streams match on a recorded session.
  Rollback: flag off.
- **Stage M2 — run the maint tick on wasm.**
  Scope: call `world.tick()` (`liveness.rs:379-386`) from the wasm physics/frame tick (mirror
  `runtime.rs:185`), and translate `EntityDespawned` into KIND_REMOVE (closing row 2: 25 s
  out-of-visibility prune now reaches rigs). Depends on M1.
  Files: `lib.rs` tick site; no JS change (KIND_REMOVE already handled `loop.js:2003`).
  Flag: `?maintPrune=on` (default-off). wasm-rebuild.
  Tests: headless-now — drive a synthetic session where an entity leaves the 384 m/adjacency set
  and assert a KIND_REMOVE after 25 s sim-time; 1070-gated — walk-away/walk-back soak (no pop-in
  regressions, re-create on return works via fresh ObjectCreate).
  Rollback: flag off.
- **Stage M3 — one JS lifecycle dispatcher.**
  Scope: move the kind=17 handler (and any other rig-affecting ClientEvent) out of
  `index.html:9990` into the scene3d dispatch layer next to `dispatchOne` (`loop.js:1997`), and
  delete/quarantine the dead direct-drain KIND arms (`loop.js:1750-1757` et seq.) so exactly one
  copy exists. Coordinate with A15 (this is the per-subsystem instance of its unified
  message→handler plan).
  Files: `scene3d/loop.js`, `index.html` (removal only). Flag: `?unifiedEntityDispatch=on`;
  JS-live. Tests: headless-now — node-side dispatch unit test (hide/show ordering vs spawn race
  using `_pendingVisibility`); 1070-gated — login-bubble hide, door/cloak toggles.
  Rollback: flag off (index.html handler retained until flag graduates).
- **Stage M4 — generic pre-create buffer (null-object analog).**
  Scope: replace per-kind `_pendingAttach`/`_pendingVisibility` maps with one
  `pendingByGuid: Map<guid, Event[]>` drained on spawn-commit, with a 25 s expiry (retail
  `acclient.c:310666`) and an optional ForceObjdesc-style re-request hook (server support
  permitting; ACE may not honor it — mark UNRESOLVED below).
  Files: `scene3d/entities.js`. Flag: `?preCreateBuffer=on`; JS-live.
  Tests: headless-now — replay a shuffled event order and assert convergence. Rollback: flag off.
- **Deliberately NOT staged:** lost-cell park-and-reenter (row 4 — small payoff until streaming
  changes; revisit with A6's cell-transit work), DetectionManager (row 9 — wait for a real wire
  capture), CLOAKED shimmer (row 7 — already tracked, A10's material domain).

## 5. Scores

- Leverage: subsumes the `liveness.rs:137` visibility TODO; closes the F16-1/F16-2 family's root
  cause (bespoke wasm lifecycle arms); M3 is a concrete down-payment on A15's dispatcher
  unification; M4 generalizes the F16-5 pattern.
- Regression-risk reduction: **H** — row 1 is a three-copy split-brain on the highest-traffic
  message family (every spawn/despawn in the game).
- Implementation risk: **M** — M1 hinges on the un-diagnosed wasm spatial `unreachable`
  (`lib.rs:21917`); M2/M3/M4 are L individually but M2 depends on M1.
- 1070-dependency: M1 headless-verifiable; M2/M3 each have a 1070-gated eye-test step; M4
  headless.
- Depends-on: A1 (where in the frame the wasm `world.tick()` should fire to match retail's
  UseTime ordering); A15 (M3 seam); A6 owns cell-transit/which-cell semantics (rows 4, 8
  deferred there). Not movement-Stage-1-gated.

## 6. SPECULATIVE / UNRESOLVED

- `UpdateVisibleObjectList`'s exact per-object gate (`acclient.c:309880-309883` tests
  `v4[12].vfptr` and `v4[14].vfptr & 1` on hash-iterated CPhysicsObj fields) — I read these as
  "cell pointer non-null" and "a state/hidden bit clear" from struct offsets, but did not confirm
  the field identities in `acclient.h`. Single-cited; treat the row-5 retail algorithm as
  "cell-pointer based" with that caveat.
- Whether ACE responds to a client `ForceObjdesc` request (needed for the optional M4 nag): not
  checked against `../ACE`; greps tried: `SendForceObjdesc` (client side found,
  `acclient.c:310308`); server side unverified.
- The exact reason the world-crate spatial path panics under wasm ("some spatial preconditions
  aren't met", `lib.rs:21918-21920`) — load-bearing for M1, needs a dedicated diagnosis; no
  citation to the panicking line itself.
- Backlog doc `~/out/bughunt86-combat-render-loop-items-2026-06-09.md` (the §3.3 F/B-item source)
  does not exist on this box; F16-x IDs were confirmed instead from
  `~/out/movement-combat-render-bughunt-2026-06-09.raw.json` and in-code comments
  (`entities.js:6836`, `lib.rs:30145`).
