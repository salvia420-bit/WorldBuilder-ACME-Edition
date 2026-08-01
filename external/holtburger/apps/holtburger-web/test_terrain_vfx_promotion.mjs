// test_terrain_vfx_promotion.mjs — PROMOTION READINESS for the seven terrain-VFX
// families (2026-08-01, docs/PERF-SYNTHESIS-bigwin-2026-08-01.md §7).
//
// The families themselves are tested by test_terrain_{grass,sand,snow,volcano,
// swamp,dirt,rock}.mjs. THIS suite tests the three traps that only bite at
// PROMOTION time — the moment the owner approves a family after a 1070 eye-test
// and someone flips it on in `quality.js`:
//
//   P1  PER-FAMILY TRAIL FADE. The global 4 s fade is grass springback and is
//       wrong for snow (300 s) and mud (30 s). Each writer now CLAIMS its fade,
//       the longest live claim wins, and an explicit `?terrainTrailFade=` beats
//       every claim.
//   P2  TRAIL COUPLING. Grass stomp, snow prints and mud prints all write the
//       shared map and all silently no-op when it was never built. A live
//       writer now IMPLIES the map (logged once); `?terrainTrail=off` still
//       wins (warned once).
//   P3  BARE DEFAULT IS UNCHANGED. Nine masters false on all four tiers, no
//       writers, no implication, no trail render target, no fade movement.
//   P4  ICE REACHABILITY. `ultra.terrainIceRefraction: true` was dead config
//       under a master that no tier could set. The promotion switchboard makes
//       every master one gate away from the ladder, so ultra's stated intent
//       becomes live the moment ice is promoted — and not before.
//
// Zero dependencies, zero GPU, zero browser.
// Run from apps/holtburger-web/:  node test_terrain_vfx_promotion.mjs

import { readFileSync } from "node:fs";
import {
  TRAIL_FAMILY_FADE_SEC,
  longestTrailFadeClaim,
  terrainTrailEnabled,
  terrainTrailWriters,
  terrainTrailFadeSource,
  terrainTrailRecoverySec,
  terrainIceEnabled,
  terrainIceRefractionEnabled,
  VFX_EFFECT_FLAGS,
  _resetVfxFlags,
} from "./scene3d/vfx_flags.js";
import { _resetVfxCatalog } from "./scene3d/vfx_catalog.js";
import {
  PRESETS, PRESET_NAMES, TERRAIN_VFX_PROMOTED, TERRAIN_VFX_TIERS, terrainMaster,
} from "./scene3d/quality.js";
import { SNOW_RECOMMENDED_FADE_SEC } from "./scene3d/terrain_snow.js";
import { MUD_RECOMMENDED_FADE_SEC } from "./scene3d/terrain_dirt.js";
import { initTerrainVfx, terrainVfxStats, _resetTerrainVfx } from "./scene3d/terrain_vfx.js";
import { TRAIL_DEFAULTS } from "./scene3d/trail_map.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const FLAGS_SRC = readFileSync("./scene3d/vfx_flags.js", "utf8");
const QUALITY_SRC = readFileSync("./scene3d/quality.js", "utf8");
const SNOW_SRC = readFileSync("./scene3d/terrain_snow.js", "utf8");
const DIRT_SRC = readFileSync("./scene3d/terrain_dirt.js", "utf8");
const TRAIL_SRC = readFileSync("./scene3d/trail_map.js", "utf8");
const FLAGS_DOC = readFileSync("./docs/url-flags.md", "utf8");

/** The nine family masters, and the `TERRAIN_VFX_PROMOTED` key of each. */
const MASTERS = Object.freeze({
  terrainTrail: "trail",
  terrainGrass: "grass",
  terrainSand: "sand",
  terrainSnow: "snow",
  terrainIce: "ice",
  terrainVolcano: "volcano",
  terrainSwamp: "swamp",
  terrainDirt: "dirt",
  terrainRock: "rock",
});

function setUrl(search) {
  globalThis.window = { location: { search } };
  _resetVfxCatalog();
  _resetVfxFlags();
}
function setUrlWithPreset(search, flags) {
  globalThis.window = { location: { search }, liveScene3d: { quality: { flags } } };
  _resetVfxCatalog();
  _resetVfxFlags();
}
function clearUrl() {
  delete globalThis.window;
  _resetVfxCatalog();
  _resetVfxFlags();
}

/** Run `fn` with console.log/warn captured. Returns the lines it emitted. */
function captureConsole(fn) {
  const lines = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a) => lines.push(["log", a.join(" ")]);
  console.warn = (...a) => lines.push(["warn", a.join(" ")]);
  try { fn(); } finally { console.log = log; console.warn = warn; }
  return lines;
}
const hasLine = (lines, kind, needle) =>
  lines.some(([k, s]) => k === kind && s.includes(needle));

// ===========================================================================
console.log("\n-- P1 per-family trail fade: the claims ------------------------");
// ===========================================================================
check("the three writers' fades are 4 / 30 / 300 s",
  TRAIL_FAMILY_FADE_SEC.grassStomp === 4
  && TRAIL_FAMILY_FADE_SEC.mudPrints === 30
  && TRAIL_FAMILY_FADE_SEC.snowPrints === 300);
check("the table is frozen (a family cannot mutate another's ask)",
  Object.isFrozen(TRAIL_FAMILY_FADE_SEC));
check("each family's exported constant IS the table entry (no drift)",
  SNOW_RECOMMENDED_FADE_SEC === TRAIL_FAMILY_FADE_SEC.snowPrints
  && MUD_RECOMMENDED_FADE_SEC === TRAIL_FAMILY_FADE_SEC.mudPrints);
check("every claimed fade is inside the trail map's own clamp",
  Object.values(TRAIL_FAMILY_FADE_SEC).every((s) => s >= 0.05 && s <= 300));
check("snow's ask IS the clamp ceiling (its 'effectively infinite')",
  TRAIL_FAMILY_FADE_SEC.snowPrints === 300);
check("grass's ask is the historical global default (4 s springback)",
  TRAIL_FAMILY_FADE_SEC.grassStomp === TRAIL_DEFAULTS.recoverySec);

// The pure longest-wins helper.
check("longestTrailFadeClaim: no claims ⇒ null, no claimants",
  (() => {
    const r = longestTrailFadeClaim([]);
    return r.sec === null && r.claimants.length === 0;
  })());
check("longestTrailFadeClaim: null/undefined input is fail-soft",
  longestTrailFadeClaim(null).sec === null && longestTrailFadeClaim(undefined).sec === null);
check("longestTrailFadeClaim: the MAXIMUM wins, order-independently",
  (() => {
    const a = [{ id: "a", sec: 4 }, { id: "b", sec: 300 }, { id: "c", sec: 30 }];
    const b = [{ id: "b", sec: 300 }, { id: "c", sec: 30 }, { id: "a", sec: 4 }];
    return longestTrailFadeClaim(a).sec === 300 && longestTrailFadeClaim(b).sec === 300;
  })());
check("longestTrailFadeClaim: every claimant is reported, non-finite dropped",
  (() => {
    const r = longestTrailFadeClaim([{ id: "a", sec: 4 }, { id: "x", sec: NaN }, { id: "b", sec: 30 }]);
    return r.sec === 30 && r.claimants.join(",") === "a,b";
  })());
check("the longest-wins rationale is recorded where the rule lives",
  /LONGEST WINS/.test(FLAGS_SRC) && /destroys that family's effect/i.test(FLAGS_SRC));

// ===========================================================================
console.log("\n-- P1 per-family trail fade: live precedence -------------------");
// ===========================================================================
clearUrl();
check("bare default: nobody claims, the fade is the historical 4 s",
  terrainTrailFadeSource().sec === 4
  && terrainTrailFadeSource().source === "fallback"
  && terrainTrailFadeSource().claimants.length === 0);

setUrl("?terrainGrass=on&terrainGrassStomp=on");
check("grass stomp alone claims 4 s (source: family)",
  terrainTrailFadeSource().sec === 4 && terrainTrailFadeSource().source === "family"
  && terrainTrailFadeSource().claimants.join() === "terrain.grassStomp");

setUrl("?terrainSnow=on&terrainSnowPrints=on");
check("snow prints alone lift the fade to 300 s WITHOUT a URL number",
  terrainTrailRecoverySec() === 300 && terrainTrailFadeSource().source === "family");

setUrl("?terrainDirt=on&terrainMudPrints=on");
check("mud prints alone lift the fade to 30 s WITHOUT a URL number",
  terrainTrailRecoverySec() === 30 && terrainTrailFadeSource().source === "family");

setUrl("?terrainDirt=on&terrainMudWetness=on");
check("mud WETNESS does not claim a fade (it never stamps the map)",
  terrainTrailFadeSource().source === "fallback" && terrainTrailRecoverySec() === 4);

setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainDirt=on&terrainMudPrints=on");
check("snow + mud together ⇒ 300 s (LONGEST wins, both claimants named)",
  terrainTrailRecoverySec() === 300
  && terrainTrailFadeSource().claimants.length === 2
  && terrainTrailFadeSource().claimants.includes("terrain.snowPrints")
  && terrainTrailFadeSource().claimants.includes("terrain.mudPrints"));

setUrl("?terrainGrass=on&terrainGrassStomp=on&terrainDirt=on&terrainMudPrints=on");
check("grass + mud together ⇒ 30 s (mud's longer claim, not grass's 4 s)",
  terrainTrailRecoverySec() === 30);

setUrl("?terrainGrass=on&terrainGrassStomp=on&terrainSnow=on&terrainSnowPrints=on"
  + "&terrainDirt=on&terrainMudPrints=on");
check("all three writers ⇒ 300 s, three claimants",
  terrainTrailRecoverySec() === 300 && terrainTrailFadeSource().claimants.length === 3);

// The URL always wins — it is the A/B knob.
setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainTrailFade=4");
check("an explicit ?terrainTrailFade BEATS snow's 300 s claim",
  terrainTrailRecoverySec() === 4 && terrainTrailFadeSource().source === "url");
setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainTrailFade=120");
check("an explicit ?terrainTrailFade wins even when SHORTER than the claim",
  terrainTrailRecoverySec() === 120 && terrainTrailFadeSource().source === "url");
setUrl("?terrainGrass=on&terrainGrassStomp=on&terrainTrailFade=250");
check("an explicit ?terrainTrailFade wins when LONGER than the claim",
  terrainTrailRecoverySec() === 250 && terrainTrailFadeSource().source === "url");
setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainTrailFade=99999");
check("an OUT-OF-RANGE ?terrainTrailFade is not a URL win — the claim stands",
  terrainTrailRecoverySec() === 300 && terrainTrailFadeSource().source === "family");
setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainTrailFade=banana");
check("an UNPARSEABLE ?terrainTrailFade is not a URL win — the claim stands",
  terrainTrailRecoverySec() === 300 && terrainTrailFadeSource().source === "family");
setUrl("?terrainTrailFade=17");
check("the URL still works with no family at all (the old contract)",
  terrainTrailRecoverySec() === 17 && terrainTrailFadeSource().source === "url");

// Preset composition: the tier is one more claimant under the same rule.
setUrlWithPreset("", { terrainTrailFade: 60 });
check("with no writer the tier's fade is used, as before",
  terrainTrailRecoverySec() === 60 && terrainTrailFadeSource().source === "preset");
setUrlWithPreset("?terrainGrass=on&terrainGrassStomp=on", { terrainTrailFade: 60 });
check("a LONGER tier fade beats a shorter family claim (longest wins throughout)",
  terrainTrailRecoverySec() === 60 && terrainTrailFadeSource().source === "preset");
setUrlWithPreset("?terrainSnow=on&terrainSnowPrints=on", { terrainTrailFade: 4 });
check("a SHORTER tier fade loses to snow's claim (it would erase the prints)",
  terrainTrailRecoverySec() === 300 && terrainTrailFadeSource().source === "family");
setUrlWithPreset("?terrainSnow=on&terrainSnowPrints=on&terrainTrailFade=8", { terrainTrailFade: 4 });
check("the URL still beats BOTH the tier and the family claim",
  terrainTrailRecoverySec() === 8 && terrainTrailFadeSource().source === "url");

// A claim is composed with its family master, exactly like the router row.
setUrl("?terrainSnowPrints=on");
check("a sub-flag WITHOUT its family master claims nothing",
  terrainTrailFadeSource().claimants.length === 0 && terrainTrailRecoverySec() === 4);
setUrl("?terrainSnow=on&terrainSnowPrints=off");
check("an explicitly-off sub-flag claims nothing even with the master on",
  terrainTrailFadeSource().claimants.length === 0);
check("every claimant id is a real VFX_EFFECT_FLAGS row",
  (() => {
    setUrl("?terrainGrass=on&terrainGrassStomp=on&terrainSnow=on&terrainSnowPrints=on"
      + "&terrainDirt=on&terrainMudPrints=on");
    return terrainTrailWriters().every((id) => typeof VFX_EFFECT_FLAGS[id] === "function");
  })());
check("a claimant is live exactly when its router row is live",
  (() => {
    setUrl("?terrainDirt=on&terrainMudPrints=on");
    return terrainTrailWriters().length === 1
      && VFX_EFFECT_FLAGS["terrain.mudPrints"]() === true
      && VFX_EFFECT_FLAGS["terrain.snowPrints"]() === false;
  })());

// ===========================================================================
console.log("\n-- P2 trail coupling: a writer implies the map -----------------");
// ===========================================================================
clearUrl();
check("bare default: no writers, so no implication (the map stays off)",
  terrainTrailWriters().length === 0 && terrainTrailEnabled() === false);

for (const [label, search] of [
  ["grass stomp", "?terrainGrass=on&terrainGrassStomp=on"],
  ["snow prints", "?terrainSnow=on&terrainSnowPrints=on"],
  ["mud prints", "?terrainDirt=on&terrainMudPrints=on"],
]) {
  setUrl(search);
  const lines = captureConsole(() => terrainTrailEnabled());
  check(`${label} alone implies ?terrainTrail=on`, terrainTrailEnabled() === true);
  check(`${label} SAYS SO once, on console.log (a promotion, not a default)`,
    hasLine(lines, "log", "[terrainTrail] implied ON by")
    && lines.filter(([k]) => k === "log").length === 1);
}

setUrl("?terrainGrass=on&terrainGrassStomp=on");
check("the implication log names the effect that caused it",
  hasLine(captureConsole(() => { _resetVfxFlags(); terrainTrailEnabled(); }),
    "log", "terrain.grassStomp"));

setUrl("?terrainGrass=on&terrainGrassStomp=on&terrainSnow=on&terrainSnowPrints=on");
check("the implication logs ONCE even with several writers and several reads",
  (() => {
    const lines = captureConsole(() => {
      terrainTrailEnabled(); terrainTrailEnabled(); terrainTrailEnabled();
    });
    return lines.filter(([k]) => k === "log").length === 1;
  })());

// A family WITHOUT a trail effect must not drag the map in.
for (const [label, search] of [
  ["the grass master alone (no stomp)", "?terrainGrass=on"],
  ["sand", "?terrainSand=on"],
  ["volcano", "?terrainVolcano=on"],
  ["swamp", "?terrainSwamp=on"],
  ["rock", "?terrainRock=on"],
  ["ice", "?terrainIce=on"],
  ["snow without prints", "?terrainSnow=on&terrainSnowPrints=off"],
  ["dirt footfall only", "?terrainDirt=on&terrainMudPrints=off&terrainFootfall=on"],
]) {
  setUrl(search);
  check(`${label} does NOT imply the trail map`, terrainTrailEnabled() === false);
}

// ===========================================================================
console.log("\n-- P2 trail coupling: explicit off still wins ------------------");
// ===========================================================================
for (const [label, search] of [
  ["grass stomp", "?terrainGrass=on&terrainGrassStomp=on&terrainTrail=off"],
  ["snow prints", "?terrainSnow=on&terrainSnowPrints=on&terrainTrail=off"],
  ["mud prints", "?terrainDirt=on&terrainMudPrints=on&terrainTrail=off"],
]) {
  setUrl(search);
  const lines = captureConsole(() => terrainTrailEnabled());
  check(`?terrainTrail=off beats ${label}'s implication`, terrainTrailEnabled() === false);
  check(`?terrainTrail=off WARNS that ${label} will no-op`,
    hasLine(lines, "warn", "?terrainTrail=off with")
    && hasLine(lines, "warn", "no-op"));
  check(`?terrainTrail=off does NOT log an implication for ${label}`,
    !hasLine(lines, "log", "implied ON"));
}
setUrl("?terrainTrail=off");
check("?terrainTrail=off with NO writer is silent (nothing to warn about)",
  captureConsole(() => terrainTrailEnabled()).length === 0
  && terrainTrailEnabled() === false);
setUrl("?terrainSnow=on&terrainSnowPrints=on&terrainTrail=off");
check("the suppression warn fires ONCE across repeated reads",
  captureConsole(() => {
    terrainTrailEnabled(); terrainTrailEnabled(); terrainTrailEnabled();
  }).filter(([k]) => k === "warn").length === 1);

// `?visual=off` kills the writers through `vfxEffectEnabled`, so it must also
// kill the implication — otherwise the map is allocated for effects that cannot
// draw (and the fade would move for nobody).
setUrl("?visual=off&terrainSnow=on&terrainSnowPrints=on");
check("?visual=off suppresses the implication (no RT for a dead effect)",
  terrainTrailWriters().length === 0
  && terrainTrailEnabled() === false
  && VFX_EFFECT_FLAGS["terrain.snowPrints"] !== undefined);
check("?visual=off also leaves the fade at the untouched fallback",
  terrainTrailFadeSource().sec === 4 && terrainTrailFadeSource().source === "fallback");
setUrl("?visual=off&terrainTrail=on");
check("?visual=off does NOT override an explicit ?terrainTrail=on (unchanged contract)",
  terrainTrailEnabled() === true);

setUrl("?terrainTrail=on");
check("?terrainTrail=on still wins with no family at all", terrainTrailEnabled() === true);
setUrl("?terrainTrail=1&terrainSnow=on&terrainSnowPrints=on");
check("?terrainTrail=1 is still NOT an opt-in (exact match), but the writer implies it",
  terrainTrailEnabled() === true
  && /EXACT-match opt-in/.test(FLAGS_SRC));
setUrl("?terrainTrail=1");
check("?terrainTrail=1 alone still warns and does NOT enable",
  (() => {
    const lines = captureConsole(() => terrainTrailEnabled());
    return terrainTrailEnabled() === false && hasLine(lines, "warn", "ignoring ?terrainTrail=");
  })());
setUrlWithPreset("", { terrainTrail: true });
check("a tier that promotes the trail still enables it with no writer",
  terrainTrailEnabled() === true);

// Comment-stripped: both headers DISCUSS `createTrailMap` in prose, so a raw
// substring test finds the very words it is trying to prove absent.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
check("the two families still refuse to build the map themselves",
  !/createTrailMap/.test(stripComments(SNOW_SRC))
  && !/createTrailMap/.test(stripComments(DIRT_SRC))
  && !/from\s+["']\.\/trail_map\.js["']/.test(SNOW_SRC)
  && !/from\s+["']\.\/trail_map\.js["']/.test(DIRT_SRC));
check("trail_map.js still imports nothing (the pure-node test seam)",
  !/^import /m.test(TRAIL_SRC));
check("both families' 'map is missing' warnings now name the EXPLICIT off",
  /EXPLICIT \?terrainTrail=off/.test(SNOW_SRC) && /EXPLICIT \?terrainTrail=off/.test(DIRT_SRC));

// ===========================================================================
console.log("\n-- P3 bare default is byte-identical ---------------------------");
// ===========================================================================
for (const tier of PRESET_NAMES) {
  check(`${tier}: masters match the switchboard (ice promoted on the `
    + `{high, ultra} ladder, the other eight false)`,
    Object.keys(MASTERS).every((k) =>
      PRESETS[tier][k] === terrainMaster(MASTERS[k], tier)));
}
check("no tier promotes the trail map",
  PRESET_NAMES.every((t) => PRESETS[t].terrainTrail === false));

// The spine with no flags: no writers, no map, no allocation.
{
  _resetTerrainVfx();
  clearUrl();
  const terrainGroup = { children: [], parent: null, add() {}, remove() {} };
  const worldRoot = { children: [], add(c) { this.children.push(c); }, remove() {} };
  terrainGroup.parent = worldRoot;
  const scene3d = { terrainGroup, frameTime: { tsSec: 0, dt: 0 } };
  globalThis.window = { location: { search: "" }, liveScene3d: scene3d };
  _resetVfxCatalog();
  _resetVfxFlags();
  const lines = captureConsole(() => initTerrainVfx({ scene3d, THREE: null, renderer: null }));
  const st = terrainVfxStats();
  check("bare default: initTerrainVfx allocates NO trail render target",
    st.trail === null);
  check("bare default: the trail flag resolves false and no writer is reported",
    st.trailFlag === false && st.trailWriters.length === 0);
  check("bare default: the fade provenance is the untouched 4 s fallback",
    st.trailFade.sec === 4 && st.trailFade.source === "fallback");
  check("bare default: the spine registers no provider and logs nothing",
    st.providers.length === 0 && lines.length === 0);
  _resetTerrainVfx();
  clearUrl();
}
// ... and the implication reaches the spine when a writer IS on.
{
  _resetTerrainVfx();
  const terrainGroup = { children: [], parent: null, add() {}, remove() {} };
  const worldRoot = { children: [], add(c) { this.children.push(c); }, remove() {} };
  terrainGroup.parent = worldRoot;
  const scene3d = { terrainGroup, frameTime: { tsSec: 0, dt: 0 } };
  globalThis.window = {
    location: { search: "?terrainSnow=on&terrainSnowPrints=on" },
    liveScene3d: scene3d,
  };
  _resetVfxCatalog();
  _resetVfxFlags();
  captureConsole(() => initTerrainVfx({ scene3d, THREE: null, renderer: null }));
  const st = terrainVfxStats();
  check("a promoted writer makes the spine resolve the map ON",
    st.trailFlag === true && st.trailWriters.join() === "terrain.snowPrints");
  check("...at the family's own fade, not the 4 s global",
    st.trailFade.sec === 300 && st.trailFade.source === "family");
  _resetTerrainVfx();
  clearUrl();
}

// ===========================================================================
console.log("\n-- P4 ice reachability + the promotion switchboard -------------");
// ===========================================================================
check("every master is gated by TERRAIN_VFX_PROMOTED — ice promoted "
  + "(USER 1070 SIGN-OFF 2026-08-01), the other eight still false",
  Object.keys(MASTERS).length === 9
  && TERRAIN_VFX_PROMOTED.ice === true
  && Object.values(MASTERS).every((f) =>
    TERRAIN_VFX_PROMOTED[f] === (f === "ice")));
check("the gate and the ladder are both frozen",
  Object.isFrozen(TERRAIN_VFX_PROMOTED) && Object.isFrozen(TERRAIN_VFX_TIERS));
check("the ladder is the documented {high, ultra} promotion target",
  TERRAIN_VFX_TIERS.low === false && TERRAIN_VFX_TIERS.mid === false
  && TERRAIN_VFX_TIERS.high === true && TERRAIN_VFX_TIERS.ultra === true);
check("every tier's master value IS gate && ladder (no hand-written booleans)",
  PRESET_NAMES.every((t) =>
    Object.entries(MASTERS).every(([key, fam]) => PRESETS[t][key] === terrainMaster(fam, t))));
check("promotion is ONE line: terrainMaster follows the gate for every tier",
  terrainMaster("ice", "high") === true       // promoted 2026-08-01
  && ["low", "mid", "high", "ultra"].every((t) =>
    terrainMaster("ice", t) === (TERRAIN_VFX_PROMOTED.ice && TERRAIN_VFX_TIERS[t])));
check("each master line in quality.js is a terrainMaster() call, 4 tiers × 9",
  (QUALITY_SRC.match(/terrainMaster\("/g) || []).length === 36);

// The ice-refraction reachability that started this.
check("ultra still STATES the refraction intent (it is no longer dead config)",
  PRESETS.ultra.terrainIceRefraction === true
  && ["low", "mid", "high"].every((t) => PRESETS[t].terrainIceRefraction === false));
check("the tier that states it IS on the promoted ladder — so promoting ice reaches it",
  TERRAIN_VFX_TIERS.ultra === true);
check("refraction composes with the master — ice IS promoted, so a bare "
  + "ultra preset now lights both (the 2026-08-01 flip made this live)",
  (() => {
    setUrlWithPreset("", PRESETS.ultra);
    return terrainIceEnabled() === true && terrainIceRefractionEnabled() === true;
  })());
check("the ultra preset alone lights refraction the moment ice is on",
  (() => {
    setUrlWithPreset("?terrainIce=on", PRESETS.ultra);
    return terrainIceEnabled() === true && terrainIceRefractionEnabled() === true;
  })());
check("the same preset at high leaves refraction off (the ladder is per-key)",
  (() => {
    setUrlWithPreset("?terrainIce=on", PRESETS.high);
    return terrainIceEnabled() === true && terrainIceRefractionEnabled() === false;
  })());
check("the switchboard says it is a ship-visible change needing approval",
  /ship-visible change/.test(QUALITY_SRC) && /DEAD CONFIG/.test(QUALITY_SRC));
check("the masters are still OUT of BOOL_FLAGS (parseBool would widen the opt-in)",
  (() => {
    const bools = QUALITY_SRC.slice(
      QUALITY_SRC.indexOf("const BOOL_FLAGS"), QUALITY_SRC.indexOf("const INT_FLAGS"));
    return Object.keys(MASTERS).every((k) => !bools.includes(`"${k}"`));
  })());

// ===========================================================================
console.log("\n-- P5 docs + readers ------------------------------------------");
// ===========================================================================
check("every new reader is exported from vfx_flags.js",
  ["terrainTrailWriters", "terrainTrailFadeSource", "longestTrailFadeClaim"]
    .every((fn) => FLAGS_SRC.includes(`export function ${fn}(`)));
check("docs/url-flags.md documents the implied promotion on the terrainTrail row",
  (() => {
    const row = FLAGS_DOC.split("\n").find((l) => l.startsWith("| `terrainTrail` |"));
    return !!row && /implied/i.test(row) && /terrainTrail=off/.test(row);
  })());
check("docs/url-flags.md documents per-family fade + longest-wins on the fade row",
  (() => {
    const row = FLAGS_DOC.split("\n").find((l) => l.startsWith("| `terrainTrailFade` |"));
    return !!row && /longest/i.test(row) && row.includes("300") && row.includes("30");
  })());
check("the trail row still records that it is an EXACT-match opt-in",
  (() => {
    const row = FLAGS_DOC.split("\n").find((l) => l.startsWith("| `terrainTrail` |"));
    return !!row && /STRICT opt-in/.test(row);
  })());
check("no `!== \"off\"` opt-in was introduced by this work",
  !/_strFlag\("terrainTrail[A-Za-z]*"\)\s*!==\s*"off"/.test(FLAGS_SRC));

clearUrl();
// ===========================================================================
console.log(`\nterrain vfx promotion: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
