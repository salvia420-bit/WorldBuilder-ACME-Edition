// test_vfx_foliage.mjs — P3.7 foliage/breath particle components + gates.
// Plain node, NO node_modules (like the other VFX harness tests). From $W:
//   node test_vfx_foliage.mjs
//
// Locks: (1) the 4 components register + are manifest-valid (legacy-safety
// contract); (2) the gates are pure + deterministic + day/weather/season
// correct; (3) emit() gates OUT → [] (byte-free) and ON → a persistent emitter
// POJO naming the right sprite; (4) flag-OFF → no emit.

import {
  foliagePollen, foliageFireflies, foliageLeaves,
} from "./scene3d/vfx/components/foliageAmbient.js";
import { breathFog } from "./scene3d/vfx/components/breathFog.js";
import { allComponents, validateComponent } from "./scene3d/vfx/registry.js";
import {
  nightFactor, pollenGate, firefliesGate, leavesGate, breathFogGate,
  marshGasGate, PARTICLE_GATES,
} from "./scene3d/vfx/particle_env_gates.js";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; } else { fail++; console.log("  FAIL:", name, extra ?? ""); }
};

// ── 1. registration + manifest conformance ───────────────────────────────────
const FOUR = ["particle.breathFog", "particle.foliageFireflies", "particle.foliagePollen", "particle.foliageLeaves"];
const liveIds = allComponents().map((c) => c.id);
for (const id of FOUR) check(`registered: ${id}`, liveIds.includes(id));
for (const c of [foliagePollen, foliageFireflies, foliageLeaves, breathFog]) {
  check(`${c.id} manifest valid`, validateComponent(c).length === 0, validateComponent(c));
  check(`${c.id} mech=particle`, c.mech === "particle");
  check(`${c.id} family=particle`, c.family === "particle");
  check(`${c.id} channel=emitter`, c.channel === "emitter");
  check(`${c.id} linkVariant()===""`, c.linkVariant() === "");
  check(`${c.id} cacheKeyScope=none`, c.cacheKeyScope === "none");
  check(`${c.id} writes=[emitter]`, JSON.stringify(c.writes) === '["emitter"]');
  check(`${c.id} lightCountDelta=0`, c.lightCountDelta === 0);
  check(`${c.id} deterministic`, c.deterministic === true);
  check(`${c.id} has emit()`, typeof c.emit === "function");
}

// ── 2. gate correctness (pure) ───────────────────────────────────────────────
const noon = { sunAlt: 0.92, season: 2, temperatureC: 25, stormness: 0, frost: 0, windStrength: 1.0 };
const night = { sunAlt: -0.4, season: 2, temperatureC: 16, stormness: 0, frost: 0, windStrength: 1.0 };
const winterNight = { sunAlt: -0.4, season: 0, temperatureC: -4, frost: 0.9, stormness: 0, windStrength: 1.2 };
const autumnGust = { sunAlt: 0.3, season: 3, temperatureC: 9, stormness: 0.2, frost: 0.1, windStrength: 1.55 };
const stormNoon = { ...noon, stormness: 1, isStorm: true };

check("nightFactor: noon=0", nightFactor(noon.sunAlt) === 0);
check("nightFactor: night=1", nightFactor(night.sunAlt) === 1);
check("pollen: day>0", pollenGate(noon) > 0);
check("pollen: night=0", pollenGate(night) === 0);
check("pollen: storm=0", pollenGate(stormNoon) === 0);
check("firefly: day=0", firefliesGate(noon) === 0);
check("firefly: night>0", firefliesGate(night) > 0);
// 2026-07-04: RELAXED default — fireflies show ANY night (night is the defining
// gate); ?foliageStrictSeason=1 restores summer-warm-only (winter night → 0).
check("firefly: relaxed winter-night > 0 (default)", firefliesGate(winterNight) > 0);
check("firefly: strict winter-night = 0", firefliesGate({ ...winterNight, strictFoliageSeason: true }) === 0);
check("firefly: strict day still = 0", firefliesGate({ ...noon, strictFoliageSeason: true }) === 0);
check("firefly: relaxed still ramps (summer night ≥ winter night)", firefliesGate(night) >= firefliesGate(winterNight));
check("leaves: autumn+gust > summer", leavesGate(autumnGust) > leavesGate(noon));
// 2026-07-04: RELAXED default — leaves shed year-round (autumn peak);
// ?foliageStrictSeason=1 restores autumn-only (winter → 0).
check("leaves: relaxed winter > 0 (default)", leavesGate(winterNight) > 0);
check("leaves: strict winter = 0", leavesGate({ ...winterNight, strictFoliageSeason: true }) === 0);
check("leaves: relaxed autumn still peaks (autumn ≥ winter)", leavesGate(autumnGust) >= leavesGate(winterNight));
check("breath: warm=0", breathFogGate(noon) === 0);
check("breath: cold>0", breathFogGate(winterNight) > 0);
// determinism: pure fns return identical for identical input
check("gate deterministic", firefliesGate(night) === firefliesGate({ ...night }));

// 2026-08-01 (terrain-VFX Wave 3A): `marshGasGate` joins this module. It is the
// ONE new gate the swamp family needed — its fireflies and midges deliberately
// reuse firefliesGate/pollenGate verbatim (plan §3.5 item 1: re-anchor, never a
// second system), so they get no gate of their own. Same shape checks the four
// above get: pure, total, deterministic, in [0,1], and routed in PARTICLE_GATES.
const marshCalm = { sunAlt: -0.4, nightFactor: 1, frost: 0, windStrength: 1.0 };
const marshGusty = { ...marshCalm, windStrength: 1.8 };
const marshFrozen = { ...marshCalm, frost: 1 };
check("marshGas: routed in PARTICLE_GATES", PARTICLE_GATES["terrain.marshGas"] === marshGasGate);
check("marshGas: total (null env ⇒ a finite baseline, no throw)", marshGasGate(null) === 1);
check("marshGas: deterministic", marshGasGate(marshCalm) === marshGasGate({ ...marshCalm }));
check("marshGas: calm night > 0", marshGasGate(marshCalm) > 0);
check("marshGas: a gust disperses it", marshGasGate(marshGusty) < marshGasGate(marshCalm));
check("marshGas: a hard freeze gates it OUT entirely", marshGasGate(marshFrozen) === 0);
check("marshGas: stays in [0,1] over a NaN-bearing sweep", (() => {
  for (const frost of [0, 0.5, 1, NaN]) {
    for (const wind of [0, 1, 1.6, 4, NaN]) {
      const v = marshGasGate({ frost, windStrength: wind, nightFactor: NaN, sunAlt: 0.3 });
      if (!(v >= 0 && v <= 1)) return false;
    }
  }
  return true;
})());

// ── 3. emit() — gate out / on / sprite wiring / persistence ───────────────────
const sprites = { softDot: 0x0A001001, spark: 0x0A001002, leaf: 0x0A001003, smoke: 0x0A001004 };
const anchor = { partIndex: 7, center: { x: 0, y: 3.2, z: 0 }, radius: 2.5 };
const ctx = (env) => ({ env, anchor, sprites, seed: 0xABCD1234, config: {} });

check("pollen emits by day", foliagePollen.emit(ctx(noon)).length === 1);
check("pollen [] at night", foliagePollen.emit(ctx(night)).length === 0);
check("firefly [] by day", foliageFireflies.emit(ctx(noon)).length === 0);
check("firefly emits at night", foliageFireflies.emit(ctx(night)).length === 1);
check("leaves emits autumn-gust", foliageLeaves.emit(ctx(autumnGust)).length === 1);
check("breath [] warm", breathFog.emit(ctx(noon)).length === 0);
check("breath emits winter-night", breathFog.emit(ctx(winterNight)).length === 1);

const e = foliageFireflies.emit(ctx(night))[0];
check("emitter persistent (totalSeconds=0, totalParticles=0)",
  e.emitterInfo.totalSeconds === 0 && e.emitterInfo.totalParticles === 0);
check("emitter names spark sprite", e.emitterInfo.hwGfxObjId === sprites.spark);
check("emitter particleType=Swarm(5)", e.emitterInfo.particleType === 5);
check("partIndex from anchor", e.partIndex === 7);
check("parentOffset at canopy centre", e.parentOffset.position.y === 3.2);
check("birthrate is a finite positive PERIOD", e.emitterInfo.birthrate > 0 && Number.isFinite(e.emitterInfo.birthrate));

// 2026-07-04 scale-floor: the classifier's visual_descriptors.jsonl bakes a
// broken startScale/finalScale=0.03 for foliage; the emit path must floor to the
// authored component scale so pollen isn't a ~1cm invisible mote. A LARGER
// descriptor scale still wins.
const brokenCfg = { env: noon, anchor, sprites, seed: 1, config: { startScale: 0.03, finalScale: 0.03 } };
const pf = foliagePollen.emit(brokenCfg)[0].emitterInfo;
check("scale-floor: broken 0.03 descriptor → authored pollen 0.5/0.32",
  pf.startScale === 0.5 && pf.finalScale === 0.32, `${pf.startScale}/${pf.finalScale}`);
const bigCfg = { env: noon, anchor, sprites, seed: 1, config: { startScale: 0.8, finalScale: 0.7 } };
const pb = foliagePollen.emit(bigCfg)[0].emitterInfo;
check("scale-floor: LARGER descriptor scale still wins (0.8/0.7)",
  pb.startScale === 0.8 && pb.finalScale === 0.7, `${pb.startScale}/${pb.finalScale}`);

// unresolved sprite → invisible-guard (no emitter). D6: components import a default
// sprite from particle_sprites.js, so the guard only fires when hwGfxObjId is forced 0.
check("no sprite (hwGfxObjId:0) → []", foliageFireflies.emit({ env: night, anchor, sprites: {}, seed: 1, config: { hwGfxObjId: 0 } }).length === 0);
// D6: default sprite present ⇒ emits even without ctx.sprites (renders at runtime, no ctx.sprites needed)
check("default sprite (no ctx.sprites) ⇒ emits", foliageFireflies.emit({ env: night, anchor, seed: 1, config: {} }).length === 1);

// determinism: same seed → identical, different seed → different period
const p1 = foliageFireflies.emit(ctx(night))[0].emitterInfo.birthrate;
const p2 = foliageFireflies.emit(ctx(night))[0].emitterInfo.birthrate;
const p3 = foliageFireflies.emit({ env: night, anchor, sprites, seed: 0x99, config: {} })[0].emitterInfo.birthrate;
check("same seed → same period", p1 === p2);
check("different seed → different period", p1 !== p3);

// dusk (g≈0.5) sparser than full night (g=1)
const dusk = { sunAlt: 0.0, season: 2, temperatureC: 18, stormness: 0, frost: 0, windStrength: 1.0 };
check("dusk period > night period (ramp)", foliageFireflies.emit(ctx(dusk))[0].emitterInfo.birthrate > p1);

console.log(`\n[test_vfx_foliage] ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
