// scene3d/vfx/fx_cues.js — tier 1 (2026-10-10): what every PlayEffect cue does
// to the WORLD around it — a light flash (`?fxLights`, vfx/fx_lights.js) and,
// for the forceful ones, a shockwave ring (`?fxDistort`, vfx/fx_distort.js).
//
// Keyed by the same look names the placeholder bursts use
// (play_effect_vfx.js `_burstLookFor`, play_effect_burst_fx.js BURST_LOOKS), so
// all 170 gameplay PlayScripts are covered by family. Fired once per dispatched
// PlayEffect (`_dispatchResolvedPlayEffect`), alongside the retail emitters and
// the placeholder — whichever of those draws, the scene around it reacts.
//
// Colours are linear RGB (max channel 1); intensities are in the DAT LightInfo
// units the light pool uses (setup torches author 20-100); ranges in metres;
// envelope times in ms (attack, hold, decay). `shock` = {radius m, strength
// 0..1, ms}. Matter cues (blood splatter, dirty fighting) and the darkness
// cues draw no light.
//
// Tier 2 (2026-10-10, `?fxDecals`): `decal` = {kind, radius m, ahead m} — the
// cue leaves a ground mark (vfx/fx_decals.js) under its target, or `ahead`
// metres in front of it (the breath weapons). kind "element" takes the mark of
// the projectile's own element (vfx/fx_ribbons.js `fxProjectileElement`): a
// flame bolt scorches, a frost bolt rimes, an acid stream stains, lightning and
// nether scorch with their own rim colour. Blood is `?blood`'s (blood_decals.js).

import { spawnFxFlash } from "./fx_lights.js";
import { spawnFxShockwave } from "./fx_distort.js";
import { spawnFxDecal } from "./fx_decals.js";

const C = (r, g, b, I, range, attack, hold, decay, extra = {}) =>
  Object.freeze({ color: [r, g, b], intensity: I, range, attackMs: attack, holdMs: hold, decayMs: decay, ...extra });

export const FX_CUES = Object.freeze({
  // cast / projectile
  launch: C(0.45, 0.75, 1.0, 30, 6, 30, 40, 300),
  explode: C(1.0, 0.55, 0.2, 60, 9, 20, 60, 550, { flicker: 0.2, flickerHz: 18, shock: { radius: 3.5, strength: 0.75, ms: 600 },
    decal: { kind: "scorch", radius: 1.8 } }),
  projectileCollision: C(1.0, 0.6, 0.3, 45, 7, 20, 40, 450, { shock: { radius: 2.5, strength: 0.55, ms: 500 },
    decal: { kind: "element", radius: 1.3 } }),
  fizzle: C(0.7, 0.7, 0.75, 8, 3, 20, 20, 300),
  // combat
  spark: C(1.0, 0.95, 0.85, 20, 3, 10, 10, 120, { flicker: 0.5, flickerHz: 30 }),
  // vitals
  healthUp: C(0.5, 1.0, 0.6, 18, 5, 60, 120, 700),
  regenUp: C(0.55, 1.0, 0.65, 14, 5, 60, 120, 700),
  healthDown: C(1.0, 0.35, 0.3, 14, 4, 30, 60, 500),
  regenDown: C(1.0, 0.4, 0.35, 10, 4, 30, 60, 500),
  swapHealth: C(1.0, 0.6, 1.0, 14, 4, 40, 80, 600),
  // wards / buffs
  shield: C(0.6, 0.75, 1.0, 16, 5, 60, 120, 700),
  attribUp: C(1.0, 0.85, 0.5, 16, 5, 60, 150, 800),
  skillUp: C(1.0, 0.88, 0.55, 14, 5, 60, 150, 800),
  enchantUp: C(1.0, 0.82, 0.45, 18, 5, 60, 150, 800),
  attribDown: C(0.6, 0.4, 0.9, 10, 4, 40, 80, 600),
  skillDown: C(0.62, 0.42, 0.9, 10, 4, 40, 80, 600),
  enchantDown: C(0.55, 0.45, 0.95, 12, 4, 40, 80, 600),
  dispel: C(0.75, 0.7, 1.0, 18, 5, 30, 60, 500, { shock: { radius: 2.0, strength: 0.4, ms: 500 } }),
  vitaeUp: C(0.9, 0.95, 1.0, 14, 5, 60, 100, 700),
  vitaeDown: C(0.5, 0.5, 0.9, 10, 4, 40, 80, 600),
  // presence
  death: C(0.6, 0.25, 0.8, 24, 6, 40, 100, 900, { shock: { radius: 3.0, strength: 0.5, ms: 800 } }),
  create: C(0.7, 0.55, 1.0, 22, 5, 80, 100, 700, { shock: { radius: 2.5, strength: 0.45, ms: 650 } }),
  hide: C(0.8, 0.4, 1.0, 10, 4, 40, 60, 500),
  portal: C(0.75, 0.5, 1.0, 40, 8, 40, 150, 900, { flicker: 0.15, flickerHz: 8, shock: { radius: 3.0, strength: 0.6, ms: 700 } }),
  portalStorm: C(0.75, 0.5, 1.0, 30, 7, 60, 400, 1200, { flicker: 0.3, flickerHz: 10 }),
  camping: C(1.0, 0.7, 0.4, 10, 4, 60, 100, 700),
  layingOfHands: C(0.9, 1.0, 1.0, 16, 5, 80, 200, 900),
  // breath weapons
  breatheFlame: C(1.0, 0.5, 0.2, 50, 9, 30, 300, 700, { flicker: 0.3, flickerHz: 14,
    decal: { kind: "scorch", radius: 2.2, ahead: 3.0 } }),
  breatheFrost: C(0.6, 0.85, 1.0, 35, 8, 30, 300, 700, { flicker: 0.1, flickerHz: 8,
    decal: { kind: "frost", radius: 2.4, ahead: 3.0 } }),
  breatheAcid: C(0.6, 1.0, 0.35, 35, 8, 30, 300, 700, { flicker: 0.15, flickerHz: 10,
    decal: { kind: "acid", radius: 2.2, ahead: 3.0 } }),
  breatheLightning: C(0.75, 0.85, 1.0, 70, 10, 5, 30, 250, { flicker: 0.7, flickerHz: 30,
    decal: { kind: "scorch", radius: 1.8, ahead: 3.0 } }),
  // status / events
  specialState: C(1.0, 1.0, 1.0, 12, 4, 40, 80, 600),
  levelUp: C(1.0, 0.9, 0.55, 45, 9, 120, 300, 1400, { shock: { radius: 4.0, strength: 0.5, ms: 900 } }),
  augmentation: C(1.0, 0.9, 0.6, 30, 7, 100, 200, 1000, { shock: { radius: 3.0, strength: 0.4, ms: 800 } }),
  aetheria: C(0.55, 1.0, 0.85, 30, 7, 80, 200, 1000, { shock: { radius: 3.0, strength: 0.4, ms: 800 } }),
  restriction: C(0.8, 0.8, 1.0, 12, 4, 40, 80, 600),
  wedding: C(1.0, 0.8, 0.9, 25, 7, 150, 400, 1200),
  bunnySmite: C(1.0, 1.0, 1.0, 70, 12, 20, 120, 900, { shock: { radius: 5.0, strength: 0.8, ms: 900 },
    decal: { kind: "scorch", radius: 3.0 } }),
  baelZharonSmite: C(0.8, 0.3, 0.4, 70, 12, 20, 120, 900, { shock: { radius: 5.0, strength: 0.8, ms: 900 },
    decal: { kind: "scorch", radius: 3.0 } }),
  blackMadness: C(0.7, 0.4, 0.9, 60, 11, 20, 120, 900, { shock: { radius: 5.0, strength: 0.8, ms: 900 },
    decal: { kind: "scorch", radius: 3.0 } }),
});

// Height of the cue above the target's root (three world, metres): chest height.
const CUE_HEIGHT_M = 1.0;

/**
 * Fire a cue's light flash + shockwave at a THREE-world root position, and
 * (tier 2) its ground mark at `opts.decalWorld`.
 * Returns what fired (diagnostics / tests). Never throws.
 * @param {string} look burst look name (play_effect_vfx.js `_burstLookFor`)
 * @param {{x:number,y:number,z:number}} rootWorld
 * @param {{decalWorld?: {x:number,y:number,z:number}, element?: {decal: string|null, color: number[]}|null}} [opts]
 */
export function fireFxCue(look, rootWorld, opts = null) {
  const cue = FX_CUES[look];
  if (!cue || !rootWorld) return { light: null, shock: null, decal: null };
  const p = { x: rootWorld.x, y: rootWorld.y + CUE_HEIGHT_M, z: rootWorld.z };
  let light = null;
  let shock = null;
  try {
    light = spawnFxFlash({
      position: p, color: cue.color, intensity: cue.intensity, range: cue.range,
      attackMs: cue.attackMs, holdMs: cue.holdMs, decayMs: cue.decayMs,
      flicker: cue.flicker ?? 0, flickerHz: cue.flickerHz ?? 0,
    });
  } catch (_) { light = null; }
  if (cue.shock) {
    try {
      shock = spawnFxShockwave({ position: p, radius: cue.shock.radius, strength: cue.shock.strength, durationMs: cue.shock.ms });
    } catch (_) { shock = null; }
  }
  let decal = null;
  if (cue.decal && opts && opts.decalWorld) {
    try {
      let kind = cue.decal.kind;
      let color = kind === "scorch" ? cue.color : undefined;
      if (kind === "element") {
        const el = opts.element || null;
        kind = el && el.decal ? el.decal : null;
        color = el && kind === "scorch" ? el.color : undefined;
      }
      if (kind) decal = spawnFxDecal({ position: opts.decalWorld, kind, radius: cue.decal.radius, color });
    } catch (_) { decal = null; }
  }
  return { light, shock, decal };
}

/** Tier 2: how far in front of its target a cue's mark lands (the breaths), metres. */
export function fxCueDecalAhead(look) {
  const d = FX_CUES[look]?.decal;
  return d && Number.isFinite(d.ahead) ? d.ahead : 0;
}
