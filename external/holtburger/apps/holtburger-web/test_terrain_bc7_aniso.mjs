// terrainBc7Anisotropy — the tier-aware anisotropy floor (2026-08-05).
// Pure function: no GPU, no wasm, no network. Run: node test_terrain_bc7_aniso.mjs
import {
  terrainBc7Anisotropy,
  TERRAIN_BC7_HIRES_ANISO,
  TERRAIN_BC7_TIERS,
} from "./scene3d/terrain_bc7.js";

let fails = 0;
const check = (cond, label) => {
  if (cond) console.log("ok:", label);
  else {
    console.log("FAIL:", label);
    fails += 1;
  }
};
const aniso = (base, tier, search) => terrainBc7Anisotropy(base, tier, search);

// --- the tier order itself is the shipped default, so assert it ------------
check(TERRAIN_BC7_TIERS[0] === "t1024", "tier order: t1024 leads (Remacri is the default look)");
check(TERRAIN_BC7_TIERS[1] === "t512", "tier order: t512 is the low-bandwidth pin");
check(TERRAIN_BC7_HIRES_ANISO === 16, "hires floor is 16 (GTX 1070 max)");

// --- the floor applies to t1024 only ---------------------------------------
check(aniso(4, "t1024", "") === 16, "t1024: preset mid (4) is floored to 16");
check(aniso(1, "t1024", "") === 1, "t1024: preset low (1) is NEVER raised");
check(aniso(16, "t1024", "") === 16, "t1024: preset high (16) is unchanged");
check(aniso(32, "t1024", "") === 32, "t1024: a base above the floor is not lowered");
check(aniso(4, "t512", "") === 4, "t512: no floor — the low tier has no extra density to resolve");
check(aniso(1, "t512", "") === 1, "t512: low preset unchanged");

// --- explicit overrides -----------------------------------------------------
check(aniso(4, "t1024", "?terrainAniso=2") === 2, "?terrainAniso wins outright, even below the floor");
check(aniso(1, "t512", "?terrainAniso=16") === 16, "?terrainAniso raises t512 too");
check(aniso(4, "t1024", "?terrainAniso=0") === 16, "?terrainAniso=0 is not a valid count — ignored");
check(
  aniso(4, "t1024", "?anisotropy=4") === 4,
  "an explicit global ?anisotropy is a deliberate A/B — the floor stands down",
);
check(
  aniso(4, "t1024", "?anisotropy=4&terrainAniso=16") === 16,
  "?terrainAniso still wins over an explicit global ?anisotropy",
);

// --- degenerate input must never produce an invalid tap count ---------------
check(aniso(undefined, "t1024", "") === 1, "undefined base falls back to 1, not NaN");
check(aniso(NaN, "t1024", "") === 1, "NaN base falls back to 1");
check(aniso(0, "t1024", "") === 1, "base 0 is clamped to 1 (0 would be an invalid GL value)");
check(aniso(-8, "t1024", "") === 1, "negative base is clamped to 1");
check(aniso(4, undefined, "") === 4, "unknown tier gets no floor");

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
