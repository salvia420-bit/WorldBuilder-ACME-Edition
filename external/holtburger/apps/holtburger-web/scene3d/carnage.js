// scene3d/carnage.js — Phase 5 automatic combat carnage (?carnage — DEFAULT ON, =off escape).
//
// The automation loop that ties Phases 1-4 together WITHOUT console commands:
//   splatter events (every hit, every creature) → decode height×quadrant →
//   attribute the hit to a leg chain from the limb registry → accumulate →
//   limp at 2 hits → sever the lower leg at 4 hits (mid-fight, visual only —
//   the server-authoritative creature keeps fighting, the limp sells it) →
//   on death, sever the most-damaged remaining leg at the hip (two legs on a
//   recent crit) and let the Phase-4 ragdoll take the rest down.
//
// On top of that spine sits the ESCALATION policy (pickEscalation, pure): every
// hit that is not itself a sever rolls ONCE against the first eligible
// candidate —
//   crit          → dislocate a joint (max 2/fight, creature fights on, wrong)
//   body hit      → chip a chunk of shell off the struck part (max 3/fight)
//   maimed + 8    → fracture the rest of the already-stumped limb (once)
//   resting chunk → shatter it into smaller pieces (progressive destruction)
// and death adds a GIB (deathPlan): a whole limb — plus the torso on a
// punishing critical finish — blown into voronoi chunks. Budget: a typical
// 10-15 hit kill shows 2-4 mid-fight events (measured over 400 seeded fights
// in scratchpad/test_carnage.mjs), escalating, never the same twice.
//
// DEATH FINISHERS (2026-08-02 expansion). On top of that spine sits a seeded
// draw from FINISHER_MOVES — decapitate / shear / torsoSplit / quarter /
// limbGib / torsoGib / chipShower / burst — gated by an overkill TIER (hits +
// crit + limbs already lost) and sampled without replacement, so hunting is a
// run of visibly different endings rather than one canned animation. Pure
// planner (`planFinisher`, `overkillTier`, `finisherBudget`, `planeRecipe`)
// with the execution isolated in `_runFinisherMove`; every cut plane is drawn
// with a randomized azimuth/tilt/offset so no two severs land on the same line.
//
// Attribution rules (attack height is meaningful, per the design):
//   Low band  → always a leg (quadrant picks WHICH leg on multi-leg rigs)
//   Mid band  → 50% a leg (hip-height IS leg-height on quadrupeds), else torso
//   Up band   → never a leg (head/torso; reserved for future head effects)
//
// Local player is exempt (their own camera rig). All state is per-instance
// and dies with the entity. Flag off: installCarnage() returns immediately,
// carnageOnDeath() is never called (hoisted gate in entities.js).

import * as THREE from "three";
import { decodeSplatterId } from "./splatter_decode.js";
import { ensureLimbRegistry, getLimbRegistry, setLimbDamage } from "./limbs.js";
import {
  slicePart,
  chipPart,
  fracturePart,
  dislocatePart,
  refractureDebrisNear,
  restingLargeDebrisCount,
} from "./dismember.js";
// Seeded per-death PRNG shared with the ragdoll's kill-direction resolver, so
// a death's finisher draw and its fall direction come from the same family of
// hashes (and a seeded test replays both). Dependency-free module.
import { hash32, mulberry32 } from "./kill_impulse.js";

export function carnageEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("carnage") !== "off";
  } catch (_e) {
    return false;
  }
}

export const CARNAGE_LIMP_HITS = 2; // leg hits before the limp shows
export const CARNAGE_SEVER_HITS = 4; // leg hits before the lower leg comes off
const CRIT_WINDOW_MS = 4000;

/* ── pure attribution (node-tested) ──────────────────────────────────── */

/**
 * Pick the leg a hit lands on. `decoded` = splatter_decode result
 * ({height, left, front}); `legs` = registry legs ([{leaf, side, end, ...}]).
 * `roll` ∈ [0,1) decides the Mid-band coin flip. Returns the leg or null.
 */
export function pickLegForHit(legs, decoded, roll = Math.random()) {
  if (!legs || legs.length === 0 || !decoded) return null;
  if (decoded.height === 2) return null; // Up band never hits legs
  if (decoded.height === 1 && roll >= 0.5) return null; // Mid: 50% torso
  const side = decoded.left ? "L" : "R";
  const end = decoded.front ? "F" : "B";
  // exact side+end match first (quadrupeds), then side match (bipeds), then any
  return (
    legs.find((l) => l.side === side && l.end === end) ||
    legs.find((l) => l.side === side) ||
    legs[0]
  );
}

/** Severity ramp for the limp: 2 hits → 0.5, 3 → 0.75, 4+ → 1.0. */
export function limpSeverity(hits) {
  if (hits < CARNAGE_LIMP_HITS) return 0;
  return Math.min(1, hits * 0.25);
}

/* ── escalation policy (pure, seeded, node-tested) ───────────────────
 * The budget: a typical 10-15 hit kill should show 2-4 DISTINCT destruction
 * events, escalating — not a constant hail of chunks. The mandatory events are
 * already the lower-leg sever at 4 leg hits and the death-time hip sever, so
 * this policy is tuned to add roughly one or two more, biased late.
 * Every event also honours a cooldown so two never land on the same swing.
 */
export const CARNAGE_EVENT_COOLDOWN_MS = 1100;
export const CARNAGE_DISLOCATE_CHANCE = 0.45; // per crit, max 2 per fight
export const CARNAGE_SHATTER_CHANCE = 0.25; // re-fracture a resting chunk
// (higher than it looks: the shatter only gets the leg hits the fracture
//  candidate above does not claim, so its realised rate is ~1 fight in 6)
export const CARNAGE_FRACTURE_CHANCE = 0.2; // blow up a stump's neighbour
export const CARNAGE_MAX_CHIPS = 3;
export const CARNAGE_MAX_DISLOCATIONS = 2;
export const CARNAGE_MAX_SHATTERS = 1;

/** Chip probability ramps with accumulated damage (armour giving way). */
export function chipChance(totalHits) {
  return Math.min(0.24, 0.07 + 0.015 * (totalHits || 0));
}

/**
 * Decide the extra destruction this hit triggers, if any. Pure: one uniform
 * `roll` is tested against the FIRST eligible candidate only, so the per-hit
 * event rate can never exceed that candidate's probability.
 *
 * ctx: { critical, height, legHit, totalHits, chips, dislocations, fractures,
 *        shatters, severed, restingDebris, cooldownOk }
 * → "dislocate" | "chip" | "shatter" | "fracture" | null
 */
export function pickEscalation(ctx, roll = Math.random()) {
  if (!ctx || !ctx.cooldownOk) return null;
  // 1. A crit wrenches a joint out of place (the creature fights on, wrong).
  if (ctx.critical && (ctx.dislocations || 0) < CARNAGE_MAX_DISLOCATIONS) {
    return roll < CARNAGE_DISLOCATE_CHANCE ? "dislocate" : null;
  }
  // 2. A body hit knocks a chunk of shell off without severing anything.
  if (!ctx.legHit && (ctx.height || 0) >= 1 && (ctx.chips || 0) < CARNAGE_MAX_CHIPS) {
    return roll < chipChance(ctx.totalHits) ? "chip" : null;
  }
  // 3. Heavy accumulated damage next to an existing stump blows the rest of
  //    that limb apart mid-fight. Once per fight, and only once maimed. This
  //    outranks the shatter below deliberately: a sever always leaves resting
  //    debris, so testing shatter first would starve the dramatic event.
  if ((ctx.totalHits || 0) >= 8 && (ctx.severed || 0) >= 1 && (ctx.fractures || 0) < 1) {
    return roll < CARNAGE_FRACTURE_CHANCE ? "fracture" : null;
  }
  // 4. Stray blows shatter chunks already lying on the ground (progressive).
  if ((ctx.restingDebris || 0) > 0 && (ctx.shatters || 0) < CARNAGE_MAX_SHATTERS) {
    return roll < CARNAGE_SHATTER_CHANCE ? "shatter" : null;
  }
  return null;
}

/**
 * Death-time plan (pure). Always the existing hip sever(s); a long or critical
 * fight additionally GIBS — voronoi-fracturing a limb, and on a punishing
 * critical finish the torso as well.
 *
 * ctx: { totalHits, critical, marked }
 */
export function deathPlan(ctx) {
  const hits = ctx?.totalHits || 0;
  const crit = !!ctx?.critical;
  return {
    hipSevers: crit ? 2 : 1,
    gibLimb: hits >= 9 || (crit && hits >= 5),
    gibTorso: crit && hits >= 12,
  };
}

/* ── death FINISHERS (pure, seeded, node-tested) ──────────────────────
 * `deathPlan` above is the spine (hip sever + the two original gibs). On top
 * of it the finisher planner draws EXTRA three-pinata moves from a catalogue,
 * weighted and gated by an overkill tier, so hunting reads as a run of
 * different endings instead of one animation: a head comes off, a torso splits
 * along an oblique plane, a creature is quartered, shell chips shower off, the
 * chunks already on the ground burst again.
 *
 * Everything here is a PURE function of (ctx, rand) so a seeded kill replays
 * exactly and the distribution is assertable without a renderer.
 */

/** Overkill tier 0-3 from the fight's shape. Higher = more spectacle. */
export function overkillTier(ctx) {
  const hits = ctx?.totalHits || 0;
  const crit = !!ctx?.critical;
  const severed = ctx?.severed || 0;
  const score = hits + (crit ? 4 : 0) + severed * 2;
  if (score >= 14) return 3;
  if (score >= 8) return 2;
  if (score >= 3) return 1;
  return 0;
}

/**
 * The catalogue. `minTier` gates availability; `w` is the draw weight; `needs`
 * names the rig feature the move requires so a legless/chainless creature
 * silently skips it instead of no-opping at execution time.
 */
export const FINISHER_MOVES = Object.freeze([
  { kind: "decapitate", minTier: 1, w: 1.1, needs: "chain" },
  { kind: "shear", minTier: 1, w: 1.0, needs: "chain" },
  { kind: "chipShower", minTier: 1, w: 0.9, needs: "any" },
  { kind: "quarter", minTier: 2, w: 1.2, needs: "leg" },
  { kind: "torsoSplit", minTier: 2, w: 1.0, needs: "root" },
  { kind: "limbGib", minTier: 2, w: 1.0, needs: "leg" },
  { kind: "burst", minTier: 2, w: 0.6, needs: "any" },
  { kind: "torsoGib", minTier: 3, w: 0.9, needs: "root" },
]);

/** How many EXTRA moves a tier is allowed to spend (before rig filtering). */
export function finisherBudget(tier, roll = 0) {
  if (tier <= 0) return 0;
  if (tier === 1) return 1;
  if (tier === 2) return roll < 0.55 ? 1 : 2;
  return roll < 0.45 ? 2 : 3;
}

/**
 * Draw the finisher move list (pure). Weighted sampling WITHOUT replacement so
 * one death never plays the same move twice, filtered by what the rig can
 * actually do.
 *
 * ctx: { totalHits, critical, severed, hasLegs, hasChains, hasRoot }
 * rand: 0..1 generator (seeded per death by the caller)
 */
export function planFinisher(ctx, rand = Math.random) {
  const base = deathPlan(ctx);
  const tier = overkillTier(ctx);
  const budget = finisherBudget(tier, rand());
  const pool = FINISHER_MOVES.filter((m) => {
    if (m.minTier > tier) return false;
    if (m.needs === "leg") return !!ctx?.hasLegs;
    if (m.needs === "chain") return !!ctx?.hasChains;
    if (m.needs === "root") return !!ctx?.hasRoot;
    return true;
  }).slice();
  const moves = [];
  for (let i = 0; i < budget && pool.length > 0; i++) {
    let total = 0;
    for (const m of pool) total += m.w;
    let r = rand() * total;
    let pick = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].w;
      if (r <= 0) {
        pick = j;
        break;
      }
    }
    moves.push(pool[pick].kind);
    pool.splice(pick, 1);
  }
  return { ...base, tier, budget, moves };
}

/**
 * Cut-plane recipe (pure). Returns the plane ORIENTATION as an azimuth + tilt
 * plus where along the part to cut, so no two severs land on the same line.
 *   style "transverse" — the classic square cut (normal ≈ world up)
 *   style "sagittal"   — a lengthwise split down the body
 *   style "oblique"    — a diagonal shear, the most fun to watch
 * `offset` is a signed fraction of the part's extent along the normal.
 */
export function planeRecipe(style, rand = Math.random) {
  const az = rand() * Math.PI * 2;
  const offset = (rand() - 0.5) * 0.5;
  if (style === "sagittal") return { az, tilt: 0, offset };
  if (style === "oblique") return { az, tilt: 0.45 + rand() * 0.65, offset };
  return { az, tilt: Math.PI / 2, offset }; // transverse: normal is world up
}

/* ── runtime ─────────────────────────────────────────────────────────── */

const _vCenter = new THREE.Vector3();
const _upNormal = new THREE.Vector3();

function _carnageState(inst) {
  if (!inst._carnage) {
    inst._carnage = {
      hits: new Map(),
      severed: new Set(),
      lastCritAt: 0,
      totalHits: 0,
      // escalation bookkeeping
      chips: 0,
      dislocations: 0,
      fractures: 0,
      shatters: 0,
      lastEventAt: 0,
      events: [],
      // filled at death by carnageOnDeath — {seed, tier, moves}
      finisher: null,
    };
  }
  return inst._carnage;
}

/** Transverse world-plane through a part's bbox center (three-world up ≈ AC +Z). */
function _slicePlaneFor(part) {
  part.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(part);
  return { point: box.getCenter(_vCenter.clone()), normal: _upNormal.set(0, 1, 0).clone() };
}

function _severLeg(inst, leg, atHip, critical) {
  const movable = leg.parts.slice(1); // parts[0] is the shared pelvis/root
  const sliceIdx = atHip ? movable[0] : movable[Math.min(1, movable.length - 1)];
  const chainParts = movable.slice(movable.indexOf(sliceIdx) + 1);
  const part = inst.parts?.[sliceIdx];
  if (!part) return Promise.resolve(null);
  const { point, normal } = _slicePlaneFor(part);
  return slicePart(inst, sliceIdx, point, normal, { critical, chainParts }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("[carnage] sever failed:", e);
    return null;
  });
}

/* ── escalation targeting ────────────────────────────────────────────
 * All of these read the limb registry that limbs.js already built: `chains`
 * is EVERY chain off the root (legs + arms + mandibles + head), `legs` is the
 * subset the limp/sever path owns. Non-leg chains are exactly what we want for
 * chips and dislocations — the parts a Low/Mid/Up band hit is NOT allowed to
 * take a leg from.
 */

/** Non-leg chains (arms/heads/mandibles), leaf-first, or [] . */
function _bodyChains(reg) {
  if (!reg?.chains) return [];
  const legChains = new Set(reg.legs.map((l) => l.chainIndex));
  const out = [];
  for (let i = 0; i < reg.chains.length; i++) {
    if (!legChains.has(i) && reg.chains[i].length > 1) out.push(reg.chains[i]);
  }
  return out;
}

/**
 * World-space impact point for a part, biased by the splatter height band
 * (three world +Y is AC +Z, so the band maps straight onto the bbox height).
 * Feeds voronoi impactPoint — the chip lands where the blow landed.
 */
function _impactPointFor(part, decoded) {
  part.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(part);
  const p = box.getCenter(new THREE.Vector3());
  const h = box.max.y - box.min.y;
  const band = decoded?.height === 2 ? 0.78 : decoded?.height === 0 ? 0.22 : 0.5;
  p.y = box.min.y + h * band;
  // Lateral bite somewhere on the struck side of the part.
  const sx = decoded?.left ? -1 : 1;
  const sz = decoded?.front ? 1 : -1;
  p.x += sx * (box.max.x - box.min.x) * 0.3;
  p.z += sz * (box.max.z - box.min.z) * 0.3;
  return p;
}

/** Chip target: a non-leg chain part on the struck band, else the torso. */
function _pickChipPart(inst, reg, decoded, roll = Math.random()) {
  const chains = _bodyChains(reg);
  const cands = [];
  for (const c of chains) {
    // Up band → the far end of the chain (head/mandible); Mid → its base.
    cands.push(decoded?.height === 2 ? c[c.length - 1] : c[Math.min(1, c.length - 1)]);
  }
  if (reg?.rootIndex !== undefined && reg.rootIndex !== null) cands.push(reg.rootIndex);
  const usable = cands.filter((i) => inst.parts?.[i] && inst.parts[i].visible !== false);
  if (usable.length === 0) return null;
  return usable[Math.min(usable.length - 1, Math.floor(roll * usable.length))];
}

/** Dislocation target: the struck leg's hip, else a non-leg chain's base. */
function _pickDislocation(inst, reg, leg, roll = Math.random()) {
  if (leg && inst.parts?.[leg.hip]) {
    return { part: leg.hip, chainParts: leg.movable.slice(1) };
  }
  const chains = _bodyChains(reg);
  if (chains.length === 0) return null;
  const c = chains[Math.min(chains.length - 1, Math.floor(roll * chains.length))];
  const movable = c.slice(1);
  if (movable.length === 0 || !inst.parts?.[movable[0]]) return null;
  return { part: movable[0], chainParts: movable.slice(1) };
}

/** The still-attached part right above an existing stump. */
function _neighbourOfSevered(inst, reg, st) {
  for (const leg of reg?.legs || []) {
    if (!st.severed.has(leg.leaf)) continue;
    const hip = leg.movable?.[0];
    if (hip !== undefined && inst.parts?.[hip]?.visible !== false) {
      const meshes = inst.parts[hip].children?.some?.((c) => c.isMesh);
      if (meshes) return hip;
    }
  }
  return null;
}

function _findInst(guid) {
  const em = window.liveScene3d?.entityManager;
  return em?.entityMap?.get(Number(guid) >>> 0) || null;
}

/** Run one escalation action. Never throws; never blocks the bus. */
function _runEscalation(kind, inst, reg, st, leg, decoded, critical) {
  const note = (extra) => {
    st.lastEventAt = performance.now();
    st.events.push({ kind, at: st.totalHits, ...extra });
    if (st.events.length > 16) st.events.shift();
  };
  try {
    if (kind === "dislocate") {
      const t = _pickDislocation(inst, reg, leg);
      if (!t) return false;
      const sev = Math.min(1, 0.45 + 0.05 * st.totalHits + (critical ? 0.2 : 0));
      const r = dislocatePart(inst, t.part, { severity: sev, chainParts: t.chainParts });
      if (!r) return false;
      st.dislocations++;
      note({ part: t.part, severity: sev });
      return true;
    }
    if (kind === "chip") {
      const pi = _pickChipPart(inst, reg, decoded);
      if (pi === null || pi === undefined) return false;
      const part = inst.parts[pi];
      st.chips++; // count the attempt: an unchippable part must not re-roll forever
      note({ part: pi });
      chipPart(inst, pi, { impactPointW: _impactPointFor(part, decoded) })
        .catch((e) => console.warn("[carnage] chip failed:", e));
      return true;
    }
    if (kind === "shatter") {
      if (!inst.root) return false;
      st.shatters++;
      note({});
      refractureDebrisNear(inst.root.position, 2.5, { maxTargets: 1 })
        .catch((e) => console.warn("[carnage] shatter failed:", e));
      return true;
    }
    if (kind === "fracture") {
      const pi = _neighbourOfSevered(inst, reg, st);
      if (pi === null) return false;
      st.fractures++;
      note({ part: pi });
      fracturePart(inst, pi, { critical, impactPointW: _impactPointFor(inst.parts[pi], decoded) })
        .catch((e) => console.warn("[carnage] fracture failed:", e));
      return true;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[carnage] escalation failed:", kind, e);
  }
  return false;
}

function _isLocalPlayer(guid) {
  try {
    return (window.getLocalPlayerGuid?.() >>> 0) === (Number(guid) >>> 0);
  } catch (_e) {
    return false;
  }
}

async function _onSplatterHit(inst, decoded, critical) {
  const setupId = inst._setupId ?? inst.setupId;
  if (!setupId) return;
  let reg = getLimbRegistry(setupId);
  if (!reg) reg = await ensureLimbRegistry(setupId, inst).catch(() => null);
  // Chains, not legs: a legless rig (floating/serpent) still chips and
  // dislocates — only the limp/sever path needs `legs`.
  if (!reg?.chains?.length) return;
  const st = _carnageState(inst);
  st.totalHits++;
  if (critical) st.lastCritAt = performance.now();
  const leg = pickLegForHit(reg.legs, decoded);
  let severedNow = false;
  if (leg) {
    const hits = (st.hits.get(leg.leaf) || 0) + (critical ? 2 : 1);
    st.hits.set(leg.leaf, hits);
    const sev = limpSeverity(hits);
    if (sev > 0) setLimbDamage(inst, leg.leaf, sev);
    if (hits >= CARNAGE_SEVER_HITS && !st.severed.has(leg.leaf)) {
      st.severed.add(leg.leaf);
      setLimbDamage(inst, leg.leaf, 1.0);
      _severLeg(inst, leg, false, critical);
      severedNow = true;
      st.lastEventAt = performance.now();
    }
  }

  // Escalation rides EVERY hit — including the Mid/Up-band ones the leg
  // attribution rejects, which is where chips and dislocations come from.
  if (severedNow) return; // a sever is this swing's event
  let restingDebris = 0;
  try {
    restingDebris = restingLargeDebrisCount();
  } catch (_e) { /* dismember not ready */ }
  const kind = pickEscalation({
    critical,
    height: decoded.height,
    legHit: !!leg,
    totalHits: st.totalHits,
    chips: st.chips,
    dislocations: st.dislocations,
    fractures: st.fractures,
    shatters: st.shatters,
    severed: st.severed.size,
    restingDebris,
    cooldownOk: performance.now() - st.lastEventAt >= CARNAGE_EVENT_COOLDOWN_MS,
  });
  if (kind) _runEscalation(kind, inst, reg, st, leg, decoded, critical);
}

/* ── finisher execution ──────────────────────────────────────────────── */

/** World-space plane from a `planeRecipe` + a part's measured box. */
function _planeFromRecipe(part, recipe) {
  part.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(part);
  const center = box.getCenter(new THREE.Vector3());
  // three world is Y-up (worldRoot rotates AC +Z onto +Y), so `tilt` measured
  // off the horizontal gives the transverse cut at tilt = π/2.
  const ct = Math.cos(recipe.tilt);
  const normal = new THREE.Vector3(ct * Math.cos(recipe.az), Math.sin(recipe.tilt), ct * Math.sin(recipe.az));
  if (normal.lengthSq() < 1e-9) normal.set(0, 1, 0);
  normal.normalize();
  const size = box.getSize(new THREE.Vector3());
  const extent =
    Math.abs(size.x * normal.x) + Math.abs(size.y * normal.y) + Math.abs(size.z * normal.z);
  center.addScaledVector(normal, (recipe.offset || 0) * extent);
  return { point: center, normal };
}

/** Slice a part with a styled plane. Returns true when the attempt was made. */
function _styledSlice(inst, partIndex, style, rand, opts = {}) {
  const part = inst?.parts?.[partIndex];
  if (!part || part.visible === false) return false;
  const meshes = part.children?.filter?.((c) => c.isMesh);
  if (!meshes || meshes.length === 0) return false;
  const { point, normal } = _planeFromRecipe(part, planeRecipe(style, rand));
  slicePart(inst, partIndex, point, normal, opts).catch((e) =>
    console.warn("[carnage] finisher slice failed:", e),
  );
  return true;
}

/** Longest non-leg chain (head/mandible/arm), or null. */
function _longestBodyChain(reg, rand) {
  const chains = _bodyChains(reg).filter((c) => c.length > 1);
  if (chains.length === 0) return null;
  chains.sort((a, b) => b.length - a.length);
  // Prefer the longest, but let a shorter one win sometimes so a creature with
  // two mandibles does not always lose the same one.
  const i = chains.length > 1 && rand() < 0.3 ? 1 : 0;
  return chains[i];
}

/**
 * Run ONE finisher move. `cx` carries the mutable cursor shared across the
 * death (which legs are still available, which parts are already destroyed) so
 * two moves never fight over the same part. Never throws.
 */
function _runFinisherMove(kind, inst, reg, st, crit, rand, cx) {
  const claim = (i) => {
    if (i === null || i === undefined || i < 0) return false;
    if (cx.used.has(i) || !inst.parts?.[i]) return false;
    cx.used.add(i);
    return true;
  };
  try {
    if (kind === "decapitate") {
      const c = _longestBodyChain(reg, rand);
      const movable = c ? c.slice(1) : [];
      if (movable.length === 0 || !claim(movable[0])) return false;
      // Cut the neck/base square-ish and let the whole distal chain ride off.
      const ok = _styledSlice(inst, movable[0], rand() < 0.7 ? "transverse" : "oblique", rand, {
        critical: crit,
        chainParts: movable.slice(1),
      });
      if (ok) st.events.push({ kind: "decapitate", part: movable[0] });
      return ok;
    }
    if (kind === "shear") {
      const chains = _bodyChains(reg).filter((c) => c.length > 1);
      if (chains.length === 0) return false;
      const c = chains[Math.min(chains.length - 1, Math.floor(rand() * chains.length))];
      const movable = c.slice(1);
      const pick = movable[Math.min(movable.length - 1, Math.floor(rand() * movable.length))];
      if (!claim(pick)) return false;
      const ok = _styledSlice(inst, pick, "oblique", rand, {
        critical: crit,
        chainParts: movable.slice(movable.indexOf(pick) + 1),
      });
      if (ok) st.events.push({ kind: "shear", part: pick });
      return ok;
    }
    if (kind === "torsoSplit") {
      const ri = reg?.rootIndex;
      if (!claim(ri)) return false;
      // A lengthwise or diagonal split reads as "cleaved", not "beheaded".
      const ok = _styledSlice(inst, ri, rand() < 0.55 ? "oblique" : "sagittal", rand, {
        critical: crit,
        speedScale: 0.7,
        upScale: 1.3,
      });
      if (ok) st.events.push({ kind: "torsoSplit", part: ri });
      return ok;
    }
    if (kind === "quarter") {
      const leg = cx.legs[cx.legCursor];
      if (!leg) return false;
      cx.legCursor++;
      if (!claim(leg.movable?.[0])) return false;
      st.severed.add(leg.leaf);
      _severLeg(inst, leg, true, crit);
      st.events.push({ kind: "quarter", part: leg.movable[0] });
      return true;
    }
    if (kind === "limbGib") {
      const leg = cx.legs[cx.legCursor];
      const target = leg?.hip;
      if (target === undefined || !claim(target)) return false;
      cx.legCursor++;
      st.severed.add(leg.leaf);
      st.fractures++;
      st.events.push({ kind: "limbGib", part: target });
      fracturePart(inst, target, { critical: crit, scale: crit ? 1.2 : 1 })
        .catch((e) => console.warn("[carnage] limb gib failed:", e));
      return true;
    }
    if (kind === "torsoGib") {
      const ri = reg?.rootIndex;
      if (!claim(ri)) return false;
      st.fractures++;
      st.events.push({ kind: "torsoGib", part: ri });
      fracturePart(inst, ri, { critical: true, scale: 1.2 })
        .catch((e) => console.warn("[carnage] torso gib failed:", e));
      return true;
    }
    if (kind === "chipShower") {
      let fired = 0;
      for (let i = 0; i < 2; i++) {
        const pi = _pickChipPart(inst, reg, { height: i === 0 ? 2 : 1, left: rand() < 0.5, front: rand() < 0.5 }, rand());
        if (pi === null || pi === undefined || cx.used.has(pi)) continue;
        st.chips++;
        fired++;
        chipPart(inst, pi, { fragmentCount: 4 + ((rand() * 3) | 0) })
          .catch((e) => console.warn("[carnage] finisher chip failed:", e));
      }
      if (fired) st.events.push({ kind: "chipShower", count: fired });
      return fired > 0;
    }
    if (kind === "burst") {
      if (!inst.root) return false;
      st.shatters++;
      st.events.push({ kind: "burst" });
      refractureDebrisNear(inst.root.position, 2.2, { maxTargets: 2 })
        .catch((e) => console.warn("[carnage] finisher burst failed:", e));
      return true;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[carnage] finisher move failed:", kind, e);
  }
  return false;
}

/**
 * Death-time finisher — called from entities.js at the death stamp (before
 * the ragdoll arms) when `?carnage` is on. Severs the most-damaged remaining
 * leg at the hip (a crit within the last 4 s takes a second leg with it), then
 * spends an overkill-tiered budget of EXTRA three-pinata moves drawn from
 * FINISHER_MOVES against a per-death seed — decapitations, oblique torso
 * splits, quarterings, chip showers, gibs, and re-bursting the chunks already
 * on the ground. No two kills draw the same list.
 *
 * Entity lifetime, corpse timing and the ragdoll→corpse part-count guard are
 * untouched: nothing here adds or removes `inst.parts` entries, it only swaps
 * the meshes inside part Groups (the same in-place children swap the
 * mid-fight sever has always used).
 */
export function carnageOnDeath(inst) {
  const setupId = inst?._setupId ?? inst?.setupId;
  const reg = setupId ? getLimbRegistry(setupId) : null;
  if (!reg?.chains?.length) return;
  const st = _carnageState(inst);
  const crit = performance.now() - st.lastCritAt < CRIT_WINDOW_MS;
  const remaining = (reg.legs || [])
    .filter((l) => !st.severed.has(l.leaf))
    .sort((a, b) => (st.hits.get(b.leaf) || 0) - (st.hits.get(a.leaf) || 0));
  // Sever/finish on death only when the fight actually marked the creature (a
  // leg hit, a crit finish, or a genuine slugging match) — a one-shot kill from
  // full health stays clean.
  const marked = remaining.some((l) => st.hits.get(l.leaf) > 0) || crit || st.totalHits >= 3;
  if (!marked) return;

  // Per-death PRNG: reproducible for tests, different for every kill.
  const seed = hash32((Number(inst.guid) >>> 0) || 0, Math.round(inst._deathAt || performance.now()));
  const rand = mulberry32(seed);

  const bodyChains = _bodyChains(reg).filter((c) => c.length > 1);
  const hasRoot =
    reg.rootIndex !== undefined && reg.rootIndex !== null && reg.rootIndex >= 0 && !!inst.parts?.[reg.rootIndex];
  const plan = planFinisher(
    {
      totalHits: st.totalHits,
      critical: crit,
      severed: st.severed.size,
      hasLegs: remaining.length > 0,
      hasChains: bodyChains.length > 0,
      hasRoot,
    },
    rand,
  );
  st.finisher = { seed, tier: plan.tier, moves: plan.moves.slice() };

  const cx = { used: new Set(), legs: remaining, legCursor: 0 };

  // 1. The spine: hip sever(s) of the most-damaged remaining leg(s).
  if (remaining.length > 0) {
    const leg = remaining[cx.legCursor++];
    st.severed.add(leg.leaf);
    cx.used.add(leg.movable?.[0]);
    _severLeg(inst, leg, true, crit);
    if (plan.hipSevers > 1 && remaining.length > cx.legCursor) {
      const leg2 = remaining[cx.legCursor++];
      st.severed.add(leg2.leaf);
      cx.used.add(leg2.movable?.[0]);
      _severLeg(inst, leg2, true, true);
    }
  }

  // 2. The original gib pair (kept exactly as shipped — the tiers below are
  //    additive, not a replacement, so nothing that worked yesterday stops).
  if (plan.gibLimb) {
    try {
      let gibPart = null;
      if (remaining.length > cx.legCursor) {
        const leg = remaining[cx.legCursor++];
        gibPart = leg.hip;
        st.severed.add(leg.leaf);
      } else if (bodyChains.length > 0) {
        const c = bodyChains[Math.min(bodyChains.length - 1, Math.floor(rand() * bodyChains.length))];
        gibPart = c[c.length - 1]; // head/mandible/arm tip
      }
      if (gibPart !== null && gibPart !== undefined && inst.parts?.[gibPart] && !cx.used.has(gibPart)) {
        cx.used.add(gibPart);
        st.fractures++;
        fracturePart(inst, gibPart, { critical: crit, scale: crit ? 1.2 : 1 })
          .catch((e) => console.warn("[carnage] gib failed:", e));
      }
      if (plan.gibTorso && hasRoot && !cx.used.has(reg.rootIndex)) {
        cx.used.add(reg.rootIndex);
        st.fractures++;
        fracturePart(inst, reg.rootIndex, { critical: true, scale: 1.2 })
          .catch((e) => console.warn("[carnage] torso gib failed:", e));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[carnage] death gib failed:", e);
    }
  }

  // 3. The seeded finisher draw — this is what makes deaths differ.
  for (const kind of plan.moves) {
    _runFinisherMove(kind, inst, reg, st, crit, rand, cx);
  }
  if (st.events.length > 24) st.events.splice(0, st.events.length - 24);
}

/* ── bus wiring ──────────────────────────────────────────────────────── */

let _installed = false;
let _critByName = new Map(); // defenderName → ts (same latch idea as combatFx)

function _bind() {
  const pc = window.__pluginClient;
  if (!pc?.events?.on) return false;
  pc.events.on("playEffect", ({ targetGuid, scriptId }) => {
    try {
      const decoded = decodeSplatterId(scriptId);
      if (!decoded) return;
      if (_isLocalPlayer(targetGuid)) return;
      const inst = _findInst(targetGuid);
      if (!inst?.parts?.length) return;
      const name = inst.meta?.name;
      const critTs = name ? _critByName.get(name) : undefined;
      const critical = critTs !== undefined && performance.now() - critTs < 3000;
      if (critical && name) _critByName.delete(name); // consume
      _onSplatterHit(inst, decoded, critical);
    } catch (_e) { /* never break the shared bus */ }
  });
  pc.events.on("damageDealt", (d) => {
    try {
      if (d?.criticalHit && d.defenderName) {
        _critByName.set(d.defenderName, performance.now());
        if (_critByName.size > 32) {
          const oldest = _critByName.keys().next().value;
          _critByName.delete(oldest);
        }
      }
    } catch (_e) { /* ignore */ }
  });
  return true;
}

/** Idempotent; retries until the plugin bus exists. Call only when flag on. */
export function installCarnage() {
  if (_installed || !carnageEnabled()) return;
  _installed = true;
  let tries = 0;
  const attempt = () => {
    if (_bind()) {
      // eslint-disable-next-line no-console
      console.info("[carnage] armed — hits accumulate on limbs; legs sever at",
        CARNAGE_SEVER_HITS, "hits; crits dislocate, body hits chip, a maimed",
        "creature loses the rest of the limb, and a long/critical kill gibs");
      return;
    }
    if (++tries < 60) setTimeout(attempt, 2000);
  };
  attempt();
  // entities.js calls the death finisher through this window hook so it never
  // has to import this module (keeps carnage fully out of the flag-off arm
  // and out of bare-node suite import graphs).
  window.__carnageOnDeath = carnageOnDeath;
  const diag = (window.__diag = window.__diag || {});
  diag.carnage = {
    enabled: carnageEnabled,
    state(guid) {
      const inst = _findInst(guid);
      if (!inst?._carnage) return null;
      const c = inst._carnage;
      return {
        totalHits: c.totalHits,
        perLeg: Object.fromEntries(c.hits),
        severed: [...c.severed],
        chips: c.chips,
        dislocations: c.dislocations,
        fractures: c.fractures,
        shatters: c.shatters,
        events: c.events.slice(),
        finisher: c.finisher || null,
        dislocatedParts: inst._dislocations ? [...inst._dislocations.keys()] : [],
      };
    },
    /**
     * Dry-run the death finisher draw over N seeded kills:
     * __diag.carnage.simulateFinisher(200, {totalHits: 12, critical: true})
     * → { tiers, byMove, distinctLists } — the variety check without a kill.
     */
    simulateFinisher(n = 200, ctx = {}) {
      const base = {
        totalHits: 10,
        critical: false,
        severed: 1,
        hasLegs: true,
        hasChains: true,
        hasRoot: true,
        ...ctx,
      };
      const tiers = {};
      const byMove = {};
      const lists = new Set();
      for (let i = 0; i < n; i++) {
        const p = planFinisher(base, mulberry32(hash32(i + 1, 0x5eed)));
        tiers[p.tier] = (tiers[p.tier] || 0) + 1;
        for (const m of p.moves) byMove[m] = (byMove[m] || 0) + 1;
        lists.add(p.moves.join(">"));
      }
      return { n, tiers, byMove, distinctLists: lists.size };
    },
    /** Dry-run the escalation policy: __diag.carnage.simulate(12, 0.2) */
    simulate(hits = 12, roll = 0.3, critEvery = 5) {
      const st = { chips: 0, dislocations: 0, fractures: 0, shatters: 0, severed: 1 };
      const out = [];
      for (let i = 1; i <= hits; i++) {
        const kind = pickEscalation({
          critical: i % critEvery === 0,
          height: i % 3,
          legHit: i % 2 === 0,
          totalHits: i,
          ...st,
          restingDebris: st.severed,
          cooldownOk: true,
        }, roll);
        if (kind) {
          out.push({ hit: i, kind });
          if (kind === "chip") st.chips++;
          else if (kind === "dislocate") st.dislocations++;
          else if (kind === "shatter") st.shatters++;
          else if (kind === "fracture") st.fractures++;
        }
      }
      return { events: out, death: deathPlan({ totalHits: hits, critical: true }) };
    },
    thresholds: {
      limpHits: CARNAGE_LIMP_HITS,
      severHits: CARNAGE_SEVER_HITS,
      cooldownMs: CARNAGE_EVENT_COOLDOWN_MS,
      maxChips: CARNAGE_MAX_CHIPS,
      maxDislocations: CARNAGE_MAX_DISLOCATIONS,
      maxShatters: CARNAGE_MAX_SHATTERS,
    },
  };
}
