// 2026-05-21 — wire-agent mode (?wireframe=1) gate. Module-scope const
// matches the URL-parsing pattern other modules use. When true, the
// per-entity surface material at L977 swaps from MeshStandardMaterial
// (texture+PBR) to a shared MeshBasicMaterial({wireframe:true}) so
// entities render as wire silhouettes consistent with the rest of the
// scene in wire-agent mode. Shared reader: scene3d/wireframe_flag.js
// (accepts 1/on/true/yes). The try keeps import-stripping source-eval
// harnesses (no `wireframeFlagOn` binding) at the default (off).
import { wireframeFlagOn } from "./wireframe_flag.js";
const WIREFRAME_MODE = (() => {
  try {
    return wireframeFlagOn();
  } catch (_) { return false; }
})();

// 2026-06-30 — ground-clamp for placed objects ("appears above then sinks
// into the ground"). Retail does NOT trust the server/authored Z blindly:
// CTransition::find_placement_position → step_down (acclient.c) lowers an
// object's collision sphere onto the walkable terrain polygon. Our entity
// spawn pinned the raw authored Z with no clamp, so an OUTDOOR object whose
// authored Z falls below the rendered terrain surface (region-height/diagonal
// drift on modded data) is buried. `_groundClampZ` lifts a buried outdoor
// object back onto the surface — LIFT-BURIED-ONLY (never pulls a legitimately
// elevated object — signs, 2nd-floor items, flying mobs — down), BOUNDED (a
// gap larger than the cap is left alone — likely an intentional structure
// floor, not a sink), and OUTDOOR-ONLY (EnvCell interiors have no terrain
// height; `terrainHeightAt` returns undefined there anyway). `?groundClamp=off`
// disables → byte-identical legacy placement.
const GROUND_CLAMP_ON = (() => {
  try {
    if (typeof window === "undefined") return true;
    return new URLSearchParams(window.location.search).get("groundClamp") !== "off";
  } catch (_) { return true; }
})();
const GROUND_CLAMP_EPS = 0.1;        // ignore objects within 10 cm of the surface
const GROUND_CLAMP_MAX_LIFT = 10.0;  // bound: never lift more than 10 m (structure floors)

// Lift a buried OUTDOOR object onto the terrain surface; return the corrected
// Z (or the original `z` when no clamp applies). `cellIdx` is the low 16 bits
// of the landcell (>= 0x0100 ⇒ EnvCell interior ⇒ skip). Returns `z` unchanged
// when the flag is off, the cell is indoor, terrain isn't resolvable yet
// (`terrainHeightAt` → undefined), the object is at/above the surface, or the
// bury depth exceeds the bound.
function _groundClampZ(wx, wy, z, cellIdx) {
  if (!GROUND_CLAMP_ON) return z;
  if ((cellIdx & 0xffff) >= 0x0100) return z; // indoor EnvCell — no terrain
  const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
  if (!sh || typeof sh.terrainHeightAt !== "function") return z;
  const groundZ = sh.terrainHeightAt(wx, wy);
  if (typeof groundZ !== "number" || !Number.isFinite(groundZ)) return z;
  const buryDepth = groundZ - z;
  if (buryDepth > GROUND_CLAMP_EPS && buryDepth <= GROUND_CLAMP_MAX_LIFT) {
    return groundZ;
  }
  return z;
}

// PROJ-VIS (2026-10-05): raw outdoor terrain height at AC world (wx, wy), or
// null when the session can't answer (terrain not streamed / no handle).
function _terrainZAt(wx, wy) {
  const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
  if (!sh || typeof sh.terrainHeightAt !== "function") return null;
  try {
    const gz = sh.terrainHeightAt(wx, wy);
    return (typeof gz === "number" && Number.isFinite(gz)) ? gz : null;
  } catch (_) {
    return null;
  }
}

// 2026-05-28 — `?spawnTrace=1` opt-in per-stage timing for entity spawn.
// When set, _spawnImpl captures `performance.now()` deltas around the two
// dominant async stages (animationCache.get, materialCache.preload /
// fetchEntitySurfacesPixels) and emits one `[spawn-trace]` log per spawn
// with the breakdown. Zero cost when off (single boolean check).
const SPAWN_TRACE = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("spawnTrace") === "1";
  } catch (_) { return false; }
})();

// A9-Stage1 (2026-06-12) — `?placementId=on` opt-in: thread the wire
// placement id (PhysicsDesc.animation_frame, spawn meta `placementId`)
// into the AnimationCache fetch so the wasm rest-pose chain resolves
// retail's `wire placement -> 0x65 Resting -> 0 -> first` order
// (acclient.c:317303/:318554/:326845). Default OFF -> 0 is passed and
// the legacy `0 -> 1 -> first` chain stays byte-identical (the wasm
// side gates on the same query flag).
const PLACEMENT_ID_ON = (() => {
  try {
    if (typeof window === "undefined") return false;
    // Default-ON (2026-06-27): retail wire-placement rest-pose chain so
    // chests/corpses/levers render their commanded rest pose (e.g. a corpse
    // lying, not standing — pairs with the B5 death fix). `?placementId=off`
    // restores the legacy `0 -> 1 -> first` chain.
    const v = new URLSearchParams(window.location.search).get("placementId");
    return v == null ? true : v.toLowerCase() !== "off";
  } catch (_) { return false; }
})();

// P6/A08-1b (net-fixwave 2026-07-10) — slice the paletted-material
// continuation loop in `_spawnImpl`. After the worker decode resolves, the
// loop runs texture copy + material mint + render-state apply per missed
// DID in ONE macrotask — bunched exactly when many spawn continuations
// resolve together (hub arrival). When on, the loop yields a real macrotask
// every ~6 ms (the statics-slicer shape) and re-checks the spawn generation
// across each yield. `?palettedSlice=off` (also 0/false) reverts.
const PALETTED_SLICE_ON = (() => {
  try {
    if (typeof window === "undefined") return true;
    const v = new URLSearchParams(window.location.search)
      .get("palettedSlice")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
})();
const PALETTED_SLICE_MS = 6;

// `?palDedup` (2026-08-06) — upper bound on how long a spawn will wait for
// ANOTHER spawn's paletted decode before giving up and taking the fallback
// (which the R-8 recolored ladder then heals). The claim contract makes this
// unreachable in normal operation: entities.js settles every claim it takes on
// every exit path, so the wait is bounded by the owner's own wasm fetch. It
// exists for the one case the contract cannot cover — a
// `fetchEntitySurfacesPixels` promise that never settles at all (dead worker),
// which today hangs only the owner and must not be allowed to hang the whole
// town's rigs behind it. 8 s is ~9× the measured 897 ms mean decode.
const PALETTED_JOIN_TIMEOUT_MS = 8000;

/**
 * `?palDedup` — await a spawn's joined paletted claims as one batch.
 * Resolves to `[{ did, material }]`; `material` is null when the owner
 * produced nothing (bailed / empty decode) or when the batch timed out.
 * Never rejects: a settle is a resolve, and a rejected join is treated as
 * "produced nothing" rather than aborting the whole material block.
 * ONE timer for the batch, cleared on the normal path.
 */
async function _awaitPalettedJoins(joins) {
  const all = Promise.all(
    joins.map((j) =>
      Promise.resolve(j.promise)
        .catch(() => null)
        .then((material) => ({ did: j.did, material: material ?? null }))
    )
  );
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(joins.map((j) => ({ did: j.did, material: null }))),
      PALETTED_JOIN_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([all, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// === Wave R2.A — entity-attached dynamic lights (SetLight hook 25) (2026-05-28) ===
// `?entityLights=on` opt-in. Default OFF → no entity lights are created and
// the SetLight (25) hook stays a logged no-op, so the rendered output is
// byte-identical to pre-R2.A. Mirrors `terrain.js::readTerrainModulationFlag`'s
// shape (any value other than the literal "on" is off; wrapped in try/catch
// for the non-browser Node harness).
function readEntityLightsFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("entityLights");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

// F16-5 `?spawnHiddenState` JS reader RETIRED 2026-10-05 (flag retirement
// phase 1). It only ever gated the `?preCreateBuffer=off` legacy arm's
// `_pendingVisibility` map; the default-on pre-create buffer parks every
// pre-spawn visibility event regardless, and the wasm emit side has been an
// always-true binding since the 2026-06-10 eye-test.

// === HELD-ITEM fixes (2026-08-02) ============================================
//
// `?childPlacement=off` — escape hatch for the B5-WIRING fix. B5 (2026-06-09)
// added `_applyChildPlacementFrames` (retail's second equip step: pose the
// child's OWN parts into the grip frame, `CPartArray::SetPlacementFrame`
// acclient.c:326818-326865 -> `CSequence::set_placement_frame` :339767, read
// back by `get_curr_animframe` :339745 whenever no animation is playing). It
// never ran: `fetchSetupPlacementFrames` was never imported into index.html,
// so `wasmExports.fetchSetupPlacementFrames` was `undefined`, the frame table
// cached EMPTY and the method returned. Held items kept whatever the SPAWN
// bake left on their parts, and that bake runs retail's INIT chain
// `wire placement -> 0x65 Resting -> 0 -> first` (?placementId, default-ON) —
// so any item whose setup lacks the requested placement key rendered in its
// RESTING pose. Retail's wire-placement chain has NO Resting step
// (:326818-:326865 is requested -> id==0); the 0x65 step is the object-init
// default (`InitObjectEnd` :317303 / `InitNullObject` :320815) which the wire
// animframe_id then overrides (`unpack_physics_desc` :322346).
// Default ON (only `=off` reverts to the broken-but-shipped behaviour).
function readChildPlacementFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("childPlacement");
    return v == null ? true : v.toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
}

// `?wieldPersist=off` — escape hatch for the attached-child lifecycle fixes:
//
//   (a) POSE GUARD. While an object is parented, retail does not integrate or
//       position it at all: `CPhysicsObj::update_position` (acclient.c:321671)
//       opens with `if (!this->parent)`, `CPhysicsObj::update_object`
//       (:323099) bails on `this->parent`, and `enter_world` (:323358) returns
//       0 outright. Our `setPose` / `applyManagedPose` / dead-reckon ease had
//       no such guard, so any server position for an equipped item wrote a
//       WORLD coordinate into a root whose transform is HAND-LOCAL — the item
//       is flung thousands of metres away, i.e. "my weapon vanished".
//   (b) APPEARANCE RESPAWN. `applyAppearance` reconstructed `newMeta.x/y/z`
//       from `inst.root.position`, which for an attached child is the
//       hand-local holding-frame origin (~0.03 m) — the respawned rig landed
//       at the map origin AND lost its `_attachedParentGuid`. It only ever
//       re-attached a wielder's CHILDREN, never a child of its own wielder.
//   (c) RE-ATTACH MEMORY. A child that despawns + respawns (PVS churn, portal
//       hop) was never re-attached: the spawn hook only nudges guids that
//       WIELD things, never guids that ARE wielded. Retail re-establishes the
//       link from the child's own PhysicsDesc on every CreateObject
//       (`unpack_physics_desc` set_parent at :322346 / :330260), so the link
//       survives re-creation. `_lastAttach` is our equivalent ledger.
//
// Default ON (only `=off` reverts).
function readWieldPersistFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("wieldPersist");
    return v == null ? true : v.toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
}
const CHILD_PLACEMENT_ON = readChildPlacementFlag();
const WIELD_PERSIST_ON = readWieldPersistFlag();
/** LRU bound on the `_lastAttach` re-attach ledger (long-session leak guard). */
const LAST_ATTACH_MAX = 512;

// A8-M4 (2026-06-11 unification survey); DEFAULT-ON since 2026-07-27
// (P4.3 / LEAK-02), `?preCreateBuffer=off` is the escape.
// ON → events addressed to a guid whose rig isn't built yet park in ONE
// generic guid-keyed FIFO (`this._preCreate`, scene3d/pre_create_buffer.js),
// drained on spawn-commit and expired 25 s after the bucket's last enqueue —
// the retail null-object recovery (QueueBlobForObject acclient.c:310848-310860
// + the 25.0 s destruction stamp :310666). OFF → the per-kind
// `_pendingAttach` map keeps its exact legacy behavior, every other
// pre-create event (including kind=17 visibility) is dropped, and the map has
// no sweeper: a park for a guid that never spawns is retained for the
// lifetime of the page. ON is the retail-parity widening: a kind=17
// visibility for an unknown guid is buffered (retail parks ALL netblobs for
// unknown guids). The retail 20 s
// SendForceObjdesc nag (acclient.c:310302-310308) is NOT implemented — ACE
// support unresolved (ROADMAP bucket D).
function readPreCreateBufferFlag() {
  // Both arms enumerate their tokens. A bare `!== "off"` reader answers ON
  // for `=false` / `=0` / `=no`, so an operator who believed they had
  // disabled the buffer would in fact still be running it.
  const DEFAULT_ON = true;
  try {
    // No `window` (node harness, worker): report the shipped page's default
    // rather than the opposite arm.
    if (typeof window === "undefined" || !window.location) return DEFAULT_ON;
    const raw = new URLSearchParams(window.location.search).get("preCreateBuffer");
    if (raw === null) return DEFAULT_ON; // param absent
    const v = raw.trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return false;
    if (v === "" || v === "on" || v === "1" || v === "true" || v === "yes") return true;
    // Unrecognised token resolves to the default, never silently.
    console.warn(
      `[preCreateBuffer] unrecognised value "${raw}" — using default (on). Use ?preCreateBuffer=off to disable.`,
    );
    return DEFAULT_ON;
  } catch (_) {
    return DEFAULT_ON;
  }
}

// === Wave R3.A — remote-entity motion SMOOTHING (2026-05-28) ===
// `?deadReckon` — DEFAULT ON (B5/QW2/REMOTE-1; `=off` → remote entities snap
// to each server-authoritative position, the old byte-identical render).
// On → the manager-level `setPose(guid, …)` stashes the server pose as a
// per-entity target and the per-frame `tick(dt)` critically-damps the
// rendered `root.position` toward it, killing the inter-packet stutter on
// other players / NPCs. SMOOTHING ONLY — no velocity prediction, no wasm
// changes (that's the documented follow-on). Same flag-reader shape as
// `readEntityLightsFlag`; read once in the constructor into
// `this._deadReckonOn` and consumed via `this.` (no cross-function handoff).
function readDeadReckonFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("deadReckon");
    // B5/QW2/REMOTE-1: remote dead-reckon (position smoothing + the
    // VectorUpdate velocity extrapolation in tick) is DEFAULT-ON in the
    // browser now; `?deadReckon=off` disables it. Was default-off (REMOTE-1:
    // remotes hard-snapped each ~1Hz packet with no between-packet motion).
    return v == null || v.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
}

// A2-P2 (2026-06-12, W3+ S8) — `?remoteInterp` (DEFAULT ON since
// F-2026-06-27; `=off` escape). COMPOSITE flag: only meaningful alongside
// `unifiedTick` + `wireStatePacks` (both also default-on; the wasm side warns
// + degrades if either is `=off`, and no pose rows ever arrive). When rows DO
// arrive (loop.js drainRemotePoses → applyManagedPose), the wasm-side retail
// PositionManager owns each managed entity's POSITION (smoothing already
// happened Rust-side, acclient.c:389258-389264) and the JS dead-reckon ease +
// velocity extrapolation are skipped for it; heading stays JS-owned via the
// K=14 ease this stage (S8 OPEN Q4). Same reader shape as readDeadReckonFlag.
function readRemoteInterpFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    // F-2026-06-27: DEFAULT-ON; only an explicit `=off` disables.
    const v = new URLSearchParams(window.location.search).get("remoteInterp");
    return v == null || v.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
}

// A2 Path A — heading ease is DEFAULT-ON in the browser; `?headingSnap=on`
// forces the legacy per-update rotation snap (A/B + instant revert). Returns
// false outside a browser (Node harness) so unit tests see the byte-identical
// snap path (no per-frame tick to advance an ease). Read once in the
// constructor into `this._headingEaseOn`.
function readHeadingEaseEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("headingSnap");
    return !(typeof v === "string" && v.toLowerCase() === "on");
  } catch (_) {
    return false;
  }
}

// `?headingEaseK=<float>` tunes the heading damp rate at eye-test (1070);
// falls back to the conservative default.
function readHeadingEaseK() {
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("headingEaseK");
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (_) { /* Node / no window → default */ }
  return HEADING_EASE_DAMP_K_DEFAULT;
}

// A5-P3 (2026-06-12, W3+ S13) — `?rootMotionObject` — DEFAULT-ON
// (`!== "off"` reader; `=off` disables).
// On overlay (one-shot link clip) COMPLETION, apply the clip's net rigid
// root displacement (`rootMotionNet` from the A5-P3 wasm metadata export)
// to the entity ANCHOR (`inst.root`), so a translating one-shot
// (lunge / knockback / door swing) ends with the rig where the anim left
// it instead of popping back to the pre-clip anchor. Retail moves the
// OBJECT frame per crossed frame (CSequence::update_internal accumulation,
// acclient.c:340717-340720, composed object-local into the new object frame
// at acclient.c:320031); ours is the spec-scoped completion-time
// approximation (A5 §4 P3 — per-frame object root motion deferred). Remote
// entities only — the local player's anchor is owned by the wasm integrator
// (stage P3-L deferral, S13 spec §3). Same flag-reader shape as
// `readDeadReckonFlag`; read once in the constructor into
// `this._rootMotionObjectOn`.
function readRootMotionObjectFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URLSearchParams(window.location.search).get("rootMotionObject") !== "off";
  } catch (_) {
    return false;
  }
}

// (2026-07-06) `?deathAnim=off` escape for the death-collapse + corpse-handoff
// behaviour: bake the Ready→Dead LINK collapse (not just the settled cycle),
// size the creature's death-hold to the REAL authored collapse length, and hand
// the collapsing rig off to the corpse (hide corpse → collapse → reveal corpse
// at the authoritative death transform → remove creature) so position AND
// orientation line up. Default ON; `=off` restores the flat cycle-hold path.
// Same reader shape as readDeadReckonFlag; read once in the constructor into
// `this._deathAnimOn`.
function readDeathAnimFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("deathAnim") !== "off";
  } catch (_) {
    return true;
  }
}

// === Wave R3.B — transparency depth-sort via AC's authored sort center
// (2026-05-29) ===
// `?sortCenter=on` opt-in. Default OFF → no `renderOrder` writes on entity
// parts; THREE's default transparent sort (by object world-position Z) runs
// exactly as before, byte-identical render. On → for entities that own MORE
// THAN ONE transparent part, the per-frame `tick(dt)` computes each
// transparent part's authored sort point (part Group world position + the
// surfaced per-part `GfxObj.sort_center` offset, transformed into world
// space), projects it to the active camera's view-space Z, and assigns a
// stable back-to-front `renderOrder` so blend order is deterministic instead
// of relying on THREE's per-object bounding-sphere centre (which collapses
// for the layered parts of a single entity that all share ~one world
// position). Read once in the constructor into `this._sortCenterOn` and
// consumed via `this.` everywhere (no cross-function local — avoids the
// prior-wave preInit3D/init3D ReferenceError trap). Same flag-reader shape as
// `readDeadReckonFlag` / `readEntityLightsFlag`.
function readSortCenterFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("sortCenter");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

// Wave R3.B — renderOrder band for sort-center-ordered transparent parts.
// Existing renderOrder users (checked 2026-05-29): selection ring = 10,
// nameplate sprite = 10, selected-item box = 11, materials wireframe fill =
// (source.renderOrder ?? 0) - 1, play-effect VFX = 950, spell preview = 960,
// AC moons = 800, sky/stars = -1, cloud overlay = 999. We assign each sorted
// transparent part a SMALL value in [BASE, BASE + count) so the band sits
// just below 0 — clear of every positive-band user above (10, 11, 800+) and
// of the default 0 used by every untouched opaque/transparent mesh. Keeping
// the whole band ≤ 0 means an entity's transparent parts still draw in the
// same broad pass as before (after opaque geometry at renderOrder 0 via the
// transparent flag), only their RELATIVE order within the entity is pinned.
// The materials fill mesh uses `(source.renderOrder ?? 0) - 1`; entity part
// meshes are never wireframe-fill sources, so no collision there. Offsets are
// negative and tiny (BASE = -100, max ~64 parts) so they never reach the
// sky/HUD negative user at -1's neighbourhood meaningfully (those live in the
// separate sky-pass scene, not the world scene), and never touch +10/+11.
const SORT_CENTER_RENDER_ORDER_BASE = -100;
// Module-private scratch objects for the per-frame sort-center projection.
// Reused across entities/parts — callers must NOT retain references.
const _sortCenterScratchVec3 = new THREE.Vector3();
const _sortCenterScratchView = new THREE.Vector3();
const _sortCenterScratchQuat = new THREE.Quaternion();

// Critical-damping rate for the position ease: factor = 1 - exp(-k·dt).
// k=12 gives ~70% of the gap closed in 100 ms and ~95% in 250 ms — fast
// enough that the rig tracks a steady walk with no perceptible lag, slow
// enough that the per-packet position jitter (server PositionUpdate cadence
// is a handful per second) is smoothed into a continuous glide rather than a
// staircase. Frame-rate independent by construction (the exp form), so the
// settle time is identical at 30 / 60 / 144 fps. Exposed as a named const for
// 1070 eye-test tuning.
const DEAD_RECKON_DAMP_K = 12.0;
// Teleport / landblock-transition snap threshold (world metres). Under normal
// locomotion the gap between the rendered pose and a fresh server pose is at
// most a metre or two (AC run speed ~5–6 m/s ÷ the few-Hz update cadence). A
// teleport or landblock hand-off moves the entity tens-to-hundreds of metres
// in a single update (a landblock is 192 m square); easing across that would
// visibly slide the rig across the map. 8 m sits well above any single-packet
// locomotion delta yet far below a landblock hop, so genuine motion smooths
// while jumps snap. squared-distance compared against this avoids a sqrt on
// the hot path.
const DEAD_RECKON_TELEPORT_SNAP_M = 8.0;
const DEAD_RECKON_TELEPORT_SNAP_SQ =
  DEAD_RECKON_TELEPORT_SNAP_M * DEAD_RECKON_TELEPORT_SNAP_M;
// B5/QW2/REMOTE-3: max age (ms) of a VectorUpdate velocity before we stop
// extrapolating with it. Retail dead-reckons remote motion from set_velocity
// (acclient.c:143476) between the few-Hz position packets; we extrapolate the
// stashed _serverTargetPos by lastVel*dt while the velocity is this fresh, and
// each new KIND_POSITION snap-corrects it. Mirrors the 2D path's 500ms gate so
// a stopped entity (no fresh velocity) doesn't overshoot. Same units as
// performance.now() deltas.
const ENTITY_VELOCITY_STALE_MS = 500;

// Grace-aware stale-entity reaper (2026-06-15). ACE's ObjectMaint keeps an
// object in this player's destruction queue for DestructionTime = 25 s after
// it leaves PVS, on the EXPLICIT assumption that "the client automatically
// culls the object" after that window (ACE ObjectMaint.cs:21/41). So this
// reaper is the retail client contract, not a hack. Culling EARLIER than 25 s
// is the bug: a portal / PvP dungeon re-entry inside the window finds the
// object still "known" to ACE (no re-send via handle_visible_cells) →
// invisible. Hence REAP_GRACE_MS sits comfortably ABOVE 25 s; we'd rather keep
// a stale rig a few extra seconds (ACE just re-sends it on re-entry → spawn()
// dedupes by guid) than ever drop a still-tracked one.
const REAP_GRACE_MS = 30000; // > ACE DestructionTime (25 s) + skew/throttle margin
// LBs of Chebyshev distance from the player within which an entity is treated
// as "near" (clock refreshed, never reaped). Set FAR wider than ACE's PVS
// (~1-2 LBs) so nothing ACE still tracks is ever beyond it; only cross-world
// porting leftovers (tens of LBs away — e.g. academy gear left resident after
// porting to Holtburg, ~178 LBs) age out and get reaped.
//
// 2026-08-03 residency #9 — the radius itself (and the `?entityReapRadius`
// grammar, unchanged) moved to scene3d/residency.js, where it is derived as
// `RESIDENCY_RADIUS_LB + REAP_KEEP_OFFSET_LB` = 5 + 3 = 8 (a 17×17 = 289-LB
// window, exactly today's value). Deriving it off the bake ring is the POINT:
// the keep-zone must stay WIDER than the ring or the reaper culls entities that
// are still inside the baked, visible world. The #11b (2026-07-14) 1070 walk
// measurements that justify the +3 slack live in residency.js next to the
// constant. `REAP_PVS_RADIUS` is imported from "./residency.js" with the rest of
// this module's imports below (ESM bindings are hoisted, so the reaper reads the
// same value it always did).
// Self-throttle for the full-entityMap scan (cheap, but no need per-frame).
const REAP_SCAN_INTERVAL_MS = 4000;
// #11b continuous reap (2026-07-14): the old "remove every stale rig in one loop"
// disposed the whole backlog in a single scan-frame — when a dense town fell out
// of the keep-radius a 1070 corridor walk saw ~2500 entity geometries disposed in
// one ~15 s window (3784→1226), the same bulk-dispose latency spike the landblock
// governor's `parkDisposeBudgetMs` smooths for landblocks. So budget the reap:
// most-stale-first, dispose up to REAP_DISPOSE_BUDGET_MS of wall-clock (with a
// per-scan count backstop) and let the rest age out on later scans. Steady
// traversal only makes a few entities stale per 4 s scan — far below the budget —
// so nothing backs up; only a one-off town-exit backlog gets spread out.
// `?entityReapBudgetMs=N` tunes it; `?entityReapBudgetMs=off` (or 0) restores the
// legacy unbudgeted bulk reap for A/B.
function readReapBudgetMs() {
  try {
    if (typeof window === "undefined" || !window.location) return 3;
    const v = new URLSearchParams(window.location.search).get("entityReapBudgetMs");
    if (v == null) return 3;
    if (v.toLowerCase() === "off") return 0; // 0 = unbudgeted (legacy bulk reap)
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 3;
  } catch (_) {
    return 3;
  }
}
const REAP_DISPOSE_BUDGET_MS = readReapBudgetMs();
const REAP_MAX_PER_SCAN = 48; // hard per-scan backstop even under a fat time budget

// A2-P2 (2026-06-12, W3+ S8, ?remoteInterp=on) — frames of per-entity
// position ownership granted by each wasm-managed pose row. While the Rust
// PositionManager is interpolating, `applyManagedPose` lands ~every tick and
// keeps re-arming this countdown; when the manager goes idle (sparse export —
// no rows), the countdown drains in ~0.5 s @60fps and the legacy dead-reckon
// ease resumes seamlessly from the re-anchored _serverTargetPos (S8 §5 risk 2
// hand-back).
const REMOTE_INTERP_OWNERSHIP_FRAMES = 30;

// F3-4 (bughunt 2026-06-09) — sticky melee standoff (m). While a monster is
// sticky-attacking, ACE withholds its position broadcast and relies on the
// client to keep it glued to the (moving) target. We track the target at this
// horizontal contact distance so the mob sits at melee range instead of
// inside the player.
//
// CREATURE-SEPARATION (2026-07-28): this is now only the FALLBACK, used when
// the retail contact envelope for the pair cannot be sized yet (no resident
// SetupModel radius). The "per-entity cyl-radii (mob radius + target radius)
// is a refinement" TODO this comment used to carry is now implemented —
// `EntityManager._separationFloor` computes the real
// `r_mob + r_player - EPSILON`, and a fixed 1.3 was wrong in BOTH directions
// (a Tusker Guard needs 1.476, a half-scale Shadow Child only 0.720).
const ENTITY_STICKY_STANDOFF_M = 1.3;

// === CREATURE-SEPARATION (2026-07-28) — `?creatureSeparation=off`. ===
//
// THE BUG (measured live, headless vs ACE 127.0.0.1:9000): a Shadow Child
// charging a STATIONARY player rendered 0.300 m from the player's centre
// while the WIRE pose said 1.318 m — 1.019 m of pure client-side overshoot,
// leaving the rig drawn deep inside the player. The wire was healthy; our
// RENDER lane broke it, in two places:
//
//  (1) the dead-reckon extrapolation below (`tgt.x += lv.vx * dt`) is an
//      ACCUMULATOR on `_serverTargetPos`, not a function of elapsed time. It
//      keeps integrating every frame for the whole `ENTITY_VELOCITY_STALE_MS`
//      window whether or not the mob is still moving — and a charging mob's
//      velocity points straight AT the player, so the error is always
//      inward. ACE stops broadcasting position the moment the mob goes
//      sticky (see F3-4 above), so nothing ever snap-corrects it back.
//  (2) nothing anywhere enforced a contact envelope on the rendered pose.
//
// WHY RETAIL DOESN'T HAVE THIS: retail runs FULL physics for every remote
// creature, so a charging mob is blocked by `CPhysicsObj::FindObjCollisions`
// (acclient.c:316159-316316) before it can interpenetrate. Creature-vs-player
// is a HARD block there: the pass-through exemption (:316216-316224) requires
// BOTH parties to be players, and `IgnoreCreatures` (0x400) is never set by
// the client. Our remote creatures are never in the solver at all, so the
// separation has to be re-imposed at the point the pose is rendered.
//
// THE RETAIL FLOOR. `CSphere::intersects_sphere` (acclient.c:359211-359214)
// and `CCylSphere::intersects_sphere` (:362082) both build
// `radsum = r_a + r_b - EPSILON` and declare contact inside it. EPSILON is
// 0.0002 (`F_EPSILON_37` acclient.c:39545; ACE `PhysicsGlobals.cs:9`) and is
// the ONLY interpenetration retail permits — there is no per-creature
// allowance and no push-out (nothing in `handle_all_collisions` :321808 ever
// writes the collidee's position; `PhysicsState.Pushable` 0x80 is declared
// but never read by the engine). Death/collapse does NOT exempt: nothing
// sets `Ethereal` on a dying creature, and corpses stay solid.
//
// The radii are the part array's collision PRIMITIVES (first cyl-sphere else
// first sphere, `CPartArray::GetCylsphere`/`GetSphere` acclient.c:325364-325376,
// scaled by `m_scale` at the call site :316244/:316266) — NOT `CSetup.radius`
// (`CPartArray::GetRadius` :325382), which is the bounding/sorting scalar the
// COMBAT lattice reads and `?combatRadii` correctly uses for the STANDOFF.
// Those are different quantities and this is the smaller one: a Tusker Guard
// blocks at 1.476 m but stands off at 2.388 m.
//
// WHAT WE ENFORCE (planar, z ignored — retail's cyl-sphere test is itself
// XY-only, :361504, and the sphere test's z term only ever makes the pair
// FURTHER apart, so a planar floor is the conservative projection of retail's
// 3D test: equal when the sphere centres are coplanar, at most a few cm
// stricter otherwise):
//   (a) prediction may never carry the target CLOSER to the local player
//       than the authoritative wire pose already is — fixing (1) at source;
//   (b) the rendered pose is pushed out to `r_mob + r_player - EPSILON` —
//       fixing (2), and the backstop for every other lane (sticky glue,
//       wasm-managed poses) that also writes `root.position`.
// Creature-vs-CREATURE separation is deliberately out of scope (see the
// report residual): retail gets it from the same solver we don't run, and
// doing it here would need an O(n^2) pass this choke point cannot afford.
function readCreatureSeparationFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get(
      "creatureSeparation"
    );
    // DEFAULT-ON; only an explicit `=off` disables. (Absent => on.)
    return v == null || v.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
}

// === IMMOVABLE-ENTITIES (2026-08-04) — `?immovableEntities=on`, default OFF. ===
//
// THE BUG: the player rig can shove doors off their hinges and slide NPCs and
// corpses around by walking into them. The displacement is entirely the
// separation push-out above: `_applyCreatureSeparation` is applied to EVERY
// non-local entity with no type filter and no bound, so `pushOut` writes
// `root.position` (and `_serverTargetPos`) of a door / corpse / standing NPC
// whenever the PLAYER's own capsule intrudes on its contact envelope. Nothing
// in wasm ever moves another entity — `clamp_delta_against_entities`
// (`crates/holtburger-world/src/spatial/entity_collision.rs`) only shortens the
// PLAYER's delta — so this render-side push is the sole source.
//
// RETAIL / ACE: the colliding mover is stopped or slid and the target is NEVER
// displaced. `CPhysicsObj::handle_all_collisions` (acclient.c:321808) writes
// only `this->m_velocityVector` (the bounce, :321870-321886);
// `track_object_collision` (:321217) and `report_object_collision` (:320228)
// record the contact and notify — neither touches `object`'s position. ACE is
// the same port: `PhysicsObj.FindObjCollisions` (`ACE.Server/Physics/
// PhysicsObj.cs:381`) returns a `TransitionState` for the MOVER and never
// writes the collidee. `PhysicsState.Pushable` (0x80) is declared and never
// read. A world object's position is the server's, full stop.
//
// THE RULE ENFORCED HERE: the separation resolve may only ever REDUCE our own
// client-side prediction error — it may never carry a rendered pose FARTHER
// from that entity's authoritative anchor than it already is. Consequences:
//   * a standing NPC / door / corpse renders AT its authoritative pose, so its
//     distance-from-anchor is 0 and every push is rejected ⇒ immovable;
//   * a charging mob whose dead-reckon overshot ~1 m past its wire pose and
//     into the player still gets pushed back OUT, because that move shortens
//     the distance to the anchor. The 2026-07-28 measured defect stays fixed.
// The anchor is the last authoritative pose we hold: `_wirePos` (stashed in
// `setPose`, reached only from a KIND_POSITION drain) falling back to the
// spawn pose, which is what a door that never moves has.
function readImmovableEntitiesFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get(
      "immovableEntities"
    );
    // DEFAULT-ON (2026-08-04 — user-verified live: doors were still pushable
    // with the fix flagged off). `=off` is the escape.
    return v?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
}

// MOVER-SIDE RESOLUTION (2026-08-04) — `?playerDepenetrate=on`, DEFAULT OFF.
// The other half of retail's collision rule. IMMOVABLE-ENTITIES establishes
// that the TARGET never moves; retail's mover then gets stopped or slid
// (`CPhysicsObj::handle_all_collisions` acclient.c:321808 writes only `this`).
// Our sim does that in `clamp_delta_against_entities`, but it clamps against
// each entity's WIRE pose, while the renderer draws the entity's INTERPOLATED
// pose — CREATURE-SEPARATION measured up to 1.019 m between the two. When that
// residual leaves the avatar drawn inside an entity, this resolves it on the
// MOVER: the local player's rendered rig is offset out, and the entity is left
// exactly where the server put it.
function readPlayerDepenetrateFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get(
      "playerDepenetrate"
    );
    // DEFAULT-OFF; only an explicit `=on` enables. (Absent => off.)
    return v != null && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

// Hard cap (m) on the per-tick mover-side correction. A wrong radius must
// never be able to fling the avatar; beyond this the overlap is a sim bug to
// fix in Rust, not something to paper over here.
const PLAYER_DEPENETRATE_MAX_M = 0.5;

// Fallback radius (m) for a party whose SetupModel collision radius has not
// landed yet. `PLAYER_SETUP_SPHERE_RADIUS` (0.48) — Setup `0x02000001`'s
// sphere, i.e. a humanoid. A residency miss must never collapse the floor to
// zero (that is the bug), so it degrades to human-sized rather than to
// nothing.
const SEPARATION_FALLBACK_RADIUS_M = 0.48;
// Re-query cadence (frames) for the wasm radius table while an entity's own
// radius is still unresolved. The table only grows as rigs stream in, so a
// resolved entity is memoised permanently and never re-queried.
const SEPARATION_RETRY_FRAMES = 30;

// F3-4b (2026-06-27, ?stickyGroundZ=on) — vertical gap (m) past which a sticky
// melee mob RELEASES its glue: the victim has left ground melee reach (jumped),
// so the mob should fall back to its server-driven grounded path and circle
// beneath rather than levitate after the airborne target (retail StickyManager
// is horizontal-only, z zeroed — acclient.c:388557; melee uses a 3D cylinder
// range — ACE Position.cs:100-114). ~melee cylinder reach; ACE MaxMeleeRange is
// 0.75 (radius-excluded) and a clear jump clears 1 m.
const STICKY_AIRBORNE_RELEASE_M = 1.0;

// === COL-20 / F4 (2026-07-27) — turn-phase ANIMATION gate for remote entities.
// Retail cannot begin forward locomotion while a turn is outstanding: a MoveTo
// builds its pending queue as [TurnToHeading, MoveToPosition]
// (`MoveToManager::MoveToObject_Internal` acclient.c:345859 via
// `AddTurnToHeadingNode` 0x00529530 / `AddMoveToPositionNode` 0x00529580), and
// `BeginTurnToHeading` (:345456-345518) plays the TurnRight/TurnLeft
// turn-in-place cycle (`_DoMotion` :345489/:345507) until that node is
// consumed — the move node does not exist before then. Once forward motion HAS
// begun, the tolerated heading error is 20.0 degrees; past it an aux turn runs
// concurrently with the walk/run (`HandleMoveToPosition` :345636,
// `if (v7 <= 20.0 || v7 >= 360.0 - 20.0)`).
//
// Remote entities here have no MoveToManager (the faithful driver is
// local-player only), so node sequencing is not renderable. Retail's own
// while-moving tolerance is the closest renderable analog: while the rendered
// heading is further than 20 degrees from the server heading target, play the
// turn cycle; the frame it crosses under, start the run/walk cycle.
// ANIMATION SELECTION ONLY — the gate never touches position or physics.
const MOVETO_FACING_TOLERANCE_RAD = (20.0 * Math.PI) / 180.0;
// Deadline reference rate (rad/s) — the authored player-MotionTable TurnRight
// |Omega.Z|. Used ONLY to bound how long the gate may hold; the rendered sweep
// rate is whatever the heading ease/slew actually does, so this constant stays
// correct whether or not the COL-19 constant-omega slew has landed.
const MOVETO_TURN_GATE_OMEGA_REF_RAD = 1.5;
// Slack for the arm frame + the first-frame animation resolve.
const MOVETO_TURN_GATE_SLACK_S = 0.25;
// Hard ceiling: a 180 degree sweep at the reference rate is pi/1.5 ~= 2.09 s,
// so nothing legitimate reaches this. It exists so a creature whose
// MotionTable has no turn-in-place cycle (null clip -> rest pose) can never be
// held in that pose indefinitely by a stale heading target.
const MOVETO_TURN_GATE_MAX_S = 3.5;
// `?remoteTurnGate=off` is the escape hatch; absent ⇒ ON (the reader is
// `!== "off"`, matching this comment — the flag IS on by default). Returns
// false outside a browser so the Node harness sees the ungated path.
const MOVETO_TURN_GATE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("remoteTurnGate")?.toLowerCase() !==
      "off"
    );
  } catch (_) {
    return false;
  }
})();

// === A2 Path A (2026-05-29) — remote-entity HEADING easing (DEFAULT-ON).
// Remote entities used to SNAP their quaternion to each server heading
// (~30 Hz), so a turning creature stepped through its facing. AC's MotionTable
// turn modifiers (0x0D/0E/0F/10) are pure omega — they exist precisely so a
// run/walk sweeps through a turn. Rather than build the full per-entity
// kinematic+reconciliation subsystem (Path B), we just SMOOTH the visible
// rotation: slerp the rendered quaternion toward the server target with the
// same frame-rate-independent exponential damp the position ease uses
// (factor = 1 - exp(-k·dt)). The server remains authoritative — the target is
// re-anchored every update, so the heading is bounded smoothing, NOT
// prediction (no drift, no rubberband). k = damp rate (1/k ≈ time constant).
// A large single-update delta (re-target / teleport / respawn discontinuity,
// not a physical turn at 30 Hz) snaps instead of spinning slowly.
const HEADING_EASE_DAMP_K_DEFAULT = 14.0;
const HEADING_EASE_SNAP_RAD = 2.5; // ~143°: only true discontinuities snap
const HEADING_EASE_EPSILON = 0.01; // settle (~0.6°) to avoid endless micro-slerp

// G-5 / F3-3 follow-on (2026-06-11) — `?turnOmega=on` rate-limits the
// KIND_TURN (TurnToHeading/TurnToObject) slerp to retail's turn rate.
// Retail turns an entity at (MotionTable turn omega × MoveToParameters
// .speed); our heading ease instead converges with a fixed exponential K,
// so a 180° emote-turn whips around in ~0.2 s instead of sweeping at the
// authored rate. The wire `params.speed` is already surfaced on the
// KIND_TURN EntityUpdate (`omega_z`, lib.rs UpdateMotion arm) and loop.js
// now forwards it here; the per-entity MotionTable omega is NOT plumbed,
// so a base constant stands in (human TurnRight cycle ≈ 3 rad/s; tune at
// the 1070 with `?turnOmegaBase=<rad/s>`). Applies ONLY to turn-directive
// targets — a KIND_POSITION heading stash clears the cap so position-
// driven smoothing keeps its existing fixed-K feel. DEFAULT-ON (reader is
// `!== "off"`: absent reads ON; `?turnOmega=off` disables).
const TURN_OMEGA_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("turnOmega")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
const TURN_OMEGA_BASE_RAD = (() => {
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("turnOmegaBase");
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (_) { /* Node / no window → default */ }
  return 3.0;
})();

// === Wave R2.A — per-quality-preset cap on the TOTAL number of entity-
// attached lights created across all entities. WebGL2 has a hard per-scene
// light-uniform limit and MeshStandardMaterial recompiles its shader when the
// active light count changes, so an unbounded torch-mob would both error and
// thrash shader variants. The static-light path already caps the per-frame
// *rendered* set at MAX_ACTIVE_LIGHTS (32) via the distance sort in
// `lighting.js::capActiveLightsByDistance`; this cap limits how many entity
// lights we ever *create* so we don't bury static lights under transient
// entity ones. Tiers mirror the headroom of `quality.js`'s PRESETS table.
const ENTITY_LIGHT_CAP_BY_PRESET = Object.freeze({
  low: 0,    // low GPUs: no entity lights at all (zero shader-variant churn).
  mid: 8,
  high: 16,
  ultra: 24,
});
const ENTITY_LIGHT_CAP_DEFAULT = 8;

// Phase 7.4b — EntityManager: per-entity Object3D rig, driven by the Rust
// motion playhead (MotionSequence; the three.js AnimationMixer it started with
// was retired 2026-10-05 — see the animation-consolidation note below).
//
// Animations are rigid-body per-part (NOT skinned). The rig is a
// `THREE.Group` whose direct children are per-part `THREE.Group`s
// named `part_0..part_N`; `poseRigAt` writes each part's position +
// quaternion from the cached keyframe buffer at the playhead's frame.
// Per-part Mesh leaves (one per Surface DID, from
// `meshToGeometryGroups`) hang off their part Group so the animation
// translates the entire part as a unit — exactly how AC's wire format
// stores it.
//
// Spawn flow:
//   1. spawn(meta) is async — kicks `fetchEntityAnimationKeyframes`
//      via the AnimationCache, which returns rest-pose part meshes +
//      the sequence descriptor for (motionCommand, stance).
//   2. Build root Group at world coords (landblockId * 192 + meta.x);
//      build per-part Groups with Mesh children; resolve materials
//      via the shared MaterialCache. Stash on entityMap[guid].
//   3. The initial cycle goes onto `inst._unifiedLoco` (no clip → rest pose).
//
// Motion-switch flow (kind=5 UpdateMotion):
//   setMotion(guid, cmd, stance) — async cache lookup; a cycle replaces
//   `_unifiedLoco` (phase carried), a one-shot (swing/cast/emote/link/death/
//   door state link) goes onto `_unifiedSeq` (+ the J5 pending queue).
//
// Per-rAF tick(dt): advance each entity's playhead (one-shot if present,
// else the cycle) and pose the rig; drain the sequence's animation hooks.
//
// ──────────────────────────────────────────────────────────────────────
// Perf B3 (2026-05-18) — `__disposable` material/geometry tag convention
// ──────────────────────────────────────────────────────────────────────
//
// B3, C5, and E3 all need to dispose cloned three.js Materials (and
// occasionally Geometries) without crashing future renders by freeing
// a shared cache reference. The convention:
//
//   - Every fresh Material / Geometry that is NOT installed into the
//     shared `MaterialCache` (e.g. `new THREE.MeshBasicMaterial(...)` /
//     `new THREE.TorusGeometry(...)` / `baseMaterial.clone()`) MUST be
//     tagged at construction:
//
//         mat.userData.__disposable = true;
//         geom.userData.__disposable = true;
//
//   - At dispose time, traverse the entity's root group with
//     `_disposeMeshChildren(this.root)`. The helper dispatches to
//     `_disposeMaterialIfOwned`, which:
//       * disposes when `userData.__disposable === true`
//       * asserts `userData.__cacheOwned !== true` (belt-and-braces —
//         a cache material that escaped onto an entity rig would
//         silently corrupt other entities; the assertion surfaces it
//         as a console error at the call site instead).
//       * else: no-op (assumed cache-owned / shared singleton).
//
// `MaterialCache._installFromPixels()` + the cache's `fallbackMaterial`
// constructor tag cache-resident materials with `__cacheOwned = true`
// so the assertion catches the corruption case. B3 introduces this
// convention; C5 (`buildings.js` unload path) and E3
// (`particles/particle_manager.js` clone site) build on it.
//
// Future material/geometry clone introductions inside entities.js MUST
// follow the same tag pattern or the dispose path will quietly leak
// them (under-dispose is preferable to over-dispose; the assertion
// catches the over-dispose case).
//
// FU3 (2026-05-18) — geometries returned from `AnimationCache.get()`
// are SHARED across all spawns of the same `setupId` (see
// animation.js:316-329: "Multiple spawns of the same setupId all see
// the SAME BufferGeometry refs"). Disposing them on the first entity's
// despawn would free GPU buffers that surviving entities still
// reference — those next render against a disposed geometry. The B3
// `_disposeMeshChildren` originally disposed unconditionally and
// shipped a CAVEAT to gate it; FU3 closes that gate. The helper now
// disposes geometry only when `userData.__disposable === true`,
// matching the material path. AnimationCache geometries stay untagged
// → never disposed by this helper; entity-owned geometries (selection
// ring TorusGeometry, etc.) carry the tag at their construction site.

import * as THREE from "three";
import {
  meshToGeometryGroups,
  surfacePixelsToTexture,
  acQuatToThree,
  acToThree,
} from "./adapter.js";
import { retailVolume } from "./audio/retail_sound_rules.js";
import { AnimationCache, cycleTimeScale } from "./animation.js";
// Routes the recolored/paletted entity-surface decode through the bake worker
// (off the main thread) with a transparent main-thread fallback.
// `surfacePixelsFetcher` does the same for the non-recolored entity surface
// preloads (statics decoder), matching the statics/buildings/cells offload.
import {
  entitySurfacePixelsFetcher,
  surfacePixelsFetcher,
} from "./bake_worker_client.js";
// decode-priority (2026-07-10): tag current/server-LB entity-surface decodes
// urgent — lane-0 dispatch in the bake-worker queue + fetch-semaphore bypass
// in the decoding wasm instance, same signal statics/buildings/terrain use.
import { isNearPlayerLb } from "./landblock_lru.js";
// 2026-08-03 residency #9 — reaper keep-zone radius, derived from the one
// residency policy constant (base 5 + 3 = 8, unchanged). `?entityReapRadius`
// grammar is preserved verbatim there. See the block near REAP_GRACE_MS above.
import { REAP_PVS_RADIUS } from "./residency.js";
// `entMB` instrument (2026-07-26, RESULTS-matcache-falsifier next-move 1):
// count + byte-sum every entity-OWNED texture/material across ALL live
// instances. Charged O(1) at register time; a poll never walks the rigs.
import { entityOwnedTally } from "./entity_owned_tally.js";
// `?recolor=off` (2026-07-26): the entity subpalette-recolor escape hatch.
// Default ON (absent ⇒ today's behaviour bit-for-bit); `off` forces every
// entity surface fetch to the palette-free base class. See recolor_flag.js.
// (The boot readback lives in recolor_flag.js, fired on module load.)
import { gatePaletteId, gateSubPalettes } from "./recolor_flag.js";
// A12 (S14): spawns.js pre-warms LOD degrade bands per wave; _spawnImpl
// consults this memo before paying a per-entity wasm await.
import { lodPrewarmGet, lodPrewarmSet } from "./lod_prewarm.js";
import { PartDegrade, partDegradeEnabled, PART_DEGRADE_INTERVAL_S } from "./part_degrade.js";
import { linkMissIsDefect } from "./motion_link_diag.js";
// Animation consolidation (docs/animation-audit §5) — COMPLETE (2026-10-05):
// every entity rig is driven by ONE authority, the RUST MotionSequence
// interpreter (src/motion_sequence.rs, cargo-tested retail CSequence): a cyclic
// `inst._unifiedLoco` (locomotion / idle / held door state) with one-shots on
// `inst._unifiedSeq` (+ the J5 pending queue) in front of it. The three.js
// AnimationMixer is gone, and so is the `?unifiedMotion` per-class gate — there
// is no other path. The wasm class is read off `window.__hbWasm` (set during
// boot); a stale pkg/ without it logs ONE loud console.error and leaves rigs at
// the rest pose. `poseRigAt` is the JS-only per-part pose write (the one step
// that can't live in Rust).
import { poseRigAt } from "./motion/motion_sequence.js";
// J5 (PARITY-D, 2026-08-13) — retail's `MotionTableManager::pending_animations`
// (acclient.h:31103). One playhead (`inst._unifiedSeq`), an ORDERED queue
// behind it. See scene3d/motion_queue.js for the decomp transcription.
import {
  createMotionQueue, addToQueue, animationsDone, headMotion,
} from "./motion_queue.js";
// Bugs 2/15/18 (2026-10-07): bare low-16 → full 32-bit MotionCommand, so
// every link lookup uses the full inner key (scene3d/motion/motion_command_full.js).
import { fullMotionCommand } from "./motion/motion_command_full.js";
// Pending one-shots kept behind the playhead (see `_enqueueUnifiedOneShot`).
// Bug 2 (2026-10-07): 3 → 8. With movement no longer cutting the playhead
// (`_preemptUnifiedForMotion`), a cast burst (windups + gesture) or a swing
// chain queues behind it the way retail's unbounded pending_animations does;
// 3 dropped the earliest windup of a burst.
const _UNIFIED_QUEUE_MAX = 8;
// Bug 15 (2026-10-07): spawn-in-flight motion stash (see `_stashSpawnMotion`).
const SPAWN_MOTION_STASH_ACTIONS = 3;
const SPAWN_MOTION_STASH_MAX_AGE_MS = 1500;
// Bug 15: no distance-LOD respawn (remove()+spawn()) within this long of a
// swing/cast, or while a one-shot plays or is queued — it threw them away.
const LOD_RESPAWN_COMBAT_QUIET_MS = 3000;
// Bug 15: late swing bakes (see `_tryPlayLink`).
const MOTION_LATE_LOG_MS = 500;
const MOTION_LATE_SKIP_MS = 1500;
// Bug 19 (2026-10-07): airborne pose = the MotionTable Falling state
// (`setAirborne`); `?jumpPose=overlay` restores the procedural arms-up tween.
const CMD_FALLING_FULL = 0x40000015;
const JUMP_POSE_OVERLAY = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("jumpPose") === "overlay";
  } catch (_) {
    return false;
  }
})();
// A touchdown that never arrives (lost event) force-lands after this long.
const MAX_AIRBORNE_MS = 8000;
// Reused empties for the absent fields of MotionSequence.fromDescriptor.
const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);
// (2026-07-02) — finite fallback for every frames/framerate duration input
// into MotionSequence.fromDescriptor. Retail framerate-0 AnimData (e.g. the
// Blood Shreth Dead cycle: anim 0x0300001A, lowFrame 40, framerate 0) means
// "snap to lowFrame and HOLD, do not advance" (CSequence::update_internal
// hits neither advance branch at |fr| <= 2e-4, acclient.c:340696-340731) —
// the wasm bake already emits those as ONE held keyframe at a nominal
// 30 fps, but any residual `frames/framerate` division upstream would leak
// Infinity/NaN into the sequence clock. `+v || 0` passes Infinity (truthy);
// this doesn't.
const _finiteOr0 = (v) => (Number.isFinite(+v) ? +v : 0);
// Doors open/close via On (0x4000000b) / Off (0x4000000c) CYCLE commands — 63 of
// 436 retail MTs carry them with hinge baked into the keyframes (no SetupModel
// hinge extraction needed; probe_door_motions.rs).
// MotionCommand.On / .Off (door open / close).
const CMD_DOOR_ON = 0x4000000b;
const CMD_DOOR_OFF = 0x4000000c;
// Door/chest On/Off are STATE-change motions: they play once and HOLD the final
// (open/closed) pose — they are NOT cyclic loops. ACE Door.cs/Chest.cs define
// `motionOpen = Motion(NonCombat, On)` / `motionClosed = Motion(NonCombat, Off)`
// as held states, and the open/close transition has a finite GetAnimationLength
// (a one-shot, not a loop). But On/Off live in the MotionTable CYCLES table, so
// `classifyMotionCommand` buckets them with the locomotion cycles ("walk") and
// the cycle-play sites would set LoopRepeat. Looping a closed chest's Off cycle
// = perpetual open↔close (the 2026-06-29 "all doors/chests opening and closing
// over and over" bug; confirmed live — a closed chest spawned with Off(0xc) on
// LoopRepeat). Special-case the LOOP MODE at the play sites via this predicate.
// The wasm `MotionSequence` class (the Rust CSequence playhead), read off the
// boot-installed `window.__hbWasm` namespace. null = stale pkg/ or no window.
// The class is the ONLY animation driver: when a browser boot's namespace lacks
// it (a pkg/ built before src/motion_sequence.rs), say so ONCE, loudly — rigs
// will sit at their rest pose (there is no mixer fallback any more).
let _motionSequenceMissingReported = false;
function _motionSequenceClass() {
  if (typeof window === "undefined") return null;
  const MS = window.__hbWasm?.MotionSequence;
  if (typeof MS === "function") return MS;
  if (window.__hbWasm && !_motionSequenceMissingReported) {
    _motionSequenceMissingReported = true;
    // eslint-disable-next-line no-console
    console.error(
      "[entities] window.__hbWasm.MotionSequence is missing — stale pkg/? " +
      "Rebuild the wasm (wasm-pack). The Rust MotionSequence is the only animation " +
      "authority; entities will hold their rest pose until it is present.",
    );
  }
  return null;
}
function isDoorStateMotion(cmd) {
  const low = (cmd >>> 0) & 0xffff;
  return low === (CMD_DOOR_ON & 0xffff) || low === (CMD_DOOR_OFF & 0xffff);
}
import { ensureNameplateForEntity } from "./nameplate_sprite.js";
// Retail target indicator (2026-08-02) — the four red corner brackets that
// track the projected selection sphere, replacing the vibe-coded torus.
// See scene3d/selection_brackets.js for the full acclient.c chain.
import {
  computeSelectionSphere,
  readSelectionIndicatorMode,
  peekDatSelectionSphere,
  loadDatSelectionSphere,
  datSelectionSphereFor,
  selectionSphereStats,
  blipColorForEntity,
  readFellowshipRoster,
} from "./selection_brackets.js";
const SELECTION_INDICATOR_MODE = readSelectionIndicatorMode();
// C2 (2026-07-12) — retail target-cycling ordering math (CPlayerSystem::
// SelectNext, acclient.c:397944). Import-free helper so the ordering logic
// is unit-testable under plain node (tests/target_cycle.test.cjs).
import {
  SELECTION_TYPE,
  computeSelectNext,
  matchesSelectionType,
  weightedDistance,
} from "./target_cycle.js";
// P6/R-6 (net-fixwave 2026-07-10) — entity program warm: per-spawn rig
// compileAsync (Step E) + the one-shot archetype-matrix warm armed on the
// local player's commit. See bake_prewarm.js for flags + rationale.
import { prewarmSubtree, scheduleArchetypeWarm, ENTITY_WARM_ON } from "./bake_prewarm.js";
import {
  materialCanCastShadow,
  SURFACE_TYPE,
  applySurfaceRenderState,
  applyClipMapRenderState,
  applyRetailSinglePass,
  readSurfaceUnifiedFlag,
  readLuminousEmissiveMapFlag,
  VFX_GLOBALS,
  installVfxComponentPatch,
  surfaceResultDecodeMisses,
  surfaceResultProvenAbsent,
  materialRendersNothing,
} from "./materials.js";
import { drainPendingPlayEffects } from "./play_effect_vfx.js";
import { drainPendingObjectSounds } from "./audio/retail_sound_rules.js";
// #16 (?itemFx) — the optional non-retail UiEffects 3D item-aura. Mirrors the
// statics.js frag seam (buildFragVariant + VFX_GLOBALS), keyed off the entity's
// UiEffects bitmask via item_fx.itemFxPlanFor. Lazy frag deps below keep the
// eval-based harnesses loadable. itemAura self-registers through item_fx's import.
import { visualEnabled, ensureVfxCatalog, vfxDescriptorFor, descriptorMechs } from "./vfx_catalog.js";
import { buildFragVariant, buildPalettedFragVariant } from "./vfx/frag_install.js";
import { ensureVfxHashVarying } from "./vfx/per_instance.js";
import { itemFxPlanFor, itemFxEnabled } from "./vfx/item_fx.js";
// P2.2 (?tipFlex): the offline catalog descriptor -> frag/MECH-B "plan" for an
// entity's setup DID, the per-effect flag, FAMILY_ORDER for the plan merge, and
// the component barrel so tipFlex + glint self-register (item_fx imports only
// itemAura). buildFragVariant + VFX_GLOBALS/installVfxComponentPatch are already
// imported (the statics-mirrored entity frag seam).
import { fragPlanForDid } from "./vfx/frag_attach.js";
import { tipFlexEnabled, gemSparkleEnabled } from "./vfx_flags.js";
// Phase 3 (P3.1) — shared emit helper: runs each particle component's emit(ctx)
// for a descriptor and returns [{emitterInfo, partIndex, parentOffset}] specs.
import { attachParticleEmitters } from "./vfx/particle_attach.js";
import { readParticleEnv } from "./vfx/particle_env.js"; // P3.7 derived day/weather/season for ctx.env
import { FAMILY_ORDER } from "./vfx/registry.js";
import "./vfx/components/index.js";
const VFX_HASH_PRELUDE = { id: "infra.vfxHash", inject: (s) => ensureVfxHashVarying(s) };
let _entityVfxFragDeps = null;
function _entityFragMat(base, materialCache, surfaceDid, fragPlan) {
  if (!fragPlan || !materialCache) return base;
  if (!_entityVfxFragDeps) {
    _entityVfxFragDeps = {
      globals: VFX_GLOBALS,
      installComponentPatch: installVfxComponentPatch,
      sharedPrelude: VFX_HASH_PRELUDE,
    };
  }
  return buildFragVariant(materialCache, surfaceDid, fragPlan.entries, _entityVfxFragDeps) || base;
}
// Paletted twin of _entityFragMat: layer the SAME frag plan onto a RECOLORED paletted
// base so itemFx / catalog effects reach recolored gear (the `_entityMaterials` path).
// Soft-degrades to the base material if the cache method is absent (stale pkg/)
// or `base` isn't a __paletteKey-tagged paletted material (e.g. shared fallback).
function _entityFragMatPaletted(base, materialCache, fragPlan) {
  if (!fragPlan || !materialCache || typeof materialCache.getCachedVariantFromPaletted !== "function") return base;
  if (!_entityVfxFragDeps) {
    _entityVfxFragDeps = {
      globals: VFX_GLOBALS,
      installComponentPatch: installVfxComponentPatch,
      sharedPrelude: VFX_HASH_PRELUDE,
    };
  }
  return buildPalettedFragVariant(materialCache, base, fragPlan.entries, _entityVfxFragDeps) || base;
}
// Combine two frag plans ({entries,ids}|null) into ONE so a single material variant
// carries BOTH the offline-catalog SET (e.g. [deformation.tipFlex (MECH-B vertex),
// emissive.glint (frag)]) AND any live itemFx aura -> ONE getCachedVariant / ONE
// __vfxSetKey (the one-variant-per-SET firewall). Dedup by comp.id (first wins),
// re-sort (FAMILY_ORDER major, id minor) so the vertex entry (deformation=0)
// installs before frag (emissive=3) on the shared chain. Either-null => the other
// (or null) => a pure passthrough, so ?tipFlex-off is byte-identical to today's
// itemFx-only path. Pure (no Date.now/Math.random); bake/spawn-time, not hot frame.
function _mergeFragPlans(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const seen = new Set();
  const entries = [];
  for (const e of a.entries.concat(b.entries)) {
    if (seen.has(e.comp.id)) continue;
    seen.add(e.comp.id);
    entries.push(e);
  }
  entries.sort((x, y) => {
    const fx = FAMILY_ORDER[x.comp.family] ?? 99;
    const fy = FAMILY_ORDER[y.comp.family] ?? 99;
    if (fx !== fy) return fx - fy;
    return x.comp.id < y.comp.id ? -1 : x.comp.id > y.comp.id ? 1 : 0;
  });
  return { entries, ids: entries.map((e) => e.comp.id) };
}
import {
  showSpeechBubbleOnEntity,
  removeSpeechBubbleFromEntity,
} from "./speech_bubble.js";
// === Wave R2.A (2026-05-28) — reuse the static-light constructor so
// entity-attached SetLight lights share identical color/intensity/falloff/
// cone math. Only imported; constructs nothing at module load.
import { buildLightForSetupLight } from "./lighting.js";
// A9-Stage2 (unification survey 2026-06-11): the single JS owner of
// part-array → Object3D transform semantics. `?rigModule=off` reverts to
// the inline legacy paths below (byte-identical-transform acceptance bar).
import {
  readRigModuleFlag,
  applyRestPoseFrame,
  buildPartSurfaceMeshes,
  createPartFramesProxy,
} from "./setup_rig.js";
// Phase 2 (2026-08-02) — limb registry + visual limping, behind the STRICT
// opt-in `?limbDamage=on`. `limbDamageEnabled()` is the single flag reader;
// with it off `applyLimbLimp` returns on its first line and nothing else in
// this file changes behaviour (the two spawn-side stashes are inert data).
import {
  limbDamageEnabled,
  ensureLimbRegistry,
  applyLimbLimp,
} from "./limbs.js";
// Phase 4 (2026-08-02) — death-time ragdoll, behind the STRICT opt-in
// `?ragdoll=on`. Same post-evaluation overwrite contract as the limp: the
// authored collapse still plays (and still sizes the death-hold window);
// `applyRagdoll` just re-poses the parts after every rig writer while
// `inst._ragdoll` exists. Flag off: `startRagdoll` returns null on its first
// check and the tick gate below is a hoisted-boolean + null read.
import {
  ragdollEnabled,
  startRagdoll,
  applyRagdoll,
  applyFrozenPose,
  transferRagdollPose,
  promotePendingPose,
} from "./ragdoll.js";
// (2026-08-02) — where the ragdoll gets its DIRECTION. Dependency-free
// resolver: projectile impact > attacker position > splatter quadrant >
// seeded azimuth, plus the per-death fall style. Static import is safe (no
// three, no listeners at import time); every call site is inside RAGDOLL_ON.
import { killOptsFor, noteProjectileImpact } from "./kill_impulse.js";
// Hoisted once (the URL cannot change mid-session), so the per-entity tick
// gate is a bare boolean read — same shape as WIREFRAME_MODE / SPAWN_TRACE.
const LIMB_DAMAGE_ON = limbDamageEnabled();
const RAGDOLL_ON = ragdollEnabled();
const RIG_MODULE_ON = readRigModuleFlag();
// FCULL (2026-06-08) — distance horizon for the per-frame entity RENDER
// cull. Only the constant is imported; the cull pass is driven from loop.js
// via `tickEntityRenderVisibility`.
import { CULL_DIST_SQ } from "./culling.js";
import { getOcclusionCuller, ENTITY_PAD_M } from "./occlusion_cull.js";
// A8-M4 (2026-06-12) — generic pre-create event buffer (retail null-object
// analog, `?preCreateBuffer=on`). Pure dependency-free module; ALL wiring
// and flag gating lives in this file (see readPreCreateBufferFlag above).
import { createPreCreateBuffer } from "./pre_create_buffer.js";

// T11 (2026-05-28) — `?velScale=on` gates velocity-scaled locomotion cycle
// speed (anti-ice-skating): the walk/run cycle's playback rate is scaled by
// actual ground speed / authored cycle speed (|MotionData.velocity|); read
// once at module load. try/catch for
// the Node test harness (no `window`).
// T1: default-ON as of 2026-06-05. The runtime `cycleBaseSpeed` denominator now
// resolves (~4.0 run / 2.6 walk) after the prefetch fix in lib.rs cycle_base_speed
// (was 0.0 from a sync-cache miss => velScale silently no-op'd). 'actual' speed
// comes from the wasm `stateGroundSpeed` getter (see tick()/_resolveStateGroundSpeed).
// `?velScale=off` disables. velScale only scales an already-running loco cycle, so
// it stays inert until the stuck-in-idle/walk-run dispatch gap is fixed — harmless.
const VEL_SCALE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return (
      new URLSearchParams(window.location.search).get("velScale")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return true;
  }
})();

// A5-P2 (unification survey 2026-06-11) — `?tweenClock=dt` (default OFF).
// One clock domain for the hook-side-effect tweens
// (`_tickJumpPoseTween` / `_tickScaleHookTween`; the swing/cast pose tickers
// were retired in the WS-B teardown). Retail clocks EVERY animation side effect off the
// single physics quantum inside the one update pass (acclient.c:340659-340780
// — frame crossings, hooks and their side effects all consume the same
// elapsed-time quantum, on the single `Timer::cur_time` static,
// acclient.c:46992). Ours split-brains two clock domains (A5 divergence #8):
// the mixer + `_tickHookOmega` + `_tickMaterialHooks` advance on the loop's
// CLAMPED dt, while these four tweens read `performance.now()` wall clock —
// so a tab-throttle / DT_RECOVERY freeze (or any dt clamping) advances the
// tween family 2s of wall time while the mixer advances ~16ms, desyncing pose
// tweens from the clip state they overlay. ON → the four tickers AND their
// stamp sites (`startMs`) run off `EntityManager._tweenClockMs`, an
// accumulated-dt clock advanced at the top of `tick(dt)` by the SAME dt the
// mixers consume (`_tweenNowMs()` is the single read point); tween phase then
// freezes/advances in lockstep with mixer time. Seeded from wall now at
// construction so absolute timestamps stay monotonic across the gate.
// Deliberately OUT of scope (conservative; stay wall-clock either way):
// `_castBusyUntilMs` (F8-4 anti-spam debounce, not a pose tween),
// `_swingHold.startedMs` + its `setTimeout` peak timers (timer-driven, not
// ticked), `_localSwingEchoes` / `_lastServerSwingMs` (wire-echo dedupe
// windows), and `actionLastUsedMs` (LRU bookkeeping).
const TWEEN_CLOCK_DT = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("tweenClock")?.toLowerCase() === "dt";
  } catch (_) {
    return false;
  }
})();

// F15-2 (2026-06-09) — `?signedMotionSpeed=on` gates REVERSE clip playback
// for a backstep (negative forward_speed). DEFAULT-ON (`!== "off"` reader;
// `?signedMotionSpeed=off` reverts): when OFF a backstepping remote
// moonwalks (forward walk anim while dead-reckoning backward). When
// ON, the locomotion clip's final timeScale is negated for negative motion
// speeds so three.js plays it in reverse. Magnitude for the gait still comes
// from the velScale getter; this only flips direction. Needs a 1070 eye-test.
const SIGNED_MOTION_SPEED = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("signedMotionSpeed")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// F3-4b (2026-06-27) — `?stickyGroundZ` keeps a sticky melee mob GROUNDED.
// DEFAULT-ON (validated 2026-06-27 on real rigs: jumped to z+15, all 3 sticky
// mobs stayed grounded, mobMaxZrise=0; `=off` escape). The legacy F3-4 glue
// eased the mob's Z to the TARGET's Z, so it floated up after a jumping player;
// retail's StickyManager pulls XY + heading only (z zeroed, acclient.c:388557)
// and a monster can't follow/attack an airborne target. When on: release the
// glue while the victim is airborne / vertically out of melee reach (mob reverts
// to its grounded server pose), else glue XY only (own ground Z). `=off` =
// byte-identical legacy (gz = tp.z).
const STICKY_GROUND_Z = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("stickyGroundZ")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// F3-6 (2026-06-27) — `?meleeFaceTarget` snaps a swinging mob to face its melee
// victim at swing start. DEFAULT-ON (validated 2026-06-27: from a perturbed
// 110°-off heading the snap recovers exact facing — fwd·dir 1.0; `=off` escape).
// ACE only broadcasts the attack motion once the attacker is already facing
// within ~5° (→20° point-blank: Monster_Tick.cs:125, IsFacing
// Monster_Navigation.cs:385), but our remote heading-ease lags and the F3-4
// sticky glue never re-faces ("documented follow-on"), so a mob can visibly
// swing while angled off. Mirrors the server's facing guarantee. `=off` =
// byte-identical (swing plays at the eased heading).
// OpenAC comparison 2026-10-04 (doors F5): `?etherealGhost=on` — opt-in.
// Retail `EtherealHook::Execute` → `CPhysicsObj::set_ethereal`
// (acclient.c:319047) flips only collision bits and never touches opacity;
// door On/Off animations carry the hook (ACE Door.cs), so the old default
// turned every opening door 40% see-through mid-swing. OpenAC ignores the hook
// visually too (TranslucencyHookSinkTests). Default = retail (no visual).
const ETHEREAL_GHOST = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("etherealGhost")?.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
})();

const MELEE_FACE_TARGET = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("meleeFaceTarget")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// F15-1 (2026-06-09) — FULL-BODY one-shot overlay. An attack/cast/emote
// one-shot ramps the base locomotion cycle's weight to 0 for its duration
// (restored on its 'finished' event — retail's remove_cyclic_anims-then-re-add),
// so the swing plays at full amplitude over still-running legs instead of
// three.js normalizing overlay+base to ~50/50 (which made a drudge's overhead
// smash look like a wiggle). The `?fullBodyOneShot` flag (default-ON) was
// RETIRED 2026-06-18 (WS-B teardown) — this is now the UNCONDITIONAL path; the
// `=off` half-amplitude / crossfade-the-legs-out fallback is gone.

// F8-1 (2026-06-09) — `?castSpeed=on` (default OFF) paces the local cast-
// gesture chain at ACE CastSpeed=2.0 instead of 1× — without it a level-7 war
// spell animates ~7s client-side vs ~3.5s server-side, so the projectile
// launches and recoil happen while the character is still mid-windup. When
// ON, each gesture's clip timeScale ×2 and its sleep ÷2, and the matching
// wire echo is suppressed (F6-2 stamp-dedup) so the server's 2× windup doesn't
// fight the prediction. Default ON (ACE CastSpeed=2.0); `?castSpeed=off` = legacy
// 1× (broken: the server echoes double the local 1× chain — escape hatch only,
// not a default), pending the batched 1070 eye-test.
const CAST_SPEED = (() => {
  try {
    return (typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castSpeed")?.toLowerCase() !== "off")
      ? 2.0 : 1.0;
  } catch (_) {
    return 1.0;
  }
})();
// WS14 — expose CAST_SPEED so HUD consumers (combat-bar cast-busy sweep) can
// size a cooldown off totalDurationS/CAST_SPEED without re-reading the URL flag
// (default 2.0; a non-default ?castSpeed=off run reads 1.0 here too).
try { if (typeof window !== "undefined") window.__castSpeed = CAST_SPEED; } catch (_) {}

// WS11 (2026-07-12) — `?castGestureLen=off` to disable (DEFAULT-ON, `!== "off"`
// escape per the flag footgun; eye-tested GTX-1070 2026-07-12). Pace the
// local cast chain's per-gesture SLEEP off the MotionTable link length
// (`classifyMotionCommandTyped().durationSec` — the SAME value setSwingMotion
// uses to drive the on-screen gesture, == ACE `GetAnimationLength`) instead of
// the JSON `durationS`. `durationS` is authored from SpellComponentTable._time,
// which equals GetAnimationLength for the round-trip WINDUP gestures but is
// ~1.7-3x too long for the single-throw CAST gesture (talisman _time), so
// today's chain-end (CasterEffect / busy-clear / recoil) drifts +0.35..0.76s
// past the server's projectile launch (ACE paces GAL/CastSpeed — see
// WS11-timing-parity.md F1/F3). ON => chain-end == on-screen gesture == server
// cadence (within ~40ms). OFF => byte-identical to today (uses durationS).
const CAST_GESTURE_LEN = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castGestureLen")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// F8-4 (2026-06-09) — `?castStateMachine` (DEFAULT-ON — `!== "off"` reader;
// `=off` disables). A minimal client
// cast-state machine: while a cast is in flight, a REPEAT cast request for the
// same caster is ignored instead of restarting the windup animation every
// click (spam-clicking a target otherwise visibly "recasts" while the server
// is still executing the first cast). The busy window auto-expires (cap) so a
// dropped UseDone can't wedge casting; clearCastBusy / cancelCastSequence clear
// it early. 1070 cast-feel eye-test still owed.
const CAST_STATE_MACHINE = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castStateMachine")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// WS01 (2026-07-12) — `?castReliability=off` to disable (DEFAULT-ON, `!== "off"`
// escape per the castSpeed/castStateMachine/castFizzle workflow; eye-tested
// GTX-1070 2026-07-12). Bundles three correctness fixes to the LOCAL cast
// prediction so the arms actually rise: (a) look the gesture up under the Magic
// stance explicitly so a stale `inst.currentStance` (e.g. NonCombat, which carries
// ZERO magic gestures — DAT-verified vs player MT 0x09000001) can't silently miss;
// (b) prefetch/warm every chain clip up front (await-capped) so the fire-and-forget
// bake can't outlive a min-50ms windup sleep; (c) only note the swing-echo dedup
// when the prediction will actually animate, so the default-ON dispatchParity echo
// dedup can't swallow the server echo after a silent no-op. `=off` = pre-WS01.
const CAST_RELIABILITY = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castReliability")?.toLowerCase() !== "off";
  } catch (_) { return false; }
})();
// WS01 — `?castBusyScope` (DEFAULT-ON, `?castBusyScope=off` escape): scope the F8-4
// busy drop to the SAME spellId so a different-spell weave the server will accept
// still animates locally. Rides `?castStateMachine`. Eye-tested GTX-1070 2026-07-12
// (suppress.busyWindow=1 on same-spell spam, different-spell recast animated).
const CAST_BUSY_SCOPE = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("castBusyScope")?.toLowerCase() !== "off";
  } catch (_) { return true; }
})();
// WS01 — the only magic stance retail uses (low16; the wasm masks &0xFFFF, and the
// DAT bake helpers mask &0xFFFF too, so low16 resolves the identical clip as the
// full 0x80000049). index.html stance consts.
const CAST_MAGIC_STANCE = 0x0049;

// WS09 (2026-07-12) — `?castSyntheticCasterVfx=off` = the fix (DEFAULT ON =
// today's behavior). ACE broadcasts the CasterEffect GameMessageScript to the
// LOCAL caster too (EnqueueBroadcast sendSelf=true, WorldObject_Networking.cs:
// 1428), so the wire already delivers it via 0xF755→kind=30→playEffect at cast
// RELEASE. The chain-end synthetic emit below therefore DOUBLE-FIRES the glow
// (and too early — local chain end, no RTT) for the ~74 caster_effect≠0 spells
// (portals/lifestones/recalls/life-buffs; ALL war+void spells are
// caster_effect=0, so this never affects a war/void cast). The wire-only fix is
// `=off`: it suppresses the synthetic so the wire is the SOLE CasterEffect
// source (retail timing; auto-suppressed on fizzle since ACE sends
// PlayScript.Fizzle, not CasterEffect). Per foundation §4.3 (WS09-verify mustFix
// #3) this risky feel change is DEFAULT-OFF-as-fix: the un-eye-tested
// suppression is the opt-in (`=off`) and E1/E2 are the merge gate for flipping
// the default. Default/absent = synthetic fires (byte-identical to today); the
// wire copy renders through the identical resolver, so if E1 confirms the wire
// paints on the local rig, flip this to `!== "on"`.
//
// 2026-10-07 — FLIPPED: DEFAULT OFF (strict `?castSyntheticCasterVfx=on`
// restores the synthetic). The wire copy is confirmed: the 2026-08-12 probe
// (playCastSequence note below) measured ACE delivering the whole cast to the
// caster — every windup UpdateMotion AND the CasterEffect GameMessageScript
// (WorldObject_Magic.cs:358-359) — and the local cast animation already plays
// from that wire, not from this chain. Retail has a single source too: the
// client never fabricates a cast effect (`ClientMagicSystem::
// FreeHandsAndCastSpell`, acclient.c:403775, sends and stops), and OpenAC
// renders caster/target effects only from the server's 0xF754/0xF755
// (EntityEffectController). The synthetic glow fired twice per buff/recall
// cast, the first one a round-trip early.
const CAST_SYNTHETIC_CASTER_VFX = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URLSearchParams(window.location.search)
      .get("castSyntheticCasterVfx")?.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
})();

// OMEGA (2026-06-06) — `?cycleOmega` gates applying a cycle's authored
// MotionData.omega (continuous angular velocity) to the rig. DEFAULT ON since
// render-audit T1c (2026-06-09; `=off` opts out). Originally held off for a
// 1070 eye-test on a real authored spinner (sign/fan) + a reachability scan.
// EXCLUDES turn-in-place cycles — their omega is the turn rate already driven by
// server heading / heading-ease, so applying it would double-count and break
// turning (the player MT TurnRight cycle carries omega [0,0,-1.5], confirmed via
// the wasm `cycleOmega` getter). Integrated in `_tickHookOmega` (summed with
// SetOmega hook omega). Under `=off` no `_cycleOmega` is ever set, so all
// consumers see undefined (the pre-T1c behaviour).
// default-ON flipped per render-audit T1c (2026-06-09), opt-out ?cycleOmega=off, pending 1070 eye-test
const CYCLE_OMEGA_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return (
      new URLSearchParams(window.location.search).get("cycleOmega")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return true;
  }
})();

// MT_CLASS_FALLBACK (motion-dispatch audit §5, 2026-06-09) — `?mtClassFallback=on`
// gates the Stage-1 generic class-mask fallback in `classifyMotionCommand`: when
// no static command Set matches, derive a play-kind from the command class byte
// instead of returning null. DEFAULT-ON (`!== "off"` reader; `=off` disables);
// the 1070 GPU eye-test is still owed.
const MT_CLASS_FALLBACK_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("mtClassFallback")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// IDLE_FIDGET (idle-fidget, 2026-06-09) — `?idleFidget=on` gates an autonomous
// client-side idle-fidget timer. Retail's client played random idle
// variations / fidget gestures so a standing creature/NPC/player is NOT frozen
// in one looping Ready idle (the single most-noticeable non-retail tell). Per
// entity, after it has been continuously in a plain standing idle (Ready/idle
// cycle, |velocity| ~0, no action/jump/swing/cast overlay, server velocity
// stale) for a per-entity randomized interval, we PROBE the MotionTable for a
// random idle-variation/fidget link clip and play ONE as a LoopOnce overlay via
// `_tryPlayLink`; it returns to the Ready cycle when the overlay ends. The
// fidget is JS-ONLY (no server packet, no Rust) and immediately yields to any
// real server motion/action (the per-entity gate re-evaluates every coarse
// timer check and cancels as soon as locomotion / a tween / a non-idle command
// arrives). DEFAULT-ON (`!== "off"` reader; `=off` disables); the 1070 GPU
// eye-test is still owed.
const IDLE_FIDGET_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("idleFidget")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
// G-4 / F3-1 follow-on (2026-06-11) — `?projectileGravity=on` gates the
// ballistic ARC for gravity-class projectiles (arrows/bolts/thrown — the
// spawns whose ObjectCreate carried PhysicsState::GRAVITY 0x400 alongside
// MISSILE 0x40; war-magic bolts fly flat in retail and are untouched).
// When on, tick()'s ballistic branch applies -9.8 z" (AC world frame,
// ACE PhysicsGlobals gravity) to `lastVel` before integrating, so the
// flight curves instead of flying constant-velocity. DEFAULT-ON
// (flipped in the default-ON wave; url-flags.md row `projectileGravity`,
// `=off` escape). Inert for any pkg/ predating the
// `entityProjectileHasGravity` export (soft-guarded, wasm manifest v2).
const PROJECTILE_GRAVITY_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("projectileGravity")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
const PROJECTILE_GRAVITY_Z = -9.8; // m/s^2, AC frame (z up)
// WS10 (2026-07-12): `?projectileImpactStop` (DEFAULT-ON, `=off` escape) — a ballistic
// projectile that receives a VectorUpdate has impacted (ACE sends none in-flight for a
// PhysicsState::MISSILE — the ONLY VectorUpdate a projectile gets is the zero-velocity
// impact stop, SpellProjectile.ProjectileImpact), so stop self-integrating. Prevents an
// arc husk from accruing gravity during its 5 s NoDraw pre-Destroy window. Off = legacy
// (masked by the NoDraw hide).
const PROJECTILE_IMPACT_STOP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("projectileImpactStop")?.toLowerCase() !== "off";
  } catch (_) { return true; }
})();
// WS10 (2026-07-12): `?projectileGroundClampSkip` (DEFAULT-ON, `=off` escape) — exempt an
// airborne MISSILE projectile from the spawn ground-clamp. Its launch Z is server-authored
// to ~2/3 caster height (WorldObject_Magic.CalculatePreOffset); clamping a bolt spawned
// below the terrain at its (wx,wy) — e.g. firing across a rise — would jump the launch
// point onto the hillside. Off = legacy (projectiles clamped like any outdoor object).
const PROJECTILE_GROUND_CLAMP_SKIP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("projectileGroundClampSkip")?.toLowerCase() !== "off";
  } catch (_) { return true; }
})();
// PROJ-VIS (2026-10-05) — spell/missile projectile render fidelity. All four are
// DEFAULT-ON, opt-out only (explicit off-family value); absent = ON.
//   ?projectileLights=off       — Setup LightInfo on a MISSILE (32 of 43 projectile
//                                 Setups carry one, e.g. Lightning Bolt 0x02000D52)
//                                 is attached through the fixed light pool and lit
//                                 from spawn when PhysicsState::LIGHTING_ON (0x800)
//                                 is set (retail CPhysicsObj::set_state →
//                                 CPartArray::InitLights, acclient.c:322172). Off =
//                                 legacy (projectile lights only under ?entityLights=on,
//                                 dark until a SetLight hook that never comes).
//   ?projectileLaunchClock=off  — integrate from the ObjectCreate RECEIPT time
//                                 (loop.js stamps `meta.recvMs`) instead of the end of
//                                 the async rig build, so spawn latency no longer
//                                 leaves the bolt trailing its true flight (and
//                                 exploding short of the target).
//   ?projectileTerrainStop=off  — stop a ballistic projectile that dives under the
//                                 outdoor terrain surface (retail client collides
//                                 missiles itself; ACE's impact stop arrives a
//                                 round-trip later).
//   ?projectileDefaultScriptSpawn=off — restore playing a MISSILE's wire
//                                 default_script at spawn. Retail plays that script
//                                 only on COLLISION (ACCWeenieObject::DoCollision →
//                                 play_default_script when SCRIPTED_COLLISION,
//                                 acclient.c:436857-436870); ACE authors it as
//                                 PlayScript.ProjectileCollision (SpellProjectile.cs:90).
//                                 Playing it at spawn raced the Setup default_script
//                                 (the bolt's trail, acclient.c:320867) for the
//                                 single `_particleChainsAttached` slot, so a bolt
//                                 either lost its trail or burst a collision splash
//                                 at the caster's hands.
function _projFlagOn(name) {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get(name);
    if (v == null) return true;
    const s = String(v).toLowerCase();
    return !(s === "off" || s === "0" || s === "false" || s === "no");
  } catch (_) { return true; }
}
const PROJECTILE_LIGHTS_ON = _projFlagOn("projectileLights");
const PROJECTILE_LAUNCH_CLOCK_ON = _projFlagOn("projectileLaunchClock");
const PROJECTILE_TERRAIN_STOP_ON = _projFlagOn("projectileTerrainStop");
const PROJECTILE_DEFAULT_SCRIPT_SPAWN_SKIP_ON = _projFlagOn("projectileDefaultScriptSpawn");
// PROJ-SPIN (2026-10-05, `?projectileOmega=off` escape, default ON): spin a
// ballistic missile by its ObjectCreate PhysicsDesc omega (wasm
// `entityProjectileOmega`). ACE sends Omega = (2π·RotationSpeed, 0, 0) and
// clears ALIGN_PATH for RotationSpeed projectiles (Whirling Blade, Elemental
// Fury, thrown weapons — SpellProjectile.cs:120-126, Creature_Missile.cs:378);
// retail `UpdatePhysicsInternal` applies it every quantum as a WORLD-frame
// `Frame::grotate(omega·quantum)` (acclient.c:317777-317783, grotate =
// pre-multiply, acclient.c:357422). Off = legacy (no spin).
const PROJECTILE_OMEGA_ON = _projFlagOn("projectileOmega");
/** PhysicsState::LIGHTING_ON (acclient.c:322181 `BYTE1(new_state) & 8`). */
const PHYSICS_STATE_LIGHTING_ON = 0x800;
/** Below-terrain tolerance (m) before the client-side terrain stop fires. */
const PROJECTILE_TERRAIN_STOP_EPS = 0.25;
/** A pending impact stop older than this (ms) is stale and pruned. */
const PROJECTILE_PENDING_STOP_TTL_MS = 10000;
// Survey A11-S0 (2026-06-11): retail `CreateBlockingParticleEmitter`
// (acclient.c:329528-329565) returns 0 and does NOT replace when the
// emitter id is already live — the opposite of the non-blocking
// `CreateParticleEmitter` replace path. Our walkers route hook type 26
// (CreateBlockingParticle) identically to 13 (CreateParticle) into the
// replace-semantics addEmitter, which restarts persistent effects retail
// would leave running. DEFAULT-ON (`!== "off"` reader): hook 26 takes retail
// blocking semantics unless `?blockingParticleParity=off` restores replace.
const BLOCKING_PARTICLE_PARITY_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("blockingParticleParity")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
// Coarse timer cadence (ms) — how often the per-entity idle-fidget bookkeeping
// runs in tick(). The whole IDLE_FIDGET feature is inert when the flag is off,
// and even when on this only walks the entity map ~3x/sec (no per-frame cost on
// the fidget path). The fire interval itself is randomized per entity in
// [IDLE_FIDGET_MIN_S, IDLE_FIDGET_MAX_S] and re-rolled each time a fidget fires.
const IDLE_FIDGET_CHECK_INTERVAL_MS = 333;
const IDLE_FIDGET_MIN_S = 6.0;
const IDLE_FIDGET_MAX_S = 15.0;
// |velocity| (m/s) below which an entity counts as "standing still" for the
// idle-fidget gate. The EMA gait speed and the last server VectorUpdate must
// both be under this (a tiny epsilon to tolerate dead-reckon micro-jitter).
const IDLE_FIDGET_SPEED_EPS = 0.05;
// Class-0x13 ChatEmote idle-variation / fidget commands (full 32-bit
// MotionCommand keys — the link inner key is the full command, never the
// low-16; see `_tryPlayLink` / the C3 fix at setMotion's emote path). This is
// the universally-authored "harmless standing gesture" subset of the retail
// /emote set (ACE MotionCommand.cs L138-151): a fidget plays one of these as a
// LoopOnce overlay ONLY when the entity's MotionTable actually has a link for
// it under (stance, Ready) — probed via `lookupMotionLinkForSwing`, so an MT
// that lacks the clip is skipped (no guessing, graceful no-op). Picked to read
// as ambient idle fidgets rather than communicative emotes (no waves / kisses).
const IDLE_FIDGET_COMMANDS = [
  0x13000083, // Nod
  0x13000085, // ShakeHead
  0x13000086, // Shrug
  0x13000088, // Akimbo
  0x1300008a, // Salute
  0x1300008b, // ScratchHead
  0x1300008d, // TapFoot
  0x13000090, // YawnStretch
];

// T9 (2026-05-28) — `?dynLod=on` gates DYNAMIC entity LOD. Spawn already picks
// a degrade band once (frozen); this re-queries the band at the live distance
// (throttled) and despawn+respawns the entity at the new band when it crosses
// — the simplest correct way to "rebind the mixer" (the spawn path rebuilds
// rig + mixer + actions). DEFAULT-ON (`!== "off"` reader; `?dynLod=off`
// disables — respawn flicker + distance behaviour change are the trade-off). The spawn LOD distance frame-fix ships unconditionally; only the
// dynamic re-pick is gated.
const DYN_LOD_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search).get("dynLod")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
// Throttle the dynamic-LOD recheck — distance bands are coarse, so ~2 Hz is
// plenty and keeps the per-entity async band query off the hot path.
const DYN_LOD_INTERVAL_S = 0.5;
/** ?partDegrade camera position scratch. */
const _pdCam = { x: 0, y: 0, z: 0 };
// R7 (runtime ObjScale/translucency, 2026-06-09) — `?runtimeObjScale=on`
// (default OFF). A mid-game `UpdateObject` (0xF7DB) re-sends the full ODD,
// which can carry a NEW obj_scale (server grow/shrink) or TRANSLUCENCY
// (ghost/cloak). The kind=6 APPEARANCE path drove `applyAppearance` but kept
// the SPAWN-time scale/opacity (newMeta inherits oldMeta), so those runtime
// changes never reached the rig. When ON, `applyAppearance` overrides
// `newMeta.{objScale,physicsTranslucency}` from the wire — but ONLY when the
// value is non-sentinel: the Rust side sends the real value on `UpdateObject`
// and the `0.0`/`-1.0` sentinels on `ObjDescEvent` (equip/dye/death carry no
// scale/translucency on the wire), so the everyday equip/dye path never resets
// a grown/ghosted entity. Default OFF pending a 1070 eye-test (re-scales the
// rig via despawn+respawn — same path SG-D uses).
// INTEGRATED always-on — 1070 eye-test PASSED 2026-06-10 (`@objscale` grows/
// shrinks the rig live). JS, live on reload. Was the default-OFF
// `?runtimeObjScale=on` gate.
const RUNTIME_OBJSCALE_ON = true;
// ─────────────────────────────────────────────────────────────────
// BUG-3 — `?appearanceUrgent=off` (DEFAULT ON since 2026-08-04,
// user-verified live; docs/url-flags.md:481). The reader below is
// `!== "off"`, so an absent param reads ON — DELIBERATE here, not the
// memory-§4 flag-default footgun. `?appearanceUrgent=off` is the escape.
//
// SYMPTOM: equipping armour (or a spell landing on you) takes several
// seconds to show on a settled scene.
//
// NOT A POLL. The trigger is already fully message-driven: the wasm recv
// loop arms `ENTITY_UPDATE_KIND_APPEARANCE` (=6) directly off
// `GameMessage::UpdateObject` (0xF7DB, lib.rs:45196) and
// `GameMessage::ObjDescEvent` (0xF625, lib.rs:45280); index.html's rAF
// drain takes the zero-copy fast path for any batch <= 256
// (index.html:10419) and hands it to `dispatchEntityUpdate`
// (loop.js:3641) → `_armAppearance` (loop.js:3568) → `applyAppearance`
// in the SAME frame the packet lands.
//
// THE REAL COST IS THE ASSET WALK THAT FOLLOWS. `applyAppearance`
// despawn+respawns the rig, and `AnimationCache` folds the equip's
// modelChanges/textureChanges/palette into its key
// (`_substitutionSuffix`, animation.js:510-530), so a NEW piece of armour
// is always a cache MISS → a full `fetchEntityAnimationKeyframes`. That
// export walks Setup → substituted GfxObjs → MotionTable → Animations via
// `prefetch::ensure_walk_prefetched_keyed` (lib.rs:23026/:23070) — the
// NON-urgent variant. `run_walk_loop` (prefetch.rs:341-438) is up to 8
// SEQUENTIAL discovery rounds (`for _round in 0..8`, :375), each at least
// one full RTT, and each round's `source.prefetch(&keys)` (:416) takes a
// `fetch_sem` permit and rides `FetchPriority::Low`
// (manifest_source.rs:737-753). Over a high-latency tunnel that is
// several seconds of pure serialised round-trips.
//
// ON: pass the same `isNearPlayerLb` urgency hint the recolour path
// already uses at :4177 down through `AnimationCache.get(opts.urgent)` to
// the wasm fetcher's trailing `urgent` arg, so an appearance change on a
// rig the player can actually see runs its walk on `prefetch_urgent`
// (semaphore bypass + default browser priority) instead of behind the
// speculative ring bakers. Also lifts the two `materialCache.preload`
// sites that were still lane-less. No new requests and no new queue — the
// same batches move to the lane that already exists.
//
// REQUIRES A WASM REBUILD: the trailing `urgent: Option<bool>` on
// `fetchEntityAnimationKeyframes` is new (lib.rs). With a stale pkg/ the
// extra arg is coerced away harmlessly and the flag is simply inert.
const APPEARANCE_URGENT_ON = (() => {
  try {
    return (
      new URLSearchParams(globalThis.location?.search || "").get("appearanceUrgent")
      ?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
// Render-completeness Waves-2 P3 (2026-05-29) — CallPES (AnimationHook
// type 19) is a RECURSIVE sub-script invocation: a PhysicsScript can call
// another PhysicsScript, which can call another, etc. (354 retail scripts
// carry CallPES). Cap the chain-walker recursion so a self-referential or
// cyclic script graph can't blow the stack / spawn-storm. 3 levels covers
// every retail script (none nest beyond 2); the walker bails past it.
const MAX_CALL_PES_DEPTH = 3;
// PORTAL-LOOP (2026-08-04) — `?callPesLoop` (default ON; `=off` restores the
// depth-capped behavior). The depth cap above conflates STATIC NESTING (what
// its "none nest beyond 2" survey measured) with SELF-LOOPING: ambient scripts
// like the portal swirl (Setup 0x020001B3 → default_script 0x3300067A:
// 2×CreateParticle + SoundTweaked + CallPES back into the loop) re-invoke
// themselves indefinitely. Retail `CPhysicsObj::CallPES`
// (acclient.c:318973-319005) just SCHEDULES the sub-script — there is no depth
// counter anywhere in the retail path — so a looping script runs for the
// object's whole life. Our A11-S1 queue arm passed `depth + 1` per iteration,
// so every portal's swirl died after 3 loop iterations (live-probed at
// Holtburg: the per-portal ScriptManager settles at scriptsCompleted=4,
// active=false, zero emitters — the "portals never/sometimes appear" bug).
// On the queue path a CallPES is ASYNC scheduling into the owner's serialized
// queue (fetch → addScript), never stack recursion, so the stack-safety half
// of the cap is moot there; the spawn-storm half is covered instead by a
// per-owner pending-script bound (`MAX_OWNER_SCRIPT_QUEUE` — a branching
// script bomb saturates its own queue and drops, while a self-loop keeps at
// most one pending sub-script). The legacy (`?scriptQueue=off`) walker keeps
// the old depth accounting untouched.
const CALL_PES_LOOP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("callPesLoop")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
const MAX_OWNER_SCRIPT_QUEUE = 8;
import { getCastSequence } from "../ui/ac_spell_cast_sequence.js";
// Track B7 (2026-06-08): spawn-time PhysicsScriptTable prewarm. Reuses the
// Phase 49 cached facade so the first object-triggered PlayEffect on this
// entity resolves warm (table + scripts + emitters already in the DAT
// caches) instead of paying the full cold async chain at cue time.
import { fetchPhysicsScriptTable } from "../ui/ac_physics_script_table.js";
// T6: reuse the particle runtime's shared RNG hook so the CallPES delay
// jitter is the same mockable uniform[0,1) the rest of scene3d/particles
// draws from (Math.random by default, deterministic under setRng in tests).
import { rng as timeRng, currentTime, particleClockMode } from "./particles/time_rng.js";
// A11-S2 (unification survey 2026-06-11) — `?particleOwner=on` (default OFF)
// routes emitter lifecycle through the ONE owner-keyed facade
// (`scene3d/particles/owner_registry.js`): object-scoped script handles
// (retail per-CPhysicsObj ParticleManager table, acclient.h:31040-31045),
// single `destroyAllForOwner` teardown replacing `_particleEmittersForGuid`.
// Off-path = the legacy per-guid map below, byte-identical.
import { ownerRegistry, particleOwnerOn } from "./particles/owner_registry.js";
// A11-S1 (unification survey 2026-06-11) — shared PhysicsScript executor.
// `?scriptQueue` (DEFAULT-ON — `!== "off"` reader; `=off` restores the
// legacy walker) routes the entity chain walker's hooks
// through a per-owner time-ordered `ScriptManager` that fires them via the
// SHARED `_fireHook` executor (ROADMAP §2 seam: reuse, never a 4th copy),
// instead of the legacy per-hook wall-clock `setTimeout` walk. Closes the
// G14 visual-hook routing gap as a side effect (16/20/23/24/25 now reach
// `_fireHook`). Off-path = the unchanged legacy walker below.
import { ScriptManager } from "./script_manager.js";
const SCRIPT_QUEUE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("scriptQueue")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();
// SCRIPTMGR-RATE (2026-08-11) — `?scriptHookTime` (DEFAULT ON; `=off` restores
// the legacy collapsed schedule). `_decodePhysicsScriptHookEntry` emits the
// `AnimationHookJs` shape `_fireHook` reads, whose hook-offset field is named
// `time`. `ScriptManager` keys its ENTIRE schedule off `entry.startTime` — the
// `addScript` sort comparator, its `length` derivation, and `_armNextHook`
// (script_manager.js; symbol anchors, the line numbers move) — so every decoded entry
// read `+undefined || 0` ⇒ 0: each script's `length` collapsed to 0 and every
// hook armed at `script.startTime + 0`. A 0x33 chain therefore fired ALL its
// hooks in the first `update()` that reached it, and a CallPES self-loop
// re-armed with zero delay — one full loop iteration PER FRAME.
// Measured against the real DAT (client_portal.dat 0x330006DA = SoundTweaked
// @t=0 + CallPES(self, pause=0.0) @t=2.7): a 400 s session at 17.5 fps runs
// `scriptsCompleted` to exactly 7,000 (the PORTAL-SWIRL-RENDER side
// observation, reproduced arithmetically) instead of 400/2.7 ≈ 148 — a 47x
// over-run that also replays the loop's SoundTweaked ~17x/s.
// ON: the decoder additionally carries `startTime` (the SAME `+e.startTime||0`
// it already computes for `time`), so the queue honors per-hook offsets like
// retail `ScriptManager::NextHook` (acclient.c:329142-329187) and like the
// legacy `?scriptQueue=off` walker's per-hook `setTimeout` delays. Nothing
// else changes: `time` is still emitted for `_fireHook`, and the hook payload
// decode is untouched. `=off` is the byte-identical legacy (collapsed) arm.
// FOOTNOTE — the derived `length` is EXACT, not the approximation
// script_manager.js's header calls it: retail `PhysicsScript::UnPack`
// (acclient.c:336452-336528) qsorts `script_data` then assigns
// `PhysicsScript::length` from the LAST entry's `start_time` (the two dwords
// written at `v4+18`/`v4+19`, immediately past `num_in_array`), i.e. retail's
// own `length` IS max(start_time). No wasm getter is needed.
const SCRIPT_HOOK_TIME_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("scriptHookTime")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A5-P1 (2026-06-12, W3+ S5) — `?hookDrain` (DEFAULT-ON — `!== "off"`
// reader; `=off` disables) routes the
// animation-timeline hook executor through the retail queue-then-drain
// shape: (a) finish-drain — a LoopOnce overlay that crosses its clip end
// between two rAFs still fires its trailing hooks in (lastTime, duration]
// exactly once (retail clamp-at-high_frame + fire-every-crossed-frame,
// acclient.c:340697-340727; pure planner `scene3d/hook_windows.js`); and
// (b) deferred fire — hooks queue into `inst._hookFireQueue` (retail
// `add_anim_hook`, acclient.c:322063-322073) with the overlay's `animDone`
// record AFTER its trailing hooks (acclient.c:340725 → :340764-340774)
// and drain at the END of the per-instance tick body, after every
// pose/tween/material application (our analog of process_hooks-after-
// position-resolve, acclient.c:320030-320035). Off-path = the unchanged
// inline executor, byte-identical. ScriptManager-fired hooks (PhysicsScript
// chain, wall-clock-ordered) stay INLINE — merging the two queues is
// explicitly out of P1 scope.
const HOOK_DRAIN_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("hookDrain")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// A11-S5 / G14 (2026-06-12, W3+ remainder) — `?defaultScriptSpawn`
// (DEFAULT-ON since the flip waves; `=off` opts out — the "(default OFF)"
// note below predates the flip, P14 fleet packet 2026-07-04) closes the
// spawn-time DefaultScript auto-resolve gap
// (survey A11 §3 row 9): the wire PhysicsDesc `default_script` is usually a
// PScriptType ENUM (+ `default_script_intensity` mod weight), NOT a 0x33
// DID — the wasm spawn payload filters it out (`physicsScriptDid` = raw
// 0x33 only), so entities with PScriptType defaults showed no ambient
// effect at spawn AND their DefaultScript(17)/DefaultScriptPart(18)
// animation hooks fired into a 0. Retail resolves it through the object's
// PhysicsScriptTable: `play_default_script` →
// `PhysicsScriptTable::GetScript(default_script, default_script_intensity)`
// → `play_script_internal` (acclient.c:320351-320376; GetScript picker
// :336552 — first entry whose mod >= intensity). When ON,
// `_resolveDefaultScriptDid` runs that chain (new `entityDefaultScript` /
// `entityDefaultScriptIntensity` session-handle getters — typeof-guarded, a
// pre-rebuild pkg/ soft-degrades to 0 — + the Phase 49 table facade + the
// Phase 51/53 `pickScriptEntry` picker) and the resolved 0x33 plays through
// `_attachParticleChainForEntity`, which routes onto the A11-S1
// `ScriptManager.addScript` queue under `?scriptQueue=on` (the stage's
// intended pairing) or the legacy walker otherwise. Wired at THREE retail
// trigger points: the spawn arm (the survey's "spawn-time auto-play" —
// note retail's own literal triggers are DefaultScriptHook 17/18,
// acclient.c:342324-342334, and missile env-collision DoCollision,
// :436861-436870; ACE-era content authors DefaultScript as the ambient
// spawn effect, hence the survey framing) plus the hook 17/18 PScriptType
// fallback. DEFAULT-ON — the reader below is `!== "off"`, so an ABSENT param
// resolves ON. `?defaultScriptSpawn=off` is the escape, and THAT arm is the
// byte-identical (0x33-only) behavior. (The old note here read "Default OFF",
// which described the escape arm and not the default; audit 2026-08-02.)
const DEFAULT_SCRIPT_SPAWN_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("defaultScriptSpawn")?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

// Track B (2026-06-24) — `?setupDefaultScript` (DEFAULT-ON, `=off` opts
// out — see the 2026-06-24 note in the reader below; the old "(default
// OFF)" here was stale, P14 fleet packet 2026-07-04) honors the
// entity's SetupModel `default_script_id` (a 0x33 PhysicsScript DID baked in
// the Setup DAT), the DAT-driven ambient particle chain dynamic entities
// currently ignore. Statics already honor it (`statics.js`
// attachStaticDefaultScripts ← wasm fetch_landblock_objects), but the entity
// spawn path only reads the WIRE PhysicsDesc default_script (DEFAULT_SCRIPT_SPAWN_ON
// above) + the raw 0x33 `physicsScriptDid` — never the Setup's own default_script.
// That gap hides e.g. the Burning Sands Katar flame (Setup 0x0200051C →
// default_script 0x33000347 → 3× CreateParticle → emitters 0x3200026E/0x32000270).
// Retail: acclient.c:320867 `if (setup->default_script_id.id) play_script_internal(...)`.
// When ON, the entity-spawn arm fetches the Setup's default_script via the wasm
// `fetchSetupDefaultScript` getter and routes the 0x33 DID through the same
// `_attachParticleChainForEntity` walker the other arms use (anchored on `root`,
// so wield carries it for free). Default OFF = byte-identical.
const SETUP_DEFAULT_SCRIPT_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search)
      .get("setupDefaultScript");
    if (v == null) return true; // 2026-06-24: DEFAULT-ON (retail-faithful; `=off` to opt out)
    const s = String(v).toLowerCase();
    return !(s === "off" || s === "0" || s === "false" || s === "no");
  } catch (_) {
    return false;
  }
})();

// AC InterpretedMotionCommand low-16 constants — used for
// category-agnostic classification. The wasm export returns the full
// u32 (`0x4500_xxxx` NonCombat / `0x4400_xxxx` combat / etc.); we mask
// to the low 16 bits and compare against retail's
// InterpretedMotionCommand enum so any stance's walk/run/stop maps to
// the same locomotion family. Mirrors `index.html:4377-4380`'s
// MOTION_CMD_* constants.
const CMD_LOW_STOP = 0x0004;
const CMD_LOW_WALK_FORWARD = 0x0005;
const CMD_LOW_WALK_BACKWARDS = 0x0006;
const CMD_LOW_RUN_FORWARD = 0x0007;
// Ready (0x41000003 — low 0x0003) is the stance-aware base pose:
// "weapon stowed" in NonCombat, "fists up" in HandCombat, "drawn"
// in SwordCombat, etc. Each stance defines its own Ready cycle in
// `MotionTable.cycles[(stance, Ready)]`. ACE broadcasts an
// UpdateMotion with cmd=Ready when the player toggles combat
// stance from idle, so the rig needs to swap to the new stance's
// Ready cycle to show the weapon-drawn pose. Pre-fix this command
// fell through `classifyMotionCommand` → null → setMotion treated
// it as STOP → fadeOutCurrent, and the stance change was tracked
// statefully (UI label updated) but never visualized on the rig.
const CMD_LOW_READY = 0x0003;
// Dead (0x0011, MotionCommand.cs L24) — the post-death collapse/prone motion.
const CMD_LOW_DEAD = 0x0011;
// (2026-07-06) Death-collapse handoff constants. Retail resolves Dead in two
// pieces (CMotionTable::GetObjectSequence, acclient.c:337763): the
// (stance,Ready)→Dead LINK carries the COLLAPSE (falls down), the (stance,Dead)
// CYCLE is the settled prone HOLD. Our Dead bake only baked the cycle (via the
// from=0 cycle path), so creatures snapped straight to prone and never played
// the collapse — the "death animation not playing for many monsters" bug. To
// bake the collapse we resolve the LINK: pass the FULL Dead command as the
// to-motion (the link inner-key is UNMASKED — motion_table.rs:164 — so the wire
// low-16 0x0011 misses; only 0x40000011 matches the on-disk key) with Ready as
// the from-motion. `expand_motion_command_low16` (player/types.rs:100) has no
// 0x0011 arm, so the wire delivers Dead as a bare 0x0011 (lib.rs:39399) — hence
// the explicit full constants here.
const CMD_DEAD_FULL = 0x40000011;   // full cyclic Dead command (link inner-key)
const CMD_READY_FULL = 0x41000003;  // Ready — the from-motion for the collapse link
// ObjectDescriptionFlag.Corpse (protocol ObjectDescriptionFlag.generated.cs:87);
// the on-wire "this object is a corpse" marker on a CreateObject.
const ODF_CORPSE = 0x00002000;
// Corpse↔creature death-handoff: a spawning corpse correlates to a creature
// that received Dead within this horizontal/vertical radius (m) and is still
// mid-collapse. Wide enough to absorb any residual dead-reckon overshoot.
const DEATH_COLLAPSE_RADIUS_M = 4.0;
const DEATH_COLLAPSE_RADIUS_SQ = DEATH_COLLAPSE_RADIUS_M * DEATH_COLLAPSE_RADIUS_M;
// Corpse grace when no authored collapse length resolved (mirrors loop.js
// DEATH_HOLD_MS): the creature has no Ready→Dead link (bake fell back to the
// 1-frame cycle hold), so there is no real collapse to wait on.
const DEATH_HOLD_FALLBACK_MS = 2000;
// Corpse correlation stays open this long past the authored collapse end —
// the corpse CreateObject rides an async time-sliced spawn queue and can land
// late in a busy dungeon (2026-08-02 handoff trace, bug #3).
const DEATH_CORRELATE_GRACE_MS = 4000;
// Monotonic-ish wall clock shared by the death stamps (same source as the
// `_deathAt` stamp and loop.js `_armRemove`, so their arithmetic is coherent).
const _entityNowMs = () =>
  (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
// Sidestep / turn-in-place locomotion. Values from
// `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:20-23`:
// TurnRight=0x6500000D, TurnLeft=0x6500000E, SideStepRight=0x6500000F,
// SideStepLeft=0x65000010 — low 16 bits are the substate. Wave 1
// Phase 1.3 (2026-05-26): wired into `classifyMotionCommand` as
// "walk" so they dispatch through the cyclic-locomotion path with a
// stance-aware AnimationCache lookup, matching how the motion table
// stores them in `MotionTable.cycles[(stance, cmd)]`.
const CMD_LOW_TURN_RIGHT = 0x000D;
const CMD_LOW_TURN_LEFT = 0x000E;
const CMD_LOW_SIDESTEP_RIGHT = 0x000F;
const CMD_LOW_SIDESTEP_LEFT = 0x0010;

// Wave 5 Phase 5.1 (movement-animation overhaul, 2026-05-26):
// fall-related MotionCommand low-16 substates.
//
// - `Falling (0x40000015)` — looping in-air state. Present as a CYCLE
//   in MT 0x09000001 for every player stance except Sling /
//   TwoHandedStaff / Graze. Classified as "walk" so the renderer
//   fetches it via `MotionTable.cycles[(stance, cmd)]` and plays it
//   LoopRepeat. The wasm recv loop emits this on the `!is_jumping &&
//   walked-off-ledge` rising edge from `system.rs:863-897`'s
//   integrator-side ledge detection.
//
// - `FallDown (0x10000050)` — one-shot lead-in clip. **Not present
//   anywhere** in MT 0x09000001 per the Phase 5.1 investigation
//   (`crates/holtburger-dat/examples/dump_player_mt_fall_variants.rs`),
//   so we don't emit it. The classifier entry is wired anyway for
//   future creature MTs that may carry it.
//
// - `Fallen (0x40000008)` — touchdown / post-fall pose. Present as a
//   CYCLE in nearly every player stance with `HAS_VELOCITY` flag set
//   (it's a settled-on-ground loop). Wave 5 Phase 5.2 emits this on
//   the landing transition to give the renderer a frame of touchdown
//   pose before subsequent locomotion broadcasts return the rig to
//   Ready. Classified as "walk" so the cycle path resolves it.
//
// The original Wave 5 plan ("walk" for Falling/FallDown, "attack" for
// Fallen/Land) was based on the **assumption** that Land = 0x4100002B
// existed as a one-shot. The data audit refuted that — chorizite +
// ACE define `MagicBlast = 0x4000002B` at low-16 0x002B; the only
// matching cycle is Magic-stance MagicBlast. So Land is not wired and
// Fallen routes through the cycle path (matching its data shape).
const CMD_LOW_FALLING = 0x0015;
const CMD_LOW_FALLDOWN = 0x0050;
const CMD_LOW_FALLEN = 0x0008;

// One-shot motion commands — attacks (melee/missile), magic casts,
// and the punch variants. ACE broadcasts these via UpdateMotion when
// the player or a creature swings/casts/shoots; the client plays the
// corresponding clip once and returns to the underlying locomotion
// loop. Pre-2026-05-17 `classifyMotionCommand` returned `null` for
// these, so they were silently dropped and combat used a vibe-coded
// triangle-wave arm tween instead of the real motion-table clip.
// Values come from `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs`.
const ATTACK_COMMANDS = new Set([
  // Thrust  low / mid / high
  0x0058, 0x0059, 0x005A,
  // Slash high / mid / low
  0x005B, 0x005C, 0x005D,
  // Backhand high / mid / low
  0x005E, 0x005F, 0x0060,
  // Missile shoot
  0x0061,
  // Unarmed (variants 1, 2, 3) high / mid / low
  0x0062, 0x0063, 0x0064,
  0x0065, 0x0066, 0x0067,
  0x0068, 0x0069, 0x006A,
  // Missile attack 1 / 2 / 3
  0x00D0, 0x00D1, 0x00D2,
  // Punch fast/slow high/mid/low
  0x018F, 0x0190, 0x0191,
  0x0192, 0x0193, 0x0194,
  // Jump + JumpCharging — same one-shot semantics as attacks. The
  // motion-table Jump clip (0x2500003B) IS fetched via _tryPlayLink
  // for completeness, but cmd_low 0x003B is universally ABSENT from
  // all 436 retail motion tables (Wave 6 data audit, 2026-05-26), so
  // the fetch resolves to a null clip. The arms-up airborne pose
  // overlay below (`setAirborne`/`_tickJumpPoseTween`) carries the
  // visual — restored Wave 1.7 (2026-05-26) after Joe Trevis's quote
  // confirmed retail's "combined jumping/falling animation" had arms
  // raised (the X-Play gag). Wave 1.2's deletion of the overlay was
  // directionally wrong; this comment block was updated as part of
  // the restoration.
  0x003B, 0x001D,
]);
const CAST_COMMANDS = new Set([
  // MagicBlast, MagicThrowMissile, MagicSelf* variants
  0x002B, 0x002C, 0x002D, 0x002E, 0x002F, 0x0030, 0x0031, 0x0032,
  // MagicRecoilMissile (motion-audit A7: closes the remote/echo cast silent-drop)
  0x0033,
  // PowerUp01..10
  0x006F, 0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078,
  // CastSpell
  0x00D3,
  // Wave 8 / Phase 8.2 (2026-05-26) — additional cast-class commands.
  // ACE classifies these in the `0x40` modifier-class half-byte (cast-
  // gesture modifiers) per `MotionCommand.cs:59-64,231-232`. They live
  // in MT `links[(stance, Ready)][cmd]` per swing-classification spec §1.
  // - MagicPenalty (0x0034) / MagicTransfer (0x0035) — spell-failure /
  //   spell-transfer one-shot gestures.
  // - MagicVision (0x0036) / MagicEnchantItem (0x0037) / MagicPortal
  //   (0x0038) / MagicPray (0x0039) — utility spell cast gestures.
  // - UseMagicStaff (0x00E0) / UseMagicWand (0x00E1) — focus-channel
  //   one-shots when the casting focus item is bound.
  0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039,
  0x00E0, 0x00E1,
  // MagicPowerUp01Purple..10Purple (0x012B..0x0134) — nether/void variants
  // of the standard PowerUp scarab windups. ACE `MotionCommand.cs:307-316`.
  // Same one-shot semantics as the green PowerUps; route through
  // `_tryPlayLink` exactly the same way.
  0x012B, 0x012C, 0x012D, 0x012E, 0x012F,
  0x0130, 0x0131, 0x0132, 0x0133, 0x0134,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — one-shot emote commands. Server
// broadcasts these on player /emote slash commands and NPC-scripted
// gestures. All live in `MotionTable.links[(stance, Ready)][cmd]` per
// swing-classification spec §1; route via `_tryPlayLink` (LoopOnce
// overlay on top of the active locomotion cycle).
//
// Citations to `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs`:
// - Cheer (0x004C, L83), ChestBeat (0x004D, L84), TippedLeft/Right
//   (0x004E-0x004F, L85-86), Sanctuary (0x0057, L94).
// - HeadThrow/FistSlam/BreatheFlame/SpinAttack (0x006B-0x006E,
//   L114-117) — creature specials, kept in EMOTE since classifier
//   class is identical.
// - ShakeFist..Winded (0x0079-0x009A, L128-161) — 35 standard emotes.
// - YMCA (0x009B, L162) — class 0x12.
// - Pray/Mock/Teapot (0x00CA-0x00CC, L209-211).
// - Flatulence/Demonet (0x00D4, 0x00DF, L219, 230).
// - WarmHands (0x0119, L289).
// - ATOYOT (0x00F9, L256) — modifier-class one-shot.
// - Helper (0x0135, L317).
// - NudgeLeft..HaveASeat (0x014A-0x0152, L338-346).
const EMOTE_COMMANDS = new Set([
  // Creature emotes / one-shots (class 0x10/0x13)
  0x004C, 0x004D, 0x004E, 0x004F, 0x0057,
  0x006B, 0x006C, 0x006D, 0x006E,
  // /emote slash-command set (class 0x13)
  0x0079, 0x007A, 0x007B, 0x007C, 0x007D, 0x007E, 0x007F,
  0x0080, 0x0081, 0x0082, 0x0083, 0x0084, 0x0085, 0x0086,
  0x0087, 0x0088, 0x0089, 0x008A, 0x008B, 0x008C, 0x008D,
  0x008E, 0x008F, 0x0090, 0x0091, 0x0092, 0x0093, 0x0094,
  0x0095, 0x0096, 0x0097, 0x0098, 0x0099, 0x009A,
  // YMCA (0x009B), Pray (0x00CA), Mock (0x00CB), Teapot (0x00CC)
  0x009B, 0x00CA, 0x00CB, 0x00CC,
  // Flatulence (0x00D4), Demonet (0x00DF), WarmHands (0x0119),
  // ATOYOT (0x00F9), Helper (0x0135)
  0x00D4, 0x00DF, 0x0119, 0x00F9, 0x0135,
  // NudgeLeft..HaveASeat (0x014A-0x0152)
  0x014A, 0x014B, 0x014C, 0x014D, 0x014E, 0x014F,
  0x0150, 0x0151, 0x0152,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — server-broadcast reaction one-shots.
// Triggered by damage events / impact. Same LoopOnce overlay semantics
// as emotes.
//
// Citations to `MotionCommand.cs`:
// - Twitch1..Twitch4 (0x0051-0x0054, L88-91) — take-damage twitches.
// - StaggerBackward/StaggerForward (0x0055-0x0056, L92-93) — impact
//   stagger reactions.
// - TwitchSubstate1..3 (0x00E4-0x00E6, L235-237) — class 0x40 variants
//   ("substate" half-byte; treated as one-shots per data shape).
const REACTION_COMMANDS = new Set([
  0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056,
  0x00E4, 0x00E5, 0x00E6,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — server-set held / persistent poses.
// Class 0x41 (`Ready`-family persistent) + class 0x43 (`State` emote-held
// variants). NPCs sit / sleep / read at desks. The pose loops until ACE
// broadcasts a new motion. Route via cycle path (LoopRepeat).
//
// Citations to `MotionCommand.cs`:
// - Crouch (0x0012, L25), Sitting (0x0013, L26), Sleeping (0x0014, L27).
// - Dead (0x0011, L24) — held post-death pose; also routes via cycle path
//   so the corpse maintains its slumped pose until despawn.
// - ShakeFistState..AtEaseState — held emote variants for the full
//   /emote set (`MotionCommand.cs:241-260, 288-292, 325-337`).
const STATIONARY_COMMANDS = new Set([
  // Held base poses (class 0x40 / 0x41)
  0x0011, 0x0012, 0x0013, 0x0014,
  // /emote held variants (class 0x43) — ShakeFistState..AtEaseState
  0x00EA, 0x00EB, 0x00EC, 0x00ED, 0x00EE, 0x00EF,
  0x00F0, 0x00F1, 0x00F2, 0x00F3, 0x00F4, 0x00F5,
  0x00F6, 0x00F7, 0x00F8,
  // SlouchState..WindedState
  0x00FA, 0x00FB, 0x00FC, 0x00FD,
  // SnowAngelState (0x0118), CurtseyState (0x011A), AFKState (0x011B),
  // MeditateState (0x011C)
  0x0118, 0x011A, 0x011B, 0x011C,
  // SitState..AtEaseState (0x013D-0x0149)
  0x013D, 0x013E, 0x013F, 0x0140, 0x0141, 0x0142,
  0x0143, 0x0144, 0x0145, 0x0146, 0x0147, 0x0148,
  0x0149,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — one-shot object-interaction motions.
// Server broadcasts when the player acts on items / containers / portals.
// Route via `_tryPlayLink` (LoopOnce overlay).
//
// Citations to `MotionCommand.cs`:
// - Reload (0x0016, L29), Unload (0x0017, L30) — bow/crossbow reload.
// - Pickup (0x0018, L31), StoreInBackpack (0x0019, L32) — item pickup.
//   `acclient.c:343297` references `substate > 0x40000018` as the
//   "ranged action" branch threshold.
// - Eat (0x001A, L33), Drink (0x001B, L34), Reading (0x001C, L35).
// - EnterPortal (0x00A0, L167), ExitPortal (0x00A1, L168) — portal
//   transition flashes.
// - BowNoAmmo (0x00E8, L239), CrossBowNoAmmo (0x00E9, L240) — misfire
//   recovery animations. Class 0x80 in ACE but the low-16 is a one-shot.
// - Pickup5/10/15/20 (0x0136-0x0139, L318-321) — tall-target pickup
//   variants.
const INTERACTION_COMMANDS = new Set([
  0x0016, 0x0017, 0x0018, 0x0019, 0x001A, 0x001B, 0x001C,
  0x00A0, 0x00A1,
  0x00E8, 0x00E9,
  0x0136, 0x0137, 0x0138, 0x0139,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — periodic idle / lifecycle ambients.
// Class 0x10 one-shots played at spawn-in / despawn / random idle gaps.
// Route via `_tryPlayLink` (LoopOnce overlay; non-blocking on locomotion).
//
// Citations to `MotionCommand.cs`:
// - EnterGame (0x009C, L163), ExitGame (0x009D, L164) — login/logout
//   transition flashes.
// - OnCreation (0x009E, L165), OnDestruction (0x009F, L166) — object
//   spawn/despawn flashes.
// - Blink (0x00E2, L233), Bite (0x00E3, L234) — random ambient creature
//   animations.
// - LogOut (0x011E, L294) — logout one-shot.
const IDLE_AMBIENT_COMMANDS = new Set([
  0x009C, 0x009D, 0x009E, 0x009F,
  0x00E2, 0x00E3,
  0x011E,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — specialized & multi-strike attack
// commands not in the original ATTACK_COMMANDS list. These all share
// LoopOnce semantics (one-shot overlay via `_tryPlayLink`).
//
// Citations to `MotionCommand.cs`:
// - Hop (0x004A, L81), Jumpup (0x004B, L82) — small one-shot jumps.
// - SpecialAttack1..3 (0x00CD-0x00CF, L212-214) — creature specials.
// - SkillHealSelf (0x010E, L277), SkillHealOther (0x010F, L279) — skill
//   heal animations.
// - DoubleSlashLow..TripleThrustHigh (0x011F-0x012A, L295-306) —
//   multi-strike attack chains. `MotionCommandHelper.IsMultiStrike`
//   (L432-435) enumerates this range exactly.
// - HouseRecall (0x013A, L322), LifestoneRecall (0x0153, L347),
//   MarketplaceRecall (0x0166, L366), AllegianceHometownRecall (0x0171,
//   L377), PKArenaRecall (0x0172, L378) — recall one-shots.
// - Fishing (0x0165, L365) — fishing-rod cast.
// - EnterPKLite (0x0167, L367) — PK Lite toggle animation.
// - OffhandSlashHigh..OffhandTripleThrustHigh (0x0173-0x0184, L379-396)
//   — dual-wield offhand multi-strike variants (matches
//   `IsMultiStrike` upper range L434-435).
// - OffhandKick (0x0185, L397).
// - AttackHigh4..AttackLow6 (0x0186-0x018E, L398-406) — additional
//   attack subsequents (per `IsSubsequent` L498-501).
// - OffhandPunchFastHigh..OffhandPunchSlowLow (0x0195-0x019A, L413-418).
// - WoahDuplicate2 (0x019B, L419) — class 0x10 variant of Woah.
const EXTENDED_ATTACK_COMMANDS = new Set([
  // Hop, Jumpup
  0x004A, 0x004B,
  // SpecialAttack1..3
  0x00CD, 0x00CE, 0x00CF,
  // SkillHealSelf, SkillHealOther
  0x010E, 0x010F,
  // DoubleSlash + TripleSlash + DoubleThrust + TripleThrust (low/mid/high)
  0x011F, 0x0120, 0x0121, 0x0122, 0x0123, 0x0124,
  0x0125, 0x0126, 0x0127, 0x0128, 0x0129, 0x012A,
  // HouseRecall, LifestoneRecall
  0x013A, 0x0153,
  // Fishing, MarketplaceRecall, EnterPKLite, AllegianceHometownRecall,
  // PKArenaRecall
  0x0165, 0x0166, 0x0167, 0x0171, 0x0172,
  // OffhandSlashHigh/Med/Low, OffhandThrustHigh/Med/Low
  0x0173, 0x0174, 0x0175, 0x0176, 0x0177, 0x0178,
  // OffhandDoubleSlashLow/Med/High, OffhandTripleSlashLow/Med/High
  0x0179, 0x017A, 0x017B, 0x017C, 0x017D, 0x017E,
  // OffhandDoubleThrustLow/Med/High, OffhandTripleThrustLow/Med/High
  0x017F, 0x0180, 0x0181, 0x0182, 0x0183, 0x0184,
  // OffhandKick
  0x0185,
  // AttackHigh4..AttackLow6
  0x0186, 0x0187, 0x0188, 0x0189, 0x018A, 0x018B,
  0x018C, 0x018D, 0x018E,
  // OffhandPunchFastHigh..OffhandPunchSlowLow
  0x0195, 0x0196, 0x0197, 0x0198, 0x0199, 0x019A,
  // WoahDuplicate2
  0x019B,
]);

// Wave 8 / Phase 8.2 (2026-05-26) — specialized held / cycle commands
// not covered by STATIONARY_COMMANDS or the explicit Ready/Walk path.
// These all share LoopRepeat semantics (cycle path).
//
// Citations to `MotionCommand.cs`:
// - HoldRun (0x0001, L8), HoldSidestep (0x0002, L9) — held movement
//   modifiers. Route via cycle path for consistency with other Ready-
//   family classifications.
// - Interpolating (0x0009, L16) — physics-blend marker (held).
// - Hover (0x000A, L17) — levitate cycle (held loop).
// - On (0x000B, L18), Off (0x000C, L19) — object-state cycles
//   (e.g. torch lit / unlit).
// - AimLevel (0x001E, L37) — held aim pose, no elevation.
// - AimHigh15..AimHigh90 (0x001F-0x0024, L38-43) — held aim-up poses.
// - AimLow15..AimLow90 (0x0025-0x002A, L44-49) — held aim-down poses.
// - StopTurning (0x003A, L65) — turn-stop marker; setMotion's STOP-sub
//   already substitutes 0x0004 → Ready, but 0x003A doesn't fall into
//   that branch. Classify as "walk" so the cycle path's null-fallback
//   resolves to a graceful no-op.
const CYCLE_HELD_COMMANDS = new Set([
  0x0001, 0x0002, 0x0009, 0x000A, 0x000B, 0x000C,
  0x001E,
  // Aim elevation pose set (AimHigh15..AimHigh90, AimLow15..AimLow90)
  0x001F, 0x0020, 0x0021, 0x0022, 0x0023, 0x0024,
  0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002A,
  0x003A,
]);

// Per swing-classification spec (`docs/swing-classification-spec-
// 2026-05-19.md`) §1, §8: swings + casts live in
// `MotionTable.links[(stance, Ready)][swingCmd]`, NOT in `cycles`.
// Validated across all 436 retail motion tables (5,455 entries;
// 100 % share `from_substate == Ready`). Routes through `_tryPlayLink`
// in `setMotion` when `classifyMotionCommand` returns `"attack"`/`"cast"`.
const READY_SUBSTATE = 0x0003;

// Perf B1 (2026-05-18) — tick-radius gate for `entityManager.tick`.
// Entities further than `MAX_TICK_DIST` metres from the active camera
// (world-space, three.js frame) skip mixer.update / hook execution /
// tween processing. Local player and entities with active tweens are
// always ticked regardless of distance. 120 m matches AC's typical
// PVS visibility envelope for animated entities — beyond that, the
// animation snap on re-entry is below perceptual threshold and the
// time-budget win on Academy (~104 spawns) is the headline.
//
// TODO (B1 follow-on) — frustum culling. The MVP is distance-only;
// adding a per-frame Frustum + Box3 test would skip more entities but
// requires per-frame projection-matrix bookkeeping and per-entity
// bounding spheres. Distance-only is well-defined and load-bearing
// enough to ship first.
//
// RP2 (2026-06-08) — `?maxTickDist=<metres>` tunes the gate radius at
// eye-test WITHOUT changing the default. Absent / non-finite / ≤0 → 120 m
// exactly (byte-identical behaviour, the same 14400 m² compare as before).
// A SMALLER value culls more distant entities' tick bodies (bigger time-
// budget win, more re-entry snap); a LARGER value keeps more ticking. Read
// once at module load; try/catch for the Node harness (no `window`). The
// gate convention (local player + active tweens always tick) is unchanged.
const MAX_TICK_DIST = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return 120;
    const v = new URLSearchParams(window.location.search).get("maxTickDist");
    const n = v == null ? NaN : parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* Node / no window → default */ }
  return 120;
})();
const MAX_TICK_DIST_SQ = MAX_TICK_DIST * MAX_TICK_DIST; // default 14400 m²

// RP2 (2026-06-08) — far-band SMOOTHING STRIDE. The position-ease +
// heading-ease passes in `tick(dt)` are pure visual smoothing of the
// server-authoritative pose (the snap target is re-anchored every update,
// so the eased value never drifts and a missed frame is recovered on the
// next run). They are therefore visual-lag-tolerant: for an entity that is
// ticked but FAR from the camera, running them every Nth frame instead of
// every frame is below the perceptual threshold while cutting the slerp /
// vector-lerp + exp() cost. `?entitySmoothStride=<2..4>` opts in. Default
// 1 → run every frame (byte-identical to pre-RP2: no stamp is ever read,
// the whole stride branch is dead). The stride applies ONLY to position +
// heading easing, ONLY beyond `ENTITY_SMOOTH_NEAR_DIST_SQ`, and NEVER to
// the local player, an entity inside the near band, or anything with an
// active jump/swing/cast tween (those run the easing every frame as
// before). mixer.update / hooks / tweens / particles are untouched.
const ENTITY_SMOOTH_STRIDE = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return 1;
    const v = new URLSearchParams(window.location.search).get("entitySmoothStride");
    const n = v == null ? NaN : parseInt(v, 10);
    // Clamp to [1,4]: 1 = off (default behaviour), 4 = most aggressive. A
    // value of 1 means "no throttle" so the hot path stays byte-identical.
    if (Number.isFinite(n) && n >= 2) return Math.min(n, 4);
  } catch (_) { /* Node / no window → default */ }
  return 1;
})();
// Near band (metres) inside which smoothing always runs every frame even
// when a stride is configured — close entities are where stutter is most
// visible, so they never get throttled. Squared to compare without a sqrt.
const ENTITY_SMOOTH_NEAR_DIST = 40;
const ENTITY_SMOOTH_NEAR_DIST_SQ = ENTITY_SMOOTH_NEAR_DIST * ENTITY_SMOOTH_NEAR_DIST;

// Module-private scratch Vector3 for entity world-position lookup in
// `_shouldTickEntity`. Callers must NOT retain a reference — the next
// `tick(dt)` reuses it.
const _tickGateScratch = new THREE.Vector3();
// RP2 — second scratch Vector3 for the smoothing-stride near/far distance
// classification in `tick(dt)`. Distinct from `_tickGateScratch` because the
// gate's scratch is consumed inside `_shouldTickEntity` before tick reuses
// it; keeping a separate one avoids any aliasing if the gate is refactored.
// Only written when a smoothing stride is configured (the flag-off path
// never touches it). Callers must NOT retain a reference.
const _smoothDistScratch = new THREE.Vector3();

// Scratch Vector3 + Quaternion for the particle-attach offset frame
// passed to `ParticleManager.addEmitter({ parentOffset })`. The manager
// `.copy()`s these into its own `parentOffset` (see
// `ParticleEmitter.setParenting`, particle_emitter.js:114-118). See the
// call site for a CAVEAT about the await window between `.set()` and
// `setParenting` across overlapping fire-and-forget chain walks.
const _particleAttachScratchVec3 = new THREE.Vector3();
const _particleAttachScratchQuat = new THREE.Quaternion();

// Wave 3 (2026-05-28) — SetOmega hook integration scratch. Avoids
// allocating a fresh THREE.Quaternion per entity per frame during the
// `_tickHookOmega` integration pass. Safe to share across entities
// because `multiplyQuaternions` reads its operands fully before writing
// the destination (we then write into `inst.root.quaternion`, never
// back into this scratch).
const _omegaScratchQ = new THREE.Quaternion();

// ── FCULL (2026-06-08) — composite entity visibility ─────────────────
//
// Two independent producers can want to hide/show an entity rig:
//   1. STATE-authoritative visibility (NoDraw / Hidden / Cloaked / attach
//      detach) — driven by wasm/server events through `setVisibility`,
//      the NoDraw hook, and `_detachChild`. Stored on `inst._stateVisible`.
//   2. RENDER cull (frustum + distance) — driven each frame by
//      `tickEntityRenderVisibility`. Stored on `inst._renderCullHidden`.
//
// They must never overwrite each other. `inst.root.visible` is ALWAYS the
// composite `stateVisible && !renderCullHidden`. Both setters below funnel
// through `_applyEntityVisible`, which is the single writer of
// `root.visible`. Defaults: stateVisible=true (spawn-visible), cull clear.

function _applyEntityVisible(inst) {
  if (!inst || !inst.root) return;
  const stateVisible = inst._stateVisible !== false; // undefined → visible
  const cullHidden = inst._renderCullHidden === true;
  const want = stateVisible && !cullHidden;
  if (inst.root.visible !== want) inst.root.visible = want;
}

/**
 * INDOOR-LAYER INVARIANT (2026-10-05 — "portaled into a dungeon, can't see my
 * player rig, can see monsters"). Every node of an entity rig must sit on
 * layer 1 (RENDER_LAYER_INDOOR). `_spawnImpl` stamps the subtree once at
 * spawn, but the two in-place part rebuilds — the appearance hot-swap
 * (`_applyAppearanceHotSwap`, DEFAULT-ON `?clothingHotSwap`, fired by the
 * ObjDescEvent ACE broadcasts on EVERY equip) and the ReplaceObject hook —
 * add fresh `THREE.Mesh`es whose layer mask defaults to layer 0. Outdoors
 * that is invisible (the world pass draws both layers in one shared-depth
 * pass). Indoors `?indoorDepthSplit` (default ON) arms on any EnvCell and
 * splits the frame: layer 0 → world pass → FULL-SCREEN depth wipe → layer 1
 * cells pass. A re-dressed local player therefore drew in the world pass and
 * was overpainted by the room shell; monsters spawned inside the dungeon
 * (stamped at spawn, never re-dressed) stayed visible. Re-stamp after every
 * rebuild. Same no-op guard as the spawn stamp (`entitiesGroup` present).
 */
function _stampEntityIndoorLayer(scene3d, obj) {
  if (!obj || !scene3d?.entitiesGroup) return;
  try {
    obj.traverse((o) => o.layers.set(1));
  } catch (_) {}
}

/** Set the STATE-authoritative visibility (producer #1) + recompose. */
function _setEntityStateVisible(inst, visible) {
  if (!inst) return;
  inst._stateVisible = !!visible;
  _applyEntityVisible(inst);
}

// Conservative per-entity cull radius (m). Entity rigs animate so their
// exact bounds shift every frame; rather than recompute a bounding sphere
// per entity per frame (alloc + traversal), we test a fixed generous sphere
// at the rig root. 6 m comfortably contains player/creature rigs (the
// largest Dereth models — drudge lords, golems — fit) plus animation reach;
// it is deliberately oversized so nothing pops at the frustum edge. The
// sphere center is the entity's AC-space root position (entitiesGroup is
// under worldRoot, so `root.position` IS AC-local — see file header).
const ENTITY_CULL_RADIUS = 6;
// Reused scratch sphere for the per-entity frustum test — radius is fixed,
// only the center is rewritten per entity. Zero per-frame allocation.
const _entityCullSphere = new THREE.Sphere(new THREE.Vector3(), ENTITY_CULL_RADIUS);

// GUARDRAIL: never cull a rig that owns an active SetupModel SetLight — hiding
// `inst.root` makes THREE skip the whole subtree, extinguishing any light
// parented under a part / the root (lighting.js recordEntities → object3D.add)
// and popping on-screen illumination from a light just off-screen. Detecting
// this means a subtree walk, so we cache the result and only (re)scan when
// lighting.js's `_setupLightScanned` marker changes (the single point at which
// rig lights are attached). Returns false until lights have been scanned (no
// lights ⇒ normal cull). Zero per-frame allocation in steady state.
function _entityOwnsLight(inst) {
  const scanned = inst._setupLightScanned === true;
  if (inst._fcullLightScanGen === scanned) return inst._fcullOwnsLight === true;
  inst._fcullLightScanGen = scanned;
  let owns = false;
  if (scanned) {
    const parts = inst.parts;
    if (Array.isArray(parts)) {
      for (let pi = 0; pi < parts.length && !owns; pi++) {
        const p = parts[pi];
        const kids = p && p.children;
        if (kids) {
          for (let i = 0; i < kids.length; i++) {
            if (kids[i] && kids[i].isLight) { owns = true; break; }
          }
        }
      }
    }
    if (!owns) {
      const rk = inst.root && inst.root.children;
      if (rk) {
        for (let i = 0; i < rk.length; i++) {
          if (rk[i] && rk[i].isLight) { owns = true; break; }
        }
      }
    }
  }
  inst._fcullOwnsLight = owns;
  return owns;
}

/**
 * ── FCULL — per-frame entity RENDER-visibility cull (2026-06-08). ─────
 *
 * Layered ON TOP of `_shouldTickEntity` (which gates UPDATES) without
 * double-gating: this pass only writes `inst._renderCullHidden` and
 * recomposes `root.visible`; it never touches mixer/hook/tween state. An
 * entity can be ticked-but-culled (just left the frustum) or visible-but-
 * not-ticked (NoDraw'd) — the two axes are independent.
 *
 * NEVER culls:
 *   - the local player (always visible — it's the camera anchor);
 *   - attached / wielded children (`_attachedParentGuid != null`) — they
 *     are parented under the wielder's part node, so three.js already hides
 *     them with the wielder; culling them here would fight that hierarchy;
 *   - entities with no resolvable root position (fail-open).
 *
 * STATE-authoritative hides (NoDraw/Cloaked) compose correctly: an entity
 * the server hid stays hidden whether or not the cull also wants to hide
 * it, and un-culling never un-hides a server-hidden rig (see
 * `_applyEntityVisible`).
 *
 * `culler` is the shared AC-space FrustumCuller, already `.update()`d this
 * frame by loop.js. Fail-soft on every missing input.
 */
export function tickEntityRenderVisibility(scene3d, culler) {
  const em = scene3d?.entityManager;
  if (!em || !culler || !culler.valid) return { tested: 0, culled: 0 };
  const map = em.entityMap;
  if (!(map instanceof Map) || map.size === 0) return { tested: 0, culled: 0 };

  // Resolve the local-player guid ONCE (never cull it). Same defensive
  // resolution as `_shouldTickEntity`. GUARDRAIL: "NEVER cull local player" is
  // unconditional, so when the live resolution fails (function absent / throws
  // / returns null) we fall back to the LAST successfully-resolved guid
  // (cached on scene3d) — once the camera-anchor rig is identified it stays
  // cull-exempt even across a transient resolution gap.
  let localGuid = null;
  try {
    if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
      const lpg = window.getLocalPlayerGuid();
      if (lpg !== null && lpg !== undefined) localGuid = lpg >>> 0;
    }
  } catch (_) { /* fall back to the cached guid below */ }
  if (localGuid !== null) {
    scene3d._fcullLastLocalGuid = localGuid;
  } else if (scene3d._fcullLastLocalGuid != null) {
    localGuid = scene3d._fcullLastLocalGuid;
  }

  // Distance horizon padded by the entity radius so a rig straddling the
  // boundary isn't clipped at its near edge. Precompute the padded squared
  // threshold once (Infinity when ?cullDist disabled it → frustum-only).
  const distHorizonSq =
    CULL_DIST_SQ === Infinity
      ? Infinity
      : CULL_DIST_SQ +
        ENTITY_CULL_RADIUS * ENTITY_CULL_RADIUS +
        2 * ENTITY_CULL_RADIUS * Math.sqrt(CULL_DIST_SQ);

  let tested = 0;
  let culled = 0;
  let occluded = 0;
  const occ = getOcclusionCuller(scene3d, THREE);
  const frameNo = occ ? occ.frame : 0;
  for (const inst of map.values()) {
    if (!inst || !inst.root) continue;
    // Local player — never cull (and clear any stale cull flag so a prior
    // frame's hide can't linger if the guid only just resolved).
    if (localGuid !== null && (inst.guid >>> 0) === localGuid) {
      if (inst._renderCullHidden) {
        inst._renderCullHidden = false;
        _applyEntityVisible(inst);
      }
      continue;
    }
    // Attached / wielded child — hierarchy-governed, never cull directly.
    if (inst._attachedParentGuid != null) {
      if (inst._renderCullHidden) {
        inst._renderCullHidden = false;
        _applyEntityVisible(inst);
      }
      continue;
    }
    // Light-bearing rig — never cull (hiding it would extinguish the
    // attached SetLight and pop on-screen illumination). See _entityOwnsLight.
    if (_entityOwnsLight(inst)) {
      if (inst._renderCullHidden) {
        inst._renderCullHidden = false;
        _applyEntityVisible(inst);
      }
      continue;
    }
    // Entity AC-space position. entitiesGroup is under worldRoot, so the
    // rig's LOCAL position is already AC coords. Use it directly (no
    // getWorldPosition round-trip — that would land in THREE world space,
    // not the AC space the frustum lives in).
    const p = inst.root.position;
    if (!p) {
      if (inst._renderCullHidden) {
        inst._renderCullHidden = false;
        _applyEntityVisible(inst);
      }
      continue;
    }
    tested += 1;
    _entityCullSphere.center.set(p.x, p.y, p.z);
    let want = culler.isSphereInFrustum(_entityCullSphere);
    if (want && distHorizonSq !== Infinity) {
      const distSq = culler.getDistanceSq(p.x, p.y, p.z);
      if (distSq > distHorizonSq) want = false;
    }
    // ?occlusionCull (occlusion_cull.js) — a frustum-visible rig whose padded
    // bounds put no sample on screen (behind a building, inside a shop seen
    // from the street) is not submitted: ~40 part draws per humanoid.
    if (want && occ && occ.armed) {
      const b = _occEntityBox(inst, frameNo);
      // String key: cell proxies are keyed by numeric cell id in the same map.
      if (b && !occ.want(inst._occKey ?? (inst._occKey = "e" + (inst.guid >>> 0)), b[0], b[1], b[2], b[3], b[4], b[5])) {
        occluded += 1;
        want = false;
      }
    }
    const cullHidden = !want;
    if (inst._renderCullHidden !== cullHidden) {
      inst._renderCullHidden = cullHidden;
      _applyEntityVisible(inst);
    }
    if (cullHidden) culled += 1;
  }
  return { tested, culled, occluded };
}

// ?occlusionCull proxy bounds for an entity rig, in the MAIN scene's frame:
// the rig's world AABB (all part meshes) padded by ENTITY_PAD_M, stored as an
// offset from the root's world position so it follows a walking rig for free.
// Re-measured every OCC_ENTITY_REMEASURE frames (pose, equip, scale changes).
const OCC_ENTITY_REMEASURE = 45;
const _occEntBox3 = new THREE.Box3();
const _occEntOut = [0, 0, 0, 0, 0, 0];
function _occEntityBox(inst, frameNo) {
  const root = inst.root;
  // A hidden root is skipped by the per-frame matrix walk (?skipHiddenMatrix):
  // refresh just its own world matrix so the proxy follows a rig that walks
  // while occluded.
  if (root.visible === false) root.updateWorldMatrix(false, false);
  const mw = root.matrixWorld.elements;
  let c = inst._occBox;
  if (!c || frameNo - c.f >= OCC_ENTITY_REMEASURE || frameNo < c.f) {
    _occEntBox3.makeEmpty();
    try { _occEntBox3.setFromObject(root); } catch (_) { return null; }
    if (_occEntBox3.isEmpty()) return null;
    const mn = _occEntBox3.min, mx = _occEntBox3.max;
    c = inst._occBox = {
      f: frameNo,
      lo: [mn.x - mw[12] - ENTITY_PAD_M, mn.y - mw[13] - ENTITY_PAD_M, mn.z - mw[14] - ENTITY_PAD_M],
      hi: [mx.x - mw[12] + ENTITY_PAD_M, mx.y - mw[13] + ENTITY_PAD_M, mx.z - mw[14] + ENTITY_PAD_M],
    };
  }
  _occEntOut[0] = mw[12] + c.lo[0]; _occEntOut[1] = mw[13] + c.lo[1]; _occEntOut[2] = mw[14] + c.lo[2];
  _occEntOut[3] = mw[12] + c.hi[0]; _occEntOut[4] = mw[13] + c.hi[1]; _occEntOut[5] = mw[14] + c.hi[2];
  return _occEntOut;
}

// Wave 1.7 (2026-05-26, post-Joe-Trevis-quote restoration) — arms-up jump
// pose overlay. Restored after Wave 1.2's deletion was determined to be
// directionally wrong: retail AC's "combined jumping/falling animation"
// had your arms up (the gag X-Play mocked), and since cmd_low 0x003B
// (Jump) is universally ABSENT from all 436 retail motion tables in the
// audited DAT, the per-part quaternion-tween overlay IS the only visual
// for the airborne window. Wired to LOCAL prediction (spacebar handler
// in index.html) instead of the server kind=18 recv handler (which fires
// only for REMOTES — see lib.rs:23502 local-skip and 26887 jump-arm
// kind=18 strip). Touchdown clear piggy-backs on Wave 5's existing
// Fallen (kind=5 ENTITY_UPDATE_KIND_MOTION) emission via the loop.js
// shared-drain hook KIND_MOTION dispatch — no new wasm event type needed.
//
// READ-ONLY: never mutate `_IDENTITY_QUAT`. It's the canonical (0,0,0,1)
// reference used as the right-hand side of `.equals()` in the
// generic-jump tilt-vs-identity test. Mutating it would silently break
// every comparison downstream.
const _IDENTITY_QUAT = new THREE.Quaternion();

// Perf B3 (2026-05-18) — dispose helpers for `Entity.dispose()` to walk
// the rig's mesh children and free Geometry/Material that aren't
// shared cache references. See the `__disposable` tag convention in
// the module docstring above. C5 + E3 consume the same tag.
//
// `_disposeMaterialIfOwned` disposes only when the material carries
// `userData.__disposable === true`. As a safety net it also asserts
// the material is NOT `__cacheOwned` — that combination indicates a
// missing-`__disposable`-tag bug at the clone site, which the
// assertion surfaces as a console error instead of producing a silent
// "next render crashes" bug elsewhere. Both arrays-of-materials and
// scalar materials are handled by the caller.
function _disposeMaterialIfOwned(mat) {
  if (!mat) return;
  const ud = mat.userData;
  if (!ud) return;
  if (ud.__cacheOwned === true && ud.__disposable === true) {
    // Programmer error: a cache material was tagged disposable at some
    // clone site that should have stayed cache-owned. Dispose would
    // free the shared GPU resource other entities still reference.
    // eslint-disable-next-line no-console
    console.error(
      "[entities/B3] _disposeMaterialIfOwned: material is BOTH __cacheOwned and __disposable —" +
        " refusing to dispose. Audit the clone site that produced it.",
      { name: mat.name, userData: ud }
    );
    return;
  }
  if (ud.__disposable !== true) return;
  // Wave 5 (2026-05-28) — clone-on-write may tag a per-entity
  // `material.map` as `__disposable` too (TextureVelocity needs an
  // owned Texture so `.offset` doesn't bleed across entities sharing
  // the same surface). Free it BEFORE the material dispose so the
  // map ref is still readable. Pre-Wave-5 entities have shared
  // (untagged) `.map` Textures so this check is a no-op for them.
  const map = mat.map;
  if (map && map.userData?.__disposable === true && map.userData?.__cacheOwned !== true) {
    try { map.dispose(); } catch (_) {}
  }
  try {
    mat.dispose();
  } catch (_) {}
}

/**
 * EQUIP-3 (2026-08-02) — is this Object3D a WIELDED CHILD's root parented
 * into one of our part Groups (as opposed to a surface Mesh the part owns)?
 *
 * THE BUG THIS EXISTS FOR: both part-content swap sites — the appearance
 * hot-swap (`_applyAppearanceHotSwap`) and the ReplaceObject animation hook —
 * cleared `partGroup.children` wholesale before rebuilding the part's meshes.
 * A held weapon/shield mounted on that part (`attachChildToParent` parents the
 * child's ROOT under `parts[holdingLocation.partId]`) was one of those
 * children, so it was removed from the scene graph and never re-added: its
 * `_attachedParentGuid` still named the wielder, every `_lastAttach` /
 * `_replayLastAttach` / retry-ladder "is it mounted?" check therefore said YES,
 * and nothing ever re-mounted it. The orphaned root keeps only its HAND-LOCAL
 * transform (~0.03 m), i.e. it evaluates at AC map origin — tens of km from
 * the player — so the item reads as ABSENT (or a sub-pixel sliver) from every
 * camera angle while every diagnostic reports it correctly equipped.
 *
 * Traced live 2026-08-02 (headless, own char, "Shield of Isin Dule" wielded
 * mid-session): `Object3D.remove(entity_80000f39)` from `part_11`, stack
 * `_applyAppearanceHotSwap` ← `applyAppearance` — fired ~8 s after a clean
 * mount, off the `GameMessageObjDescEvent(creature)` ACE broadcasts on EVERY
 * equip (`Creature_Equipment.cs:365`). The despawn+respawn arm of
 * `applyAppearance` was already correct (it detaches + re-attaches around the
 * rebuild); only the hot-swap arm — which is the DEFAULT (`?clothingHotSwap`)
 * — had the hole.
 *
 * Retail never had it: `CPhysicsPart::SetPart` swaps the part's gfx contents
 * in place, while children live in the separate `CPhysicsObj::children`
 * CHILDLIST (`add_child` acclient.c:316729) that part rebuilds never touch.
 */
function _isAttachedChildNode(obj) {
  return obj?.userData?.__attachedChildOf != null;
}

// `_disposeMeshChildren` walks the rig and frees per-Mesh geometry +
// materials. FU3 (2026-05-18) — both dispose paths are gated by
// `userData.__disposable === true`: geometry via an inline check (no
// shared "cache-owned" assertion needed because AnimationCache doesn't
// tag, so a missing tag is the expected "shared" signal), material via
// `_disposeMaterialIfOwned`.
//
// ORDERING CONSTRAINT (load-bearing, was undocumented): call BEFORE
// `root.parent.remove(root)` so the walk still has the part-Mesh subtree
// attached. `dispose()` relies on this.
//
// OWNERSHIP CONSTRAINT (2026-08-02): because the walk runs while the rig
// is still mounted, a WIELDED CHILD that has not been detached yet is
// part of this subtree — `attachChildToParent` parents another entity's
// root under one of THIS wielder's part groups, and `dispose()` does not
// detach children first. A plain `.traverse()` therefore descended into
// a live foreign entity and could free ITS `__disposable`-tagged
// geometry/materials while that entity is still rendering. Hence the
// hand-rolled walk below instead of `.traverse()`: it PRUNES at any node
// tagged `userData.__attachedChildOf` (see `_isAttachedChildNode`), which
// three.js's `traverse` has no way to express. The child's own
// `dispose()` frees its resources when it despawns.
function _disposeMeshChildren(root) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj.isMesh) {
      // FU3: only dispose __disposable-tagged geometries to avoid
      // freeing shared cached geometries from AnimationCache.
      if (obj.geometry?.userData?.__disposable === true) {
        try {
          obj.geometry.dispose();
        } catch (_) {}
      }
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) _disposeMaterialIfOwned(m);
      } else {
        _disposeMaterialIfOwned(obj.material);
      }
    }
    const kids = obj.children;
    if (!kids) continue;
    for (let i = 0; i < kids.length; i += 1) {
      // Do NOT descend into a mounted wielded child — it belongs to a
      // different, possibly surviving, entity. (`root` itself is never
      // pruned even if it is somebody's attached child: we were asked to
      // dispose exactly this rig.)
      if (_isAttachedChildNode(kids[i])) continue;
      stack.push(kids[i]);
    }
  }
}

// Convert AC's full motion command (u32) to a coarse category for
// cycle selection. Returns one of "walk", "run", "stop", or null
// (unknown / non-locomotion command). Matches the 2D path's gate at
// `index.html:4534-4541`.
function classifyMotionCommand(cmd) {
  const low = cmd & 0xffff;
  if (low === CMD_LOW_STOP) return "stop";
  if (low === CMD_LOW_WALK_FORWARD || low === CMD_LOW_WALK_BACKWARDS)
    return "walk";
  if (low === CMD_LOW_RUN_FORWARD) return "run";
  // Wave 1 Phase 1.3 (2026-05-26): sidestep + turn-in-place dispatch as
  // cyclic locomotion. MT 0x09000001 has these clips in
  // `cycles[(stance, cmd)]` for all 13 player stances (audit
  // table at docs/movement-animation-overhaul-plan-2026-05-26.md:33-39).
  // Returning "walk" routes through AnimationCache with stance-aware
  // key, exactly like WalkForward / WalkBackwards.
  if (low === CMD_LOW_SIDESTEP_LEFT || low === CMD_LOW_SIDESTEP_RIGHT)
    return "walk";
  if (low === CMD_LOW_TURN_LEFT || low === CMD_LOW_TURN_RIGHT)
    return "walk";
  // Wave 5 Phase 5.1 (2026-05-26): fall states. Falling + Fallen are
  // CYCLE entries in MT 0x09000001 (data dump confirms `flags=0x01
  // HAS_VELOCITY` on Fallen entries) so they route through the cycle
  // lookup path.
  //
  // Audit A8 (FallDown link routing fix): FallDown (0x50) is an
  // Action-class one-shot LEAD-IN, NOT a cycle. The player MT
  // (0x09000001) has NO `cycles[(stance, FallDown)]` entry, so routing
  // it to "walk" landed it in `fadeOutCurrent` (null cycle clip → rest
  // pose) instead of playing the authored fall clip. The fall clip lives
  // in `MotionTable.links` exactly like a swing/cast, so route FallDown
  // to "attack" so it rides `_tryPlayLink`, which fetches the link clip
  // (FallDown 0x50 is inside the modeled attack range 0x0050..0x0078, so
  // `expandActionCommandLow16` keys it as 0x10000050) and plays it as a
  // LoopOnce overlay. A missing link no-ops gracefully (same fail-soft
  // path as any other attack-class command on an MT that lacks the
  // entry). FALLING (0x15) + FALLEN (0x08) stay on the cycle ("walk")
  // path — their behavior is unchanged.
  if (low === CMD_LOW_FALLDOWN) return "attack";
  if (low === CMD_LOW_FALLING || low === CMD_LOW_FALLEN)
    return "walk";
  if (ATTACK_COMMANDS.has(low)) return "attack";
  if (CAST_COMMANDS.has(low)) return "cast";
  // Wave 8 / Phase 8.2 (2026-05-26) — full MotionCommand classifier
  // coverage. Per the inventory at `docs/wave-8-motion-command-inventory-
  // 2026-05-26.md`, the remaining ACE enum entries split into emote
  // (one-shot expressive), reaction (server-broadcast damage response),
  // interaction (object pickup/use), idle ambient (lifecycle), extended
  // attack (multi-strike + recalls + offhand), stationary held (NPC
  // sitting/sleeping/state-emotes), and held-cycle (aim modifiers).
  //
  // Emotes, reactions, interactions, idle ambients, and extended attacks
  // all route through `_tryPlayLink` as LoopOnce overlays — same path as
  // ATTACK_COMMANDS. If the entity's MT has no entry for the command,
  // `_tryPlayLink` resolves to a null clip and the overlay quietly
  // no-ops (preserves the active locomotion cycle). Graceful for any
  // MT.
  //
  // Stationary poses and held cycles route through the cycle path as
  // LoopRepeat — same as Ready / WalkForward / RunForward. Cache-miss
  // path lands in `fadeOutCurrent` (entities.js:3245), so missing MT
  // entries also fail gracefully (rig holds rest pose).
  if (EMOTE_COMMANDS.has(low)) return "attack";
  if (REACTION_COMMANDS.has(low)) return "attack";
  if (INTERACTION_COMMANDS.has(low)) return "attack";
  if (IDLE_AMBIENT_COMMANDS.has(low)) return "attack";
  if (EXTENDED_ATTACK_COMMANDS.has(low)) return "attack";
  if (STATIONARY_COMMANDS.has(low)) return "walk";
  if (CYCLE_HELD_COMMANDS.has(low)) return "walk";
  // Ready: stance-aware base pose. Caller (setMotion) treats this
  // exactly like "walk"/"run" — fetch the cycle and play LoopRepeat.
  // It's the cycle ACE broadcasts on combat-mode toggle so the rig
  // can show the weapon-drawn / fists-up pose for the new stance.
  if (low === CMD_LOW_READY) return "idle";
  if (MT_CLASS_FALLBACK_ON) {
    // Stage-1 generic dispatcher (motion-dispatch audit §5): no static Set
    // matched, so derive a play-kind from the command class byte. A bare
    // low-16 (class byte 0) and held/sub-state classes fall through to the
    // cycle path; Action(0x10)/ChatEmote(0x13) play as a LoopOnce overlay.
    // _tryPlayLink and the cycle path both no-op gracefully on a missing MT
    // entry, so this can only add a clip, never crash. Gated ?mtClassFallback=on
    // pending 1070 GPU eye-test before default.
    const _cls = (cmd >>> 24) & 0xff;
    if (_cls === 0x10 || _cls === 0x13) return "attack";
    return "walk";
  }
  return null;
}

// Wave 2 (2026-06-08) — defensive low-16 → full-32bit expansion for the
// MotionTable LINK lookup. The link inner key is the FULL 32-bit
// MotionCommand (never the masked low-16; C3) — `lib.rs` already ships a
// full command on the main KIND_MOTION_ACTION path, but the
// `pollMotionActions` side-channel (only reachable via default-OFF
// `?multiAction=on`) and any legacy caller can still hand `setMotion` a
// bare low-16. If the high bits are already set we return the value
// unchanged (lossless for the main path); otherwise we OR in the correct
// Action class by RANGE, mirroring the Rust `expand_motion_command_low16`
// exactly (a coarse attack/cast split would mis-prefix the magic powerups,
// which classify "cast" but are 0x10-class).
//
// Ranges per ACE MotionCommand.cs (cross-checked against chorizite):
//   0x16..0x1D   Reload..JumpCharging (incl. Eat 0x1A / Drink 0x1B) → 0x40
//   0x1E..0x39   AimLevel..MagicPray (aim + magic gestures)         → 0x40
//   0x50..0x6E   FallDown..SpinAttack (melee/attack swings)         → 0x10
//   0x6F..0x78   MagicPowerUp01..10 (cast windups)                  → 0x10
//   0x11F..0x134 multi-strike attacks + colored powerups            → 0x10
// (Wave-2 review B6: 0x16..0x1D was NOT in the Rust expander's modeled
// set before — it now is, so this mirror covers it.) A low-16 OUTSIDE
// every modeled range is returned UNCHANGED — we must NOT fabricate a
// wrong class (the previous catch-all `| 0x40000000` mis-prefixed
// emotes / idle ambients, whose real classes are 0x13 / 0x10, making the
// link lookup miss with a fake key instead of falling through cleanly).
// Audit §5 key-reconstruction fix: explicit per-command class map for
// out-of-range commands whose full 32-bit class can't be derived from the
// coarse attack/use ranges below. Full keys per the motion-audit A7/A8.
//   0x4E TippedLeft  → 0x10 (Action)    0x4F TippedRight → 0x10 (Action)
//   0x91 Cringe      → 0x13 (ChatEmote) 0xD3 CastSpell   → 0x40 (Use)
const ACTION_LOW16_CLASS = {
  0x4e: 0x10000000,
  0x4f: 0x10000000,
  0x91: 0x13000000,
  0xd3: 0x40000000,
};
function expandActionCommandLow16(cmd) {
  const c = cmd >>> 0;
  if ((c >>> 16) !== 0) return c; // already a full 32-bit command
  const low = c & 0xffff;
  // Audit §5: per-command class reconstruction for out-of-range commands.
  if (ACTION_LOW16_CLASS[low] !== undefined)
    return (ACTION_LOW16_CLASS[low] | low) >>> 0;
  const isAttackClass =
    (low >= 0x0050 && low <= 0x0078) ||
    (low >= 0x011f && low <= 0x0134);
  const isUseClass = low >= 0x0016 && low <= 0x0039;
  if (isAttackClass) return (0x10000000 | low) >>> 0;
  if (isUseClass) return (0x40000000 | low) >>> 0;
  // Outside every modeled range — don't fabricate a class; pass through.
  return low >>> 0;
}

// 2026-10-05: the FINAL cast gesture (MagicBlast..MagicPray 0x4000002B-39,
// CastSpell 0x400000D3, UseMagicStaff/Wand 0x400000E0/E1) is a class-0x40
// SUBSTATE, not a 0x10 action. ACE sends it in the forward_command slot at
// CastSpeed 2.0 and follows it with Ready at 1.0 (Player_Magic.cs
// DoCastGesture / DoCastSpell). Retail GetObjectSequence's substate branch
// (acclient.c:337748; OpenAC CMotionTable.cs:215-286) plays link(Ready→
// gesture) and then the gesture CYCLE, which is a framerate-0 HOLD of the
// arms-out frame (player MT 0x09000001: cycles[(Magic,0x2B)] = 0x0300059B
// frame 16, fr 0). The next Ready then plays link(gesture→Ready), frames
// 16..end of that same anim: the recoil, the "second half of the cast
// gesture". The 0x10-class windups (MagicPowerUp*) stay one-shot actions.
// Cap on how long a Ready waits for a pending cast-gesture commit (see
// setMotion). Generous: a cold bake behind world streaming can take >1 s, and
// a late gesture + recoil beats a lost one.
const CAST_GESTURE_COMMIT_WAIT_MS = 2500;

function isSubstateCastGesture(cmd) {
  const c = cmd >>> 0;
  const low = c & 0xffff;
  const inBand = (low >= 0x002b && low <= 0x0039) || low === 0x00d3 || low === 0x00e0 || low === 0x00e1;
  if (!inBand) return false;
  const cls = c >>> 24;
  return cls === 0 || cls === 0x40;
}

// Wave 3.E (2026-05-19) — typed widening of `classifyMotionCommand`.
//
// **Purpose.** When the renderer plays a swing (`setMotion(guid, cmd,
// stance)` with `cls === "attack" || "cast"`), it currently routes
// through `_tryPlayLink` which calls the wasm
// `fetchEntityAnimationKeyframes` to bake a clip. That path resolves the
// link anim correctly but doesn't expose the anim spec (id, low, high,
// fps) — which `setSwingPoseFromMotion` needs to drive a one-shot
// AnimationAction with precise timing (e.g. for the charge-attack
// hold-at-peak-frame case).
//
// **What this does.** Calls the wasm export
// `SessionHandle::lookupMotionLinkForSwing(mtId, stance, cmd)` to walk
// `MotionTable.links[outer]` and return the typed link-anim spec. The
// wasm side mirrors the C# oracle at
// `WorldBuilder.Terminal/CommandEngine.MotionParity.cs::MotionClassifySwing`
// per spec §3.2; the JS-side caller (renderer) consumes the typed
// `{ kind, height, anim, animId, lowFrame, highFrame, framerate,
//   durationSec, resolvedCommand }` to drive `setSwingPoseFromMotion`.
//
// **Fallback.** When no session handle is wired (e.g. unit tests,
// offline cache misses, pre-spawn), returns a synthetic object whose
// `kind` mirrors the coarse 1-arg `classifyMotionCommand(cmd)` result.
// Existing 1-arg callers are untouched (they use the coarse string).
// New callers prefer this typed function and inspect `.kind`.
//
// **Cross-port parity status.** `validate_motion_pose.cjs --js-vs-cs`
// drives this same wasm export from Node (via the pkg-nodejs target)
// and diffs against the C# oracle. As of Wave 3.E ship (2026-05-19),
// 52/52 of the C# PASS rows additionally PASS on the JS side (22
// resolved-swing match + 30 BowCombat both-missing). Spec target was
// ≥30 of 52.
function classifyMotionCommandTyped(motionTableId, stance, motionCmd) {
  const wasmReady =
    typeof window !== "undefined" &&
    window.__sessionHandle &&
    typeof window.__sessionHandle.lookupMotionLinkForSwing === "function";
  if (wasmReady && motionTableId && stance && motionCmd) {
    try {
      const linkAnim = window.__sessionHandle.lookupMotionLinkForSwing(
        motionTableId >>> 0,
        stance >>> 0,
        motionCmd >>> 0
      );
      if (linkAnim) {
        // Typed result — caller can use `.anim`, `.durationSec`,
        // etc. to drive the AnimationMixer precisely. Copied into a
        // plain object, then the wasm-bindgen box is freed (this runs
        // several times per cast gesture and per swing).
        try {
          return {
            kind: linkAnim.kind, // "swing" | "cast" | "unknown"
            height: linkAnim.height || null, // "High" | "Medium" | "Low" | null
            anim: linkAnim.anim,
            animId: linkAnim.animId,
            lowFrame: linkAnim.lowFrame,
            highFrame: linkAnim.highFrame,
            framerate: linkAnim.framerate,
            durationSec: linkAnim.durationSec,
            resolvedCommand: linkAnim.resolvedCommand,
            source: "wasm-link",
          };
        } finally {
          try { linkAnim.free?.(); } catch (_) { /* already released */ }
        }
      }
      // Wasm returned None — either no link for this (stance, cmd) or
      // the motion table isn't in the cache yet. Fall through to coarse.
    } catch (err) {
      // Wasm threw — log once, fall through. Don't spam (rare path).
      if (!classifyMotionCommandTyped._loggedErrorOnce) {
        classifyMotionCommandTyped._loggedErrorOnce = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[entities/W3E] lookupMotionLinkForSwing threw; falling back to coarse",
          err
        );
      }
    }
  }
  // Fallback path — wrap the coarse string in a typed envelope so
  // callers see a consistent shape. `.kind` carries the coarse
  // category; `.anim`-shaped fields are null.
  const coarse = classifyMotionCommand(motionCmd);
  return {
    kind: coarse, // "stop"|"walk"|"run"|"attack"|"cast"|"idle"|null
    height: null,
    anim: null,
    animId: null,
    lowFrame: null,
    highFrame: null,
    framerate: null,
    durationSec: null,
    resolvedCommand: motionCmd >>> 0,
    source: "coarse-fallback",
  };
}

// Wave 3.E export hook — staged for the swing-pose driver wire-up
// (setSwingPoseFromMotion adoption) and for plugin authors to call
// directly. Per `project_w3e_done_2026-05-19` memory: 52/52 JS-vs-C#
// parity on the wasm path. Exposed via window so callers don't need
// to import this module.
if (typeof window !== "undefined") {
  window.__classifyMotionCommandTyped = classifyMotionCommandTyped;
}

/**
 * Per-entity instance: one Object3D rig driven by the Rust motion playhead.
 *
 * Owned by EntityManager.entityMap. Holds:
 *   - root: THREE.Group rooted at the entity's world position; named
 *     `entity_${guidHex}`.
 *   - parts: array of per-part Group children (length = setup.parts).
 *     Their `.position` / `.quaternion` are written by `poseRigAt`.
 *   - _unifiedLoco: the cyclic MotionSequence record (locomotion / idle /
 *     held door state) `{ seq, desc, cacheKey, hooks, lastHookTime, hold }`.
 *   - _unifiedSeq / _unifiedQueue: the one-shot on the playhead (swing, cast,
 *     emote, link, death, door state link) + the J5 pending queue behind it.
 *   - currentActionKey (accessor): the playhead's cycle key.
 *   - meta: original spawn meta (modelId, paletteId, etc.) so motion
 *     switches re-fetch with the same substitutions.
 */
class EntityInstance {
  constructor(guid, root, parts, meta) {
    this.guid = guid;
    this.root = root;
    this.parts = parts;
    this.meta = meta;
    // Render-completeness audit (2026-05-29) — wielded-item attach state.
    // When this entity is a held child (weapon/shield/bow), `_attachedParentGuid`
    // is its wielder's guid and `root` is parented under the wielder's part
    // node (so it tracks the hand animation). When this entity is a wielder,
    // `_attachedChildren` is the Set of child guids hanging off it. Both null
    // until an attach happens. See `EntityManager.attachChildToParent`.
    this._attachedParentGuid = null;
    this._attachedChildren = null;
    this._attachedPlacement = 0;
    // Ownership of geometries + materials so dispose() can free them.
    // Materials are shared via materialCache; only geometries are
    // disposable per-entity.
    this.geometries = [];
    // Track which textures the entity owns (only when paletteSubs
    // were applied — fresh DataTextures, not shared with materialCache).
    this.ownedTextures = [];
    this.ownedMaterials = [];
    // A5-P1b (2026-06-12, ?hookDrain=on) — deferred hook-fire queue:
    // `{kind:"hook", hook}` records pushed by `_fireHooksInRange` (the playhead
    // hook drain) and drained at the END of the per-instance tick body (retail add_anim_hook → process_hooks,
    // acclient.c:322063/:320035). Empty + untouched when the flag is off.
    /** @type {Array<object>} */
    this._hookFireQueue = [];
    // Cached SoundTable DID — read on spawn, used by every SoundTable
    // (hookType 2) hook fire. `0` when the entity has no SoundTable on
    // its weenie (most static placements + vanilla creatures). The
    // value is also propagated to `meta.soundTableDid` for spawn-meta
    // consumers, but kept in a flat field too so the executor doesn't
    // walk `this.meta` on every fire.
    this.soundTableDid = 0;
    // Bookkeeping for the diag-script's prewarm assertion. Counts how
    // many times `soundTableCache.get(soundTableDid)` was called from
    // this entity's spawn — should be exactly 1 for entities with a
    // non-zero SoundTable. Capture-script reads via inst._prewarmCount.
    this._prewarmCount = 0;
    // Wave 1.7 (2026-05-26): Airborne pose offset. Null when grounded;
    // THREE.Quaternion when airborne. Multiplied onto root.quaternion in
    // setPose so the jump tilt survives across position updates. Cleared
    // by `_tickJumpPoseTween` on the final landing tick.
    this.airborneTilt = null;
  }

  // The playhead's key: the locomotion cycle the Rust MotionSequence
  // (`_unifiedLoco`) is driving — the same `AnimationCache.makeKey` string the
  // mixer used, so every reader (setMotion's re-issue dedup, the hook event
  // records, plugin `animationHookDone`, `__diag.motion`, index.html's
  // remote-swing dedup) keeps its key shape. One-shots on `_unifiedSeq` never
  // change it, exactly like the mixer's link overlays never did. Read-only.
  get currentActionKey() {
    return this._unifiedLoco?.cacheKey ?? null;
  }

  registerGeometry(geom) {
    this.geometries.push(geom);
  }

  // `entMB` (2026-07-26) — THE two registration points for the entity-owned
  // pool. Every owned texture/material in the client passes through here (the
  // hot-swap commit in `_applyAppearanceHotSwap` routes its
  // `_pendingOwned*` arrays through these methods too, rather than pushing
  // raw, so the tally has no blind side door). The tally charge is O(1):
  // `image.data.byteLength` read once, cached in a WeakMap.
  registerOwnedTexture(tex) {
    this.ownedTextures.push(tex);
    entityOwnedTally.registerTexture(tex, this);
  }

  registerOwnedMaterial(mat) {
    this.ownedMaterials.push(mat);
    entityOwnedTally.registerMaterial(mat, this);
  }

  setPose(x, y, z, qw, qx, qy, qz) {
    this.root.position.set(x, y, z);
    this.root.quaternion.copy(acQuatToThree(qw, qx, qy, qz));
    // Wave 1.7 (2026-05-26): Re-apply airborne tilt offset if active.
    // setAirborne(true) stashes the tilt quaternion on the instance;
    // this ensures every position update preserves it instead of
    // snapping the entity back to upright mid-jump. Generic-path only —
    // the human-path locks the mixer and tweens part quaternions
    // directly, so airborneTilt stays null for the humanoid case.
    if (this.airborneTilt) {
      this.root.quaternion.multiply(this.airborneTilt);
    }
    // DIM1-2 / W4.3 (2026-06-05): re-apply any accumulated SetOmega spin AFTER
    // the server-orientation copy() above (which otherwise stomps it), mirroring
    // the airborneTilt re-apply. `_omegaAccumQ` is integrated each frame by
    // `_tickHookOmega`. Retail keeps omega as a persistent angular-velocity
    // re-applied every tick (acclient.c:316613/:317777). Pre-multiply to match
    // the world-space spin order used in `_tickHookOmega`.
    if (this._omegaAccumQ) {
      this.root.quaternion.premultiply(this._omegaAccumQ);
    }
  }

  dispose() {
    // 2026-05-30 — mark disposed + cancel any pending spawn-race surface
    // refresh (see EntityManager._scheduleEntitySurfaceRefresh) so a late
    // re-decode can't touch a torn-down rig. R-8 (2026-07-09): ditto for the
    // recolored twin (_scheduleRecoloredSurfaceRefresh).
    this._disposed = true;
    if (this._surfaceRefreshTimer) {
      try { clearTimeout(this._surfaceRefreshTimer); } catch (_) {}
      this._surfaceRefreshTimer = null;
    }
    if (this._recolorRefreshTimer) {
      try { clearTimeout(this._recolorRefreshTimer); } catch (_) {}
      this._recolorRefreshTimer = null;
    }
    // Free in-flight wasm MotionSequences — the one-shot
    // (_unifiedSeq) and the locomotion cycle (_unifiedLoco) — so a despawn
    // doesn't leak the Rust-side allocations.
    if (this._unifiedSeq) {
      try { this._unifiedSeq.seq.free(); } catch (_) {}
      this._unifiedSeq = null;
    }
    if (this._unifiedQueue) {
      for (const n of this._unifiedQueue.list) {
        if (n.payload) { try { n.payload.seq.free(); } catch (_) {} }
      }
      this._unifiedQueue = null; // J5: despawn drains pending_animations
    }
    if (this._unifiedLoco) {
      try { this._unifiedLoco.seq.free(); } catch (_) {}
      this._unifiedLoco = null;
    }
    // Perf B3 (2026-05-18) — walk the rig BEFORE detaching from the
    // scene graph so traverse() still has the part-Mesh subtree
    // attached. The helper disposes per-Mesh geometry + materials only
    // when tagged `userData.__disposable = true`. FU3 (2026-05-18)
    // closes the geometry gate too — see the `__disposable` convention
    // block in the module docstring. `inst.ownedMaterials` loop below
    // remains as a safety net (three.js `.dispose()` is idempotent so a
    // second pass is a no-op).
    _disposeMeshChildren(this.root);
    if (this.root.parent) this.root.parent.remove(this.root);
    // FU3 (2026-05-18) — `inst.geometries` holds the AnimationCache's
    // SHARED BufferGeometry refs (registerGeometry at the spawn site
    // pushes the cache's `g.geometry` directly). Disposing them here
    // would crash the next render of any surviving entity with the
    // same setupId. The traverse above already disposes any
    // entity-OWNED geometries that carry the `__disposable` tag (e.g.
    // the selection-ring TorusGeometry); the cache geometries stay
    // alive as long as the cache holds them.
    for (const g of this.geometries) {
      if (g?.userData?.__disposable !== true) continue;
      try {
        g.dispose();
      } catch (_) {}
    }
    // `entMB` (2026-07-26) — teardown half of the tally. NOTE what this does
    // and does NOT prove: `Texture.dispose()` frees the GPU handle only, so
    // decrementing `liveBytes` here records that the CLIENT released its
    // reference, not that the JS bytes came back. If the heap keeps stepping
    // while `entMB` returns to baseline, the retainer is a holder that keeps
    // these objects reachable past dispose (see the module docstring).
    for (const t of this.ownedTextures) {
      entityOwnedTally.disposeTexture(t);
      try {
        t.dispose();
      } catch (_) {}
    }
    for (const m of this.ownedMaterials) {
      entityOwnedTally.disposeMaterial(m);
      try {
        m.dispose();
      } catch (_) {}
    }
    entityOwnedTally.releaseOwner(this);
  }
}

/**
 * Entity manager: drives the per-entity rigs from the wasm
 * `pollEntityUpdates` stream.
 *
 * Created once per init3D and stored on
 * `liveScene3d.entityManager`. The render loop in `loop.js` calls
 * `tick(dt)` each rAF and `drainEntityEvents3D` consumes events into
 * spawn / setPose / setMotion / remove.
 */
export class EntityManager {
  constructor(scene3d, wasmExports) {
    this.scene3d = scene3d;
    this.wasmExports = wasmExports;
    // A5-P2 (`?tweenClock=dt`) — accumulated-dt tween clock (ms). Advanced
    // at the top of `tick(dt)` by the same dt the mixers consume; read via
    // `_tweenNowMs()` by the four pose-tween tickers + their stamp sites.
    // Seeded from wall now so stamps made before the first tick (and any
    // flag-off → flag-on comparison) stay monotonic. Inert when the flag is
    // off (`_tweenNowMs()` returns `performance.now()`, the legacy clock).
    this._tweenClockMs =
      typeof performance !== "undefined" ? performance.now() : 0;
    // Wave 7.5 (2026-05-24) — applyAppearance hot-swap: swaps the entity's
    // part-mesh contents in place (preserving root + mixer + currently-
    // playing action) instead of W7.3's despawn+respawn. Falls back to
    // despawn+respawn when topology mismatch is detected OR when the hot-
    // swap path throws. DEFAULT-ON (2026-07-02): the manual A/B it was
    // gated on happened live on the 1070 — equip/unequip with no flash,
    // weapons staying mounted; user ruling "default clothinghotswap on".
    // Escape: `?clothingHotSwap=0` (or `off`) reverts to despawn+respawn.
    this._hotSwapAppearance = true;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("clothingHotSwap");
        if (flag === "0" || flag === "off") this._hotSwapAppearance = false;
      }
    } catch (_) {}
    // FU-1 (2026-06-11): wieldHandAttach — DEFAULT-ON (`!== "off"` reader;
    // `?wieldHandAttach=off` restores the legacy gate). Lets
    // attachChildToParent retry the holding-location resolve with
    // Quiver(5)→RightHand(1) for an ammo child whose ParentEvent location
    // was 0 (instead of mounting it at the wielder root / feet). index.js
    // reads the same flag for its held-item mask (flushWieldedDirty).
    // No `window` (node harness, worker) → the shipped default (ON).
    this._wieldHandAttach = true;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("wieldHandAttach");
        this._wieldHandAttach = flag?.toLowerCase() !== "off";
      }
    } catch (_) {}
    // wieldedSpawn (2026-06-11): DEFAULT-ON (`!== "off"` reader; the wasm
    // side is also default-ON). The wasm side synthesizes a KIND_SPAWN for a
    // wielded child that has no world presence (pack→wield / login-wielded)
    // with its kind=7 attach in the same drain batch — the attach parks
    // until the rig commits. The mount resolves async (holding-location
    // fetch), so `_spawnImpl` hides a rig whose own attach is pending at
    // commit time; `attachChildToParent` re-asserts state-visible on mount.
    // `?wieldedSpawn=off` disables the hide. No `window` → shipped default.
    this._wieldedSpawn = true;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("wieldedSpawn");
        this._wieldedSpawn = flag?.toLowerCase() !== "off";
      }
    } catch (_) {}
    // C2 (2026-07-12) — retail keybind TARGET CYCLING (CPlayerSystem::
    // SelectNext, acclient.c:397944). Input-triggered only (no passive
    // behavior change), so it ships ENABLED; `?targetCycle=off` is the
    // escape. `!== "off"` = default-ON (the intentional flag-default
    // footgun here — an absent param reads ON). Consumed by `selectNext`
    // / `cycleTarget` / `selectSelf`; the keydown dispatch in index.html
    // also honours it before calling in.
    this._targetCycleEnabled = true;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("targetCycle");
        if ((flag ?? "").toLowerCase() === "off") this._targetCycleEnabled = false;
      }
    } catch (_) {}
    // === Wave R2.A (2026-05-28) — entity-attached dynamic lights.
    // Read the `?entityLights=on` opt-in HERE (constructor) — the same
    // scope as every consumer (`_attachEntityLights`, `_fireHook` SetLight
    // branch, `dispose`/`remove`), all of which read `this._entityLightsOn`.
    // No cross-function flag handoff (avoids the prior ReferenceError where
    // a flag was declared in one function and read in another).
    this._entityLightsOn = readEntityLightsFlag();
    // Per-preset cap on the TOTAL entity lights created across all entities.
    // `scene3d.quality.preset` is one of "low"|"mid"|"high"|"ultra".
    const presetName = scene3d?.quality?.preset;
    this._entityLightCap = Object.prototype.hasOwnProperty.call(
      ENTITY_LIGHT_CAP_BY_PRESET,
      presetName
    )
      ? ENTITY_LIGHT_CAP_BY_PRESET[presetName]
      : ENTITY_LIGHT_CAP_DEFAULT;
    // Running total of entity lights currently attached to the scene graph
    // (decremented on entity remove). Telemetry: `_entityLightHookFires`
    // counts SetLight (25) hook dispatches that actually toggled a light,
    // `_setLightDeferredFires` (kept for parity) counts no-op fires when the
    // feature is off / the entity carries no lights.
    this._entityLightCount = 0;
    this._entityLightCapHitLogged = false;
    // === Wave R3.A (2026-05-28) — remote-entity motion smoothing.
    // Read `?deadReckon` (DEFAULT ON) HERE (constructor) so every consumer
    // (`setPose`, `tick`) reads `this._deadReckonOn` — no cross-function flag
    // handoff (avoids the prior-wave ReferenceError where a flag was declared
    // in one function and read in another). `=off` → the snap path in
    // `setPose` runs exactly as before (byte-identical), no target stored, no
    // tick smoothing.
    this._deadReckonOn = readDeadReckonFlag();
    // (2026-07-06) `?deathAnim=off` escape — death-collapse + corpse handoff.
    this._deathAnimOn = readDeathAnimFlag();
    // A2-P2 (2026-06-12, W3+ S8) — `?remoteInterp` (DEFAULT ON, `=off`
    // escape). Read once HERE; consumed in `applyManagedPose` / `setPose` / `tick`.
    this._remoteInterpOn = readRemoteInterpFlag();
    // CREATURE-SEPARATION (2026-07-28) — `?creatureSeparation=off`. Read once
    // HERE; consumed in `tick` (the prediction clamp + the contact-envelope
    // push-out) and in the F3-4 sticky glue's standoff. See the flag-reader
    // block for the full decomp grounding.
    this._creatureSeparationOn = readCreatureSeparationFlag();
    // IMMOVABLE-ENTITIES (2026-08-04) — `?immovableEntities=on` (default OFF).
    // Bounds the separation push-out so it can never displace an entity past
    // its authoritative pose; see the flag-reader block for the decomp/ACE
    // grounding. Consumed in `_applyCreatureSeparation` and by the spawn-time
    // anchor stash.
    this._immovableEntitiesOn = readImmovableEntitiesFlag();
    // MOVER-SIDE RESOLUTION (2026-08-04) — `?playerDepenetrate=on` (default
    // OFF). Applies a rejected separation to the LOCAL PLAYER's rendered rig
    // instead of to the entity. `_pendingPlayerDepen` is rebuilt from scratch
    // each tick (never accumulated) — see the apply site in `tick`.
    this._playerDepenetrateOn = readPlayerDepenetrateFlag();
    /** @type {{x:number,y:number}|null} */
    this._pendingPlayerDepen = null;
    // Cached wasm radius table: setupId -> collision-primitive radius (m,
    // UNSCALED). Refreshed on the `SEPARATION_RETRY_FRAMES` cadence only
    // while some entity is still unresolved.
    /** @type {Map<number, number>} */
    this._separationRadii = new Map();
    this._separationPlayerRadius = SEPARATION_FALLBACK_RADIUS_M;
    this._separationEpsilon = 0.0002;
    this._separationTableFrame = -1e9;
    // UNCONDITIONAL reachability counters (the `sceneryArmEvals` lesson: a
    // gated probe cannot distinguish "flag off" from "arm in dead code").
    // `evals` bumps on every per-entity separation slice BEFORE the enable
    // gate; `resolved` counts floors sized from a REAL resident SetupModel
    // radius rather than the humanoid fallback; `clamped` counts prediction
    // clamps (defect 1); `pushed` counts contact-envelope push-outs
    // (defect 2). Read via `window.__creatureSeparationStats()`.
    // `immovable` (IMMOVABLE-ENTITIES, 2026-08-04) counts push-outs REJECTED
    // because they would have carried the entity past its authoritative pose —
    // i.e. the player trying to shove a door/corpse/NPC. Stays 0 with
    // `?immovableEntities` off.
    this._sepStats = {
      evals: 0, resolved: 0, clamped: 0, pushed: 0, immovable: 0,
      // MOVER-SIDE RESOLUTION: ticks where a rejected push was resolved by
      // offsetting the PLAYER instead. Stays 0 with `?playerDepenetrate` off.
      moverResolved: 0,
    };
    // Diag surface for capture scripts / the 1070 eye-test. Registered here
    // (not on `__diag`) so it is reachable the moment the manager exists,
    // before the diag bundle attaches.
    try {
      if (typeof window !== "undefined") {
        window.__creatureSeparationStats = () => this.creatureSeparationStats();
      }
    } catch (_) { /* non-browser harness */ }
    // A2 Path A (2026-05-29) — remote-entity heading ease. Default-on (browser);
    // `?headingSnap=on` reverts to the legacy snap, `?headingEaseK=` tunes rate.
    // Consumed in `setPose` (stash target / discontinuity-snap) + `tick` (slerp).
    this._headingEaseOn = readHeadingEaseEnabled();
    this._headingEaseK = readHeadingEaseK();
    // A5-P3 (2026-06-12) — `?rootMotionObject=1` opt-in (default OFF):
    // apply a one-shot overlay's net root displacement to the entity
    // anchor on `finished`. Read once HERE; consumed in `_tryPlayLink`
    // (arm) + `_applyRootMotionToAnchor` (apply) via `this.`.
    this._rootMotionObjectOn = readRootMotionObjectFlag();
    // === Wave R3.B (2026-05-29) — transparency depth-sort via AC sort center.
    // Read the `?sortCenter=on` opt-in HERE (constructor) so every consumer
    // (`_attachSortCenters` at spawn, the `tick` sort pass) reads
    // `this._sortCenterOn` — no cross-function flag handoff. Default OFF → no
    // renderOrder writes anywhere, THREE's default transparent sort untouched.
    this._sortCenterOn = readSortCenterFlag();
    // Per-setup cache of per-part sort-center offsets (Float32Array, 3 floats
    // per part, part-index order) so the wasm fetch happens once per unique
    // setup id. Only populated when `_sortCenterOn`. Keyed by setupId.
    /** @type {Map<number, Float32Array>} */
    this._sortCenterCache = new Map();
    // GUIDs whose sort-center attach has been kicked off (idempotent guard,
    // mirrors `_particleChainsAttached`). Cleared on remove.
    /** @type {Set<number>} */
    this._sortCenterAttached = new Set();
    /** @type {Map<number, Promise<void>>} */
    this._sortCenterInFlight = new Map();
    this._sortCenterWarned = false;
    /** @type {Map<number, EntityInstance>} */
    this.entityMap = new Map();
    /** @type {AnimationCache} */
    this.animationCache = new AnimationCache();
    // T11 — authored cycle ground speeds (|MotionData.velocity|) keyed by the
    // AnimationCache cacheKey, memoised across entities sharing a cycle.
    /** @type {Map<string, number>} */
    this._cycleBaseSpeedCache = new Map();
    // OMEGA (2026-06-06): memoised cycle-omega lookups (cacheKey -> {x,y,z}|null).
    this._cycleOmegaCache = new Map();
    // T9 — dynamic-LOD recheck throttle accumulator (seconds).
    this._dynLodAccum = 0;
    // ?partDegrade (2026-10-06, opt-in `=on`) — retail per-part GfxObjDegradeInfo pick (part_degrade.js).
    this._partDegrade = partDegradeEnabled()
      ? new PartDegrade({
          fetchInfo: (did) => {
            const fn = this.wasmExports?.fetch_gfx_obj_degrade_info
              ?? (typeof window !== "undefined" ? window.__hbWasm?.fetch_gfx_obj_degrade_info : undefined);
            return typeof fn === "function" ? fn(did) : null;
          },
        })
      : null;
    this._partDegradeAccum = 0;
    try { if (typeof window !== "undefined") window.__partDegrade = this._partDegrade; } catch (_) {}
    // RP2 (2026-06-08) — monotonic frame counter for the far-band smoothing
    // stride (`?entitySmoothStride=`). Only advanced in `tick` when a stride
    // is configured; per-entity `_smoothFrameStamp` records the frame an
    // entity last ran position/heading easing so the next eligible frame is
    // `(stamp + stride)`. Default (stride==1) leaves both untouched.
    this._smoothFrame = 0;
    this.materialCache = scene3d?.materialCache ?? null;
    /** @type {Map<number, Promise<EntityInstance|null>>} */
    this.spawnInFlight = new Map();
    // Diagnostics for capture scripts.
    this.spawnCount = 0;
    this.removeCount = 0;
    this.motionSwitchCount = 0;
    this.lastError = null;
    // H2 (2026-05-12): per-entity particle emitter bookkeeping. Each
    // entry tracks `(guid → [emitterId, …])` so removal can stop the
    // emitter(s) that belong to a despawning entity. The
    // `_worldParticleManager` is the world-side counterpart to
    // sky_dome's particle manager — it's lazily created on first
    // chain walk in `_attachParticleChainForEntity` once we have
    // both wasmExports + a materialCache. `_particleChainsAttached`
    // dedups per-guid attach attempts (idempotent against
    // re-Spawn / META_REFRESH flows).
    /** @type {Map<number, number[]>} */
    this._particleEmittersForGuid = new Map();
    /** H3-E1: pending sound-hook setTimeout IDs per entity GUID, so
     * the timers can be canceled when the entity despawns. */
    /** @type {Map<number, number[]>} */
    this._soundTimeoutsForGuid = new Map();
    /** A11-S1: per-entity-guid PhysicsScript `ScriptManager` (time-ordered
     * hook queue). Only populated when `?scriptQueue=on`; ticked from
     * `tick()` and cleared on entity despawn. */
    /** @type {Map<number, ScriptManager>} */
    this._scriptManagersForGuid = new Map();
    /** @type {Set<number>} */
    this._particleChainsAttached = new Set();
    // Track B7 (2026-06-08): PhysicsScriptTable DIDs already prewarmed
    // (spawn-time warm of table + scripts + emitters + ParticleManager)
    // so the same table isn't re-walked for every entity that shares it.
    /** @type {Set<number>} */
    this._prewarmedScriptTables = new Set();
    // F.D-fu3 (2026-05-20): per-guid promise that resolves when the
    // H2 chain walker has fully landed (including all `addEmitter`
    // awaits + setTimeout schedules for Sound hooks). Distinct from
    // `_particleChainsAttached` which fires synchronously at spawn-
    // dispatch time; this Map's promise resolves at the END of the
    // chain walk so validators can `await` the actual resolution
    // instead of guessing a settle time. Cleared on `remove(guid)`.
    /** @type {Map<number, Promise<{ok: boolean, emitterCount: number, soundHookCount: number, reason?: string}>>} */
    this._particleChainResolveForGuid = new Map();
    this._worldParticleManager = null;
    // B4 (2026-05-18): name → Set<guid> index so `findGuidByName` is
    // O(1) instead of an O(N) entityMap scan. Names aren't unique
    // (multiple "Drudge") so the value is a Set; callers that want
    // "first match" read `[...set][0]`. Maintained on spawn / remove
    // (the only two name-touching paths in this file — `inst.meta` is
    // set once at construction and never reassigned, so no rename
    // path exists in entities.js; re-spawn goes through remove() →
    // _spawnImpl() which naturally re-indexes).
    /** @type {Map<string, Set<number>>} */
    this._nameToGuid = new Map();
    // Render-completeness audit (2026-05-29) — wielded-item attach.
    // `_pendingAttach`: childGuid → {parentGuid, location, placement} for
    // ParentEvents that arrived before both rigs existed (ObjectCreate /
    // ParentEvent ordering is not guaranteed). Flushed on every spawn.
    // `_holdingLocCache`: wielder setupId → Map<locationKey, {partId, ox..qz}>
    // so we fetch each wielder's holding table from wasm at most once.
    /** @type {Map<number, {parentGuid:number, location:number, placement:number}>} */
    this._pendingAttach = new Map();
    // HELD-ITEM (2026-08-02, `?wieldPersist`) — `_lastAttach`: childGuid →
    // the LAST committed {parentGuid, location, placement}. Unlike
    // `_pendingAttach` (a request queue, cleared the moment the mount lands)
    // this is a durable ledger: it survives `remove(childGuid)` so a
    // despawn+respawn of the ITEM alone (PVS churn on a portal hop, an
    // ObjectDelete/ObjectCreate pair for the same guid) re-mounts it in the
    // hand. Retail gets this for free — the child's own CreateObject carries
    // its parent + location in the PhysicsDesc and `unpack_physics_desc`
    // re-runs `set_parent` (acclient.c:322346 / :330260) — whereas our spawn
    // hook only ever nudges guids that WIELD things, never guids that ARE
    // wielded. Cleared only by an explicit detach (`_detachChild`).
    /** @type {Map<number, {parentGuid:number, location:number, placement:number}>} */
    this._lastAttach = new Map();
    // A8-M4 (2026-06-12) — `?preCreateBuffer` (default ON): the generic
    // guid-keyed pre-create FIFO that REPLACES `_pendingAttach` when on. It
    // also carries the F16-5 spawn-time draw gate: the wasm spawn-hidden emit
    // sends a kind=17 visibility:false in the same recv batch as KIND_SPAWN,
    // the rig builds async, so the event parks here and replays on spawn.
    // (The `?preCreateBuffer=off` arm drops pre-spawn visibility; its
    // `_pendingVisibility` map + `?spawnHiddenState` opt-in were retired
    // 2026-10-05.) Drained from `_spawnImpl` via
    // `_drainPreCreate`, purged on `remove()`/`_detachChild`, swept for the
    // retail 25 s expiry at the tail of `tick(dt)`. Read the flag once here
    // (constructor) — same scope as every consumer (`setVisibility`,
    // `attachChildToParent`, `_spawnImpl`, `_detachChild`, `remove`,
    // `tick`), all of which read `this._preCreateBufferOn`.
    this._preCreateBufferOn = readPreCreateBufferFlag();
    this._preCreate = createPreCreateBuffer();
    // Rate-limit stamp for the once-per-second expiry sweep in tick(dt)
    // (Date.now() domain throughout — the buffer's enqueue stamps use its default
    // Date.now() clock, so the sweep must compare in the same domain).
    this._preCreateLastSweepMs = 0;
    /** @type {Map<number, Map<number, object>>} */
    this._holdingLocCache = new Map();
    // B5 (2026-06-09): child-weapon placement-frame cache, keyed
    // `"<childSetupId>:<placement>"` → Map<partIndex, {ox..qz}>. Lets us
    // fetch each held item's `placement_frames[placement]` from wasm at
    // most once per (setup, placement) and re-pose the weapon's parts
    // into the combat grip on attach (retail SetPlacementFrame).
    /** @type {Map<string, Map<number, object>>} */
    this._placementFrameCache = new Map();
    // Batch 9 #2 (2026-06-07): per-spawn generation token. `spawn()`
    // bumps + captures a generation per GUID before any async work and
    // threads it into `_spawnImpl(meta, gen)`. A concurrent `remove(guid)`
    // (or re-`spawn`) bumps the same GUID's generation, so the in-flight
    // `_spawnImpl` can detect that its result is stale at the Step-E
    // commit and dispose the half-built rig instead of attaching a ghost.
    // The token is deleted on `spawn()`'s terminal path (when it still
    // owns the latest generation) so the Map stays bounded. NOTE: this is
    // intentionally NOT the identity-check pattern used by the surface-
    // refresh timer (`this.entityMap.get(inst.guid) !== inst`, ~2548) —
    // that guard runs AFTER the rig is committed; the generation token
    // covers the BEFORE-commit window where `entityMap` has no entry yet.
    /** @type {Map<number, number>} */
    this._spawnGen = new Map();
    // Batch 9 em-dispose (2026-06-07): set true by `dispose()` so any
    // in-flight `_spawnImpl` (or deferred timer) bails instead of
    // attaching to a torn-down manager.
    this._disposed = false;
  }

  /**
   * Build the rig for a never-seen entity. Idempotent — re-spawn
   * with the same GUID first removes the existing instance.
   *
   * `meta` shape (mirrors `metaFromSpawn` at `index.html:3383` plus
   * the wire-position fields the 3D path needs):
   *   {
   *     guid, modelId / setupId,
   *     x, y, z, qw, qx, qy, qz,
   *     landblockId,
   *     modelChanges:   Uint32Array | null,
   *     textureChanges: Uint32Array | null,
   *     subPalettes:    Uint32Array | null,
   *     paletteId, mtableId,
   *     motionCommand: u32 — initial motion (typically 0 = idle),
   *     motionStance:  u32 — initial stance (0 = MotionTable.default).
   *   }
   *
   * The `setupId` field is the same value the 2D path calls `modelId`;
   * either name is accepted. (Phase 7.0–7.3 used both interchangeably
   * for buildings/statics; Phase 7.4 unifies on `modelId`.)
   */
  async spawn(meta) {
    if (!meta) return null;
    const guid = (meta.guid >>> 0) || 0;
    if (!guid) return null;
    if (this.spawnInFlight.has(guid)) {
      return this.spawnInFlight.get(guid);
    }
    if (this.entityMap.has(guid)) {
      // Re-spawn → tear down then rebuild. Mirrors
      // `ensureEntitySprite`'s `entry.modelId === 0` upgrade path.
      this.remove(guid);
    }
    // Batch 9 #2 (2026-06-07): bump + capture this spawn's generation
    // BEFORE any async work. A later remove()/re-spawn of the same GUID
    // bumps it again; the in-flight `_spawnImpl` carries `gen` and bails
    // at the Step-E commit if it no longer matches (stale spawn race).
    const gen = ((this._spawnGen.get(guid) | 0) + 1) | 0;
    this._spawnGen.set(guid, gen);
    // Diagnostic hook (always-on; cheap when __diag not installed). Fires
    // BEFORE any async work so the "spawn attempt observed" signal is
    // captured even if _spawnImpl never returns. See scene3d/diag.js.
    if (typeof window !== "undefined" && window.__diag?.onSpawnAttempted) {
      try {
        let isLocalPlayer = false;
        if (typeof window.getLocalPlayerGuid === "function") {
          const lpg = window.getLocalPlayerGuid();
          if (lpg !== null && lpg !== undefined && (lpg >>> 0) === guid) {
            isLocalPlayer = true;
          }
        }
        window.__diag.onSpawnAttempted({ ...meta, guid, isLocalPlayer });
      } catch (_) { /* diag must never break spawn */ }
    }
    const promise = this._spawnImpl(meta, gen).catch((e) => {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(`[phase7.4b] spawn(0x${guid.toString(16)}) failed:`, e);
      if (typeof window !== "undefined" && window.__diag?.onSpawnFailed) {
        try { window.__diag.onSpawnFailed(meta, e); } catch (_) {}
      }
      return null;
    });
    this.spawnInFlight.set(guid, promise);
    try {
      const inst = await promise;
      if (inst) this.spawnCount += 1;
      return inst;
    } finally {
      this.spawnInFlight.delete(guid);
      // Batch 9 #2: drop the generation token to keep `_spawnGen` bounded.
      // Two cases clear it: (a) we still own the latest generation (no
      // concurrent remove/re-spawn supplanted us), or (b) a remove() raced us
      // and bumped the generation but did NOT launch a replacement spawn
      // (spawnInFlight — already cleared above — has no entry), so the token
      // would otherwise linger with no owner. If a NEWER spawn is in flight,
      // the token belongs to it and we leave it for that spawn's terminal path.
      if (
        (this._spawnGen.get(guid) | 0) === gen ||
        !this.spawnInFlight.has(guid)
      ) {
        this._spawnGen.delete(guid);
      }
    }
  }

  async _spawnImpl(meta, gen = 0) {
    const guid = meta.guid >>> 0;
    let setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
    if (!setupId) {
      // No real setup yet (PrivateUpdatePosition before ObjectCreate).
      // Skip — the next ObjectCreate will retry with a real setup_id.
      // P14 (2026-07-04): countable, not silent — a wire entity whose
      // setup never hydrates (portal-family suspect) shows up here.
      this.nullSetupSkips = (this.nullSetupSkips | 0) + 1;
      if (typeof window !== "undefined" && window.__diag?.onSpawnFailed) {
        try { window.__diag.onSpawnFailed(meta, new Error("setupId=0 (skip)")); } catch (_) {}
      }
      return null;
    }

    // Wave 7.4 (2026-05-24): spawn-time entity LOD. If the camera is
    // positioned + the setup has a GfxObjDegradeInfo chain + the
    // entity's distance lands in one of the chain's bands, substitute
    // setupId for the band's gfx_obj_id (0x01 prefix) BEFORE the
    // animationCache.get call so the rig builder bakes the LOD-N
    // mesh. fetch_entity_animation_keyframes already branches on
    // `setup_id >> 24 != 0x02` and takes the GfxObj direct path
    // (lib.rs:10840 region), so substituting a 0x01 prefix here is
    // safe + matches the statics LOD path. Distance frozen at spawn —
    // entities crossing the band threshold mid-game won't switch
    // (handoff-degrade-info-entity-lod-2026-05-24.md § shape-a).
    // Returns 0 when no chain / no band matches / no camera; on 0
    // we fall through to the original full-detail setup. The wasm
    // helper is fire-and-forget at the worst — failure to substitute
    // never breaks spawn, only foregoes the LOD optimization.
    // T9 (2026-05-28): record the original (full-detail) setup + the chosen
    // band so the dynamic-LOD recheck (tick) can detect band crossings.
    const lodOriginalSetup = setupId;
    let lodSubstitute = 0;
    let lodPartSwap = 0;
    // EQUIP-3 (2026-08-02): a WIELDED CHILD has NO world pose of its own —
    // ACE omits `PhysicsDescriptionFlag.Position` for anything carrying
    // `Parent` (WorldObject_Networking.cs:358-362), so the wasm surfaces
    // `landblockId = 0, x = y = z = 0` (verified on the wire: the held
    // "Quarrel" / "Paradox-touched Olthoi Spear" KIND_SPAWNs arrive as
    // `1:<setup>:0`). The band lookup below would then measure the camera
    // against AC map origin (0,0) — tens of km for any real position — and
    // freeze the entity's LOD on that garbage distance for its whole life
    // (the substitution is spawn-time only). Today every retail band is a
    // finite window (GfxObjInfo min/ideal/max, typically ≤100 m — see
    // degrade_info.rs), so the miss returns 0 and the full-detail mesh
    // survives by luck; 27 of 35 sampled weapon/shield GfxObjs DO carry a
    // degrade chain (e.g. "Round Shield" 0x02000162 → 0x110002AF), so a
    // single open-ended band would silently swap a held weapon to its
    // lowest-detail stand-in forever. Skip the lookup outright — a parented
    // object has no distance of its own (retail resolves degrade from the
    // object's real position, and a child's is its wielder's). Also saves an
    // async wasm round-trip + a poisoned `lodPrewarm` memo entry per held
    // item.
    const lodPoseless =
      ((meta.landblockId ?? 0) >>> 0) === 0 &&
      !(meta.x || meta.y || meta.z);
    const lodFetch = lodPoseless
      ? null
      : this.wasmExports?.fetch_entity_degrade_for_distance;
    if (typeof lodFetch === "function") {
      try {
        const cameraPos = window.liveScene3d?.camera?.position;
        if (cameraPos) {
          const lbId = (meta.landblockId ?? 0) >>> 0;
          const lbX = (lbId >>> 24) & 0xff;
          const lbY = (lbId >>> 16) & 0xff;
          const wx = lbX * 192 + (meta.x ?? 0);
          const wy = lbY * 192 + (meta.y ?? 0);
          // T9 fix (2026-05-28): TRUE horizontal distance in the THREE frame.
          // acToThree maps AC (ax,ay,az) → (ax, az, -ay), so the entity's
          // THREE x = wx and THREE z = -wy. The old calc used `cameraPos.y -
          // wy` — comparing the camera's HEIGHT (THREE y) to the entity's
          // NORTH coord (AC y), a frame mismatch that scrambled the LOD
          // distance. Correct: hypot(cam.x - wx, cam.z - (-wy)).
          const dx = cameraPos.x - wx;
          const dz = cameraPos.z - -wy;
          const distance = Math.hypot(dx, dz);
          if (distance > 0) {
            // A12 (S14): memo hit (spawns.js wave pre-warm) resolves
            // synchronously; a miss falls back to the per-entity wasm
            // call and back-fills the memo for wave-mates.
            let substitute = lodPrewarmGet(setupId, distance);
            if (substitute === undefined) {
              substitute = (await lodFetch(setupId, distance)) >>> 0;
              lodPrewarmSet(setupId, distance, substitute);
            } else {
              substitute >>>= 0;
            }
            try {
              window.__diag?.lod?.onSpawnAttempt?.({
                guid,
                setupId,
                distance,
                substituted: substitute !== 0,
              });
            } catch (_) {}
            if (substitute !== 0) {
              try {
                window.__diag?.lod?.onSpawnSubstitution?.({
                  guid,
                  originalSetupId: setupId,
                  substituteSetupId: substitute,
                  distance,
                });
              } catch (_) {}
              if ((setupId >>> 24) === 2 && (substitute >>> 24) === 1) {
                // Degrade bands swap PART gfxobjs, not whole setups: retail
                // resolves the band INSIDE the SetupModel, so the Setup's
                // placement frame still poses the part. Replacing the whole
                // setup with the raw 0x01 took the wasm's skeleton-less
                // path, whose rest pose is always identity — placement-posed
                // props (a town sign's Resting frame lifts its part +4.66 so
                // the post plants) spawned buried whenever a near band
                // matched and popped back up when it didn't ("the sign keeps
                // dropping"). Thread the band pick as a part-0 model change
                // instead; wire-commanded model changes still win (the wasm
                // part walk takes the FIRST match per part index).
                lodPartSwap = substitute;
              } else {
                setupId = substitute;
              }
              lodSubstitute = substitute; // T9 — remember the chosen band
            }
          }
        }
      } catch (_) { /* spawn-time LOD must never break spawn */ }
    }

    const mtableId = (meta.mtableId ?? 0) >>> 0;
    const initialMotion = (meta.motionCommand ?? 0) >>> 0;
    const initialStance = (meta.motionStance ?? 0) >>> 0;
    let modelChanges = meta.modelChanges ?? new Uint32Array(0);
    if (lodPartSwap) {
      // Spawn-time LOD as a per-part substitution (see the band-pick block
      // above). Appended AFTER wire changes so a wire-commanded part-0
      // swap keeps precedence. Local copy only — meta stays untouched so
      // a T9 LOD respawn re-derives from the wire state.
      const withLod = new Uint32Array(modelChanges.length + 2);
      withLod.set(modelChanges);
      withLod[modelChanges.length] = 0;
      withLod[modelChanges.length + 1] = lodPartSwap >>> 0;
      modelChanges = withLod;
    }
    const textureChanges = meta.textureChanges ?? new Uint32Array(0);
    // `?recolor=off` CHOKE POINT 1 of 3 — the spawn path (2026-07-26).
    // `*Raw` keeps the wire's true palette state for the ANIMATION bake
    // (`bakeOpts.paletteSubsFlat` below) so the AnimationCache key, the
    // keyframe fetch and therefore the whole rig/mesh half stay byte-identical
    // across both arms of the experiment; only the SURFACE half is gated.
    // Gated to (0, []) the surface branch's `hasPaletteSubs` is false, so the
    // entity takes the plain shared-MaterialCache path: the palette-free base
    // class, no composed decode, no per-wearer owned texture.
    const paletteIdRaw = (meta.paletteId ?? 0) >>> 0;
    const subPalettesRaw = meta.subPalettes ?? new Uint32Array(0);
    const paletteId = gatePaletteId(paletteIdRaw);
    const subPalettes = gateSubPalettes(subPalettesRaw);
    // A9-Stage1: wire placement id rides only under ?placementId=on so
    // the default cache keys/fetch args stay byte-identical.
    const placementId = PLACEMENT_ID_ON ? ((meta.placementId ?? 0) >>> 0) : 0;

    // Step A: kick the keyframe + rest-pose-mesh fetch via the cache.
    // Cache key folds in motion + stance so the very first action a
    // freshly-spawned entity plays is the one the wire commanded
    // (most spawns arrive idle → key resolves to default-stance idle,
    // which the wasm side returns as 0-frame "rest pose only").
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") {
      // No animation export — skip this entity. The 2D fallback for
      // statically-placed objects is the building/statics path
      // (Phase 7.2), which doesn't go through EntityManager.
      throw new Error(
        "EntityManager: wasmExports.fetchEntityAnimationKeyframes missing"
      );
    }
    const _spawnTraceT0 = SPAWN_TRACE ? performance.now() : 0;
    const _spawnTraceAnimStart = _spawnTraceT0;
    // BUG-3 urgency centre — the same `(meta.landblockId ?? 0) >>> 0` the
    // recolour fetch at the surfaces stage already measures against.
    const _urgentLb = (meta.landblockId ?? 0) >>> 0;
    const bakeOpts = {
      modelChanges,
      textureChanges,
      // RAW, deliberately — see the `?recolor=off` choke-point note above.
      // The animation/mesh half is not part of the recolor experiment.
      paletteId: paletteIdRaw,
      paletteSubsFlat: subPalettesRaw,
      placementId,
      // BUG-3 (`?appearanceUrgent=on`, see APPEARANCE_URGENT_ON): route this
      // bake's Setup/GfxObj/MotionTable walk through `prefetch_urgent` when the
      // rig is one the player can see. `landblockId === 0` is the PARENTED case
      // (EQUIP-3: ACE omits Position for anything carrying `Parent`,
      // WorldObject_Networking.cs:358-362) — a held weapon has no pose of its
      // own but hangs off a rig that IS near, and "trying gear on" is exactly
      // the latency this flag targets, so treat poseless as urgent too.
      urgent: APPEARANCE_URGENT_ON && (
        _urgentLb === 0 || isNearPlayerLb(this.scene3d, _urgentLb)
      ),
    };
    // P11 (2026-07-04) — the spawn-time bake used to be FATAL on reject: a
    // corpse CreateObject ships motionCommand=Dead, and a Dead-pose bake
    // failure propagated to spawn()'s catch → the corpse never entered
    // entityMap (invisible AND unclickable, which also fed P12's "can't
    // loot"). The live creature's later Dead via setMotion is caught and
    // non-fatal — align the two: on a non-idle initial-motion bake reject,
    // fall back to the rest-pose bake (motion 0, stance 0) so the entity
    // COMMITS (standing beats absent), log it, and count it
    // (spawnBakeFallbacks). Same fallback for a degenerate 0-part bake.
    let animEntry;
    try {
      animEntry = await this.animationCache.get(
        setupId,
        mtableId,
        initialMotion,
        initialStance,
        fetchKeyframes,
        bakeOpts
      );
    } catch (e) {
      // Rest-pose bake failing too is the genuinely fatal case — rethrow.
      if (initialMotion === 0 && initialStance === 0) throw e;
      this.spawnBakeFallbacks = (this.spawnBakeFallbacks | 0) + 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/P11] spawn(0x${guid.toString(16)}) bake failed ` +
        `(motion=0x${initialMotion.toString(16)} stance=0x${initialStance.toString(16)} ` +
        `setup=0x${setupId.toString(16)} mtable=0x${mtableId.toString(16)}) ` +
        `— rest-pose fallback:`,
        e?.message ?? e
      );
      animEntry = await this.animationCache.get(
        setupId, mtableId, 0, 0, fetchKeyframes, bakeOpts
      );
    }
    if (
      animEntry &&
      (animEntry.partCount >>> 0) === 0 &&
      (initialMotion !== 0 || initialStance !== 0)
    ) {
      // Degenerate non-idle bake (no parts) — retry rest pose; keep the
      // degenerate entry if the retry also fails (commit-invisible matches
      // the old behaviour, never worse).
      try {
        const rest = await this.animationCache.get(
          setupId, mtableId, 0, 0, fetchKeyframes, bakeOpts
        );
        if (rest && (rest.partCount >>> 0) > 0) {
          this.spawnBakeFallbacks = (this.spawnBakeFallbacks | 0) + 1;
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/P11] spawn(0x${guid.toString(16)}) non-idle bake ` +
            `degenerate (0 parts, motion=0x${initialMotion.toString(16)}) ` +
            `— using rest-pose bake`
          );
          animEntry = rest;
        }
      } catch (_) { /* keep the degenerate entry */ }
    }
    const _spawnTraceAnimMs = SPAWN_TRACE ? (performance.now() - _spawnTraceAnimStart) : 0;
    // 2026-05-16 — `AnimationCache.get()` now returns `partGroups`
    // pre-converted to `{ groups: [{geometry, surfaceDid}], surfaceDids }`
    // and frees its wasm partMesh handles inside the cache. Multiple
    // spawns of the same setupId all see the SAME BufferGeometry refs
    // (THREE.Mesh tolerates shared geometry — N meshes with the same
    // geometry render correctly, each with its own transform/material).
    // Pre-2026-05-16 this loop did the conversion + free per spawn,
    // which caused the second-and-later spawns of any shared setupId
    // to render bodyless: the cached `partMeshes` array was shared, the
    // first spawn freed each handle, the next spawn's
    // meshToGeometryGroups got null-ptr wrappers + returned empty.
    // Back-compat: older animation.js builds (or wasm bundles) without
    // `partGroups` fall back to the legacy per-spawn convert+free path
    // for the SINGLE spawn of that key — the second-spawn race still
    // happens against an old cache, but doesn't crash.
    const partCount = animEntry.partCount;
    const initialClip = animEntry.clip;
    const resolvedStance = animEntry.resolvedStance >>> 0;
    const restOrigins = animEntry.restOrigins ?? new Float32Array(0);
    const restOrientations = animEntry.restOrientations ?? new Float32Array(0);
    const hasRestPose =
      restOrigins.length === partCount * 3 &&
      restOrientations.length === partCount * 4;

    // Step B: build the rig. Root holds the entity's world transform;
    // per-part children hold the rig-local transforms the AnimationClip
    // drives.
    const root = new THREE.Group();
    root.name = `entity_${guid.toString(16).padStart(8, "0")}`;
    // Validator-side identity. Mirrors the userData convention used
    // by scene3d/statics.js (modelId, landblockId on the InstancedMesh
    // node) and scene3d/buildings.js (modelId on the placementGroup)
    // so validate_landblock_completeness.cjs's walker can attribute
    // each entity to its expected manifest entry. Entities are matched
    // on wcid (weenie class id), not setupDid, so wcid goes into the
    // generic `modelId` field the walker reads. Without this block the
    // matcher reported `entities: matched=0` (every rendered entity
    // classified as "no modelId resolved" → invented).
    root.userData = {
      modelId: (meta?.wcid >>> 0) || 0,
      landblockId: (meta?.landblockId >>> 0) || 0,
      name: meta?.name ?? null,
    };
    const parts = [];

    // Resolve materials — first preload all unique surface DIDs across
    // all parts in one wasm round-trip, then synchronously paint via
    // getCached.
    const allSurfaceDids = new Set();
    let partGroups;
    if (Array.isArray(animEntry.partGroups)) {
      partGroups = animEntry.partGroups;
      for (const conv of partGroups) {
        if (!conv) continue;
        for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
      }
    } else {
      // Legacy fallback — convert per-spawn + free.
      const partMeshes = animEntry.partMeshes ?? [];
      partGroups = [];
      for (let p = 0; p < partCount; p += 1) {
        const partMesh = partMeshes[p];
        if (!partMesh) { partGroups.push({ groups: [], surfaceDids: [] }); continue; }
        const conv = meshToGeometryGroups(partMesh);
        conv.didDegrade = (partMesh.didDegrade ?? 0) >>> 0; // ?partDegrade
        partGroups.push(conv);
        for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
        if (typeof partMesh.free === "function") { try { partMesh.free(); } catch (_) {} }
      }
    }

    const inst = new EntityInstance(guid, root, parts, meta);
    // T9 — dynamic-LOD bookkeeping: the full-detail setup this entity spawned
    // from + the degrade band it currently renders (0 = full detail). The
    // tick recheck re-queries the band at the live distance and respawns when
    // it crosses. `lodOriginalSetup` is captured BEFORE the spawn-time
    // substitution so the recheck always asks the band table from full detail.
    inst._lodOriginalSetup = lodOriginalSetup;
    inst._lodSub = lodSubstitute;
    // Phase 2 limbs (2026-08-02) — the setup this rig was actually built from
    // (post-LOD-substitution, so it matches `parts`/`restOrigins`) plus refs to
    // the rest-pose arrays. `limbs.js` needs BOTH: the setup id keys its
    // per-Setup limb registry, and the rest frames are the only pose that is
    // still trustworthy after the mixer starts overwriting the part Groups.
    // The arrays are the AnimationCache's own (shared across every spawn of
    // this setup) — refs, not copies, so this costs two pointers per entity.
    inst._setupId = setupId >>> 0;
    inst._restOrigins = hasRestPose ? restOrigins : null;
    inst._restOrientations = hasRestPose ? restOrientations : null;

    // Material resolution. Two paths:
    //   1. Plain (no palette substitutions) — share the scene
    //      MaterialCache so two NPCs with the same setup share
    //      MeshStandardMaterial instances.
    //   2. paletteId or subPalettes set — fetch via
    //      fetchEntitySurfacesPixels which applies the palette
    //      substitutions. These textures are entity-owned (the same
    //      surface DID for a different entity will resolve to a
    //      different recoloured texture) and live on the entity until
    //      dispose.
    const hasPaletteSubs =
      paletteId !== 0 ||
      (subPalettes && subPalettes.length > 0);
    // R-8 (net-fixwave 2026-07-09) — decode-audit capture for the recolored-path
    // recovery ladder armed at the bottom of this function. `decodeMisses`
    // (P2↔P3 ABI; 0 on legacy wasm) flags an incomplete walk even when every
    // part decoded non-empty: a soft-skipped palette overlay is TEXTURED but
    // unrecolored, invisible to the mapless-mesh probe.
    let composedDecodeMisses = 0;
    const _spawnTraceMatStart = SPAWN_TRACE ? performance.now() : 0;
    // 2026-05-28 perf: wire-agent mode discards the texture from
    // fetchEntitySurfacesPixels anyway (per-DID wireframe materials
    // are palette-independent), so route wire spawns through the
    // cheaper cache.preload branch below. Real-mode entities still
    // take the palette path so their recolored surfaces look right.
    if (hasPaletteSubs && !WIREFRAME_MODE && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      // `?palDedup` (2026-08-06) — this spawn's single-flight claims, did →
      // settle. Declared OUTSIDE the try so the `finally` can sweep them: the
      // contract on `MaterialCache.claimPalettedInflight` is that a claim MUST
      // settle on every exit path, and the paths out of this block include a
      // generation-abort `break`, a throwing wasm fetch, and normal completion.
      // `_palSettle` settles-and-forgets one key; `_palSweepClaims` settles the
      // rest with null (= "I produced nothing" — the joiner then re-checks the
      // cache and otherwise takes the fallback, exactly as it would have if it
      // had run its own empty decode).
      const palClaims = new Map();
      const _palSettle = (did, mat) => {
        const s = palClaims.get(did >>> 0);
        if (!s) return;
        palClaims.delete(did >>> 0);
        try { s(mat ?? null); } catch (_) { /* a settle must never break spawn */ }
      };
      const _palSweepClaims = () => {
        if (palClaims.size === 0) return;
        for (const s of [...palClaims.values()]) {
          try { s(null); } catch (_) {}
        }
        palClaims.clear();
      };
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          // Wave 7.7 — recolor observability. Fires for every spawn that
          // arrives with non-trivial palette overlays (W7.3 server-
          // pushed recolors + any local applyAppearance preview). Captures
          // the (guid, surfaceDids, paletteId, subPalettes) triple so
          // the diag harness can audit which entities ARE actually
          // paying the recolor compositor cost vs spawning with empty
          // overlays. Fires BEFORE the wasm call so we observe even
          // when the call throws.
          try {
            window.__diag?.clothing?.onRecolorApplication?.({
              guid,
              source: "spawn",
              surfaceDidCount: dids.length,
              paletteId,
              subPaletteTripleCount: (subPalettes.length / 3) | 0,
            });
          } catch (_) {}

          // 2026-05-28 perf: paletted-material dedup. Check the cache
          // for each (DID, paletteId, subPalettes) before firing wasm
          // fetches. Spawn-trace data showed 57/97 spawns going this
          // path with mean 897ms wasm-fetch; many entities share outfit
          // signatures so a transparent dedup layer skips most fetches.
          // The cache holds CACHE-OWNED materials so they survive entity
          // dispose — see MaterialCache.installPaletted.
          //
          // `?palDedup` (2026-08-06) — the cache lookup above is SYNCHRONOUS
          // and the mint is ~897 ms of `await` away, so before this every rig
          // that spawned inside another rig's decode window missed too and
          // minted its own copy. Measured at Nanto: FOUR material objects for
          // ONE `__paletteKey` on four guids — three wasted decodes, three
          // wasted texture uploads, three extra material objects (each its own
          // program/uniform state, and invisible to any identity-keyed merge —
          // `static_batch_x::_getOrCreateBucket` is the in-tree precedent) —
          // and three orphans the caches cannot reclaim: not in
          // `palettedMaterials` (the last install won the slot) yet
          // `__cacheOwned`, so the entity's dispose skips them too.
          // A miss now looks for an in-flight CLAIM before deciding to fetch:
          // join it if one exists, otherwise take the claim and fetch. `off` ⇒
          // both calls return null ⇒ the pre-2026-08-06 path, unchanged.
          const entityMaterials = new Map();
          const missDids = [];
          const missIdx = [];
          /** @type {Array<{did: number, promise: Promise<object|null>}>} */
          const palJoins = [];
          if (this.materialCache && !WIREFRAME_MODE) {
            for (let i = 0; i < dids.length; i += 1) {
              const did = dids[i] >>> 0;
              const cached = this.materialCache.getCachedPaletted(did, paletteId, subPalettes);
              if (cached) {
                entityMaterials.set(did, cached);
              } else {
                const pending = this.materialCache.getPalettedInflight(did, paletteId, subPalettes);
                if (pending) {
                  palJoins.push({ did, promise: pending });
                  continue;
                }
                missDids.push(did);
                missIdx.push(i);
                // Nothing awaits between the `getPalettedInflight` above and
                // this claim, so the claim cannot be stolen in between.
                const settle = this.materialCache.claimPalettedInflight(did, paletteId, subPalettes);
                if (settle) palClaims.set(did, settle);
              }
            }
          } else {
            // Wire mode: every DID still needs the wasm fetch result
            // because surfacePixelsToTexture has size side-effects we
            // observe (even though wire mode then drops the texture).
            // Keep the original path: fetch all, recolour all.
            for (let i = 0; i < dids.length; i += 1) {
              missDids.push(dids[i] >>> 0);
              missIdx.push(i);
            }
          }

          // Fire wasm fetch only for the DIDs we don't already have
          // cached. Pass the SUBSET Uint32Array so the wasm side only
          // does the residual work.
          let results = null;
          if (missDids.length > 0) {
            const fetchDids = new Uint32Array(missDids);
            results = await entitySurfacePixelsFetcher(this.wasmExports)(
              fetchDids,
              paletteId,
              subPalettes,
              isNearPlayerLb(this.scene3d, (meta.landblockId ?? 0) >>> 0)
            );
            // R-8 — call-level decode audit (both fields null/0 on legacy
            // wasm). Proven-absent DIDs seed the per-entity skip set so the
            // recolored ladder never re-hammers a catalog-confirmed absence.
            composedDecodeMisses = surfaceResultDecodeMisses(results) ?? 0;
            const absent = surfaceResultProvenAbsent(results);
            if (absent && absent.size) {
              inst._recoloredSurfaceAbsent = new Set(absent);
            }
          }

          let _palSliceStart = performance.now();
          for (let mi = 0; mi < missDids.length; mi += 1) {
            // P6/A08-1b — yield a real macrotask once a synchronous chunk
            // exceeds the budget (texture copy + material mint per DID used
            // to run bunched in ONE task after the worker decode resolved).
            // Across the yield, re-check the spawn generation — a despawned
            // or superseded rig must not keep minting materials; free the
            // still-unconsumed wasm handles before bailing (the loop tail
            // frees consumed ones). The Step-E guard still runs after.
            if (
              PALETTED_SLICE_ON &&
              mi > 0 &&
              performance.now() - _palSliceStart > PALETTED_SLICE_MS
            ) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, 0));
              _palSliceStart = performance.now();
              if (this._disposed || (this._spawnGen.get(guid) | 0) !== gen) {
                for (let rest = mi; rest < missDids.length; rest += 1) {
                  const rsp = results ? results[rest] : null;
                  try {
                    if (rsp && typeof rsp.free === "function") rsp.free();
                  } catch (_) { /* best-effort */ }
                }
                break;
              }
            }
            const did = missDids[mi] >>> 0;
            const sp = results ? results[mi] : null;
            if (!sp || sp.width === 0 || sp.height === 0) {
              // Empty — fall back to scene-cache fallback. The cache
              // returns the shared fallbackMaterial in that case.
              entityMaterials.set(
                did,
                this.materialCache?.fallbackMaterial ??
                  this._fallbackMaterial()
              );
              // `?palDedup` — settle with null, NOT with the fallback we just
              // took: null is the honest "no paletted material exists for this
              // signature" answer, and it puts the joiner on exactly the branch
              // the owner is on — shared fallback now, mapless mesh, R-8
              // recolored ladder heals both rigs from the same later install.
              _palSettle(did, null);
              if (sp && typeof sp.free === "function") sp.free();
              continue;
            }
            const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
            // C1 — snapshot the Surface (0x08) render-state floats/flags
            // BEFORE `sp.free()` drops the wasm object (getters are invalid
            // afterwards). Fail-soft: missing getters → 0 (opaque).
            const palSurfaceState = {
              surfaceType: (sp.surfaceType ?? 0) >>> 0,
              translucency: typeof sp.translucency === "number" ? sp.translucency : 0.0,
              luminosity: typeof sp.luminosity === "number" ? sp.luminosity : 0.0,
              diffuse: typeof sp.diffuse === "number" ? sp.diffuse : 0.0,
              // A10-M3 (2026-06-12) — source-texture palettedness for the
              // parityV2 ClipMap alpha-test ref. Strict boolean-or-undefined:
              // missing getter (stale pkg) → undefined → decoder keeps 0.5.
              hasPalette: typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined,
            };
            if (typeof sp.free === "function") sp.free();
            let mat;
            if (WIREFRAME_MODE) {
              // 2026-05-22 — route through the shared MaterialCache so
              // the per-DID dominant-colour manifest applies AND the
              // material gets registered in `wireMatToFill`, which is
              // what `addFillCompanions` walks to attach the solid-fill
              // twin. Per-entity palette substitutions are irrelevant
              // here: in wire mode the colour comes from either the
              // manifest's dominant RGB or the 32-bucket HSL hash —
              // neither uses palette. Sharing materials across all
              // entities that touch the same surface DID is therefore
              // safe and gives fill coverage for the local player
              // (whose palette-driven branch previously minted unique
              // materials that bypassed the cache → bypassed the fill
              // companion walk → wire-only rig in screenshots).
              try { tex.dispose && tex.dispose(); } catch (_) {}
              mat = this.materialCache?._wireframeMaterialFor?.(did)
                ?? this._fallbackMaterial?.()
                ?? this.materialCache?.fallbackMaterial;
              if (!mat) {
                const hue = ((did >>> 0) % 32) / 32;
                mat = new THREE.MeshBasicMaterial({
                  color: new THREE.Color().setHSL(hue, 0.6, 0.65),
                  wireframe: true,
                  side: THREE.DoubleSide,
                  fog: true,
                });
                mat.userData = { __disposable: true };
                inst.registerOwnedMaterial(mat);
              }
              // Wire mode: don't pollute palette cache (materials are
              // shared per-DID-hash, palette-independent).
              entityMaterials.set(did, mat);
            } else {
              mat = new THREE.MeshStandardMaterial({
                map: tex,
                roughness: 0.9,
                metalness: 0.0,
                side: THREE.DoubleSide,
                transparent: false,
              });
              // C1 (render-completeness wave 3) — apply Surface (0x08)
              // Tier-1 render-state (blend/opacity/alphaTest/emissive) +
              // tag userData.surfaceTypeFlags, mirroring the plain path's
              // `_materialFromFlags`. Without this, recolored luminous/translucent/
              // clipmap gear rendered flat-opaque. Fail-soft on surfaceType=0.
              this._applyPalettedSurfaceRenderState(mat, palSurfaceState);
              mat.name = `paletted-${did.toString(16)}-${paletteId.toString(16)}`;
              // 2026-05-28 — install into the paletted-material cache
              // so the next entity with the same (DID, paletteId,
              // subPalettes) signature gets a cache hit. installPaletted
              // tags __cacheOwned so per-entity dispose doesn't free it.
              if (this.materialCache) {
                this.materialCache.installPaletted(did, paletteId, subPalettes, mat, tex);
              } else {
                mat.userData = { ...(mat.userData || {}), __disposable: true };
                inst.registerOwnedTexture(tex);
                inst.registerOwnedMaterial(mat);
              }
              entityMaterials.set(did, mat);
              // `?palDedup` — hand the freshly-installed material to whoever
              // joined this claim. AFTER installPaletted, so the material is
              // already `__cacheOwned`/`__paletteKey`-tagged and a joiner sees
              // byte-identical userData to a plain cache hit.
              _palSettle(did, mat);
            }
          }
          // `?palDedup` — settle every claim we still hold BEFORE awaiting any
          // join. This is the deadlock argument: two spawns can each own a key
          // the other joins (A owns k1 + joins k2, B owns k2 + joins k1), so a
          // spawn must never be parked on a join while still holding a claim.
          // After the mint loop nothing more will be minted — the leftovers are
          // the generation-abort `break`'s unreached DIDs — so null is correct.
          _palSweepClaims();
          if (palJoins.length > 0) {
            const joined = await _awaitPalettedJoins(palJoins);
            for (const { did, material } of joined) {
              // A joiner that got null (owner bailed, or decoded empty) re-reads
              // the cache — a LATER spawn may have installed the signature in
              // the meantime — and only then takes the fallback, which leaves a
              // mapless mesh for the R-8 ladder to heal.
              const m = material
                ?? this.materialCache?.getCachedPaletted(did, paletteId, subPalettes)
                ?? this.materialCache?.fallbackMaterial
                ?? this._fallbackMaterial();
              if (m) entityMaterials.set(did, m);
            }
          }
          inst._entityMaterials = entityMaterials;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] fetchEntitySurfacesPixels failed for entity ${guid.toString(16)}:`,
          e
        );
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "surface" }); } catch (_) {}
      } finally {
        // `?palDedup` — belt-and-braces. The sweep above covers the normal and
        // `break` exits; this one covers a throwing fetch/mint (the catch just
        // above) and anything a future edit adds. Never let a claim outlive the
        // spawn that took it — a joiner would park on it until the join
        // timeout, i.e. an unrecolored rig for that long.
        _palSweepClaims();
      }
    } else if (allSurfaceDids.size > 0 && this.materialCache) {
      // Cache hit / miss flows through the shared cache. Preload via
      // the bulk path so all DIDs land in one wasm round-trip.
      try {
        // BUG-3 (`?appearanceUrgent=on`): the non-recoloured sibling of the
        // recolour fetch above, which has carried `isNearPlayerLb` since
        // 2026-07-10. Same lane hint, same closure shape as
        // statics.js:1963-1969 / buildings.js:864-869.
        const spFetchRaw = surfacePixelsFetcher(this.wasmExports);
        const spUrgent = APPEARANCE_URGENT_ON && (
          _urgentLb === 0 || isNearPlayerLb(this.scene3d, _urgentLb)
        );
        await this.materialCache.preload(
          [...allSurfaceDids],
          (dids) => spFetchRaw(dids, spUrgent)
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] materialCache.preload failed for entity ${guid.toString(16)}:`,
          e
        );
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "surface" }); } catch (_) {}
      }
    }
    const _spawnTraceMatMs = SPAWN_TRACE ? (performance.now() - _spawnTraceMatStart) : 0;
    const _spawnTraceRigStart = SPAWN_TRACE ? performance.now() : 0;

    // Build per-part Groups + per-surface Mesh leaves.
    //
    // A9-Stage2: the rest-pose frame + per-surface mesh-build loop is the
    // single-owner part-array construction (`scene3d/setup_rig.js`). Per-
    // surface material resolution stays HERE (A10 seam — this module owns
    // the entity material decisions; setup_rig makes none). The closure
    // mirrors the legacy inline branch exactly. `?rigModule=off` reverts.
    const castShadowGate = !!(this.scene3d?.shadowsEnabled || this.scene3d?.csmEnabled);
    // #16 (?itemFx): optional NON-RETAIL UiEffects emissive aura. Compute the frag
    // plan ONCE per spawn from the entity's UiEffects bitmask (the entityUiEffects
    // getter; typeof-guarded → a stale pkg/ soft-degrades to 0 / no aura). Gated
    // `?visual && ?itemFx`; null plan ⇒ base material ⇒ byte-identical. Applied to
    // BOTH the surfaceDid-keyed `getCached` path (variant shared by surfaceDid) AND
    // the paletted `_entityMaterials` path (variant shared by exact paletteKey via
    // MaterialCache.getCachedVariantFromPaletted), so recolored gear gets the
    // aura too — previously the paletted branch returned the base verbatim, which is
    // why recolored magic items showed no glow despite the effects being default-on.
    let _itemFxPlan = null;
    if (visualEnabled() && itemFxEnabled()) {
      try {
        const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
        const ue = (sh && typeof sh.entityUiEffects === "function")
          ? (sh.entityUiEffects(guid >>> 0) >>> 0) : 0;
        if (ue) _itemFxPlan = itemFxPlanFor(ue);
      } catch (_) { _itemFxPlan = null; }
    }
    // P2.2 (?tipFlex) — offline catalog descriptor for this entity's ORIGINAL
    // (pre-LOD) setup DID. Carries the tip-flex SET [deformation.tipFlex (MECH-B
    // vertex), emissive.glint (frag)]; the widened frag_attach mech filter admits
    // the vertex entry, and tipFlex's own `enabled: tipFlexEnabled` gate drops it
    // when ?tipFlex is off. Gate visualEnabled() && tipFlexEnabled() (|| future
    // entity-side deform effects, e.g. bow-limb). Off => no catalog plan => entity
    // material path unchanged (byte-identical). Use lodOriginalSetup so the
    // descriptor key matches the canonical SetupModel even when a 0x01 LOD gfxobj
    // was substituted. await ensureVfxCatalog() is a cached no-op after first load.
    let _catalogPlan = null;
    if (visualEnabled() && tipFlexEnabled()) {
      try {
        await ensureVfxCatalog();
        _catalogPlan = fragPlanForDid(lodOriginalSetup >>> 0);
      } catch (_) { _catalogPlan = null; }
    }
    // ONE combined plan => ONE getCachedVariant / ONE __vfxSetKey when BOTH the
    // catalog SET and a live itemFx aura are present; passthrough otherwise.
    const _entityPlan = _mergeFragPlans(_catalogPlan, _itemFxPlan);
    const resolveEntityMaterial = (g) => {
      const did = g.surfaceDid >>> 0;
      if (inst._entityMaterials && inst._entityMaterials.has(did)) {
        const pbase = inst._entityMaterials.get(did);
        // Recolored/paletted gear no longer skips the VFX plan: layer the same
        // _entityPlan (itemFx aura + catalog effects) onto a clone of the recolored
        // base. Keyed per recolor × effect-SET so colours stay correct and programs
        // dedup; _entityPlan==null ⇒ returns pbase verbatim (byte-identical).
        return _entityPlan ? _entityFragMatPaletted(pbase, this.materialCache, _entityPlan) : pbase;
      }
      if (this.materialCache) {
        // T2: g.doubleSided drives FrontSide vs DoubleSide (default true).
        const base = this.materialCache.getCached(did, g.doubleSided);
        return _entityPlan ? _entityFragMat(base, this.materialCache, did, _entityPlan) : base;
      }
      return this._fallbackMaterial();
    };
    for (let p = 0; p < partCount; p += 1) {
      const partGroup = new THREE.Group();
      partGroup.name = `part_${p}`;
      const conv = partGroups[p];
      // ?partDegrade: the part GfxObj's degrade chain (part_degrade.js reads it per tick).
      partGroup.userData.didDegrade = ((conv && conv.didDegrade) ?? 0) >>> 0;
      partGroup.userData.__degHidden = false;
      if (RIG_MODULE_ON) {
        applyRestPoseFrame(THREE, partGroup, restOrigins, restOrientations, p, hasRestPose);
        buildPartSurfaceMeshes(THREE, {
          partGroup,
          conv,
          partIndex: p,
          guid,
          resolveMaterial: resolveEntityMaterial,
          castShadow: castShadowGate,
          materialCanCastShadow,
          materialRendersNothing,
          onGeometry: (geometry) => inst.registerGeometry(geometry),
        });
      } else {
        // === Legacy inline path (`?rigModule=off` escape hatch) ===
        // Cohere-B (2026-05-12): apply the resolved rest-pose frame to
        // the partGroup. partMeshes ship part-LOCAL (no placement baked
        // in); the rest frame composes against the entity root the same
        // way PhatSDK's `CPartArray::UpdateParts` composes
        // `entity_world.combine(anim_frame[i])`. During cycle playback
        // the AnimationMixer overrides these values frame-by-frame with
        // the model-space cycle keyframes. With hasRestPose=false (old
        // wasm bundle without the getters), partGroup stays at identity
        // — matches pre-fix behaviour.
        if (hasRestPose) {
          partGroup.position.set(
            restOrigins[p * 3 + 0],
            restOrigins[p * 3 + 1],
            restOrigins[p * 3 + 2]
          );
          // AC wire order is (qw, qx, qy, qz); three.js wants
          // (qx, qy, qz, qw). Reorder at apply.
          const qw = restOrientations[p * 4 + 0];
          const qx = restOrientations[p * 4 + 1];
          const qy = restOrientations[p * 4 + 2];
          const qz = restOrientations[p * 4 + 3];
          partGroup.quaternion.set(qx, qy, qz, qw);
        }
        for (const g of conv.groups) {
          const did = g.surfaceDid >>> 0;
          const mat = resolveEntityMaterial(g);
          const m = new THREE.Mesh(g.geometry, mat);
          m.name = `part_${p}_surface_${did.toString(16)}`;
          m.userData = { guid, partIndex: p, surfaceDid: did };
          // Visual-fidelity Phase 0.1 — entities cast shadows (NPCs +
          // local player rig). receiveShadow is false because the
          // entity rig is animated per-frame; receiving shadows on a
          // moving rig adds shimmer that's distracting without buying
          // much (entities are mostly self-shadowing internally).
          // Translucent / additive surfaces (ghosts, ethereal effects)
          // are skipped via the material-flag check.
          // Phase 3.3 — CSM path enables casting on the same meshes.
          if (castShadowGate) {
            m.castShadow = materialCanCastShadow(mat);
          }
          // Mirror of the rig-module skip (setup_rig.js) so `?rigModule=off`
          // does not silently diverge from the shipped path.
          if (materialRendersNothing(mat)) m.visible = false;
          partGroup.add(m);
          inst.registerGeometry(g.geometry);
        }
      }
      parts.push(partGroup);
      root.add(partGroup);
    }

    // T4: per-part particle anchoring. CreateParticle hooks carry a
    // `part_index`; the particle runtime resolves a non-root index via
    // `this.parent.partFrames[partIndex]` (particle_emitter.js:336, and
    // particle.js:179 / setParenting:180 read its {position, quaternion}).
    // The entity rig is a bare THREE.Group with no `partFrames`, so every
    // non-root index silently root-fell-back to the model origin. Attach a
    // LIVE, lazily-evaluated accessor on `root` (= the `parent` passed to
    // addEmitter) that returns the CURRENT WORLD-space frame of
    // `parts[partIndex]` per read — the part Groups carry only LOCAL
    // rest-pose / mixer-driven transforms relative to root, so we must
    // compose up to world via getWorldPosition/getWorldQuaternion. The
    // consumer treats `partFrames[i]` as a drop-in for `parent.position`/
    // `parent.quaternion` (which are world), so the frames must be world too.
    // 0xFFFFFFFF / -1 still anchors to root (handled upstream, never indexes
    // this); out-of-range / undefined falls back to root anchoring.
    // Reusable per-index frame objects so repeated reads don't allocate.
    // A9-Stage2: the Proxy factory lives in setup_rig.js (single owner of
    // the world-frame accessor contract A11 consumes). `?rigModule=off`
    // reverts to the byte-identical inline Proxy below.
    if (RIG_MODULE_ON) {
      root.partFrames = createPartFramesProxy(THREE, parts);
    } else {
      const partFrameCache = [];
      root.partFrames = new Proxy([], {
        get(_target, prop) {
          if (prop === "length") return parts.length;
          // Only intercept integer-index reads; anything else (Symbol,
          // string method names) returns undefined so `&&` guards short out.
          const idx = typeof prop === "string" ? Number(prop) : NaN;
          if (!Number.isInteger(idx) || idx < 0 || idx >= parts.length) {
            return undefined;
          }
          const part = parts[idx];
          if (!part) return undefined;
          let frame = partFrameCache[idx];
          if (!frame) {
            frame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
            partFrameCache[idx] = frame;
          }
          // World-space (composes root ⊗ local). updateWorldMatrix(true,…)
          // ensures the part's world matrix reflects this frame's mixer pose
          // even if the renderer hasn't flushed the scene graph yet.
          part.updateWorldMatrix(true, false);
          part.getWorldPosition(frame.position);
          part.getWorldQuaternion(frame.quaternion);
          return frame;
        },
        has(_target, prop) {
          const idx = typeof prop === "string" ? Number(prop) : NaN;
          return Number.isInteger(idx) && idx >= 0 && idx < parts.length;
        },
      });
    }

    // Phase 2 limbs (2026-08-02) — warm the per-Setup limb registry.
    // Fire-and-forget: the classification needs the part geometry that the
    // loop above just built, is cached per setupId (so only the FIRST spawn of
    // a model pays the `fetchSetupParentIndex` round-trip), and never blocks
    // the spawn. Gated on `?limbDamage=on` so the default path makes no extra
    // wasm call at all.
    if (LIMB_DAMAGE_ON) {
      ensureLimbRegistry(setupId, inst, this.wasmExports).catch((e) => {
        // eslint-disable-next-line no-console
        if (!this._limbRegistryWarned) {
          this._limbRegistryWarned = true;
          console.warn(
            `[entities/limbs] registry build failed (setup=0x${setupId.toString(16)}):`,
            e
          );
        }
      });
    }

    // Step C: world-frame transform. Wire format gives us
    // (landblockId, x, y, z) where (x, y) are LB-local metres. Convert
    // to world coords the same way the 2D path does
    // (`landblockToWorldXY` at index.html:2777).
    const lbId = (meta.landblockId ?? 0) >>> 0;
    const lbX = (lbId >>> 24) & 0xff;
    const lbY = (lbId >>> 16) & 0xff;
    const wx = lbX * 192.0 + (meta.x ?? 0);
    const wy = lbY * 192.0 + (meta.y ?? 0);
    // Ground-clamp the authored Z (retail step_down) so a buried outdoor object
    // rests on the terrain surface instead of sinking. `lbId & 0xffff` is the
    // landcell index (>= 0x0100 ⇒ indoor ⇒ skipped inside the helper). Stash the
    // cell index so position updates can re-clamp (covers terrain that streams
    // in after spawn).
    inst._outdoorCellIdx = lbId & 0xffff;
    // WS10 (2026-07-12): never ground-clamp a MISSILE projectile — it is airborne by
    // definition and its launch Z is server-authored to ~2/3 caster height
    // (WorldObject_Magic.CalculatePreOffset). Clamping a bolt spawned below the terrain at
    // its (wx,wy) — e.g. firing across a rise — would jump the launch point onto the
    // hillside. Dedicated `?projectileGroundClampSkip=off` reverts just this exemption
    // (leaving `?groundClamp` intact for all other entities).
    const wz = (PROJECTILE_GROUND_CLAMP_SKIP_ON && this.isProjectile(guid))
      ? (meta.z ?? 0)
      : _groundClampZ(wx, wy, meta.z ?? 0, inst._outdoorCellIdx);
    inst.setPose(wx, wy, wz, meta.qw ?? 1, meta.qx ?? 0, meta.qy ?? 0, meta.qz ?? 0);
    // IMMOVABLE-ENTITIES (2026-08-04, `?immovableEntities=on`): stash the
    // CREATE pose as the authoritative anchor. `_wirePos` is stashed only by
    // the manager-level `setPose`, i.e. only from a KIND_POSITION drain — and a
    // door, a corpse or a standing NPC may never get one, so without this the
    // separation bound would have no anchor for exactly the objects the report
    // is about. Overwritten by the first real KIND_POSITION.
    if (this._immovableEntitiesOn) {
      inst._spawnAnchor = new THREE.Vector3(wx, wy, wz);
    }
    // #9 (2026-06-07): remember the entity's authored base scale so the
    // generic jump pose can multiply through it instead of stomping x/y/z
    // back to 1.0 (which collapsed scaled creatures mid-jump). Defaults to
    // 1.0 for the common objScale==1 path → byte-identical transforms.
    inst._baseScale = (meta.objScale && meta.objScale > 0) ? meta.objScale : 1.0;
    if (inst._baseScale !== 1) {
      root.scale.setScalar(inst._baseScale);
    }

    // Step D: SoundTable + the initial cycle on the motion playhead.
    // Task E (2026-05-12): cache the entity's SoundTable DID on the
    // instance. The wire field is `EntityUpdate.soundTableDid` (backed
    // by `ObjectDescription.stable_id` = `PropertyDataId::SoundTable`
    // (3)). Used by the per-frame hook executor when a SoundTable
    // (hookType 2) hook fires; the executor resolves the carried
    // Sound enum via `soundTableCache.resolveSound(inst.soundTableDid,
    // soundEnum)`. `0` means "entity has no SoundTable" — SoundTable
    // hooks fired on such an entity silently no-op (not an error;
    // many static placements have animation hooks but no SoundTable).
    inst.soundTableDid = (meta.soundTableDid ?? 0) >>> 0;
    // The spawn's initial cycle goes straight onto the Rust playhead
    // (`_unifiedLoco`), so every entity is on ONE authority from its first
    // frame. Auto-plays locomotion (walk/run) AND the Ready idle cycle — lib.rs
    // defaults animatable spawns (mtable_id != 0) to Ready (0x41000003) →
    // "idle", which is what makes standing NPCs/vendors/players breathe instead
    // of standing frozen at the rest pose. One-shot classes are never the spawn
    // motion; motion=0 (no MotionTable) → no clip → rest pose. A door/chest
    // spawning in a state (On/Off) is installed as a HELD cycle — its final
    // open/closed frame, no swing on spawn.
    let _spawnOnPlayhead = false;
    if (initialClip) {
      const _cls0 = classifyMotionCommand(initialMotion);
      if (_cls0 === "walk" || _cls0 === "run" || _cls0 === "idle") {
        // Bugs 2/15/18: the same full-command / full-stance key setMotion
        // builds, so its first Ready dedupes against this idle.
        const st0Key = (resolvedStance || initialStance) >>> 0;
        const cacheKey0 = AnimationCache.makeKey(
          setupId, mtableId, fullMotionCommand(initialMotion),
          st0Key ? (((st0Key & 0xffff) | 0x80000000) >>> 0) : 0,
        );
        _spawnOnPlayhead = this._installUnifiedLoco(
          inst, animEntry.sequenceDescriptor, cacheKey0, animEntry.hooks, initialMotion,
        );
        // Seed the motion-state memory with the spawn state so the FIRST server
        // Motion broadcast (e.g. Use → On) resolves its MotionTable LINK
        // (Off→On = the authored opening swing; On→Off = the same anim at
        // negative framerate, baked reversed) instead of snapping.
        if (_spawnOnPlayhead && isDoorStateMotion(initialMotion)) {
          inst.lastMotionCommand = initialMotion >>> 0;
        } else if (_spawnOnPlayhead) {
          // Bug 18 (2026-10-07): the same for locomotion. Retail's
          // InterpretedMotionState starts at the spawn substate and style, so
          // the first stance change plays its draw/sheathe link and the first
          // step its Ready→Walk/Run link. Ours left both unset, so the first
          // combat toggle after a spawn popped straight into the new stance.
          inst.lastMotionCommand = fullMotionCommand(initialMotion);
          const st0 = (resolvedStance || initialStance) >>> 0;
          if (!inst.lastStance && st0) inst.lastStance = st0;
        }
      }
    }
    // P6/R-6 (net-fixwave 2026-07-10) — per-spawn rig program warm:
    // compileAsync the fully-built rig BEFORE it becomes visible. The
    // surface pixels resolved in Step B and the maps are already installed
    // on the materials, so this warms the POST-`USE_MAP` program variant —
    // warming pre-install would link a mapless program and the later map
    // attach would relink on a VISIBLE frame (the A09-6 branch failure
    // mode). Entities are invisible until Step E anyway, so the warm rides
    // the existing latency window; on real GPUs the link runs on driver
    // threads (KHR_parallel_shader_compile) — SwiftShader links are ~free,
    // so laptop probes measure COVERAGE (Δprograms), not the latency win.
    // The spawn-race guard below doubles as the post-await liveness
    // re-check. Console tell only for real links (>8 ms) so hub bursts of
    // cache-hit warms stay silent. `?entityWarm=off` skips.
    if (ENTITY_WARM_ON) {
      const _warmT0 = performance.now();
      await prewarmSubtree(this.scene3d, root);
      const _warmMs = performance.now() - _warmT0;
      // Tell only for real links (>8 ms), capped at 20 lines per session —
      // under SwiftShader every compile crosses the threshold and a hub
      // burst would print hundreds of lines (177 measured); the first 20 +
      // the closing summary carry the field signal.
      if (_warmMs > 8) {
        EntityManager._rigWarmTells = (EntityManager._rigWarmTells | 0) + 1;
        if (EntityManager._rigWarmTells <= 20) {
          // eslint-disable-next-line no-console
          console.info(
            `[entities] rig warm 0x${guid.toString(16)}: ${Math.round(_warmMs)} ms (program link)` +
              (EntityManager._rigWarmTells === 20 ? " — further rig-warm tells suppressed" : "")
          );
        }
      }
    }
    // Batch 9 #2 (2026-06-07): spawn-race liveness guard. Between this
    // spawn's generation capture and now, a remove(guid)/re-spawn (or
    // manager dispose()) may have run while `_spawnImpl` awaited the
    // animation cache / surface decode. If our generation was supplanted
    // or the manager is torn down, do NOT attach the half-built rig (that
    // is the #2 "ghost rig" leak). Dispose ONLY this instance — routed
    // through `inst.dispose()`, which frees just the `__disposable`-tagged
    // geometry; the shared AnimationCache geometry (registered untagged at
    // ~2089) MUST survive for any sibling entity on the same setupId. A
    // blanket geometry.dispose() here would crash their next render.
    if (this._disposed || (this._spawnGen.get(guid) | 0) !== gen) {
      try { inst.dispose(); } catch (_) {}
      return null;
    }
    // Step E: parent under entitiesGroup + register.
    if (this.scene3d?.entitiesGroup) {
      this.scene3d.entitiesGroup.add(root);
    }
    // 2026-05-22 — wire-agent: walk THIS entity's subtree and add solid-
    // fill companion meshes for every wire-bucket-materialed
    // Mesh/InstancedMesh, so NPCs/monsters/players render with the
    // per-bucket HSL fill colour visible between the wire lines instead
    // of empty transparency. Scoped to the entity's `root` (not the
    // entire entitiesGroup) so the walk is O(per-entity verts) on each
    // spawn instead of O(all-entity verts).
    if (
      this.scene3d?.wireframeMode &&
      this.scene3d.materialCache &&
      typeof this.scene3d.materialCache.addFillCompanions === "function"
    ) {
      this.scene3d.materialCache.addFillCompanions(root);
    }
    // Phase 5 PView render-order fix (2026-05-25): entities live on layer 1
    // (RENDER_LAYER_INDOOR) alongside EnvCells so the depth-clear split in
    // atmosphere_pipeline.js draws cells + entities AFTER terrain when the
    // camera is inside a cottage. Three.js layer masks are per-object so we
    // walk the entity subtree after every child (model + nameplate + wire-
    // companion fills) is attached to ensure no node sits on layer 0.
    if (this.scene3d?.entitiesGroup) {
      root.traverse((o) => o.layers.set(1));
    }
    this.entityMap.set(guid, inst);
    // P6/A10-O1 — the FIRST rig committing is the in-world signal: arm the
    // one-shot archetype-matrix warm (self-guarded; later calls and
    // `?archetypeWarm=off` no-op). Any-entity, NOT local-player-gated: the
    // wasm eager-WorldState path suppresses the local player's KIND_SPAWN on
    // SelectCharacter (see _armPosition's note), so a local-only trigger
    // never fires on exactly the default boot. The delay inside lets the
    // boot flood + async AtmosphereLights attach settle so the warmed
    // programs compile against the final light state (A10-F3).
    try { scheduleArchetypeWarm(this.scene3d); } catch (_) { /* diag-only */ }
    // Bug 15 (2026-10-07): motions that arrived while this rig was being
    // built (see `_stashSpawnMotion`).
    if (this._spawnMotionStash?.has(guid)) {
      try { this._replaySpawnMotions(guid); } catch (_) { /* replay is best-effort */ }
    }
    // (2026-07-06) A corpse CreateObject (ODF Corpse bit) arrives right after a
    // creature's Dead motion + delete. Correlate it to the collapsing creature
    // so the corpse stays hidden until the death animation finishes and reveals
    // at the exact death transform (fixes the "corpse in a slightly different
    // spot" + "corpse appears before the animation is done" pair).
    if (this._deathAnimOn && ((meta.objDescFlags >>> 0) & ODF_CORPSE) !== 0) {
      // Re-materialized corpse (vis churn / dungeon cell transitions / walk
      // away and back): the sprawl + dismemberment lived on the OLD instance,
      // so every re-spawn snapped back to the authored prone pose ("the old
      // corpses come back", 2026-08-02). Restore from the per-guid archives
      // first; only a corpse with no archived state runs the death handoff
      // (a re-spawn has no dying creature to correlate with anyway).
      let restored = false;
      if (RAGDOLL_ON) {
        try { restored = !!window.__ragdollCorpseRestore?.(inst); } catch (_e) { /* optional */ }
      }
      try { if (window.__dismemberCorpseRestore?.(inst)) restored = true; } catch (_e) { /* optional */ }
      if (!restored) {
        try { this._tryCorpseDeathHandoff(inst); } catch (_) { /* handoff is best-effort */ }
      }
    }
    // P13/P16-H2 (2026-07-04) — once the LOCAL player's spawn bake commits
    // (its MotionTable is in the wasm source cache by construction), feed
    // the authored one-shot link lengths to the completion-clock shim so
    // cast gestures/emotes complete at their REAL clip length instead of
    // the flat 2.0 s. typeof-guarded: a stale pkg/ keeps the fallback.
    try {
      const lpgFn = (typeof window !== "undefined") ? window.getLocalPlayerGuid : null;
      const lpg = typeof lpgFn === "function" ? lpgFn() : null;
      if (lpg != null && (lpg >>> 0) === guid && mtableId) {
        const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
        if (sh && typeof sh.ingestMotionLengths === "function") {
          sh.ingestMotionLengths(mtableId >>> 0);
        }
      }
    } catch (_) { /* length ingest must never break spawn */ }
    // F3-1 (bughunt 2026-06-09) — ballistic projectile seed. PhysicsState::Missile
    // entities (war/void/life bolts, arrows/bolts/thrown weapons) are the one
    // class ACE never streams in-flight UpdatePosition for: the only motion datum
    // is the ObjectCreate PhysicsDesc launch velocity, surfaced on the KIND_SPAWN
    // EntityUpdate's vx/vy/vz (AC world frame, same frame as root.position). Seed
    // it as `lastVel` and flag `_ballistic` so tick()'s ballistic branch
    // integrates it every frame, instead of leaving the projectile frozen at the
    // launch point (the dead-reckon ease only moves entities with a server
    // POSITION target, which a missile never receives). Gated on BOTH the wasm
    // projectile classification (projectile_index ← PhysicsState::Missile) AND a
    // meaningfully non-zero launch velocity, so a non-missile spawn (vx/vy/vz = 0)
    // is never marked ballistic.
    // PROJ-VIS: classify once (wasm getter; spawn-static) — read by the
    // light attach, dynamic-LOD skip and default-script arm below.
    inst._isProjectile = this.isProjectile(guid);
    {
      const lvx = +(meta.vx ?? 0);
      const lvy = +(meta.vy ?? 0);
      const lvz = +(meta.vz ?? 0);
      if (lvx * lvx + lvy * lvy + lvz * lvz > 1e-4 && inst._isProjectile) {
        inst.lastVel = { vx: lvx, vy: lvy, vz: lvz, omegaZ: 0 };
        // PROJ-VIS: anchor the flight clock to when the ObjectCreate ARRIVED
        // (loop.js `_armSpawn` stamps `meta.recvMs`), not to now — the rig build
        // above awaits keyframes/materials, and starting the clock here made the
        // bolt run that latency behind its server flight for its whole life, so
        // the impact stop (NoDraw + VectorUpdate) caught it short of the target.
        // The first `_tickBallisticProjectiles` pass integrates the elapsed gap
        // (substepped; >2 s is skipped as a teleport, like retail).
        const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
        const recvMs = +meta.recvMs;
        inst.lastVelMs =
          PROJECTILE_LAUNCH_CLOCK_ON && Number.isFinite(recvMs) && recvMs > 0 && recvMs <= nowMs
            ? recvMs
            : nowMs;
        inst._ballistic = true;
        // RP6 particle cull exemption (particle_manager.js `_rp6ShouldCull`):
        // a projectile's trail emitters must emit every frame of the flight.
        if (inst.root) {
          inst.root.userData = inst.root.userData || {};
          inst.root.userData.__ballistic = true;
        }
        // The impact VectorUpdate can beat a slow rig build (setVelocity parks
        // it in `_pendingProjectileStops`); honour it so the bolt integrates to
        // where the server stopped it instead of flying on, hidden, for 5 s.
        const pendingStop = this._pendingProjectileStops?.get(guid);
        if (pendingStop != null) {
          this._pendingProjectileStops.delete(guid);
          inst._ballisticStopMs = pendingStop;
        }
        // Client-side terrain stop is only trusted when the launch point is
        // above the local terrain sample (a bolt fired across a rise can be
        // authored below our sample — see the ground-clamp skip above).
        inst._ballisticTerrainOk = false;
        if (PROJECTILE_TERRAIN_STOP_ON && (inst._outdoorCellIdx & 0xffff) < 0x0100) {
          const gz = _terrainZAt(inst.root.position.x, inst.root.position.y);
          inst._ballisticTerrainOk =
            gz != null && inst.root.position.z >= gz - PROJECTILE_TERRAIN_STOP_EPS;
        }
        // G-4 (?projectileGravity=on): arc the flight for gravity-class
        // missiles. Sampled once at spawn (classification is spawn-static).
        inst._ballisticGravity =
          PROJECTILE_GRAVITY_ON && this.projectileHasGravity(guid);
        // OpenAC comparison 2026-10-04 (combat M-2b): ALIGN_PATH missiles
        // face their velocity every frame (retail set_vector_heading).
        inst._ballisticAlignPath = this.projectileAlignsPath(guid);
        // PROJ-SPIN: RotationSpeed missiles carry a PhysicsDesc omega.
        inst._ballisticOmega = PROJECTILE_OMEGA_ON ? this.projectileOmega(guid) : null;
      }
    }
    // Track B2 (motion-audit, 2026-06-09): replay any PlayEffects that raced
    // ahead of this spawn (queued by guid when the target was not yet in the
    // entityMap). No-op if none queued.
    drainPendingPlayEffects(this, guid);
    // Server sounds that arrived before this object (retail QueueBlobForObject).
    try { drainPendingObjectSounds(guid); } catch (_) {}
    // Spawn-race recovery (2026-05-30): if a surface's DAT resources had not
    // yet streamed from the server when this entity spawned, its decode
    // returned empty and the mesh got the shared flat-grey fallback material
    // — the reported "white door / chest" (WB.Terminal confirmed the surface
    // DATA is correct; the decode just lost the spawn race and the material
    // was never refreshed). Detect any mesh still on the fallback and schedule
    // a deferred re-decode + material swap once the resources arrive. Gated to
    // NON-recolored entities (paletteId/subPalettes empty) so the plain re-decode
    // can't strip a recolor; recolored entities are rarer and left as-is.
    if (
      !hasPaletteSubs &&
      !WIREFRAME_MODE &&
      this.materialCache &&
      typeof this.wasmExports?.fetch_surfaces_pixels === "function"
    ) {
      // A mesh with no `.map` is on the fallback — either the shared
      // DoubleSide fallbackMaterial OR a FrontSide *clone* of it that
      // getCached() mints for `?perPolyCull` single-sided faces. Both mean
      // the surface decode lost the spawn race; real surfaces always carry a
      // map (solid-colour surfaces get a 1×1 DataTexture).
      let needsRefresh = false;
      root.traverse((o) => {
        if (!needsRefresh && o.isMesh && o.material && !o.material.map &&
            o.userData && o.userData.surfaceDid != null) {
          needsRefresh = true;
        }
      });
      if (needsRefresh) this._scheduleEntitySurfaceRefresh(inst, 0);
    }
    // R-8 (net-fixwave 2026-07-09) — recolored-path twin of the recovery arm above.
    // Players/recolored NPCs take the fetchEntitySurfacesPixels path, which the
    // `!hasPaletteSubs` gate excludes — one swallowed prefetch round (empty
    // parts) or an incomplete walk (`decodeMisses > 0`) whitened the whole
    // outfit with no recovery until respawn. A parameter-preserving refetch
    // (identical DIDs + palette state) cannot strip the recolor, so schedule one
    // on the same backoff ladder. Mapless probe mirrors the plain arm; the
    // decodeMisses arm additionally catches textured-but-unrecolored parts.
    if (
      hasPaletteSubs &&
      !WIREFRAME_MODE &&
      typeof this.wasmExports?.fetchEntitySurfacesPixels === "function"
    ) {
      let needsRefresh = composedDecodeMisses > 0;
      if (!needsRefresh) {
        root.traverse((o) => {
          if (!needsRefresh && o.isMesh && o.material && !o.material.map &&
              o.userData && o.userData.surfaceDid != null) {
            needsRefresh = true;
          }
        });
      }
      if (needsRefresh) {
        this._scheduleRecoloredSurfaceRefresh(inst, {
          paletteId,
          subPalettes,
          dids: new Uint32Array([...allSurfaceDids]),
          missArmed: composedDecodeMisses > 0,
        }, 0);
      }
    }
    // wieldedSpawn (2026-06-11) — this rig is a wielded child whose attach
    // is already parked (the wasm emits its synthetic KIND_SPAWN and the
    // kind=7 attach in one drain batch). The mount in attachChildToParent
    // resolves async (holding-location fetch), so without this the weapon
    // renders a frame or two at its spawn pose (the wielder's feet / LB 0)
    // before snapping to the hand. Hide via the state-visible channel —
    // attachChildToParent re-asserts `_setEntityStateVisible(c, true)` on
    // mount, and the cull walk recomposes from the same flag (a raw
    // `root.visible` write would be stomped by the next cull pass).
    // A8-M4 (2026-06-12): under `?preCreateBuffer=on` the park lives in the
    // generic buffer, not `_pendingAttach` — consult whichever map owns it.
    const hasParkedAttach = this._preCreateBufferOn
      ? this._preCreate.hasFor(guid, "attach")
      : this._pendingAttach.has(guid);
    if (this._wieldedSpawn && hasParkedAttach) {
      _setEntityStateVisible(inst, false);
    }
    // HELD-ITEM (2026-08-02, `?wieldPersist`) — durable re-attach replay.
    // Runs on BOTH drain arms below (the park queues only hold OUTSTANDING
    // requests; a re-created wielded item has none). See `_replayLastAttach`.
    this._replayLastAttach(guid, hasParkedAttach);
    if (this._preCreateBufferOn) {
      // A8-M4 (2026-06-12) — spawn-commit drain of the generic pre-create
      // buffer (retail: object creation replays the placeholder's queued
      // netblobs in arrival order). Subsumes the legacy flush below;
      // its map stays empty under the flag (no enqueue site feeds it).
      this._drainPreCreate(guid);
    } else {
      // Render-completeness audit (2026-05-29) — flush any wielded-item attach
      // that arrived before this rig (or its counterpart) existed. Covers both
      // roles: this entity may be a child waiting for its wielder, or a wielder
      // whose children are queued. Fire-and-forget (resolves holding frame async).
      this._flushPendingAttach(guid);
    }
    // Diagnostic hook (always-on; cheap when __diag not installed). Fires
    // AFTER the entity is committed to the live scene graph so observed
    // position is the final post-bake value, not the spawn-time meta.
    if (typeof window !== "undefined" && window.__diag?.onSpawnSucceeded) {
      try { window.__diag.onSpawnSucceeded(guid, inst); } catch (_) {}
    }
    // B4 (2026-05-18): index `name → Set<guid>` for O(1) lookup in
    // `findGuidByName`. Only adds when the entity carries a non-empty
    // string name (matches the nameplate-attach guard just below).
    if (
      inst.meta &&
      typeof inst.meta.name === "string" &&
      inst.meta.name.length > 0
    ) {
      const nm = inst.meta.name;
      let bucket = this._nameToGuid.get(nm);
      if (!bucket) {
        bucket = new Set();
        this._nameToGuid.set(nm, bucket);
      }
      bucket.add(guid);
    }

    // Task E (2026-05-12): prewarm the SoundTableCache for this entity.
    // The first cache.get() per DID kicks the wasm fetchSoundTable; we
    // do it now (spawn time, off the rAF tick) so that when a
    // SoundTable hook fires, `cache.resolveSound(...)` is already a
    // synchronous-in-practice (await on a settled Promise) operation.
    // Fire-and-forget — failures here are logged inside the cache
    // implementation; the per-hook executor falls through silently when
    // resolveSound returns null.
    //
    // Pattern choice rationale: the alternative is fire-and-forget per
    // hook with no prewarm. That makes first-hit per entity stutter
    // (wasm fetch + parse on a tick boundary) while subsequent hooks
    // are immediate. Prewarming amortizes the fetch onto the spawn
    // path where the entity is already async, and from-then-on every
    // hook fires through a warm cache. Spawn-time prewarm is the
    // documented choice in `docs/ambient-sounds-chain-2026-05-12.md`
    // task-E section "Pick prewarm-on-spawn."
    const stbDid = inst.soundTableDid;
    if (stbDid !== 0 && this.scene3d?.soundTableCache) {
      inst._prewarmCount += 1;
      this.scene3d.soundTableCache.get(stbDid).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/task-E] prewarm SoundTable 0x${stbDid.toString(16)} ` +
          `for entity 0x${guid.toString(16)} failed:`,
          e
        );
      });
    }

    // === Wave R2.A (2026-05-28) — entity-attached dynamic lights.
    // When `?entityLights=on`, fetch this Setup's LightInfo descriptors via
    // the SAME wasm export the static path uses (`fetchSetupModelLights`),
    // build THREE PointLight/SpotLight(s) with `lighting.js`'s constructor,
    // parent each under its matching per-part Group (`inst.parts[partIndex]`,
    // mirroring `attachSetupModelLights`), and start them OFF (visible=false,
    // intensity 0). The SetLight (25) hook later toggles them on/off. Fire-
    // and-forget so the wasm fetch doesn't block spawn return. Skipped wholly
    // when the flag is off (default) → zero allocation, byte-identical scene.
    // PROJ-VIS (2026-10-05, `?projectileLights`, default ON): a MISSILE's Setup
    // lights attach regardless of `?entityLights`, but ONLY through the fixed
    // light pool (pool carriers never change the renderer's light count → no
    // relink freeze; the legacy `.visible`-cap path would relink on every
    // cast, so it is left to the explicit `?entityLights=on` opt-in). Lit from
    // spawn when the ObjectCreate PhysicsState carries LIGHTING_ON — retail has
    // no SetLight hook for a bolt, the state bit IS the switch
    // (CPhysicsObj::set_state → CPartArray::InitLights, acclient.c:322172).
    const projLights =
      PROJECTILE_LIGHTS_ON &&
      inst._isProjectile === true &&
      !!this.scene3d?.lighting?.lightPool?.enabled;
    if (
      (this._entityLightsOn || projLights) &&
      this.wasmExports &&
      typeof this.wasmExports.fetchSetupModelLights === "function"
    ) {
      const lightOpts = projLights
        ? { projectile: true, startOn: this._projectileLightingOn(guid) }
        : undefined;
      this._attachEntityLights(inst, setupId, lightOpts).catch((e) => {
        // eslint-disable-next-line no-console
        if (!this._entityLightsWarned) {
          this._entityLightsWarned = true;
          console.warn(
            `[entities/R2.A] entity-light attach for 0x${guid.toString(16)} ` +
            `(setup=0x${setupId.toString(16)}) failed:`,
            e
          );
        }
      });
    }

    // === Wave R3.B (2026-05-29) — transparency depth-sort via AC sort center.
    // When `?sortCenter=on`, fetch this Setup's per-part `GfxObj.sort_center`
    // offsets (one fetch per unique setupId, cached) and stash them on the
    // instance so the per-frame `tick(dt)` can pin transparent-part blend
    // order. Fire-and-forget; the tick path no-ops until the offsets land.
    // Skipped wholly when the flag is off (default) → zero allocation, zero
    // wasm round-trips, byte-identical scene.
    if (
      this._sortCenterOn &&
      this.wasmExports &&
      typeof this.wasmExports.fetchSetupPartSortCenters === "function"
    ) {
      this._attachSortCenters(inst, setupId).catch((e) => {
        // eslint-disable-next-line no-console
        if (!this._sortCenterWarned) {
          this._sortCenterWarned = true;
          console.warn(
            `[entities/R3.B] sort-center attach for 0x${guid.toString(16)} ` +
            `(setup=0x${setupId.toString(16)}) failed:`,
            e
          );
        }
      });
    }

    // Step E.5 — H2 (2026-05-12): if the entity carries a PhysicsScript
    // DID, walk the CreateParticleHook chain and attach emitters
    // anchored on the entity's rig. Fire-and-forget — particle attach
    // doesn't block the spawn return; the manager's `tick()` picks up
    // emitters as they resolve. Reuses the Sky-J P4 ParticleManager
    // runtime + Sky-J P3 wasm exports.
    const pesId = (meta.physicsScriptDid >>> 0);
    if (
      pesId !== 0 &&
      !this._particleChainsAttached.has(guid) &&
      this.wasmExports &&
      typeof this.wasmExports.fetchPhysicsScript === "function" &&
      typeof this.wasmExports.fetchParticleEmitter === "function" &&
      typeof this.wasmExports.fetchBuildingPlacement === "function"
    ) {
      this._particleChainsAttached.add(guid);
      // F.D-fu3 (2026-05-20): record the resolve promise so validators
      // (and any caller via `awaitParticleChainResolution(guid)`) can
      // wait for the H2 chain to actually finish landing emitters +
      // scheduling Sound hooks before snapshotting state. The promise
      // resolves to a small descriptor regardless of success/failure
      // so the caller can branch on `result.ok` instead of catching.
      const resolvePromise = this._attachParticleChainForEntity(guid, root, pesId)
        .then((descriptor) => descriptor ?? { ok: true, emitterCount: 0, soundHookCount: 0 })
        .catch((e) => {
          this._particleChainsAttached.delete(guid);
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/H2] particle chain walk for 0x${guid.toString(16)} (pes=0x${pesId.toString(16)}) threw:`,
            e
          );
          return {
            ok: false,
            emitterCount: 0,
            soundHookCount: 0,
            reason: String(e?.message ?? e),
          };
        });
      this._particleChainResolveForGuid.set(guid, resolvePromise);
    }

    // A11-S5 / G14 (2026-06-12): spawn-time DefaultScript auto-resolve.
    // When `meta.physicsScriptDid` is 0 the entity may STILL carry a
    // PScriptType-coded PhysicsDesc default script (the wasm spawn payload
    // filters non-0x33 values) — resolve it through the retail
    // `play_default_script` chain (GetScript(default_script, intensity),
    // acclient.c:320351-320376) and play it. Same idempotency guard as the
    // raw-0x33 arm above; fire-and-forget (resolve is async DAT work).
    if (
      DEFAULT_SCRIPT_SPAWN_ON &&
      pesId === 0 &&
      // PROJ-VIS: a MISSILE's wire default_script is its COLLISION script
      // (see PROJECTILE_DEFAULT_SCRIPT_SPAWN_SKIP_ON) — never a spawn effect.
      !(PROJECTILE_DEFAULT_SCRIPT_SPAWN_SKIP_ON && inst._isProjectile === true) &&
      !this._particleChainsAttached.has(guid) &&
      this.wasmExports &&
      typeof this.wasmExports.fetchPhysicsScript === "function" &&
      typeof this.wasmExports.fetchParticleEmitter === "function" &&
      typeof this.wasmExports.fetchBuildingPlacement === "function"
    ) {
      this._resolveDefaultScriptDid(guid)
        .then((did) => {
          if (did === 0) return;
          if (!this.entityMap.has(guid)) return; // despawned mid-resolve
          if (this._particleChainsAttached.has(guid)) return;
          this._particleChainsAttached.add(guid);
          this._attachParticleChainForEntity(guid, root, did).catch((e) => {
            this._particleChainsAttached.delete(guid);
            // eslint-disable-next-line no-console
            console.warn(
              `[entities/A11-S5] default-script chain for 0x${guid.toString(16)} (pes=0x${did.toString(16)}) threw:`,
              e
            );
          });
        })
        .catch(() => {});
    }

    // Track B (2026-06-24): honor the entity's SetupModel.default_script — a
    // 0x33 PhysicsScript DID baked in the Setup DAT, the DAT-driven ambient
    // particle chain dynamic entities ignore (statics already play it via
    // `attachStaticDefaultScripts` ← wasm `fetch_landblock_objects`). The arms
    // above only read the WIRE PhysicsDesc default_script + raw `physicsScriptDid`,
    // never the Setup's own `default_script`. Gated `?setupDefaultScript`
    // (default OFF). Sibling of the A11-S5 wire arm — same `pesId===0` +
    // `_particleChainsAttached` idempotency guard, same
    // `_attachParticleChainForEntity` walker (anchored on `root`, so wield
    // carries it for free). Resolves via the new `fetchSetupDefaultScript` wasm
    // getter (typeof-guarded → a pre-rebuild pkg/ soft-degrades to skipped).
    // e.g. Burning Sands Katar: Setup 0x0200051C → 0x33000347 → 3× CreateParticle
    // → emitters 0x3200026E/0x32000270. Default OFF = byte-identical.
    if (
      SETUP_DEFAULT_SCRIPT_ON &&
      pesId === 0 &&
      (setupId >>> 0) !== 0 &&
      !this._particleChainsAttached.has(guid) &&
      this.wasmExports &&
      typeof this.wasmExports.fetchSetupDefaultScript === "function" &&
      typeof this.wasmExports.fetchPhysicsScript === "function" &&
      typeof this.wasmExports.fetchParticleEmitter === "function" &&
      typeof this.wasmExports.fetchBuildingPlacement === "function"
    ) {
      const sId = (setupId >>> 0);
      Promise.resolve(this.wasmExports.fetchSetupDefaultScript(sId))
        .then((rawDid) => {
          const did = (rawDid >>> 0);
          if (did === 0) return;
          if (!this.entityMap.has(guid)) return; // despawned mid-resolve
          if (this._particleChainsAttached.has(guid)) return;
          this._particleChainsAttached.add(guid);
          this._attachParticleChainForEntity(guid, root, did).catch((e) => {
            this._particleChainsAttached.delete(guid);
            // eslint-disable-next-line no-console
            console.warn(
              `[entities/TrackB] setup default_script chain for 0x${guid.toString(16)} ` +
                `(setup=0x${sId.toString(16)}, pes=0x${did.toString(16)}) threw:`,
              e
            );
          });
        })
        .catch(() => {});
    }

    // Track P3 (?gemSparkle, default-OFF) — SYNTHESIZED additive particle suite
    // for entities. If this entity's catalog descriptor carries a `particle`
    // mech AND the DID does NOT already self-emit via a DAT default_script
    // (coexistence rule §5 / §9 #14 — never double-animate the Track-B flame),
    // attach the client-local additive emitter(s) to `root` under owner
    // `guid>>>0`. Reuses the SAME ownerRegistry path + per-guid teardown the
    // H2/CreateParticle chains use, so entity-remove's destroyAllForOwner(g)
    // (entities.js:8060) reaps it for free. Fire-and-forget; OFF ⇒ no attach ⇒
    // byte-identical. Uses `lodOriginalSetup` (canonical SetupModel key) for the
    // descriptor lookup and `setupId` for the default_script coexistence probe.
    if (
      visualEnabled() && gemSparkleEnabled() &&
      (setupId >>> 0) !== 0 && this.wasmExports
    ) {
      this._attachVfxParticlesForEntity(guid, root, lodOriginalSetup >>> 0, setupId >>> 0)
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/P3] vfx particle attach for 0x${guid.toString(16)} threw:`, e,
          );
        });
    }

    // Track B7 (2026-06-08): if this entity carries a PhysicsScriptTable
    // (DAT 0x34) it can be the target of an object-triggered PlayEffect
    // (opcode 0xF755) at any moment. The PlayEffect resolver
    // (play_effect_vfx.js::_tryResolveRealVfx) walks a COLD async chain
    // — fetchPhysicsScriptTable → fetchPhysicsScript → per-hook
    // fetchParticleEmitter, plus the lazy ParticleManager build — which
    // made the spell effect land 5+s late on first touch. Fire-and-forget
    // a best-effort prewarm here so those DAT records + the world
    // ParticleManager are already warm by the time the cue arrives.
    // Guarded: no-op (and never throws) when the entity has no table DID
    // or the wasm getters are unavailable.
    {
      let tableDid = 0;
      try { tableDid = (this.getPhysicsScriptTableDid(guid) >>> 0); } catch (_) { tableDid = 0; }
      if (tableDid !== 0) {
        this._prewarmPhysicsScriptTable(tableDid, root).catch(() => {});
      }
    }
    // Follow-on #10 (3D port state doc) — DOM nameplate overlay. Skip
    // the local player (matches the 2D path's `ensureNameplate` skip at
    // index.html:3467 — your own head doesn't need a tag above it). The
    // local player check goes through `window.getLocalPlayerGuid` like
    // the 2D path does; pre-spawn the function returns null/undefined,
    // matching the 2D ensureNameplate skip on guid mismatch.
    if (
      this.scene3d?.nameplateLayer &&
      meta &&
      typeof meta.name === "string" &&
      meta.name.length > 0
    ) {
      let isLocalPlayer = false;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        try {
          const lpg = window.getLocalPlayerGuid();
          if (lpg !== null && lpg !== undefined) {
            isLocalPlayer = (lpg >>> 0) === guid;
          }
        } catch (_) {}
      }
      if (!isLocalPlayer) {
        try {
          this.scene3d.nameplateLayer.setNameplate(guid, meta.name, root);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._nameplateWarned) {
            this._nameplateWarned = true;
            console.warn("[follow-on#10] setNameplate threw:", e);
          }
        }
      }
    }
    // Task #13 (2026-05-13) — in-world THREE.Sprite nameplate, parented
    // to the entity's root Group so it auto-follows the rig via the
    // standard matrixWorld walk. Coexists with the DOM overlay above
    // (the DOM path is the fallback / capture-script-friendly overlay;
    // the sprite path is the visible-in-3D layer that depth-tests
    // against world geometry). The sprite module handles its own
    // local-player + inventory-item skip + category-coloured text bake,
    // so callers here pass through without further filtering.
    try {
      ensureNameplateForEntity(inst, this.scene3d);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!this._nameplateSpriteWarned) {
        this._nameplateSpriteWarned = true;
        console.warn("[task-13] ensureNameplateForEntity threw:", e);
      }
    }
    // Render-audit critic missedFeatures #1 (2026-06-09): whole-OBJECT
    // translucency. The wasm EntitySpawnJs carries `physicsTranslucency`
    // (PhysicsDesc Translucency, rank-6 render fix): 0.0 = fully opaque,
    // 1.0 = fully transparent. Apply at the entity ROOT so ghosts /
    // spectres / ethereal creatures and the classic fade-on-drop /
    // materialize render semi-transparent instead of fully opaque. This
    // is DISTINCT from the per-surface `state.translucency` consumed in
    // `_applyPalettedSurfaceRenderState` — object translucency composes
    // MULTIPLICATIVELY over each surface's authored base opacity (and over
    // the Ethereal hint), so the two never clobber each other. No-op when
    // the field is 0/absent (the common case) — leaves materials opaque.
    {
      const objTrans = +(meta.physicsTranslucency ?? 0);
      if (objTrans > 0) {
        try {
          this._applyObjectTranslucencyToEntity(inst, objTrans);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._objTransWarned) {
            this._objTransWarned = true;
            console.warn("[render-audit#1] spawn object-translucency threw:", e);
          }
        }
      }
    }
    if (SPAWN_TRACE) {
      const rigMs = performance.now() - _spawnTraceRigStart;
      const totalMs = performance.now() - _spawnTraceT0;
      const surfaceCount = allSurfaceDids?.size ?? 0;
      const path = hasPaletteSubs ? "palette" : "cache";
      // eslint-disable-next-line no-console
      console.log(
        `[spawn-trace] guid=0x${guid.toString(16)} setup=0x${setupId.toString(16)} ` +
        `parts=${partCount} surfaces=${surfaceCount} path=${path} | ` +
        `anim=${_spawnTraceAnimMs.toFixed(1)}ms mat=${_spawnTraceMatMs.toFixed(1)}ms ` +
        `rig=${rigMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`
      );
    }
    return inst;
  }

  _fallbackMaterial() {
    if (this.materialCache?.fallbackMaterial) {
      return this.materialCache.fallbackMaterial;
    }
    // Standalone / test mode — synthesize a one-off fallback.
    if (!this._sharedFallback) {
      this._sharedFallback = WIREFRAME_MODE
        ? new THREE.MeshBasicMaterial({
            color: 0x888888, wireframe: true, side: THREE.DoubleSide,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x888888,
            roughness: 0.9,
            metalness: 0.0,
            side: THREE.DoubleSide,
          });
      // Perf B3 (2026-05-18) — manager-owned singleton (lifecycle =
      // EntityManager.dispose at the bottom of this file). Mark as
      // cache-owned so per-entity dispose chains skip it. See the
      // `__disposable` convention block in the module docstring.
      this._sharedFallback.userData = {
        ...(this._sharedFallback.userData || {}),
        __cacheOwned: true,
      };
    }
    return this._sharedFallback;
  }

  /**
   * 2026-05-30 — spawn-race surface recovery. When an entity spawns before
   * its surface DAT resources have streamed from the server, the synchronous
   * decode returns empty and the mesh is painted with the shared flat-grey
   * fallback material; the resources then arrive but the material is never
   * refreshed — the permanent "white door / chest" (WB.Terminal confirmed the
   * surface DATA is intact; only the spawn-time decode lost the race). This
   * re-decodes the still-fallback surfaces and swaps the real material onto
   * the mesh once they resolve, retrying with backoff. Plain (non-recolored) path
   * only — the caller gates on `!hasPaletteSubs` so a plain re-decode can
   * never strip a recolor.
   */
  _scheduleEntitySurfaceRefresh(inst, attempt = 0) {
    // Backoff covering the slow tail of resource streaming: some entity
    // surfaces don't arrive until tens of seconds into the heavy initial
    // load (and setTimeout is starved while the atmosphere bake blocks the
    // main thread, so early ticks bunch up after it). Stops the instant
    // every surface has a textured material.
    const DELAYS_MS = [600, 1500, 3500, 8000, 16000, 32000, 60000, 90000];
    if (!inst || !inst.root || attempt >= DELAYS_MS.length) return;
    const cache = this.materialCache;
    if (!cache || typeof this.wasmExports?.fetch_surfaces_pixels !== "function") return;
    // "Needs a texture" = the current material has no `.map` — the shared
    // DoubleSide fallback OR a FrontSide clone of it. Real surfaces (incl.
    // solid colours, which get a 1×1 DataTexture) always carry a map.
    const needsTex = (mat) => !!mat && !mat.map;
    inst._surfaceRefreshTimer = setTimeout(async () => {
      inst._surfaceRefreshTimer = null;
      // Bail if the rig was disposed or replaced (e.g. LOD respawn) meanwhile.
      if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
      const pending = [];
      inst.root.traverse((o) => {
        if (o.isMesh && needsTex(o.material) && o.userData && o.userData.surfaceDid != null) {
          pending.push(o);
        }
      });
      if (pending.length === 0) return; // every surface resolved
      const dids = [...new Set(pending.map((m) => m.userData.surfaceDid >>> 0))];
      // R-2 (net-fixwave 2026-07-09): this ladder IS an explicit retry — a DID
      // negative-cached by a transient zero-dim (exactly the class it exists
      // to heal) made preload() below skip the fetch entirely, burning every
      // attempt as a no-op. Un-poison our targets first; a genuine catalog
      // absence just re-poisons via the provenAbsent-gated insert.
      if (cache.missingSurfaces) {
        for (const d of dids) cache.missingSurfaces.delete(d);
      }
      try {
        await cache.preload(dids, this.wasmExports.fetch_surfaces_pixels);
      } catch (_) { /* transient — covered by the retry below */ }
      if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
      for (const m of pending) {
        // Preserve the mesh's sidedness (FrontSide for per-poly-culled faces).
        const doubleSided = !m.material || m.material.side !== THREE.FrontSide;
        const real = cache.getCached(m.userData.surfaceDid >>> 0, doubleSided);
        if (real && real.map) m.material = real; // only swap to a textured material
      }
      // Anything still untextured? the resource hasn't arrived — back off + retry.
      if (pending.some((m) => needsTex(m.material))) {
        this._scheduleEntitySurfaceRefresh(inst, attempt + 1);
      }
    }, DELAYS_MS[attempt]);
  }

  /**
   * R-8 (net-fixwave 2026-07-09) — cancel a pending recolored-surface refresh.
   * Called on appearance change (`_applyAppearanceHotSwap`): the captured
   * palette state is stale then, and the swap re-fetches + re-arms itself.
   * Despawn/respawn cancels via `EntityInstance.dispose()` (timer clear) +
   * the ladder's `entityMap.get(guid) !== inst` guard.
   */
  _cancelRecoloredSurfaceRefresh(inst) {
    if (!inst) return;
    if (inst._recolorRefreshTimer) {
      try { clearTimeout(inst._recolorRefreshTimer); } catch (_) {}
      inst._recolorRefreshTimer = null;
    }
    inst._recolorRefreshKey = null;
  }

  /**
   * R-8 (net-fixwave 2026-07-09) — recolored-path twin of
   * `_scheduleEntitySurfaceRefresh` above. The plain ladder is gated
   * `!hasPaletteSubs` (a plain re-decode would strip a recolor), so every player
   * (skin/hair subPalettes) and recoloured NPC had NO recovery: one transient
   * empty decode in the single fetchEntitySurfacesPixels call painted the
   * whole outfit with the mapless grey fallback until respawn. The safe
   * retry is a PARAMETER-PRESERVING refetch — identical DIDs + (paletteId,
   * subPalettes) — which by construction cannot strip the recolor.
   *
   * `spec` = { paletteId, subPalettes, dids: Uint32Array (the spawn's full
   * surface-DID set), missArmed: bool }. Normally only the still-mapless
   * DIDs are refetched (checking the shared paletted cache first); the one
   * `missArmed` sweep — armed when the spawn/hot-swap fetch reported
   * `decodeMisses > 0` (P2↔P3 ABI) — refetches the full set and, once a
   * COMPLETE decode lands (refetch decodeMisses === 0), also swaps textured
   * meshes: a soft-skipped palette overlay leaves a textured-but-unrecolored
   * material the mapless probe can't see. Same backoff schedule, liveness
   * guards, and stop-when-healed shape as the plain ladder, plus:
   *   - per-entity dedupe (`_recolorRefreshTimer` — one ladder per rig);
   *   - appearance supersession (`_recolorRefreshKey` — hot-swap cancels);
   *   - `_recoloredSurfaceAbsent` skip set (catalog-proven absences never retry).
   * Healed materials install via `installPaletted` so every later entity
   * with the same recolor signature is a cache hit (and a signature poisoned by
   * an incomplete decode is replaced for future spawns).
   */
  _scheduleRecoloredSurfaceRefresh(inst, spec, attempt = 0) {
    const DELAYS_MS = [600, 1500, 3500, 8000, 16000, 32000, 60000, 90000];
    if (!inst || !inst.root || !spec || attempt >= DELAYS_MS.length) return;
    if (typeof this.wasmExports?.fetchEntitySurfacesPixels !== "function") return;
    if (inst._recolorRefreshTimer) return; // per-entity dedupe — one ladder at a time
    // `?recolor=off` CHOKE POINT 3 of 3 — the recolored recovery ladder
    // (2026-07-26). Belt-and-braces: both arming sites (spawn commit,
    // hot-swap commit) already pass gated values, so under `off` this ladder
    // is never armed at all (`hasPaletteSubs` is false there and the PLAIN
    // ladder arms instead). Gating here as well means a future arming site —
    // or a stale `spec` captured before a flag flip — cannot re-open the
    // composed decode behind the experiment's back.
    const paletteId = gatePaletteId((spec.paletteId ?? 0) >>> 0);
    const subPalettes = gateSubPalettes(spec.subPalettes ?? new Uint32Array(0));
    const key = `${paletteId}|${Array.from(subPalettes).join(",")}`;
    if (attempt === 0) inst._recolorRefreshKey = key;
    const needsTex = (mat) => !!mat && !mat.map;
    const skipAbsent = (did) =>
      !!(inst._recoloredSurfaceAbsent && inst._recoloredSurfaceAbsent.has(did >>> 0));
    inst._recolorRefreshTimer = setTimeout(async () => {
      inst._recolorRefreshTimer = null;
      // Same liveness guards as the plain ladder, plus appearance
      // supersession: a hot-swap cleared/replaced the key meanwhile.
      if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
      if (inst._recolorRefreshKey !== key) return;
      const cache = this.materialCache;
      const pendingDids = new Set();
      inst.root.traverse((o) => {
        if (o.isMesh && needsTex(o.material) && o.userData &&
            o.userData.surfaceDid != null && !skipAbsent(o.userData.surfaceDid)) {
          pendingDids.add(o.userData.surfaceDid >>> 0);
        }
      });
      const sweep = !!spec.missArmed;
      if (pendingDids.size === 0 && !sweep) {
        inst._recolorRefreshKey = null; // every recolored surface resolved
        return;
      }
      // Refetch set: mapless DIDs always; the missArmed sweep takes the full
      // spawn set (minus proven absences). A shared-cache hit heals a mapless
      // DID without a fetch — except under the sweep, where the cached entry
      // is exactly what the incomplete decode may have poisoned.
      const healed = new Map();
      const fetchDids = [];
      const wantDids = new Set(pendingDids);
      if (sweep) for (const d of spec.dids) { if (!skipAbsent(d)) wantDids.add(d >>> 0); }
      for (const d of wantDids) {
        const hit = (!sweep && cache)
          ? cache.getCachedPaletted(d, paletteId, subPalettes)
          : null;
        if (hit && hit.map) healed.set(d, hit);
        else fetchDids.push(d);
      }
      let results = null;
      if (fetchDids.length > 0) {
        try {
          results = await this.wasmExports.fetchEntitySurfacesPixels(
            new Uint32Array(fetchDids),
            paletteId,
            subPalettes
          );
        } catch (_) { /* transient — covered by the retry below */ }
      }
      // Re-check liveness across the await (mirrors the plain ladder).
      if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
      if (inst._recolorRefreshKey !== key) return;
      const refetchMisses = surfaceResultDecodeMisses(results);
      const absent = surfaceResultProvenAbsent(results);
      if (absent && absent.size) {
        if (!inst._recoloredSurfaceAbsent) inst._recoloredSurfaceAbsent = new Set();
        for (const d of absent) inst._recoloredSurfaceAbsent.add(d >>> 0);
      }
      // Only a COMPLETE refetch (misses === 0; null = legacy wasm, in which
      // case the sweep can never have been armed) may swap textured meshes.
      const sweepComplete = sweep && !!results && (refetchMisses ?? 0) === 0;
      for (let i = 0; i < fetchDids.length; i += 1) {
        const did = fetchDids[i] >>> 0;
        const sp = results ? results[i] : null;
        if (!sp || sp.width === 0 || sp.height === 0) {
          if (sp && typeof sp.free === "function") sp.free();
          continue; // still empty — the retry below backs off
        }
        const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
        // C1 — snapshot Surface (0x08) render-state BEFORE `sp.free()`
        // (mirrors the spawn-path twin).
        const palSurfaceState = {
          surfaceType: (sp.surfaceType ?? 0) >>> 0,
          translucency: typeof sp.translucency === "number" ? sp.translucency : 0.0,
          luminosity: typeof sp.luminosity === "number" ? sp.luminosity : 0.0,
          diffuse: typeof sp.diffuse === "number" ? sp.diffuse : 0.0,
          hasPalette: typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined,
        };
        if (typeof sp.free === "function") sp.free();
        const mat = new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.9,
          metalness: 0.0,
          side: THREE.DoubleSide,
          transparent: false,
        });
        this._applyPalettedSurfaceRenderState(mat, palSurfaceState);
        mat.name = `paletted-${did.toString(16)}-${paletteId.toString(16)}`;
        if (cache) {
          cache.installPaletted(did, paletteId, subPalettes, mat, tex);
        } else {
          mat.userData = { ...(mat.userData || {}), __disposable: true };
          inst.registerOwnedTexture(tex);
          inst.registerOwnedMaterial(mat);
        }
        healed.set(did, mat);
      }
      if (healed.size > 0) {
        inst.root.traverse((o) => {
          if (!o.isMesh || !o.userData || o.userData.surfaceDid == null) return;
          const mat = healed.get(o.userData.surfaceDid >>> 0);
          if (!mat || !mat.map) return;
          if (needsTex(o.material)) {
            o.material = mat;
          } else if (sweepComplete && !o.material?.userData?.__vfxSetKey) {
            // Sweep: replace possibly-unrecolored textured parts too — but never
            // a VFX variant clone (would drop the aura; colour staleness is
            // the lesser evil there).
            o.material = mat;
          }
        });
        if (!inst._entityMaterials) inst._entityMaterials = new Map();
        for (const [d, m] of healed) inst._entityMaterials.set(d, m);
      }
      // Anything still mapless (or the sweep still incomplete)? back off +
      // retry; otherwise the ladder is done — release the supersession key.
      let stillPending = false;
      inst.root.traverse((o) => {
        if (!stillPending && o.isMesh && needsTex(o.material) && o.userData &&
            o.userData.surfaceDid != null && !skipAbsent(o.userData.surfaceDid)) {
          stillPending = true;
        }
      });
      const missStill = sweep && !sweepComplete;
      if (stillPending || missStill) {
        this._scheduleRecoloredSurfaceRefresh(
          inst, { ...spec, missArmed: missStill }, attempt + 1
        );
      } else {
        inst._recolorRefreshKey = null;
      }
    }, DELAYS_MS[attempt]);
  }

  /**
   * DEPRECATED 2026-07-26 (dye→recolor terminology rename) — thin aliases so
   * the out-of-tree probe `harness/surface-ladder-probe.mjs` (which arms this
   * ladder by name on a live `EntityManager`) keeps working for one release.
   * Remove after the harness is updated. No behaviour: pure delegation.
   */
  _scheduleDyedSurfaceRefresh(inst, spec, attempt = 0) {
    return this._scheduleRecoloredSurfaceRefresh(inst, spec, attempt);
  }

  /** DEPRECATED 2026-07-26 — see `_scheduleDyedSurfaceRefresh` above. */
  _cancelDyedSurfaceRefresh(inst) {
    return this._cancelRecoloredSurfaceRefresh(inst);
  }

  /**
   * C1 (render-completeness wave 3, 2026-05-29) — apply Surface (0x08)
   * Tier-1 render-state to a palette-path material.
   *
   * The plain entity path (paletteId=0) routes through
   * `MaterialCache._materialFromFlags`, which reads `Surface.surface_type`
   * (the bitfield) + the trailing translucency/luminosity floats and sets
   * the blend mode, opacity, alphaTest, and emissive accordingly. The
   * palette path (dyed armour, skin/hair-tinted players, recolored
   * creatures — `hasPaletteSubs`) builds its `MeshStandardMaterial` inline
   * and historically dropped ALL of that, so luminous/translucent/clipmap
   * recolored gear rendered flat-opaque and non-emissive. This replicates the
   * SAME render-state treatment as `_materialFromFlags` (materials.js
   * @1743-1820) inline (Agent C owns materials.js; we may not edit it) and
   * tags `userData.surfaceTypeFlags` so downstream AnimationHook material
   * ramps (SetMaterial etc.) can read the bits.
   *
   * Fail-soft: missing/zero `surfaceType` → leaves the material at its
   * constructed opaque state (current behaviour). `state` is a plain
   * snapshot `{ surfaceType:u32, translucency:f32, luminosity:f32 }` taken
   * from the wasm `SurfacePixels` object BEFORE its `free()` (getters at
   * web/src/lib.rs:5514/5552/5558 are invalid after free).
   *
   * Retail mapping: blend states D3DPolyRender::SetSurface acclient.c:454470
   * (Alpha → SRCALPHA/INVSRCALPHA), :454513 (Translucent), emissive @454688.
   */
  _applyPalettedSurfaceRenderState(mat, state) {
    if (!mat || !state) return;
    const flags = (state.surfaceType ?? 0) >>> 0;
    // Persist the bitfield regardless — AnimationHook material ramps read it.
    mat.userData = { ...(mat.userData || {}), surfaceTypeFlags: flags };
    if (flags === 0) return; // fail-soft: empty/fallback surface stays opaque
    const sfTranslucency = +(state.translucency ?? 0.0);
    const sfLuminosity = +(state.luminosity ?? 0.0);
    const sfDiffuse = +(state.diffuse ?? 0.0);
    // === A10-M1 (2026-06-11) — delegate to the single decoder ================
    // When `?surfaceUnified=on`, route through the shared
    // `applySurfaceRenderState` (materials.js) so the recolored/paletted path and the
    // cache path run ONE decoder. This ALSO attaches the luminous emissiveMap
    // (the diffuse-recoloured map, `mat.map`) — the resolved reading that fixes
    // recolored luminous gear washing to white (A10 §3 row 2; ROADMAP §7 item 2).
    // Default OFF keeps the legacy inline ladder below (NO emissiveMap — the
    // wrong reading, kept for byte-identical rollback only). The userData
    // surfaceTypeFlags stamp above is preserved for the hook-ramp clock.
    if (readSurfaceUnifiedFlag()) {
      applySurfaceRenderState(
        mat,
        {
          flags,
          translucency: sfTranslucency,
          luminosity: sfLuminosity,
          diffuse: sfDiffuse,
          // A10-M3 — forward palettedness (parityV2 ClipMap alpha-test ref).
          // NOTE this state object keys the bitfield as `surfaceType` (not
          // `flags`) — kept asymmetric on purpose; only the new key is added.
          hasPalette: state.hasPalette,
        },
        { texture: mat.map ?? null },
      );
      return;
    }
    const isTranslucent = (flags & SURFACE_TYPE.Translucent) !== 0;
    const isClipMap = (flags & SURFACE_TYPE.Base1ClipMap) !== 0;
    const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
    const isAlpha = (flags & SURFACE_TYPE.Alpha) !== 0;
    const isInvAlpha = (flags & SURFACE_TYPE.InvAlpha) !== 0;
    if (isAdditive && isAlpha) {
      // Wave-3 M1 parity (2026-05-29): Alpha+Additive (0x10000|0x100) blends
      // SRCALPHA/ONE, not ONE/ONE — the additive contribution is weighted by
      // per-texel source alpha (retail acclient.c:454474). This MUST match
      // `_materialFromFlags` (materials.js:1768) so a recolored/paletted glow
      // blends identically to its un-recolored twin; otherwise the palette path
      // over-brightened Alpha+Additive surfaces with hard halo edges.
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendEquation = THREE.AddEquation;
      mat.transparent = true;
      mat.depthWrite = false;
    } else if (isAdditive) {
      // Pure-additive (no Alpha bit) → ONE/ONE (flames, sparks); depthWrite
      // off so they don't occlude geometry behind them.
      mat.blending = THREE.AdditiveBlending;
      mat.transparent = true;
      mat.depthWrite = false;
    } else if (isTranslucent || isAlpha || isInvAlpha) {
      // Alpha blend (SRCALPHA/INVSRCALPHA), depthWrite off — painter-sorted.
      mat.transparent = true;
      mat.depthWrite = false;
      // Translucent's alpha = 1 - T (acclient.c:454523); Alpha (0x100) takes
      // its alpha from the texture channel, so only adjust opacity for
      // Translucent with T>0.
      if (isTranslucent && sfTranslucency > 0) {
        mat.opacity = Math.max(0, 1 - sfTranslucency);
        // DIM7-5 / W4.2 (2026-06-05): stash the AUTHORED base translucency so a
        // later Transparent(20)/TransparentPart(7) hook ramp can floor against
        // it — retail floors `_end` to translucencyOriginal
        // (acclient.c:316947-316956) so a hook can't render a base-translucent
        // surface MORE opaque than its authored baseline.
        // `_applyRampValueToMaterial` reads this back. (anim-deep FIX-PLAN W4.2.)
        mat.userData = { ...(mat.userData || {}), __baseTranslucency: sfTranslucency };
      }
    } else if (isClipMap) {
      // Binary alpha mask. RND-08/33 (2026-07-27): retail's ref is per-format
      // (paletted 100/255, DDS 200/255) and the arm also enables
      // ONE/INVSRCALPHA blending — shared with the two materials.js ladders via
      // `applyClipMapRenderState` so a recoloured clipmap surface (dolls,
      // Virindi) decodes identically to its un-recoloured twin.
      applyClipMapRenderState(mat, state.hasPalette);
    }
    if (sfLuminosity > 0) {
      // Self-illumination driven by the luminosity FLOAT (not the 0x40 bit).
      // LEGACY (?surfaceUnified off): flat grayscale emissive with NO
      // emissiveMap. NOTE — this is the WRONG reading: retail's grayscale
      // emissive is MODULATED by the diffuse texture in the FF combiner
      // (acclient.c:454691-454697 + 454429-454432), so omitting the emissiveMap
      // washes a COLOURED recolored-luminous surface to white (A10 §3 row 2). The
      // correct reading (emissiveMap = mat.map) lives in
      // `applySurfaceRenderState` (materials.js) and is taken when
      // `?surfaceUnified=on`. Kept here only for byte-identical flag-off
      // rollback. Clamp to (0, 2] (ACE ~[0,1] with occasional HDR pushes).
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = Math.min(2.0, sfLuminosity);
      // R1 (2026-06-24, `?luminousEmissiveMap`): attach the (recoloured)
      // diffuse map as emissiveMap so a COLOURED recolored-luminous surface glows
      // in-colour (FF texture×emissive) instead of washing to white — the same
      // resolved reading `?surfaceUnified` takes, as a narrow opt-in. The
      // non-recolored cache path already does this (applyFloatLumDiffuse:1284), so the
      // emissiveMap program variant already exists (no net new program expected).
      // Default OFF = byte-identical (flat white).
      if (readLuminousEmissiveMapFlag() && mat.map) mat.emissiveMap = mat.map;
    }
    // Diffuse-reflectance albedo tint — parity with _materialFromFlags
    // (materials.js:1839; retail acclient.c:454458). No-op at d≈1 (~96% of
    // surfaces); dims the d≠1 minority. Multiplies with the (recolored) map.
    // C1 originally omitted this, so paletted/recolored gear skipped the dim that
    // the plain path applies.
    if (sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
      mat.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
    }
    // Retail draws a surface ONCE (`?surfaceSinglePass`, materials.js
    // `applyRetailSinglePass`). THIS LADDER IS THE PATH THAT ACTUALLY RUNS:
    // `readSurfaceUnifiedFlag()` is default-OFF, so the `applySurfaceRenderState`
    // delegate above is NOT taken and recolored/paletted entity materials never reach
    // that funnel. Putting the parity call only on the funnel left the dominant
    // population (403 of 451 transparent DoubleSide meshes at Holtburg are
    // `paletted-*`) still double-submitted — caught by field verification, where
    // the scene-wide arm still found 26 materials to flip and still gained +40%
    // fps AFTER the "fix" had supposedly landed. A no-op unless the ladder above
    // actually made this material transparent.
    applyRetailSinglePass(mat);
    mat.needsUpdate = true;
  }

  /**
   * Update transform from PositionUpdate. No animation switch.
   *
   * This is the SERVER-AUTHORITATIVE position-update path: it's invoked from
   * `loop.js` (the KIND_POSITION drain + the local-player integrator sync) and
   * is distinct from the spawn / respawn / appearance-hotswap path, which
   * calls `EntityInstance.setPose(…)` directly (so those always snap — first
   * placement and pose-preserve respawns never glide).
   *
   * Wave R3.A (2026-05-28) — when `?deadReckon=on` AND the entity is a REMOTE
   * one (NOT the local player, which owns its own client-side prediction and
   * must not be fought), the server pose is stashed as a per-entity target and
   * `tick(dt)` critically-damps `root.position` toward it. Default OFF, or for
   * the local player, falls through to the byte-identical snap below.
   */
  /**
   * A2-P2 (2026-06-12, W3+ S8, `?remoteInterp=on`) — apply one wasm-managed
   * remote pose row (loop.js `drainRemotePoses`, world coords). The Rust
   * PositionManager already eased this position (retail `adjust_offset` step
   * cap, acclient.c:389258-389264), so it's written DIRECTLY — no JS ease on
   * top. Ownership rules (S8 P2.d.2):
   *   - local guid → no-op (defense; loop.js also skips);
   *   - `_ballistic` → no-op (F3-1/G-4 projectile self-integration owns it);
   *   - `_stickyTarget` → no-op (F3-4 glue owns position until A2-P3 —
   *     retail's sticky also runs inside this manager, acclient.c:388300,
   *     but sticky is explicitly P3 scope);
   *   - else: arm `_wasmDriven` ownership, write root.position, and
   *     re-anchor `_serverTargetPos` so the legacy ease has nothing to drag
   *     when ownership decays back (S8 §5 risk 2).
   * ROTATION is deliberately untouched on plain rows — heading stays
   * JS-owned through the same K=14 ease stash `setPose` keeps feeding (S8
   * OPEN Q4). A2-P3 R2 (`?stickyRetail=on`): a STICKY-stepped row passes
   * the optional AC quat (qw..qz) — retail sets the sticky heading hard
   * every frame (acclient.c:388593-388600), so it's applied directly and
   * the ease stash is re-anchored to it (no yank-back on release).
   */
  applyManagedPose(guid, x, y, z, qw, qx, qy, qz) {
    if (!this._remoteInterpOn) return;
    const g = guid >>> 0;
    if (this._isLocalPlayerGuid(g)) return;
    const inst = this.entityMap.get(g);
    if (!inst || !inst.root) return;
    if (inst._ballistic) return;
    if (inst._stickyTarget) return;
    // OpenAC comparison 2026-10-04 (remote motion D10): a queue still draining
    // at death must not drag the collapsed body — the corpse holds where it fell.
    if (inst._deadFrozen) return;
    // HELD-ITEM (2026-08-02) — a parented object has no world position of its
    // own; its root transform is the hand-local holding frame. Retail refuses
    // to integrate it at all (`CPhysicsObj::update_position` acclient.c:321671
    // `if (!this->parent)`; `update_object` :323099). Writing the wire world
    // pose here would fling the weapon out of the hand.
    if (WIELD_PERSIST_ON && inst._attachedParentGuid != null) return;
    inst._wasmDriven = REMOTE_INTERP_OWNERSHIP_FRAMES;
    inst.root.position.set(x, y, z);
    let tgt = inst._serverTargetPos;
    if (!tgt) tgt = inst._serverTargetPos = new THREE.Vector3();
    tgt.set(x, y, z);
    // CREATURE-SEPARATION (2026-07-28) — the separation resolve in `tick`
    // CANNOT cover this lane: `loop.js` runs `entityManager.tick(dt)`
    // (loop.js:2089) and only THEN `drainRemotePoses` (loop.js:2102), so a
    // wasm-managed row is the LAST write to `root.position` each frame and
    // would be rendered un-separated. Measured live: a Tusker Guard pinned at
    // the 1.476 m floor on tick frames but flicked to 0.300 m on managed-row
    // frames — 0.3 is `StickyManager::adjust_offset`'s bare `STICKY_RADIUS`
    // (acclient.c:388559), i.e. the Rust REMOTE sticky lane was radius-blind
    // (both radii 0.0). That deeper repair has since landed (remote motion
    // D6, 86c3ef14: `stick_remote_entity_to` carries the holder's and the
    // target's `combat_part_dims` radius, so a sticky row now stands at
    // r_holder + r_target + 0.3, outside this floor) — the push-out stays as
    // the render-side guarantee for every other row and for the
    // `?combatRadii=off` 0.0 fallback. Re-uses the same floor + push-out as
    // `tick`.
    // (Gate lives INSIDE `_applyCreatureSeparation` so the eval counter stays
    // unconditionally reachable on this lane too; rows here are sparse — only
    // bodies whose Rust manager stepped this tick — so the per-row player-pose
    // resolve is a handful of calls per frame, not one per entity.)
    if (!inst._deadFrozen) {
      const pp = this._localPlayerWorldPose();
      if (pp) this._applyCreatureSeparation(inst, pp);
    }
    // A2-P3 R2 — sticky heading (only sticky-flagged rows carry a quat;
    // loop.js drainRemotePoses omits it otherwise).
    if (qw !== undefined && Number.isFinite(+qw)) {
      const tq = acQuatToThree(+qw, +qx, +qy, +qz);
      inst.root.quaternion.copy(tq);
      let tgtQ = inst._serverTargetQuat;
      if (!tgtQ) tgtQ = inst._serverTargetQuat = new THREE.Quaternion();
      tgtQ.copy(tq);
      inst._headingEaseInit = true;
    }
  }

  setPose(guid, x, y, z, qw, qx, qy, qz) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // HELD-ITEM (2026-08-02) — same parented-object guard as
    // `applyManagedPose` / `setVisibility`. ACE keeps broadcasting a position
    // for an equipped item in some flows (drop/pickup echo, teleport
    // re-sync); applying it to a hand-parented root moves the weapon by the
    // full world coordinate (tens of thousands of metres) and it reads as
    // "the weapon disappeared". Retail: `update_position` acclient.c:321671.
    // Also drop any ease target stashed BEFORE the attach, so `tick`'s
    // dead-reckon can't keep dragging the child toward a world point.
    if (WIELD_PERSIST_ON && inst._attachedParentGuid != null) {
      inst._serverTargetPos = null;
      inst._serverTargetQuat = null;
      inst._headingEaseInit = false;
      return;
    }
    const isRemote = !this._isLocalPlayerGuid(g);
    // A2-P2 (`?remoteInterp=on`): while the wasm PositionManager owns this
    // entity's position, the wire packet that produced this KIND_POSITION
    // ALREADY fed the Rust manager via the routed arm — writing/stashing the
    // un-eased target here would double-apply it (S8 §5 risk 1). The
    // sticky-clear below and the heading stash still run (heading stays
    // JS-owned this stage); only the POSITION write/stash is skipped.
    const wasmDriven =
      this._remoteInterpOn && isRemote && (inst._wasmDriven | 0) > 0;
    // F3-4 (bughunt 2026-06-09): a real server position broadcast for this
    // entity means ACE resumed netsend-true movement — sticky is over (a
    // sticky monster receives NO position updates). Clear it so normal
    // dead-reckon resumes from this authoritative pose. This is the single
    // clear-on-resumed-position point for both KIND_POSITION drain paths
    // (EntityManager.setPose is only reached from a KIND_POSITION event).
    if (inst._stickyTarget) inst._stickyTarget = null;
    // CREATURE-SEPARATION (2026-07-28): stash the AUTHORITATIVE wire pose
    // before any of the branches below decide to ease, snap or defer it.
    // `setPose` is reached ONLY from a KIND_POSITION drain (see the comment
    // just above), so this is the raw server pose — the anchor the prediction
    // clamp measures against. Kept for remotes only; the local player runs its
    // own predictor and never reaches the separation resolve.
    if (isRemote) {
      let wp = inst._wirePos;
      if (!wp) wp = inst._wirePos = new THREE.Vector3();
      wp.set(x, y, z);
    }
    // A5-P3 (?rootMotionObject=1): a fresh authoritative KIND_POSITION
    // replaces the anchor wholesale, making the applied-root-motion
    // ledger moot — clear it (diag-only; the existing dead-reckon
    // teleport-snap guard already bounds any large residual delta).
    if (inst._appliedRootMotion) inst._appliedRootMotion = null;

    // === A2 Path A (2026-05-29) — remote-entity HEADING ease.
    // Eligible only for a plain remote entity whose rotation isn't already
    // owned this frame by SetOmega spin (`_omega`) or a jump (`_isAirborne` /
    // `airborneTilt`) — those write `root.quaternion` in `tick`, so easing the
    // same channel would fight them. When eligible, stash the server heading as
    // a target the per-frame `tick` slerps toward; position keeps its existing
    // behavior (R3.A ease under `?deadReckon`, else snap). When NOT eligible we
    // fall through to the exact pre-Path-A code (byte-identical snap paths).
    const easeHeading =
      this._headingEaseOn &&
      isRemote &&
      !inst._omega &&
      !inst._cycleOmega &&
      !inst._isAirborne &&
      !inst.airborneTilt;
    if (easeHeading) {
      const tq = acQuatToThree(qw, qx, qy, qz); // plain remote → no tilt mult
      let tgtQ = inst._serverTargetQuat;
      if (!tgtQ) tgtQ = inst._serverTargetQuat = new THREE.Quaternion();
      // First heading for this entity, or a large single-update delta (a
      // re-target / teleport / respawn discontinuity, not a physical turn at
      // ~30 Hz) → snap so the rig doesn't spin slowly across the gap.
      if (
        !inst._headingEaseInit ||
        inst.root.quaternion.angleTo(tq) > HEADING_EASE_SNAP_RAD
      ) {
        inst.root.quaternion.copy(tq);
      }
      inst._headingEaseInit = true;
      tgtQ.copy(tq);
      // G-5 (?turnOmega=on): a position-driven heading target supersedes a
      // turn directive — drop the omega cap so smoothing keeps its fixed-K.
      if (inst._turnOmegaCapRad) inst._turnOmegaCapRad = 0;
      // Position — unchanged from R3.A: ease under ?deadReckon, else snap.
      // A2-P2: skipped entirely while the wasm manager owns position.
      if (wasmDriven) {
        return;
      }
      if (this._deadReckonOn) {
        let tgt = inst._serverTargetPos;
        if (!tgt) tgt = inst._serverTargetPos = new THREE.Vector3();
        const cur = inst.root.position;
        const dx = x - cur.x;
        const dy = y - cur.y;
        const dz = z - cur.z;
        if (dx * dx + dy * dy + dz * dz > DEAD_RECKON_TELEPORT_SNAP_SQ) {
          // A4-Q3 (?mtQueue=on): a teleport-class snap is this remote
          // entity's exit/enter-world signal — cancel its one-shot
          // overlays (retail HandleExitWorld drain + enter-world link
          // removal, acclient.c:329940-329957). No-op flag-off.
          this._cancelOneShotOverlays(inst);
          cur.set(x, y, z);
        }
        tgt.set(x, y, z);
      } else {
        inst.root.position.set(x, y, z);
      }
      return;
    }
    // Not eased (local player, omega/jump owns rotation, or `?headingSnap=on`):
    // reset the init flag so the ease re-snaps cleanly the moment it resumes.
    inst._headingEaseInit = false;

    // Wave R3.A — remote-entity smoothing gate. Rotation always snaps (heading
    // is already normalized upstream); only POSITION is eased.
    if (this._deadReckonOn && isRemote) {
      // Orientation snaps as before — re-uses EntityInstance.setPose's
      // quaternion path by writing the rotation directly, leaving position to
      // the ease in tick(). (Calling inst.setPose here would snap position,
      // defeating the smoothing.)
      inst.root.quaternion.copy(acQuatToThree(qw, qx, qy, qz));
      if (inst.airborneTilt) {
        inst.root.quaternion.multiply(inst.airborneTilt);
      }
      // DIM1-2 / W4.3 (2026-06-05): re-apply accumulated SetOmega spin after the
      // server-orientation copy() so a remote entity that BOTH spins (set_omega)
      // AND streams position updates keeps spinning — retail set_omega is a
      // persistent angular-velocity re-applied every tick (acclient.c:316613/
      // :317777). Mirrors the airborneTilt re-apply above; pre-multiply to match
      // `_tickHookOmega`'s world-space order. (anim-deep FIX-PLAN W4.3.)
      if (inst._omegaAccumQ) {
        inst.root.quaternion.premultiply(inst._omegaAccumQ);
      }
      // A2-P2: rotation snapped above as before; position stash/snap is the
      // wasm manager's while it owns this entity.
      if (wasmDriven) {
        return;
      }
      // Lazily allocate the per-entity target vector (reused in place — no
      // per-update allocation).
      let tgt = inst._serverTargetPos;
      if (!tgt) {
        tgt = inst._serverTargetPos = new THREE.Vector3();
      }
      // Teleport / landblock-transition detection: compare the NEW server pose
      // against the entity's CURRENT rendered position. A large jump (or a
      // first server update arriving far from the spawn pose) snaps so the rig
      // doesn't glide across the map; otherwise it eases.
      const cur = inst.root.position;
      const dx = x - cur.x;
      const dy = y - cur.y;
      const dz = z - cur.z;
      if (dx * dx + dy * dy + dz * dz > DEAD_RECKON_TELEPORT_SNAP_SQ) {
        // A4-Q3 (?mtQueue=on): a teleport-class snap is this remote
        // entity's exit/enter-world signal — cancel its one-shot
        // overlays (retail HandleExitWorld drain + enter-world link
        // removal, acclient.c:329940-329957). No-op flag-off.
        this._cancelOneShotOverlays(inst);
        // Snap: move both the rendered position AND the target so tick() has
        // nothing left to drag toward.
        cur.set(x, y, z);
      }
      tgt.set(x, y, z);
      return;
    }
    if (wasmDriven) {
      // A2-P2: rotation-only write (mirrors the deadReckon arm's quaternion
      // path); position belongs to the wasm manager.
      inst.root.quaternion.copy(acQuatToThree(qw, qx, qy, qz));
      if (inst.airborneTilt) inst.root.quaternion.multiply(inst.airborneTilt);
      if (inst._omegaAccumQ) inst.root.quaternion.premultiply(inst._omegaAccumQ);
      return;
    }
    inst.setPose(x, y, z, qw, qx, qy, qz);
  }

  /**
   * Wave R3.A — true when `guid` is the local player. Resolved via the same
   * `window.getLocalPlayerGuid()` global the rest of this file uses
   * (`getEquippedWeapon`, `getKnownSpells`, the spawn-diag at ~line 1356).
   * Returns false outside a browser (Node harness) or when no local player is
   * identified yet — so the smoothing path simply never excludes anyone, which
   * is safe (the Node harness has no live local player).
   */
  _isLocalPlayerGuid(guid) {
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) {
          return (lpg >>> 0) === (guid >>> 0);
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * Toggle the entity's render visibility. Called from the kind=17
   * EntityVisibilityChanged ClientEvent drain in index.html when the
   * wasm side detects that `Entity::should_draw()` flipped — driven
   * by `PhysicsState::HIDDEN`, `NO_DRAW`, or `CLOAKED` changes on a
   * `SetState` packet, or by an entity's initial spawn already in
   * one of those states. Mirrors the bits ACE checks at the
   * `PhysicsObj.cs` draw gates (17 references to `Hidden`, 11 to
   * `NoDraw`, 8 to `Cloaked` in `ACE.Server/Physics/`).
   *
   * THREE.js skips children of an invisible group automatically, so
   * toggling the root is sufficient — no per-part walk needed.
   * No-op when the entity isn't in `entityMap` yet (race with the
   * spawn pipeline; the spawn-time visibility event reaches JS after
   * the EntityInstance is built).
   */
  setVisibility(guid, visible) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst || !inst.root) {
      // F16-5 (2026-06-09): the rig isn't built yet — the wasm spawn-hidden
      // emit (kind=17 visible:false) lands before the async spawn completes.
      // A8-M4 (2026-06-12): under `?preCreateBuffer` (default ON) ALL
      // pre-create visibility events buffer in the generic FIFO — retail
      // parks every netblob for an unknown guid (QueueBlobForObject).
      // Appended (not last-write-wins): the FIFO replay at spawn applies them
      // in arrival order and setVisibility is synchronous, so the last one
      // wins anyway. `?preCreateBuffer=off` → dropped (legacy behaviour).
      if (this._preCreateBufferOn) {
        this._preCreate.enqueue(g, "visibility", { visible: !!visible });
      }
      return;
    }
    // Render-completeness audit (2026-05-29): a wielded child's own PVS
    // visibility is governed by its wielder (it's parented under the
    // wielder's part node, so three.js already hides it when the wielder
    // is hidden). Its own ObjectCreate often carries a NULL landblock once
    // equipped, which would otherwise drive a spurious visible=false here
    // and blank the in-hand weapon. Skip — the parent hierarchy decides.
    if (inst._attachedParentGuid != null) return;
    // FCULL (2026-06-08) — route through the composite so a concurrent
    // frustum/distance cull (`_renderCullHidden`) and this STATE-authoritative
    // visibility don't fight: the rendered flag is `stateVisible &&
    // !renderCullHidden`.
    _setEntityStateVisible(inst, !!visible);
    // PROJ-VIS: a projectile's NoDraw (ACE ProjectileImpact SetState) must also
    // put out its pool-fed light — the carrier keeps feeding the fixed pool even
    // under a hidden root, so a dark rig would otherwise still glow.
    if (inst._projectileLights) {
      this._setProjectileLightsOn(
        inst,
        !!visible && !inst._projectileImpacted && this._projectileLightingOn(guid),
      );
    }
  }

  /**
   * F17-5 (bughunt 2026-06-09) — float a fading speech / emote bubble over
   * the speaker. Driven by the wasm kind=55
   * `CLIENT_EVENT_KIND_OVERHEAD_SPEECH` event (HearSpeech /
   * HearRangedSpeech / EmoteText / SoulEmote), which now carries the
   * sender guid that was previously dropped at the wasm→JS boundary.
   * No-op when the speaker isn't a live 3D rig (speech is ephemeral — a
   * bubble over a not-rendered entity is pointless, so unlike
   * `setVisibility` there's no queue). Gated upstream by
   * `?speechBubbles=on` (the index.html kind=55 handler).
   *
   * @param {number} guid — speaker GUID.
   * @param {string} text — spoken words / emote text (no channel prefix).
   * @param {boolean} isEmote — emote (vs say) styling hint.
   */
  showSpeechBubble(guid, text, isEmote) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    showSpeechBubbleOnEntity(inst, text, !!isEmote);
  }

  /**
   * Render-completeness audit (2026-05-29) — attach a wielded child
   * (weapon/shield/bow) to its wielder, or detach it.
   *
   * AC sends the child its own ObjectCreate (so its rig exists in
   * `entityMap`) plus a `ParentEvent` linking it to the wielder at a
   * holding `location` (RightHand=1, LeftHand=2, Shield=3, …) with a grip
   * `placement`. We parent the child's `root` under the wielder's
   * `parts[partId]` Group at the holding-location frame from the wielder's
   * SetupModel. three.js then propagates the part's per-frame animation to
   * the child for free (no per-frame follow code).
   *
   * `parentGuid === 0` means DETACH (item unequipped to a pack — ACE will
   * usually ObjectDelete it right after; we hide + unparent defensively).
   *
   * Ordering-safe: if either rig isn't spawned yet the request is queued in
   * `_pendingAttach` and retried from `spawn()` via `_flushPendingAttach`.
   */
  /**
   * EQUIP-3 (2026-08-02) — park an attach request that cannot be satisfied
   * right now (a rig is missing, or vanished across `attachChildToParent`'s
   * holding-location await). Extracted from the entry-point guard so BOTH
   * "not built yet" and "torn down mid-resolve" take the identical route; the
   * post-await case used to just `return`, permanently losing the request.
   *
   * A8-M4 (2026-06-12): under `?preCreateBuffer=on` park in the generic
   * buffer instead, keyed by CHILD guid (the parent-side unblock is the
   * `_drainPreCreate` scan, mirroring `_flushPendingAttach`). `dedupeKind`
   * preserves the legacy Map's last-write-wins: two parked attaches would
   * race their async holding-location resolves on drain.
   */
  _parkAttach(childGuid, parentGuid, location, placement) {
    const cGuid = childGuid >>> 0;
    const req = {
      parentGuid: parentGuid >>> 0,
      location: location >>> 0,
      placement: placement >>> 0,
    };
    if (this._preCreateBufferOn) {
      this._preCreate.enqueue(cGuid, "attach", req, { dedupeKind: true });
      return;
    }
    this._pendingAttach.set(cGuid, req);
  }

  async attachChildToParent(childGuid, parentGuid, location, placement) {
    const cGuid = childGuid >>> 0;
    const pGuid = parentGuid >>> 0;
    if (pGuid === 0) {
      this._detachChild(cGuid);
      return;
    }
    const childInst = this.entityMap.get(cGuid);
    const parentInst = this.entityMap.get(pGuid);
    if (!childInst || !parentInst) {
      // One (or both) rigs not built yet — remember and retry on spawn.
      this._parkAttach(cGuid, pGuid, location, placement);
      return;
    }
    const setupId =
      (parentInst.meta?.setupId ?? parentInst.meta?.modelId ?? 0) >>> 0;
    let loc = null;
    try {
      loc = await this._resolveHoldingLocation(setupId, location >>> 0);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[attach] holding-location resolve failed:", e);
    }
    // FU-1 (2026-06-11): behind ?wieldHandAttach=on, when the kind=7
    // ParentEvent attach for ammo carries location=ParentLocation=0 (ACE
    // ammo weenies usually lack ParentLocation), `_resolveHoldingLocation`
    // missed and `loc` is null — the quarrel would mount at the wielder
    // ROOT origin (the feet). Retry the resolve with Quiver(5) then
    // RightHand(1) so the arrow/bolt lands in the quiver/hand frame.
    // Only for ammo children (EquipMask MISSILE_AMMO 0x00800000), looked
    // up from the wielder's wielded-items snapshot. Flag OFF = unchanged.
    if (this._wieldHandAttach && loc === null && (location >>> 0) === 0) {
      let childIsAmmo = false;
      try {
        const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
        if (handle && typeof handle.entityWieldedItems === "function") {
          const items = handle.entityWieldedItems(pGuid);
          if (Array.isArray(items)) {
            const entry = items.find((w) => (w?.guid >>> 0) === cGuid);
            if (entry && (((entry.equipMask >>> 0) & 0x00800000) !== 0)) {
              childIsAmmo = true;
            }
          }
        }
      } catch (_) {}
      if (childIsAmmo) {
        for (const altKey of [5, 1]) {
          try {
            const alt = await this._resolveHoldingLocation(setupId, altKey);
            if (alt) {
              loc = alt;
              break;
            }
          } catch (_) {}
        }
      }
    }
    // Re-check liveness after the await — either rig may have despawned.
    // EQUIP-3 (2026-08-02): RE-PARK instead of dropping. Pre-fix this bare
    // `return` silently consumed a server-authoritative attach whenever a rig
    // was torn down and rebuilt across the holding-location await (an
    // applyAppearance despawn+respawn of the wielder on the very ObjDescEvent
    // ACE broadcasts alongside the equip — Creature_Equipment.cs:365 — hits
    // this window every single time). Nothing re-issued it once the wielder's
    // retry ladder had retired, so the held item stayed unmounted for the rest
    // of the session (it renders at its pose-less spawn origin, i.e. tens of
    // km from the player = absent / a sub-pixel sliver). Retail rebuilds the
    // link from the child's own PhysicsDesc on EVERY CreateObject
    // (`unpack_physics_desc` acclient.c:322346 → `set_parent` :330260), so a
    // dropped request is never retail-faithful; parking makes the surviving
    // rig's next spawn commit (`_flushPendingAttach` / `_drainPreCreate`)
    // land it.
    const c = this.entityMap.get(cGuid);
    const p = this.entityMap.get(pGuid);
    if (!c || !c.root || !p || !p.root) {
      this._parkAttach(cGuid, pGuid, location, placement);
      return;
    }
    // Mount point: the wielder part the holding location names, else root.
    let mount = p.root;
    if (loc && p.parts && loc.partId >= 0 && loc.partId < p.parts.length) {
      mount = p.parts[loc.partId];
    }
    if (c.root.parent) c.root.parent.remove(c.root);
    mount.add(c.root);
    // Bug 14 diag: how long from the server's attach to the item on screen.
    try {
      const t0m = (typeof window !== "undefined") ? window.__heldAttachT0 : null;
      const t0 = t0m?.get?.(cGuid);
      if (typeof t0 === "number") {
        t0m.delete(cGuid);
        const now = (typeof performance !== "undefined") ? performance.now() : 0;
        // eslint-disable-next-line no-console
        console.info(`[held-attach] 0x${cGuid.toString(16)}→0x${pGuid.toString(16)} loc=${location} mounted ${Math.round(now - t0)} ms after the attach`);
      }
    } catch (_) { /* diag only */ }
    // EQUIP-3 (2026-08-02) — brand the mounted root so the two part-content
    // swap sites (`_applyAppearanceHotSwap` and the ReplaceObject anim hook)
    // can tell "a held item parented here" from "a surface Mesh I own". Both
    // used to clear `partGroup.children` wholesale, which silently ORPHANED
    // the wielded child (see `_isAttachedChildNode`).
    c.root.userData.__attachedChildOf = pGuid;
    if (loc) {
      c.root.position.set(loc.ox, loc.oy, loc.oz);
      c.root.quaternion.copy(acQuatToThree(loc.qw, loc.qx, loc.qy, loc.qz));
    } else {
      // No holding entry for this location key — best-effort mount at the
      // part origin so the weapon at least tracks the hand (tunable).
      c.root.position.set(0, 0, 0);
      c.root.quaternion.identity();
    }
    // The wielder root may carry obj_scale; the child inherits it through
    // the part node (a juvenile creature holds a proportionally-placed
    // weapon — matches retail). Keep the child's own scale untouched.
    // FCULL (2026-06-08) — set the STATE-visible baseline (true on attach);
    // while attached the child is excluded from the cull walk (it follows
    // the wielder's hierarchy visibility) so `_renderCullHidden` stays clear.
    _setEntityStateVisible(c, true);
    c._attachedParentGuid = pGuid;
    c._attachedPlacement = placement >>> 0;
    // Remembered so an appearance-change respawn of the WIELDER can
    // re-attach this child faithfully (applyAppearance re-attach loop).
    c._attachedLocation = location >>> 0;
    // HELD-ITEM (2026-08-02) — a pose stashed BEFORE the attach (the item's
    // own pre-equip ObjectCreate / KIND_POSITION) would keep the dead-reckon
    // ease in `tick` dragging this now-hand-local root toward a WORLD point,
    // walking the weapon out of the hand over the following seconds. Retail
    // never integrates a parented object at all (acclient.c:321671/:323099),
    // so drop the targets outright at mount time.
    if (WIELD_PERSIST_ON) {
      c._serverTargetPos = null;
      c._serverTargetQuat = null;
      c._headingEaseInit = false;
      c._wasmDriven = 0;
      c._stickyTarget = null;
      // Persistent re-attach ledger — survives `remove(childGuid)` so a
      // despawn+respawn of the ITEM (PVS churn, portal hop) re-establishes
      // the link, the way retail rebuilds it from the child's own
      // PhysicsDesc on every CreateObject (`unpack_physics_desc` :322346 ->
      // `set_parent` :330260). Cleared only by an explicit detach.
      this._lastAttach.delete(cGuid); // re-insert so Map order == recency
      this._lastAttach.set(cGuid, {
        parentGuid: pGuid,
        location: location >>> 0,
        placement: placement >>> 0,
      });
      // Long-session bound. An entry normally dies on `_detachChild` (unequip
      // / wielder despawn), but a child removed while its wielder survives is
      // unlinked from `_attachedChildren` first, so no later detach reaches
      // it. Map iteration is insertion order and we re-insert above, so this
      // is a plain LRU trim. 512 >> any plausible live wielded-child count.
      if (this._lastAttach.size > LAST_ATTACH_MAX) {
        const oldest = this._lastAttach.keys().next().value;
        if (oldest !== undefined) this._lastAttach.delete(oldest);
      }
    }
    if (!p._attachedChildren) p._attachedChildren = new Set();
    p._attachedChildren.add(cGuid);
    this._pendingAttach.delete(cGuid);
    // A8-M4 (2026-06-12): same stale-park cleanup for the generic buffer —
    // a direct mount (both rigs present) supersedes any earlier parked
    // attach for this child. No-op when the flag is off (buffer empty).
    this._preCreate.removeMatching((g, ev) => g === cGuid && ev.kind === "attach");
    // Keep the child subtree on the indoor render layer (matches spawn).
    try {
      c.root.traverse((o) => o.layers.set(1));
    } catch (_) {}
    // B5 (2026-06-09): second equip step — re-pose the child weapon's own
    // parts into the grip frame named by `placement`. Runs after the
    // holding-location mount above so it sets the child's per-part LOCAL
    // transforms (relative to the now-positioned child root). Re-applied
    // on every attach (incl. the ParentEvent attach-resync), so a
    // placement correction picks up automatically.
    const childSetupId = (c.meta?.setupId ?? c.meta?.modelId ?? 0) >>> 0;
    try {
      await this._applyChildPlacementFrames(cGuid, childSetupId, placement >>> 0);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[attach] placement-frame re-pose failed:", e);
    }
  }

  /**
   * Detach a previously-attached child: unparent back to entitiesGroup.
   * Wave C / PR8 (2026-06-06): no longer sets visibility=false. The prior
   * behavior was correct for the unequip-to-pack case (ACE ObjectDeletes
   * the item right after, and dispose() runs from the normal despawn
   * path), but it broke the drop-to-ground case — ACE follows up with a
   * new SetPosition + ObjectCreate that re-uses the same GUID and
   * expects the mesh to stay visible at the new world position. Letting
   * visibility default to true (matches the spawn-time state) is
   * correct for both flows: dispose() removes the entity entirely when
   * an ObjectDelete arrives, and SetPosition keeps the mesh visible at
   * the new position. Idempotent; safe for unknown / already-detached.
   */
  _detachChild(childGuid) {
    const cGuid = childGuid >>> 0;
    this._pendingAttach.delete(cGuid);
    // HELD-ITEM (2026-08-02) — an explicit detach is the ONLY thing that
    // forgets the re-attach ledger. `remove()` deliberately leaves it intact
    // so a despawn+respawn of the item re-mounts it (retail rebuilds the link
    // from the child's PhysicsDesc on every CreateObject).
    this._lastAttach.delete(cGuid);
    // A8-M4 (2026-06-12): cancel ONLY a parked attach for this child (a
    // parked visibility event must survive a detach). No-op when the flag
    // is off (buffer empty).
    this._preCreate.removeMatching((g, ev) => g === cGuid && ev.kind === "attach");
    const c = this.entityMap.get(cGuid);
    if (!c || !c.root) return;
    const parentGuid = c._attachedParentGuid;
    if (parentGuid != null) {
      const p = this.entityMap.get(parentGuid >>> 0);
      if (p && p._attachedChildren) p._attachedChildren.delete(cGuid);
    }
    if (c.root.parent) c.root.parent.remove(c.root);
    // EQUIP-3: clear the mount brand (see `attachChildToParent`).
    if (c.root.userData) delete c.root.userData.__attachedChildOf;
    if (this.scene3d?.entitiesGroup) this.scene3d.entitiesGroup.add(c.root);
    // visibility intentionally left at its current value (true) so ground-
    // drops render the item at its new position. ObjectDelete reaches the
    // normal despawn path that fully removes the entity.
    c._attachedParentGuid = null;
  }

  /**
   * Resolve (and cache) a wielder SetupModel's holding-location table, then
   * return the entry for `locationKey` ({partId, ox..oz, qw..qz}) or null.
   */
  async _resolveHoldingLocation(setupId, locationKey) {
    const sid = setupId >>> 0;
    if (sid === 0) return null;
    let table = this._holdingLocCache.get(sid);
    if (!table) {
      table = new Map();
      const fetchFn = this.wasmExports?.fetchSetupHoldingLocations;
      if (typeof fetchFn === "function") {
        const bundle = await fetchFn(sid);
        if (bundle) {
          const arr =
            typeof bundle.takeLocations === "function"
              ? bundle.takeLocations()
              : [];
          for (const e of arr) {
            table.set(e.locationKey >>> 0, {
              partId: e.partId | 0,
              ox: e.ox,
              oy: e.oy,
              oz: e.oz,
              qw: e.qw,
              qx: e.qx,
              qy: e.qy,
              qz: e.qz,
            });
            if (typeof e.free === "function") {
              try { e.free(); } catch (_) {}
            }
          }
          if (typeof bundle.free === "function") {
            try { bundle.free(); } catch (_) {}
          }
        }
      }
      this._holdingLocCache.set(sid, table);
    }
    return table.get(locationKey >>> 0) ?? null;
  }

  /**
   * B5 (2026-06-09): re-pose a held child's OWN parts into the combat
   * grip by applying its SetupModel `placement_frames[placement]` to each
   * `inst.parts[i]` Group — the second half of retail's two-step equip
   * (`set_parent` mounts the child at the hand; `SetPlacementFrame`
   * re-poses the child's parts). Without this the weapon renders in its
   * Default(0) spawn pose (a spear stands vertically instead of being
   * gripped). Fetched once per `(childSetupId, placement)` and cached.
   * `placement` is the server-authoritative grip key (PropertyInt
   * Placement, surfaced through the wielded-item snapshot / ParentEvent).
   * No-op when the child is a single-part GfxObj (no placement table) or
   * the wasm export is absent (old bundle) — matches prior behaviour.
   */
  async _applyChildPlacementFrames(childGuid, setupId, placement) {
    // `?childPlacement=off` — revert to the (broken) pre-2026-08-02 behaviour
    // where the grip re-pose never ran and the item kept the spawn bake's
    // Resting(101) pose. See `readChildPlacementFlag`.
    if (!CHILD_PLACEMENT_ON) return;
    const sid = setupId >>> 0;
    const cGuid = childGuid >>> 0;
    if (sid === 0) return;
    const key = `${sid}:${placement | 0}`;
    let frames = this._placementFrameCache.get(key);
    if (!frames) {
      frames = new Map();
      const fetchFn = this.wasmExports?.fetchSetupPlacementFrames;
      if (typeof fetchFn === "function") {
        const bundle = await fetchFn(sid, placement | 0);
        if (bundle) {
          const arr =
            typeof bundle.takeFrames === "function" ? bundle.takeFrames() : [];
          for (const f of arr) {
            frames.set(f.partIndex >>> 0, {
              ox: f.ox, oy: f.oy, oz: f.oz,
              qw: f.qw, qx: f.qx, qy: f.qy, qz: f.qz,
            });
            if (typeof f.free === "function") {
              try { f.free(); } catch (_) {}
            }
          }
          if (typeof bundle.free === "function") {
            try { bundle.free(); } catch (_) {}
          }
        }
      }
      this._placementFrameCache.set(key, frames);
    }
    if (frames.size === 0) return;
    // Re-check liveness after the await — the child may have despawned.
    const c = this.entityMap.get(cGuid);
    if (!c || !c.parts) return;
    for (let i = 0; i < c.parts.length; i += 1) {
      const fr = frames.get(i);
      const g = c.parts[i];
      if (!fr || !g) continue;
      g.position.set(fr.ox, fr.oy, fr.oz);
      // AC wire order (qw, qx, qy, qz) → three.js (qx, qy, qz, qw).
      g.quaternion.copy(acQuatToThree(fr.qw, fr.qx, fr.qy, fr.qz));
    }
  }

  /**
   * A8-M4 (2026-06-12, `?preCreateBuffer=on`) — spawn-commit drain of the
   * generic pre-create buffer for a just-built rig. Retail analog: object
   * creation replays the null-object placeholder's queued netblobs in
   * arrival order (CPhysicsObj::queue_netblob FIFO, fed by
   * CObjectMaint::QueueBlobForObject acclient.c:310848-310860). Two passes:
   *   1. events parked UNDER this guid, in arrival order — `attach` retries
   *      `attachChildToParent` (which re-parks if the counterpart is still
   *      missing, exactly like the legacy `_flushPendingAttach` retry),
   *      `visibility` re-routes through `setVisibility` so the same
   *      attached-child / render-cull composite guards apply (F16-5).
   *   2. parked attaches whose WIELDER is this guid — the parent-side
   *      unblock the legacy `_flushPendingAttach` covered with its map scan
   *      (a parked attach is keyed by CHILD guid, but either rig's spawn
   *      can be the unblocking one).
   * Unknown kinds are dropped with a one-shot warn (forward-compat: a
   * future enqueue site must add its replay arm here).
   */
  _drainPreCreate(guid) {
    const g = guid >>> 0;
    if (this._preCreate.size() === 0) return;
    for (const ev of this._preCreate.takeFor(g)) {
      if (ev.kind === "attach") {
        // Fire-and-forget (resolves holding frame async), like the legacy flush.
        this.attachChildToParent(g, ev.data.parentGuid, ev.data.location, ev.data.placement);
      } else if (ev.kind === "visibility") {
        this.setVisibility(g, ev.data.visible);
      } else if (!this._preCreateUnknownKindWarned) {
        this._preCreateUnknownKindWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[entities/A8-M4] unknown pre-create event kind dropped:", ev.kind);
      }
    }
    const asWielder = this._preCreate.takeMatching(
      (childGuid, ev) => ev.kind === "attach" && ev.data.parentGuid === g
    );
    for (const ev of asWielder) {
      this.attachChildToParent(ev.guid, ev.data.parentGuid, ev.data.location, ev.data.placement);
    }
  }

  /**
   * Retry queued attaches that involve `guid` (as child or as wielder),
   * now that its rig has been built. Called from `spawn()`.
   */
  /**
   * HELD-ITEM (2026-08-02, `?wieldPersist`) — durable re-attach replay, run
   * at every spawn commit (BOTH the `?preCreateBuffer` drain arm and the
   * legacy `_flushPendingAttach` arm — the two park queues only remember
   * requests that are still OUTSTANDING, and a re-created item has none).
   *
   * The hole this closes: loop.js's spawn hook nudges `_markWielderDirty` for
   * every spawned guid, which enumerates what that guid WIELDS. Nothing ever
   * asks "is this guid wielded BY someone?", so an item whose rig despawns and
   * respawns on its own (PVS churn across a portal hop, an ObjectDelete /
   * ObjectCreate pair reusing the guid) came back unparented and rendered at
   * its ObjectCreate world pose — the reported "my weapon is gone / on the
   * floor". Retail has no such hole: the child's own CreateObject carries its
   * parent + location in the PhysicsDesc, and `unpack_physics_desc` re-runs
   * `set_parent` every time (acclient.c:322346 / :330260).
   *
   * `hasParkedAttach` = a still-outstanding, server-authoritative attach
   * request for this guid; when set it supersedes the ledger and we do nothing
   * (the park drain is about to mount it with fresher args).
   */
  _replayLastAttach(guid, hasParkedAttach) {
    if (!WIELD_PERSIST_ON || this._lastAttach.size === 0) return;
    const g = guid >>> 0;
    if (!hasParkedAttach) {
      const last = this._lastAttach.get(g);
      if (last) {
        const inst = this.entityMap.get(g);
        const wielder = this.entityMap.get(last.parentGuid >>> 0);
        if (inst && inst._attachedParentGuid == null && wielder) {
          this.attachChildToParent(g, last.parentGuid, last.location, last.placement);
        }
      }
    }
    // …and the mirror case: this guid is the WIELDER coming back; re-mount
    // every remembered child that is live but currently unparented.
    for (const [childGuid, rec] of this._lastAttach) {
      if ((rec.parentGuid >>> 0) !== g) continue;
      const c = this.entityMap.get(childGuid >>> 0);
      if (c && c._attachedParentGuid == null) {
        this.attachChildToParent(childGuid, g, rec.location, rec.placement);
      }
    }
  }

  _flushPendingAttach(guid) {
    const g = guid >>> 0;
    if (this._pendingAttach.size === 0) return;
    // This entity might be the awaited CHILD…
    const asChild = this._pendingAttach.get(g);
    if (asChild) {
      this.attachChildToParent(
        g,
        asChild.parentGuid,
        asChild.location,
        asChild.placement
      );
    }
    // …or the awaited WIELDER of one or more queued children.
    for (const [childGuid, req] of this._pendingAttach) {
      if (req.parentGuid === g) {
        this.attachChildToParent(
          childGuid,
          req.parentGuid,
          req.location,
          req.placement
        );
      }
    }
  }

  /**
   * Phase D — lookup the entity GUID for a given display name. Case-
   * sensitive. Returns 0 (a never-used GUID since ACE GUIDs are 32-bit
   * and skip 0) when no match. Used by the recv-loop damageTaken /
   * evadedAttacker dispatch to play setSwingPose on the attacker's
   * rig.
   *
   * B4 (2026-05-18) — O(1) via the `_nameToGuid` index maintained on
   * spawn/remove. Names aren't unique (e.g. multiple "Drudge"), so the
   * index holds a Set<guid> per name; we return the first guid via
   * iterator (matches the previous "first match wins" semantics — the
   * old linear scan stopped at the first hit too). Iterator order is
   * insertion order, so the oldest still-alive entity with that name
   * wins, which is what the linear scan over an insertion-ordered Map
   * also did.
   */
  findGuidByName(name) {
    if (typeof name !== "string" || name.length === 0) return 0;
    const bucket = this._nameToGuid.get(name);
    if (!bucket || bucket.size === 0) return 0;
    // Set iteration is insertion-order — first value is the
    // oldest-still-alive guid with this name.
    const first = bucket.values().next().value;
    return (first >>> 0) || 0;
  }

  /**
   * Wave 1 Phase 3 (CMT fixes plan 2026-05-26): expose the equipped
   * primary weapon for an entity so the CombatManeuverTable lookup in
   * `scene3d/picking.js:441` can infer the AttackType from the wielded
   * item instead of hardcoding Slash.
   *
   * Returns a minimal weapon record consumed by
   * `ui/ac_attack_type_for_weapon.js#inferAttackTypeForWeapon`:
   * `{ guid, wcid, itemType, equipMask, name }` or `null` when the
   * entity is unarmed / unknown.
   *
   * ## Current data source (local player only)
   *
   * Equipped weapons live in the wasm-side `latest_inventory` snapshot
   * — see `apps/holtburger-web/src/lib.rs:13991 InventoryItem`. Each
   * inventory entry carries an `equipMask` bitfield; items with
   * `equipMask & (MELEE_WEAPON | MISSILE_WEAPON | TWO_HANDED | CASTER)`
   * are wielded. We pick the first such entry — there's at most one
   * primary weapon at a time per ACE's `wield_item` semantics
   * (`crates/holtburger-world/src/player/types.rs:471`).
   *
   * The snapshot is read via `window.__sessionHandle.playerInventory()`
   * (the global handle is exposed by `index.html` at the top of
   * `start_session`). EntityManager doesn't get the handle injected
   * at construction time, so the lookup goes through the global —
   * matches the existing `window.getLocalPlayerGuid()` pattern used
   * elsewhere in this file (see line ~837).
   *
   * ## Non-local entities (Wave 2 / Phase 5, 2026-05-26)
   *
   * For non-local GUIDs we consult the wasm `entityEquippedWeapon`
   * getter, which is populated by the recv loop's
   * `apply_inventory_object_create` whenever an `ObjectCreate` arrives
   * carrying a `WielderId` that is NOT the local player (see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`).
   * The wasm side maintains a `wielder_index: HashMap<u32, Vec<...>>`
   * keyed by wielder GUID; this accessor just unions the local +
   * remote channels into the same `{guid, wcid, itemType, equipMask,
   * name}` shape. Returns `null` when the wielder isn't in the index
   * (the entity hasn't been observed yet) OR when the entity is
   * currently unarmed.
   *
   * ## Wave 6 / Phase 15 (2026-05-26): `W_AttackType` now on the wire
   *
   * `PropertyInt::AttackType = 47` is surfaced on both the local
   * (`InventoryItem.attackType`) and non-local (`EquippedWeaponJs
   * .attackType`) wasm structs — see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`
   * and `publish_player_inventory_snapshot`. The returned record
   * now carries `attackType` so `inferAttackTypeForWeapon` can
   * prefer it over the equip-slot heuristic and resolve two-handed
   * spears to Thrust, swords to Thrust|Slash, etc. (closing the
   * Phase 13 documented limitation).
   *
   * ## Wave 8 / Phase 25 (2026-05-26): `MaximumVelocity` now on the wire
   *
   * `PropertyFloat::MaximumVelocity = 26` is surfaced on both the local
   * (`InventoryItem.maximumVelocity`) and non-local
   * (`EquippedWeaponJs.maximumVelocity`) wasm structs — see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create` and
   * `publish_player_inventory_snapshot`. The returned record now
   * carries `maximumVelocity` so `scene3d/picking.js`'s missile
   * branch can pass per-weapon projectile speed to
   * `getAimLevelForBallisticArc` (replacing Phase 19's hardcoded
   * 20 m/s default). Fallback `20.0` matches ACE
   * `Creature_Missile.cs:208 DefaultProjectileSpeed`.
   *
   * ## Wave 10 / Phase 29 (2026-05-26): `DamageMod` now on the wire
   *
   * `PropertyFloat::DamageMod = 63` is surfaced on both the local
   * (`InventoryItem.damageMod`) and non-local
   * (`EquippedWeaponJs.damageMod`) wasm structs — see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create` and
   * `publish_player_inventory_snapshot`. The returned record now
   * carries `damageMod` so `ui/ac_damage_rating.js`'s
   * `computeDamageRatingRollup` can compute the per-weapon `base`
   * contribution as `round((damageMod - 1.0) * 100)` (Yumi 1.5 →
   * `+50`; neutral 1.0 → `0`). Fallback `1.0` (neutral, no DR
   * contribution) matches ACE `BaseDamageMod.cs:52`'s
   * `weapon.GetProperty(PropertyFloat.DamageMod) ?? 1.0f`.
   *
   * @param {number} guid — entity GUID to query
   * @returns {{ guid: number, wcid: number, itemType: number,
   *             equipMask: number, attackType: number,
   *             maximumVelocity: number, damageMod: number,
   *             name: string } | null}
   */
  getEquippedWeapon(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return null;

    // Resolve the local player guid via the same global pattern the
    // rest of this file uses (`isLocalPlayer` at ~line 837).
    let localGuid = 0;
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) localGuid = (lpg >>> 0);
      }
    } catch (_) { /* never break callers */ }

    // CMT Wave 2 / Phase 5 (2026-05-26): non-local entities consult
    // the wasm-side wielder index via `entityEquippedWeapon(guid)`.
    // Returns `EquippedWeaponJs` (with the same shape this accessor
    // emits) or `undefined` when the entity isn't a wielder we've
    // observed. We map `undefined` → `null` to keep the contract
    // stable with the local path.
    if (g !== localGuid) {
      try {
        if (typeof window !== "undefined" && window.__sessionHandle
            && typeof window.__sessionHandle.entityEquippedWeapon === "function") {
          const w = window.__sessionHandle.entityEquippedWeapon(g);
          if (!w) return null;
          // wasm-bindgen returns a struct with getters; mirror it into
          // a plain object so the caller doesn't have to worry about
          // wasm-bindgen handle lifetimes (the struct here is cheap —
          // 6 fields, no per-call .free() responsibility).
          // CMT Wave 6 / Phase 15 (2026-05-26): `attackType` is
          // PropertyInt 47 (`W_AttackType`); `inferAttackTypeForWeapon`
          // prefers it over the EquipMask heuristic when non-zero.
          // CMT Wave 8 / Phase 25 (2026-05-26): `maximumVelocity` is
          // PropertyFloat 26 (m/s) — picking.js's missile branch passes
          // it to `getAimLevelForBallisticArc` for per-weapon gravity
          // arcs. `20.0` fallback mirrors ACE `Creature_Missile.cs:208
          // DefaultProjectileSpeed` and Phase 19's `BOW_DEFAULT_SPEED_MPS`.
          // CMT Wave 10 / Phase 29 (2026-05-26): `damageMod` is
          // PropertyFloat 63 — `ui/ac_damage_rating.js`'s
          // `computeDamageRatingRollup` reads it for the per-weapon
          // `base` contribution via `round((damageMod - 1.0) * 100)`.
          // `1.0` fallback (neutral, no DR contribution) mirrors ACE
          // `BaseDamageMod.cs:52` (`?? 1.0f`).
          const result = {
            guid:     (w.guid ?? 0) >>> 0,
            wcid:     (w.wcid ?? 0) >>> 0,
            itemType: (w.itemType ?? 0) >>> 0,
            equipMask: (w.equipMask ?? 0) >>> 0,
            attackType: (w.attackType ?? 0) >>> 0,
            maximumVelocity: Number.isFinite(w.maximumVelocity) ? w.maximumVelocity : 20.0,
            damageMod: Number.isFinite(w.damageMod) ? w.damageMod : 1.0,
            name:     typeof w.name === "string" ? w.name : "",
          };
          // wasm-bindgen-constructed structs need explicit .free()
          // unless we relinquish the borrow. We've copied the fields
          // above, so we can release the handle here.
          if (typeof w.free === "function") {
            try { w.free(); } catch (_) {}
          }
          return result;
        }
      } catch (_) { /* never break callers */ }
      return null;
    }

    // Pull the latest inventory snapshot. `window.__sessionHandle` is
    // the wasm-bound session handle; `playerInventory()` returns
    // `Array<InventoryItem>` (see `src/lib.rs:16160`). Each item's
    // `equipMask` is a u32 bitfield from
    // `holtburger_common::properties::EquipMask`.
    let inventory = null;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.playerInventory === "function") {
        inventory = window.__sessionHandle.playerInventory();
      }
    } catch (_) { /* never break callers */ }
    if (!Array.isArray(inventory) || inventory.length === 0) return null;

    // EquipMask bits that mark a "primary weapon" — what `picking.js`'s
    // melee branch cares about. Order of preference for multi-bit cases
    // is irrelevant because no item carries more than one of these.
    const PRIMARY_WEAPON_BITS =
        0x00100000 /* MELEE_WEAPON */
      | 0x00400000 /* MISSILE_WEAPON */
      | 0x01000000 /* CASTER */
      | 0x02000000 /* TWO_HANDED */;

    for (const item of inventory) {
      const mask = (item?.equipMask ?? 0) >>> 0;
      if ((mask & PRIMARY_WEAPON_BITS) === 0) continue;
      // First (and only) primary wielded weapon wins.
      // CMT Wave 6 / Phase 15 (2026-05-26): `attackType` is
      // PropertyInt 47 (`W_AttackType`), surfaced on the local-player
      // InventoryItem alongside the non-local EquippedWeaponJs path.
      // Drives `inferAttackTypeForWeapon`'s new wire-prefers-heuristic
      // precedence (closes Phase 13's two-handed limitation).
      // CMT Wave 8 / Phase 25 (2026-05-26): `maximumVelocity` is
      // PropertyFloat 26 (m/s) — picking.js's missile branch reads it
      // for the gravity-arc resolver. `20.0` fallback mirrors ACE
      // `Creature_Missile.cs:208 DefaultProjectileSpeed` and Phase 19's
      // `BOW_DEFAULT_SPEED_MPS`.
      // CMT Wave 10 / Phase 29 (2026-05-26): `damageMod` is PropertyFloat
      // 63 — `ui/ac_damage_rating.js`'s `computeDamageRatingRollup` reads
      // it for the per-weapon `base` contribution via
      // `round((damageMod - 1.0) * 100)`. `1.0` fallback (neutral, no
      // DR contribution) mirrors ACE `BaseDamageMod.cs:52` (`?? 1.0f`).
      return {
        guid:     (item.guid ?? 0) >>> 0,
        wcid:     (item.wcid ?? 0) >>> 0,
        itemType: (item.itemType ?? 0) >>> 0,
        equipMask: mask,
        attackType: (item.attackType ?? 0) >>> 0,
        maximumVelocity: Number.isFinite(item.maximumVelocity) ? item.maximumVelocity : 20.0,
        damageMod: Number.isFinite(item.damageMod) ? item.damageMod : 1.0,
        name:     typeof item.name === "string" ? item.name : "",
      };
    }
    // No primary weapon slot occupied — unarmed. Caller will see
    // `null` and infer Punch.
    return null;
  }

  /**
   * CMT Wave 8 / Phase 23 (2026-05-26): dual-wield detection for the
   * Phase 21 `inferAttackTypeForWeapon(weapon, opts)` call site in
   * `scene3d/picking.js` melee branch. Returns `true` iff the entity
   * has BOTH a primary weapon (MELEE_WEAPON / TWO_HANDED — the kinds
   * that the unarmed Kick logic in ACE's `Player_Melee.cs:462` cares
   * about) AND a non-shield item in the offhand slot.
   *
   * ## ACE's offhand model
   *
   * AC has NO distinct "OffhandWeapon" EquipMask bit. Verified against
   * `~/ace-server/Source/ACE.Entity/Enum/EquipMask.cs` and
   * `crates/holtburger-common/src/properties/inventory.rs:158-191` —
   * the EquipMask bitfield jumps from `MELEE_WEAPON = 0x00100000`
   * straight to `SHIELD = 0x00200000` then `MISSILE_WEAPON =
   * 0x00400000`, with no offhand-weapon slot in between.
   *
   * Instead, retail / ACE encodes dual-wielding by placing a non-shield
   * weapon in the `Shield` equip slot — see
   * `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Equipment.cs:133
   * GetDualWieldWeapon()`:
   *
   *     return EquippedObjects.Values.FirstOrDefault(
   *         e => !e.IsShield && e.CurrentWieldedLocation == EquipMask.Shield);
   *
   * The `!e.IsShield` clause is the discriminator: an item equipped in
   * the SHIELD slot that is itself not a shield = offhand weapon. We
   * approximate `IsShield` here with `equipMask == SHIELD` exactly
   * (shields carry only that bit; offhand weapons carry SHIELD plus
   * other context the wire doesn't always surface). The closest proxy
   * we have on the wire is `itemType` — `ItemType::MeleeWeapon = 1`
   * vs `ItemType::Armor = 2` (shield is Armor). If itemType is a
   * weapon-family type, treat the SHIELD-slot occupant as an offhand
   * weapon. Otherwise treat it as a real shield.
   *
   * ## Local player
   *
   * Walks `window.__sessionHandle.playerInventory()` (the wasm-bound
   * snapshot — see `src/lib.rs:16426 player_inventory`) looking for:
   *
   *   1. A primary weapon: `equipMask & (MELEE_WEAPON | TWO_HANDED)`
   *      non-zero. Two-handed is included because retail technically
   *      can't dual-wield with a two-hander, but the wire could carry
   *      a transient state during a swap; the helper's `isDualWield`
   *      clause only matters for unarmed Kick logic anyway and a
   *      two-hander already short-circuits the unarmed branch upstream.
   *   2. A SHIELD-slot non-shield item: `equipMask & SHIELD` non-zero
   *      AND `itemType !== ITEM_TYPE_ARMOR (2)`. Mirrors
   *      `Creature_Equipment.cs:135` `!e.IsShield`.
   *
   * Returns `true` iff BOTH are present.
   *
   * ## Non-local entities
   *
   * The wasm `wielder_index` accumulates every wielded item
   * ObjectCreate per wielder (primary + offhand shield-slot occupant
   * both land in the index). Phase 26 (Wave 9, 2026-05-26) added the
   * `entityWieldedItems(guid)` wasm getter which returns the FULL
   * list as `Vec<EquippedWeaponJs>` (distinct from the primary-only
   * `entityEquippedWeapon`). This accessor walks that list and applies
   * the same primary+SHIELD-slot-non-shield heuristic as the local
   * branch.
   *
   * ## Defensive contract
   *
   * Returns `false` whenever data isn't available (pre-login,
   * `playerInventory()` throws, snapshot empty). Never throws —
   * matches the `getEquippedWeapon` pattern.
   *
   * @param {number} guid — entity GUID to query
   * @returns {boolean}
   */
  isDualWield(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return false;

    // Resolve the local player guid via the same global pattern the
    // sibling `getEquippedWeapon` accessor uses (`getLocalPlayerGuid`
    // at ~line 837).
    let localGuid = 0;
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) localGuid = (lpg >>> 0);
      }
    } catch (_) { /* never break callers */ }

    // EquipMask bits — see ACE.Entity/Enum/EquipMask.cs +
    // crates/holtburger-common/src/properties/inventory.rs:158.
    // `MELEE_WEAPON | TWO_HANDED` mark the primary; `SHIELD` is the
    // offhand slot. Two-handed is included for completeness even
    // though dual-wielding a two-hander is invalid in retail — keeps
    // the predicate honest if the wire ever shows a transient state.
    const PRIMARY_BITS = 0x00100000 /* MELEE_WEAPON */ | 0x02000000 /* TWO_HANDED */;
    const SHIELD_BIT   = 0x00200000;
    // ItemType::Armor = 2 — shields are ItemType=Armor in AC. Anything
    // else in the SHIELD slot is an offhand weapon per ACE's
    // `Creature_Equipment.cs:135` `!e.IsShield` discriminator.
    const ITEM_TYPE_ARMOR = 2;

    // Non-local entities — Phase 26 (Wave 9, 2026-05-26). Pull the full
    // wielded-item list from the wielder index via the new
    // `entityWieldedItems(guid)` wasm getter (lib.rs). Iterate and apply
    // the same primary + SHIELD-slot-non-shield heuristic the local
    // branch uses below. Defensive: empty list / unavailable getter →
    // false.
    if (g !== localGuid) {
      let items = null;
      try {
        if (typeof window !== "undefined" && window.__sessionHandle
            && typeof window.__sessionHandle.entityWieldedItems === "function") {
          items = window.__sessionHandle.entityWieldedItems(g);
        }
      } catch (_) { /* never break callers */ }
      if (!Array.isArray(items) || items.length === 0) return false;

      let remoteHasPrimary = false;
      let remoteHasOffhandWeapon = false;
      for (const item of items) {
        const mask = (item?.equipMask ?? 0) >>> 0;
        if ((mask & PRIMARY_BITS) !== 0) {
          remoteHasPrimary = true;
        }
        if ((mask & SHIELD_BIT) !== 0) {
          const itemType = (item?.itemType ?? 0) >>> 0;
          if (itemType !== ITEM_TYPE_ARMOR) {
            remoteHasOffhandWeapon = true;
          }
        }
        if (remoteHasPrimary && remoteHasOffhandWeapon) return true;
      }
      return remoteHasPrimary && remoteHasOffhandWeapon;
    }

    // Local player path. Pull the latest inventory snapshot from the
    // wasm-bound session handle. Returns `Vec<InventoryItem>` —
    // `src/lib.rs:16426 player_inventory`. Each item carries a u32
    // `equipMask` from `holtburger_common::properties::EquipMask`.
    let inventory = null;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.playerInventory === "function") {
        inventory = window.__sessionHandle.playerInventory();
      }
    } catch (_) { /* never break callers */ }
    if (!Array.isArray(inventory) || inventory.length === 0) return false;

    let hasPrimary = false;
    let hasOffhandWeapon = false;
    for (const item of inventory) {
      const mask = (item?.equipMask ?? 0) >>> 0;
      if ((mask & PRIMARY_BITS) !== 0) {
        hasPrimary = true;
      }
      if ((mask & SHIELD_BIT) !== 0) {
        const itemType = (item?.itemType ?? 0) >>> 0;
        if (itemType !== ITEM_TYPE_ARMOR) {
          hasOffhandWeapon = true;
        }
      }
      if (hasPrimary && hasOffhandWeapon) return true;
    }
    return hasPrimary && hasOffhandWeapon;
  }

  /**
   * CMT Wave 10 / Phase 30 (2026-05-26): is this entity a projectile in
   * flight?
   *
   * Bridges to the wasm-side `entityIsProjectile(guid)` getter populated
   * by the recv loop's `apply_inventory_object_create` arm whenever an
   * `ObjectCreate` arrives with `PhysicsState::MISSILE` (`0x40`) set.
   * That bit is the canonical wire-level distinguisher for "projectile in
   * flight" because ACE sets it on BOTH projectile spawn paths:
   *
   *   1. War / void / life magic projectiles — `SpellProjectile.Setup()`
   *      at `ace-server/Source/ACE.Server/WorldObjects/SpellProjectile.cs:77`
   *      (`Missile = true`). These carry `WeenieType.ProjectileSpell = 33`
   *      in the LSD weenie table (see WCIDs 2619 "Missile", 7264 "Force
   *      Bolt", 33527 "Lightning Bolt"). Spawned by ACE per cast via
   *      `WorldObjectFactory.cs:103-104`.
   *   2. Bow / crossbow / atlatl / thrown-weapon projectiles —
   *      `Creature_Missile.SetProjectilePhysicsState()` at
   *      `ace-server/Source/ACE.Server/WorldObjects/Creature_Missile.cs:357`
   *      (`obj.Missile = true`). These carry `WeenieType.Missile = 4` in
   *      the LSD weenie table (see WCIDs 27876 "Muck Ball", 29964
   *      "Throwing Axe", 34585 "Stone Hatchet"). Spawned by ACE per
   *      missile attack via `LaunchProjectile` at
   *      `Creature_Missile.cs:104`.
   *
   * Returns `false` when:
   *   - `guid` is 0 / unparseable,
   *   - the wasm getter is unavailable (pre-session, mid-rebuild),
   *   - the entity has never been seen (no ObjectCreate arrived yet),
   *   - the entity exists but is not a projectile (everything else).
   *
   * Wave 10 territory: classification only. Wave 11 will add the actual
   * launch-trail / impact-explode VFX hooks that consume this — see
   * `docs/cmt-fixes-plan-2026-05-26.md` §"Phase 30 — Projectile entity
   * classification".
   *
   * @param {number} guid — entity GUID to query
   * @returns {boolean}
   */
  isProjectile(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return false;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.entityIsProjectile === "function") {
        return !!window.__sessionHandle.entityIsProjectile(g);
      }
    } catch (_) { /* never break callers */ }
    return false;
  }

  /**
   * G-4 / F3-1 follow-on (2026-06-11): `true` when the projectile's
   * ObjectCreate carried PhysicsState::GRAVITY in addition to MISSILE
   * (arrows/bolts/thrown — the arced class). Mirrors isProjectile's
   * access shape; soft-guarded so a pkg/ predating the wasm manifest-v2
   * `entityProjectileHasGravity` export degrades to `false` (flat flight).
   *
   * @param {number} guid — entity GUID to query
   * @returns {boolean}
   */
  projectileAlignsPath(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return false;
    try {
      const h = typeof window !== "undefined" ? window.__sessionHandle : null;
      if (h && typeof h.entityProjectileAlignsPath === "function") {
        return !!h.entityProjectileAlignsPath(g);
      }
    } catch (_) { /* never break callers */ }
    return false;
  }

  /**
   * PROJ-SPIN (2026-10-05): the missile's ObjectCreate PhysicsDesc omega as
   * `{x, y, z}` (rad/s, AC world frame), or `null` when it does not spin or
   * the pkg/ predates the `entityProjectileOmega` export.
   *
   * @param {number} guid — entity GUID to query
   * @returns {{x:number,y:number,z:number}|null}
   */
  projectileOmega(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return null;
    try {
      const h = typeof window !== "undefined" ? window.__sessionHandle : null;
      if (h && typeof h.entityProjectileOmega === "function") {
        const o = h.entityProjectileOmega(g);
        if (o && o.length >= 3) {
          const x = +o[0], y = +o[1], z = +o[2];
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
              && x * x + y * y + z * z > 0) {
            return { x, y, z };
          }
        }
      }
    } catch (_) { /* never break callers */ }
    return null;
  }

  projectileHasGravity(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return false;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.entityProjectileHasGravity === "function") {
        return !!window.__sessionHandle.entityProjectileHasGravity(g);
      }
    } catch (_) { /* never break callers */ }
    return false;
  }

  /**
   * CMT Wave 16 / Phase 50 (2026-05-26): per-entity `PhysicsScriptTable`
   * (DAT 0x34) DID accessor.
   *
   * Returns the entity's cached `physicsScriptTableDid` — the DID the
   * Wave 17 `GameMessageScript` handler will use to look up the
   * concrete `PhysicsScript` (0x33) corresponding to a `PScriptType`
   * enum value the server broadcasts on opcode 0xF755.
   *
   * The wasm side caches this on every `ObjectCreate` (initial value
   * from `PhysicsDesc.PhsTableID` > `Setup.default_phstable_id`,
   * mirroring retail `acclient.c:320886-320900` Setup init and
   * `acclient.c:322321-322331` PhysicsDesc override) and refreshes it
   * on `UpdateObject` for runtime swaps (e.g. equip/unequip via
   * `Creature.CalculateObjDesc`). See
   * `external/holtburger/docs/physicsscript-bridge-research-2026-05-26.md`
   * §1+§5 for the full chain.
   *
   * Returns `0` when:
   *   - `guid` is 0 / unparseable,
   *   - the wasm getter is unavailable (pre-session, mid-rebuild),
   *   - the entity has never been seen (no ObjectCreate arrived yet),
   *   - the entity exists but carries neither a PhysicsDesc override
   *     nor a Setup `default_phstable_id` — i.e. it has no
   *     PhysicsScriptTable. Wave 17's consumer should no-op for these
   *     (matches retail's `CPhysicsObj::play_script` early-out when
   *     `physics_script_table` is null at acclient.c:320335-320343).
   *
   * Mirrors the access shape of `getEquippedWeapon`, `getStance`,
   * `isProjectile` — single wasm getter, returns a u32 number.
   *
   * @param {number} guid — entity GUID to query
   * @returns {number} u32 PhysicsScriptTable DID (0x34xxxxxx), or 0 if none
   */
  getPhysicsScriptTableDid(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return 0;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.entityPhysicsScriptTableDid === "function") {
        return (window.__sessionHandle.entityPhysicsScriptTableDid(g) >>> 0);
      }
    } catch (_) { /* never break callers */ }
    return 0;
  }

  /**
   * A11-S5 / G14 (2026-06-12): retail `play_default_script` resolution —
   * `PhysicsScriptTable::GetScript(default_script, default_script_intensity)`
   * (acclient.c:320351-320376; picker :336552). Reads the RAW PhysicsDesc
   * `default_script` off the new session-handle getters (typeof-guarded —
   * a pre-rebuild pkg/ returns 0 and this soft-degrades to a no-op):
   *   - 0                    → 0 (no default script),
   *   - 0x33xxxxxx           → returned as-is (a raw PhysicsScript DID;
   *                            the existing `physicsScriptDid` spawn path
   *                            already covers this case — callers gate on
   *                            it being absent),
   *   - anything else        → PScriptType ENUM: resolve via the entity's
   *                            PhysicsScriptTable (Phase 49 facade) +
   *                            `pickScriptEntry(entries, intensity)`
   *                            (Phase 51/53 picker, acclient.c:336552).
   * No table / no row → 0, matching retail's `play_script` null-table
   * no-op (acclient.c:320335-320343). Never throws.
   *
   * @param {number} guid
   * @returns {Promise<number>} resolved 0x33 PhysicsScript DID, or 0.
   */
  async _resolveDefaultScriptDid(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return 0;
    let raw = 0;
    let intensity = 0;
    try {
      const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
      if (!sh || typeof sh.entityDefaultScript !== "function") return 0;
      raw = sh.entityDefaultScript(g) >>> 0;
      if (raw === 0) return 0;
      if ((raw >>> 24) === 0x33) return raw;
      intensity = (typeof sh.entityDefaultScriptIntensity === "function")
        ? +sh.entityDefaultScriptIntensity(g) || 0
        : 0;
    } catch (_) { return 0; }
    const tableDid = this.getPhysicsScriptTableDid(g);
    if (tableDid === 0) return 0;
    try {
      const table = await fetchPhysicsScriptTable(tableDid);
      const entries = table?.scripts?.[String(raw)];
      if (!Array.isArray(entries) || entries.length === 0) return 0;
      // Lazy import — play_effect_vfx.js is a self-binding side-effect
      // module index.html loads on its own schedule; only pull the pure
      // picker when the flag-on resolver actually runs.
      const { pickScriptEntry } = await import("./play_effect_vfx.js");
      const picked = pickScriptEntry(entries, intensity);
      return (picked?.scriptDid >>> 0) || 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * A11-S5: fire-and-forget arm shared by the spawn path and the
   * DefaultScript(17)/DefaultScriptPart(18) hook fallbacks — resolve the
   * PScriptType default script and play it through the normal chain
   * (`_attachParticleChainForEntity` → `?scriptQueue=on` ⇒ the A11-S1
   * `ScriptManager.addScript` queue; legacy walker otherwise). Drops the
   * play if the entity despawned during the async resolve.
   */
  _playDefaultScriptResolved(guid, rig, defaultPartIndex = -1) {
    const g = guid >>> 0;
    this._resolveDefaultScriptDid(g)
      .then((did) => {
        if (did === 0) return;
        if (!this.entityMap.has(g)) return; // despawned mid-resolve
        this._attachParticleChainForEntity(g, rig, did, 0, defaultPartIndex)
          .catch(() => {});
      })
      .catch(() => {});
  }

  /**
   * Track B7 (2026-06-08): best-effort spawn-time prewarm for an entity
   * that carries a PhysicsScriptTable (DAT 0x34). Called fire-and-forget
   * from `_spawnImpl` so the first object-triggered PlayEffect cue on
   * this entity resolves WARM instead of paying the cold async chain in
   * `play_effect_vfx.js::_tryResolveRealVfx` (table → script → emitter
   * fetches + lazy ParticleManager build) that made the effect land 5+s
   * late.
   *
   * What it warms:
   *   1. The world `ParticleManager` (so the PlayEffect resolver's
   *      `em._worldParticleManager != null` fast-path is satisfied and it
   *      doesn't bail to the placeholder for lack of a manager).
   *   2. The PhysicsScriptTable JSON (Phase 49 cached facade).
   *   3. A bounded set of the table's PhysicsScripts (0x33) and their
   *      CreateParticle ParticleEmitters (0x32) — the DAT records the
   *      resolver will need. Bounded so a table with many PScriptTypes
   *      doesn't fan out into a huge prefetch storm on every spawn.
   *
   * Never throws — every fetch is individually guarded; the caller
   * attaches a `.catch(() => {})` for belt-and-braces.
   *
   * @param {number} tableDid — 0x34xxxxxx PhysicsScriptTable DID (nonzero)
   * @param {THREE.Object3D} rig — the entity rig, for ParticleManager wiring
   * @returns {Promise<void>}
   */
  async _prewarmPhysicsScriptTable(tableDid, rig) {
    const td = (tableDid >>> 0);
    if (td === 0) return;
    // Perf (2026-06-27): on the FIRST PhysicsScriptTable prewarm of the
    // session, also kick off a one-time background warm of the SHARED cast/
    // effect PhysicsScripts (Launch/Explode/cast-glyphs — the canonical
    // PlayScript→PhysicsScript map, refCount up to 101 across tables) so the
    // first war/void cast resolves to real VFX warm instead of paying the cold
    // fetchPhysicsScript + per-hook fetchParticleEmitter chain ON the cast
    // frame. That cold chain is the >0.5 s stall that trips the dt-recovery
    // window (index.js:1763-1776) into freezing the sim — which (pre the
    // _tickBallisticProjectiles fix) also froze the spell projectile mid-flight.
    // Chunked + fire-and-forget so the warm itself never stalls a frame.
    if (!this._canonicalCastPrewarmStarted) {
      this._canonicalCastPrewarmStarted = true;
      this._prewarmCanonicalCastScripts().catch(() => {});
    }
    // Dedup: only prewarm a given table DID once per session. The DAT
    // caches make repeat fetches cheap, but skipping the walk entirely
    // avoids redundant parse cost when many entities share a table.
    if (this._prewarmedScriptTables.has(td)) return;
    this._prewarmedScriptTables.add(td);

    // 1. Warm the world ParticleManager (idempotent — returns the
    //    existing one when already built).
    try { await this._ensureWorldParticleManager(rig); } catch (_) {}

    // 2. Warm the table JSON via the cached facade.
    let table;
    try { table = await fetchPhysicsScriptTable(td); } catch (_) { table = null; }
    if (!table || !table.scripts || typeof table.scripts !== "object") return;

    const wasm = this.wasmExports;
    if (!wasm || typeof wasm.fetchPhysicsScript !== "function") return;

    // 3. Prefetch a bounded set of the resolvable scripts + their
    //    CreateParticle emitters. Collect unique scriptDids first (the
    //    same DID can appear under multiple PScriptTypes), then cap.
    const PREWARM_SCRIPT_CAP = 16;
    const scriptDids = new Set();
    for (const key of Object.keys(table.scripts)) {
      const entries = table.scripts[key];
      if (!Array.isArray(entries)) continue;
      for (const ent of entries) {
        const did = (ent?.scriptDid >>> 0);
        if (did !== 0) scriptDids.add(did);
        if (scriptDids.size >= PREWARM_SCRIPT_CAP) break;
      }
      if (scriptDids.size >= PREWARM_SCRIPT_CAP) break;
    }

    const canFetchEmitter = (typeof wasm.fetchParticleEmitter === "function");
    for (const scriptDid of scriptDids) {
      let ps;
      try { ps = await wasm.fetchPhysicsScript(scriptDid); } catch (_) { continue; }
      if (!ps || typeof ps.takeEntries !== "function" || !canFetchEmitter) continue;
      let entriesJs;
      try { entriesJs = ps.takeEntries(); } catch (_) { continue; }
      if (!Array.isArray(entriesJs)) continue;
      for (const e of entriesJs) {
        if (e.hookType !== 13 && e.hookType !== 26) continue;
        const emitterDid = (e.createParticleEmitterId >>> 0);
        if (emitterDid === 0) continue;
        try { await wasm.fetchParticleEmitter(emitterDid); } catch (_) { /* warm-only */ }
      }
    }
  }

  /**
   * Perf (2026-06-27) — one-time background warm of the SHARED cast/effect
   * PhysicsScripts. `_prewarmPhysicsScriptTable` only warms the scripts of an
   * already-spawned entity's table; the cast-VFX scripts (Launch 0x33000E62,
   * Explode 0x3300011E, the cast glyphs, etc.) are referenced by the canonical
   * PlayScript map and may be cold until the matching entity happens to spawn.
   * Warming them up front means the player's first war/void cast resolves to
   * real emitters without the cold fetchPhysicsScript + fetchParticleEmitter
   * chain landing on the cast frame (the >0.5 s hitch). DAT-cache warm only
   * (no geometry/material build, no manager mutation) → zero visual/behaviour
   * change. Chunked under a tiny per-slice time budget with a yield between
   * slices so the warm never itself causes a stall. Fired once per session.
   * @private
   */
  async _prewarmCanonicalCastScripts() {
    const wasm = this.wasmExports;
    if (!wasm || typeof wasm.fetchPhysicsScript !== "function") return;
    const canFetchEmitter = typeof wasm.fetchParticleEmitter === "function";
    // Load the canonical PlayScript→PhysicsScript map (generated data file).
    let canon;
    try {
      const url = new URL(
        "../data/playscript-canonical-physics-scripts.json",
        import.meta.url,
      );
      const resp = await fetch(url);
      canon = (await resp.json())?.canonical;
    } catch (_) {
      return; // data file absent / unreadable → silently skip (warm is opt-in perf)
    }
    if (!canon || typeof canon !== "object") return;
    // Unique 0x33 PhysicsScript DIDs from the map, skipping any already warmed
    // by an entity-table prewarm (the DAT cache makes a repeat fetch cheap, but
    // skipping avoids redundant parse work).
    const dids = [];
    const seen = this._prewarmedCanonicalScripts || (this._prewarmedCanonicalScripts = new Set());
    for (const k of Object.keys(canon)) {
      const did = (parseInt(canon[k] && canon[k].scriptDid, 16) || 0) >>> 0;
      if (did && !seen.has(did)) { seen.add(did); dids.push(did); }
    }
    if (dids.length === 0) return;
    const yieldOnce = () =>
      new Promise((r) =>
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(() => r(), { timeout: 250 })
          : setTimeout(r, 16),
      );
    // PREWARM-WIDTH (2026-08-04) — the original driver was a `do…while` whose
    // exit test is a 3 ms CPU budget (`performance.now() < budgetEnd`), written
    // when the per-script cost was a synchronous wasm DAT parse. It is not any
    // more: every iteration now `await`s a NETWORK fetch, and on a 150 ms-RTT
    // tunnel the very first await blows a 3 ms budget, so the `do…while` ran
    // EXACTLY ONE script per slice and then paid `yieldOnce()` — a
    // `requestIdleCallback(timeout: 250)`. Effective rate: one script per
    // (RTT + up to 250 ms), i.e. ~0.4 s each, so a canonical set of several
    // dozen scripts took tens of seconds to warm and was still cold when the
    // player actually cast. That is the "prewarm exists but the first cast is
    // still cold" gap.
    //
    // Fix: keep the yield-between-slices shape (it is what keeps the wasm
    // PARSES from accumulating into one frame stall — still a real concern),
    // but make each slice a BOUNDED PARALLEL WAVE so the RTTs overlap instead
    // of stacking. Per slice: one wave for the scripts, then one wave for every
    // emitter DID discovered across the whole slice. Cost per slice is ~2 RTT
    // regardless of width, so the whole canonical set warms in
    // ceil(N/WIDTH) × (2·RTT + idle) instead of N × (RTT + idle).
    //
    // STAYS ON THE NORMAL LANE ON PURPOSE — no `urgent` argument here. This is
    // speculative background work; letting it bypass the fetch semaphore would
    // put it in direct contention with the player's actual in-flight cast,
    // which is the exact starvation the urgent lane exists to prevent.
    const PREWARM_FETCH_WIDTH = 8;
    let i = 0;
    while (i < dids.length) {
      const slice = dids.slice(i, i + PREWARM_FETCH_WIDTH);
      i += slice.length;
      const scripts = await Promise.all(
        slice.map((did) =>
          Promise.resolve(wasm.fetchPhysicsScript(did)).catch(() => null)),
      );
      if (canFetchEmitter) {
        // Collect this slice's emitter DIDs, then fire them as ONE wave.
        // Deduped: unlike the cast path these handles are discarded (warm-only,
        // the DAT/shard cache is the product), so sharing a resolution is free.
        const emitterDids = new Set();
        for (const ps of scripts) {
          if (!ps || typeof ps.takeEntries !== "function") continue;
          let entries;
          try { entries = ps.takeEntries(); } catch (_) { continue; }
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            if (e.hookType !== 13 && e.hookType !== 26) continue;
            const emitterDid = (e.createParticleEmitterId >>> 0);
            if (emitterDid !== 0) emitterDids.add(emitterDid);
          }
        }
        if (emitterDids.size > 0) {
          await Promise.all(
            [...emitterDids].map((d) =>
              Promise.resolve(wasm.fetchParticleEmitter(d)).catch(() => null)),
          );
        }
      }
      if (i < dids.length) await yieldOnce();
    }
  }

  /**
   * CMT Wave 2 / Phase 5 (2026-05-26): per-entity MotionStance accessor.
   *
   * Returns the entity's last-observed `MotionStance` (one of
   * `holtburger_common::motion::MotionStance` — HandCombat,
   * SwordCombat, BowCombat, MagicCombat, NonCombat, etc.). The value
   * is stamped on every kind=5 `UpdateMotion` from ACE — see
   * `setMotion(...)` at the top of this file where both
   * `inst.lastStance` and `inst.currentStance` are written. Returns
   * `0` for entities that have never received an UpdateMotion (the
   * spawn meta's `motionStance` is also checked as a fallback).
   *
   * Used by the `damageTaken` / `evadedAttacker` handlers in
   * `index.html` (~line 8612) to drive the CMT lookup for remote-
   * player swings.
   *
   * @param {number} guid — entity GUID to query
   * @returns {number} u32 MotionStance, or 0 if unknown
   */
  getStance(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return 0;
    const inst = this.entityMap.get(g);
    if (!inst) return 0;
    // Prefer currentStance (resolved with stance=0 fallback inside
    // setMotion); fall back to lastStance and then the spawn meta.
    const s = (inst.currentStance ?? inst.lastStance ?? inst.meta?.motionStance ?? 0) >>> 0;
    return s;
  }

  /**
   * Phase D — persistent selection indicator on the currently targeted
   * entity. A flat ring is parented under the entity's root so it
   * follows position/rotation automatically and is GC'd when the
   * entity is removed from the scene. `guid = 0` (or any unknown
   * GUID) clears the indicator.
   */
  getSelectedTarget() {
    return (this._selectedGuid ?? 0) >>> 0;
  }

  setSelectedTarget(guid) {
    const next = (guid >>> 0) || 0;
    // Tear down the previous selection ring even if it's on the same
    // entity — keeps the path idempotent.
    if (this._selectedGuid && this._selectedGuid !== next) {
      const prev = this.entityMap.get(this._selectedGuid);
      if (prev?._selectionRing) {
        prev.root.remove(prev._selectionRing);
        prev._selectionRing.geometry.dispose();
        prev._selectionRing.material.dispose();
        prev._selectionRing = null;
      }
    }
    this._selectedGuid = next;
    // === RETAIL TARGET INDICATOR (2026-08-02, `?selectionIndicator`) ======
    // Retail draws nothing in the 3D scene for a selected target — it runs a
    // 2D UI overlay (`VividTargetIndicator`, acclient.c:289744) fed by the
    // screen-space bbox of the object's SELECTION SPHERE, recomputed every
    // frame in `SmartBox::RenderNormalMode` (:144918-:144930). Hand the
    // overlay the rig + its sphere; `scene3d/selection_brackets.js` does the
    // projection and the four corner brackets. The legacy torus below only
    // builds under `?selectionIndicator=ring|both`.
    const _selLayer = this.scene3d?.selectionBracketLayer ?? null;
    if (next === 0) {
      _selLayer?.setTarget(0, null, null);
      return;
    }
    const inst = this.entityMap.get(next);
    if (!inst || !inst.root) {
      this._selectedGuid = 0;
      _selLayer?.setTarget(0, null, null);
      return;
    }
    if (_selLayer) {
      try {
        // FU-2 (2026-08-02) — bracket colour. Retail tints the four corners
        // with the radar blip colour (`VividTargetIndicator::SetSelected`
        // acclient.c:289443 → `gmRadarUI::GetBlipColor` :262708); see
        // selection_brackets.js `blipColorForEntity` for the full branch
        // transcription. `?bracketBlipColor=off` pins the legacy red.
        //
        // 2026-08-02 — feed the server-sent `_blipColor` byte
        // (`PublicWeenieDesc::_blipColor`, PropertyInt::RadarBlipColor 95).
        // Retail tests it FIRST and SHORT-CIRCUITS the whole type/relationship
        // ladder on a non-zero value (`gmRadarUI::GetBlipColor` acclient.c:262708,
        // switch at :262726) — that is what makes a lifestone BLUE and an NPC
        // YELLOW rather than the type ladder's default gold.
        //
        // Read lazily HERE rather than in `toMeta`: the value is only needed
        // for the one selected entity, the wasm lookup is an O(1) HashMap hit,
        // and doing it at selection time keeps the per-frame meta hot path and
        // loop.js untouched. Cached onto `meta` so a re-select is free.
        // typeof-guarded: a stale `pkg/` (no `entityRadarBlipColor` export)
        // leaves it 0, which is exactly retail's "use the type ladder"
        // sentinel — so the pre-existing colours survive a wasm skew.
        if (inst.meta && inst.meta.radarBlipColor === undefined) {
          let _bc = 0;
          try {
            const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
            if (sh && typeof sh.entityRadarBlipColor === "function") {
              _bc = sh.entityRadarBlipColor(next >>> 0) >>> 0;
            }
          } catch (_) { _bc = 0; }
          inst.meta.radarBlipColor = _bc;
        }
        _selLayer.setColor(blipColorForEntity(inst, readFellowshipRoster()));
        // FU-2 — bracket BOUNDS. Prefer the real `CSetup.selection_sphere`
        // (CPartArray::GetSelectionSphere acclient.c:326293); the Box3
        // heuristic is only the fallback for setups that have none. The wasm
        // fetch is async, so seed with the heuristic and upgrade in place.
        const setupId =
          (inst.meta?.setupId ?? inst.meta?.modelId ?? 0) >>> 0;
        const cached = peekDatSelectionSphere(setupId);
        const datNow = cached ? datSelectionSphereFor(cached, inst.root) : null;
        if (datNow) {
          selectionSphereStats.dat++;
          selectionSphereStats.lastPath = "dat";
          _selLayer.setTarget(next, inst.root, datNow);
        } else {
          selectionSphereStats.heuristic++;
          selectionSphereStats.lastPath = "heuristic";
          _selLayer.setTarget(next, inst.root, computeSelectionSphere(inst.root));
          if (cached === undefined) {
            // Not fetched yet — kick it and swap the sphere in when it lands,
            // but only if this guid is still the selection.
            loadDatSelectionSphere(
              this.wasmExports?.fetchSetupSelectionSphere, setupId,
            ).then((rec) => {
              if ((this._selectedGuid >>> 0) !== next) return;
              const live = this.entityMap.get(next);
              if (!live || !live.root) return;
              const up = datSelectionSphereFor(rec, live.root);
              if (!up) return;
              selectionSphereStats.upgrades++;
              selectionSphereStats.dat++;
              selectionSphereStats.heuristic--;
              selectionSphereStats.lastPath = "dat";
              try { _selLayer.setTarget(next, live.root, up); } catch (_) {}
            }).catch(() => {});
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[selection] bracket layer setTarget threw:", e);
      }
    }
    if (SELECTION_INDICATOR_MODE !== "ring" && SELECTION_INDICATOR_MODE !== "both") {
      return; // brackets-only (default) / none → no torus
    }
    if (inst._selectionRing) return; // already ringed
    // 0.6m flat torus at the entity's feet, tilted so the ring lies
    // in the local XY (AC ground) plane. Bright red, slight emissive
    // hint so it reads even in shadow.
    const ringGeom = new THREE.TorusGeometry(0.55, 0.06, 6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3322,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    // Perf B3 (2026-05-18) — selection-ring resources are fresh per
    // selection; tag both geometry + material so the
    // `_disposeMeshChildren` traverse frees them when the entity is
    // despawned WHILE selected (otherwise the explicit dispose at the
    // setSelected swap-path above handles them).
    ringGeom.userData = { ...(ringGeom.userData || {}), __disposable: true };
    ringMat.userData = { ...(ringMat.userData || {}), __disposable: true };
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0, 0.02);
    ring.renderOrder = 10;
    ring.name = "selection-ring";
    inst._selectionRing = ring;
    inst.root.add(ring);
    _stampEntityIndoorLayer(this.scene3d, ring);
  }

  // === C2 (2026-07-12) — retail keybind TARGET CYCLING ==================
  // CPlayerSystem::SelectNext (acclient.c:397944) + its keybind dispatch
  // (acclient.c:399692-399746). Reuses the `_selectedGuid` selection ring
  // and emits `selectionChanged` on the plugin bus so the existing
  // target-bar HUD name display (plugins/target-bar.js) surfaces the pick
  // — the SAME path the click-selection in picking.js uses. Pure ordering
  // lives in scene3d/target_cycle.js (unit-tested); this method only
  // gathers live candidates + commits the selection.

  /**
   * The local player's guid, or 0 if not resolved yet. Same global the rest
   * of this file consults (`_isLocalPlayerGuid`, spawn diag).
   */
  _localPlayerGuid() {
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) return (lpg >>> 0) || 0;
      }
    } catch (_) {}
    return 0;
  }

  /**
   * The local player's world pose `{x, y, z}` in AC world coords, or null.
   * Mirrors picking.js `playerWorldPose`: the wasm LocalPlayerPose carries
   * landblock-local x/y + a separate landblockId, so fold the landblock
   * offset in to match entity world positions (`inst.root.position`).
   */
  _localPlayerWorldPose() {
    let pose = null;
    try {
      const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
      pose = sh?.getLocalPlayerPose?.();
      if (!pose) return null;
      const lbId = (pose.landblockId ?? 0) >>> 0;
      const lbX = (lbId >>> 24) & 0xff;
      const lbY = (lbId >>> 16) & 0xff;
      return { x: pose.x + lbX * 192, y: pose.y + lbY * 192, z: pose.z };
    } catch (_) {
      return null;
    } finally {
      // The pose is a wasm-bindgen BOX and this runs every EntityManager.tick:
      // copy-then-free, or ~60 boxes/s are left to the FinalizationRegistry
      // (frame_pose.js / the R1#6 note).
      try { pose?.free?.(); } catch (_) { /* already released */ }
    }
  }

  /**
   * CREATURE-SEPARATION — reachability + effect counters.
   *
   * `evals` is bumped UNCONDITIONALLY (outside the `?creatureSeparation`
   * gate) on every per-entity separation slice, so a live client can tell
   * "flag off" from "this arm never runs" — the `sceneryArmEvals` lesson.
   * `resolved` counts floors sized from a REAL resident SetupModel collision
   * radius rather than the humanoid fallback (it is what proves the wasm
   * radius table is actually reaching JS). `clamped` / `pushed` count the two
   * corrections firing. `immovable` counts push-outs REJECTED by the
   * IMMOVABLE-ENTITIES anchor bound (`?immovableEntities=on`) — nonzero the
   * moment you walk into a door / corpse / standing NPC, and the proof the
   * player is no longer displacing it. `radiiCached` is the resident table
   * size.
   *
   * @returns {{evals:number, resolved:number, clamped:number, pushed:number,
   *            immovable:number, radiiCached:number, playerRadius:number,
   *            enabled:boolean}}
   */
  creatureSeparationStats() {
    return {
      ...this._sepStats,
      radiiCached: this._separationRadii.size,
      playerRadius: this._separationPlayerRadius,
      enabled: !!this._creatureSeparationOn,
      immovableEnabled: !!this._immovableEntitiesOn,
      playerDepenetrateEnabled: !!this._playerDepenetrateOn,
    };
  }

  /**
   * CREATURE-SEPARATION — refresh the wasm collision-radius table
   * (`SessionHandle.creatureSeparationTable`) at most once every
   * `SEPARATION_RETRY_FRAMES`. The table only GROWS as creature rigs stream
   * in and their SetupModels parse, so an entity whose radius already
   * resolved is memoised permanently and never re-reads this.
   *
   * Self-degrading: a stale `pkg/` with no such export leaves the map empty
   * and every floor falls back to the humanoid radius (still far better than
   * the pre-fix zero), so a JS/wasm version skew degrades rather than throws.
   */
  _refreshSeparationTable() {
    if (this._smoothFrame - this._separationTableFrame < SEPARATION_RETRY_FRAMES) {
      return;
    }
    this._separationTableFrame = this._smoothFrame;
    try {
      const sh = typeof window !== "undefined" ? window.__sessionHandle : null;
      const t = sh?.creatureSeparationTable?.();
      if (!t) return;
      const ids = t.setupIds;
      const radii = t.radii;
      if (ids && radii && ids.length === radii.length) {
        for (let i = 0; i < ids.length; i++) {
          this._separationRadii.set(ids[i] >>> 0, radii[i]);
        }
      }
      if (Number.isFinite(t.playerRadius) && t.playerRadius > 0) {
        this._separationPlayerRadius = t.playerRadius;
      }
      if (Number.isFinite(t.epsilon)) this._separationEpsilon = t.epsilon;
    } catch (_) {
      /* stale pkg / pre-login — keep the fallback */
    }
  }

  /**
   * CREATURE-SEPARATION — the retail contact floor (m, planar centre-to-centre)
   * between `inst` and the LOCAL player:
   *
   *     r_mob * scale  +  r_player  -  EPSILON
   *
   * exactly the `radsum` retail's `CSphere::intersects_sphere`
   * (acclient.c:359211) / `CCylSphere::intersects_sphere` (:362082) build
   * before declaring contact. `r_mob` is the SetupModel's collision primitive
   * (first cyl-sphere else first sphere) as published by wasm; the scale is
   * the entity's live `_baseScale` (retail's `m_scale`, applied at the
   * `FindObjCollisions` call site :316244/:316266).
   *
   * Memoised on the instance. Returns 0 when the floor cannot be sized at all
   * (no root / no meta), which callers treat as "no separation this frame".
   */
  _separationFloor(inst) {
    // UNCONDITIONAL reachability probe — bumped before the enable gate so a
    // live client can distinguish "flag off" from "this arm is dead code".
    this._sepStats.evals++;
    if (inst._sepFloor !== undefined && inst._sepFloorResolved) {
      return inst._sepFloor;
    }
    this._refreshSeparationTable();
    const setupId = (inst?.meta?.setupId ?? inst?.setupId ?? 0) >>> 0;
    const r = this._separationRadii.get(setupId);
    const resolved = Number.isFinite(r) && r > 0;
    const base = resolved ? r : SEPARATION_FALLBACK_RADIUS_M;
    // `_baseScale` is the rig's applied uniform scale (the wire `obj_scale`);
    // a half-scale Shadow Child must halve its radius or it blocks like a
    // full-size humanoid.
    const scale =
      Number.isFinite(inst?._baseScale) && inst._baseScale > 0
        ? inst._baseScale
        : 1;
    inst._sepFloor =
      base * scale + this._separationPlayerRadius - this._separationEpsilon;
    inst._sepFloorResolved = resolved;
    if (resolved) this._sepStats.resolved++;
    return inst._sepFloor;
  }

  /**
   * CREATURE-SEPARATION — the two render-side corrections, applied to one
   * remote entity AFTER every lane that writes `root.position` has run
   * (sticky glue / dead-reckon ease / wasm-managed pose) and BEFORE the
   * velScale gait sampler reads the frame's position delta, so the gait
   * reflects what is actually drawn.
   *
   * IMMOVABLE-ENTITIES (2026-08-04, `?immovableEntities=on`): both corrections
   * run through `pushOut`, which under that flag refuses any move that would
   * carry the pose farther from the entity's authoritative anchor — the fix
   * for "the player shoves doors/NPCs/corpses around". See the
   * `readImmovableEntitiesFlag` block for the retail/ACE grounding.
   *
   * @param {object} inst  the entity instance (already known non-local)
   * @param {{x:number,y:number,z:number}} pp  local player world pose
   */
  _applyCreatureSeparation(inst, pp) {
    const floor = this._separationFloor(inst);
    if (!this._creatureSeparationOn || !(floor > 0)) return;

    // IMMOVABLE-ENTITIES (2026-08-04, `?immovableEntities=on`): the entity's
    // authoritative anchor — the last server pose we hold. `_wirePos` is
    // stashed only from a KIND_POSITION drain, so a door / corpse / standing
    // NPC that never moves falls back to its CREATE pose (`_spawnAnchor`).
    // `null` when the flag is off, which leaves `pushOut` byte-identical.
    const anchor = this._immovableEntitiesOn
      ? (inst._wirePos || inst._spawnAnchor || null)
      : null;

    // Planar push of `v` (an {x,y} carrier) out to `floor` from the player.
    // Returns true when it moved. Dead-centre overlap has no axis to push
    // along, so reuse the last bearing — a stable choice beats a per-frame
    // random one, which would jitter.
    const pushOut = (v) => {
      const dx = v.x - pp.x;
      const dy = v.y - pp.y;
      const d = Math.hypot(dx, dy);
      if (d >= floor) return false;
      let ux;
      let uy;
      if (d > 1e-4) {
        ux = dx / d;
        uy = dy / d;
      } else {
        const h = inst._lastSepBearing || 0;
        ux = Math.cos(h);
        uy = Math.sin(h);
      }
      const nx = pp.x + ux * floor;
      const ny = pp.y + uy * floor;
      // IMMOVABLE-ENTITIES: a world object's position is the SERVER's. Retail
      // stops/slides the MOVER and never writes the collidee
      // (`CPhysicsObj::handle_all_collisions` acclient.c:321808 touches only
      // `this->m_velocityVector`; `track_object_collision` :321217 /
      // `report_object_collision` :320228 only record + notify. ACE
      // `PhysicsObj.FindObjCollisions` `PhysicsObj.cs:381` likewise returns a
      // state for the mover). So this correction may only ever REDUCE our own
      // prediction error: reject any push that would carry the pose FARTHER
      // from the anchor than it already is. A standing door/corpse/NPC renders
      // at its anchor (distance 0) ⇒ every push is rejected ⇒ immovable. A
      // mob whose dead-reckon overshot past its wire pose and into the player
      // still gets pushed back out, because that shortens the anchor distance.
      if (anchor) {
        const ax = v.x - anchor.x, ay = v.y - anchor.y;
        const bx = nx - anchor.x, by = ny - anchor.y;
        if (bx * bx + by * by > ax * ax + ay * ay) {
          this._sepStats.immovable++;
          // MOVER-SIDE RESOLUTION (`?playerDepenetrate=on`): the target is
          // authoritative where it stands, so retail's answer is to move the
          // MOVER. Record what the PLAYER would have to move: the entity sits
          // at `pp + u·d` (u = player→entity unit, d < floor), so the player
          // must travel `u·(d − floor)` — i.e. AWAY from the entity, by
          // exactly the shortfall. Keep the LARGEST demand this tick (a plain
          // max, not a sum: two entities rarely demand the same direction and
          // summing would over-correct); `tick` applies + clears it.
          if (this._playerDepenetrateOn) {
            const need = d - floor; // negative
            const cx = ux * need;
            const cy = uy * need;
            const prev = this._pendingPlayerDepen;
            if (!prev || cx * cx + cy * cy > prev.x * prev.x + prev.y * prev.y) {
              this._pendingPlayerDepen = { x: cx, y: cy };
            }
          }
          return false;
        }
      }
      inst._lastSepBearing = Math.atan2(uy, ux);
      v.x = nx;
      v.y = ny;
      return true;
    };

    // === (a) FIX THE PREDICTION AT SOURCE ===
    // Both corrections are applied to `_serverTargetPos` — the thing the ease
    // chases — NOT just to the rendered pose. Clamping only the render would
    // leave a corrupted target dragging inward every frame while the clamp
    // shoved outward: a per-frame fight, i.e. exactly the jitter/rubber-band
    // this must not introduce. Fixing the TARGET lets the existing K=12 ease
    // converge onto the floor naturally, so the approach stays smooth and the
    // arrival is a settle rather than a collision with a clamp.
    const tgt = inst._serverTargetPos;
    const wire = inst._wirePos;
    if (tgt) {
      // (a1) BOUND THE EXTRAPOLATION LEAD. The dead-reckon block adds
      // `lastVel * dt` to `tgt` EVERY frame for the whole
      // `ENTITY_VELOCITY_STALE_MS` window — an accumulator, not a function of
      // elapsed time — so a mob that stopped moving keeps sliding forward at
      // its last speed, and a charging mob's velocity points at the player.
      // Real dead reckoning can only claim the distance the last known
      // velocity could actually have covered since the authoritative anchor,
      // and the freshness window bounds that. Anything past it is not
      // prediction, it is drift.
      if (wire && inst.lastVel) {
        const speed = Math.hypot(inst.lastVel.vx, inst.lastVel.vy);
        const maxLead = speed * (ENTITY_VELOCITY_STALE_MS / 1000);
        const lx = tgt.x - wire.x;
        const ly = tgt.y - wire.y;
        const lead = Math.hypot(lx, ly);
        if (lead > maxLead && lead > 1e-4) {
          const s = maxLead / lead;
          tgt.x = wire.x + lx * s;
          tgt.y = wire.y + ly * s;
          this._sepStats.clamped++;
        }
      }
      // (a2) The target may not sit inside the contact envelope either — a
      // prediction that ends up inside the player is not a pose the mob could
      // legally hold, so the ease must never be aimed there.
      if (pushOut(tgt)) this._sepStats.clamped++;
    }

    // === (b) CONTACT ENVELOPE ON THE RENDERED POSE ===
    // The hard backstop for EVERY lane, including the ones with no
    // `_serverTargetPos` at all: the F3-4 sticky glue (which writes
    // `root.position` directly) and `applyManagedPose` (the Rust
    // PositionManager). Also covers the frames before the ease has caught up.
    // Never pushes FURTHER than the floor, so releasing it cannot pop.
    if (pushOut(inst.root.position)) this._sepStats.pushed++;
  }

  /**
   * Gather the live candidate list for a selection type: every entity in
   * `entityMap` that passes the type filter, is not the local player, is
   * not mid-death (`_deadFrozen`, set by the collapse handoff), and has a
   * world position to rank by. Dead/destroyed entities never reach here —
   * they're removed from `entityMap` (or become corpses, excluded by the
   * ODF_CORPSE filter) — so they drop out of the cycle.
   *
   * @param {string} type — a SELECTION_TYPE value
   * @param {{x:number,y:number,z:number}} pose — player world pose
   * @returns {Array<{guid:number, dist:number}>}
   */
  _gatherCycleCandidates(type, pose) {
    const out = [];
    for (const [guid, inst] of this.entityMap) {
      if (!inst || !inst.root || !inst.root.position) continue;
      if (inst._deadFrozen) continue; // dead/collapsing — out of the cycle
      if (!matchesSelectionType(inst.meta, type)) continue;
      const p = inst.root.position;
      out.push({
        guid: (guid >>> 0) || 0,
        dist: weightedDistance(pose, { x: p.x, y: p.y, z: p.z }),
      });
    }
    return out;
  }

  /**
   * Commit a selection change: update the ring, fire `selectionChanged` on
   * the plugin bus (the target-bar HUD listens), return the new guid.
   * No-op emit when the guid is unchanged.
   */
  _commitSelection(newGuid) {
    const next = (newGuid >>> 0) || 0;
    const prev = (this._selectedGuid >>> 0) || 0;
    if (next === prev) return prev;
    this.setSelectedTarget(next);
    try {
      window.__pluginClient?.events?.emit?.("selectionChanged", {
        guid: (this._selectedGuid >>> 0) || 0,
        prevGuid: prev,
      });
    } catch (_) { /* never block cycling on a subscriber fault */ }
    return (this._selectedGuid >>> 0) || 0;
  }

  /**
   * Retail CPlayerSystem::SelectNext primitive (acclient.c:397944). Selects
   * the next candidate of `type` in the given direction and commits it.
   *
   * @param {boolean} closer — step toward the nearer neighbour (extreme:
   *        nearest). false = toward the farther neighbour (extreme: farthest).
   * @param {boolean} extreme — ignore the current selection, jump to the
   *        absolute nearest/farthest (the wrap-around fallback).
   * @param {string} [type] — SELECTION_TYPE.MONSTER (default) / PLAYER / ANY.
   * @returns {number} the guid selected this call, or 0 when nothing changed
   *        (retail leaves selectedID untouched; the caller then wraps).
   */
  selectNext(closer, extreme, type = SELECTION_TYPE.MONSTER) {
    if (this._targetCycleEnabled === false) return 0;
    const pose = this._localPlayerWorldPose();
    if (!pose) return 0; // can't rank without a player position
    const selfGuid = this._localPlayerGuid();
    const candidates = this._gatherCycleCandidates(type, pose);
    if (candidates.length === 0) return 0;
    const cur = (this._selectedGuid >>> 0) || 0;
    const pick = computeSelectNext(candidates, cur, selfGuid, !!closer, !!extreme);
    if (!pick || pick === cur) return 0;
    // `_commitSelection` → `setSelectedTarget` refuses a guid that isn't a
    // live, ringable entity (one that despawned between the candidate gather
    // above and this commit — an async-spawn/despawn race). Report the guid
    // that was ACTUALLY committed, not the raw pick, so a caller (e.g. the
    // `__selectClosestTarget` harness poll) never chases a target the
    // selection ring never took and can retry cleanly.
    const committed = (this._commitSelection(pick) >>> 0) || 0;
    return committed === (pick >>> 0) ? pick : 0;
  }

  /**
   * Keybind-level cycle: mirrors the retail dispatch's "try the incremental
   * step; if the selection didn't move, re-issue with extreme=1 to wrap"
   * pattern (acclient.c:399717-399746).
   *
   * @param {"next"|"previous"|"closest"} mode
   * @param {string} [type] — SELECTION_TYPE.MONSTER (default) / PLAYER / ANY.
   * @returns {number} the guid now selected (0 if nothing selectable).
   */
  cycleTarget(mode, type = SELECTION_TYPE.MONSTER) {
    if (this._targetCycleEnabled === false) return (this._selectedGuid >>> 0) || 0;
    if (mode === "closest") {
      // ClosestMonster (1, 1) — absolute nearest.
      const g = this.selectNext(true, true, type);
      return g || ((this._selectedGuid >>> 0) || 0);
    }
    if (mode === "previous") {
      // PreviousMonster (0, 0); if unchanged → wrap (1, 1) = nearest.
      let g = this.selectNext(false, false, type);
      if (!g) g = this.selectNext(true, true, type);
      return g || ((this._selectedGuid >>> 0) || 0);
    }
    // "next" — NextMonster (1, 0); if unchanged → wrap (0, 1) = farthest.
    let g = this.selectNext(true, false, type);
    if (!g) g = this.selectNext(false, true, type);
    return g || ((this._selectedGuid >>> 0) || 0);
  }

  /**
   * Retail SelectSelf — select the local player. Returns the guid (0 if the
   * local player isn't resolved yet).
   */
  selectSelf() {
    if (this._targetCycleEnabled === false) return (this._selectedGuid >>> 0) || 0;
    const self = this._localPlayerGuid();
    if (!self) return 0;
    return this._commitSelection(self);
  }

  /**
   * Harness-friendly snapshot of the current selection: `{guid, name, dist}`
   * (dist = weighted distance to the local player, or -1 when unknown).
   * Used by `window.__getSelectedTarget` for the eye-test driver.
   */
  selectedTargetInfo() {
    const guid = (this._selectedGuid >>> 0) || 0;
    if (!guid) return { guid: 0, name: null, dist: -1 };
    const inst = this.entityMap.get(guid);
    let name = null;
    try { name = inst?.meta?.name ?? inst?.name ?? null; } catch (_) {}
    let dist = -1;
    try {
      const pose = this._localPlayerWorldPose();
      const p = inst?.root?.position;
      if (pose && p) dist = weightedDistance(pose, { x: p.x, y: p.y, z: p.z });
    } catch (_) {}
    return { guid, name, dist };
  }

  /**
   * Wave 1.7 (2026-05-26) — toggle arms-up airborne pose overlay.
   *
   * Restored after Wave 1.2's deletion was determined to be directionally
   * wrong: cmd_low 0x003B (Jump) is universally ABSENT from all 436
   * retail motion tables (Wave 6 data audit), so the JS-side per-part
   * quaternion tween IS the visual for the airborne window. Joe Trevis
   * confirmed retail's "combined jumping/falling animation" had arms
   * raised — the X-Play gag. This restores that pose.
   *
   * Two rig shapes:
   * - Humanoid (>=16 parts): slerp parts[10]/[13] upper arms ±π/2
   *   around local X (arms horizontal), slight leg-out tilt on
   *   parts[1]/[5]. Mixer is paused at tween-complete so the walk-
   *   cycle clip doesn't drift the parts mid-air. Stash + restore
   *   per-part quaternions on landing.
   * - Generic (<16 parts, e.g. drudges, rats): tilt root ~12° around
   *   local X plus 8% Z stretch. No part-locking required.
   *
   * Idempotent: re-entering the same state is a no-op. Per-frame
   * advance lives in `_tickJumpPoseTween`. Wired only on the LOCAL
   * player's jump path (index.html spacebar handler) — remote players
   * use kind=18 EntityAirborneChanged (lib.rs:23517) which would land
   * here too once the JS recv handler is restored (deferred; remote
   * jumps currently fall back to the MotionTable Falling cycle path).
   */
  // Bug 19 helpers (see `setAirborne`).
  _leaveGround(inst) {
    const g = inst.guid >>> 0;
    const stance = ((inst.currentStance ?? inst.lastStance ?? 0) >>> 0);
    const from = (inst.lastMotionCommand ?? 0) >>> 0;
    inst._groundMotion = {
      cmd: from && (from & 0xffff) !== CMD_LOW_FALLING ? from : CMD_READY_FULL,
      stance,
      speed: (inst._motionSpeed ?? 1.0) * ((inst._motionSpeedSign ?? 1) < 0 ? -1 : 1),
    };
    inst._airborneSinceMs = performance.now();
    if (this._jumpAnimLogOk(g)) {
      try {
        // eslint-disable-next-line no-console
        console.log(
          `[jump-anim] 0x${g.toString(16)} airborne=1 -> 0x${CMD_FALLING_FULL.toString(16)} ` +
          `(from 0x${from.toString(16)})`,
        );
      } catch (_) {}
    }
    this.setMotion(g, CMD_FALLING_FULL, stance, 1.0);
  }

  _hitGround(inst, why) {
    const g = inst.guid >>> 0;
    const gm = inst._groundMotion;
    inst._groundMotion = null;
    inst._airborneSinceMs = 0;
    const stance = ((gm?.stance || inst.currentStance || inst.lastStance || 0) >>> 0);
    const cmd = gm?.cmd && (gm.cmd & 0xffff) !== CMD_LOW_FALLING ? gm.cmd >>> 0 : CMD_READY_FULL;
    if (this._jumpAnimLogOk(g)) {
      try {
        // eslint-disable-next-line no-console
        console.log(`[jump-anim] 0x${g.toString(16)} airborne=0 (${why}) -> 0x${cmd.toString(16)}`);
      } catch (_) {}
    }
    this.setMotion(g, cmd, stance, gm?.speed ?? 1.0);
  }

  // `[jump-anim]` lines: always for the local player, a capped few for others.
  _jumpAnimLogOk(g) {
    if (this._isLocalPlayerGuid(g >>> 0)) return true;
    this._jumpAnimRemoteLogs = (this._jumpAnimRemoteLogs | 0) + 1;
    return this._jumpAnimRemoteLogs <= 20;
  }

  setAirborne(guid, airborne) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    const wantAirborne = !!airborne;
    const currentlyAirborne = !!inst._isAirborne;
    if (wantAirborne === currentlyAirborne) return; // idempotent
    inst._isAirborne = wantAirborne;
    // Wave 3 / I6 fix (2026-05-28) — clear the stuck-airborne stamp on
    // any state change. The takeoff path re-stamps in _tickJumpPoseTween
    // once the takeoff tween completes; the landing path leaves it null.
    inst._airborneStablishedMs = null;

    // Bug 19 (2026-10-07): the airborne pose is the MotionTable's Falling
    // state, as in retail. `LeaveGround` (acclient.c:344478) re-runs the
    // interpreted movement off the walkable, which applies Falling
    // 0x40000015 (acclient.c:344193): the take-off LINK out of the current
    // substate (human MT: Ready→Falling 0x030004AA, Run→Falling 0x030004AC)
    // and then the Falling loop (0x030004A9). Keys pressed in the air only
    // update the motion state (acclient.c:343987-344013; `setMotion` keeps
    // them in `_groundMotion`), and `HitGround` (:344429) re-applies that
    // state, which plays the Falling→Ready/Walk/Run landing link. The old
    // procedural arms-up tween is kept behind `?jumpPose=overlay`.
    if (!JUMP_POSE_OVERLAY) {
      if (wantAirborne) this._leaveGround(inst);
      else this._hitGround(inst, "touchdown");
      return;
    }

    const isHumanShape = inst.parts && inst.parts.length >= 16;

    if (wantAirborne) {
      if (isHumanShape) {
        this._applyHumanJumpPose(inst);
      } else {
        this._applyGenericJumpPose(inst);
      }
    } else {
      if (inst._jumpPoseStash) {
        this._clearHumanJumpPose(inst);
      } else if (inst.airborneTilt) {
        this._clearGenericJumpPose(inst);
      }
    }
  }

  /**
   * Per-part jump pose for humanoid SetupModels. Sets up a 200ms
   * slerp tween from current pose → outstretched pose; the per-frame
   * `_tickJumpPoseTween` in `tick(dt)` advances it. The animation
   * mixer is paused at tween-complete (not at tween-start) so the
   * limbs ease into the airborne pose smoothly instead of snapping.
   *
   * Part indices match the human SetupModel skeleton:
   *   parts[10] LEFT_UPPER_ARM   (rotated -π/2 around X = up + out)
   *   parts[13] RIGHT_UPPER_ARM  (rotated +π/2 around X = up + out)
   *   parts[1]  LEFT_UPPER_LEG   (-π/12 = slight outward splay)
   *   parts[5]  RIGHT_UPPER_LEG  (+π/12)
   * Weapons bound to parts[15] inherit the right-hand rotation.
   */
  _applyHumanJumpPose(inst) {
    const X = new THREE.Vector3(1, 0, 0);
    const HUMAN_AIRBORNE_OFFSETS = [
      // [partIndex, axis, angle]
      [10, X, -Math.PI / 2],  // LEFT_UPPER_ARM   — horizontal
      [13, X, Math.PI / 2],   // RIGHT_UPPER_ARM  — horizontal
      [1,  X, -Math.PI / 12], // LEFT_UPPER_LEG   — slight out
      [5,  X, Math.PI / 12],  // RIGHT_UPPER_LEG  — slight out
    ];
    const from = new Map();
    const to = new Map();
    for (const [partIdx, axis, angle] of HUMAN_AIRBORNE_OFFSETS) {
      const p = inst.parts && inst.parts[partIdx];
      if (!p) continue;
      const orig = p.quaternion.clone();
      from.set(partIdx, orig);
      const offset = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      to.set(partIdx, orig.clone().multiply(offset));
    }
    // Stash the pre-airborne quaternions so landing can tween back
    // to them (and so a paranoid mixer-unpause restores to a known
    // frame instead of whatever clip-time happens to be).
    inst._jumpPoseStash = from;
    inst._jumpPoseTween = {
      // A5-P2: stamp from the same clock `_tickJumpPoseTween` reads.
      startMs: this._tweenNowMs(),
      durationMs: 200,
      from,
      to,
      isLanding: false,
      kind: "human",
    };
  }

  _clearHumanJumpPose(inst) {
    if (!inst._jumpPoseStash) return;
    // Reverse tween: from current (possibly mid-arc-pose) → stashed
    // pre-airborne quaternions. `_jumpPoseStash` doubles as the
    // landing target.
    const from = new Map();
    for (const [partIdx, _origQ] of inst._jumpPoseStash) {
      const p = inst.parts && inst.parts[partIdx];
      if (p) from.set(partIdx, p.quaternion.clone());
    }
    inst._jumpPoseTween = {
      // A5-P2: stamp from the same clock `_tickJumpPoseTween` reads.
      startMs: this._tweenNowMs(),
      durationMs: 200,
      from,
      to: inst._jumpPoseStash,
      isLanding: true,
      kind: "human",
    };
    // `_jumpPoseStash` cleared and mixer resumed at tween-complete
    // in `_tickJumpPoseTween`, not here.
  }

  /**
   * Body-level fallback for non-human entities. Same shape as the
   * human tween (slerps root.quaternion offset + lerps root.scale.z)
   * so the per-frame tick can handle both paths uniformly.
   */
  _applyGenericJumpPose(inst) {
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI / 15, // ~12°
    );
    inst._jumpPoseTween = {
      // A5-P2: stamp from the same clock `_tickJumpPoseTween` reads.
      startMs: this._tweenNowMs(),
      durationMs: 200,
      fromTilt: new THREE.Quaternion(), // identity
      toTilt: tilt,
      fromScale: 1.0,
      toScale: 1.08,
      isLanding: false,
      kind: "generic",
    };
  }

  _clearGenericJumpPose(inst) {
    // Reverse: tween back to identity tilt + scale 1.0 (fraction of base).
    // #9: fromScale is the current scale FRACTION relative to the entity's
    // authored base scale (root.scale.z is base*fraction), so divide back
    // out. base defaults to 1 → byte-identical to the prior `scale.z`.
    const base = inst._baseScale || 1.0;
    inst._jumpPoseTween = {
      // A5-P2: stamp from the same clock `_tickJumpPoseTween` reads.
      startMs: this._tweenNowMs(),
      durationMs: 200,
      fromTilt: inst.airborneTilt
        ? inst.airborneTilt.clone()
        : new THREE.Quaternion(),
      toTilt: new THREE.Quaternion(), // identity
      fromScale: inst.root.scale.z / base,
      toScale: 1.0,
      isLanding: true,
      kind: "generic",
    };
  }

  /**
   * Phase C — one-shot melee swing pose. Right upper arm sweeps
   * forward and back over ~300ms (triangle wave: 0→1→0 in part
   * rotation amplitude). Restarting before completion replaces the
   * tween. Only animates humanoid rigs (16+ parts); other shapes
   * are no-ops (an animated swing on a drudge would need a per-
   * shape part-index map and isn't worth Phase C scope).
   */
  // F6-2 — record that picking.js just played an OPTIMISTIC local swing
  // for `cmd`, so the server's matching KIND_MOTION_ACTION echo (which
  // fires for the local guid too) doesn't restart/double-play the same
  // swing ~RTT later. Keyed by command; consumed once within ~500ms.
  noteLocalSwingPrediction(cmd) {
    const c = (cmd >>> 0) || 0;
    if (c === 0) return;
    if (!this._localSwingEchoes) this._localSwingEchoes = new Map();
    this._localSwingEchoes.set(c, performance.now() + 500);
    try { window.__diag?.cast?.onEchoNote?.(c); } catch (_) {}
  }

  // F6-2 — returns true (and consumes the record) when `guid` is the
  // local player and `cmd` matches an optimistic swing fired within the
  // last ~500ms, so the caller can skip re-playing it.
  consumeLocalSwingEcho(guid, cmd) {
    if (!this._localSwingEchoes) return false;
    if (!this._isLocalPlayerGuid(guid >>> 0)) return false;
    const c = (cmd >>> 0) || 0;
    const expiry = this._localSwingEchoes.get(c);
    if (expiry == null) return false;
    this._localSwingEchoes.delete(c);
    return performance.now() <= expiry;
  }

  // setSwingPose (the single-arm vibe-pose one-shot) RETIRED 2026-06-18
  // (WS-B teardown). Superseded by the Rust motion authority (unifiedMotion
  // default-on); its callers now no-op when no real MotionTable link/clip
  // resolves. The _swingTween machinery it drove is removed below.

  /**
   * Wave 13 / Phase 42 (2026-05-26) — one-shot magic cast pose. Mirrors
   * `setSwingPose`'s placeholder-vibe-pose role: plays an immediate
   * incantation gesture on the caster's rig while the server's
   * authoritative UpdateMotion (kind=5) and the motion-table classifier
   * race to deliver the real cast clip. The real clip wins via
   * `setMotion`'s `cls === "cast"` branch (which clears `_castTween`,
   * see ~line 2569 above for the swing analog).
   *
   * Pose choice: BOTH upper arms (parts[10] LEFT_UPPER_ARM and parts[13]
   * RIGHT_UPPER_ARM) rotated upward around local X by -π/2 — outstretched
   * arms-raised incantation. Visually distinct from `setSwingPose`'s
   * forward-down right-arm swing (single arm, opposite-sign rotation).
   * Duration 600ms — casts feel longer than melee swings, gives time for
   * the spell-shape preview overlay (Wave 12 Phase 38) to register
   * before the gesture concludes.
   *
   * Triangle-wave amplitude (0→1→0 over the duration) same as the swing
   * tween; restarting mid-tween replaces the cast. Non-humans (rigs with
   * <16 parts) no-op, mirroring `setSwingPose`. Per-frame advance lives
   * in `_tickCastTween` below.
   */
  // setCastPose (the both-arms-up vibe-pose one-shot) RETIRED 2026-06-18
  // (WS-B teardown). Superseded by playCastSequence's real ACE-derived
  // gesture chain + the Rust motion authority; its fallback callers now
  // no-op. The _castTween machinery it drove is removed below.

  /**
   * Wave 14 / Phase 45 (2026-05-26) — per-spell scarab-windup chain
   * playback. Replaces Phase 42's `setCastPose` vibe-pose with the
   * real ACE-derived sequence: for each scarab in the spell's
   * `SpellFormula.Components[]`, play the corresponding windup gesture
   * (`MagicPowerUp0X`); then play the talisman cast gesture
   * (`MagicBlast` / `MagicSelf` / etc.).
   *
   * Wave 18 / Phase 52 (2026-05-26) — after the gesture chain
   * completes, fire `SpellBase.CasterEffect` (PlayScript enum) on the
   * caster via the same wire-side `playEffect` event the server would
   * emit. Lets the Wave 17 resolver (`play_effect_vfx.js
   * _tryResolveRealVfx`) handle PhysicsScriptTable lookup +
   * `formulaScale`-weighted pick + ParticleEmitter spawn. TargetEffect
   * is OUT-of-scope for this wave (requires damageDealt→SpellId
   * attribution; see TODO breadcrumb at the end of the chain body).
   *
   * Algorithm (mirrors `Player_Magic.cs::CreatePlayerSpell` and
   * `SpellFormula.cs::GetGestureMotionsList` in ACE):
   *
   * ```
   * for each entry in seq.windupGestures:
   *   await setSwingMotion(guid, entry.motion) for entry.durationS seconds
   * await setSwingMotion(guid, seq.castGesture.motion) for castGesture.durationS seconds
   * ```
   *
   * Edge cases the Phase 44 generator bakes into the JSON:
   *   - **FastCast** spells (`fastCast: true`) emit empty windup, only
   *     the final cast gesture plays.
   *   - **Lead-scarab exempt** spells (Lightning Bolt I, etc.) emit
   *     empty windup despite `fastCast: false` (ACE's `SpellFormula`
   *     short-circuits when the only scarab is Lead).
   *
   * Cancellation: every chain start writes a monotonic token to
   * `inst._castSequenceToken`. Each await checks `inst._castSequenceToken`
   * still matches the token captured at chain start; if not, the chain
   * aborts cleanly. New cast → new token → prior chain bails out at
   * its next `await`. Rapid-fire cast clicks therefore overwrite the
   * sequence in place rather than queueing N stuck poses.
   *
   * Fallback paths (any of which triggers `setCastPose` vibe-pose):
   *   - `spellId` is 0 / falsy.
   *   - `data/spell-cast-sequence.json` not yet loaded (first-frame
   *     race — `getCastSequence` returns null, async fetch kicks).
   *   - `spellId` not in the sequence map (homebrew / out-of-LSD spells).
   *   - `setSwingMotion` is not callable on the manager (defensive —
   *     shouldn't happen, but the missile/melee path has the same
   *     guard).
   *
   * @param {number} guid — entity GUID to animate (typically local
   *   player; remote casters fall back to `setCastPose` because
   *   `damageTaken` doesn't carry a SpellId — see `index.html`
   *   dispatchRemoteSwing magic branch).
   * @param {number | string} spellId — u32 SpellId being cast.
   * @returns {Promise<void>} resolves when the full chain completes
   *   or aborts (cancelled / fell through to fallback).
   */
  async playCastSequence(guid, spellId, opts) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // WS16 diag: open the cast record BEFORE any early return (spellId may be 0).
    try { window.__diag?.cast?.onCastRequested?.({ guid: g, spellId }); } catch (_) {}
    // Fallback path A: missing spellId → vibe-pose.
    if (!spellId) {
      // WS-B teardown (2026-06-18): setCastPose vibe-pose fallback removed.
      // The real path is playCastSequence's ACE-derived gesture chain; when
      // it falls through (no spellId / table not loaded / no setSwingMotion),
      // the entity plays NO fallback gesture (the pose was a placeholder).
      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "noSpell" }); } catch (_) {}
      return;
    }
    // Fallback path B: table not loaded yet (first-frame race) OR
    // SpellId not in the map. `getCastSequence` returns null in both
    // cases and (on first call) kicks the async fetch so the *next*
    // cast hits a populated table.
    const seq = getCastSequence(spellId);
    if (!seq) {
      // WS-B teardown (2026-06-18): setCastPose vibe-pose fallback removed.
      // The real path is playCastSequence's ACE-derived gesture chain; when
      // it falls through (no spellId / table not loaded / no setSwingMotion),
      // the entity plays NO fallback gesture (the pose was a placeholder).
      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "tableNotLoaded" }); } catch (_) {}
      return;
    }
    // Fallback path C: setSwingMotion not available (defensive — the
    // melee/missile path has the same guard around `setSwingMotion`).
    if (typeof this.setSwingMotion !== "function") {
      // WS-B teardown (2026-06-18): setCastPose vibe-pose fallback removed.
      // The real path is playCastSequence's ACE-derived gesture chain; when
      // it falls through (no spellId / table not loaded / no setSwingMotion),
      // the entity plays NO fallback gesture (the pose was a placeholder).
      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "noSetSwing" }); } catch (_) {}
      return;
    }
    // F8-4 — cast-state-machine gate. While a cast is in flight, ignore a
    // repeat request for the same caster (don't restart the windup). The busy
    // window is sized to the chain's own duration (capped) so it can't wedge.
    if (CAST_STATE_MACHINE) {
      const nowMs = performance.now();
      // WS01: `?castBusyScope=on` restricts the drop to a repeat of the SAME
      // spell (spam-click protection); a different-spell weave the server will
      // accept still animates its windup locally.
      const sameSpell = !CAST_BUSY_SCOPE || (inst._castBusySpellId === (spellId >>> 0));
      if (sameSpell && inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
        this._castDiag("busyDropped");
        try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "busyWindow" }); } catch (_) {}
        return; // already casting this spell — ignore the recast
      }
      let estMs = 0;
      // WS11: size the busy window off the same source the chain sleeps on
      // (link length under ?castGestureLen, else JSON durationS) so the cap
      // tracks the actual chain length. Byte-identical when the flag is off.
      const mt0 = (inst.meta?.mtableId ?? 0) >>> 0;
      const gLen = (gz) => {
        if (CAST_GESTURE_LEN) {
          try {
            const m = (typeof gz.motion === "string" ? parseInt(gz.motion, 16) : gz.motion) >>> 0;
            const r = window.__classifyMotionCommandTyped?.(mt0, CAST_MAGIC_STANCE, m);
            if (r && r.source === "wasm-link" && Number.isFinite(+r.durationSec) && +r.durationSec > 0)
              return +r.durationSec * 1000;
          } catch (_) { /* fall back to durationS */ }
        }
        return (+gz.durationS || 0.6) * 1000;
      };
      for (const gz of (seq.windupGestures || [])) estMs += gLen(gz);
      if (seq.castGesture) estMs += gLen(seq.castGesture);
      inst._castBusyUntilMs = nowMs + Math.min(12000, estMs / CAST_SPEED);
      inst._castBusySpellId = (spellId >>> 0);
    }
    // Cancellation token. Bump on every chain start; subsequent
    // awaits compare against this snapshot to detect "a newer cast
    // started, bail out".
    const token = ((inst._castSequenceToken | 0) + 1) | 0;
    inst._castSequenceToken = token;
    // WS08b (2026-07-13) — durable "a local cast chain is in flight" flag.
    // Set at chain commit and cleared on natural completion / cancel /
    // clearCastBusy (below). Unlike `_castBusyUntilMs` (a SHORT durationS-based
    // debounce estimate that can expire mid-windup), this stays true for the
    // WHOLE visible chain, so a genuine terminal reject arriving after the busy
    // estimate lapsed but during the windup is still honored (read by the
    // index.html kind=13 handler via shouldClearCastOnReject). Purely additive:
    // only the `?castRejectClears=on` handler reads it, so default behavior is
    // unchanged.
    inst._castChainActive = true;
    // WS16 diag: chain committed past all early returns.
    try {
      window.__diag?.cast?.onChainStart?.({
        guid: g, spellId, token,
        busyUntilMs: inst._castBusyUntilMs ?? null,
        windupCount: (seq.windupGestures || []).length,
        hasCast: !!seq.castGesture,
        fastCast: seq.fastCast, leadOnly: seq.leadOnly,
      });
    } catch (_) {}
    // WS04 (?castHoldReclaim) — mark the LOCAL cast chain in flight so the
    // movement system holds the forward slot dead across the WHOLE chain
    // (not per-windup-node). Local-player only: `window.getLocalPlayerGuid()`
    // is the canonical accessor this file uses (the SessionHandle has no
    // per-instance local-guid export). Degrades silently if the global or the
    // `noteLocalCastWindow` export is missing (stale pkg/ → the feature just
    // no-ops; the flag is default-OFF anyway).
    const __ws04sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
    let __ws04local = false;
    if (
      __ws04sh &&
      typeof window !== "undefined" &&
      typeof window.getLocalPlayerGuid === "function" &&
      typeof __ws04sh.noteLocalCastWindow === "function"
    ) {
      const __lpg = window.getLocalPlayerGuid();
      __ws04local = (__lpg != null) && (g === (__lpg >>> 0));
    }
    const __ws04setWindow = (active) => {
      if (!__ws04local) return;
      try { __ws04sh.noteLocalCastWindow(active); } catch (_) {}
    };
    // Token-guarded close: only clears if THIS chain still owns the window (a
    // newer cast — which re-stamped true — must not be cleared by an older
    // chain's tail/despawn path).
    const __ws04clear = () => {
      if (!__ws04local || inst._castSequenceToken !== token) return;
      if (inst._ws04WindowTimer) { clearTimeout(inst._ws04WindowTimer); inst._ws04WindowTimer = 0; }
      __ws04setWindow(false);
    };
    if (__ws04local) {
      // Belt (WS04 verify must-fix #2): a self-clearing watchdog guarantees
      // the window can NEVER stick TRUE if the chain is abandoned without
      // cancelCastSequence — e.g. entity despawn mid-windup, which returns
      // early below without bumping the token. Mirrors the F8-4
      // `_castBusyUntilMs` cap (max chain estimate, 12 s ceiling).
      if (inst._ws04WindowTimer) { clearTimeout(inst._ws04WindowTimer); inst._ws04WindowTimer = 0; }
      __ws04setWindow(true);
      inst._ws04WindowTimer = setTimeout(() => {
        inst._ws04WindowTimer = 0;
        if (inst._castSequenceToken === token) __ws04setWindow(false);
      }, 12000);
    }
    // (vibe-pose _castTween clear removed — setCastPose retired, WS-B 2026-06-18)
    // Helper: play one gesture (windup or cast) and sleep for its
    // duration. Returns false if cancelled mid-flight (caller breaks
    // out of the chain).
    const playGesture = async (gesture) => {
      if (inst._castSequenceToken !== token) return false;
      if (!this.entityMap.has(g)) return false;
      // The JSON stores motion as a `0x...` hex string (Phase 44
      // contract); setSwingMotion takes a u32. Accept both numeric
      // and string inputs defensively — a future generator change
      // that emits decimal numbers shouldn't break the chain.
      let motionU32;
      if (typeof gesture.motion === "number") {
        motionU32 = gesture.motion >>> 0;
      } else if (typeof gesture.motion === "string") {
        const s = gesture.motion;
        const parsed = (s.startsWith("0x") || s.startsWith("0X"))
          ? parseInt(s, 16)
          : parseInt(s, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return true; // skip
        motionU32 = parsed >>> 0;
      } else {
        return true; // skip malformed entry rather than aborting chain
      }
      // WS11: default sleep source = the JSON durationS (== SpellComponentTable
      // ._time). Under ?castGestureLen the try below overwrites this with the
      // MotionTable link length for cast/swing gestures (see the A2 comment).
      let durS = +gesture.durationS || 0.6;
      try {
        // setSwingMotion is async (animation cache fetch) but we don't
        // `await` it — the per-gesture sleep below is what paces the
        // chain. Awaiting setSwingMotion would compound its internal
        // latency on top of the spell's wall-clock duration.
        // F8-1: pace the clip at CastSpeed (×2 under ?castSpeed), and record
        // the prediction so the server's matching 2× windup echo is skipped
        // (consumeLocalSwingEcho in loop.js) instead of fighting/restarting it.
        // WS01: mirror canPlayReal synchronously (a cheap in-memory HashMap walk,
        // no bake) so we only note the swing-echo dedup when the prediction will
        // actually animate. Otherwise the default-ON dispatchParity echo dedup
        // swallows the server echo too and NOTHING raises the arms.
        const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
        // WS11 also needs `c` (for the link length), so classify when EITHER
        // flag wants it. The Magic stance (0x49) is the correct one to resolve
        // under — WS01 DAT-verified that a stale inst.currentStance (e.g.
        // NonCombat, which carries ZERO magic gestures) silently misses.
        const c = (CAST_RELIABILITY || CAST_GESTURE_LEN)
          ? window.__classifyMotionCommandTyped?.(mtableId, CAST_MAGIC_STANCE, motionU32)
          : null;
        const willPlay = !CAST_RELIABILITY ||
          !!(c && (c.kind === "swing" || c.kind === "cast") && (c.resolvedCommand >>> 0) !== 0 && c.source === "wasm-link");
        this._castDiag("attempts");
        if (!willPlay) this._castDiag("linkOrStanceMiss");
        // ── 2026-08-12: THE LOCAL CAST PREDICTION NO LONGER ANIMATES ──
        // Retail's client plays NO cast animation of its own. Verified in the
        // decomp: `ClientMagicSystem::FreeHandsAndCastSpell` (acclient.c:403775)
        // is nine lines — MaybeStopCompletely, the CM_Magic send, a cursor bump
        // — with no motion call; and the animation funnel is singular
        // (`CPhysicsObj::DoMotion` has exactly ONE call site in 31 MB, inside
        // `CommandInterpreter::MovePlayer`, :717999). A cast gesture can only
        // reach `CSequence` via the server's 0xF74C action list at
        // `CMotionInterp::move_to_interpreted_state:344410`.
        //
        // ACE sends us exactly that, and measurement confirmed it end-to-end
        // (probe 2026-08-12, 3/3 casts): the COMPLETE windup chain arrives, one
        // `UpdateMotion` per gesture, `movement_seq` strictly monotonic, order
        // and identity matching this table exactly, at on-wire speed **2.0** —
        // i.e. `Player_Magic.cs:603 CastSpeed = 2.0f`, the same number
        // `CAST_SPEED` hardcodes. `EnqueueBroadcast` sends to the caster first
        // (`WorldObject_Networking.cs:1376-1385`), and the spell VFX comes with
        // it (`WorldObject_Magic.cs:358-359` broadcasts `CasterEffect` with
        // `spell.Formula.Scale`), so nothing is lost by not fabricating it.
        //
        // Predicting locally forced a dedup to stop the server's authoritative
        // motion "fighting" ours, and that dedup is a 500 ms wall-clock window
        // (`noteLocalSwingPrediction`, :8506). Measured, the cast gesture's echo
        // lands 584-756 ms after the local prediction, so it MISSES the window
        // in 3/3 casts, `forceLocal` re-issues `setMotion`, and the gesture
        // visibly re-plays. Widening the constant would be tuning a number to
        // hide an architecture we know is inverted; removing the prediction
        // deletes the whole class of bug instead.
        //
        // The unconsumed 4th echo animating is also the proof this is safe: a
        // server echo demonstrably drives the local rig on its own.
        //
        // KEPT: classification `c` (WS11 still paces the chain's busy-window /
        // CasterEffect timing off the MotionTable link length) and the diag
        // counters. REMOVED: the gesture playback and its echo-suppression note.
        // `playCastSequence` is local-player only — remote casters animate off
        // the wire already — so remote behaviour is untouched.
        this._castDiag("serverDrivenGesture");
        // WS11: prefer the MotionTable link length (== ACE GetAnimationLength ==
        // the on-screen gesture setSwingMotion just started) over the JSON
        // durationS. Only the single-throw CAST gesture actually diverges
        // (talisman _time is ~1.7-3x its throw length); windups shift only
        // ~+30-40ms/gesture because durationSec is the Rust baked-INCLUSIVE
        // frame sum ((high-low+1) frames, src/lib.rs), ~1 frame/segment longer
        // than ACE's exclusive GAL — within the ±100ms target, and it aligns
        // the windup sleep to its OWN on-screen visual (which was ~1 frame
        // short before). Falls back to durationS on a cache/link miss.
        if (CAST_GESTURE_LEN && c && c.source === "wasm-link" &&
            (c.kind === "swing" || c.kind === "cast") &&
            Number.isFinite(+c.durationSec) && +c.durationSec > 0) {
          durS = +c.durationSec;
        }
      } catch (_) { /* never block the chain on a single gesture fail */ }
      // F8-1: shorten each gesture's wall-clock by CastSpeed so the chain's
      // total duration matches the 2× server cast.
      const ms = Math.max(50, Math.round((durS * 1000) / CAST_SPEED));
      await new Promise((resolve) => setTimeout(resolve, ms));
      // Recheck cancellation after the sleep — a newer cast may have
      // started while we slept.
      if (inst._castSequenceToken !== token) return false;
      if (!this.entityMap.has(g)) return false;
      return true;
    };
    // WS01: warm the animationCache for EVERY gesture up front, in parallel, so
    // the fire-and-forget bake in setSwingMotion can't outlive a min-50ms windup
    // sleep and leave the arms unraised. Await-capped so a slow/hung bake never
    // blocks the cast. Idempotent (promise-keyed cache) — the per-gesture
    // setSwingMotion below reuses these exact warm entries.
    if (CAST_RELIABILITY) {
      try { await this._prefetchCastClips(g, seq); } catch (_) {}
      if (inst._castSequenceToken !== token) return; // a newer cast preempted us
    }
    // Chain: windup gestures in order, then the cast gesture.
    const _windups = seq.windupGestures || [];
    for (let _i = 0; _i < _windups.length; _i++) {
      const gesture = _windups[_i];
      // WS16 diag: stamp the windup gesture BEFORE it plays (index-threaded).
      try { window.__diag?.cast?.onGesture?.({ guid: g, index: _i, motion: gesture.motion, name: gesture.name, isCast: false }); } catch (_) {}
      const ok = await playGesture(gesture);
      if (!ok) {
        // WS04 — cancelled or entity vanished. Token-guarded, so a newer
        // cast's window survives; a despawn (token still ours) closes it.
        __ws04clear();
        return;
      }
    }
    if (seq.castGesture) {
      // WS16 diag: stamp the final cast gesture.
      try { window.__diag?.cast?.onGesture?.({ guid: g, index: _windups.length, motion: seq.castGesture.motion, name: seq.castGesture.name, isCast: true }); } catch (_) {}
      // WS06 (2026-07-12): client re-face at the FINAL gesture (ACE's second
      // Rotate before the cast gesture, Player_Magic.cs "do second rotate").
      // Fire-and-forget so the turn runs CONCURRENTLY with the gesture overlay.
      // No-op unless the caller supplied a hook (flag-gated in picking.js). Token-
      // guarded so a preempted/fizzled chain doesn't re-face; wrapped so a hook
      // fault never breaks the chain.
      if (inst._castSequenceToken === token &&
          typeof opts?.onBeforeCastGesture === "function") {
        try { opts.onBeforeCastGesture(); } catch (_) { /* never break the chain */ }
      }
      await playGesture(seq.castGesture);
    }

    // -----------------------------------------------------------------
    // Wave 18 / Phase 52 — CasterEffect VFX spawn.
    //
    // After the gesture chain completes, fire the spell's per-spell
    // CasterEffect PlayScript on the CASTER entity. Mirrors ACE's
    // `WorldObject_Magic.cs:358-359 DoSpellEffects`:
    //
    //   caster.EnqueueBroadcast(new GameMessageScript(
    //       caster.Guid, spell.CasterEffect, spell.Formula.Scale));
    //
    // CasterEffect is a PlayScript enum value (small u32, NOT a 0x33
    // PhysicsScript DID), so we route through the Wave 17 resolver
    // chain identically to how a wire-driven `PlayEffect (0xF755)`
    // event would be handled: the caster's PhysicsScriptTable maps
    // the PScriptType ID → real PhysicsScript DID using `formulaScale`
    // as the picker `mod` (per acclient.c:336552
    // PhysicsScriptTableData::GetScript).
    //
    // We emit the synthetic `playEffect` event rather than calling
    // play_effect_vfx.js's internal `_tryResolveRealVfx` directly so:
    //   1. The placeholder fallback path runs automatically if the
    //      caster has no PhysicsScriptTable / scriptId not in table.
    //   2. We don't touch play_effect_vfx.js (Phase 51's file —
    //      reserved for other Wave 18 agents per mandate).
    //   3. Diag counters (`_realVfxStats.attempts/resolved/miss*`)
    //      stay coherent across both wire-driven + spell-driven paths.
    //
    // Cancellation: if the chain was cancelled mid-flight we already
    // returned via the `ok === false` path above; this code only runs
    // when the chain succeeded end-to-end. No further token check
    // needed.
    //
    // TargetEffect needs NO client synthesis (WS09 2026-07-12): ACE broadcasts
    // `GameMessageScript(target.Guid, spell.TargetEffect, spell.Formula.Scale)`
    // at `WorldObject_Magic.cs:361-365` with sendSelf=true (via the
    // target.Wielder ?? target broadcaster), so the wire already delivers it to
    // the LOCAL victim (self-buff / self-cast promoted per foundation §1.1) AND
    // — via the known-players broadcast — to observers of a REMOTE victim, on
    // the victim's guid. It arrives as 0xF755 → kind=30 → playEffect and renders
    // through the same resolver (system.rs applies no self-filter). The
    // projectile-hit gating (`!IsProjectile || projectileHit`) is server-side,
    // so a bolt's TargetEffect fires at impact and arrives on the wire then. Do
    // NOT synthesize it here — the earlier `damageDealt`-attribution TODO is
    // moot (F3). Live render on both rigs still verified in the eye-test queue.
    // F8-2: don't fire the spell's success CasterEffect glow if the chain
    // was cancelled while the cast gesture was playing — a recast preempted
    // it, or a fizzle/UseDone bumped the token via cancelCastSequence().
    // Without this, a FIZZLED cast still flashed the success VFX (the cast
    // gesture's playGesture result isn't checked above, so control reaches
    // here even after a mid-cast cancel).
    if (inst._castSequenceToken !== token) return;
    // WS09: the wire GameMessageScript already delivers CasterEffect to the
    // local caster at server RELEASE; the synthetic chain-end emit is a
    // double-fire. Gate it behind CAST_SYNTHETIC_CASTER_VFX (default ON =
    // today; `?castSyntheticCasterVfx=off` = wire-only fix, pending E1/E2).
    if (CAST_SYNTHETIC_CASTER_VFX && (seq.casterEffect | 0) !== 0) {
      try {
        if (
          typeof window !== "undefined" &&
          window.__pluginClient &&
          window.__pluginClient.events &&
          typeof window.__pluginClient.events.emit === "function"
        ) {
          window.__pluginClient.events.emit("playEffect", {
            targetGuid: g >>> 0,
            scriptId: (seq.casterEffect | 0) >>> 0,
            speed: Number.isFinite(seq.formulaScale) ? +seq.formulaScale : 1.0,
            // Visuals only: the wire GameMessageScript carries the same
            // script and plays its sound hooks once (play_effect_vfx.js).
            synthetic: true,
          });
          // WS16 diag: CasterEffect PlayScript emitted at chain end.
          try { window.__diag?.cast?.onCasterEffect?.({ guid: g, scriptId: (seq.casterEffect | 0) >>> 0, scale: seq.formulaScale }); } catch (_) {}
        }
      } catch (err) {
        // Never let a CasterEffect spawn failure unwind the cast
        // chain — the gesture sequence already completed visually.
        // eslint-disable-next-line no-console
        console.warn(
          `[playCastSequence] casterEffect emit failed for spell ${spellId}:`,
          err,
        );
      }
    }
    // F8-4 — chain completed: clear the cast-busy window so the next cast
    // isn't gated.
    if (inst) inst._castBusyUntilMs = 0;
    // WS08b — chain completed naturally: drop the durable in-flight flag. Only
    // reached when this chain still owns the token (guarded above at line
    // `inst._castSequenceToken !== token` return), so a preempting recast that
    // re-set the flag is not cleared here.
    if (inst) inst._castChainActive = false;
    // WS16 diag: chain reached the cast-gesture end normally.
    try { window.__diag?.cast?.onChainComplete?.({ guid: g }); } catch (_) {}
    // WS14 — cast-lifecycle resolved (chain reached the cast-gesture end).
    // Emitted for ANY caster; consumers filter on casterGuid === localGuid
    // (mirrors spellCastInitiated.attackerGuid). Additive + no-op without a
    // bus; clears the combat-bar cast-busy sweep. (Event names → WS16.)
    try {
      window.__pluginClient?.events?.emit?.("spellCastResolved", {
        spellId: spellId >>> 0, casterGuid: guid >>> 0,
      });
    } catch (_) {}
    // WS04 — chain completed naturally: close the local cast window so held-W
    // resumes. Token-guarded (a preempting recast that re-stamped true wins).
    __ws04clear();
  }

  // F8-4 — clear the cast-busy window for `guid` (a UseDone / WeenieError
  // landed, so the server is done with this cast). Lets the next cast start
  // immediately instead of waiting out the capped busy window.
  clearCastBusy(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (inst) { inst._castBusyUntilMs = 0; inst._castChainActive = false; } // WS08b: server done → chain no longer in flight
  }

  // F8-2 — cancel an in-flight cast-gesture chain for `guid` (a fizzle /
  // UseDone / WeenieError landed). Bumps `_castSequenceToken` so the chain's
  // next token check breaks out (and the success CasterEffect glow is
  // suppressed via the guard before the synthetic emit), then drops the rig
  // back to its stance-Ready recoil so it doesn't freeze mid-windup.
  cancelCastSequence(guid, cause) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return false;
    inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
    // 2026-10-05: a Ready setMotion no longer pre-empts a one-shot (see
    // _preemptUnifiedForMotion), so the deliberate cut frees it here.
    if (inst._unifiedSeq?.clearOnDone) {
      this._clearUnifiedQueue(inst);
      try { inst._unifiedSeq.seq.free(); } catch (_) { /* already freed */ }
      inst._unifiedSeq = null;
    }
    inst._castBusyUntilMs = 0; // F8-4 — cancelled cast frees the busy window
    inst._castChainActive = false; // WS08b — cancelled cast is no longer in flight
    // WS16 diag: tag the cancel cause (anim-break / fizzle / UseDone / recast).
    try { window.__diag?.cast?.onChainCancel?.({ guid: guid >>> 0, cause: cause ?? "cancel" }); } catch (_) {}
    // WS14 — cast-lifecycle rejected (fizzle / UseDone / recast preempt).
    // Clears the combat-bar cast-busy sweep early. The server-side WeenieError
    // toast (§1.4) is unchanged; this is the structured lifecycle signal.
    try {
      window.__pluginClient?.events?.emit?.("spellCastRejected", {
        casterGuid: guid >>> 0, reason: "cancelled",
      });
    } catch (_) {}
    try {
      const stance = ((inst.currentStance ?? inst.lastStance ??
        (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
      // CMD_LOW_READY (0x0003) high-bits preserved like setMotion's substitution.
      this.setMotion?.(guid >>> 0, 0x0003, stance, 1.0);
    } catch (_) { /* recoil is best-effort */ }
    // WS04 (?castHoldReclaim) — the local cast window closes on fizzle /
    // UseDone / recast preempt. The token bump at the top means any in-flight
    // chain's token-guarded clear won't double-fire; this unconditionally
    // closes the window for the LOCAL player (a following new cast re-stamps
    // true after its own token bump). Clears the watchdog too. Placed at the
    // tail so it doesn't push the overlay-guard block down the function.
    const __ws04g = guid >>> 0;
    if (
      typeof window !== "undefined" &&
      window.__sessionHandle &&
      typeof window.getLocalPlayerGuid === "function" &&
      typeof window.__sessionHandle.noteLocalCastWindow === "function"
    ) {
      const __lpg = window.getLocalPlayerGuid();
      if (__lpg != null && (__ws04g === (__lpg >>> 0))) {
        if (inst._ws04WindowTimer) { clearTimeout(inst._ws04WindowTimer); inst._ws04WindowTimer = 0; }
        try { window.__sessionHandle.noteLocalCastWindow(false); } catch (_) {}
      }
    }
    return true;
  }

  /**
   * Animation consolidation (docs/animation-audit §5 Step 1, missile): build a
   * one-shot Rust MotionSequence from the CYCLE bake for `cmd` and drive it
   * full-body (hands back to the `_unifiedLoco` cycle on completion). The bake resolves cycles
   * (lib.rs try_resolve_cycle_frames), so an aim-level fire (class 0x40, in
   * MotionTable.cycles) — which the links-only swing resolver structurally can't
   * reach (canPlayReal false → single-arm/non-human setSwingPose no-op = "missile
   * fires with no animation") — animates here instead. Returns true if a sequence
   * was built (caller skips the fallback), false otherwise (bake didn't resolve a
   * cycle / stale pkg → unchanged behavior).
   * @returns {Promise<boolean>}
   */
  async _tryUnifiedCycleOneShot(guid, setupId, mtableId, cmd, stance, clearOnDone = true) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return false;
    const MS = _motionSequenceClass();
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (!MS || typeof fetchKeyframes !== "function") return false;
    let entry = null;
    try {
      entry = await this.animationCache.get(setupId >>> 0, mtableId >>> 0, cmd >>> 0, stance >>> 0, fetchKeyframes, {
        modelChanges: inst.meta?.modelChanges ?? new Uint32Array(0),
        textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
        paletteId: (inst.meta?.paletteId ?? 0) >>> 0,
        paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
      });
    } catch (_) { return false; }
    if (!this.entityMap.has(g)) return false;
    const d = entry?.sequenceDescriptor;
    if (!d) return false;
    const seq = MS.fromDescriptor(
      d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
      d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
      false, // one-shot: play once. clearOnDone=true hands back to the cycle
             // (swing/missile); false HOLDS the final frame.
    );
    if (!seq) return false;
    if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch (_) {} }
    // J5: this door/missile one-shot is set directly on the playhead (it is not
    // a MotionTable link gesture), so drop any pending tail rather than let it
    // be promoted behind this one.
    this._clearUnifiedQueue(inst);
    inst._unifiedSeq = { seq, desc: d, clearOnDone, hooks: entry?.hooks || null, lastHookTime: -1,
      speed: this._unifiedOneShotSpeed(inst) };
    return true;
  }

  // The ONE locomotion-cycle installer (spawn + setMotion). Builds the cyclic
  // Rust MotionSequence for descriptor `d` and puts it on `inst._unifiedLoco`,
  // carrying the prior cycle's normalized phase across a swap (walk→run: no
  // foot-pop). Door/chest On/Off STATE cycles are held, not looped
  // (isDoorStateMotion — looping them is the 2026-06-29 open↔close bug): built
  // non-cyclic and advanced past their end so the playhead clamps the final
  // (open/closed) frame, with no hook timeline (spawning or snapping a door into
  // a state must not replay its swing sounds). Returns false when no sequence
  // could be built (no wasm class / no descriptor) — the caller keeps its
  // previous state.
  _installUnifiedLoco(inst, d, cacheKey, hooks, cmd, carryPhase = true) {
    const MS = _motionSequenceClass();
    if (!MS || !d) return false;
    const hold = isDoorStateMotion(cmd >>> 0);
    const seq = MS.fromDescriptor(
      d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
      d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
      !hold, // cyclic locomotion loops; a held state latches its final frame
    );
    if (!seq) return false;
    const prev = inst._unifiedLoco;
    if (carryPhase && !hold && prev?.seq && !prev.hold && typeof seq.seekPhase === "function") {
      try { seq.seekPhase(prev.seq.phase); } catch (_) {}
    }
    if (prev?.seq) { try { prev.seq.free(); } catch (_) {} }
    if (hold) {
      try { seq.advance(_finiteOr0(d.duration) + 1); } catch (_) {}
    }
    // No base-speed snapshot: the tick reads it live per cacheKey (audit F2 —
    // the snapshot froze a stale run base onto idle).
    inst._unifiedLoco = {
      seq, desc: d, cacheKey, hold,
      hooks: hold ? null : (hooks || null), lastHookTime: -1,
    };
    inst._locoCycleKey = cacheKey;
    return true;
  }

  // ---- J5: pending_animations (retail MotionTableManager) -----------------
  // `inst._unifiedSeq` stays the SINGLE playhead; `inst._unifiedQueue` is the
  // bookkeeping list that says what plays after it, exactly as retail keeps
  // `pending_animations` alongside the one `CSequence`. There is no second
  // advance loop — nothing here races the playhead.
  //
  // BEFORE (ledger J5): every new one-shot overwrote `_unifiedSeq` outright, so
  // a gesture arriving mid-gesture silently cut the first one off — retail
  // instead APPENDS and only retracts under `remove_redundant_links`.
  //
  // Deviation, deliberate: retail's queue is unbounded. A wire storm (or an
  // echo the dedup window missed) would show up as visible animation lag with
  // no ceiling, so `_UNIFIED_QUEUE_MAX` pending entries are kept and the oldest
  // pending (never the in-flight head) is dropped past that. Recorded in the
  // ledger under J5.
  _enqueueUnifiedOneShot(inst, motion, numAnims, rec) {
    if (!inst._unifiedQueue) inst._unifiedQueue = createMotionQueue();
    const q = inst._unifiedQueue;
    rec.numAnims = Math.max(1, numAnims | 0);
    for (const dropped of addToQueue(q, motion >>> 0, rec.numAnims, rec)) {
      try { dropped.seq.free(); } catch (_) { /* already freed */ }
    }
    while (q.list.length > _UNIFIED_QUEUE_MAX + 1) {
      const victim = q.list.splice(1, 1)[0];
      if (victim?.payload) { try { victim.payload.seq.free(); } catch (_) {} }
    }
    this._promoteUnifiedHead(inst);
    return inst._unifiedSeq === rec;
  }

  // Put the queue head on the playhead if the playhead is free. Retires
  // leading zero-anim nodes (retail: `num_anims <= animation_counter` pops
  // them without their ever playing).
  _promoteUnifiedHead(inst) {
    const q = inst._unifiedQueue;
    if (!q || inst._unifiedSeq) return;
    // A record whose wasm sequence was already freed (`__wbg_ptr === 0`) can
    // never finish; retire it like an empty node rather than promote it.
    while (q.list.length > 0 && (!q.list[0].payload || q.list[0].payload.seq?.__wbg_ptr === 0)) {
      animationsDone(q, q.list[0].payload?.numAnims || 1);
    }
    const head = headMotion(q);
    if (head?.payload) {
      inst._unifiedSeq = head.payload;
      q.started = true;
    }
  }

  // The playhead finished the record it was given: retire it from the queue
  // (retail `AnimationDone`, once per finished animation) and promote the next.
  _unifiedOneShotFinished(inst, rec) {
    const q = inst._unifiedQueue;
    if (!q) return;
    if (headMotion(q)?.payload === rec) animationsDone(q, rec?.numAnims || 1);
    this._promoteUnifiedHead(inst);
  }

  // setMotion's preamble (see the comment at its call site): a gesture over a
  // finishing one-shot appends; anything else pre-empts the playhead AND drops
  // the pending tail, so a freed record is never left in the queue.
  _preemptUnifiedForMotion(inst, motionCommand) {
    if (!inst._unifiedSeq) return;
    // A held door/chest state link is owned by setMotion's door branch: a
    // re-broadcast of the held state must be a no-op (not a snap back to the
    // spawn state), and a real state change replaces it there.
    if (inst._unifiedSeq.stateHold && isDoorStateMotion(motionCommand >>> 0)) return;
    // A bare 0 / Stop is substituted to Ready inside setMotion; classify it
    // as the Ready it becomes. (ACE's non-PK windups put the action in the
    // forward slot, which the wasm filters to 0, so each windup arrives as
    // KIND_MOTION(0) + KIND_MOTION_ACTION; the mtClassFallback "walk" for a
    // bare 0 made that 0 cut the windup/gesture already playing.)
    const lowIn = (motionCommand >>> 0) & 0xffff;
    const incoming = (lowIn === 0 || lowIn === 0x0004 /* Stop */)
      ? "idle" : classifyMotionCommand(motionCommand >>> 0);
    // Bug 2 (2026-10-07): a one-shot that finishes on its own (an action,
    // a windup, a gesture, a transition link) is NEVER cut by an incoming
    // command, whatever its class. Retail's new cycle only does
    // `clear_physics` + `remove_cyclic_anims` (acclient.c:337737, :337796):
    // queued links and actions keep playing and the new link + cycle are
    // appended behind them (OpenAC CMotionTable.cs:193, :255); sidestep and
    // turn are modifiers on the sequence (CMotionTable.cs:341-366), not
    // replacements. Before this, every Q/E/A/D press (camera.js
    // `_dispatchLocalRigMotion`, client_events.js DriveApplied) freed the
    // cast windup on the playhead, so attack spells cast while moving never
    // animated. The deliberate cuts stay explicit: the forward-key anim-break
    // and fizzles free the one-shot in `cancelCastSequence`, death pre-empts in
    // its own branch.
    if (inst._unifiedSeq.clearOnDone) return;
    const ua = inst._unifiedSeq;
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[motion-cut] 0x${(inst.guid >>> 0).toString(16)} held one-shot cut by ` +
        `0x${(motionCommand >>> 0).toString(16)} (${incoming})`,
      );
    } catch (_) {}
    this._clearUnifiedQueue(inst); // frees every pending record except `ua`
    try { ua.seq.free(); } catch (_) { /* already freed */ }
    inst._unifiedSeq = null;
  }

  // Anything that pre-empts the playhead outright (death, despawn, a new
  // locomotion/stance command) drops the pending tail too — retail's
  // `HandleExitWorld` / `Destroy` both drain `pending_animations` the same way.
  _clearUnifiedQueue(inst) {
    const q = inst._unifiedQueue;
    if (!q) return;
    for (const n of q.list) {
      if (n.payload && n.payload !== inst._unifiedSeq) {
        try { n.payload.seq.free(); } catch (_) { /* already freed */ }
      }
    }
    inst._unifiedQueue = null;
  }

  // Door open/close always routes through the Rust authority (playDoorMotion).
  // Kept because index.html's kind=15 handler asks before calling it (its
  // false branch — the legacy instant root-rotation snap — is now unreachable).
  usesUnifiedDoor() { return true; }

  // Animation consolidation (docs/animation-audit §5 Step 3) / rev 2026-07-02:
  // play a door's real swing. Open = On (0x4000000b), close = Off (0x4000000c).
  // Routes through setMotion's door-state branch — retail order: play the
  // MotionTable LINK (the authored swing; On→Off is the same anim baked
  // reversed, door sounds ride its hooks) then hold the framerate-0 cycle.
  // Both triggers of a door change (the server Motion broadcast → setMotion,
  // and the SetState/ethereal flip → kind=15 → here) funnel into that ONE
  // branch, whose lastMotionCommand dedup makes the second trigger a no-op —
  // previously this path played the On/Off CYCLE as a unified one-shot, which
  // (a) raced the state link and (b) under the B5 full-range bake rendered a
  // closed door OPEN (the Off cycle baked the whole open anim; "stuck open").
  // stance 0 → the bake resolves default_style (doors key under NonCombat
  // 0x003D). @returns {Promise<boolean>} whether the door was handled (caller
  // falls back to the instant root-rotation snap on false).
  async playDoorMotion(guid, open) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return false;
    const cmd = open ? CMD_DOOR_ON : CMD_DOOR_OFF;
    await this.setMotion(guid >>> 0, cmd, 0, 1.0);
    return true;
  }

  // Drain a unified sequence's hook timeline (swoosh/chime/strike/footfall) by
  // the sequence's current frame-time, through the SHARED _fireHooksInRange.
  // Wrap-aware: for a looping cycle whose frame-time rolled back to a new loop,
  // fire the prior loop's tail (lastHookTime, end] then restart the window — so
  // a cycle's footfalls fire every loop. One-shots never wrap → the wrap branch
  // is inert. `ua` is the _unifiedSeq / _unifiedLoco record { seq, desc, hooks,
  // lastHookTime }.
  _drainUnifiedHooks(inst, ua) {
    if (!ua.hooks || !ua.hooks.length) return;
    const audioMgr = this.scene3d?.audioManager ?? null;
    const cache = this.scene3d?.soundTableCache ?? null;
    const gf = ua.seq.globalFrameIndex;
    const ft = ua.desc.frameTimes;
    const fr = +ua.desc.framerate || 0;
    const curT = (ft && gf < ft.length) ? ft[gf] : (fr > 0 ? gf / fr : 0);
    if (curT < ua.lastHookTime) {
      // Cycle wrapped: fire the tail of the prior loop, then restart at 0.
      const dur = +ua.desc.duration || (ft && ft.length ? ft[ft.length - 1] : 0);
      if (dur > ua.lastHookTime) {
        this._fireHooksInRange(inst, ua.hooks, ua.lastHookTime, dur, audioMgr, cache);
      }
      ua.lastHookTime = 0;
    }
    if (curT > ua.lastHookTime) {
      this._fireHooksInRange(inst, ua.hooks, ua.lastHookTime, curT, audioMgr, cache);
      ua.lastHookTime = curT;
    }
  }

  // The locomotion gait framerate scale (how fast to advance the cyclic
  // playhead) — the retired mixer path's setEffectiveTimeScale math: the
  // anti-ice-skating velScale (actual ground speed / authored cycle speed,
  // clamped [0.25,4.0]) composed with the server per-motion speed + backstep
  // sign. When no base speed (idle / velScale-absent), plays at motionSpeed.
  // One-shot playback tempo (2026-08-12). Retail scales an animation node's
  // FRAMERATE by the motion's speed — `AnimSequenceNode::multiply_framerate`
  // (acclient.c:340968-340979) is literally `framerate = multiplier * framerate`
  // — so a server motion carrying speed 2.0 plays its clip twice as fast. With a
  // fixed-dt playhead that is equivalent to advancing `dt * speed`.
  //
  // `inst._motionSpeed` is the broadcast `forward_speed` MAGNITUDE (set at the
  // setMotion site above; the sign rides `_motionSpeedSign`), so it is always
  // positive and safe to multiply by. It is captured at BUILD time, not read per
  // tick, because the mixer path it replaces also read it once when the action
  // started (`setEffectiveTimeScale`, the `swingSpeed` composition) — reading it
  // every tick would let a LATER locomotion broadcast change the tempo of a
  // swing already in flight. Assignment order makes this safe: `_motionSpeed` is
  // set before `_tryPlayLink` / `_tryUnifiedCycleOneShot` run.
  //
  // Why this exists: the `_unifiedSeq` branch advanced at raw `dt` and ignored
  // speed entirely, while its `_unifiedLoco` sibling scaled correctly. Measured
  // in-world 2026-08-12 — ACE broadcasts every cast gesture at speed 2.0
  // (`Player_Magic.cs:603 CastSpeed = 2.0f`), `inst._motionSpeed` read 2, and the
  // one completed gesture still took 0.796-0.847 s against an authored 0.7917 s
  // (0.93-0.99x) in 5/5 measurements — i.e. 1.0x, half the intended rate. This
  // governs melee/missile/death/door one-shots too, not just casts.
  _unifiedOneShotSpeed(inst) {
    const s = +(inst?._motionSpeed);
    return Number.isFinite(s) && s > 0 ? s : 1.0;
  }

  _unifiedLocoGaitScale(inst, base) {
    let scale;
    if (base > 0) {
      let actual = this._resolveStateGroundSpeed(inst);
      const fromGetter = Number.isFinite(actual) && actual > 0;
      if (!fromGetter) actual = inst._emaSpeed ?? 0;
      const velComp = cycleTimeScale(actual, base);
      // Getter path: velComp is the complete scale (motionSpeed already encoded,
      // matching the mixer tick). EMA fallback composes with motionSpeed.
      scale = fromGetter ? velComp : velComp * (inst._motionSpeed ?? 1.0);
    } else {
      scale = inst._motionSpeed ?? 1.0;
    }
    const signed = scale * (inst._motionSpeedSign ?? 1);
    // Guard against a zero/negative-at-rest stall (idle still needs to tick its
    // cycle); fall back to native rate on a non-finite result.
    return Number.isFinite(signed) && signed !== 0 ? signed : 1.0;
  }

  // WS01 (2026-07-12) — cheap link-miss / reliability counters. WS16 owns the
  // final `window.__diag.cast` schema; this lazy-inits and merges so multiple
  // workstreams can attach. Diag-only (no flag).
  _castDiag(field) {
    try {
      if (typeof window === "undefined") return;
      const d = (window.__diag || (window.__diag = {}));
      const c = (d.cast || (d.cast = { attempts: 0, linkOrStanceMiss: 0, busyDropped: 0, echoSwallowed: 0 }));
      c[field] = (c[field] | 0) + 1;
    } catch (_) { /* diag must never break casting */ }
  }

  // WS01 (2026-07-12) — pre-bake every clip a cast chain will need so the
  // per-gesture setSwingMotion hits a warm, promise-keyed cache (animation.js
  // AnimationCache.get) instead of racing a cold bake against a 50ms sleep. Uses
  // the SAME (setupId, mtableId, resolvedCommand, CAST_MAGIC_STANCE, fromMotion:
  // Ready, subs) key the cast-path setSwingMotion will use, so the entries are
  // reused verbatim. Await-capped so a slow/hung bake never blocks casting.
  async _prefetchCastClips(guid, seq) {
    const inst = this.entityMap.get(guid >>> 0);
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (!inst || typeof fetchKeyframes !== "function" || !this.animationCache) return;
    const setupId  = (inst.meta?.modelId ?? inst.meta?.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
    const opts = {
      modelChanges:   inst.meta?.modelChanges ?? new Uint32Array(0),
      textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
      paletteId:      (inst.meta?.paletteId ?? 0) >>> 0,
      paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
      fromMotion: READY_SUBSTATE,
    };
    const gestures = [...(seq.windupGestures || [])];
    if (seq.castGesture) gestures.push(seq.castGesture);
    const toU32 = (m) => {
      if (typeof m === "number") return m >>> 0;
      const s = String(m); const p = (s.startsWith("0x") || s.startsWith("0X")) ? parseInt(s, 16) : parseInt(s, 10);
      return Number.isFinite(p) && p >= 0 ? (p >>> 0) : 0;
    };
    const warms = [];
    for (const gz of gestures) {
      const c = window.__classifyMotionCommandTyped?.(mtableId, CAST_MAGIC_STANCE, toU32(gz.motion));
      if (c && c.source === "wasm-link" && (c.resolvedCommand >>> 0) !== 0) {
        warms.push(this.animationCache.get(setupId, mtableId, c.resolvedCommand >>> 0, CAST_MAGIC_STANCE, fetchKeyframes, opts).catch(() => {}));
      }
    }
    if (!warms.length) return;
    // Cap so a hung bake never blocks casting (~200ms is imperceptible vs a ~2s cast).
    await Promise.race([Promise.all(warms), new Promise((r) => setTimeout(r, 200))]);
  }

  /**
   * @param {number} guid
   * @param {number} motionCmd
   * @param {{ speed?: number, stance?: number }} [opts]
   *   Plays the gesture as a full-body one-shot on the Rust playhead
   *   (queued behind an in-flight gesture). `opts.speed` paces it
   *   (multiplies the server per-motion speed). The retired mixer-only
   *   `holdAtPeak` option is ignored (no caller passed it).
   *   `opts.stance` (WS01) pins the MotionTable link lookup stance; a
   *   falsy/absent value falls through to the entity's derived stance.
   */
  async setSwingMotion(guid, motionCmd, opts) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // WS01: a caller may pin the stance (the cast chain always uses Magic 0x0049)
    // so a stale `inst.currentStance` (e.g. NonCombat, which carries NO magic
    // gestures — DAT-verified vs player MT 0x09000001) can't make the from-Ready
    // link lookup silently miss. A falsy/absent opts.stance falls through to the
    // existing derivation, so every non-cast caller is byte-identical.
    const stance =
      (((opts && opts.stance) ? (opts.stance >>> 0) : 0) ||
       ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0)) >>> 0;
    const setupId = (inst.meta?.modelId ?? inst.meta?.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
    const result = classifyMotionCommandTyped(mtableId, stance, motionCmd >>> 0);
    // CMT Wave 2 / Phase 5 (2026-05-26): removed the `isHuman` gate
    // that previously short-circuited non-human rigs to the
    // setSwingPose tween (which itself early-returns on non-humans →
    // drudges silently played nothing). The motion-table classifier
    // (`classifyMotionCommandTyped`) works for any rig — monster
    // motion tables expose swings under NonCombat stance and the
    // wasm-side `lookupMotionLinkForSwing` returns the same
    // typed-anim envelope regardless of rig topology. The downstream
    // `animationCache.get` path also accepts any setupId, so once a
    // valid `swing/cast` clip resolves we play it on whatever rig
    // the entity has. setSwingPose is still the fallback for the
    // (rare) case where the motion table has no link entry for the
    // requested (stance, cmd) — humanoids get the legacy tween,
    // non-humans silently no-op which preserves prior behaviour.
    // See `docs/swing-classification-spec-2026-05-19.md` §8.2.
    const canPlayReal =
      result &&
      (result.kind === "swing" || result.kind === "cast") &&
      (result.resolvedCommand >>> 0) !== 0 &&
      result.source === "wasm-link";
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    // WS16 diag: record the link outcome per (stance, gesture-id). Miss-reason
    // is derived from the same predicate the play-gate uses — no behavior change.
    try {
      if (window.__diag?.cast?.onLinkResolve) {
        let reason = null;
        if (canPlayReal && typeof fetchKeyframes === "function") reason = null;         // hit (pending fetch)
        else if (!stance) reason = "stance-falsy";
        else if (result?.source !== "wasm-link") reason = "not-wasm-link";
        else if (result?.kind !== "swing" && result?.kind !== "cast") reason = "kind-mismatch";
        else if ((result?.resolvedCommand >>> 0) === 0) reason = "resolved-zero";
        else if (typeof fetchKeyframes !== "function") reason = "no-fetchKeyframes";
        window.__diag.cast.onLinkResolve({
          guid: g, cmd: (motionCmd >>> 0), stance, mtableId,
          outcome: (canPlayReal && typeof fetchKeyframes === "function") ? "hit" : "miss",
          reason,
        });
      }
    } catch (_) {}
    if (!canPlayReal || typeof fetchKeyframes !== "function") {
      // Missile / aim-level fire is a CYCLE (class 0x40) the links-only gate
      // above can't resolve: route it through the Rust authority on the cycle
      // bake (full-body, retail-faithful). Only diverts when a real cycle
      // resolves; otherwise no gesture plays.
      if (await this._tryUnifiedCycleOneShot(g, setupId, mtableId, motionCmd >>> 0, stance)) {
        return;
      }
      // WS-B teardown (2026-06-18): the setSwingPose vibe-pose fallback was
      // removed — the Rust motion authority (unifiedMotion default-on) is the
      // swing path; when no real MotionTable link/clip resolves, the entity
      // now plays NO gesture (the pose was a placeholder), matching the
      // non-human silent-no-op that already applied.
      return;
    }
    const resolvedCmd = result.resolvedCommand >>> 0;
    let entry;
    try {
      entry = await this.animationCache.get(
        setupId,
        mtableId,
        resolvedCmd,
        stance,
        fetchKeyframes,
        {
          modelChanges: inst.meta?.modelChanges ?? new Uint32Array(0),
          textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
          paletteId: (inst.meta?.paletteId ?? 0) >>> 0,
          paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
          fromMotion: READY_SUBSTATE,
        },
      );
    } catch (_) {
      // WS-B teardown (2026-06-18): the setSwingPose vibe-pose fallback was
      // removed — the Rust motion authority (unifiedMotion default-on) is the
      // swing path; when no real MotionTable link/clip resolves, the entity
      // now plays NO gesture (the pose was a placeholder), matching the
      // non-human silent-no-op that already applied.
      return;
    }
    if (!this.entityMap.has(g)) return;
    const clip = entry?.clip;
    if (!clip) {
      // WS-B teardown (2026-06-18): the setSwingPose vibe-pose fallback was
      // removed — the Rust motion authority (unifiedMotion default-on) is the
      // swing path; when no real MotionTable link/clip resolves, the entity
      // now plays NO gesture (the pose was a placeholder), matching the
      // non-human silent-no-op that already applied.
      return;
    }
    // The gesture is a full-body one-shot on the Rust playhead, queued behind
    // any gesture already in flight (J5 pending_animations); when the queue
    // drains the tick falls back to the `_unifiedLoco` cycle. The server
    // per-motion speed (`inst._motionSpeed`, retail `Framerate *= speed`)
    // composes with `opts.speed` (e.g. the cast chain at ACE CastSpeed=2.0).
    const MS = _motionSequenceClass();
    const d = entry?.sequenceDescriptor;
    if (!MS || !d) return; // stale pkg / no descriptor → no gesture (like a link miss)
    const seq = MS.fromDescriptor(
      d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
      d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
      false,
    );
    if (!seq) return;
    const optSpeed = +(opts?.speed) > 0 ? +opts.speed : 1.0;
    const rec = { seq, desc: d, clearOnDone: true, hooks: entry.hooks || null, lastHookTime: -1,
      speed: this._unifiedOneShotSpeed(inst) * optSpeed };
    this._enqueueUnifiedOneShot(inst, resolvedCmd, (d.segmentCounts?.length || 1), rec);
    console.log(
      "[entities/swingMotion] guid=0x" + g.toString(16) +
      " cmd=0x" + (motionCmd >>> 0).toString(16) +
      " anim=" + result.animId +
      " dur=" + (Number.isFinite(+result.durationSec) ? (+result.durationSec).toFixed(2) : "0.00") + "s",
    );
  }

  /**
   * A5-P2 (`?tweenClock=dt`) — the single clock read for the pose-tween
   * tickers (`_tickJumpPoseTween` / `_tickScaleHookTween`; swing/cast pose
   * tickers retired in the WS-B teardown) and their `startMs` stamp sites. Flag on →
   * the accumulated-dt clock advanced in `tick(dt)` (one clock domain with
   * the mixers, retail's single-quantum contract, acclient.c:340659-340780);
   * flag off → `performance.now()`, byte-identical to the legacy wall-clock
   * behavior. Stamp sites MUST use this too: mixing a wall-clock `startMs`
   * with a dt-clock `nowMs` would corrupt the tween phase.
   */
  _tweenNowMs() {
    if (TWEEN_CLOCK_DT) return this._tweenClockMs;
    return typeof performance !== "undefined" ? performance.now() : 0;
  }

  /**
   * Wave 1.7 (2026-05-26) — per-frame advance of the jump-pose tween.
   * Called from `tick` after `mixer.update` so our slerp wins for the
   * locked parts. Ease-out cubic on the human path (snaps quickly out
   * of walking pose, settles into airborne); same easing on generic
   * for consistency.
   */
  _tickJumpPoseTween(inst, nowMs) {
    const tween = inst._jumpPoseTween;
    if (!tween) {
      // Wave 3 / I6 fix (2026-05-28) — stuck-airborne timeout. When the
      // takeoff tween completes we stash `_airborneStablishedMs`. If
      // no kind=18 (airborne=0) packet arrives within
      // MAX_STUCK_AIRBORNE_MS, force-land manually so a dropped touch-
      // down packet doesn't strand the entity in arms-up forever.
      // Threshold is generous (8s) — most jumps land within 1.5s; we
      // only want to catch the genuinely-broken case, not interrupt
      // long arc jumps off cliffs.
      if (inst._isAirborne && inst._airborneStablishedMs != null) {
        const MAX_STUCK_AIRBORNE_MS = 8000;
        const ageMs = nowMs - inst._airborneStablishedMs;
        if (ageMs > MAX_STUCK_AIRBORNE_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/I6] stuck-airborne timeout (${(ageMs / 1000).toFixed(1)}s) — force-landing`
          );
          inst._airborneStablishedMs = null;
          inst._isAirborne = false;
          if (inst._jumpPoseStash) {
            this._clearHumanJumpPose(inst);
          } else if (inst.airborneTilt) {
            this._clearGenericJumpPose(inst);
          }
        }
      }
      return;
    }
    const t = (nowMs - tween.startMs) / tween.durationMs;
    const clampedT = Math.max(0, Math.min(1, t));
    // Ease-out cubic: 1 - (1-t)^3. Snappier than linear, gentler
    // than ease-out quintic.
    const eased = 1 - (1 - clampedT) * (1 - clampedT) * (1 - clampedT);

    if (tween.kind === "human") {
      for (const [partIdx, fromQ] of tween.from) {
        const toQ = tween.to.get(partIdx);
        if (!toQ) continue;
        const p = inst.parts && inst.parts[partIdx];
        if (p) p.quaternion.slerpQuaternions(fromQ, toQ, eased);
      }
    } else if (tween.kind === "generic") {
      // Tilt: slerp identity quat ↔ tilt quat, multiply into root.
      // We re-derive root.quaternion from the position-frame quat
      // every setPose call, so apply the tween every tick.
      //
      // `tweenQ` is NOT pooled — it's assigned directly to
      // `inst.airborneTilt` and read by `setPose` on every subsequent
      // position update until the tween ends or the entity lands.
      // Pooling the slerp result would corrupt the stored tilt the
      // moment any other entity's tween advanced. The identity
      // sentinel on the next line IS pooled (`_IDENTITY_QUAT`,
      // read-only) since `.equals(...)` only reads it.
      const tweenQ = new THREE.Quaternion().slerpQuaternions(
        tween.fromTilt,
        tween.toTilt,
        eased,
      );
      // Store as airborneTilt so setPose can re-apply on position
      // updates (read by `EntityInstance.setPose`).
      inst.airborneTilt = tweenQ.equals(_IDENTITY_QUAT)
        ? null
        : tweenQ;
      if (inst.airborneTilt) {
        inst.root.quaternion.multiply(tweenQ);
      }
      // Scale: simple lerp of the fraction, applied THROUGH the entity's
      // authored base scale so scaled creatures keep their size mid-jump.
      // #9: base defaults to 1 → scale.set(1, 1, scaleZ) (byte-identical).
      const base = inst._baseScale || 1.0;
      const scaleZ = tween.fromScale + (tween.toScale - tween.fromScale) * eased;
      inst.root.scale.set(base, base, base * scaleZ);
    }

    if (clampedT >= 1) {
      if (tween.isLanding) {
        if (tween.kind === "human") {
          inst._jumpPoseStash = null;
        } else {
          inst.airborneTilt = null;
        }
      } else {
        // Tween-in complete. (The human path used to pause the mixer
        // action here; the playhead keeps cycling and the tween's per-part
        // slerp — applied after the pose — owns the locked parts.)
        if (tween.kind !== "human") {
          inst.airborneTilt = tween.toTilt.clone();
        }
        // Wave 3 / I6 fix (2026-05-28) — record when takeoff stabilised
        // so the stuck-airborne timeout in the no-tween branch can fire
        // if a kind=18 (airborne=0) packet is dropped en route.
        inst._airborneStablishedMs = nowMs;
      }
      inst._jumpPoseTween = null;
    }
  }

  // _tickSwingTween / _tickCastTween (per-frame advance of the swing/cast
  // vibe-pose tweens) RETIRED 2026-06-18 (WS-B teardown) along with
  // setSwingPose/setCastPose — nothing assigns _swingTween/_castTween anymore.
  // (_tickJumpPoseTween above is KEPT — jump arms-up is retail-correct.)

  /**
   * T11 — resolve a locomotion cycle's authored ground speed
   * (`|MotionData.velocity|`, m/s) via the wasm `cycleBaseSpeed` export and
   * stash it on the entity so `tick()` can scale playback to actual ground
   * travel. Memoised by cacheKey across entities. Stores `inst._locoBaseSpeed`
   * only if the cycle is still the entity's active loco cycle when the (async)
   * fetch resolves. No-op without the export (older wasm).
   */
  async _resolveCycleBaseSpeed(inst, mtableId, stance, cmd, cacheKey) {
    const fn = this.wasmExports?.cycleBaseSpeed;
    if (typeof fn !== "function") return;
    let bs = this._cycleBaseSpeedCache.get(cacheKey);
    if (bs === undefined) {
      try {
        bs = await fn(mtableId >>> 0, stance >>> 0, cmd >>> 0);
      } catch (_) {
        bs = 0;
      }
      if (!Number.isFinite(bs) || bs < 0) bs = 0;
      this._cycleBaseSpeedCache.set(cacheKey, bs);
    }
    if (inst._locoCycleKey === cacheKey) inst._locoBaseSpeed = bs;
  }

  /**
   * OMEGA (2026-06-06) — resolve a cycle's authored MotionData.omega (rad/s)
   * via the wasm `cycleOmega` export and stash it so `_tickHookOmega` can spin
   * the rig continuously while the cycle plays (e.g. an authored spinning
   * sign/fan idle cycle). Memoised by cacheKey. Stores `inst._cycleOmega` only
   * if the cycle is still the entity's active omega cycle when the (async) fetch
   * resolves. `null` when the cycle has no omega (the common case) or without
   * the export (older wasm). Only reached when `?cycleOmega=on`.
   */
  async _resolveCycleOmega(inst, mtableId, stance, cmd, cacheKey) {
    const fn = this.wasmExports?.cycleOmega;
    if (typeof fn !== "function") return;
    let o = this._cycleOmegaCache.get(cacheKey);
    if (o === undefined) {
      try {
        const a = await fn(mtableId >>> 0, stance >>> 0, cmd >>> 0);
        o =
          a && a.length === 3 && (a[0] || a[1] || a[2])
            ? { x: a[0], y: a[1], z: a[2] }
            : null;
      } catch (_) {
        o = null;
      }
      this._cycleOmegaCache.set(cacheKey, o);
    }
    if (inst._cycleOmegaKey === cacheKey) inst._cycleOmega = o;
  }

  /**
   * T1: resolve the entity's current 'actual' ground anim-speed (m/s) from
   * the wasm `stateGroundSpeed` getter — a synchronous pure-math mirror of
   * retail `CMotionInterp::get_state_velocity` (acclient.c:343539). It consumes
   * the interpreted motion-state scalars stashed by `setMotion` /
   * `setSidestepLayer` (forward_command/forward_speed + sidestep_command/
   * sidestep_speed) plus a player run_rate, and returns the FINAL m/s with
   * run_rate ALREADY applied internally (clamped to run_rate*4.0). The caller
   * feeds the result directly into `cycleTimeScale(actual, base)` and must NOT
   * re-scale by run_rate.
   *
   * Returns a finite positive number on success, or `null` when the getter is
   * absent (older wasm bundle) or no motion command is stashed — letting tick()
   * fall back to the legacy XZ-position-delta EMA.
   *
   * run_rate comes from the optional `playerRunRate` getter (holtburger-world
   * `run_rate_from_skill_and_burden` surfaced to wasm); defaults to 1.0 (the
   * retail no-weenie seed) when that getter isn't present so encumbrance/
   * run-skill simply don't modulate the gait yet rather than breaking it.
   */
  _resolveStateGroundSpeed(inst) {
    const fn = this.wasmExports?.stateGroundSpeed;
    if (typeof fn !== "function") return null;
    const fwdCmd = inst._forwardCommand >>> 0;
    const sideCmd = inst._sidestepCommand >>> 0;
    // Nothing to scale from until a forward or sidestep command has been
    // stashed — let the EMA cover the gap (e.g. just-spawned, idle).
    //
    // Issue 4 (2026-06-03): _sidestepCommand is populated ONLY by
    // setSidestepLayer (the additive 0.5-weight sidestep blend). The local
    // player rig's camera-driven dispatch (scene3d/camera.js
    // _dispatchLocalRigMotion) DOES call setSidestepLayer under the default-ON
    // `?localRigCombo` (F15-3: independent forward + sidestep slots), so
    // _sidestepCommand is set for a camera-dispatched strafe. Only the legacy
    // `?localRigCombo=off` single-clip lane routes a PURE strafe through
    // setMotion as the FORWARD command without calling setSidestepLayer; there
    // fwdCmd is a SideStep* code with no forward run/walk speed to scale, this
    // can return null and tick() falls back to the rig-XZ EMA — HARMLESS, since
    // sidestep |velocity|≈0 makes the EMA-derived cycleTimeScale a no-op.
    if (fwdCmd === 0 && sideCmd === 0) return null;
    const fwdSpeed = Number.isFinite(inst._forwardSpeed) ? inst._forwardSpeed : 0;
    const sideSpeed = Number.isFinite(inst._sidestepSpeed) ? inst._sidestepSpeed : 0;
    // F3-4/F3-5 run-rate source. The state-velocity getter clamps to
    // `run_rate * 4.0`, so the run rate sets each mover's top speed and thus
    // its gait tempo. Pre-fix EVERY rig used the LOCAL player's
    // skill/burden-derived `playerRunRate`, so a whole field of mobs animated
    // at YOUR tempo and shifted with YOUR buffs (F3-5). Use the per-entity
    // rate instead for non-local rigs: the creature's own `run_rate` from its
    // MoveTo (stashed on `inst._runRate`), or a neutral 1.0 when none has
    // arrived — never the local player's rate. The local player rig keeps
    // `playerRunRate` (it IS the local player).
    let runRate = 1.0;
    if (this._isLocalPlayerGuid(inst.guid >>> 0)) {
      const rrFn = this.wasmExports?.playerRunRate;
      if (typeof rrFn === "function") {
        try {
          const rr = +rrFn();
          if (Number.isFinite(rr) && rr > 0) runRate = rr;
        } catch (_) { /* keep the 1.0 seed */ }
      }
    } else if (Number.isFinite(inst._runRate) && inst._runRate > 0) {
      runRate = inst._runRate;
    }
    let v;
    try {
      v = +fn(fwdCmd, fwdSpeed, sideCmd, sideSpeed, runRate);
    } catch (_) {
      return null;
    }
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * COL-20/F4 — angle (rad) between the RENDERED heading and the current
   * server heading target. Returns 0 when no target is armed (just spawned,
   * `?headingSnap=on`, local player, omega/jump owns the quaternion) so the
   * turn gate fails OPEN: no target ⇒ no turn phase ⇒ locomotion starts
   * immediately, exactly as before this gate existed.
   */
  _headingErrorRad(inst) {
    if (!inst || !inst.root || !inst._headingEaseInit || !inst._serverTargetQuat) {
      return 0;
    }
    return inst.root.quaternion.angleTo(inst._serverTargetQuat);
  }

  /**
   * Update motion command/stance. Triggers async fetch + crossFade
   * to a new action when needed. Idempotent: already-playing
   * (cmd, stance) is a no-op.
   *
   * STOP / non-locomotion commands fade out the current action, leaving
   * the rig at rest pose.
   *
   * Render-completeness Waves-2 A1 (2026-05-29): `motionSpeed` is the
   * server's per-motion playback speed (`UpdateMotion.forward_speed`,
   * default `1.0`). Retail scales the active sequence's animation
   * framerate by it (`Framerate *= speed`, ACE `AnimData.cs:17`; retail
   * `AnimSequenceNode::multiply_framerate` `acclient.c:340978`), so
   * hasted / slowed / quickness-modified entities animate at the
   * server's tempo. Stored on `inst._motionSpeed` and MULTIPLIED INTO
   * the cycle's `setEffectiveTimeScale` — composing with (not clobbering)
   * the `?velScale=on` T11 velocity-scale path (see `tick()` ~L6343).
   */
  // Bug 15 (2026-10-07): motions that arrive while a rig's spawn is in
  // flight. Keeps the LATEST base command (locomotion / idle / stance) and up
  // to SPAWN_MOTION_STASH_ACTIONS recent actions (swings, windups, emotes).
  _stashSpawnMotion(guid, motionCommand, motionStance, motionSpeed) {
    if (!this._spawnMotionStash) this._spawnMotionStash = new Map();
    let st = this._spawnMotionStash.get(guid);
    if (!st) {
      st = { base: null, actions: [] };
      this._spawnMotionStash.set(guid, st);
    }
    const rec = {
      cmd: motionCommand >>> 0,
      stance: motionStance >>> 0,
      speed: motionSpeed,
      at: performance.now(),
    };
    const c = classifyMotionCommand(rec.cmd);
    if ((c === "attack" || c === "cast") && !isSubstateCastGesture(rec.cmd)) {
      st.actions.push(rec);
      if (st.actions.length > SPAWN_MOTION_STASH_ACTIONS) st.actions.shift();
    } else {
      st.base = rec;
    }
  }

  // Replay what `_stashSpawnMotion` kept, once the rig is in `entityMap`.
  // Actions older than SPAWN_MOTION_STASH_MAX_AGE_MS are dropped: by then the
  // swing they animate has already resolved on the server.
  _replaySpawnMotions(guid) {
    const st = this._spawnMotionStash?.get(guid);
    if (!st) return;
    this._spawnMotionStash.delete(guid);
    const now = performance.now();
    let replayed = 0;
    let dropped = 0;
    if (st.base) {
      this.setMotion(guid, st.base.cmd, st.base.stance, st.base.speed);
      replayed++;
    }
    for (const a of st.actions) {
      if (now - a.at > SPAWN_MOTION_STASH_MAX_AGE_MS) {
        dropped++;
        continue;
      }
      this.setMotion(guid, a.cmd, a.stance, a.speed);
      replayed++;
    }
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[motion-drop] 0x${(guid >>> 0).toString(16)} spawn in flight: replayed ${replayed}, ` +
        `dropped ${dropped} stale action(s)` +
        (st.base ? ` (base 0x${st.base.cmd.toString(16)} st=0x${st.base.stance.toString(16)})` : ""),
      );
    } catch (_) {}
  }

  setMotion(guid, motionCommand, motionStance, motionSpeed = 1.0) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) {
      // Bug 15 (2026-10-07): a motion for a rig still being built used to be
      // dropped (the rig is only registered at the END of `_spawnImpl`, after
      // its bakes). Right after login every nearby monster is mid-spawn, so
      // their first chase/swing broadcasts vanished. Stash them; `_spawnImpl`
      // replays them once the rig commits.
      if (this.spawnInFlight?.has(guid >>> 0)) {
        this._stashSpawnMotion(guid >>> 0, motionCommand, motionStance, motionSpeed);
      }
      return Promise.resolve();
    }
    {
      // Bug 15: stamp a server swing/cast when it ARRIVES, not when its bake
      // finishes, so the damage-event swing guess (client_events.js, now
      // opt-in) and the LOD-respawn guard see it at once.
      const c = classifyMotionCommand(motionCommand >>> 0);
      if (c === "attack" || c === "cast") {
        const now = performance.now();
        inst._lastServerSwingMs = now;
        inst._lastCombatMotionMs = now;
      }
      // Bug 19 (2026-10-07): off the ground the interpreted movement keeps
      // Falling on the sequence; locomotion commands (held keys, the
      // server's echo) only update the state that touchdown re-applies
      // (acclient.c:343987-344013, :344429). Death and actions still play.
      if (inst._isAirborne && !JUMP_POSE_OVERLAY) {
        const low = (motionCommand >>> 0) & 0xffff;
        const loco = low === 0 || low === CMD_LOW_READY || low === CMD_LOW_STOP ||
          c === "walk" || c === "run" || c === "idle";
        if (loco && low !== CMD_LOW_FALLING && low !== CMD_LOW_DEAD) {
          inst._groundMotion = {
            cmd: motionCommand >>> 0,
            stance: (motionStance >>> 0) || inst._groundMotion?.stance || 0,
            speed: motionSpeed,
          };
          return Promise.resolve();
        }
      }
    }
    // 2026-10-05 cast regression (fb58331a): a final cast gesture is a held
    // SUBSTATE whose link + cycle commit in one step AFTER their bakes resolve,
    // token-gated like any cycle. ACE sends the closing Ready ~0.35 s after the
    // gesture (Player_Magic.cs FinishCast; the gesture's link length at
    // CastSpeed 2.0), and loop.js / setLocalStance / the cmdInterp Ready lane
    // can issue one too. Whenever the gesture's bake was still in flight (cold
    // cache, LRU eviction, a busy bake queue), that Ready bumped the token, the
    // gesture commit was dropped, and the Ready itself dedupe-returned against
    // the unchanged Ready cycle: no raise, no hold, no recoil. The old action
    // path was never token-gated, so it always played. Retail cannot lose it
    // either: the gesture is appended to the sequence the moment its motion is
    // applied (GetObjectSequence, acclient.c:337748), and the Ready that follows
    // builds on top of it. So a Ready/Stop arriving while a gesture commit is
    // pending WAITS for it, then plays the gesture→Ready recoil link.
    const low = (motionCommand >>> 0) & 0xffff;
    const idleClass = low === CMD_LOW_READY || low === CMD_LOW_STOP || low === 0;
    if (!idleClass) {
      const c = classifyMotionCommand(motionCommand >>> 0);
      // Action one-shots (windups, swings, emotes) queue on top of whatever
      // base cycle commits; they never supersede a waiting Ready.
      if (!((c === "attack" || c === "cast") && !isSubstateCastGesture(motionCommand))) {
        inst._motionIssueSeq = ((inst._motionIssueSeq | 0) + 1) | 0;
      }
    } else {
      inst._motionIssueSeq = ((inst._motionIssueSeq | 0) + 1) | 0;
    }
    const pending = inst._castGesturePending;
    if (idleClass && pending) {
      return this._setMotionAfterCastGesture(inst, pending, guid, motionCommand, motionStance, motionSpeed);
    }
    const p = this._setMotionImpl(guid, motionCommand, motionStance, motionSpeed);
    if (isSubstateCastGesture(motionCommand)) {
      const tracked = p.catch(() => {}).then(() => {
        if (inst._castGesturePending === tracked) inst._castGesturePending = null;
      });
      inst._castGesturePending = tracked;
    }
    return p;
  }

  // A Ready/Stop that arrived while a cast gesture's commit was pending: wait
  // for that commit (capped, so a hung bake cannot wedge the rig), then apply
  // the Ready unless a newer base command was issued meanwhile.
  async _setMotionAfterCastGesture(inst, pending, guid, motionCommand, motionStance, motionSpeed) {
    const issue = inst._motionIssueSeq;
    let timer = 0;
    await Promise.race([
      pending,
      new Promise((r) => { timer = setTimeout(r, CAST_GESTURE_COMMIT_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (this.entityMap.get(guid >>> 0) !== inst) return;
    if (inst._motionIssueSeq !== issue) return; // superseded while waiting
    return this._setMotionImpl(guid, motionCommand, motionStance, motionSpeed);
  }

  async _setMotionImpl(guid, motionCommand, motionStance, motionSpeed = 1.0) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    // COL-10 clip half (2026-07-27) — retail CMotionInterp::adjust_motion
    // (acclient.c:343776): WalkBackwards (0x45000006) is NEVER resolved
    // against the MotionTable — no `cycles[(stance, 0x0006)]` entry exists
    // (player MT 0x09000001 dump-verified ABSENT). Retail rewrites the
    // command to WalkForward with `speed *= -0.64999998` BEFORE the state
    // machine looks, and the negative speed_mod plays the walk cycle in
    // REVERSE (negative frame_quantum, CSequence::update_internal
    // acclient.c:340730; hooks fire dir=-1). Ours passed 0x45000006 through
    // to the cycle bake -> 0-frame miss -> the `!clip -> fadeOutCurrent`
    // branch below -> idle/rest pose while the body backsteps at 2.028 m/s.
    // Convert at this single setMotion boundary so the local input dispatch
    // (index.html:8922/:9917) and any wire delivery both get the retail clip.
    // Direction rides `_motionSpeedSign` (reverse playback), magnitude rides
    // `_motionSpeed` (0.65 x walk framerate — retail change_cycle_speed).
    if (((motionCommand >>> 0) & 0xffff) === CMD_LOW_WALK_BACKWARDS) {
      motionCommand = 0x45000005; // WalkForward, full 32-bit command
      const sIn = +motionSpeed;
      motionSpeed =
        -0.64999998 * (Number.isFinite(sIn) && sIn !== 0 ? Math.abs(sIn) : 1.0);
    }
    // 2026-10-05: SideStepLeft → SideStepRight with NEGATED speed (retail
    // adjust_motion, acclient.c:343746) — the later Left→Right remap alone
    // kept the speed positive, so a left strafe played the right cycle.
    if (((motionCommand >>> 0) & 0xffff) === CMD_LOW_SIDESTEP_LEFT) {
      const sIn = +motionSpeed;
      motionCommand = (((motionCommand >>> 0) & 0xffff0000) | CMD_LOW_SIDESTEP_RIGHT) >>> 0;
      motionSpeed = -(Number.isFinite(sIn) && sIn !== 0 ? Math.abs(sIn) : 1.0);
    }
    // 2026-10-07: TurnLeft likewise → TurnRight with NEGATED speed (the same
    // adjust_motion arm, acclient.c:343746 `*motion = 0x6500000D; *speed *=
    // -1`), so a left turn plays the right-turn cycle in REVERSE. The later
    // Left→Right remap kept the speed positive: a left turn stepped the
    // right-turn footwork.
    if (((motionCommand >>> 0) & 0xffff) === CMD_LOW_TURN_LEFT) {
      const sIn = +motionSpeed;
      motionCommand = (((motionCommand >>> 0) & 0xffff0000) | CMD_LOW_TURN_RIGHT) >>> 0;
      motionSpeed = -(Number.isFinite(sIn) && sIn !== 0 ? Math.abs(sIn) : 1.0);
    }
    // CQ-06 (2026-07-27) — death-hold guard, retail refusal semantics. Once a
    // sequence is in the Dead substate, retail REFUSES motions with no path
    // out of it: the player MT has NO `links[(stance, Dead)]` (dump-verified,
    // 0x09000001) so CMotionTable::GetObjectSequence returns 0, and
    // StopSequenceMotion returns 0 unless the stopped motion IS the current
    // substate (acclient.c:337928) — a corpse's Dead cycle (framerate 0,
    // frozen) simply persists. Our pre-fix code freed the death hold below
    // for ANY late broadcast (a trailing Stop, a Death-category emote or
    // reaction one-shot), after which the tick fell back to mixer.update()
    // with the pre-death idle/walk action still installed -> "corpses flicker
    // back to idle after death animation". Refuse everything except an
    // explicit revival locomotion/idle cycle (Ready / WalkForward /
    // RunForward — what ACE broadcasts at resurrect); dead creatures never
    // receive one and are removed on the death clock (`_deathEndAt`).
    {
      const heldDead =
        (inst._unifiedSeq && inst._unifiedSeq.deathHold === true) ||
        ((inst.lastMotionCommand ?? 0) & 0xffff) === CMD_LOW_DEAD;
      if (heldDead) {
        const lowIn = (motionCommand >>> 0) & 0xffff;
        const isRevival =
          lowIn === CMD_LOW_READY ||
          lowIn === CMD_LOW_WALK_FORWARD ||
          lowIn === CMD_LOW_RUN_FORWARD;
        if (!isRevival) return; // refused — the death pose holds (retail parity)
      }
    }
    // A new locomotion/stance/motion command ends any in-progress unified
    // sequence (swing override, or a death hold on resurrect/correction) so
    // movement stays responsive.
    //
    // OpenAC comparison 2026-10-04 (combat P0-1): this used to free the
    // playhead for EVERY command — including the next swing/cast gesture — but
    // left the freed record at the head of `_unifiedQueue`. The gesture routed
    // below then queued behind it, `_promoteUnifiedHead` promoted the freed
    // record, its `advance()` threw every tick, and the entity's gestures were
    // wedged until the next locomotion command. Now:
    //   * a gesture over a finishing (clearOnDone) one-shot APPENDS — retail
    //     `add_to_queue`, the J5 design — instead of cutting it;
    //   * anything that does pre-empt drops the pending tail with it, so no
    //     freed record can ever be promoted.
    this._preemptUnifiedForMotion(inst, motionCommand);
    // 2026-10-05: an ACTION's speed (a 0x10-class swing or windup, e.g. ACE
    // CastSpeed 2.0) scales only that action's link. Retail AddMotion(link,
    // speed) re-adds the base cycle at the unchanged substate speed
    // (acclient.c:337803; OpenAC CMotionTable.cs:296-298). Stashing it in
    // `_motionSpeed` sped up the Ready idle that followed (2x breathing
    // between windups) until the next locomotion command reset it.
    let actionSpeed = 0;
    {
      const c0 = classifyMotionCommand(motionCommand >>> 0);
      if ((c0 === "attack" || c0 === "cast") && !isSubstateCastGesture(motionCommand)) {
        const s0 = +motionSpeed;
        actionSpeed = Number.isFinite(s0) && s0 > 0 ? s0 : 1.0;
      }
    }
    // A1: stash the playback speed (fail-soft to 1.0 for non-finite /
    // non-positive). Read by the locomotion timeScale composition below
    // and by the per-frame T11 velScale tick.
    if (!actionSpeed) {
      const ms = +motionSpeed;
      // COL-10 clip half — keep the backstep MAGNITUDE. The old
      // `ms > 0 ? ms : 1.0` clamp threw |−0.65| away for negative speeds, so
      // a reversed walk cycle played at full forward-walk rate (feet ~54%
      // fast vs the 2.028 m/s body). Retail multiplies the cycle framerate by
      // the SIGNED speed_mod (change_cycle_speed, acclient.c:337269, applied at :337775); we
      // split it: magnitude here, direction in `_motionSpeedSign` below.
      inst._motionSpeed = Number.isFinite(ms) && ms !== 0 ? Math.abs(ms) : 1.0;
      // F15-2 — remember a backstep's direction (raw ms < 0) so the
      // locomotion clip can play in reverse under ?signedMotionSpeed. The
      // magnitude above is unchanged (the gait still comes from the velScale
      // getter), so this is inert (sign = +1) when the flag is off.
      inst._motionSpeedSign =
        (SIGNED_MOTION_SPEED && Number.isFinite(ms) && ms < 0) ? -1 : 1;
    }
    // ACE broadcasts cmd=Stop (0x0004) or cmd=Invalid (0x0000) when a
    // moving entity comes to rest. With no override we'd fall through
    // classifyMotionCommand → null → fadeOutCurrent → bare SetupModel
    // rest pose, dropping the stance-aware idle (combat pose
    // disappears on releasing W). Substitute to Ready (0x0003) so the
    // locomotion-cache path fetches `cycles[(stance, Ready)]` — the
    // weapons-drawn pose for HandCombat, normal stand for NonCombat,
    // etc. Preserve the high bits of the wire u32 so MotionTable's
    // cycle_key masking is unchanged.
    let cmd = (motionCommand >>> 0);
    let cmdLow = cmd & 0xFFFF;
    if (cmdLow === CMD_LOW_STOP || cmdLow === 0x0000) {
      cmd = (cmd & 0xFFFF0000) | CMD_LOW_READY;
      cmdLow = CMD_LOW_READY;
    }
    // Wave 2 Phase 2.5 (2026-05-26): defensive Left → Right substitution
    // for the sidestep + turn-in-place commands. Mirrors retail's
    // `InterpretedMotionState::ApplyMotion` (`~/ac-headers/acclient.c:
    // 332761-332770`) — only `TurnRight` / `SideStepRight` are carried;
    // ACE's `MotionInterp.adjust_motion` (`external/ACE/Source/ACE.Server/
    // Physics/Animation/MotionInterp.cs:409-417`) rewrites the Left codes
    // with negated speed. Our outbound wasm path
    // (`crates/holtburger-core/src/client/movement/common.rs::
    // sidestep_command_for_state` / `turn_motion_command_for_state`)
    // matches, but UpdateMotion broadcasts from a remote player on an
    // older client (or a custom plugin emitting the raw enum) could
    // still carry `0x6500000E` / `0x65000010`. Mapping to Right hits
    // the same `MotionTable.cycles[(stance, ...Right)]` clip retail
    // played for both directions.
    if (cmdLow === CMD_LOW_TURN_LEFT) {
      cmd = (cmd & 0xFFFF0000) | CMD_LOW_TURN_RIGHT;
      cmdLow = CMD_LOW_TURN_RIGHT;
    } else if (cmdLow === CMD_LOW_SIDESTEP_LEFT) {
      cmd = (cmd & 0xFFFF0000) | CMD_LOW_SIDESTEP_RIGHT;
      cmdLow = CMD_LOW_SIDESTEP_RIGHT;
    }
    // Bugs 2/15/18 (2026-10-07): canonical FULL 32-bit command from here on.
    // The MotionTable link INNER key is the full command, and remote motions
    // arrive as the wire's bare low-16 (local Ready alternated bare/full), so
    // every link lookup TO a bare command missed. The canonical value also
    // fixes the Stop→Ready substitution above, which kept a full Stop's class
    // bits (0x40000004 → 0x40000003, not Ready's 0x41000003).
    {
      const canon = fullMotionCommand(cmdLow);
      if (canon > 0xffff) cmd = canon >>> 0;
    }
    let stance = (motionStance >>> 0);
    // Wave 3 / Phase 3.3 (2026-05-26): capture the PREVIOUS stance
    // before `inst.lastStance` is mutated below so the Ready-substitution
    // branch can detect a stance change (current vs. previous) and apply
    // a 150ms crossfade on the Ready cycle swap. Zero means "no prior
    // stance recorded yet" (initial spawn) — we suppress the crossfade
    // in that case to avoid blending from a null pose.
    const prevStance = (inst.lastStance ?? 0) >>> 0;
    // ACE emits UpdateMotion with stance=0 for "motion-only" broadcasts
    // (the wire shorthand for "keep current stance"). Without
    // substitution our cycle_key resolves to `MotionTable.default_style`
    // (NonCombat for humans), so e.g. a HandCombat-stanced player who
    // starts walking would visibly drop out of the combat pose and
    // play the NonCombat walk cycle. `applyConfirmedStance` in
    // index.html already preserves the last label on stance=0; mirror
    // that behaviour here for the rig pose.
    if (stance === 0 && inst.lastStance) {
      stance = inst.lastStance;
    } else if (stance !== 0) {
      inst.lastStance = stance;
    }
    // CMT Wave 2 / Phase 5 (2026-05-26): mirror the resolved stance
    // onto `inst.currentStance` so `getStance(guid)` (and downstream
    // CMT-driven swing dispatch for remote players) can read it
    // without re-deriving stance=0 fallback semantics. Mirrors the
    // existing read pattern in `setSwingMotion` at line ~1942 which
    // already checks `inst.currentStance ?? inst.lastStance ?? …`.
    inst.currentStance = stance;
    // Bugs 2/15/18: full 32-bit stance (0x80000000 | low16) for every cache
    // key and bake below, so a bare wire stance and a full one share a key.
    // The stored lastStance / currentStance keep the value they were given.
    if (stance) stance = (((stance & 0xffff) | 0x80000000) >>> 0);
    // (2026-07-02) — death-hold stamp, read by loop.js `_armRemove`: ACE
    // resolves `deathAnimLength` through `GetAnimData`, which reads the
    // MotionTable LINKS ONLY (DatLoader MotionTable.cs:130-148) — creature
    // Dead lives in the CYCLES, so the length is 0 and the server's
    // corpse-create + creature-delete fire ~immediately after the Dead
    // motion. Without a client-side grace the rig is disposed before the
    // collapse (or the framerate-0 frozen pose) ever renders. Stamped
    // BEFORE the async keyframe fetch so the removal deferral covers the
    // resolve window (the `entityMap.has` guard below would otherwise
    // abort the fetch when the delete lands first).
    // Bug 6 (2026-10-07): a PLAYER rig survives its death (the same object
    // returns at the lifestone); a live motion after Dead clears the death
    // state so the dying-only guards (no re-dress, no LOD respawn, frozen
    // dead-reckon) stop applying. Creatures never come back — their corpse is
    // a new object.
    if ((cmd & 0xFFFF) !== CMD_LOW_DEAD && typeof inst._deathAt === "number") {
      const isPlayerRig = this._isLocalPlayerGuid(guid >>> 0)
        || (((inst.meta?.objDescFlags >>> 0) & 0x8) !== 0);
      if (isPlayerRig && !inst._removePending && !inst._corpseHandoffGuid) {
        inst._deathAt = undefined;
        inst._deathEndAt = undefined;
        inst._deadFrozen = false;
      }
    }
    if ((cmd & 0xFFFF) === CMD_LOW_DEAD) {
      inst._deathAt = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      // Phase 5 carnage (`?carnage=on`) — death finisher runs FIRST so its
      // slices spawn from the live final pose before the ragdoll takes over.
      // Reached via the window hook carnage.js registers (no import — keeps
      // the module out of the flag-off arm and bare-node suite graphs).
      if (!this._isLocalPlayerGuid(guid >>> 0)) {
        try { window.__carnageOnDeath?.(inst); } catch (_e) { /* never block death */ }
      }
      // Phase 4 ragdoll (`?ragdoll=on`) — arm on the death stamp, remote rigs
      // only (the local player's camera rig stays on the authored collapse).
      // Fire-and-forget: the cold path awaits one cached wasm registry fetch;
      // startRagdoll self-guards against the entity being removed meanwhile.
      if (RAGDOLL_ON && !this._isLocalPlayerGuid(guid >>> 0)) {
        // Direction of the fall comes from the KILL, not from a constant:
        // killOptsFor resolves {dir, critical, seed, style, …} from the
        // projectile that just impacted / the attacker's position / the
        // splatter quadrant, falling back to a seeded azimuth. Never throws.
        let killOpts;
        try {
          killOpts = killOptsFor(inst);
        } catch (_e) {
          killOpts = undefined;
        }
        // Bug 6 (2026-10-07): mark the rig as arming so a server delete that
        // lands before the cold registry fetch resolves still holds it for the
        // corpse claim (loop.js `_armRemove`).
        inst._ragdollArming = true;
        startRagdoll(inst, killOpts).catch((e) => {
          if (!this._ragdollWarned) {
            this._ragdollWarned = true;
            // eslint-disable-next-line no-console
            console.warn(`[entities/ragdoll] arm failed for 0x${guid.toString(16)}:`, e);
          }
        }).finally(() => { inst._ragdollArming = false; });
      }
    }
    // A final cast gesture is a SUBSTATE (see isSubstateCastGesture): it takes
    // the generic link + cycle path below, not the action branch. KIND_MOTION
    // delivers it as a bare low16, and the link's inner key is the FULL
    // command (C3), so expand it here.
    const castGestureSubstate = isSubstateCastGesture(cmd);
    if (castGestureSubstate && (cmd >>> 16) === 0) {
      cmd = (0x40000000 | cmd) >>> 0;
    }
    let cls = classifyMotionCommand(cmd);
    // === COL-20 / F4 — turn-phase gate. A MoveTo* envelope arrives as a bare
    // forward-locomotion hint (`moveto_locomotion_hint`, lib.rs:6710, emitted
    // from the KIND_MOTION arm at lib.rs:42908) with no facing information, so
    // pre-fix a remote creature started its run cycle the instant the chase
    // was ordered — while still rotating. Hold the queued forward command and
    // render the turn-in-place cycle until the facing error is inside retail's
    // 20 degree while-moving tolerance; `tick` releases it (see
    // MOVETO_FACING_TOLERANCE_RAD). Remote-only and animation-only: the
    // server-driven position stream is untouched, so a gated creature still
    // travels — only which clip plays changes.
    if (
      MOVETO_TURN_GATE_ON &&
      !this._isLocalPlayerGuid(guid >>> 0) &&
      cls !== "attack" &&
      cls !== "cast"
    ) {
      if (cmdLow !== CMD_LOW_RUN_FORWARD && cmdLow !== CMD_LOW_WALK_FORWARD) {
        // Any other command supersedes the queued locomotion — retail's
        // per-unpack preamble cancels the pending queue wholesale before the
        // case dispatch (acclient.c:339518-339519).
        inst._turnGateCmd = 0;
      } else if (this._headingErrorRad(inst) > MOVETO_FACING_TOLERANCE_RAD) {
        if (inst._turnGateCmd !== cmd) {
          // Fresh arm (a re-broadcast of the SAME command keeps the original
          // deadline so a repeating envelope cannot extend the gate).
          inst._turnGateUntilMs =
            _entityNowMs() +
            1000 *
              Math.min(
                MOVETO_TURN_GATE_MAX_S,
                this._headingErrorRad(inst) / MOVETO_TURN_GATE_OMEGA_REF_RAD +
                  MOVETO_TURN_GATE_SLACK_S,
              );
        }
        inst._turnGateCmd = cmd;
        inst._turnGateStance = stance;
        inst._turnGateSpeed = Number.isFinite(+motionSpeed) ? +motionSpeed : 1.0;
        // Substitute the turn-in-place cycle at the SAME stance. TurnLeft is
        // already folded to TurnRight above, matching retail's carried code.
        cmd = ((cmd & 0xffff0000) | CMD_LOW_TURN_RIGHT) >>> 0;
        cmdLow = CMD_LOW_TURN_RIGHT;
        cls = classifyMotionCommand(cmd);
      } else {
        inst._turnGateCmd = 0;
      }
    }
    if (cls === "stop" || cls === null) {
      // Unclassifiable command: the playhead keeps its current cycle (Stop /
      // Invalid were already substituted to Ready above). `lastMotionCommand`
      // stays sticky so e.g. Walk → ? → Walk replays the original link.
      return;
    }
    const setupId =
      (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta.mtableId ?? 0) >>> 0;

    // Animation consolidation (docs/animation-audit §5 Step 2): route Dead
    // (0x0011) through the Rust one-shot authority — play the collapse ONCE,
    // then HOLD the final (prone) frame (a non-cyclic MotionSequence latches
    // `done` and clamps its last frame). An empty bake falls through to the
    // STATIONARY_COMMANDS → cycle path below.
    if (cmdLow === CMD_LOW_DEAD) {
      const deathToken = inst._motionToken = ((inst._motionToken | 0) + 1) | 0;
      const MS = _motionSequenceClass();
      const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
      if (MS && typeof fetchKeyframes === "function") {
        let entry = null;
        try {
          // (2026-07-06) When `?deathAnim` is on (default), bake the COLLAPSE
          // via the Ready→Dead LINK, not the settled Dead CYCLE. Retail's
          // GetObjectSequence adds the transition-into-dead (get_link) THEN the
          // cyclic hold (acclient.c:337763); the transition is the fall-down
          // motion (tusker Ready→Dead = anim 0x0300001a frames 0→39 @ 30fps).
          // Passing `fromMotion` routes the wasm dispatcher (lib.rs:18151) to
          // try_resolve_link_frames; a creature with no such link falls back to
          // the cycle path (the legacy 1-frame prone hold — no regression). The
          // link inner-key is UNMASKED, so we must pass the FULL Dead command
          // (CMD_DEAD_FULL), not the wire low-16 `cmd`.
          const bakeCmd = this._deathAnimOn ? CMD_DEAD_FULL : cmd;
          const bakeOpts = {
            modelChanges: inst.meta?.modelChanges ?? new Uint32Array(0),
            textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
            paletteId: (inst.meta?.paletteId ?? 0) >>> 0,
            paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
          };
          if (this._deathAnimOn) bakeOpts.fromMotion = CMD_READY_FULL;
          entry = await this.animationCache.get(setupId, mtableId, bakeCmd, stance, fetchKeyframes, bakeOpts);
        } catch (_) { entry = null; }
        if (!this.entityMap.has(guid >>> 0)) return; // despawned mid-resolve
        if (inst._motionToken !== deathToken) return; // superseded mid-resolve (F6)
        const d = entry?.sequenceDescriptor;
        if (d) {
          const seq = MS.fromDescriptor(
            d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
            d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
            false, // one-shot collapse → latches `done`, holds the final prone frame
          );
          if (seq) {
            if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch (_) {} }
            inst._unifiedSeq = null;
            this._clearUnifiedQueue(inst); // J5: death pre-empts every pending gesture
            // clearOnDone:false → keep posing the clamped prone frame (held dead).
            // deathHold:true → the CQ-06 guard at setMotion entry refuses any
            // non-revival motion from freeing this hold (retail: no links out
            // of the Dead substate — the corpse pose is sticky).
            inst._unifiedSeq = { seq, desc: d, clearOnDone: false, deathHold: true, hooks: entry?.hooks || null, lastHookTime: -1,
              speed: this._unifiedOneShotSpeed(inst) };
            // (2026-07-06) Stamp the REAL collapse length so loop.js `_armRemove`
            // holds the rig for exactly this creature's authored death animation
            // (they vary — tusker ~1.3s, others longer) instead of the flat
            // DEATH_HOLD_MS, and the corpse handoff reveals on the same clock.
            // Freeze remote dead-reckon so the collapsing rig settles at the
            // authoritative death spot rather than coasting on its last velocity.
            if (this._deathAnimOn) {
              // Floor at 400ms: a creature with no Ready→Dead LINK falls back
              // to the 1-frame Dead CYCLE, whose duration (~33ms) collapsed
              // the death-hold AND the corpse-correlation window to a single
              // frame (2026-08-02 trace, bug #4).
              const durMs = Math.max(400, (Number.isFinite(d.duration) && d.duration > 0)
                ? d.duration * 1000 : DEATH_HOLD_FALLBACK_MS);
              inst._deathDurationMs = durMs;
              inst._deathEndAt = (inst._deathAt ?? _entityNowMs()) + durMs;
              this._freezeDeadReckon(inst);
            }
            return; // the tick drives the rig; skip the legacy cycle path
          }
        }
      }
      // MS missing (stale pkg) / empty bake → fall through to the cycle path.
    }

    // Swings + magic casts live in `MotionTable.links[(stance,
    // Ready)][swingCmd]` — never in `cycles[(stance, swingCmd)]`.
    // Empirically validated across all 436 retail motion tables
    // (5,455 link entries, 0 cycle entries) — see
    // `docs/swing-classification-spec-2026-05-19.md` §1, §8.
    //
    // Route attack/cast through `_tryPlayLink` with from = Ready =
    // 0x0003: the swing plays as a full-body one-shot on the playhead
    // (queued behind any in-flight gesture), and the locomotion cycle
    // resumes when it completes.
    //
    // Stance-agnostic per spec §8.2 finding A — monster motion
    // tables put swings in `NonCombat`; the link lookup either has
    // an entry or it doesn't, we pass `stance` straight through.
    //
    if ((cls === "attack" || cls === "cast") && !castGestureSubstate) {
      // (swing/cast vibe-pose tween clears removed — setSwingPose/setCastPose
      // retired, WS-B teardown 2026-06-18; nothing assigns the tweens now.)
      // F3-6 (?meleeFaceTarget=on): orient a swinging mob toward its melee
      // victim before the swing renders. The server only broadcasts the attack
      // when the attacker is already facing (IsFacing ~5°→20°), but our remote
      // heading-ease lags and the F3-4 sticky glue never re-faces, so the mob
      // can visibly swing angled off. Snap-face the sticky target on the XY
      // plane (AC-forward = (-sin h, cos h, 0) → h = atan2(-Δx, Δy); pure-Z quat
      // (0,0,sin(h/2),cos(h/2)) — .z/.w map to AC z/w directly per getHeading),
      // and pin _serverTargetQuat so the ease holds the facing through the
      // swing. Attack only (casters keep their windup heading). Inert when the
      // flag is off or there's no known target.
      if (MELEE_FACE_TARGET && cls === "attack" && inst._stickyTarget && inst.root) {
        const tgtInst = this.entityMap.get(inst._stickyTarget >>> 0);
        if (tgtInst && tgtInst !== inst && tgtInst.root) {
          const tp = tgtInst.root.position;
          const p = inst.root.position;
          const h = Math.atan2(-(tp.x - p.x), tp.y - p.y);
          const hz = Math.sin(h / 2);
          const hw = Math.cos(h / 2);
          inst.root.quaternion.set(0, 0, hz, hw);
          if (inst._serverTargetQuat) inst._serverTargetQuat.set(0, 0, hz, hw);
        }
      }
      // Wave 2 (2026-06-08, C3): the MotionTable link inner key is the
      // FULL 32-bit command. lib.rs's main path already sends one, but a
      // bare low-16 from the side-channel / legacy caller is expanded here
      // so the link still resolves (no-op when already full-32bit).
      const linkCmd = expandActionCommandLow16(cmd);
      this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, linkCmd, stance,
        { speed: actionSpeed || 1.0 });
      // Don't update `lastMotionCommand` — the next locomotion
      // broadcast should resolve its link transition from the
      // PREVIOUS locomotion cmd, not from this swing.
      return;
    }
    // Door/chest/lever STATE motions (On/Off). Retail plays the MotionTable
    // LINK once on a state change (the authored transition — Off→On is the
    // opening swing at +framerate, On→Off the SAME anim baked reversed at
    // -framerate; door sounds + the Ethereal flip ride its anim hooks), then
    // ENTERS the destination CYCLE — which for state motions is a
    // framerate-0 single-frame HOLD (see the wasm hold bake). The finished
    // link clamps on its final frame == the destination hold pose, so the
    // clamped link IS the held state; the generic cycle path below is only
    // the no-link fallback (snaps to the commanded state).
    if (isDoorStateMotion(cmd)) {
      const fromState = (inst.lastMotionCommand ?? 0) >>> 0;
      // Dup-suppression: a door change fires up to TWICE (server Motion
      // broadcast → setMotion, and the SetState/ethereal kind=15 →
      // playDoorMotion → here). The first trigger stamps lastMotionCommand
      // synchronously (below, before any await), so the second — and any
      // re-broadcast of the already-held state — is a clean no-op instead
      // of a mid-link crossfade to the hold pose. Compare low-16: the spawn
      // meta carries the bare substate (0xB/0xC) while broadcasts carry the
      // full 0x4000000B/0C — the MotionTable key masks them identically.
      if ((fromState & 0xffff) === (cmd & 0xffff)) return;
      // Stamp BEFORE the async link so the generic link kick below (which
      // re-reads lastMotionCommand) can never double-play this transition.
      inst.lastMotionCommand = cmd;
      if (fromState !== 0) {
        // The link INNER key is the FULL 32-bit command (the C3 finding),
        // but the kind-5 Motion broadcast delivers the bare low-16 substate
        // (0x0B/0x0C) — un-expanded it misses links[0x3d000b][0x4000000c]
        // and falls back to the 1-frame cycle SNAP (observed live: close
        // played "b→c ... 0 hooks" instead of the authored reverse swing).
        // On/Off are class 0x40 (CMD_DOOR_ON/OFF); expand when bare. The
        // outer (from) key masks low-16, so fromState needs no expansion.
        const linkToCmd = (cmd >>> 16) !== 0
          ? cmd
          : ((0x40000000 | (cmd & 0xffff)) >>> 0);
        const played = await this._tryPlayLink(
          inst, setupId, mtableId, fromState, linkToCmd, stance,
          { stateHold: true },
        );
        if (played) return;
      }
      // Unknown prior state / no link entry → fall through: the 1-frame
      // cycle hold below snaps the object to the commanded state. Drop any
      // held link of the previous state so that cycle hold is what shows.
      this._dropStateHold(inst);
    }
    // Locomotion. Build the cache key the same way the spawn path did
    // (resolvedStance falls back to the entity's first-bake stance).
    const cacheKey = AnimationCache.makeKey(setupId, mtableId, cmd, stance);
    // OMEGA (2026-06-06): apply this cycle's authored MotionData.omega
    // (continuous angular velocity — e.g. a spinning sign/fan idle cycle) under
    // ?cycleOmega=on (default OFF), EXCLUDING turn-in-place cycles whose omega is
    // the turn rate already driven by server heading / heading-ease (applying it
    // would double-count and break turning). `cmdLow` already has TurnLeft folded
    // to TurnRight above. Async + memoised; integrated each frame in
    // `_tickHookOmega`. Cleared when switching to a cycle without omega.
    if (CYCLE_OMEGA_ON && cmdLow !== CMD_LOW_TURN_RIGHT) {
      inst._cycleOmegaKey = cacheKey;
      this._resolveCycleOmega(inst, mtableId, stance, cmd, cacheKey);
    } else if (inst._cycleOmega) {
      inst._cycleOmega = null;
      inst._cycleOmegaKey = null;
      // #8 (2026-06-07): drop the accumulated spin delta when the cycle's
      // authored omega stops, mirroring the SetOmega(0,0,0) hook-stop reset,
      // so a later server setPose doesn't re-stamp a residual spin. Only when
      // no SetOmega-hook spin remains (it owns the accum otherwise).
      if (!inst._omega) inst._omegaAccumQ = null;
    }
    // T11 — mark this as the entity's active locomotion cycle and resolve its
    // authored ground speed (async, memoised) so the per-frame tick can scale
    // playback to actual ground travel. Only walk/run-family cycles (sidestep
    // / turn-in-place / fall also classify "walk"; their |velocity| is ~0 →
    // cycleTimeScale no-ops). Gated by ?velScale=on.
    if (VEL_SCALE_ON && (cls === "walk" || cls === "run")) {
      inst._locoCycleKey = cacheKey;
      // Seed from the memo so a gait swap never inherits the prior cycle's base.
      inst._locoBaseSpeed = this._cycleBaseSpeedCache.get(cacheKey) ?? 0;
      this._resolveCycleBaseSpeed(inst, mtableId, stance, cmd, cacheKey);
      // T1: stash the interpreted forward motion state (full u32 command +
      // forward_speed scalar) so tick() can feed the new wasm `stateGroundSpeed`
      // getter (retail CMotionInterp::get_state_velocity) as the 'actual'
      // ground anim-speed, instead of the rig XZ-position-delta EMA. `cmd` here
      // is the already-interpreted forward command (WalkForward/RunForward —
      // backstep arrives as WalkForward with a negated forward_speed upstream);
      // `inst._motionSpeed` is the broadcast forward_speed (set above). The
      // sidestep axis is driven separately (setSidestepLayer stashes its scalars).
      // Sidestep / turn / fall cycles also classify "walk" but carry no
      // forward axis — zero it so the getter doesn't keep the last run.
      const isFwd = cmdLow === CMD_LOW_WALK_FORWARD || cmdLow === CMD_LOW_RUN_FORWARD;
      inst._forwardCommand = isFwd ? cmd >>> 0 : 0;
      inst._forwardSpeed = isFwd ? (inst._motionSpeed ?? 1.0) : 0;
    } else {
      // Audit F2: idle/Ready (and any other non-gait cycle) clears the gait
      // state; it used to keep the last walk/run values forever, so the idle
      // cycle was velocity-scaled against the run's authored speed.
      inst._forwardCommand = 0;
      inst._forwardSpeed = 0;
      inst._locoBaseSpeed = 0;
    }
    // 2026-10-05 — peace↔combat draw/sheathe: retail GetObjectSequence's
    // style branch (acclient.c:337700-745; OpenAC CMotionTable.cs:158-212)
    // plays links[(oldStyle, Ready)][newStyle] (or the two-hop via the
    // default style) before the new style's cycle. We only ever swapped the
    // Ready cycle, so the rig snapped.
    //
    // The style link's FETCH starts here, but it is only PLAYED at the commit
    // below, in the same synchronous step that installs the new cycle. When
    // the two raced independently (owner report 2026-10-05: draw/sheathe "very
    // good but slight frame freeze"), the cached new-stance cycle could land
    // first and pop the rig into the new stance before the link pulled it back.
    // Or the link could finish before the cycle bake did and drop back to the
    // OLD stance's cycle. The pending fetch is parked on the instance, so a
    // newer setMotion that supersedes this one (the predictor's Ready re-issue)
    // inherits it instead of losing the draw animation.
    //
    // Bug 18 (2026-10-07): the style change is applied for ANY command, not
    // only Ready, and as retail orders it. `apply_interpreted_movement`
    // (acclient.c:344147) applies the style first, then the forward command,
    // into one sequence: the style step appends the EXIT link (current
    // substate → Ready, old style), the style link(s), then the new style's
    // Ready (acclient.c:337700-337760; OpenAC CMotionTable.cs:158-211); the
    // forward step appends Ready → cmd (new style) and the new cycle. Ours
    // played the style link only for a Ready (a Run carrying the new stance
    // popped straight into the combat run) and no exit link.
    let ownStanceChain = false;
    if (prevStance !== 0 && (stance & 0xffff) !== (prevStance & 0xffff)) {
      inst._pendingStyleLinks = this._resolveStanceChain(
        inst, setupId, mtableId, prevStance, stance, (inst.lastMotionCommand ?? 0) >>> 0,
      );
      ownStanceChain = true;
    }
    // Dedupe against the playhead's cycle (`currentActionKey` is its key).
    // Audit F6: per-entity command token, bumped BEFORE the dedup so even a
    // re-issue of the playing cycle supersedes an older fetch still in
    // flight. Every await below re-checks it: last command issued wins, not
    // last fetch finished.
    const motionToken = inst._motionToken = ((inst._motionToken | 0) + 1) | 0;
    const styleLinksP = inst._pendingStyleLinks || null;
    if (cacheKey === inst.currentActionKey && !styleLinksP) {
      // Already on this cycle. A gesture whose commit never landed (superseded
      // or no cycle) must not stay the remembered substate: setLocalStance
      // would keep re-issuing Ready and the next link would key off it.
      if (isSubstateCastGesture(inst.lastMotionCommand ?? 0) && !castGestureSubstate) {
        inst.lastMotionCommand = cmd;
      }
      return; // already playing
    }
    this.motionSwitchCount += 1;

    // Locomotion transition LINK. When transitioning from a known previous
    // motion command (not the very first setMotion for this entity), ask the
    // MotionTable for a link via `opts.fromMotion`. If one exists it plays as
    // a one-shot on the playhead; when it finishes the tick falls back to
    // `_unifiedLoco`, which by then holds the new cycle
    // (prev cycle) → (link once) → (next cycle). Like the style link, it is
    // fetched in parallel with the cycle and played at the commit below. A
    // substate cast gesture takes this path too: Ready→gesture on the way in,
    // gesture→Ready (the recoil) on the next Ready.
    // A cast gesture always links out of Ready, the substate ACE leaves the
    // caster in (it stops the caster first). Retail would hop through the
    // style default from any other substate; from a never-moved spawn
    // `lastMotionCommand` is 0, which would otherwise skip the gesture link.
    // Bug 18: after a style change the substate is the NEW style's Ready, so
    // the forward command links from there (the chain's entry link).
    const fromMotion = castGestureSubstate
      ? READY_SUBSTATE
      : styleLinksP
        ? CMD_READY_FULL
        : ((inst.lastMotionCommand ?? 0) >>> 0);
    let linkP = null;
    if (
      fromMotion !== 0 &&
      fromMotion !== cmd &&
      cacheKey !== inst.currentActionKey &&
      ((cls !== "attack" && cls !== "cast") || castGestureSubstate)
    ) {
      // The link's INNER key is the full 32-bit command (C3), but the wire
      // Ready (KIND_MOTION low16) and setLocalStance's Ready are bare 0x0003:
      // links[(Magic, MagicBlast)] holds only 0x41000003, so the bare lookup
      // missed and the wasm fell back to the Ready CYCLE, i.e. no recoil.
      const linkTo = (isSubstateCastGesture(fromMotion) && cmd === CMD_LOW_READY)
        ? CMD_READY_FULL : cmd;
      linkP = this._fetchLinkEntry(inst, setupId, mtableId, fromMotion, linkTo, stance);
    }
    inst.lastMotionCommand = cmd;

    // Fetch the cycle (cache hit after the first bake). Substitutions reuse
    // the spawn meta's entries (NPC outfit doesn't change mid-walk).
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return;
    let entry = null;
    if (cacheKey !== inst.currentActionKey) {
      try {
        entry = await this.animationCache.get(
          setupId,
          mtableId,
          cmd,
          stance,
          fetchKeyframes,
          {
            modelChanges: inst.meta.modelChanges ?? new Uint32Array(0),
            textureChanges: inst.meta.textureChanges ?? new Uint32Array(0),
            paletteId: (inst.meta.paletteId ?? 0) >>> 0,
            paletteSubsFlat: inst.meta.subPalettes ?? new Uint32Array(0),
          }
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] setMotion fetch failed for entity ${guid.toString(16)}:`,
          e
        );
        entry = null; // the links below still play
      }
    }
    const linkEntry = linkP ? await linkP : null;
    const styleLinks = styleLinksP ? await styleLinksP : null;
    // Re-check — the entity may have been removed between the cache hit and
    // now; a newer setMotion may have superseded this one (audit F6). A
    // superseded call leaves `_pendingStyleLinks` for the newer one.
    if (!this.entityMap.has(guid >>> 0)) return;
    if (inst._motionToken !== motionToken) return;
    if (inst._pendingStyleLinks === styleLinksP) inst._pendingStyleLinks = null;
    // ---- commit: links + cycle in ONE synchronous step (no tick between) ----
    // Order matches retail's sequence build: the transition (exit) link, the
    // style link(s), then the destination cycle (acclient.c:337726-745).
    // Bug 18: the style chain (exit link + style links) FIRST, then the
    // forward command's link, then the cycle — retail's order.
    let linked = false;
    let styleN = 0;
    for (const l of (styleLinks || [])) {
      if (this._playLinkEntry(inst, l.entry, l.fromCmd ?? READY_SUBSTATE, l.toCmd, l.stance)) {
        linked = true;
        styleN++;
      }
    }
    const entryPlayed = !!(linkEntry && this._playLinkEntry(inst, linkEntry, fromMotion, cmd, stance));
    if (entryPlayed) linked = true;
    if (styleLinks) {
      const m = styleLinks.meta || {};
      try {
        // eslint-disable-next-line no-console
        console.log(
          `[stance-chain] 0x${(guid >>> 0).toString(16)} ` +
          `0x${((m.from ?? prevStance) >>> 0).toString(16)}->0x${((m.to ?? stance) >>> 0).toString(16)} ` +
          `exit=${m.exit ? 1 : 0} style=${styleN - (m.exit ? 1 : 0)} entry=${entryPlayed ? 1 : 0} ` +
          `cycle=0x${(cmd >>> 0).toString(16)}${ownStanceChain ? "" : " (inherited)"}`,
        );
      } catch (_) {}
    }
    // No animation resolved for this (cmd, stance) → the playhead keeps its
    // current cycle (the mixer used to fade to the rest pose here, which the
    // playhead never did).
    if (!entry?.clip) return;
    // Drive the cycle through the Rust authority. Phase is carried across a
    // cycle swap (walk→run) via the Rust seekPhase so the feet don't pop — the
    // reason the mixer-era band-aids (150 ms stance crossfade, 200 ms
    // RESUME_WINDOW mid-stride restore) are gone. After a link the cycle
    // starts at its first frame instead: retail appends the cycle node behind
    // the link, and the link's last frame is authored to meet the cycle's
    // first. A carried phase popped the pose at the hand-off. A one-shot
    // (_unifiedSeq) suppresses this during a swing, then resumes it. By here
    // attack/cast actions and death have already returned, so cls is a cycle
    // (walk/run/idle/Ready/held door state/held cast gesture).
    if (this._installUnifiedLoco(inst, entry.sequenceDescriptor, cacheKey, entry.hooks, cmd, !linked)) {
      try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
    }
  }

  /**
   * Track B9 (2026-06-08) — apply the server-authoritative COMBAT STANCE
   * to the LOCAL player's rig without disturbing its client-predicted
   * locomotion.
   *
   * The local player's gait is owned by the W3.1 keystate predictor
   * (`index.html` ~10457 fires `setMotion(localGuid, Run/Walk/Ready,
   * stance)` on input); loop.js's KIND_MOTION arms therefore SKIP the
   * server's UpdateMotion echo for the local guid so the echoed
   * locomotion command can't fight the predictor (DIM10/A-2). But that
   * skip ALSO dropped the server's STANCE half of UpdateMotion 0xF74C
   * (ACE `Player_Combat.cs` ChangeCombatMode → `Creature_Combat.cs`
   * SetCombatMode → GetCombatStance), so a combat-mode toggle never
   * re-posed the local rig. This method restores ONLY the stance:
   *
   *   1. Stamp `inst.currentStance`/`inst.lastStance` so `getStance(guid)`
   *      returns the confirmed stance — the predictor reads it on the
   *      next input tick, so an in-flight walk/run re-resolves to the new
   *      stance's cycle on its own without us touching the active clip.
   *   2. ONLY when the resolved low-16 stance actually CHANGED, and ONLY
   *      while the rig is NOT in an active walk/run locomotion clip,
   *      replay the stance-aware Ready/idle base pose by delegating to
   *      `setMotion(guid, Ready, motionStance)`. That reuses setMotion's
   *      Stop/Invalid→Ready substitution and its 150ms stance-change
   *      crossfade (`isStanceReadyChange`) — note we deliberately do NOT
   *      pre-stamp `inst.lastStance` before that call so setMotion's
   *      own `prevStance` capture still sees the change and fades.
   *
   * CONFLICT-GUARD (Track B9): this touches ONLY the Ready/idle base-pose
   * layer. It MUST NEVER replace or restart the predictor-owned walk/run
   * locomotion clip while the player is moving — so when the rig's last
   * locomotion command classifies as walk/run we leave the active clip
   * alone and let the predictor adopt the new stance on its next tick.
   *
   * @param {number} guid — local player GUID
   * @param {number} motionStance — u32 MotionStance from UpdateMotion
   */
  setLocalStance(guid, motionStance) {
    const g = (guid >>> 0);
    const inst = this.entityMap.get(g);
    if (!inst) return;
    const stance = (motionStance >>> 0);
    if (stance === 0) return; // motion-only broadcast — keep current stance
    // Resolve the low-16 the same way setMotion compares stances, and
    // detect whether the stance actually changed before we stamp it.
    const prevStance = (inst.currentStance ?? inst.lastStance ?? 0) >>> 0;
    const changed = (prevStance & 0xFFFF) !== (stance & 0xFFFF);
    // Determine whether the rig is in an active walk/run locomotion clip
    // owned by the predictor. If so, only stamp the stance — the predictor
    // re-issues Run/Walk with the new stance on its next input tick
    // (it reads getStance), so the active clip is left untouched.
    // 2026-10-05: no prior command (fresh spawn, never moved) is NOT moving —
    // the ?mtClassFallback classifier maps a bare 0 to "walk", which made
    // every stance change before the first step stamp-only (no draw anim).
    const lastCmd = (inst.lastMotionCommand ?? 0) >>> 0;
    const lastCls = lastCmd ? classifyMotionCommand(lastCmd) : null;
    const moving = lastCls === "walk" || lastCls === "run";
    // 2026-10-05: the local rig is HOLDING a cast gesture (arms out, the
    // gesture's framerate-0 cycle). ACE ends every cast with Ready at 1.0
    // (Player_Magic.cs DoCastSpell), but loop.js skips the local Ready echo
    // (predictor-owned locomotion) and hands us only its stance. Without this
    // the arms stay out until the next keypress. Issue the Ready ourselves so
    // the gesture→Ready recoil link plays.
    if (isSubstateCastGesture(lastCmd) && (lastCmd >>> 24) === 0x40) {
      this.setMotion(g, CMD_LOW_READY, stance);
      return;
    }
    if (changed && moving) {
      // Bug 18 (2026-10-07): a combat toggle WHILE running used to only
      // record the stance here; the next predictor tick then swapped straight
      // to the new stance's run cycle (the "stance switches instantly"). Play
      // the retail style change on the current gait instead: setMotion builds
      // exit link → draw/sheathe → Ready→Run (new style) → run cycle. The
      // predictor's own re-issue of the same Run then dedupes against it.
      const spd = (inst._motionSpeed ?? 1.0) * ((inst._motionSpeedSign ?? 1) < 0 ? -1 : 1);
      this.setMotion(g, lastCmd, stance, spd);
      return;
    }
    if (!changed) {
      // No pose swap: just record the confirmed stance so getStance()
      // and the next predictor tick pick it up. (Always safe.)
      inst.currentStance = stance;
      inst.lastStance = stance;
      return;
    }
    // Stationary AND the stance changed: replay the stance-aware Ready
    // base pose via setMotion. We intentionally do NOT pre-stamp
    // inst.lastStance/currentStance here — setMotion captures prevStance
    // from inst.lastStance to drive its 150ms crossfade, then stamps both
    // fields itself (`inst.currentStance = inst.lastStance = stance`).
    this.setMotion(g, CMD_LOW_READY, stance);
  }

  /**
   * Record the entity's interpreted SIDESTEP axis (retail `RawMotionState`
   * carries forward / sidestep / turn as independent slots,
   * acclient.c:332759-332786). Since the animation consolidation this is a
   * plain scalar setter: it stashes `_sidestepCommand` (SideStepRight
   * 0x6500000F — Left is folded to Right, the direction rides the speed sign)
   * and `_sidestepSpeed` (the wire `sidestep_speed` magnitude) for the
   * `stateGroundSpeed` getter's X term, which scales the locomotion cycle's
   * gait. It no longer layers a 0.5-weight mixer clip: a pure strafe already
   * plays the SideStepRight CYCLE through setMotion on the Rust playhead, and a
   * diagonal plays the forward cycle (retail has one playhead, no blend).
   *
   * The name is kept because index.html / loop.js / camera.js call it.
   * `sidestepCmd = 0` (or any non-sidestep low-16) clears the axis.
   *
   * @param {number} guid
   * @param {number} sidestepCmd Full u32 motion command. Use 0 to clear.
   * @param {number} _motionStance unused (kept for the callers' signature)
   * @param {number} [speed] wire `sidestep_speed`; omitted/non-finite → 1.0.
   */
  setSidestepLayer(guid, sidestepCmd, _motionStance, speed) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    let cmd = sidestepCmd >>> 0;
    if ((cmd & 0xFFFF) === CMD_LOW_SIDESTEP_LEFT) {
      cmd = ((cmd & 0xFFFF0000) | CMD_LOW_SIDESTEP_RIGHT) >>> 0;
    }
    const low = cmd & 0xFFFF;
    if (cmd === 0 || (low !== CMD_LOW_SIDESTEP_RIGHT && low !== CMD_LOW_SIDESTEP_LEFT)) {
      inst._sidestepCommand = 0;
      inst._sidestepSpeed = 0;
      return;
    }
    inst._sidestepCommand = cmd;
    inst._sidestepSpeed = Number.isFinite(speed) ? Math.abs(speed) : 1.0;
  }

  /**
   * VectorUpdate (kind=4) handler. Stashes the remote entity's last server
   * velocity + a timestamp; tick() extrapolates _serverTargetPos by lastVel*dt
   * while it's fresh (B5/QW2/REMOTE-3 — retail set_velocity dead-reckon,
   * acclient.c:143476). vx/vy/vz arrive in AC world coords, the same frame as
   * _serverTargetPos (loop.js sets both from lbX*192+x), so no transform is
   * needed. Each new KIND_POSITION snap-corrects via setPose.
   */
  setVelocity(upd) {
    const inst = this.entityMap.get((upd.guid >>> 0));
    if (!inst) {
      // PROJ-VIS (2026-10-05): a projectile's ONLY VectorUpdate is its impact
      // stop. On a short flight it can land while the rig is still building
      // (spawnInFlight) and used to be dropped here — the bolt then flew on
      // past the target (lit, hidden only by NoDraw) for ACE's 5 s pre-Destroy
      // window. Park the impact TIME; the ballistic seed in `_spawnImpl`
      // consumes it and the integrator stops the bolt at that instant.
      const g = upd.guid >>> 0;
      const v2 = (+upd.vx || 0) ** 2 + (+upd.vy || 0) ** 2 + (+upd.vz || 0) ** 2;
      if (PROJECTILE_IMPACT_STOP_ON && v2 <= 1e-6 && this.spawnInFlight?.has(g)) {
        const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
        if (!this._pendingProjectileStops) this._pendingProjectileStops = new Map();
        const m = this._pendingProjectileStops;
        if (m.size > 64) {
          for (const [k, t] of m) if (nowMs - t > PROJECTILE_PENDING_STOP_TTL_MS) m.delete(k);
        }
        m.set(g, nowMs);
      }
      return;
    }
    // Pre-impact velocity, captured BEFORE the overwrite below. For a
    // PhysicsState::Missile this is still the ObjectCreate launch velocity
    // (ACE streams nothing in flight), i.e. the exact flight direction of the
    // bolt/arrow that is about to stop — the best kill-direction source there
    // is (scene3d/kill_impulse.js).
    const prevVel = inst.lastVel;
    inst.lastVel = {
      vx: upd.vx ?? 0,
      vy: upd.vy ?? 0,
      vz: upd.vz ?? 0,
      omegaZ: upd.omegaZ ?? 0,
    };
    inst.lastVelMs = typeof performance !== "undefined" ? performance.now() : 0;
    // WS10 (2026-07-12): ACE streams NO in-flight UpdatePosition/VectorUpdate for a
    // PhysicsState::MISSILE object — the ONLY VectorUpdate a projectile ever receives is
    // the impact zero-velocity stop (SpellProjectile.ProjectileImpact →
    // GameMessageVectorUpdate, SpellProjectile.cs:237-238). So any VectorUpdate on a
    // ballistic projectile IS the impact: stop self-integrating, else _ballisticGravity
    // keeps decaying vz and the (NoDraw'd) husk sinks through the world for its 5 s
    // pre-Destroy window. Gated on the projectile classification so a normal remote-entity
    // dead-reckon VectorUpdate is untouched. `?projectileImpactStop=off` restores the
    // (masked-by-NoDraw) legacy behavior byte-identically.
    if (PROJECTILE_IMPACT_STOP_ON && inst._ballistic && this.isProjectile(upd.guid >>> 0)) {
      this._stopBallisticProjectile(inst);
      // Record WHERE it hit and WHICH WAY it was going. Correlated to a victim
      // by proximity at death time (the impact carries no defender guid), so a
      // mage bolt or an arrow topples the creature the way it was travelling.
      if (RAGDOLL_ON && prevVel && inst.root) {
        try {
          noteProjectileImpact(
            inst.root.position.x,
            inst.root.position.y,
            prevVel.vx || 0,
            prevVel.vy || 0,
          );
        } catch (_e) { /* enrichment only — never break the impact stop */ }
      }
    }
  }

  /**
   * F3-4 (bughunt 2026-06-09) — set/clear a sticky-attack target for `guid`.
   * `target` 0 clears. While set, tick() glues this entity to the target's
   * live position at melee standoff (ACE stops broadcasting a sticky monster's
   * position — `Monster_Tick.UpdatePosition(false)` — so without this the mob
   * freezes where it first reached you and attacks land from a statue meters
   * away). The sticky target rides on `model_id` of the KIND_MOTION wire event
   * (the canonical UpdateMotion echo); a fresh non-sticky movement command
   * sends 0 here and a resumed position broadcast (setPose / KIND_POSITION)
   * also clears it.
   */
  setStickyTarget(guid, target) {
    const inst = this.entityMap.get((guid >>> 0));
    if (!inst) return;
    const t = (target >>> 0) || 0;
    inst._stickyTarget = t === 0 ? null : t;
  }

  /**
   * F3-5 (bughunt 2026-06-09) — stash a remote entity's OWN run rate (from its
   * MoveTo `run_rate`, surfaced on the KIND_MOTION `vx` field). Used by
   * `_resolveStateGroundSpeed` so the velScale gait tempo reflects the
   * creature's rate instead of borrowing the local player's. A non-positive
   * value is ignored (keeps the last known rate); the rate naturally persists
   * across the position-only updates that follow a chase MoveTo.
   */
  setEntityRunRate(guid, rate) {
    const inst = this.entityMap.get((guid >>> 0));
    if (!inst) return;
    const r = +rate;
    if (Number.isFinite(r) && r > 0) inst._runRate = r;
  }

  /**
   * F3-3 (bughunt 2026-06-09) — execute a server TurnToHeading/TurnToObject
   * directive. The wire carries the ABSOLUTE target heading as an AC z-up
   * quaternion; convert it the same way `setPose` does and stash it as the
   * heading-ease target (`_serverTargetQuat` + `_headingEaseInit`) so the
   * per-frame slerp in `tick()` turns the rig to face it. Pre-fix this
   * envelope was dropped, so NPCs never turned to face you on interaction and
   * idle turn-in-place never played. No snap — a turn should be a smooth
   * rotation; a subsequent authoritative position update (`setPose`)
   * overrides this if one arrives (awake monsters), and drives nothing extra
   * if it doesn't (the NPC-emote case this fixes).
   */
  applyTurnDirective(guid, qw, qx, qy, qz, turnSpeed) {
    const inst = this.entityMap.get((guid >>> 0));
    if (!inst || !inst.root) return;
    const tq = acQuatToThree(qw, qx, qy, qz);
    let tgtQ = inst._serverTargetQuat;
    if (!tgtQ) tgtQ = inst._serverTargetQuat = new THREE.Quaternion();
    tgtQ.copy(tq);
    inst._headingEaseInit = true;
    // G-5 (?turnOmega=on): cap the tick slerp at the retail turn rate —
    // base omega × the wire MoveToParameters.speed (loop.js forwards the
    // KIND_TURN omega_z hint; 0/absent → speed 1). Cleared on settle and
    // by any KIND_POSITION heading stash (setPose owns the target again).
    if (TURN_OMEGA_ON) {
      const sp = +turnSpeed;
      inst._turnOmegaCapRad =
        TURN_OMEGA_BASE_RAD * (Number.isFinite(sp) && sp > 0 ? sp : 1.0);
    }
  }

  /**
   * Wave 7.3 (2026-05-24): mid-game equip change. The wasm UpdateObject
   * arm (lib.rs::GameMessage::UpdateObject) packs the four substitution-
   * relevant fields (modelChanges / textureChanges / subPalettes /
   * paletteId) into an `ENTITY_UPDATE_KIND_APPEARANCE` event; loop.js
   * routes it here.
   *
   * V1 strategy: despawn + respawn. Hot-swap (preserve mixer + actions
   * + bone state, replace only parts + materials) would avoid the
   * brief flicker but would require careful animation-state sync that
   * deserves its own validation. Despawn+respawn is robust + cheap +
   * the next KIND_POSITION re-syncs the entity to its current pose,
   * so the flicker is bounded to one frame in steady state.
   *
   * Pose preservation: read the current world pose off `inst.root`
   * (entity-instance positions are stored in AC world-frame per the
   * `picking.js::entityAcPosition` comment), convert back to LB-local
   * for the spawn meta, and pass it through so the respawn lands at
   * the current pose instead of the original spawn-time pose.
   *
   * Diag: fires `__diag.clothing.onAppearanceChange` with substitution
   * counts BEFORE the despawn, so the observation lands even if the
   * subsequent spawn errors.
   *
   * @param {number} guid
   * @param {{modelChanges?: Uint32Array, textureChanges?: Uint32Array,
   *          subPalettes?: Uint32Array, paletteId?: number}} opts
   * @returns {Promise<boolean>} true if dispatched, false if no entity
   *   existed for the guid.
   */
  async applyAppearance(guid, opts) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return false;
    // Bug 6 / bug 16 (2026-10-07): a creature that has died is not re-dressed.
    // ACE dequips an armed creature's treasure while it dies
    // (`TryDequipObjectWithBroadcasting` → ObjDescEvent, Creature_Death.cs:675);
    // re-dressing the dying rig cost a full bake + palette decode (a frame
    // drop at every armed kill), and the remove()+spawn() fallback wiped the
    // ragdoll the corpse handoff copies its pose from. The corpse carries the
    // final ObjDesc anyway.
    if (typeof inst._deathAt === "number") {
      // eslint-disable-next-line no-console
      console.info(`[handoff] skip re-dress of dying 0x${g.toString(16)}`);
      return true;
    }

    const oldMeta = inst.meta || {};
    const newMeta = { ...oldMeta };
    if (opts?.modelChanges) newMeta.modelChanges = opts.modelChanges;
    if (opts?.textureChanges) newMeta.textureChanges = opts.textureChanges;
    if (opts?.subPalettes) newMeta.subPalettes = opts.subPalettes;
    if (opts?.paletteId !== undefined) newMeta.paletteId = (opts.paletteId >>> 0);
    // R7 (?runtimeObjScale=on): apply a runtime scale/translucency carried by
    // an UpdateObject. The Rust side sends real values on UpdateObject and the
    // 0.0 / -1.0 "no change" sentinels on ObjDescEvent (equip/dye/death carry
    // neither on the wire), so equip/dye never resets a grown/ghosted entity.
    // The respawn below re-reads `meta.objScale` (~:2680) + `meta
    // .physicsTranslucency` (~:3068), so merging into newMeta is sufficient.
    if (RUNTIME_OBJSCALE_ON) {
      if (opts?.objScale > 0) newMeta.objScale = opts.objScale;
      if (opts?.physicsTranslucency >= 0) {
        newMeta.physicsTranslucency = opts.physicsTranslucency;
      }
    }

    // Wave 7.5 — try hot-swap when the URL flag is on. Hot-swap
    // preserves root + mixer + currently-playing action; only the
    // child Mesh contents of each inst.parts[p] Group get replaced.
    // On topology mismatch or any error, falls through to the W7.3
    // despawn+respawn path so the equip change still propagates.
    if (this._hotSwapAppearance) {
      try {
        const swapped = await this._applyAppearanceHotSwap(inst, newMeta, g);
        if (swapped) return true;
        // swapped=false → topology mismatch or unhandled fallback;
        // fall through to despawn+respawn.
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[applyAppearance] hot-swap threw on 0x${g.toString(16)}, falling back to despawn+respawn:`, e);
      }
    }

    // HELD-ITEM (2026-08-02, `?wieldPersist`) — is THIS entity a wielded
    // child? If so its `root.position` is the hand-local holding frame
    // (~0.03 m), NOT an AC world pose: the world-pose preservation below
    // would write ~0.03 into `newMeta.x/y/z` and the respawned rig would land
    // at the MAP ORIGIN, unparented, permanently — an ObjDesc/UpdateObject on
    // an equipped item (dye, imbue, a tinker recolour) silently teleported the
    // weapon out of the world. Skip the pose rewrite entirely (a parented
    // object has no world pose of its own — retail `update_position`
    // acclient.c:321671) and re-mount after the respawn.
    const selfAttach =
      WIELD_PERSIST_ON && inst._attachedParentGuid != null
        ? {
            parentGuid: inst._attachedParentGuid >>> 0,
            location: (inst._attachedLocation ?? 0) >>> 0,
            placement: (inst._attachedPlacement ?? 0) >>> 0,
          }
        : null;
    // Preserve current world pose. `inst.root.position` is already in
    // AC world-frame (lbX*192 + local_x, etc); recompute LB-local so
    // the spawn path's `wx = lbX*192 + meta.x` rebuilds the same world
    // coords. Falls through to spawn-time pose if any field is missing.
    const root = selfAttach ? null : inst.root;
    if (root?.position) {
      const lbId = (oldMeta.landblockId ?? 0) >>> 0;
      const lbX = (lbId >>> 24) & 0xff;
      const lbY = (lbId >>> 16) & 0xff;
      newMeta.x = root.position.x - lbX * 192;
      newMeta.y = root.position.y - lbY * 192;
      newMeta.z = root.position.z;
    }
    if (root?.quaternion) {
      newMeta.qw = root.quaternion.w;
      newMeta.qx = root.quaternion.x;
      newMeta.qy = root.quaternion.y;
      newMeta.qz = root.quaternion.z;
    }

    try {
      window.__diag?.clothing?.onAppearanceChange?.({
        guid: g,
        source: "wire-update-object",
        modelChangesCount: (opts?.modelChanges?.length ?? 0) / 2 | 0,
        textureChangesCount: (opts?.textureChanges?.length ?? 0) / 3 | 0,
        subPalettesCount: (opts?.subPalettes?.length ?? 0) / 3 | 0,
        paletteId: newMeta.paletteId ?? 0,
      });
    } catch (_) {}

    // The wearer's wielded children (weapon/shield) are parented INSIDE
    // this rig's part nodes — remove(g) would take their roots down with
    // it, leaving the weapon invisible until the next wield event. Park
    // them on entitiesGroup first (detach), remember their mount args,
    // and re-attach to the fresh rig after the respawn.
    const reattach = [];
    if (inst._attachedChildren && inst._attachedChildren.size) {
      for (const cg of [...inst._attachedChildren]) {
        const c = this.entityMap.get(cg >>> 0);
        if (!c) continue;
        reattach.push({
          guid: cg >>> 0,
          location: (c._attachedLocation ?? 0) >>> 0,
          placement: (c._attachedPlacement ?? 0) >>> 0,
        });
        this._detachChild(cg);
      }
    }

    this.remove(g);
    await this.spawn(newMeta);
    for (const r of reattach) {
      try {
        await this.attachChildToParent(r.guid, g, r.location, r.placement);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[applyAppearance] re-attach 0x${r.guid.toString(16)} failed:`, e);
      }
    }
    // HELD-ITEM (2026-08-02) — …and the mirror case the original loop never
    // covered: THIS entity was itself a wielded child. `remove(g)` dropped its
    // `_attachedParentGuid`, so without this the fresh rig stays unparented.
    // (`_replayLastAttach` on the spawn commit usually already re-mounted it;
    // this is the belt-and-braces path for when the ledger was cleared.)
    if (selfAttach && this.entityMap.get(g)?._attachedParentGuid == null) {
      try {
        await this.attachChildToParent(
          g, selfAttach.parentGuid, selfAttach.location, selfAttach.placement
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[applyAppearance] self re-attach 0x${g.toString(16)} failed:`, e);
      }
    }
    // === Wave 6 polish — entityAppearanceChanged emit (2026-05-28) ===
    // Notify the plugin bus that this entity's visible appearance just
    // landed (despawn+respawn path). Wave 3.B's examine-target plugin
    // subscribes via `client.events.on("entityAppearanceChanged", ...)`
    // to tear down + rebuild its embedded PaperdollViewport so the recolored
    // gear re-renders. Without this emit, the subscription never fires.
    // The hot-swap variant (`_applyAppearanceHotSwap`) carries a
    // matching emit at its `return true` site below.
    try {
      window.__pluginClient?.events?.emit?.("entityAppearanceChanged", { guid: g });
    } catch (_) {}
    return true;
  }

  /**
   * Wave 7.5 (2026-05-24): hot-swap variant of applyAppearance.
   * Preserves `inst.root` + the motion playhead (`_unifiedLoco` /
   * `_unifiedSeq`) — only the child Mesh contents of each
   * `inst.parts[p]` Group get replaced. The playhead keeps posing
   * `parts[p].position` / `parts[p].quaternion` (same part count for the
   * same setupId).
   *
   * Returns true when the swap succeeded. Returns false when:
   *  - new animEntry.partGroups.length !== inst.parts.length
   *    (rig topology changed — caller should despawn+respawn)
   *  - any other recoverable mismatch
   * Throws on unexpected errors — caller's try/catch handles fallback.
   *
   * @private
   */
  async _applyAppearanceHotSwap(inst, newMeta, guid) {
    const setupId = (newMeta.modelId ?? newMeta.setupId ?? 0) >>> 0;
    if (!setupId) return false;
    const mtableId = (newMeta.mtableId ?? 0) >>> 0;
    // Use the entity's CURRENT motion/stance (mid-animation continuity),
    // falling back to spawn-time defaults.
    const motion = (inst.currentMotion ?? newMeta.motionCommand ?? 0) >>> 0;
    const stance = (inst.currentStance ?? newMeta.motionStance ?? 0) >>> 0;
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;

    const animEntry = await this.animationCache.get(
      setupId, mtableId, motion, stance, fetchKeyframes,
      {
        modelChanges: newMeta.modelChanges ?? new Uint32Array(0),
        textureChanges: newMeta.textureChanges ?? new Uint32Array(0),
        paletteId: (newMeta.paletteId ?? 0) >>> 0,
        paletteSubsFlat: newMeta.subPalettes ?? new Uint32Array(0),
        // BUG-3 FOLLOW-UP (2026-08-04) — THE armour miss. `?appearanceUrgent`
        // first landed only on `_spawnImpl`'s `bakeOpts`, but hot-swap is
        // DEFAULT-ON (`this._hotSwapAppearance = true`, :3495) so a normal
        // equip takes THIS branch and never reached the urgent lane — only the
        // topology-mismatch/throw FALLBACK respawns did, which is why the fix
        // read as "fast but not instant". This `animationCache.get` is the
        // single dominant await of a wear event: the equip's
        // modelChanges/textureChanges change the cache key
        // (`animation.js _substitutionSuffix`), so it is ALWAYS a miss and
        // always pays a full `fetchEntityAnimationKeyframes` walk. Unlike the
        // cast chain, this walk is genuinely multi-round (its closure touches
        // `triangulate_setup_model_per_part` + `try_resolve_cycle_frames`, so
        // it discovers GfxObjs/Animations/Surfaces across rounds), which is
        // exactly the case `prefetch.rs:375`'s `for _round in 0..8` serialises.
        urgent: APPEARANCE_URGENT_ON && (
          ((newMeta.landblockId ?? 0) >>> 0) === 0
          || isNearPlayerLb(this.scene3d, (newMeta.landblockId ?? 0) >>> 0)
        ),
      }
    );

    const newPartGroups = Array.isArray(animEntry.partGroups)
      ? animEntry.partGroups
      : null;
    if (!newPartGroups) return false;
    if (newPartGroups.length !== inst.parts.length) {
      // Topology mismatch — caller despawn+respawn.
      return false;
    }

    // Collect new surface DIDs + decide entity-owned-materials vs cache.
    const allSurfaceDids = new Set();
    for (const pg of newPartGroups) {
      if (!pg) continue;
      for (const did of pg.surfaceDids) allSurfaceDids.add(did >>> 0);
    }
    // `?recolor=off` CHOKE POINT 2 of 3 — the re-dress (appearance hot-swap)
    // path (2026-07-26). Same contract as the spawn twin: the animation bake
    // above still reads `newMeta` RAW (byte-identical rig in both arms); only
    // these two locals — which feed `hasPaletteSubs`, the
    // `fetchEntitySurfacesPixels` call, and the recolored-ladder arm at the bottom
    // of this method — are gated. Off ⇒ the swap takes the plain
    // `materialCache.preload` branch and registers NO owned textures.
    const paletteId = gatePaletteId((newMeta.paletteId ?? 0) >>> 0);
    const subPalettes = gateSubPalettes(newMeta.subPalettes ?? new Uint32Array(0));
    const hasPaletteSubs = paletteId !== 0 || subPalettes.length > 0;
    // R-8 (net-fixwave 2026-07-09) — an appearance change supersedes any
    // pending recolored-surface refresh (its captured palette state is stale);
    // the arm at the bottom of this swap re-schedules against the new state.
    this._cancelRecoloredSurfaceRefresh(inst);
    let hotSwapDecodeMisses = 0;

    let entityMaterials = null;
    if (hasPaletteSubs && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      const dids = new Uint32Array([...allSurfaceDids]);
      if (dids.length > 0) {
        // Wave 7.7 — recolor observability on the hot-swap path too.
        try {
          window.__diag?.clothing?.onRecolorApplication?.({
            guid,
            source: "hot-swap",
            surfaceDidCount: dids.length,
            paletteId,
            subPaletteTripleCount: (subPalettes.length / 3) | 0,
          });
        } catch (_) {}
        const results = await entitySurfacePixelsFetcher(this.wasmExports)(
          dids,
          paletteId,
          subPalettes,
          isNearPlayerLb(this.scene3d, (newMeta.landblockId ?? 0) >>> 0),
        );
        // R-8 — decode audit (see the spawn-path twin): misses arm the
        // ladder's sweep; proven absences join the per-entity skip set.
        hotSwapDecodeMisses = surfaceResultDecodeMisses(results) ?? 0;
        const hotSwapAbsent = surfaceResultProvenAbsent(results);
        if (hotSwapAbsent && hotSwapAbsent.size) {
          if (!inst._recoloredSurfaceAbsent) inst._recoloredSurfaceAbsent = new Set();
          for (const d of hotSwapAbsent) inst._recoloredSurfaceAbsent.add(d >>> 0);
        }
        entityMaterials = new Map();
        const newOwnedMaterials = [];
        const newOwnedTextures = [];
        for (let i = 0; i < dids.length; i += 1) {
          const did = dids[i] >>> 0;
          const sp = results[i];
          if (!sp || sp.width === 0 || sp.height === 0) {
            entityMaterials.set(did, this.materialCache?.fallbackMaterial ?? this._fallbackMaterial());
            if (sp && typeof sp.free === "function") sp.free();
            continue;
          }
          const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
          // C1 — snapshot Surface (0x08) render-state BEFORE `sp.free()`.
          const palSurfaceState = {
            surfaceType: (sp.surfaceType ?? 0) >>> 0,
            translucency: typeof sp.translucency === "number" ? sp.translucency : 0.0,
            luminosity: typeof sp.luminosity === "number" ? sp.luminosity : 0.0,
            diffuse: typeof sp.diffuse === "number" ? sp.diffuse : 0.0,
            // A10-M3 — palettedness for the parityV2 ClipMap alpha-test ref
            // (strict boolean-or-undefined; see the spawn-path twin).
            hasPalette: typeof sp.hasPalette === "boolean" ? sp.hasPalette : undefined,
          };
          if (typeof sp.free === "function") sp.free();
          const mat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false,
          });
          mat.name = `entity-${guid.toString(16)}-surface-${did.toString(16)}`;
          mat.userData = { ...(mat.userData || {}), __disposable: true };
          // C1 — apply palette-path Surface Tier-1 render-state + tag
          // surfaceTypeFlags (mirrors the plain `_materialFromFlags` path).
          this._applyPalettedSurfaceRenderState(mat, palSurfaceState);
          newOwnedMaterials.push(mat);
          newOwnedTextures.push(tex);
          entityMaterials.set(did, mat);
        }
        // Swap owned-asset bookkeeping. Old materials/textures get
        // disposed below after we detach the meshes referencing them.
        inst._pendingOwnedMaterials = newOwnedMaterials;
        inst._pendingOwnedTextures = newOwnedTextures;
      }
    } else if (allSurfaceDids.size > 0 && this.materialCache) {
      try {
        // BUG-3 (`?appearanceUrgent=on`): match the recoloured arm above,
        // which already passes `isNearPlayerLb` as its urgency hint.
        const spFetchRaw = surfacePixelsFetcher(this.wasmExports);
        const hsLb = (newMeta.landblockId ?? 0) >>> 0;
        const hsUrgent = APPEARANCE_URGENT_ON && (
          hsLb === 0 || isNearPlayerLb(this.scene3d, hsLb)
        );
        await this.materialCache.preload(
          [...allSurfaceDids],
          (dids) => spFetchRaw(dids, hsUrgent)
        );
      } catch (e) {
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "hot-swap" }); } catch (_) {}
      }
    }

    // Capture old owned assets for disposal AFTER we've detached the
    // meshes that hold material/geometry refs.
    const oldOwnedMaterials = inst.ownedMaterials.slice();
    const oldOwnedTextures = inst.ownedTextures.slice();

    // Detach all child Meshes of each inst.parts[p], then attach
    // new ones built from newPartGroups[p].
    for (let p = 0; p < inst.parts.length; p += 1) {
      const partGroup = inst.parts[p];
      // remove existing child meshes — EQUIP-3 (2026-08-02): but NEVER a
      // wielded child's root that happens to be mounted on this part (see
      // `_isAttachedChildNode`; retail's `CPhysicsPart::SetPart` likewise
      // rebuilds only the part's own gfx, never the CHILDLIST).
      const oldChildren = partGroup.children.slice();
      for (const child of oldChildren) {
        if (_isAttachedChildNode(child)) continue;
        partGroup.remove(child);
      }
      const conv = newPartGroups[p];
      // ?partDegrade: the swapped-in GfxObj brings its own degrade chain; the new meshes start visible.
      partGroup.userData.didDegrade = ((conv && conv.didDegrade) ?? 0) >>> 0;
      partGroup.userData.__degHidden = false;
      if (!conv) continue;
      // A9-Stage2: retail `CPhysicsPart::SetPart` swaps the part contents
      // in place (the part Group / its transform survives; only the surface
      // meshes are rebuilt) — same build loop as spawn, routed through the
      // single owner. `?rigModule=off` reverts to the byte-identical inline
      // loop. Material resolution stays here (A10 seam, hot-swap variant:
      // `entityMaterials` is the freshly-fetched local Map, not inst._…).
      const resolveSwapMaterial = (grp) => {
        const did = grp.surfaceDid >>> 0;
        if (entityMaterials && entityMaterials.has(did)) {
          return entityMaterials.get(did);
        }
        if (this.materialCache) {
          return this.materialCache.getCached(did, grp.doubleSided);
        }
        return this._fallbackMaterial();
      };
      const swapCastShadow = !!(this.scene3d?.shadowsEnabled || this.scene3d?.csmEnabled);
      if (RIG_MODULE_ON) {
        buildPartSurfaceMeshes(THREE, {
          partGroup,
          conv,
          partIndex: p,
          guid,
          resolveMaterial: resolveSwapMaterial,
          castShadow: swapCastShadow,
          materialCanCastShadow,
          materialRendersNothing,
          onGeometry: (geometry) => inst.registerGeometry(geometry),
        });
      } else {
        for (const grp of conv.groups) {
          const did = grp.surfaceDid >>> 0;
          const mat = resolveSwapMaterial(grp);
          const m = new THREE.Mesh(grp.geometry, mat);
          m.name = `part_${p}_surface_${did.toString(16)}`;
          m.userData = { guid, partIndex: p, surfaceDid: did };
          if (swapCastShadow) {
            m.castShadow = materialCanCastShadow(mat);
          }
          // Mirror of the rig-module skip — see the spawn path above.
          if (materialRendersNothing(mat)) m.visible = false;
          partGroup.add(m);
          inst.registerGeometry(grp.geometry);
        }
      }
    }

    // Indoor-layer invariant — the rebuilt part meshes default to layer 0.
    _stampEntityIndoorLayer(this.scene3d, inst.root);

    // Commit new owned-asset registry; dispose old ones now that
    // nothing references them.
    // `entMB` (2026-07-26) — the re-dress swap is the SECOND registration
    // path into the owned pool (a busy town re-dresses constantly: equip,
    // unequip, dye preview). Route the commit through `registerOwned*`
    // instead of a raw `push` so the tally charges these exactly like the
    // spawn path; clearing the array is not a release (the old objects are
    // released by the dispose loops just below, keyed by identity).
    if (inst._pendingOwnedMaterials) {
      inst.ownedMaterials.length = 0;
      for (const m of inst._pendingOwnedMaterials) inst.registerOwnedMaterial(m);
      delete inst._pendingOwnedMaterials;
    }
    if (inst._pendingOwnedTextures) {
      inst.ownedTextures.length = 0;
      for (const t of inst._pendingOwnedTextures) inst.registerOwnedTexture(t);
      delete inst._pendingOwnedTextures;
    }
    inst._entityMaterials = entityMaterials;
    for (const m of oldOwnedMaterials) {
      entityOwnedTally.disposeMaterial(m);
      try { m.dispose(); } catch (_) {}
    }
    for (const t of oldOwnedTextures) {
      entityOwnedTally.disposeTexture(t);
      try { t.dispose(); } catch (_) {}
    }

    // Update meta with new substitutions so future operations see
    // current state.
    inst.meta = newMeta;

    try {
      window.__diag?.clothing?.onAppearanceChange?.({
        guid,
        source: "hot-swap",
        modelChangesCount: ((newMeta.modelChanges?.length ?? 0) / 2) | 0,
        textureChangesCount: ((newMeta.textureChanges?.length ?? 0) / 3) | 0,
        subPalettesCount: ((newMeta.subPalettes?.length ?? 0) / 3) | 0,
        paletteId: (newMeta.paletteId ?? 0) >>> 0,
      });
    } catch (_) {}

    // === Wave 6 polish — entityAppearanceChanged emit (2026-05-28) ===
    // Hot-swap variant: appearance changed mid-game without despawn+
    // respawn. Mirror the emit from the despawn+respawn path above so
    // examine-target.js (and any other subscriber) refreshes when the
    // hot-swap succeeds. The fallback (`swapped=false`) does NOT emit
    // here because the caller's despawn+respawn path will fire its own
    // emit after spawn lands.
    try {
      window.__pluginClient?.events?.emit?.("entityAppearanceChanged", { guid });
    } catch (_) {}

    // R-8 (net-fixwave 2026-07-09) — hot-swap twin of the spawn-commit
    // recovery arms: a transient empty decode during an appearance change
    // otherwise leaves the new outfit on the mapless fallback until the next
    // respawn (the spawn-path arms never see hot-swapped meshes). Recolored swaps
    // arm the recolored ladder; plain swaps arm the 2026-05-30 plain ladder.
    if (!WIREFRAME_MODE && inst.root) {
      let needsRefresh = hasPaletteSubs && hotSwapDecodeMisses > 0;
      if (!needsRefresh) {
        inst.root.traverse((o) => {
          if (!needsRefresh && o.isMesh && o.material && !o.material.map &&
              o.userData && o.userData.surfaceDid != null) {
            needsRefresh = true;
          }
        });
      }
      if (needsRefresh) {
        if (hasPaletteSubs) {
          this._scheduleRecoloredSurfaceRefresh(inst, {
            paletteId,
            subPalettes,
            dids: new Uint32Array([...allSurfaceDids]),
            missArmed: hotSwapDecodeMisses > 0,
          }, 0);
        } else if (this.materialCache &&
                   typeof this.wasmExports?.fetch_surfaces_pixels === "function") {
          this._scheduleEntitySurfaceRefresh(inst, 0);
        }
      }
    }

    // Phase 2 limbs (2026-08-02) — keep the limb bookkeeping in step with the
    // swapped-in model. A re-dress usually keeps the same Setup (equal part
    // count is already enforced above), but an equipment change CAN swap the
    // base model outright; leaving `_setupId` on the old value would key the
    // limp at the wrong registry. Pure data writes — no behaviour change with
    // the flag off. On an actual model change any in-flight limp state is
    // dropped (its remembered part transforms describe the old rig).
    const _limbRest = animEntry.restOrigins ?? null;
    const _limbRestQ = animEntry.restOrientations ?? null;
    const _limbHasRest =
      !!_limbRest && !!_limbRestQ &&
      _limbRest.length === inst.parts.length * 3 &&
      _limbRestQ.length === inst.parts.length * 4;
    if ((inst._setupId >>> 0) !== setupId) {
      inst._limpState = null;
      if (inst._limbDamage) inst._limbDamage.clear();
    }
    inst._setupId = setupId;
    inst._restOrigins = _limbHasRest ? _limbRest : null;
    inst._restOrientations = _limbHasRest ? _limbRestQ : null;

    return true;
  }

  /**
   * Remove an entity by GUID. Tears down geometries, textures, mixer.
   */
  // (2026-07-06) Stop a freshly-dead remote creature from coasting. The
  // dead-reckon ease (tick, ~line 11300) extrapolates the last VectorUpdate
  // velocity forward between position packets; a monster that died mid-charge
  // keeps sliding, so the authoritative corpse (server death spot) lands behind
  // the rig. Clearing the target + velocity settles the rig; `_deadFrozen` is a
  // belt-and-braces guard the ease also checks.
  _freezeDeadReckon(inst) {
    if (!inst) return;
    inst._deadFrozen = true;
    inst._serverTargetPos = null;   // position-ease guard requires this → skips
    inst.lastVel = null;            // stop velocity extrapolation
    inst._headingEaseInit = false;  // stop heading slerp toward a stale target
  }

  // (2026-07-06) Corpse↔creature death handoff. On death ACE sends three
  // independent objects with no linkage: the creature's Dead motion, a separate
  // corpse CreateObject at the server death spot, then the creature's delete.
  // Played naively the prone corpse pops in while the creature is still
  // collapsing, and at a slightly different spot (dead-reckon overshoot +
  // ground-clamp skew). Correlate them: find the just-died creature under this
  // fresh corpse, snap it onto the corpse's AUTHORITATIVE transform (position AND
  // orientation line up), hide the corpse, let the collapse play, then reveal the
  // corpse and remove the creature on the collapse's own clock. Called from
  // _spawnImpl right after commit when the spawn carries the ODF Corpse bit.
  _tryCorpseDeathHandoff(corpseInst) {
    if (!corpseInst || !corpseInst.root) return;
    const cp = corpseInst.root.position;
    const now = _entityNowMs();
    // Nearest still-collapsing, unclaimed creature within the correlation radius.
    let best = null;
    let bestD2 = DEATH_COLLAPSE_RADIUS_SQ;
    for (const inst of this.entityMap.values()) {
      if (inst === corpseInst) continue;
      if (typeof inst._deathAt !== "number") continue;
      if (inst._corpseHandoffGuid) continue; // already owns a corpse
      // Correlation window: the authored-collapse clock, EXTENDED while a
      // ragdoll is still live (the sim runs 2-4s, and the corpse's async
      // time-sliced spawn can land after a short authored collapse expired —
      // 2026-08-02 trace, bug #3) plus a grace for busy spawn queues.
      const endAt = inst._deathEndAt ?? (inst._deathAt + DEATH_HOLD_FALLBACK_MS);
      const ragdollLive = RAGDOLL_ON && inst._ragdoll && !inst._ragdoll.sim?.done;
      // Bug 6 (2026-10-07): a creature whose server delete already arrived is
      // held by `_armRemove` only so a corpse can claim it — always in-window.
      if (!ragdollLive && !inst._removePending && now >= endAt + DEATH_CORRELATE_GRACE_MS) continue;
      const p = inst.root?.position;
      if (!p) continue;
      const dx = p.x - cp.x, dy = p.y - cp.y, dz = p.z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // Live-ragdoll creatures match at 2× radius: a monster that died
      // mid-charge can dead-reckon several metres past the server death spot
      // before the freeze lands, and a missed correlation here IS the
      // "authored corpse appears" failure.
      const maxD2 = ragdollLive ? DEATH_COLLAPSE_RADIUS_SQ * 4 : DEATH_COLLAPSE_RADIUS_SQ;
      if (d2 < maxD2 && d2 < bestD2) { bestD2 = d2; best = inst; }
    }
    if (!best) {
      if (RAGDOLL_ON) {
        // Bug 6 diag: name the nearest dying creature that was rejected and why.
        let near = null, nearD2 = Infinity, why = "none";
        for (const inst of this.entityMap.values()) {
          if (inst === corpseInst || typeof inst._deathAt !== "number") continue;
          const p = inst.root?.position;
          if (!p) continue;
          const d2 = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2 + (p.z - cp.z) ** 2;
          if (d2 < nearD2) { nearD2 = d2; near = inst; }
        }
        if (near) {
          const endAt = near._deathEndAt ?? (near._deathAt + DEATH_HOLD_FALLBACK_MS);
          why = near._corpseHandoffGuid ? "claimed"
            : (now >= endAt + DEATH_CORRELATE_GRACE_MS && !near._removePending) ? "window"
            : "distance";
        }
        // eslint-disable-next-line no-console
        console.info(
          `[handoff] corpse 0x${(corpseInst.guid >>> 0).toString(16)}: no dying creature matched — authored pose shows` +
          (near ? ` (nearest 0x${(near.guid >>> 0).toString(16)} d=${Math.sqrt(nearD2).toFixed(1)}m rejected: ${why})` : " (no dying creature present)"),
        );
      }
      return; // no dying creature here → corpse shows normally
    }

    // Align the collapsing rig with the corpse's authoritative transform so the
    // reveal is seamless in BOTH position and heading (the corpse's server
    // orientation is the creature's death orientation), then hide the corpse.
    // Hide via the STATE-VISIBLE channel: `root.visible` has a single legal
    // writer (_applyEntityVisible) and a raw write here was stomped back to
    // true by the very next frustum-cull recompose — the authored corpse was
    // visible during the whole fall (2026-08-02 trace, bug #1).
    best.root.position.copy(cp);
    best.root.quaternion.copy(corpseInst.root.quaternion);
    this._freezeDeadReckon(best);
    best._corpseHandoffGuid = corpseInst.guid >>> 0; // _armRemove yields to us
    _setEntityStateVisible(corpseInst, false);
    corpseInst._hiddenForHandoff = true;
    if (RAGDOLL_ON) {
      // eslint-disable-next-line no-console
      console.info(`[handoff] corpse 0x${(corpseInst.guid >>> 0).toString(16)} ↔ creature 0x${(best.guid >>> 0).toString(16)} (d=${Math.sqrt(bestD2).toFixed(1)}m)`);
    }

    const revealAt = best._deathEndAt ?? (best._deathAt + DEATH_HOLD_FALLBACK_MS);
    const remaining = Math.max(0, revealAt - now);
    const corpseGuid = corpseInst.guid >>> 0;
    const creatureGuid = best.guid >>> 0;
    // Phase 4 ragdoll (`?ragdoll=on`) — persist the sprawl onto the LOOTABLE
    // corpse object before it reveals: copy the dying creature's final ragdoll
    // part transforms onto the corpse rig as a frozen post-mixer overwrite
    // (part-count-guarded; on mismatch the corpse keeps the authored prone
    // pose). The corpse object itself — server position, picking meshes,
    // selection, nameplate — is untouched, so looting works exactly as
    // before; only the pose differs. The reveal WAITS (bounded) for the sim
    // to settle: revealing on the authored-collapse clock froze a MID-FALL
    // pose — or none at all — which read as "the old corpse animation came
    // back" (2026-08-02 field report).
    const finishReveal = (settleRetries) => {
      try {
        const corpse = this.entityMap.get(corpseGuid);
        const creature = this.entityMap.get(creatureGuid);
        if (
          RAGDOLL_ON && settleRetries > 0 &&
          creature?._ragdoll && !creature._ragdoll.sim?.done
        ) {
          setTimeout(() => finishReveal(settleRetries - 1), 500);
          return;
        }
        if (RAGDOLL_ON) {
          // eslint-disable-next-line no-console
          console.info(`[handoff] reveal 0x${corpseGuid.toString(16)}: creature=${creature ? "present" : "GONE"} ragdoll=${creature?._ragdoll ? (creature._ragdoll.sim?.done ? "settled" : "live") : "none"} retries-left=${settleRetries}`);
        }
        if (RAGDOLL_ON && creature?._ragdoll && corpse) {
          transferRagdollPose(creature, corpse);
          // apply synchronously so the reveal frame already shows the sprawl
          // (the tick re-asserts every frame afterwards)
          applyFrozenPose(corpse);
        }
        // Dismemberment carry-over (`?dismember=on`): stumps/hidden parts
        // move onto the corpse rig so a leg lost mid-fight STAYS lost on the
        // lootable corpse. Window hook — see window.__carnageOnDeath pattern.
        if (creature && corpse) {
          try { window.__dismemberTransfer?.(creature, corpse); } catch (_e) { /* optional */ }
        }
        if (corpse && corpse._hiddenForHandoff) {
          // reveal via the composite writer (same invariant as the hide)
          _setEntityStateVisible(corpse, true);
          corpse._hiddenForHandoff = false;
        }
        // Remove the collapsed creature now that the corpse has taken over. The
        // creature's own KIND_REMOVE deferral yielded to us (_corpseHandoffGuid);
        // remove() no-ops if it already went.
        this.remove(creatureGuid);
      } catch (_) { /* handoff must never throw into a timer */ }
    };
    setTimeout(() => finishReveal(8), remaining);
  }

  remove(guid) {
    const g = guid >>> 0;
    // Batch 9 #2 (2026-06-07): bump the spawn generation FIRST — even on
    // the early-return path below. A remove() that races an in-flight
    // _spawnImpl (entityMap has no committed entry yet) must still
    // invalidate that spawn so its Step-E liveness guard disposes the
    // half-built rig instead of attaching a ghost.
    if (this._spawnGen.has(g)) {
      this._spawnGen.set(g, ((this._spawnGen.get(g) | 0) + 1) | 0);
    }
    // P4.3/LEAK-02 — purge the park maps BEFORE the `!inst` bail below.
    // An event parks only because the guid has NO committed `entityMap`
    // entry, so purging after the bail cannot reach the case the purge
    // exists for: an ObjectDelete for a guid that never spawned leaves its
    // bucket to the 25 s sweep at best, and to the process lifetime when
    // `?preCreateBuffer=off` routes parks to the sweeperless legacy maps.
    // Retail made the identical mistake in `CObjectMaint::DeleteObject`
    // (acclient.c:309939): the `weenie_object_table` bucket miss at
    // :309986-309988 jumps past the `null_weenie_object_table` removal at
    // :309999, which sits inside the hit branch opened at :309995.
    // Keyed by g only — no `inst` dependency.
    this._pendingAttach.delete(g);
    // A8-M4 (2026-06-12): retail RemoveObjectToBeDestroyed cancels the
    // placeholder's timer on real removal (acclient.c:309906-309915).
    // Parked attaches keyed by OTHER child guids that name this guid as
    // wielder are left to the 25 s expiry, matching the legacy
    // `_pendingAttach` behavior. No-op when the buffer is empty.
    this._preCreate.purgeGuid(g);
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // F16-4 — clear the selected target when its entity despawns
    // (ObjectDelete / corpse swap / out-of-vision). Otherwise the target
    // bar keeps showing the dead guid and the next attack/cast/Use is sent
    // against a nonexistent object and silently fails — reads as "combat
    // stopped working". Emitted BEFORE entityMap.delete so subscribers can
    // still resolve the old name from prevGuid if they need it.
    if ((this._selectedGuid >>> 0) === g && g !== 0) {
      this._selectedGuid = 0;
      // Retail target indicator (2026-08-02): drop the overlay too, else the
      // brackets keep projecting a disposed rig. Retail's equivalent is
      // `SmartBox::GetObjectBoundingBox` returning status 3 (object unknown)
      // once CObjectMaint no longer resolves the iid (acclient.c:144083).
      try { this.scene3d?.selectionBracketLayer?.setTarget(0, null, null); } catch (_) {}
      try {
        window.__pluginClient?.events?.emit?.("selectionChanged", {
          guid: 0,
          prevGuid: g,
        });
      } catch (_) { /* never block despawn on a subscriber fault */ }
    }
    // Render-completeness audit (2026-05-29) — wielded-item lifecycle.
    // If this entity is a WIELDER with attached children, detach them first
    // so they aren't dragged out of the scene (and left tracked-but-orphaned)
    // when the wielder's `dispose()` removes its subtree. Detach hides them;
    // ACE normally ObjectDeletes wielded items alongside their wielder.
    if (inst._attachedChildren && inst._attachedChildren.size > 0) {
      for (const childGuid of [...inst._attachedChildren]) {
        this._detachChild(childGuid);
      }
      inst._attachedChildren.clear();
    }
    // If this entity is itself an attached CHILD, unlink it from its wielder
    // and drop any pending request so we don't leak a stale reference.
    if (inst._attachedParentGuid != null) {
      const p = this.entityMap.get(inst._attachedParentGuid >>> 0);
      if (p && p._attachedChildren) p._attachedChildren.delete(g);
    }
    // F17-5 (2026-06-09): tear down any in-flight speech bubble so a despawn
    // mid-fade doesn't leak its texture/material (the fade loop would
    // otherwise keep the sprite alive under the detached root).
    removeSpeechBubbleFromEntity(inst);
    // B4 (2026-05-18): drop the name→guid index entry BEFORE dispose
    // so we still have access to `inst.meta.name`. Removes the bucket
    // entirely once empty to avoid a long-session leak of empty Sets.
    if (inst.meta && typeof inst.meta.name === "string" && inst.meta.name.length > 0) {
      const bucket = this._nameToGuid.get(inst.meta.name);
      if (bucket) {
        bucket.delete(g);
        if (bucket.size === 0) this._nameToGuid.delete(inst.meta.name);
      }
    }
    // LIGHT-GUARD (2026-10-05) — release the Setup lights that lighting.js
    // `attachSetupModelLights` (recordEntities) parented under this rig. Only
    // the `?entityLights` path (`inst._setupLights`, below) was ever spliced
    // out of `scene3d.activeLights`; these default-path rig lights (green
    // dungeon portals, lit creatures, Acid Stream bolts…) leaked forever as
    // ghost pool sources frozen at the despawn pose.
    if (inst._setupLightScanned === true && inst.root && Array.isArray(this.scene3d?.activeLights)) {
      const active = this.scene3d.activeLights;
      try {
        inst.root.traverse((o) => {
          if (!o.isLight) return;
          const idx = active.indexOf(o);
          if (idx !== -1) active.splice(idx, 1);
        });
      } catch (_) { /* never block a despawn on light bookkeeping */ }
    }
    inst.dispose();
    this.entityMap.delete(g);
    this.removeCount += 1;
    // Follow-on #10 (3D port state doc) — drop the DOM nameplate too.
    // Idempotent on the layer side (silent no-op for unknown GUIDs)
    // so a re-spawn that already removed its nameplate doesn't error.
    if (this.scene3d?.nameplateLayer) {
      try {
        this.scene3d.nameplateLayer.removeNameplate(g);
      } catch (_) {}
    }
    // H2 (2026-05-12): stop + destroy any particle emitters attached
    // to this entity. Without this, fireworks rocket emitters from
    // despawned rockets would keep spawning particles for their full
    // lifespan after the rocket disappeared.
    const emitterIds = this._particleEmittersForGuid.get(g);
    if (emitterIds && this._worldParticleManager) {
      for (const eId of emitterIds) {
        try {
          this._worldParticleManager.destroyParticleEmitter(eId);
        } catch (_) {}
      }
      this._particleEmittersForGuid.delete(g);
    }
    // A11-S2: owner-facade teardown — the ONE `destroyAllForOwner` API
    // (retail destroy_particle_manager on the CPhysicsObj destructor path,
    // acclient.c:318082-318095). With the flag on, every emitter this guid
    // owns (H2 chain + AnimationHook 13/26 + PlayEffect one-shots) lives in
    // the registry, the legacy map above stays empty, and this single call
    // (plus its epoch tombstone for in-flight creates) is the teardown.
    if (particleOwnerOn()) {
      try { ownerRegistry.destroyAllForOwner(g); } catch (_) {}
    }
    // H3-E1 (2026-05-12): cancel any pending Sound / SoundTweaked
    // setTimeout schedules. If we didn't, a sound queued at start_time
    // = 30s would fire 30s after the rocket already despawned.
    const timeouts = this._soundTimeoutsForGuid.get(g);
    if (timeouts) {
      for (const tid of timeouts) {
        try { clearTimeout(tid); } catch (_) {}
      }
      this._soundTimeoutsForGuid.delete(g);
    }
    // A11-S1: drop this entity's PhysicsScript queue (and its still-pending
    // hooks) so a despawn mid-script doesn't fire hooks onto a released rig
    // or leak the manager. (`?scriptQueue=on` only.)
    const sm = this._scriptManagersForGuid.get(g);
    if (sm) {
      try { sm.clear(); } catch (_) {}
      this._scriptManagersForGuid.delete(g);
    }
    this._particleChainsAttached.delete(g);
    this._pendingProjectileStops?.delete(g);
    // === Wave R3.B (2026-05-29) — drop the per-guid sort-center attach guard
    // so a re-spawn of the same guid re-attaches. The per-SETUP offset cache
    // (`_sortCenterCache`) is intentionally NOT cleared here — it's keyed by
    // setupId and shared across entities, so it survives individual removals.
    this._sortCenterAttached.delete(g);
    // === Wave R2.A (2026-05-28) — release entity-attached lights.
    // `inst.dispose()` (above) already detached the rig subtree (and with
    // it the part-parented lights) from the scene graph, but the lights are
    // also referenced in `scene3d.activeLights` for the per-frame distance
    // cap. Splice them out so the sort doesn't keep stale handles, and
    // decrement the global entity-light count so freed slots are reclaimable
    // by later spawns under the per-preset cap.
    if (Array.isArray(inst._setupLights) && inst._setupLights.length > 0) {
      const active = this.scene3d?.activeLights;
      for (const light of inst._setupLights) {
        if (Array.isArray(active)) {
          const idx = active.indexOf(light);
          if (idx !== -1) active.splice(idx, 1);
        }
        if (light.parent) light.parent.remove(light);
        if (typeof light.dispose === "function") {
          try { light.dispose(); } catch (_) {}
        }
      }
      this._entityLightCount = Math.max(
        0,
        (this._entityLightCount | 0) - inst._setupLights.length
      );
      inst._setupLights = null;
    }
    // F.D-fu3: also drop the resolve-promise entry so a re-spawn
    // with the same GUID gets a fresh promise. The old promise has
    // already resolved by now in the common case (chain walks are
    // fast vs entity lifetime); we don't need to await it before
    // dropping the reference.
    this._particleChainResolveForGuid.delete(g);
  }

  /**
   * === Wave R2.A (2026-05-28) — attach entity-local dynamic lights.
   *
   * Gated by `?entityLights=on` (checked by the caller via
   * `this._entityLightsOn`). Fetches the entity's SetupModel LightInfo
   * descriptors through the SAME wasm export the static path uses
   * (`fetchSetupModelLights`), constructs one `THREE.PointLight`
   * (`cone_angle == 0`) or `THREE.SpotLight` (`cone_angle > 0`) per
   * descriptor via `lighting.js::buildLightForSetupLight`, and parents each
   * under its matching per-part Group (`inst.parts[partIndex]`) so the light
   * rides the rig — exactly mirroring `attachSetupModelLights`'s static path.
   *
   * Lights start OFF: `visible = false` and `intensity = 0`. The decoded
   * intensity is stashed on `light.userData.__setupIntensity` so the
   * SetLight (25) hook can toggle it back on without re-reading the DAT.
   * They're pushed onto `scene3d.activeLights` so the existing per-frame
   * distance cap (`lighting.js`, MAX_ACTIVE_LIGHTS=32) governs which render.
   *
   * Count-capped at `this._entityLightCap` (per quality preset). When the
   * cap is hit we log ONCE (no silent caps, per the team-agents-plan rule)
   * and stop creating further entity lights.
   *
   * Async (the wasm fetch is awaited); fire-and-forget at the call site so
   * spawn return isn't blocked. Returns a small descriptor for harnesses.
   */
  async _attachEntityLights(inst, setupId, opts = undefined) {
    const summary = { created: 0, capped: false };
    // PROJ-VIS (2026-10-05): `opts.projectile` = a MISSILE's lights (see the
    // spawn-site note): tagged `__dynamicPriority` so the light pool gives
    // them a slot ahead of static torches (retail: dynamic lights claim HW
    // slots before statics, minimize_object_lighting acclient.c:380659), and
    // `opts.startOn` lights them immediately (PhysicsState LIGHTING_ON).
    const projectile = !!(opts && opts.projectile);
    if (!inst || !inst.root || !Array.isArray(inst.parts)) return summary;
    const sid = setupId >>> 0;
    // Raw 0x01 GfxObjs (setup_id >> 24 != 0x02) carry no Setup → no lights.
    // The wasm helper returns empty for these too, but short-circuiting here
    // saves a boundary round-trip on the common case (most entities).
    if ((sid >>> 24) !== 0x02) return summary;
    // Already at the cap before we even fetch — nothing to do.
    if ((this._entityLightCount | 0) >= (this._entityLightCap | 0)) {
      this._maybeLogEntityLightCap();
      summary.capped = true;
      return summary;
    }

    let bundle;
    try {
      bundle = await this.wasmExports.fetchSetupModelLights(sid);
    } catch (_) {
      return summary; // network/IO prefetch error — treat as no lights.
    }
    if (!bundle) return summary;
    const lightCount = bundle.partCount | 0;
    if (lightCount === 0) {
      if (typeof bundle.free === "function") {
        try { bundle.free(); } catch (_) {}
      }
      return summary;
    }
    const setupLights = bundle.takeLights();
    if (typeof bundle.free === "function") {
      try { bundle.free(); } catch (_) {}
    }

    // The entity may have been removed while the fetch was in flight.
    // 2026-08-03 — must be an IDENTITY check, not `has(guid)`: a same-guid
    // respawn (dynamic-LOD `_respawnForLod`, appearance despawn+respawn) puts a
    // NEW instance under this guid, so `has()` passes while `inst` is the dead
    // one. Attaching then parents lights to a detached rig and pushes them into
    // `scene3d.activeLights` / `_entityLightCount` with no owner left to release
    // them (remove() already ran and nulled `inst._setupLights`).
    if (inst._disposed || this.entityMap.get(inst.guid >>> 0) !== inst) {
      for (const sl of setupLights) {
        if (typeof sl.free === "function") { try { sl.free(); } catch (_) {} }
      }
      return summary;
    }

    if (!Array.isArray(this.scene3d?.activeLights)) {
      if (this.scene3d) this.scene3d.activeLights = [];
    }
    const active = this.scene3d?.activeLights;

    for (const sl of setupLights) {
      // Honour the per-preset cap mid-loop — a single Setup can carry more
      // light descriptors than the remaining budget allows.
      if ((this._entityLightCount | 0) >= (this._entityLightCap | 0)) {
        this._maybeLogEntityLightCap();
        summary.capped = true;
        if (typeof sl.free === "function") { try { sl.free(); } catch (_) {} }
        continue;
      }
      const targetPartIndex = sl.partIndex >>> 0;
      const partGroup = inst.parts[targetPartIndex];
      if (!partGroup) {
        // Light references a part index this rig didn't build — skip.
        if (typeof sl.free === "function") { try { sl.free(); } catch (_) {} }
        continue;
      }
      // Reuse the static-light constructor for identical color/intensity/
      // falloff/cone math (PointLight vs SpotLight selection included).
      const light = buildLightForSetupLight(sl);
      if (typeof sl.free === "function") { try { sl.free(); } catch (_) {} }
      if (light === null) continue;
      // Start OFF. Remember the authored intensity so the SetLight hook can
      // restore it; the static path leaves lights ON, but entity SetLight
      // lights default dark until the animation's lightsOn hook fires.
      light.userData = light.userData || {};
      light.userData.__setupIntensity = light.intensity;
      light.userData.__entityLight = true;
      light.intensity = 0;
      light.visible = false;
      if (projectile) {
        light.userData.__dynamicPriority = true;
        inst._projectileLights = true;
        // Lit only while the bolt is still in flight and drawn: an impact (or
        // NoDraw) that landed during the async LightInfo fetch keeps it dark.
        if (opts.startOn && !inst._projectileImpacted && inst._stateVisible !== false) {
          light.intensity = light.userData.__setupIntensity;
        }
      }
      partGroup.add(light);
      if (Array.isArray(active)) active.push(light);
      if (!Array.isArray(inst._setupLights)) inst._setupLights = [];
      inst._setupLights.push(light);
      this._entityLightCount = (this._entityLightCount | 0) + 1;
      summary.created += 1;
    }
    return summary;
  }

  /**
   * === Wave R3.B (2026-05-29) — attach per-part sort-center offsets.
   *
   * Gated by `?sortCenter=on` (the caller checks `this._sortCenterOn`).
   * Fetches the entity's per-part `GfxObj.sort_center` offsets through the
   * `fetchSetupPartSortCenters` wasm export (one fetch per UNIQUE setupId,
   * memoised in `this._sortCenterCache`), and stashes a flat Float32Array
   * (3 floats per part, part-index order) on `inst._partSortCenters`. The
   * per-frame `tick(dt)` reads that array to project each transparent part's
   * authored sort point to view-space Z and assign a stable `renderOrder`.
   *
   * `inst._sortablePartCount` caches how many parts carry a transparent mesh
   * (computed lazily in the tick on first sort) — but the OFFSETS must land
   * first, so this attach only provides the data; the tick owns the "skip
   * unless > 1 transparent part" gate. Async; fire-and-forget at the call
   * site so spawn return isn't blocked. Idempotent per guid.
   */
  async _attachSortCenters(inst, setupId) {
    if (!inst || !inst.root || !Array.isArray(inst.parts)) return;
    const sid = setupId >>> 0;
    const guid = inst.guid >>> 0;
    if (this._sortCenterAttached.has(guid)) return;
    this._sortCenterAttached.add(guid);

    // Serve from the per-setup cache when warm (the common case once a few
    // entities of the same setup have spawned).
    const cached = this._sortCenterCache.get(sid);
    if (cached) {
      inst._partSortCenters = cached;
      return;
    }
    // Dedup concurrent fetches of the same setup id (two NPCs sharing a setup
    // spawning near-simultaneously share one wasm round-trip).
    let inflight = this._sortCenterInFlight.get(sid);
    if (!inflight) {
      inflight = (async () => {
        let bundle;
        try {
          bundle = await this.wasmExports.fetchSetupPartSortCenters(sid);
        } catch (_) {
          return null; // network/IO prefetch error — treat as no sort data.
        }
        if (!bundle) return null;
        const partCount = bundle.partCount | 0;
        const centers = bundle.takeCenters();
        if (typeof bundle.free === "function") {
          try { bundle.free(); } catch (_) {}
        }
        if (partCount === 0 || !Array.isArray(centers) || centers.length === 0) {
          for (const c of centers || []) {
            if (typeof c.free === "function") { try { c.free(); } catch (_) {} }
          }
          return null;
        }
        // Flatten to (partIndex -> x,y,z). centers[] is part-index order from
        // the wasm side, but key off `partIndex` defensively so a gap can't
        // misalign the rest.
        const flat = new Float32Array(partCount * 3);
        for (const c of centers) {
          const pi = c.partIndex >>> 0;
          if (pi < partCount) {
            flat[pi * 3 + 0] = c.x;
            flat[pi * 3 + 1] = c.y;
            flat[pi * 3 + 2] = c.z;
          }
          if (typeof c.free === "function") { try { c.free(); } catch (_) {} }
        }
        this._sortCenterCache.set(sid, flat);
        return flat;
      })();
      this._sortCenterInFlight.set(sid, inflight);
      // Drop the in-flight handle once it settles so a later miss re-fetches
      // only if the cache write didn't happen (null result).
      inflight.finally(() => {
        if (this._sortCenterInFlight.get(sid) === inflight) {
          this._sortCenterInFlight.delete(sid);
        }
      });
    }
    const flat = await inflight;
    // The entity may have been removed while the fetch was in flight.
    if (!flat || !this.entityMap.has(guid)) return;
    inst._partSortCenters = flat;
  }

  /**
   * === Wave R3.B (2026-05-29) — per-frame transparent-part sort.
   *
   * Called from `tick(dt)` ONLY when `this._sortCenterOn`. For one entity:
   * collect its parts that carry at least one transparent mesh; if there are
   * ≤ 1, return immediately (the overwhelmingly common case — most entities
   * have zero transparent parts, so this is a cheap early-out). For each
   * transparent part, take its Group world position, add the surfaced
   * per-part `GfxObj.sort_center` offset (rotated into world space by the
   * part's world quaternion), and project to the camera's view-space Z
   * (`applyMatrix4(camera.matrixWorldInverse)` → smaller/more-negative z =
   * farther). Sort parts back-to-front and assign `renderOrder` in the
   * reserved negative band so THREE draws them in that order regardless of
   * its own per-object bounding-sphere heuristic.
   *
   * @private
   */
  _tickSortCenters(inst, camera) {
    if (!inst || !Array.isArray(inst.parts) || inst.parts.length < 2) return;
    const offsets = inst._partSortCenters;
    if (!offsets) return; // offsets haven't landed yet (or none for this setup)
    if (!camera || !camera.matrixWorldInverse) return;

    // Collect transparent parts (a part is "transparent" if any of its mesh
    // leaves has a transparent material). Reuse a per-instance scratch array
    // to avoid per-frame allocation.
    let list = inst._sortCenterPartList;
    if (!list) list = inst._sortCenterPartList = [];
    list.length = 0;
    for (let p = 0; p < inst.parts.length; p += 1) {
      const part = inst.parts[p];
      if (!part || !part.children) continue;
      let hasTransparent = false;
      for (const child of part.children) {
        if (child.isMesh && child.material && child.material.transparent) {
          hasTransparent = true;
          break;
        }
      }
      if (hasTransparent) list.push(p);
    }
    // ≤ 1 transparent part → nothing to disambiguate; leave renderOrder alone.
    if (list.length <= 1) {
      // If a previous frame set renderOrder on parts that are no longer
      // transparent (e.g. a fade completed), reset them to the default 0 so
      // we don't leave stale ordering behind.
      this._clearSortRenderOrders(inst);
      return;
    }

    // Compute view-space depth for each transparent part.
    // RP2 (2026-06-08): the keyed array is reused (`.length = 0`) AND its
    // entry OBJECTS are pooled in `_sortCenterKeyedPool`, so the per-frame
    // sort pass allocates nothing once an entity's transparent-part count has
    // stabilised (previously each part pushed a fresh `{part,z}` literal every
    // frame). The pool grows monotonically to the max part count ever seen and
    // is reused across frames; `keyed` holds (possibly-reordered after sort)
    // references INTO the pool, so we index `keyed[i].part`, never the pool by
    // slot, after the sort. Whole block runs only when `?sortCenter=on`.
    let keyed = inst._sortCenterKeyed;
    if (!keyed) keyed = inst._sortCenterKeyed = [];
    keyed.length = 0;
    let pool = inst._sortCenterKeyedPool;
    if (!pool) pool = inst._sortCenterKeyedPool = [];
    let poolIdx = 0;
    for (const p of list) {
      const part = inst.parts[p];
      // World position of the part Group.
      part.getWorldPosition(_sortCenterScratchVec3);
      // Add the authored sort-center offset, rotated by the part's world
      // orientation so the offset tracks the animated part frame.
      const ox = offsets[p * 3 + 0];
      const oy = offsets[p * 3 + 1];
      const oz = offsets[p * 3 + 2];
      if (ox !== 0 || oy !== 0 || oz !== 0) {
        _sortCenterScratchView.set(ox, oy, oz);
        if (typeof part.getWorldQuaternion === "function") {
          _sortCenterScratchView.applyQuaternion(
            part.getWorldQuaternion(_sortCenterScratchQuat)
          );
        }
        _sortCenterScratchVec3.add(_sortCenterScratchView);
      }
      // Project into the camera's view space; .z is the depth (more negative
      // = farther in front of the camera, per three.js view-space convention).
      _sortCenterScratchVec3.applyMatrix4(camera.matrixWorldInverse);
      // Reuse a pooled entry object (grow the pool only on first sight of a
      // larger transparent-part count); overwrite its fields in place.
      let entry = pool[poolIdx];
      if (entry === undefined) entry = pool[poolIdx] = { part: 0, z: 0 };
      entry.part = p;
      entry.z = _sortCenterScratchVec3.z;
      keyed.push(entry);
      poolIdx += 1;
    }
    // Back-to-front: farthest (most negative view z) first → lowest
    // renderOrder, so it draws first and nearer parts blend over it.
    keyed.sort((a, b) => a.z - b.z);
    for (let i = 0; i < keyed.length; i += 1) {
      const part = inst.parts[keyed[i].part];
      if (!part || !part.children) continue;
      const ro = SORT_CENTER_RENDER_ORDER_BASE + i;
      for (const child of part.children) {
        if (child.isMesh) child.renderOrder = ro;
      }
    }
  }

  /**
   * === Wave R3.B — reset any renderOrder this manager set on an entity's
   * meshes back to the THREE default (0). Used when a previously-multi-
   * transparent entity drops to ≤ 1 transparent part so stale ordering
   * doesn't linger. Only touches meshes we actually tagged (renderOrder in
   * the reserved negative band), leaving other renderOrder users untouched.
   * @private
   */
  _clearSortRenderOrders(inst) {
    if (!inst || !Array.isArray(inst.parts)) return;
    for (const part of inst.parts) {
      if (!part || !part.children) continue;
      for (const child of part.children) {
        if (
          child.isMesh &&
          child.renderOrder <= SORT_CENTER_RENDER_ORDER_BASE + 64 &&
          child.renderOrder >= SORT_CENTER_RENDER_ORDER_BASE
        ) {
          child.renderOrder = 0;
        }
      }
    }
  }

  /**
   * === Wave R2.A — log the entity-light cap exactly once (no-silent-caps).
   */
  _maybeLogEntityLightCap() {
    if (this._entityLightCapHitLogged) return;
    this._entityLightCapHitLogged = true;
    const presetName = this.scene3d?.quality?.preset ?? "(default)";
    // eslint-disable-next-line no-console
    console.info(
      `[entities/R2.A] entity-light cap reached: ${this._entityLightCount}/` +
      `${this._entityLightCap} (quality=${presetName}). Further entity ` +
      `SetLight lights will not be created this session.`
    );
  }

  /**
   * H2 (2026-05-12): walk an entity's PhysicsScript chain and attach
   * a ParticleManager emitter per CreateParticleHook (hookType 13 or
   * 26). Mirrors `sky_dome.js::_attachParticleChainFromState` but
   * anchors emitters on the entity's rig instead of the sky-cell
   * origin, so particles follow the entity if it moves (e.g. firework
   * rockets in flight).
   *
   * Chain: entity.physicsScriptDid (0x33..) → fetchPhysicsScript →
   * each CreateParticleHook → fetchParticleEmitter → addEmitter with
   * parent=entity.rig.
   *
   * Lazily creates `this._worldParticleManager` on first call. The
   * manager's scene is `entitiesGroup` so per-particle THREE.Meshes
   * are siblings of the entity rigs.
   */
  /**
   * 2026-05-18 motion-link experiment. Fetch a transition clip from
   * the MotionTable's Links table for `(stance, fromCmd → toCmd)`.
   * On hit, play it once (LoopOnce, clampWhenFinished=false) so the
   * rig animates the transition before the destination cycle takes
   * over. On miss, no-op — caller's existing crossfade-to-cycle
   * path runs unchanged.
   *
   * A4 (waves-2, DEFERRED 2026-05-29 — grounded, not implemented). This is
   * SINGLE-HOP: one direct `(stance, fromCmd → toCmd)` link. Retail
   * `GetObjectSequence` (acclient.c:337641; ACE MotionTable.cs:121-188) does
   * a VIA-DEFAULT two-hop when no direct link exists: exit-link
   * (currentSubstate → style default) + entry-link (default → target) +
   * dest-cycle + `re_modify`, concatenated into one Sequence (e.g. Run→Ready
   * →Crouch when Run→Crouch is absent). We do NOT synthesize that here — on a
   * direct-link miss the caller falls back to a plain crossfade, which is
   * visually acceptable. Deferred as diminishing-returns: the gap only fires
   * on exotic state-to-state transitions a viewer rarely sees framed, the
   * fix is high-effort (multi-record Sequence concat), and `re_modify`
   * depends on the A2 modifier machinery that is intentionally unbuilt
   * (see [[render-completeness-waves2]] / motion_table.rs `modifiers`).
   * Intra-link multi-segment chaining (windup→strike→recover within ONE link
   * record) IS already handled by try_resolve_link_frames (T4, lib.rs).
   */
  // Stance-change links (see setMotion): direct links[(from, Ready)][to], else
  // the retail two-hop through the default style (acclient.c:337726).
  // FETCH ONLY: resolves to `[{ entry, toCmd, stance }]` in play order (empty
  // when no link exists). setMotion plays them together with the new cycle.
  async _resolveStyleLinks(inst, setupId, mtableId, fromStyle, toStyle) {
    const full = (s) => (((s >>> 0) & 0xffff) | 0x80000000) >>> 0;
    const from = full(fromStyle), to = full(toStyle);
    const direct = await this._fetchLinkEntry(inst, setupId, mtableId, READY_SUBSTATE, to, from);
    if (direct) return [{ entry: direct, toCmd: to, stance: from }];
    const DEF = 0x8000003d; // NonCombat = the humanoid default_style
    if (from === DEF || to === DEF) return [];
    // Both hops in parallel (the second only plays if the first exists).
    const [a, b] = await Promise.all([
      this._fetchLinkEntry(inst, setupId, mtableId, READY_SUBSTATE, DEF, from),
      this._fetchLinkEntry(inst, setupId, mtableId, READY_SUBSTATE, to, DEF),
    ]);
    if (!a) return [];
    const out = [{ entry: a, toCmd: DEF, stance: from }];
    if (b) out.push({ entry: b, toCmd: to, stance: DEF });
    return out;
  }

  // Bug 18 (2026-10-07): the whole style-change prefix retail appends before
  // the forward command: the EXIT link `exitFrom → Ready` in the OLD style
  // (skipped when already at Ready), then `_resolveStyleLinks`. Resolves to
  // `[{ entry, fromCmd, toCmd, stance }]` in play order, with
  // `.meta = { from, to, exit }` for the [stance-chain] log. Fetch only.
  async _resolveStanceChain(inst, setupId, mtableId, fromStyle, toStyle, exitFrom) {
    const full = (s) => (((s >>> 0) & 0xffff) | 0x80000000) >>> 0;
    const from = full(fromStyle);
    const to = full(toStyle);
    const exitCmd = fullMotionCommand(exitFrom >>> 0);
    const wantExit = exitCmd !== 0 && (exitCmd & 0xffff) !== CMD_LOW_READY;
    const [exit, style] = await Promise.all([
      wantExit
        ? this._fetchLinkEntry(inst, setupId, mtableId, exitCmd, CMD_READY_FULL, from)
        : Promise.resolve(null),
      this._resolveStyleLinks(inst, setupId, mtableId, from, to),
    ]);
    const out = [];
    if (exit) out.push({ entry: exit, fromCmd: exitCmd, toCmd: CMD_READY_FULL, stance: from });
    for (const l of style) out.push({ ...l, fromCmd: CMD_READY_FULL });
    out.meta = { from, to, exit: !!exit };
    return out;
  }

  // Fetch + play the stance-change links on their own (kept for callers
  // outside setMotion; setMotion commits them with the cycle instead).
  async _playStyleLink(inst, setupId, mtableId, fromStyle, toStyle) {
    const links = await this._resolveStyleLinks(inst, setupId, mtableId, fromStyle, toStyle);
    if (!this.entityMap.has(inst.guid >>> 0)) return;
    for (const l of links) this._playLinkEntry(inst, l.entry, READY_SUBSTATE, l.toCmd, l.stance);
  }

  // Resolve a MotionTable link `links[(stance, fromCmd)][toCmd]` through the
  // animation cache. Returns the cache entry, or null when no link exists, the
  // bake failed, or the entity was removed meanwhile. No side effects on the
  // playhead.
  async _fetchLinkEntry(inst, setupId, mtableId, fromCmd, toCmd, stance) {
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return null;
    // Bug 15 (2026-10-07): a swing / cast link is player-visible combat
    // feedback, so its bake rides the urgent fetch lane (BUG-3
    // `?appearanceUrgent`) instead of queueing behind world streaming; after
    // login that queue held the first swings back for seconds. Locomotion
    // links stay on the normal lane.
    const tcls = classifyMotionCommand(toCmd >>> 0);
    const urgent = APPEARANCE_URGENT_ON && (tcls === "attack" || tcls === "cast");
    let entry;
    try {
      entry = await this.animationCache.get(
        setupId,
        mtableId,
        toCmd,
        stance,
        fetchKeyframes,
        {
          modelChanges: inst.meta.modelChanges ?? new Uint32Array(0),
          textureChanges: inst.meta.textureChanges ?? new Uint32Array(0),
          paletteId: (inst.meta.paletteId ?? 0) >>> 0,
          paletteSubsFlat: inst.meta.subPalettes ?? new Uint32Array(0),
          fromMotion: fromCmd,
          urgent,
        },
      );
    } catch (_) {
      return null;
    }
    if (!this.entityMap.has(inst.guid >>> 0)) return null;
    if (!entry?.clip) return null;
    // Bugs 2/15/18 (2026-10-07): when the requested link does not exist the
    // wasm bake falls back to the target's CYCLE (lib.rs
    // build_entity_animation_data_inner_v2), and this used to hand that whole
    // loop back as the link — a full Ready/Run cycle played once in front of
    // the real draw, swing or windup. `isLink === false` is that fallback;
    // `null` (an older pkg/ without the flag) keeps the old behaviour.
    if (entry.isLink === false) {
      this._noteCycleAsLink(inst, mtableId, fromCmd, toCmd, stance);
      return null;
    }
    return entry;
  }

  // One console line per distinct rejected (mtable, stance, from → to), capped
  // per session: most locomotion transitions legitimately have no link.
  _noteCycleAsLink(inst, mtableId, fromCmd, toCmd, stance) {
    const key = `${mtableId >>> 0}:${stance >>> 0}:${fromCmd >>> 0}:${toCmd >>> 0}`;
    if (!this._cycleAsLinkSeen) this._cycleAsLinkSeen = new Set();
    if (this._cycleAsLinkSeen.has(key) || this._cycleAsLinkSeen.size >= 64) return;
    this._cycleAsLinkSeen.add(key);
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[motion-link] cycle-as-link rejected 0x${(inst.guid >>> 0).toString(16)} ` +
        `0x${(fromCmd >>> 0).toString(16)}->0x${(toCmd >>> 0).toString(16)} ` +
        `st=0x${(stance >>> 0).toString(16)} mtable=0x${(mtableId >>> 0).toString(16)}`,
      );
    } catch (_) {}
  }

  // Play an already-resolved link entry as a FULL-BODY one-shot in the Rust
  // MotionSequence interpreter (retail GetObjectSequence, acclient.c:337842),
  // APPENDED to pending_animations (J5) rather than clobbering a gesture
  // already on the playhead. Synchronous. On completion the tick falls back
  // to the `_unifiedLoco` cycle. `speed` (optional) is the link's own
  // framerate multiplier (retail AddMotion(link, speed)); it defaults to the
  // entity's motion speed.
  _playLinkEntry(inst, entry, fromCmd, toCmd, stance, speed = undefined) {
    const MS = _motionSequenceClass();
    const d = entry?.sequenceDescriptor;
    if (!MS || !d) return false;
    const seq = MS.fromDescriptor(
      d.numFrames >>> 0,
      +d.framerate || 0,
      +d.duration || 0,
      d.frameTimes || EMPTY_F32,
      d.segmentStarts || EMPTY_U32,
      d.segmentCounts || EMPTY_U32,
      false, // one-shot (no cyclic region) → latches `done`, holds last frame
    );
    if (!seq) return false;
    const sp = (Number.isFinite(+speed) && +speed > 0) ? +speed : this._unifiedOneShotSpeed(inst);
    // Keep `desc` for the per-frame poser (it owns the keyframe buffer).
    const rec = { seq, desc: d, clearOnDone: true, hooks: entry?.hooks || null, lastHookTime: -1,
      speed: sp };
    // `numAnims` is the link's AnimData segment count — retail's `num_anims`
    // is exactly that (CMotionTable fills it in as it appends nodes).
    this._enqueueUnifiedOneShot(inst, toCmd >>> 0, (d.segmentCounts?.length || 1), rec);
    // Audit C1/F3: stamp the server-swing time (attack/cast only — locomotion
    // transition links must NOT suppress a later legitimate CMT swing) so
    // index.html's guessed-swing dedup sees an in-flight server swing.
    const tcls = classifyMotionCommand(toCmd >>> 0);
    if (tcls === "attack" || tcls === "cast") {
      inst._lastServerSwingMs = performance.now();
    }
    return true; // the tick drives the rig
  }

  async _tryPlayLink(inst, setupId, mtableId, fromCmd, toCmd, stance, opts = undefined) {
    // Returns true when a clip was resolved and played (or handed to the
    // unified one-shot), false otherwise — the door-state caller falls back
    // to its 1-frame cycle hold on false. Legacy callers ignore the value.
    if (typeof this.wasmExports?.fetchEntityAnimationKeyframes !== "function") return false;
    const t0 = performance.now();
    const entry = await this._fetchLinkEntry(inst, setupId, mtableId, fromCmd, toCmd, stance);
    if (!this.entityMap.has(inst.guid >>> 0)) return false;
    // A locomotion link whose setMotion was superseded mid-fetch is stale (F6).
    if (opts?.motionToken !== undefined && inst._motionToken !== opts.motionToken) return false;
    // Bug 15 (2026-10-07): a swing whose bake took longer than the swing
    // itself would play AFTER its hit landed (retail loads synchronously and
    // never shows one late). Skip it past MOTION_LATE_SKIP_MS or twice its
    // length; log any wait over MOTION_LATE_LOG_MS either way.
    if (entry) {
      const tcls = classifyMotionCommand(toCmd >>> 0);
      if (tcls === "attack" || tcls === "cast") {
        const waited = performance.now() - t0;
        if (waited > MOTION_LATE_LOG_MS) {
          const sp = (Number.isFinite(+opts?.speed) && +opts.speed > 0) ? +opts.speed : 1;
          const durMs = (_finiteOr0(entry.sequenceDescriptor?.duration) * 1000) / sp;
          const skip = waited > Math.max(MOTION_LATE_SKIP_MS, 2 * durMs);
          try {
            // eslint-disable-next-line no-console
            console.log(
              `[motion-late] 0x${(inst.guid >>> 0).toString(16)} 0x${(toCmd >>> 0).toString(16)} ` +
              `bake ${Math.round(waited)}ms (clip ${Math.round(durMs)}ms) ${skip ? "skipped" : "played"}`,
            );
          } catch (_) {}
          if (skip) return false;
        }
      }
    }
    if (!entry) {
      // No link registered for this (stance, from→to) transition. For
      // locomotion transition links this is the common/expected case
      // (most cycles have no explicit link clip), but for an Action-class
      // one-shot (attack swing / cast / eat) a null clip means a genuinely
      // MISSING MotionTable link entry — the swing/eat will be invisible.
      // Wave 2 (2026-06-08): surface that as a one-line diag instead of a
      // silent return so a missing link is observable in the console.
      // classifyMotionCommand masks &0xffff, so it tolerates a full-32bit
      // or low-16 command equally.
      const tcls = (typeof classifyMotionCommand === "function")
        ? classifyMotionCommand(toCmd >>> 0)
        : null;
      // 2026-10-06: only a real swing / cast miss is a defect. Emotes, idle
      // fidgets (Twitch1-4 reach this path via the class-byte fallback),
      // FallDown, Jump and recalls legitimately lack links in many tables —
      // retail plays nothing for them either (scene3d/motion_link_diag.js).
      if (linkMissIsDefect(toCmd >>> 0, ATTACK_COMMANDS, CAST_COMMANDS)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[motion-link] no MotionTable link for ${(tcls)} 0x${(toCmd >>> 0).toString(16)} ` +
          `(from 0x${(fromCmd >>> 0).toString(16)}, stance 0x${(stance >>> 0).toString(16)}, ` +
          `mtable 0x${(mtableId >>> 0).toString(16)}) on entity 0x${(inst.guid >>> 0).toString(16)} ` +
          `— swing/cast/eat will not play`,
        );
      }
      return false;
    }
    // Door/chest/lever state transitions (setMotion's isDoorStateMotion
    // branch): the link's final frame IS the destination hold pose (Off→On
    // ends open, On→Off ends closed), so the one-shot HOLDS it
    // (clearOnDone:false) — retail's "play the link, then enter the
    // framerate-0 hold cycle". It goes straight onto the playhead (a state
    // change is not a queued gesture). Door sounds + the Ethereal flip ride its
    // hooks. The link is posed from its raw part frames, and no root motion is
    // applied to the anchor (see _playStateHoldLink).
    if (opts?.stateHold && this._playStateHoldLink(inst, entry, fromCmd, toCmd, stance)) {
      return true;
    }
    // Every other link — attack swings, cast windups, emotes, locomotion
    // transition links, stance (draw/sheathe) links.
    return this._playLinkEntry(inst, entry, fromCmd, toCmd, stance, opts?.speed);
  }

  // Build + install a held state-transition one-shot (see the stateHold call
  // site in `_tryPlayLink`). Returns false when no sequence could be built.
  _playStateHoldLink(inst, entry, fromCmd, toCmd, stance) {
    const MS = _motionSequenceClass();
    const d = entry?.sequenceDescriptor;
    if (!MS || !d) return false;
    const seq = MS.fromDescriptor(
      d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
      d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
      false, // one-shot → latches `done`, holds the final (open/closed) frame
    );
    if (!seq) return false;
    const rec = {
      seq, desc: d, clearOnDone: false, stateHold: true,
      // RAW part frames (retail CPartArray::UpdateParts), NOT in place.
      // 2026-10-05 owner report: the door opened the wrong way / protruded
      // into the building, and the next use threw it ~1 m outward. The
      // in-place fix subtracts the MEAN translation of all parts relative to
      // the clip's frame 0. That is right for a locomotion stride, but a door
      // swing is hinge motion, so the leaves' origins sweep an arc and the
      // mean moves with them. Measured on the retail DATs: double door
      // 0x03000767 (5 parts) mean -0.40 m y; 0x03000559 (3 parts) -0.65 m;
      // single-leaf 0x03000c17 about 2 m. Subtracting that slid the static
      // frame/lintel parts and dragged the leaves off their hinges. A reversed
      // (On→Off) link starts at the OPEN frame, so the closed hold ended up
      // offset the opposite way, and every use snapped the door back and
      // forth by that amount. The mixer bake had the same subtraction
      // (buildAnimationClip B1-render v2); retail never had any of it.
      inPlace: false,
      hooks: entry.hooks || null, lastHookTime: -1,
      speed: this._unifiedOneShotSpeed(inst),
    };
    // No `?rootMotionObject` arm here. The link HOLDS its final frame, and that
    // frame already carries the bake's folded root motion (DIM5_2_ROOT_ORIENT,
    // posed raw above). Also moving the anchor by the net on completion would
    // count the displacement twice, once more on every use. (The surveyed
    // door/chest/lever anims carry no pos_frames, so this is a guard.)
    const prev = inst._unifiedSeq;
    this._clearUnifiedQueue(inst); // frees every pending record except `prev`
    if (prev) { try { prev.seq.free(); } catch (_) { /* already freed */ } }
    inst._unifiedSeq = rec;
    console.log(
      `[motion-link] 0x${(inst.guid >>> 0).toString(16)} ${fromCmd.toString(16)}→${toCmd.toString(16)} stance=${stance.toString(16)} (state link held, ${entry.hooks?.length ?? 0} hooks)`,
    );
    return true;
  }

  // Free a held door/chest state link (setMotion's door fallthrough).
  _dropStateHold(inst) {
    const ua = inst._unifiedSeq;
    if (!ua || !ua.stateHold) return;
    try { ua.seq.free(); } catch (_) { /* already freed */ }
    inst._unifiedSeq = null;
  }

  // A5-P3 on the playhead: stamp the record with the overlay clip's net root
  // displacement + the per-guid KIND_POSITION stamp at play time. Applied ONCE
  // by `_applyUnifiedRootMotionIfDone` when the sequence completes naturally;
  // a record freed before completion (interrupted) applies nothing — the same
  // contract the mixer `finished` listener had.
  _armUnifiedRootMotion(inst, rec, net) {
    let poseTs = 0;
    try {
      if (typeof window !== "undefined" && window.__lastEntityWorldPos) {
        poseTs = window.__lastEntityWorldPos.get(inst.guid >>> 0)?.ts ?? 0;
      }
    } catch (_) {}
    rec.rootMotion = { net, poseTs, applied: false };
  }

  _applyUnifiedRootMotionIfDone(inst, rec) {
    const rm = rec?.rootMotion;
    if (!rm || rm.applied || !rec.seq.done) return;
    rm.applied = true;
    this._applyRootMotionToAnchor(inst, rm.net, rm.poseTs);
  }

  // A5-P3 — apply a completed overlay's net root displacement
  // `[tx,ty,tz, qw,qx,qy,qz]` (AC w-first, model space relative to clip
  // start) to the entity ANCHOR, mirroring retail
  // CPhysicsObj::UpdatePositionInternal (acclient.c:320014-320031):
  //   - TRANSLATION is scaled by live m_scale and composed OBJECT-LOCAL
  //     (`d = R_root·(s·T)`; Frame::combine, acclient.c:320031), but
  //     SKIPPED when airborne — the JS analog of retail zeroing
  //     `offset_frame.m_fOrigin` when `!(transient_state &
  //     ON_WALKABLE_TS)` (acclient.c:320020-320026; acclient.h:3691).
  //   - ROTATION post-multiplies regardless — retail never zeroes the
  //     offset quaternion (acclient.c:320014-320026 touches only
  //     m_fOrigin.x/y/z).
  // FRESHNESS GATE (double-apply protection): if any server
  // KIND_POSITION landed mid-clip (per-guid `.ts` stamp changed since
  // play), SKIP entirely — the authoritative pose already includes
  // whatever the server thinks the anim did. Dead-reckon / heading-ease
  // targets are co-moved so `tick()` doesn't pull the rig back; the
  // `_appliedRootMotion` ledger is diag-only and cleared in `setPose`
  // (a fresh authoritative pose replaces the anchor wholesale).
  _applyRootMotionToAnchor(inst, net, poseTsAtPlay) {
    try {
      if (!this._rootMotionObjectOn) return;
      if (!inst || !net || net.length !== 7) return;
      const g = inst.guid >>> 0;
      if (!this.entityMap.has(g)) return; // disposed mid-clip
      let tsNow = 0;
      if (typeof window !== "undefined" && window.__lastEntityWorldPos) {
        tsNow = window.__lastEntityWorldPos.get(g)?.ts ?? 0;
      }
      if (tsNow !== poseTsAtPlay) return; // server pose landed mid-clip
      const airborne = !!(inst._isAirborne || inst.airborneTilt);
      let dx = 0, dy = 0, dz = 0;
      if (!airborne) {
        // Live m_scale analog: objScale base (root.scale set at spawn)
        // as mutated by ScaleHook tweens — retail reads live m_scale
        // (acclient.c:320016-320019).
        const s = inst.root.scale.x || 1.0;
        const d = new THREE.Vector3(net[0], net[1], net[2])
          .multiplyScalar(s)
          .applyQuaternion(inst.root.quaternion);
        inst.root.position.add(d);
        // Keep the dead-reckon ease target coherent so tick() doesn't
        // pull the rig back toward the pre-apply server target.
        if (inst._serverTargetPos) inst._serverTargetPos.add(d);
        dx = d.x; dy = d.y; dz = d.z;
      }
      // Rotation: object-local post-multiply; AC w-first → three.js via
      // acQuatToThree (pure w-reorder — scene is AC Z-up throughout).
      const rq = acQuatToThree(net[3], net[4], net[5], net[6]);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(net[3])));
      inst.root.quaternion.multiply(rq);
      if (inst._serverTargetQuat) inst._serverTargetQuat.multiply(rq);
      // Diag-only ledger — cleared on the next authoritative setPose.
      const led = inst._appliedRootMotion || (inst._appliedRootMotion = {
        x: 0, y: 0, z: 0, angle: 0, count: 0,
      });
      led.x += dx; led.y += dy; led.z += dz;
      led.angle += angle; led.count += 1;
      if (typeof window !== "undefined" && window.__diag?.motion?.onRootMotionApplied) {
        try {
          window.__diag.motion.onRootMotionApplied({
            guid: g, dx, dy, dz, angle, airborne,
          });
        } catch (_) { /* diag must never block */ }
      }
    } catch (_) { /* never block the finished path */ }
  }

  /**
   * A4-Q3 (2026-06-12) — exit-world overlay cancellation hook. Retail drains
   * every pending one-shot across an enter/exit-world transition
   * (`MotionTableManager::HandleExitWorld`, acclient.c:329940-329947;
   * `HandleEnterWorld` → `remove_all_link_animations`, :329949-329957). The
   * body that existed stopped running THREE.LoopOnce MIXER overlays only, so
   * since the animation consolidation (every one-shot is on the Rust playhead)
   * it had nothing left to stop. Kept as a NO-OP seam (index.html kind=33 and
   * the dead-reckon teleport-snap branches call it): cutting playhead
   * one-shots here would be a behaviour change for gestures that already ride
   * the playhead, owed its own eye-test (portal mid-emote). The Rust half
   * (`MovementSystem::handle_exit_world_for`) is unaffected.
   */
  _cancelOneShotOverlays(_inst) {}

  /**
   * A4-Q3 — public guid-keyed wrapper for `_cancelOneShotOverlays`;
   * called from the `index.html` kind=33 `PortalSpaceEntered` drain for
   * the LOCAL player (the portal-transit hook — the wasm recv arm fires
   * the matching Rust-side `handle_exit_world_for` from the same
   * `PlayerTeleport` message). Currently a no-op (see above).
   */
  cancelOneShotOverlaysForGuid(guid) {
    const inst = this.entityMap?.get(guid >>> 0);
    if (inst) this._cancelOneShotOverlays(inst);
  }

  /**
   * Lazy-construct `this._worldParticleManager` on first use. Imports
   * the particles + adapter modules dynamically so the
   * `test_phase7_4*` composite-source harness doesn't have to bundle
   * them. Idempotent: returns the existing manager on subsequent calls.
   *
   * The `rig` parameter is used only as a `scene` fallback if
   * `scene3d.entitiesGroup` is not attached yet (rare boot-race
   * condition). For animation-hook callers, pass `inst.root` — the
   * value isn't read after the manager is first created.
   *
   * Originally inline in `_attachParticleChainForEntity`; extracted on
   * 2026-05-28 so animation-hook `CreateParticleHook` (Wave 1) can
   * reuse the same manager without duplicating the boot code.
   */
  async _ensureWorldParticleManager(rig) {
    if (this._worldParticleManager) return this._worldParticleManager;
    const { ParticleManager } = await import("./particles/index.js");
    const adapter = await import("./adapter.js");
    const meshToGeometryGroups = adapter.meshToGeometryGroups;
    const materialCache = this.materialCache;
    const ents_wasm = this.wasmExports;
    // H3-bugfix (2026-05-12): same fix as sky_dome.js — must run
    // wasm-side mesh through meshToGeometryGroups to get a real
    // THREE.BufferGeometry. Otherwise new THREE.Mesh crashes with
    // "Cannot read properties of null (reading 'morphAttributes')".
    const resolveGfxObj = async (hwGfxObjId) => {
      // Skip id 0 (no building/hardware GfxObj — a detach, or an entity with no
      // placement model): fetchBuildingPlacement(0) always fails wasm-side and
      // spammed `[entities/H2] fetchBuildingPlacement(0x0) failed` (2026-06-29).
      if (!(hwGfxObjId >>> 0)) return null;
      if (!ents_wasm || typeof ents_wasm.fetchBuildingPlacement !== "function") {
        return null;
      }
      let bundle;
      try {
        bundle = await ents_wasm.fetchBuildingPlacement(hwGfxObjId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/H2] fetchBuildingPlacement(0x${hwGfxObjId.toString(16)}) failed:`,
          e
        );
        return null;
      }
      if ((bundle.partCount | 0) === 0) {
        if (typeof bundle.free === "function") bundle.free();
        return null;
      }
      const meshes = bundle.takePartMeshes();
      if (typeof bundle.free === "function") bundle.free();
      const wasmMesh = meshes[0];
      if (!wasmMesh) return null;
      const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
      if (typeof wasmMesh.free === "function") wasmMesh.free();
      if (!groups || groups.length === 0) return null;
      return {
        geometry: groups[0].geometry,
        surfaceDid: groups[0].surfaceDid || surfaceDids[0] || 0,
      };
    };
    // PART-GEO-MEMO (2026-10-06): ONE geometry per particle GfxObj, shared by
    // every emitter that draws it. ParticleManager.destroyParticleEmitter never
    // disposes geometry ("cache-owned by the geometryFactory") — but this factory
    // had no cache: each addEmitter decoded + uploaded a fresh geometry that was
    // never freed. Live (1070, warmPark=off, Holtburg<->Yaraq x2): 743 orphaned
    // particle geometries by the third Holtburg visit. Failed (null) resolves are
    // not memoized, so a decode-starved miss can retry. `__cacheOwned` keeps the
    // LB dispose loops off a geometry other emitters still draw.
    const _resolveMemo = new Map(); // hwGfxObjId -> Promise<{geometry, surfaceDid}|null>
    const resolveGfxObjShared = (hwGfxObjId) => {
      const id = hwGfxObjId >>> 0;
      let p = _resolveMemo.get(id);
      if (!p) {
        p = resolveGfxObj(id).then(
          (r) => {
            if (!r) { _resolveMemo.delete(id); return r; }
            try { r.geometry.userData.__cacheOwned = true; } catch (_) {}
            return r;
          },
          (e) => { _resolveMemo.delete(id); throw e; },
        );
        _resolveMemo.set(id, p);
      }
      return p;
    };
    this._worldParticleManager = new ParticleManager({
      scene: this.scene3d?.entitiesGroup ?? rig?.parent ?? null,
      // ?particleInstancing (DEFAULT ON 2026-10-06): entity/world emitters
      // (portal swirl, lifestone, cast effects) join the per-(gfxobj, layer,
      // blend) instanced buckets too — 107 per-particle draws at Holtburg.
      instancing: true,
      geometryFactory: async (hwGfxObjId) => {
        const r = await resolveGfxObjShared(hwGfxObjId);
        return r?.geometry ?? null;
      },
      // Retail deg_mode facing (2026-07-28) — hw GfxObj → did_degrade chain
      // DID for the particle billboard-mode resolve (particle_manager.js
      // `_billboardModeFor`; cached per-gfxobj, once per session). Byte-level
      // `fetchModelDidDegrades` export — the `fetchBuildingPlacement`
      // ModelMesh does NOT populate `.didDegrade` (verified live 2026-07-28).
      // Typeof-guarded: a stale bundle resolves 0 → facing soft-off.
      degradeInfoFactory: async (hwGfxObjId) => {
        if (typeof ents_wasm?.fetchModelDidDegrades !== "function") return 0;
        const r = await ents_wasm.fetchModelDidDegrades(new Uint32Array([hwGfxObjId >>> 0]));
        return (r && r[0]) >>> 0;
      },
      materialFactory: async (hwGfxObjId) => {
        if (!materialCache) return null;
        const r = await resolveGfxObjShared(hwGfxObjId);
        if (!r?.surfaceDid) return null;
        try {
          // 2026-06-20 ParticleViewer parity: UNLIT billboard material
          // (texture × opacity, additive/alpha from the surface flag), NOT the
          // lit MeshStandard entity path. `?particleUnlit=off` → legacy lit.
          return await materialCache.getParticleUnlit(
            r.surfaceDid,
            ents_wasm.fetch_surfaces_pixels
          );
        } catch (_) {
          return null;
        }
      },
    });
    return this._worldParticleManager;
  }

  /**
   * Wave 5 (2026-05-28) — Clone-on-write helper for entity materials.
   * Returns a material OWNED by this entity (cloned from the shared
   * `materialCache` on first request), suitable for mutating opacity /
   * emissive / color / `.map.offset` uniforms without bleeding into
   * other entities that share the same surface.
   *
   * Re-points every Mesh in `inst.parts` that referenced the shared
   * material to the clone. Idempotent: subsequent calls with the same
   * `surfaceDid` return the already-owned clone.
   *
   * Cloned materials are tagged `userData.__disposable = true` (and
   * NOT `__cacheOwned`) so the existing `_disposeMaterialIfOwned`
   * policy frees them on entity release. With `opts.cloneTexture`
   * (set by TextureVelocity hooks), the material's `.map` is also
   * cloned so the per-entity `.offset` doesn't bleed; the underlying
   * `Texture.image` is shared so there's no extra GPU upload.
   *
   * Returns `null` when the surface isn't in cache (which means we'd
   * be cloning the fallback singleton — caller should no-op).
   */
  _getOrCloneEntityMaterial(inst, surfaceDid, opts = {}) {
    const did = surfaceDid >>> 0;
    if (!inst._entityMaterials) inst._entityMaterials = new Map();
    let existing = inst._entityMaterials.get(did);
    // 2026-08-03 — INVARIANT: every mutation reached through this getter (ramp
    // tweens, ethereal, camera fade, texture velocity) is PER-ENTITY, so what we
    // hand back must never be cache-owned. `_entityMaterials` is not all
    // entity-owned: the recolored spawn path and the R-8 recovery ladder store
    // `installPaletted` materials, which materials.js tags `__cacheOwned` and
    // shares with every entity carrying the same palette signature. Upgrade such
    // an entry to a private clone here — otherwise the mutation bleeds across
    // characters, and the `cloneTexture` branch below would re-point the CACHE
    // material's `.map` (desyncing MaterialCache.palettedTextures).
    if (existing && existing.userData?.__cacheOwned === true) {
      const owned = existing.clone();
      owned.userData = { ...(owned.userData || {}), __disposable: true };
      delete owned.userData.__cacheOwned;
      inst._entityMaterials.set(did, owned);
      this._repointEntityMeshes(inst, did, owned);
      existing = owned;
    }
    if (existing) {
      // Already entity-owned. If the caller now wants a cloned texture
      // and the existing clone still points at a shared `.map`, clone
      // the texture now (lazy upgrade so plain Transparent hooks don't
      // pay for texture cloning).
      if (opts.cloneTexture && existing.map &&
          existing.map.userData?.__disposable !== true) {
        const tex = existing.map.clone();
        tex.userData = { ...(tex.userData || {}), __disposable: true };
        delete tex.userData.__cacheOwned;
        tex.needsUpdate = false; // shared image, no re-upload
        existing.map = tex;
      }
      return existing;
    }
    if (!this.materialCache) return null;
    const shared = this.materialCache.getCached(did);
    if (!shared) return null;
    // Skip the fallback singleton — cloning the global fallback would
    // both waste memory and risk dispose-policy confusion. Treat as
    // "no usable cache hit".
    if (shared === this.materialCache.fallbackMaterial) return null;
    const cloned = shared.clone();
    cloned.userData = { ...(cloned.userData || {}), __disposable: true };
    // Strip `__cacheOwned` if it carried over via spread — the clone
    // is per-entity, not cache-owned.
    if (cloned.userData.__cacheOwned) delete cloned.userData.__cacheOwned;
    if (opts.cloneTexture && cloned.map) {
      const tex = cloned.map.clone();
      tex.userData = { ...(tex.userData || {}), __disposable: true };
      delete tex.userData.__cacheOwned;
      tex.needsUpdate = false;
      cloned.map = tex;
    }
    inst._entityMaterials.set(did, cloned);
    this._repointEntityMeshes(inst, did, cloned);
    return cloned;
  }

  /**
   * Re-point every Mesh under `inst.parts` that renders `did` at `mat`. Spawn
   * stamps `userData.surfaceDid` on each Mesh so this lookup is
   * O(parts × meshes_per_part). Shared by both clone paths in
   * `_getOrCloneEntityMaterial`.
   */
  _repointEntityMeshes(inst, did, mat) {
    if (!Array.isArray(inst.parts)) return;
    for (const part of inst.parts) {
      if (!part) continue;
      for (const child of part.children) {
        if (!child || !child.isMesh) continue;
        if ((child.userData?.surfaceDid >>> 0) === (did >>> 0)) {
          child.material = mat;
        }
      }
    }
  }

  /**
   * Phase 3 (P3.4) — attach SYNTHESIZED additive particle emitter(s) for an
   * entity whose catalog descriptor carries a `particle` mech. Sibling of the
   * DAT-driven `_attachParticleChainForEntity`, but for the legacy-safe POJO
   * path: it runs each particle component's `emit(ctx)` (P3.1/P3.3) and routes
   * the resulting emitterInfo POJOs through the SAME world ParticleManager +
   * ownerRegistry the H2/CreateParticle chains use, anchored on the live rig.
   *
   * Coexistence (§5 / §9 #14): SKIP any DID whose SetupModel already fires a
   * `default_script` (the Track-B flame) — its DAT emitters already render, so a
   * suite particle would double-animate it. Resolved via `fetchSetupDefaultScript`
   * (typeof-guarded; a pre-rebuild pkg/ soft-degrades to "no default_script").
   *
   * Owner key = `guid>>>0`; teardown is the existing entity-remove
   * `destroyAllForOwner(g)` (g = guid>>>0, entities.js:8060) — plus the legacy
   * `_particleEmittersForGuid` fallback when `?particleOwner=off` (the H2 path at
   * entities.js:8045 reaps it). Despawn never leaks. Fail-soft throughout.
   */
  async _attachVfxParticlesForEntity(guid, rig, descriptorDid, setupDid) {
    if (!rig || !this.wasmExports) return;
    let descriptor = null;
    try {
      await ensureVfxCatalog();
      descriptor = vfxDescriptorFor(descriptorDid >>> 0);
    } catch (_) { return; }
    if (!descriptor || !descriptorMechs(descriptor).has("particle")) return;

    // Coexistence: a Setup that self-emits via default_script is animated by the
    // Track-B / DAT path already — never stack a suite particle on top. (Probe
    // only AFTER the cheap in-memory mech check, so the DAT read is paid by the
    // handful of allowlisted particle DIDs, not every spawn.)
    if (typeof this.wasmExports.fetchSetupDefaultScript === "function") {
      try {
        const ds = (await this.wasmExports.fetchSetupDefaultScript(setupDid >>> 0)) >>> 0;
        if (ds !== 0) return;
      } catch (_) { /* fall through — treat as no default_script */ }
    }
    if (!this.entityMap.has(guid)) return; // despawned during the async resolve

    const manager = await this._ensureWorldParticleManager(rig);
    if (!manager) return;
    if (!this.entityMap.has(guid)) return; // despawned during the manager build

    // P3.1 attach driver (D5): route the single-element entity placement through
    // the CANONICAL attachParticleEmitters — it builds the deterministic emit-ctx
    // (hash01+clock, NEVER Math.random), runs each registered particle component's
    // emit(ctx), and routes every synthesized spec through ParticleManager.addEmitter.
    // Owner-scoped under guid>>>0 when ?particleOwner is on (despawn's
    // destroyAllForOwner reaps it, entities.js:8086); else the returned ids are
    // registered in the legacy per-guid bucket below so the H2 despawn path
    // (entities.js:8071) tears them down. The driver resolves the descriptor from
    // `descriptorDid`; geometry is the LIVE rig (numParts from partFrames) so a
    // future P3.6 anchor-parts pick can resolve against the animated parts.
    // (This supersedes agent 07's `emitSpecsForDescriptor` — that export was
    // dropped from the canonical particle_attach module, D5.)
    const ownedByRegistry = particleOwnerOn();
    let result;
    try {
      result = await attachParticleEmitters(
        this, [{ modelId: descriptorDid >>> 0, guid: guid >>> 0 }], this.wasmExports,
        () => guid >>> 0,
        {
          manager,
          buildParent: () => rig,
          useOwnerRegistry: ownedByRegistry,
          didFor: (p) => (p.modelId >>> 0),
          geometryFor: () => ({ numParts: (rig.partFrames && rig.partFrames.length) || 1, partBoxes: [], rig }),
          clockNow: () => (this.scene3d && this.scene3d.frameTime && this.scene3d.frameTime.tsSec) || 0,
          env: readParticleEnv(this.scene3d), // P3.7 — day/weather/season for foliage/breath gates
        },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[entities/P3] attachParticleEmitters(0x${(descriptorDid >>> 0).toString(16)}) threw:`, e);
      return;
    }
    const ids = (result && result.ids) || [];
    if (ids.length === 0) return;

    // Despawn raced the awaits: if the entity is already gone, reap now so a late
    // emitter doesn't outlive its rig (mirrors play_effect_vfx.js:1471-1476).
    if (!this.entityMap.has(guid)) {
      if (ownedByRegistry) {
        try { ownerRegistry.destroySome(guid >>> 0, ids); } catch (_) {}
      } else {
        for (const id of ids) { try { manager.destroyParticleEmitter(id); } catch (_) {} }
      }
      return;
    }
    // Off-path: register in the legacy per-guid map so entity-remove tears them
    // down (entities.js:8071). On-path the owner facade already tracks them —
    // don't double-register (that's the split-brain S2 removed).
    if (!ownedByRegistry) {
      let bucket = this._particleEmittersForGuid.get(guid);
      if (!bucket) { bucket = []; this._particleEmittersForGuid.set(guid, bucket); }
      for (const id of ids) bucket.push(id);
    }
  }

  // WS09 (2026-07-12) — fire ONE decoded audio hook from a wire PlayEffect
  // (play_effect_vfx.js `_tryResolveRealVfx`) through the SAME sound sink the
  // H2 gesture/spawn walker uses (this method's sibling above,
  // entities.js:~10762 Sound/SoundTweaked + ~10857 SoundTable). The resolver
  // decodes the PhysicsScriptEntryJs into a plain `desc` synchronously (the
  // wasm entry object may be reclaimed before a deferred fire) and hands it
  // here; this method owns the StartTime scheduling + the audioManager /
  // soundTableCache lookups so the wire path reuses the validated sink instead
  // of duplicating it. `desc`:
  //   { hookType, startTime, soundWaveId, soundEnum, soundProbability,
  //     soundVolume }  (hookType ∈ {1 Sound, 2 SoundTable, 21 SoundTweaked}).
  // Guarded so the entity vanishing mid-delay drops the fire (no ghost sound).
  _firePlayEffectSoundHook(guid, desc) {
    if (!desc) return;
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    const rig = inst.root;
    const audioMgr = this.scene3d?.audioManager;
    const ht = desc.hookType | 0;
    const delayMs = Math.max(0, (+desc.startTime || 0) * 1000);
    if (ht === 1 || ht === 21) {
      if (!audioMgr) return;
      const waveId = (desc.soundWaveId >>> 0);
      if (waveId === 0) return;
      const probability = Number.isFinite(desc.soundProbability)
        ? desc.soundProbability : 1.0;
      // SoundHook plays at 1.0, SoundTweaked at its vol — 0 is silent
      // (acclient.c:342188-342209, 383079-383118).
      const volume = ht === 21 ? retailVolume(desc.soundVolume) : 1.0;
      // Coin-flip on probability (only SoundTweaked carries != 1.0).
      if (!(probability >= 1.0 || Math.random() < probability)) return;
      setTimeout(() => {
        if (!this.entityMap.has(guid >>> 0)) return;
        // Transform the entity's RAW AC-frame position into the three.js frame
        // the AudioContext listener lives in (acToThree), same as the H2 arm.
        const pos = rig?.position ?? { x: 0, y: 0, z: 0 };
        const a4t = acToThree(pos.x, pos.y, pos.z);
        audioMgr
          // Plain SoundHook (ht 1) applies the effect slider twice, as retail
          // PlaySoundA(gid, obj) → GetAttenuation (acclient.c:342190, 383481, 383092-383095).
          .play(waveId, { x: a4t[0], y: a4t[1], z: a4t[2] }, { gain: volume, followGuid: (guid >>> 0), sliderTwice: ht === 1 })
          .catch(() => {});
      }, delayMs);
      return;
    }
    if (ht === 2) {
      const soundEnum = (desc.soundEnum >>> 0);
      if (soundEnum === 0) return;
      const cache = this.scene3d?.soundTableCache ?? null;
      setTimeout(() => {
        if (!this.entityMap.has(guid >>> 0)) return;
        // Adapter mirrors the AnimationHookJs shape `_fireHook` reads (same as
        // the H2 SoundTable arm), resolving inst.soundTableDid via the cache.
        this._fireHook(inst, { hookType: 2, soundEnum, time: +desc.startTime }, audioMgr, cache);
      }, delayMs);
    }
  }

  // W4.7 / DIM3-3 (2026-06-05): `defaultPartIndex` lets a caller anchor the
  // invoked script's emitters at a specific SetupModel part when the script's
  // OWN CreateParticle hook carries no part (root sentinel). DefaultScriptPart
  // (18) passes its `_part_index` (retail `play_default_script(object,
  // _part_index)`, acclient.c:342324-342327); CreateParticle(13/26) already
  // anchors per-part via the hook's own `createParticlePartIndex`, so a hook
  // that names its OWN part still wins — `defaultPartIndex` only fills the
  // root-sentinel case. Anchoring uses the existing `inst.root.partFrames[
  // partIndex]` per-part-frame path (particle_emitter.js:347), NOT a different
  // parent Object3D. Default -1 = body root (unchanged behavior). Threaded
  // through CallPES recursion so sub-scripts inherit it. (anim-deep FIX-PLAN
  // W4.7.)
  async _attachParticleChainForEntity(guid, rig, pesId, depth = 0, defaultPartIndex = -1) {
    // F.D-fu (2026-05-20): emit a chain-walker entry log so validators
    // (and devs eyeballing console) can correlate spawn dispatch with
    // chain-walker firing. Critical for diagnosing "no PhysicsScriptHook
    // events observed" — without this, a silent fetchPhysicsScript hang
    // (no throw, no resolve) is invisible.
    // eslint-disable-next-line no-console
    console.log(
      `[entities/H2] chain walker entered for guid=0x${guid.toString(16)} pes=0x${pesId.toString(16)}`
    );
    let ps;
    try {
      ps = await this.wasmExports.fetchPhysicsScript(pesId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/H2] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
        e
      );
      // F.D-fu3 — return a descriptor so callers can distinguish a
      // hard fetch failure from "no hooks found".
      return {
        ok: false,
        emitterCount: 0,
        soundHookCount: 0,
        reason: `fetchPhysicsScript_failed:${String(e?.message ?? e)}`,
      };
    }
    const entries = ps.takeEntries();
    // eslint-disable-next-line no-console
    console.log(
      `[entities/H2] chain walker fetched PS=0x${pesId.toString(16)} entries=${entries.length} for guid=0x${guid.toString(16)}`
    );

    // Lazy-create the world-side ParticleManager on first chain walk.
    await this._ensureWorldParticleManager(rig);

    // A11-S1 (unification survey 2026-06-11): when `?scriptQueue=on`, route
    // this script through the per-owner time-ordered `ScriptManager` and the
    // SHARED `_fireHook` executor instead of the legacy per-hook setTimeout
    // walk below. This serializes scripts back-to-back (retail
    // AddScriptInternal) and closes the G14 visual-hook routing gap (16/20/
    // 23/24/25 reach `_fireHook` for free). CallPES recurses as a queued
    // `addScript`. The legacy walker below is the unchanged off-path.
    if (SCRIPT_QUEUE_ON) {
      return this._queuePhysicsScript(guid, rig, pesId, entries, depth, defaultPartIndex);
    }

    const THREE = (await import("three")).default ?? (await import("three"));
    // B2 (perf plan 2026-05-18): the per-hook `new Vector3(...)` /
    // `new Quaternion(...)` allocations these locals used to back are
    // now pooled into module-scope `_particleAttachScratch*` — the
    // dynamic import stays in case future hook arms need a fresh
    // class reference, but the locals it produced are no longer
    // referenced anywhere in this function.
    void THREE;

    const emitterIds = [];
    const timeoutIds = [];
    // Phase F.C — runtime event log probe (shared across the H2 walker's
    // Sound hook + CreateParticle hook arms).
    const pushEventRecord = this.scene3d?._pushEventRecord;
    for (const e of entries) {
      // H3-E1 (2026-05-12): Sound + SoundTweaked hooks fire WAVE
      // playback at `start_time` seconds after script attach. Wired
      // via the AudioManager when one is attached to scene3d.
      const audioMgr = this.scene3d?.audioManager;
      if ((e.hookType === 1 || e.hookType === 21) && audioMgr) {
        const waveId = e.soundWaveId >>> 0;
        if (waveId !== 0) {
          const probability = e.soundProbability;
          // SoundHook 1.0 / SoundTweaked vol, 0 silent (acclient.c:342188-342209).
          const volume = e.hookType === 21 ? retailVolume(e.soundVolume) : 1.0;
          const delayMs = Math.max(0, e.startTime * 1000);
          const hookStartTime = +e.startTime;
          // Coin-flip on probability (only SoundTweaked has !=1.0).
          if (probability >= 1.0 || Math.random() < probability) {
            const tid = setTimeout(() => {
              // Read the entity's current world position at fire-time.
              // The rig was passed in; .position tracks the entity if
              // it has moved between attach + fire.
              const pos = {
                x: rig.position.x,
                y: rig.position.y,
                z: rig.position.z,
              };
              // Phase F.C — record the actual fire moment (after the
              // setTimeout delay), not the schedule moment. F.D's
              // validator time-correlates against the PhysicsScript
              // start_time + the attach instant.
              if (pushEventRecord) {
                pushEventRecord({
                  type: "sound",
                  wave_did: waveId,
                  parent_entity_guid: (guid >>> 0),
                  world_pos: [+pos.x, +pos.y, +pos.z],
                  t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
                  source: "PhysicsScriptHook",
                  source_meta: {
                    entity_guid: (guid >>> 0),
                    script_did: (pesId >>> 0),
                    start_time_s: hookStartTime,
                    hook_type: (e.hookType | 0),
                    gain: volume,
                  },
                });
              }
              // Wave 3 / A4 — follow the entity so HRTF tracks moving sources.
              // D4-NEW-1 (2026-06-05): `pos` here is the entity's RAW AC-frame
              // position (rig.position lives under worldRoot, whose -π/2 X
              // rotation never reaches the AudioContext). The listener is set
              // in three.js frame (index.js:1479-1480), so the emitter must be
              // transformed into the SAME frame or its panned DIRECTION is
              // permuted (AC-north → overhead instead of three.js -Z forward).
              // Apply acToThree (ax,ay,az)→(ax,az,-ay); distance is preserved
              // either way. Retail shares one frame (acclient.c:383163-383164).
              // (D4-NEW-1-verification.md — verdict PARTIAL/HIGH.) NOTE: this
              // followGuid sound's per-rAF panner update lives in
              // index.js updateFollowingPositions and must apply the same
              // transform there to stay corrected after frame 0.
              const a4t = acToThree(pos.x, pos.y, pos.z);
              // SoundHook (1) applies the effect slider twice (acclient.c:342190, 383481, 383092-383095).
              audioMgr.play(waveId, { x: a4t[0], y: a4t[1], z: a4t[2] }, { gain: volume, followGuid: (guid >>> 0), sliderTwice: e.hookType === 1 }).catch(() => {});
            }, delayMs);
            timeoutIds.push(tid);
          }
        }
        continue; // hook handled; don't fall through to emitter check
      }

      // === Render-completeness Waves-2 P3 (2026-05-29) ===
      // Pre-P3 the walker handled only Sound(1)/SoundTweaked(21) and
      // CreateParticle(13)/CreateBlockingParticle(26), `continue`-ing past
      // every other type. That silently DROPPED three hook types that
      // legitimately appear in PhysicsScript (0x33) chains:
      //   SoundTable(2)  ×626 scripts — the walker's sound arm above checks
      //                  for raw Sound(1)/SoundTweaked(21), but real scripts
      //                  carry SoundTable(2) (a Sound-enum lookup vs the
      //                  entity's SoundTable).
      //   Scale(12)      ×122 scripts — uniform object scale tween.
      //   CallPES(19)    ×354 scripts — a RECURSIVE sub-script call that was
      //                  never followed.
      // We DON'T blanket-route every type through `_fireHook` (that path is
      // the animation-trigger executor; firing animation-only hooks like
      // ReplaceObject(5)/material ramps from the spawn-walker context risks
      // acting on the wrong target). Instead we explicitly add the three
      // types that belong in PhysicsScripts, decoding from `e.hookData`
      // (PhysicsScriptEntryJs exposes no soundEnum/rampEnd/callPes getters)
      // with the SAME byte layout the animation-hook path uses
      // (`lib.rs` AnimationHookJs::{soundEnum,rampEnd,rampTime,callPesDid,
      // callPesPause}). SoundTable(2)/Scale(12) reuse the validated
      // `_fireHook` arms via a small adapter object (no logic duplication);
      // CallPES(19) recurses through this same walker with a depth guard.
      if (e.hookType === 2 || e.hookType === 12 || e.hookType === 19) {
        const inst = this.entityMap.get(guid >>> 0);
        if (!inst) continue; // entity gone; drop.
        const bytes = e.hookData; // Uint8Array view of the typeswitch body.
        const dv = (bytes && bytes.byteLength)
          ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : null;
        // PhysicsScript hooks fire `start_time` seconds after script attach
        // (same convention as the Sound arm above). Honor it via setTimeout
        // so scripted timing isn't collapsed to t=0.
        const startDelayMs = Math.max(0, (+e.startTime || 0) * 1000);
        if (e.hookType === 2) {
          // SoundTable: soundEnum = u32 LE @ hook_data[0..4] (len >= 4).
          if (!dv || bytes.byteLength < 4) continue;
          const soundEnum = dv.getUint32(0, true) >>> 0;
          if (soundEnum === 0) continue;
          const cache = this.scene3d?.soundTableCache ?? null;
          const tid = setTimeout(() => {
            if (!this.entityMap.has(guid >>> 0)) return;
            // Adapter mirrors the AnimationHookJs shape `_fireHook` reads.
            this._fireHook(inst, { hookType: 2, soundEnum, time: +e.startTime }, audioMgr, cache);
          }, startDelayMs);
          timeoutIds.push(tid);
          continue;
        }
        if (e.hookType === 12) {
          // Scale: rampEnd = f32 LE @[0..4], rampTime = f32 LE @[4..8]
          // (len == 8). No `start` — `_fireHook` tweens from current scale.
          if (!dv || bytes.byteLength < 8) continue;
          const rampEnd = dv.getFloat32(0, true);
          const rampTime = dv.getFloat32(4, true);
          const tid = setTimeout(() => {
            if (!this.entityMap.has(guid >>> 0)) return;
            this._fireHook(inst, { hookType: 12, rampEnd, rampTime, time: +e.startTime }, null, null);
          }, startDelayMs);
          timeoutIds.push(tid);
          continue;
        }
        // CallPES (19): callPesDid = u32 LE @[0..4], callPesPause = f32 LE
        // @[4..8] (len >= 8). Recurse THIS walker on the sub-script, after
        // (start_time + callPesPause). Depth-guarded so a cyclic script
        // graph can't infinitely recurse / spawn-storm.
        if (!dv || bytes.byteLength < 8) continue;
        const callPesDid = dv.getUint32(0, true) >>> 0;
        const callPesPause = dv.getFloat32(4, true);
        if (callPesDid === 0) continue;
        if (depth >= MAX_CALL_PES_DEPTH) {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/P3] CallPES depth guard hit (depth=${depth} >= ${MAX_CALL_PES_DEPTH}); ` +
              `dropping sub-script 0x${callPesDid.toString(16)} on guid=0x${guid.toString(16)}`
          );
          continue;
        }
        // T6: retail CallPES rolls a UNIFORM RANDOM duration in [0, pause]
        // (`Random::RollDice(0, pause)`, acclient.c:318987) driving a 0→1
        // FPHook that fires the sub-script only on interp completion — so
        // `pause` is a MAX window, not a fixed wait. If `delta < 0.0002`
        // retail fires immediately (acclient.c:318973). Replace the old
        // fixed `(start_time + pause)*1000` with that jitter. start_time is
        // the hook's own schedule offset within this chain (additive,
        // unchanged); only the pause window is now randomized. Accepts
        // non-determinism (timeRng = Math.random by default).
        const pauseW = +callPesPause || 0;
        const randPause = pauseW < 0.0002 ? 0 : timeRng() * pauseW;
        const pesDelayMs = Math.max(0, ((+e.startTime || 0) + randPause) * 1000);
        // Batch 9 #24 (2026-06-07): the CallPES timer fires AFTER this
        // chain walk has already `.set` its local `timeoutIds` into
        // `_soundTimeoutsForGuid` (~6622). Worse, the recursive sub-script
        // walk this timer kicks does its OWN `.set` on the same GUID,
        // clobbering the parent's tracked ids. So we don't rely on the
        // local `timeoutIds`/`.set` for this timer: register it DIRECTLY
        // into the persistent per-guid array (get-or-create + PUSH — the
        // value is an Array, never `.set`/Set.add) so remove(guid) can
        // cancel a still-pending CallPES even after the sub-walk clobbers
        // the map's array, and self-remove on fire so fired ids don't
        // accumulate. We also keep the local push so a same-walk `.set`
        // stays self-consistent for callers that snapshot it immediately.
        const gKey = guid >>> 0;
        const pesTid = setTimeout(() => {
          // Self-remove this id from the persistent array first so a
          // later remove(guid) doesn't waste a clearTimeout on a fired id.
          const arr = this._soundTimeoutsForGuid.get(gKey);
          if (arr) {
            const i = arr.indexOf(pesTid);
            if (i !== -1) arr.splice(i, 1);
          }
          if (!this.entityMap.has(gKey)) return;
          // W4.7 — inherit the default part anchor in the sub-script.
          this._attachParticleChainForEntity(guid, rig, callPesDid, depth + 1, defaultPartIndex).catch(() => {});
        }, pesDelayMs);
        let pesBucket = this._soundTimeoutsForGuid.get(gKey);
        if (!pesBucket) {
          pesBucket = [];
          this._soundTimeoutsForGuid.set(gKey, pesBucket);
        }
        pesBucket.push(pesTid);
        timeoutIds.push(pesTid);
        continue;
      }

      // DIM6-2 / W1.3 (2026-06-05): the PhysicsScript chain-walker previously
      // `continue`'d past Destroy(14)/Stop(15) hooks, silently dropping them —
      // retail tears emitters down by the per-script handle
      // (acclient.c:342513-342545, :316382-316407), mirroring the already-
      // correct AnimationHook path at entities.js (~hookType 14/15 above).
      // The PhysicsScriptEntryJs wasm getter `createParticleEmitterInstanceId`
      // is GATED on hook_type 13|26 (lib.rs:34803-34809) so it returns 0 for
      // 14/15; the handle for those is the 4-byte payload at hookData[0..4]
      // (parallels AnimationHookJs::particle_emitter_id, lib.rs:13237-13239),
      // so read it directly from `e.hookData` (the same Uint8Array view the
      // SoundTable/Scale/CallPES arms above decode). (anim-deep FIX-PLAN W1.3.)
      if (e.hookType === 14 || e.hookType === 15) {
        const hb = e.hookData; // Uint8Array view of the 4-byte payload.
        if (hb && hb.byteLength >= 4 && this._worldParticleManager) {
          const dvh = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
          const handle = dvh.getUint32(0, true) >>> 0;
          if (handle !== 0) {
            try {
              if (particleOwnerOn()) {
                // A11-S2: handle is OBJECT-SCOPED — resolve it through this
                // guid's owner record (retail destroy/stop key into the
                // object's OWN table, acclient.c:316382-316407), so a handle
                // collision with another object's script can't cross-kill.
                if (e.hookType === 14) {
                  ownerRegistry.destroyEmitter(guid >>> 0, handle);
                } else {
                  ownerRegistry.stopEmitter(guid >>> 0, handle);
                }
              } else if (e.hookType === 14) {
                this._worldParticleManager.destroyParticleEmitter(handle);
              } else {
                this._worldParticleManager.stopParticleEmitter(handle);
              }
            } catch (_) { /* idempotent — never error on unknown id */ }
          }
        }
        continue;
      }

      if (e.hookType !== 13 && e.hookType !== 26) continue;
      const emitterId = (e.createParticleEmitterId >>> 0);
      if (emitterId === 0) continue;

      let emitterInfo;
      try {
        emitterInfo = await this.wasmExports.fetchParticleEmitter(emitterId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/H2] fetchParticleEmitter(0x${emitterId.toString(16)}) failed:`,
          err
        );
        continue;
      }

      // Perf B2 (2026-05-18): scratch-pool the offset frame.
      // `ParticleManager.addEmitter` eventually calls
      // `ParticleEmitter.setParenting(partIdx, offsetFrame)` which
      // `.copy()`s position + quaternion into the emitter's persistent
      // `parentOffset` (particle_emitter.js:114-118). Within a single
      // `_attachParticleChainForEntity` call the for-loop awaits each
      // `addEmitter` before iterating, so the scratches are safe to
      // reuse across hook entries in the same chain walk.
      //
      // CAVEAT: addEmitter is async and has multiple awaits
      // (geometryFactory, materialFactory, setInfo) BEFORE setParenting
      // runs. If two `_attachParticleChainForEntity` calls overlap (the
      // outer call site is fire-and-forget at entities.js:912), caller
      // B can overwrite the scratch values between caller A's `.set()`
      // here and caller A's eventual `setParenting`. The race window
      // is narrow and the visual effect is a wrong particle offset on
      // one emitter — not catastrophic, but worth a follow-on if
      // overlapping bulk spawns produce visible artifacts. A safer
      // long-term fix would be a per-call scratch pair or changing the
      // `addEmitter` contract to consume the offset synchronously.
      _particleAttachScratchVec3.set(
        e.createParticleOffsetX,
        e.createParticleOffsetY,
        e.createParticleOffsetZ,
      );
      _particleAttachScratchQuat.set(
        e.createParticleOffsetQX,
        e.createParticleOffsetQY,
        e.createParticleOffsetQZ,
        e.createParticleOffsetQW,
      );
      const offset = {
        position: _particleAttachScratchVec3,
        quaternion: _particleAttachScratchQuat,
      };

      let partIndex = (e.createParticlePartIndex === 0xffffffff)
        ? -1
        : (e.createParticlePartIndex | 0);
      // W4.7 / DIM3-3 (2026-06-05): if this hook anchors at the body root
      // (sentinel -1) but the invoking DefaultScriptPart(18) supplied a default
      // part, anchor at that part instead — retail `play_default_script` passes
      // `_part_index` as the script's base part. A hook that names its OWN part
      // is unaffected. (anim-deep FIX-PLAN W4.7.)
      if (partIndex === -1 && (defaultPartIndex | 0) >= 0) {
        partIndex = defaultPartIndex | 0;
      }

      // F.D-fu (2026-05-20): record the CreateParticle hook FIRING (the
      // contract-level event per docs/event-completeness-method.md
      // §P1 — entity-anchored PhysicsScript hooks) IMMEDIATELY at hook-
      // iteration time, BEFORE the slow addEmitter await. The
      // contract's "did this event fire?" is satisfied when the chain
      // walker DISPATCHES the hook (the emitterId is resolved from
      // the script entry, partIndex is determined, the chain walker
      // has reached the addEmitter call site). Whether addEmitter
      // succeeds at building the visual is QoS downstream of the
      // contract — setInfo can return 0 when the emitter's hwGfxObjId
      // yields a 0-part building bundle, and the wasm geometry/
      // material fetches addEmitter awaits internally can take ~30+s
      // each under headless software-GL. Under those conditions a
      // validator snapshot at +60s would see 0 fires; pushing the
      // record at dispatch time surfaces the contract-level event
      // immediately. The `visual_landed` field stays `false` here;
      // production observers that care about visual landing should
      // consult `_particleEmittersForGuid.get(guid)` separately.
      const firePos = {
        x: rig.position.x,
        y: rig.position.y,
        z: rig.position.z,
      };
      const fireMeta = {
        entity_guid: (guid >>> 0),
        script_did: (pesId >>> 0),
        start_time_s: +e.startTime,
        hook_type: (e.hookType | 0),
        part_index: partIndex,
        offset_x: +e.createParticleOffsetX,
        offset_y: +e.createParticleOffsetY,
        offset_z: +e.createParticleOffsetZ,
      };
      if (pushEventRecord) {
        pushEventRecord({
          type: "particle",
          emitter_did: (emitterId >>> 0),
          parent_entity_guid: (guid >>> 0),
          world_pos: [+firePos.x, +firePos.y, +firePos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "PhysicsScriptHook",
          source_meta: { ...fireMeta, visual_landed: false, dispatched: true },
        });
      }
      // F.D-fu (2026-05-20): fire-and-forget the visual addEmitter so
      // the for-loop iteration doesn't block on per-emitter wasm
      // geometry/material fetches. Under headless software-GL each
      // addEmitter can take ~30+s for a fresh hwGfxObjId pair (the
      // takram bake + GPU stall path); serial-await across 3 entries
      // pushed total chain walk past validator snapshot windows.
      // Visual rendering completes in the background; emitterIds
      // collects as each promise resolves so `_particleEmittersForGuid`
      // eventually contains the right set. Behaviour-wise this means
      // emitterIds order can differ from manifest order on slow-
      // emitter cases, but no caller asserts ordering on that map.
      const emitterIdForCatch = (emitterId >>> 0);
      // DIM6-2 / W1.3 (2026-06-05): seed the manager emitter with the per-script
      // INSTANCE handle (createParticleEmitterInstanceId = hookData[36..40],
      // lib.rs:34803-34809) — NOT the EmitterInfo DID `emitterId` above — so a
      // later Destroy(14)/Stop(15) hook in the same chain can key teardown by
      // that handle. ParticleManager.addEmitter already honors a supplied
      // `emitterId` (particle_manager.js:126/:131/:238); when 0 it auto-assigns,
      // so the moon (pure CreateParticle, handle 0) is unaffected. Mirrors the
      // AnimationHook CreateParticle path (entities.js _fireCreateParticleHook
      // passes `emitterId: emitterIdSeed`). (anim-deep FIX-PLAN W1.3.)
      // A11-S2: with `?particleOwner=on`, route through the owner facade —
      // the per-script instance handle becomes OBJECT-SCOPED (the facade
      // allocates the underlying id and owns replace/blocking semantics per
      // owner, retail per-CPhysicsObj table), and teardown is
      // `destroyAllForOwner` at entity-release. Off-path unchanged.
      const _s2AddEmitter = (req) =>
        particleOwnerOn()
          ? ownerRegistry.addEmitter(guid >>> 0, this._worldParticleManager, req)
          : this._worldParticleManager.addEmitter(req);
      _s2AddEmitter({
        emitterInfo,
        parent: rig,  // <-- the entity rig (THREE.Group); .position + .quaternion track the entity
        partIndex,
        parentOffset: offset,
        emitterId: (e.createParticleEmitterInstanceId >>> 0),
        // A11-S0: hook 26 = CreateBlockingParticle. With the parity flag on,
        // route it with retail blocking semantics (no-replace if id live).
        // (A11-S2: the owner facade applies blocking per-owner regardless,
        // but only when the S0 parity flag asks for blocking semantics —
        // keep the two flags' contracts independent.)
        blocking: ((e.hookType | 0) === 26) && BLOCKING_PARTICLE_PARITY_ON,
      })
        .then((id) => {
          if (id !== 0) {
            emitterIds.push(id);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/H2] addEmitter(0x${emitterIdForCatch.toString(16)}) failed:`,
            err
          );
        });
    }
    if (emitterIds.length > 0) {
      // A11-S2: the owner facade is the registry of record when the flag is
      // on — do NOT shadow it in the legacy per-guid map (the map would be a
      // second teardown path, exactly the split-brain S2 removes).
      if (!particleOwnerOn()) {
        this._particleEmittersForGuid.set(guid, emitterIds);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[entities/H2] attached ${emitterIds.length} particle emitters ` +
          `for entity 0x${guid.toString(16)} (PES 0x${pesId.toString(16)})`
      );
    }
    if (timeoutIds.length > 0) {
      // Batch 9 #24 (2026-06-07): get-or-create + MERGE rather than `.set`
      // (clobber). The CallPES arm above may have already registered its
      // self-removing timer into this guid's array; a recursive sub-script
      // walk hitting this line must NOT replace that array out from under
      // the still-pending parent timers. Dedup so a CallPES timer that is
      // in BOTH the local `timeoutIds` and the persistent array (it pushes
      // to both) isn't recorded twice. The value stays a plain Array.
      let bucket = this._soundTimeoutsForGuid.get(guid);
      if (!bucket) {
        bucket = [];
        this._soundTimeoutsForGuid.set(guid, bucket);
      }
      for (const tid of timeoutIds) {
        if (bucket.indexOf(tid) === -1) bucket.push(tid);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[entities/H3-E1] scheduled ${timeoutIds.length} sound hooks ` +
          `for entity 0x${guid.toString(16)} (PES 0x${pesId.toString(16)})`
      );
    }
    // F.D-fu3 (2026-05-20): return a descriptor so callers can
    // observe what actually landed without polling the internal Maps.
    return {
      ok: true,
      emitterCount: emitterIds.length,
      soundHookCount: timeoutIds.length,
    };
  }

  // ===================================================================
  // A11-S1 (unification survey 2026-06-11) — shared script executor path
  // ===================================================================

  /**
   * Decode a `PhysicsScriptEntryJs` into a plain object whose fields match
   * the `AnimationHookJs` getter names `_fireHook` / `_fireCreateParticleHook`
   * read. The PhysicsScript entry's `hookData` carries the IDENTICAL
   * `(hook_type, hook_data)` typeswitch body as an AnimationHook
   * (lib.rs:14377-14409), so the byte offsets below mirror the
   * `AnimationHookJs` getters (lib.rs:14543-14890) 1:1. This is the SEAM:
   * after this decode every hook flows through the single `_fireHook`
   * executor — no forked dispatch switch (ROADMAP §2).
   *
   * @param {Object} e  a PhysicsScriptEntryJs (drained from `takeEntries()`).
   * @returns {Object} AnimationHookJs-shaped plain object.
   */
  _decodePhysicsScriptHookEntry(e) {
    const hookType = e.hookType | 0;
    const time = +e.startTime || 0;
    const bytes = e.hookData;
    const len = bytes ? bytes.byteLength : 0;
    const dv =
      bytes && len ? new DataView(bytes.buffer, bytes.byteOffset, len) : null;
    const u32 = (off) => (dv && off + 4 <= len ? dv.getUint32(off, true) >>> 0 : 0);
    const i32 = (off) => (dv && off + 4 <= len ? dv.getInt32(off, true) : 0);
    const f32 = (off) => (dv && off + 4 <= len ? dv.getFloat32(off, true) : 0);
    // Base — A11-S1 fixup (2026-06-11): PhysicsScript-sourced hooks must FIRE
    // UNCONDITIONALLY through `_fireHook`, exactly like the legacy off-path
    // walker (which never reads `direction`, entities.js ~:9924-9928 comment)
    // and retail `ScriptManager::UpdateScripts` (acclient.c:329189-329246), which
    // calls `hook->Execute` with NO direction gate — the A-DIR gate is a
    // motion-Sequence (acclient.c segment-playback) concept, not a script-queue
    // one. We therefore force `direction = 0` (Both) so the A-DIR gate in
    // `_fireHook` (entities.js:9935, drops `direction === -1`) never drops a
    // genuinely wire-parsed `i32 direction == -1` 0x33 entry (SoundTable 2 /
    // NoDraw 16 / TextureVelocity 23/24 / SetLight 25 / etc.). Feeding the raw
    // on-disk `direction` here re-created the exact on/off-path divergence the
    // `?scriptQueue` flag's 'byte-identical / no drift' contract forbids. We do
    // NOT read `e.direction` at all (it stays a property of the wire entry only).
    const h = { hookType, time, direction: 0 };
    // SCRIPTMGR-RATE (2026-08-11): `time` is the `_fireHook`/`AnimationHookJs`
    // field name; `ScriptManager` schedules on `startTime`, which read
    // `undefined` here from A11-S1 (2026-06-11) until today — collapsing every
    // script to length 0 / all-hooks-at-t0 and turning a CallPES self-loop into
    // a per-frame loop (see `SCRIPT_HOOK_TIME_ON` above for the arithmetic).
    // Carry BOTH names — additive, so `_fireHook` is unaffected.
    if (SCRIPT_HOOK_TIME_ON) h.startTime = time;
    switch (hookType) {
      case 1: // Sound — wave DID @0
        h.soundWaveId = u32(0);
        break;
      case 21: // SoundTweaked — gid@0 prob@4 prio@8 vol@12
        h.soundWaveId = u32(0);
        h.soundProbability = len === 16 ? f32(4) : 1.0;
        h.soundPriority = len === 16 ? f32(8) : 0.0;
        h.soundVolume = len === 16 ? f32(12) : 1.0;
        break;
      case 2: // SoundTable — sound enum @0
        h.soundEnum = u32(0);
        break;
      case 6: // Ethereal
        h.etherealValue = i32(0);
        break;
      case 16: // NoDraw
        h.noDrawValue = u32(0);
        break;
      case 25: // SetLight
        h.lightsOn = i32(0);
        break;
      case 22: // SetOmega — x@0 y@4 z@8
        h.omegaX = f32(0); h.omegaY = f32(4); h.omegaZ = f32(8);
        break;
      case 12: // Scale — end@0 time@4
        h.rampEnd = f32(0); h.rampTime = f32(4);
        break;
      case 8: case 10: case 20: // whole-object ramp — start@0 end@4 time@8
        h.rampStart = f32(0); h.rampEnd = f32(4); h.rampTime = f32(8);
        h.partIndex = 0xffffffff;
        break;
      case 7: case 9: case 11: // per-part ramp — part@0 start@4 end@8 time@12
        h.partIndex = u32(0);
        h.rampStart = f32(4); h.rampEnd = f32(8); h.rampTime = f32(12);
        break;
      case 23: // TextureVelocity — u@0 v@4
        h.textureUSpeed = f32(0); h.textureVSpeed = f32(4);
        h.partIndex = 0xffffffff;
        break;
      case 24: // TextureVelocityPart — part@0 u@4 v@8
        h.partIndex = u32(0);
        h.textureUSpeed = f32(4); h.textureVSpeed = f32(8);
        break;
      case 18: // DefaultScriptPart — part@0
        h.partIndex = len >= 4 ? u32(0) : 0xffffffff;
        break;
      case 14: case 15: // Destroy / Stop — handle @0
        h.particleEmitterId = u32(0);
        break;
      case 19: // CallPES — did@0 pause@4
        h.callPesDid = u32(0);
        h.callPesPause = f32(4);
        break;
      case 13: case 26: // CreateParticle / CreateBlockingParticle (40 bytes)
        h.emitterInfoId = len === 40 ? u32(0) : 0;
        h.createPartIndex = len === 40 ? u32(4) : 0;
        h.offsetOriginX = len === 40 ? f32(8) : 0;
        h.offsetOriginY = len === 40 ? f32(12) : 0;
        h.offsetOriginZ = len === 40 ? f32(16) : 0;
        h.offsetOrientationW = len === 40 ? f32(20) : 1.0;
        h.offsetOrientationX = len === 40 ? f32(24) : 0;
        h.offsetOrientationY = len === 40 ? f32(28) : 0;
        h.offsetOrientationZ = len === 40 ? f32(32) : 0;
        h.particleEmitterId = len === 40 ? u32(36) : 0;
        break;
      default:
        break;
    }
    return h;
  }

  /**
   * A11-S1: queue a PhysicsScript onto this entity's `ScriptManager`, decoding
   * each entry into an AnimationHookJs-shaped hook and firing it through the
   * shared `_fireHook` executor. Replaces the legacy per-hook `setTimeout`
   * walk (the off-path) when `?scriptQueue=on`. Scripts chain back-to-back
   * (ScriptManager.addScript). CallPES (19) is handled inside the executor by
   * recursing into `_queuePhysicsScript`, so a sub-script joins the SAME queue
   * — serialized like retail, not a concurrent recursive walk.
   *
   * @returns {{ok:boolean, hookCount:number}} descriptor (parallels the legacy
   *   walker's return shape enough for callers that only check `ok`).
   */
  _queuePhysicsScript(guid, rig, pesId, entries, depth = 0, defaultPartIndex = -1, startNow = undefined) {
    const gKey = guid >>> 0;
    let mgr = this._scriptManagersForGuid.get(gKey);
    if (!mgr) {
      mgr = new ScriptManager({ owner: gKey });
      // Install the shared executor (the seam). Bound to THIS chain's rig +
      // depth + default-part anchor so the sub-script recursion inherits them.
      mgr.setExecutor((entry) =>
        this._executeScriptHook(gKey, rig, pesId, entry, depth, defaultPartIndex),
      );
      this._scriptManagersForGuid.set(gKey, mgr);
    } else {
      // Re-point the executor at the most-recent chain context so a script
      // queued after a context change (new rig on respawn) fires correctly.
      mgr.setExecutor((entry) =>
        this._executeScriptHook(gKey, rig, pesId, entry, depth, defaultPartIndex),
      );
    }
    // PORTAL-LOOP (2026-08-04): the spawn-storm bound that replaces per-
    // iteration depth accumulation (`?callPesLoop`, default ON). A CallPES
    // sub-script (`startNow` is a number — top-level attaches pass undefined)
    // that would push this owner's PENDING queue past the cap is dropped: a
    // branching script bomb saturates its own serialized queue and stops
    // growing, while a well-formed self-loop keeps at most one pending
    // sub-script and never comes near the cap.
    if (
      CALL_PES_LOOP_ON &&
      typeof startNow === "number" &&
      Array.isArray(mgr._queue) &&
      mgr._queue.length >= MAX_OWNER_SCRIPT_QUEUE
    ) {
      if (!this._callPesQueueCapWarned) {
        this._callPesQueueCapWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/PORTAL-LOOP] owner 0x${gKey.toString(16)} CallPES sub-script ` +
          `0x${(pesId >>> 0).toString(16)} dropped — pending queue at cap ` +
          `(${MAX_OWNER_SCRIPT_QUEUE}); branching script graph?`
        );
      }
      return { ok: false, hookCount: 0, emitterCount: 0, soundHookCount: 0 };
    }
    const decoded = [];
    for (const e of entries) decoded.push(this._decodePhysicsScriptHookEntry(e));
    // A11-S1 fixup: a CallPES sub-script supplies its own absolute t=0
    // (`startNow` = fire-time + RollDice(0,pause)) so the rand-pause schedule is
    // honored even if the parent script has already popped (queue empty → the
    // `now` override is what `addScript` keys off). For top-level scripts
    // `startNow` is undefined → `addScript` falls back to `currentTime()` /
    // back-to-back chaining, unchanged.
    mgr.addScript(
      pesId >>> 0,
      decoded,
      typeof startNow === "number" ? { now: startNow } : undefined,
    );
    // Descriptor shape parallels the legacy walker's so callers (validators)
    // that read `ok`/`emitterCount`/`soundHookCount` keep working. On the
    // queue path the visual/sound split isn't known until the hooks fire, so
    // we surface the total queued hook count under all three fields' intent.
    return {
      ok: true,
      hookCount: decoded.length,
      emitterCount: 0,
      soundHookCount: 0,
    };
  }

  /**
   * A11-S1: the per-hook arm of the shared executor. Routes a decoded hook
   * through `_fireHook` (the single dispatch switch), with three owner-context
   * fixups the entity walker needs:
   *   - CreateParticle (13/26): seed the instance handle + default-part anchor,
   *     honoring `?blockingParticleParity`, then call `_fireCreateParticleHook`.
   *   - CallPES (19): recurse into `_queuePhysicsScript` (depth-guarded) so the
   *     sub-script joins this owner's queue.
   *   - everything else: straight `_fireHook(inst, hook, audioMgr, cache)`.
   */
  _executeScriptHook(gKey, rig, pesId, hook, depth, defaultPartIndex) {
    const inst = this.entityMap.get(gKey);
    if (!inst) return; // entity released — drop the hook.
    const hookType = hook.hookType | 0;
    const audioMgr = this.scene3d?.audioManager ?? null;
    const cache = this.scene3d?.soundTableCache ?? null;
    if (hookType === 13 || hookType === 26) {
      // Inherit the invoking DefaultScriptPart's anchor when the hook anchors
      // at the body root (W4.7 / DIM3-3 parity), then fire via the shared
      // create-particle arm.
      const adapted = { ...hook };
      if ((adapted.createPartIndex >>> 0) === 0xffffffff && (defaultPartIndex | 0) >= 0) {
        adapted.createPartIndex = defaultPartIndex | 0;
      }
      const isBlocking = hookType === 26 && BLOCKING_PARTICLE_PARITY_ON;
      this._fireCreateParticleHook(inst, adapted, isBlocking).catch(() => {});
      // Track for entity-release teardown like the legacy path does.
      return;
    }
    if (hookType === 19) {
      // CallPES — queue the sub-script on the SAME owner (serialized).
      const callDid = hook.callPesDid >>> 0;
      if (callDid === 0) return;
      // PORTAL-LOOP (2026-08-04): on the queue path a CallPES iteration is
      // async scheduling, not stack recursion — retail has no depth counter
      // (acclient.c:318973-319005), and accumulating one here killed every
      // self-looping ambient script (portal swirl) after 3 iterations. With
      // `?callPesLoop` ON (default) depth passes through UNCHANGED and the
      // spawn-storm guard is the per-owner queue bound in
      // `_queuePhysicsScript`; `=off` restores the depth-capped legacy arm.
      if (!CALL_PES_LOOP_ON && depth >= MAX_CALL_PES_DEPTH) return;
      // A11-S1 fixup (2026-06-11): apply the retail CallPES rand-pause that the
      // legacy off-path uses (entities.js:8046-8048) and the original queue path
      // dropped. Retail `CPhysicsObj::CallPES` (acclient.c:318973-319005)
      // schedules the sub-script at `RollDice(0, pause)` on the physics clock
      // when `pause >= 0.0002`, else fires immediately — `callPesPause` is a MAX
      // window, not a fixed wait, and it is INDEPENDENT of the parent script's
      // derived length (so the prior 'serialized after parent length' behavior
      // was timing drift, not parity). We capture the start time NOW (when the
      // CallPES hook fires) plus the random pause, and hand it to the sub-script
      // as its absolute t=0 — robust to the parent script having already popped
      // by the time the async fetch resolves.
      const pauseW = +hook.callPesPause || 0;
      const randPause = pauseW < 0.0002 ? 0 : timeRng() * pauseW;
      const subStart = currentTime() + randPause;
      this.wasmExports
        .fetchPhysicsScript(callDid)
        .then((sub) => {
          if (!this.entityMap.has(gKey)) return;
          const subEntries = sub.takeEntries();
          // PORTAL-LOOP: loop iterations do not accumulate depth (see the
          // guard above); the legacy `=off` arm keeps the old accounting.
          const subDepth = CALL_PES_LOOP_ON ? depth : depth + 1;
          this._queuePhysicsScript(gKey, rig, callDid, subEntries, subDepth, defaultPartIndex, subStart);
        })
        .catch(() => {});
      return;
    }
    // All other hook types route straight through the shared executor.
    this._fireHook(inst, hook, audioMgr, cache);
  }

  /**
   * F.D-fu3 (2026-05-20) — await the H2 particle chain walker's
   * resolution for `guid`. Returns the descriptor produced by
   * `_attachParticleChainForEntity` (with `ok`, `emitterCount`,
   * `soundHookCount`, optional `reason`), or `null` if the entity
   * never had a PhysicsScript DID + thus never started a chain walk
   * (which is the common case for most weenies).
   *
   * Used by validators (Phase F.D) to wait for the chain to land
   * BEFORE snapshotting the event log, instead of guessing a settle
   * time. Mirrors the `spawnInFlight` pattern at line 786 — the
   * promise is created at chain-walk dispatch time and stays in
   * the Map across the walker's `fetchPhysicsScript` → loop →
   * `fetchParticleEmitter` → `addEmitter` chain.
   *
   * @param {number} guid
   * @returns {Promise<{ok: boolean, emitterCount: number, soundHookCount: number, reason?: string}|null>}
   */
  async awaitParticleChainResolution(guid) {
    const g = (guid >>> 0);
    const p = this._particleChainResolveForGuid.get(g);
    if (!p) return null;
    return p;
  }

  /**
   * F.D-fu3 (2026-05-20) — await the SPAWN resolution for `guid`.
   * Returns the `EntityInstance` once the `_spawnImpl` async chain
   * has fully resolved (rig built, meta populated, prewarm fired),
   * or `null` if the entity isn't currently in-flight AND not in
   * the entityMap. If the entity is already fully spawned, returns
   * the existing instance synchronously (Promise resolves on next
   * tick). If a spawn IS in flight, returns the in-flight promise.
   *
   * Validators call this BEFORE `awaitParticleChainResolution` so
   * they wait for the spawn → chain dispatch BEFORE waiting on
   * the chain itself. (Chain dispatch only happens once the
   * spawn's `_spawnImpl` reaches line ~1187.)
   *
   * @param {number} guid
   * @returns {Promise<object|null>}
   */
  async awaitSpawnResolution(guid) {
    const g = (guid >>> 0);
    const inFlight = this.spawnInFlight.get(g);
    if (inFlight) return inFlight;
    const inst = this.entityMap.get(g);
    if (inst) return inst;
    return null;
  }

  /**
   * Phase 7.5 — local player world-position resolver for the camera
   * switcher. Returns AC world coordinates `{x, y, z}` for the entity
   * whose GUID matches `getLocalPlayerGuid()` if exposed on window, or
   * null when no local player is identified yet.
   *
   * Mirrors the 2D path's `centreOnPlayer` localPlayerGuid lookup at
   * `index.html:5597-5603` so the 3D follow camera tracks the same
   * sprite the 2D path centres on. The 2D path stores sprite.x /
   * sprite.y in world AC metres; the 3D path stores root.position
   * with the same convention, so the two converge on identical
   * coordinates when both renderers consume the same entity stream.
   *
   * Falls back to null when no local player is known; the caller
   * (CameraSwitcher._safePlayerPos) then falls back to the Holtburg
   * centre. That keeps the camera framed before the first PUP lands.
   */
  getLocalPlayerWorldPos() {
    // eslint-disable-next-line no-undef
    if (typeof window === "undefined") return null;
    // Workstream B (2026-05-11) — prefer the cameraSwitcher's
    // client-side predicted pose if it's been seeded. The predicted
    // pose advances every rAF along the WASD intent vector + reconciles
    // against the 30 Hz authoritative KIND_POSITION emit, giving the
    // follow camera a smooth 60 FPS player track instead of the
    // discrete server-step jitter the bare `__lastEntityWorldPos` read
    // produces. Falls through to the original three-tier resolution
    // pre-spawn (predictedPlayerPos is null until the first server pose
    // arrives) or in the unit-test path (no liveScene3d on window).
    //
    // eslint-disable-next-line no-undef
    const cs = window.liveScene3d?.cameraSwitcher;
    if (cs && typeof cs.getPredictedPlayerWorldPos === "function") {
      const predicted = cs.getPredictedPlayerWorldPos();
      if (predicted) return predicted;
    }
    // eslint-disable-next-line no-undef
    const lpgFn = window.getLocalPlayerGuid;
    let guid = (typeof lpgFn === "function") ? lpgFn() : null;
    // GUID-prefix fallback: the wasm-side eager-WorldState path on
    // SelectCharacter suppresses the kind=1/kind=7 ClientEvents, so
    // setLocalPlayerGuid is never called and the page-level lookup
    // returns null. AC's 32-bit GUIDs are namespaced — 0x5xxxxxxx is
    // the player-character tier, 0x8xxxxxxx is dynamic spawn (NPCs),
    // 0x7xxxxxxx is world-static. The KIND_POSITION stream in
    // __lastEntityWorldPos still carries the player's pose; scan for
    // the first 0x5-prefix key as a fallback identifier. If none is
    // present yet (pre-spawn frames), fall through to a null return.
    if ((guid === null || guid === undefined)
      // eslint-disable-next-line no-undef
      && window.__lastEntityWorldPos) {
      // eslint-disable-next-line no-undef
      for (const k of window.__lastEntityWorldPos.keys()) {
        if (((k >>> 0) & 0xF0000000) === 0x50000000) {
          guid = k >>> 0;
          break;
        }
      }
    }
    if (guid === null || guid === undefined) return null;
    const guidU32 = guid >>> 0;
    const inst = this.entityMap.get(guidU32);
    if (inst && inst.root) {
      return {
        x: inst.root.position.x,
        y: inst.root.position.y,
        z: inst.root.position.z,
      };
    }
    // Fallback: the wasm-side's eager-WorldState path on SelectCharacter
    // suppresses the KIND_SPAWN entity-update for the local player, so
    // the 3D EntityManager never builds a rig. The 2D path's entityMap
    // (`window.entityMap`, exposed at index.html:2430) is seeded by the
    // same ObjectCreate flow and tracks the player's authoritative
    // world position in `sprite.x` / `sprite.y` (AC world metres). Use
    // the 2D entry as the camera-follow source until the wasm-side
    // gains a local-player KIND_SPAWN emission.
    // eslint-disable-next-line no-undef
    const twoDMap = window.entityMap;
    const twoDEntry = twoDMap && typeof twoDMap.get === "function"
      ? twoDMap.get(guidU32)
      : null;
    if (twoDEntry && twoDEntry.sprite) {
      return {
        x: twoDEntry.sprite.x,
        y: twoDEntry.sprite.y,
        // 2D sprites don't carry world-Z; the wasm-side authoritative
        // pose isn't directly readable, but `__predLastPos` reflects
        // the last predicted Z when one was set. Default to 80 (typical
        // Holtburg outdoor Z) to keep the camera at eye-height — the
        // follow-camera's vertical framing tolerates ±a few metres.
        z: 80,
      };
    }
    // Third-tier fallback: every KIND_POSITION drained by the shared
    // hook is stashed in `window.__lastEntityWorldPos` regardless of
    // whether either entityMap ever spawned a rig. Even with both
    // upstream maps missing the player, this carries the wasm-side
    // pose (the same one the heartbeat trace prints) so the camera
    // tracks teleports + walks without requiring a wasm rebuild to
    // emit KIND_SPAWN for the eager-WorldState path.
    // eslint-disable-next-line no-undef
    const lastMap = window.__lastEntityWorldPos;
    if (lastMap && typeof lastMap.get === "function") {
      const p = lastMap.get(guidU32);
      if (p) {
        return { x: p.x, y: p.y, z: p.z };
      }
    }
    return null;
  }

  /**
   * Follow-on #2 (2026-05-10) — local player's facing in the
   * CameraSwitcher.followYaw convention (clockwise-from-north). Used by
   * `computeMovementFromKeys` in follow mode to compute a heading-error
   * `turn` delta so WASD direction in world space converges on
   * camera-facing even before the player's heading has aligned.
   *
   * Convention bridge:
   *   - `acQuatToThree` reorders (qw,qx,qy,qz) → three (qx,qy,qz,qw)
   *     and `setPose` writes that onto `inst.root.quaternion`.
   *   - Three's Quaternion stores (x, y, z, w) so the AC w lives at
   *     `.w` and the AC z (the yaw axis for an upright body) lives at
   *     `.z`. The yaw extraction below uses the same formula as the
   *     2D path's `quaternionToYaw` (`index.html:2757-2762`).
   *   - The raw yaw is a counter-clockwise rotation around +Z (the
   *     right-hand rule convention three.js + the AC quaternion
   *     family share). `followYaw` is a clockwise-from-+Y-north
   *     compass-bearing convention (camera.js header: yaw=0 → north,
   *     yaw=π/2 → east). The two differ by sign, so we NEGATE.
   *
   * Returns 0 when no local player is known so `headingError = followYaw`
   * → behaviour collapses to "rotate to camera-facing", which is the
   * sensible pre-spawn default (no walking happens pre-EnteredWorld
   * anyway, so the turn delta is harmless).
   */
  getLocalPlayerHeading() {
    // eslint-disable-next-line no-undef
    if (typeof window === "undefined") return 0;
    // eslint-disable-next-line no-undef
    const lpgFn = window.getLocalPlayerGuid;
    if (typeof lpgFn !== "function") return 0;
    const guid = lpgFn();
    if (guid === null || guid === undefined) return 0;
    const inst = this.entityMap.get((guid >>> 0));
    if (!inst || !inst.root) return 0;
    // three.js Quaternion has (x, y, z, w); after acQuatToThree, .z is
    // the AC z-axis component and .w is the AC w. Yaw extraction
    // matches the 2D path's quaternionToYaw exactly.
    const q = inst.root.quaternion;
    const qw = q.w;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const rawYaw = Math.atan2(
      2 * (qw * qz + qx * qy),
      1 - 2 * (qy * qy + qz * qz)
    );
    // Convert CCW-around-+Z (raw quaternion yaw) → CW-from-+Y-north
    // (followYaw convention) by negation. Verified against
    // `from_heading` in `holtburger_common::math::Quaternion` for the
    // four cardinals: N→0, E→π/2, S→π, W→-π/2.
    return -rawYaw;
  }

  /**
   * Wave 5 / Phase 9 (2026-05-26) — defender heading accessor for
   * Sneak Attack prediction. Returns the entity's raw yaw in radians
   * (CCW-around-+Z math convention, same shape as
   * `LocalPlayerPose::heading` from `src/lib.rs:20535-20537` and the
   * wire-side quaternion's `atan2(2(qw·qz + qx·qy), 1 - 2(qy² + qz²))`
   * extraction). NOT negated — unlike `getLocalPlayerHeading()` which
   * converts to the followYaw camera convention, this getter returns
   * the raw yaw so it can be passed directly into
   * `ui/ac_sneak_attack_predict.js::isAttackerBehindDefender` whose
   * AC-forward derivation is `(-sin h, cos h, 0)`.
   *
   * Returns `null` when the entity is unknown OR its rig has not yet
   * been built (no `inst.root.quaternion` available). Callers MUST
   * gate the predictor call on a non-null return — the helper is
   * conservative on `null` headings but skipping the call avoids the
   * cost of building the `pose` object only to throw it away.
   *
   * @param {number} guid — entity GUID to query
   * @returns {number | null} raw yaw in radians, or null if unknown
   */
  getHeading(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return null;
    const inst = this.entityMap.get(g);
    if (!inst || !inst.root || !inst.root.quaternion) return null;
    const q = inst.root.quaternion;
    // Same `atan2(siny_cosp, cosy_cosp)` extraction as
    // `getLocalPlayerHeading()` above + `publish_local_player_pose`
    // in `src/lib.rs`. Note three's `Quaternion` stores `(x, y, z, w)`
    // and `acQuatToThree` re-orders the AC `(qw, qx, qy, qz)` wire
    // tuple into that slot, so `.w` and `.z` here are the AC w / z
    // components directly.
    const qw = q.w;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    return Math.atan2(
      2 * (qw * qz + qx * qy),
      1 - 2 * (qy * qy + qz * qz),
    );
  }

  /**
   * Perf B1 (2026-05-18) — gate predicate for `tick(dt)`. Returns
   * `true` when the entity should run its full per-frame update
   * (mixer.update + hook fire + jump/swing tween advance), `false`
   * when it can be safely skipped this tick.
   *
   * Force-tick exceptions (always returns `true`):
   *   1. Local player — `window.getLocalPlayerGuid()` matches the
   *      entity's guid. The local rig is visible to the user even in
   *      top-down/free cams where the camera is far from the body, so
   *      we never skip its mixer. Handles the function-missing case
   *      (pre-spawn frames, unit-test path with no window) gracefully
   *      by treating it as "not the local player" and falling through
   *      to the distance check.
   *   3. Active swing-pose tween — `inst._swingTween` truthy. Same
   *      reason: the 300 ms slerp needs every tick or the arm sticks
   *      out after the visible swing window has passed.
   *   4. Within tick radius — entity world-space position is within
   *      `MAX_TICK_DIST` metres of the active camera.
   *
   * TODO (B1 follow-on) — additional "currently active" predicates:
   *   - particle-attach hooks fired on this entity (need a hook-fire
   *     timestamp on `inst`; the file doesn't track one today),
   *   - spell-effect bind to a remote target (currently lives on the
   *     particle runtime, not the entity),
   *   - targeted-by-local-player (the picking layer holds the
   *     selection guid; threading it through scene3d would let us
   *     keep a stalker target ticking off-screen).
   *   Each of these is a separate PR — the MVP keeps the predicate
   *   coupled to state already on `inst`.
   */
  _shouldTickEntity(inst) {
    // (1) Local player — always tick.
    let localPlayerGuid = null;
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        // eslint-disable-next-line no-undef
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) {
          localPlayerGuid = lpg >>> 0;
        }
      }
    } catch (_) {
      // Function exists but threw — treat as "no local player resolved"
      // and fall through to the other gates.
    }
    if (localPlayerGuid !== null && (inst.guid >>> 0) === localPlayerGuid) {
      return true;
    }
    // (2) Active jump-pose tween (Wave 1.7 2026-05-26) — always tick
    // to finish the slerp. Without this, an entity that left the tick
    // radius mid-air would freeze in the arms-up pose after re-entry.
    if (inst._jumpPoseTween) return true;
    // (swing/cast vibe-pose tween reads removed — setSwingPose/setCastPose
    // retired, WS-B teardown 2026-06-18; the tweens are never assigned now.)
    // (4) Distance gate — same camera-resolution convention as
    // `capActiveLightsByDistance` in lighting.js (Phase 7.5 switcher
    // first, fall back to `.camera`). Bail open (return `true` —
    // preserve original behaviour) when no camera is resolvable so
    // pre-camera-init frames don't silently freeze every animation.
    const camera =
      this.scene3d?.cameraSwitcher?.activeCamera ??
      this.scene3d?.camera ??
      null;
    if (!camera || !camera.position || !inst.root) {
      return true;
    }
    // Entity rigs live under worldRoot (which is rotated -π/2 around
    // X) so we need the WORLD-space position — matches the lighting
    // pattern at lighting.js:549-555. Use the scratch Vector3 so we
    // don't allocate per-entity per-frame.
    if (typeof inst.root.getWorldPosition === "function") {
      inst.root.getWorldPosition(_tickGateScratch);
    } else if (inst.root.position) {
      _tickGateScratch.set(
        inst.root.position.x,
        inst.root.position.y,
        inst.root.position.z
      );
    } else {
      // No position to compare — bail open.
      return true;
    }
    const dx = _tickGateScratch.x - camera.position.x;
    const dy = _tickGateScratch.y - camera.position.y;
    const dz = _tickGateScratch.z - camera.position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq <= MAX_TICK_DIST_SQ;
  }

  /**
   * T9 — dynamic-LOD recheck. For each non-local, settled entity with a
   * degrade chain, re-query the band at the live camera distance and respawn
   * at the new band when it crosses. The spawn path rebuilds rig + mixer +
   * actions (the "mixer rebind"), so a despawn+respawn is the simplest correct
   * swap. Loop-safe: the recheck distance uses the same world transform the
   * spawn re-queries with, so a fresh spawn lands on the same band that
   * triggered it (no thrash). Skips the local player, in-flight spawns, and
   * entities mid-tween. Throttled by the caller (`DYN_LOD_INTERVAL_S`).
   * @private
   */
  _tickDynamicLod() {
    const lodFetch = this.wasmExports?.fetch_entity_degrade_for_distance;
    if (typeof lodFetch !== "function") return;
    const cam = window.liveScene3d?.camera?.position;
    if (!cam) return;
    let localGuid = null;
    try {
      const lpg = window.getLocalPlayerGuid?.();
      if (lpg != null) localGuid = lpg >>> 0;
    } catch (_) {}
    for (const inst of this.entityMap.values()) {
      const g = inst.guid >>> 0;
      if (g === localGuid) continue; // local player is always full detail
      if (!inst._lodOriginalSetup) continue; // no degrade chain captured
      // Bug 6 (2026-10-07): never LOD-respawn (remove()+spawn()) a dying
      // creature or a corpse mid-handoff — it wiped the ragdoll and the
      // `_deathAt` stamp the corpse claim needs, so the corpse came up in the
      // authored pose. Retail swaps degrades inside the part array instead.
      if (typeof inst._deathAt === "number" || inst._hiddenForHandoff || inst._corpseHandoffGuid) continue;
      if (inst._lodRespawning) continue; // a band query / respawn is in flight
      if (this.spawnInFlight.has(g)) continue;
      // Bug 15 (2026-10-07): `_respawnForLod` is remove()+spawn(), which threw
      // away a swing on the playhead and every queued one-shot, and dropped
      // motions arriving during the rebuild. Approaching monsters cross the
      // distance bands exactly while they attack. Hold the swap while a
      // one-shot plays or waits, and for a quiet window after combat motion.
      if (
        inst._unifiedSeq?.clearOnDone ||
        (inst._unifiedQueue?.list?.length ?? 0) > 0 ||
        (inst._lastCombatMotionMs &&
          performance.now() - inst._lastCombatMotionMs < LOD_RESPAWN_COMBAT_QUIET_MS)
      ) {
        continue;
      }
      if (inst._jumpPoseTween) continue; // (swing/cast tweens retired, WS-B 2026-06-18)
      // PROJ-VIS: never LOD-respawn a projectile. `_respawnForLod` is
      // remove()+spawn(): mid-flight it tore down the trail emitters + light and
      // re-seeded the flight from the stale ObjectCreate velocity (even after
      // the impact stop). Retail swaps degrade levels inside the part array.
      if (inst._isProjectile || inst._ballistic) continue;
      const p = inst.root?.position;
      if (!p) continue;
      // Entity WORLD horizontal distance. entitiesGroup is under worldRoot
      // (rotation.x = -π/2), so the local AC position (east, north, height) =
      // (p.x, p.y, p.z) maps to THREE world (east, height, -north) =
      // (p.x, p.z, -p.y). Horizontal plane is XZ → dz = cam.z - (-p.y).
      const dx = cam.x - p.x;
      const dz = cam.z + p.y;
      const distance = Math.hypot(dx, dz);
      if (!(distance > 0)) continue;
      inst._lodRespawning = true;
      Promise.resolve(lodFetch(inst._lodOriginalSetup, distance))
        .then((sub) => {
          sub = sub >>> 0;
          if (this.entityMap.get(g) !== inst) return; // despawned meanwhile
          if (sub !== ((inst._lodSub ?? 0) >>> 0)) {
            this._respawnForLod(inst, g).catch(() => {});
          } else {
            inst._lodRespawning = false;
          }
        })
        .catch(() => {
          inst._lodRespawning = false;
        });
    }
  }

  /**
   * T9 — despawn + respawn an entity so the spawn path re-picks its LOD band
   * at the current distance. Preserves world pose (the AC-frame local position
   * + quaternion are copied verbatim — entity positions ARE AC LB-local under
   * worldRoot, so this matches applyAppearance) plus the live motion + stance
   * so the swapped rig resumes its gait instead of snapping to spawn idle (the
   * next UpdateMotion re-syncs regardless). Never throws out of the tick path.
   * @private
   */
  async _respawnForLod(inst, g) {
    try {
      const oldMeta = inst.meta || {};
      const newMeta = { ...oldMeta };
      const root = inst.root;
      if (root?.position) {
        const lbId = (oldMeta.landblockId ?? 0) >>> 0;
        const lbX = (lbId >>> 24) & 0xff;
        const lbY = (lbId >>> 16) & 0xff;
        newMeta.x = root.position.x - lbX * 192;
        newMeta.y = root.position.y - lbY * 192;
        newMeta.z = root.position.z;
      }
      if (root?.quaternion) {
        newMeta.qw = root.quaternion.w;
        newMeta.qx = root.quaternion.x;
        newMeta.qy = root.quaternion.y;
        newMeta.qz = root.quaternion.z;
      }
      newMeta.motionCommand =
        (inst.lastMotionCommand ?? inst.currentMotion ?? oldMeta.motionCommand ?? 0) >>> 0;
      newMeta.motionStance =
        (inst.currentStance ?? inst.lastStance ?? oldMeta.motionStance ?? 0) >>> 0;
      try {
        window.__diag?.lod?.onDynamicSwap?.({ guid: g, motion: newMeta.motionCommand });
      } catch (_) {}
      this.remove(g);
      await this.spawn(newMeta);
    } catch (_) {
      // Dynamic LOD must never break the tick / entity state.
    }
  }

  /**
   * F3-1b (bughunt 2026-06-27) — advance every ballistic projectile by REAL
   * elapsed wall-clock time, independent of the main-loop `dt`. Called at the
   * very top of tick(), BEFORE the `dt<=0` recovery early-return, so a cast-time
   * frame stall (which trips the dt-recovery window into forcing dt=0 for ~10
   * frames — exactly a projectile's flight) can no longer freeze the bolt at its
   * launch point. War/void/life bolts + arrows/bolts/thrown weapons are
   * PhysicsState::Missile entities for which ACE streams NO in-flight
   * UpdatePosition — the ObjectCreate launch velocity is the only motion datum,
   * so the client owns their integration (retail: acclient.c update_object
   * integrates by real elapsed quantum, substepped at <=0.1 s, skipping >2 s
   * gaps as teleports). `_ballistic` + `lastVel` + `lastVelMs` are seeded in
   * _spawnImpl. No-op (single Map walk, early `continue`) when nothing is
   * ballistic, so non-combat frames pay ~nothing.
   * @private
   */
  _tickBallisticProjectiles() {
    if (!this.entityMap || this.entityMap.size === 0) return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    for (const inst of this.entityMap.values()) {
      if (!inst || !inst._ballistic || !inst.lastVel || !inst.root) continue;
      const lv = inst.lastVel;
      // Anchor the first step to when the launch velocity was seeded so the
      // total displacement stays correct even if this pass starts a few frames
      // late (e.g. the spawn raced a stalled frame).
      let last = inst._ballisticLastMs;
      if (last == null) last = inst.lastVelMs != null ? inst.lastVelMs : now;
      // PROJ-VIS: an impact stop that raced the rig build (`_ballisticStopMs`,
      // parked by setVelocity) caps the integration at the server's impact
      // time, then the projectile stops exactly like the in-flight impact path.
      const stopMs = inst._ballisticStopMs;
      const endMs = stopMs != null && stopMs < now ? Math.max(stopMs, last) : now;
      let rdt = (endMs - last) / 1000;
      inst._ballisticLastMs = endMs;
      const reachedStop = stopMs != null && now >= stopMs;
      if (!(rdt > 1e-4) || rdt > 2.0) {
        // Retail update_object treats a >2 s gap as a teleport and does NOT
        // integrate across it (acclient.c:323120-323159) — otherwise an alt-tab
        // would hurl the bolt forward. (Moot in practice: a projectile despawns
        // on impact within ~1 s, so it's long gone after any real stall.)
        if (reachedStop) this._stopBallisticProjectile(inst);
        continue;
      }
      const pos = inst.root.position;
      // Substep at <=0.1 s (native MAX_QUANTUM) so a recovered multi-frame gap
      // integrates the full path instead of one oversized Euler step.
      let remaining = rdt;
      while (remaining > 1e-4) {
        const step = remaining > 0.1 ? 0.1 : remaining;
        // G-4 (?projectileGravity=on): semi-implicit Euler — decay vertical
        // velocity first, then integrate, matching the retail arc for gravity-
        // class missiles. Flag off / non-gravity class → lv.vz untouched (flat).
        if (inst._ballisticGravity) lv.vz += PROJECTILE_GRAVITY_Z * step;
        pos.x += lv.vx * step;
        pos.y += lv.vy * step;
        pos.z += lv.vz * step;
        remaining -= step;
      }
      // PROJ-SPIN: retail order — omega spin (grotate) first, then the
      // ALIGN_PATH heading (ACE never sets both on one missile).
      if (inst._ballisticOmega) this._spinProjectile(inst, rdt);
      if (inst._ballisticAlignPath) this._alignToVelocity(inst, lv);
      // PROJ-VIS: client-side terrain collision (retail collides missiles
      // locally; ACE's zero-velocity impact arrives a round-trip later). Only
      // when the launch point was above our terrain sample, and only outdoors.
      if (PROJECTILE_TERRAIN_STOP_ON && inst._ballisticTerrainOk) {
        const gz = _terrainZAt(pos.x, pos.y);
        if (gz != null && pos.z < gz - PROJECTILE_TERRAIN_STOP_EPS) {
          pos.z = gz;
          this._stopBallisticProjectile(inst);
          continue;
        }
      }
      if (reachedStop) this._stopBallisticProjectile(inst);
    }
  }

  /**
   * PROJ-VIS (2026-10-05): end a ballistic projectile's self-integration —
   * the single stop path shared by the in-flight impact VectorUpdate
   * (setVelocity), an impact that raced the rig build (`_ballisticStopMs`) and
   * the client terrain stop. Also extinguishes the projectile's Setup lights:
   * ACE clears LightsStatus in the same ProjectileImpact (SpellProjectile.cs:
   * 209-238) and retail's set_state then DestroyLights (acclient.c:322188).
   */
  _stopBallisticProjectile(inst) {
    if (!inst) return;
    inst._ballistic = false;
    inst._ballisticGravity = false;
    inst._ballisticStopMs = null;
    inst._ballisticOmega = null;
    inst._projectileImpacted = true;
    if (inst.lastVel) {
      inst.lastVel.vx = 0;
      inst.lastVel.vy = 0;
      inst.lastVel.vz = 0;
    }
    this._setProjectileLightsOn(inst, false);
  }

  /** PROJ-VIS: does this projectile's last PhysicsState carry LIGHTING_ON?
   *  Defaults to true when the wasm getter is unavailable (ACE sets
   *  LightsStatus on every spell projectile weenie that has a light). */
  _projectileLightingOn(guid) {
    try {
      const sh = (typeof window !== "undefined") ? window.__sessionHandle : null;
      if (!sh || typeof sh.objectPhysicsState !== "function") return true;
      const st = sh.objectPhysicsState(guid >>> 0) >>> 0;
      if (st === 0) return true; // unknown guid → don't guess dark
      return (st & PHYSICS_STATE_LIGHTING_ON) !== 0;
    } catch (_) {
      return true;
    }
  }

  /** PROJ-VIS: drive a projectile's attached Setup lights on/off by
   *  INTENSITY only (never `.visible` — pool carriers stay invisible so the
   *  renderer's light count never changes, no shader relink). */
  _setProjectileLightsOn(inst, on) {
    const lights = inst && inst._setupLights;
    if (!Array.isArray(lights) || lights.length === 0 || !inst._projectileLights) return;
    for (const light of lights) {
      if (on) {
        const authored = light.userData && Number.isFinite(light.userData.__setupIntensity)
          ? light.userData.__setupIntensity
          : light.intensity;
        light.intensity = authored;
      } else {
        light.intensity = 0;
      }
    }
  }

  /**
   * PROJ-SPIN (2026-10-05): advance a spinning missile's orientation by its
   * PhysicsDesc omega over `dtSec` — retail `UpdatePhysicsInternal`'s
   * `Frame::grotate(omega·quantum)` (acclient.c:317777-317783). grotate builds
   * the axis-angle quaternion of `w = omega·dt` and PRE-multiplies it
   * (`new = dq ⊗ q`, acclient.c:357422-357456): a WORLD-frame rotation, so a
   * Whirling Blade's (4π, 0, 0) spins about world X (east) whatever its
   * heading — what ACE's data makes retail do. Constant world axis ⇒ the
   * substeps compose into one exact rotation, so a single step over the whole
   * elapsed gap is exact. Skips |w| < 2e-4 like grotate. The scene is AC Z-up
   * with a pure w-reorder quaternion mapping (adapter.js acQuatToThree), so the
   * AC vector is used as-is.
   */
  _spinProjectile(inst, dtSec) {
    const o = inst && inst._ballisticOmega;
    if (!o || !inst.root || !(dtSec > 0)) return;
    const wx = o.x * dtSec, wy = o.y * dtSec, wz = o.z * dtSec;
    const theta2 = wx * wx + wy * wy + wz * wz;
    if (!(theta2 >= 0.0002 * 0.0002)) return;
    const theta = Math.sqrt(theta2);
    const s = Math.sin(theta * 0.5) / theta;
    const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(theta * 0.5);
    const q = inst.root.quaternion;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    let nx = dw * qx + dx * qw + dy * qz - dz * qy;
    let ny = dw * qy - dx * qz + dy * qw + dz * qx;
    let nz = dw * qz + dx * qy - dy * qx + dz * qw;
    let nw = dw * qw - dx * qx - dy * qy - dz * qz;
    const n = Math.hypot(nx, ny, nz, nw) || 1;
    q.set(nx / n, ny / n, nz / n, nw / n);
  }

  /**
   * Retail `Frame::set_vector_heading(velocity)` for an ALIGN_PATH missile:
   * yaw so AC-forward (+Y) points along the horizontal velocity, then pitch
   * about the local X axis by the climb angle — an arrow on a gravity arc
   * noses over. AC heading convention as elsewhere here: forward =
   * (-sin h, cos h, 0) ⇒ h = atan2(-vx, vy); world Z-up, same frame as
   * root.position.
   */
  _alignToVelocity(inst, lv) {
    const horiz = Math.hypot(lv.vx, lv.vy);
    if (!(horiz + Math.abs(lv.vz) > 1e-4)) return;
    const h = Math.atan2(-lv.vx, lv.vy);
    const p = Math.atan2(lv.vz, horiz);
    const q = inst.root.quaternion;
    // q = Rz(h) * Rx(p)
    const ch = Math.cos(h / 2), sh = Math.sin(h / 2);
    const cp = Math.cos(p / 2), sp = Math.sin(p / 2);
    q.set(ch * sp, sh * sp, sh * cp, ch * cp);
  }

  /**
   * Per-rAF tick. Advances every entity's motion playhead by dt seconds.
   * Called from loop.js#tickPerFrame.
   */
  tick(dt) {
    // F3-1b (bughunt 2026-06-27): integrate ballistic projectiles on a
    // wall-clock dt BEFORE the dt<=0 recovery early-return below. The main
    // loop forces dt=0 for ~10 frames after any >0.5 s frame stall (the
    // dt-recovery window, index.js:1763-1776), and the first cast of a spell
    // stalls that long loading its particle DATs — so keying projectile flight
    // off `dt` left the bolt frozen at the launch point for its entire sub-
    // second flight. Projectiles own their motion (ACE streams no in-flight
    // UpdatePosition), so a real-time integration here is correct and immune to
    // the freeze. Runs unconditionally; no-op when no entity is ballistic.
    this._tickBallisticProjectiles();
    if (!(dt > 0)) {
      // PROJ-VIS (2026-10-05): the particle/script managers run on the WALL
      // clock (time_rng.js currentTime) and retail never gates them
      // (acclient.c:322886), yet the default `?particleClock=off` path only
      // reached them at the tail of this method — so the dt-recovery window
      // (dt forced to 0 for 10 frames after any >0.5 s stall; a first cast's
      // DAT load is one) froze every emitter mid-flight: the projectile moved
      // (wall-clock above) but its trail emitted nothing for those frames.
      if (particleClockMode() === "off") this.tickParticlesAndScripts();
      return;
    }
    // A5-P2 (`?tweenClock=dt`) — advance the unified tween clock by the SAME
    // dt every mixer below consumes (retail: one elapsed-time quantum for the
    // whole update pass, acclient.c:340659-340780). Placed after the dt>0
    // guard: a skipped frame advances neither mixers nor tweens. When the
    // flag is off this field is dead (legacy wall clock), so no gate check
    // is needed on the add itself — `_tweenNowMs()` owns the gate.
    this._tweenClockMs += dt * 1000;
    // === Wave R3.B (2026-05-29) — resolve the active camera ONCE for the
    // transparent-part sort pass. Same accessor convention as
    // `_shouldTickEntity` (switcher first, fall back to `.camera`). Only when
    // `?sortCenter=on`; null when off → the per-entity call below is never
    // made, so default-off is byte-identical (no renderOrder writes).
    const _sortCenterCamera = this._sortCenterOn
      ? (this.scene3d?.cameraSwitcher?.activeCamera ?? this.scene3d?.camera ?? null)
      : null;
    // RP2 (2026-06-08) — monotonic per-tick frame counter for the far-band
    // smoothing stride. Only incremented when a stride is configured, so the
    // default (stride==1) path never even touches it. Bounded growth is fine
    // (compared via subtraction, not stored long-term). Resolve the camera
    // ONCE for the near/far distance test, same accessor convention as the
    // gate / sort pass; null when the stride is off OR no camera resolvable
    // (→ run every frame, fail-soft like the gate's bail-open). The gait-Hz
    // throttle reads `performance.now()` once here so per-entity recompute
    // gating doesn't call it in the loop.
    const _smoothStrideOn = ENTITY_SMOOTH_STRIDE > 1;
    const _smoothCamera = _smoothStrideOn
      ? (this.scene3d?.cameraSwitcher?.activeCamera ?? this.scene3d?.camera ?? null)
      : null;
    if (_smoothStrideOn) this._smoothFrame = (this._smoothFrame | 0) + 1;
    const _smoothFrame = this._smoothFrame | 0;
    // RP2 — resolve the local-player guid ONCE for the smoothing-stride
    // exclusion (the local player must never be throttled). Only needed when a
    // stride is configured. Same defensive resolution as `_shouldTickEntity`'s
    // gate (the function existing-but-throwing → treat as "no local player").
    let _smoothLocalGuid = null;
    if (_smoothStrideOn) {
      try {
        if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
          const lpg = window.getLocalPlayerGuid();
          if (lpg !== null && lpg !== undefined) _smoothLocalGuid = lpg >>> 0;
        }
      } catch (_) { /* fall through → no local-player exclusion this tick */ }
    }
    // CREATURE-SEPARATION (2026-07-28) — resolve the local player's world
    // pose ONCE per tick. `_localPlayerWorldPose()` crosses the wasm boundary
    // (`SessionHandle.getLocalPlayerPose`), so calling it per entity would be
    // ~30x the cost for a value that cannot change inside a single tick.
    // `null` pre-spawn / on a throwing handle → the separation resolve is
    // skipped this tick (bail-open, same convention as the stride gate).
    // Resolved unconditionally so the arm stays reachable with the flag off
    // and the eval counter keeps climbing.
    const _sepPlayerPose = this._localPlayerWorldPose();
    // Advance the frame counter the separation table's retry cadence reads.
    // `_smoothFrame` is otherwise only advanced when a smoothing stride is
    // configured (default: never), which would freeze the retry clock at 0
    // and pin the table to its very first read — so bump it here too when the
    // stride is off. Bounded-growth is fine (compared by subtraction).
    if (!_smoothStrideOn) this._smoothFrame = (this._smoothFrame | 0) + 1;
    for (const inst of this.entityMap.values()) {
      // Perf B1 (2026-05-18) — distance + local-player + active-tween
      // gate. When false, skip mixer.update, hook execution, and the
      // jump/swing tween advances entirely. `inst.root.position`,
      // `inst.lastVel`, etc., are written by setPose / setVelocity
      // (not by tick), so skipping the tick body leaves them
      // readable for downstream consumers. Animation snap on
      // re-entry is the documented MVP trade.
      if (!this._shouldTickEntity(inst)) continue;
      // RP2 (2026-06-08) — far-band SMOOTHING-STRIDE decision. `runSmoothing`
      // gates ONLY the position-ease + heading-ease passes below (pure visual
      // smoothing of a re-anchored server target — lag-tolerant, self-
      // correcting). Default true so the stride-off path is byte-identical.
      // When a stride IS configured we run the easing every frame for the
      // local player, any entity inside the near band, and anything with an
      // active jump/swing/cast tween (close / important motion is never
      // throttled); for everything else we run it on frames where
      // `(_smoothFrame - stamp) >= stride`, recording the stamp. A first-time
      // entity (no stamp) runs this frame and stamps. mixer.update / hooks /
      // tweens / particles are NEVER gated by this — they still run every tick.
      let runSmoothing = true;
      if (_smoothStrideOn) {
        const isLocal =
          _smoothLocalGuid !== null && (inst.guid >>> 0) === _smoothLocalGuid;
        const hasActiveTween =
          inst._jumpPoseTween; // (swing/cast tweens retired, WS-B 2026-06-18)
        if (isLocal || hasActiveTween) {
          // Always-smooth set: run every frame and keep the stamp current so a
          // later transition into the throttled set doesn't fire immediately.
          inst._smoothFrameStamp = _smoothFrame;
        } else {
          // Distance test — same world-space + bail-open convention as the
          // gate. No resolvable camera/position → treat as near (run every
          // frame). Beyond the near band → apply the stride.
          let nearOrUnknown = true;
          if (_smoothCamera && _smoothCamera.position && inst.root) {
            if (typeof inst.root.getWorldPosition === "function") {
              inst.root.getWorldPosition(_smoothDistScratch);
            } else if (inst.root.position) {
              _smoothDistScratch.set(
                inst.root.position.x,
                inst.root.position.y,
                inst.root.position.z
              );
            } else {
              _smoothDistScratch.copy(_smoothCamera.position); // dist 0 → near
            }
            const sdx = _smoothDistScratch.x - _smoothCamera.position.x;
            const sdy = _smoothDistScratch.y - _smoothCamera.position.y;
            const sdz = _smoothDistScratch.z - _smoothCamera.position.z;
            const sDistSq = sdx * sdx + sdy * sdy + sdz * sdz;
            nearOrUnknown = sDistSq <= ENTITY_SMOOTH_NEAR_DIST_SQ;
          }
          if (nearOrUnknown) {
            inst._smoothFrameStamp = _smoothFrame;
          } else {
            const stamp = inst._smoothFrameStamp;
            if (stamp === undefined || _smoothFrame - stamp >= ENTITY_SMOOTH_STRIDE) {
              inst._smoothFrameStamp = _smoothFrame;
            } else {
              runSmoothing = false;
            }
          }
        }
      }
      // === Wave R3.B (2026-05-29) — transparent-part depth sort. Runs AFTER
      // the gate (distant entities skip, like every other per-frame body) and
      // AFTER mixer/tween updates further below would move part frames — but
      // it reads the CURRENT frame's world transforms, which is fine: the
      // ordering is recomputed every frame, so a one-frame lag is invisible.
      // Self-gates to entities with > 1 transparent part; a no-op (one truthy
      // check) for everything else. Whole block dead when the flag is off
      // (camera is null → the call is never reached via the truthy guard).
      if (_sortCenterCamera) {
        try {
          this._tickSortCenters(inst, _sortCenterCamera);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._sortCenterTickWarned) {
            this._sortCenterTickWarned = true;
            console.warn(
              `[entities/R3.B] sort-center tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // === COL-20 / F4 — turn-phase gate release. While `_turnGateCmd` holds,
      // `setMotion` swapped the queued run/walk for the turn-in-place cycle;
      // start the queued locomotion the frame the facing error crosses under
      // retail's 20 degree while-moving tolerance (`HandleMoveToPosition`
      // acclient.c:345636). The deadline is the unreachable-target valve only
      // (MOVETO_TURN_GATE_MAX_S) — a real sweep always wins the angle test
      // first. One falsy check per entity when no gate is armed.
      if (inst._turnGateCmd) {
        if (
          this._headingErrorRad(inst) <= MOVETO_FACING_TOLERANCE_RAD ||
          _entityNowMs() >= inst._turnGateUntilMs
        ) {
          const queuedCmd = inst._turnGateCmd >>> 0;
          const queuedStance = inst._turnGateStance >>> 0;
          const queuedSpeed = inst._turnGateSpeed;
          // Clear BEFORE the re-entry so the gate cannot re-arm itself.
          inst._turnGateCmd = 0;
          this.setMotion(inst.guid >>> 0, queuedCmd, queuedStance, queuedSpeed);
        }
      }
      // === Wave R3.A (2026-05-28) — remote-entity motion smoothing.
      // Critically-damp the rendered position toward the latest server-
      // authoritative target stashed by `setPose`. Frame-rate independent:
      // factor = 1 - exp(-k·dt). Runs BEFORE the velocity-scale EMA below so
      // the anti-ice-skating gait reads the (smoothed) motion that's actually
      // rendered. Gated on (a) the flag and (b) an active target — so when
      // `?deadReckon` is absent NO target is ever stored and this whole block
      // is a single truthy check then skip (byte-identical to pre-R3.A). The
      // teleport snap + local-player exclusion both live in `setPose`; by the
      // time a target exists here it's already a remote entity that should
      // glide. Jump/swing/cast/scale tweens move root.quaternion + scale (NOT
      // position) for remote entities, so easing position never fights them.
      // RP2: `runSmoothing` short-circuits this block on throttled far-band
      // frames (default true → no change). The target is re-anchored every
      // setPose, so a skipped frame is recovered on the next run with no drift
      // — the documented far-band visual-lag trade. mixer/hooks are untouched.
      // F3-1b (bughunt 2026-06-27) — ballistic projectile integration MOVED OUT
      // of this gated, dt-driven loop into `_tickBallisticProjectiles()`, which
      // runs every tick on a WALL-CLOCK dt BEFORE the `dt<=0` recovery early-
      // return at the top of tick(). Integrating here keyed off the main-loop
      // `dt`, which the dt-recovery window (index.js:1763-1776) forces to 0 for
      // ~10 frames after ANY >0.5 s frame stall. The first cast of a spell
      // stalls that long synchronously loading its particle DATs + cloning per-
      // slot materials (the cast-time hitch), so the projectile's whole sub-
      // second flight landed inside the dt=0 freeze: it sat frozen at the launch
      // point while only the impact VFX (a non-sim-gated burst) played near the
      // target — the reported "I see the end but not the bolt travelling". The
      // wall-clock pass is also retail-faithful: acclient.c update_object
      // integrates by real elapsed quantum, substepped, not by a render dt.
      // F3-4 (bughunt 2026-06-09) — sticky melee tracking. While a monster is
      // sticky-attacking, ACE withholds its position broadcast (relying on the
      // retail client's StickyManager to glue it to the moving target), so our
      // dead-reckon ease — which only chases the stale last KIND_POSITION —
      // left the mob frozen where it first reached the player while its attacks
      // kept landing. Pin the mob toward the target's LIVE position each frame,
      // keeping a horizontal melee standoff so it sits at contact range rather
      // than inside the target. Runs independent of `?deadReckon`/`runSmoothing`
      // (this is gameplay tracking, not visual smoothing) and OWNS the position,
      // so the dead-reckon ease below is skipped for a sticky entity. Cleared by
      // setStickyTarget(0) on a fresh non-sticky command or a resumed position
      // broadcast. Facing-toward-target is a documented follow-on (the mob keeps
      // its last chase facing, already roughly toward the player).
      // A2-P2 (`?remoteInterp=on`): drain the wasm-ownership countdown each
      // frame. While > 0 the dead-reckon ease + velocity extrapolation below
      // are skipped — the Rust PositionManager wrote root.position directly
      // (applyManagedPose) and easing toward the stale _serverTargetPos would
      // fight it. Fresh rows re-arm the countdown; an idle manager lets it
      // drain (~0.5 s) and the legacy ease resumes from the re-anchored
      // target. Inert (0 | 0 = 0) unless applyManagedPose ever armed it.
      const wasmDriven = (inst._wasmDriven | 0) > 0;
      if (wasmDriven) inst._wasmDriven -= 1;
      let stickyGlued = false;
      if (inst._stickyTarget) {
        const tgtInst = this.entityMap.get(inst._stickyTarget >>> 0);
        if (tgtInst && tgtInst !== inst && tgtInst.root) {
          const tp = tgtInst.root.position;
          const p = inst.root.position;
          const dx = p.x - tp.x;
          const dy = p.y - tp.y;
          const dh = Math.hypot(dx, dy);
          // Standoff along the current mob→target horizontal vector; if the mob
          // is right on top of the target (dh≈0) keep its current bearing.
          const ux = dh > 1e-3 ? dx / dh : 1;
          const uy = dh > 1e-3 ? dy / dh : 0;
          // CREATURE-SEPARATION (2026-07-28): size the glue standoff from the
          // PAIR's real contact envelope instead of the flat 1.3 m, which was
          // wrong in both directions (a Tusker Guard blocks at 1.476, a
          // half-scale Shadow Child at 0.720). Only meaningful when the target
          // IS the local player — the floor is computed against the player's
          // radius — so a mob-on-mob stick keeps the legacy constant. Falls
          // back to the constant whenever the floor cannot be sized.
          let standoff = ENTITY_STICKY_STANDOFF_M;
          if (
            this._creatureSeparationOn &&
            this._isLocalPlayerGuid(inst._stickyTarget >>> 0)
          ) {
            const f = this._separationFloor(inst);
            if (f > 0) standoff = f;
          }
          const gx = tp.x + ux * standoff;
          const gy = tp.y + uy * standoff;
          // F3-4b (?stickyGroundZ=on): a monster can't follow/attack an airborne
          // victim. If the target jumped out of vertical melee reach, RELEASE the
          // glue (stickyGlued stays false → the dead-reckon ease below resumes
          // from the server's grounded pose; the mob circles beneath, attacking
          // but unable to land it). Otherwise glue XY only and leave Z to the
          // mob's own ground (retail StickyManager zeroes the follow Z,
          // acclient.c:388557). Flag off = legacy (ease Z to the target's Z).
          const targetAirborne =
            STICKY_GROUND_Z &&
            (tgtInst._isAirborne === true ||
              Math.abs(tp.z - p.z) > STICKY_AIRBORNE_RELEASE_M);
          if (!targetAirborne) {
            const factor = 1 - Math.exp(-DEAD_RECKON_DAMP_K * dt);
            p.x += (gx - p.x) * factor;
            p.y += (gy - p.y) * factor;
            if (!STICKY_GROUND_Z) {
              const gz = tp.z; // legacy: match the target's height
              p.z += (gz - p.z) * factor;
            }
            stickyGlued = true;
          }
        }
      }
      // `!inst._ballistic`/`!stickyGlued` defense-in-depth: a ballistic
      // projectile and a sticky-glued mob own their own motion above and must
      // never also be dragged by the dead-reckon ease (ACE sends no position
      // for either, so _serverTargetPos is normally absent/stale anyway).
      // HELD-ITEM (2026-08-02, `?wieldPersist`): `!inst._attachedParentGuid`
      // is the same defense-in-depth as `!inst._ballistic` / `!stickyGlued`
      // above — retail never integrates a parented object at all
      // (`CPhysicsObj::update_position` acclient.c:321671 opens with
      // `if (!this->parent)`), and easing a hand-local root toward a WORLD
      // target walks the weapon out of the hand. `setPose`/`attachChildToParent`
      // already null the target, so this is belt-and-braces.
      if (runSmoothing && this._deadReckonOn && inst._serverTargetPos && !inst._ballistic && !stickyGlued && !wasmDriven && !inst._deadFrozen && !(WIELD_PERSIST_ON && inst._attachedParentGuid != null)) {
        const tgt = inst._serverTargetPos;
        // B5/QW2/REMOTE-3: extrapolate the server target forward by the last
        // VectorUpdate velocity while it's fresh — retail integrates
        // set_velocity between the few-Hz position packets (acclient.c:143476)
        // instead of holding the last discrete pose. Same AC-world frame as
        // tgt (loop.js sets both from lbX*192+x), so add directly. Each new
        // KIND_POSITION overwrites _serverTargetPos in setPose (snap-correct),
        // and the staleness gate stops a stopped entity from overshooting.
        const lv = inst.lastVel;
        if (
          lv &&
          inst.lastVelMs !== undefined &&
          (typeof performance !== "undefined" ? performance.now() : 0) -
            inst.lastVelMs <
            ENTITY_VELOCITY_STALE_MS
        ) {
          tgt.x += lv.vx * dt;
          tgt.y += lv.vy * dt;
          tgt.z += lv.vz * dt;
        }
        const pos = inst.root.position;
        const factor = 1 - Math.exp(-DEAD_RECKON_DAMP_K * dt);
        pos.x += (tgt.x - pos.x) * factor;
        pos.y += (tgt.y - pos.y) * factor;
        pos.z += (tgt.z - pos.z) * factor;
      }
      // === CREATURE-SEPARATION (2026-07-28, `?creatureSeparation=off`) ===
      // Runs AFTER every lane that writes `root.position` this frame (the
      // F3-4 sticky glue, the dead-reckon ease, and any wasm-managed pose
      // `applyManagedPose` wrote before the tick) and BEFORE the velScale
      // gait sampler below reads the frame's position delta — so the gait
      // reflects what is actually drawn rather than a pose we then move.
      // Clamps the prediction inward-drift and enforces retail's contact
      // envelope. Skipped for the local player (owns its own prediction and
      // its own swept-circle collision) and for corpses/dead rigs, which are
      // parked by the collapse handoff and must not be shoved.
      // `_separationFloor` bumps the UNCONDITIONAL eval counter, so keep this
      // call outside the flag gate (the gate is inside).
      if (
        _sepPlayerPose &&
        !inst._deadFrozen &&
        inst.root &&
        !this._isLocalPlayerGuid(inst.guid >>> 0)
      ) {
        this._applyCreatureSeparation(inst, _sepPlayerPose);
      }
      // === A2 Path A (2026-05-29) — remote-entity HEADING ease. Exponentially
      // slerp the rendered quaternion toward the server target stashed by
      // setPose (same frame-rate-independent damp shape as the position ease
      // above). Whole block dead unless heading easing armed a target for this
      // entity (`_headingEaseInit`), so when `?headingSnap=on` / local player /
      // Node, no target is stored and this is a single falsy check then skip
      // (byte-identical to pre-Path-A). Re-checks the omega/jump gate so a
      // SetOmega or jump that started since the last setPose takes the wheel
      // this frame instead of being fought; the discontinuity snap lives in
      // setPose. Runs after the position ease + before mixer.update so the
      // velocity-scale gait reads the heading actually rendered.
      // RP2: `runSmoothing` short-circuits the slerp on throttled far-band
      // frames (default true → no change). Same self-correcting re-anchor
      // argument as the position ease above.
      if (
        runSmoothing &&
        inst._headingEaseInit &&
        inst._serverTargetQuat &&
        !inst._omega &&
        !inst._cycleOmega &&
        !inst._isAirborne &&
        !inst.airborneTilt
      ) {
        const q = inst.root.quaternion;
        const tgtQ = inst._serverTargetQuat;
        const ang = q.angleTo(tgtQ);
        if (ang > HEADING_EASE_EPSILON) {
          let frac = 1 - Math.exp(-this._headingEaseK * dt);
          // G-5 (?turnOmega=on): cap this frame's sweep at the retail turn
          // rate for turn-directive targets (cap unset/0 → unchanged ease).
          if (inst._turnOmegaCapRad > 0) {
            const maxFrac = (inst._turnOmegaCapRad * dt) / ang;
            if (maxFrac < frac) frac = maxFrac;
          }
          q.slerp(tgtQ, frac);
        } else if (ang > 0) {
          q.copy(tgtQ); // settle within epsilon — stop micro-slerping
          if (inst._turnOmegaCapRad) inst._turnOmegaCapRad = 0; // turn done
        }
      }
      // T11 — velocity-scaled locomotion playback (anti-ice-skating). Derive
      // an EMA-smoothed ground speed from the rig's horizontal (XZ) world-
      // position delta this frame — the fallback 'actual' speed
      // `_unifiedLocoGaitScale` uses when the wasm stateGroundSpeed getter has
      // nothing. Sampled BEFORE the playhead advance below so the rate applies
      // this frame. ?velScale (default on).
      if (VEL_SCALE_ON) {
        const p = inst.root.position;
        // RP2 (2026-06-08) — EMA-sampler / smoothing-stride interaction guard.
        // The EMA derives ground speed from the per-frame XZ delta of
        // `inst.root.position`, but for remote entities that position is moved
        // ONLY by the dead-reckon position-ease above (7437), which is gated by
        // `runSmoothing`. On a throttled far-band frame (`_smoothStrideOn &&
        // !runSmoothing`) the ease is skipped, so the position is FROZEN this
        // frame: sampling it would fold a spurious ~0 delta into the EMA (and
        // then a full-gap spike on the next run frame), staircasing the EMA
        // toward zero and re-introducing the ice-skating gait that velScale
        // exists to remove. So we accumulate `dt` across skipped frames and
        // sample/fold ONLY on frames where the position was actually integrated,
        // dividing the delta by the full elapsed interval since the last sample
        // (correct m/s magnitude over a multi-frame gap). `_velPrevX/Z` is held
        // (not advanced) on skipped frames so the next sample spans the real
        // motion interval. The held EMA value persists across skipped frames.
        //
        // Default path: `_smoothStrideOn` false → `runSmoothing` is never set
        // false (it starts true and is only cleared inside the stride block at
        // 7355) → `_velSample` always true and `_velAccumDt` is always exactly
        // the current-frame `dt`, so this collapses to the exact prior code
        // (fold every frame, divide by `dt`) — byte-identical with flags off.
        const _velSample = runSmoothing;
        inst._velAccumDt = (inst._velAccumDt || 0) + dt;
        if (_velSample) {
          if (inst._velPrevX !== undefined && inst._velAccumDt > 0) {
            const dx = p.x - inst._velPrevX;
            const dz = p.z - inst._velPrevZ;
            const sp = Math.hypot(dx, dz) / inst._velAccumDt;
            inst._emaSpeed =
              inst._emaSpeed === undefined ? sp : inst._emaSpeed * 0.7 + sp * 0.3;
          }
          inst._velPrevX = p.x;
          inst._velPrevZ = p.z;
          inst._velAccumDt = 0;
        }
        // The gait itself (actual / authored ground speed × server
        // motionSpeed × direction) is applied to the playhead's advance in
        // `_unifiedLocoGaitScale`, which reads this EMA as its fallback.
      }
      try {
        if (inst._unifiedSeq) {
          // A one-shot Rust MotionSequence owns the rig (full-body, no blend) —
          // SUPPRESS _unifiedLoco (single playhead). attack
          // (clearOnDone:true) hands back on completion → the tick then falls to
          // _unifiedLoco below (locomotion resumes); death (clearOnDone:false)
          // holds the clamped prone frame.
          const ua = inst._unifiedSeq;
          // Retail scales the node framerate by the motion speed
          // (AnimSequenceNode::multiply_framerate, acclient.c:340977). `ua.speed`
          // is that multiplier, captured when the one-shot was built. The `?? 1`
          // keeps any older record (or a rebuilt-mid-flight one) at 1.0x rather
          // than NaN-ing the playhead.
          ua.seq.advance(dt * (ua.speed ?? 1));
          poseRigAt(ua.seq.globalFrameIndex, ua.desc, inst.parts, ua.inPlace === true);
          this._drainUnifiedHooks(inst, ua); // swoosh / chime / strike (Step 6)
          if (ua.rootMotion) this._applyUnifiedRootMotionIfDone(inst, ua);
          if (ua.seq.done && ua.clearOnDone) {
            try { ua.seq.free(); } catch (_) { /* already freed */ }
            inst._unifiedSeq = null;
            // J5: retire it from pending_animations and promote the next
            // queued gesture onto the SAME playhead (retail AnimationDone).
            this._unifiedOneShotFinished(inst, ua);
          }
        } else if (inst._unifiedLoco) {
          // The cyclic locomotion sequence, with gait scaling (anti-ice-skating
          // velScale × server motionSpeed × direction) applied by advancing the
          // playhead faster/slower. Rust phase carry makes swaps seamless.
          const lo = inst._unifiedLoco;
          const step = dt * this._unifiedLocoGaitScale(inst, this._cycleBaseSpeedCache.get(lo.cacheKey) ?? 0);
          if (step >= 0) {
            lo.seq.advance(step);
            // A held door/chest state cycle is a static pose, so it is posed
            // raw. In place is for locomotion strides only (see
            // _playStateHoldLink).
            poseRigAt(lo.seq.globalFrameIndex, lo.desc, inst.parts, lo.hold !== true);
            this._drainUnifiedHooks(inst, lo); // footfalls (wrap-aware)
          } else {
            // 2026-10-05: advance() ignores dt<=0 (motion_sequence.rs
            // advance_impl), so a backstep/left-strafe (negative speed) froze
            // the cycle. Retail runs it backwards (CSequence::update_internal,
            // acclient.c:340659) — step the phase back and seek.
            const dur = +lo.desc.duration || 0;
            if (dur > 0) {
              let p = lo.seq.phase + step / dur;
              p -= Math.floor(p);
              lo.seq.seekPhase(p);
            }
            poseRigAt(lo.seq.globalFrameIndex, lo.desc, inst.parts, true);
            lo.lastHookTime = -1; // no reverse footfall spam
          }
        }
        // Neither → no animation resolved for this entity (rest pose).
      } catch (e) {
        // Don't let one bad sequence kill the whole tick.
        // eslint-disable-next-line no-console
        if (!this._playheadWarned) {
          this._playheadWarned = true;
          console.warn("[entities] motion playhead advance threw:", e);
        }
      }
      // Bug 19: a lost touchdown must not leave a rig in Falling forever.
      if (
        inst._isAirborne && inst._airborneSinceMs &&
        performance.now() - inst._airborneSinceMs > MAX_AIRBORNE_MS
      ) {
        inst._isAirborne = false;
        this._hitGround(inst, "stuck-airborne timeout");
      }
      // Wave 1.7 (2026-05-26) — Jump-pose tween advance. Runs AFTER
      // the playhead pose so our per-part slerp wins on the locked-out
      // arm/leg quaternions for the duration of the airborne tween.
      // No-op when no tween is active.
      if (inst._jumpPoseTween) {
        try {
          this._tickJumpPoseTween(inst, this._tweenNowMs());
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._jumpTweenWarned) {
            this._jumpTweenWarned = true;
            console.warn(
              `[entities/jump-tween] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // Phase 2 limbs (2026-08-02, `?limbDamage=on`) — POST-EVALUATION limp
      // offset. Runs after EVERY rig writer above (mixer.update /
      // poseRigAt for both unified paths, and the jump-pose tween) so the
      // offset lands on top of the resolved pose instead of being stomped by
      // it. `applyLimbLimp` bails on its first line when the flag is off and on
      // its second when the entity carries no damage, so the default path is a
      // single boolean read + one null check per entity per frame — and the
      // rendered rig is byte-identical.
      if (LIMB_DAMAGE_ON && inst._limbDamage && inst._limbDamage.size > 0) {
        try {
          applyLimbLimp(inst, dt);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._limbLimpWarned) {
            this._limbLimpWarned = true;
            console.warn(
              `[entities/limbs] limp tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // Phase 4 ragdoll (`?ragdoll=on`) — LAST rig writer of the frame: the
      // dying creature's sim (or a corpse's frozen transferred pose)
      // overwrites everything above, including the limp. Gate is a hoisted
      // boolean + two null reads on the default path. A throw disarms the
      // ragdoll so a broken sim degrades to the authored collapse.
      if (RAGDOLL_ON && (inst._ragdoll || inst._ragdollFrozenPose || inst._ragdollPendingPose)) {
        try {
          if (inst._ragdollPendingPose) promotePendingPose(inst);
          if (inst._ragdoll) applyRagdoll(inst, dt);
          else applyFrozenPose(inst);
        } catch (e) {
          if (!this._ragdollTickWarned) {
            this._ragdollTickWarned = true;
            // eslint-disable-next-line no-console
            console.warn(
              `[entities/ragdoll] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
          inst._ragdoll = null;
          inst._ragdollFrozenPose = null;
        }
      }
      // Swing-pose / cast-pose tween ticks RETIRED 2026-06-18 (WS-B teardown)
      // along with setSwingPose/setCastPose + _tickSwingTween/_tickCastTween.
      // (Jump-pose tween above + scale-hook tween below are KEPT.)
      // Wave 3 (2026-05-28) — Scale hook tween. Ticks after the
      // mixer + jump/swing/cast tweens so the scaled-object value wins
      // for the tween duration. Per-tween guard (gated on
      // `inst._scaleHookTween`) so non-scaling entities pay zero cost.
      if (inst._scaleHookTween) {
        try {
          this._tickScaleHookTween(inst, this._tweenNowMs());
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._scaleHookTweenWarned) {
            this._scaleHookTweenWarned = true;
            console.warn(
              `[entities/scale-hook] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // Wave 3 (2026-05-28) — SetOmega continuous angular velocity.
      // Persistent state, not a tween — applies `omega * dt` to the
      // root quaternion each frame until a SetOmega(0,0,0) clears it.
      if (inst._omega || inst._cycleOmega) {
        try {
          this._tickHookOmega(inst, dt);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._omegaTickWarned) {
            this._omegaTickWarned = true;
            console.warn(
              `[entities/omega-hook] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // Wave 6 (2026-05-28) — material ramp tweens + UV scroll.
      // Gated on either material tweens being active OR any cloned
      // material carrying a __hookTexVel tag. The check is one
      // truthy-Map read on the fast path; entities with no material
      // hooks pay zero per-frame cost.
      if (
        (inst._materialHookTweens && inst._materialHookTweens.length > 0) ||
        (inst._entityMaterials && inst._entityMaterials.size > 0)
      ) {
        try {
          this._tickMaterialHooks(inst, dt, performance.now());
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._materialHookTickWarned) {
            this._materialHookTickWarned = true;
            console.warn(
              `[entities/material-hook] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // A5-P1b (?hookDrain=on) — the per-instance hook-fire DRAIN: execute
      // every queued hook + completion record in FIFO order, AFTER all
      // pose/position/tween/omega/material application above — our analog
      // of retail's process_hooks-after-position-resolve
      // (CPhysicsObj::UpdatePositionInternal: offset combine → physics
      // resolve → ONLY THEN process_hooks drains the queue in order,
      // acclient.c:320030-320035). A thrown hook must not drop the rest
      // of the queue (per-record try/catch). Off-path: queue is never
      // written, this is one length check.
      if (HOOK_DRAIN_ON && inst._hookFireQueue && inst._hookFireQueue.length > 0) {
        const fireQueue = inst._hookFireQueue;
        inst._hookFireQueue = [];
        const _audioMgr = this.scene3d?.audioManager ?? null;
        const _stCache = this.scene3d?.soundTableCache ?? null;
        for (const rec of fireQueue) {
          try {
            if (rec.kind === "hook") {
              this._fireHook(inst, rec.hook, _audioMgr, _stCache);
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            if (!this._hookDrainWarned) {
              this._hookDrainWarned = true;
              console.warn(
                `[entities/hook-drain] record failed for entity 0x${inst.guid.toString(16)}:`,
                e
              );
            }
          }
        }
      }
      // IDLE_FIDGET (2026-06-09, ?idleFidget=on) — autonomous client-side idle
      // fidget. Accumulate per-entity standing-idle dwell time and, once it
      // crosses a per-entity randomized interval, trigger ONE idle-variation
      // overlay. Whole block dead when the flag is off (one truthy check then
      // skip — byte-identical to pre-feature). `_idleFidgetTick` does the cheap
      // dwell bookkeeping every frame and only does the (throttled, async)
      // MT-probe + play when an interval elapses; it cancels/resets the dwell
      // the instant the entity is no longer plainly standing idle, so it never
      // fights server prediction or an incoming clip.
      if (IDLE_FIDGET_ON) {
        try {
          this._idleFidgetTick(inst, dt);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._idleFidgetTickWarned) {
            this._idleFidgetTickWarned = true;
            console.warn(
              `[entities/idle-fidget] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
    }
    // === MOVER-SIDE RESOLUTION (2026-08-04, `?playerDepenetrate=on`) ===
    // Retail's rule, applied the retail way round: when an overlap cannot be
    // resolved by moving the TARGET (its position is the server's — see the
    // IMMOVABLE-ENTITIES block), it must be resolved by moving the MOVER
    // (`CPhysicsObj::handle_all_collisions` acclient.c:321808 acts only on
    // `this`). `_applyCreatureSeparation` records the correction each rejected
    // push would have needed; here it is applied to the LOCAL PLAYER's rendered
    // rig instead of to the entity.
    //
    // DEFAULT-OFF and deliberately a BACKSTOP, not the primary fix: the primary
    // fix is that the SIM stops the mover before the overlap exists (the COL-03
    // `gfx_id` repair + the sim/render radius parity work in
    // `WorldState::entity_physics_bsp` / `entity_collision_radius`). What the
    // sim structurally cannot see is an entity RENDERED away from its wire pose
    // (dead-reckon lead / sticky glue — CREATURE-SEPARATION measured 1.019 m of
    // it), and that residual is what this covers.
    //
    // RENDER-ONLY and NON-ACCUMULATING: it writes the avatar rig's transform,
    // never the wasm integrator pose or `predictedPlayerPos`, and it is
    // recomputed from scratch every tick (never added to itself), so it cannot
    // drift or fight the integrator across frames — the dual-predictor failure
    // mode this codebase keeps re-learning. Capped at
    // `PLAYER_DEPENETRATE_MAX_M` so a bad radius can never fling the avatar.
    if (this._playerDepenetrateOn) {
      const dep = this._pendingPlayerDepen;
      if (dep && (dep.x !== 0 || dep.y !== 0)) {
        try {
          const lpg = typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function"
            ? window.getLocalPlayerGuid()
            : null;
          const li = lpg != null ? this.entityMap.get(lpg >>> 0) : null;
          if (li && li.root) {
            const mag = Math.hypot(dep.x, dep.y);
            const s = mag > PLAYER_DEPENETRATE_MAX_M ? PLAYER_DEPENETRATE_MAX_M / mag : 1;
            li.root.position.x += dep.x * s;
            li.root.position.y += dep.y * s;
            this._sepStats.moverResolved++;
          }
        } catch (_) { /* pre-spawn / no local rig — nothing to resolve */ }
      }
      this._pendingPlayerDepen = null;
    }
    // T9 (2026-05-28) — dynamic-LOD recheck (throttled). Re-queries each
    // entity's degrade band at the live camera distance and respawns it when
    // it crosses a band. Gated by ?dynLod=on.
    if (DYN_LOD_ON) {
      this._dynLodAccum += dt;
      if (this._dynLodAccum >= DYN_LOD_INTERVAL_S) {
        this._dynLodAccum = 0;
        this._tickDynamicLod();
      }
    }
    // ?partDegrade (2026-10-06, opt-in `=on`) — retail per-part degrade pick: a
    // part whose GfxObjDegradeInfo pick lands on a NULL level is not drawn (human
    // body parts beyond 134 m). The player's own parts never degrade.
    if (this._partDegrade) {
      this._partDegradeAccum += dt;
      if (this._partDegradeAccum >= PART_DEGRADE_INTERVAL_S) {
        this._partDegradeAccum = 0;
        const cam = (typeof window !== "undefined") ? window.liveScene3d?.camera : null;
        if (cam && cam.matrixWorld) {
          const ce = cam.matrixWorld.elements;
          _pdCam.x = ce[12]; _pdCam.y = ce[13]; _pdCam.z = ce[14];
          try { this._partDegrade.tick(this.entityMap.values(), _pdCam, this._localPlayerGuid()); } catch (_) {}
        }
      }
    }
    // A8-M4 (2026-06-12, `?preCreateBuffer=on`) — retail 25 s pre-create
    // expiry (acclient.c:310666; the timer is refreshed on every enqueue,
    // QueueBlobForObject → AddObjectToBeDestroyed remove+re-add). Whole
    // buckets expire together, like retail destroying the placeholder with
    // its queued blobs. Rate-limited to once/second (same pattern as the
    // locomotion prune above); Date.now() domain to match the buffer's
    // enqueue stamps. Flag off / empty buffer → size()===0, zero cost.
    if (this._preCreateBufferOn && this._preCreate.size() > 0) {
      const sweepNow = Date.now();
      if (sweepNow - this._preCreateLastSweepMs > 1000) {
        this._preCreateLastSweepMs = sweepNow;
        this._preCreate.expire(sweepNow);
      }
    }
    // A11-S3 (`?particleClock=off|loop|sim`): when "off" (default), the
    // particle/script manager phase runs here at the legacy point — the
    // tail of tick(dt) — preserving the byte-identical call graph. When
    // "loop"/"sim", tickPerFrame's dedicated manager phase (scene3d/loop.js)
    // calls `tickParticlesAndScripts()` instead, at the retail point in
    // frame (after pose application; acclient.c:322883-322892).
    if (particleClockMode() === "off") this.tickParticlesAndScripts();
  }

  /** A11-S3: retail manager phase — ParticleManager::UpdateParticles then
   *  ScriptManager::UpdateScripts (acclient.c:322887-322892 order). Called
   *  from tick(dt) when ?particleClock=off (legacy point), or from
   *  tickPerFrame's particle phase when =loop|sim. NEVER RP3-gated (retail
   *  updates managers even for inactive objects, acclient.c:322886). */
  tickParticlesAndScripts() {
    // H2 (2026-05-12): advance the world-side particle runtime. The
    // ParticleManager is lazily created on the first attach; tick is
    // a no-op when null.
    if (this._worldParticleManager) {
      try {
        this._worldParticleManager.tick();
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!this._particleTickWarned) {
          this._particleTickWarned = true;
          console.warn("[entities/H2] worldParticleManager.tick threw:", e);
        }
      }
    }
    // A11-S1: advance the per-entity PhysicsScript queues on the SAME clock
    // as the rest of the tick (no private setTimeout). Only populated when
    // `?scriptQueue=on`; the map is empty (zero cost) on the off-path. An
    // idle (drained) manager left in the map is cheap; it is removed on
    // entity despawn. `update()` reads `currentTime()` from time_rng.js.
    if (this._scriptManagersForGuid.size > 0) {
      for (const mgr of this._scriptManagersForGuid.values()) {
        try {
          if (mgr.active) mgr.update();
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._scriptQueueTickWarned) {
            this._scriptQueueTickWarned = true;
            console.warn("[entities/A11-S1] scriptManager.update threw:", e);
          }
        }
      }
    }
  }

  /**
   * IDLE_FIDGET (2026-06-09, ?idleFidget=on) — per-entity idle-fidget timer.
   *
   * **Problem.** Every standing creature/NPC/player is frozen in one looping
   * Ready idle. Retail's client played autonomous idle variations / fidget
   * gestures so a standing entity wasn't perfectly static — the single most-
   * noticeable non-retail tell.
   *
   * **What this does.** Each entity accumulates `_idleDwellS` while it is in a
   * PLAIN STANDING IDLE: on the Ready/idle cycle (or never-moved-since-spawn),
   * |velocity| ~0 (both the velScale gait EMA AND the last server VectorUpdate
   * under `IDLE_FIDGET_SPEED_EPS`, or stale), and with NO action overlay
   * playing (no jump/swing/cast tween, no fidget already in flight). The
   * instant ANY of those is false — a locomotion command, an incoming swing/
   * cast clip, a tween, a non-idle motion — the dwell RESETS to 0 (the fidget
   * yields immediately to real server motion/prediction; it never fights it).
   *
   * When the dwell crosses the entity's randomized target (`_idleFidgetNextS`,
   * re-rolled in [MIN, MAX] each fire), it kicks ONE idle-variation overlay via
   * `_fireIdleFidget` and resets the dwell + re-rolls the next interval.
   *
   * **Cost.** No per-frame allocation. The dwell add + gate is a handful of
   * field reads per ticked entity; the (async) MT-probe + play happens at most
   * once per ~6-15 s per entity, throttled so the manager-wide bookkeeping only
   * re-evaluates the heavier gate every `IDLE_FIDGET_CHECK_INTERVAL_MS`.
   *
   * **Data-source note.** There is NO wasm getter to ENUMERATE the idle/fidget
   * motions a MotionTable contains (the only MT-introspection export is
   * `lookupMotionLinkForSwing(mtId, stance, cmd)`, which probes ONE command).
   * So `_fireIdleFidget` PROBES a randomly-chosen ChatEmote idle-variation
   * command with that getter and plays it only when a real link clip exists —
   * correct, not guessed; an MT lacking the clip is skipped. The play path is
   * the existing `_tryPlayLink` LoopOnce overlay, which already no-ops
   * gracefully on a missing clip.
   * @private
   */
  _idleFidgetTick(inst, dt) {
    // (1) Reset the dwell the instant the entity is not plainly standing idle.
    //     An action overlay (jump / swing / cast tween) or an in-flight fidget
    //     means a clip is already playing — never stack a fidget on top, and
    //     never fight an incoming server clip.
    if (
      inst._jumpPoseTween ||
      inst._idleFidgetActive
    ) {
      inst._idleDwellS = 0;
      return;
    }
    // (2) Must be on the Ready/idle cycle. `lastMotionCommand` is the last
    //     non-stop command setMotion played (sticky across STOP). "idle" ==
    //     Ready; undefined/0 == spawned idle and never moved. Anything else
    //     (walk / run / attack / cast / a held stationary pose) disqualifies.
    const lastCmd = (inst.lastMotionCommand ?? 0) >>> 0;
    const onIdle =
      lastCmd === 0 || classifyMotionCommand(lastCmd) === "idle";
    if (!onIdle) {
      inst._idleDwellS = 0;
      return;
    }
    // (3) |velocity| ~0. The velScale EMA gait speed (when present) AND the
    //     last server VectorUpdate must both be under the epsilon. A stale
    //     VectorUpdate (older than the dead-reckon staleness window) counts as
    //     stopped — a standing entity stops getting velocity packets.
    const emaSpeed = inst._emaSpeed ?? 0;
    if (emaSpeed > IDLE_FIDGET_SPEED_EPS) {
      inst._idleDwellS = 0;
      return;
    }
    const lv = inst.lastVel;
    if (lv && inst.lastVelMs !== undefined) {
      const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
      if (nowMs - inst.lastVelMs < ENTITY_VELOCITY_STALE_MS) {
        const vMag = Math.hypot(lv.vx ?? 0, lv.vy ?? 0, lv.vz ?? 0);
        if (vMag > IDLE_FIDGET_SPEED_EPS) {
          inst._idleDwellS = 0;
          return;
        }
      }
    }
    // (4) Plainly standing idle — accumulate dwell. Lazily seed the per-entity
    //     randomized fire interval the first time this entity becomes idle.
    if (inst._idleFidgetNextS === undefined) {
      inst._idleFidgetNextS = this._rollIdleFidgetInterval();
    }
    inst._idleDwellS = (inst._idleDwellS || 0) + dt;
    if (inst._idleDwellS < inst._idleFidgetNextS) return;
    // Interval elapsed — fire ONE fidget. Reset the dwell + re-roll the next
    // interval up front so a failed/absent probe still waits a fresh interval
    // (no tight retry loop) and so the dwell doesn't keep re-triggering while
    // the async probe is in flight.
    inst._idleDwellS = 0;
    inst._idleFidgetNextS = this._rollIdleFidgetInterval();
    this._fireIdleFidget(inst);
  }

  /**
   * IDLE_FIDGET — pick a per-entity randomized fire interval in
   * [IDLE_FIDGET_MIN_S, IDLE_FIDGET_MAX_S]. Uses the shared mockable RNG
   * (`timeRng`) so tests are deterministic under `setRng`, matching the rest
   * of scene3d's time-jitter (CallPES delay, particle emission).
   * @private
   */
  _rollIdleFidgetInterval() {
    let r;
    try {
      r = timeRng();
    } catch (_) {
      r = Math.random();
    }
    if (!(r >= 0 && r < 1)) r = 0;
    return IDLE_FIDGET_MIN_S + r * (IDLE_FIDGET_MAX_S - IDLE_FIDGET_MIN_S);
  }

  /**
   * IDLE_FIDGET — probe + play ONE idle-variation fidget for `inst`.
   *
   * Picks a random ChatEmote idle-variation command, PROBES the entity's
   * MotionTable for a real link clip under (stance, Ready) via the wasm
   * `lookupMotionLinkForSwing` getter, and — only when one exists — plays it as
   * a LoopOnce overlay through the existing `_tryPlayLink` path. The probe
   * keeps this CORRECT (it never plays a command the MT lacks); the play path
   * already no-ops gracefully if the clip turns out absent at fetch time.
   *
   * `_idleFidgetActive` guards against stacking (`_idleFidgetTick` resets the
   * dwell while it's set) and is cleared when the LoopOnce overlay's duration
   * elapses (best-effort timer; the clip self-clamps to weight 0 regardless, so
   * a missed clear just defers the next fidget by one interval — never a stuck
   * pose). A real server motion clears it implicitly: setMotion's locomotion /
   * swing / cast paths take over the affected parts, and the next idle dwell
   * re-arms from 0.
   * @private
   */
  _fireIdleFidget(inst) {
    if (typeof window === "undefined") return;
    const sh = window.__sessionHandle;
    if (!sh || typeof sh.lookupMotionLinkForSwing !== "function") {
      // No MT-introspection getter wired (pre-login / offline / Node) — can't
      // verify the clip exists, so skip rather than play a possibly-absent
      // command. The blocked[] note flags the missing enumerate-MT getter.
      return;
    }
    const setupId = (inst.meta?.modelId ?? inst.meta?.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
    if (!mtableId) return; // raw GfxObj setup with no MotionTable — no fidgets.
    const stance =
      (inst.currentStance ?? inst.lastStance ?? inst.meta?.motionStance ?? 0) >>> 0;
    // NOTE: stance may be 0 here (NPCs spawn idle with motionStance 0; only
    // setMotion/setLocalStance set currentStance/lastStance). We pass it
    // through unchanged — both the wasm probe (lookupMotionLinkForSwing →
    // classify_motion_link_for_swing) and the clip fetch (_tryPlayLink →
    // try_resolve_link_frames) resolve stance 0 → default_style, so a
    // never-moved entity probes against its real (e.g. NonCombat) link set.
    // Pick a random fidget command; probe up to a few candidates so an MT that
    // happens to lack the first pick still fidgets (most have a handful of the
    // common gestures). Bounded, cheap — at most IDLE_FIDGET_COMMANDS.length
    // synchronous getter calls, once per ~6-15s per entity.
    const n = IDLE_FIDGET_COMMANDS.length;
    let startR;
    try {
      startR = timeRng();
    } catch (_) {
      startR = Math.random();
    }
    if (!(startR >= 0 && startR < 1)) startR = 0;
    const start = Math.floor(startR * n) % n;
    let cmd = 0;
    for (let i = 0; i < n; i++) {
      const candidate = IDLE_FIDGET_COMMANDS[(start + i) % n] >>> 0;
      let linkAnim = null;
      try {
        linkAnim = sh.lookupMotionLinkForSwing(
          mtableId >>> 0,
          stance >>> 0,
          candidate >>> 0
        );
      } catch (_) {
        // Getter threw (rare) — give up on this fidget cycle.
        return;
      }
      if (linkAnim) {
        cmd = candidate;
        // wasm Option<MotionLinkAnimJs> — free it; we only needed presence.
        try { linkAnim.free?.(); } catch (_) {}
        break;
      }
      try { linkAnim?.free?.(); } catch (_) {}
    }
    if (!cmd) return; // this MT has none of the idle-variation clips — skip.
    // Re-check the entity is still plainly idle (the probe loop is synchronous,
    // but a server motion could have landed via a queued event between the
    // dwell check and here; cheapest re-guard is the overlay-tween set).
    if (inst._jumpPoseTween) return; // (swing/cast tweens retired, WS-B 2026-06-18)
    inst._idleFidgetActive = true;
    // Play the fidget as a LoopOnce overlay on top of the Ready cycle (from =
    // Ready, same as a swing). `_tryPlayLink` is async + fail-soft; a fetch
    // miss just leaves `_idleFidgetActive` set until the clear timer below.
    Promise.resolve()
      .then(() =>
        this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, cmd, stance)
      )
      .catch(() => {});
    // Best-effort clear of the active guard after a generous fidget duration so
    // the entity can fidget again later. The LoopOnce overlay self-clamps to
    // weight 0 when it finishes regardless of this timer; this only re-arms the
    // dwell gate. A real server motion takes over the parts independently.
    if (typeof setTimeout === "function") {
      setTimeout(() => {
        if (this.entityMap.has(inst.guid >>> 0)) {
          inst._idleFidgetActive = false;
        }
      }, IDLE_FIDGET_MAX_S * 1000);
    } else {
      inst._idleFidgetActive = false;
    }
  }

  /**
   * Walk a sorted-by-time hook list and fire those in
   * `(lowExclusive, highInclusive]`. Sound (1) + SoundTable (2)
   * land audio playback; other hook types increment a debug counter
   * so the diag-script can assert the executor reached them.
   *
   * Called by `_drainUnifiedHooks` (the playhead hook drain) — the
   * wrap-around branch reuses it for both halves of a looped range.
   */
  _fireHooksInRange(inst, timeline, lowExclusive, highInclusive, audioMgr, cache) {
    // Binary search would be faster for very long timelines, but
    // retail clips have 0-20 hooks max so linear scan is fine and
    // simpler to verify.
    for (let i = 0; i < timeline.length; i += 1) {
      const h = timeline[i];
      const t = h.time;
      if (t <= lowExclusive) continue;
      if (t > highInclusive) break; // sorted asc — no later entries match
      if (HOOK_DRAIN_ON) {
        // A5-P1b — queue instead of firing inline (retail add_anim_hook,
        // acclient.c:322063-322073); the per-instance end-of-tick drain
        // executes via the SAME `_fireHook`. Only the animation-timeline
        // executor routes here — ScriptManager/PhysicsScript callers
        // invoke `_fireHook` directly and stay inline.
        inst._hookFireQueue.push({ kind: "hook", hook: h });
        continue;
      }
      this._fireHook(inst, h, audioMgr, cache);
    }
  }

  /**
   * Dispatch one hook to the appropriate handler.
   * Sound (1) + SoundTable (2) play audio via the AudioManager;
   * CreateParticle (13) + SoundTweaked (21) + others are debug-counted
   * (Task E scope is Sound + SoundTable; the rest are follow-ons).
   */
  _fireHook(inst, hook, audioMgr, cache) {
    // === A-DIR (render-completeness wave 3, 2026-05-29) — direction gate ===
    // Retail/ACE `Sequence.execute_hooks` fires a hook iff
    // `hook.Direction == Both(0) || hook.Direction == dir`, where `dir` is
    // the segment's PLAYBACK direction (Forward if frametime>0 else Backward;
    // ACE.Server/Physics/Animation/Sequence.cs:262-270). `AnimationHookDir`:
    // Backward=-1, Both=0, Forward=1.
    //
    // Holtburger re-bakes negative-framerate (reverse) segments as
    // FORWARD-ordered keyframes and always advances three.js clips forward,
    // so playback `dir` is always Forward(1). To keep reverse segments
    // retail-correct under that always-forward executor, the Rust baker
    // (web/src/lib.rs build_concatenated_motion_frames) NEGATES each hook's
    // direction on reverse segments (Forward<->Backward, Both unchanged) —
    // Issue B (2026-06-03). After that pre-flip the faithful ACE gate reduces
    // exactly to: fire iff `direction === 0 (Both) || direction === 1
    // (Forward)` — i.e. drop direction === -1 — for BOTH forward and reverse
    // segments. Without this gate the executor fired every hook in the
    // advance window, spuriously triggering the 200 Backward-only hooks
    // (census 2026-05-29: 6419 hooks = 3243 Both / 2976 Forward / 200
    // Backward) — dominated by SoundTable type-2 (wrong/double sounds on
    // reversible props like doors/levers), plus SetMaterial/TextureVelocity.
    //
    // `hook.direction` is baked per-entry in animation.js:604 (`h.direction`,
    // wasm getter web/src/lib.rs:12289). Fail-soft: synthetic hooks
    // (PhysicsScript-sourced, e.g. the SoundTable/Luminous synthesis at
    // ~:5955/:5968) carry no `direction` field → `undefined` → NOT === -1 →
    // they fire (correct; they're not direction-tagged AnimationHooks).
    // DIM3-4 (2026-06-05): retail's AnimHookDir also has UNKNOWN=-2 (a
    // constructor sentinel never serialized to the wire — see the Rust
    // `AnimationHook.direction` doc). This `=== -1` gate is already fail-soft
    // for it: a stray -2 is NOT -1, so it fires (treated as Both/unconditional),
    // which is the correct fallback. The Rust reverse-segment baker also clamps
    // its negation so -2 can never become +2.
    if ((hook.direction | 0) === -1) return;
    const hookType = hook.hookType | 0;
    const pos = inst.root.position;
    // Phase F.C — runtime event log probe. Same no-op stub shape as
    // every other source; reading via the scene3d ref is cheap.
    const pushEventRecord = this.scene3d?._pushEventRecord;
    if (hookType === 1) {
      // Sound — payload is a Wave DID. Play directly.
      const waveId = hook.soundWaveId >>> 0;
      if (waveId === 0 || !audioMgr) return;
      // Position is read at fire-time so the panner pans to the
      // entity's current location (matches PhatSDK retail behaviour
      // — sound positions update with the body during animation).
      if (pushEventRecord) {
        pushEventRecord({
          type: "sound",
          wave_did: waveId,
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            motion_command: (inst.currentActionKey ?? null),
            // stance is folded into currentActionKey; no separate field
            // on EntityInstance (the (cmd, stance) tuple is the cache key).
            hook_type: 1,
            hook_time: +hook.time,
          },
        });
      }
      // D4-NEW-1 (2026-06-05): transform the RAW AC-frame entity position into
      // the three.js frame the AudioContext listener lives in (acToThree
      // (ax,ay,az)→(ax,az,-ay)); otherwise the panner pans a permuted
      // DIRECTION (north→overhead). Distance is preserved. This Sound(1) hook
      // carries no followGuid, so the one-time transform fully corrects it.
      // (D4-NEW-1-verification.md PARTIAL/HIGH; retail acclient.c:383163-383164.)
      const sndT = acToThree(pos.x, pos.y, pos.z);
      audioMgr
        // Retail applies the effect slider twice on SoundHook (acclient.c:342190, 383481, 383092-383095).
        .play(waveId, { x: sndT[0], y: sndT[1], z: sndT[2] }, { sliderTwice: true })
        .catch(() => {});
      this._soundHookFires = (this._soundHookFires | 0) + 1;
      return;
    }
    if (hookType === 2) {
      // SoundTable — payload is a Sound enum. Resolve via the entity's
      // SoundTable to get a Wave DID + per-row volume.
      const soundEnum = hook.soundEnum >>> 0;
      // Terrain-VFX Wave 3B (plan §3.7 item 1) — FOOTFALL NOTIFY. The plan asks
      // the DIRT/MUD family to "hang off the existing footstep-audio trigger
      // rather than re-deriving contact from velocity", and this hook IS that
      // trigger: `Sound.Footstep1 = 0x37` / `Sound.Footstep2 = 0x38`
      // (ACE.Entity/Enum/Sound.cs), fired by the animation timeline at the frame
      // the foot lands. It is notified BEFORE the SoundTable guards below on
      // purpose — a puff is a ground-contact event, not an audio one, so a muted
      // session or an entity with no SoundTable must still kick up dust.
      // `pos` is `inst.root.position`, i.e. the RAW AC frame (+Z up) the terrain
      // oracle wants; no acToThree here (that transform belongs to the panner).
      // The listener property is installed ONLY by
      // `scene3d/terrain_dirt.js::installFootfallHook` under `?terrainDirt=on`,
      // so with the family off this is one `typeof undefined` test.
      if (soundEnum === 0x37 || soundEnum === 0x38) {
        const onFootfall = this.scene3d?.onTerrainFootfall;
        if (typeof onFootfall === "function") {
          try { onFootfall(inst.guid >>> 0, pos.x, pos.y, pos.z); } catch (_) { /* never break audio */ }
        }
      }
      if (soundEnum === 0 || !cache || !audioMgr) return;
      let stbDid = inst.soundTableDid >>> 0;
      // WS12 (2026-07-12): mirror the 0xF750 GMSound + wasm-spawn local-player
      // fallback (index.html local-player 0x20000001 backfill / lib.rs
      // is_local_player humanoid default) — the local player's Setup is a
      // clothing composite that often omits default_sound_table, so a stale pkg
      // (or a spawn path that seeds 0) leaves player SoundTable(2) anim hooks
      // (emotes etc.) silent until the first GMSound. Backfill to the canonical
      // humanoid table for the LOCAL player ONLY; remote entities keep 0 =
      // genuinely no SoundTable. Cannot regress a non-zero table (guarded on 0).
      if (stbDid === 0) {
        const lpg = (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function")
          ? (window.getLocalPlayerGuid() >>> 0) : 0;
        if (lpg && (inst.guid >>> 0) === lpg) {
          inst.soundTableDid = 0x20000001;
          stbDid = 0x20000001;
        }
      }
      if (stbDid === 0) {
        // No SoundTable on this entity's weenie. Silent no-op — this
        // is a normal outcome for entities whose animations carry
        // SoundTable hooks but whose weenie has no SoundTable property
        // (e.g. shared rig + non-vocal subclass). No log spam.
        return;
      }
      // Fire-and-forget: the prewarm in `_spawnImpl` warms the cache
      // by the second frame, so by the time hooks fire (cycle frame
      // count typically > 1) the await on `resolveSound` is on a
      // settled Promise.
      cache
        .resolveSound(stbDid, soundEnum)
        .then((entry) => {
          if (!entry) return; // soft null — Sound enum not in this STB
          // DIM8-2 / W1.2 (2026-06-05): roll the per-row PlayProbability gate.
          // Retail `SoundTableHook::Execute → PlaySoundA` gates playback on
          // `PlayProbability(selected.probability_)` AFTER the uniform pick
          // (acclient.c:383681-383703); we resolved `entry.probability` from
          // the cache but discarded it. Use the SoundTableCache rng (cache._rng)
          // for test determinism, falling back to Math.random. Most rows are
          // probability==1.0 so audible impact is low. The PhysicsScript adapter
          // (entities.js ~:6226) routes hookType 2 through this same arm, so the
          // single gate covers both paths. (anim-deep FIX-PLAN W1.2.)
          if (entry.probability != null && entry.probability < 1.0) {
            const r = (typeof cache?._rng === "function") ? cache._rng() : Math.random();
            if (r >= entry.probability) return;
          }
          const gain = retailVolume(entry.volume); // row volume 0 = silent (acclient.c:383096)
          // Snapshot pos again at await-resolution time so a moving
          // entity's audio lands at its current location, not where
          // it was at hook-fire time. (For instant-resolve from a
          // warm cache the two are identical.)
          const px = inst.root.position.x;
          const py = inst.root.position.y;
          const pz = inst.root.position.z;
          // Phase F.C — emit event log record BEFORE play(). Source
          // is still "AnimationHook" (the hook is the trigger; the
          // SoundTable resolve is just the lookup mechanism). The
          // hookType field disambiguates from raw Sound (1) hooks.
          if (pushEventRecord) {
            pushEventRecord({
              type: "sound",
              wave_did: (entry.waveDid >>> 0),
              parent_entity_guid: (inst.guid >>> 0),
              world_pos: [+px, +py, +pz],
              t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
              source: "AnimationHook",
              source_meta: {
                entity_guid: (inst.guid >>> 0),
                motion_command: (inst.currentActionKey ?? null),
                // stance is folded into currentActionKey; no separate field
            // on EntityInstance (the (cmd, stance) tuple is the cache key).
                hook_type: 2,
                sound_enum: soundEnum,
                stb_did: stbDid,
                gain,
              },
            });
          }
          // Wave 3 / A4 — follow the entity so HRTF tracks moving sources.
          // D4-NEW-1 (2026-06-05): transform the RAW AC-frame snapshot into the
          // three.js listener frame (acToThree (ax,ay,az)→(ax,az,-ay)) so the
          // panned direction matches the listener; distance is preserved.
          // followGuid: the per-rAF panner refresh in index.js
          // updateFollowingPositions must apply the same transform to keep this
          // corrected past frame 0. (D4-NEW-1-verification.md; acclient.c:383163-383164.)
          const stbT = acToThree(px, py, pz);
          audioMgr.play(entry.waveDid, { x: stbT[0], y: stbT[1], z: stbT[2] }, { gain, followGuid: (inst.guid >>> 0) }).catch(() => {});
        })
        .catch(() => {});
      this._soundTableHookFires = (this._soundTableHookFires | 0) + 1;
      return;
    }
    if (hookType === 3) {
      // AttackHook — retail's strike-frame trigger. The DAT payload
      // carries an AttackCone (part_index, left/right Vec2D, radius,
      // height) and acclient.c:342282 (`AttackHook::Execute`) calls
      // `CPhysicsObj::attack` to do hit-detection. Server is the
      // authority for hit/damage resolution on our side (see ACE
      // `Player_Melee.cs:51` → `Attack(target)` → damage), so the
      // client just needs the *timing* to sync visual feedback (UI
      // pulse, future hit-marker, future impact-sound boost) to the
      // strike moment instead of swing-start.
      //
      // Emit a `combatStrikeFrame` event carrying the attacker's
      // entity GUID + the hook time-in-clip. Plugins (combat-bar
      // pulse, damage-feed timing) subscribe via
      // `client.events.on("combatStrikeFrame", ...)`.
      try {
        window.__pluginClient?.events?.emit?.("combatStrikeFrame", {
          attackerGuid: (inst.guid >>> 0),
          hookTimeInClipS: +hook.time,
        });
      } catch (_) {}
      // Phase F.C — runtime event log probe symmetry with sound hooks.
      if (pushEventRecord) {
        pushEventRecord({
          type: "combat_strike_frame",
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            motion_command: (inst.currentActionKey ?? null),
            hook_type: 3,
            hook_time: +hook.time,
          },
        });
      }
      this._attackHookFires = (this._attackHookFires | 0) + 1;
      return;
    }
    // Wave 1 (2026-05-28) — particle hooks. CreateParticle attaches an
    // emitter anchored to the entity rig (forge embers, lantern sparks,
    // idle-animation effects). Destroy/Stop tear down emitters by the
    // per-script `particleEmitterId` handle. CallPES invokes a separate
    // PhysicsScript chain after a delay.
    if (hookType === 13 || hookType === 26) {
      // CreateParticle / CreateBlockingParticle. Retail blocks the
      // animation while a `CreateBlockingParticle` script is running
      // (acclient.c:343026); we treat both the same — three.js has no
      // frame-gating mechanism the hook could pause, and the visual
      // result is the same.
      // A11-S0: hook 26 = CreateBlockingParticle. With the parity flag on,
      // route it with blocking semantics (no-replace if id already live).
      const isBlocking = (hookType === 26) && BLOCKING_PARTICLE_PARITY_ON;
      this._fireCreateParticleHook(inst, hook, isBlocking).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/hook-13] createParticle on 0x${inst.guid.toString(16)} failed:`,
          err
        );
      });
      this._createParticleHookFires = (this._createParticleHookFires | 0) + 1;
      return;
    }
    if (hookType === 14) {
      // DestroyParticle — tear down by per-script handle.
      // A11-S2: with `?particleOwner=on` the handle is OBJECT-SCOPED —
      // resolve through this entity's owner record (retail keys into the
      // object's OWN table, acclient.c:316382-316393).
      const emitterId = hook.particleEmitterId >>> 0;
      if (emitterId !== 0 && particleOwnerOn()) {
        try { ownerRegistry.destroyEmitter(inst.guid >>> 0, emitterId); } catch (_) {}
      } else if (emitterId !== 0 && this._worldParticleManager) {
        try { this._worldParticleManager.destroyParticleEmitter(emitterId); }
        catch (_) { /* idempotent — never error on unknown id */ }
      }
      this._destroyParticleHookFires = (this._destroyParticleHookFires | 0) + 1;
      return;
    }
    if (hookType === 15) {
      // StopParticle — stop emission (no teardown) by per-script handle.
      // A11-S2: owner-scoped resolve, as for Destroy(14) above
      // (acclient.c:316395-316407).
      const emitterId = hook.particleEmitterId >>> 0;
      if (emitterId !== 0 && particleOwnerOn()) {
        try { ownerRegistry.stopEmitter(inst.guid >>> 0, emitterId); } catch (_) {}
      } else if (emitterId !== 0 && this._worldParticleManager) {
        try { this._worldParticleManager.stopParticleEmitter(emitterId); }
        catch (_) { /* idempotent */ }
      }
      this._stopParticleHookFires = (this._stopParticleHookFires | 0) + 1;
      return;
    }
    if (hookType === 19) {
      // CallPES — invoke a PhysicsScript on this entity after
      // `callPesPause` seconds. Delegates to the existing chain walker
      // which fans out into its own CreateParticleHook entries.
      const pesId = hook.callPesDid >>> 0;
      const pause = +hook.callPesPause;
      if (pesId !== 0) {
        // T6: same retail jitter as the chain walker (~L6105) — `pause` is a
        // MAX window; roll `RollDice(0, pause)` (fire immediately when the
        // window < 0.0002). acclient.c:318987.
        const pauseW = pause || 0;
        const randPause = pauseW < 0.0002 ? 0 : timeRng() * pauseW;
        const delayMs = Math.max(0, randPause * 1000);
        const guidU = (inst.guid >>> 0);
        const root = inst.root;
        setTimeout(() => {
          // Late-fire guard: bail if the entity has been released while
          // the timer was pending (matches the Sound-hook pattern at
          // line ~4525). `_attachParticleChainForEntity` itself also
          // soft-noops on unknown guids, but the explicit check keeps
          // the per-fire log spam down.
          if (!this.entityMap.has(guidU)) return;
          this._attachParticleChainForEntity(guidU, root, pesId).catch(() => {});
        }, delayMs);
      }
      this._callPesHookFires = (this._callPesHookFires | 0) + 1;
      return;
    }
    if (hookType === 21) {
      // Wave 2 (2026-05-28) — SoundTweaked. Same wire shape as Sound (1)
      // (`hook.soundWaveId` is a Wave DID) but with three modifiers:
      //   - `soundProbability` (0..1): coin-flip gate; <1.0 means the
      //     hook fires probabilistically. Retail uses this for ambient
      //     creature vocalizations that shouldn't fire every cycle.
      //   - `soundVolume` (linear gain): passed as the play() `gain`
      //     option. Retail allows per-hook gain so a creature's quiet
      //     idle breaths and loud death roar can share the same hook
      //     mechanism.
      //   - `soundPriority` (linear float): retail's mix-priority hint
      //     for the AC mixer; our AudioManager doesn't currently use
      //     priority (HRTF panner + linear gain only) so we record it
      //     in the event log for future use but don't gate playback on
      //     it. Cite: acclient.c:343123 (SoundTweakedHook::UnPack).
      const waveId = hook.soundWaveId >>> 0;
      if (waveId === 0 || !audioMgr) return;
      const probability = +hook.soundProbability;
      // Coin-flip — same pattern as the PhysicsScript walker at line
      // ~4538. `probability >= 1.0` short-circuits the RNG call so
      // always-fire hooks don't burn `Math.random()` per swing.
      if (!(probability >= 1.0 || Math.random() < probability)) {
        // Rolled below probability — still count as a fire-attempt for
        // telemetry. The diag asserts "the executor reached this hook
        // type"; whether the coin landed heads is downstream.
        this._soundTweakedHookFires = (this._soundTweakedHookFires | 0) + 1;
        this._soundTweakedHookRollsMissed = (this._soundTweakedHookRollsMissed | 0) + 1;
        return;
      }
      const gain = retailVolume(+hook.soundVolume); // vol 0 = silent (acclient.c:342209, 383096)
      if (pushEventRecord) {
        pushEventRecord({
          type: "sound",
          wave_did: waveId,
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            motion_command: (inst.currentActionKey ?? null),
            hook_type: 21,
            hook_time: +hook.time,
            probability,
            priority: +hook.soundPriority,
            gain,
          },
        });
      }
      // Wave 3 / A4 parity with hookType 2 — track the entity GUID so
      // the panner follows a moving source. Important for SoundTweaked
      // (e.g. monster idle vocalizations on a creature that's pursuing
      // the player).
      // D4-NEW-1 (2026-06-05): transform the RAW AC-frame entity position into
      // the three.js listener frame (acToThree (ax,ay,az)→(ax,az,-ay)) so the
      // panned direction is correct; distance is preserved. followGuid: the
      // per-rAF panner refresh in index.js updateFollowingPositions must apply
      // the same transform to stay corrected past frame 0.
      // (D4-NEW-1-verification.md PARTIAL/HIGH; retail acclient.c:383163-383164.)
      const twkT = acToThree(pos.x, pos.y, pos.z);
      audioMgr
        .play(waveId, { x: twkT[0], y: twkT[1], z: twkT[2] }, { gain, followGuid: (inst.guid >>> 0) })
        .catch(() => {});
      this._soundTweakedHookFires = (this._soundTweakedHookFires | 0) + 1;
      return;
    }
    // Wave 3 (2026-05-28) — whole-object visibility / transform /
    // lifecycle hooks. These mutate `inst.root` directly. Material
    // hooks (Transparent/Luminous/Diffuse/Ethereal/TextureVelocity/
    // SetLight) are intentionally deferred — they need per-entity
    // material clone-on-write infra that we don't have yet (materials
    // are shared via `materialCache`).
    if (hookType === 4) {
      // AnimationDone — lifecycle signal that the cycle finished. Emit
      // a plugin event so combat/cast/motion observers see the edge.
      // three.js's `mixer.addEventListener('finished')` only fires for
      // LoopOnce actions; AnimationDone hooks fire on every loop, so
      // they're a distinct signal for LoopRepeat cycles (e.g. "idle
      // breath" idle-cycle end frames).
      try {
        window.__pluginClient?.events?.emit?.("animationHookDone", {
          guid: (inst.guid >>> 0),
          motionCommand: (inst.currentActionKey ?? null),
          hookTimeInClipS: +hook.time,
        });
      } catch (_) {}
      this._animationDoneHookFires = (this._animationDoneHookFires | 0) + 1;
      return;
    }
    if (hookType === 16) {
      // NoDraw — toggle entity visibility. Server is authoritative for
      // physics presence; we just hide/show the rig. `noDrawValue !== 0`
      // means "don't draw".
      const hidden = (hook.noDrawValue >>> 0) !== 0;
      // FCULL (2026-06-08) — composite with any active frustum/distance cull
      // so the two never overwrite each other (NoDraw is STATE-authoritative;
      // the cull is render-only).
      if (inst.root) _setEntityStateVisible(inst, !hidden);
      this._noDrawHookFires = (this._noDrawHookFires | 0) + 1;
      return;
    }
    if (hookType === 17) {
      // DefaultScript — invoke the entity's default PhysicsScript chain
      // (the same chain `_spawnImpl` walks at spawn). Used by retail to
      // re-trigger idle particle attaches at specific animation frames.
      const pesId = (inst.physicsScriptDid >>> 0) ||
        ((inst.meta?.physicsScriptDid >>> 0) | 0) ||
        0;
      if (pesId !== 0) {
        this._attachParticleChainForEntity(inst.guid >>> 0, inst.root, pesId)
          .catch(() => {});
      } else if (DEFAULT_SCRIPT_SPAWN_ON) {
        // A11-S5 / G14: PScriptType-coded default — this hook IS retail's
        // `DefaultScriptHook::Execute → play_default_script` trigger
        // (acclient.c:342330-342334 → :320351-320376); resolve via
        // GetScript(default_script, intensity) and play.
        this._playDefaultScriptResolved(inst.guid >>> 0, inst.root);
      }
      this._defaultScriptHookFires = (this._defaultScriptHookFires | 0) + 1;
      return;
    }
    if (hookType === 12) {
      // Scale — uniform scale tween from current → `rampEnd` over
      // `rampTime` seconds. NOTE: this is whole-object uniform scale
      // (X/Y/Z all set to the same value), distinct from the jump-tween
      // convention at line ~3341 that touches only Z. If both are active
      // concurrently, the Scale tween wins because it ticks last. In
      // practice they shouldn't overlap (jump = airborne; Scale hooks
      // are scripted into specific animation frames).
      const toScale = +hook.rampEnd;
      const durationS = +hook.rampTime;
      inst._scaleHookTween = {
        // A5-P2: stamp from the same clock `_tickScaleHookTween` reads.
        startMs: this._tweenNowMs(),
        durationMs: Math.max(0, durationS * 1000),
        fromScale: inst.root?.scale?.x ?? 1.0,
        toScale,
      };
      this._scaleHookFires = (this._scaleHookFires | 0) + 1;
      return;
    }
    if (hookType === 22) {
      // SetOmega — continuous angular velocity (rad/s) around an axis.
      // Persistent state until another SetOmega arrives (zero vector =
      // stop). Per-frame integration in `_tickHookOmega`.
      const ox = +hook.omegaX, oy = +hook.omegaY, oz = +hook.omegaZ;
      const stop = (ox === 0 && oy === 0 && oz === 0);
      inst._omega = stop
        ? null  // stop — clearing the field skips the tick fast-path
        : { x: ox, y: oy, z: oz };
      // #8 (2026-06-07): on stop, also drop the accumulated spin delta so a
      // subsequent server setPose re-application (`_omegaAccumQ.premultiply`
      // in setPose / _tickHookOmega) doesn't keep stamping a residual spin
      // onto the now-stopped heading. Only the hook spin clears here; the
      // cycle-omega path clears its own accum via cycleOmega below.
      if (stop && !inst._cycleOmega) inst._omegaAccumQ = null;
      this._setOmegaHookFires = (this._setOmegaHookFires | 0) + 1;
      return;
    }
    // Wave 4 (2026-05-28) — DefaultScriptPart (18). Same chain walker
    // as DefaultScript (17). Retail uses this to fire a "puff of smoke"
    // PhysicsScript at the foot part instead of the body root.
    // W4.7 / DIM3-3 (2026-06-05): thread the wire `partIndex` into the walker
    // as the invoked script's DEFAULT anchor part so the emitter anchors at
    // `inst.parts[partIndex]` (via the partFrames path) instead of the body
    // root — retail `play_default_script(object, _part_index)`
    // (acclient.c:342324-342327). Was previously advisory/telemetry-only.
    if (hookType === 18) {
      const pesId = (inst.physicsScriptDid >>> 0) ||
        ((inst.meta?.physicsScriptDid >>> 0) | 0) ||
        0;
      const partHint = hook.partIndex >>> 0;
      // Normalize the root sentinel (0xFFFFFFFF) to the walker's -1 default.
      const defaultPartIndex = (partHint === 0xFFFFFFFF) ? -1 : (partHint | 0);
      if (pesId !== 0) {
        this._attachParticleChainForEntity(inst.guid >>> 0, inst.root, pesId, 0, defaultPartIndex)
          .catch(() => {});
      } else if (DEFAULT_SCRIPT_SPAWN_ON) {
        // A11-S5 / G14: PScriptType-coded default — retail
        // `DefaultScriptPartHook::Execute → play_default_script(object,
        // _part_index)` (acclient.c:342324-342327), part anchor threaded.
        this._playDefaultScriptResolved(inst.guid >>> 0, inst.root, defaultPartIndex);
      }
      if (pushEventRecord) {
        pushEventRecord({
          type: "default_script_part",
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            hook_type: 18,
            part_index: partHint,
            script_did: pesId,
          },
        });
      }
      this._defaultScriptPartHookFires = (this._defaultScriptPartHookFires | 0) + 1;
      return;
    }
    // Wave 6 (2026-05-28) — Material/visual hooks via clone-on-write.
    // Whole-object ramps (Transparent 20, Luminous 8, Diffuse 10) spawn
    // a tween per surface in `inst._materialHookTweens`; per-part ramps
    // (TransparentPart 7, LuminousPart 9, DiffusePart 11) scope to the
    // surfaces on `inst.parts[partIdx]` only. Ethereal (6) snap-toggles
    // opacity across the entity. TextureVelocity (23) / Part (24)
    // installs persistent UV-scroll velocity in `inst._textureVelocities`.
    if (hookType === 20 || hookType === 8 || hookType === 10) {
      this._spawnMaterialRampTween(inst, hookType, -1, hook);
      this._materialHookFires = (this._materialHookFires | 0) + 1;
      return;
    }
    if (hookType === 7 || hookType === 9 || hookType === 11) {
      const partIdx = hook.partIndex >>> 0;
      if (partIdx === 0xFFFFFFFF) return; // sentinel — non-part-aware
      this._spawnMaterialRampTween(inst, hookType, partIdx, hook);
      this._materialHookFires = (this._materialHookFires | 0) + 1;
      return;
    }
    if (hookType === 6) {
      // Ethereal — instant toggle. Non-zero = phase through; clients
      // visualize via reduced opacity (server is collision-authoritative
      // so the visual is purely a hint). `0` restores prior opacity.
      const wantEthereal = (hook.etherealValue | 0) !== 0;
      if (ETHEREAL_GHOST) this._applyEtherealToEntity(inst, wantEthereal);
      else inst._ethereal = wantEthereal; // retail: state only, no visual
      this._etherealHookFires = (this._etherealHookFires | 0) + 1;
      return;
    }
    if (hookType === 23) {
      // TextureVelocity (whole-object) — persistent UV scroll.
      this._setTextureVelocity(inst, -1, +hook.textureUSpeed, +hook.textureVSpeed);
      this._textureVelocityHookFires = (this._textureVelocityHookFires | 0) + 1;
      return;
    }
    if (hookType === 24) {
      const partIdx = hook.partIndex >>> 0;
      if (partIdx === 0xFFFFFFFF) return;
      this._setTextureVelocity(inst, partIdx, +hook.textureUSpeed, +hook.textureVSpeed);
      this._textureVelocityHookFires = (this._textureVelocityHookFires | 0) + 1;
      return;
    }
    // === Wave R2.A (2026-05-28) — SetLight (25). Toggles the entity's
    // attached dynamic lights (built at spawn by `_attachEntityLights`, path
    // (b): real THREE PointLight/SpotLight). `hook.lightsOn` (i32 bool) drives
    // on/off: on → restore each light's authored intensity + visible=true;
    // off → intensity 0 + visible=false. The per-frame distance cap in
    // lighting.js still governs which of the (now-on) lights actually render.
    //
    // DEFAULT-OFF (`?entityLights` absent): `inst._setupLights` is never
    // populated (the spawn-time attach is skipped), so this branch falls
    // through to the unchanged logged-no-op + counter below — byte-identical
    // to pre-R2.A behaviour.
    if (hookType === 25) {
      const lights = inst._setupLights;
      if (this._entityLightsOn && Array.isArray(lights) && lights.length > 0) {
        const wantOn = (hook.lightsOn | 0) !== 0;
        // Pool mode (?lightPool=on): the source light is a PERMANENT
        // `.visible=false` carrier — the fixed light pool (lighting.js) renders
        // it from its intensity. Flipping `.visible` here would change the
        // renderer's per-type light count → relink every lit material in the
        // scene → the multi-second freeze on every spell cast. So drive
        // intensity ONLY and leave `.visible` untouched. Legacy: flip as before.
        const poolOn = !!this.scene3d?.lighting?.lightPool?.enabled;
        for (const light of lights) {
          if (wantOn) {
            const authored =
              light.userData && Number.isFinite(light.userData.__setupIntensity)
                ? light.userData.__setupIntensity
                : light.intensity;
            light.intensity = authored;
            if (!poolOn) light.visible = true;
          } else {
            light.intensity = 0;
            if (!poolOn) light.visible = false;
          }
        }
        this._entityLightHookFires = (this._entityLightHookFires | 0) + 1;
        return;
      }
      // No entity lights on this rig (feature off, or Setup carries none).
      // Keep the original logged-no-op + deferral counter for telemetry
      // parity with the other hooks.
      if (!inst._setLightHookDebugged) {
        inst._setLightHookDebugged = true;
        // eslint-disable-next-line no-console
        console.debug(
          `[entities/setlight] hookType=25 on entity ` +
          `0x${inst.guid.toString(16)} — no attached entity lights ` +
          `(entityLights=${this._entityLightsOn ? "on" : "off"})`
        );
      }
      this._setLightDeferredFires = (this._setLightDeferredFires | 0) + 1;
      return;
    }
    // Wave 7 (2026-05-28) — ReplaceObject. Single-part mesh swap;
    // mirrors `_applyAppearanceHotSwap` (line ~4059) but scoped to one
    // part. Async via `_fireReplaceObjectHook` so the await on
    // `fetchBuildingPlacement` doesn't block the hook executor.
    if (hookType === 5) {
      const partIdx = hook.replacePartIndex >>> 0;
      const newGfxObjId = hook.replaceNewGfxObjId >>> 0;
      if (newGfxObjId === 0 || partIdx === 0xFF) {
        this._replaceObjectHookFires = (this._replaceObjectHookFires | 0) + 1;
        return;
      }
      this._fireReplaceObjectHook(inst, partIdx, newGfxObjId).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/hook-5] replaceObject part=${partIdx} ` +
          `gfxObj=0x${newGfxObjId.toString(16)} on entity ` +
          `0x${inst.guid.toString(16)} failed:`,
          err
        );
      });
      this._replaceObjectHookFires = (this._replaceObjectHookFires | 0) + 1;
      return;
    }
    // Every hook type now routes to a handler or an explicit deferral.
    // Reaching this line means a NEW hook type was added upstream (in
    // retail or melt) that we haven't seen yet. Counted separately so
    // diag surfaces the "unknown hook arrived" event distinctly from
    // the known-deferred counters.
    this._unhandledHookFires = (this._unhandledHookFires | 0) + 1;
  }

  /**
   * Wave 3 — Scale hook (hookType 12) tween advance. Lerps
   * `inst.root.scale` uniformly from `fromScale` → `toScale` over
   * `durationMs`. Easing matches the jump-tween convention: linear (no
   * cubic-bezier) because retail's Scale hooks are usually short
   * (0.1-0.5s) and the duration is already authored into the motion.
   *
   * Called from `tick(dt)` after `mixer.update` so the scale wins for
   * the tween duration.
   */
  _tickScaleHookTween(inst, nowMs) {
    const tw = inst._scaleHookTween;
    if (!tw || !inst.root) return;
    const elapsed = nowMs - tw.startMs;
    if (tw.durationMs <= 0 || elapsed >= tw.durationMs) {
      // Snap to end + clear the tween.
      inst.root.scale.set(tw.toScale, tw.toScale, tw.toScale);
      inst._scaleHookTween = null;
      return;
    }
    const t = elapsed / tw.durationMs;
    const s = tw.fromScale + (tw.toScale - tw.fromScale) * t;
    inst.root.scale.set(s, s, s);
  }

  /**
   * Wave 6 (2026-05-28) — Spawn ramp tweens for a Transparent (20) /
   * Luminous (8) / Diffuse (10) / *Part (7, 9, 11) hook. Builds one
   * tween entry per affected material (whole-object: every surface on
   * the entity; per-part: only surfaces on `inst.parts[partIndex]`).
   * Tweens live in `inst._materialHookTweens` and advance in
   * `_tickMaterialHooks` each frame.
   *
   * `partIndex < 0` means whole-object.
   */
  _spawnMaterialRampTween(inst, hookType, partIndex, hook) {
    if (!inst.root) return;
    const rampStart = +hook.rampStart;
    const rampEnd = +hook.rampEnd;
    const durationMs = Math.max(0, (+hook.rampTime) * 1000);
    const surfaceDids = this._collectEntitySurfaceDids(inst, partIndex);
    if (!surfaceDids || surfaceDids.length === 0) return;
    if (!inst._materialHookTweens) inst._materialHookTweens = [];
    // Drop any prior tween for the same (hookType, surfaceDid) — the
    // newer hook supersedes. Per-part variants and whole-object share
    // the same per-surface address space (a part swap can clobber a
    // whole-object Diffuse, matching retail's "last hook wins"
    // semantics; acclient.c:0x00524F90).
    if (inst._materialHookTweens.length > 0) {
      const keep = [];
      for (const tw of inst._materialHookTweens) {
        // Diffuse/Luminous/Transparent each have whole-obj + per-part
        // variants that target the SAME material property — collapse
        // by property family, not literal hookType.
        const oldFamily = this._materialHookFamily(tw.hookType);
        const newFamily = this._materialHookFamily(hookType);
        if (oldFamily === newFamily && surfaceDids.includes(tw.surfaceDid)) {
          continue; // superseded — drop
        }
        keep.push(tw);
      }
      inst._materialHookTweens = keep;
    }
    const startMs = performance.now();
    for (const did of surfaceDids) {
      const mat = this._getOrCloneEntityMaterial(inst, did);
      if (!mat) continue; // fallback / cache miss — silent no-op
      // Snap to rampStart immediately so a 0-duration ramp lands the
      // end value on the next tick (durationMs<=0 → tick sees elapsed
      // >= durationMs and applies rampEnd).
      this._applyRampValueToMaterial(hookType, mat, rampStart);
      inst._materialHookTweens.push({
        hookType,
        surfaceDid: did,
        startMs,
        durationMs,
        rampStart,
        rampEnd,
      });
    }
  }

  /**
   * Map a ramp hookType to its material-property family. Transparent
   * (20) and TransparentPart (7) both target `opacity` — they're one
   * family. Same for Luminous (8/9) → emissive; Diffuse (10/11) →
   * color. Used by `_spawnMaterialRampTween` to collapse superseded
   * tweens by *effect*, not literal opcode.
   */
  _materialHookFamily(hookType) {
    if (hookType === 20 || hookType === 7) return "opacity";
    if (hookType === 8 || hookType === 9) return "emissive";
    if (hookType === 10 || hookType === 11) return "diffuse";
    return null;
  }

  /**
   * Walk `inst.parts` collecting unique `surfaceDid`s. With
   * `partIndex < 0` (whole-object), returns every surface on the rig;
   * with `partIndex >= 0`, returns only surfaces on that one part.
   */
  _collectEntitySurfaceDids(inst, partIndex) {
    const out = [];
    if (!Array.isArray(inst.parts)) return out;
    const seen = new Set();
    const collectFrom = (partGroup) => {
      if (!partGroup) return;
      for (const child of partGroup.children) {
        if (!child || !child.isMesh) continue;
        const did = (child.userData?.surfaceDid >>> 0);
        if (did && !seen.has(did)) {
          seen.add(did);
          out.push(did);
        }
      }
    };
    if (partIndex < 0) {
      for (const part of inst.parts) collectFrom(part);
    } else if (partIndex < inst.parts.length) {
      collectFrom(inst.parts[partIndex]);
    }
    return out;
  }

  /**
   * Apply a ramp value to a material based on the source hookType.
   * Transparent (20/7) → `opacity` + `transparent`. Luminous (8/9) →
   * `emissive` (set as a uniform white at the given intensity).
   * Diffuse (10/11) → `color` scaled to the value (multiplies the
   * albedo texture by `v` — matches retail's "Diffuse" parameter
   * semantic in `acclient.c:0x00523000`).
   */
  _applyRampValueToMaterial(hookType, material, value) {
    if (!material) return;
    if (hookType === 20 || hookType === 7) {
      // T2: the Transparent(20)/TransparentPart(7) hook VALUE is
      // TRANSLUCENCY, not alpha. Retail `CMaterial::SetTranslucencySimple`
      // (acclient.c:360598) computes `alpha = 1.0 - trans`, so 0=opaque,
      // 1=invisible. The previous `opacity = value` faded the material IN
      // as translucency ramped 0→1 — backwards. Invert to match retail and
      // the static-surface path (materials.js:1836 `opacity = 1 - translucency`).
      // `transparent: true` is required for three.js to actually blend;
      // value <= 0 (fully opaque) restores the fast opaque path.
      //
      // DIM7-5 / W4.2 (2026-06-05): floor the ramp VALUE (translucency) to the
      // surface's authored base translucency so a Transparent hook can never
      // render a base-translucent surface MORE opaque than its authored
      // baseline — retail floors `_end` to translucencyOriginal
      // (acclient.c:316947-316956). The base is stashed on `userData` at clone
      // time (`__baseTranslucency`, see _applyPalettedSurfaceRenderState).
      // Absent (non-paletted / opaque-base surfaces) → floor 0 = current
      // behavior. Covers both the ramp and the snap (both route through here,
      // _tickMaterialHooks tween-done branch). (anim-deep FIX-PLAN W4.2.)
      const baseTrans = +(material.userData?.__baseTranslucency ?? 0);
      const flooredValue = value < baseTrans ? baseTrans : value;
      material.opacity = 1 - flooredValue;
      material.transparent = flooredValue > 0;
      // depthWrite mirrors transparency to avoid sorting glitches on
      // edges (matches the standard PBR-ghost convention).
      if (material.transparent && material.depthWrite !== false) {
        material.userData.__preTransDepthWrite = material.depthWrite;
        material.depthWrite = false;
      } else if (!material.transparent && material.userData.__preTransDepthWrite !== undefined) {
        material.depthWrite = material.userData.__preTransDepthWrite;
        delete material.userData.__preTransDepthWrite;
      }
    } else if (hookType === 8 || hookType === 9) {
      // Luminous — emissive intensity. Set the emissive color to a
      // uniform white at `value` brightness; `emissiveIntensity` stays
      // at the material's default (usually 1.0) so the on-screen
      // luminance equals `value`. Works on MeshStandardMaterial even
      // when the cached material had `emissive = (0, 0, 0)`.
      if (material.emissive) {
        material.emissive.setRGB(value, value, value);
        // DIM7-3 / W4.1 (2026-06-05): force emissiveIntensity to 1.0 so the
        // on-screen luminance equals `value` raw, matching retail
        // SetLuminositySimple (acclient.c:360612-360617, raw emissive set).
        // A BASE-Luminous surface's cloned material carries
        // emissiveIntensity = min(2.0, sfLuminosity) (entities.js ~:2615 /
        // materials.js); three.js renders emissive × emissiveIntensity, so
        // leaving it would DOUBLE-brighten a base-luminous surface that also
        // gets a runtime Luminous hook. (anim-deep FIX-PLAN W4.1.)
        material.emissiveIntensity = 1.0;
      }
    } else if (hookType === 10 || hookType === 11) {
      // Diffuse — albedo scalar. Multiplies the texture by `value`;
      // `value = 0` reads as black, `value = 1` is the un-tinted
      // material. Retail's Diffuse param is in [0, 1].
      if (material.color) {
        material.color.setRGB(value, value, value);
      }
    }
  }

  /**
   * Wave 6 — Ethereal (6) snap-toggle. Sets opacity to 0.4 when
   * `ethereal === true`; restores the prior opacity when `false`.
   *
   * T5: the 0.4 ghost opacity is a DELIBERATE CLIENT INVENTION, NOT retail.
   * Retail `CPhysicsObj::set_ethereal` (acclient.c:319047) only flips the
   * collision-state bit 0x4 (ETHEREAL_PS) + transient_state bit 0x100 — it
   * NEVER touches opacity/translucency/material (and there is no retail
   * `set_translucency_internal` symbol at all). Any visual for ethereal is
   * a holtburger affordance so ethereal objects read as ghostly; keep it
   * only as long as that reads well in an eye-test.
   *
   * The "prior opacity" is captured once per cloned material in
   * `userData.__preEtherealOpacity`; subsequent toggles read that
   * snapshot so a Transparent hook that fires between Ethereal
   * on→off transitions doesn't leak its intermediate value into the
   * restore path.
   */
  _applyEtherealToEntity(inst, ethereal) {
    inst._ethereal = !!ethereal;
    const dids = this._collectEntitySurfaceDids(inst, -1);
    for (const did of dids) {
      const mat = this._getOrCloneEntityMaterial(inst, did);
      if (!mat) continue;
      if (ethereal) {
        if (mat.userData.__preEtherealOpacity === undefined) {
          mat.userData.__preEtherealOpacity = mat.opacity;
        }
        mat.opacity = 0.4; // T5: client-invented ghost hint, NOT retail (see method doc)
        mat.transparent = true;
        if (mat.depthWrite !== false) {
          mat.userData.__preEtherealDepthWrite = mat.depthWrite;
          mat.depthWrite = false;
        }
      } else {
        if (mat.userData.__preEtherealOpacity !== undefined) {
          mat.opacity = mat.userData.__preEtherealOpacity;
          delete mat.userData.__preEtherealOpacity;
        }
        mat.transparent = mat.opacity < 1.0;
        if (mat.userData.__preEtherealDepthWrite !== undefined) {
          mat.depthWrite = mat.userData.__preEtherealDepthWrite;
          delete mat.userData.__preEtherealDepthWrite;
        }
      }
    }
  }

  /**
   * Render-audit critic missedFeatures #1 (2026-06-09) — whole-OBJECT
   * translucency entrypoint. Called from the EntityUpdate drain (loop.js)
   * whenever the wasm `physicsTranslucency` field changes at runtime — e.g.
   * the classic AC fade as an item materializes / is dropped, or a creature
   * phasing ethereal — so the change re-renders without a respawn. The same
   * field is applied at spawn (see `spawn()`). No-op when the entity isn't
   * in `entityMap` yet (race with the async spawn pipeline).
   *
   * `translucency` is the PhysicsDesc Translucency in [0, 1]: 0 = fully
   * opaque, 1 = fully transparent. Values outside that range are clamped.
   */
  applyObjectTranslucency(guid, translucency) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    this._applyObjectTranslucencyToEntity(inst, +translucency || 0);
  }

  /**
   * Render-audit critic missedFeatures #1 (2026-06-09) — apply a whole-OBJECT
   * translucency factor across every surface on the entity. Mirrors the
   * `_applyEtherealToEntity` snapshot/restore discipline so the two — plus
   * the per-surface translucency (`_applyPalettedSurfaceRenderState`) and the
   * Transparent (20) hook ramps — COMPOSE instead of clobbering.
   *
   * The object factor is MULTIPLICATIVE: each material's opacity becomes
   * `base * (1 - translucency)`, where `base` is the opacity OWNED by the
   * other systems (authored surface translucency, a Transparent ramp, etc.).
   * We snapshot that base into `userData.__preObjTransOpacity` the first time
   * object-translucency touches a material, and ALWAYS derive the new opacity
   * from that snapshot — never from the already-multiplied current value — so
   * repeated runtime updates don't compound. When translucency returns to 0
   * we restore the snapshot, drop it, and reset `transparent`/`depthWrite` so
   * the next non-zero apply re-snapshots the (now other-system-owned) base.
   *
   * Object translucency is INDEPENDENT of the `should_draw` hide-gate
   * (`_setEntityStateVisible`): a hidden entity stays hidden via `root.visible`
   * regardless of material opacity, and a translucent entity is still drawn
   * (just blended). We deliberately do NOT touch `inst.root.visible` here.
   *
   * `_getOrCloneEntityMaterial` returns null for fallback / cache-miss
   * surfaces (same as the ethereal path) — those silently no-op rather than
   * cloning the shared fallback singleton.
   */
  _applyObjectTranslucencyToEntity(inst, translucency) {
    // Clamp the translucency to [0, 1] → opacity multiplier in [0, 1].
    const t = translucency < 0 ? 0 : (translucency > 1 ? 1 : translucency);
    const factor = 1 - t; // clamp01(1 - physicsTranslucency)
    inst._objectTranslucency = t;
    const dids = this._collectEntitySurfaceDids(inst, -1);
    for (const did of dids) {
      const mat = this._getOrCloneEntityMaterial(inst, did);
      if (!mat) continue;
      if (t > 0) {
        // Snapshot the base opacity (owned by surface-translucency / hooks /
        // ethereal) on FIRST object-translucency touch; re-derive from it on
        // every subsequent apply so runtime updates don't compound.
        if (mat.userData.__preObjTransOpacity === undefined) {
          mat.userData.__preObjTransOpacity = mat.opacity;
        }
        const base = mat.userData.__preObjTransOpacity;
        mat.opacity = base * factor;
        mat.transparent = true;
        // Translucent objects must not occlude themselves via depth — stash
        // the prior depthWrite so the restore path can return it.
        if (mat.depthWrite !== false && mat.userData.__preObjTransDepthWrite === undefined) {
          mat.userData.__preObjTransDepthWrite = mat.depthWrite;
          mat.depthWrite = false;
        }
      } else if (mat.userData.__preObjTransOpacity !== undefined) {
        // Restore: object is fully opaque again. Return the base opacity the
        // other systems set, then let `transparent` reflect THAT value (a
        // surface that's authored-translucent or mid-ethereal stays blended;
        // a plain opaque surface drops back to opaque).
        mat.opacity = mat.userData.__preObjTransOpacity;
        delete mat.userData.__preObjTransOpacity;
        mat.transparent = mat.opacity < 1.0;
        if (mat.userData.__preObjTransDepthWrite !== undefined) {
          mat.depthWrite = mat.userData.__preObjTransDepthWrite;
          delete mat.userData.__preObjTransDepthWrite;
        }
      }
      // t === 0 AND no snapshot → material was never touched by object
      // translucency; leave it exactly as the other systems set it (do NOT
      // force `transparent = true` on an already-opaque material).
    }
  }

  /**
   * A12-C2 (2026-06-12, ?retailCamZoom=on) — camera-driven local-player
   * fade. Retail's CameraSet::UpdateCamera fades the player via
   * SetTranslucencyHierarchical as the camera closes on the pivot
   * (opaque at ≥0.45 m, invisible toward 0.2 m, fully hidden in-head —
   * acclient.c:149187-149216). camera.js computes the opacity each frame
   * (scene3d/camera_math.js `nearFadeOpacity`) and pushes it here.
   *
   * Mirrors `_applyObjectTranslucencyToEntity`'s snapshot/restore
   * discipline with its OWN snapshot keys (`__preCamFadeOpacity` /
   * `__preCamFadeDepthWrite`) so the camera fade COMPOSES multiplicatively
   * over whatever the other opacity owners (surface render-state, object
   * translucency, ethereal, Transparent hooks) set, and restores their
   * value exactly when the camera backs off (opacity returns to 1).
   *
   * KNOWN COMPOSITION CAVEAT (flag-gated, acceptable): if another opacity
   * system snapshots `mat.opacity` while a camera fade is mid-flight, it
   * captures the faded value as its base. The camera fade re-derives from
   * its own snapshot on every change so it never compounds itself, and the
   * local player rarely receives runtime object-translucency — 1070
   * eye-test will confirm before any default-on.
   *
   * Idempotent per `inst._camFadeOpacity`; camera.js additionally
   * quantizes to 1/128 so material writes only happen on visible change.
   */
  setLocalPlayerCameraOpacity(guid, opacity) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    let o = +opacity;
    if (!Number.isFinite(o)) o = 1.0;
    if (o < 0) o = 0;
    else if (o > 1) o = 1;
    if (inst._camFadeOpacity === o) return;
    inst._camFadeOpacity = o;
    const dids = this._collectEntitySurfaceDids(inst, -1);
    for (const did of dids) {
      const mat = this._getOrCloneEntityMaterial(inst, did);
      if (!mat) continue;
      if (o < 1) {
        if (mat.userData.__preCamFadeOpacity === undefined) {
          mat.userData.__preCamFadeOpacity = mat.opacity;
        }
        mat.opacity = mat.userData.__preCamFadeOpacity * o;
        mat.transparent = true;
        if (mat.depthWrite !== false && mat.userData.__preCamFadeDepthWrite === undefined) {
          mat.userData.__preCamFadeDepthWrite = mat.depthWrite;
          mat.depthWrite = false;
        }
      } else if (mat.userData.__preCamFadeOpacity !== undefined) {
        mat.opacity = mat.userData.__preCamFadeOpacity;
        delete mat.userData.__preCamFadeOpacity;
        mat.transparent = mat.opacity < 1.0;
        if (mat.userData.__preCamFadeDepthWrite !== undefined) {
          mat.depthWrite = mat.userData.__preCamFadeDepthWrite;
          delete mat.userData.__preCamFadeDepthWrite;
        }
      }
    }
  }

  /**
   * Wave 6 — Install a persistent UV-scroll velocity. `(us, vs)` are
   * Δoffset per second; `(0, 0)` clears. `partIndex < 0` applies to
   * every entity surface; `partIndex >= 0` scopes to one part. Tags
   * each affected material with `userData.__hookTexVel = {us, vs}` so
   * `_tickMaterialHooks` can iterate `inst._entityMaterials` once per
   * frame without an auxiliary map.
   *
   * Forces `cloneTexture: true` so the per-entity material gets its
   * own `Texture` object; the underlying `Texture.image` is shared
   * with the cache (one GPU upload).
   */
  _setTextureVelocity(inst, partIndex, us, vs) {
    const dids = this._collectEntitySurfaceDids(inst, partIndex);
    const stop = (us === 0 && vs === 0);
    for (const did of dids) {
      const mat = this._getOrCloneEntityMaterial(inst, did, { cloneTexture: !stop });
      if (!mat) continue;
      if (stop) {
        delete mat.userData.__hookTexVel;
      } else {
        mat.userData.__hookTexVel = { us, vs };
        // DIM1-4 / W4.4 (2026-06-05): the per-frame UV scroll in
        // `_tickMaterialHooks` hard-gates `if (!mat.map) continue;`, so a
        // material whose diffuse texture hasn't been lazily upgraded yet would
        // silently DROP the scroll. Retail `SetPartTextureVelocity` scrolls
        // unconditionally (acclient.c:342554). Trigger the lazy diffuse-texture
        // upgrade now (mirrors the needsTex path at ~:2506) so the scroll has a
        // `.map` to offset. Fire-and-forget; most water/lava/sign surfaces
        // already carry a base map so this no-ops. (anim-deep FIX-PLAN W4.4.)
        if (!mat.map) {
          this._ensureEntityMaterialMap(inst, did >>> 0).catch(() => {});
        }
      }
    }
  }

  /**
   * DIM1-4 / W4.4 (2026-06-05) — lazily attach a diffuse `.map` to an
   * entity-owned material that was cloned from a still-untextured (map-less)
   * cache material, so a TextureVelocity hook installed on it has a texture to
   * UV-scroll. Resolves the textured cache material via the SAME path the
   * surface-refresh retry uses (`materialCache.get(did, fetch_surfaces_pixels)`)
   * and lifts a per-entity CLONE of its `.map` onto the entity material (the
   * clone keeps the velocity `.offset` private; the underlying `Texture.image`
   * is shared, so no extra GPU upload). No-op if the surface still has no
   * texture (resource not arrived) or the entity material was disposed.
   */
  async _ensureEntityMaterialMap(inst, surfaceDid) {
    const did = surfaceDid >>> 0;
    if (!this.materialCache || typeof this.wasmExports?.fetch_surfaces_pixels !== "function") return;
    const mat = inst._entityMaterials?.get(did);
    // Already upgraded (by us or by a concurrent call), gone, or velocity
    // cleared meanwhile → nothing to do.
    if (!mat || mat.map || !mat.userData?.__hookTexVel) return;
    let cacheMat;
    try {
      cacheMat = await this.materialCache.get(did, this.wasmExports.fetch_surfaces_pixels);
    } catch (_) {
      return; // transient — a later TextureVelocity install retries
    }
    if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
    if (!mat.map && mat.userData?.__hookTexVel && cacheMat && cacheMat.map) {
      const tex = cacheMat.map.clone();
      tex.userData = { ...(tex.userData || {}), __disposable: true };
      delete tex.userData.__cacheOwned;
      tex.needsUpdate = false; // shared image, no re-upload
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }

  /**
   * Wave 6 — per-frame advance of material ramp tweens + UV scroll.
   * Ramp tweens drain when they hit `durationMs`; UV scroll is
   * persistent until `_setTextureVelocity` clears it.
   */
  _tickMaterialHooks(inst, dt, nowMs) {
    if (inst._materialHookTweens && inst._materialHookTweens.length > 0) {
      const survivors = [];
      for (const tw of inst._materialHookTweens) {
        const mat = inst._entityMaterials?.get(tw.surfaceDid);
        if (!mat) continue; // material disposed / dereferenced
        const elapsed = nowMs - tw.startMs;
        if (tw.durationMs <= 0 || elapsed >= tw.durationMs) {
          this._applyRampValueToMaterial(tw.hookType, mat, tw.rampEnd);
          continue; // tween done
        }
        const t = elapsed / tw.durationMs;
        const v = tw.rampStart + (tw.rampEnd - tw.rampStart) * t;
        this._applyRampValueToMaterial(tw.hookType, mat, v);
        survivors.push(tw);
      }
      inst._materialHookTweens = survivors.length > 0 ? survivors : null;
    }
    if (inst._entityMaterials && inst._entityMaterials.size > 0) {
      for (const mat of inst._entityMaterials.values()) {
        const vel = mat.userData?.__hookTexVel;
        if (!vel) continue;
        if (!mat.map) continue;
        const off = mat.map.offset;
        // Wrap into [0, 1) to keep float precision good over long
        // sessions; UV-wrap-aware sampling makes this safe.
        off.x = ((off.x + vel.us * dt) % 1 + 1) % 1;
        off.y = ((off.y + vel.vs * dt) % 1 + 1) % 1;
        // No `needsUpdate` flag — Texture offset/repeat hot-path
        // doesn't require re-upload, three.js uploads the offset as
        // a uniform per draw.
      }
    }
  }

  /**
   * Wave 3 — SetOmega hook (hookType 22) integration. Advances
   * `inst.root.quaternion` by `omega * dt` per frame. Continuous; a
   * subsequent SetOmega with a zero vector clears `inst._omega` and
   * stops the rotation.
   *
   * Uses `_omegaScratch*` module-scope scratch to avoid per-frame
   * allocations across the entity list.
   */
  _tickHookOmega(inst, dt) {
    if (!inst.root) return;
    // Sum the SetOmega-hook omega (`_omega`) and the authored cycle omega
    // (`_cycleOmega`, ?cycleOmega=on). Either may be absent; when both are the
    // omega is the combined angular velocity. With cycleOmega OFF, `_cycleOmega`
    // is never set, so this reduces to the original hook-only behaviour.
    const ho = inst._omega, co = inst._cycleOmega;
    if (!ho && !co) return;
    const ox = (ho ? ho.x : 0) + (co ? co.x : 0);
    const oy = (ho ? ho.y : 0) + (co ? co.y : 0);
    const oz = (ho ? ho.z : 0) + (co ? co.z : 0);
    const magSq = ox * ox + oy * oy + oz * oz;
    if (magSq === 0) return;
    const mag = Math.sqrt(magSq);
    const angle = mag * dt;
    if (angle === 0) return;
    // Pre-multiplied delta quaternion: q = (cos(θ/2), sin(θ/2) * axis).
    const halfAngle = angle * 0.5;
    const sinHalf = Math.sin(halfAngle);
    _omegaScratchQ.set(
      (ox / mag) * sinHalf,  // x
      (oy / mag) * sinHalf,  // y
      (oz / mag) * sinHalf,  // z
      Math.cos(halfAngle),   // w
    );
    inst.root.quaternion.multiplyQuaternions(_omegaScratchQ, inst.root.quaternion);
    // DIM1-2 / W4.3 (2026-06-05): accumulate the SAME pre-multiplied spin delta
    // into a persistent `_omegaAccumQ` so a subsequent server `setPose` copy()
    // (which resets root.quaternion to the server orientation + airborneTilt
    // and would otherwise STOMP the baked-in spin) can re-apply it — retail
    // set_omega is a persistent angular-VELOCITY field re-applied every tick
    // (acclient.c:316613/:317777), never lost on an orientation update. Only an
    // entity that BOTH spins AND receives position updates repros the clobber;
    // static spinners (signs/fans, no setPose) are unaffected.
    // (anim-deep FIX-PLAN W4.3.)
    if (!inst._omegaAccumQ) inst._omegaAccumQ = new THREE.Quaternion();
    inst._omegaAccumQ.premultiply(_omegaScratchQ);
  }

  /**
   * Wave 1 — Spawn a particle emitter for a CreateParticleHook (13) /
   * CreateBlockingParticleHook (26) fired by an entity's animation
   * timeline.
   *
   * Pipeline: hook.emitterInfoId → `fetchParticleEmitter(did)` →
   * `_worldParticleManager.addEmitter(...)`. The hook carries:
   *   - emitterInfoId — ParticleEmitter (0x32..) DID
   *   - createPartIndex — which SetupModel part to anchor to (`0xFFFFFFFF` = root)
   *   - offsetOrigin{X,Y,Z} + offsetOrientation{W,X,Y,Z} — local-space spawn Frame
   *   - particleEmitterId — per-script stable handle (Destroy/Stop reference)
   *
   * On success the returned emitter id is pushed into
   * `_particleEmittersForGuid` so the entity-release path tears it down
   * (line ~4260) — same lifecycle as PhysicsScript-walked emitters, so
   * fireworks rockets that despawn before their hook fires don't leak
   * floating particles.
   *
   * Errors are caught at the caller in `_fireHook`; this method may
   * reject if `_ensureWorldParticleManager` or `fetchParticleEmitter`
   * throws.
   */
  async _fireCreateParticleHook(inst, hook, blocking = false) {
    const emitterInfoId = hook.emitterInfoId >>> 0;
    if (emitterInfoId === 0) return;
    if (!inst.root) return; // entity released between hook arm + fire
    await this._ensureWorldParticleManager(inst.root);
    let emitterInfo;
    try {
      emitterInfo = await this.wasmExports.fetchParticleEmitter(emitterInfoId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/hook-13] fetchParticleEmitter(0x${emitterInfoId.toString(16)}) failed:`,
        e
      );
      return;
    }
    if (!this.entityMap.has(inst.guid >>> 0)) return; // released mid-await
    const parentOffset = {
      position: {
        x: +hook.offsetOriginX,
        y: +hook.offsetOriginY,
        z: +hook.offsetOriginZ,
      },
      // Frame stores quaternion as wxyz; THREE.Quaternion is xyzw —
      // ParticleManager.addEmitter expects the wxyz shape (matches the
      // H2 chain walker at line ~4675 which passes the same shape).
      quaternion: {
        w: +hook.offsetOrientationW,
        x: +hook.offsetOrientationX,
        y: +hook.offsetOrientationY,
        z: +hook.offsetOrientationZ,
      },
    };
    const partIndex = hook.createPartIndex | 0;
    const emitterIdSeed = hook.particleEmitterId >>> 0;
    let spawnedId;
    try {
      // A11-S2: with `?particleOwner=on` route through the owner facade —
      // `emitterIdSeed` becomes an OBJECT-SCOPED handle and entity-release
      // teardown is the facade's `destroyAllForOwner` (the per-guid map
      // below stays empty on-path).
      const req = {
        emitterInfo,
        parent: inst.root,
        partIndex,
        parentOffset,
        emitterId: emitterIdSeed,
        blocking,
      };
      spawnedId = particleOwnerOn()
        ? await ownerRegistry.addEmitter(inst.guid >>> 0, this._worldParticleManager, req)
        : await this._worldParticleManager.addEmitter(req);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/hook-13] addEmitter(0x${emitterInfoId.toString(16)}) failed:`,
        e
      );
      return;
    }
    if (!spawnedId) return;
    // A11-S2: on-path the facade already tracks this emitter under the
    // guid owner — skip the legacy map (single registry of record).
    if (particleOwnerOn()) return;
    // Track for release-time cleanup (same map the PhysicsScript chain
    // walker uses at line ~4260).
    const guidU = inst.guid >>> 0;
    let ids = this._particleEmittersForGuid.get(guidU);
    if (!ids) {
      ids = [];
      this._particleEmittersForGuid.set(guidU, ids);
    }
    ids.push(spawnedId);
  }

  /**
   * Wave 7 (2026-05-28) — ReplaceObject (hookType 5) per-part mesh
   * swap. Replaces all child Meshes of `inst.parts[partIndex]` with
   * new Meshes built from `newGfxObjId`'s parts. Used by retail for
   * helm-on/helm-off, weapon-draw, equipment-change animations.
   *
   * Pipeline (mirrors the per-part loop in `_applyAppearanceHotSwap`
   * at line ~4166 but scoped to one part):
   *   1. `fetchBuildingPlacement(newGfxObjId)` — wasm-side GfxObj load
   *   2. `meshToGeometryGroups` — convert to {geometry, surfaceDid} groups
   *   3. Detach existing children of `inst.parts[partIndex]`
   *   4. Build new Meshes, attach to the same `partGroup`
   *   5. Preserve mixer bindings — the `THREE.Group` itself stays;
   *      `mixer` binds animation keyframes to `inst.parts[i].position`
   *      / `.quaternion`, both of which survive children swaps.
   *
   * Errors caught at the caller (`_fireHook`); this method may reject
   * if wasm fetch or geometry conversion throws.
   */
  async _fireReplaceObjectHook(inst, partIndex, newGfxObjId) {
    if (!inst.root) return; // released
    if (!Array.isArray(inst.parts) || partIndex >= inst.parts.length) return;
    const partGroup = inst.parts[partIndex];
    if (!partGroup) return;
    const ents_wasm = this.wasmExports;
    if (!ents_wasm || typeof ents_wasm.fetchBuildingPlacement !== "function") {
      return;
    }
    let bundle;
    try {
      bundle = await ents_wasm.fetchBuildingPlacement(newGfxObjId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/hook-5] fetchBuildingPlacement(0x${newGfxObjId.toString(16)}) failed:`,
        e
      );
      return;
    }
    if (!this.entityMap.has(inst.guid >>> 0)) {
      // entity released during await
      if (typeof bundle.free === "function") bundle.free();
      return;
    }
    if ((bundle.partCount | 0) === 0) {
      if (typeof bundle.free === "function") bundle.free();
      return;
    }
    const meshes = bundle.takePartMeshes();
    if (typeof bundle.free === "function") bundle.free();
    const wasmMesh = meshes[0];
    if (!wasmMesh) return;
    const adapter = await import("./adapter.js");
    const meshToGeometryGroups = adapter.meshToGeometryGroups;
    const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
    if (typeof wasmMesh.free === "function") wasmMesh.free();
    if (!groups || groups.length === 0) return;

    // Re-check liveness after the second await (adapter import).
    if (!this.entityMap.has(inst.guid >>> 0)) return;

    // Preload materials for any new surface DIDs not already in cache.
    // Fire-and-forget — the new Meshes start with the fallback material
    // for a few frames if the surface fetch is slow, which is a much
    // better UX than blocking the hook executor on the wait.
    if (surfaceDids?.length && this.materialCache &&
        typeof ents_wasm.fetch_surfaces_pixels === "function") {
      const newDids = surfaceDids.filter(
        (d) => !this.materialCache.materials.has(d >>> 0)
      );
      if (newDids.length > 0) {
        this.materialCache
          .preload(newDids, ents_wasm.fetch_surfaces_pixels)
          .catch(() => { /* fallback rendering will pick up */ });
      }
    }

    // Detach existing children. Batch 9 #11 (2026-06-07): dispose +
    // unregister any old child geometry that was itself produced by a
    // PRIOR ReplaceObject (tagged `userData.__disposable === true` below).
    // A rapid helm-on→helm-off→helm-on sequence previously leaked the
    // intermediate swapped-out geometries until entity despawn; freeing
    // them here keeps `renderer.info.memory.geometries` flat. We dispose
    // ONLY `__disposable`-tagged geometry — the original spawn meshes
    // carry the SHARED, UNtagged AnimationCache geometry (registered at
    // ~2089) which other entities on the same setupId still render, so it
    // MUST survive. We also drop those refs from `inst.geometries` so the
    // entity's own dispose() doesn't double-free (idempotent, but tidy).
    const oldChildren = partGroup.children.slice();
    for (const child of oldChildren) {
      // EQUIP-3 (2026-08-02): a ReplaceObject hook swaps THIS part's gfx —
      // it must not evict a wielded child mounted on the same part (a
      // right-hand ReplaceObject during a combat/emote clip would otherwise
      // orphan the weapon mid-swing). See `_isAttachedChildNode`.
      if (_isAttachedChildNode(child)) continue;
      partGroup.remove(child);
      const og = child.geometry;
      if (og && og.userData?.__disposable === true) {
        const idx = inst.geometries.indexOf(og);
        if (idx !== -1) inst.geometries.splice(idx, 1);
        try { og.dispose(); } catch (_) {}
      }
    }

    // Attach new Meshes — same per-group pattern as spawn (~line 1671)
    // and hot-swap (~line 4185).
    const guid = inst.guid >>> 0;
    for (const g of groups) {
      const did = g.surfaceDid >>> 0;
      let mat = null;
      if (inst._entityMaterials && inst._entityMaterials.has(did)) {
        mat = inst._entityMaterials.get(did);
      } else if (this.materialCache) {
        mat = this.materialCache.getCached(did, g.doubleSided);
      } else {
        mat = this._fallbackMaterial();
      }
      // Batch 9 #11 (2026-06-07): tag ReplaceObject geometry as entity-
      // OWNED so both the detach loop above (on a later swap) and the
      // entity's dispose() free it. Unlike the spawn path's SHARED
      // AnimationCache geometry, this geometry is built fresh from
      // `meshToGeometryGroups(wasmMesh)` for THIS entity only, so it is
      // safe (and necessary) to dispose. Merge to preserve any existing
      // userData (none today, but keep the convention's spread idiom).
      g.geometry.userData = {
        ...(g.geometry.userData || {}),
        __disposable: true,
      };
      const m = new THREE.Mesh(g.geometry, mat);
      m.name = `part_${partIndex}_surface_${did.toString(16)}_replaced`;
      m.userData = { guid, partIndex, surfaceDid: did, replaced: true };
      if (this.scene3d?.shadowsEnabled || this.scene3d?.csmEnabled) {
        m.castShadow = materialCanCastShadow(mat);
      }
      partGroup.add(m);
      inst.registerGeometry(g.geometry);
    }
    // Indoor-layer invariant — the replacement meshes default to layer 0.
    _stampEntityIndoorLayer(this.scene3d, partGroup);
    // ?partDegrade: retail SetPart loads the NEW GfxObj's degrade chain
    // (CPhysicsPart::LoadGfxObjArray). fetchBuildingPlacement does not fill
    // didDegrade, so look it up; the fresh meshes start visible meanwhile.
    partGroup.userData.didDegrade = 0;
    partGroup.userData.__degHidden = false;
    if (this._partDegrade && typeof ents_wasm.fetchModelDidDegrades === "function") {
      Promise.resolve(ents_wasm.fetchModelDidDegrades(new Uint32Array([newGfxObjId >>> 0])))
        .then((r) => {
          if (inst.parts && inst.parts[partIndex] === partGroup) {
            partGroup.userData.didDegrade = ((r && r[0]) ?? 0) >>> 0;
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Reap every live world entity but keep the manager REUSABLE for the
   * next session — unlike dispose(), which permanently tears the manager
   * down (sets _disposed, disposes the animationCache).
   *
   * Called when a session ENDS (ws disconnect / relogin): every entity
   * guid from the dead session is now invalid, and the next connection
   * re-streams a fresh ObjectCreate burst. Without this, the stale rigs
   * linger and the re-streamed objects — which ACE re-creates under FRESH
   * dynamic guids on each landblock load — stack on top of the old set
   * (the academy "two leather hats" double-spawn). The per-guid remove()
   * also tears down all per-entity driver state (MoveTo/pursuit/sticky/
   * remoteInterp live ON the instance), so no ghost drivers linger under
   * the unified pipeline either.
   *
   * Keeps the (session-agnostic) animationCache warm so the next session's
   * re-spawn doesn't pay a cold cache.
   */
  clearWorldEntities() {
    // Invalidate any in-flight spawns whose guid isn't mapped yet, so a
    // late `_spawnImpl` Step-E commit can't re-add a ghost after we clear.
    // (remove() below already bumps the generation for every MAPPED guid;
    // clearing `_spawnGen` afterward makes the captured gen mismatch for
    // the rest.)
    for (const g of this.spawnInFlight.keys()) {
      this._spawnGen.set(g, ((this._spawnGen.get(g) | 0) + 1) | 0);
    }
    for (const g of [...this.entityMap.keys()]) {
      try { this.remove(g); } catch (_) {}
    }
    this.entityMap.clear();
    this._nameToGuid.clear();
    this.spawnInFlight.clear();
    this._spawnGen.clear();
    // P4.3/LEAK-02 — the parks are keyed by the DEAD session's guid space.
    // ACE re-creates objects under fresh dynamic guids on reconnect, so a
    // surviving bucket can never be drained by a spawn; the legacy maps have
    // no sweeper at all, and the buffer's 25 s sweep only runs while `tick`
    // is live. Drop all three in lockstep with `entityMap`.
    this._pendingAttach.clear();
    this._preCreate.clear();
  }

  /**
   * Grace-aware stale-entity reaper. Removes entities whose landblock the
   * player left long enough ago (> ACE's 25 s ObjMaint grace) that ACE has
   * dropped them from this player's known set — at which point ACE re-sends
   * them via handle_visible_cells on re-entry, so culling is safe and
   * matches the retail client contract (ACE ObjectMaint.cs:41). This is the
   * SAFE replacement for the reverted landblock_lru.evict() cull, which
   * culled immediately on render eviction and so raced the grace (a portal /
   * PvP dungeon re-entry inside 25 s → invisible players).
   *
   * Per-entity `_lastNearMs` is refreshed whenever the entity is within
   * REAP_PVS_RADIUS LBs of the player (far wider than ACE's PVS, so nothing
   * ACE still tracks is ever beyond it). Only cross-world porting leftovers
   * age out. Self-throttled; safe to call every frame. `currentLbKey` is the
   * player's current landblock key (LB-LRU's getCurrentLbId()), or null.
   */
  reapStaleEntities(currentLbKey) {
    const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
    if (this._lastReapScanMs != null && now - this._lastReapScanMs < REAP_SCAN_INTERVAL_MS) {
      return;
    }
    this._lastReapScanMs = now;
    if (currentLbKey == null) return; // unknown player LB — never reap blind
    const cx = (currentLbKey >>> 24) & 0xff;
    const cy = (currentLbKey >>> 16) & 0xff;
    let localGuid = 0;
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        localGuid = (window.getLocalPlayerGuid() >>> 0) || 0;
      }
    } catch (_) { /* fall through with 0; the cheb guard still protects the player */ }

    let kill = null;
    for (const [guid, inst] of this.entityMap) {
      if ((guid >>> 0) === localGuid) continue; // never the local player
      const lbId = inst?.meta?.landblockId;
      if (lbId == null) continue;
      const lb = lbId >>> 0;
      if (lb === 0) continue; // wielded/contained — rides the player, no landblock
      // Bug 14: an item mounted on a wielder rides that wielder whatever
      // landblock it was spawned in (a pre-fix synthesized wield spawn carried
      // the wielder's landblock and was reaped ~30 s after a long port).
      if (inst?._attachedParentGuid != null) continue;
      const lx = (lb >>> 24) & 0xff;
      const ly = (lb >>> 16) & 0xff;
      const cheb = Math.max(Math.abs(lx - cx), Math.abs(ly - cy));
      if (cheb <= REAP_PVS_RADIUS) {
        inst._lastNearMs = now; // in/near PVS → keep, refresh the grace clock
        continue;
      }
      // Far from the player. Start the clock on first sighting-out (so a
      // newly-noticed far entity still gets a full grace), then reap once it
      // has been gone longer than ACE keeps it.
      if (inst._lastNearMs == null) { inst._lastNearMs = now; continue; }
      if (now - inst._lastNearMs > REAP_GRACE_MS) {
        if (!kill) kill = [];
        kill.push({ guid, age: now - inst._lastNearMs });
      }
    }
    if (kill) {
      if (REAP_DISPOSE_BUDGET_MS > 0) {
        // Continuous reap: most-stale-first, bounded by a wall-clock budget +
        // a count backstop; the remainder ages out on the next scan.
        kill.sort((a, b) => b.age - a.age);
        const start = (typeof performance !== "undefined") ? performance.now() : Date.now();
        let removed = 0;
        for (const { guid } of kill) {
          try { this.remove(guid); } catch (_) {}
          removed += 1;
          if (removed >= REAP_MAX_PER_SCAN) break;
          const nowMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
          if (nowMs - start > REAP_DISPOSE_BUDGET_MS) break;
        }
      } else {
        // Legacy unbudgeted bulk reap (`?entityReapBudgetMs=off`).
        for (const { guid } of kill) {
          try { this.remove(guid); } catch (_) {}
        }
      }
    }
  }

  /**
   * Drop every entity + clear the animation cache. Called on scene
   * teardown.
   */
  dispose() {
    // Batch 9 em-dispose (2026-06-07): mark disposed FIRST so any in-flight
    // `_spawnImpl` bails at its Step-E liveness guard instead of attaching
    // to a torn-down manager.
    this._disposed = true;
    // Route every live entity through `remove(g)` rather than the bare
    // `inst.dispose()`. The old loop disposed each rig's subtree but
    // LEAKED the manager-side bookkeeping `remove()` owns: particle
    // emitters (`_particleEmittersForGuid`), pending Sound/SoundTable/
    // CallPES timers (`_soundTimeoutsForGuid`), and entity-attached lights
    // still referenced in `scene3d.activeLights`. `remove()` mutates
    // `entityMap` as it goes, so snapshot the keys first. It also clears
    // the per-guid name/attach/sort-center/chain-resolve maps in lockstep.
    for (const g of [...this.entityMap.keys()]) {
      try { this.remove(g); } catch (_) {}
    }
    this.entityMap.clear();
    // B4 (2026-05-18): drop the name→guid index in lockstep with
    // entityMap so a re-init starts from a clean state. (remove() prunes
    // entries as it goes; clear() is a belt-and-suspenders no-op if empty.)
    this._nameToGuid.clear();
    this.spawnInFlight.clear();
    // Batch 9 #2 (2026-06-07): drop all spawn-generation tokens.
    this._spawnGen.clear();
    this.animationCache.dispose();
    if (this._sharedFallback) {
      try {
        this._sharedFallback.dispose();
      } catch (_) {}
      this._sharedFallback = null;
    }
  }
}
