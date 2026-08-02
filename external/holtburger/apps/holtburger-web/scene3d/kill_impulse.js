// scene3d/kill_impulse.js — where a death-time ragdoll gets its DIRECTION.
//
// Rides the `?ragdoll` flag (no flag of its own): installed from
// scene3d/index.js only when `ragdoll !== "off"`, and read from entities.js's
// death arm through `killOptsFor(inst)`.
//
// THE BUG THIS EXISTS TO FIX (2026-08-02). `startRagdoll(inst)` was called with
// no opts, so ragdoll.js fell through to `dx = 1, dy = 0` and seeded the
// impulse as `[RAGDOLL_IMPULSE, 0, …]`. `initSim`'s "no direction ⇒ random
// yaw" branch was therefore UNREACHABLE (the impulse XY was never zero), and
// every creature in the world toppled toward MODEL +X — its own right — with
// only ±0.45 rad of jitter. Deaths looked stamped from a mould.
//
// WHAT WE KNOW ABOUT A KILL, best source first
// --------------------------------------------
//  1. PROJECTILE IMPACT (mage bolt / arrow / thrown). ACE streams no in-flight
//     motion for a PhysicsState::Missile: the launch velocity arrives once on
//     ObjectCreate (entities.js seeds `inst.lastVel` + `_ballistic`) and the
//     ONLY VectorUpdate a projectile ever gets is the impact stop
//     (SpellProjectile.ProjectileImpact). entities.js `setVelocity` hands us
//     that moment plus the pre-impact velocity — an exact flight direction.
//  2. ATTACKER POSITION. `damageDealt` (we hit them) resolves defenderName →
//     guid through EntityManager's name index; the attacker is the local
//     player, whose world position we have. `damageTaken` is the mirror.
//     Direction = victim − attacker, i.e. the shove a melee blow imparts.
//  3. SPLATTER QUADRANT. Every hit on every creature broadcasts one of the 12
//     Splatter PlayScripts, which decode (splatter_decode.js) to a
//     TARGET-RELATIVE quadrant — where the wound is, hence where the blow came
//     FROM. Push = −quadrant. This is the only source that works for fights we
//     are merely watching, and it is the one that always fires.
//  4. NOTHING. Seeded per-death azimuth — well distributed, never constant.
//
// All directions are stored in the WORLD (AC/entitiesGroup, +Z up) frame and
// converted to MODEL space at death, because that is the frame ragdoll.js's
// verlet sim runs in (part Groups are root-local; AC headings are yaw-only).
//
// Dependency-free on purpose (no three.js, no entities import): bare-node
// importable so the whole resolver is unit-testable, same policy as
// splatter_decode.js and limbs.js.

/* ── tunables ────────────────────────────────────────────────────────── */

/** How long a recorded hit stays eligible to steer a death. */
export const KILL_HIT_TTL_MS = 6000;
/** Recency half-life: a 1.5 s-old hit counts half as much as a fresh one. */
export const KILL_HIT_HALF_LIFE_MS = 1500;
/** Per-source confidence weights (multiplied by the recency weight). */
export const KILL_SOURCE_WEIGHT = Object.freeze({
  projectile: 1.0,
  attacker: 0.85,
  splatter: 0.5,
});
/** Ring sizes — bounded like every other per-guid cache in scene3d. */
export const KILL_MAX_TRACKED = 64;
export const KILL_MAX_HITS_PER_GUID = 6;
export const KILL_MAX_PROJECTILES = 16;
/** Projectile→victim correlation window. */
export const KILL_PROJECTILE_TTL_MS = 2500;
export const KILL_PROJECTILE_RADIUS_M = 3.0;
/** How much of the victim's own travel direction leaks into the fall. */
export const KILL_MOTION_BLEND = 0.35;
export const KILL_MOTION_MIN_SPEED = 0.6; // m/s before motion counts at all

/* ── pure math (node-tested) ─────────────────────────────────────────── */

/** Deterministic PRNG (mulberry32) — same generator ragdoll.js uses. */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit avalanche mix of two integers — the per-death seed. */
export function hash32(a, b) {
  let h = (a >>> 0) ^ Math.imul(b >>> 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Yaw (rotation about +Z) of an AC entity quaternion. AC headings are
 * yaw-only, so this is exact for every rig; a tilted quaternion (the jump
 * pose tween) degrades to its yaw component, which is what we want.
 */
export function yawFromQuat(x, y, z, w) {
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  return Math.atan2(siny, cosy);
}

/** Rotate a 2-vector by `ang` about +Z. Returns a fresh [x, y]. */
export function rotZ(vx, vy, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [vx * c - vy * s, vx * s + vy * c];
}

/**
 * Where the blow came FROM, as a push direction, in MODEL space.
 *
 * The splatter quadrant is target-relative: AC model space is forward +Y,
 * right +X, so a "LeftFront" wound sits at (−1, +1)/√2. The attacker was on
 * that side, so the body is shoved the OTHER way.
 */
export function quadrantPushModel(decoded) {
  if (!decoded) return null;
  const INV_SQRT2 = 0.70710678;
  const qx = (decoded.left ? -1 : 1) * INV_SQRT2;
  const qy = (decoded.front ? 1 : -1) * INV_SQRT2;
  return [-qx, -qy];
}

/** Model-space quadrant push lifted into the world frame by the body's yaw. */
export function quadrantPushWorld(decoded, yaw) {
  const m = quadrantPushModel(decoded);
  if (!m) return null;
  return rotZ(m[0], m[1], yaw || 0);
}

/** Recency weight: 1 at ts=now, halving every KILL_HIT_HALF_LIFE_MS. */
export function recencyWeight(ageMs, halfLifeMs = KILL_HIT_HALF_LIFE_MS) {
  if (!(ageMs > 0)) return 1;
  if (ageMs >= KILL_HIT_TTL_MS) return 0;
  return Math.pow(0.5, ageMs / (halfLifeMs || 1));
}

/**
 * Weighted vector mean of unit directions (a circular mean that degrades
 * gracefully: opposing hits cancel toward "no clear direction", which the
 * caller reads as low confidence and falls back to seeded variety).
 *
 * entries: [{ dx, dy, ts, source, critical }]
 * → { dx, dy, confidence, critical, source } | null
 */
export function blendHits(entries, nowMs) {
  if (!entries || entries.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  let critical = false;
  let best = null;
  let bestW = 0;
  for (const e of entries) {
    const age = nowMs - (e.ts || 0);
    const rw = recencyWeight(age);
    if (rw <= 0) continue;
    const sw = KILL_SOURCE_WEIGHT[e.source] ?? 0.5;
    const w = rw * sw;
    const l = Math.hypot(e.dx || 0, e.dy || 0);
    if (!(l > 1e-6)) continue;
    sx += (e.dx / l) * w;
    sy += (e.dy / l) * w;
    wsum += w;
    if (e.critical) critical = true;
    if (w > bestW) {
      bestW = w;
      best = e.source;
    }
  }
  if (wsum <= 0) return null;
  const l = Math.hypot(sx, sy);
  if (!(l > 1e-6)) return null;
  return {
    dx: sx / l,
    dy: sy / l,
    // 1 = every hit agreed, →0 = they cancelled out.
    confidence: Math.min(1, l / wsum),
    critical,
    source: best || "splatter",
  };
}

/**
 * Per-death fall STYLE. Even with a perfect attack direction, twenty kills that
 * all topple cleanly backwards read as a loop; retail creatures crumple, spin
 * out, pitch onto their face and flop sideways. The style is drawn from the
 * per-death seed, so it is reproducible and never module-global random.
 *
 * `rotate` is applied to the resolved direction (radians). `useMotion` swings
 * the fall toward wherever the creature was RUNNING — a charging mob that dies
 * mid-stride should carry its momentum onto its face.
 */
export const FALL_STYLES = Object.freeze([
  { name: "topple", p: 0.40, rotate: 0, topple: 1.0, twist: 1.0, spread: 0.55, useMotion: false },
  { name: "spinout", p: 0.16, rotate: 0, topple: 0.9, twist: 2.1, spread: 0.8, useMotion: false },
  { name: "crumple", p: 0.14, rotate: 0, topple: 0.32, twist: 0.7, spread: 1.5, useMotion: false },
  { name: "faceplant", p: 0.12, rotate: 0, topple: 1.15, twist: 0.8, spread: 0.5, useMotion: true },
  { name: "sidefall", p: 0.10, rotate: Math.PI / 2, topple: 1.0, twist: 1.2, spread: 0.6, useMotion: false },
  { name: "sidefall2", p: 0.05, rotate: -Math.PI / 2, topple: 1.0, twist: 1.2, spread: 0.6, useMotion: false },
  { name: "backflop", p: 0.03, rotate: Math.PI, topple: 1.1, twist: 0.9, spread: 0.7, useMotion: false },
]);

/** Draw a style from a 0..1 roll (cumulative over FALL_STYLES). */
export function pickFallStyle(roll) {
  let acc = 0;
  const r = Math.min(0.999999, Math.max(0, roll || 0));
  for (const s of FALL_STYLES) {
    acc += s.p;
    if (r < acc) return s;
  }
  return FALL_STYLES[0];
}

/**
 * THE resolver (pure). Turns everything we know into the opts `startRagdoll`
 * wants. Always returns a usable direction — an unknowable kill gets a seeded
 * azimuth drawn from the full circle, never a constant.
 *
 * state: {
 *   hits:    [{dx, dy, ts, source, critical}]  world-frame push dirs
 *   yaw:     entity yaw (rad) at death
 *   motion:  {vx, vy} | null                   victim's own world velocity
 *   guid, nowMs, critical
 * }
 * → { dir: [mx, my], worldDir: [wx, wy], critical, seed, style, source,
 *     confidence, toppleScale, twistScale, dirJitter }
 */
export function resolveKillImpulse(state) {
  const guid = (state?.guid >>> 0) || 0;
  const nowMs = state?.nowMs ?? 0;
  const seed = hash32(guid, Math.round(nowMs));
  const rand = mulberry32(seed);

  const blended = blendHits(state?.hits, nowMs);
  const style = pickFallStyle(rand());

  // Base azimuth: measured attack direction when we have one, else a seeded
  // draw over the FULL circle (the old bug's regression test).
  let ang;
  let source = "seeded";
  let confidence = 0;
  if (blended && blended.confidence > 0.25) {
    ang = Math.atan2(blended.dy, blended.dx);
    source = blended.source;
    confidence = blended.confidence;
  } else {
    ang = rand() * Math.PI * 2;
  }

  // The victim's own momentum: a mob that dies mid-charge should keep going.
  const mv = state?.motion;
  if (mv) {
    const sp = Math.hypot(mv.vx || 0, mv.vy || 0);
    if (sp >= KILL_MOTION_MIN_SPEED) {
      const w = style.useMotion ? 0.85 : KILL_MOTION_BLEND;
      const mx = (mv.vx / sp) * w + Math.cos(ang) * (1 - w);
      const my = (mv.vy / sp) * w + Math.sin(ang) * (1 - w);
      if (Math.hypot(mx, my) > 1e-6) ang = Math.atan2(my, mx);
      if (style.useMotion) source = source === "seeded" ? "motion" : source + "+motion";
    }
  }

  ang += style.rotate;
  // A low-confidence read (hits that cancelled, or none at all) gets a wider
  // seeded fan so the residual bias can never look like a preferred direction.
  const fan = confidence > 0.25 ? 0 : (rand() - 0.5) * Math.PI * 0.8;
  ang += fan;

  const wx = Math.cos(ang);
  const wy = Math.sin(ang);
  const yaw = state?.yaw || 0;
  const model = rotZ(wx, wy, -yaw);

  return {
    dir: model,
    worldDir: [wx, wy],
    critical: !!(state?.critical || blended?.critical),
    seed,
    style: style.name,
    source,
    confidence,
    toppleScale: style.topple,
    twistScale: style.twist,
    dirJitter: style.spread,
  };
}

/* ── runtime state (browser; bounded, TTL'd) ─────────────────────────── */

const _hits = new Map(); // guid → [{dx, dy, ts, source, critical}]
const _projectiles = []; // [{x, y, dx, dy, ts}]
const _stats = { splatter: 0, attacker: 0, projectile: 0, resolved: 0, bySource: {} };

function _now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function _prune(nowMs) {
  for (const [g, list] of _hits) {
    const keep = list.filter((h) => nowMs - h.ts < KILL_HIT_TTL_MS);
    if (keep.length === 0) _hits.delete(g);
    else if (keep.length !== list.length) _hits.set(g, keep);
  }
  while (_hits.size > KILL_MAX_TRACKED) {
    const oldest = _hits.keys().next();
    if (oldest.done) break;
    _hits.delete(oldest.value);
  }
  while (_projectiles.length && nowMs - _projectiles[0].ts > KILL_PROJECTILE_TTL_MS) {
    _projectiles.shift();
  }
}

/** Record a world-frame push direction for `guid`. Never throws. */
export function noteHit(guid, dx, dy, opts = {}) {
  try {
    const g = (Number(guid) >>> 0) || 0;
    if (!g) return false;
    const l = Math.hypot(dx || 0, dy || 0);
    if (!(l > 1e-6)) return false;
    const nowMs = opts.ts ?? _now();
    let list = _hits.get(g);
    if (!list) {
      list = [];
      _hits.set(g, list);
    } else {
      // Re-insert so the LRU cap evicts by recency, not first-seen.
      _hits.delete(g);
      _hits.set(g, list);
    }
    list.push({
      dx: dx / l,
      dy: dy / l,
      ts: nowMs,
      source: opts.source || "splatter",
      critical: !!opts.critical,
    });
    if (list.length > KILL_MAX_HITS_PER_GUID) list.shift();
    _stats[opts.source || "splatter"] = (_stats[opts.source || "splatter"] || 0) + 1;
    _prune(nowMs);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * A broadcast Splatter landed on `guid`. `quat` is the entity's live root
 * quaternion ({x,y,z,w}); the target-relative quadrant is lifted into the
 * world frame with its yaw so a later turn cannot re-aim the blow.
 */
export function noteSplatterHit(guid, decoded, quat, opts = {}) {
  if (!decoded) return false;
  const yaw = quat ? yawFromQuat(quat.x || 0, quat.y || 0, quat.z || 0, quat.w ?? 1) : 0;
  const w = quadrantPushWorld(decoded, yaw);
  if (!w) return false;
  return noteHit(guid, w[0], w[1], { ...opts, source: "splatter" });
}

/** An attacker at (ax, ay) hit the entity standing at (vx, vy). */
export function noteAttackerHit(guid, ax, ay, vx, vy, opts = {}) {
  const dx = vx - ax;
  const dy = vy - ay;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return noteHit(guid, dx, dy, { ...opts, source: "attacker" });
}

/**
 * A ballistic projectile just stopped (= impacted) at (x, y) travelling along
 * (dx, dy). Not attributed to a victim here — the correlation is done at death
 * time by proximity, because the impact carries no defender guid.
 */
export function noteProjectileImpact(x, y, dx, dy, ts) {
  try {
    const l = Math.hypot(dx || 0, dy || 0);
    if (!(l > 1e-6) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const nowMs = ts ?? _now();
    _projectiles.push({ x, y, dx: dx / l, dy: dy / l, ts: nowMs });
    while (_projectiles.length > KILL_MAX_PROJECTILES) _projectiles.shift();
    _stats.projectile++;
    _prune(nowMs);
    return true;
  } catch (_e) {
    return false;
  }
}

/** Nearest recent projectile impact to (x, y), or null. */
export function projectileNear(x, y, nowMs = _now()) {
  let best = null;
  let bestD2 = KILL_PROJECTILE_RADIUS_M * KILL_PROJECTILE_RADIUS_M;
  for (const p of _projectiles) {
    if (nowMs - p.ts > KILL_PROJECTILE_TTL_MS) continue;
    const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

/** Everything recorded for a guid (diag/tests). */
export function hitsFor(guid) {
  return _hits.get((Number(guid) >>> 0) || 0) || [];
}

/** Drop a guid's history (entity removal / test isolation). */
export function forgetKillImpulse(guid) {
  if (guid === undefined) {
    _hits.clear();
    _projectiles.length = 0;
    return;
  }
  _hits.delete((Number(guid) >>> 0) || 0);
}

/**
 * Build the `startRagdoll` opts for a dying entity. This is the ONE call
 * entities.js makes; everything above feeds it.
 */
export function killOptsFor(inst, nowMs = _now()) {
  let guid = 0;
  let yaw = 0;
  let motion = null;
  let x = 0;
  let y = 0;
  try {
    guid = (Number(inst?.guid) >>> 0) || 0;
    const q = inst?.root?.quaternion;
    if (q) yaw = yawFromQuat(q.x || 0, q.y || 0, q.z || 0, q.w ?? 1);
    const p = inst?.root?.position;
    if (p) {
      x = p.x || 0;
      y = p.y || 0;
    }
    const lv = inst?.lastVel;
    const lvMs = inst?.lastVelMs ?? 0;
    if (lv && nowMs - lvMs < 1200) motion = { vx: lv.vx || 0, vy: lv.vy || 0 };
  } catch (_e) {
    /* a malformed instance must never block a death */
  }

  const hits = guid ? (_hits.get(guid) || []).slice() : [];
  // A projectile that stopped next to this creature moments ago IS the kill.
  const proj = projectileNear(x, y, nowMs);
  if (proj) hits.push({ dx: proj.dx, dy: proj.dy, ts: proj.ts, source: "projectile", critical: false });

  const out = resolveKillImpulse({ guid, nowMs, yaw, motion, hits });
  _stats.resolved++;
  _stats.bySource[out.source] = (_stats.bySource[out.source] || 0) + 1;
  _lastResolved = { guid, ...out, hits: hits.length };
  return out;
}

let _lastResolved = null;

/* ── bus wiring ──────────────────────────────────────────────────────── */

let _installed = false;

function _localPlayerGuid() {
  try {
    const g = window.getLocalPlayerGuid?.();
    return g === null || g === undefined ? 0 : (g >>> 0) || 0;
  } catch (_e) {
    return 0;
  }
}

function _instFor(guid) {
  try {
    // Accept an EntityInstance directly (the ragdoll diag hands one straight
    // through), any numeric form, or a string — same tolerance as the
    // findInst helpers in ragdoll.js / dismember.js.
    if (guid && typeof guid === "object" && guid.parts) return guid;
    return window.liveScene3d?.entityManager?.entityMap?.get((Number(guid) >>> 0) || 0) || null;
  } catch (_e) {
    return null;
  }
}

function _bind() {
  const pc = window.__pluginClient;
  if (!pc?.events?.on) return false;
  // WE hit someone: the attacker is the local player, at a position we know.
  pc.events.on("damageDealt", (d) => {
    try {
      const ev = d?.detail ?? d ?? {};
      const name = typeof ev.defenderName === "string" ? ev.defenderName : "";
      if (!name) return;
      const em = window.liveScene3d?.entityManager;
      const guid = typeof em?.findGuidByName === "function" ? em.findGuidByName(name) >>> 0 : 0;
      if (!guid) return;
      const victim = _instFor(guid);
      const attacker = _instFor(_localPlayerGuid());
      if (!victim?.root?.position || !attacker?.root?.position) return;
      noteAttackerHit(
        guid,
        attacker.root.position.x,
        attacker.root.position.y,
        victim.root.position.x,
        victim.root.position.y,
        { critical: ev.criticalHit === true },
      );
    } catch (_e) {
      /* never break the shared bus */
    }
  });
  // Someone hit US — only useful for the (excluded) local ragdoll, but the
  // attacker's own death later reads better with its position on record.
  pc.events.on("damageTaken", (d) => {
    try {
      const ev = d?.detail ?? d ?? {};
      const name = typeof ev.attackerName === "string" ? ev.attackerName : "";
      if (!name) return;
      const em = window.liveScene3d?.entityManager;
      const guid = typeof em?.findGuidByName === "function" ? em.findGuidByName(name) >>> 0 : 0;
      if (!guid) return;
      const attacker = _instFor(guid);
      const victim = _instFor(_localPlayerGuid());
      if (!victim?.root?.position || !attacker?.root?.position) return;
      // Record the RECOIL on the attacker: whoever is punching us is facing us.
      noteAttackerHit(
        guid,
        victim.root.position.x,
        victim.root.position.y,
        attacker.root.position.x,
        attacker.root.position.y,
        { critical: false },
      );
    } catch (_e) {
      /* ignore */
    }
  });
  return true;
}

/** Idempotent; retries until the plugin bus exists. Call only when ragdoll is on. */
export function installKillImpulse() {
  if (_installed) return;
  _installed = true;
  window.__killImpulseNoteProjectile = noteProjectileImpact;
  let tries = 0;
  const attempt = () => {
    if (_bind()) return;
    if (++tries < 60) setTimeout(attempt, 2000);
  };
  attempt();
  const diag = (window.__diag = window.__diag || {});
  diag.killImpulse = {
    stats: () => ({ ..._stats, tracked: _hits.size, projectiles: _projectiles.length }),
    last: () => _lastResolved,
    hits: (guid) => hitsFor(guid),
    /** Dry-run the resolver for a live entity without killing it. */
    probe(guid) {
      const inst = _instFor(guid);
      if (!inst) return { error: "no such entity" };
      return killOptsFor(inst);
    },
    clear: () => forgetKillImpulse(),
  };
}

/** diag.js attach hook (registered in its attach list). */
export function attachKillImpulse(diag) {
  diag.killImpulse = diag.killImpulse || {
    stats: () => ({ ..._stats, tracked: _hits.size, projectiles: _projectiles.length }),
    last: () => _lastResolved,
    hits: (guid) => hitsFor(guid),
    clear: () => forgetKillImpulse(),
  };
}
