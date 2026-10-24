// test_terrain_desert_haze.mjs — the DESERT arm of the heat shimmer + mirage
// (2026-10-23; scene3d/terrain_desert_haze.js + the ground / mirage terms of
// scene3d/vfx/heat_haze_effect.js).
//
//   D1. pure helpers: sand fraction, tent-weighted desert weight, env heat
//   D2. REAL DAT: the Tufa desert reads as desert, Holtburg does not
//   D3. the state write: low-pass, quality / player gates, ownership of the
//       ground fields vs the volcano disc fields
//   D4. gating: heatHazeEnabled (tier, ?terrainHaze, ?visual, ?terrainVfx) and
//       the provider registration
//   D5. the Effect: ground + mirage uniforms, live knobs, GLSL text
//
// Targeted single test: `node test_terrain_desert_haze.mjs`.
import { existsSync, openSync, readSync, closeSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, ok, info = "") {
  if (ok) { passed += 1; console.log(`  [OK] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name} ${info}`); }
}

const HIGH_FLAGS = { terrainHaze: true, terrainHazeStrength: 1, terrainVolcano: false, terrainVolcanoRadius: 160, terrainVolcanoEmberCount: 1, terrainCrackGlow: true };
function setUrl(search, qualityFlags = HIGH_FLAGS) {
  globalThis.window = { location: { search }, liveScene3d: { quality: { flags: { ...qualityFlags } } } };
}
setUrl("");

const { _resetVfxFlags, heatHazeEnabled } = await import("./scene3d/vfx_flags.js");
const { _resetVfxCatalog } = await import("./scene3d/vfx_catalog.js");
const desert = await import("./scene3d/terrain_desert_haze.js");
const volc = await import("./scene3d/terrain_volcano.js");
const vfx = await import("./scene3d/terrain_vfx.js");
const haze = await import("./scene3d/vfx/heat_haze_effect.js");
const { FAM_SAND, familyForCode } = await import("./scene3d/terrain_families.js");
const reset = () => { _resetVfxCatalog(); _resetVfxFlags(); };

const T = desert.MIRAGE_TUNING;
const SAND_CODE = [...Array(32).keys()].find((c) => familyForCode(c) === FAM_SAND);
const GRASS_CODE = 1;
const lbKey = (x, y) => (((x << 24) | (y << 16)) >>> 0);

// ---------------------------------------------------------------------------
console.log("\n-- D1. pure helpers --");
{
  check("a sand terrain code exists (FAM_SAND)", Number.isInteger(SAND_CODE), String(SAND_CODE));
  check("sandFractionOfCodes: all sand = 1, none = 0, 27/81 = 1/3, bad input = 0",
    desert.sandFractionOfCodes(new Uint8Array(81).fill(SAND_CODE)) === 1
    && desert.sandFractionOfCodes(new Uint8Array(81).fill(GRASS_CODE)) === 0
    && Math.abs(desert.sandFractionOfCodes(Uint8Array.from({ length: 81 }, (_, i) => (i < 27 ? SAND_CODE : GRASS_CODE))) - 1 / 3) < 1e-12
    && desert.sandFractionOfCodes(null) === 0 && desert.sandFractionOfCodes(new Uint8Array(10)) === 0);

  const full = new Map();
  for (let x = 100; x <= 120; x += 1) for (let y = 100; y <= 120; y += 1) full.set(lbKey(x, y), { x: x * 192 + 96, y: y * 192 + 96, frac: 1 });
  const mid = 110 * 192 + 96;
  check("desertWeightAt: deep inside an all-sand region = 1", Math.abs(desert.desertWeightAt(full, mid, mid) - 1) < 1e-12);
  check("desertWeightAt: an empty map = 0, non-finite position = 0",
    desert.desertWeightAt(new Map(), mid, mid) === 0 && desert.desertWeightAt(full, NaN, mid) === 0);
  // Edge: the region ends at x = 120; standing on its last column, the east
  // half of the window is sand-free.
  const edge = desert.desertWeightAt(full, 120 * 192 + 96, mid);
  check("desertWeightAt: on the region's edge the weight is partial (0.3 .. 0.85)", edge > 0.3 && edge < 0.85, edge.toFixed(3));
  const out = desert.desertWeightAt(full, 125 * 192 + 96, mid);
  check("desertWeightAt: 5 landblocks past the edge it is 0 (never follows you out)", out === 0, String(out));
  const one = new Map([[lbKey(110, 110), { x: mid, y: mid, frac: 1 }]]);
  const lonely = desert.desertWeightAt(one, mid, mid);
  check("desertWeightAt: one sand landblock in grass country stays under weightLo", lonely < T.weightLo, lonely.toFixed(3));

  check("desertHeatFromEnv: null env = clear noon (1)", desert.desertHeatFromEnv(null) === 1);
  check("desertHeatFromEnv: night (sunAlt < 0) = 0, dawn below sunLo = 0",
    desert.desertHeatFromEnv({ sunAlt: -0.3 }) === 0 && desert.desertHeatFromEnv({ sunAlt: T.sunLo }) === 0);
  check("desertHeatFromEnv: full rain wetness = 0, half wet = half",
    desert.desertHeatFromEnv({ sunAlt: 1, wetness: 1 }) === 0
    && Math.abs(desert.desertHeatFromEnv({ sunAlt: 1, wetness: 0.5 }) - 0.5) < 1e-12);
  check("desertHeatFromEnv: a full storm damps by stormDamp",
    Math.abs(desert.desertHeatFromEnv({ sunAlt: 1, stormness: 1 }) - (1 - T.stormDamp)) < 1e-12);
  const lo = desert.desertHeatFromEnv({ sunAlt: 0.3 }), hi = desert.desertHeatFromEnv({ sunAlt: 0.5 });
  check("desertHeatFromEnv: rises with the sun", lo > 0 && hi > lo && hi < 1, `${lo.toFixed(3)} ${hi.toFixed(3)}`);

  check("resolveDesertHazeQuality: needs terrainHaze true and a strength > 0",
    desert.resolveDesertHazeQuality(null) === null
    && desert.resolveDesertHazeQuality({ terrainHaze: false, terrainHazeStrength: 1 }) === null
    && desert.resolveDesertHazeQuality({ terrainHaze: true, terrainHazeStrength: 0 }) === null
    && desert.resolveDesertHazeQuality({ terrainHaze: true, terrainHazeStrength: 1.25 }).strength === 1.25
    && desert.resolveDesertHazeQuality({ terrainHaze: true, terrainHazeStrength: 9 }).strength === 4);
}

// ---------------------------------------------------------------------------
console.log("\n-- D2. real DAT: Tufa desert vs Holtburg --");
const CELL_DAT = "/home/wbterminal/ac_base_dats/client_cell_1.dat";
function openDat(path) {
  const fd = openSync(path, "r");
  const hdr = Buffer.alloc(36);
  readSync(fd, hdr, 0, 36, 0x140);
  const blockSize = hdr.readUInt32LE(4);
  const root = hdr.readUInt32LE(32);
  const readAt = (len, off) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const readData = (offset, size) => {
    const out = Buffer.alloc(size);
    let cur = offset, done = 0;
    while (done < size) {
      const next = readAt(4, cur).readUInt32LE(0);
      const take = next === 0 ? size - done : Math.min(size - done, blockSize - 4);
      readAt(take, cur + 4).copy(out, done);
      done += take; cur = next;
    }
    return out;
  };
  const find = (id) => {
    let node = root;
    for (let depth = 0; node && depth < 32; depth += 1) {
      const d = readData(node, 1716);
      const n = d.readUInt32LE(248);
      const leaf = d.readUInt32LE(0) === 0;
      let i = 0;
      for (; i < n; i += 1) {
        const eid = d.readUInt32LE(252 + 24 * i + 4);
        if (eid === id) { const e = 252 + 24 * i; return { offset: d.readUInt32LE(e + 8), size: d.readUInt32LE(e + 12) }; }
        if (eid > id) break;
      }
      if (leaf) return null;
      node = d.readUInt32LE(4 * i);
    }
    return null;
  };
  const get = (id) => { const e = find(id >>> 0); return e ? readData(e.offset, e.size) : null; };
  return { get, close: () => closeSync(fd) };
}
/** CellLandblock: u32 id, u32 hasObjects, u16 terrain[81], u8 height[81]. */
function readCodes(dat, lbX, lbY) {
  const b = dat.get((((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xffff) >>> 0);
  if (!b) return null;
  const codes = new Uint8Array(81);
  for (let v = 0; v < 81; v += 1) codes[v] = (b.readUInt16LE(8 + 2 * v) >> 2) & 0x1f;
  return codes;
}
/** The provider's view of a 5×5 around (cx, cy): only landblocks with sand. */
function sandMapAround(dat, cx, cy, r = 3) {
  const m = new Map();
  for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) {
    const codes = readCodes(dat, cx + dx, cy + dy);
    const frac = desert.sandFractionOfCodes(codes);
    if (frac > 0) m.set(lbKey(cx + dx, cy + dy), { x: (cx + dx) * 192 + 96, y: (cy + dy) * 192 + 96, frac });
  }
  return m;
}
if (!existsSync(CELL_DAT)) {
  check(`real DAT present (${CELL_DAT})`, false, "missing");
} else {
  const dat = openDat(CELL_DAT);
  // 0x886E: the owner's pose in the Tufa desert on the 1070 (13.2S 7.0E).
  const tufa = sandMapAround(dat, 0x88, 0x6e);
  const tw = desert.desertWeightAt(tufa, 0x88 * 192 + 96, 0x6e * 192 + 96);
  check(`Tufa desert 0x886E: desert weight ${tw.toFixed(3)} >= weightHi (${T.weightHi}) — the mirage runs at full weight`, tw >= T.weightHi);
  const holt = sandMapAround(dat, 0xa9, 0xb4);
  const hw = desert.desertWeightAt(holt, 0xa9 * 192 + 96, 0xb4 * 192 + 96);
  check(`Holtburg 0xA9B4: desert weight ${hw.toFixed(3)} < weightLo (${T.weightLo}) — no mirage in grassland`, hw < T.weightLo);
  dat.close();
}

// ---------------------------------------------------------------------------
console.log("\n-- D3. the state write --");
{
  const S = volc.HEAT_HAZE_STATE;
  volc.clearHeatHazeState(); volc.clearGroundHazeState();
  const lbs = desert._desertSandLbs();
  lbs.clear();
  for (let x = 100; x <= 120; x += 1) for (let y = 100; y <= 120; y += 1) lbs.set(lbKey(x, y), { x: x * 192 + 96, y: y * 192 + 96, frac: 1 });
  const P = { x: 110 * 192 + 96, y: 110 * 192 + 96, z: 10 };
  const Q = { strength: 1.25 };
  desert.updateDesertHazeState(Q, P, null, 1 / 60);
  check("first frame rises toward the target but does not jump (low-pass)", S.groundStrength > 0 && S.groundStrength < 0.05, String(S.groundStrength));
  for (let i = 0; i < 60 * 12; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  check("after 12 s at full desert + noon it settles at the tier strength (1.25)", Math.abs(S.groundStrength - 1.25) < 1e-3, String(S.groundStrength));
  check("mirage weight follows the ground weight; depth bands published",
    S.mirage === S.groundStrength && S.groundNearM === T.groundNearM && S.groundFullM === T.groundFullM
    && S.groundFarM === T.groundFarM && S.mirageStartM === T.mirageStartM && S.mirageFeatherM === T.mirageFeatherM);
  check("the desert arm never touches the volcano disc fields", S.enabled === 0 && S.radiusM === 0 && S.strength === 0);
  volc.clearGroundHazeState();
  desert.updateDesertHazeState(Q, P, null, 0.25);
  const quarter = S.groundStrength;
  volc.clearGroundHazeState();
  desert.updateDesertHazeState(Q, P, null, 30);
  check("a 30 s hitch steps exactly like 0.25 s (no instant jump)", S.groundStrength === quarter && quarter > 0 && quarter < 0.3, String(quarter));
  for (let i = 0; i < 60 * 12; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  for (let i = 0; i < 60 * 12; i += 1) desert.updateDesertHazeState(Q, P, { sunAlt: -0.5 }, 1 / 60);
  check("at night it decays to exactly 0", S.groundStrength === 0 && S.mirage === 0, String(S.groundStrength));
  for (let i = 0; i < 60 * 12; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  volc.clearHeatHazeState();
  check("clearHeatHazeState (the volcano arm's clear) leaves the ground fields alone", S.groundStrength > 1);
  S.enabled = 1; S.radiusM = 160; S.strength = 1;
  volc.clearGroundHazeState();
  check("clearGroundHazeState leaves the disc fields alone, zeroes the ground ones",
    S.enabled === 1 && S.radiusM === 160 && S.groundStrength === 0 && S.mirage === 0 && S.desertWeight === 0);
  volc.clearHeatHazeState();
  for (let i = 0; i < 60; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  desert.updateDesertHazeState(null, P, null, 1 / 60);
  check("no quality (tier without haze) clears the ground fields at once", S.groundStrength === 0);
  for (let i = 0; i < 60; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  desert.updateDesertHazeState(Q, null, null, 1 / 60);
  check("no player clears the ground fields at once", S.groundStrength === 0);
  lbs.clear();
  for (let i = 0; i < 60 * 12; i += 1) desert.updateDesertHazeState(Q, P, null, 1 / 60);
  check("no sand landblock resident: decays to 0", S.groundStrength === 0 && S.desertWeight === 0);
  volc.clearGroundHazeState();
}

// ---------------------------------------------------------------------------
console.log("\n-- D4. gating + registration --");
{
  setUrl(""); reset();
  check("high tier, no URL: heatHazeEnabled() true (shipped)", heatHazeEnabled() === true);
  const surf = desert.initDesertHaze({ scene3d: {}, readEnv: () => null });
  const ids = vfx.terrainVfxStats().providers.map((p) => p.id || p);
  check("initDesertHaze registers terrain.desertHaze", !!surf && ids.some((id) => String(id) === desert.DESERT_HAZE_PROVIDER_ID), JSON.stringify(ids));
  check("a second initDesertHaze is idempotent (no duplicate provider)",
    !!desert.initDesertHaze({}) && vfx.terrainVfxStats().providers.filter((p) => String(p.id || p) === desert.DESERT_HAZE_PROVIDER_ID).length === 1);
  check("stats surface reports enabled", surf.stats().enabled === true);
  desert.disposeDesertHaze();
  vfx._resetTerrainVfx();
  for (const [label, search, flags] of [["?terrainHaze=off", "?terrainHaze=off", HIGH_FLAGS], ["?visual=off", "?visual=off", HIGH_FLAGS],
    ["?terrainVfx=off", "?terrainVfx=off", HIGH_FLAGS], ["mid tier (terrainHaze false)", "", { ...HIGH_FLAGS, terrainHaze: false }]]) {
    setUrl(search, flags); reset();
    check(`${label}: heatHazeEnabled false, initDesertHaze returns null, nothing registers`,
      heatHazeEnabled() === false && desert.initDesertHaze({}) === null && vfx.terrainVfxStats().providers.length === 0);
  }
  setUrl("?terrainHaze=on", { ...HIGH_FLAGS, terrainHaze: false }); reset();
  check("?terrainHaze=on lights it on a tier that does not", heatHazeEnabled() === true);
  setUrl(""); reset();
}

// ---------------------------------------------------------------------------
console.log("\n-- D5. the Effect: ground + mirage --");
{
  const state = { enabled: 0, radiusM: 0, groundStrength: 0, mirage: 0 };
  const fx = haze.createHeatHazeEffect({ enabled: true, cameraFar: 12000, state });
  const u = (k) => fx.uniforms.get(k).value;
  fx.update(null, null, 0.016);
  check("all-zero state: ground, mirage and disc strength uniforms are 0", u("uGround") === 0 && u("uMirage") === 0 && u("uStrength") === 0);
  Object.assign(state, { groundStrength: 1.25, mirage: 1.25, groundNearM: 25, groundFullM: 450, groundFarM: 2600, mirageStartM: 160, mirageFeatherM: 420 });
  fx.update(null, null, 0.016);
  check("ground uniform = amplitude × groundGain × groundStrength",
    Math.abs(u("uGround") - haze.HEAT_BASE_AMPLITUDE * haze.HEAT_GROUND_GAIN * 1.25) < 1e-12, String(u("uGround")));
  check("mirage uniform = mirage lift × weight", Math.abs(u("uMirage") - haze.MIRAGE_BASE_LIFT * 1.25) < 1e-12, String(u("uMirage")));
  check("bands copied", u("uGroundNear") === 25 && u("uGroundFull") === 450 && u("uGroundFar") === 2600 && u("uMirageStart") === 160 && u("uMirageFeather") === 420);
  check("the desert arm alone leaves the disc off (uStrength 0, uHeatRadius 0)", u("uStrength") === 0 && u("uHeatRadius") === 0);
  fx.ground = 2; fx.mirage = 0.02; fx.update(null, null, 0.016);
  check("live knobs: ground gain and mirage lift", Math.abs(u("uGround") - haze.HEAT_BASE_AMPLITUDE * 2 * 1.25) < 1e-12 && Math.abs(u("uMirage") - 0.025) < 1e-12);
  check("the base amplitude is 0.009 (1.5x the old whisper, owner 2026-10-23)", haze.HEAT_BASE_AMPLITUDE === 0.009);

  const src = fx.getFragmentShader();
  const glsl = src.slice(src.indexOf("uniform float uTime"));
  check("GLSL declares the seven desert uniforms",
    ["uGround", "uGroundNear", "uGroundFull", "uGroundFar", "uMirage", "uMirageStart", "uMirageFeather"].every((n) => new RegExp(`uniform float ${n};`).test(glsl)));
  check("GLSL: no backticks, still a pure mainUv (no mainImage)", !glsl.includes("`") && /void\s+mainUv\s*\(\s*inout\s+vec2\s+uv\s*\)/.test(glsl) && !/mainImage/.test(glsl));
  check("GLSL: the early-out covers disc, ground and mirage", /if \(!disc && uGround <= 0\.0 && uMirage <= 0\.0\) return;/.test(glsl));
  check("GLSL: the sky still never warps (dist < 0 returns before any term)", glsl.indexOf("if (dist < 0.0) return;") < glsl.indexOf("float a = 0.0;"));
  check("GLSL: the mirage samples from ABOVE (uv.y += ...), ramped by distance", /uv\.y \+= uMirage \* r \*/.test(glsl) && /smoothstep\(uMirageStart/.test(glsl));
  check("GLSL: the ground term grows with distance and fades by uGroundFar", /smoothstep\(uGroundNear, max\(uGroundFull/.test(glsl) && /uGroundFar \* 0\.7/.test(glsl));
  check("GLSL: ASCII only", [...glsl].every((c) => c.charCodeAt(0) < 128));
  check("GLSL: the mirage lifts only ground that recedes (a wall or roof face below a crest is not lifted)",
    /hbHeatDistanceM\(uv - vec2\(0\.0, 2\.0 \* texelSize\.y\)\)/.test(glsl) && /smoothstep\(1\.002, 1\.02, dist \/ max\(dBelow, 0\.01\)\)/.test(glsl));

  // 2026-10-23 — towns stand both arms down.
  check("townFactorFromCells: open country 1, a town 0, monotone between",
    desert.townFactorFromCells(0) === 1 && desert.townFactorFromCells(T.townCellsLo) === 1 && desert.townFactorFromCells(T.townCellsHi) === 0
    && desert.townFactorFromCells(100) === 0 && desert.townFactorFromCells(8) < 1 && desert.townFactorFromCells(8) > desert.townFactorFromCells(12));
  const st2 = { enabled: 1, radiusM: 160, screenRadiusUv: 0.3, screenU: 0.5, screenV: 0.5, nearM: 0, farM: 500, featherM: 10, strength: 1,
    groundStrength: 1, mirage: 1, groundNearM: 25, groundFullM: 450, groundFarM: 2600, mirageStartM: 160, mirageFeatherM: 420, townFactor: 1 };
  const fx2 = haze.createHeatHazeEffect({ enabled: true, cameraFar: 12000, state: st2 });
  const v2 = (k) => fx2.uniforms.get(k).value;
  fx2.update(null, null, 0.016);
  const full = [v2("uStrength"), v2("uGround"), v2("uMirage")];
  st2.townFactor = 0.25; fx2.update(null, null, 0.016);
  check("the Effect scales the disc, the ground shimmer and the mirage by townFactor",
    full.every((x) => x > 0) && Math.abs(v2("uStrength") - full[0] * 0.25) < 1e-12 && Math.abs(v2("uGround") - full[1] * 0.25) < 1e-12 && Math.abs(v2("uMirage") - full[2] * 0.25) < 1e-12);
  st2.townFactor = 0; fx2.update(null, null, 0.016);
  check("in a town (factor 0) every term is off", v2("uStrength") === 0 && v2("uGround") === 0 && v2("uMirage") === 0);
  delete st2.townFactor; fx2.update(null, null, 0.016);
  check("a state without townFactor (an older writer) is treated as open country", v2("uStrength") === full[0]);
}

console.log(`\nterrain desert haze: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
