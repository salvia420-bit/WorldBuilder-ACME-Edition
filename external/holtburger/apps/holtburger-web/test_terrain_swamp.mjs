// test_terrain_swamp.mjs — SWAMP / MARSH terrain VFX (Wave 3A,
// `scene3d/terrain_swamp.js` + `scene3d/vfx/components/terrainSwampAmbient.js`
// + the `marshGasGate` addition to `scene3d/vfx/particle_env_gates.js`).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.5 "Tests", plus the invariants
// §5.1-§5.9 every terrain-VFX module signs up to):
//   L1  THE RE-ANCHOR IS NOT A FORK. The terrain-anchored firefly emitter spec
//       is BYTE-IDENTICAL to the canopy path except for the anchor and the
//       enumerated tint/drift overrides — asserted as a set comparison against
//       the exported `SWAMP_FIREFLY_OVERRIDES`, so a smuggled-in extra
//       divergence fails the suite. Same for midges vs pollen. Neither
//       component may author an emitterInfo field the canopy one does not have.
//   L2  ONE FIREFLY GATE. The terrain component reuses `firefliesGate` BY
//       IDENTITY (not a copy), so night/season/`?foliageStrictSeason` behave
//       identically for canopy and marsh, and the shared gate is what turns the
//       ground emitters on at dusk.
//   L3  MARSH-GAS PLACEMENT IS HASH-STABLE per lbKey: two calls, and a call
//       with the landblock's grids re-created, produce byte-identical
//       placements; every slot stands on a FAM_SWAMP vertex (so never on water,
//       plan §3.8.1); and the three effects pick DIFFERENT vertices.
//   L4  PARK STOPS EMISSION AND DESTROYS NOTHING: `emitterCountForOwner(key)`
//       is unchanged across a park and `destroyAllForOwner` is not called.
//   L5  EVICT calls `destroyAllForOwner` EXACTLY ONCE, on the swamp-scoped
//       owner key `staticOwnerKeyForLb(lb) + ":swamp"` — never on the bare
//       `static:<lb>` key, which would reap the landblock's brazier/foliage
//       emitters on a mere terrain LOD rebake.
//   L6  SHIP-OFF: with no URL flags every swamp flag reads false,
//       `initTerrainSwamp` registers NOTHING and allocates NOTHING, and the
//       DEFAULT-ON effect count is unchanged.
//   L7  THE QUALITY LADDER MATCHES PLAN §3.5 (`low: null` · mid {fog:8,
//       gas:false, fireflies:true} · high {fog:16, gas:true} · ultra {fog:24,
//       gas:true, wisps:true}), and the swamp code set is DERIVED from
//       `terrain_families.js`, never hardcoded.
//   L8  CODE 23 STAYS WATER BY DEFAULT (plan §3.8.3) and joins the swamp family
//       ONLY under `?strictWaterCodes` — asserted in BOTH directions.
//   L9  THE DESCRIPTORS PASS THE VFX FIREWALL: the manifest lint (layer A) and
//       the source denylist (layer B — a per-component test responsibility,
//       plan §5.1), `lightCountDelta === 0` on every synthesised component,
//       `cacheKeyScope "none"`, `linkVariant() === ""`, and a gated-out env
//       synthesises NO emitter.
//   L10 NO LIGHT ANYWHERE (§5.2). The wisp glow is a FINITE additive-sprite
//       emitter, never a PointLight, and neither host module constructs a light.
//   L11 THE NEW GATE (`marshGasGate`) passes the same shape checks
//       `test_vfx_foliage.mjs` applies to the four foliage gates: pure, total,
//       deterministic, in [0,1], and registered in `PARTICLE_GATES`.
//
// Run from apps/holtburger-web/:  node test_terrain_swamp.mjs

import { readFileSync } from "node:fs";
import {
  FAM_SWAMP, FAM_WATER, FAM_GRASS, familyForCode,
  setTerrainWaterCodes, defaultTerrainWaterCodes,
  LEGACY_WATER_CODES, STRICT_WATER_CODES,
} from "./scene3d/terrain_families.js";
import { lintManifest, lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
// URL + quality harness. Every flag reader memoizes, so the window has to be in
// place BEFORE the first read and `_resetVfxFlags()` after every change.
// ---------------------------------------------------------------------------
const HIGH_FLAGS = {
  terrainSwamp: false,
  terrainGroundFogCount: 16,
  terrainGroundFogRadius: 56,
  terrainMarshGasCount: 2,
  terrainMarshWisps: false,
  terrainSwampFireflies: true,
  terrainSwampMidges: true,
};
function setUrl(search, qualityFlags = HIGH_FLAGS) {
  globalThis.window = {
    location: { search },
    liveScene3d: { quality: { flags: { ...qualityFlags } } },
  };
}
function clearUrl() { delete globalThis.window; }

setUrl("");
const flags = await import("./scene3d/vfx_flags.js");
const {
  _resetVfxFlags, vfxEffectEnabled, VFX_EFFECT_FLAGS,
  terrainSwampEnabled, terrainGroundFogEnabled, terrainMarshGasEnabled,
  terrainMarshWispsEnabled, terrainSwampFirefliesEnabled, terrainSwampMidgesEnabled,
  terrainGroundFogCount, terrainGroundFogRadiusM, terrainGroundFogSoftnessM,
  terrainMarshGasCount,
} = flags;

const gates = await import("./scene3d/vfx/particle_env_gates.js");
const { firefliesGate, pollenGate, marshGasGate, PARTICLE_GATES } = gates;

const amb = await import("./scene3d/vfx/components/terrainSwampAmbient.js");
const {
  terrainSwampFireflies, terrainSwampMidges, terrainMarshGas,
  SWAMP_FIREFLY_OVERRIDES, SWAMP_MIDGE_OVERRIDES, SWAMP_GATE_MIN, swampHash01,
} = amb;
const { foliageFireflies, foliagePollen } = await import("./scene3d/vfx/components/foliageAmbient.js");
const { allComponents, validateComponent } = await import("./scene3d/vfx/registry.js");

const swamp = await import("./scene3d/terrain_swamp.js");
const vfx = await import("./scene3d/terrain_vfx.js");
const { PRESETS } = await import("./scene3d/quality.js");

const AMB_SRC = readFileSync(new URL("./scene3d/vfx/components/terrainSwampAmbient.js", import.meta.url), "utf8");
const HOST_SRC = readFileSync(new URL("./scene3d/terrain_swamp.js", import.meta.url), "utf8");
/** Comment-stripped source — `lint_caps.js` layer B does exactly this before its
 *  denylist sweep, and for the same reason: a module header that DISCUSSES
 *  `Math.random` or names code 23 is not a code fact. */
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  .replace(/\/\/.*$/gm, "");
const HOST_CODE = strip(HOST_SRC);
const AMB_CODE = strip(AMB_SRC);

const NIGHT = { sunAlt: -0.4, nightFactor: 1, season: 2, temperatureC: 16, stormness: 0, frost: 0, wetness: 0, windStrength: 1.0 };
const NOON = { sunAlt: 0.92, nightFactor: 0, season: 2, temperatureC: 25, stormness: 0, frost: 0, wetness: 0, windStrength: 1.0 };
const FROZEN = { ...NIGHT, frost: 0.95, temperatureC: -6, season: 0 };
const GUSTY = { ...NIGHT, windStrength: 1.8 };
const CANOPY_ANCHOR = { partIndex: 7, center: { x: 0, y: 3.2, z: 0 }, radius: 2.5 };
const GROUND_ANCHOR = { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 2.5 };

// ---------------------------------------------------------------------------
console.log("\n== L1  the re-anchor is not a fork");
// ---------------------------------------------------------------------------
function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
{
  const seed = 0xABCD1234;
  const canopy = foliageFireflies.emit({ env: NIGHT, anchor: CANOPY_ANCHOR, seed, config: {} })[0];
  const marsh = terrainSwampFireflies.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed, config: {} })[0];
  // `centreLiftY` and `liftM` are host-side config, never emitterInfo fields —
  // the emitterInfo diff may only contain the tint + drift overrides.
  const allowed = new Set(["id", "hwGfxObjId", "aY", "minA", "maxA", "maxOffset"]);
  const d = diffKeys(canopy.emitterInfo, marsh.emitterInfo);
  check("firefly spec differs ONLY in the enumerated overrides (+ anchor-derived maxOffset)",
    d.every((k) => allowed.has(k)), d.join(","));
  check("every enumerated override actually took effect", (() => {
    const inf = marsh.emitterInfo;
    return inf.id === SWAMP_FIREFLY_OVERRIDES.synthId
      && inf.hwGfxObjId === SWAMP_FIREFLY_OVERRIDES.hwGfxObjId
      && inf.aY === SWAMP_FIREFLY_OVERRIDES.aY
      && inf.minA === SWAMP_FIREFLY_OVERRIDES.minA
      && inf.maxA === SWAMP_FIREFLY_OVERRIDES.maxA;
  })());
  check("the marsh tint is a DIFFERENT sprite (a colour is not an emitterInfo field)",
    marsh.emitterInfo.hwGfxObjId !== canopy.emitterInfo.hwGfxObjId);
  check("SAME birthrate for the same seed+gate — the strongest reuse proof",
    marsh.emitterInfo.birthrate === canopy.emitterInfo.birthrate);
  check("SAME Swarm hover terms (b/c untouched — retail firefly trajectory intact)",
    marsh.emitterInfo.bX === canopy.emitterInfo.bX
    && marsh.emitterInfo.bY === canopy.emitterInfo.bY
    && marsh.emitterInfo.cX === canopy.emitterInfo.cX
    && marsh.emitterInfo.particleType === canopy.emitterInfo.particleType);
  check("LOWER drift than the canopy (plan §3.5: 'lower-drifting')",
    marsh.emitterInfo.aY < canopy.emitterInfo.aY
    && marsh.emitterInfo.maxA < canopy.emitterInfo.maxA);
  check("the anchor is the OTHER difference: partIndex -1, AC +Z lift",
    marsh.partIndex === -1 && marsh.parentOffset.position.z === amb.SWAMP_ANCHOR_LIFT_M.fireflies
    && canopy.partIndex === 7);
  check("the lift is on AC +Z, NOT on the canopy path's +Y (trap T-B)",
    marsh.parentOffset.position.y === 0 && canopy.parentOffset.position.y === 3.2);
}
{
  const seed = 0x5150;
  const canopy = foliagePollen.emit({ env: NOON, anchor: CANOPY_ANCHOR, seed, config: {} })[0];
  const midge = terrainSwampMidges.emit({ env: NOON, anchor: GROUND_ANCHOR, seed, config: {} })[0];
  const allowed = new Set(["id", "hwGfxObjId", "aY", "minA", "maxA", "maxOffset"]);
  const d = diffKeys(canopy.emitterInfo, midge.emitterInfo);
  check("midge spec differs ONLY in the enumerated overrides", d.every((k) => allowed.has(k)), d.join(","));
  check("midge overrides took effect", midge.emitterInfo.hwGfxObjId === SWAMP_MIDGE_OVERRIDES.hwGfxObjId
    && midge.emitterInfo.id === SWAMP_MIDGE_OVERRIDES.synthId);
  check("tighter drift than pollen", midge.emitterInfo.maxA < canopy.emitterInfo.maxA);
  check("the 'tighter orbit' rides the ANCHOR RADIUS (trap T-C: the scale floor is not ours to move)",
    (() => {
      const tight = terrainSwampMidges.emit({
        env: NOON, anchor: { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 1.1 }, seed, config: {},
      })[0];
      return tight.emitterInfo.maxOffset < midge.emitterInfo.maxOffset
        && tight.emitterInfo.startScale === canopy.emitterInfo.startScale;
    })());
}
check("neither re-anchor constructs an emitterInfo of its own", (() => {
  // Only the marsh gas (a genuinely new phenomenon) may author one.
  const bodies = AMB_SRC.split("export const terrainMarshGas");
  return !/emitterType:/.test(bodies[0]) && /emitterType:/.test(bodies[1]);
})());
check("the re-anchor calls the canopy components' own emit()",
  /source\.emit\(/.test(AMB_SRC)
  && /reAnchor\(foliageFireflies, this, ctx\)/.test(AMB_SRC)
  && /reAnchor\(foliagePollen, this, ctx\)/.test(AMB_SRC));
check("ctx.sprites is deliberately NOT forwarded (trap T-A)",
  !/sprites:\s*ctx/.test(AMB_SRC) && /NO `sprites` bag/.test(AMB_SRC));

// ---------------------------------------------------------------------------
console.log("\n== L2  one firefly gate, shared BY IDENTITY");
// ---------------------------------------------------------------------------
check("terrain fireflies use firefliesGate by identity", terrainSwampFireflies.gateFn === firefliesGate);
check("terrain midges use pollenGate by identity", terrainSwampMidges.gateFn === pollenGate);
check("canopy fireflies still use the same fn (no divergence)", foliageFireflies.gateFn === firefliesGate);
check("day ⇒ no marsh firefly emitter at all (byte-free, not a hidden one)",
  terrainSwampFireflies.emit({ env: NOON, anchor: GROUND_ANCHOR, seed: 1, config: {} }).length === 0);
check("night ⇒ exactly one marsh firefly emitter",
  terrainSwampFireflies.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 1, config: {} }).length === 1);
check("?foliageStrictSeason still reaches the marsh path (winter night ⇒ none)",
  terrainSwampFireflies.emit({
    env: { ...NIGHT, season: 0, temperatureC: -4, strictFoliageSeason: true },
    anchor: GROUND_ANCHOR, seed: 1, config: {},
  }).length === 0);
check("midges are a DAY effect (pollenGate): none at night, one at noon",
  terrainSwampMidges.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 1, config: {} }).length === 0
  && terrainSwampMidges.emit({ env: NOON, anchor: GROUND_ANCHOR, seed: 1, config: {} }).length === 1);

// ---------------------------------------------------------------------------
console.log("\n== L3  hash-stable placement on FAM_SWAMP vertices only");
// ---------------------------------------------------------------------------
function makeGrids() {
  // A landblock that is half marsh (code 4), a quarter water (code 18) and a
  // quarter grass (code 1) — so a naive placement would land on water.
  const codes = new Uint8Array(81);
  const heights = new Float32Array(81);
  for (let vx = 0; vx < 9; vx += 1) {
    for (let vy = 0; vy < 9; vy += 1) {
      const i = vx * 9 + vy;
      codes[i] = vx < 5 ? 4 : (vy < 5 ? 18 : 1);
      heights[i] = 3 + vx * 0.25 + vy * 0.1;
    }
  }
  return { codes, heights };
}
{
  const g1 = makeGrids();
  const g2 = makeGrids();
  const base = { lbKey: 0xAB120000, lbX: 0xAB, lbY: 0x12, count: 3, seed: 0x53574d70 };
  const a = swamp.swampSlotsForLandblock({ ...base, ...g1, channel: swamp.EFFECT_GAS });
  const b = swamp.swampSlotsForLandblock({ ...base, ...g1, channel: swamp.EFFECT_GAS });
  const c = swamp.swampSlotsForLandblock({ ...base, ...g2, channel: swamp.EFFECT_GAS });
  check("three vents requested, three placed", a.length === 3);
  check("two calls ⇒ byte-identical placements", JSON.stringify(a) === JSON.stringify(b));
  check("re-created grids ⇒ byte-identical placements (§5.5)", JSON.stringify(a) === JSON.stringify(c));
  check("every vent stands on a FAM_SWAMP vertex", a.every((s) => familyForCode(s.code) === FAM_SWAMP));
  check("no vent on a WATER vertex (plan §3.8.1)", a.every((s) => familyForCode(s.code) !== FAM_WATER));
  check("every vent is inside its landblock", a.every((s) => {
    const lx = s.x - 0xAB * 192, ly = s.y - 0x12 * 192;
    return lx >= 0 && lx <= 192 && ly >= 0 && ly <= 192;
  }));
  check("vents take DISTINCT vertices", new Set(a.map((s) => `${s.vx},${s.vy}`)).size === 3);
  const ff = swamp.swampSlotsForLandblock({ ...base, ...g1, count: 1, channel: swamp.EFFECT_FIREFLIES });
  const mg = swamp.swampSlotsForLandblock({ ...base, ...g1, count: 1, channel: swamp.EFFECT_MIDGES });
  check("the three effects do NOT stack on one vertex (the channel salt works)",
    `${ff[0].vx},${ff[0].vy}` !== `${mg[0].vx},${mg[0].vy}`);
  check("a landblock with NO swamp vertex places nothing", (() => {
    const dry = new Uint8Array(81).fill(1);   // all grassland
    return swamp.swampSlotsForLandblock({ ...base, codes: dry, heights: g1.heights, channel: 0 }).length === 0;
  })());
  check("count 0 ⇒ no slots and no work", swamp.swampSlotsForLandblock({ ...base, ...g1, count: 0 }).length === 0);
  check("slot z comes from the LB height grid", a.every((s) => s.z === g1.heights[s.vx * 9 + s.vy]));
}

// ---------------------------------------------------------------------------
console.log("\n== L4/L5  park stops, evict destroys — on the :swamp-scoped key");
// ---------------------------------------------------------------------------
const { staticOwnerKeyForLb } = await import("./scene3d/vfx/particle_attach.js");
check("owner key is the canonical static key + ':swamp'",
  swamp.swampOwnerKeyForLb(0xAB120000) === `${staticOwnerKeyForLb(0xAB120000)}:swamp`);
check("owner key is NOT the bare static key (the rebake trap)",
  swamp.swampOwnerKeyForLb(0xAB120000) !== staticOwnerKeyForLb(0xAB120000));
check("handles are distinct per effect and never 0", (() => {
  const seen = new Set();
  for (let e = 0; e <= swamp.EFFECT_WISP; e += 1) {
    for (let s = 0; s < 8; s += 1) {
      const h = swamp.swampEmitterHandle(e, s);
      if (h === 0 || seen.has(h)) return false;
      seen.add(h);
    }
  }
  return seen.size === 32;
})());

/** A recording stand-in for the shared owner registry. */
function makeRegistry() {
  const calls = { add: [], stop: [], destroy: [], destroyAll: [] };
  const live = new Map();   // ownerKey -> Set(handle)
  return {
    calls,
    async addEmitter(ownerKey, manager, req) {
      calls.add.push({ ownerKey, id: req.emitterId, info: req.emitterInfo, parent: req.parent });
      if (!live.has(ownerKey)) live.set(ownerKey, new Set());
      live.get(ownerKey).add(req.emitterId >>> 0);
      return req.emitterId >>> 0;
    },
    stopEmitter(ownerKey, handle) { calls.stop.push({ ownerKey, handle }); return true; },
    destroyEmitter(ownerKey, handle) {
      calls.destroy.push({ ownerKey, handle });
      live.get(ownerKey)?.delete(handle >>> 0);
      return true;
    },
    destroyAllForOwner(ownerKey) { calls.destroyAll.push(ownerKey); live.delete(ownerKey); return true; },
    emitterCountForOwner(ownerKey) { return live.get(ownerKey)?.size || 0; },
  };
}
const FAKE_MANAGER = { addEmitter() { return 1; } };
const FAKE_ORACLE = { heightAt: (x, y) => 3 + ((x + y) % 7) * 0.01 };

async function drain() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

{
  setUrl("?terrainSwamp=on&terrainMarshGas=on&terrainSwampFireflies=on&terrainGroundFog=off&terrainSwampMidges=off");
  _resetVfxFlags();
  vfx._resetTerrainVfx();
  swamp._resetTerrainSwamp();
  const reg = makeRegistry();
  const surface = swamp.initTerrainSwamp({
    THREE: null,
    scene3d: { frameTime: { tsSec: 0 } },
    readEnv: () => NIGHT,
    getParticleManager: () => FAKE_MANAGER,
    ownerRegistry: reg,
    getOracle: () => FAKE_ORACLE,
  });
  check("flagged on ⇒ initTerrainSwamp returns a surface", !!surface);

  const g = makeGrids();
  const lbKey = 0xAB120000;
  const mesh = {
    userData: { lbX: 0xAB, lbY: 0x12, terrainCodes: g.codes, heights: g.heights },
  };
  vfx.initTerrainVfx({ THREE: null, scene3d: { frameTime: { tsSec: 0 }, terrainGroup: { children: [] } } });
  vfx.terrainVfxNoteLandblockMesh({ terrainGroup: { children: [] } }, mesh);
  await drain();

  const ownerKey = swamp.swampOwnerKeyForLb(lbKey);
  const created = reg.calls.add.filter((c) => c.ownerKey === ownerKey);
  check("landblock-ready created emitters on the :swamp key", created.length > 0, `${created.length}`);
  // The tier drives the count: HIGH_FLAGS is gas 2 + fireflies 1 (midges and
  // fog are flagged off in this URL), and it is NIGHT, so all three gate in.
  check("the TIER count reached the placement (2 vents + 1 firefly anchor)",
    created.length === 3, `${created.length}`);
  check("gas and firefly handles come from DIFFERENT effect ranges", (() => {
    const gasH = new Set([0, 1].map((s) => swamp.swampEmitterHandle(swamp.EFFECT_GAS, s)));
    const ffH = swamp.swampEmitterHandle(swamp.EFFECT_FIREFLIES, 0);
    const ids = created.map((c) => c.id);
    return ids.filter((i) => gasH.has(i)).length === 2 && ids.includes(ffH);
  })());
  check("no emitter carries a light of any kind (§5.2)",
    created.every((c) => !("lightId" in c.info) && !("light" in c.info)));
  check("stats mirror the __terrainSand shape (enabled/inited/counters/owners)", (() => {
    const st = surface.stats();
    return st.enabled === true && st.inited === true && st.landblocks === 1
      && Array.isArray(st.owners) && st.owners[0].ownerKey === ownerKey
      && typeof st.counters.emittersCreated === "number"
      && Array.isArray(st.swampCodes) && typeof st.swampCodeMask === "number";
  })());
  check("emitters were parented at AC world coordinates inside the landblock",
    created.every((c) => c.parent.position.x >= 0xAB * 192 && c.parent.position.x <= 0xAB * 192 + 192));
  const before = reg.emitterCountForOwner(ownerKey);

  // PARK
  vfx.terrainVfxLandblockPark(lbKey);
  await drain();
  check("L4 park called stopEmitter", reg.calls.stop.length > 0);
  check("L4 park destroyed NOTHING (emitterCountForOwner unchanged)",
    reg.emitterCountForOwner(ownerKey) === before && reg.calls.destroyAll.length === 0);
  check("L4 park never called destroyEmitter", reg.calls.destroy.length === 0);
  check("L4 stats report the park", surface.stats().counters.parks > 0);

  // UNPARK — hash-stable, so the same handles come back
  const addsBeforeUnpark = reg.calls.add.length;
  vfx.terrainVfxLandblockUnpark(lbKey);
  await drain();
  const readded = reg.calls.add.slice(addsBeforeUnpark);
  check("unpark re-armed the SAME handles (not a re-scatter)",
    readded.length > 0 && readded.every((c) => created.some((o) => o.id === c.id)));

  // EVICT
  vfx.terrainVfxLandblockGone(lbKey, "evict");
  await drain();
  check("L5 evict called destroyAllForOwner exactly once", reg.calls.destroyAll.length === 1);
  check("L5 it was called on the :swamp key, never the bare static key",
    reg.calls.destroyAll[0] === ownerKey
    && reg.calls.destroyAll[0] !== staticOwnerKeyForLb(lbKey));
  check("L5 the landblock record is gone", surface.stats().landblocks === 0);

  swamp._resetTerrainSwamp();
  vfx._resetTerrainVfx();
  clearUrl();
  _resetVfxFlags();
}

// ---------------------------------------------------------------------------
console.log("\n== the wisp: finite, additive, no light, on a long timer");
// ---------------------------------------------------------------------------
{
  const bubbles = terrainMarshGas.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 9, config: {} })[0];
  const wisp = terrainMarshGas.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 9, config: { mode: "wisp" } })[0];
  check("bubbles are PERSISTENT (totalSeconds 0, totalParticles 0)",
    bubbles.emitterInfo.totalSeconds === 0 && bubbles.emitterInfo.totalParticles === 0);
  check("the wisp is FINITE at ~2 s (it self-expires in particle_emitter.js)",
    wisp.emitterInfo.totalSeconds === 2.0);
  check("the wisp uses a DIFFERENT (additive) sprite from the bubbles",
    wisp.emitterInfo.hwGfxObjId !== bubbles.emitterInfo.hwGfxObjId);
  check("gas rises straight up (no lateral a-term, no Swarm orbit)",
    bubbles.emitterInfo.aX === 0 && bubbles.emitterInfo.aY === 0 && bubbles.emitterInfo.aZ > 0
    && bubbles.emitterInfo.bX === 0 && bubbles.emitterInfo.cX === 0);
  check("gas sits AT the surface (a small AC +Z lift, trap T-B)",
    bubbles.parentOffset.position.z === amb.SWAMP_ANCHOR_LIFT_M.gas
    && bubbles.parentOffset.position.y === 0);
  check("the wisp reads much further than the bubbles (additive night flare)",
    wisp.emitterInfo.degradeDistanceMeters > bubbles.emitterInfo.degradeDistanceMeters);
  check("wisp period is RARE (plan §3.5: 'a long timer')", swamp.SWAMP_TUNING.wispPeriodSec >= 60);
  check("the same seed gives the same spec (§5.5)",
    JSON.stringify(terrainMarshGas.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 9, config: {} })[0])
    === JSON.stringify(bubbles));
}

// ---------------------------------------------------------------------------
console.log("\n== L6  ship-OFF");
// ---------------------------------------------------------------------------
{
  setUrl("");
  _resetVfxFlags();
  check("no URL flags ⇒ terrainSwamp false", terrainSwampEnabled() === false);
  // The SUB-flags deliberately fall back to their tier value when absent (so
  // ONE `?terrainSwamp=on` lights the tier's intended set) — it is the FAMILY
  // MASTER that ships off, and the composed router row is what an effect asks.
  check("no URL flags ⇒ composed groundFog false", vfxEffectEnabled("terrain.groundFog") === false);
  check("no URL flags ⇒ composed marshGas false", vfxEffectEnabled("terrain.marshGas") === false);
  check("no URL flags ⇒ wisps false", terrainMarshWispsEnabled() === false);
  check("no URL flags ⇒ fireflies false (the family master is what gates it)",
    vfxEffectEnabled("terrain.swampFireflies") === false);
  check("no URL flags ⇒ midges false", vfxEffectEnabled("terrain.swampMidges") === false);
  swamp._resetTerrainSwamp();
  const s = swamp.initTerrainSwamp({ THREE: null, scene3d: {}, ownerRegistry: makeRegistry() });
  check("master off ⇒ initTerrainSwamp registers NOTHING and returns null", s === null);
  check("master off ⇒ no landblocks, no fog, not inited", (() => {
    const st = swamp.terrainSwampStats();
    return st.inited === false && st.landblocks === 0 && st.fog === null;
  })());
  // EXACT-match discipline: a near-miss must NOT enable.
  for (const bad of ["1", "true", "yes", "ON", ""]) {
    setUrl(`?terrainSwamp=${bad}`);
    _resetVfxFlags();
    check(`?terrainSwamp=${JSON.stringify(bad)} does NOT enable (strict === "on")`,
      terrainSwampEnabled() === false);
  }
  setUrl("?terrainSwamp=on");
  _resetVfxFlags();
  check('?terrainSwamp=on DOES enable', terrainSwampEnabled() === true);
  check("sub-effects fall back to the tier when absent (one URL lights the tier's set)",
    terrainGroundFogEnabled() === true && terrainMarshGasEnabled() === true
    && terrainSwampFirefliesEnabled() === true);
  setUrl("?terrainSwamp=on&terrainGroundFog=off");
  _resetVfxFlags();
  check("a sub-effect =off still wins over the tier", terrainGroundFogEnabled() === false);
  clearUrl();
  _resetVfxFlags();
}
{
  // The DEFAULT-ON count must not move: none of the swamp rows tracks
  // visualAllEffects(), so `?visual=all` may not light them.
  setUrl("?visual=all");
  _resetVfxFlags();
  const lit = Object.keys(VFX_EFFECT_FLAGS).filter((id) => VFX_EFFECT_FLAGS[id]());
  check("?visual=all lights exactly 14 effects — no swamp row among them",
    lit.length === 14 && !lit.some((id) => id.startsWith("terrain.")), `${lit.length}: ${lit.join(",")}`);
  clearUrl();
  _resetVfxFlags();
}
check("every swamp row is present in the flag router", (() => {
  const need = ["terrain.swamp", "terrain.groundFog", "terrain.marshGas",
    "terrain.swampFireflies", "terrain.swampMidges"];
  return need.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function");
})());
check("the three descriptor ids are ALSO router rows (so vfxEffectEnabled resolves)",
  [terrainMarshGas.id, terrainSwampFireflies.id, terrainSwampMidges.id]
    .every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));

// ---------------------------------------------------------------------------
console.log("\n== L7  the quality ladder matches plan §3.5");
// ---------------------------------------------------------------------------
{
  const want = {
    low: { terrainGroundFogCount: 0, terrainMarshGasCount: 0, terrainMarshWisps: false, terrainSwampFireflies: false, terrainSwampMidges: false },
    mid: { terrainGroundFogCount: 8, terrainMarshGasCount: 0, terrainMarshWisps: false, terrainSwampFireflies: true, terrainSwampMidges: true },
    high: { terrainGroundFogCount: 16, terrainMarshGasCount: 2, terrainMarshWisps: false, terrainSwampFireflies: true, terrainSwampMidges: true },
    ultra: { terrainGroundFogCount: 24, terrainMarshGasCount: 3, terrainMarshWisps: true, terrainSwampFireflies: true, terrainSwampMidges: true },
  };
  for (const tier of ["low", "mid", "high", "ultra"]) {
    const p = PRESETS[tier];
    check(`${tier}: terrainSwamp ships false (§5.9)`, p.terrainSwamp === false);
    for (const [k, v] of Object.entries(want[tier])) {
      check(`${tier}: ${k} === ${v}`, p[k] === v, `${p[k]}`);
    }
    check(`${tier}: terrainGroundFogRadius is set`, Number.isFinite(p.terrainGroundFogRadius));
    check(`${tier}: NO terrainGroundFogSoftness preset key (URL-only by design)`,
      !("terrainGroundFogSoftness" in p));
  }
  check("low ⇒ resolveSwampQuality is null (plan §5.8: low is null, no exceptions)",
    swamp.resolveSwampQuality(PRESETS.low) === null);
  check("mid ⇒ fog 8, NO gas, fireflies on", (() => {
    const q = swamp.resolveSwampQuality(PRESETS.mid);
    return q && q.fogCount === 8 && q.gasCount === 0 && q.fireflies === true && q.wisps === false;
  })());
  check("high ⇒ fog 16, gas 2, still no wisps", (() => {
    const q = swamp.resolveSwampQuality(PRESETS.high);
    return q && q.fogCount === 16 && q.gasCount === 2 && q.wisps === false;
  })());
  check("ultra ⇒ fog 24, gas 3, wisps", (() => {
    const q = swamp.resolveSwampQuality(PRESETS.ultra);
    return q && q.fogCount === 24 && q.gasCount === 3 && q.wisps === true;
  })());
  check("wisps cannot outlive the gas they ignite (wisps ⇒ gasCount > 0)",
    swamp.resolveSwampQuality({ ...PRESETS.ultra, terrainMarshGasCount: 0 }).wisps === false);
  check("softness defaults to 0 at every tier (the depth read is URL-armed only)",
    ["low", "mid", "high", "ultra"].every((t) => swamp.resolveSwampQuality(PRESETS[t])?.fogSoftnessM === undefined
      || swamp.resolveSwampQuality(PRESETS[t]).fogSoftnessM === 0));
}
{
  setUrl("", PRESETS.high);
  _resetVfxFlags();
  check("numeric readers fall through to the preset", terrainGroundFogCount() === 16
    && terrainGroundFogRadiusM() === 56 && terrainMarshGasCount() === 2);
  check("softness has NO preset path — it is 0 unless the URL says otherwise",
    terrainGroundFogSoftnessM() === 0);
  setUrl("?terrainGroundFogSoftness=2.5", PRESETS.high);
  _resetVfxFlags();
  check("?terrainGroundFogSoftness arms the depth read", terrainGroundFogSoftnessM() === 2.5);
  setUrl("?terrainGroundFogCount=40", PRESETS.high);
  _resetVfxFlags();
  check("a URL numeric beats the preset", terrainGroundFogCount() === 40);
  check("a numeric alone CANNOT turn the family on", terrainSwampEnabled() === false);
  clearUrl();
  _resetVfxFlags();
}
check("the swamp code set is DERIVED from the family LUT, never listed", (() => {
  const derived = [];
  for (let c = 0; c < 32; c += 1) if (familyForCode(c) === FAM_SWAMP) derived.push(c);
  return JSON.stringify(swamp.swampTerrainCodes()) === JSON.stringify(derived);
})());
check("the host CODE never hardcodes code 4 / code 23 as a literal family member",
  !/===\s*4\b|===\s*23\b|\[\s*4\s*,\s*23\s*\]/.test(HOST_CODE));

// ---------------------------------------------------------------------------
console.log("\n== L8  code 23 (SeaSlime) is WATER by default (plan §3.8.3)");
// ---------------------------------------------------------------------------
{
  check("shipped default: 23 is FAM_WATER, NOT swamp", familyForCode(23) === FAM_WATER);
  check("shipped default: swampTerrainCodes() === [4]",
    JSON.stringify(swamp.swampTerrainCodes()) === "[4]");
  check("shipped default: swampIncludesSeaSlime() false", swamp.swampIncludesSeaSlime() === false);
  check("shipped default: the code mask is 1<<4", swamp.swampCodeBitmask() === (1 << 4));
  check("LEGACY_WATER_CODES contains 23 (that is why it is water today)",
    LEGACY_WATER_CODES.includes(23));
  // Flip to the strict set — the same thing `?strictWaterCodes` does — and 23
  // must FALL THROUGH to swamp, picking up every effect in this file.
  setTerrainWaterCodes(STRICT_WATER_CODES);
  check("?strictWaterCodes: 23 becomes FAM_SWAMP", familyForCode(23) === FAM_SWAMP);
  check("?strictWaterCodes: swampTerrainCodes() === [4, 23]",
    JSON.stringify(swamp.swampTerrainCodes()) === "[4,23]");
  check("?strictWaterCodes: swampIncludesSeaSlime() true", swamp.swampIncludesSeaSlime() === true);
  check("?strictWaterCodes: slots may now land on a code-23 vertex", (() => {
    const codes = new Uint8Array(81).fill(23);
    const heights = new Float32Array(81).fill(2);
    const got = swamp.swampSlotsForLandblock({
      lbKey: 0x11220000, lbX: 0x11, lbY: 0x22, codes, heights, count: 2, channel: 0,
    });
    return got.length === 2 && got.every((s) => s.code === 23);
  })());
  setTerrainWaterCodes(defaultTerrainWaterCodes());
  check("restored: 23 is water again", familyForCode(23) === FAM_WATER);
  check("code 22 (FauxWaterRunning) never becomes swamp either way",
    familyForCode(22) !== FAM_SWAMP);
  // Under the default set, a wholly code-23 landblock places NOTHING here — the
  // water agent owns it.
  check("shipped default: a code-23 landblock places no swamp slots", (() => {
    const codes = new Uint8Array(81).fill(23);
    return swamp.swampSlotsForLandblock({
      lbKey: 0x11220000, lbX: 0x11, lbY: 0x22, codes, count: 2, channel: 0,
    }).length === 0;
  })());
}

// ---------------------------------------------------------------------------
console.log("\n== L9  the descriptors pass the VFX firewall");
// ---------------------------------------------------------------------------
const THREE_IDS = ["terrain.swampFireflies", "terrain.swampMidges", "terrain.marshGas"];
{
  const liveIds = allComponents().map((c) => c.id);
  for (const id of THREE_IDS) check(`registered: ${id}`, liveIds.includes(id));
  for (const c of [terrainSwampFireflies, terrainSwampMidges, terrainMarshGas]) {
    check(`${c.id} manifest valid (layer A)`, validateComponent(c).length === 0, JSON.stringify(validateComponent(c)));
    check(`${c.id} lintManifest clean`, lintManifest(c).length === 0, JSON.stringify(lintManifest(c)));
    check(`${c.id} mech/family/channel`, c.mech === "particle" && c.family === "particle" && c.channel === "emitter");
    check(`${c.id} linkVariant() === ""`, c.linkVariant() === "");
    check(`${c.id} cacheKeyScope === "none" (§5.4)`, c.cacheKeyScope === "none");
    check(`${c.id} writes === ["emitter"]`, JSON.stringify(c.writes) === '["emitter"]');
    check(`${c.id} lightCountDelta === 0 (§5.2)`, c.lightCountDelta === 0);
    check(`${c.id} deterministic`, c.deterministic === true);
    check(`${c.id} emit() is a function`, typeof c.emit === "function");
  }
  const srcIssues = lintSource(AMB_SRC);
  check("layer B: the descriptor source passes the denylist", srcIssues.length === 0, JSON.stringify(srcIssues));
}

// ---------------------------------------------------------------------------
console.log("\n== L10  no light anywhere, no Math.random, no .visible=");
// ---------------------------------------------------------------------------
for (const [name, code] of [["terrain_swamp.js", HOST_CODE], ["terrainSwampAmbient.js", AMB_CODE]]) {
  check(`${name}: constructs no Light (§5.2)`, !/Light\b/.test(code));
  check(`${name}: no Math.random (§5.5)`, !/Math\.random/.test(code));
  check(`${name}: no argless Date.now`, !/Date\.now\(\)/.test(code));
  check(`${name}: no customProgramCacheKey (§5.4)`, !/customProgramCacheKey/.test(code));
  check(`${name}: no .visible= (§5.3 — park stops emission instead)`, !/\.visible\s*=/.test(code));
  check(`${name}: no direct THREE import`, !/from "three"/.test(code));
}
check("the host never touches the terrain fragment shader", !/terrain\.js/.test(HOST_CODE));

// ---------------------------------------------------------------------------
console.log("\n== L11  the new gate passes the foliage-gate shape checks");
// ---------------------------------------------------------------------------
check("marshGasGate is registered in PARTICLE_GATES", PARTICLE_GATES["terrain.marshGas"] === marshGasGate);
check("★ marshGasGate is total: null/undefined env ⇒ 0 (wiring fault, gated out), never a throw",
  marshGasGate(null) === 0 && marshGasGate(undefined) === 0);
check("marshGasGate is deterministic", marshGasGate(NIGHT) === marshGasGate({ ...NIGHT }));
check("marshGasGate stays in [0,1] over a wide env sweep", (() => {
  for (const frost of [0, 0.5, 1, NaN]) {
    for (const wind of [0, 1, 1.6, 4, NaN]) {
      for (const nf of [0, 0.5, 1, NaN]) {
        const v = marshGasGate({ frost, windStrength: wind, nightFactor: nf, sunAlt: 0.3 });
        if (!(v >= 0 && v <= 1)) return false;
      }
    }
  }
  return true;
})());
check("a FROZEN marsh barely vents", marshGasGate(FROZEN) < 0.25);
check("a GUSTY marsh vents less than a calm one", marshGasGate(GUSTY) < marshGasGate(NIGHT));
check("night reads slightly stronger than noon", marshGasGate(NIGHT) > marshGasGate(NOON));
check("a HARD FREEZE gates the gas out entirely (0, not merely dim)",
  marshGasGate({ frost: 1, windStrength: 1, nightFactor: 1 }) === 0);
check("a gated-out gas env synthesises NO emitter (byte-free, plan §2.3)",
  terrainMarshGas.emit({ env: { frost: 1, windStrength: 3, nightFactor: 0 }, anchor: GROUND_ANCHOR, seed: 1, config: {} }).length === 0);
check("the gate scales the vent PERIOD (a stronger gate vents faster)", (() => {
  const calm = terrainMarshGas.emit({ env: NIGHT, anchor: GROUND_ANCHOR, seed: 3, config: {} })[0];
  const gusty = terrainMarshGas.emit({ env: GUSTY, anchor: GROUND_ANCHOR, seed: 3, config: {} })[0];
  return gusty.emitterInfo.birthrate > calm.emitterInfo.birthrate;
})());
check("swampHash01 is the shared deterministic hash, in [0,1)", (() => {
  for (const n of [0, 1, -7, 0x7fffffff, 12345]) {
    const v = swampHash01(n);
    if (!(v >= 0 && v < 1) || v !== swampHash01(n)) return false;
  }
  return true;
})());
check("SWAMP_GATE_MIN is re-exported by the host (one threshold, one place)",
  swamp.SWAMP_GATE_MIN === SWAMP_GATE_MIN);

// ---------------------------------------------------------------------------
console.log("\n== the shared ground fog is composed, not forked");
// ---------------------------------------------------------------------------
check("the host imports the SHARED scene3d/ground_fog.js",
  /from "\.\/ground_fog\.js"/.test(HOST_SRC));
check("the host supplies only the palette + family gate + tier numbers",
  /SWAMP_FOG_PALETTE/.test(HOST_SRC) && /families: \[FAM_SWAMP\]/.test(HOST_SRC));
check("the fog palette honours the plan's 0.2..1.5 m lift band",
  swamp.SWAMP_FOG_PALETTE.liftMinM === 0.2 && swamp.SWAMP_FOG_PALETTE.liftMaxM === 1.5);
check("the fog provider is CAMERA-scoped (immune to evict/park/rebake)",
  /id: FOG_PROVIDER_ID[\s\S]{0,200}scope: "camera"/.test(HOST_SRC));
check("the three emitter providers are LANDBLOCK-scoped",
  /_emitterProvider\(effect, cfg\)[\s\S]{0,300}scope: "landblock"/.test(HOST_SRC));
check("the flag is the SHARED name terrainGroundFog, not terrainSwampFog",
  typeof flags.terrainGroundFogEnabled === "function" && flags.terrainSwampFogEnabled === undefined);
{
  // The camera-scoped fog provider, end to end with no THREE (the
  // ?nullRender=1 path): it builds ONCE, at the tier's count, and it is immune
  // to evict/park by construction (it gets no landblock callbacks at all).
  setUrl("?terrainSwamp=on&terrainGroundFog=on&terrainMarshGas=off&terrainSwampFireflies=off&terrainSwampMidges=off");
  _resetVfxFlags();
  vfx._resetTerrainVfx();
  swamp._resetTerrainSwamp();
  // The spine derives playerPos/camera/quality from the scene3d FACADE it is
  // ticked with — it does not take a caller-built frameCtx (`terrainVfxTick(dt,
  // scene3d)`), so drive it exactly as `loop.js` does.
  const fakeScene = {
    frameTime: { tsSec: 0 },
    terrainGroup: { children: [] },
    camera: { far: 8000 },
    cameraSwitcher: { _safePlayerPos: () => ({ x: 1000, y: 2000, z: 4 }) },
    quality: { flags: { ...HIGH_FLAGS } },
  };
  const surface = swamp.initTerrainSwamp({
    THREE: null,
    scene3d: fakeScene,
    readEnv: () => NIGHT,
    ownerRegistry: makeRegistry(),
    getOracle: () => ({
      heightAt: () => 4,
      sample: (x, y, out) => {
        const o = out || {};
        o.height = 4; o.hasHeight = true; o.code = 4; o.family = FAM_SWAMP;
        o.normal = { x: 0, y: 0, z: 1 }; o.cornerCodes = null;
        return o;
      },
    }),
  });
  check("fog-only flags ⇒ a surface with no landblock providers", !!surface);
  check("no fog before the first frame", surface.stats().fog === null);
  vfx.initTerrainVfx({ THREE: null, scene3d: fakeScene });
  vfx.terrainVfxTick(0.016, fakeScene);
  const st = surface.stats();
  check("one frame ⇒ the ring is built at the tier count (16 ⇒ 16, a square)",
    st.fog !== null && st.fog.count === 16 && st.counters.fogBuilds === 1, JSON.stringify(st.fog && st.fog.count));
  check("the ring grounded cards through the oracle", st.fog.pool.live > 0, `${st.fog.pool.live}`);
  check("the depth read is INERT until armed", st.fog.depthWired === false
    && st.fog.depthThreshold === 0 && st.fog.softnessM === 0);
  vfx.terrainVfxTick(0.016, fakeScene);
  check("a second frame does NOT rebuild the ring", surface.stats().counters.fogBuilds === 1);
  check("the 1070 seam arms the depth texture by hand",
    surface.setFogSceneDepthTexture({}) === true
    && surface.stats().fog.depthWired === true);
  swamp._resetTerrainSwamp();
  vfx._resetTerrainVfx();
  clearUrl();
  _resetVfxFlags();
}

console.log(`\n[test_terrain_swamp] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
