// tests/hotbar_cooldown_sprites.test.mjs — Area 12 / D3: 12-Frame Hotbar Cooldown Sprites
//
// Verifies:
// 1. COOLDOWN_SPRITE_IDS exports 12 consecutive sprites from 0x060067CF to 0x060067DA.
// 2. cooldownStep12(duration, remaining) returns 1..12 based on retail phase.
// 3. hotbar.js CSS includes all 12 [data-cd-step="N"] rules mapping to 0x060067CF..0x060067DA.
// 4. [data-cd-step] disables animation and clip-path to prevent raster thrash.
// 5. Inventory caching prevents 4 Hz WASM playerInventory polling on cooldown ticks.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

console.log("[1] COOLDOWN_SPRITE_IDS and cooldownStep12 pure exports");
const hotbarModule = await import(pathToFileURL(path.join(APP, "plugins", "hotbar.js")).href);
const { COOLDOWN_SPRITE_IDS, cooldownStep12 } = hotbarModule;

check("COOLDOWN_SPRITE_IDS is frozen array of 12 sprite IDs from 0x060067CF to 0x060067DA", () => {
  assert.equal(Array.isArray(COOLDOWN_SPRITE_IDS), true);
  assert.equal(COOLDOWN_SPRITE_IDS.length, 12);
  assert.equal(COOLDOWN_SPRITE_IDS[0], 0x060067CF);
  assert.equal(COOLDOWN_SPRITE_IDS[11], 0x060067DA);
  for (let i = 0; i < 12; i++) {
    assert.equal(COOLDOWN_SPRITE_IDS[i], 0x060067CF + i);
  }
});

check("cooldownStep12 handles invalid or zero values safely", () => {
  assert.equal(cooldownStep12(0, 0), 0);
  assert.equal(cooldownStep12(100, 0), 0);
  assert.equal(cooldownStep12(0, 50), 0);
  assert.equal(cooldownStep12(-10, 5), 0);
  assert.equal(cooldownStep12(100, -5), 0);
  assert.equal(cooldownStep12(null, null), 0);
  assert.equal(cooldownStep12(undefined, undefined), 0);
});

check("cooldownStep12 scales 1 to 12 across cooldown progress", () => {
  // At start of cooldown (remaining == duration) -> step 12
  assert.equal(cooldownStep12(100, 100), 12);
  assert.equal(cooldownStep12(60, 60), 12);

  // At halfway (remaining == 50% duration) -> step 7 (trunc(0.5 * 12 + 1) = 7)
  assert.equal(cooldownStep12(100, 50), 7);

  // At 25% remaining -> step 4 (trunc(0.25 * 12 + 1) = 4)
  assert.equal(cooldownStep12(100, 25), 4);

  // At 75% remaining -> step 10 (trunc(0.75 * 12 + 1) = 10)
  assert.equal(cooldownStep12(100, 75), 10);

  // Near completion -> step 1
  assert.equal(cooldownStep12(100, 1), 1);
  assert.equal(cooldownStep12(100, 5), 1);
});

console.log("\n[2] Stylesheet static analysis for retail 12-frame sprites");
const hotbarSource = fs.readFileSync(path.join(APP, "plugins", "hotbar.js"), "utf8");

check("Stylesheet defines rules for all 12 cooldown sprite frames", () => {
  for (let step = 1; step <= 12; step++) {
    const hex = "0x0" + (0x060067CF + step - 1).toString(16).toUpperCase();
    const pattern = new RegExp(`\\[data-cd-step=["']?${step}["']?\\][\\s\\S]*?${hex}\\.png`);
    assert.match(hotbarSource, pattern, `Missing sprite rule for step ${step} (${hex})`);
  }
});

check("Stylesheet disables continuous animation and clip-path when data-cd-step is present", () => {
  const cdStepRule = /hb-hotbar-slot\.cooldown-active\[data-cd-step\]::after\s*\{([^}]+)\}/.exec(hotbarSource);
  assert.ok(cdStepRule, "Expected [data-cd-step] selector in stylesheet");
  assert.match(cdStepRule[1], /animation:\s*none/, "Expected animation: none to stop continuous 60-120Hz thrash");
  assert.match(cdStepRule[1], /clip-path:\s*none/, "Expected clip-path: none to stop polygon rasterization");
});

check("Stylesheet preserves fallback keyframe animation for slots without data-cd-step", () => {
  const fallbackRule = /hb-hotbar-slot\.cooldown-active:not\(\[data-cd-step\]\)::after\s*\{([^}]+)\}/.exec(hotbarSource);
  assert.ok(fallbackRule, "Expected :not([data-cd-step]) fallback selector");
  assert.match(fallbackRule[1], /animation:\s*hb-hotbar-cd/, "Expected fallback keyframe animation");
});

console.log("\n[3] Inventory polling reduction verification");
check("hotbar.js implements cached inventory cooldown map to avoid 4 Hz polling on timer ticks", () => {
  assert.match(hotbarSource, /cachedCdByGuid/, "Expected cachedCdByGuid map in hotbar.js");
  assert.match(hotbarSource, /updateCachedInventoryCooldowns/, "Expected updateCachedInventoryCooldowns helper");
  // The timer pass passes fromTimer=true or checks cache to skip playerInventory()
  assert.match(hotbarSource, /refreshSlotCooldowns\s*\(\s*fromTimer/, "Expected refreshSlotCooldowns to support fromTimer flag");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
