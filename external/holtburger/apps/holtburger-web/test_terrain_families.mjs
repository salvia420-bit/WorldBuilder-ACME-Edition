// Terrain-VFX Wave 0A — `scene3d/terrain_families.js` unit test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
//   node test_terrain_families.mjs
//
// Locks (design plan `docs/2026-07-31-terrain-vfx-plan.md` §1.3, §2.5, §8.12):
//  - all 32 codes map to exactly one family, and every family is non-empty
//    except by explicit design;
//  - the exact §1.3 membership lists;
//  - water membership is DERIVED from the water-code set, not hardcoded:
//    flipping to the strict set moves 23 FAM_WATER -> FAM_SWAMP and takes 22
//    out of FAM_WATER;
//  - `?strictWaterCodes` reader semantics match `terrain.js` verbatim;
//  - the deliberate DELTAS vs `terrain.js::TERRAIN_CODE_TO_DETAIL_SLICE`
//    (6/25/26 STONE->VOLCANO, 4 NONE->SWAMP) are asserted by parsing that
//    table straight out of `terrain.js`, so an edit to EITHER table trips;
//  - the LUT is code-indexed, never name-matched (plan §8 risk 12).
//
// Pure ESM — `terrain_families.js` imports nothing, so no three stub is needed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import {
  FAM_NONE, FAM_GRASS, FAM_SAND, FAM_ROCK, FAM_SNOWICE,
  FAM_SWAMP, FAM_VOLCANO, FAM_DIRT, FAM_WATER, FAM_COUNT,
  FAM_NAMES, TERRAIN_CODE_NAMES, TERRAIN_CODE_COUNT,
  LEGACY_WATER_CODES, STRICT_WATER_CODES,
  buildTerrainFamilyLut, readStrictWaterCodesFlag,
  TERRAIN_CODE_TO_FAMILY, setTerrainWaterCodes, terrainWaterCodes,
  familyForCode, isWaterCode, familyName,
} from "./scene3d/terrain_families.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---- family constants ----------------------------------------------
console.log("terrain_families — family constants");
check("FAM_* are 0..8 dense", [
  FAM_NONE, FAM_GRASS, FAM_SAND, FAM_ROCK, FAM_SNOWICE,
  FAM_SWAMP, FAM_VOLCANO, FAM_DIRT, FAM_WATER,
].every((v, i) => v === i));
check("FAM_COUNT === 9", FAM_COUNT === 9);
check("FAM_NAMES covers every family", FAM_NAMES.length === FAM_COUNT);
check("TERRAIN_CODE_NAMES has 32 entries", TERRAIN_CODE_NAMES.length === 32);
check("familyName(FAM_VOLCANO) === 'volcano'", familyName(FAM_VOLCANO) === "volcano");

// ---- §1.3 membership, on the LEGACY water set ----------------------
console.log("terrain_families — §1.3 membership (legacy water set)");
const legacy = buildTerrainFamilyLut(LEGACY_WATER_CODES);
const strict = buildTerrainFamilyLut(STRICT_WATER_CODES);

check("LUT is Uint8Array(32)", legacy instanceof Uint8Array && legacy.length === 32);

const EXPECT_LEGACY = {
  [FAM_GRASS]: [1, 3, 9, 21, 28, 29],
  [FAM_SAND]: [10, 11, 12],
  [FAM_ROCK]: [0, 13, 14, 30],
  [FAM_SNOWICE]: [2, 15, 27],
  [FAM_SWAMP]: [4],
  [FAM_VOLCANO]: [6, 25, 26],
  [FAM_DIRT]: [5, 7, 8, 24, 31],
  [FAM_WATER]: [16, 17, 18, 19, 20, 22, 23],
  [FAM_NONE]: [],
};
for (const fam of Object.keys(EXPECT_LEGACY)) {
  const want = EXPECT_LEGACY[fam];
  const got = [];
  for (let c = 0; c < 32; c += 1) if (legacy[c] === Number(fam)) got.push(c);
  check(
    `FAM_${FAM_NAMES[fam].toUpperCase()} = [${want.join(",")}]`,
    got.length === want.length && got.every((c, i) => c === want[i]),
    `got [${got.join(",")}]`,
  );
}

// Exactly one family per code, all in range.
let allOne = true;
for (let c = 0; c < 32; c += 1) {
  if (!(legacy[c] >= 0 && legacy[c] < FAM_COUNT)) allOne = false;
}
check("every code maps into [0, FAM_COUNT)", allOne);
check("the 32 codes partition into the 9 families",
  Object.values(EXPECT_LEGACY).reduce((n, a) => n + a.length, 0) === 32);

// ---- water derivation ----------------------------------------------
console.log("terrain_families — water membership is DERIVED, not hardcoded");
check("legacy: 22 is FAM_WATER", legacy[22] === FAM_WATER);
check("legacy: 23 is FAM_WATER", legacy[23] === FAM_WATER);
check("strict: 23 moves FAM_WATER -> FAM_SWAMP", strict[23] === FAM_SWAMP,
  `got ${FAM_NAMES[strict[23]]}`);
check("strict: 22 leaves FAM_WATER", strict[22] !== FAM_WATER,
  `got ${FAM_NAMES[strict[22]]}`);
check("strict: 22 lands in FAM_NONE (faux running water — nothing scatters)",
  strict[22] === FAM_NONE);
check("strict: 16-20 stay FAM_WATER",
  [16, 17, 18, 19, 20].every((c) => strict[c] === FAM_WATER));
check("strict: no other code changed",
  [...Array(32).keys()].every((c) => (c === 22 || c === 23) || strict[c] === legacy[c]));
// An arbitrary injected set (i.e. a future region) must flow through too.
const noWater = buildTerrainFamilyLut([]);
check("empty water set: 16-20 still FAM_WATER (retail SurfChar, no dry identity)",
  [16, 17, 18, 19, 20].every((c) => noWater[c] === FAM_WATER));
check("empty water set: 23 is FAM_SWAMP", noWater[23] === FAM_SWAMP);
check("out-of-range water codes are ignored",
  buildTerrainFamilyLut([99, -3])[0] === FAM_ROCK);

// ---- the `?strictWaterCodes` reader --------------------------------
console.log("terrain_families — ?strictWaterCodes reader parity with terrain.js");
check("absent param reads ON (verbatim `!== \"off\"`)", readStrictWaterCodesFlag("") === true);
check("?strictWaterCodes=off reads OFF",
  readStrictWaterCodesFlag("?strictWaterCodes=off") === false);
check("?strictWaterCodes=on reads ON",
  readStrictWaterCodesFlag("?strictWaterCodes=on") === true);
check("any other value still reads ON (that is terrain.js's semantics)",
  readStrictWaterCodesFlag("?strictWaterCodes=1") === true);
// The reader really is byte-identical to terrain.js's — assert the source.
const terrainSrc = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
check("terrain.js still uses the `!== \"off\"` strictWaterCodes reader",
  /get\("strictWaterCodes"\)\s*!==\s*"off"/.test(terrainSrc));
check("terrain.js legacy water set is still {16..20,22,23}",
  /\[16,\s*17,\s*18,\s*19,\s*20,\s*22,\s*23\]/.test(terrainSrc));
check("terrain.js strict water set is still {16..20}",
  /\[16,\s*17,\s*18,\s*19,\s*20\]/.test(terrainSrc));

// ---- live LUT + injection ------------------------------------------
console.log("terrain_families — shared LUT injection");
const beforeRef = TERRAIN_CODE_TO_FAMILY;
setTerrainWaterCodes(STRICT_WATER_CODES);
check("setTerrainWaterCodes mutates IN PLACE (importers keep the same ref)",
  TERRAIN_CODE_TO_FAMILY === beforeRef);
check("after strict injection familyForCode(23) === FAM_SWAMP",
  familyForCode(23) === FAM_SWAMP);
check("after strict injection isWaterCode(22) === false", isWaterCode(22) === false);
check("terrainWaterCodes() reports the active set",
  terrainWaterCodes().join(",") === "16,17,18,19,20");
setTerrainWaterCodes(LEGACY_WATER_CODES);
check("re-injecting the legacy set restores 23 to FAM_WATER",
  familyForCode(23) === FAM_WATER && isWaterCode(23));
check("terrainWaterCodes() follows", terrainWaterCodes().join(",") === "16,17,18,19,20,22,23");
check("familyForCode masks to 5 bits (0x1f) like terrain.js:145",
  familyForCode(0x20 | 1) === familyForCode(1));

// ---- deltas vs terrain.js's detail-slice table ---------------------
//
// `TERRAIN_CODE_TO_DETAIL_SLICE` is module-private in terrain.js, so parse it
// off disk rather than export-widening a file Wave 0A is only allowed to touch
// in one line. Parsing also means an edit to that table trips this test.
console.log("terrain_families — deltas vs terrain.js TERRAIN_CODE_TO_DETAIL_SLICE");
function parseDetailSlices(src) {
  const m = src.match(/TERRAIN_CODE_TO_DETAIL_SLICE\s*=\s*new Uint8Array\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  const out = [];
  const re = /DETAIL_SLICE_([A-Z]+)/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) out.push(hit[1]);
  return out;
}
const slices = parseDetailSlices(terrainSrc);
check("parsed TERRAIN_CODE_TO_DETAIL_SLICE (32 entries)",
  Array.isArray(slices) && slices.length === 32, `got ${slices ? slices.length : "null"}`);

if (slices && slices.length === 32) {
  // Where the two tables AGREE by construction.
  const SLICE_TO_FAM = {
    GRASS: FAM_GRASS, SAND: FAM_SAND, STONE: FAM_ROCK, SNOW: FAM_SNOWICE, DIRT: FAM_DIRT,
  };
  // The complete, deliberate delta list. Anything else diverging is a bug.
  const EXPECTED_DELTAS = {
    4: ["NONE", FAM_SWAMP],    // MarshSparseSwamp — no detail slice, but a real family
    6: ["STONE", FAM_VOLCANO], // ObsidianPlain
    25: ["STONE", FAM_VOLCANO], // Volcano1
    26: ["STONE", FAM_VOLCANO], // Volcano2
    // water codes carry DETAIL_SLICE_NONE and are FAM_WATER
    16: ["NONE", FAM_WATER], 17: ["NONE", FAM_WATER], 18: ["NONE", FAM_WATER],
    19: ["NONE", FAM_WATER], 20: ["NONE", FAM_WATER],
    22: ["NONE", FAM_WATER], 23: ["NONE", FAM_WATER],
  };
  const unexpected = [];
  for (let c = 0; c < 32; c += 1) {
    const exp = EXPECTED_DELTAS[c];
    if (exp) {
      if (slices[c] !== exp[0] || legacy[c] !== exp[1]) {
        unexpected.push(`${c}: slice ${slices[c]} fam ${FAM_NAMES[legacy[c]]}`);
      }
      continue;
    }
    const want = SLICE_TO_FAM[slices[c]];
    if (want === undefined || legacy[c] !== want) {
      unexpected.push(`${c}: slice ${slices[c]} fam ${FAM_NAMES[legacy[c]]}`);
    }
  }
  check("every code either matches its detail slice or is a KNOWN delta",
    unexpected.length === 0, unexpected.join(" | "));
  check("6/25/26 are STONE in terrain.js but FAM_VOLCANO here",
    [6, 25, 26].every((c) => slices[c] === "STONE" && legacy[c] === FAM_VOLCANO));
  check("4 is NONE in terrain.js but FAM_SWAMP here",
    slices[4] === "NONE" && legacy[4] === FAM_SWAMP);
  // The shared-RenderSurface trap: 0 vs 24/31 share `0x06006D6F` yet split.
  check("code 0 (ROCK) and codes 24/31 (DIRT) split despite a shared RenderSurface",
    legacy[0] === FAM_ROCK && legacy[24] === FAM_DIRT && legacy[31] === FAM_DIRT);
  check("codes 9 and 28 share `0x06006D3C` and are both GRASS",
    legacy[9] === FAM_GRASS && legacy[28] === FAM_GRASS);
}

// ---- code-indexed, never name-matched ------------------------------
console.log("terrain_families — code-indexed, never name-matched (§8 risk 12)");
const famSrc = readFileSync(resolvePath(__dirname, "scene3d/terrain_families.js"), "utf8");
const codeSection = famSrc.slice(famSrc.indexOf("const BASE_FAMILY"));
check("no name lookup in the LUT builder / accessors",
  !/TERRAIN_CODE_NAMES\s*[[.]/.test(codeSection)
  && !/\.indexOf\(\s*["']/.test(codeSection)
  && !/name\s*===/.test(codeSection));
check("TERRAIN_CODE_COUNT === 32", TERRAIN_CODE_COUNT === 32);

console.log(`\nterrain_families: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
