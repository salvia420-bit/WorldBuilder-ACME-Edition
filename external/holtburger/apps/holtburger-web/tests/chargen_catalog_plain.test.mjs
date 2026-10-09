// tests/chargen_catalog_plain.test.mjs — the char-gen wizard's data reaches it
// as plain objects (2026-10-09).
//
// The wasm getters `getCharacterGenCatalog`, `getSkillCostsForHeritage` and
// `getCharacterGenAppearanceStrips` serialize serde_json values through
// serde_wasm_bindgen, whose default makes every JSON object a JS `Map`. The
// wizard (plugins/character-creation.js `openWizard`) reads
// `catalog.heritages`, so with real data it refused to open ("catalog not
// loaded") — found on the 1070 from the new character screen. The rynth host
// now hands the plugin facade plain objects.
//
// Run from apps/holtburger-web/:  node tests/chargen_catalog_plain.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const { RynthWebHost, plainFromMaps } = await import(pathToFileURL(path.join(APP, "rynth", "webhost.js")).href);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

// What serde_wasm_bindgen hands JS for the catalog (shape from the live 1070
// session: heritages[] of Maps, starterAreas[] of Maps, …).
const map = (o) => new Map(Object.entries(o));
const wasmCatalog = map({
  expectedSkillSlots: 55,
  heritages: [map({ heritageId: 1, name: "Aluvian", genders: [map({ genderId: 1, name: "Male" })], templates: [map({ id: 0, name: "Bow Hunter" })] })],
  skills: [map({ skillId: 1, name: "Axe" })],
  starterAreas: [map({ startAreaId: 0, name: "Holtburg", locationCount: 1 })],
});
const handle = {
  getCharacterGenCatalog: () => wasmCatalog,
  getSkillCostsForHeritage: () => map({ trainedCost: 4, specializedCost: 8 }),
  getCharacterGenAppearanceStrips: () => map({ genderId: 1, hairStyles: [map({ id: 3 })] }),
};

check("plainFromMaps: Maps become plain objects, deeply; arrays and scalars stay", () => {
  const p = plainFromMaps(wasmCatalog);
  assert.equal(p instanceof Map, false);
  assert.equal(p.heritages[0].name, "Aluvian");
  assert.equal(p.heritages[0].genders[0].name, "Male");
  assert.equal(p.starterAreas[0].startAreaId, 0);
  assert.deepEqual(plainFromMaps({ a: 1 }), { a: 1 }, "already plain passes through");
  assert.equal(plainFromMaps(null), null);
  assert.equal(plainFromMaps(7), 7);
});

check("the host's char-gen getters return plain objects (the wizard's precondition holds)", () => {
  const host = new RynthWebHost(handle, { entityMap: new Map(), noEventTap: true });
  const cat = host.TryGetCharacterGenCatalog();
  assert.ok(cat.heritages?.length > 0, "openWizard reads catalog.heritages");
  assert.equal(cat.starterAreas.find((a) => a.startAreaId === 0)?.name, "Holtburg");
  assert.deepEqual(host.TryGetSkillCostsForHeritage(1, 1), { trainedCost: 4, specializedCost: 8 });
  assert.equal(host.TryGetCharacterGenAppearanceStrips(1, 1).hairStyles[0].id, 3);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
