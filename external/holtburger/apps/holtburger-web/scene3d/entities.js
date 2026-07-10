// 2026-05-21 — wire-agent mode (?wireframe=1) gate. Module-scope const
// matches the URL-parsing pattern other modules use. When true, the
// per-entity surface material at L977 swaps from MeshStandardMaterial
// (texture+PBR) to a shared MeshBasicMaterial({wireframe:true}) so
// entities render as wire silhouettes consistent with the rest of the
// scene in wire-agent mode.
const WIREFRAME_MODE = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("wireframe") === "1";
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

// F16-5 (bughunt 2026-06-09) — `?spawnHiddenState=on` opt-in. Default OFF →
// `setVisibility` no-ops on a not-yet-spawned guid exactly as before
// (byte-identical render). On → a visibility request for a guid whose rig is
// still async-building is queued in `_pendingVisibility` and applied when the
// rig spawns. Pairs with the wasm spawn-hidden kind=17 emit (same flag name);
// gating both behind the flag keeps the no-inst path inert when off. Same
// reader shape as `readEntityLightsFlag`.
function readSpawnHiddenStateFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("spawnHiddenState");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

// A8-M4 (2026-06-11 unification survey) — `?preCreateBuffer=on` opt-in.
// Default OFF → byte-identical: the per-kind `_pendingAttach` /
// `_pendingVisibility` maps keep their exact legacy behavior and every
// other pre-create event is dropped as before. On → events addressed to a
// guid whose rig isn't built yet park in ONE generic guid-keyed FIFO
// (`this._preCreate`, scene3d/pre_create_buffer.js), drained on spawn-commit
// and expired 25 s after the bucket's last enqueue — the retail null-object
// recovery (QueueBlobForObject acclient.c:310848-310860 + the 25.0 s
// destruction stamp :310666). DELIBERATE retail-parity widening under the
// flag: a kind=17 visibility for an unknown guid is buffered EVEN WITHOUT
// `?spawnHiddenState=on` (retail parks ALL netblobs for unknown guids; the
// per-kind opt-in was only ever a guard on the legacy map). The retail 20 s
// SendForceObjdesc nag (acclient.c:310302-310308) is NOT implemented — ACE
// support unresolved (ROADMAP bucket D). Same reader shape as
// `readEntityLightsFlag`.
function readPreCreateBufferFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("preCreateBuffer");
    return typeof v === "string" && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

// === Wave R3.A — remote-entity motion SMOOTHING (2026-05-28) ===
// `?deadReckon=on` opt-in. Default OFF → remote entities snap to each
// server-authoritative position exactly as before (byte-identical render).
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

// A2-P2 (2026-06-12, W3+ S8) — `?remoteInterp=on` opt-in (default OFF,
// pending 1070 eye-test). COMPOSITE flag: only meaningful alongside
// `?unifiedTick=on&wireStatePacks=stage1` (the wasm side warns + degrades
// otherwise, and no pose rows ever arrive, so this stays inert). When rows DO
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

// A5-P3 (2026-06-12, W3+ S13) — `?rootMotionObject=1` opt-in, default OFF.
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
const REAP_PVS_RADIUS = 8;
// Self-throttle for the full-entityMap scan (cheap, but no need per-frame).
const REAP_SCAN_INTERVAL_MS = 4000;

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
// inside the player. A fixed default for now; per-entity cyl-radii (mob radius
// + target radius) is a refinement.
const ENTITY_STICKY_STANDOFF_M = 1.3;

// F3-4b (2026-06-27, ?stickyGroundZ=on) — vertical gap (m) past which a sticky
// melee mob RELEASES its glue: the victim has left ground melee reach (jumped),
// so the mob should fall back to its server-driven grounded path and circle
// beneath rather than levitate after the airborne target (retail StickyManager
// is horizontal-only, z zeroed — acclient.c:388557; melee uses a 3D cylinder
// range — ACE Position.cs:100-114). ~melee cylinder reach; ACE MaxMeleeRange is
// 0.75 (radius-excluded) and a clear jump clears 1 m.
const STICKY_AIRBORNE_RELEASE_M = 1.0;

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
// driven smoothing keeps its existing fixed-K feel. Default OFF.
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

// Phase 7.4b — EntityManager: per-entity Object3D rig + AnimationMixer.
//
// Sister to the 2D path's `entityMap` + `tickEntityAnimations`
// (`index.html:3354 + 4483-4644`). Where the 2D path bakes pre-
// rasterized walk-cycle frames and swaps PIXI textures per rAF, the
// 3D path holds keyframes as `THREE.AnimationClip`s and runs one
// `AnimationMixer` per entity. Stance-keyed cycle map mirrors the 2D
// `EntityCycleSet`; cap of 4 actions per setup matches
// `MAX_BAKES_PER_SETUP = 4` (`index.html:2992`).
//
// Animations are rigid-body per-part (NOT skinned). The rig is a
// `THREE.Group` whose direct children are per-part `THREE.Group`s
// named `part_0..part_N` — those names match
// `AnimationCache.partNames` (Phase 7.4a) so each clip's
// `${partName}.position` / `${partName}.quaternion` tracks resolve.
// Per-part Mesh leaves (one per Surface DID, from
// `meshToGeometryGroups`) hang off their part Group so the animation
// translates the entire part as a unit — exactly how AC's wire format
// stores it.
//
// Spawn flow:
//   1. spawn(meta) is async — kicks `fetchEntityAnimationKeyframes`
//      via the AnimationCache. The cache returns rest-pose part
//      meshes + (optional) AnimationClip for the requested
//      (motionCommand, stance).
//   2. Build root Group at world coords (landblockId * 192 + meta.x);
//      build per-part Groups with Mesh children; resolve materials
//      via the shared MaterialCache. Stash on entityMap[guid].
//   3. If a clip resolved, mixer.clipAction(clip).play() — first cycle
//      starts immediately. STOP / 0 motion plays no clip (rest pose).
//
// Motion-switch flow (kind=5 UpdateMotion):
//   1. setMotion(guid, cmd, stance) — fire-and-forget async cache
//      lookup for the new (cmd, stance) key.
//   2. When the new clip resolves: crossFadeTo(newAction, 0.2) on the
//      currently playing action. If currentAction is null (was idle),
//      newAction.play() with a fadeIn(0.2). STOP transitions stop the
//      current action with a 0.2 s fade-out.
//   3. If the cache hits the per-setup cap of 4, the oldest unused
//      action is evicted (mixer.uncacheAction) before the new one
//      installs.
//
// Per-rAF tick(dt): walk every mixer, call mixer.update(dt). Cheap;
// the heavy lifting is in the keyframe interpolators inside
// AnimationMixer.
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
import { AnimationCache, cycleTimeScale, hasRootMotion } from "./animation.js";
// Routes the dyed/paletted entity-surface decode through the bake worker
// (off the main thread) with a transparent main-thread fallback.
// `surfacePixelsFetcher` does the same for the non-dyed entity surface
// preloads (statics decoder), matching the statics/buildings/cells offload.
import {
  entitySurfacePixelsFetcher,
  surfacePixelsFetcher,
} from "./bake_worker_client.js";
// Animation consolidation (docs/animation-audit §5): route attack swings through
// the RUST MotionSequence interpreter (full-body, retail-faithful, cargo-tested —
// src/motion_sequence.rs) instead of the mixer overlay that the locomotion cycle
// half-blends into the "upper-body-only swing" bug. The wasm `MotionSequence`
// class is read at runtime off `window.__hbWasm` (set during boot) so a stale
// pkg/ soft-degrades to the mixer overlay. `poseRigAt` is the JS-only per-part
// pose write (the one step that can't live in Rust). Default-OFF — enable with
// ?unifiedMotion=attack (or =on).
import { poseRigAt } from "./motion/motion_sequence.js";
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
// Inline flag read (NOT an imported helper) so module-load works in the
// source-eval headless harness that doesn't resolve ESM imports — the same
// inline-read pattern the other URL flags use. The wasm MotionSequence +
// poseRigAt are referenced only inside the flag-on runtime branches, so
// they're inert when off.
// `?unifiedMotion=<class>` selects which motion classes route through the Rust
// authority. W6 flip (2026-06-18, §9 class-by-class ruling): the bare default
// enables every class EXCEPT locomotion — locomotion carries the open B-1
// movement-integrator oscillation (Walk→Stop→Walk), so it stays behind explicit
// `?unifiedMotion=locomotion` / `=on` until B-1 lands. `=off` = all off (escape);
// `=on` = all incl. locomotion; `=<class>` = that class only.
const UNIFIED_MODE = (() => {
  try {
    const v = new URLSearchParams(
      (typeof window !== "undefined" && window.location && window.location.search) || "",
    ).get("unifiedMotion");
    return v == null ? "default" : String(v).toLowerCase();
  } catch (_) { return "default"; }
})();
// "default" = the W6 all-but-locomotion default; "on" = all classes incl. loco.
const UNIFIED_DEFAULT = UNIFIED_MODE === "default";
const UNIFIED_ATTACK = UNIFIED_DEFAULT || UNIFIED_MODE === "attack" || UNIFIED_MODE === "on";
const UNIFIED_DEATH = UNIFIED_DEFAULT || UNIFIED_MODE === "death" || UNIFIED_MODE === "on";
// Cast gestures live in `MotionTable.links` like swings — same one-shot path.
// Per-SPELL windup variation stays blocked (no prj_spell_id on the wire; ACE is
// kept vanilla), so this animates the real full-body cast GESTURE, not per-spell.
const UNIFIED_CAST = UNIFIED_DEFAULT || UNIFIED_MODE === "cast" || UNIFIED_MODE === "on";
// Doors open/close via On (0x4000000b) / Off (0x4000000c) CYCLE commands — 63 of
// 436 retail MTs carry them with hinge baked into the keyframes (no SetupModel
// hinge extraction needed; probe_door_motions.rs). Same one-shot path as missile.
const UNIFIED_DOOR = UNIFIED_DEFAULT || UNIFIED_MODE === "door" || UNIFIED_MODE === "on";
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
function isDoorStateMotion(cmd) {
  const low = (cmd >>> 0) & 0xffff;
  return low === (CMD_DOOR_ON & 0xffff) || low === (CMD_DOOR_OFF & 0xffff);
}
// Locomotion (walk/run/idle cycles) — the WORKING oracle, migrated LAST. Drives
// a CYCLIC MotionSequence with gait scaling + Rust phase carry across swaps.
// A one-shot (_unifiedSeq) suppresses _unifiedLoco during a swing, then resumes
// it on completion (single playhead — retail-faithful).
const UNIFIED_LOCO = UNIFIED_MODE === "locomotion" || UNIFIED_MODE === "on";
// Missile rides with attack (both Step 1): an aim-level fire is a CYCLE
// (class 0x40, in MotionTable.cycles) the links-only swing resolver can't reach.
const UNIFIED_MISSILE = UNIFIED_DEFAULT || UNIFIED_MODE === "missile" || UNIFIED_MODE === "attack" || UNIFIED_MODE === "on";
import { ensureNameplateForEntity } from "./nameplate_sprite.js";
// P6/R-6 (net-fixwave 2026-07-10) — entity program warm: per-spawn rig
// compileAsync (Step E) + the one-shot archetype-matrix warm armed on the
// local player's commit. See bake_prewarm.js for flags + rationale.
import { prewarmSubtree, scheduleArchetypeWarm, ENTITY_WARM_ON } from "./bake_prewarm.js";
import {
  materialCanCastShadow,
  SURFACE_TYPE,
  applySurfaceRenderState,
  readSurfaceUnifiedFlag,
  readLuminousEmissiveMapFlag,
  VFX_GLOBALS,
  installVfxComponentPatch,
  surfaceResultDecodeMisses,
  surfaceResultProvenAbsent,
} from "./materials.js";
import { drainPendingPlayEffects } from "./play_effect_vfx.js";
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
// Paletted twin of _entityFragMat: layer the SAME frag plan onto a DYED paletted
// base so itemFx / catalog effects reach dyed gear (the `_entityMaterials` path).
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
const RIG_MODULE_ON = readRigModuleFlag();
// FCULL (2026-06-08) — distance horizon for the per-frame entity RENDER
// cull. Only the constant is imported; the cull pass is driven from loop.js
// via `tickEntityRenderVisibility`.
import { CULL_DIST_SQ } from "./culling.js";
// A8-M4 (2026-06-12) — generic pre-create event buffer (retail null-object
// analog, `?preCreateBuffer=on`). Pure dependency-free module; ALL wiring
// and flag gating lives in this file (see readPreCreateBufferFlag above).
import { createPreCreateBuffer } from "./pre_create_buffer.js";

// T11 (2026-05-28) — `?velScale=on` gates velocity-scaled locomotion cycle
// speed (anti-ice-skating): the walk/run cycle's playback rate is scaled by
// actual ground speed / authored cycle speed (|MotionData.velocity|). Default
// OFF (eye-test-tuned gait change); read once at module load. try/catch for
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
// for a backstep (negative forward_speed). Default OFF: a backstepping remote
// otherwise moonwalks (forward walk anim while dead-reckoning backward). When
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
// fight the prediction. Default OFF pending a 1070 eye-test (cast timing/feel).
const CAST_SPEED = (() => {
  try {
    return (typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castSpeed")?.toLowerCase() !== "off")
      ? 2.0 : 1.0;
  } catch (_) {
    return 1.0;
  }
})();

// F8-4 (2026-06-09) — `?castStateMachine=on` (default OFF). A minimal client
// cast-state machine: while a cast is in flight, a REPEAT cast request for the
// same caster is ignored instead of restarting the windup animation every
// click (spam-clicking a target otherwise visibly "recasts" while the server
// is still executing the first cast). The busy window auto-expires (cap) so a
// dropped UseDone can't wedge casting; clearCastBusy / cancelCastSequence clear
// it early. Default OFF pending a 1070 eye-test (cast feel).
const CAST_STATE_MACHINE = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castStateMachine")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();

// OMEGA (2026-06-06) — `?cycleOmega=on` gates applying a cycle's authored
// MotionData.omega (continuous angular velocity) to the rig. Default OFF: a
// behaviour change that needs a 1070 eye-test on a real authored spinner
// (sign/fan) + a reachability scan (which in-scene MTs carry cycle omega).
// EXCLUDES turn-in-place cycles — their omega is the turn rate already driven by
// server heading / heading-ease, so applying it would double-count and break
// turning (the player MT TurnRight cycle carries omega [0,0,-1.5], confirmed via
// the wasm `cycleOmega` getter). Integrated in `_tickHookOmega` (summed with
// SetOmega hook omega). Harmless while OFF: no `_cycleOmega` is ever set, so all
// consumers see undefined and behaviour is byte-identical.
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
// instead of returning null. Default OFF pending a 1070 GPU eye-test.
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
// arrives). Default OFF pending a 1070 GPU eye-test.
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
// flight curves instead of flying constant-velocity. Default OFF
// (motion-adjacent visual) pending a 1070 GPU eye-test; inert for any
// pkg/ predating the `entityProjectileHasGravity` export (soft-guarded,
// wasm manifest v2).
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
// Survey A11-S0 (2026-06-11): retail `CreateBlockingParticleEmitter`
// (acclient.c:329528-329565) returns 0 and does NOT replace when the
// emitter id is already live — the opposite of the non-blocking
// `CreateParticleEmitter` replace path. Our walkers route hook type 26
// (CreateBlockingParticle) identically to 13 (CreateParticle) into the
// replace-semantics addEmitter, which restarts persistent effects retail
// would leave running. Behind a default-off flag so the legacy (replace)
// behavior is the off-path; on => hook 26 uses retail blocking semantics.
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
// rig + mixer + actions). Default OFF (respawn flicker + a behaviour change at
// distance). The spawn LOD distance frame-fix ships unconditionally; only the
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
// Render-completeness Waves-2 P3 (2026-05-29) — CallPES (AnimationHook
// type 19) is a RECURSIVE sub-script invocation: a PhysicsScript can call
// another PhysicsScript, which can call another, etc. (354 retail scripts
// carry CallPES). Cap the chain-walker recursion so a self-referential or
// cyclic script graph can't blow the stack / spawn-storm. 3 levels covers
// every retail script (none nest beyond 2); the walker bails past it.
const MAX_CALL_PES_DEPTH = 3;
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
// `?scriptQueue=on` (default OFF) routes the entity chain walker's hooks
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

// A5-P1 (2026-06-12, W3+ S5) — `?hookDrain=on` (default OFF) routes the
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
import { planHookWindows } from "./hook_windows.js";
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

// A4-Q2 (2026-06-12, W3+ S5) — `?mtQueue=on` (default OFF) wires one-shot
// overlay COMPLETION across the wasm boundary: when a tagged
// (`mtQueued`-played, see `_tryPlayLink`) overlay ends, JS calls
// `window.__notifyAnimationDone(guid, true)` → the wasm
// `notifyAnimationDone` export → that entity's `MotionTableManager`
// (A4/SA4F per-guid routing: local player → the A4-Q1 system queue,
// every guid → its registry MovementManager; retail per-OBJECT chain
// `AnimDoneHook::Execute` → `Hook_AnimDone` →
// `CPartArray::AnimationDone` → `MotionTableManager::AnimationDone`,
// acclient.c:342336 → :317087 → :325080 → :329873; success hard-coded 1
// on the renderer path, :317093). Eviction/stop of a tagged,
// not-yet-completed overlay notifies success=false (hang prevention —
// the Rust num_anims=1 node would otherwise never complete; exit-world
// drain analogy, acclient.c:329940-329947). NO current caller tags plays
// (the enqueue sources arrive with Stage-2 `?interpRig` / A3-D2); the
// tagging contract prevents counter poisoning (only pipeline-queued
// overlays may notify — acclient.c:329885-329894 is positional).
// Independently flippable from `?hookDrain` (a mixer `finished` listener
// is the fallback completion detector); full retail ORDERING parity needs
// both on. Typeof-guarded — a pre-v4 pkg soft-degrades to a no-op.
const MT_QUEUE_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return (
      new URLSearchParams(window.location.search)
        .get("mtQueue")?.toLowerCase() !== "off"
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
// fallback. Default OFF = byte-identical (0x33-only) behavior.
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

// A4-Q2 — the ONE notify gate (shared by the EntityManager completion
// path and EntityInstance eviction): only tagged keys, typeof-guarded
// bridge (`index.html` installs `window.__notifyAnimationDone` next to
// the SessionHandle). A4/SA4F (2026-06-12): the local-player guid gate
// is LIFTED — the wasm recv arm routes per-guid (retail per-OBJECT
// chain has no local filter, acclient.c:342336-342338). Counter
// poisoning stays guarded by the `_mtQueuedKeys` tagging contract
// (acclient.c:329885-329894 is positional); NO current caller tags
// plays, so remote notifies stay inert until the A3-D2 / ?interpRig
// enqueue-consumers land and tag remote one-shots.
function notifyMtQueuedOverlayDone(inst, key, success) {
  try {
    if (!MT_QUEUE_ON || !inst || !inst._mtQueuedKeys) return;
    if (!inst._mtQueuedKeys.has(key)) return;
    inst._mtQueuedKeys.delete(key);
    if (typeof window === "undefined") return;
    if (typeof window.__notifyAnimationDone === "function") {
      window.__notifyAnimationDone(inst.guid >>> 0, !!success);
    }
  } catch (_) { /* never block the tick on the notify */ }
}

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

// Same 4-bake-per-setup ceiling the 2D path enforces
// (`index.html:2992`). Without this, a creature flipping stances
// rapidly would accrete unbounded mixer actions; the cap evicts
// least-recently-used to bound memory.
const MAX_ACTIONS_PER_SETUP = 4;

// Cohere-B (2026-05-12): retail AC never crossfaded between motions.
// Each motion command (stance change, walk/run cycle swap, attack
// one-shot) was a hard cut — the next AnimSet's frame 0 replaced the
// previous AnimSet's last frame on the very next tick. PhatSDK
// PartArray.cpp:337-405 `advance_to_next_animation()` does an
// unconditional pointer swap with no blend state. Setting this to 0
// makes `crossFadeTo` and `fadeOutCurrent` short-circuit to a hard
// stop+play swap below, matching that retail behaviour. Per the dev
// dev chat 2026-05-12, "rotational interpolation never existed in
// retail. not on release, not at end of retail." — and the same is
// true of cycle-to-cycle blends.
const CROSSFADE_S = 0;

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

// RP2 (2026-06-08) — velocity-scale gait recompute throttle. The T11
// anti-ice-skating gait already low-pass-filters ground speed through an
// EMA (α=0.3), so recomputing `cycleTimeScale` + `setEffectiveTimeScale`
// every render frame is wasteful — the EMA barely moves between 60/144 fps
// frames. `?gaitHz=<hz>` caps the recompute to ~that rate (per entity, via
// a last-recompute timestamp). Default 0 → recompute every frame
// (byte-identical to pre-RP2: no timestamp is ever read). Only the gait
// MATH is throttled; the per-frame EMA position-delta sampling still runs
// every frame so the EMA stays accurate when a recompute does fire.
const GAIT_RECOMPUTE_HZ = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return 0;
    const v = new URLSearchParams(window.location.search).get("gaitHz");
    const n = v == null ? NaN : parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* Node / no window → default */ }
  return 0;
})();
const GAIT_RECOMPUTE_INTERVAL_MS = GAIT_RECOMPUTE_HZ > 0 ? 1000 / GAIT_RECOMPUTE_HZ : 0;

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
    const cullHidden = !want;
    if (inst._renderCullHidden !== cullHidden) {
      inst._renderCullHidden = cullHidden;
      _applyEntityVisible(inst);
    }
    if (cullHidden) culled += 1;
  }
  return { tested, culled };
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

// `_disposeMeshChildren` walks the rig with `.traverse()` and frees
// per-Mesh geometry + materials. FU3 (2026-05-18) — both dispose paths
// are now gated by `userData.__disposable === true`: geometry via an
// inline check (no shared "cache-owned" assertion needed because
// AnimationCache doesn't tag, so a missing tag is the expected
// "shared" signal), material via `_disposeMaterialIfOwned`. Call
// BEFORE `root.parent.remove(root)` so the traverse path is still
// intact.
function _disposeMeshChildren(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
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
  });
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
        // etc. to drive the AnimationMixer precisely.
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
 * Per-entity instance: one Object3D rig + one AnimationMixer.
 *
 * Owned by EntityManager.entityMap. Holds:
 *   - root: THREE.Group rooted at the entity's world position; named
 *     `entity_${guidHex}`.
 *   - parts: array of per-part Group children (length = setup.parts).
 *     Their `.position` / `.quaternion` are the channels animation
 *     clips drive.
 *   - mixer: THREE.AnimationMixer(root)
 *   - actions: Map<cacheKey, AnimationAction>. cacheKey is
 *     `AnimationCache.makeKey(setupId, mtableId, command, stance)`.
 *   - currentAction: the action currently playing (or null = rest).
 *   - currentActionKey: matching cacheKey, for crossfade lookup.
 *   - lastUseMs per actionKey for LRU eviction.
 *   - meta: original spawn meta (modelId, paletteId, etc.) so motion
 *     switches re-fetch with the same substitutions.
 */
class EntityInstance {
  constructor(guid, root, parts, mixer, meta) {
    this.guid = guid;
    this.root = root;
    this.parts = parts;
    this.mixer = mixer;
    this.actions = new Map();
    this.actionLastUsedMs = new Map();
    this.currentAction = null;
    this.currentActionKey = null;
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
    // Task E (2026-05-12) — AnimationMixer hook execution state.
    // The wasm `EntityAnimationData.takeHooks()` returns a
    // sorted-by-time list of `(time_in_clip_s, hook_type, hook_data)`
    // entries per resolved cycle (e.g. forge idle anim). We bake it on
    // first cache-miss for an action and re-bake on cache eviction.
    //
    // `hookTimelines`: cacheKey → Array<{time, hookType, soundWaveId,
    //   soundEnum, soundProbability, soundVolume, direction}>.
    //   Hooks beyond Sound (1) and SoundTable (2) are kept in the
    //   timeline so the per-frame executor can debug-log them, but
    //   only Sound/SoundTable land audio playback today (Task E
    //   scope — CreateParticle/SoundTweaked/etc. are follow-ons).
    // `actionLastHookTime`: actionKey → seconds-into-clip the
    //   per-tick executor last advanced past. Initialized to 0 on
    //   first play; reset to 0 when an action is .reset()'d. On wrap
    //   (currentTime < lastTime) the executor fires hooks in
    //   `[lastTime, clipDuration)` AND `[0, currentTime]`.
    /** @type {Map<string, Array<object>>} */
    this.hookTimelines = new Map();
    /** @type {Map<string, number>} */
    this.actionLastHookTime = new Map();
    // A5-P1b (2026-06-12, ?hookDrain=on) — deferred hook-fire queue:
    // `{kind:"hook", hook}` and `{kind:"animDone", key, action}` records
    // pushed during `_tickAnimationHooks` and drained at the END of the
    // per-instance tick body (retail add_anim_hook → process_hooks,
    // acclient.c:322063/:320035). Empty + untouched when the flag is off.
    /** @type {Array<object>} */
    this._hookFireQueue = [];
    // A4-Q2 (2026-06-12, ?mtQueue=on) — link-keys of overlays the wasm
    // pipeline queued (`_tryPlayLink` `mtQueued` option). ONLY these may
    // notify `notifyAnimationDone` (counter-poisoning guard); cleared on
    // completion/eviction. No current caller tags — enqueue sources
    // arrive with Stage-2 ?interpRig / A3-D2.
    /** @type {Set<string>} */
    this._mtQueuedKeys = new Set();
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
    // Wave 7 Phase 7.1 (2026-05-26): Walk-cycle phase preservation.
    // When `crossFadeTo` swaps off a locomotion clip, we stash the
    // departing action's `mixer.time` so a re-press within ~200ms can
    // resume the same cycle from mid-stride instead of restarting at
    // frame 0 (which makes the feet "pop").
    //
    // Key: cacheKey (the same string used by `actions` / `actionLastUsedMs`).
    // Value: { time: number /* clip.time at swap-out, seconds */,
    //          leftAt: number /* performance.now() ms */ }.
    //
    // Pruned in `tick(dt)` (entries older than 5s are dropped) and on
    // dispose(). Gate at the read site to `classifyMotionCommand ===
    // "walk"|"run"` — restart-from-mid-clip is wrong for swings/casts
    // (LoopOnce one-shots) and for the stance-Ready pose swap.
    /** @type {Map<string, { time: number, leftAt: number }>} */
    this._recentLocomotionTime = new Map();
  }

  registerGeometry(geom) {
    this.geometries.push(geom);
  }

  registerOwnedTexture(tex) {
    this.ownedTextures.push(tex);
  }

  registerOwnedMaterial(mat) {
    this.ownedMaterials.push(mat);
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

  /**
   * Promote `nextAction` to the currently-playing action with a
   * crossFade. `nextActionKey` is stamped so subsequent setMotion
   * calls can spot a no-op (same action already current).
   */
  crossFadeTo(nextAction, nextActionKey, durationS) {
    if (this.currentAction === nextAction) return;
    // Wave 7 Phase 7.1 (2026-05-26): stash the departing action's mixer
    // time so a same-key re-fetch within 200 ms can resume mid-stride.
    // We record ALL outgoing transitions (locomotion or otherwise) and
    // gate at the read site in `setMotion` to locomotion-only. Doing
    // both ends would scatter the gating logic; record cheap + filter
    // cheap-read is the simplest contract.
    if (this.currentAction && this.currentActionKey) {
      try {
        this._recentLocomotionTime.set(this.currentActionKey, {
          time: this.currentAction.time,
          leftAt: performance.now(),
        });
      } catch (_) {}
    }
    if (durationS <= 0) {
      // Cohere-B (2026-05-12): hard-cut path — retail had no blend
      // between motions. Stop the current action (drops it to weight 0
      // immediately) and start `nextAction` from wherever it was when
      // last stopped. Same shape as the catch-block fallback below,
      // but unconditional.
      //
      // Cohere-B follow-on (2026-05-12, "cycle-rewind"): deliberately
      // SKIP `nextAction.reset()`. three.js's `action.stop()`
      // preserves `.time`; `.reset()` zeroes it. The wasm integrator
      // currently overshoots the run target (Perf-B follow-on:
      // "25 m/s vs 4.5 m/s") and emits motion oscillation —
      // Walk → Stop → Walk → ... at sub-second cadence — even when
      // the player is holding W steady. Each transition hits this
      // hard-cut path; if we reset() the walk action's time on every
      // re-entry, the visible rig keeps rewinding to walk-cycle
      // frame 0, producing the "jutting back every 0.5-2 s" the user
      // reported. By preserving `.time`, a re-played action resumes
      // mid-cycle and the rig walks continuously across the
      // integrator's stutter. Brand-new actions have `.time = 0` by
      // construction so first-play is unaffected.
      if (this.currentAction) {
        try { this.currentAction.stop(); } catch (_) {}
      }
      nextAction.setEffectiveWeight(1.0);
      nextAction.setEffectiveTimeScale(1.0);
      nextAction.enabled = true;
      nextAction.play();
    } else if (this.currentAction) {
      // Live crossfade — fades current → new over `durationS`. Both
      // actions stay scheduled so the mixer interpolates between them
      // until the fade completes; then `currentAction` is .stop()'d
      // implicitly by its weight reaching 0. Retained for any future
      // caller that overrides the duration; current production path
      // uses `CROSSFADE_S = 0` and takes the hard-cut branch above.
      try {
        nextAction.reset();
        nextAction.setEffectiveWeight(1.0);
        nextAction.setEffectiveTimeScale(1.0);
        nextAction.enabled = true;
        nextAction.play();
        this.currentAction.crossFadeTo(nextAction, durationS, false);
      } catch (e) {
        // Fall back to a hard swap if crossFade hits an internal
        // assertion — usually means an action was uncached mid-flight.
        this.currentAction.stop();
        nextAction.reset();
        nextAction.play();
      }
    } else {
      // No action was playing — start fresh. Cohere-B follow-on:
      // skip `.reset()` for the same reason as the hard-cut path
      // above. Brand-new AnimationActions construct with `.time = 0`;
      // re-played actions resume from where they stopped, preventing
      // the walk-cycle rewind during integrator motion oscillation.
      if (durationS > 0) {
        nextAction.fadeIn(durationS);
      }
      nextAction.play();
    }
    this.currentAction = nextAction;
    this.currentActionKey = nextActionKey;
  }

  /**
   * Stop the current action with a fade-out. Sets `currentAction =
   * null`. Used on STOP commands and on respawn to reset to rest pose.
   */
  fadeOutCurrent(durationS) {
    if (!this.currentAction) return;
    // Wave 7 Phase 7.1 (2026-05-26): same swap-out stash as `crossFadeTo`
    // — STOP → re-press should also resume the previous walk cycle from
    // where it left off (e.g. tap W → release → re-press within 200 ms).
    if (this.currentActionKey) {
      try {
        this._recentLocomotionTime.set(this.currentActionKey, {
          time: this.currentAction.time,
          leftAt: performance.now(),
        });
      } catch (_) {}
    }
    if (durationS <= 0) {
      // Cohere-B (2026-05-12): hard-cut stop. Retail STOP commands
      // ended the current motion's cycle and held the rig at the
      // next-applicable default pose immediately. The PhatSDK
      // equivalent is to call `advance_to_next_animation()` to the
      // default (no fade-out state).
      try { this.currentAction.stop(); } catch (_) {}
    } else {
      try {
        this.currentAction.fadeOut(durationS);
        // Don't .stop() yet — fadeOut needs the mixer to keep the
        // action scheduled until weight hits 0. The mixer's tick will
        // implicitly stop it. Future reset() in crossFadeTo will reuse
        // the action.
      } catch (e) {
        try {
          this.currentAction.stop();
        } catch (_) {}
      }
    }
    this.currentAction = null;
    this.currentActionKey = null;
  }

  /**
   * Evict the least-recently-used cached action to keep the per-entity
   * action count under `MAX_ACTIONS_PER_SETUP`. Never evicts the
   * `currentActionKey` (mixer assertion would fire).
   */
  evictOldestUnused() {
    if (this.actions.size < MAX_ACTIONS_PER_SETUP) return;
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, ts] of this.actionLastUsedMs) {
      if (key === this.currentActionKey) continue;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const action = this.actions.get(oldestKey);
    if (action) {
      try {
        action.stop();
        this.mixer.uncacheAction(action.getClip(), this.root);
      } catch (_) {}
    }
    // A4-Q2 (?mtQueue=on) — CANCELLATION: evicting a tagged overlay that
    // never completed must still complete its Rust-side num_anims=1 node
    // (no JS→Rust truncation mirror exists; a missed completion is a
    // hung node forever). success=false by analogy to the exit-world
    // drain (acclient.c:329940-329947; spec S5 §6 OQ-2). A COMPLETED
    // overlay already cleared its key, so this is a no-op for it; the
    // whole call is a no-op when the flag is off / the set is empty.
    notifyMtQueuedOverlayDone(this, oldestKey, false);
    this.actions.delete(oldestKey);
    this.actionLastUsedMs.delete(oldestKey);
    // Task E (2026-05-12): drop the evicted action's hook timeline +
    // last-fire state. If the same (cmd, stance) is re-fetched later,
    // setMotion's cache-miss path will repopulate from the AnimationCache.
    this.hookTimelines.delete(oldestKey);
    this.actionLastHookTime.delete(oldestKey);
  }

  dispose() {
    // 2026-05-30 — mark disposed + cancel any pending spawn-race surface
    // refresh (see EntityManager._scheduleEntitySurfaceRefresh) so a late
    // re-decode can't touch a torn-down rig. R-8 (2026-07-09): ditto for the
    // dyed twin (_scheduleDyedSurfaceRefresh).
    this._disposed = true;
    if (this._surfaceRefreshTimer) {
      try { clearTimeout(this._surfaceRefreshTimer); } catch (_) {}
      this._surfaceRefreshTimer = null;
    }
    if (this._dyedRefreshTimer) {
      try { clearTimeout(this._dyedRefreshTimer); } catch (_) {}
      this._dyedRefreshTimer = null;
    }
    try {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    } catch (_) {}
    // Free in-flight wasm MotionSequences (?unifiedMotion) — the one-shot
    // (_unifiedSeq) and the locomotion cycle (_unifiedLoco) — so a despawn
    // doesn't leak the Rust-side allocations.
    if (this._unifiedSeq) {
      try { this._unifiedSeq.seq.free(); } catch (_) {}
      this._unifiedSeq = null;
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
    for (const t of this.ownedTextures) {
      try {
        t.dispose();
      } catch (_) {}
    }
    for (const m of this.ownedMaterials) {
      try {
        m.dispose();
      } catch (_) {}
    }
    this.actions.clear();
    this.actionLastUsedMs.clear();
    // Task E (2026-05-12): drop hook timeline state alongside the
    // mixer + actions.
    this.hookTimelines.clear();
    this.actionLastHookTime.clear();
    // Wave 7 Phase 7.1 (2026-05-26): drop locomotion-phase cache too.
    this._recentLocomotionTime.clear();
    this.currentAction = null;
    this.currentActionKey = null;
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
    // FU-1 (2026-06-11): wieldHandAttach — default-OFF opt-in that lets
    // attachChildToParent retry the holding-location resolve with
    // Quiver(5)→RightHand(1) for an ammo child whose ParentEvent location
    // was 0 (instead of mounting it at the wielder root / feet). index.js
    // overwrites this field after construction from a single URL parse;
    // initialise here so the field is never undefined when the manager is
    // built from a path that doesn't set it (e.g. the hello-cube capture).
    this._wieldHandAttach = false;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("wieldHandAttach");
        this._wieldHandAttach = (flag?.toLowerCase() === "on");
      }
    } catch (_) {}
    // wieldedSpawn (2026-06-11): default-OFF opt-in. The wasm side
    // synthesizes a KIND_SPAWN for a wielded child that has no world
    // presence (pack→wield / login-wielded) with its kind=7 attach in the
    // same drain batch — the attach parks in `_pendingAttach` until the rig
    // commits. The mount resolves async (holding-location fetch), so under
    // this flag `_spawnImpl` hides a rig whose own attach is pending at
    // commit time; `attachChildToParent` re-asserts state-visible on mount.
    // Mirrors the `_wieldHandAttach` pattern above (index.js overwrites
    // after construction from a single URL parse; initialise here so the
    // field is never undefined).
    this._wieldedSpawn = false;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("wieldedSpawn");
        this._wieldedSpawn = (flag?.toLowerCase() === "on");
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
    // Read the `?deadReckon=on` opt-in HERE (constructor) so every consumer
    // (`setPose`, `tick`) reads `this._deadReckonOn` — no cross-function flag
    // handoff (avoids the prior-wave ReferenceError where a flag was declared
    // in one function and read in another). Default OFF → the snap path in
    // `setPose` runs exactly as before (byte-identical), no target stored, no
    // tick smoothing.
    this._deadReckonOn = readDeadReckonFlag();
    // (2026-07-06) `?deathAnim=off` escape — death-collapse + corpse handoff.
    this._deathAnimOn = readDeathAnimFlag();
    // A2-P2 (2026-06-12, W3+ S8) — `?remoteInterp=on` (default OFF). Read
    // once HERE; consumed in `applyManagedPose` / `setPose` / `tick`.
    this._remoteInterpOn = readRemoteInterpFlag();
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
    // F16-5 (bughunt 2026-06-09) — spawn-time draw gate. `_pendingVisibility`:
    // guid → visible(bool) for a `setVisibility` that arrived before the rig
    // existed. The wasm spawn-hidden emit (`?spawnHiddenState=on`) sends a
    // kind=17 visibility:false in the same recv batch as the KIND_SPAWN, but
    // the rig builds async so the event lands first and `setVisibility` would
    // otherwise no-op on the missing guid. Queue it and flush on spawn — same
    // ordering-safe pattern as `_pendingAttach`.
    /** @type {Map<number, boolean>} */
    this._pendingVisibility = new Map();
    // A8-M4 (2026-06-12) — `?preCreateBuffer=on`: the generic guid-keyed
    // pre-create FIFO that REPLACES the two per-kind maps above when on
    // (they stay byte-identical when off). Drained from `_spawnImpl` via
    // `_drainPreCreate`, purged on `remove()`/`_detachChild`, swept for the
    // retail 25 s expiry at the tail of `tick(dt)`. Read the flag once here
    // (constructor) — same scope as every consumer (`setVisibility`,
    // `attachChildToParent`, `_spawnImpl`, `_detachChild`, `remove`,
    // `tick`), all of which read `this._preCreateBufferOn`.
    this._preCreateBufferOn = readPreCreateBufferFlag();
    this._preCreate = createPreCreateBuffer();
    // Rate-limit stamp for the once-per-second expiry sweep in tick(dt)
    // (same pattern as `_lastRecentLocomotionPruneMs`, but Date.now()
    // domain throughout — the buffer's enqueue stamps use its default
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
    // Wave 7 Phase 7.1 (2026-05-26): rate-limit the per-entity
    // `_recentLocomotionTime` prune to once per second. Each entry is
    // single-shot (deleted on consume), but if a player walks then
    // stops permanently, the cycle's last swap-out entry would sit
    // forever — the prune drops anything older than 5s. ms timestamp,
    // checked at end of `tick(dt)`.
    this._lastRecentLocomotionPruneMs = 0;
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
    const lodFetch = this.wasmExports?.fetch_entity_degrade_for_distance;
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
            const substitute = (await lodFetch(setupId, distance)) >>> 0;
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
    const paletteId = (meta.paletteId ?? 0) >>> 0;
    const subPalettes = meta.subPalettes ?? new Uint32Array(0);
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
    const bakeOpts = {
      modelChanges,
      textureChanges,
      paletteId,
      paletteSubsFlat: subPalettes,
      placementId,
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
        partGroups.push(conv);
        for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
        if (typeof partMesh.free === "function") { try { partMesh.free(); } catch (_) {} }
      }
    }

    const inst = new EntityInstance(guid, root, parts, null, meta);
    // T9 — dynamic-LOD bookkeeping: the full-detail setup this entity spawned
    // from + the degrade band it currently renders (0 = full detail). The
    // tick recheck re-queries the band at the live distance and respawns when
    // it crosses. `lodOriginalSetup` is captured BEFORE the spawn-time
    // substitution so the recheck always asks the band table from full detail.
    inst._lodOriginalSetup = lodOriginalSetup;
    inst._lodSub = lodSubstitute;

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
    // R-8 (net-fixwave 2026-07-09) — decode-audit capture for the dyed-path
    // recovery ladder armed at the bottom of this function. `decodeMisses`
    // (P2↔P3 ABI; 0 on legacy wasm) flags an incomplete walk even when every
    // part decoded non-empty: a soft-skipped palette overlay is TEXTURED but
    // undyed, invisible to the mapless-mesh probe.
    let dyedDecodeMisses = 0;
    const _spawnTraceMatStart = SPAWN_TRACE ? performance.now() : 0;
    // 2026-05-28 perf: wire-agent mode discards the texture from
    // fetchEntitySurfacesPixels anyway (per-DID wireframe materials
    // are palette-independent), so route wire spawns through the
    // cheaper cache.preload branch below. Real-mode entities still
    // take the palette path so their dyed surfaces look right.
    if (hasPaletteSubs && !WIREFRAME_MODE && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          // Wave 7.7 — dye observability. Fires for every spawn that
          // arrives with non-trivial palette overlays (W7.3 server-
          // pushed dyes + any local applyAppearance preview). Captures
          // the (guid, surfaceDids, paletteId, subPalettes) triple so
          // the diag harness can audit which entities ARE actually
          // paying the dye compositor cost vs spawning with empty
          // overlays. Fires BEFORE the wasm call so we observe even
          // when the call throws.
          try {
            window.__diag?.clothing?.onDyeApplication?.({
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
          const entityMaterials = new Map();
          const missDids = [];
          const missIdx = [];
          if (this.materialCache && !WIREFRAME_MODE) {
            for (let i = 0; i < dids.length; i += 1) {
              const did = dids[i] >>> 0;
              const cached = this.materialCache.getCachedPaletted(did, paletteId, subPalettes);
              if (cached) {
                entityMaterials.set(did, cached);
              } else {
                missDids.push(did);
                missIdx.push(i);
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
              subPalettes
            );
            // R-8 — call-level decode audit (both fields null/0 on legacy
            // wasm). Proven-absent DIDs seed the per-entity skip set so the
            // dyed ladder never re-hammers a catalog-confirmed absence.
            dyedDecodeMisses = surfaceResultDecodeMisses(results) ?? 0;
            const absent = surfaceResultProvenAbsent(results);
            if (absent && absent.size) {
              inst._dyedSurfaceAbsent = new Set(absent);
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
              // `_materialFromFlags`. Without this, dyed luminous/translucent/
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
      }
    } else if (allSurfaceDids.size > 0 && this.materialCache) {
      // Cache hit / miss flows through the shared cache. Preload via
      // the bulk path so all DIDs land in one wasm round-trip.
      try {
        await this.materialCache.preload(
          [...allSurfaceDids],
          surfacePixelsFetcher(this.wasmExports)
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
    // MaterialCache.getCachedVariantFromPaletted), so dyed/recoloured gear gets the
    // aura too — previously the paletted branch returned the base verbatim, which is
    // why dyed magic items showed no glow despite the effects being default-on.
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
        // Dyed/paletted gear no longer skips the VFX plan: layer the same
        // _entityPlan (itemFx aura + catalog effects) onto a clone of the dyed
        // base. Keyed per dye × effect-SET so colours stay correct and programs
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
    const wz = _groundClampZ(wx, wy, meta.z ?? 0, inst._outdoorCellIdx);
    inst.setPose(wx, wy, wz, meta.qw ?? 1, meta.qx ?? 0, meta.qy ?? 0, meta.qz ?? 0);
    // #9 (2026-06-07): remember the entity's authored base scale so the
    // generic jump pose can multiply through it instead of stomping x/y/z
    // back to 1.0 (which collapsed scaled creatures mid-jump). Defaults to
    // 1.0 for the common objScale==1 path → byte-identical transforms.
    inst._baseScale = (meta.objScale && meta.objScale > 0) ? meta.objScale : 1.0;
    if (inst._baseScale !== 1) {
      root.scale.setScalar(inst._baseScale);
    }

    // Step D: AnimationMixer + initial action.
    const mixer = new THREE.AnimationMixer(root);
    inst.mixer = mixer;
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
    if (initialClip) {
      const cacheKey = AnimationCache.makeKey(
        setupId,
        mtableId,
        initialMotion,
        resolvedStance || initialStance
      );
      const action = mixer.clipAction(initialClip);
      // Door/chest state motions (On/Off) HOLD their open/closed pose; idle/walk/
      // run cycles loop. Without this, a chest/door spawning with Off(closed) /
      // On(open) loops its open↔close cycle forever (see isDoorStateMotion).
      const _holdState = isDoorStateMotion(initialMotion);
      action.setLoop(_holdState ? THREE.LoopOnce : THREE.LoopRepeat, _holdState ? 1 : Infinity);
      action.clampWhenFinished = _holdState;
      action.enabled = true;
      inst.actions.set(cacheKey, action);
      inst.actionLastUsedMs.set(cacheKey, performance.now());
      // Task E (2026-05-12): stash the cycle's hook timeline alongside
      // the action. The animation cache already snapshotted hooks to
      // plain POJOs and `animEntry.hooks` is sorted-by-time-asc.
      // Reused across mixers (multiple entities sharing this clip see
      // the same timeline array — safe, the executor's state lives
      // per-entity in `actionLastHookTime`).
      if (Array.isArray(animEntry.hooks) && animEntry.hooks.length > 0) {
        inst.hookTimelines.set(cacheKey, animEntry.hooks);
        // -1 epoch (2026-07-02): the range walker fires (last, cur] — a 0
        // seed permanently skips hooks at t=0.0 (retail fires the entry
        // frame's hooks on the first advance; door open sounds sit at t=0).
        inst.actionLastHookTime.set(cacheKey, -1);
      }
      // Auto-play locomotion (walk/run) AND the Ready idle cycle at spawn.
      // Render-completeness audit (2026-05-29): lib.rs now defaults
      // animatable spawns (mtable_id != 0) to Ready (0x41000003), which
      // classifyMotionCommand maps to "idle". The action above is already
      // configured LoopRepeat, so idle just needs to start — this is what
      // makes standing NPCs/vendors/players breathe and sway instead of
      // standing frozen at the rest pose. One-shot attack/cast commands are
      // never the spawn-initial motion and stay gated out. Entities with no
      // MotionTable spawn with motion=0 → cls === null → no idle attempt.
      const cls = classifyMotionCommand(initialMotion);
      if (cls === "walk" || cls === "run" || cls === "idle") {
        action.play();
        if (_holdState) {
          // Snap to the final (resting) frame so the door/chest shows its
          // open/closed pose immediately, without a one-shot swing on spawn.
          // clampWhenFinished holds it there. (Since the 2026-07-02 wasm
          // hold-bake fix, a framerate-0 state cycle is a single-frame clip
          // — Off holds the closed frame, On the open frame — so this snap
          // is a no-op kept for pre-rebuild pkg/ compatibility.)
          action.time = initialClip.duration || 0;
          // Seed the motion-state memory with the spawn state so the FIRST
          // server Motion broadcast (e.g. Use → On) resolves its MotionTable
          // LINK (Off→On = the authored opening swing; On→Off = the same
          // anim at negative framerate, baked reversed) instead of snapping.
          inst.lastMotionCommand = initialMotion >>> 0;
        }
        inst.currentAction = action;
        inst.currentActionKey = cacheKey;
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
    // (2026-07-06) A corpse CreateObject (ODF Corpse bit) arrives right after a
    // creature's Dead motion + delete. Correlate it to the collapsing creature
    // so the corpse stays hidden until the death animation finishes and reveals
    // at the exact death transform (fixes the "corpse in a slightly different
    // spot" + "corpse appears before the animation is done" pair).
    if (this._deathAnimOn && ((meta.objDescFlags >>> 0) & ODF_CORPSE) !== 0) {
      try { this._tryCorpseDeathHandoff(inst); } catch (_) { /* handoff is best-effort */ }
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
    {
      const lvx = +(meta.vx ?? 0);
      const lvy = +(meta.vy ?? 0);
      const lvz = +(meta.vz ?? 0);
      if (lvx * lvx + lvy * lvy + lvz * lvz > 1e-4 && this.isProjectile(guid)) {
        inst.lastVel = { vx: lvx, vy: lvy, vz: lvz, omegaZ: 0 };
        inst.lastVelMs =
          typeof performance !== "undefined" ? performance.now() : 0;
        inst._ballistic = true;
        // G-4 (?projectileGravity=on): arc the flight for gravity-class
        // missiles. Sampled once at spawn (classification is spawn-static).
        inst._ballisticGravity =
          PROJECTILE_GRAVITY_ON && this.projectileHasGravity(guid);
      }
    }
    // Track B2 (motion-audit, 2026-06-09): replay any PlayEffects that raced
    // ahead of this spawn (queued by guid when the target was not yet in the
    // entityMap). No-op if none queued.
    drainPendingPlayEffects(this, guid);
    // Spawn-race recovery (2026-05-30): if a surface's DAT resources had not
    // yet streamed from the server when this entity spawned, its decode
    // returned empty and the mesh got the shared flat-grey fallback material
    // — the reported "white door / chest" (WB.Terminal confirmed the surface
    // DATA is correct; the decode just lost the spawn race and the material
    // was never refreshed). Detect any mesh still on the fallback and schedule
    // a deferred re-decode + material swap once the resources arrive. Gated to
    // NON-dyed entities (paletteId/subPalettes empty) so the plain re-decode
    // can't strip a dye; dyed entities are rarer and left as-is.
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
    // R-8 (net-fixwave 2026-07-09) — dyed-path twin of the recovery arm above.
    // Players/dyed NPCs take the fetchEntitySurfacesPixels path, which the
    // `!hasPaletteSubs` gate excludes — one swallowed prefetch round (empty
    // parts) or an incomplete walk (`decodeMisses > 0`) whitened the whole
    // outfit with no recovery until respawn. A parameter-preserving refetch
    // (identical DIDs + palette state) cannot strip the dye, so schedule one
    // on the same backoff ladder. Mapless probe mirrors the plain arm; the
    // decodeMisses arm additionally catches textured-but-undyed parts.
    if (
      hasPaletteSubs &&
      !WIREFRAME_MODE &&
      typeof this.wasmExports?.fetchEntitySurfacesPixels === "function"
    ) {
      let needsRefresh = dyedDecodeMisses > 0;
      if (!needsRefresh) {
        root.traverse((o) => {
          if (!needsRefresh && o.isMesh && o.material && !o.material.map &&
              o.userData && o.userData.surfaceDid != null) {
            needsRefresh = true;
          }
        });
      }
      if (needsRefresh) {
        this._scheduleDyedSurfaceRefresh(inst, {
          paletteId,
          subPalettes,
          dids: new Uint32Array([...allSurfaceDids]),
          missArmed: dyedDecodeMisses > 0,
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
    if (this._preCreateBufferOn) {
      // A8-M4 (2026-06-12) — spawn-commit drain of the generic pre-create
      // buffer (retail: object creation replays the placeholder's queued
      // netblobs in arrival order). Subsumes BOTH legacy flushes below;
      // their maps stay empty under the flag (no enqueue site feeds them).
      this._drainPreCreate(guid);
    } else {
      // Render-completeness audit (2026-05-29) — flush any wielded-item attach
      // that arrived before this rig (or its counterpart) existed. Covers both
      // roles: this entity may be a child waiting for its wielder, or a wielder
      // whose children are queued. Fire-and-forget (resolves holding frame async).
      this._flushPendingAttach(guid);
      // F16-5 (2026-06-09) — apply any spawn-time draw gate that raced ahead
      // of this rig. The wasm spawn-hidden emit (`?spawnHiddenState=on`) queued
      // a visible:false here in `_pendingVisibility`; re-route through
      // `setVisibility` now that the rig is in `entityMap` so the same
      // attached-child / render-cull composite guards apply. No-op when nothing
      // queued (flag off, or a normally-visible spawn).
      if (this._pendingVisibility.size > 0 && this._pendingVisibility.has(guid)) {
        const wantVisible = this._pendingVisibility.get(guid);
        this._pendingVisibility.delete(guid);
        this.setVisibility(guid, wantVisible);
      }
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
    if (
      this._entityLightsOn &&
      this.wasmExports &&
      typeof this.wasmExports.fetchSetupModelLights === "function"
    ) {
      this._attachEntityLights(inst, setupId).catch((e) => {
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
   * the mesh once they resolve, retrying with backoff. Plain (non-dyed) path
   * only — the caller gates on `!hasPaletteSubs` so a plain re-decode can
   * never strip a dye.
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
   * R-8 (net-fixwave 2026-07-09) — cancel a pending dyed-surface refresh.
   * Called on appearance change (`_applyAppearanceHotSwap`): the captured
   * palette state is stale then, and the swap re-fetches + re-arms itself.
   * Despawn/respawn cancels via `EntityInstance.dispose()` (timer clear) +
   * the ladder's `entityMap.get(guid) !== inst` guard.
   */
  _cancelDyedSurfaceRefresh(inst) {
    if (!inst) return;
    if (inst._dyedRefreshTimer) {
      try { clearTimeout(inst._dyedRefreshTimer); } catch (_) {}
      inst._dyedRefreshTimer = null;
    }
    inst._dyedRefreshKey = null;
  }

  /**
   * R-8 (net-fixwave 2026-07-09) — dyed-path twin of
   * `_scheduleEntitySurfaceRefresh` above. The plain ladder is gated
   * `!hasPaletteSubs` (a plain re-decode would strip a dye), so every player
   * (skin/hair subPalettes) and recoloured NPC had NO recovery: one transient
   * empty decode in the single fetchEntitySurfacesPixels call painted the
   * whole outfit with the mapless grey fallback until respawn. The safe
   * retry is a PARAMETER-PRESERVING refetch — identical DIDs + (paletteId,
   * subPalettes) — which by construction cannot strip the dye.
   *
   * `spec` = { paletteId, subPalettes, dids: Uint32Array (the spawn's full
   * surface-DID set), missArmed: bool }. Normally only the still-mapless
   * DIDs are refetched (checking the shared paletted cache first); the one
   * `missArmed` sweep — armed when the spawn/hot-swap fetch reported
   * `decodeMisses > 0` (P2↔P3 ABI) — refetches the full set and, once a
   * COMPLETE decode lands (refetch decodeMisses === 0), also swaps textured
   * meshes: a soft-skipped palette overlay leaves a textured-but-undyed
   * material the mapless probe can't see. Same backoff schedule, liveness
   * guards, and stop-when-healed shape as the plain ladder, plus:
   *   - per-entity dedupe (`_dyedRefreshTimer` — one ladder per rig);
   *   - appearance supersession (`_dyedRefreshKey` — hot-swap cancels);
   *   - `_dyedSurfaceAbsent` skip set (catalog-proven absences never retry).
   * Healed materials install via `installPaletted` so every later entity
   * with the same dye signature is a cache hit (and a signature poisoned by
   * an incomplete decode is replaced for future spawns).
   */
  _scheduleDyedSurfaceRefresh(inst, spec, attempt = 0) {
    const DELAYS_MS = [600, 1500, 3500, 8000, 16000, 32000, 60000, 90000];
    if (!inst || !inst.root || !spec || attempt >= DELAYS_MS.length) return;
    if (typeof this.wasmExports?.fetchEntitySurfacesPixels !== "function") return;
    if (inst._dyedRefreshTimer) return; // per-entity dedupe — one ladder at a time
    const paletteId = (spec.paletteId ?? 0) >>> 0;
    const subPalettes = spec.subPalettes ?? new Uint32Array(0);
    const key = `${paletteId}|${Array.from(subPalettes).join(",")}`;
    if (attempt === 0) inst._dyedRefreshKey = key;
    const needsTex = (mat) => !!mat && !mat.map;
    const skipAbsent = (did) =>
      !!(inst._dyedSurfaceAbsent && inst._dyedSurfaceAbsent.has(did >>> 0));
    inst._dyedRefreshTimer = setTimeout(async () => {
      inst._dyedRefreshTimer = null;
      // Same liveness guards as the plain ladder, plus appearance
      // supersession: a hot-swap cleared/replaced the key meanwhile.
      if (inst._disposed || this.entityMap.get(inst.guid) !== inst) return;
      if (inst._dyedRefreshKey !== key) return;
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
        inst._dyedRefreshKey = null; // every dyed surface resolved
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
      if (inst._dyedRefreshKey !== key) return;
      const refetchMisses = surfaceResultDecodeMisses(results);
      const absent = surfaceResultProvenAbsent(results);
      if (absent && absent.size) {
        if (!inst._dyedSurfaceAbsent) inst._dyedSurfaceAbsent = new Set();
        for (const d of absent) inst._dyedSurfaceAbsent.add(d >>> 0);
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
            // Sweep: replace possibly-undyed textured parts too — but never
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
        this._scheduleDyedSurfaceRefresh(
          inst, { ...spec, missArmed: missStill }, attempt + 1
        );
      } else {
        inst._dyedRefreshKey = null;
      }
    }, DELAYS_MS[attempt]);
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
   * dyed gear rendered flat-opaque and non-emissive. This replicates the
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
    // `applySurfaceRenderState` (materials.js) so the dyed/paletted path and the
    // cache path run ONE decoder. This ALSO attaches the luminous emissiveMap
    // (the diffuse-recoloured map, `mat.map`) — the resolved reading that fixes
    // dyed luminous gear washing to white (A10 §3 row 2; ROADMAP §7 item 2).
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
      // `_materialFromFlags` (materials.js:1768) so a dyed/paletted glow
      // blends identically to its un-dyed twin; otherwise the palette path
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
      // Binary alpha mask (foliage, fences) — alphaTest cuts alpha=0 frags.
      mat.alphaTest = 0.5;
      mat.transparent = false;
    }
    if (sfLuminosity > 0) {
      // Self-illumination driven by the luminosity FLOAT (not the 0x40 bit).
      // LEGACY (?surfaceUnified off): flat grayscale emissive with NO
      // emissiveMap. NOTE — this is the WRONG reading: retail's grayscale
      // emissive is MODULATED by the diffuse texture in the FF combiner
      // (acclient.c:454691-454697 + 454429-454432), so omitting the emissiveMap
      // washes a COLOURED dyed-luminous surface to white (A10 §3 row 2). The
      // correct reading (emissiveMap = mat.map) lives in
      // `applySurfaceRenderState` (materials.js) and is taken when
      // `?surfaceUnified=on`. Kept here only for byte-identical flag-off
      // rollback. Clamp to (0, 2] (ACE ~[0,1] with occasional HDR pushes).
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = Math.min(2.0, sfLuminosity);
      // R1 (2026-06-24, `?luminousEmissiveMap`): attach the (recoloured)
      // diffuse map as emissiveMap so a COLOURED dyed-luminous surface glows
      // in-colour (FF texture×emissive) instead of washing to white — the same
      // resolved reading `?surfaceUnified` takes, as a narrow opt-in. The
      // non-dyed cache path already does this (applyFloatLumDiffuse:1284), so the
      // emissiveMap program variant already exists (no net new program expected).
      // Default OFF = byte-identical (flat white).
      if (readLuminousEmissiveMapFlag() && mat.map) mat.emissiveMap = mat.map;
    }
    // Diffuse-reflectance albedo tint — parity with _materialFromFlags
    // (materials.js:1839; retail acclient.c:454458). No-op at d≈1 (~96% of
    // surfaces); dims the d≠1 minority. Multiplies with the (recolored) map.
    // C1 originally omitted this, so paletted/dyed gear skipped the dim that
    // the plain path applies.
    if (sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
      mat.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
    }
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
    inst._wasmDriven = REMOTE_INTERP_OWNERSHIP_FRAMES;
    inst.root.position.set(x, y, z);
    let tgt = inst._serverTargetPos;
    if (!tgt) tgt = inst._serverTargetPos = new THREE.Vector3();
    tgt.set(x, y, z);
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
      // F16-5 (2026-06-09): the rig isn't built yet. Under
      // `?spawnHiddenState=on` the wasm spawn-hidden emit (kind=17
      // visible:false) lands before the async spawn completes — remember
      // the desired visibility so `spawn()` can apply it once the rig
      // exists, instead of dropping it. Off → no-op as before.
      // A8-M4 (2026-06-12): under `?preCreateBuffer=on` ALL pre-create
      // visibility events buffer in the generic FIFO — retail parks every
      // netblob for an unknown guid (QueueBlobForObject), so the
      // `?spawnHiddenState` per-kind opt-in is subsumed here. Appended (not
      // last-write-wins): the FIFO replay at spawn applies them in arrival
      // order and setVisibility is synchronous, so the last one wins anyway.
      if (this._preCreateBufferOn) {
        this._preCreate.enqueue(g, "visibility", { visible: !!visible });
        return;
      }
      if (readSpawnHiddenStateFlag()) this._pendingVisibility.set(g, !!visible);
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
      // A8-M4 (2026-06-12): under `?preCreateBuffer=on` park in the generic
      // buffer instead, keyed by CHILD guid (the parent-side unblock is the
      // `_drainPreCreate` scan, mirroring `_flushPendingAttach`).
      // `dedupeKind` preserves the legacy Map's last-write-wins: two parked
      // attaches would race their async holding-location resolves on drain.
      if (this._preCreateBufferOn) {
        this._preCreate.enqueue(cGuid, "attach", {
          parentGuid: pGuid,
          location: location >>> 0,
          placement: placement >>> 0,
        }, { dedupeKind: true });
        return;
      }
      this._pendingAttach.set(cGuid, {
        parentGuid: pGuid,
        location: location >>> 0,
        placement: placement >>> 0,
      });
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
    const c = this.entityMap.get(cGuid);
    const p = this.entityMap.get(pGuid);
    if (!c || !c.root || !p || !p.root) return;
    // Mount point: the wielder part the holding location names, else root.
    let mount = p.root;
    if (loc && p.parts && loc.partId >= 0 && loc.partId < p.parts.length) {
      mount = p.parts[loc.partId];
    }
    if (c.root.parent) c.root.parent.remove(c.root);
    mount.add(c.root);
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
    // A8-M4 (2026-06-12): cancel ONLY a parked attach for this child (a
    // parked visibility event must survive a detach, exactly as
    // `_pendingVisibility` did). No-op when the flag is off (buffer empty).
    this._preCreate.removeMatching((g, ev) => g === cGuid && ev.kind === "attach");
    const c = this.entityMap.get(cGuid);
    if (!c || !c.root) return;
    const parentGuid = c._attachedParentGuid;
    if (parentGuid != null) {
      const p = this.entityMap.get(parentGuid >>> 0);
      if (p && p._attachedChildren) p._attachedChildren.delete(cGuid);
    }
    if (c.root.parent) c.root.parent.remove(c.root);
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
    let i = 0;
    while (i < dids.length) {
      // Tiny per-slice budget: warm a couple of scripts, then yield so the
      // synchronous wasm DAT parses never accumulate into a frame stall.
      const budgetEnd =
        (typeof performance !== "undefined" ? performance.now() : 0) + 3;
      do {
        const scriptDid = dids[i++];
        let ps;
        try { ps = await wasm.fetchPhysicsScript(scriptDid); } catch (_) { continue; }
        if (!ps || typeof ps.takeEntries !== "function" || !canFetchEmitter) continue;
        let entries;
        try { entries = ps.takeEntries(); } catch (_) { continue; }
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (e.hookType !== 13 && e.hookType !== 26) continue;
          const emitterDid = (e.createParticleEmitterId >>> 0);
          if (emitterDid !== 0) {
            try { await wasm.fetchParticleEmitter(emitterDid); } catch (_) { /* warm-only */ }
          }
        }
      } while (
        i < dids.length &&
        (typeof performance !== "undefined" ? performance.now() : 0) < budgetEnd
      );
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
    if (next === 0) return;
    const inst = this.entityMap.get(next);
    if (!inst || !inst.root) {
      this._selectedGuid = 0;
      return;
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
  async playCastSequence(guid, spellId) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // Fallback path A: missing spellId → vibe-pose.
    if (!spellId) {
      // WS-B teardown (2026-06-18): setCastPose vibe-pose fallback removed.
      // The real path is playCastSequence's ACE-derived gesture chain; when
      // it falls through (no spellId / table not loaded / no setSwingMotion),
      // the entity plays NO fallback gesture (the pose was a placeholder).
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
      return;
    }
    // Fallback path C: setSwingMotion not available (defensive — the
    // melee/missile path has the same guard around `setSwingMotion`).
    if (typeof this.setSwingMotion !== "function") {
      // WS-B teardown (2026-06-18): setCastPose vibe-pose fallback removed.
      // The real path is playCastSequence's ACE-derived gesture chain; when
      // it falls through (no spellId / table not loaded / no setSwingMotion),
      // the entity plays NO fallback gesture (the pose was a placeholder).
      return;
    }
    // F8-4 — cast-state-machine gate. While a cast is in flight, ignore a
    // repeat request for the same caster (don't restart the windup). The busy
    // window is sized to the chain's own duration (capped) so it can't wedge.
    if (CAST_STATE_MACHINE) {
      const nowMs = performance.now();
      if (inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
        return; // already casting — ignore the recast
      }
      let estMs = 0;
      for (const gz of (seq.windupGestures || [])) estMs += (+gz.durationS || 0.6) * 1000;
      if (seq.castGesture) estMs += (+seq.castGesture.durationS || 0.6) * 1000;
      inst._castBusyUntilMs = nowMs + Math.min(12000, estMs / CAST_SPEED);
    }
    // Cancellation token. Bump on every chain start; subsequent
    // awaits compare against this snapshot to detect "a newer cast
    // started, bail out".
    const token = ((inst._castSequenceToken | 0) + 1) | 0;
    inst._castSequenceToken = token;
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
      try {
        // setSwingMotion is async (animation cache fetch) but we don't
        // `await` it — the per-gesture sleep below is what paces the
        // chain. Awaiting setSwingMotion would compound its internal
        // latency on top of the spell's wall-clock duration.
        // F8-1: pace the clip at CastSpeed (×2 under ?castSpeed), and record
        // the prediction so the server's matching 2× windup echo is skipped
        // (consumeLocalSwingEcho in loop.js) instead of fighting/restarting it.
        this.setSwingMotion(g, motionU32, { speed: CAST_SPEED });
        if (CAST_SPEED !== 1.0) this.noteLocalSwingPrediction?.(motionU32);
      } catch (_) { /* never block the chain on a single gesture fail */ }
      // F8-1: shorten each gesture's wall-clock by CastSpeed so the chain's
      // total duration matches the 2× server cast.
      const ms = Math.max(50, Math.round(((+gesture.durationS || 0.6) * 1000) / CAST_SPEED));
      await new Promise((resolve) => setTimeout(resolve, ms));
      // Recheck cancellation after the sleep — a newer cast may have
      // started while we slept.
      if (inst._castSequenceToken !== token) return false;
      if (!this.entityMap.has(g)) return false;
      return true;
    };
    // Chain: windup gestures in order, then the cast gesture.
    for (const gesture of (seq.windupGestures || [])) {
      const ok = await playGesture(gesture);
      if (!ok) return; // cancelled or entity vanished
    }
    if (seq.castGesture) {
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
    // TargetEffect deferred: ACE fires TargetEffect on the TARGET via
    // a separate `GameMessageScript(target.Guid, spell.TargetEffect,
    // spell.Formula.Scale)` broadcast at `WorldObject_Magic.cs:361-365`,
    // gated on `projectileHit` for projectile spells. Wiring this in
    // the client requires attributing `damageDealt` events back to
    // the SpellId that produced them; per the Wave 13/14 audit ACE's
    // `damageDealt` payload does NOT carry SpellId. TODO follow-on:
    // either (a) thread SpellId through the missile entity's
    // `prj_spell_id` field (acclient.h cites this exists on retail
    // ProjectileObject), or (b) consume `GameMessageScript` events
    // landing on remote-entity targets and correlate by time-window.
    // See entities.js:2421 (`playCastSequence`) for where this hookup
    // would land.
    // F8-2: don't fire the spell's success CasterEffect glow if the chain
    // was cancelled while the cast gesture was playing — a recast preempted
    // it, or a fizzle/UseDone bumped the token via cancelCastSequence().
    // Without this, a FIZZLED cast still flashed the success VFX (the cast
    // gesture's playGesture result isn't checked above, so control reaches
    // here even after a mid-cast cancel).
    if (inst._castSequenceToken !== token) return;
    if ((seq.casterEffect | 0) !== 0) {
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
          });
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
  }

  // F8-4 — clear the cast-busy window for `guid` (a UseDone / WeenieError
  // landed, so the server is done with this cast). Lets the next cast start
  // immediately instead of waiting out the capped busy window.
  clearCastBusy(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (inst) inst._castBusyUntilMs = 0;
  }

  // F8-2 — cancel an in-flight cast-gesture chain for `guid` (a fizzle /
  // UseDone / WeenieError landed). Bumps `_castSequenceToken` so the chain's
  // next token check breaks out (and the success CasterEffect glow is
  // suppressed via the guard before the synthetic emit), then drops the rig
  // back to its stance-Ready recoil so it doesn't freeze mid-windup.
  cancelCastSequence(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return false;
    inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
    inst._castBusyUntilMs = 0; // F8-4 — cancelled cast frees the busy window
    try {
      const stance = ((inst.currentStance ?? inst.lastStance ??
        (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
      // CMD_LOW_READY (0x0003) high-bits preserved like setMotion's substitution.
      this.setMotion?.(guid >>> 0, 0x0003, stance, 1.0);
    } catch (_) { /* recoil is best-effort */ }
    return true;
  }

  /**
   * Wave 4 / Phase 4.2 (2026-05-26) — release a held swing windup.
   * Pairs with `setSwingMotion(guid, motionCmd, { holdAtPeak: true })`
   * below. While held, the clip's mixer time is paused at the peak
   * frame (`durationSec * 0.5`). Calling this resumes playback from
   * that frame to clip end, then the usual `_swingRestoreTimer`
   * fires `setMotion(Ready)`.
   *
   * No-op if no hold is in flight for `guid` — safe to call
   * unconditionally on charge fire / hold release.
   */
  releaseSwingHold(guid) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    const hold = inst._swingHold;
    if (!hold) return;
    // Cancel the pending pause-at-peak setTimeout if it hasn't fired yet.
    if (hold.peakTimerId) {
      clearTimeout(hold.peakTimerId);
      hold.peakTimerId = 0;
    }
    const action = hold.action;
    if (action) {
      // Resume playback. Two cases:
      //   1) Pause-at-peak already fired → action.paused = true. Flipping
      //      false lets the mixer advance again.
      //   2) Pause-at-peak hasn't fired yet (early release before peak):
      //      action is still playing normally. paused=false is a no-op.
      try { action.paused = false; } catch (_) {}
    }
    // Re-arm the Ready-restore for the REMAINING duration of the
    // swing (from current mixer.time to clip end). Pre-fix the restore
    // timer fired at `dur ms` after setSwingMotion started, so a
    // long-held charge would prematurely revert to Ready while the
    // swing was still paused at peak. Now we re-arm with the actual
    // post-release runtime.
    if (inst._swingRestoreTimer) {
      clearTimeout(inst._swingRestoreTimer);
      inst._swingRestoreTimer = null;
    }
    const swingKey = hold.swingKey;
    const stance = hold.stance;
    const clipDuration = (action?.getClip?.()?.duration ?? 0);
    const currentTime = (action?.time ?? 0);
    const remainingSec = Math.max(0.08, (clipDuration - currentTime) || 0.4);
    const remainingMs = Math.round(remainingSec * 1000);
    inst._swingRestoreTimer = setTimeout(() => {
      inst._swingRestoreTimer = null;
      if (!this.entityMap.has(g)) return;
      if (inst.currentActionKey !== swingKey) return;
      this.setMotion(g, CMD_LOW_READY, stance);
    }, remainingMs);
    inst._swingHold = null;
    // eslint-disable-next-line no-console
    console.log(
      "[entities/swingHold] release guid=0x" + g.toString(16) +
      " key=" + swingKey + " remaining=" + remainingSec.toFixed(2) + "s",
    );
  }

  /**
   * Animation consolidation (docs/animation-audit §5 Step 1, missile): build a
   * one-shot Rust MotionSequence from the CYCLE bake for `cmd` and drive it
   * full-body (hands back to the mixer on completion). The bake resolves cycles
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
    const MS =
      (typeof window !== "undefined" && window.__hbWasm) ? window.__hbWasm.MotionSequence : null;
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
      false, // one-shot: play once. clearOnDone=true hands back to the mixer
             // (swing/missile); false HOLDS the final frame (door open/closed).
    );
    if (!seq) return false;
    if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch (_) {} }
    inst._unifiedSeq = { seq, desc: d, clearOnDone, hooks: entry?.hooks || null, lastHookTime: -1 };
    return true;
  }

  // Whether door open/close should route through the Rust authority
  // (?unifiedMotion=door). index.html's kind=15 handler reads this to decide
  // between playDoorMotion and the legacy instant root-rotation snap.
  usesUnifiedDoor() { return UNIFIED_DOOR; }

  // Animation consolidation (docs/animation-audit §5 Step 3) / rev 2026-07-02:
  // play a door's real swing. Open = On (0x4000000b), close = Off (0x4000000c).
  // Routes through setMotion's door-state branch — retail order: play the
  // MotionTable LINK (the authored swing; On→Off is the same anim baked
  // reversed, door sounds ride its hooks) then hold the framerate-0 cycle.
  // Both triggers of a door change (the server Motion broadcast → setMotion,
  // and the SetState/ethereal flip → kind=15 → here) funnel into that ONE
  // branch, whose lastMotionCommand dedup makes the second trigger a no-op —
  // previously this path played the On/Off CYCLE as a unified one-shot, which
  // (a) raced the mixer link and (b) under the B5 full-range bake rendered a
  // closed door OPEN (the Off cycle baked the whole open anim; "stuck open").
  // stance 0 → the bake resolves default_style (doors key under NonCombat
  // 0x003D). @returns {Promise<boolean>} whether the door was handled (caller
  // falls back to the instant root-rotation snap on false).
  async playDoorMotion(guid, open) {
    if (!UNIFIED_DOOR) return false;
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
  // playhead) — mirrors the mixer path's setEffectiveTimeScale math: the
  // anti-ice-skating velScale (actual ground speed / authored cycle speed,
  // clamped [0.25,4.0]) composed with the server per-motion speed + backstep
  // sign. When no base speed (idle / velScale-absent), plays at motionSpeed.
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

  /**
   * @param {number} guid
   * @param {number} motionCmd
   * @param {{ holdAtPeak?: boolean }} [opts]
   *   When `holdAtPeak` is true (Wave 4 / Phase 4.2), the clip plays
   *   from frame 0 to its peak frame (`durationSec * 0.5`), then
   *   pauses. Call `releaseSwingHold(guid)` to resume from peak to
   *   end. If `durationSec` isn't available (cache miss / coarse
   *   classification), the hold is silently downgraded to a normal
   *   one-shot swing — the visual still plays, just without the hold.
   */
  async setSwingMotion(guid, motionCmd, opts) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    const holdAtPeak = !!(opts && opts.holdAtPeak);
    const stance =
      ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
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
    if (!canPlayReal || typeof fetchKeyframes !== "function") {
      // Missile / aim-level fire is a CYCLE (class 0x40) the links-only gate
      // above can't resolve. Under ?unifiedMotion, route it through the Rust
      // authority on the cycle bake (full-body, retail-faithful) instead of the
      // single-arm/non-human setSwingPose no-op. Only diverts when a real cycle
      // resolves; otherwise falls through unchanged. Default-off.
      if (UNIFIED_MISSILE && await this._tryUnifiedCycleOneShot(g, setupId, mtableId, motionCmd >>> 0, stance)) {
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
    const swingKey = `swing:${resolvedCmd.toString(16)}:${stance.toString(16)}`;
    let action = inst.actions.get(swingKey);
    if (!action) {
      inst.evictOldestUnused?.();
      action = inst.mixer.clipAction(clip);
      inst.actions.set(swingKey, action);
    }
    inst.actionLastUsedMs.set(swingKey, performance.now());
    if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
      inst.hookTimelines.set(swingKey, entry.hooks);
    }
    inst.actionLastHookTime.set(swingKey, -1);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    // A3 (2026-05-29): one-shot swings/casts honor the server's per-motion
    // speed too. The base timeScale normalizes the clip to its authored
    // duration (`clip.duration / dur`); MULTIPLY by `inst._motionSpeed`
    // (retail `Framerate *= speed`) so a hasted/slowed attack plays faster/
    // slower. Identity (1.0) is the fail-soft default.
    // F8-1: `opts.speed` lets a caller pace this one-shot (e.g. the cast
    // chain at ACE CastSpeed=2.0). Defaults to 1.0, so non-cast callers are
    // unaffected. Composes multiplicatively with the server per-motion speed.
    const swingSpeed = (inst._motionSpeed ?? 1.0) * (+(opts?.speed) > 0 ? +opts.speed : 1.0);
    const dur = +result.durationSec;
    if (Number.isFinite(dur) && dur > 0 && Number.isFinite(clip.duration) && clip.duration > 0) {
      action.setEffectiveTimeScale((clip.duration / dur) * swingSpeed);
    } else {
      action.setEffectiveTimeScale(swingSpeed);
    }
    action.setEffectiveWeight(1.0);
    action.reset();
    action.play();
    const prior = inst.currentAction;
    // FU-3 (2026-06-11) — full-body one-shot is now UNCONDITIONAL (the
    // ?fullBodyOneShot flag was retired 2026-06-18): the local swing/cast
    // OVERLAYS locomotion (legs keep running) like the `_tryPlayLink`
    // server-echo path, and the base-cycle suppression below ramps that base to
    // 0 for the overlay's duration. The old `=off` branch — crossFadeFrom(prior),
    // which faded the legs OUT — is gone.
    // (swing/cast vibe-pose tween clears removed — posers retired, WS-B 2026-06-18)
    inst.currentAction = action;
    inst.currentActionKey = swingKey;
    // Make the LOCAL optimistic swing/cast one-shot full-body, exactly like the
    // server-echo `_tryPlayLink` path: without the base-cycle suppression
    // three.js normalizes overlay+base to ~50/50 → the swing plays at half
    // amplitude.
    if (!inst._locoCycleKey || !inst.actions?.has(inst._locoCycleKey)) {
      // ensure a base to suppress when velScale is off (it only sets
      // _locoCycleKey for walk/run): point it at the prior locomotion/Ready
      // action so its weight is ramped to 0 for the overlay's duration
      if (prior && prior !== action) {
        for (const [k, a] of inst.actions) {
          if (a === prior) { inst._locoCycleKey = k; break; }
        }
      }
    }
    this._suppressBaseCycleForOverlay(inst, action);
    if (inst._swingRestoreTimer) clearTimeout(inst._swingRestoreTimer);
    // Wave 4 / Phase 4.2 (2026-05-26) — hold-at-peak windup. Schedule a
    // pause at `dur * 0.5` after play() so the rig holds at the peak
    // frame until `releaseSwingHold(guid)` fires. The Ready-restore
    // timer is skipped here (the release path arms it for the remaining
    // post-peak duration). If `dur` isn't a valid number (coarse
    // classify, no MotionData), the hold downgrades to a normal swing.
    // Drop any previous hold (rapid re-fire on same guid).
    if (inst._swingHold) {
      if (inst._swingHold.peakTimerId) {
        clearTimeout(inst._swingHold.peakTimerId);
      }
      inst._swingHold = null;
    }
    const peakUsable = holdAtPeak && Number.isFinite(dur) && dur > 0;
    if (peakUsable) {
      const peakMs = Math.max(20, Math.round(dur * 500)); // dur*1000 / 2.
      const peakTimerId = setTimeout(() => {
        if (!this.entityMap.has(g)) return;
        if (inst.currentActionKey !== swingKey) return;
        // Action may have been replaced by a newer swing — guard via
        // the hold-record back-reference, not just currentAction.
        if (!inst._swingHold || inst._swingHold.swingKey !== swingKey) return;
        try { action.paused = true; } catch (_) {}
        // eslint-disable-next-line no-console
        console.log(
          "[entities/swingHold] peak-paused guid=0x" + g.toString(16) +
          " key=" + swingKey + " t=" + (action.time ?? 0).toFixed(2) + "s",
        );
      }, peakMs);
      inst._swingHold = {
        swingKey,
        stance,
        action,
        peakTimerId,
        startedMs: performance.now(),
      };
      // Don't arm the auto-restore timer — `releaseSwingHold` arms it
      // for the post-peak remaining duration when the hold ends.
      // eslint-disable-next-line no-console
      console.log(
        "[entities/swingMotion] HOLD guid=0x" + g.toString(16) +
        " cmd=0x" + (motionCmd >>> 0).toString(16) +
        " anim=" + result.animId +
        " dur=" + dur.toFixed(2) + "s (pause at " + (peakMs / 1000).toFixed(2) + "s)",
      );
    } else {
      const restoreDelayMs = Math.max(
        80,
        Math.round(((Number.isFinite(dur) && dur > 0) ? dur : (clip.duration || 0.4)) * 1000),
      );
      inst._swingRestoreTimer = setTimeout(() => {
        inst._swingRestoreTimer = null;
        if (!this.entityMap.has(g)) return;
        if (inst.currentActionKey !== swingKey) return;
        this.setMotion(g, CMD_LOW_READY, stance);
      }, restoreDelayMs);
      console.log(
        "[entities/swingMotion] guid=0x" + g.toString(16) +
        " cmd=0x" + (motionCmd >>> 0).toString(16) +
        " anim=" + result.animId +
        " dur=" + (Number.isFinite(dur) ? dur.toFixed(2) : "0.00") + "s",
      );
    }
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
          if (inst.currentAction) inst.currentAction.paused = false;
        } else {
          inst.airborneTilt = null;
        }
      } else {
        // Tween-in complete. Lock the mixer for human path so the
        // walk-cycle doesn't drift the parts while airborne.
        if (tween.kind === "human") {
          if (inst.currentAction) inst.currentAction.paused = true;
        } else {
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
    // _dispatchLocalRigMotion) routes a PURE strafe through setMotion as the
    // FORWARD command and never calls setSidestepLayer, so for a camera-
    // dispatched pure strafe both fwdCmd (a SideStep* code, not a Run/Walk
    // forward code) and sideCmd land here without a forward run/walk speed to
    // scale, and this returns null → tick() falls back to the rig-XZ EMA. That
    // fallback is intentional and HARMLESS: sidestep |velocity|≈0, so the
    // EMA-derived cycleTimeScale no-ops. Routing strafe through setSidestepLayer
    // would change the visible clip (additive blend vs. full swap) and is
    // deliberately NOT done here.
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
  async setMotion(guid, motionCommand, motionStance, motionSpeed = 1.0) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    // A new locomotion/stance/motion command ends any in-progress unified
    // sequence (swing override, or a death hold on resurrect/correction) so
    // movement stays responsive. No-op when ?unifiedMotion is off (never set).
    if (inst._unifiedSeq) {
      try { inst._unifiedSeq.seq.free(); } catch (_) { /* already freed */ }
      inst._unifiedSeq = null;
    }
    // A1: stash the playback speed (fail-soft to 1.0 for non-finite /
    // non-positive). Read by the locomotion timeScale composition below
    // and by the per-frame T11 velScale tick.
    {
      const ms = +motionSpeed;
      inst._motionSpeed = Number.isFinite(ms) && ms > 0 ? ms : 1.0;
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
    if ((cmd & 0xFFFF) === CMD_LOW_DEAD) {
      inst._deathAt = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
    }
    const cls = classifyMotionCommand(cmd);
    if (cls === "stop" || cls === null) {
      inst.fadeOutCurrent(CROSSFADE_S);
      // Remember the last non-stop command we played so a follow-up
      // setMotion(...) can ask the wasm side for a link clip from
      // the previous cycle into the next one.
      // (`lastMotionCommand` stays sticky across STOP so e.g.
      //  Walk → Stop → Walk replays the original link.)
      return;
    }
    const setupId =
      (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta.mtableId ?? 0) >>> 0;

    // Animation consolidation (docs/animation-audit §5 Step 2,
    // ?unifiedMotion=death): route Dead (0x0011) through the Rust one-shot
    // authority — play the collapse ONCE, then HOLD the final (prone) frame
    // (a non-cyclic MotionSequence latches `done` and clamps its last frame).
    // Replaces the held-LOOPING cycle pose + the racy separate collapse overlay
    // (two unsequenced mixer actions) with ONE sequence. Default-off: when the
    // flag is off this is skipped and Dead falls through to the legacy
    // STATIONARY_COMMANDS → cycle path below (untouched, no regression).
    if (UNIFIED_DEATH && cmdLow === CMD_LOW_DEAD) {
      const MS =
        (typeof window !== "undefined" && window.__hbWasm) ? window.__hbWasm.MotionSequence : null;
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
        const d = entry?.sequenceDescriptor;
        if (d) {
          const seq = MS.fromDescriptor(
            d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
            d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
            false, // one-shot collapse → latches `done`, holds the final prone frame
          );
          if (seq) {
            if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch (_) {} }
            // clearOnDone:false → keep posing the clamped prone frame (held dead).
            inst._unifiedSeq = { seq, desc: d, clearOnDone: false, hooks: entry?.hooks || null, lastHookTime: -1 };
            // (2026-07-06) Stamp the REAL collapse length so loop.js `_armRemove`
            // holds the rig for exactly this creature's authored death animation
            // (they vary — tusker ~1.3s, others longer) instead of the flat
            // DEATH_HOLD_MS, and the corpse handoff reveals on the same clock.
            // Freeze remote dead-reckon so the collapsing rig settles at the
            // authoritative death spot rather than coasting on its last velocity.
            if (this._deathAnimOn) {
              const durMs = (Number.isFinite(d.duration) && d.duration > 0)
                ? d.duration * 1000 : DEATH_HOLD_FALLBACK_MS;
              inst._deathDurationMs = durMs;
              inst._deathEndAt = (inst._deathAt ?? _entityNowMs()) + durMs;
              this._freezeDeadReckon(inst);
            }
            return; // the tick drives the rig; skip the legacy cycle path
          }
        }
      }
      // MS missing (stale pkg) / empty bake → fall through to the legacy path.
    }

    // Swings + magic casts live in `MotionTable.links[(stance,
    // Ready)][swingCmd]` — never in `cycles[(stance, swingCmd)]`.
    // Empirically validated across all 436 retail motion tables
    // (5,455 link entries, 0 cycle entries) — see
    // `docs/swing-classification-spec-2026-05-19.md` §1, §8.
    //
    // Route attack/cast through `_tryPlayLink` with from = Ready =
    // 0x0003 and OVERLAY the swing on top of the active locomotion
    // cycle (no crossFadeTo). The walk/run continues to animate the
    // legs while the swing animates the arms; when LoopOnce ends
    // with `clampWhenFinished=false`, the swing weight drops to 0
    // and the cycle resumes the affected parts.
    //
    // Stance-agnostic per spec §8.2 finding A — monster motion
    // tables put swings in `NonCombat`; the link lookup either has
    // an entry or it doesn't, we pass `stance` straight through.
    //
    // Pre-fix: attack/cast went through the cycle path, which
    // returned a null clip (swings aren't in cycles) and the
    // `if (!clip) fadeOutCurrent` branch then silently faded out
    // the underlying locomotion. Net effect: no swing visible AND
    // the walk cycle stopped.
    if (cls === "attack" || cls === "cast") {
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
      this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, linkCmd, stance);
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
      // cycle hold below snaps the object to the commanded state.
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
      this._resolveCycleBaseSpeed(inst, mtableId, stance, cmd, cacheKey);
      // T1: stash the interpreted forward motion state (full u32 command +
      // forward_speed scalar) so tick() can feed the new wasm `stateGroundSpeed`
      // getter (retail CMotionInterp::get_state_velocity) as the 'actual'
      // ground anim-speed, instead of the rig XZ-position-delta EMA. `cmd` here
      // is the already-interpreted forward command (WalkForward/RunForward —
      // backstep arrives as WalkForward with a negated forward_speed upstream);
      // `inst._motionSpeed` is the broadcast forward_speed (set above). The
      // sidestep axis is driven separately (setSidestepLayer stashes its scalars).
      inst._forwardCommand = cmd >>> 0;
      inst._forwardSpeed = inst._motionSpeed ?? 1.0;
    }
    if (cacheKey === inst.currentActionKey) return; // already playing
    this.motionSwitchCount += 1;
    inst.actionLastUsedMs.set(cacheKey, performance.now());

    // 2026-05-18 motion-link experiment. When we're transitioning
    // from a known previous motion command (not the very first
    // setMotion for this entity), ask the MotionTable for a link
    // transition clip via `opts.fromMotion`. If one exists, play it
    // once with LoopOnce + clampWhenFinished, then schedule the
    // destination cycle as a follow-up so the rig flows
    // (prev cycle frames) → (link clip frames once) → (next cycle).
    const fromMotion = (inst.lastMotionCommand ?? 0) >>> 0;
    if (
      fromMotion !== 0 &&
      fromMotion !== cmd &&
      cls !== "attack" &&
      cls !== "cast"
    ) {
      // Don't await — kick off the link fetch but immediately also
      // start fetching the destination cycle below. If the link
      // resolves we'll insert it as a quick overlay; if not (no
      // link entry for this transition) we just play the cycle as
      // before. Failure is silent — same visual as today.
      this._tryPlayLink(inst, setupId, mtableId, fromMotion, cmd, stance);
    }
    inst.lastMotionCommand = cmd;

    let action = inst.actions.get(cacheKey);
    if (!action) {
      // Cache miss → fetch the clip. Substitutions reuse the spawn
      // meta's entries (NPC outfit doesn't change mid-walk).
      const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
      if (typeof fetchKeyframes !== "function") return;
      let entry;
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
        return;
      }
      // Re-check — the entity may have been removed between the
      // cache hit and now.
      if (!this.entityMap.has(guid >>> 0)) return;
      const clip = entry.clip;
      if (!clip) {
        // No animation resolved for this (cmd, stance). Treat as STOP
        // — fade out the current action.
        inst.fadeOutCurrent(CROSSFADE_S);
        return;
      }
      // Animation consolidation (docs/animation-audit §5 Step 5,
      // ?unifiedMotion=locomotion): drive the locomotion CYCLE through the Rust
      // authority instead of the mixer crossFadeTo. Phase is carried across a
      // cycle swap (walk→run) via the Rust seekPhase so the feet don't pop.
      // A one-shot (_unifiedSeq) suppresses this during a swing then resumes it.
      // By here attack/cast/death/stop have already returned, so cls is a
      // locomotion cycle (walk/run/idle/Ready). Default-off → unchanged below.
      if (UNIFIED_LOCO) {
        const MS =
          (typeof window !== "undefined" && window.__hbWasm) ? window.__hbWasm.MotionSequence : null;
        const d = entry.sequenceDescriptor;
        if (MS && d) {
          const seq = MS.fromDescriptor(
            d.numFrames >>> 0, _finiteOr0(d.framerate), _finiteOr0(d.duration),
            d.frameTimes || EMPTY_F32, d.segmentStarts || EMPTY_U32, d.segmentCounts || EMPTY_U32,
            true, // cyclic locomotion — loops
          );
          if (seq) {
            const prev = inst._unifiedLoco;
            // Carry normalized phase from the prior cycle (no foot-pop on swap).
            if (prev?.seq && typeof seq.seekPhase === "function") {
              try { seq.seekPhase(prev.seq.phase); } catch (_) {}
            }
            if (prev?.seq) { try { prev.seq.free(); } catch (_) {} }
            inst._unifiedLoco = {
              seq, desc: d, cacheKey,
              base: inst._locoBaseSpeed || 0,
              hooks: entry.hooks || null, lastHookTime: -1,
            };
            inst._locoCycleKey = cacheKey;
            try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
            return; // the tick drives the loco cycle; skip the mixer crossFadeTo
          }
        }
      }
      // Don't exceed the per-entity action cap. Evict before install.
      inst.evictOldestUnused();
      action = inst.mixer.clipAction(clip);
      // One-shot (attack / cast) — play once + return to the rest
      // pose; the surrounding locomotion will re-resume on the next
      // STOP / WalkForward / RunForward broadcast from ACE. Pre-2026-
      // 05-17 these commands were dropped at `classifyMotionCommand`,
      // so combat used a vibe-coded triangle-wave arm tween in
      // `setSwingPose`. Now the real MotionTable clip plays for any
      // attack-family or cast-family command. Clear the vibe-tween
      // so the real clip wins (the tween's per-tick slerp runs AFTER
      // mixer.update and would otherwise overwrite the clip's pose).
      if (cls === "attack" || cls === "cast") {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        // (swing/cast vibe-pose tween clears removed — posers retired, WS-B 2026-06-18)
      } else if (isDoorStateMotion(cmd)) {
        // Door/chest open/close: play the transition ONCE and HOLD the final
        // (open/closed) pose — these are state changes, not cyclic loops.
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.enabled = true;
      inst.actions.set(cacheKey, action);
      // Task E (2026-05-12): same hook-timeline stash as the spawn
      // path. The cache entry already has hooks drained + snapshotted
      // to plain JS POJOs; multiple entities sharing this clip share
      // the same timeline array (per-entity firing state in
      // `actionLastHookTime` keeps them independent).
      if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
        inst.hookTimelines.set(cacheKey, entry.hooks);
        inst.actionLastHookTime.set(cacheKey, -1);
      }
    }
    // Wave 7 Phase 7.1 (2026-05-26): walk-cycle phase preservation.
    //
    // When the player rapidly taps W (release-then-re-press within
    // ~200 ms), `setMotion` previously fetched the same `cacheKey`,
    // saw `currentActionKey == null` (because `fadeOutCurrent` cleared
    // it on the release), and the resulting `crossFadeTo(action, …)`
    // played the cycle from `action.time` — which for a freshly-
    // created clipAction is 0, and for a re-played existing action is
    // wherever .stop() left it. The latter usually works (Cohere-B's
    // "cycle-rewind" comment at L631–643 deliberately skipped
    // `.reset()` to preserve `.time` across the integrator's motion
    // oscillation), but it falls down when the LRU evicts the action
    // mid-pause: cache-miss path creates a brand-new clipAction at
    // .time = 0 and the foot "pops".
    //
    // Fix: after the action is resolved (cache hit OR miss), look up
    // a recent same-key swap-out. If one exists within RESUME_WINDOW_MS,
    // pin `action.time` to the saved phase. Locomotion-only — swings,
    // casts, and stance-Ready get the existing hard-cut behaviour
    // (their LoopOnce semantics + the 150 ms Ready crossfade rely on
    // .time starting at 0).
    if (cls === "walk" || cls === "run") {
      const recent = inst._recentLocomotionTime.get(cacheKey);
      if (recent) {
        const RESUME_WINDOW_MS = 200;
        const elapsed = performance.now() - recent.leftAt;
        if (elapsed >= 0 && elapsed < RESUME_WINDOW_MS) {
          // Defensive modulo: if the cached clip's duration differs
          // from when the time was stashed (e.g. AnimationCache served
          // a different setup/stance variant), wrap to clip duration.
          // three.js's mixer already wraps internally on LoopRepeat,
          // but a >duration starting offset would visibly snap.
          let restored = recent.time;
          try {
            const clipDur = action.getClip()?.duration ?? 0;
            if (clipDur > 0) {
              restored = ((restored % clipDur) + clipDur) % clipDur;
            }
          } catch (_) {}
          action.time = restored;
        }
        // Whether we used it or not, drop the entry — same-key swap-
        // out + restore is single-shot per cycle. Subsequent rapid
        // taps will get re-stashed by `crossFadeTo` on the next out.
        inst._recentLocomotionTime.delete(cacheKey);
      }
    }
    // Wave 3 / Phase 3.3 (2026-05-26): per-retail "modifier-stacking
    // blend feel" on stance transitions. AC retail had no discrete
    // DrawSword/SheathSword clip — the visual transition was done by
    // swapping `current_style` atomically and letting the modifier
    // stack blend it (per `~/ac-headers/acclient.c:332771-332786` /
    // memory project_holtburger_combat_phase_g_done_2026-05-17). We
    // approximate that feel with a 150 ms crossfade on the specific
    // case of Ready-with-stance-change. All other locomotion swaps
    // remain hard cuts (`CROSSFADE_S = 0` — see comment at L211)
    // because retail's PhatSDK `advance_to_next_animation()` was an
    // unconditional pointer swap with no blend state. Edge case:
    // rapid stance toggles within <150 ms — three.js's
    // `crossFadeTo` replaces the previous fade in flight so it
    // self-heals; we don't need a guard.
    const isStanceReadyChange =
      (cmd & 0xFFFF) === CMD_LOW_READY
      && prevStance !== 0
      && stance !== prevStance;
    const crossfadeDuration = isStanceReadyChange ? 0.15 : CROSSFADE_S;
    inst.crossFadeTo(action, cacheKey, crossfadeDuration);
    // A1 (2026-05-29): apply the server's per-motion playback speed to the
    // locomotion cycle. When ?velScale=on, the per-frame T11 tick owns
    // setEffectiveTimeScale (it MULTIPLIES inst._motionSpeed in there —
    // see tick() ~L6360), so setting it here would just be overwritten next
    // frame; skip to avoid a one-frame double-apply. When velScale is OFF,
    // the cycle otherwise plays at native rate (1.0), so set the playback
    // speed directly here. Identity (1.0) is a no-op, so this is fail-soft.
    if (!VEL_SCALE_ON) {
      // F15-2 — multiply in the backstep direction (sign = +1 unless
      // ?signedMotionSpeed flips it for a negative speed).
      const ms = (inst._motionSpeed ?? 1.0) * (inst._motionSpeedSign ?? 1);
      if (ms !== 1.0) {
        try { action.setEffectiveTimeScale(ms); } catch (_) {}
      }
    }
    try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
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
    const lastCls = classifyMotionCommand((inst.lastMotionCommand ?? 0) >>> 0);
    const moving = lastCls === "walk" || lastCls === "run";
    if (!changed || moving) {
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
   * Wave 2 Phase 2.2 (2026-05-26) — layer a sidestep cycle on top of
   * the active forward locomotion clip.
   *
   * **Why this exists.** Retail's `RawMotionState` carries forward,
   * sidestep, and turn as three INDEPENDENT command slots
   * (`~/ac-headers/acclient.c:332759-332786`,
   * `external/ACE/Source/ACE.Server/Physics/Animation/RawMotionState.cs:7-115`).
   * The wasm side now packs both slots when the player holds W+D
   * (`crates/holtburger-core/src/client/movement/common.rs::build_motion_state_raw_motion_state`).
   * `setMotion()` plays ONE clip via crossFadeTo, replacing whatever
   * was active — fine for the forward axis, but it would clobber the
   * forward clip on a follow-up sidestep dispatch.
   *
   * **Mechanism.** Mirrors `_tryPlayLink`'s overlay pattern: fetch the
   * sidestep cycle through the AnimationCache, install it as a separate
   * keyed action (`sidestep:0x{cmd}:0x{stance}`), set LoopRepeat, and
   * just `.play()` it. The mixer blends it with the active locomotion
   * action by their respective weights — three.js's
   * `AnimationMixer.update(dt)` handles concurrent actions natively.
   *
   * Pass `sidestepCmd = 0` (or any non-sidestep command low-16) to
   * fade out and remove the sidestep layer; this is the path
   * `setLocomotionPair` takes when strafe key releases while forward
   * is still held.
   *
   * No-op for entities without a rig (silently returns) or when the
   * cmd doesn't map to a known sidestep low (`0x0F`/`0x10`).
   *
   * @param {number} guid
   * @param {number} sidestepCmd Full u32 motion command. Use 0 to clear.
   * @param {number} motionStance Stance (current_style); 0 inherits.
   * @param {number} [speed] W4.5 / DIM1-3 (2026-06-05): the wire
   *   `sidestep_speed` scalar (retail MotionInterp.cs:414 / acclient.c:332766
   *   scales the strafe anim by it). When omitted/non-finite, defaults to 1.0
   *   (the un-modulated sidestep anim speed) — backward-compatible with the
   *   3-arg local caller (index.html). Threading the real wire value here makes
   *   `inst._sidestepSpeed` carry the fractional magnitude the
   *   `stateGroundSpeed` getter / velScale consume. (anim-deep FIX-PLAN W4.5.)
   */
  async setSidestepLayer(guid, sidestepCmd, motionStance, speed) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    // Wave 2 Phase 2.5 (2026-05-26): defensive Left → Right substitution.
    // Our wasm wire-emit (`crates/holtburger-core/src/client/movement/
    // common.rs::sidestep_command_for_state`) and the local-prediction
    // dispatch at `index.html:9290` both already pass
    // `SideStepRight (0x6500000F)` regardless of direction. But ACE's
    // UpdateMotion broadcast from a remote player on an older client (or
    // a custom plugin emitting the raw enum value) could still carry the
    // Left code (`0x65000010`). Map it to Right so the cache lookup hits
    // the same `MotionTable.cycles[(stance, SideStepRight)]` clip
    // retail used for both directions. The direction sign rides
    // `sidestep_speed`, but the rig only needs ONE clip either way.
    let normalizedCmd = sidestepCmd >>> 0;
    if ((normalizedCmd & 0xFFFF) === CMD_LOW_SIDESTEP_LEFT) {
      normalizedCmd = (normalizedCmd & 0xFFFF0000) | CMD_LOW_SIDESTEP_RIGHT;
    }
    const cmd = normalizedCmd;
    const cmdLow = cmd & 0xFFFF;

    // Clear path — fade out any existing sidestep layer, then return.
    const SIDESTEP_LAYER_KEY_PREFIX = "sidestep:";
    const clearLayer = (reason) => {
      if (!inst.actions) return;
      for (const [key, action] of inst.actions.entries()) {
        if (typeof key === "string" && key.startsWith(SIDESTEP_LAYER_KEY_PREFIX)) {
          try {
            action.fadeOut(CROSSFADE_S);
            // Disable after a few frames; three.js will GC the binding.
            setTimeout(() => {
              try { action.enabled = false; } catch (_) {}
            }, Math.max(50, CROSSFADE_S * 1000 + 16));
          } catch (_) {}
        }
      }
      if (window?.__diag?.motion?.onSidestepLayerCleared) {
        try {
          window.__diag.motion.onSidestepLayerCleared({ guid: guid >>> 0, reason });
        } catch (_) {}
      }
    };

    if (cmd === 0 || (cmdLow !== 0x000F && cmdLow !== 0x0010)) {
      // T1: clear the stashed sidestep state so the per-frame stateGroundSpeed
      // getter drops the X term once sidestep is released.
      inst._sidestepCommand = 0;
      inst._sidestepSpeed = 0;
      clearLayer(cmd === 0 ? "cleared" : `unsupported-cmd=0x${cmdLow.toString(16)}`);
      return;
    }
    // T1: stash the interpreted sidestep command (full u32, already collapsed
    // to SideStepRight 0x6500000F above) for the stateGroundSpeed getter's X
    // term. retail get_state_velocity keys the X term on
    // `command == SideStepRight` and scales by sidestep_speed.
    // W4.5 / DIM1-3 (2026-06-05): thread the real wire `sidestep_speed`
    // magnitude (was hardcoded 1.0, dropping fractional-speed strafes). When the
    // caller omits it (3-arg callers) `speed` is undefined → fall back to 1.0,
    // the un-modulated sidestep anim speed. Harmless until velScale is live AND
    // a fractional-speed strafe occurs. (anim-deep FIX-PLAN W4.5.)
    inst._sidestepCommand = cmd >>> 0;
    inst._sidestepSpeed = Number.isFinite(speed) ? Math.abs(speed) : 1.0;

    let stance = (motionStance >>> 0);
    if (stance === 0 && inst.lastStance) {
      stance = inst.lastStance;
    }
    if (stance === 0) {
      // No prior stance recorded; defer to a future setMotion call.
      return;
    }

    const setupId =
      (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta.mtableId ?? 0) >>> 0;
    const layerKey = `${SIDESTEP_LAYER_KEY_PREFIX}0x${cmd.toString(16)}:0x${stance.toString(16)}`;

    let action = inst.actions?.get(layerKey);
    if (!action) {
      const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
      if (typeof fetchKeyframes !== "function") return;
      let entry;
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
          },
        );
      } catch (e) {
        console.warn(
          `[wave2.2] setSidestepLayer fetch failed for entity 0x${(guid >>> 0).toString(16)}:`,
          e,
        );
        return;
      }
      if (!this.entityMap.has(guid >>> 0)) return;
      const clip = entry?.clip;
      if (!clip) {
        // No sidestep cycle for this (stance, cmd) — silent no-op; the
        // forward clip alone still drives the visible animation.
        return;
      }
      inst.evictOldestUnused?.();
      action = inst.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      // Weight 0.5 = additive 50/50 blend with the forward clip.
      // Three.js mixers sum weighted poses across all `enabled+play()`-ed
      // actions; equal weights yield a midpoint pose which reads as a
      // diagonal walk. Tunable later if user feedback says the rig looks
      // too sideways or too straight.
      action.setEffectiveWeight(0.5);
      action.enabled = true;
      inst.actions?.set(layerKey, action);
    } else {
      // Re-arm an existing layer (fadeOut may have started during a
      // brief release+re-press of A/D).
      action.enabled = true;
      action.setEffectiveWeight(0.5);
    }
    try {
      action.play();
      if (window?.__diag?.motion?.onSidestepLayerPlayed) {
        try {
          window.__diag.motion.onSidestepLayerPlayed({
            guid: guid >>> 0,
            cmd: cmd >>> 0,
            stance: stance >>> 0,
            layerKey,
          });
        } catch (_) {}
      }
    } catch (e) {
      console.warn(`[wave2.2] setSidestepLayer play failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Wave 2 Phase 2.2 (2026-05-26) — drive both forward + sidestep
   * animation slots in one call.
   *
   * Used by the local-prediction path in `index.html` (mirrors the
   * Phase 1.5 Jump local trigger) to keep the rig's diagonal walk
   * visible while the wire packet is still in flight. ACE's
   * UpdateMotion broadcast does eventually arrive carrying the same
   * forward / sidestep pair; that path can call `setLocomotionPair`
   * too (or rely on `setMotion` for the forward axis alone — both work).
   *
   * @param {number} guid
   * @param {number} forwardCmd  Full u32; 0 = leave forward path
   *                             alone (caller will call setMotion or
   *                             clear separately).
   * @param {number} sidestepCmd Full u32; 0 = clear sidestep layer.
   * @param {number} motionStance
   */
  setLocomotionPair(guid, forwardCmd, sidestepCmd, motionStance) {
    if (forwardCmd !== 0) {
      // Fire-and-forget; setMotion handles its own async fetch.
      this.setMotion(guid, forwardCmd, motionStance);
    }
    // Always run sidestep layer dispatch (handles both arm and clear).
    this.setSidestepLayer(guid, sidestepCmd, motionStance);
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
    if (!inst) return;
    inst.lastVel = {
      vx: upd.vx ?? 0,
      vy: upd.vy ?? 0,
      vz: upd.vz ?? 0,
      omegaZ: upd.omegaZ ?? 0,
    };
    inst.lastVelMs = typeof performance !== "undefined" ? performance.now() : 0;
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

    // Preserve current world pose. `inst.root.position` is already in
    // AC world-frame (lbX*192 + local_x, etc); recompute LB-local so
    // the spawn path's `wx = lbX*192 + meta.x` rebuilds the same world
    // coords. Falls through to spawn-time pose if any field is missing.
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
    // === Wave 6 polish — entityAppearanceChanged emit (2026-05-28) ===
    // Notify the plugin bus that this entity's visible appearance just
    // landed (despawn+respawn path). Wave 3.B's examine-target plugin
    // subscribes via `client.events.on("entityAppearanceChanged", ...)`
    // to tear down + rebuild its embedded PaperdollViewport so the dyed
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
   * Preserves `inst.root` + `inst.mixer` + currently-playing
   * `inst.currentAction` — only the child Mesh contents of each
   * `inst.parts[p]` Group get replaced. The mixer continues driving
   * `parts[p].position` / `parts[p].quaternion` against the same
   * clip (cache returns a fresh animEntry post-W7.5 substitution-
   * aware cache key fix, but the clip's track NAMES match the old
   * one because partGroup naming `part_${p}` is identical for same
   * setupId).
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
    // falling back to spawn-time defaults if currentAction is null.
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
    const paletteId = (newMeta.paletteId ?? 0) >>> 0;
    const subPalettes = newMeta.subPalettes ?? new Uint32Array(0);
    const hasPaletteSubs = paletteId !== 0 || subPalettes.length > 0;
    // R-8 (net-fixwave 2026-07-09) — an appearance change supersedes any
    // pending dyed-surface refresh (its captured palette state is stale);
    // the arm at the bottom of this swap re-schedules against the new state.
    this._cancelDyedSurfaceRefresh(inst);
    let hotSwapDecodeMisses = 0;

    let entityMaterials = null;
    if (hasPaletteSubs && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      const dids = new Uint32Array([...allSurfaceDids]);
      if (dids.length > 0) {
        // Wave 7.7 — dye observability on the hot-swap path too.
        try {
          window.__diag?.clothing?.onDyeApplication?.({
            guid,
            source: "hot-swap",
            surfaceDidCount: dids.length,
            paletteId,
            subPaletteTripleCount: (subPalettes.length / 3) | 0,
          });
        } catch (_) {}
        const results = await entitySurfacePixelsFetcher(this.wasmExports)(dids, paletteId, subPalettes);
        // R-8 — decode audit (see the spawn-path twin): misses arm the
        // ladder's sweep; proven absences join the per-entity skip set.
        hotSwapDecodeMisses = surfaceResultDecodeMisses(results) ?? 0;
        const hotSwapAbsent = surfaceResultProvenAbsent(results);
        if (hotSwapAbsent && hotSwapAbsent.size) {
          if (!inst._dyedSurfaceAbsent) inst._dyedSurfaceAbsent = new Set();
          for (const d of hotSwapAbsent) inst._dyedSurfaceAbsent.add(d >>> 0);
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
        await this.materialCache.preload([...allSurfaceDids], surfacePixelsFetcher(this.wasmExports));
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
      // remove existing child meshes
      const oldChildren = partGroup.children.slice();
      for (const child of oldChildren) {
        partGroup.remove(child);
      }
      const conv = newPartGroups[p];
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
          partGroup.add(m);
          inst.registerGeometry(grp.geometry);
        }
      }
    }

    // Commit new owned-asset registry; dispose old ones now that
    // nothing references them.
    if (inst._pendingOwnedMaterials) {
      inst.ownedMaterials.length = 0;
      for (const m of inst._pendingOwnedMaterials) inst.ownedMaterials.push(m);
      delete inst._pendingOwnedMaterials;
    }
    if (inst._pendingOwnedTextures) {
      inst.ownedTextures.length = 0;
      for (const t of inst._pendingOwnedTextures) inst.ownedTextures.push(t);
      delete inst._pendingOwnedTextures;
    }
    inst._entityMaterials = entityMaterials;
    for (const m of oldOwnedMaterials) {
      try { m.dispose(); } catch (_) {}
    }
    for (const t of oldOwnedTextures) {
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
    // respawn (the spawn-path arms never see hot-swapped meshes). Dyed swaps
    // arm the dyed ladder; plain swaps arm the 2026-05-30 plain ladder.
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
          this._scheduleDyedSurfaceRefresh(inst, {
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
      const endAt = inst._deathEndAt ?? (inst._deathAt + DEATH_HOLD_FALLBACK_MS);
      if (now >= endAt) continue; // its collapse already finished
      const p = inst.root?.position;
      if (!p) continue;
      const dx = p.x - cp.x, dy = p.y - cp.y, dz = p.z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = inst; }
    }
    if (!best) return; // no dying creature here → corpse shows normally

    // Align the collapsing rig with the corpse's authoritative transform so the
    // reveal is seamless in BOTH position and heading (the corpse's server
    // orientation is the creature's death orientation), then hide the corpse.
    best.root.position.copy(cp);
    best.root.quaternion.copy(corpseInst.root.quaternion);
    this._freezeDeadReckon(best);
    best._corpseHandoffGuid = corpseInst.guid >>> 0; // _armRemove yields to us
    corpseInst.root.visible = false;
    corpseInst._hiddenForHandoff = true;

    const revealAt = best._deathEndAt ?? (best._deathAt + DEATH_HOLD_FALLBACK_MS);
    const remaining = Math.max(0, revealAt - now);
    const corpseGuid = corpseInst.guid >>> 0;
    const creatureGuid = best.guid >>> 0;
    setTimeout(() => {
      try {
        const corpse = this.entityMap.get(corpseGuid);
        if (corpse && corpse._hiddenForHandoff && corpse.root) {
          corpse.root.visible = true;
          corpse._hiddenForHandoff = false;
        }
        // Remove the collapsed creature now that the corpse has taken over. The
        // creature's own KIND_REMOVE deferral yielded to us (_corpseHandoffGuid);
        // remove() no-ops if it already went.
        this.remove(creatureGuid);
      } catch (_) { /* handoff must never throw into a timer */ }
    }, remaining);
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
    this._pendingAttach.delete(g);
    // F16-5 (2026-06-09): drop any un-applied spawn-time draw gate so a guid
    // that despawned before its rig finished building doesn't leak.
    this._pendingVisibility.delete(g);
    // A8-M4 (2026-06-12): same despawn purge for the generic pre-create
    // buffer (retail RemoveObjectToBeDestroyed cancels the placeholder's
    // timer on real removal, acclient.c:309906-309915; parked attaches
    // keyed by OTHER child guids that name this guid as wielder are left
    // to the 25 s expiry, matching the legacy `_pendingAttach` behavior).
    // No-op when the flag is off (buffer empty).
    this._preCreate.purgeGuid(g);
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
  async _attachEntityLights(inst, setupId) {
    const summary = { created: 0, capped: false };
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
    if (!this.entityMap.has(inst.guid >>> 0)) {
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
  async _tryPlayLink(inst, setupId, mtableId, fromCmd, toCmd, stance, opts = undefined) {
    // Returns true when a clip was resolved and played (or handed to the
    // unified one-shot), false otherwise — the door-state caller falls back
    // to its 1-frame cycle hold on false. Legacy callers ignore the value.
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;
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
        },
      );
    } catch (_) {
      return false;
    }
    if (!this.entityMap.has(inst.guid >>> 0)) return false;
    const clip = entry?.clip;
    if (!clip) {
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
      if (tcls === "attack" || tcls === "cast") {
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
    // Step-1/4 (?unifiedMotion=attack|cast): drive an attack swing or a cast
    // gesture as a FULL-BODY one-shot sequence (retail GetObjectSequence,
    // acclient.c:337842) instead of a LoopOnce overlay the locomotion cycle
    // half-blends ("upper-body-only swing") or the both-arms-up cast vibe tween.
    // Casts, like swings, live in MotionTable.links — same one-shot mechanism.
    // The tick loop advances inst._unifiedSeq + poses the rig and SUPPRESSES the
    // mixer; on completion the stance cycle resumes. Default-off → unchanged
    // mixer overlay path below.
    const _unifiedCls =
      (entry?.sequenceDescriptor && typeof classifyMotionCommand === "function")
        ? classifyMotionCommand(toCmd >>> 0)
        : null;
    if (
      (UNIFIED_ATTACK && _unifiedCls === "attack") ||
      (UNIFIED_CAST && _unifiedCls === "cast")
    ) {
      // Build the swing as a one-shot in the RUST MotionSequence interpreter.
      // The class is read off window.__hbWasm (typeof-guarded): a stale pkg/
      // without it falls through to the mixer overlay below (soft-degrade).
      const MS =
        (typeof window !== "undefined" && window.__hbWasm && window.__hbWasm.MotionSequence) || null;
      const d = entry.sequenceDescriptor;
      if (MS && d) {
        const seq = MS.fromDescriptor(
          d.numFrames >>> 0,
          +d.framerate || 0,
          +d.duration || 0,
          d.frameTimes || EMPTY_F32,
          d.segmentStarts || EMPTY_U32,
          d.segmentCounts || EMPTY_U32,
          false, // one-shot swing (no cyclic region) → latches `done`, holds last frame
        );
        if (seq) {
          // Keep `desc` for the per-frame poser (it owns the keyframe buffer).
          // clearOnDone: the one-shot swing hands the rig back to the mixer
          // (frozen cycle resumes) on completion.
          inst._unifiedSeq = { seq, desc: d, clearOnDone: true, hooks: entry?.hooks || null, lastHookTime: -1 };
          return true; // skip the mixer overlay; the tick drives the rig
        }
      }
    }
    // Use a stable cache key so repeated transitions reuse the same
    // AnimationAction (mixer-bound bindings live per-entity).
    const linkKey = `link:${fromCmd.toString(16)}->${toCmd.toString(16)}:${stance.toString(16)}`;
    let action = inst.actions?.get(linkKey);
    if (!action) {
      inst.evictOldestUnused?.();
      action = inst.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      action.enabled = true;
      inst.actions?.set(linkKey, action);
    }
    // Door-state transitions (setMotion's isDoorStateMotion branch): the
    // link's final frame IS the destination hold pose (Off→On ends open,
    // On→Off ends closed), so clamp it there — the clamped link is the held
    // state, exactly retail's "play the link, then enter the framerate-0
    // hold cycle". SOLO the rig first: a still-applied previous state (the
    // spawn hold action or a prior clamped link) would otherwise weight-
    // normalize ~50/50 against this overlay for its whole playback. Door/
    // chest/lever rigs only ever carry state actions, so the blanket stop
    // is safe — and it is scoped to opts.stateHold callers only.
    if (opts?.stateHold) {
      action.clampWhenFinished = true;
      if (inst.actions) {
        for (const a of inst.actions.values()) {
          if (a !== action) {
            try { a.stop(); } catch (_) { /* already unbound */ }
          }
        }
      }
      inst.currentAction = action;
      inst.currentActionKey = linkKey;
      inst.actionLastUsedMs?.set(linkKey, performance.now());
    }
    // Register / refresh the hook timeline for this overlay clip so
    // `_tickAnimationHooks` fires Sound (sword swoosh, magic chime),
    // SoundTable, CreateParticle, and AttackHook strike-frame events
    // during the swing/cast. Without this the hook executor would
    // skip the overlay (it walks every running action, but `get(key)`
    // misses if no timeline was registered).
    //
    // Reset `actionLastHookTime` to 0 on every play() so a rapid
    // replay (spam-click attack) fires hooks from the top — the
    // following `action.reset()` rewinds `.time` to 0, and without
    // matching the lastTime reset the first tick would see
    // `currentTime=0 < lastTime=high` and trigger the wrap-around
    // re-fire branch.
    if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
      inst.hookTimelines.set(linkKey, entry.hooks);
    }
    inst.actionLastHookTime.set(linkKey, -1);
    // A4-Q2 (?mtQueue=on) — TAGGING CONTRACT: only overlays the wasm
    // pipeline queued may notify `notifyAnimationDone` (counter
    // poisoning guard — acclient.c:329885-329894 is positional). NO
    // current caller passes `mtQueued: true`; the callers arrive with
    // Stage-2 `?interpRig` consumption / A3-D2 — Q2 pins the plumb so
    // D2 cannot fork it. Locomotion transition links and server-echo
    // overlays NEVER notify.
    if (MT_QUEUE_ON && opts?.mtQueued === true) {
      inst._mtQueuedKeys?.add(linkKey);
      if (!HOOK_DRAIN_ON && !action.__mtNotifyArmed) {
        // Fallback completion detector when the drain executor is off
        // (the flags stay independently flippable; full retail ORDERING
        // parity only with both on — see url-flags.md). Caveat: three.js
        // fires `finished` INSIDE `mixer.update`, i.e. before this
        // frame's hooks (spec S5 §6 OQ-4) — accepted on the fallback.
        // `__mtNotifyArmed` guards spam-replay duplicate listeners on
        // the reused action (one finish = one notify).
        action.__mtNotifyArmed = true;
        const _mixer = inst.mixer;
        const _overlayAction = action;
        const onMtFinished = (e) => {
          if (e.action !== _overlayAction) return;
          try { _mixer.removeEventListener("finished", onMtFinished); } catch (_) {}
          _overlayAction.__mtNotifyArmed = false;
          notifyMtQueuedOverlayDone(inst, linkKey, true);
        };
        try { _mixer.addEventListener("finished", onMtFinished); } catch (_) {}
      }
    }
    try {
      // A3 (2026-05-29): attack/cast one-shots route here (from=Ready in
      // setMotion); honor the server's per-motion speed so hasted/slowed
      // casts play at the right tempo (retail `Framerate *= speed`). Link
      // clips play at native rate otherwise, so identity (1.0) is a no-op
      // and brief locomotion transition links are unaffected (fail-soft).
      const linkSpeed = inst._motionSpeed ?? 1.0;
      if (linkSpeed !== 1.0) {
        try { action.setEffectiveTimeScale(linkSpeed); } catch (_) {}
      }
      action.reset();
      action.play();
      // A5-P3 (?rootMotionObject=1) — arm the completion-time anchor
      // apply for a one-shot overlay whose clip carries a significant
      // net root displacement. Remote entities only (local-player anchor
      // is the wasm integrator — P3-L deferred). The `finished` listener
      // fires inside `mixer.update`, i.e. BEFORE this frame's
      // per-instance hook drain at the end of the tick body — matching
      // retail's position-resolve-before-process_hooks order
      // (acclient.c:320031 before :320035) on BOTH ?hookDrain states,
      // so no second owner is needed at the drain site (S13 §3 step 6).
      if (
        this._rootMotionObjectOn &&
        hasRootMotion(entry.rootMotionNet) &&
        !this._isLocalPlayerGuid(inst.guid >>> 0)
      ) {
        this._armRootMotionOnFinish(inst, action, entry.rootMotionNet);
      }
      // Audit C1 (CMT remote-swing double-play dedup): a SERVER
      // KIND_MOTION_ACTION swing/cast routes through here (setMotion's
      // `cls === "attack"|"cast"` branch) and raw-plays WITHOUT touching
      // `inst.currentActionKey` (it stays on the locomotion key) — the
      // overlay clip lives under a `link:` key, and we never stamp
      // `actionLastUsedMs` for it either. The index.html damageTaken/CMT
      // guessed-swing dedup guard keys on `currentActionKey.startsWith(
      // "swing:")`, so it MISSES an in-flight server swing routed this way
      // and the CMT guess fires a SECOND swing on top (double-play). Stamp
      // a timestamp here (attack/cast classes only — locomotion transition
      // links must NOT suppress a later legitimate CMT swing) so that guard
      // can also recognize an active server swing for the same target
      // within its STALE_SWING_MS window.
      {
        const _tcls = (typeof classifyMotionCommand === "function")
          ? classifyMotionCommand(toCmd >>> 0)
          : null;
        if (_tcls === "attack" || _tcls === "cast") {
          inst._lastServerSwingMs = performance.now();
          // F15-1: make this one-shot full-body (ramp the base cycle to 0).
          // Unconditional since the ?fullBodyOneShot flag was retired 2026-06-18.
          this._suppressBaseCycleForOverlay(inst, action);
        }
      }
      console.log(
        `[motion-link] 0x${(inst.guid >>> 0).toString(16)} ${fromCmd.toString(16)}→${toCmd.toString(16)} stance=${stance.toString(16)} (link clip played, ${entry.hooks?.length ?? 0} hooks)`,
      );
      // Follow-on hook for __diag.motion combat-swing observation.
      // The locomotion crossFadeTo path at L~2005 already lands on
      // onMotionApplied; this site is the link-clip path (attacks,
      // casts, gesture loops) which raw-plays without touching
      // inst.currentActionKey. Fires a SEPARATE link-played event so
      // the diag surface can tell "swung" apart from "transitioned
      // motion state" without one event blocking the other.
      if (typeof window !== "undefined" && window.__diag?.motion?.onMotionLinkPlayed) {
        try {
          window.__diag.motion.onMotionLinkPlayed({
            guid: inst.guid >>> 0,
            name: inst.meta?.name ?? "",
            fromCmd: fromCmd >>> 0,
            toCmd: toCmd >>> 0,
            stance: stance >>> 0,
            hookCount: entry.hooks?.length ?? 0,
            linkKey,
          });
        } catch (_) { /* never block the play path */ }
      }
    } catch (e) {
      console.warn(`[motion-link] play failed: ${e?.message ?? e}`);
      return false;
    }
    return true;
  }

  // F15-1 — make a one-shot overlay (attack/cast/emote) FULL-BODY by ramping
  // the base locomotion cycle's effectiveWeight to 0 for the overlay's
  // duration, then restoring it on the overlay's 'finished' event. Without
  // this, three.js normalizes the overlay + still-running base cycle to ~50/50,
  // so swings play at half amplitude and pop to the base pose in one frame at
  // clip end. Mirrors retail's remove_cyclic_anims-then-re-add. Gated by the
  // caller on ?fullBodyOneShot; a same-overlay guard avoids duplicate
  // listeners on rapid replay (spam-click).
  _suppressBaseCycleForOverlay(inst, overlayAction) {
    try {
      if (!inst || !overlayAction || !inst.mixer) return;
      if (inst._baseSuppressAction === overlayAction) return; // already suppressing this overlay
      const baseKey = inst._locoCycleKey;
      if (!baseKey) return;
      const baseAction = inst.actions?.get(baseKey);
      if (!baseAction || baseAction === overlayAction) return;
      if (typeof baseAction.isRunning === "function" && !baseAction.isRunning()) return;
      const savedWeight = (typeof baseAction.getEffectiveWeight === "function")
        ? baseAction.getEffectiveWeight()
        : 1.0;
      baseAction.setEffectiveWeight(0);
      inst._baseSuppressAction = overlayAction;
      // A5-P1b (?hookDrain=on): do NOT register the mixer listener —
      // the restore moves into `_completeOverlay`, reached via the
      // drain queue's `animDone` record (the listener and the queue
      // path must be mutually exclusive or the weight double-restores;
      // spec S5 §5 risk 5). Record what the restore needs instead.
      if (HOOK_DRAIN_ON) {
        inst._baseSuppressSaved = { savedWeight, baseAction };
        return;
      }
      const mixer = inst.mixer;
      const onFinished = (e) => {
        if (e.action !== overlayAction) return;
        try { mixer.removeEventListener("finished", onFinished); } catch (_) {}
        if (inst._baseSuppressAction === overlayAction) inst._baseSuppressAction = null;
        // Restore only if the loco cycle is still this same action (a motion
        // change may have swapped it; the old action is then irrelevant and
        // already faded out).
        const cur = inst.actions?.get(inst._locoCycleKey);
        if (cur === baseAction) {
          try { baseAction.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); } catch (_) {}
        }
      };
      mixer.addEventListener("finished", onFinished);
    } catch (_) { /* never block the swing on the weight-ramp */ }
  }

  // A5-P3 (2026-06-12, W3+ S13, `?rootMotionObject=1`) — register a
  // one-shot `finished` listener that applies the overlay clip's net root
  // displacement to the entity anchor when (and only when) the clip runs
  // to natural completion. Pattern of `_suppressBaseCycleForOverlay`'s
  // `onFinished`: same-action guard via `inst._pendingRootMotion ===
  // action` so a spam-replay (reset/play on the reused action) REFRESHES
  // the captured pose timestamp instead of stacking listeners — one
  // completed play = at most one apply. `poseTs` is captured at play time
  // from the per-guid KIND_POSITION stamp (loop.js `__lastEntityWorldPos`
  // slot `.ts`); the apply-side freshness gate compares it.
  // An INTERRUPTED overlay (action.stop()/motion swap before completion)
  // never fires `finished` → applies NOTHING (accepted approximation gap
  // vs retail's per-crossed-frame partial application,
  // acclient.c:340713-340727; S13 spec §3 step 5 / §5).
  _armRootMotionOnFinish(inst, action, net) {
    try {
      if (!inst || !action || !inst.mixer) return;
      const g = inst.guid >>> 0;
      let poseTs = 0;
      if (typeof window !== "undefined" && window.__lastEntityWorldPos) {
        poseTs = window.__lastEntityWorldPos.get(g)?.ts ?? 0;
      }
      if (inst._pendingRootMotion === action) {
        // Re-arm (spam replay): refresh the captured timestamp only —
        // the existing listener stays registered and applies once.
        inst._pendingRootMotionPoseTs = poseTs;
        return;
      }
      inst._pendingRootMotion = action;
      inst._pendingRootMotionPoseTs = poseTs;
      const mixer = inst.mixer;
      const onFinished = (e) => {
        if (e.action !== action) return;
        try { mixer.removeEventListener("finished", onFinished); } catch (_) {}
        if (inst._pendingRootMotion === action) inst._pendingRootMotion = null;
        this._applyRootMotionToAnchor(inst, net, inst._pendingRootMotionPoseTs ?? 0);
      };
      mixer.addEventListener("finished", onFinished);
    } catch (_) { /* never block the play path */ }
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
   * A5-P1b + A4-Q2 (2026-06-12, W3+ S5) — the ONE owner of overlay-end
   * work, reached via the drain queue's `animDone` record (?hookDrain=on).
   *
   * 1. Base-cycle weight restore: the flag-path counterpart of
   *    `_suppressBaseCycleForOverlay`'s `onFinished` listener (which is
   *    NOT registered under ?hookDrain — mutually exclusive, no
   *    double-restore). Restores only if the loco cycle is still the same
   *    action (a motion change may have swapped it; the old action is
   *    then irrelevant and already faded out) — same rule as the
   *    listener.
   * 2. The A4-Q2 notify (?mtQueue=on): tagged local-player overlays
   *    report completion across the wasm boundary (retail success is
   *    hard-coded 1 on the renderer path, CPartArray::AnimationDone(v1,
   *    1), acclient.c:317093). A no-op until a caller tags plays AND
   *    both the flag + the v4 pkg are live.
   *
   * `finished` is true for natural clip end (the only current caller);
   * cancellation paths (eviction) notify `false` directly via
   * `notifyMtQueuedOverlayDone` without the weight-restore step.
   */
  _completeOverlay(inst, key, action, finished) {
    try {
      if (inst && action && inst._baseSuppressAction === action) {
        inst._baseSuppressAction = null;
        const saved = inst._baseSuppressSaved;
        inst._baseSuppressSaved = null;
        if (saved && saved.baseAction) {
          const cur = inst.actions?.get(inst._locoCycleKey);
          if (cur === saved.baseAction) {
            try {
              saved.baseAction.setEffectiveWeight(
                saved.savedWeight > 0 ? saved.savedWeight : 1.0
              );
            } catch (_) {}
          }
        }
      }
    } catch (_) { /* never block the drain on the weight-restore */ }
    notifyMtQueuedOverlayDone(inst, key, !!finished);
  }

  /**
   * A4-Q3 (2026-06-12, unification survey) — exit-world overlay
   * cancellation: retail drains every pending one-shot with success=0
   * across an enter/exit-world transition
   * (`MotionTableManager::HandleExitWorld`, acclient.c:329940-329947)
   * and enter-world additionally removes ALL sequence link animations
   * (`HandleEnterWorld` → `CSequence::remove_all_link_animations`,
   * acclient.c:329949-329957) — an emote/swing/cast must NOT carry
   * across a teleport/portal transit. This is the renderer half of
   * that pair: stop every RUNNING `THREE.LoopOnce` overlay action
   * (one-shot links + transition links — retail removes link anims
   * wholesale; NEVER the LoopRepeat base locomotion cycle), restore an
   * F15-1-suppressed base-cycle weight, and cancellation-notify tagged
   * keys success=false through `_completeOverlay`. The Rust half (the
   * `PlayerTeleport` recv arms → `MovementSystem::handle_exit_world_for`)
   * drains the pending queue independently — whichever lands second
   * no-ops on the empty queue (acclient.c:329884 head-null guard).
   *
   * Gated by `?mtQueue=on` (A4 §4 stage Q3 "rollback: same flags") —
   * default OFF; the portal-cancel visual is the 1070 eye-test
   * acceptance.
   */
  _cancelOneShotOverlays(inst) {
    if (!MT_QUEUE_ON || !inst || !inst.actions || !inst.mixer) return;
    for (const [key, action] of inst.actions) {
      try {
        if (!action || action.loop !== THREE.LoopOnce) continue;
        if (typeof action.isRunning === "function" && !action.isRunning()) continue;
        // Legacy (non-?hookDrain) F15-1 suppression keeps its saved
        // weight inside the mixer 'finished' closure, which never fires
        // on stop() — capture before `_completeOverlay` clears the
        // marker, then restore manually (the listener's own fallback is
        // 1.0 for a non-positive saved weight, so 1.0 here matches).
        const legacySuppressed =
          inst._baseSuppressAction === action && !inst._baseSuppressSaved;
        // ?hookDrain weight restore + tagged cancellation notify
        // (success=false — the exit-world drain semantics; a COMPLETED
        // overlay already cleared its tag, so the notify is a no-op for
        // it).
        this._completeOverlay(inst, key, action, false);
        if (legacySuppressed) {
          const base = inst.actions.get(inst._locoCycleKey);
          if (base && base !== action) {
            try { base.setEffectiveWeight(1.0); } catch (_) {}
          }
        }
        action.stop();
      } catch (_) { /* never block the teleport on overlay teardown */ }
    }
  }

  /**
   * A4-Q3 — public guid-keyed wrapper for `_cancelOneShotOverlays`;
   * called from the `index.html` kind=33 `PortalSpaceEntered` drain for
   * the LOCAL player (the portal-transit hook — the wasm recv arm fires
   * the matching Rust-side `handle_exit_world_for` from the same
   * `PlayerTeleport` message). No-op when the guid is unknown or
   * `?mtQueue` is off.
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
    this._worldParticleManager = new ParticleManager({
      scene: this.scene3d?.entitiesGroup ?? rig?.parent ?? null,
      geometryFactory: async (hwGfxObjId) => {
        const r = await resolveGfxObj(hwGfxObjId);
        return r?.geometry ?? null;
      },
      materialFactory: async (hwGfxObjId) => {
        if (!materialCache) return null;
        const r = await resolveGfxObj(hwGfxObjId);
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
    const existing = inst._entityMaterials.get(did);
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
    // Re-point every Mesh under `inst.parts` that referenced the
    // shared material. Spawn (~line 1671) stamps `userData.surfaceDid`
    // on each Mesh so this lookup is O(parts × meshes_per_part).
    if (Array.isArray(inst.parts)) {
      for (const part of inst.parts) {
        if (!part) continue;
        for (const child of part.children) {
          if (!child || !child.isMesh) continue;
          if ((child.userData?.surfaceDid >>> 0) === did) {
            child.material = cloned;
          }
        }
      }
    }
    return cloned;
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
          const volume = e.soundVolume > 0 ? e.soundVolume : 1.0;
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
              audioMgr.play(waveId, { x: a4t[0], y: a4t[1], z: a4t[2] }, { gain: volume, followGuid: (guid >>> 0) }).catch(() => {});
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
      if (depth >= MAX_CALL_PES_DEPTH) return;
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
          this._queuePhysicsScript(gKey, rig, callDid, subEntries, depth + 1, defaultPartIndex, subStart);
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
      if (inst._lodRespawning) continue; // a band query / respawn is in flight
      if (this.spawnInFlight.has(g)) continue;
      if (inst._jumpPoseTween) continue; // (swing/cast tweens retired, WS-B 2026-06-18)
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
      let rdt = (now - last) / 1000;
      inst._ballisticLastMs = now;
      if (!(rdt > 1e-4)) continue;
      // Retail update_object treats a >2 s gap as a teleport and does NOT
      // integrate across it (acclient.c:323120-323159) — otherwise an alt-tab
      // would hurl the bolt forward. (Moot in practice: a projectile despawns
      // on impact within ~1 s, so it's long gone after any real stall.)
      if (rdt > 2.0) continue;
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
    }
  }

  /**
   * Per-rAF tick. Advances every entity's mixer by dt seconds.
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
    if (!(dt > 0)) return;
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
    const _gaitThrottleOn = GAIT_RECOMPUTE_INTERVAL_MS > 0;
    const _gaitNowMs = _gaitThrottleOn
      ? (typeof performance !== "undefined" ? performance.now() : 0)
      : 0;
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
          const gx = tp.x + ux * ENTITY_STICKY_STANDOFF_M;
          const gy = tp.y + uy * ENTITY_STICKY_STANDOFF_M;
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
      if (runSmoothing && this._deadReckonOn && inst._serverTargetPos && !inst._ballistic && !stickyGlued && !wasmDriven && !inst._deadFrozen) {
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
      // position delta this frame, then scale the active loco cycle's
      // playback rate by (actual / authored). Set BEFORE mixer.update so the
      // rate applies this frame. cycleTimeScale clamps [0.25, 4.0], so a
      // server-pose snap can't freeze or hyper-spin the rig. ?velScale=on only.
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
        const base = inst._locoBaseSpeed;
        // RP2 (2026-06-08) — gait recompute throttle. The EMA sampling above
        // ran this frame regardless; the EXPENSIVE part (the wasm getter call,
        // `cycleTimeScale`, `setEffectiveTimeScale`) is what we cap to ~gaitHz.
        // When throttled, three.js retains the last `effectiveTimeScale` on the
        // action, so the gait holds its previous (low-pass-EMA-derived) value —
        // imperceptible since the EMA barely moves between frames. Default
        // (`gaitHz` absent → interval 0) → `_gaitThrottleOn` false → recompute
        // every frame, byte-identical to pre-RP2.
        let _gaitRecompute = true;
        if (_gaitThrottleOn) {
          const last = inst._gaitLastRecomputeMs;
          if (last !== undefined && _gaitNowMs - last < GAIT_RECOMPUTE_INTERVAL_MS) {
            _gaitRecompute = false;
          }
        }
        if (_gaitRecompute && base > 0 && inst._locoCycleKey) {
          const locoAction = inst.actions.get(inst._locoCycleKey);
          if (locoAction && locoAction.isRunning()) {
            if (_gaitThrottleOn) inst._gaitLastRecomputeMs = _gaitNowMs;
            // T1: prefer the wasm `stateGroundSpeed` getter (a mirror of retail
            // CMotionInterp::get_state_velocity) for the 'actual' ground anim-
            // speed instead of the rig XZ-position-delta EMA. The getter is pure
            // math over the interpreted motion state (forward_command/_speed +
            // sidestep_command/_speed) and a JS-supplied run_rate, returning the
            // FINAL m/s with run_rate ALREADY applied internally (it clamps to
            // run_rate*4.0) — so we feed the result straight into cycleTimeScale
            // and DO NOT re-scale by run_rate. The EMA stays only as a fallback
            // when the getter is absent (older wasm) or returns null/0 — e.g.
            // when no forward/sidestep command is stashed yet — so server-pose
            // snaps / teleports / rubber-banding (which the EMA reads as garbage)
            // can't poison the gait once the getter is live.
            // T1 fix (2026-06-03): track whether the speed came from the wasm
            // getter. The getter's value ALREADY encodes UpdateMotion.forward_speed
            // (== inst._motionSpeed) and run_rate, so velScaleComponent below is the
            // COMPLETE framerate scale — re-multiplying by motionSpeed would
            // double-count forward_speed (0.5 -> 0.25 at half speed).
            let actualSpeed = this._resolveStateGroundSpeed(inst);
            const speedFromGetter = Number.isFinite(actualSpeed) && actualSpeed > 0;
            if (!speedFromGetter) {
              actualSpeed = inst._emaSpeed ?? 0;
            }
            // A1 (2026-05-29): compose the server playback speed
            // (`inst._motionSpeed`) WITH the T11 velocity-scale factor into
            // ONE timeScale — multiply, do not clobber. velScaleComponent is
            // the anti-ice-skating gait (actual/authored ground speed);
            // motionSpeed is retail's `Framerate *= speed`. Identity (1.0)
            // motionSpeed leaves T11 untouched (fail-soft).
            const velScaleComponent = cycleTimeScale(actualSpeed, base);
            const motionSpeed = inst._motionSpeed ?? 1.0;
            // Getter path: velScaleComponent is the single, complete scale (retail
            // applies the speed scalar ONCE). EMA-fallback path keeps the legacy
            // compose-with-motionSpeed behavior unchanged. (Eye-test TODO: the EMA
            // path likely double-counts too; revisit when flipping VEL_SCALE_ON on.)
            // F15-2 — apply the backstep direction AFTER cycleTimeScale's
            // positive [0.25,4.0] clamp, so a negative final timeScale (reverse
            // playback) survives. Sign is +1 unless ?signedMotionSpeed flips it,
            // so this is byte-identical when the flag is off.
            const dir = inst._motionSpeedSign ?? 1;
            locoAction.setEffectiveTimeScale(
              (speedFromGetter ? velScaleComponent : velScaleComponent * motionSpeed) * dir,
            );
          }
        }
      }
      try {
        if (inst._unifiedSeq) {
          // A one-shot Rust MotionSequence owns the rig (full-body, no blend) —
          // SUPPRESS the mixer AND _unifiedLoco (single playhead). attack
          // (clearOnDone:true) hands back on completion → the tick then falls to
          // _unifiedLoco below (locomotion resumes); death (clearOnDone:false)
          // holds the clamped prone frame.
          const ua = inst._unifiedSeq;
          ua.seq.advance(dt);
          poseRigAt(ua.seq.globalFrameIndex, ua.desc, inst.parts);
          this._drainUnifiedHooks(inst, ua); // swoosh / chime / strike (Step 6)
          if (ua.seq.done && ua.clearOnDone) {
            try { ua.seq.free(); } catch (_) { /* already freed */ }
            inst._unifiedSeq = null;
          }
        } else if (inst._unifiedLoco) {
          // ?unifiedMotion=locomotion: drive the cyclic locomotion sequence with
          // gait scaling (anti-ice-skating velScale × server motionSpeed — the
          // same math the mixer path applied via setEffectiveTimeScale) by
          // advancing the playhead faster/slower. frameNumber carries phase, so
          // the swap band-aids (CROSSFADE_S=0, RESUME_WINDOW) aren't needed.
          const lo = inst._unifiedLoco;
          lo.seq.advance(dt * this._unifiedLocoGaitScale(inst, lo.base));
          poseRigAt(lo.seq.globalFrameIndex, lo.desc, inst.parts);
          this._drainUnifiedHooks(inst, lo); // footfalls (wrap-aware)
        } else {
          inst.mixer.update(dt);
        }
      } catch (e) {
        // Don't let one bad mixer kill the whole tick.
        // eslint-disable-next-line no-console
        if (!this._mixerWarned) {
          this._mixerWarned = true;
          console.warn("[phase7.4b] mixer.update threw:", e);
        }
      }
      // Task E (2026-05-12): AnimationMixer hook execution.
      // After advancing the mixer, fire any baked-cycle hooks whose
      // time-in-clip we crossed this tick. Wrapped in try/catch so a
      // bad single-entity hook doesn't tank the whole tick.
      try {
        this._tickAnimationHooks(inst);
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!this._hookTickWarned) {
          this._hookTickWarned = true;
          console.warn(
            `[entities/task-E] hook tick failed for entity 0x${inst.guid.toString(16)}:`,
            e
          );
        }
      }
      // Wave 1.7 (2026-05-26) — Jump-pose tween advance. Runs AFTER
      // mixer.update so our per-part slerp wins on the locked-out
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
            } else if (rec.kind === "animDone") {
              this._completeOverlay(inst, rec.key, rec.action, true);
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
    // Wave 7 Phase 7.1 (2026-05-26): periodic prune of stale entries in
    // each entity's `_recentLocomotionTime` cache. The restore-window is
    // 200 ms, so anything older than 5 s is dead weight. Rate-limited to
    // once/second so the per-entity Map walk doesn't run every frame.
    const nowMs = performance.now();
    if (nowMs - this._lastRecentLocomotionPruneMs > 1000) {
      this._lastRecentLocomotionPruneMs = nowMs;
      const STALE_THRESHOLD_MS = 5000;
      for (const inst of this.entityMap.values()) {
        if (!inst._recentLocomotionTime || inst._recentLocomotionTime.size === 0) {
          continue;
        }
        for (const [key, entry] of inst._recentLocomotionTime) {
          if (nowMs - entry.leftAt > STALE_THRESHOLD_MS) {
            inst._recentLocomotionTime.delete(key);
          }
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
   * Task E (2026-05-12) — fire any AnimationHook entries whose
   * time-in-clip the current action just crossed.
   *
   * Algorithm:
   *   1. Resolve the currently-playing action + its cacheKey.
   *      Bail if no action (rest pose) or no timeline registered for
   *      the current action.
   *   2. Read `action.time` (three.js's per-action playback time,
   *      seconds since the action started or was last `.reset()`'d;
   *      monotonically increasing within a loop pass, wraps to 0
   *      when the clip loops).
   *   3. Read `lastTime = inst.actionLastHookTime.get(cacheKey)` —
   *      where we left off last tick. Initialised to 0 in
   *      `_spawnImpl` / `setMotion` when the timeline is first
   *      stashed.
   *   4. Walk the sorted hook list:
   *      - Normal case (`currentTime >= lastTime`): fire each hook
   *        with `lastTime < hook.time <= currentTime`.
   *      - Wrap case (`currentTime < lastTime`): the clip looped.
   *        Fire hooks in `(lastTime, clipDuration]` AND `[0, currentTime]`.
   *        Both branches respect the sorted order; the wrap branch
   *        walks the tail of the list then the head.
   *   5. Save `currentTime` as the new `lastTime`.
   *
   * Hook handlers (this task lands Sound + SoundTable only):
   *   - hookType 1 (Sound): hook.soundWaveId is the Wave DID to play.
   *     Call `audioManager.play(waveId, entity.position)`.
   *   - hookType 2 (SoundTable): hook.soundEnum is the Sound enum to
   *     resolve through the entity's SoundTable.
   *     `await soundTableCache.resolveSound(inst.soundTableDid,
   *     soundEnum)` returns `{waveDid, ...}` or null. Fire-and-forget
   *     — the prewarm in `_spawnImpl` makes the await effectively
   *     synchronous after the first frame.
   *   - hookType 13 (CreateParticle), 21 (SoundTweaked), others —
   *     TODO debug-stub. Counts via `inst._unhandledHookFires` so
   *     the diag script can verify the handler reaches them.
   */
  _tickAnimationHooks(inst) {
    // Walk EVERY running action on the mixer — `inst.currentAction`
    // (the locomotion cycle) AND any one-shot overlay actions like
    // the swing/cast link clips played via `_tryPlayLink`. The
    // pre-fix version only inspected `currentAction`, so combat
    // overlays' hooks (sword swoosh on type=1 Sound, magic chime
    // resolved through type=2 SoundTable, future AttackHook
    // strike-frame events) never fired.
    //
    // For an action that finished (LoopOnce past duration,
    // `isRunning() === false`) we skip — three.js stops advancing
    // `.time` so re-firing trailing hooks would be a bug.
    if (!inst.actions || inst.actions.size === 0) return;
    const audioMgr = this.scene3d?.audioManager ?? null;
    const cache = this.scene3d?.soundTableCache ?? null;
    for (const [key, action] of inst.actions) {
      // A5-P1 (?hookDrain=on) — finish-drain + completion-record path:
      // window math via the pure planner (`hook_windows.js`), which adds
      // exactly one behavior the legacy branch below lacks: a LoopOnce
      // that crossed its end between two rAFs fires its trailing hooks in
      // (lastTime, clipDuration] ONCE (retail clamp-at-high_frame,
      // acclient.c:340697-340727) and then queues an `animDone` record
      // AFTER them (retail order, :340725 → :340764-340774). The hooks
      // themselves are QUEUED, not fired inline — `_fireHooksInRange`
      // pushes records under this flag; the per-instance drain at the end
      // of the tick body executes them. Legacy off-path below is
      // byte-identical to pre-S5.
      if (HOOK_DRAIN_ON) {
        if (!action) continue;
        // `has()` check BEFORE planning: an action that was never
        // played/armed (no `actionLastHookTime` entry — every play site
        // seeds 0) must not finish-drain.
        const wasArmed = inst.actionLastHookTime.has(key);
        let isRunning = false;
        let isLoopOnce = false;
        let currentTime = 0;
        let clipDuration = 0;
        try {
          isRunning = !!action.isRunning();
          isLoopOnce = action.loop === THREE.LoopOnce;
          currentTime = +action.time;
          const clip = action.getClip();
          clipDuration = clip ? +clip.duration : 0;
        } catch (_) {
          continue;
        }
        if (!isRunning && !wasArmed) continue;
        let lastTime = inst.actionLastHookTime.get(key);
        if (lastTime === undefined) lastTime = 0;
        const plan = planHookWindows({
          lastTime,
          currentTime,
          clipDuration,
          isRunning,
          isLoopOnce,
        });
        const timeline = inst.hookTimelines.get(key);
        if (timeline && timeline.length > 0) {
          for (const w of plan.windows) {
            this._fireHooksInRange(inst, timeline, w[0], w[1], audioMgr, cache);
          }
        }
        if (plan.finished) {
          // Completion record rides the SAME queue, after this overlay's
          // trailing hook records — drained by `_completeOverlay`.
          inst._hookFireQueue.push({ kind: "animDone", key, action });
        }
        if (isRunning) inst.actionLastHookTime.set(key, currentTime);
        else if (plan.drainedTo !== null) inst.actionLastHookTime.set(key, plan.drainedTo);
        continue;
      }
      if (!action || !action.isRunning()) continue;
      const timeline = inst.hookTimelines.get(key);
      if (!timeline || timeline.length === 0) continue;
      // three.js exposes `AnimationAction.time` as time-in-clip
      // (seconds within the action's clip; for LoopRepeat actions, it
      // wraps to 0 at duration each pass).
      let currentTime = 0;
      let clipDuration = 0;
      try {
        currentTime = +action.time;
        const clip = action.getClip();
        clipDuration = clip ? +clip.duration : 0;
      } catch (_) {
        continue;
      }
      if (!(clipDuration > 0)) continue;
      let lastTime = inst.actionLastHookTime.get(key);
      if (lastTime === undefined) lastTime = 0;
      if (currentTime >= lastTime) {
        // Common case: monotonic advance within one loop pass.
        this._fireHooksInRange(inst, timeline, lastTime, currentTime, audioMgr, cache);
      } else {
        // Wrap-around: a LoopRepeat cycle wrapped past clip end. Fire
        // (lastTime, clipDuration] then (-Inf, currentTime]. LoopOnce
        // overlays don't wrap, so this branch fires for locomotion only.
        this._fireHooksInRange(inst, timeline, lastTime, clipDuration, audioMgr, cache);
        this._fireHooksInRange(inst, timeline, -Infinity, currentTime, audioMgr, cache);
      }
      inst.actionLastHookTime.set(key, currentTime);
    }
  }

  /**
   * Walk a sorted-by-time hook list and fire those in
   * `(lowExclusive, highInclusive]`. Sound (1) + SoundTable (2)
   * land audio playback; other hook types increment a debug counter
   * so the diag-script can assert the executor reached them.
   *
   * Called by `_tickAnimationHooks` — split out so the wrap-around
   * branch can reuse the same range walker for both halves of the
   * looped range.
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
        .play(waveId, { x: sndT[0], y: sndT[1], z: sndT[2] })
        .catch(() => {});
      this._soundHookFires = (this._soundHookFires | 0) + 1;
      return;
    }
    if (hookType === 2) {
      // SoundTable — payload is a Sound enum. Resolve via the entity's
      // SoundTable to get a Wave DID + per-row volume.
      const soundEnum = hook.soundEnum >>> 0;
      if (soundEnum === 0 || !cache || !audioMgr) return;
      const stbDid = inst.soundTableDid >>> 0;
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
          const gain = entry.volume > 0 ? entry.volume : 1.0;
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
      const gain = hook.soundVolume > 0 ? +hook.soundVolume : 1.0;
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
      this._applyEtherealToEntity(inst, wantEthereal);
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
        kill.push(guid);
      }
    }
    if (kill) {
      for (const guid of kill) {
        try { this.remove(guid); } catch (_) {}
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
