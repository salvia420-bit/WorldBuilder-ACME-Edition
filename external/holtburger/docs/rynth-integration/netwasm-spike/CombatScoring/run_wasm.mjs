// run_wasm.mjs — execute the CombatScoring wasm AppBundle in Node and replay
// ALL fixtures.json scenarios through the [JSExport] scoreTargets boundary,
// comparing against the natively-generated expected outputs. Proves the
// mono-wasm runtime reproduces the C# scoring bit-for-bit (float tolerance 1e-9).
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
const E = exports.CombatScoringExports;
console.log("wasm module version:", E.Version());

const fx = JSON.parse(readFileSync(fixturesPath, "utf8"));
let pass = 0, fail = 0;
for (const sc of fx.scenarios) {
  const got = JSON.parse(E.ScoreTargets(JSON.stringify(sc.input)));
  const exp = sc.expected;
  const scalarOk =
    got.SelectedTargetId === exp.SelectedTargetId &&
    got.LockedTargetId === exp.LockedTargetId &&
    got.Switched === exp.Switched &&
    (got.DropReason ?? null) === (exp.DropReason ?? null) &&
    got.TargetLostScanAtMs === exp.TargetLostScanAtMs &&
    got.Scanned.length === exp.Scanned.length;
  let scoresOk = scalarOk;
  if (scalarOk)
    for (let i = 0; i < got.Scanned.length; i++) {
      const a = got.Scanned[i], b = exp.Scanned[i];
      if (a.Id !== b.Id || Math.abs(a.Score - b.Score) > 1e-9 * Math.max(1, Math.abs(b.Score))) {
        scoresOk = false;
        break;
      }
    }
  if (scoresOk) pass++;
  else {
    fail++;
    console.log(`MISMATCH ${sc.name}: wasm sel=${got.SelectedTargetId?.toString(16)} native sel=${exp.SelectedTargetId?.toString(16)}`);
  }
}
console.log(`NETWASM PARITY: ${pass}/${fx.scenarios.length} scenarios match native C#${fail ? " — " + fail + " MISMATCH" : ""}`);
process.exit(fail ? 1 : 0);
