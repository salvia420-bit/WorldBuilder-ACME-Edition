//! Flat-buffer contract between the kernel and scene3d/rust/particles.js.
//!
//! Every index here is mirrored by the `L` table at the top of
//! apps/holtburger-web/scene3d/rust/particles.js; change both together (the
//! node parity test and the cargo fixtures both go through these offsets).
//! All inputs are `f64` (JS numbers, bit-exact) except the per-handle flag
//! words, which are `u32`. Outputs are `f32` instance data (what the
//! InstancedMesh attributes hold) and `u32` records.

// ---- configuration (once per ParticleSystem) ------------------------------
/// particle.js `SWARM_ACE_LEGACY` (`?swarmAce=on`).
pub const CFG_SWARM_ACE: usize = 0;
/// particle.js `PARTICLE_INIT_ACE_LEGACY` (`?particleInitAce=on`).
pub const CFG_INIT_ACE: usize = 1;
/// particle.js `PARTICLE_ROT_EULER_LEGACY` (`?particleRotAce=on`).
pub const CFG_ROT_EULER: usize = 2;
/// particle.js `PARTICLE_INIT_FRAME_ACE_LEGACY` (`?particleInitFrameAce=on`).
pub const CFG_INIT_FRAME_ACE: usize = 3;
pub const CFG_LEN: usize = 4;

// ---- emitter descriptor (add_emitter) --------------------------------------
pub const D_ID: usize = 0;
pub const D_EMITTER_TYPE: usize = 1;
pub const D_PARTICLE_TYPE: usize = 2;
pub const D_BIRTHRATE: usize = 3;
/// `info.maxParticles` AFTER the quality cap (= `parts.length`).
pub const D_MAX_PARTICLES: usize = 4;
pub const D_TOTAL_PARTICLES: usize = 5;
pub const D_TOTAL_SECONDS: usize = 6;
pub const D_LIFESPAN: usize = 7;
pub const D_LIFESPAN_RAND: usize = 8;
pub const D_OFFSET_DIR: usize = 9; // 3
pub const D_MIN_OFFSET: usize = 12;
pub const D_MAX_OFFSET: usize = 13;
pub const D_A: usize = 14; // 3
pub const D_MIN_A: usize = 17;
pub const D_MAX_A: usize = 18;
pub const D_B: usize = 19; // 3
pub const D_MIN_B: usize = 22;
pub const D_MAX_B: usize = 23;
pub const D_C: usize = 24; // 3
pub const D_MIN_C: usize = 27;
pub const D_MAX_C: usize = 28;
pub const D_SCALE_RAND: usize = 29;
pub const D_START_SCALE: usize = 30;
pub const D_FINAL_SCALE: usize = 31;
pub const D_TRANS_RAND: usize = 32;
pub const D_START_TRANS: usize = 33;
pub const D_FINAL_TRANS: usize = 34;
pub const D_PARENT_LOCAL: usize = 35;
pub const D_BILLBOARD: usize = 36;
/// `emitter.parentOffset` (after setParenting).
pub const D_PO_POS: usize = 37; // 3
pub const D_PO_QUAT: usize = 40; // 4
/// `emitter.lastEmitOffset` after setParenting (`_emitterOrigin`).
pub const D_LAST_EMIT_OFFSET: usize = 44; // 3
/// The ParticleEmitter constructor's two clock reads.
pub const D_LAST_EMIT_TIME: usize = 47;
pub const D_LAST_UPDATE_TIME: usize = 48;
/// `_createdSlots` after setInfo (the lazy initial working set).
pub const D_CREATED_SLOTS: usize = 49;
/// initEnd: `creationTime` / the burst's clock, and the burst count
/// (`_initialParticlesRetail() ? initialParticles | 0 : …`).
pub const D_INIT_NOW: usize = 50;
pub const D_BURST: usize = 51;
/// The anchor frame (`_resolveAnchorFrame()`, `_scene`-local) for initEnd and,
/// when `D_CACHED`, for the emitter's whole life.
pub const D_ANCHOR_POS: usize = 52; // 3
pub const D_ANCHOR_QUAT: usize = 55; // 4
/// 1 = frozen static anchor: anchor frame and RP6 sphere are constant, so the
/// kernel keeps them and decides RP6 itself. 0 = dynamic: JS supplies the
/// anchor (when `needs_anchor`) and the RP6 decision (flag word bit 0).
pub const D_CACHED: usize = 59;
/// `rp6CullSphere(emitter)` (world centre + radius; radius < 0 = never cull).
pub const D_RP6_CENTER: usize = 60; // 3
pub const D_RP6_RADIUS: usize = 63;
pub const D_DEGRADE_DISTANCE: usize = 64;
pub const D_FORCE_DEGRADE: usize = 65;
/// Bucket route (JS interns `(key, base material)`), shared-alpha eligibility
/// (`alpha && !skyGlow`) and whether a bucket this emitter creates is an FX
/// bucket (`!skyGlow && base.isMeshBasicMaterial && !base.wireframe`).
pub const D_ROUTE: usize = 66;
pub const D_SHARED_ELIGIBLE: usize = 67;
pub const D_FX_IF_CREATE: usize = 68;
/// `_fxRow`, whether the row spawns tier-1 kids / has a tier-2 stretch, the
/// teleport speed² (`particleFxTeleportSpeedSq`) and `renderLayer | 0`.
pub const D_ROW: usize = 69;
pub const D_KIDS_ROW: usize = 70;
pub const D_STRETCH_ROW: usize = 71;
pub const D_VEL_LIM_SQ: usize = 72;
pub const D_RENDER_LAYER: usize = 73;
/// `_bbMode` (2..5 or 0) and the sprite quad's local normal
/// (`_billboardLocalNormal`, only for `info.billboard` emitters).
pub const D_BB_MODE: usize = 74;
pub const D_HAS_BB_NORMAL: usize = 75;
pub const D_BB_NORMAL: usize = 76; // 3
pub const D_FILM_HIDDEN: usize = 79;
pub const D_RP6_CULLED: usize = 80;
pub const D_LEN: usize = 81;

// ---- set_emitter_field ids --------------------------------------------------
pub const F_DEGRADE_DISTANCE: u32 = 1;
pub const F_FORCE_DEGRADE: u32 = 2;
pub const F_BB_MODE: u32 = 3;
pub const F_FILM_HIDDEN: u32 = 4;
pub const F_STOPPED: u32 = 5;
pub const F_ID: u32 = 6;
/// The cached RP6 sphere (re-sent if the sphere flags flip at runtime).
/// (F_RP6_* are written only between ticks.)
pub const F_RP6_CX: u32 = 7;
pub const F_RP6_CY: u32 = 8;
pub const F_RP6_CZ: u32 = 9;
pub const F_RP6_RADIUS: u32 = 10;

// ---- per-tick globals --------------------------------------------------------
pub const G_NOW: usize = 0;
pub const G_FRAME: usize = 1;
pub const G_INTERVAL: usize = 2;
pub const G_RECHECK: usize = 3;
pub const G_STAGGER: usize = 4;
pub const G_HALF_PHASE: usize = 5;
pub const G_CAMERA_VALID: usize = 6;
/// RP6 `camera.position`.
pub const G_CAM_POS: usize = 7; // 3
/// RP6 frustum: six planes × (normal.x, normal.y, normal.z, constant).
pub const G_PLANES: usize = 10; // 24
pub const G_MAX_DISTANCE: usize = 34;
pub const G_DEGRADE_ON: usize = 35;
pub const G_DEGRADE_CAP_ON: usize = 36;
pub const G_CULL_FREEZE: usize = 37;
pub const G_LEAN_CULLED: usize = 38;
pub const G_CULLED_STOP_SECONDS: usize = 39;
pub const G_CELL_GATE: usize = 40;
/// Billboards: `bbCamera !== null`, `camera.position` (sprite mode) and the
/// camera in `_scene`-local space (retail modes).
pub const G_BB_ON: usize = 41;
pub const G_BB_CAM: usize = 42; // 3
pub const G_BB_CAM_LOCAL: usize = 45; // 3
/// Own alpha buckets' back-to-front sort: `this._instSortCam` (local).
pub const G_SORT_ON: usize = 48;
pub const G_SORT_CAM: usize = 49; // 3
pub const G_FX_ENABLED: usize = 52;
pub const G_FX_LIVE: usize = 53;
pub const G_KIDS_ON: usize = 54;
pub const G_MOTION_ON: usize = 55;
pub const G_SHARED_ON: usize = 56;
/// particle_fx.js xorshift32 seed state (`_rng >>> 0`), in and out.
pub const G_FX_SEED: usize = 57;
pub const G_LEN: usize = 58;

// ---- per-handle inputs ---------------------------------------------------------
/// `anchor_in`: 7 f64 per handle (pos xyz, quat xyzw).
pub const ANCHOR_STRIDE: usize = 7;
/// `flags_in` bit 0: the JS RP6 decision (`_rp6Culled`) of a dynamic emitter.
pub const FLAG_CULLED: u32 = 1;
/// `flags_in` bit 1: `_emitterCellHidden` this tick (dynamic emitters).
pub const FLAG_CELL_HIDDEN: u32 = 2;
/// `needs_anchor` (per handle, refreshed by add / stop / set_field(F_STOPPED)
/// and at the end of every tick): when JS must supply a dynamic emitter's
/// anchor next tick. Bits; JS resolves iff NEED_ALWAYS, or every present
/// condition bit holds — and never on a tick whose RP6 flag is culled when
/// NEED_SKIP_IF_CULLED is set. Conservative: an unused frame may be resolved,
/// a used one never skipped.
pub const NEED_NEVER: u32 = 0;
/// Unconditionally (a parent-local emitter with live particles).
pub const NEED_ALWAYS: u32 = 1;
/// Only when `now - anchor_last_emit[h] > info.birthrate` (the kernel's own
/// per-second emit test, evaluated by JS with the same expression).
pub const NEED_IF_DUE: u32 = 2;
/// Not on a culled tick: a persistent emitter that is not stopped reads no
/// anchor in the culled branch (no virtual emit, no drain).
pub const NEED_SKIP_IF_CULLED: u32 = 4;
/// Only when `now >= anchor_slot_free[h] - NEED_SLOT_MARGIN_US * 1e-6`: a
/// saturated emitter (`numParticles >= maxParticles`) emits — and a per-metre
/// one reads its origin to any effect — only once a live particle can die.
pub const NEED_IF_SLOT: u32 = 8;
/// The slot test's margin (µs), far above the f64 error of the threshold.
pub const NEED_SLOT_MARGIN_US: u32 = 1000;

// ---- route and key tables --------------------------------------------------------
/// `route_in`: per route (key id, alpha-material signature id).
pub const ROUTE_STRIDE: usize = 2;
/// `key_in`: per bucket key.
pub const K_OWN_EXISTS: usize = 0;
pub const K_OWN_CAP: usize = 1;
pub const K_OWN_FX: usize = 2;
pub const K_SH_EXISTS: usize = 3;
pub const K_SH_SIG: usize = 4;
pub const K_SH_SCENE_OK: usize = 5;
pub const K_SH_CAP: usize = 6;
pub const K_SH_START_N: usize = 7;
pub const K_SH_FX: usize = 8;
pub const K_ALPHA: usize = 9;
pub const KEY_STRIDE: usize = 10;

// ---- outputs ------------------------------------------------------------------
/// `events`: records of 3 u32 `[type, a, b]`, replayed by JS in order.
pub const EV_STRIDE: usize = 3;
/// Ensure the manager's own bucket for key `a` (created through emitter `b`).
pub const EV_OWN: u32 = 1;
/// `sharedAlphaBuckets.acquire` key `a` (created through emitter `b`).
pub const EV_SHARED: u32 = 2;
/// `_growBucket(own bucket a, need b)`.
pub const EV_GROW_OWN: u32 = 3;
/// `_growBucket(shared bucket a, need b)`.
pub const EV_GROW_SHARED: u32 = 4;
/// `this._kids || (this._kids = new ParticleFxKids(scene))`.
pub const EV_KIDS_MGR: u32 = 5;
/// `this._kids.layer(a)` (get-or-create).
pub const EV_KIDS_LAYER: u32 = 6;
/// `buckets`: records of 4 u32 `[kind, key, count, first instance]`.
pub const BK_STRIDE: usize = 4;
pub const BK_OWN: u32 = 0;
pub const BK_SHARED: u32 = 1;
/// Instance data: 16 f32 (matrix, column-major) + 3 f32 (instance colour).
pub const MAT_STRIDE: usize = 16;
pub const COL_STRIDE: usize = 3;
/// `kids`: records of 3 u32 `[layer, count, first record]`.
pub const KL_STRIDE: usize = 3;
/// Kid record: aKidPos (x, y, z, age), aKidVel (vx, vy, vz, opacity), aKidRow (row, seed).
pub const KID_STRIDE: usize = 10;
/// `stats` (f64).
pub const S_FORCE_STOPPED: usize = 0;
pub const S_CELL_HIDDEN: usize = 1;
pub const S_CELL_PARTICLE_TICKS: usize = 2;
pub const S_REJECTED_SCENE: usize = 3;
pub const S_REJECTED_MAT: usize = 4;
pub const S_FX_SEED: usize = 5;
pub const S_LEN: usize = 6;

// ---- emitter state query (emitter_state) -----------------------------------------
pub const Q_NUM_PARTICLES: usize = 0;
pub const Q_TOTAL_EMITTED: usize = 1;
pub const Q_CREATION_TIME: usize = 2;
pub const Q_LAST_EMIT_TIME: usize = 3;
pub const Q_LAST_UPDATE_TIME: usize = 4;
pub const Q_STOPPED: usize = 5;
pub const Q_CREATED_SLOTS: usize = 6;
pub const Q_CULLED: usize = 7;
pub const Q_LAST_EMIT_OFFSET: usize = 8; // 3
pub const Q_FROZEN_AT: usize = 11; // NaN = none
pub const Q_CULLED_SINCE: usize = 12; // NaN = none
pub const Q_GROWING: usize = 13;
pub const Q_LEN: usize = 14;
// `state_out` holds this Q_* row per handle (Q_LEN f64 each), published at
// add / stop / set_field and at the end of every tick (also for the emitters
// that finished in it), with any in-flight lazy grow already landed — the
// values `emitter_state` returns. JS field reads go through a view on it, so
// they cost no wasm call.

// ---- film_samples (film mode's per-emitter particle sample) ---------------------
/// `film_out`: per live emitter `[handle, n]` then n rows of FS_STRIDE f64 —
/// the first `max` slots that are live, visible, at a finite position and
/// whose `clamp01(isFinite(op) ? op : 1)` exceeds `op_min` (film/scene/
/// particles_query.js `sphereOf`'s sample, without building slot meshes).
pub const FS_X: usize = 0;
pub const FS_SCALE: usize = 3;
pub const FS_OP: usize = 4;
pub const FS_STRIDE: usize = 5;

// ---- per-slot export (slot_snapshot / export) -----------------------------------
/// One slot: live, visible, op, pos xyz, quat xyzw, scale, then the particle
/// (lastUpdateTime, birthtime, lifespan, lifetime, startFrame pos xyz + quat
/// xyzw, offset, a, b, c, startScale, finalScale, startTrans, finalTrans), then
/// the FX state (seed, life, vel ×8, kidPrev ×5).
pub const SL_LIVE: usize = 0;
pub const SL_VISIBLE: usize = 1;
pub const SL_OP: usize = 2;
pub const SL_POS: usize = 3; // 3
pub const SL_QUAT: usize = 6; // 4
pub const SL_SCALE: usize = 10;
pub const SL_LAST_UPDATE_TIME: usize = 11;
pub const SL_BIRTHTIME: usize = 12;
pub const SL_LIFESPAN: usize = 13;
pub const SL_LIFETIME: usize = 14;
pub const SL_SF_POS: usize = 15; // 3
pub const SL_SF_QUAT: usize = 18; // 4
pub const SL_OFFSET: usize = 22; // 3
pub const SL_A: usize = 25; // 3
pub const SL_B: usize = 28; // 3
pub const SL_C: usize = 31; // 3
pub const SL_START_SCALE: usize = 34;
pub const SL_FINAL_SCALE: usize = 35;
pub const SL_START_TRANS: usize = 36;
pub const SL_FINAL_TRANS: usize = 37;
pub const SL_SEED: usize = 38;
pub const SL_LIFE: usize = 39;
pub const SL_VEL: usize = 40; // 8
pub const SL_KID_PREV: usize = 48; // 5
pub const SL_STRIDE: usize = 53;
