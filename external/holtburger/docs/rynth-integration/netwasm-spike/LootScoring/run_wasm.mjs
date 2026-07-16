// run_wasm.mjs — execute the LootScoring wasm AppBundle in Node and replay
// ALL fixtures.json scenarios through the [JSExport] evaluateLoot boundary,
// comparing against the natively-generated expected outputs. Outputs are
// verdict/int/string only (no floats), so the comparison is exact deep
// equality of the parsed JSON.
//
// Usage: node run_wasm.mjs <AppBundle-dir> [fixtures.json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const bundle = process.argv[2];
const fixturesPath = process.argv[3] || new URL("./fixtures.json", import.meta.url).pathname;
if (!bundle) {
  console.error("usage: node run_wasm.mjs <AppBundle-dir> [fixtures.json]");
  process.exit(2);
}

const { dotnet } = await import(pathToFileURL(path.join(bundle, "_framework/dotnet.js")));
const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
const E = exports.LootScoringExports;
console.log("wasm module version:", E.Version());

const fx = JSON.parse(readFileSync(fixturesPath, "utf8"));
let pass = 0, fail = 0;
for (const sc of fx.scenarios) {
  const got = JSON.parse(E.EvaluateLoot(JSON.stringify(sc.input)));
  const exp = sc.expected;
  // Canonical deep compare: both sides came from the SAME source-gen
  // serializer (same key order); JSON.stringify after JSON.parse normalizes
  // number formatting identically on both.
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (ok) pass++;
  else {
    fail++;
    console.log(`MISMATCH ${sc.name}:`);
    console.log(`  wasm   ${JSON.stringify(got)}`);
    console.log(`  native ${JSON.stringify(exp)}`);
  }
}
console.log(`NETWASM PARITY: ${pass}/${fx.scenarios.length} scenarios match native C#${fail ? " — " + fail + " MISMATCH" : ""}`);
process.exit(fail ? 1 : 0);
