// particle.gemSparkle — the FIRST synthesized-emitter (MECH "particle") component
// (Visual-Behavior Suite, Phase 3, 2026-06-24). The "magic gem sparkle" archetype's
// signature effect: a persistent, additive twinkle of 2–4 soft-dot sprites standing
// at a magic gem/crystal (design doc §4.5 "magic gem sparkle" — persistent standing
// emitter, 2–4 additive sprites; §5.3 cost class = MEDIUM/cheap, additive overdraw).
//
// MECH "particle" (registry.js:35 MECHS, FAMILY_ORDER.particle = 9 → runs LAST):
// this component carries NO shader (linkVariant() === "" like MECH-A windBend) and
// NO begin_vertex patch. Instead it implements the Phase-3 emit(ctx) hook, which
// SYNTHESISES a plain-JS emitterInfo POJO and hands it to the attach layer
// (particle_attach.attachParticleEmitters, P3.1), which calls the EXISTING
// ParticleManager.addEmitter({emitterInfo, parent, partIndex, parentOffset}) seam
// (particle_manager.js:469). Phase 3 builds NO engine — it reuses the whole shipped
// pipeline: RP6 220 m + frustum cull, maxParticlesPerEmitter 64/256/1024/2048 per
// quality (particle_emitter.js:164-196), PlayEffect FIFO, owner-registry teardown.
//
// THE FIREWALL (spec §1.2 / constraints §5): READS only static/derived inputs — the
// gem GfxObj vertex bbox ("geometry", for the spawn-ball size) + the shared client
// wall-clock ("clock", the cadence the synthesized emitter rides via the engine's
// currentTime()); WRITES only a synthesized client-local ADDITIVE billboard emitter
// ("emitter" cap, lint_caps.js:32) — sprites the server neither stores nor
// replicates, with NO collision, NO wire value, NO physics, NO replicated state, and
// NO light-count change (lightCountDelta:0). Deterministic: per-particle variety
// comes from the particle engine's SEEDED rng (time_rng.js, applied to the POJO's
// *Rand range fields), and any cross-DID phase comes from a SET-scoped hash01 —
// NEVER Math.random, NEVER an argless Date.now, NEVER a per-instance program key
// (cacheKeyScope:"set"; particle has no shader so this is a formality). Purely
// cosmetic + client-local ⇒ cannot desync (the server never sees it).
//
// JS-ONLY (no wasm rebuild): the POJO names an EXISTING additive sprite GfxObj, so
// entities.js' geometry/material factories (entities.js:9019-9074 → getParticleUnlit)
// render it with zero DAT 0x32 replay and zero shader relink. Node-testable: this
// leaf imports NO three (the POJO uses FLAT scalar fields aX/aY/aZ/offsetDirX/… that
// ParticleEmitterInfo's constructor reads directly, particle_emitter_info.js:54-109),
// so the legacy-safety + particle-install harnesses run it under plain node.
//
// DEFAULT-OFF: enabled = gemSparkleEnabled (?gemSparkle, composed under the ?visual
// master gate by the seam). Off ⇒ particle_attach drops the entry ⇒ emit() is never
// called ⇒ addEmitter is never called ⇒ no emitter mesh / no draw call / no material
// ⇒ byte-identical (mirrors tipFlex's enabled-gate OFF path, frag_attach.js:96).

import { registerComponent } from "../registry.js";
import { gemSparkleEnabled } from "../../vfx_flags.js"; // components/ -> vfx/ -> scene3d/vfx_flags.js
import { GEM_SPARKLE_SOFT_DOT } from "../particle_sprites.js"; // D3: DAT-confirmed additive twinkle 0x010010F9 (sparkleStar)

// ParticleType enum mirror (ParticleType.cs / particle.js switch :213,:344). We need
// only two trajectories; inlined so this leaf imports no three-pulling module:
//   Still         (0): position = parentOrigin + spawnOffset; no A/B/C — a dot that
//                      pops at a random point in the spawn ball, shrinks, fades. The
//                      "standing" twinkle (design-doc §4.5 wording). cheapest.
//   LocalVelocity (1): position = lifetime*A + parentOrigin + spawnOffset; A rotated
//                      into the part frame — a gentle upward drift when riseSpeed>0.
const PARTICLE_TYPE_STILL = 0;
const PARTICLE_TYPE_LOCAL_VELOCITY = 1;
const EMITTER_TYPE_BIRTHRATE_PER_SEC = 1; // EmitterType.BirthratePerSec (info :32)

// Sane clamps so a stray classifier config can't author a fill bomb. Counts/seconds/
// metres. maxParticles is ALSO clamped at runtime by the per-quality cap (low:64), so
// this is just an authoring guard far under that.
const MAX_PARTICLES_CAP = 16;
const MAX_SPAWN_RADIUS_M = 0.25;

function _clamp(v, lo, hi) {
  const n = Number.isFinite(+v) ? +v : lo;
  return Math.max(lo, Math.min(hi, n));
}

// Deterministic SET-scoped phase in [0,1). The attach layer MAY pass ctx.hash01 (a
// hash of the descriptor SET key / setupDid — NEVER a per-instance guid, which would
// be cacheKeyScope:"instance"); absent ⇒ 0 (fixed phase). This decorrelates DIFFERENT
// gem descriptors so they don't all start their t=0 burst identically. NOT Math.random.
function _phase01(ctx) {
  const h = ctx && Number.isFinite(+ctx.hash01) ? +ctx.hash01 : 0;
  // Wrap into [0,1) defensively (a caller may pass a raw integer hash).
  const f = h - Math.floor(h);
  return f >= 0 && f < 1 ? f : 0;
}

// ⚠ 2026-08-03 — CTX SHAPE FIX. This function used to read ONLY `ctx.geometry`,
// and `emit()` used to read ONLY `ctx.partIndex`. **Neither field exists on the
// ctx the attach layer actually builds.** `particle_attach.attachParticleEmitters`
// constructs exactly:
//     { did, numParts, partBoxes, rig, hash01, seed, clock, tSec, weather, env,
//       anchor, config }
// The resolved anchor lives on `ctx.anchor` — a {partIndex, center, radius}
// record produced by `particle_attach._resolveAnchor` from the descriptor's
// `config.anchor` ROLE against the per-part bboxes — and EVERY sibling particle
// component reads it (foliageAmbient, breathFog, terrainDustDevil,
// terrainVolcanoEmbers, terrainSwampAmbient). gemSparkle silently discarded the
// whole P3.6 anchor resolution: the spawn ball was always the authored 0.05 m and
// the part was always the root (-1), so the twinkle sat at the model ORIGIN
// regardless of which part the `vfx anchor-parts` bake picked. Its unit test hid
// this by hand-building `{ geometry: { halfExtent } }` — a shape the runtime never
// produces.
//
// `ctx.geometry` is kept as a LEGACY fallback (offline/preview callers pass it),
// but `ctx.anchor` now wins.
//
// ⚠ The root anchor's `radius` is NOT geometry. `_resolveAnchor` returns
// `radius: config.maxOffset || 1` for role "root" — gemSparkle authors no
// `maxOffset`, so that is a literal 1 m, 20× the authored 0.05 m ball. Only a
// REAL resolved part (partIndex >= 0, radius derived from that part's bbox) may
// size the ball; the root case keeps the authored `spawnRadius`.
function _anchorHalfExtent(ctx, fallback) {
  const a = ctx && ctx.anchor;
  if (a && Number.isInteger(a.partIndex) && a.partIndex >= 0 && Number.isFinite(+a.radius) && +a.radius > 0) {
    return _clamp(a.radius, 0.005, MAX_SPAWN_RADIUS_M);
  }
  const g = ctx && ctx.geometry;                       // legacy / offline callers
  if (g && Number.isFinite(+g.halfExtent)) return _clamp(g.halfExtent, 0.005, MAX_SPAWN_RADIUS_M);
  if (g && g.partBox && g.partBox.min && g.partBox.max) {
    const dx = +g.partBox.max[0] - +g.partBox.min[0];
    const dy = +g.partBox.max[1] - +g.partBox.min[1];
    const dz = +g.partBox.max[2] - +g.partBox.min[2];
    const span = Math.max(dx, dy, dz);
    if (Number.isFinite(span) && span > 0) return _clamp(span * 0.5, 0.005, MAX_SPAWN_RADIUS_M);
  }
  return _clamp(fallback, 0.005, MAX_SPAWN_RADIUS_M);
}

/** The anchor part this placement resolved to, or -1 (root). Prefers the LIVE
 *  `ctx.anchor.partIndex` (P3.6 selector) over the legacy `ctx.partIndex`, then
 *  the authored config. Pure. */
function _anchorPartIndex(ctx, cfg) {
  const a = ctx && ctx.anchor;
  if (a && Number.isInteger(a.partIndex) && a.partIndex >= 0) return a.partIndex;
  if (Number.isInteger(ctx && ctx.partIndex)) return ctx.partIndex;   // legacy
  if (Number.isInteger(cfg && cfg.partIndex)) return cfg.partIndex;
  return -1;
}

/**
 * Build ONE persistent additive gem-sparkle emitterInfo POJO (pure; node-testable —
 * no three). FLAT field names mirror the ParticleEmitterInfo constructor
 * (particle_emitter_info.js:54-109) so `new ParticleEmitterInfo(thisPojo)` snapshots
 * it directly. totalParticles:0 + totalSeconds:0 ⇒ INFINITE/persistent (the engine's
 * "firstParticle/standing" path, particle_emitter.js:309-313). Additive blend is
 * decided downstream by the sprite's Surface (surfaceTypeFlags & 0x10000,
 * particle_manager.js:553-601) — NOT by this POJO.
 *
 * @param {object} cfg   merged defaults+descriptor config (see gemSparkle.defaults)
 * @param {object} [ctx] emit() context (geometry/hash01) — optional, all fail-soft
 * @returns {object} a ParticleEmitterInfo POJO
 */
export function gemSparkleEmitterInfo(cfg, ctx) {
  const c = { ...gemSparkle.defaults, ...(cfg || {}) };
  const phase = _phase01(ctx);

  const maxParticles = Math.round(_clamp(c.maxParticles, 1, MAX_PARTICLES_CAP));
  const spawnRadius = _anchorHalfExtent(ctx, c.spawnRadius);

  // Cross-DID desync (SET scope): a ±15% nudge on the spawn interval + a 0..maxParticles
  // t=0 burst, both driven by the deterministic SET hash. Absent hash ⇒ phase 0 ⇒ the
  // authored cadence + the authored initialParticles. (Per-particle variety is the
  // engine's seeded rng over the *Rand fields below — this is only inter-emitter.)
  const birthrate = _clamp(c.birthrate, 0.05, 5) * (0.85 + 0.30 * phase);
  const initialParticles = ctx && Number.isFinite(+ctx.hash01)
    ? Math.min(maxParticles, Math.round(phase * maxParticles))
    : Math.round(_clamp(c.initialParticles, 0, maxParticles));

  // Trajectory: a "standing" twinkle (Still) by default; a gentle upward drift when
  // riseSpeed>0 (LocalVelocity, A = unit +Z scaled by minA==maxA==riseSpeed so the
  // engine's sortingSphere = maxA*lifespan is the TRUE travel distance — tight cull).
  const riseSpeed = _clamp(c.riseSpeed, 0, 1);
  const drifts = riseSpeed > 0;

  const startScale = _clamp(c.startScale, 0.001, 5);
  const finalScale = _clamp(c.finalScale, 0.001, 5);

  return {
    id: 0,                                   // E6-warn dedup key only; the manager assigns the runtime emitterId
    emitterType: EMITTER_TYPE_BIRTHRATE_PER_SEC,
    particleType: drifts ? PARTICLE_TYPE_LOCAL_VELOCITY : PARTICLE_TYPE_STILL,
    gfxObjId: 0,                             // software-path GfxObj (unused; hw path renders)
    hwGfxObjId: (c.hwGfxObjId >>> 0),        // the additive soft-dot sprite (see defaults / agent-03 dep)

    // Cadence + population. AC semantics (particle_emitter_info.js:262-267): `birthrate`
    // is the MINIMUM SECONDS BETWEEN spawns, NOT particles/sec — a LARGER value ⇒ a
    // LOWER spawn rate. maxParticles caps concurrent dots (2–4); both stay far under the
    // low-quality 64 cap so E6 never trips (particle_emitter.js:184-196).
    birthrate,
    maxParticles,
    initialParticles,
    totalParticles: 0,                       // 0 = INFINITE  ─┐ persistent ambient emitter
    totalSeconds: 0,                         // 0 = INFINITE  ─┘ (never auto-stops; torn down by owner registry)

    // Lifetime (+ jitter so dots don't pulse in lockstep). The engine draws
    // getRandomLifespan() = rng()∈[-1,1)·lifespanRand + lifespan per dot (seeded rng,
    // deterministic — NOT Math.random).
    lifespan: _clamp(c.lifespan, 0.1, 30),
    lifespanRand: _clamp(c.lifespanRand, 0, 5),

    // Spawn volume — a small isotropic ball of radius [minOffset,maxOffset] around the
    // anchor. offsetDir = 0 ⇒ getRandomOffset (particle_emitter_info.js:185-212) yields
    // a uniformly-random direction · [minOffset,maxOffset] (a spherical shell), i.e. a
    // tight twinkle cloud at the gem. maxOffset = the geometry-sized spawn radius.
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0,
    maxOffset: spawnRadius,

    // Velocity A (object/part-local; rotated into the part frame for LocalVelocity).
    // Still ⇒ A and its magnitude are 0 (no motion). Drift ⇒ unit +Z · riseSpeed.
    aX: 0, aY: 0, aZ: drifts ? 1 : 0,
    minA: drifts ? riseSpeed : 0,
    maxA: drifts ? riseSpeed : 0,
    // B (accel) / C unused for this archetype.
    bX: 0, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,

    // Size lerp over life: born small-bright, SHRINK as it fades (startScale > finalScale
    // per the §4.5 archetype). scaleRand jitters per dot (seeded rng).
    scaleRand: _clamp(c.scaleRand, 0, 1),
    startScale,
    finalScale,

    // Translucency lerp. VERIFIED ENGINE POLARITY (particle.js:20-21,98-111;
    // setTranslucency ⇒ opacity = 1 − translucency, ACE 0=opaque/1=invisible): born
    // OPAQUE (startTrans 0 ⇒ opacity 1) → fade to INVISIBLE (finalTrans 1 ⇒ opacity 0,
    // and ==1 sets NoDraw). This is the CORRECT encoding of "fade out" — see the header
    // note correcting the handoff's "startTrans 1->0" (which is the alpha-mental-model
    // slip; literally applied it would fade IN).
    transRand: _clamp(c.transRand, 0, 1),
    startTrans: _clamp(c.startTrans, 0, 1),
    finalTrans: _clamp(c.finalTrans, 0, 1),

    // Re-anchor to the (possibly animating/moving) part frame every tick so the sparkle
    // hugs the gem (updateParticles :377; _resolveAnchorFrame converts the WORLD-space
    // partFrames to scene-local — do NOT double-apply the worldRoot −π/2 X rotation).
    isParentLocal: c.isParentLocal !== false,

    // Camera-facing billboard (HANDOFF Bug 3 fix, 2026-06-24): the sparkleStar
    // GfxObj is a FLAT planar quad; a fixed-orientation Still particle renders it
    // edge-on (≈0 pixels) from perpendicular azimuths. ParticleManager.tick()
    // faces these at the camera each frame (particle_manager.js _billboardEmitter).
    // Engine default is false (retail-faithful for DAT replay); synthesized
    // sprite emitters opt in. Honours ?particleBillboard=off for A/B eye-test.
    billboard: true,
  };
}

export const gemSparkle = {
  id: "particle.gemSparkle",
  family: "particle",       // FAMILIES has "particle"; FAMILY_ORDER.particle = 9 (runs last)
  mech: "particle",         // MECHS has "particle"; routed via COMPONENT_MECH "particle"
  channel: "emitter",       // the §14 conflict unit for synthesized emitters
  // No shader, no link-affecting bits — one (zero) program. cacheKeyScope:"none" is the
  // truthful descriptor for a particle component: linkVariant()==="" ⇒ no cached material
  // variant to key (D2 — matches the shipped no-shader mechs windBend.js:23 / flameFlicker).
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  // LIVE per-effect default-OFF gate consulted by particle_attach.particleEntriesFor-
  // Descriptor (mirrors frag_attach.js:96). Off ?gemSparkle ⇒ the entry is dropped at
  // BOTH the statics and entity seams ⇒ emit() never runs ⇒ byte-identical.
  enabled: gemSparkleEnabled,
  // Legacy-safety manifest (spec §1.2): the gem GfxObj bbox (geometry) + the shared
  // client clock in; a synthesized client-local additive emitter out. Nothing
  // replicated. reads ⊆ ALLOWED_READS, writes ⊆ ALLOWED_WRITES (lint_caps.js).
  reads: ["geometry", "clock"],
  writes: ["emitter"],
  // Classifier/config-facing knobs (metres / seconds / counts). hwGfxObjId is the
  // additive sprite GfxObj. DEFAULT = 0x01001A61 — the moon-star "A" sprite, a small
  // additive soft-dot DAT-VERIFIED at particle_emitter.rs:160-161 (emitter 0x32000455)
  // and rendered through the ADDITIVE branch (particle_manager.js:584 "the moon's
  // crimson-star particle"). Agent 03 (P3.2 particle_sprites) may override with a softer
  // soft-dot; the catalog/descriptor config can also override per-DID.
  defaults: {
    hwGfxObjId: GEM_SPARKLE_SOFT_DOT, // 0x010010F9 sparkleStar — DAT-confirmed additive 4-point twinkle (D3, agent-03 probe)
    maxParticles: 4,        // 2–4 concurrent additive dots (≪ the 64 low-quality cap)
    initialParticles: 2,    // t=0 burst so the gem sparkles immediately on attach
    birthrate: 0.45,        // SECONDS BETWEEN spawns (interval, not rate) → low spawn rate
    lifespan: 1.3,          // seconds a dot lives
    lifespanRand: 0.4,      // ± lifetime jitter
    spawnRadius: 0.05,      // metres — small spawn ball at the gem (maxOffset is a POSITION offset; correctly metres)
    // startScale/finalScale are UNITLESS MULTIPLIERS on the sprite GfxObj's
    // native size (particle.js:299/475 mesh.scale.setScalar) — NOT metres. The
    // sparkleStar quad is ~0.294 m across (DAT obj-export), so 0.45 → ~0.13 m
    // born, 0.15 → ~0.044 m faded. BOTH must stay above the 0.1 floor that
    // getRandomStartScale/getRandomFinalScale clamp to (particle_emitter_info.js
    // :138/147) — the old 0.06/0.012 both clamped UP to 0.1, collapsing to a
    // constant ~0.029 m dot with no shrink AND (being a fixed-orientation flat
    // quad) edge-on invisible. See billboard:true below + HANDOFF Bug 3.
    startScale: 0.45,       // ×native (~0.13 m) — born small-bright
    finalScale: 0.15,       // ×native (~0.044 m) — shrink as it fades (startScale > finalScale)
    scaleRand: 0.06,        // ± per-dot size variety (×native)
    startTrans: 0.0,        // born opaque   (ACE translucency 0 = opaque)
    finalTrans: 1.0,        // fade to invisible (ACE translucency 1 = invisible / NoDraw)
    transRand: 0.0,         // clean fade (no opacity jitter)
    riseSpeed: 0.0,         // metres/sec upward drift; 0 = "standing" twinkle (Still)
    partIndex: -1,          // anchor: root (the minimal first slice; P3.6 selector resolves a gem part)
    liftZ: 0.0,             // metres — parentOffset +Z to nudge the ball toward gem height
  },

  /**
   * Phase-3 emit hook (P3.1 contract): synthesise the emitter spec(s) for one
   * placement/entity. gemSparkle emits exactly ONE persistent additive emitter, so the
   * array has length 1. The attach layer (particle_attach.attachParticleEmitters)
   * supplies `parent` (inst.root / the static SetupModel, with partFrames) + `blocking`
   * and calls ParticleManager.addEmitter({emitterInfo, parent, partIndex, parentOffset})
   * for each returned spec, then registers the returned id under the owner key
   * (entity guid | "static:<lb>") for free teardown.
   *
   * ctx (all fields OPTIONAL / fail-soft — agents 01/02 own the final ctx shape):
   *   config?   : merged config (defaults already folded in here too, so emit() works
   *               standalone in unit tests with a bare ctx)
   *   geometry? : { halfExtent?:number, partBox?:{min:[x,y,z],max:[x,y,z]} } — the gem/
   *               anchor bbox for the spawn-ball size (the "geometry" read)
   *   hash01?   : SET-scoped deterministic seed in [0,1) for cross-DID desync (NEVER a
   *               per-instance guid hash)
   *   clock?    : shared wall-clock tsSec (the "clock" read) — the synthesized emitter's
   *               cadence rides this via the engine's currentTime(); unused by the static
   *               v1 POJO, consumed by a future drift-phase variant
   *   partIndex?: resolved anchor part index (P3.6 anchor-parts selector); default -1 (root)
   *
   * @param {object} [ctx]
   * @returns {Array<{emitterInfo:object, partIndex:number, parentOffset:(object|null)}>}
   */
  emit(ctx) {
    const cfg = { ...gemSparkle.defaults, ...((ctx && ctx.config) || {}) };
    const emitterInfo = gemSparkleEmitterInfo(cfg, ctx);

    // Anchor: the resolved part (P3.6 `ctx.anchor`), then the legacy ctx field,
    // then the configured/root index. Root sentinel −1. See _anchorPartIndex.
    const partIndex = _anchorPartIndex(ctx, cfg);

    // Static offset frame (emitter-local, AC Z-up): the resolved anchor's bbox
    // CENTRE (so the ball sits on the gem, not at the part origin) plus the
    // authored liftZ. Plain {position,quaternion} POJO (addEmitter accepts POJO
    // frames, particle_manager.js:495-513) — no three needed.
    const liftZ = _clamp(cfg.liftZ, -5, 5);
    const c = (ctx && ctx.anchor && ctx.anchor.center) || null;
    const cx = c && Number.isFinite(+c.x) ? +c.x : 0;
    const cy = c && Number.isFinite(+c.y) ? +c.y : 0;
    const cz = c && Number.isFinite(+c.z) ? +c.z : 0;
    // null stays the "no offset at all" path (byte-identical to pre-fix for a
    // root anchor with no lift), so the OFF/default render is unchanged.
    const parentOffset = (liftZ !== 0 || cx !== 0 || cy !== 0 || cz !== 0)
      ? { position: { x: cx, y: cy, z: cz + liftZ }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
      : null;

    return [{ emitterInfo, partIndex, parentOffset }];
  },
};

registerComponent(gemSparkle);
export default gemSparkle;
