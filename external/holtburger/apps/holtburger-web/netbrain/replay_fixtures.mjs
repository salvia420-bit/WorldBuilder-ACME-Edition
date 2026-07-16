// replay_fixtures.mjs — the byte-for-byte gate for the UNIFIED RynthBrain
// AppBundle: replays every committed fixture corpus from the per-slice spike
// harnesses (docs/rynth-integration/netwasm-spike/) through the consolidated
// RynthBrainExports surface and compares against the natively-generated
// expectations. Proves consolidation (one bundle, InvariantGlobalization)
// changed nothing.
//
// Usage: node replay_fixtures.mjs [AppBundle-dir]   (default ./AppBundle)
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const bundle = process.argv[2] || path.join(here, "AppBundle");
const spike = path.join(here, "../../../docs/rynth-integration/netwasm-spike");

const { dotnet } = await import(pathToFileURL(path.join(bundle, "_framework/dotnet.js")));
const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
const E = exports.RynthBrainExports;
console.log("netbrain version:", E.Version());

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const stable = (v) => JSON.stringify(canon(v));

let totalPass = 0, totalFail = 0;

// ---- CombatScoring: scenario inputs -> expected ScoringOutput (float-tolerant
// score compare, mirroring CombatScoring/run_wasm.mjs) ----
{
  const fx = JSON.parse(readFileSync(path.join(spike, "CombatScoring/fixtures.json"), "utf8"));
  let pass = 0, fail = 0;
  for (const sc of fx.scenarios) {
    const got = JSON.parse(E.ScoreTargets(JSON.stringify(sc.input)));
    const exp = sc.expected;
    let ok =
      got.SelectedTargetId === exp.SelectedTargetId &&
      got.LockedTargetId === exp.LockedTargetId &&
      got.Switched === exp.Switched &&
      (got.DropReason ?? null) === (exp.DropReason ?? null) &&
      got.TargetLostScanAtMs === exp.TargetLostScanAtMs &&
      got.Scanned.length === exp.Scanned.length;
    if (ok)
      for (let i = 0; i < got.Scanned.length; i++) {
        const a = got.Scanned[i], b = exp.Scanned[i];
        if (a.Id !== b.Id || Math.abs(a.Score - b.Score) > 1e-9 * Math.max(1, Math.abs(b.Score))) { ok = false; break; }
      }
    if (ok) pass++;
    else { fail++; console.log(`MISMATCH combat/${sc.name}`); }
  }
  console.log(`combat: ${pass}/${fx.scenarios.length}`);
  totalPass += pass; totalFail += fail;
}

// ---- BuffScoring: recorded boundary calls -> exact canonical-JSON equality ----
{
  const fx = JSON.parse(readFileSync(path.join(spike, "BuffScoring/fixtures.json"), "utf8"));
  let pass = 0, fail = 0, calls = 0;
  for (const sc of fx.scenarios)
    for (const call of sc.calls) {
      calls++;
      const got = JSON.parse(E.ScheduleBuffs(JSON.stringify(call.input)));
      if (stable(got) === stable(call.output)) pass++;
      else { fail++; console.log(`MISMATCH buff/${sc.name} @t=${call.input.NowMs - fx.meta.t0Ms}`); }
    }
  console.log(`buff: ${pass}/${calls} boundary calls`);
  totalPass += pass; totalFail += fail;
}

// ---- LootScoring (present once the #18 slice lands): single-call scenarios ----
{
  const lootFx = path.join(spike, "LootScoring/fixtures.json");
  if (existsSync(lootFx) && typeof E.EvaluateLoot === "function") {
    const fx = JSON.parse(readFileSync(lootFx, "utf8"));
    let pass = 0, fail = 0;
    for (const sc of fx.scenarios) {
      const got = JSON.parse(E.EvaluateLoot(JSON.stringify(sc.input)));
      if (stable(got) === stable(sc.expected)) pass++;
      else { fail++; console.log(`MISMATCH loot/${sc.name}`); }
    }
    console.log(`loot: ${pass}/${fx.scenarios.length}`);
    totalPass += pass; totalFail += fail;
  } else {
    console.log("loot: skipped (slice not present in bundle/fixtures yet)");
  }
}

console.log(`NETBRAIN UNIFIED PARITY: ${totalPass} pass, ${totalFail} fail`);
process.exit(totalFail ? 1 : 0);
