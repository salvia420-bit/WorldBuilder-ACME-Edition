// run_wasm.mjs — execute the BuffScoring wasm AppBundle in Node and replay
// every recorded boundary call (fixtures.json scenarios[].calls[]) through the
// [JSExport] scheduleBuffs boundary, comparing against the natively-generated
// outputs. Proves the mono-wasm runtime reproduces the C# scheduling
// bit-for-bit (deep JSON equality; the DTOs are ints/bools/strings + ms
// doubles that must round-trip exactly).
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
const E = exports.BuffScoringExports;
console.log("wasm module version:", E.Version());

// order-insensitive deep equality would hide real drift — compare canonical
// JSON with keys sorted (property ORDER is serializer-defined, not semantic).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const stable = (v) => JSON.stringify(canon(v));

const fx = JSON.parse(readFileSync(fixturesPath, "utf8"));
let pass = 0, fail = 0, calls = 0;
for (const sc of fx.scenarios) {
  for (const call of sc.calls) {
    calls++;
    const got = JSON.parse(E.ScheduleBuffs(JSON.stringify(call.input)));
    if (stable(got) === stable(call.output)) pass++;
    else {
      fail++;
      console.log(`MISMATCH ${sc.name} @t=${call.input.NowMs - fx.meta.t0Ms}: wasm action=${got.Action} native action=${call.output.Action}`);
    }
  }
}
console.log(`NETWASM PARITY: ${pass}/${calls} boundary calls match native C#${fail ? " — " + fail + " MISMATCH" : ""}`);
process.exit(fail ? 1 : 0);
