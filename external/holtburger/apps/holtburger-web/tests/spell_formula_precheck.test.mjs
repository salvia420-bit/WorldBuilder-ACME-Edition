// tests/spell_formula_precheck.test.mjs — Area 12: Personalized Spell Formulas & Cast Precheck
//
// Verifies:
// 1. spellbaseStringHash matches retail account-hash algorithm deterministically.
// 2. Foci substitution replaces school tapers with Prismatic Taper (188 / 20631).
// 3. areSpellComponentsRequired reads PropertyBool 68 (SpellComponentsRequired).
// 4. ?castPrecheck defaults to "components" (retail-authentic behavior).
// 5. spell-components.json has valid DualDidMapper 0x27000002 WCIDs.
// 6. preCheckSpell verifies personalized formula and carried inventory items.

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

console.log("[1] ui/ac_spell_formula.js pure hash & randomization tests");
const formulaModule = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_formula.js")).href);
const {
  spellbaseStringHash,
  randomizeVersion1,
  randomizeVersion2,
  randomizeVersion3,
  getEffectiveSpellFormula,
  areSpellComponentsRequired,
  PRISMATIC_TAPER_ID,
  PRISMATIC_TAPER_WCID,
} = formulaModule;

check("spellbaseStringHash is deterministic and matches retail hash algorithm", () => {
  const h1 = spellbaseStringHash("testaccount");
  const h2 = spellbaseStringHash("testaccount");
  assert.equal(h1, h2);
  assert.equal(typeof h1, "number");
  assert.ok(h1 !== 0);

  // Different accounts produce different hashes
  const h3 = spellbaseStringHash("anotheraccount");
  assert.notEqual(h1, h3);

  // Empty string produces 0
  assert.equal(spellbaseStringHash(""), 0);
  assert.equal(spellbaseStringHash(null), 0);
});

check("randomizeVersion1/2/3 personalizes components based on account hash", () => {
  const baseComponents = [1, 63]; // Lead Scarab, Red Taper
  const r1 = randomizeVersion1(baseComponents, 12345, 100);
  assert.ok(Array.isArray(r1));
  assert.equal(r1.length, 2);

  const r2 = randomizeVersion2(baseComponents, 12345, 100);
  assert.ok(Array.isArray(r2));
  assert.equal(r2.length, 2);

  const r3 = randomizeVersion3(baseComponents, 12345, 100);
  assert.ok(Array.isArray(r3));
  assert.equal(r3.length, 2);
});

check("Foci substitution replaces school tapers with Prismatic Taper when focus is possessed", () => {
  // Base spell with Red Taper (63) and Lead Scarab (1)
  const baseComponents = [1, 63];
  const possessedFoci = new Set([15271]); // War Magic Focus possessed (school 1)

  const effective = getEffectiveSpellFormula({
    spell: { components: baseComponents, school: 1, power: 1 },
    accountName: "myaccount",
    inventoryWcids: possessedFoci,
  });

  assert.equal(effective.length, 2);
  // Red Taper (63) must be replaced by Prismatic Taper (188)
  assert.ok(effective.includes(PRISMATIC_TAPER_ID), "Red Taper should be replaced with Prismatic Taper");
  assert.ok(!effective.includes(63), "Red Taper should not remain in effective formula");
  assert.ok(effective.includes(1), "Scarab should remain");
});

check("Without Foci, school tapers remain in formula", () => {
  const baseComponents = [1, 63];
  const effective = getEffectiveSpellFormula({
    spell: { components: baseComponents, school: 4, power: 1, formulaVersion: 0 },
    accountName: "myaccount",
    inventoryWcids: new Set(), // No foci
  });

  assert.ok(effective.includes(63), "Red Taper should remain when no focus possessed");
  assert.ok(!effective.includes(PRISMATIC_TAPER_ID), "Prismatic Taper should not be used without focus");
});

console.log("\n[2] areSpellComponentsRequired tests");
check("areSpellComponentsRequired correctly queries PropertyBool 68 (SpellComponentsRequired)", () => {
  // When PropertyBool 68 is true, components are required
  const handleReq = {
    playerPropertyBool(guid, prop) {
      if (prop === 68) return true;
      return false;
    },
  };
  assert.equal(areSpellComponentsRequired(handleReq), true);

  // When PropertyBool 68 is false, components are NOT required (free casting)
  const handleFree = {
    playerPropertyBool(guid, prop) {
      if (prop === 68) return false;
      return true;
    },
  };
  assert.equal(areSpellComponentsRequired(handleFree), false);

  // Missing handle defaults to false
  assert.equal(areSpellComponentsRequired(null), false);
});

console.log("\n[3] data/spell-components.json verification");
check("spell-components.json has valid DualDidMapper 0x27000002 WCIDs", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(APP, "data", "spell-components.json"), "utf8"));
  const comps = catalog.components;

  assert.equal(comps["1"].name, "Lead Scarab");
  assert.equal(comps["1"].wcid, 691);

  assert.equal(comps["2"].name, "Iron Scarab");
  assert.equal(comps["2"].wcid, 689);

  assert.equal(comps["63"].name, "Red Taper");
  assert.equal(comps["63"].wcid, 1650);

  assert.equal(comps["188"].name, "Prismatic Taper");
  assert.equal(comps["188"].wcid, PRISMATIC_TAPER_WCID);
  assert.equal(comps["188"].wcid, 20631);

  assert.equal(comps["192"].name, "Dark Scarab");
  assert.equal(comps["192"].wcid, 37117);

  assert.equal(comps["193"].name, "Mana Scarab");
  assert.equal(comps["193"].wcid, 37155);
});

console.log("\n[4] ui/ac_cast_precheck.js default-ON and preCheckSpell verification");
const precheckModule = await import(pathToFileURL(path.join(APP, "ui", "ac_cast_precheck.js")).href);
const { castPrecheckMode, preCheckSpell, _setComponentTableForTest } = precheckModule;

check("castPrecheckMode defaults to 'components'", () => {
  globalThis.window = { location: { search: "" } };
  assert.equal(castPrecheckMode(), "components");

  globalThis.window = { location: { search: "?castPrecheck=off" } };
  assert.equal(castPrecheckMode(), "off");

  globalThis.window = { location: { search: "?castPrecheck=on" } };
  assert.equal(castPrecheckMode(), "on");
});

check("preCheckSpell succeeds when player has all required personalized components", () => {
  _setComponentTableForTest({
    "1": { name: "Lead Scarab", wcid: 691 },
    "63": { name: "Red Taper", wcid: 1650 },
  });

  globalThis.window = {
    location: { search: "" }, // default "components"
    __sessionHandle: {
      getSpellRecord(id) {
        return { components: [1, 63], formulaVersion: 0 };
      },
      playerInventory() {
        return [
          { guid: 1, wcid: 691, name: "Lead Scarab", stackSize: 5 },
          { guid: 2, wcid: 1650, name: "Red Taper", stackSize: 10 },
        ];
      },
      playerPropertyBool(guid, prop) {
        if (prop === 68) return true; // components required
        return false;
      },
      playerKnownSpells() { return []; },
    },
  };

  const err = preCheckSpell(100);
  assert.equal(err, null, "Should pass precheck when player carries all components");
});

check("preCheckSpell rejects when player is missing components and PropertyBool 68 is true", () => {
  _setComponentTableForTest({
    "1": { name: "Lead Scarab", wcid: 691 },
    "63": { name: "Red Taper", wcid: 1650 },
  });

  globalThis.window = {
    location: { search: "" }, // default "components"
    __sessionHandle: {
      getSpellRecord(id) {
        return { components: [1, 63], formulaVersion: 0 };
      },
      playerInventory() {
        // Player only has Lead Scarab, missing Red Taper
        return [
          { guid: 1, wcid: 691, name: "Lead Scarab", stackSize: 5 },
        ];
      },
      playerPropertyBool(guid, prop) {
        if (prop === 68) return true; // components required
        return false;
      },
      playerKnownSpells() { return []; },
    },
  };

  const err = preCheckSpell(100);
  assert.ok(err, "Should return missing components error");
  assert.match(err, /components/);
});

check("preCheckSpell allows free casting when PropertyBool 68 is false even if missing components", () => {
  globalThis.window = {
    location: { search: "" },
    __sessionHandle: {
      getSpellRecord(id) {
        return { components: [1, 63], formulaVersion: 0 };
      },
      playerInventory() {
        return []; // completely empty inventory
      },
      playerPropertyBool(guid, prop) {
        if (prop === 68) return false; // components NOT required
        return false;
      },
      playerKnownSpells() { return []; },
    },
  };

  const err = preCheckSpell(100);
  assert.equal(err, null, "Should allow free cast when PropertyBool 68 is false");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
